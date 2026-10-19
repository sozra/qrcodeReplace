// In-memory Stripe double used only by tests; never packaged in dist/.
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';

export function localDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  const db = { prepare(sql) {
    const prepared = values => ({ bind(...args) { return prepared(args); },
      async first() { return sqlite.prepare(sql).get(...values) || null; },
      async all() { return { results: sqlite.prepare(sql).all(...values) }; },
      async run() { return { meta: sqlite.prepare(sql).run(...values) }; },
    });
    return prepared([]);
  }, async batch(statements) {
    sqlite.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  return db;
}
export async function notifyPayment(handle, env, session, overrides = {}) {
  const event = { id: `evt_${crypto.randomUUID().replaceAll('-', '')}`, type: 'checkout.session.completed', livemode: false, data: { object: session }, ...overrides };
  const body = JSON.stringify(event), t = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');
  return handle(new Request(`${env.BILLING_ORIGIN}/api/billing/webhook`, { method: 'POST', body, headers: { 'stripe-signature': `t=${t},v1=${signature}` } }), env);
}
export function stripeFixture() {
  const sessions = new Map(), calls = [], idempotency = new Map();
  let unavailable = false;
  const send = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  return { sessions, calls, setUnavailable(value) { unavailable = value; },
    complete(id, plan = 'lifetime') {
      const session = sessions.get(id);
      Object.assign(session, { status: 'complete', payment_status: 'paid', customer: 'cus_fixture',
        payment_intent: { id: `pi_${id}`, customer: 'cus_fixture', status: 'succeeded', latest_charge: { paid: true, livemode: false, refunded: false, disputed: false, amount_refunded: 0 } } });
      if (plan === 'monthly') session.subscription = { id: `sub_${id}`, livemode: false, status: 'active', latest_invoice: { id: `in_${id}`, status: 'paid', amount_due: 100 }, items: { data: [{ quantity: 1, price: { id: 'price_monthly' }, current_period_end: Math.floor(Date.now() / 1000) + 86400 }] }, cancel_at_period_end: false };
      return session;
    },
    async fetch(input, options = {}) {
      if (unavailable) throw new Error('offline');
      const url = new URL(input), path = url.pathname, body = new URLSearchParams(options.body);
      calls.push({ path, body, options });
      if (path === '/v1/account') return send({ id: 'acct_fixture' });
      if (path === '/v1/invoice_payments') {
        const session = [...sessions.values()].find(s => s.subscription?.latest_invoice?.id === url.searchParams.get('invoice'));
        return send({ has_more: false, data: session ? [{ livemode: false, amount_paid: 100, payment: { type: 'payment_intent', payment_intent: session.payment_intent } }] : [] });
      }
      if (path.startsWith('/v1/payment_intents/')) return send([...sessions.values()].find(s => s.payment_intent?.id === path.split('/').at(-1))?.payment_intent);
      if (path.startsWith('/v1/prices/')) {
        const monthly = path.endsWith('price_monthly');
        return send({ id: monthly ? 'price_monthly' : 'price_lifetime', active: true, livemode: false, billing_scheme: 'per_unit', unit_amount: monthly ? 100 : 500, currency: 'usd', type: monthly ? 'recurring' : 'one_time', recurring: monthly ? { interval: 'month', interval_count: 1, usage_type: 'licensed' } : null });
      }
      if (path === '/v1/checkout/sessions' && options.method === 'POST') {
        const key = options.headers['Idempotency-Key'];
        if (idempotency.has(key)) return send(idempotency.get(key));
        const id = `cs_test_${sessions.size + 1}`;
        const session = { id, livemode: false, status: 'open', payment_status: 'unpaid', mode: body.get('mode'), client_reference_id: body.get('client_reference_id'),
          metadata: { app: body.get('metadata[app]'), plan: body.get('metadata[plan]'), price: body.get('metadata[price]') },
          line_items: { data: [{ price: { id: body.get('line_items[0][price]') }, quantity: 1 }] },
          url: `https://checkout.stripe.com/c/pay/${id}` };
        sessions.set(id, session); idempotency.set(key, session); return send(session);
      }
      if (path.endsWith('/expire')) {
        const session = sessions.get(path.split('/').at(-2)); session.status = 'expired'; return send(session);
      }
      if (path.startsWith('/v1/checkout/sessions/')) return sessions.has(path.split('/').at(-1)) ? send(sessions.get(path.split('/').at(-1))) : send({}, 404);
      if (path === '/v1/billing_portal/sessions') return send({ url: 'https://billing.stripe.com/p/session/test_fixture' });
      throw new Error(`Unexpected fixture request: ${path}`);
    },
  };
}
export function billingEnv(origin = 'https://qr.example') {
  return { BILLING_EXPERIMENT: 'exports', BILLING_ORIGIN: origin, STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_ACCOUNT_ID: 'acct_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', BILLING_DB: localDatabase(), BILLING_COOKIE_SECRET: 'fixture-only-cookie-secret-at-least-32-chars', STRIPE_PRICE_LIFETIME: 'price_lifetime', STRIPE_PRICE_MONTHLY: 'price_monthly' };
}
