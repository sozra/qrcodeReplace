/* QR 置换台 — 主逻辑
 * 依赖: vendor/jsQR.js (识别), vendor/qrcode.js + qrcode_UTF8.js (生成)
 */
"use strict";

// ---------------------------------------------------------------- state

const state = {
  img: null,          // HTMLImageElement 原图
  srcCanvas: null,    // 原图自然尺寸画布（用于取色/导出底图）
  detections: [],     // { id, data, version, loc:{tl,tr,br,bl}, enabled }
  text: "你还真扫啊",
  ec: "M",
  matchVersion: true,
};

const PRESETS = [
  "你还真扫啊",
  "此码已休假，有事烧纸",
  "404: QR Not Found",
  "https://www.bilibili.com/video/BV1GJ411x7h7",
  "扫码结果：一个神秘的微笑 :)",
  "恭喜你浪费了 3 秒钟",
];

const MAX_DETECTIONS = 8;
const DETECT_MAX_DIM = 1600;

// ---------------------------------------------------------------- dom

const $ = (id) => document.getElementById(id);
const stage = $("stage"), dropzone = $("dropzone"), view = $("view");
const draghint = $("draghint"), fileInput = $("fileInput");
const inpText = $("inpText"), presetsBox = $("presets");
const segEc = $("segEc"), chkMatch = $("chkMatch");
const detsBox = $("dets"), detsEmpty = $("detsEmpty");
const btnCopy = $("btnCopy"), btnDownload = $("btnDownload"), btnRescan = $("btnRescan");
const toastEl = $("toast");

const resultCanvas = document.createElement("canvas");

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
}

// ---------------------------------------------------------------- geometry

function quadCenter(q) {
  return {
    x: (q.tl.x + q.tr.x + q.br.x + q.bl.x) / 4,
    y: (q.tl.y + q.tr.y + q.br.y + q.bl.y) / 4,
  };
}

function expandQuad(q, factor) {
  const c = quadCenter(q);
  const ex = (p) => ({ x: c.x + (p.x - c.x) * factor, y: c.y + (p.y - c.y) * factor });
  return { tl: ex(q.tl), tr: ex(q.tr), br: ex(q.br), bl: ex(q.bl) };
}

function pathQuad(ctx, q) {
  ctx.beginPath();
  ctx.moveTo(q.tl.x, q.tl.y);
  ctx.lineTo(q.tr.x, q.tr.y);
  ctx.lineTo(q.br.x, q.br.y);
  ctx.lineTo(q.bl.x, q.bl.y);
  ctx.closePath();
}

function pointInQuad(x, y, q) {
  const pts = [q.tl, q.tr, q.br, q.bl];
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

// 边的朝外法向量（远离四边形中心）
function sideNormal(a, b, center) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len, ny = dx / len;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  if (nx * (mx - center.x) + ny * (my - center.y) < 0) { nx = -nx; ny = -ny; }
  return { x: nx, y: ny };
}

function samplePx(ctx, W, H, x, y) {
  x = Math.min(Math.max(Math.round(x), 0), W - 1);
  y = Math.min(Math.max(Math.round(y), 0), H - 1);
  return ctx.getImageData(x, y, 1, 1).data;
}

// 沿法向量向外扫描，返回与底色相近的连续区域宽度（即该侧静区宽度）
function measureSide(ctx, W, H, a, b, normal, modulePx) {
  const maxT = modulePx * 10;
  const step = Math.max(1, modulePx / 4);
  let ref = null, lastGood = 0;
  for (let t = step; t <= maxT; t += step) {
    let ok = true;
    const samples = [];
    for (const k of [0.3, 0.5, 0.7]) {
      const px = a.x + (b.x - a.x) * k + normal.x * t;
      const py = a.y + (b.y - a.y) * k + normal.y * t;
      const d = samplePx(ctx, W, H, px, py);
      samples.push(d);
      if (ref && Math.hypot(d[0] - ref[0], d[1] - ref[1], d[2] - ref[2]) > 48) ok = false;
    }
    if (!ref) ref = samples[1];
    if (!ok) break;
    lastGood = t;
  }
  return lastGood;
}

// 实测原码的真实外框（码区 + 各侧实际静区）与衬底色
function measureFootprint(det) {
  const ctx = state.srcCanvas.getContext("2d", { willReadFrequently: true });
  const W = state.srcCanvas.width, H = state.srcCanvas.height;
  const q = det.loc, c = quadCenter(q);
  const n = 17 + 4 * (det.version || 4);
  const sideLen = (Math.hypot(q.tr.x - q.tl.x, q.tr.y - q.tl.y) +
                   Math.hypot(q.bl.x - q.tl.x, q.bl.y - q.tl.y)) / 2;
  const modulePx = sideLen / n;

  const nTop = sideNormal(q.tl, q.tr, c);
  const nRight = sideNormal(q.tr, q.br, c);
  const nBottom = sideNormal(q.br, q.bl, c);
  const nLeft = sideNormal(q.bl, q.tl, c);

  const t = measureSide(ctx, W, H, q.tl, q.tr, nTop, modulePx);
  const r = measureSide(ctx, W, H, q.tr, q.br, nRight, modulePx);
  const b = measureSide(ctx, W, H, q.br, q.bl, nBottom, modulePx);
  const l = measureSide(ctx, W, H, q.bl, q.tl, nLeft, modulePx);

  const off = (p, n1, d1, n2, d2) => ({ x: p.x + n1.x * d1 + n2.x * d2, y: p.y + n1.y * d1 + n2.y * d2 });
  const quad = {
    tl: off(q.tl, nTop, t, nLeft, l),
    tr: off(q.tr, nTop, t, nRight, r),
    br: off(q.br, nBottom, b, nRight, r),
    bl: off(q.bl, nBottom, b, nLeft, l),
  };

  // 静区够宽时取静区原色作为衬底，否则退回纯白
  let bg = "#ffffff";
  if (Math.min(t, r, b, l) > modulePx * 0.5) {
    const spots = [
      { p: { x: (q.tl.x + q.tr.x) / 2, y: (q.tl.y + q.tr.y) / 2 }, n: nTop, d: t / 2 },
      { p: { x: (q.tr.x + q.br.x) / 2, y: (q.tr.y + q.br.y) / 2 }, n: nRight, d: r / 2 },
      { p: { x: (q.br.x + q.bl.x) / 2, y: (q.br.y + q.bl.y) / 2 }, n: nBottom, d: b / 2 },
      { p: { x: (q.bl.x + q.tl.x) / 2, y: (q.bl.y + q.tl.y) / 2 }, n: nLeft, d: l / 2 },
    ];
    let rr = 0, gg = 0, bb = 0;
    for (const s of spots) {
      const d = samplePx(ctx, W, H, s.p.x + s.n.x * s.d, s.p.y + s.n.y * s.d);
      rr += d[0]; gg += d[1]; bb += d[2];
    }
    bg = `rgb(${Math.round(rr / 4)},${Math.round(gg / 4)},${Math.round(bb / 4)})`;
  }
  return { quad, bg, modulePx, quiet: { t, r, b, l } };
}

// 单位正方形 (0,0)(1,0)(1,1)(0,1) → 目标四边形 的透射变换
function homographyToQuad(q) {
  const src = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const dst = [q.tl, q.tr, q.br, q.bl];
  const A = [], B = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); B.push(v);
  }
  // 高斯消元（部分主元）
  const n = 8;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]]; [B[col], B[piv]] = [B[piv], B[col]];
    const d = A[col][col] || 1e-12;
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / d;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      B[r] -= f * B[col];
    }
  }
  const h = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = B[r];
    for (let c = r + 1; c < n; c++) s -= A[r][c] * h[c];
    h[r] = s / (A[r][r] || 1e-12);
  }
  return (x, y) => {
    const d = h[6] * x + h[7] * y + 1;
    return { x: (h[0] * x + h[1] * y + h[2]) / d, y: (h[3] * x + h[4] * y + h[5]) / d };
  };
}

// ---------------------------------------------------------------- detection

function runDetection() {
  const w = state.srcCanvas.width, h = state.srcCanvas.height;
  const scale = Math.min(1, DETECT_MAX_DIM / Math.max(w, h));
  const dw = Math.round(w * scale), dh = Math.round(h * scale);

  const det = document.createElement("canvas");
  det.width = dw; det.height = dh;
  const dctx = det.getContext("2d", { willReadFrequently: true });
  dctx.drawImage(state.srcCanvas, 0, 0, dw, dh);

  const found = [];
  for (let iter = 0; iter < MAX_DETECTIONS; iter++) {
    const imgData = dctx.getImageData(0, 0, dw, dh);
    const res = jsQR(imgData.data, dw, dh, { inversionAttempts: "attemptBoth" });
    if (!res) break;
    const inv = 1 / scale;
    const loc = {
      tl: { x: res.location.topLeftCorner.x * inv, y: res.location.topLeftCorner.y * inv },
      tr: { x: res.location.topRightCorner.x * inv, y: res.location.topRightCorner.y * inv },
      br: { x: res.location.bottomRightCorner.x * inv, y: res.location.bottomRightCorner.y * inv },
      bl: { x: res.location.bottomLeftCorner.x * inv, y: res.location.bottomLeftCorner.y * inv },
    };
    found.push({
      id: found.length + 1,
      data: res.data,
      version: res.version || 0,
      loc,
      enabled: true,
    });
    // 在检测画布上抹掉该码，继续找下一个
    const n = 17 + 4 * (res.version || 4);
    dctx.fillStyle = "#fff";
    pathQuad(dctx, expandQuad({
      tl: res.location.topLeftCorner, tr: res.location.topRightCorner,
      br: res.location.bottomRightCorner, bl: res.location.bottomLeftCorner,
    }, (n + 12) / n));
    dctx.fill();
  }
  for (const det of found) det.foot = measureFootprint(det);
  state.detections = found;
}

// ---------------------------------------------------------------- rendering

function buildQR(version) {
  const text = state.text;
  if (!text) return null;
  const tryMake = (t) => {
    const qr = qrcode(t, state.ec);
    qr.addData(text);
    qr.make();
    return qr;
  };
  if (state.matchVersion && version >= 1 && version <= 40) {
    try { return tryMake(version); } catch (e) { /* 内容超长则回落自动版本 */ }
  }
  return tryMake(0);
}

function renderResult() {
  if (!state.img) return;
  const w = state.srcCanvas.width, h = state.srcCanvas.height;
  resultCanvas.width = w; resultCanvas.height = h;
  const ctx = resultCanvas.getContext("2d");
  ctx.drawImage(state.srcCanvas, 0, 0);

  for (const det of state.detections) {
    if (!det.enabled) continue;
    ctx.fillStyle = det.foot.bg;
    pathQuad(ctx, det.foot.quad);
    ctx.fill();

    const qr = buildQR(det.version);
    if (!qr) continue;
    const m = qr.getModuleCount();
    const map = homographyToQuad(det.loc);        // 模块网格对齐原码区
    ctx.fillStyle = "#000000";
    for (let r = 0; r < m; r++) {
      for (let c = 0; c < m; c++) {
        if (!qr.isDark(r, c)) continue;
        const p0 = map(c / m, r / m);
        const p1 = map((c + 1) / m, r / m);
        const p2 = map((c + 1) / m, (r + 1) / m);
        const p3 = map(c / m, (r + 1) / m);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.lineTo(p3.x, p3.y);
        ctx.closePath();
        ctx.fill();
      }
    }
  }
}

function renderView() {
  renderResult();
  if (!state.img) return;
  const w = resultCanvas.width, h = resultCanvas.height;
  view.width = w; view.height = h;
  const ctx = view.getContext("2d");
  ctx.drawImage(resultCanvas, 0, 0);

  // 标注层（不进导出结果）
  const lw = Math.max(2, Math.min(w, h) / 400);
  const badgeR = lw * 7;
  ctx.lineWidth = lw;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${badgeR * 1.1}px ui-monospace, monospace`;
  for (const det of state.detections) {
    const quad = det.foot.quad;
    ctx.strokeStyle = det.enabled ? "#f0b942" : "rgba(255,255,255,0.45)";
    ctx.setLineDash(det.enabled ? [] : [lw * 3, lw * 3]);
    pathQuad(ctx, quad);
    ctx.stroke();
    ctx.setLineDash([]);
    const bx = quad.tl.x, by = quad.tl.y - badgeR * 1.6;
    ctx.beginPath();
    ctx.arc(bx, by, badgeR, 0, Math.PI * 2);
    ctx.fillStyle = det.enabled ? "#f0b942" : "rgba(255,255,255,0.45)";
    ctx.fill();
    ctx.fillStyle = "#1d1605";
    ctx.fillText(String(det.id), bx, by + badgeR * 0.05);
  }
}

// ---------------------------------------------------------------- detections list

const EYE_ON = '<svg class="det-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg class="det-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.16 3.19"/><path d="M6.61 6.61A17.5 17.5 0 0 0 2 12s3.5 7 10 7c.66 0 1.3-.06 1.92-.18"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';

function renderDetList() {
  detsBox.querySelectorAll(".det").forEach((el) => el.remove());
  if (!state.img) {
    detsEmpty.textContent = "尚未载入图片";
    detsEmpty.classList.remove("hidden");
    return;
  }
  if (state.detections.length === 0) {
    detsEmpty.textContent = "未检测到二维码";
    detsEmpty.classList.remove("hidden");
    return;
  }
  detsEmpty.classList.add("hidden");
  for (const det of state.detections) {
    const n = 17 + 4 * (det.version || 0);
    const el = document.createElement("div");
    el.className = "det" + (det.enabled ? "" : " off");
    el.innerHTML = `
      <div class="det-badge">${det.id}</div>
      <div class="det-body">
        <div class="det-data" title="${escapeHtml(det.data)}">${escapeHtml(det.data)}</div>
        <div class="det-meta">v${det.version || "?"} · ${n}×${n} · 点击卡片或图上标记可切换</div>
      </div>
      ${det.enabled ? EYE_ON : EYE_OFF}`;
    el.addEventListener("click", () => toggleDet(det.id));
    detsBox.appendChild(el);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toggleDet(id) {
  const det = state.detections.find((d) => d.id === id);
  if (!det) return;
  det.enabled = !det.enabled;
  renderView();
  renderDetList();
}

// ---------------------------------------------------------------- image loading

function loadImage(img) {
  state.img = img;
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext("2d").drawImage(img, 0, 0);
  state.srcCanvas = c;

  dropzone.classList.add("hidden");
  view.classList.remove("hidden");
  btnCopy.disabled = false;
  btnDownload.disabled = false;
  btnRescan.disabled = false;

  runDetection();
  renderView();
  renderDetList();
  toast(state.detections.length
    ? `检测到 ${state.detections.length} 个二维码`
    : "未检测到二维码，可换张图或重扫");
}

function loadFile(file) {
  if (!file || !file.type.startsWith("image/")) { toast("请选择图片文件"); return; }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => { loadImage(img); URL.revokeObjectURL(url); };
  img.onerror = () => { toast("图片载入失败"); URL.revokeObjectURL(url); };
  img.src = url;
}

// ---------------------------------------------------------------- events

dropzone.addEventListener("click", () => fileInput.click());
$("btnBrowse").addEventListener("click", (e) => { e.stopPropagation(); fileInput.click(); });
fileInput.addEventListener("change", () => { loadFile(fileInput.files[0]); fileInput.value = ""; });

document.addEventListener("paste", (e) => {
  for (const item of e.clipboardData.items) {
    if (item.type.startsWith("image/")) { loadFile(item.getAsFile()); e.preventDefault(); return; }
  }
});

let dragDepth = 0;
document.addEventListener("dragenter", (e) => {
  if (![...e.dataTransfer.types].includes("Files")) return;
  dragDepth++;
  draghint.classList.remove("hidden");
});
document.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) draghint.classList.add("hidden");
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  draghint.classList.add("hidden");
  loadFile(e.dataTransfer.files[0]);
});

view.addEventListener("click", (e) => {
  const rect = view.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * view.width;
  const y = ((e.clientY - rect.top) / rect.height) * view.height;
  for (let i = state.detections.length - 1; i >= 0; i--) {
    const det = state.detections[i];
    if (pointInQuad(x, y, det.foot.quad)) {
      toggleDet(det.id);
      return;
    }
  }
});

// ---------------------------------------------------------------- controls

inpText.addEventListener("input", () => { state.text = inpText.value; renderView(); });

for (const p of PRESETS) {
  const chip = document.createElement("button");
  chip.className = "chip";
  chip.textContent = p;
  chip.title = p;
  chip.addEventListener("click", () => {
    state.text = p;
    inpText.value = p;
    renderView();
  });
  presetsBox.appendChild(chip);
}

segEc.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-ec]");
  if (!btn) return;
  state.ec = btn.dataset.ec;
  segEc.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
  renderView();
});

chkMatch.addEventListener("change", () => { state.matchVersion = chkMatch.checked; renderView(); });

btnRescan.addEventListener("click", () => {
  if (!state.img) return;
  runDetection();
  renderView();
  renderDetList();
  toast(state.detections.length ? `检测到 ${state.detections.length} 个二维码` : "仍未检测到二维码");
});

btnDownload.addEventListener("click", () => {
  renderResult();
  resultCanvas.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "qr-replaced.png";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast("已导出 PNG");
  }, "image/png");
});

btnCopy.addEventListener("click", async () => {
  renderResult();
  try {
    const blob = await new Promise((res) => resultCanvas.toBlob(res, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast("已复制到剪贴板");
  } catch (e) {
    toast("复制失败：" + e.message);
  }
});
