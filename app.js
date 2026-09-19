/* QR 置换台 — 主逻辑
 * 依赖: vendor/jsQR.js (识别), vendor/qrcode.js + qrcode_UTF8.js (生成)
 */
"use strict";

// ---------------------------------------------------------------- state

const state = {
  img: null,          // HTMLImageElement 原图
  srcCanvas: null,    // 原图自然尺寸画布（用于取色/导出底图）
  srcName: null,      // 导入文件的原名（用于导出命名）
  detections: [],     // { id, data, version, loc:{tl,tr,br,bl}, enabled }
  text: "你还真扫啊",
  ec: "M",
  matchVersion: true,
  reboxFor: null,     // 正在框选取票号区域的 detection
  selectedId: null,
  tool: "select",
  comparing: false,
};

// 内容像取票号（纯数字，允许空格/短横）时才启用号码处理
const NUM_RE = /^\d[\d\s-]{4,}\d$/;

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
const btnImport = $("btnImport"), btnReimport = $("btnReimport");
const inpText = $("inpText"), presetsBox = $("presets");
const segEc = $("segEc"), chkMatch = $("chkMatch");
const detsBox = $("dets"), detsEmpty = $("detsEmpty");
const btnCopy = $("btnCopy"), btnDownload = $("btnDownload"), btnRescan = $("btnRescan");
const toastEl = $("toast");

const resultCanvas = document.createElement("canvas");
const viewport = $("viewport");
const camera = { scale: 1, fit: 1, x: 0, y: 0 };
const editorHistory = new EditorHistory(60);
let historyTimer = null;
let validationRun = null;
let revision = 0;
let renderError = "";
let dragInfo = null;
let viewRaf = 0;
let pendingExport = null;
let importSequence = 0;
const pointers = new Map();
const clampNum = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

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

function pxLum(d) {
  return 0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2];
}

// 沿法向量向外扫描，返回与底色相近的连续区域宽度（即该侧静区宽度）
function measureSide(ctx, W, H, a, b, normal, modulePx) {
  // 标准静区为 4 个模块，外扩再多没有收益，只会盖住周边内容
  const maxT = modulePx * 4;
  const step = Math.max(1, modulePx / 4);
  // 沿边加密采样，避免漏掉不居中的文字
  const K = [0.15, 0.28, 0.41, 0.54, 0.67, 0.8, 0.93];
  let ref = null, lastGood = 0;
  for (let t = step; t <= maxT; t += step) {
    const samples = K.map((k) => samplePx(ctx, W, H,
      a.x + (b.x - a.x) * k + normal.x * t,
      a.y + (b.y - a.y) * k + normal.y * t));
    // 以最亮的采样点为底色基准，避开码边缘残留的深色像素
    if (!ref) ref = samples.reduce((best, s) => (pxLum(s) > pxLum(best) ? s : best), samples[0]);
    const hit = samples.some((d) =>
      Math.hypot(d[0] - ref[0], d[1] - ref[1], d[2] - ref[2]) > 26);
    if (hit) break;
    lastGood = t;
  }
  // 回退一步，把贴到文字抗锯齿边缘的那步让出来
  return Math.min(Math.max(lastGood - step, modulePx * 0.4), maxT);
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
  for (const det of found) suggestNumberRegion(det);
}

// ---------------------------------------------------------------- 取票号定位

// 连续墨色列合并为笔画串（合并 1px 的抗锯齿空洞）
function inkRuns(colInk) {
  const runs = [];
  for (let i = 0; i < colInk.length; i++) {
    if (colInk[i] > 0) {
      const last = runs[runs.length - 1];
      if (last && i - last.x1 <= 2) last.x1 = i;
      else runs.push({ x0: i, x1: i });
    }
  }
  return runs;
}

// 在码的上方/下方寻找最深的横向文字带，作为取票号区域的候选
function suggestNumberRegion(det) {
  det.numMode = "off";
  det.numRegion = null;
  det.numDigits = null;
  det._numAn = null;
  if (!NUM_RE.test(det.data.trim())) return;

  const ctx = state.srcCanvas.getContext("2d", { willReadFrequently: true });
  const W = state.srcCanvas.width, H = state.srcCanvas.height;
  const q = det.loc;
  const sideLen = (Math.hypot(q.tr.x - q.tl.x, q.tr.y - q.tl.y) +
                   Math.hypot(q.bl.x - q.tl.x, q.bl.y - q.tl.y)) / 2;
  const modulePx = det.foot.modulePx;
  const INK_LUM = 145;   // 只认足够深的字，过滤掉浅灰说明文字
  const x0 = Math.max(0, Math.round(Math.min(q.tl.x, q.bl.x) - sideLen * 0.35));
  const x1 = Math.min(W, Math.round(Math.max(q.tr.x, q.br.x) + sideLen * 0.35));
  const yTop = Math.min(q.tl.y, q.tr.y);
  const yBot = Math.max(q.bl.y, q.br.y);
  const reach = sideLen * 0.6;   // 号码一般紧贴码区，搜太远容易捞到别的文字

  const findBand = (yA, yB) => {
    yA = Math.max(0, Math.round(yA)); yB = Math.min(H, Math.round(yB));
    const sw = x1 - x0, sh = yB - yA;
    if (sw < 8 || sh < 8) return null;
    const data = ctx.getImageData(x0, yA, sw, sh).data;
    const rowInk = new Uint32Array(sh);
    for (let y = 0; y < sh; y++) {
      let cnt = 0;
      for (let x = 0; x < sw; x++) {
        const i = (y * sw + x) * 4;
        if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < INK_LUM) cnt++;
      }
      rowInk[y] = cnt;
    }
    const minCnt = Math.max(3, sw * 0.003);
    const gapTol = Math.max(2, modulePx * 0.35);
    const minH = Math.max(6, modulePx * 0.9);
    const maxH = modulePx * 3.2; // 号码字高通常在 1~3 个模块之间，更高的是标题等其他内容
    const bands = [];
    for (let y = 0; y < sh; y++) {
      if (rowInk[y] >= minCnt) {
        const last = bands[bands.length - 1];
        if (last && y - last.y1 <= gapTol) last.y1 = y;
        else bands.push({ y0: y, y1: y });
      }
    }
    const good = bands.filter((b) => {
      const bh = b.y1 - b.y0 + 1;
      return bh >= minH && bh <= maxH;
    });
    if (!good.length) return null;
    // 号码通常是该区域里字最高的一行
    good.sort((p, n) => (n.y1 - n.y0) - (p.y1 - p.y0));
    const b = good[0];

    // 该行内墨色列范围 + 列轮廓
    const colInk = new Uint32Array(sw);
    let ix0 = -1, ix1 = -1;
    for (let x = 0; x < sw; x++) {
      let cnt = 0;
      for (let y = b.y0; y <= b.y1; y++) {
        const i = (y * sw + x) * 4;
        if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < INK_LUM) cnt++;
      }
      colInk[x] = cnt;
      if (cnt > 0) { if (ix0 < 0) ix0 = x; ix1 = x; }
    }
    if (ix0 < 0) return null;

    return {
      x0: x0 + ix0, x1: x0 + ix1,
      y0: yA + b.y0, y1: yA + b.y1,
    };
  };

  // 优先取码下方的文字带，找不到再看上方
  const band = findBand(yBot + modulePx * 1.5, yBot + reach) ||
               findBand(yTop - reach, yTop - modulePx * 1.5);
  if (!band) return;

  const padX = (band.x1 - band.x0) * 0.06 + 2;
  const padY = (band.y1 - band.y0) * 0.25 + 2;
  const rx0 = Math.max(0, band.x0 - padX), ry0 = Math.max(0, band.y0 - padY);
  const rx1 = Math.min(W, band.x1 + padX), ry1 = Math.min(H, band.y1 + padY);
  det.numRegion = { x: rx0, y: ry0, w: rx1 - rx0, h: ry1 - ry0 };
  // 只给出候选区域，默认不改动图像，由用户在卡片里主动选择遮盖/换号
  det.numMode = "off";
}

// ---------------------------------------------------------------- rendering

// ---------------------------------------------------------------- 取票号绘制

// 分析号码区域：背景色、墨色、字形范围、空格分组（按区域坐标缓存）
function analyzeNumber(det) {
  const r = det.numRegion;
  const sig = [r.x, r.y, r.w, r.h].map(Math.round).join(",");
  if (det._numAn && det._numAn.sig === sig) return det._numAn;

  const ctx = state.srcCanvas.getContext("2d", { willReadFrequently: true });
  const W = state.srcCanvas.width, H = state.srcCanvas.height;
  const rx = Math.max(0, Math.round(r.x)), ry = Math.max(0, Math.round(r.y));
  const rw = Math.min(W - rx, Math.round(r.w)), rh = Math.min(H - ry, Math.round(r.h));
  const an = { sig, bg: "#ffffff", empty: true };
  if (rw < 4 || rh < 4) { det._numAn = an; return an; }

  // 背景色：取区域外侧一圈的亮色像素
  let br = 0, bgc = 0, bgg = 0, bgb = 0, blum = 0;
  const ring = (x, y) => {
    const d = samplePx(ctx, W, H, x, y);
    const l = pxLum(d);
    if (l > 150) { br += d[0]; bgg += d[1]; bgb += d[2]; blum += l; bgc++; }
  };
  for (let k = 0; k <= 4; k++) {
    const fx = rx + ((rw - 1) * k) / 4, fy = ry + ((rh - 1) * k) / 4;
    ring(fx, ry - 2); ring(fx, ry + rh + 1); ring(rx - 2, fy); ring(rx + rw + 1, fy);
  }
  let bgLum = 255;
  if (bgc) {
    br = Math.round(br / bgc); bgg = Math.round(bgg / bgc); bgb = Math.round(bgb / bgc);
    an.bg = `rgb(${br},${bgg},${bgb})`;
    bgLum = blum / bgc;
  }

  const img = ctx.getImageData(rx, ry, rw, rh).data;
  const inkThr = bgLum - 60;
  const lumAt = (x, y) => {
    const i = (y * rw + x) * 4;
    return 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2];
  };

  // 字形范围与墨色
  let ix0 = -1, ix1 = -1, iy0 = -1, iy1 = -1, inkN = 0;
  let cr = 0, cg = 0, cb = 0, cn = 0;
  const coreThr = bgLum - 110;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const l = lumAt(x, y);
      if (l >= inkThr) continue;
      inkN++;
      if (ix0 < 0 || x < ix0) ix0 = x;
      if (x > ix1) ix1 = x;
      if (iy0 < 0 || y < iy0) iy0 = y;
      if (y > iy1) iy1 = y;
      if (l < coreThr) {
        const i = (y * rw + x) * 4;
        cr += img[i]; cg += img[i + 1]; cb += img[i + 2]; cn++;
      }
    }
  }
  if (inkN < 8 || ix0 < 0) { det._numAn = an; return an; }

  an.empty = false;
  an.bounds = { x0: rx + ix0, x1: rx + ix1, y0: ry + iy0, y1: ry + iy1 };
  an.ink = cn ? `rgb(${Math.round(cr / cn)},${Math.round(cg / cn)},${Math.round(cb / cn)})` : "#222222";

  const L = Math.max(1, det.data.replace(/\D/g, "").length);
  const spanH = iy1 - iy0 + 1;
  const colInk = new Uint32Array(ix1 - ix0 + 1);
  for (let x = ix0; x <= ix1; x++) {
    let cnt = 0;
    for (let y = iy0; y <= iy1; y++) if (lumAt(x, y) < inkThr) cnt++;
    colInk[x - ix0] = cnt;
  }
  const runs = inkRuns(colInk);
  // 每个数字通常是一个独立笔画串，标签（如“取票号”）在左边，
  // 从右往左数 L 个笔画串即为号码本体，避免把标签当号码或切进号码中间
  const numRuns = runs.slice(Math.max(0, runs.length - L));
  const nx0 = ix0 + numRuns[0].x0, nx1 = ix0 + numRuns[numRuns.length - 1].x1;
  const spanW = nx1 - nx0 + 1;
  const pitch = spanW / L;
  // 空格分组：间隙明显大于字距中位数的位置视为空格，每组位数 = 笔画串数
  const gaps = [];
  for (let i = 1; i < numRuns.length; i++) gaps.push(numRuns[i].x0 - numRuns[i - 1].x1 - 1);
  const medGap = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor((gaps.length - 1) / 2)] : 0;
  const spaceThr = Math.max(3, medGap * 1.35);
  const groups = [];
  let cnt = 1;
  for (let i = 1; i < numRuns.length; i++) {
    if (gaps[i - 1] > spaceThr) { groups.push(cnt); cnt = 1; }
    else cnt++;
  }
  groups.push(cnt);
  an.groups = groups;
  an.L = L;
  an.numBounds = { x0: rx + nx0, x1: rx + nx1, y0: an.bounds.y0, y1: an.bounds.y1 };

  // 按墨色密度估一个字重，让新号码粗细接近原来的
  const density = inkN / (spanW * spanH);
  an.weight = density > 0.3 ? 700 : density > 0.2 ? 600 : 500;

  det._numAn = an;
  return an;
}

function genDigits(det, L) {
  const orig = det.data.replace(/\D/g, "");
  let s = "";
  do {
    s = "";
    for (let i = 0; i < L; i++) s += Math.floor(Math.random() * 10);
  } while (s === orig);
  return s;
}

function groupDigits(digits, groups) {
  if (!groups || !groups.length) return digits;
  const out = [];
  let i = 0;
  for (const g of groups) { out.push(digits.slice(i, i + g)); i += g; }
  if (i < digits.length) out.push(digits.slice(i));
  return out.filter(Boolean).join(" ");
}

function drawNumberRegion(ctx, det) {
  const r = det.numRegion;
  const an = analyzeNumber(det);
  ctx.fillStyle = an.bg;
  // 遮盖模式：整块盖掉；换号模式：只盖号码本体，保留“取票号”等标签
  if (det.numMode !== "replace" || an.empty) {
    ctx.fillRect(r.x, r.y, r.w, r.h);
    return;
  }

  if (!det.numDigits) det.numDigits = genDigits(det, an.L);
  const text = groupDigits(det.numDigits, an.groups);
  const nb = an.numBounds;
  const bh = nb.y1 - nb.y0 + 1;
  const bw = nb.x1 - nb.x0 + 1;
  const padX = Math.max(2, (bw / an.L) * 0.35);
  const padY = Math.max(2, bh * 0.18);
  ctx.fillRect(nb.x0 - padX, nb.y0 - padY, bw + padX * 2, bh + padY * 2);
  const fam = '"Helvetica Neue", Helvetica, Arial, "PingFang SC", sans-serif';
  let size = bh / 0.72;   // 数字帽高约为字号的 0.72
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${an.weight} ${size}px ${fam}`;
  const tw = ctx.measureText(text).width;
  if (tw > 0) size *= Math.min(1.15, Math.max(0.7, bw / tw));
  ctx.font = `${an.weight} ${size}px ${fam}`;
  ctx.fillStyle = an.ink;
  ctx.fillText(text,
    (nb.x0 + nb.x1) / 2,
    (nb.y0 + nb.y1) / 2 + size * 0.03);
}

const qrCache = new Map();
function buildQR(version) {
  if (!state.text) throw new Error("请输入替换内容；清空文本不会遮盖原码。");
  const key = JSON.stringify([state.text, state.ec, state.matchVersion ? version : 0]);
  if (qrCache.has(key)) return qrCache.get(key);
  const make = (v) => { const qr = qrcode(v, state.ec); qr.addData(state.text); qr.make(); return qr; };
  let qr;
  if (state.matchVersion && version >= 1 && version <= 40) {
    try { qr = make(version); } catch (_) { /* 容量不足时自动升级，并在卡片显示实际版本。 */ }
  }
  try { if (!qr) qr = make(0); }
  catch (_) { throw new Error("替换内容超出二维码容量，请缩短内容或降低容错等级。"); }
  if (qrCache.size >= 24) qrCache.delete(qrCache.keys().next().value);
  qrCache.set(key, qr);
  return qr;
}

function updateExportControls() {
  const disabled = !state.img || !!renderError || !!validationRun || !!dragInfo;
  btnDownload.disabled = disabled;
  btnCopy.disabled = disabled;
  $("btnVerify").disabled = disabled;
  $("renderError").textContent = renderError;
  $("renderError").classList.toggle("hidden", !renderError);
}

function renderResult() {
  if (!state.img) return false;
  const w = state.srcCanvas.width, h = state.srcCanvas.height;
  if (resultCanvas.width !== w || resultCanvas.height !== h) { resultCanvas.width = w; resultCanvas.height = h; }
  const ctx = resultCanvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(state.srcCanvas, 0, 0);
  renderError = "";
  try {
    // 先验证所有生成参数，避免部分替换或旧预览被当作有效结果。
    const codes = state.detections.filter(d => d.enabled).map(det => ({ det, qr: buildQR(det.version) }));
    for (const { det, qr } of codes) {
      const m = qr.getModuleCount();
      det.generatedVersion = (m - 17) / 4;
      ctx.fillStyle = det.foot.bg;
      pathQuad(ctx, det.foot.quad);
      ctx.fill();
      const map = homographyToQuad(det.loc);
      ctx.fillStyle = "#000000";
      for (let r = 0; r < m; r++) for (let c = 0; c < m; c++) {
        if (!qr.isDark(r, c)) continue;
        const p = [map(c / m, r / m), map((c + 1) / m, r / m), map((c + 1) / m, (r + 1) / m), map(c / m, (r + 1) / m)];
        pathQuad(ctx, { tl: p[0], tr: p[1], br: p[2], bl: p[3] });
        ctx.fill();
      }
    }
    for (const det of state.detections) {
      if (det.numMode !== "off" && det.numRegion) drawNumberRegion(ctx, det);
    }
  } catch (e) {
    renderError = e.message || "无法生成替换结果，请调整内容后重试。";
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(state.srcCanvas, 0, 0);
  }
  updateExportControls();
  return !renderError;
}

function renderView(rebuild = true) {
  if (!state.img) return;
  if (rebuild) renderResult();
  const w = state.srcCanvas.width, h = state.srcCanvas.height;
  if (view.width !== w || view.height !== h) { view.width = w; view.height = h; }
  const ctx = view.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(state.comparing ? state.srcCanvas : resultCanvas, 0, 0);
  if (state.comparing) return;
  const unit = 1 / camera.scale;
  ctx.lineWidth = 1.5 * unit;
  ctx.font = `600 ${11 * unit}px -apple-system, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const det of state.detections) {
    const selected = det.id === state.selectedId;
    ctx.strokeStyle = selected ? "#fff1ba" : det.enabled ? "#f0b942" : "#8b919c";
    ctx.setLineDash(det.enabled ? [] : [5 * unit, 4 * unit]);
    pathQuad(ctx, det.loc); ctx.stroke(); ctx.setLineDash([]);
    const bx = det.loc.tl.x, by = Math.max(12 * unit, det.loc.tl.y - 15 * unit);
    ctx.fillStyle = det.enabled ? "#f0b942" : "#8b919c";
    ctx.beginPath(); ctx.arc(bx, by, 10 * unit, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#1d1605"; ctx.fillText(String(det.id), bx, by);
    if (selected && state.tool === "select" && !state.reboxFor) {
      for (const p of Object.values(det.loc)) {
        ctx.fillStyle = "#f0b942"; ctx.fillRect(p.x - 5 * unit, p.y - 5 * unit, 10 * unit, 10 * unit);
        ctx.strokeStyle = "#151719"; ctx.strokeRect(p.x - 5 * unit, p.y - 5 * unit, 10 * unit, 10 * unit);
      }
    }
  }
  for (const det of state.detections) {
    if (det.numMode === "off" || !det.numRegion) continue;
    const r = det.numRegion;
    ctx.strokeStyle = "#4cc2ff";
    ctx.setLineDash([5 * unit, 4 * unit]); ctx.strokeRect(r.x, r.y, r.w, r.h); ctx.setLineDash([]);
    ctx.fillStyle = "#4cc2ff";
    for (const [x, y] of [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]) {
      ctx.fillRect(x - 4 * unit, y - 4 * unit, 8 * unit, 8 * unit);
    }
  }
  if (dragInfo?.kind === "drawQR") {
    const r = dragInfo.rect;
    if (r) { ctx.strokeStyle = "#4cc2ff"; ctx.setLineDash([5 * unit, 3 * unit]); ctx.strokeRect(r.x, r.y, r.w, r.h); ctx.setLineDash([]); }
  }
}

function captureEdit() {
  return {
    text: state.text, ec: state.ec, matchVersion: state.matchVersion,
    detections: state.detections.map(({ id, data, version, loc, enabled, manual, numMode, numRegion, numDigits }) =>
      ({ id, data, version, loc, enabled, manual: !!manual, numMode: numMode || "off", numRegion: numRegion || null, numDigits: numDigits || null })),
  };
}
function updateHistoryControls() {
  $("btnUndo").disabled = !state.img || !editorHistory.canUndo;
  $("btnRedo").disabled = !state.img || !editorHistory.canRedo;
}
function commitHistory() {
  clearTimeout(historyTimer); historyTimer = null;
  if (state.img) editorHistory.commit(captureEdit());
  updateHistoryControls();
}
function restoreEdit(snapshot) {
  if (!snapshot) return;
  state.text = snapshot.text; state.ec = snapshot.ec; state.matchVersion = snapshot.matchVersion;
  state.detections = snapshot.detections;
  for (const det of state.detections) { det.foot = measureFootprint(det); det._numAn = null; }
  if (!state.detections.some(d => d.id === state.selectedId)) state.selectedId = state.detections[0]?.id ?? null;
  inpText.value = state.text; chkMatch.checked = state.matchVersion;
  segEc.querySelectorAll("button").forEach(b => { b.classList.toggle("on", b.dataset.ec === state.ec); b.setAttribute("aria-pressed", String(b.dataset.ec === state.ec)); });
  invalidateValidation(); renderView(); renderDetList(); updateHistoryControls();
}
function editChanged({ deferHistory = false } = {}) {
  invalidateValidation();
  renderView(); renderDetList();
  if (deferHistory) {
    clearTimeout(historyTimer); historyTimer = setTimeout(commitHistory, 450);
    $("btnUndo").disabled = false;
    $("btnRedo").disabled = true;
  } else commitHistory();
}
function undoEdit(redo = false) {
  cancelInteraction(); commitHistory();
  restoreEdit(redo ? editorHistory.redo() : editorHistory.undo());
}

function renderDetList() {
  detsBox.querySelectorAll(".det").forEach(el => el.remove());
  detsEmpty.textContent = state.img ? "未检测到二维码，可用「手动框选」添加" : "尚未载入图片";
  detsEmpty.classList.toggle("hidden", state.detections.length > 0);
  for (const det of state.detections) {
    const el = document.createElement("div");
    el.className = "det" + (det.enabled ? "" : " off") + (det.id === state.selectedId ? " selected" : "");
    el.dataset.id = det.id;
    const desc = det.data || "手动区域 · 未识别原码";
    const original = det.version ? `原码 v${det.version}` : "原码版本未知";
    const generated = det.enabled && det.generatedVersion && !renderError ? ` → 新码 v${det.generatedVersion}` : "";
    el.innerHTML = `<div class="det-main"><div class="det-badge">${det.id}</div><div class="det-body"><div class="det-data" title="${escapeHtml(desc)}">${escapeHtml(desc)}</div><div class="det-meta">${original}${generated}${det.manual ? " · 手动" : ""}</div></div></div>
      <div class="det-actions"><button class="btn mini ghost" data-act="select">调整四角</button><button class="btn mini ghost" data-act="toggle" aria-pressed="${det.enabled}">${det.enabled ? "停用替换" : "启用替换"}</button><button class="btn mini ghost" data-act="delete">移除</button></div>`;
    el.addEventListener("click", e => {
      const action = e.target.closest("button[data-act]")?.dataset.act;
      cancelInteraction(); commitHistory();
      if (action === "toggle") { det.enabled = !det.enabled; editChanged(); }
      else if (action === "delete") { state.detections = state.detections.filter(d => d.id !== det.id); if (state.selectedId === det.id) state.selectedId = null; editChanged(); }
      else selectDetection(det.id);
    });
    if (NUM_RE.test(det.data.trim())) {
      const row = document.createElement("div"); row.className = "det-num";
      row.innerHTML = `<span class="det-num-label">取票号</span><div class="seg seg-tiny">${[["off", "关"], ["cover", "遮盖"], ["replace", "换号"]].map(([m, label]) => `<button data-m="${m}" class="${det.numMode === m ? "on" : ""}" aria-pressed="${det.numMode === m}">${label}</button>`).join("")}</div><button class="btn mini ghost" data-act="rebox">框选</button>${det.numMode === "replace" ? '<button class="btn mini ghost" data-act="reshuffle">换一注</button>' : ""}`;
      row.addEventListener("click", e => {
        e.stopPropagation(); const btn = e.target.closest("button"); if (!btn) return;
        cancelInteraction(); commitHistory();
        if (btn.dataset.m) {
          const mode = btn.dataset.m;
          if (mode !== "off" && !det.numRegion) { state.reboxFor = { id: det.id, mode }; setTool("number"); }
          else { det.numMode = mode; editChanged(); }
        } else if (btn.dataset.act === "rebox") { state.reboxFor = { id: det.id, mode: det.numMode === "off" ? "replace" : det.numMode }; setTool("number"); }
        else { det.numDigits = null; editChanged(); }
      });
      el.appendChild(row);
    }
    detsBox.appendChild(el);
  }
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function selectDetection(id) {
  state.selectedId = id; setTool("select"); state.comparing = false;
  const det = state.detections.find(d => d.id === id);
  if (det) {
    const c = quadCenter(det.loc);
    camera.x = viewport.clientWidth / 2 - c.x * camera.scale;
    camera.y = viewport.clientHeight / 2 - c.y * camera.scale;
    applyViewTransform();
  }
  renderView(false); renderDetList(); updateToolControls();
}

function applyViewTransform() {
  if (!state.img) return;
  view.style.width = `${state.srcCanvas.width}px`; view.style.height = `${state.srcCanvas.height}px`;
  view.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
  $("zoomLabel").textContent = `${Math.round(camera.scale * 100)}%`;
}
function fitView() {
  if (!state.img) return;
  const w = state.srcCanvas.width, h = state.srcCanvas.height;
  camera.fit = Math.min((viewport.clientWidth - 24) / w, (viewport.clientHeight - 24) / h, 1);
  camera.fit = Math.max(0.001, camera.fit); camera.scale = camera.fit;
  camera.x = (viewport.clientWidth - w * camera.scale) / 2;
  camera.y = (viewport.clientHeight - h * camera.scale) / 2;
  applyViewTransform(); renderView(false);
}
function zoomAt(factor, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2) {
  if (!state.img) return;
  const scale = clampNum(camera.scale * factor, camera.fit * 0.5, Math.max(8, camera.fit));
  const ratio = scale / camera.scale;
  camera.x = x - (x - camera.x) * ratio; camera.y = y - (y - camera.y) * ratio; camera.scale = scale;
  applyViewTransform(); scheduleRenderView(false);
}
function updateToolControls() {
  for (const [id, active] of [["btnAddQr", state.tool === "drawQR"], ["btnPan", state.tool === "pan"], ["btnCompare", state.comparing]]) {
    $(id).classList.toggle("active", active); $(id).setAttribute("aria-pressed", String(active));
  }
  $("btnCompare").textContent = state.comparing ? "返回结果" : "原图对比";
  $("btnCancelEdit").classList.toggle("hidden", !["drawQR", "number"].includes(state.tool));
  $("editorHintText").textContent = state.comparing ? "正在查看原图，导出仍使用替换结果" : state.tool === "drawQR" ? "拖动框选二维码码区；先局部识别，识别失败时可调整四角。Esc 取消" : state.tool === "number" ? "拖动框选取票号区域 · Esc 取消" : state.tool === "pan" ? "拖动平移 · 滚轮或双指缩放" : "点选二维码后拖动四角 · 拖动空白处平移 · 滚轮 / 双指缩放";
  viewport.style.cursor = state.comparing || state.tool === "pan" ? "grab" : state.tool === "drawQR" || state.tool === "number" ? "crosshair" : "default";
}
function setTool(tool) {
  state.tool = tool; state.comparing = false;
  if (tool !== "number") state.reboxFor = null;
  updateToolControls(); renderView(false);
}
function viewPos(e) {
  const rect = viewport.getBoundingClientRect();
  return { x: (e.clientX - rect.left - camera.x) / camera.scale, y: (e.clientY - rect.top - camera.y) / camera.scale, scale: 1 / camera.scale };
}
function scheduleRenderView(rebuild = true) {
  if (rebuild) scheduleRenderView.dirty = true;
  if (viewRaf) return;
  viewRaf = requestAnimationFrame(() => { viewRaf = 0; const dirty = !!scheduleRenderView.dirty; scheduleRenderView.dirty = false; renderView(dirty); });
}
function validQuad(q) {
  const pts = [q.tl, q.tr, q.br, q.bl]; let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4], c = pts[(i + 2) % 4];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 8) return false;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 16 || (sign && Math.sign(cross) !== sign)) return false;
    sign = Math.sign(cross);
  }
  return sign > 0;
}
function cancelInteraction() {
  if (viewRaf) { cancelAnimationFrame(viewRaf); viewRaf = 0; scheduleRenderView.dirty = false; }
  const before = dragInfo?.before;
  dragInfo = null; pointers.clear();
  state.reboxFor = null; state.tool = "select";
  if (before) restoreEdit(before);
  updateToolControls(); renderView(false); updateExportControls();
}
function addManualQR(r) {
  if (!r || r.w < 12 || r.h < 12) { toast("框选范围太小，请重新框选"); return; }
  const W = state.srcCanvas.width, H = state.srcCanvas.height;
  // 保留原分辨率的局部扫描，解决整张大图降采样后的漏检。
  const pad = Math.max(8, Math.min(r.w, r.h) * 0.18);
  const x = Math.max(0, Math.floor(r.x - pad)), y = Math.max(0, Math.floor(r.y - pad));
  const w = Math.min(W - x, Math.ceil(r.w + pad * 2)), h = Math.min(H - y, Math.ceil(r.h + pad * 2));
  const scale = Math.min(1, 2400 / Math.max(w, h));
  const crop = document.createElement("canvas"); crop.width = Math.max(1, Math.round(w * scale)); crop.height = Math.max(1, Math.round(h * scale));
  const ctx = crop.getContext("2d", { willReadFrequently: true }); ctx.drawImage(state.srcCanvas, x, y, w, h, 0, 0, crop.width, crop.height);
  const pixels = ctx.getImageData(0, 0, crop.width, crop.height);
  const decoded = jsQR(pixels.data, crop.width, crop.height, { inversionAttempts: "attemptBoth" });
  let loc = { tl: { x: r.x, y: r.y }, tr: { x: r.x + r.w, y: r.y }, br: { x: r.x + r.w, y: r.y + r.h }, bl: { x: r.x, y: r.y + r.h } };
  let res = decoded;
  if (res) {
    const p = res.location; const map = a => ({ x: x + a.x * w / crop.width, y: y + a.y * h / crop.height });
    const detectedLoc = { tl: map(p.topLeftCorner), tr: map(p.topRightCorner), br: map(p.bottomRightCorner), bl: map(p.bottomLeftCorner) };
    const center = quadCenter(detectedLoc);
    if (center.x >= r.x && center.x <= r.x + r.w && center.y >= r.y && center.y <= r.y + r.h) loc = detectedLoc;
    else res = null;
  }
  const center = quadCenter(loc);
  const duplicate = state.detections.find(d => {
    const c = quadCenter(d.loc);
    return Math.hypot(c.x - center.x, c.y - center.y) < Math.min(r.w, r.h) * 0.3;
  });
  if (duplicate) { selectDetection(duplicate.id); toast("该二维码已存在，已选中，可拖动四角调整"); return; }
  const det = { id: Math.max(0, ...state.detections.map(d => d.id)) + 1, data: res?.data || "", version: res?.version || 0, loc, enabled: true, manual: true };
  det.foot = measureFootprint(det); suggestNumberRegion(det);
  state.detections.push(det); state.selectedId = det.id;
  toast(res ? "局部识别成功，可继续调整四角" : "已添加手动区域，请将四角贴合码区边缘（不含白边）");
}

viewport.addEventListener("pointerdown", e => {
  if (!state.img || (e.button !== 0 && e.button !== 1)) return;
  e.preventDefault();
  if (!pointers.size && !dragInfo) commitHistory();
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); viewport.setPointerCapture(e.pointerId);
  if (pointers.size === 2) {
    const before = dragInfo?.before; dragInfo = null; if (before) restoreEdit(before);
    const [a, b] = [...pointers.values()], rect = viewport.getBoundingClientRect();
    const mx = (a.x + b.x) / 2 - rect.left, my = (a.y + b.y) / 2 - rect.top;
    dragInfo = { kind: "pinch", distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), scale: camera.scale, ax: (mx - camera.x) / camera.scale, ay: (my - camera.y) / camera.scale };
    updateExportControls(); return;
  }
  if (pointers.size > 2) return;
  const { x, y, scale } = viewPos(e), W = view.width, H = view.height;
  const inside = x >= 0 && x <= W && y >= 0 && y <= H;
  if (state.comparing || state.tool === "pan" || e.button === 1 || !inside) {
    dragInfo = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: camera.x, oy: camera.y };
  } else if (state.tool === "drawQR") {
    dragInfo = { kind: "drawQR", x0: x, y0: y, rect: null };
  } else if (state.reboxFor) {
    const det = state.detections.find(d => d.id === state.reboxFor.id);
    if (det) { dragInfo = { kind: "rebox", det, x0: x, y0: y, before: JSON.parse(JSON.stringify(captureEdit())) }; det.numMode = state.reboxFor.mode; }
  } else {
    const before = () => JSON.parse(JSON.stringify(captureEdit()));
    const tol = 12 * scale;
    const selected = state.detections.find(d => d.id === state.selectedId);
    if (selected) for (const [corner, p] of Object.entries(selected.loc)) {
      if (Math.hypot(x - p.x, y - p.y) <= tol) { dragInfo = { kind: "qrCorner", det: selected, corner, before: before() }; break; }
    }
    if (!dragInfo) for (const det of [...state.detections].reverse()) {
      if (det.numMode === "off" || !det.numRegion) continue;
      const r = det.numRegion;
      for (const [corner, cx, cy] of [["tl", r.x, r.y], ["tr", r.x + r.w, r.y], ["br", r.x + r.w, r.y + r.h], ["bl", r.x, r.y + r.h]]) {
        if (Math.abs(x - cx) <= tol && Math.abs(y - cy) <= tol) { dragInfo = { kind: "resize", det, corner, orig: { ...r }, before: before() }; break; }
      }
      if (dragInfo) break;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { dragInfo = { kind: "move", det, dx: x - r.x, dy: y - r.y, before: before() }; break; }
    }
    if (!dragInfo) dragInfo = { kind: "click", x0: x, y0: y, sx: e.clientX, sy: e.clientY, ox: camera.x, oy: camera.y };
  }
  if (["drawQR", "rebox", "qrCorner", "resize", "move"].includes(dragInfo?.kind)) invalidateValidation();
  updateExportControls();
});
viewport.addEventListener("pointermove", e => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const d = dragInfo; if (!d) return;
  if (d.kind === "pinch") {
    const [a, b] = [...pointers.values()]; if (!b) return;
    const rect = viewport.getBoundingClientRect();
    camera.scale = clampNum(d.scale * Math.hypot(a.x - b.x, a.y - b.y) / d.distance, camera.fit * 0.5, Math.max(8, camera.fit));
    camera.x = (a.x + b.x) / 2 - rect.left - d.ax * camera.scale; camera.y = (a.y + b.y) / 2 - rect.top - d.ay * camera.scale;
    applyViewTransform(); scheduleRenderView(false); return;
  }
  if (d.kind === "click" && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 5) d.kind = "pan";
  if (d.kind === "pan") { camera.x = d.ox + e.clientX - d.sx; camera.y = d.oy + e.clientY - d.sy; applyViewTransform(); return; }
  if (d.kind === "click") return;
  const pos = viewPos(e), x = clampNum(pos.x, 0, view.width), y = clampNum(pos.y, 0, view.height);
  if (d.kind === "drawQR") {
    d.rect = { x: Math.min(d.x0, x), y: Math.min(d.y0, y), w: Math.abs(x - d.x0), h: Math.abs(y - d.y0) };
    scheduleRenderView(false); return;
  }
  if (d.kind === "qrCorner") {
    const q = { ...d.det.loc, [d.corner]: { x, y } };
    if (!validQuad(q)) return;
    d.det.loc = q; d.det.foot = measureFootprint(d.det);
  } else if (d.kind === "move") {
    const r = d.det.numRegion; r.x = clampNum(x - d.dx, 0, view.width - r.w); r.y = clampNum(y - d.dy, 0, view.height - r.h);
  } else if (d.kind === "resize") {
    const r = d.det.numRegion, o = d.orig;
    let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
    if (d.corner.includes("l")) x0 = Math.min(x, x1 - 8);
    if (d.corner.includes("r")) x1 = Math.max(x, x0 + 8);
    if (d.corner.includes("t")) y0 = Math.min(y, y1 - 8);
    if (d.corner.includes("b")) y1 = Math.max(y, y0 + 8);
    r.x = clampNum(x0, 0, view.width); r.y = clampNum(y0, 0, view.height);
    r.w = clampNum(x1, 0, view.width) - r.x; r.h = clampNum(y1, 0, view.height) - r.y;
  } else if (d.kind === "rebox") {
    d.det.numRegion = { x: Math.min(d.x0, x), y: Math.min(d.y0, y), w: Math.abs(x - d.x0), h: Math.abs(y - d.y0) };
  }
  d.det._numAn = null; invalidateValidation(); scheduleRenderView();
});
viewport.addEventListener("pointerup", e => {
  pointers.delete(e.pointerId);
  if (viewport.hasPointerCapture(e.pointerId)) viewport.releasePointerCapture(e.pointerId);
  const d = dragInfo; if (!d) return;
  dragInfo = null;
  if (d.kind === "pinch" || d.kind === "pan") { updateExportControls(); return; }
  if (d.kind === "click") {
    const det = [...state.detections].reverse().find(t => pointInQuad(d.x0, d.y0, t.loc));
    if (det) { state.selectedId = det.id; renderDetList(); renderView(false); }
    updateExportControls(); return;
  }
  if (d.kind === "drawQR") { addManualQR(d.rect); setTool("select"); editChanged(); return; }
  if (d.kind === "rebox") {
    const r = d.det.numRegion;
    if (!r || r.w < 8 || r.h < 8) { restoreEdit(d.before); toast("框选范围太小，已恢复"); }
    setTool("select");
  }
  editChanged();
});
viewport.addEventListener("pointercancel", () => cancelInteraction());
viewport.addEventListener("wheel", e => {
  if (!state.img) return; e.preventDefault(); if (dragInfo) return;
  const rect = viewport.getBoundingClientRect();
  zoomAt(Math.exp(-clampNum(e.deltaY, -100, 100) * 0.005), e.clientX - rect.left, e.clientY - rect.top);
}, { passive: false });
new ResizeObserver(() => { if (state.img && !dragInfo) fitView(); }).observe(viewport);

function invalidateValidation() {
  revision++;
  if (validationRun) { validationRun.controller.abort(); validationRun = null; }
  pendingExport = null;
  if ($("exportDialog").open) $("exportDialog").close();
  $("validationResults").replaceChildren();
  $("validationSummary").textContent = "结果尚未验证；导出或复制前会自动回扫";
  updateExportControls();
}
function showValidation(results, detections) {
  const list = $("validationResults"); list.replaceChildren();
  for (const r of results) {
    const row = document.createElement("div"); row.className = `validation-row ${r.status}`;
    row.textContent = `#${r.id} ${r.status === "passed" ? "通过" : r.status === "failed" ? "未通过" : "未验证"} · ${r.message}`;
    list.appendChild(row);
  }
  const activeIds = new Set(detections.filter(d => d.enabled).map(d => d.id));
  const checked = results.filter(r => activeIds.has(r.id)), failed = checked.filter(r => r.status !== "passed");
  $("validationSummary").textContent = !checked.length ? "没有启用的二维码替换，未执行回扫" : failed.length ? `${failed.length} / ${checked.length} 个替换区域未通过，请检查四角和内容` : `${checked.length} 个替换区域全部通过当前解码器验证`;
}
function canvasBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("图片编码失败，请尝试缩小原图")), "image/png"));
}
async function blobCanvas(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image(); await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error("无法读取导出的 PNG")); img.src = url; });
    const canvas = document.createElement("canvas"); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0); return canvas;
  } finally { URL.revokeObjectURL(url); }
}
async function verifyResult(action = "verify") {
  if (!state.img || validationRun || dragInfo) return;
  commitHistory(); if (!renderResult()) { renderView(false); toast(renderError); return; }
  const token = revision, controller = new AbortController(), run = { controller };
  const detections = JSON.parse(JSON.stringify(state.detections.map(({ id, enabled, loc, version, generatedVersion }) => ({ id, enabled, loc, version, generatedVersion }))));
  const text = state.text;
  const frozen = document.createElement("canvas"); frozen.width = resultCanvas.width; frozen.height = resultCanvas.height;
  frozen.getContext("2d").drawImage(resultCanvas, 0, 0);
  validationRun = run; updateExportControls(); $("validationSummary").textContent = "正在验证最终 PNG…";
  let decodedCanvas;
  try {
    const blob = await canvasBlob(frozen);
    if (token !== revision) return;
    decodedCanvas = await blobCanvas(blob);
    if (token !== revision) return;
    const results = await QRValidation.verifyCanvas(decodedCanvas, detections, text, {
      signal: controller.signal,
      onProgress: ({ completed, total }) => { if (token === revision) $("validationSummary").textContent = `正在回扫 ${completed} / ${total}…`; },
    });
    if (token !== revision) return;
    showValidation(results, detections);
    if (action === "verify") return;
    const prepared = { blob, action, revision: token, name: exportName() };
    if (results.some(r => r.status !== "passed" && detections.some(d => d.id === r.id && d.enabled))) {
      pendingExport = prepared;
      $("exportDialogMessage").textContent = "部分替换区域未能扫描出预期内容。可以返回调整四角、缩短文本后重试，也可以导出当前结果。";
      $("btnExportAnyway").textContent = action === "copy" ? "仍然复制" : "仍然下载";
      $("exportDialog").showModal();
    } else await performExport(prepared);
  } catch (e) {
    if (e.name !== "AbortError" && token === revision) { $("validationSummary").textContent = `验证失败：${e.message || e}`; toast("验证未完成，请重试"); }
  } finally {
    frozen.width = frozen.height = 1;
    if (decodedCanvas) decodedCanvas.width = decodedCanvas.height = 1;
    if (validationRun === run) validationRun = null;
    updateExportControls();
  }
}
async function performExport(prepared) {
  if (!prepared || prepared.revision !== revision) { toast("图片已修改，请重新验证"); return; }
  if (prepared.action === "copy") {
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("当前浏览器不支持复制图片，请使用下载 PNG");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": prepared.blob })]); toast("已复制结果");
    } catch (e) {
      if (prepared.revision !== revision) return;
      pendingExport = prepared;
      $("exportDialogMessage").textContent = `复制未完成：${e.message || e}。可再次点击复制，或取消后下载 PNG。`;
      $("btnExportAnyway").textContent = "再次复制";
      if (!$("exportDialog").open) $("exportDialog").showModal();
    }
  } else {
    const a = document.createElement("a"), url = URL.createObjectURL(prepared.blob);
    a.href = url; a.download = prepared.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000); toast("已导出 PNG");
  }
}
let saveSeq = 0;
function exportName() {
  saveSeq++; const now = new Date(), p = n => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  let base = (state.srcName || "").replace(/\.[a-z0-9]+$/i, "").replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 60);
  base = base && !/^image$/i.test(base) ? base + "-qr" : "qr-replaced";
  return `${base}-${ts}-${p(saveSeq)}.png`;
}

function loadImage(img) {
  cancelInteraction(); clearTimeout(historyTimer); qrCache.clear();
  state.img = img; state.reboxFor = null; state.comparing = false;
  const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext("2d").drawImage(img, 0, 0); state.srcCanvas = c;
  dropzone.classList.add("hidden"); view.classList.remove("hidden"); viewport.classList.remove("hidden");
  for (const id of ["editorToolbar", "editorHint", "btnReimport"]) $(id).classList.remove("hidden");
  btnRescan.disabled = false;
  runDetection(); state.selectedId = state.detections[0]?.id ?? null;
  invalidateValidation(); renderView(); fitView(); renderDetList();
  editorHistory.reset(captureEdit()); updateHistoryControls(); updateToolControls();
  toast(state.detections.length ? `检测到 ${state.detections.length} 个二维码` : "未检测到二维码，可用手动框选局部识别");
}
function loadFile(file) {
  if (!file || !file.type.startsWith("image/")) { toast("请选择图片文件"); return; }
  const sequence = ++importSequence, url = URL.createObjectURL(file), img = new Image();
  img.onload = () => { try { if (sequence === importSequence) { state.srcName = file.name || null; loadImage(img); } } finally { URL.revokeObjectURL(url); } };
  img.onerror = () => { if (sequence === importSequence) toast("图片载入失败"); URL.revokeObjectURL(url); };
  img.src = url;
}

dropzone.addEventListener("click", () => fileInput.click());
$("btnBrowse").addEventListener("click", e => { e.stopPropagation(); fileInput.click(); });
btnImport.addEventListener("click", () => fileInput.click()); btnReimport.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => { loadFile(fileInput.files[0]); fileInput.value = ""; });
if (window.matchMedia && matchMedia("(pointer: coarse)").matches) {
  dropzone.querySelector(".drop-title").textContent = "点这里选择图片";
  dropzone.querySelector(".drop-sub").textContent = "从相册或文件中导入";
}
document.addEventListener("paste", e => { for (const item of e.clipboardData.items) if (item.type.startsWith("image/")) { loadFile(item.getAsFile()); e.preventDefault(); return; } });
let dragDepth = 0;
document.addEventListener("dragenter", e => { if ([...e.dataTransfer.types].includes("Files")) { dragDepth++; draghint.classList.remove("hidden"); } });
document.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) draghint.classList.add("hidden"); });
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", e => { e.preventDefault(); dragDepth = 0; draghint.classList.add("hidden"); loadFile(e.dataTransfer.files[0]); });

inpText.addEventListener("input", () => { state.text = inpText.value; editChanged({ deferHistory: true }); });
inpText.addEventListener("blur", commitHistory);
for (const p of PRESETS) {
  const chip = document.createElement("button"); chip.className = "chip"; chip.textContent = p; chip.title = p;
  chip.addEventListener("click", () => { cancelInteraction(); commitHistory(); state.text = p; inpText.value = p; editChanged(); }); presetsBox.appendChild(chip);
}
segEc.addEventListener("click", e => {
  const btn = e.target.closest("button[data-ec]"); if (!btn) return;
  cancelInteraction(); commitHistory(); state.ec = btn.dataset.ec;
  segEc.querySelectorAll("button").forEach(b => { b.classList.toggle("on", b === btn); b.setAttribute("aria-pressed", String(b === btn)); }); editChanged();
});
chkMatch.addEventListener("change", () => { cancelInteraction(); commitHistory(); state.matchVersion = chkMatch.checked; editChanged(); });
btnRescan.addEventListener("click", () => {
  if (!state.img) return;
  cancelInteraction(); commitHistory();
  const old = state.detections; runDetection();
  const used = new Set(); let nextId = Math.max(0, ...old.map(d => d.id)) + 1;
  state.detections = state.detections.map(fresh => {
    const center = quadCenter(fresh.loc);
    const match = old.find(d => !used.has(d.id) && d.data === fresh.data && pointInQuad(center.x, center.y, expandQuad(d.loc, 1.3)));
    if (match) { used.add(match.id); return match; }
    fresh.id = nextId++; return fresh;
  });
  for (const d of old) if (!used.has(d.id)) state.detections.push(d);
  editChanged(); toast(`重扫完成，共 ${state.detections.length} 个区域，已保留现有编辑`);
});
$("btnUndo").addEventListener("click", () => undoEdit()); $("btnRedo").addEventListener("click", () => undoEdit(true));
$("btnAddQr").addEventListener("click", () => { const active = state.tool === "drawQR"; cancelInteraction(); commitHistory(); setTool(active ? "select" : "drawQR"); });
$("btnPan").addEventListener("click", () => { const active = state.tool === "pan"; cancelInteraction(); setTool(active ? "select" : "pan"); });
$("btnCompare").addEventListener("click", () => { const next = !state.comparing; cancelInteraction(); state.comparing = next; updateToolControls(); renderView(false); });
$("btnZoomIn").addEventListener("click", () => zoomAt(1.25)); $("btnZoomOut").addEventListener("click", () => zoomAt(0.8)); $("btnFit").addEventListener("click", fitView);
$("btnCancelEdit").addEventListener("click", cancelInteraction);
$("btnVerify").addEventListener("click", () => verifyResult());
btnDownload.addEventListener("click", () => verifyResult("download")); btnCopy.addEventListener("click", () => verifyResult("copy"));
$("btnExportCancel").addEventListener("click", () => { pendingExport = null; $("exportDialog").close(); });
$("exportDialog").addEventListener("cancel", () => { pendingExport = null; });
$("btnExportAnyway").addEventListener("click", () => { const prepared = pendingExport; pendingExport = null; $("exportDialog").close(); performExport(prepared); });
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !$("exportDialog").open) { cancelInteraction(); return; }
  const editable = e.target instanceof HTMLElement && (e.target.matches("input,textarea") || e.target.isContentEditable);
  if (editable || !state.img || $("exportDialog").open) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undoEdit(e.shiftKey); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); undoEdit(true); }
  else if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomAt(1.25); }
  else if (e.key === "-") { e.preventDefault(); zoomAt(0.8); }
  else if (e.key === "0") { e.preventDefault(); fitView(); }
});
updateHistoryControls();
