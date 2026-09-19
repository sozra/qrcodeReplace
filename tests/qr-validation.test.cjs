"use strict";

// Run with: node --test tests/qr-validation.test.cjs
// The real bundled generator and decoder operate on synthetic export pixels;
// the small canvas adapter only supplies browser pixel-copy operations.
const test = require("node:test");
const assert = require("node:assert/strict");
const qrcode = require("../vendor/qrcode.js");
global.jsQR = require("../vendor/jsQR.js");
require("../qr-validation.js");

class PixelCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4).fill(255);
  }

  getContext() {
    return {
      getImageData: (x, y, width, height) => {
        const data = new Uint8ClampedArray(width * height * 4);
        for (let row = 0; row < height; row++) {
          const offset = ((y + row) * this.width + x) * 4;
          data.set(this.data.subarray(offset, offset + width * 4), row * width * 4);
        }
        return { data, width, height };
      },
      drawImage: (source, sx, sy, sw, sh, dx, dy, dw, dh) => {
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
        if (!source.data) {
          this.data.fill(255);
          return;
        }
        for (let y = 0; y < dh; y++) {
          for (let x = 0; x < dw; x++) {
            const offset = (Math.floor(sy + y * sh / dh) * source.width + Math.floor(sx + x * sw / dw)) * 4;
            this.data.set(source.data.subarray(offset, offset + 4), ((y + dy) * this.width + x + dx) * 4);
          }
        }
      },
    };
  }
}

global.document = { createElement: () => new PixelCanvas(0, 0) };

function drawQR(canvas, text, x, y, moduleSize = 5) {
  const qr = qrcode(3, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      for (let py = y + r * moduleSize; py < y + (r + 1) * moduleSize; py++) {
        for (let px = x + c * moduleSize; px < x + (c + 1) * moduleSize; px++) {
          const i = (py * canvas.width + px) * 4;
          canvas.data[i] = canvas.data[i + 1] = canvas.data[i + 2] = 0;
        }
      }
    }
  }
  const size = n * moduleSize;
  return { tl: { x, y }, tr: { x: x + size, y }, br: { x: x + size, y: y + size }, bl: { x, y: y + size } };
}

function target(loc, extra = {}) {
  return { id: 1, enabled: true, loc, version: 3, ...extra };
}

test("verifies final pixels and reports all targets with progress", async () => {
  const canvas = new PixelCanvas(500, 250);
  const first = drawQR(canvas, "replacement", 30, 40);
  const second = drawQR(canvas, "replacement", 290, 40);
  const progress = [];
  const results = await QRValidation.verifyCanvas(canvas,
    [target(first), target(second, { id: 2 }), { id: 3, enabled: false }], "replacement",
    { onProgress: (p) => progress.push(p) });
  assert.deepEqual(results.map((r) => r.status), ["passed", "passed", "skipped"]);
  assert.equal(results[0].decoded, "replacement");
  assert.deepEqual(progress.map((p) => p.completed), [1, 2, 3]);
  assert.equal(progress.at(-1).total, 3);
});

test("rejects a readable QR with wrong contents", async () => {
  const canvas = new PixelCanvas(240, 240);
  const loc = drawQR(canvas, "old content", 40, 40);
  const [result] = await QRValidation.verifyCanvas(canvas, [target(loc)], "replacement");
  assert.equal(result.status, "failed");
  assert.equal(result.decoded, "old content");
  assert.match(result.message, /不一致/);
});

test("perspective fallback decodes sampled export pixels at the correct location", async () => {
  const canvas = new PixelCanvas(300, 280);
  const qr = qrcode(3, "M");
  qr.addData("perspective target");
  qr.make();
  const modules = qr.getModuleCount();
  // Projective map: x=(180u+20v+40)/(.4v+1), y=(240v+40)/(.4v+1).
  // Invert it at each output pixel to paint a genuinely skewed QR image.
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const v = (40 - (y + 0.5)) / (0.4 * (y + 0.5) - 240);
      const u = ((x + 0.5) * (0.4 * v + 1) - 20 * v - 40) / 180;
      if (u < 0 || u >= 1 || v < 0 || v >= 1 || !qr.isDark(Math.floor(v * modules), Math.floor(u * modules))) continue;
      const i = (y * canvas.width + x) * 4;
      canvas.data[i] = canvas.data[i + 1] = canvas.data[i + 2] = 0;
    }
  }
  const loc = { tl: { x: 40, y: 40 }, tr: { x: 220, y: 40 },
    br: { x: 240 / 1.4, y: 200 }, bl: { x: 60 / 1.4, y: 200 } };
  const realDecode = global.jsQR;
  let calls = 0;
  global.jsQR = (...args) => ++calls === 1 ? null : realDecode(...args);
  try {
    const [result] = await QRValidation.verifyCanvas(canvas, [target(loc)], "perspective target");
    assert.equal(result.status, "passed");
    assert.match(result.message, /透视校正后/);
    assert.ok(calls >= 2);
  } finally {
    global.jsQR = realDecode;
  }
});

test("a neighbouring QR with identical content cannot pass the wrong target", async () => {
  const canvas = new PixelCanvas(400, 320);
  drawQR(canvas, "replacement", 245, 80, 2);
  const blank = { tl: { x: 20, y: 40 }, tr: { x: 240, y: 40 }, br: { x: 240, y: 260 }, bl: { x: 20, y: 260 } };
  // A deliberately broad padding includes the neighbouring code in the crop.
  const crop = canvas.getContext().getImageData(0, 0, 303, 320);
  assert.equal(jsQR(crop.data, crop.width, crop.height).data, "replacement");
  const [result] = await QRValidation.verifyCanvas(canvas, [target(blank, { version: 1 })], "replacement");
  assert.equal(result.status, "failed");
  assert.equal(result.decoded, undefined);
});

test("rejects invalid bounds, crossed corners, and empty replacement text", async () => {
  const canvas = new PixelCanvas(240, 240);
  const loc = drawQR(canvas, "replacement", 40, 40);
  const outside = { ...loc, tl: { x: -10, y: 40 } };
  const crossed = { ...loc, tr: loc.br, br: loc.tr };
  const results = await QRValidation.verifyCanvas(canvas,
    [target(outside), target(crossed, { id: 2 })], "replacement");
  assert.deepEqual(results.map((r) => r.status), ["failed", "failed"]);
  const [empty] = await QRValidation.verifyCanvas(canvas, [target(loc)], "");
  assert.equal(empty.status, "failed");
});

test("aborts before start and when cancelled between targets", async () => {
  const canvas = new PixelCanvas(240, 240);
  const loc = drawQR(canvas, "replacement", 40, 40);
  const before = new AbortController();
  before.abort();
  await assert.rejects(QRValidation.verifyCanvas(canvas, [target(loc)], "replacement", { signal: before.signal }),
    { name: "AbortError" });
  const between = new AbortController();
  let progress = 0;
  await assert.rejects(QRValidation.verifyCanvas(canvas, [target(loc), target(loc)], "replacement", {
    signal: between.signal,
    onProgress: () => { progress++; between.abort(); },
  }), { name: "AbortError" });
  assert.equal(progress, 1);
});

test("large crop allocation is bounded before any image read", async () => {
  const canvas = {
    width: 100000, height: 100000,
    getContext: () => { throw new Error("Must not read huge source pixels"); },
  };
  const loc = { tl: { x: 100, y: 100 }, tr: { x: 99900, y: 100 }, br: { x: 99900, y: 99900 }, bl: { x: 100, y: 99900 } };
  const [result] = await QRValidation.verifyCanvas(canvas, [target(loc)], "replacement");
  assert.equal(result.status, "failed");
  assert.match(result.message, /未能读出/);
});

test("canvas pixels remain unchanged after verifying an unreadable region", async () => {
  const canvas = new PixelCanvas(260, 220);
  drawQR(canvas, "replacement", 110, 50, 2);
  const before = Buffer.from(canvas.data);
  const blank = { tl: { x: 30, y: 50 }, tr: { x: 100, y: 50 }, br: { x: 100, y: 120 }, bl: { x: 30, y: 120 } };
  await QRValidation.verifyCanvas(canvas, [target(blank)], "replacement");
  assert.deepEqual(Buffer.from(canvas.data), before);
});
