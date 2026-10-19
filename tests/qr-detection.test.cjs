"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const qrcode = require("../vendor/qrcode.js");
global.jsQR = require("../vendor/jsQR.js");
require("../qr-detection.js");

// Browser canvas adapter for real bundled generator/decoder regression tests.
class PixelCanvas {
  constructor(width = 0, height = 0) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4).fill(255);
  }
  getContext() {
    return {
      fillRect: () => { this.data = new Uint8ClampedArray(this.width * this.height * 4).fill(255); },
      drawImage: (source, sx, sy, sw, sh, dx, dy, dw, dh) => {
        if (sw === dw && sh === dh) {
          for (let row = 0; row < dh; row++) {
            const offset = ((sy + row) * source.width + sx) * 4;
            this.data.set(source.data.subarray(offset, offset + dw * 4), ((dy + row) * this.width + dx) * 4);
          }
          return;
        }
        for (let y = 0; y < dh; y++) {
          for (let x = 0; x < dw; x++) {
            const from = (Math.floor(sy + y * sh / dh) * source.width + Math.floor(sx + x * sw / dw)) * 4;
            this.data.set(source.data.subarray(from, from + 4), ((dy + y) * this.width + dx + x) * 4);
          }
        }
      },
      getImageData: (x, y, width, height) => {
        const data = new Uint8ClampedArray(width * height * 4);
        for (let row = 0; row < height; row++) {
          const offset = ((y + row) * this.width + x) * 4;
          data.set(this.data.subarray(offset, offset + width * 4), row * width * 4);
        }
        return { data, width, height };
      },
    };
  }
}

global.document = { createElement: () => new PixelCanvas() };

function drawQR(canvas, text, x, y, moduleSize = 3) {
  const qr = qrcode(3, "M");
  qr.addData(text);
  qr.make();
  for (let row = 0; row < qr.getModuleCount(); row++) {
    for (let col = 0; col < qr.getModuleCount(); col++) {
      if (!qr.isDark(row, col)) continue;
      for (let py = y + row * moduleSize; py < y + (row + 1) * moduleSize; py++) {
        for (let px = x + col * moduleSize; px < x + (col + 1) * moduleSize; px++) {
          const offset = (py * canvas.width + px) * 4;
          canvas.data[offset] = canvas.data[offset + 1] = canvas.data[offset + 2] = 0;
        }
      }
    }
  }
}

function checksum(canvas) { return createHash("sha256").update(canvas.data).digest("hex"); }

test("iterative masks retain nearby QR codes with identical content and preserve source pixels", async () => {
  const canvas = new PixelCanvas(245, 140);
  drawQR(canvas, "same text", 24, 24);
  drawQR(canvas, "same text", 130, 24);
  const original = checksum(canvas);
  const progress = [];
  const results = await QRDetection.detectCanvas(canvas, { onProgress: (p) => progress.push(p) });
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((det) => det.data), ["same text", "same text"]);
  assert.ok(Math.abs(results[0].loc.tl.x - results[1].loc.tl.x) > 90);
  assert.ok(results.every((det) => det.version === 3));
  assert.equal(checksum(canvas), original);
  assert.equal(progress.at(-1).phase, "complete");
  assert.equal(progress.at(-1).completed, progress.at(-1).total);
});

test("native tiles find 58px codes in a 4000×3000 image even when overview finds another code", async () => {
  const canvas = new PixelCanvas(4000, 3000);
  drawQR(canvas, "small repeated", 1003, 755, 2); // Crosses initial horizontal and vertical tile edges.
  drawQR(canvas, "small repeated", 1900, 1800, 2);
  drawQR(canvas, "overview code", 2850, 1200, 8);
  const original = checksum(canvas);
  const progress = [];
  const results = await QRDetection.detectCanvas(canvas, { onProgress: (p) => progress.push(p) });
  assert.equal(results.length, 3);
  assert.equal(results.filter((det) => det.data === "small repeated").length, 2);
  const overview = progress.find((p) => p.phase === "overview" && p.completed === 1);
  assert.equal(overview.found, 1);
  assert.ok(progress.at(-1).total >= 21);
  assert.equal(progress.at(-1).completed, progress.at(-1).total);
  const first = results.find((det) => det.data === "small repeated" && det.loc.tl.x < 1500);
  assert.ok(Math.abs(first.loc.tl.x - 1003) < 2);
  assert.ok(Math.abs(first.loc.tl.y - 755) < 2);
  assert.equal(checksum(canvas), original);
});

test("small native tiles isolate aligned QR codes that a full-resolution overview cannot decode", async () => {
  const canvas = new PixelCanvas(960, 620);
  drawQR(canvas, "123456789012", 120, 120, 6);
  drawQR(canvas, "original second", 620, 120, 6);
  const progress = [];
  const results = await QRDetection.detectCanvas(canvas, { onProgress: (p) => progress.push(p) });
  assert.deepEqual(results.map((det) => det.data).sort(), ["123456789012", "original second"]);
  assert.equal(progress.find((p) => p.phase === "overview" && p.completed === 1).found, 0);
  assert.equal(progress.at(-1).completed, progress.at(-1).total);
  assert.ok(results.some((det) => Math.abs(det.loc.tl.x - 120) < 2));
  assert.ok(results.some((det) => Math.abs(det.loc.tl.x - 620) < 2));
});

test("failed detailed large tiles retry smaller crops without refining blank tiles", async () => {
  const canvas = new PixelCanvas(2100, 1100);
  drawQR(canvas, "123456789012", 120, 120, 6);
  drawQR(canvas, "original second", 620, 120, 6);
  const progress = [];
  const results = await QRDetection.detectCanvas(canvas, { onProgress: (p) => progress.push(p) });
  assert.deepEqual(results.map((det) => det.data).sort(), ["123456789012", "original second"]);
  assert.ok(progress.some((p) => p.phase === "detail"));
  assert.equal(progress.at(-1).completed, progress.at(-1).total);
  assert.ok(progress.at(-1).total < 61); // Six base tiles, but blank tiles need no nine-way retries.
  const blankProgress = [];
  assert.deepEqual(await QRDetection.detectCanvas(new PixelCanvas(2100, 1100), {
    onProgress: (p) => blankProgress.push(p),
  }), []);
  assert.equal(blankProgress.at(-1).total, 7);
});

test("supports inverted QR codes", async () => {
  const canvas = new PixelCanvas(160, 160);
  drawQR(canvas, "inverted", 35, 35);
  for (let i = 0; i < canvas.data.length; i += 4) {
    canvas.data[i] = 255 - canvas.data[i];
    canvas.data[i + 1] = 255 - canvas.data[i + 1];
    canvas.data[i + 2] = 255 - canvas.data[i + 2];
  }
  const [result] = await QRDetection.detectCanvas(canvas);
  assert.equal(result.data, "inverted");
});

test("deduplication retains separate tilted polygons whose bounding boxes overlap", async () => {
  const oldDecoder = global.jsQR;
  const candidates = [
    [{ x: 20, y: 20 }, { x: 120, y: 120 }, { x: 115, y: 125 }, { x: 15, y: 25 }],
    [{ x: 30, y: 10 }, { x: 130, y: 110 }, { x: 125, y: 115 }, { x: 25, y: 15 }],
  ];
  global.jsQR = () => {
    const points = candidates.shift();
    return points ? { data: "same content", version: 3, location: { topLeftCorner: points[0],
      topRightCorner: points[1], bottomRightCorner: points[2], bottomLeftCorner: points[3] } } : null;
  };
  try {
    const results = await QRDetection.detectCanvas(new PixelCanvas(160, 160));
    assert.equal(results.length, 2);
  } finally { global.jsQR = oldDecoder; }
});

test("honors an explicit detection limit", async () => {
  const canvas = new PixelCanvas(320, 150);
  drawQR(canvas, "first", 25, 25);
  drawQR(canvas, "second", 205, 25);
  const results = await QRDetection.detectCanvas(canvas, { maxDetections: 1 });
  assert.equal(results.length, 1);
});

test("aborts before start or between scan regions", async () => {
  const canvas = new PixelCanvas(1800, 80);
  const before = new AbortController();
  before.abort();
  await assert.rejects(QRDetection.detectCanvas(canvas, { signal: before.signal }), { name: "AbortError" });
  const during = new AbortController();
  let completed = 0;
  await assert.rejects(QRDetection.detectCanvas(canvas, {
    signal: during.signal,
    onProgress: (p) => { if (p.completed) { completed = p.completed; during.abort(); } },
  }), { name: "AbortError" });
  assert.equal(completed, 1);
});

test("rejects oversized scans before creating image working copies", async () => {
  await assert.rejects(QRDetection.detectCanvas({ width: 100000, height: 100000,
    getContext: () => { throw new Error("Must not read an unbounded source"); } }), /图片过大/);
  await assert.rejects(QRDetection.detectCanvas({ width: 0, height: 0, getContext() {} }), /没有可识别/);
});

test("worker load failure re-reads pixels and falls back to local decoding", async () => {
  const canvas = new PixelCanvas(160, 160);
  drawQR(canvas, "worker fallback", 35, 35);
  let terminated = false, usedWorker = false;
  const oldLocation = global.location, oldWorker = global.Worker;
  global.location = { protocol: "http:", href: "http://localhost/index.html" };
  global.Worker = class {
    postMessage() { usedWorker = true; setTimeout(() => this.onerror(new Error("blocked")), 0); }
    terminate() { terminated = true; }
  };
  try {
    const [result] = await QRDetection.detectCanvas(canvas);
    assert.equal(result.data, "worker fallback");
    assert.ok(usedWorker && terminated);
  } finally {
    global.location = oldLocation;
    global.Worker = oldWorker;
  }
});

test("cancellation terminates an in-flight worker and rejects instead of returning partial detections", async () => {
  const canvas = new PixelCanvas(100, 100);
  const controller = new AbortController();
  let terminated = false;
  const oldLocation = global.location, oldWorker = global.Worker;
  global.location = { protocol: "http:", href: "http://localhost/index.html" };
  global.Worker = class {
    postMessage() { setTimeout(() => controller.abort(), 0); }
    terminate() { terminated = true; }
  };
  try {
    await assert.rejects(QRDetection.detectCanvas(canvas, { signal: controller.signal }), { name: "AbortError" });
    assert.ok(terminated);
  } finally {
    global.location = oldLocation;
    global.Worker = oldWorker;
  }
});
