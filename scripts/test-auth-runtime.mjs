import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { googleFixture, client } from '../tests/auth-fixture.mjs';

// Exercise the deployed bundle's real workerd fetch/crypto/D1 path. Only upstream
// Google responses are simulated; production contains no test identity hooks.
const google = await googleFixture();
const origin = 'https://qr.example';
let redirectResponse = false, unexpectedRequests = 0;
const runtime = new Miniflare(convertV4MiniflareOptions({
  modules: true, script: await readFile('dist/_worker.js', 'utf8'), compatibilityDate: '2026-10-19',
  d1Databases: ['BILLING_DB'],
  bindings: {
    BILLING_EXPERIMENT: 'exports', BILLING_ORIGIN: origin, STRIPE_SECRET_KEY: 'sk_test_runtimefixture', STRIPE_ACCOUNT_ID: 'acct_runtimefixture',
    STRIPE_WEBHOOK_SECRET: 'whsec_runtimefixture', BILLING_COOKIE_SECRET: 'runtime-fixture-cookie-secret-over-32-characters', STRIPE_PRICE_LIFETIME: 'price_runtimefixture',
    GOOGLE_CLIENT_ID: 'runtimefixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'runtime-fixture-google-client-secret',
  },
  outboundService: async request => {
    if (!['https://oauth2.googleapis.com/token', 'https://www.googleapis.com/oauth2/v3/certs'].includes(request.url)) {
      unexpectedRequests++; return new Response('Unexpected outbound request', { status: 500 });
    }
    if (redirectResponse) return Response.redirect('https://untrusted.example/token', 302);
    return google.fetch(request.url, { method: request.method, body: request.method === 'POST' ? await request.text() : undefined });
  },
}));
try {
  const browser = client(async request => runtime.dispatchFetch(request.url, {
    method: request.method, headers: Object.fromEntries(request.headers),
    body: request.method === 'POST' ? await request.text() : undefined, redirect: 'manual',
  }), { BILLING_ORIGIN: origin });
  const result = await browser.login(google);
  assert.equal(result.response.headers.get('location'), `${origin}/?auth=success`, 'workerd must exchange the code and validate a Google-signed ID token');
  const db = await runtime.getD1Database('BILLING_DB');
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM auth_users').first()).count, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM auth_sessions').first()).count, 1);
  redirectResponse = true;
  assert.equal((await browser.login(google)).response.headers.get('location'), `${origin}/?auth=failed`);
  assert.equal(unexpectedRequests, 0, 'OAuth credentials must never follow an upstream redirect');
  await browser.request('/api/auth/logout', {});
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM auth_sessions').first()).count, 0);
  console.log('Google runtime passed: actual workerd token request, RS256 verification, D1 session, logout and redirect rejection.');
} finally { await runtime.dispose(); }
