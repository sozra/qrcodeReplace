import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBillingHandler } from '../server/billing.mjs';
import { billingEnv, stripeFixture, notifyPayment } from './billing-fixture.mjs';
import { googleFixture } from './auth-fixture.mjs';

export async function run({ browser, url: staticURL }) {
  const fixture = stripeFixture(), google = await googleFixture(), handle = createBillingHandler(fixture.fetch, google.fetch);
  let env;
  const server = createServer(async (req, res) => {
    try {
      if (!req.url.startsWith('/api/')) {
        const asset = await fetch(`${staticURL}${req.url}`); res.writeHead(asset.status, { 'Content-Type': asset.headers.get('content-type') }); res.end(Buffer.from(await asset.arrayBuffer())); return;
      }
      const request = new Request(`${env.BILLING_ORIGIN}${req.url}`, { method: req.method, headers: req.headers,
        ...(req.method === 'GET' ? {} : { body: Readable.toWeb(req), duplex: 'half' }) });
      const result = await handle(request, env), headers = Object.fromEntries(result.headers);
      if (result.headers.getSetCookie().length) headers['set-cookie'] = result.headers.getSetCookie();
      res.writeHead(result.status, headers); res.end(await result.text());
    } catch { res.writeHead(500).end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  env = billingEnv(`http://127.0.0.1:${server.address().port}`);
  const context = await browser.newContext(), page = await context.newPage(), errors = [];
  context.on('page', tab => tab.on('pageerror', error => errors.push(error.message)));
  page.on('pageerror', error => errors.push(error.message));
  // Stripe recommends mocks for automated browser tests; manually exercise hosted Checkout separately.
  await context.route('https://checkout.stripe.com/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>模拟 Stripe 测试结账页</h1>' }));
  await context.route('https://billing.stripe.com/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>模拟 Stripe 订阅管理</h1>' }));
  async function mockGoogle(browserContext, claims) {
    await browserContext.route('https://accounts.google.com/**', async route => route.fulfill({ status: 302, headers: { location: await google.authorize(route.request().url(), claims) }, body: '' }));
  }
  await mockGoogle(context);
  async function login(target, browserContext, button = '#billingLogin') {
    const popup = browserContext.waitForEvent('page'); await target.locator(button).click(); const tab = await popup;
    await tab.waitForURL(`${env.BILLING_ORIGIN}/**`);
    await tab.waitForFunction(() => document.getElementById('billingIdentity').textContent.includes('已登录'));
    await tab.close();
    if (await target.locator('#billingDialog[open]').count()) await target.locator('#billingRefresh').click();
    else { await target.locator('#billingOpen').click(); await target.locator('#billingRefresh').click(); }
    await target.waitForFunction(() => document.getElementById('billingIdentity').textContent.includes('已登录'));
  }
  async function importQR(target = page) {
    const data = await target.evaluate(() => {
      const qr = qrcode(0, 'M'); qr.addData('Billing original'); qr.make();
      const size = qr.getModuleCount(), c = document.createElement('canvas'); c.width = c.height = (size + 8) * 10;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.fillStyle = '#000';
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (qr.isDark(y, x)) ctx.fillRect((x + 4) * 10, (y + 4) * 10, 10, 10);
      return c.toDataURL().split(',')[1];
    });
    await target.locator('#fileInput').setInputFiles({ name: 'billing-qr.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64') });
    await target.waitForFunction(() => !document.getElementById('btnDownload').disabled);
    await target.locator('#inpText').fill('Billing paid QR');
  }
  async function downloadAndDecode(target = page) {
    const ready = target.waitForEvent('download'); await target.locator('#btnDownload').click(); const download = await ready;
    const png = await readFile(await download.path());
    assert.equal(await target.evaluate(async base64 => {
      const img = new Image(); img.src = `data:image/png;base64,${base64}`; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); const pixels = ctx.getImageData(0, 0, c.width, c.height);
      return jsQR(pixels.data, c.width, c.height)?.data;
    }, png.toString('base64')), 'Billing paid QR');
  }
  try {
    await page.goto(env.BILLING_ORIGIN); await page.evaluate(() => QRBilling.ready); await importQR();
    let downloads = 0; page.on('download', () => downloads++);
    await page.locator('#btnDownload').click(); await page.locator('#billingDialog[open]').waitFor(); assert.equal(downloads, 0);
    assert.equal(await page.locator('[data-plan]').count(), 2);
    await page.locator('#billingClose').click();
    await page.locator('#btnCopy').click(); await page.locator('#billingDialog[open]').waitFor();
    await page.locator('#billingClose').click();
    await page.evaluate(() => { document.querySelector('#btnShare').classList.remove('hidden'); });
    await page.locator('#btnShare').click(); await page.locator('#billingDialog[open]').waitFor();
    assert.equal(await page.locator('[data-plan="lifetime"]').isDisabled(), true);
    await login(page, context);
    assert.equal(await page.locator('#inpText').inputValue(), 'Billing paid QR');
    // Payment opens separately and leaves the editor intact.
    const newTab = context.waitForEvent('page'); await page.locator('[data-plan="lifetime"]').click(); const checkout = await newTab;
    await checkout.waitForURL('https://checkout.stripe.com/**'); assert.equal(await page.locator('#inpText').inputValue(), 'Billing paid QR');
    await page.locator('#billingRefresh').click(); assert.equal(downloads, 0);
    fixture.complete('cs_test_1'); await notifyPayment(handle, env, fixture.sessions.get('cs_test_1'));
    await page.locator('#billingRefresh').click(); await page.waitForFunction(() => document.querySelector('#billingMessage').textContent.includes('已生效'));
    await page.locator('#billingClose').click(); await downloadAndDecode();
    // Fresh browser storage recovers the same account's entitlement through signed Google login.
    const secondContext = await browser.newContext(); await mockGoogle(secondContext);
    const secondPage = await secondContext.newPage(); await secondPage.goto(env.BILLING_ORIGIN); await secondPage.evaluate(() => QRBilling.ready);
    assert.match(await secondPage.locator('#accountSummary').textContent(), /尚未登录/);
    await login(secondPage, secondContext, '#accountLogin');
    await secondPage.waitForFunction(() => document.querySelector('#billingSummary').textContent.includes('已解锁'));
    await secondPage.locator('#billingClose').click(); await importQR(secondPage); await downloadAndDecode(secondPage);
    await secondPage.locator('#accountLogout').click();
    await secondPage.waitForFunction(() => document.querySelector('#accountSummary').textContent.includes('尚未登录'));
    await secondPage.locator('#btnDownload').click(); await secondPage.locator('#billingDialog[open]').waitFor();
    assert.equal(await secondPage.locator('#inpText').inputValue(), 'Billing paid QR');
    await secondContext.close();
    // A refund is rechecked before export, including when the browser previously showed paid.
    fixture.sessions.get('cs_test_1').payment_intent.latest_charge.refunded = true;
    await page.locator('#btnDownload').click(); await page.locator('#billingDialog[open]').waitFor(); assert.equal(downloads, 1);
    // A spoofed return parameter and localStorage flag cannot unlock.
    await context.clearCookies(); await page.goto(`${env.BILLING_ORIGIN}/?billing=success&paid=true`);
    await page.evaluate(() => { localStorage.setItem('paid', 'true'); return QRBilling.ready; });
    await page.locator('#billingDialog[open]').waitFor(); assert.match(await page.locator('#billingMessage').textContent(), /Google 登录/);
    await page.locator('#billingClose').click();
    // Ad-free mode permits the complete free export workflow and removes placeholder after purchase.
    env.BILLING_EXPERIMENT = 'adfree'; await page.reload(); await page.evaluate(() => QRBilling.ready);
    assert.equal(await page.locator('#billingAd').isVisible(), true); await importQR(); await downloadAndDecode();
    await page.locator('#billingOpen').click();
    await login(page, context);
    const nextTab = context.waitForEvent('page'); await page.locator('[data-plan="monthly"]').click(); const monthly = await nextTab;
    await monthly.waitForURL('https://checkout.stripe.com/**'); fixture.complete('cs_test_2', 'monthly'); await notifyPayment(handle, env, fixture.sessions.get('cs_test_2'));
    await page.locator('#billingRefresh').click(); await page.waitForFunction(() => document.querySelector('#billingAd').classList.contains('hidden'));
    const portalTab = context.waitForEvent('page'); await page.locator('#billingPortal').click(); await (await portalTab).waitForURL('https://billing.stripe.com/**');
    fixture.sessions.get('cs_test_2').subscription.status = 'canceled'; await page.locator('#billingRefresh').click();
    await page.waitForFunction(() => !document.querySelector('#billingAd').classList.contains('hidden'));
    // Narrow viewport: pricing and controls remain inside the viewport.
    await page.setViewportSize({ width: 390, height: 844 });
    const box = await page.locator('#billingDialog').boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 390);
    await page.screenshot({ path: '/tmp/qr-billing-mobile.png', fullPage: true });
    // Network failure must not reuse a previously paid state for export.
    env.BILLING_EXPERIMENT = 'exports'; fixture.setUnavailable(true);
    await page.locator('#billingClose').click(); await page.locator('#btnDownload').click(); await page.locator('#billingDialog[open]').waitFor();
    assert.match(await page.locator('#billingMessage').textContent(), /暂不可用/);
    // Direct index.html keeps import/edit/download working without an API.
    await page.goto(pathToFileURL(resolve('index.html')).href); await importQR(); await downloadAndDecode();
    assert.equal(await page.locator('#billingPanel').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('Billing browser flow passed: Google popup login, cross-browser paid PNG recovery, logout, both modes, refund, subscription/portal, network failure, mobile layout and file:// PNG decode.');
  } finally { await context.close(); await new Promise(resolve => server.close(resolve)); }
}
