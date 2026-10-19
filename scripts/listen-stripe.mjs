import { readFile, writeFile, chmod } from 'node:fs/promises';
import { parseEnv, promisify } from 'node:util';
import { spawn, execFile } from 'node:child_process';
import { dirname, delimiter } from 'node:path';

// Only local sandbox forwarding. Credentials travel in the child environment, never argv/logs.
const env = parseEnv(await readFile('.dev.vars', 'utf8'));
if (!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(env.STRIPE_SECRET_KEY || '')) throw new Error('请先在 .dev.vars 填写 Stripe 测试密钥');
if (env.BILLING_ORIGIN !== 'http://127.0.0.1:8788') throw new Error('本脚本只向本地 127.0.0.1:8788 转发');
const response = await fetch('https://api.stripe.com/v1/account', { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Stripe-Version': '2026-09-30.endive' }, signal: AbortSignal.timeout(12000) });
const account = await response.json();
if (!response.ok || account.id !== env.STRIPE_ACCOUNT_ID) throw new Error('测试密钥无效或与配置的沙盒账户不一致');
const events = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.voided', 'invoice.marked_uncollectible', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.closed', 'refund.created', 'refund.updated'];
const childEnv = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`, STRIPE_API_KEY: env.STRIPE_SECRET_KEY };
const command = ['exec', '--yes', '--package=@stripe/cli@1.54.0', '--', 'stripe'];
async function saveSecret(secret) {
  const current = await readFile('.dev.vars', 'utf8'), setting = `STRIPE_WEBHOOK_SECRET=${secret}`;
  await writeFile('.dev.vars', /^STRIPE_WEBHOOK_SECRET=.*$/m.test(current) ? current.replace(/^STRIPE_WEBHOOK_SECRET=.*$/m, setting) : `${current.trimEnd()}\n${setting}\n`, { mode: 0o600 });
  await chmod('.dev.vars', 0o600);
}
try {
  const result = await promisify(execFile)('npm', [...command, 'listen', '--print-secret', '--skip-update', '--color', 'off'], { env: childEnv, timeout: 30000 });
  const secret = result.stdout.match(/whsec_[A-Za-z0-9]+/)?.[0];
  if (!secret) throw new Error();
  await saveSecret(secret);
  console.log('本地 Webhook 签名密钥已安全配置，正在建立事件连接…');
} catch { console.error('无法取得本地 Webhook 签名密钥；请检查网络和沙盒密钥权限。'); process.exit(1); }
const child = spawn('npm', ['exec', '--yes', '--package=@stripe/cli@1.54.0', '--', 'stripe', 'listen', '--events-from', '@self', '--events', events.join(','), '--forward-to', `${env.BILLING_ORIGIN}/api/billing/webhook`, '--skip-update', '--color', 'off'], {
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let pending = Promise.resolve(), configured = false;
const readinessTimer = setTimeout(() => {
  if (!configured) console.error('Stripe WebSocket 尚未连接；若持续停在 Getting ready，可停止本进程并运行 npm run sync:stripe -- --watch 进行本地真实事件同步。');
}, 20000);
for (const stream of [child.stdout, child.stderr]) {
  let buffer = '';
  stream.on('data', chunk => {
    buffer += chunk.toString();
    // CLI readiness uses carriage returns and may omit a final newline.
    if (/whsec_[A-Za-z0-9]+[^A-Za-z0-9]/.test(buffer)) buffer += '\n';
    const lines = buffer.split(/\r\n|\r|\n/); buffer = lines.pop();
    for (const line of lines) pending = pending.then(async () => {
      const secret = line.match(/whsec_[A-Za-z0-9]+/)?.[0];
      if (secret) {
        await saveSecret(secret);
        configured = true;
        console.log('Stripe 沙盒 Webhook 已连接，签名密钥已安全写入 .dev.vars。现在启动或重启 npm run dev:billing，并保持此进程运行。');
      } else if (/\bReady!/i.test(line)) {
        configured = true;
        console.log('Stripe 事件监听已就绪。请启动或重启 npm run dev:billing，并保持本进程运行。');
      } else if (/evt_[A-Za-z0-9]+|\[\d{3}\]|error|failed|expired|getting ready/i.test(line)) {
        console.log(line.replace(/(?:[sr]k_(?:test|live)|whsec)_[A-Za-z0-9]+/g, '[redacted]'));
      }
    }).catch(() => { console.error('无法保存 Webhook 配置；请检查本地文件权限。'); child.kill(); process.exitCode = 1; });
  });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { console.error('无法启动 Stripe CLI'); process.exitCode = 1; });
child.on('exit', async code => { clearTimeout(readinessTimer); await pending; if (!configured) console.error('Stripe Webhook 未就绪；检查网络和测试密钥权限后重试。'); process.exitCode = code || (configured ? 0 : 1); });
