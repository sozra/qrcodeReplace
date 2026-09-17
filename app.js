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

  // 取票号区域（遮盖 / 换号）
  for (const det of state.detections) {
    if (det.numMode === "off" || !det.numRegion) continue;
    drawNumberRegion(ctx, det);
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

  // 取票号区域标注（不进导出结果）
  for (const det of state.detections) {
    if (det.numMode === "off" || !det.numRegion) continue;
    const r = det.numRegion;
    ctx.strokeStyle = "#4cc2ff";
    ctx.lineWidth = lw;
    ctx.setLineDash([lw * 2.5, lw * 2.5]);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.setLineDash([]);
    const hs = lw * 3.2;
    ctx.fillStyle = "#4cc2ff";
    for (const [cx, cy] of [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]) {
      ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
    }
    ctx.font = `600 ${badgeR * 0.8}px -apple-system, "PingFang SC", sans-serif`;
    ctx.textAlign = "left";
    ctx.fillStyle = "#4cc2ff";
    ctx.fillText("取票号", r.x + lw * 2, r.y + badgeR * 0.9);
    ctx.textAlign = "center";
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
      <div class="det-main">
        <div class="det-badge">${det.id}</div>
        <div class="det-body">
          <div class="det-data" title="${escapeHtml(det.data)}">${escapeHtml(det.data)}</div>
          <div class="det-meta">v${det.version || "?"} · ${n}×${n} · 点击卡片或图上标记可切换</div>
        </div>
        ${det.enabled ? EYE_ON : EYE_OFF}
      </div>`;
    el.addEventListener("click", () => toggleDet(det.id));

    // 内容像取票号：提供号码处理（遮盖 / 随机换号）
    if (NUM_RE.test(det.data.trim())) {
      const row = document.createElement("div");
      row.className = "det-num";
      row.innerHTML = `
        <span class="det-num-label">取票号</span>
        <div class="seg seg-tiny">
          <button data-m="off" class="${det.numMode === "off" ? "on" : ""}">关</button>
          <button data-m="cover" class="${det.numMode === "cover" ? "on" : ""}">遮盖</button>
          <button data-m="replace" class="${det.numMode === "replace" ? "on" : ""}">换号</button>
        </div>
        <button class="btn mini ghost" data-act="rebox" title="在图上拖拽，重新框选号码区域">框选</button>
        ${det.numMode === "replace"
          ? '<button class="btn mini ghost" data-act="reshuffle" title="重新生成一个随机号码">换一注</button>'
          : ""}`;
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        const mBtn = e.target.closest("button[data-m]");
        const actBtn = e.target.closest("button[data-act]");
        if (mBtn) {
          det.numMode = mBtn.dataset.m;
          if (det.numMode !== "off" && !det.numRegion) {
            state.reboxFor = det;
            toast("在图上拖拽，框选取票号区域");
          }
          renderView();
          renderDetList();
        } else if (actBtn) {
          if (actBtn.dataset.act === "rebox") {
            state.reboxFor = det;
            toast("在图上拖拽，框选取票号区域");
          } else {
            det.numDigits = null;
            renderView();
          }
        }
      });
      el.appendChild(row);
    }
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
  state.reboxFor = null;
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext("2d").drawImage(img, 0, 0);
  state.srcCanvas = c;

  dropzone.classList.add("hidden");
  view.classList.remove("hidden");
  btnReimport.classList.remove("hidden");
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
  state.srcName = file.name || null;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => { loadImage(img); URL.revokeObjectURL(url); };
  img.onerror = () => { toast("图片载入失败"); URL.revokeObjectURL(url); };
  img.src = url;
}

// ---------------------------------------------------------------- events

dropzone.addEventListener("click", () => fileInput.click());
$("btnBrowse").addEventListener("click", (e) => { e.stopPropagation(); fileInput.click(); });
btnImport.addEventListener("click", () => fileInput.click());
btnReimport.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => { loadFile(fileInput.files[0]); fileInput.value = ""; });

// 触屏设备没有拖拽和 ⌘V，换成贴合实际操作的提示
if (window.matchMedia && matchMedia("(pointer: coarse)").matches) {
  dropzone.querySelector(".drop-title").textContent = "点这里选择图片";
  dropzone.querySelector(".drop-sub").textContent = "从相册或文件中导入，之后可点右下角按钮换图";
}

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

// 视图坐标（CSS 像素 → 图像像素）
function viewPos(e) {
  const rect = view.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * view.width,
    y: ((e.clientY - rect.top) / rect.height) * view.height,
    scale: view.width / rect.width,
  };
}

const clampNum = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
let dragInfo = null;

// 拖拽期间合并重绘：每个 animation frame 至多渲染一次
let viewRaf = 0;
function scheduleRenderView() {
  if (viewRaf) return;
  viewRaf = requestAnimationFrame(() => { viewRaf = 0; renderView(); });
}

view.addEventListener("pointerdown", (e) => {
  if (!state.img) return;
  const { x, y, scale } = viewPos(e);

  // 框选模式：直接开始拖一个新区域
  if (state.reboxFor) {
    dragInfo = {
      kind: "rebox", det: state.reboxFor, x0: x, y0: y,
      prev: state.reboxFor.numRegion, prevMode: state.reboxFor.numMode,
    };
    if (state.reboxFor.numMode === "off") state.reboxFor.numMode = "replace";
    view.setPointerCapture(e.pointerId);
    return;
  }

  // 号码区域：四角缩放优先，其次内部拖动
  const tol = 10 * scale;
  for (let i = state.detections.length - 1; i >= 0; i--) {
    const det = state.detections[i];
    if (det.numMode === "off" || !det.numRegion) continue;
    const r = det.numRegion;
    const corners = [
      { c: "tl", px: r.x, py: r.y }, { c: "tr", px: r.x + r.w, py: r.y },
      { c: "br", px: r.x + r.w, py: r.y + r.h }, { c: "bl", px: r.x, py: r.y + r.h },
    ];
    for (const cn of corners) {
      if (Math.abs(x - cn.px) <= tol && Math.abs(y - cn.py) <= tol) {
        dragInfo = { kind: "resize", det, corner: cn.c, orig: { ...r } };
        view.setPointerCapture(e.pointerId);
        return;
      }
    }
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
      dragInfo = { kind: "move", det, dx: x - r.x, dy: y - r.y };
      view.setPointerCapture(e.pointerId);
      return;
    }
  }

  dragInfo = { kind: "click", x0: x, y0: y, scale };
});

view.addEventListener("pointermove", (e) => {
  if (!dragInfo || dragInfo.kind === "click") return;
  const { x, y } = viewPos(e);
  const d = dragInfo;
  const W = view.width, H = view.height;
  if (d.kind === "move") {
    const r = d.det.numRegion;
    r.x = clampNum(x - d.dx, 0, W - r.w);
    r.y = clampNum(y - d.dy, 0, H - r.h);
    d.det._numAn = null;
  } else if (d.kind === "resize") {
    const r = d.det.numRegion, o = d.orig;
    let nx0 = o.x, ny0 = o.y, nx1 = o.x + o.w, ny1 = o.y + o.h;
    if (d.corner.includes("l")) nx0 = Math.min(x, nx1 - 8);
    if (d.corner.includes("r")) nx1 = Math.max(x, nx0 + 8);
    if (d.corner.includes("t")) ny0 = Math.min(y, ny1 - 8);
    if (d.corner.includes("b")) ny1 = Math.max(y, ny0 + 8);
    r.x = clampNum(nx0, 0, W); r.y = clampNum(ny0, 0, H);
    r.w = clampNum(nx1, 0, W) - r.x; r.h = clampNum(ny1, 0, H) - r.y;
    d.det._numAn = null;
  } else if (d.kind === "rebox") {
    const cx = clampNum(x, 0, W), cy = clampNum(y, 0, H);
    d.det.numRegion = {
      x: Math.min(d.x0, cx), y: Math.min(d.y0, cy),
      w: Math.abs(cx - d.x0), h: Math.abs(cy - d.y0),
    };
    d.det._numAn = null;
  }
  scheduleRenderView();
});

view.addEventListener("pointerup", (e) => {
  if (!dragInfo) return;
  const d = dragInfo;
  dragInfo = null;
  if (d.kind === "click") {
    const { x, y, scale } = viewPos(e);
    if (Math.hypot(x - d.x0, y - d.y0) >= 6 * scale) return;
    for (let i = state.detections.length - 1; i >= 0; i--) {
      const det = state.detections[i];
      if (pointInQuad(x, y, det.foot.quad)) { toggleDet(det.id); return; }
    }
    return;
  }
  if (d.kind === "rebox") {
    const r = d.det.numRegion;
    if (!r || r.w < 8 || r.h < 8) {
      // 框选无效：还原区域和模式
      d.det.numRegion = d.prev || null;
      d.det.numMode = d.prevMode;
    }
    state.reboxFor = null;
  }
  renderView();
  renderDetList();
});

view.addEventListener("pointercancel", () => {
  if (dragInfo && dragInfo.kind === "rebox") {
    // 触摸被系统手势打断：还原半截框选
    dragInfo.det.numRegion = dragInfo.prev || null;
    dragInfo.det.numMode = dragInfo.prevMode;
    state.reboxFor = null;
  }
  dragInfo = null;
  renderView();
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

// 导出文件名：沿用原图名 + 时间戳 + 序号，保证多次保存互不覆盖
let saveSeq = 0;
function exportName() {
  saveSeq++;
  const now = new Date();
  const p = (n, l) => String(n).padStart(l || 2, "0");
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
             `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  let base = (state.srcName || "").replace(/\.[a-z0-9]+$/i, "")
    .replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 60);
  const hasBase = !!base && !/^image$/i.test(base);
  if (!hasBase) base = "qr-replaced";
  return `${hasBase ? base + "-qr" : base}-${ts}-${p(saveSeq)}.png`;
}

btnDownload.addEventListener("click", () => {
  renderResult();
  resultCanvas.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = exportName();
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
