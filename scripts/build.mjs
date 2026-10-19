import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Keep the browser app unchanged; package the optional Pages billing backend separately.
await rm('dist', { recursive: true, force: true });
await mkdir('dist');
for (const file of (await readdir('.')).sort()) {
  if (file === 'index.html' || file === 'styles.css' || file.endsWith('.js')) {
    await cp(file, `dist/${file}`);
  }
}
await cp('vendor', 'dist/vendor', { recursive: true });

const html = await readFile('dist/index.html', 'utf8');
for (const [, reference] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  if (/^(?:[a-z]+:|\/\/|#)/i.test(reference)) continue;
  const path = reference.split(/[?#]/)[0];
  await readFile(`dist/${path}`); // Fail on missing local scripts/styles.
}

async function hashes(directory, prefix = '') {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(result, await hashes(`${directory}/${entry.name}`, `${name}/`));
    else result[name] = createHash('sha256').update(await readFile(`${directory}/${entry.name}`)).digest('hex');
  }
  return result;
}

const commit = process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const files = await hashes('dist');
// Hosted Checkout opens in a separate tab; no third-party scripts/frames run in the editor.
const headers = "/*\n  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n";
await writeFile('dist/_headers', headers);
const source = await readFile('server/billing.mjs', 'utf8');
const routes = `${JSON.stringify({ version: 1, include: ['/api/*'], exclude: [] }, null, 2)}\n`;
const server = { sourceSha256: createHash('sha256').update(source).digest('hex'), routesSha256: createHash('sha256').update(routes).digest('hex'), headersSha256: createHash('sha256').update(headers).digest('hex') };
await writeFile('dist/_worker.js', `const QR_DEPLOYMENT = ${JSON.stringify({ commit, ...server })};\n${source}`);
await writeFile('dist/_routes.json', routes);
// Pages consumes the worker, routes and headers; they are not public static assets.
await writeFile('dist/_deployment.json', `${JSON.stringify({ commit, files, server }, null, 2)}\n`);
console.log(`Static site and optional Pages billing API packaged in dist/ for ${commit}.`);
