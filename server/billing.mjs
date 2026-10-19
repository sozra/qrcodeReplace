// Sandbox-only Pages backend. Images and QR contents never reach these routes.
// No cached entitlement: every status/export check reads authoritative Stripe state.
const API_VERSION = '2026-09-30.endive';
const APP = 'qr-replace-sandbox-v1';
const INTEGRATION = 'qrcode-replace-ptkzmhqw';
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
    && /^(sk|rk)_test_[a-zA-Z0-9]+$/.test(env.STRIPE_SECRET_KEY || '')
    && /^acct_[a-zA-Z0-9]+$/.test(env.STRIPE_ACCOUNT_ID || '')
    && /^whsec_[a-zA-Z0-9]+$/.test(env.STRIPE_WEBHOOK_SECRET || '')
    && !!env.BILLING_DB
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
async function limitedText(message, limit) {
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
    return new TextDecoder().decode(bytes);
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw new BillingError(400, '无法读取请求内容');
  } finally { reader.releaseLock(); }
}
async function limitedJSON(message, limit) {
  const text = await limitedText(message, limit);
  try { return JSON.parse(text); } catch { throw new BillingError(400, '无法读取请求内容'); }
}

// Sandbox schema initialization is idempotent; no remote provisioning/configuration.
async function database(env) {
  const db = env.BILLING_DB;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS billing_orders (session TEXT PRIMARY KEY, buyer TEXT NOT NULL, plan TEXT NOT NULL, price TEXT NOT NULL, customer TEXT, subscription TEXT, payment_intent TEXT, confirmed INTEGER NOT NULL DEFAULT 0, paid INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT \'pending\', created INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS billing_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, processed INTEGER NOT NULL)'),
    db.prepare('CREATE INDEX IF NOT EXISTS billing_orders_buyer ON billing_orders(buyer, created)'),
    db.prepare('CREATE INDEX IF NOT EXISTS billing_orders_customer ON billing_orders(customer)'),
    db.prepare('CREATE INDEX IF NOT EXISTS billing_orders_subscription ON billing_orders(subscription)'),
  ]);
  return db;
}
async function verifiedEvent(request, env) {
  const raw = await limitedText(request, 256 * 1024);
  const parts = (request.headers.get('stripe-signature') || '').split(',').map(part => part.trim().split('='));
  const timestamp = parts.find(([name]) => name === 't')?.[1];
  if (!/^\d+$/.test(timestamp || '') || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new BillingError(400, '无效的支付通知签名');
  const signatures = parts.filter(([name, value]) => name === 'v1' && /^[a-f0-9]{64}$/.test(value)).map(([, value]) => Uint8Array.from(value.match(/../g), hex => parseInt(hex, 16)));
  const signingKey = await key(env.STRIPE_WEBHOOK_SECRET);
  const matches = await Promise.all(signatures.map(signature => crypto.subtle.verify('HMAC', signingKey, signature, encoder.encode(`${timestamp}.${raw}`))));
  if (!matches.some(Boolean)) throw new BillingError(400, '无效的支付通知签名');
  let event;
  try { event = JSON.parse(raw); } catch { throw new BillingError(400, '无效的支付通知'); }
  if (event.livemode !== false || !/^evt_[a-zA-Z0-9]+$/.test(event.id || '') || (event.account && event.account !== env.STRIPE_ACCOUNT_ID)) throw new BillingError(400, '仅接受本沙盒的支付通知');
  return event;
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
    const value = await stripe(env, `checkout/sessions/${receipt.session}?expand[]=line_items&expand[]=payment_intent.latest_charge&expand[]=subscription.latest_invoice`);
    const line = value.line_items?.data;
    if (value.livemode !== false || value.client_reference_id !== buyer.id || value.metadata?.app !== APP
      || value.metadata.plan !== receipt.plan || !Object.hasOwn(plans, receipt.plan)
      || value.metadata.price !== receipt.price || line?.length !== 1 || line[0].price?.id !== receipt.price || line[0].quantity !== 1
      || value.mode !== (receipt.plan === 'monthly' ? 'subscription' : 'payment')) {
      throw new BillingError(403, '无法验证此浏览器的测试购买记录');
    }
    if (value.subscription?.latest_invoice?.status === 'paid') {
      const invoice = value.subscription.latest_invoice;
      const payments = await stripe(env, `invoice_payments?invoice=${encodeURIComponent(invoice.id)}&status=paid&limit=100&expand[]=data.payment.payment_intent.latest_charge`);
      // Latest API models invoice payments separately; never trust paid-out-of-band invoices.
      invoice.verified_payment = payments.has_more === false && payments.data?.length > 0
        && payments.data.every(payment => payment.livemode === false && payment.payment?.type === 'payment_intent' && paidIntent(payment.payment.payment_intent))
        && payments.data.reduce((total, payment) => total + (payment.amount_paid || 0), 0) >= invoice.amount_due;
    }
    return value;
  }
  function entitlement(value) {
    if (!value) return { paid: false, state: 'none', canManage: false };
    let paid = value.status === 'complete' && value.payment_status === 'paid';
    if (value.mode === 'subscription') {
      const sub = value.subscription;
      const items = sub?.items?.data;
      paid = paid && sub?.livemode === false && sub.status === 'active'
        && items?.length === 1 && items[0].price?.id === value.metadata.price && items[0].quantity === 1
        && items[0].current_period_end > Date.now() / 1000
        && (!sub.cancel_at || sub.cancel_at > Date.now() / 1000)
        && sub.latest_invoice?.status === 'paid' && sub.latest_invoice.verified_payment === true;
    } else {
      paid = paid && paidIntent(value.payment_intent);
    }
    return { paid: !!paid, state: paid ? 'active' : value.status === 'open' ? 'pending' : 'inactive', plan: value.metadata.plan,
      canManage: value.status === 'complete' && /^cus_[a-zA-Z0-9]+$/.test(value.customer || ''),
      cancelAtPeriodEnd: value.subscription?.cancel_at_period_end === true || (value.subscription?.cancel_at > 0 && value.subscription.cancel_at === value.subscription.items?.data?.[0]?.current_period_end) };
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
  function record(db, order, value, access, confirm = false) {
    return db.prepare('UPDATE billing_orders SET customer = ?, subscription = ?, payment_intent = ?, paid = ?, state = ?, confirmed = MAX(confirmed, ?) WHERE session = ?')
      .bind(value.customer || null, value.subscription?.id || null, value.payment_intent?.id || null, Number(access.paid), access.state, Number(confirm && access.paid), order.session);
  }
  async function webhook(request, env) {
    const event = await verifiedEvent(request, env);
    const db = await database(env);
    if (await db.prepare('SELECT id FROM billing_events WHERE id = ?').bind(event.id).first()) return json({ received: true, duplicate: true });
    const object = event.data?.object;
    let orders = [];
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed'].includes(event.type)) {
      const order = await db.prepare('SELECT * FROM billing_orders WHERE session = ?').bind(object?.id || '').first();
      if (!order && object?.metadata?.app === APP) throw new BillingError(503, '订单尚未保存，请重试通知');
      if (order) orders = [order];
    } else if (event.type?.startsWith('customer.subscription.')) {
      orders = (await db.prepare('SELECT * FROM billing_orders WHERE subscription = ?').bind(object?.id || '').all()).results;
    } else if (['invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.voided', 'invoice.marked_uncollectible'].includes(event.type)) {
      const sub = object?.parent?.subscription_details?.subscription || object?.subscription;
      orders = (await db.prepare('SELECT * FROM billing_orders WHERE subscription = ?').bind(typeof sub === 'string' ? sub : sub?.id || '').all()).results;
    } else if (['charge.refunded', 'charge.dispute.created', 'charge.dispute.closed', 'refund.updated', 'refund.created'].includes(event.type)) {
      const intent = typeof object?.payment_intent === 'string' ? object.payment_intent : object?.payment_intent?.id;
      // Resolve the first-class payment/customer relationship; metadata never grants ownership.
      const payment = intent ? await stripe(env, `payment_intents/${intent}`) : null;
      orders = (await db.prepare('SELECT * FROM billing_orders WHERE customer = ? OR payment_intent = ?').bind(payment?.customer || object?.customer || '', intent || '').all()).results;
    }
    const updates = [];
    for (const order of orders) {
      const value = await session(env, order, { id: order.buyer });
      updates.push(record(db, order, value, entitlement(value), true));
    }
    // The snapshot and event receipt commit together. Duplicates and event reordering are harmless:
    // every event reads current Stripe state, and exports independently revalidate that state.
    await db.batch([...updates, db.prepare('INSERT OR IGNORE INTO billing_events (id, type, processed) VALUES (?, ?, ?)').bind(event.id, event.type, Date.now())]);
    return json({ received: true });
  }
  return async function handle(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/deployment' && request.method === 'GET') return json(build);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      const routes = { '/api/billing/status': 'GET', '/api/billing/checkout': 'POST', '/api/billing/portal': 'POST', '/api/billing/webhook': 'POST' };
      if (!Object.hasOwn(routes, url.pathname)) return json({ error: '未找到接口' }, 404);
      if (request.method !== routes[url.pathname]) return json({ error: '不支持此方法' }, 405);
      const settings = config(env, url);
      if (!settings.enabled) return request.method === 'GET' ? json({ ...settings, paid: false, plans: [] }) : json({ error: '付费测试未开启' }, 503);
      if (!settings.configured) return json({ ...settings, paid: false, plans: [], error: '付费测试尚未配置完成，请检查测试密钥、Webhook、数据库、价格和站点地址' }, 503);
      if (url.pathname.endsWith('/webhook')) return await webhook(request, env);
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
      const db = await database(env);
      const receipt = await readCookie(request, 'qr_checkout', env);
      const order = receipt?.buyer === buyer.id ? await db.prepare('SELECT * FROM billing_orders WHERE session = ? AND buyer = ?').bind(receipt.session, buyer.id).first() : null;
      const current = await session(env, order, buyer);
      const access = entitlement(current);
      if (order && current) await record(db, order, current, access).run();
      if (access.paid && !order?.confirmed) { access.paid = false; access.state = 'processing'; }
      if (url.pathname.endsWith('/status')) {
        const available = await Promise.all(Object.entries(plans).filter(([, field]) => env[field]).map(([plan]) => price(env, plan)));
        return json({ ...settings, ...access, plans: available }, 200, cookies);
      }
      const body = await limitedJSON(request, 2048);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BillingError(400, '请求内容无效');
      if (url.pathname.endsWith('/portal')) {
        if (!access.canManage) throw new BillingError(403, '当前浏览器没有可管理的购买记录');
        const portal = await stripe(env, 'billing_portal/sessions', { customer: current.customer, ...(env.STRIPE_PORTAL_CONFIGURATION ? { configuration: env.STRIPE_PORTAL_CONFIGURATION } : {}), return_url: `${env.BILLING_ORIGIN}/?billing=portal` });
        return json({ url: hostedURL(portal.url, 'billing.stripe.com') });
      }
      if (!Object.hasOwn(plans, body.plan) || !/^[a-f0-9-]{36}$/.test(body.requestId || '')) throw new BillingError(400, '购买方案或请求编号无效');
      if (access.paid || entitlement(current).paid) throw new BillingError(409, '付款已完成，请等待支付通知后刷新状态');
      // A past-due subscription must be managed, not replaced by another subscription.
      if (current?.subscription && !['canceled', 'incomplete_expired'].includes(current.subscription.status)) throw new BillingError(409, '已有订阅，请先在订阅管理中处理');
      if (current?.status === 'open' && receipt.plan === body.plan && receipt.price === env[plans[body.plan]]) return json({ url: hostedURL(current.url, 'checkout.stripe.com') });
      if (current?.status === 'open') await stripe(env, `checkout/sessions/${current.id}/expire`, {});
      await price(env, body.plan);
      const account = await stripe(env, 'account');
      if (account.id !== env.STRIPE_ACCOUNT_ID) throw new BillingError(503, '测试密钥与所选沙盒账户不一致');
      const params = { mode: body.plan === 'monthly' ? 'subscription' : 'payment', 'line_items[0][price]': env[plans[body.plan]], 'line_items[0][quantity]': '1',
        integration_identifier: INTEGRATION, 'managed_payments[enabled]': 'false', 'adaptive_pricing[enabled]': 'true', client_reference_id: buyer.id, 'metadata[app]': APP, 'metadata[plan]': body.plan, 'metadata[price]': env[plans[body.plan]],
        success_url: `${env.BILLING_ORIGIN}/?billing=success`, cancel_url: `${env.BILLING_ORIGIN}/?billing=cancel` };
      if (body.plan === 'lifetime') { params.customer_creation = 'always'; params['invoice_creation[enabled]'] = 'true'; }
      else params['subscription_data[billing_mode][type]'] = 'flexible';
      const checkout = await stripe(env, 'checkout/sessions', params, `${APP}-${buyer.id}-${body.requestId}`);
      if (checkout.livemode !== false || !/^cs_test_[a-zA-Z0-9]+$/.test(checkout.id || '')) throw new BillingError(502, '仅允许 Stripe 测试支付');
      const checkoutURL = hostedURL(checkout.url, 'checkout.stripe.com');
      await db.prepare('INSERT OR IGNORE INTO billing_orders (session, buyer, plan, price, created) VALUES (?, ?, ?, ?, ?)')
        .bind(checkout.id, buyer.id, body.plan, env[plans[body.plan]], Date.now()).run();
      cookies.push(await cookie('qr_checkout', { buyer: buyer.id, session: checkout.id, plan: body.plan, price: env[plans[body.plan]] }, env, url));
      return json({ url: checkoutURL }, 200, cookies);
    } catch (error) {
      return json({ error: error instanceof BillingError ? error.message : '支付状态暂时不可用，请稍后重试' }, error instanceof BillingError ? error.status : 502);
    }
  };
}

export default { fetch: createBillingHandler() };
