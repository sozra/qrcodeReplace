import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Local development fallback when Stripe CLI's WebSocket host is unreachable.
// Fetch genuine events from Stripe, then replay them through the same signed handler.
// This is NOT evidence of a Stripe-to-HTTPS webhook delivery and is never deployed.
const env = parseEnv(await readFile('.dev.vars', 'utf8'));
if (!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(env.STRIPE_SECRET_KEY || '') || !/^whsec_[A-Za-z0-9]+$/.test(env.STRIPE_WEBHOOK_SECRET || '')) throw new Error('请先配置沙盒密钥与本地 Webhook 签名密钥');
if (env.BILLING_ORIGIN !== 'http://127.0.0.1:8788') throw new Error('事件重放仅允许发送到本地测试服务');
async function stripe(path) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Stripe-Version': '2026-09-30.endive' }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Stripe 事件读取失败（HTTP ${response.status}）`);
  return response.json();
}
if ((await stripe('account')).id !== env.STRIPE_ACCOUNT_ID) throw new Error('密钥不属于所选沙盒');
await mkdir('.wrangler', { recursive: true });
const path = `.wrangler/stripe-event-cursor-${env.STRIPE_ACCOUNT_ID}.json`;
let since = Math.floor(Date.now() / 1000) - 3600;
try { since = JSON.parse(await readFile(path, 'utf8')).since || since; } catch { /* First run. */ }
const supported = /^(checkout\.session\.(completed|async_payment_succeeded|async_payment_failed)|customer\.subscription\.(created|updated|deleted)|invoice\.(paid|payment_failed|payment_action_required|voided|marked_uncollectible)|charge\.(refunded|dispute\.created|dispute\.closed)|refund\.(created|updated))$/;
async function sync() {
  const events = []; let cursor = '', hasMore = true;
  // Two-minute overlap handles delayed event visibility; server-side IDs deduplicate replay.
  const until = Math.floor(Date.now() / 1000);
  for (let page = 0; hasMore && page < 100; page++) {
    const params = new URLSearchParams({ limit: '100', 'created[gte]': String(since), 'created[lte]': String(until), ...(cursor ? { starting_after: cursor } : {}) });
    const list = await stripe(`events?${params}`); hasMore = list.has_more; events.push(...list.data); cursor = list.data.at(-1)?.id;
  }
  if (hasMore) throw new Error('事件数量超过本地同步上限；游标保持不变');
  let count = 0;
  for (const event of events.reverse()) {
    if (event.livemode !== false || !supported.test(event.type)) continue;
    const body = JSON.stringify(event), timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex');
    const response = await fetch(`${env.BILLING_ORIGIN}/api/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${timestamp},v1=${signature}` }, body, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`本地事件处理失败（HTTP ${response.status}，${event.type}）；游标保持不变，请检查本地服务后重试`);
    if (!(await response.json()).duplicate) count++;
  }
  since = until - 120;
  await writeFile(path, JSON.stringify({ since }), { mode: 0o600 });
  if (count || !process.argv.includes('--watch')) console.log(`已同步 ${count} 条 Stripe 沙盒真实事件（本地重放，非 HTTPS Webhook 投递）。`);
}
if (process.argv.includes('--watch')) {
  console.log('本地沙盒事件同步运行中，每 5 秒检查一次。请保持此进程和 dev:billing 运行。');
  for (;;) { try { await sync(); } catch (error) { console.error(error.message); } await delay(5000); }
} else await sync();
