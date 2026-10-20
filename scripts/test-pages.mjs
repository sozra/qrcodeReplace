import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, delimiter, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';

// Run the checked artifact in workerd, from an empty cwd so local secrets cannot load.
async function verifyRuntime(experiment) {
const cwd = await mkdtemp(`${tmpdir()}/qr-pages-test-`);
const reserve = createServer().listen(0, '127.0.0.1'); await once(reserve, 'listening');
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const bindings = experiment === 'off' ? { BILLING_EXPERIMENT: 'off' } : {
  BILLING_EXPERIMENT: 'exports', BILLING_ORIGIN: origin, STRIPE_SECRET_KEY: 'sk_test_runtimefixture', STRIPE_ACCOUNT_ID: 'acct_runtimefixture',
  STRIPE_WEBHOOK_SECRET: 'whsec_runtimefixture', BILLING_COOKIE_SECRET: 'runtime-fixture-cookie-secret-over-32-characters', STRIPE_PRICE_LIFETIME: 'price_runtimefixture',
  GOOGLE_CLIENT_ID: 'runtimefixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'runtime-fixture-google-client-secret',
};
const bindingArgs = Object.entries(bindings).flatMap(([name, value]) => ['--binding', `${name}=${value}`]);
const child = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'pages', 'dev', resolve('dist'), '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0', '--compatibility-date', '2026-10-19', ...bindingArgs, '--d1', 'BILLING_DB'], {
  cwd, env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`, WRANGLER_SEND_METRICS: 'false', BROWSER: 'none' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data.toString()).slice(-4000); });
const stopped = once(child, 'exit');
try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`Pages runtime exited before becoming ready: ${output}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/api/deployment`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch { /* Starting. */ }
    await delay(250);
  }
  assert.ok(ready, 'Pages runtime must start within 20 seconds');
  const get = path => fetch(`http://127.0.0.1:${port}${path}`);
  const expected = JSON.parse(await readFile('dist/_deployment.json', 'utf8'));
  assert.deepEqual(await (await get('/api/deployment')).json(), { commit: expected.commit, ...expected.server });
  if (experiment === 'off') assert.equal((await (await get('/api/billing/status')).json()).enabled, false);
  else {
    // These routes exercise real D1 SQL and PKCE in workerd, without calling Google or Stripe.
    const headers = { origin, 'content-type': 'application/json' };
    const locked = await fetch(`${origin}/api/billing/checkout`, { method: 'POST', headers, body: JSON.stringify({ plan: 'lifetime', requestId: crypto.randomUUID() }) });
    assert.equal(locked.status, 401);
    const start = await fetch(`${origin}/api/auth/google`, { method: 'POST', headers, body: '{}' });
    assert.equal(start.status, 200);
    const target = new URL((await start.json()).url);
    assert.equal(target.origin, 'https://accounts.google.com');
    assert.equal(target.searchParams.get('redirect_uri'), `${origin}/api/auth/google/callback`);
    assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
    const state = target.searchParams.get('state'), cookie = start.headers.getSetCookie()[0].split(';')[0];
    const callback = `${origin}/api/auth/google/callback?state=${state}&error=access_denied`;
    const cancelled = await fetch(callback, { headers: { cookie }, redirect: 'manual' });
    assert.equal(cancelled.status, 303); assert.equal(cancelled.headers.get('location'), `${origin}/?auth=cancel`);
    const replay = await fetch(callback, { headers: { cookie }, redirect: 'manual' });
    assert.equal(replay.headers.get('location'), `${origin}/?auth=expired`);
  }
  assert.equal((await get('/api/unknown')).status, 404);
  const home = await get('/');
  assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(home.headers.get('referrer-policy'), 'no-referrer');
  for (const [path, hash] of Object.entries(expected.files)) {
    const response = await get(`/${path}`); assert.equal(response.status, 200);
    assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), hash, path);
  }
  console.log(`Pages runtime passed (${experiment}): checked artifact, API routing, D1 OAuth flow and every public asset hash.`);
} finally {
  child.kill('SIGTERM');
  await Promise.race([stopped, delay(3000).then(() => child.kill('SIGKILL'))]);
  await rm(cwd, { recursive: true, force: true });
}

}
await verifyRuntime('off');
await verifyRuntime('exports');
