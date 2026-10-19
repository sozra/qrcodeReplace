// Sandbox-only Pages backend. Images and QR contents never reach these routes.
// No cached entitlement: every status/export check reads authoritative Stripe state.
const API_VERSION = '2025-02-24.acacia';
const APP = 'qr-replace-sandbox-v1';
const YEAR = 365 * 24 * 60 * 60;
const encoder = new TextEncoder();
const plans = { lifetime: 'STRIPE_PRICE_LIFETIME', monthly: 'STRIPE_PRICE_MONTHLY' };
const build = typeof QR_DEPLOYMENT === 'undefined' ? null : QR_DEPLOYMENT;

class BillingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function json(data, status = 200, cookies = []) {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(data), { status, headers });
}
function config(env, url) {
  const experiment = env.BILLING_EXPERIMENT || 'off';
  if (experiment === 'off') return { enabled: false, experiment };
  const configured = ['exports', 'adfree'].includes(experiment)
    && /^sk_test_[a-zA-Z0-9]+$/.test(env.STRIPE_SECRET_KEY || '')
    && (env.BILLING_COOKIE_SECRET || '').length >= 32
    && env.BILLING_ORIGIN === url.origin
    && (url.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(url.hostname))
    && Object.values(plans).some(key => /^price_[a-zA-Z0-9]+$/.test(env[key] || ''));
  return { enabled: true, configured, experiment, testMode: true };
}
function b64(bytes) { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
function unb64(value) { return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), ch => ch.charCodeAt(0)); }
async function key(secret) { return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
async function sign(value, secret) {
  const payload = b64(encoder.encode(JSON.stringify({ ...value, exp: Math.floor(Date.now() / 1000) + YEAR })));
  return `${payload}.${b64(new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(payload))))}`;
}
async function readCookie(request, name, env) {
  try {
    const value = (request.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1);
    if (!value || value.length > 2048) return null;
    const parts = value.split('.');
    if (parts.length !== 2 || !await crypto.subtle.verify('HMAC', await key(env.BILLING_COOKIE_SECRET), unb64(parts[1]), encoder.encode(parts[0]))) return null;
    const data = JSON.parse(new TextDecoder().decode(unb64(parts[0])));
    return data.exp > Date.now() / 1000 && data.kind === name ? data : null;
  } catch { return null; }
}
async function cookie(name, value, env, url) {
  return `${name}=${await sign({ ...value, kind: name }, env.BILLING_COOKIE_SECRET)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${YEAR}${url.protocol === 'https:' ? '; Secure' : ''}`;
}
async function limitedJSON(message, limit) {
  const reader = message.body?.getReader();
  if (!reader) throw new BillingError(400, '请求内容为空');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new BillingError(413, '请求内容过大'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw new BillingError(400, '无法读取请求内容');
  } finally { reader.releaseLock(); }
}

export function createBillingHandler(stripeFetch = fetch) {
  async function stripe(env, path, params, idempotencyKey) {
    const headers = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Stripe-Version': API_VERSION };
    if (params) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let response;
    try {
      response = await stripeFetch(`https://api.stripe.com/v1/${path}`, { method: params ? 'POST' : 'GET', headers, body: params ? new URLSearchParams(params) : undefined, signal: AbortSignal.timeout(12000) });
    } catch { throw new BillingError(502, 'Stripe 暂时无法连接，请稍后重试'); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new BillingError(502, 'Stripe 请求未完成，请检查测试配置或稍后重试');
    }
    return limitedJSON(response, 256 * 1024);
  }
  async function price(env, plan) {
    const id = env[plans[plan]];
    if (!/^price_[a-zA-Z0-9]+$/.test(id || '')) throw new BillingError(400, '此方案尚未配置');
    const value = await stripe(env, `prices/${id}`);
    if (value.livemode !== false || !value.active || value.billing_scheme !== 'per_unit' || !(value.unit_amount > 0)
      || (plan === 'monthly' ? value.type !== 'recurring' || value.recurring?.interval !== 'month' || value.recurring?.interval_count !== 1 || value.recurring?.usage_type !== 'licensed' : value.type !== 'one_time')) {
      throw new BillingError(503, '请使用有效的测试价格：一次性买断或每月固定金额订阅');
    }
    return { id: plan, amount: value.unit_amount, currency: value.currency, interval: plan === 'monthly' ? 'month' : null };
  }
  async function session(env, receipt, buyer) {
    if (!receipt || receipt.buyer !== buyer?.id || !/^cs_test_[a-zA-Z0-9]+$/.test(receipt.session || '')) return null;
    const value = await stripe(env, `checkout/sessions/${receipt.session}?expand[]=line_items&expand[]=payment_intent.latest_charge&expand[]=subscription.latest_invoice.payment_intent.latest_charge`);
    const line = value.line_items?.data;
    if (value.livemode !== false || value.client_reference_id !== buyer.id || value.metadata?.app !== APP
      || value.metadata.plan !== receipt.plan || !Object.hasOwn(plans, receipt.plan)
      || value.metadata.price !== receipt.price || line?.length !== 1 || line[0].price?.id !== receipt.price || line[0].quantity !== 1
      || value.mode !== (receipt.plan === 'monthly' ? 'subscription' : 'payment')) {
      throw new BillingError(403, '无法验证此浏览器的测试购买记录');
    }
    return value;
  }
  function entitlement(value) {
    if (!value) return { paid: false, state: 'none', canManage: false };
    let paid = value.status === 'complete' && value.payment_status === 'paid';
    if (value.mode === 'subscription') {
      const sub = value.subscription;
      paid = paid && sub?.livemode === false && sub.status === 'active'
        && sub.latest_invoice?.status === 'paid' && sub.current_period_end > Date.now() / 1000
        && paidIntent(sub.latest_invoice.payment_intent);
    } else {
      paid = paid && paidIntent(value.payment_intent);
    }
    return { paid: !!paid, state: paid ? 'active' : value.status === 'open' ? 'pending' : 'inactive', plan: value.metadata.plan,
      canManage: value.status === 'complete' && /^cus_[a-zA-Z0-9]+$/.test(value.customer || ''),
      cancelAtPeriodEnd: value.subscription?.cancel_at_period_end === true };
  }
  function paidIntent(intent) {
    const charge = intent?.latest_charge;
    return intent?.status === 'succeeded' && charge?.paid === true && charge.livemode === false && !charge.refunded && !charge.disputed && charge.amount_refunded === 0;
  }
  function hostedURL(value, host) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== host || url.username || url.password || url.port) throw new BillingError(502, 'Stripe 返回了无效的支付链接');
    return url.href;
  }
  return async function handle(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/deployment' && request.method === 'GET') return json(build);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      const routes = { '/api/billing/status': 'GET', '/api/billing/checkout': 'POST', '/api/billing/portal': 'POST' };
      if (!Object.hasOwn(routes, url.pathname)) return json({ error: '未找到接口' }, 404);
      if (request.method !== routes[url.pathname]) return json({ error: '不支持此方法' }, 405);
      const settings = config(env, url);
      if (!settings.enabled) return request.method === 'GET' ? json({ ...settings, paid: false, plans: [] }) : json({ error: '付费测试未开启' }, 503);
      if (!settings.configured) return json({ ...settings, paid: false, plans: [], error: '付费测试尚未配置完成，请检查服务端测试密钥、价格、Cookie 密钥和站点地址' }, 503);
      if (request.method === 'POST' && (request.headers.get('origin') !== env.BILLING_ORIGIN || !request.headers.get('content-type')?.startsWith('application/json'))) {
        throw new BillingError(403, '请求来源无效，请从应用内重试');
      }
      const cookies = [];
      let buyer = await readCookie(request, 'qr_buyer', env);
      if (!buyer) {
        if (request.method !== 'GET') throw new BillingError(403, '请允许本站 Cookie 并刷新购买状态后重试');
        buyer = { id: crypto.randomUUID() };
        cookies.push(await cookie('qr_buyer', buyer, env, url));
      }
      const receipt = await readCookie(request, 'qr_checkout', env);
      const current = await session(env, receipt, buyer);
      const access = entitlement(current);
      if (url.pathname.endsWith('/status')) {
        const available = await Promise.all(Object.entries(plans).filter(([, field]) => env[field]).map(([plan]) => price(env, plan)));
        return json({ ...settings, ...access, plans: available }, 200, cookies);
      }
      const body = await limitedJSON(request, 2048);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BillingError(400, '请求内容无效');
      if (url.pathname.endsWith('/portal')) {
        if (!access.canManage) throw new BillingError(403, '当前浏览器没有可管理的购买记录');
        const portal = await stripe(env, 'billing_portal/sessions', { customer: current.customer, return_url: `${env.BILLING_ORIGIN}/?billing=portal` });
        return json({ url: hostedURL(portal.url, 'billing.stripe.com') });
      }
      if (!Object.hasOwn(plans, body.plan) || !/^[a-f0-9-]{36}$/.test(body.requestId || '')) throw new BillingError(400, '购买方案或请求编号无效');
      if (access.paid) throw new BillingError(409, '已解锁，请勿重复购买');
      // A past-due subscription must be managed, not replaced by another subscription.
      if (current?.subscription && !['canceled', 'incomplete_expired'].includes(current.subscription.status)) throw new BillingError(409, '已有订阅，请先在订阅管理中处理');
      if (current?.status === 'open' && receipt.plan === body.plan && receipt.price === env[plans[body.plan]]) return json({ url: hostedURL(current.url, 'checkout.stripe.com') });
      if (current?.status === 'open') await stripe(env, `checkout/sessions/${current.id}/expire`, {});
      await price(env, body.plan);
      const params = { mode: body.plan === 'monthly' ? 'subscription' : 'payment', 'line_items[0][price]': env[plans[body.plan]], 'line_items[0][quantity]': '1',
        'payment_method_types[0]': 'card', 'adaptive_pricing[enabled]': 'false', client_reference_id: buyer.id, 'metadata[app]': APP, 'metadata[plan]': body.plan, 'metadata[price]': env[plans[body.plan]],
        success_url: `${env.BILLING_ORIGIN}/?billing=success`, cancel_url: `${env.BILLING_ORIGIN}/?billing=cancel` };
      if (body.plan === 'lifetime') params.customer_creation = 'always';
      const checkout = await stripe(env, 'checkout/sessions', params, `${APP}-${buyer.id}-${body.requestId}`);
      if (checkout.livemode !== false || !/^cs_test_[a-zA-Z0-9]+$/.test(checkout.id || '')) throw new BillingError(502, '仅允许 Stripe 测试支付');
      const checkoutURL = hostedURL(checkout.url, 'checkout.stripe.com');
      cookies.push(await cookie('qr_checkout', { buyer: buyer.id, session: checkout.id, plan: body.plan, price: env[plans[body.plan]] }, env, url));
      return json({ url: checkoutURL }, 200, cookies);
    } catch (error) {
      return json({ error: error instanceof BillingError ? error.message : '支付状态暂时不可用，请稍后重试' }, error instanceof BillingError ? error.status : 502);
    }
  };
}

export default { fetch: createBillingHandler() };
