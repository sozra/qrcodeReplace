import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

function run(args) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const directory of ['.', 'scripts', 'tests', 'server']) {
  const files = await readdir(directory).catch(error => {
    if (error.code === 'ENOENT' && directory === 'tests') return [];
    throw error;
  });
  for (const file of files.sort()) {
    if (/\.(?:js|mjs|cjs)$/.test(file)) run(['--check', `${directory}/${file}`]);
  }
  const tests = files.filter(file => file.endsWith('.test.cjs')).sort();
  if (tests.length) run(['--test', ...tests.map(file => `${directory}/${file}`)]);
}
console.log('JavaScript syntax and available module tests passed.');
