import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Package the static app without compiling or changing browser code.
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
await writeFile('dist/_deployment.json', `${JSON.stringify({ commit, files: await hashes('dist') }, null, 2)}\n`);
console.log(`Static site packaged in dist/ for ${commit}.`);
