import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const template = await readFile('.dev.vars.example', 'utf8');
try {
  await writeFile('.dev.vars', template.replace('BILLING_COOKIE_SECRET=', `BILLING_COOKIE_SECRET=${randomBytes(32).toString('hex')}`), { flag: 'wx', mode: 0o600 });
  console.log('Created ignored .dev.vars with a random signing key. Fill in Stripe sandbox key and price IDs locally.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.dev.vars already exists; preserved all existing values.');
}
