const assert = require('node:assert/strict');
const { test } = require('node:test');

async function setup(overrides = {}) {
  const { createBillingHandler } = await import('../server/billing.mjs');
  const { stripeFixture, billingEnv, notifyPayment } = await import('./billing-fixture.mjs');
  const fixture = stripeFixture(), env = { ...billingEnv(), ...overrides }, handle = createBillingHandler(fixture.fetch), jar = new Map();
  async function request(path = 'status', body, headers = {}) {
    const response = await handle(new Request(`https://qr.example/api/billing/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: {
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(body === undefined ? {} : { origin: env.BILLING_ORIGIN, 'content-type': 'application/json' }), ...headers,
    }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    for (const value of response.headers.getSetCookie()) { const [name, ...rest] = value.split(';')[0].split('='); jar.set(name, rest.join('=')); }
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  await request();
  const buy = (plan = 'lifetime') => request('checkout', { plan, requestId: crypto.randomUUID() });
  const notify = (id, overrides) => notifyPayment(handle, env, fixture.sessions.get(id), overrides);
  return { fixture, env, request, buy, jar, handle, notify };
}

test('billing is opt-in; live keys, missing signing key and wrong origin fail closed', async () => {
  for (const overrides of [{ STRIPE_SECRET_KEY: 'sk_live_invalid' }, { BILLING_COOKIE_SECRET: '' }, { BILLING_ORIGIN: 'https://elsewhere.example' }, { BILLING_EXPERIMENT: 'typo' }]) {
    const s = await setup(overrides), r = await s.request(); assert.equal(r.status, 503); assert.equal(r.data.paid, false); assert.equal(s.fixture.calls.length, 0);
  }
  const s = await setup({ BILLING_EXPERIMENT: 'off' }); assert.equal((await s.request()).data.enabled, false); assert.equal((await s.buy()).status, 503);
});
test('sandbox checkout uses server price, signed HttpOnly cookie and same-origin return', async () => {
  const s = await setup(); const r = await s.buy(); assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/); assert.match(r.headers.get('set-cookie'), /Secure/);
  const call = s.fixture.calls.find(c => c.path === '/v1/checkout/sessions');
  assert.equal(call.body.get('line_items[0][price]'), 'price_lifetime'); assert.equal(call.body.get('success_url'), 'https://qr.example/?billing=success');
  assert.equal(call.options.headers['Stripe-Version'], '2026-09-30.endive'); assert.ok(call.options.headers['Idempotency-Key']);
  assert.equal((await s.request()).data.paid, false); assert.equal((await s.request()).data.state, 'pending');
});
test('successful payment unlocks without visiting return URL; refund/dispute revoke access', async () => {
  const s = await setup(); await s.buy(); const session = s.fixture.complete('cs_test_1'); await s.notify('cs_test_1');
  assert.equal((await s.request()).data.paid, true); assert.equal((await s.buy()).status, 409);
  session.payment_intent.latest_charge.amount_refunded = 1; assert.equal((await s.request()).data.paid, false);
  session.payment_intent.latest_charge.amount_refunded = 0; session.payment_intent.latest_charge.disputed = true; assert.equal((await s.request()).data.paid, false);
});
test('subscription tracks latest invoice, expiry and cancellation; outstanding subscription cannot be duplicated', async () => {
  const s = await setup(); await s.buy('monthly'); const session = s.fixture.complete('cs_test_1', 'monthly'); await s.notify('cs_test_1');
  assert.equal((await s.request()).data.paid, true);
  session.subscription.cancel_at_period_end = true; assert.equal((await s.request()).data.paid, true); assert.equal((await s.request()).data.cancelAtPeriodEnd, true);
  // Flexible billing Portal schedules cancel_at while cancel_at_period_end stays false.
  session.subscription.cancel_at_period_end = false; session.subscription.cancel_at = session.subscription.items.data[0].current_period_end;
  assert.equal((await s.request()).data.paid, true); assert.equal((await s.request()).data.cancelAtPeriodEnd, true);
  session.subscription.cancel_at = 1; assert.equal((await s.request()).data.paid, false); session.subscription.cancel_at = null;
  session.payment_intent.latest_charge.refunded = true; assert.equal((await s.request()).data.paid, false);
  session.payment_intent.latest_charge.refunded = false;
  session.subscription.status = 'past_due'; assert.equal((await s.request()).data.paid, false); assert.equal((await s.buy('monthly')).status, 409);
  assert.equal((await s.request('portal', {})).status, 200);
  session.subscription.status = 'active'; session.subscription.latest_invoice.status = 'open'; assert.equal((await s.request()).data.paid, false);
  session.subscription.latest_invoice.status = 'paid'; session.subscription.items.data[0].current_period_end = 1; assert.equal((await s.request()).data.paid, false);
  session.subscription.status = 'canceled'; assert.equal((await s.request()).data.paid, false);
});
test('tampered cookies, success query, wrong owner, wrong price and unpaid sessions cannot unlock', async () => {
  const s = await setup(); await s.buy(); const session = s.fixture.complete('cs_test_1'); await s.notify('cs_test_1');
  const original = s.jar.get('qr_checkout'); s.jar.set('qr_checkout', `${original}broken`); assert.equal((await s.request()).data.paid, false);
  s.jar.set('qr_checkout', original); const buyer = session.client_reference_id; session.client_reference_id = 'other'; assert.equal((await s.request()).status, 403);
  session.client_reference_id = buyer; session.line_items.data[0].price.id = 'price_other'; assert.equal((await s.request()).status, 403);
  session.line_items.data[0].price.id = 'price_lifetime'; session.payment_status = 'unpaid'; assert.equal((await s.request()).data.paid, false);
  const other = await setup(); assert.equal((await other.request('status?billing=success&paid=true')).data.paid, false);
});
test('CSRF, arbitrary plans and forged portal customer are rejected or ignored', async () => {
  const s = await setup(); assert.equal((await s.request('checkout', { plan: 'lifetime', requestId: crypto.randomUUID() }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await s.buy('__proto__')).status, 400); assert.equal((await s.request('portal', { customer: 'cus_other' })).status, 403);
  await s.buy(); s.fixture.complete('cs_test_1'); await s.request('portal', { customer: 'cus_other' });
  assert.equal(s.fixture.calls.at(-1).body.get('customer'), 'cus_fixture');
});
test('pending checkout is reused, changing plans expires it, network failure does not grant access', async () => {
  const s = await setup(); const first = await s.buy(); assert.equal((await s.buy()).data.url, first.data.url); assert.equal(s.fixture.sessions.size, 1);
  await s.buy('monthly'); assert.equal(s.fixture.sessions.get('cs_test_1').status, 'expired'); assert.equal(s.fixture.sessions.size, 2);
  s.fixture.complete('cs_test_2', 'monthly'); s.fixture.setUnavailable(true); assert.equal((await s.request()).status, 502);
});
test('prices are displayed from Stripe; client amounts and live checkout responses cannot be used', async () => {
  const s = await setup(); assert.equal((await s.request()).data.plans[0].amount, 500);
  await s.request('checkout', { plan: 'lifetime', requestId: crypto.randomUUID(), amount: 1, price: 'price_evil' });
  assert.equal(s.fixture.calls.find(c => c.path === '/v1/checkout/sessions').body.get('line_items[0][price]'), 'price_lifetime');
  s.fixture.complete('cs_test_1').livemode = true; assert.equal((await s.request()).status, 403);
});

test('payment waits for a verified webhook; duplicate delivery is idempotent and async completion works', async () => {
  const s = await setup(); await s.buy(); const session = s.fixture.complete('cs_test_1');
  assert.equal((await s.request()).data.state, 'processing');
  assert.equal((await s.buy()).status, 409);
  const event = { id: 'evt_repeat', type: 'checkout.session.async_payment_succeeded' };
  assert.equal((await s.notify(session.id, event)).status, 200);
  assert.equal((await s.request()).data.paid, true);
  assert.equal((await (await s.notify(session.id, event)).json()).duplicate, true);
  assert.equal((await s.env.BILLING_DB.prepare('SELECT COUNT(*) AS count FROM billing_events').first()).count, 1);
});
test('invalid signatures, stale signatures, live events and wrong account events never grant access', async () => {
  const { createHmac } = require('node:crypto');
  const s = await setup(); await s.buy(); const session = s.fixture.complete('cs_test_1');
  const body = JSON.stringify({ id: 'evt_forged', type: 'checkout.session.completed', livemode: false, data: { object: session } });
  for (const header of ['t=0,v1=bad', `t=${Math.floor(Date.now()/1000)},v1=${'0'.repeat(64)}`, `t=1,v1=${createHmac('sha256',s.env.STRIPE_WEBHOOK_SECRET).update(`1.${body}`).digest('hex')}`]) {
    const response = await s.handle(new Request('https://qr.example/api/billing/webhook', { method: 'POST', body, headers: { 'stripe-signature': header } }), s.env);
    assert.equal(response.status, 400);
  }
  assert.equal((await s.notify(session.id, { livemode: true })).status, 400);
  assert.equal((await s.notify(session.id, { account: 'acct_other' })).status, 400);
  assert.equal((await s.request()).data.paid, false);
});
test('unpaid completed webhook stays locked; failed processing retries; later success unlocks', async () => {
  const s = await setup(); await s.buy(); const session = s.fixture.sessions.get('cs_test_1');
  session.status = 'complete';
  assert.equal((await s.notify(session.id)).status, 200);
  assert.equal((await s.request()).data.paid, false);
  s.fixture.complete(session.id); s.fixture.setUnavailable(true);
  assert.equal((await s.notify(session.id, { id: 'evt_retry' })).status, 502);
  s.fixture.setUnavailable(false);
  assert.equal((await s.notify(session.id, { id: 'evt_retry' })).status, 200);
  assert.equal((await s.request()).data.paid, true);
});
test('subscription and refund events reconcile stored orders against current Stripe state', async () => {
  const s = await setup(); await s.buy('monthly'); const session = s.fixture.complete('cs_test_1', 'monthly');
  await s.notify(session.id);
  const stored = () => s.env.BILLING_DB.prepare('SELECT * FROM billing_orders WHERE session = ?').bind(session.id).first();
  session.subscription.status = 'past_due';
  assert.equal((await s.notify(session.id, { type: 'invoice.payment_failed', data: { object: { parent: { subscription_details: { subscription: session.subscription.id } } } } })).status, 200);
  assert.equal((await stored()).paid, 0);
  session.subscription.status = 'active';
  await s.notify(session.id, { type: 'invoice.paid', data: { object: { parent: { subscription_details: { subscription: session.subscription.id } } } } });
  assert.equal((await stored()).paid, 1);
  session.payment_intent.latest_charge.refunded = true;
  await s.notify(session.id, { type: 'charge.refunded', data: { object: { payment_intent: session.payment_intent.id } } });
  assert.equal((await stored()).paid, 0);
  // A late completed event cannot restore a refunded payment.
  await s.notify(session.id); assert.equal((await stored()).paid, 0);
});
test('restricted keys work; checkout config enables invoices/dynamic methods and binds the selected account', async () => {
  const s = await setup({ STRIPE_SECRET_KEY: 'rk_test_fixture', STRIPE_PORTAL_CONFIGURATION: 'bpc_fixture' });
  assert.equal((await s.buy()).status, 200);
  const params = s.fixture.calls.find(c => c.path === '/v1/checkout/sessions').body;
  assert.equal(params.get('invoice_creation[enabled]'), 'true');
  assert.equal(params.has('payment_method_types[0]'), false);
  assert.equal(params.get('adaptive_pricing[enabled]'), 'true');
  assert.equal(params.get('managed_payments[enabled]'), 'false');
  assert.match(params.get('integration_identifier'), /[a-z]{8}$/);
  s.fixture.complete('cs_test_1'); await s.notify('cs_test_1'); await s.request('portal', {});
  assert.equal(s.fixture.calls.at(-1).body.get('configuration'), 'bpc_fixture');
  const wrong = await setup({ STRIPE_ACCOUNT_ID: 'acct_other' }); assert.equal((await wrong.buy()).status, 503);
  for (const overrides of [{ STRIPE_SECRET_KEY: 'rk_live_invalid' }, { BILLING_DB: null }, { STRIPE_WEBHOOK_SECRET: '' }]) assert.equal((await (await setup(overrides)).request()).status, 503);
});
