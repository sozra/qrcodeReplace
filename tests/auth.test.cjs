const assert = require('node:assert/strict');
const { test } = require('node:test');

async function setup() {
  const { createBillingHandler } = await import('../server/billing.mjs');
  const { billingEnv, stripeFixture, notifyPayment } = await import('./billing-fixture.mjs');
  const { googleFixture, client } = await import('./auth-fixture.mjs');
  const google = await googleFixture(), stripe = stripeFixture(), env = billingEnv(), handle = createBillingHandler(stripe.fetch, google.fetch);
  return { env, google, stripe, handle, browser: () => client(handle, env), notify: id => notifyPayment(handle, env, stripe.sessions.get(id)) };
}
test('Google login validates signed ID token, uses PKCE and rotates a revocable HttpOnly session', async () => {
  const s = await setup(), b = s.browser();
  assert.equal((await b.request('/api/billing/checkout', { plan: 'lifetime', requestId: crypto.randomUUID() })).status, 401);
  const result = await b.login(s.google);
  assert.equal(result.response.headers.get('location'), 'https://qr.example/?auth=success');
  assert.match(result.response.headers.get('set-cookie'), /__Host-qr_session=.*HttpOnly; SameSite=Lax; Max-Age=2592000; Secure/);
  assert.equal((await b.request()).data.auth.user.email, 'alice@example.com');
  const stolen = s.browser(); stolen.jar.set('__Host-qr_session', b.jar.get('__Host-qr_session'));
  await b.login(s.google);
  assert.equal((await stolen.request()).data.auth.user, null);
  stolen.jar.set('__Host-qr_session', b.jar.get('__Host-qr_session'));
  await b.request('/api/auth/logout', {});
  assert.equal((await stolen.request()).data.auth.user, null);
  assert.equal((await b.request()).data.paid, false);
});
test('same Google sub restores a paid order in another browser; another account or same email does not', async () => {
  const s = await setup(), first = s.browser(), second = s.browser(), other = s.browser();
  await first.login(s.google);
  await first.request('/api/billing/checkout', { plan: 'lifetime', requestId: crypto.randomUUID() });
  s.stripe.complete('cs_test_1'); await s.notify('cs_test_1');
  assert.equal((await first.request()).data.paid, true);
  assert.equal((await second.request()).data.paid, false);
  await second.login(s.google, { email: 'changed@example.com' });
  assert.equal((await second.request()).data.paid, true);
  assert.equal((await second.request('/api/billing/portal', {})).status, 200);
  await other.login(s.google, { sub: 'google-user-b', email: 'changed@example.com' });
  assert.equal((await other.request()).data.paid, false);
  assert.equal((await other.request('/api/billing/portal', { customer: 'cus_fixture' })).status, 403);
  s.stripe.sessions.get('cs_test_1').payment_intent.latest_charge.refunded = true;
  assert.equal((await second.request()).data.paid, false);
});
test('OAuth rejects wrong state, a different browser, expiry and callback replay', async () => {
  const s = await setup(), b = s.browser();
  const start = await b.request('/api/auth/google', {}), callback = await s.google.authorize(start.data.url);
  const other = s.browser(); assert.match((await other.request(callback)).response.headers.get('location'), /auth=invalid/);
  assert.equal(s.google.calls.length, 0);
  const cookie = b.jar.get('__Host-qr_oauth');
  assert.match((await b.request(callback)).response.headers.get('location'), /auth=success/);
  b.jar.set('__Host-qr_oauth', cookie);
  assert.match((await b.request(callback)).response.headers.get('location'), /auth=expired/);
  const expired = await b.request('/api/auth/google', {});
  await s.env.BILLING_DB.prepare('UPDATE auth_flows SET expires = 1').run();
  assert.match((await b.request(await s.google.authorize(expired.data.url))).response.headers.get('location'), /auth=expired/);
});
test('wrong signature, issuer, audience, nonce, email verification and expired tokens fail closed', async () => {
  const s = await setup();
  for (const claims of [{ iss: 'https://evil.example' }, { aud: 'other.apps.googleusercontent.com' }, { nonce: 'wrong' }, { email_verified: false }, { exp: 1 }, { azp: 'other' }, { sub: '' }]) {
    const b = s.browser(); const result = await b.login(s.google, claims);
    assert.match(result.response.headers.get('location'), /auth=failed/);
    assert.equal((await b.request()).data.auth.user, null);
  }
  const { generateKeyPair } = await import('jose'), fake = await generateKeyPair('RS256'), b = s.browser();
  const start = await b.request('/api/auth/google', {});
  assert.match((await b.request(await s.google.authorize(start.data.url, {}, fake.privateKey))).response.headers.get('location'), /auth=failed/);
});
test('login CSRF, cancellation and unavailable provider do not create an account or expose tokens', async () => {
  const s = await setup(), b = s.browser();
  assert.equal((await b.request('/api/auth/google', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await b.request('/api/auth/logout', {}, { origin: 'https://evil.example' })).status, 403);
  const start = await b.request('/api/auth/google', {}), url = new URL(start.data.url);
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(url.searchParams.has('access_type'), false);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const cancel = `/api/auth/google/callback?error=access_denied&state=${url.searchParams.get('state')}`;
  assert.match((await b.request(cancel)).response.headers.get('location'), /auth=cancel/);
  const retry = await b.request('/api/auth/google', {}), callback = await s.google.authorize(retry.data.url);
  s.google.setUnavailable(true);
  const failed = await b.request(callback); assert.match(failed.response.headers.get('location'), /auth=failed/);
  assert.equal((await s.env.BILLING_DB.prepare('SELECT COUNT(*) AS count FROM auth_users').first()).count, 0);
});
test('OAuth failure diagnostics never log provider bodies, credentials or arbitrary errors', async t => {
  const { createBillingHandler } = await import('../server/billing.mjs');
  const { billingEnv, stripeFixture } = await import('./billing-fixture.mjs');
  const { googleFixture, client } = await import('./auth-fixture.mjs');
  const google = await googleFixture(), stripe = stripeFixture(), logs = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args));
  for (const mode of ['response', 'exception']) {
    const handle = createBillingHandler(stripe.fetch, async () => {
      if (mode === 'response') return Response.json({ error: 'invalid_client', error_description: 'private-token-and-secret' }, { status: 401 });
      throw Object.assign(new Error('private-token-and-secret'), { code: 'private-token-and-secret' });
    });
    const b = client(handle, billingEnv());
    assert.match((await b.login(google)).response.headers.get('location'), /auth=failed/);
  }
  assert.equal(logs.length, 2);
  assert.equal(logs[0][1].providerError, 'invalid_client');
  assert.equal(logs[1][1].verifierError, undefined);
  assert.doesNotMatch(JSON.stringify(logs), /private-token-and-secret/);
});
test('legacy browser purchases can be claimed once and cannot be reassigned after logout', async () => {
  const s = await setup(), b = s.browser();
  const { seedAccount } = await import('./billing-fixture.mjs'), { cookie } = await import('../server/shared.mjs');
  const seed = await seedAccount(s.env, b.jar);
  await b.request('/api/billing/checkout', { plan: 'lifetime', requestId: crypto.randomUUID() });
  s.stripe.complete('cs_test_1'); await s.notify('cs_test_1');
  // Model the v1 deployment: immutable Stripe buyer, no account ownership, signed browser receipt.
  await s.env.BILLING_DB.prepare('DELETE FROM billing_owners WHERE buyer = ?').bind(seed.id).run();
  b.jar.clear();
  for (const [name, value] of [['qr_buyer', { id: seed.id }], ['qr_checkout', { buyer: seed.id, session: 'cs_test_1' }]]) {
    b.jar.set(name, (await cookie(name, value, s.env, new URL(s.env.BILLING_ORIGIN))).split(';')[0].slice(name.length + 1));
  }
  const old = new Map(b.jar);
  assert.equal((await b.request()).data.auth.legacyAvailable, true);
  assert.match((await b.login(s.google, undefined, true)).response.headers.get('location'), /auth=linked$/);
  assert.equal((await b.request()).data.paid, true);
  const second = s.browser(); await second.login(s.google); assert.equal((await second.request()).data.paid, true);
  await b.request('/api/auth/logout', {});
  for (const [k, v] of old) b.jar.set(k, v);
  assert.equal((await b.request()).data.paid, false);
  await b.login(s.google, { sub: 'google-user-b' }, true);
  assert.equal((await b.request()).data.paid, false);
});
test('two browsers reuse one pending checkout and one customer; malformed/missing configuration stays locked', async () => {
  const s = await setup(), a = s.browser(), b = s.browser();
  await a.login(s.google); await b.login(s.google);
  const body = () => ({ plan: 'lifetime', requestId: crypto.randomUUID() });
  const responses = await Promise.all([a.request('/api/billing/checkout', body()), b.request('/api/billing/checkout', body())]);
  assert.ok(responses.some(r => r.status === 200));
  assert.ok(responses.every(r => [200, 409].includes(r.status)));
  assert.equal((await b.request('/api/billing/checkout', body())).status, 200);
  assert.equal(s.stripe.sessions.size, 1);
  assert.equal(s.stripe.calls.filter(c => c.path === '/v1/customers').length, 1);
  s.env.GOOGLE_CLIENT_SECRET = '';
  assert.equal((await a.request('/api/billing/checkout', body())).status, 503);
  assert.equal((await a.request('/api/auth/google', {})).status, 503);
});
