import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';

const { default: billingWorker } = await import(`data:text/javascript;base64,${(await readFile('dist/_worker.js')).toString('base64')}`);

const root = resolve('dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname.startsWith('/api/')) {
      const result = await billingWorker.fetch(new Request(`http://localhost${request.url}`), {});
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(await result.text()); return;
    }
    const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.status() >= 400 && new URL(response.url()).pathname !== '/favicon.ico') {
      errors.push(`${response.status()} ${response.url()}`);
    }
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  await page.waitForFunction(() => typeof window.jsQR === 'function' && typeof window.qrcode === 'function');
  assert.match(await page.title(), /QR 置换台/);
  assert.equal(await page.locator('#fileInput').count(), 1);
  assert.equal(await page.locator('#btnDownload').isDisabled(), true);
  // Import a generated QR through the same file input that users use.
  const image = await page.evaluate(() => {
    const qr = qrcode(3, 'M'); qr.addData('CI original QR'); qr.make();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 400;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 400, 400); ctx.fillStyle = '#000';
    for (let row = 0; row < qr.getModuleCount(); row++) {
      for (let col = 0; col < qr.getModuleCount(); col++) {
        if (qr.isDark(row, col)) ctx.fillRect(84 + col * 8, 84 + row * 8, 8, 8);
      }
    }
    return canvas.toDataURL().split(',')[1];
  });
  await page.locator('#fileInput').setInputFiles({ name: 'ci-qr.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
  await page.waitForFunction(() => !document.querySelector('#btnDownload').disabled);
  await page.locator('#inpText').fill('CI replacement QR');
  // The user-facing download must contain the edited, readable QR.
  const downloadReady = page.waitForEvent('download');
  await page.locator('#btnDownload').click();
  const download = await downloadReady;
  const png = await readFile(await download.path());
  const decoded = await page.evaluate(async base64 => {
    const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(pixels.data, pixels.width, pixels.height)?.data;
  }, png.toString('base64'));
  assert.equal(decoded, 'CI replacement QR');
  console.log('Browser smoke passed: import → detect → replace → download → decode.');
  // Run repository integration checks when those files have been committed.
  const suites = await readdir('tests').catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const file of suites.filter(file => file.endsWith('.browser.js')).sort()) {
    await page.goto(url);
    const result = await page.evaluate(await readFile(`tests/${file}`, 'utf8'));
    assert.ok(result?.passed > 0, `${file} must report passing checks`);
    console.log(`${file}: ${result.passed} checks passed.`);
  }
  assert.deepEqual(errors, [], 'No browser errors or failed asset requests');
  for (const file of suites.filter(file => file.endsWith('.browser.mjs')).sort()) {
    const { run } = await import(`../tests/${file}`);
    await run({ browser, url });
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
