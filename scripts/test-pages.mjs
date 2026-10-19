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
const cwd = await mkdtemp(`${tmpdir()}/qr-pages-test-`);
const reserve = createServer().listen(0, '127.0.0.1'); await once(reserve, 'listening');
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const child = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'pages', 'dev', resolve('dist'), '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0', '--compatibility-date', '2026-10-19', '--binding', 'BILLING_EXPERIMENT=off'], {
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
  assert.equal((await (await get('/api/billing/status')).json()).enabled, false);
  assert.equal((await get('/api/unknown')).status, 404);
  for (const [path, hash] of Object.entries(expected.files)) {
    const response = await get(`/${path}`); assert.equal(response.status, 200);
    assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), hash, path);
  }
  console.log('Pages runtime passed: checked artifact, API routing, opt-in billing and every public asset hash.');
} finally {
  child.kill('SIGTERM');
  await Promise.race([stopped, delay(3000).then(() => child.kill('SIGKILL'))]);
  await rm(cwd, { recursive: true, force: true });
}
