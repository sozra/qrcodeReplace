import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

const base = new URL(process.env.DEPLOYMENT_URL || 'https://qr-replace.pages.dev');
assert.equal(base.protocol, 'https:');
const expected = JSON.parse(await readFile('dist/_deployment.json', 'utf8'));
async function get(path) {
  const url = new URL(path, base);
  url.searchParams.set('revision', expected.commit);
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
  assert.equal(response.status, 200, `${url.pathname} must return HTTP 200`);
  return response;
}
for (let attempt = 1; attempt <= 6; attempt++) {
  try {
    const manifest = await (await get('/_deployment.json')).json();
    assert.deepEqual(manifest, expected, 'The production alias must serve this build');
    for (const [file, hash] of Object.entries(expected.files)) {
      const body = Buffer.from(await (await get(`/${file}`)).arrayBuffer());
      assert.equal(createHash('sha256').update(body).digest('hex'), hash, `${file} must match the build artifact`);
    }
    console.log(`Verified ${base.origin}: HTTP 200 and all asset hashes match ${expected.commit}.`);
    break;
  } catch (error) {
    if (attempt === 6) throw error;
    console.log(`Production propagation check ${attempt}/6 failed: ${error.message}. Retrying in 10s.`);
    await setTimeout(10000);
  }
}
