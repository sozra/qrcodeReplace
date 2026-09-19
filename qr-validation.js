/* Final-image QR verification. Uses only pixels from the supplied export canvas.
 * Load after vendor/jsQR.js. No network requests or application-state access.
 */
(function (root) {
  "use strict";

  const MAX_CROP_DIM = 2048;
  const MAX_CROP_PIXELS = 3000000;
  const MAX_CANDIDATES = 4;
  const CORNERS = ["tl", "tr", "br", "bl"];

  function abortIfNeeded(signal) {
    if (!signal || !signal.aborted) return;
    const error = new Error("验证已取消");
    error.name = "AbortError";
    throw error;
  }

  async function yieldToUI(signal) {
    abortIfNeeded(signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    abortIfNeeded(signal);
  }

  function cross(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  function signedArea(points) {
    return points.reduce((sum, p, i) => {
      const next = points[(i + 1) % points.length];
      return sum + p.x * next.y - next.x * p.y;
    }, 0) / 2;
  }

  function validQuad(loc) {
    if (!loc) return false;
    const points = CORNERS.map((key) => loc[key]);
    if (points.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
    const turns = points.map((p, i) => cross(p, points[(i + 1) % 4], points[(i + 2) % 4]));
    return Math.abs(signedArea(points)) >= 9 &&
      (turns.every((v) => v > 0.01) || turns.every((v) => v < -0.01));
  }

  // Convex polygon intersection keeps a neighbouring QR with the same content
  // from accidentally passing verification for this target.
  function intersectionArea(subject, clip) {
    let output = subject;
    const orientation = signedArea(clip) < 0 ? -1 : 1;
    for (let edge = 0; edge < clip.length && output.length; edge++) {
      const a = clip[edge], b = clip[(edge + 1) % clip.length];
      const input = output;
      output = [];
      let previous = input[input.length - 1];
      let previousDistance = cross(a, b, previous) * orientation;
      for (const current of input) {
        const distance = cross(a, b, current) * orientation;
        if ((distance >= 0) !== (previousDistance >= 0)) {
          const t = previousDistance / (previousDistance - distance);
          output.push({
            x: previous.x + (current.x - previous.x) * t,
            y: previous.y + (current.y - previous.y) * t,
          });
        }
        if (distance >= 0) output.push(current);
        previous = current;
        previousDistance = distance;
      }
    }
    return output.length >= 3 ? Math.abs(signedArea(output)) : 0;
  }

  function correspondsToTarget(decoded, target) {
    if (!validQuad(decoded)) return false;
    const a = CORNERS.map((key) => decoded[key]);
    const b = CORNERS.map((key) => target[key]);
    const decodedArea = Math.abs(signedArea(a));
    const targetArea = Math.abs(signedArea(b));
    const intersection = intersectionArea(a, b);
    return decodedArea / targetArea >= 0.45 && decodedArea / targetArea <= 1.8 &&
      intersection / (decodedArea + targetArea - intersection) >= 0.5;
  }

  function qrLocation(result, map) {
    const loc = result.location;
    if (!loc) return null;
    return {
      tl: map(loc.topLeftCorner), tr: map(loc.topRightCorner),
      br: map(loc.bottomRightCorner), bl: map(loc.bottomLeftCorner),
    };
  }

  function meanSide(loc) {
    const points = CORNERS.map((key) => loc[key]);
    return points.reduce((sum, p, i) => {
      const next = points[(i + 1) % 4];
      return sum + Math.hypot(p.x - next.x, p.y - next.y);
    }, 0) / 4;
  }

  function moduleCount(det) {
    const version = Number(det.generatedVersion || det.version);
    return 17 + 4 * (Number.isInteger(version) && version >= 1 && version <= 40 ? version : 4);
  }

  function readCrop(canvas, det) {
    const points = CORNERS.map((key) => det.loc[key]);
    const padding = Math.max(5, meanSide(det.loc) / moduleCount(det) * 6);
    const x = Math.max(0, Math.floor(Math.min(...points.map((p) => p.x)) - padding));
    const y = Math.max(0, Math.floor(Math.min(...points.map((p) => p.y)) - padding));
    const right = Math.min(canvas.width, Math.ceil(Math.max(...points.map((p) => p.x)) + padding));
    const bottom = Math.min(canvas.height, Math.ceil(Math.max(...points.map((p) => p.y)) + padding));
    const width = right - x, height = bottom - y;
    if (width < 3 || height < 3) throw new Error("二维码区域超出图片范围");
    const scale = Math.min(1, MAX_CROP_DIM / width, MAX_CROP_DIM / height,
      Math.sqrt(MAX_CROP_PIXELS / (width * height)));
    let pixels;
    if (scale === 1) {
      pixels = canvas.getContext("2d", { willReadFrequently: true }).getImageData(x, y, width, height);
    } else {
      const work = document.createElement("canvas");
      work.width = Math.max(1, Math.floor(width * scale));
      work.height = Math.max(1, Math.floor(height * scale));
      const ctx = work.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(canvas, x, y, width, height, 0, 0, work.width, work.height);
      pixels = ctx.getImageData(0, 0, work.width, work.height);
      work.width = work.height = 0;
    }
    return {
      pixels,
      map: (p) => ({ x: x + p.x * width / pixels.width, y: y + p.y * height / pixels.height }),
      unmap: (p) => ({ x: (p.x - x) * pixels.width / width, y: (p.y - y) * pixels.height / height }),
      reduced: scale < 1,
    };
  }

  function maskCandidate(pixels, location) {
    const points = [location.topLeftCorner, location.topRightCorner,
      location.bottomRightCorner, location.bottomLeftCorner];
    const minX = Math.max(0, Math.floor(Math.min(...points.map((p) => p.x))) - 1);
    const maxX = Math.min(pixels.width, Math.ceil(Math.max(...points.map((p) => p.x))) + 1);
    const minY = Math.max(0, Math.floor(Math.min(...points.map((p) => p.y))) - 1);
    const maxY = Math.min(pixels.height, Math.ceil(Math.max(...points.map((p) => p.y))) + 1);
    // This is only a decoder working copy; neither exported pixels nor the
    // rectification source is ever masked.
    for (let y = minY; y < maxY; y++) {
      for (let x = minX; x < maxX; x++) {
        const offset = (y * pixels.width + x) * 4;
        pixels.data[offset] = pixels.data[offset + 1] = pixels.data[offset + 2] = 255;
        pixels.data[offset + 3] = 255;
      }
    }
  }

  async function decodeTarget(pixels, map, target, signal) {
    const working = { data: new Uint8ClampedArray(pixels.data), width: pixels.width, height: pixels.height };
    for (let i = 0; i < MAX_CANDIDATES; i++) {
      abortIfNeeded(signal);
      const result = root.jsQR(working.data, working.width, working.height, { inversionAttempts: "attemptBoth" });
      if (!result) return null;
      const decodedLoc = qrLocation(result, map);
      if (correspondsToTarget(decodedLoc, target)) return result;
      if (!result.location) return null;
      maskCandidate(working, result.location);
      await yieldToUI(signal);
    }
    return null;
  }

  // Closed-form homography: coordinates (0,0)..(1,1) are the QR code area.
  function quadMap(q) {
    const { tl: a, tr: b, br: c, bl: d } = q;
    const dx1 = b.x - c.x, dx2 = d.x - c.x, dx3 = a.x - b.x + c.x - d.x;
    const dy1 = b.y - c.y, dy2 = d.y - c.y, dy3 = a.y - b.y + c.y - d.y;
    const determinant = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(determinant) < 1e-8) return null;
    const g = (dx3 * dy2 - dx2 * dy3) / determinant;
    const h = (dx1 * dy3 - dx3 * dy1) / determinant;
    return (x, y) => {
      const divisor = g * x + h * y + 1;
      return {
        x: ((b.x - a.x + g * b.x) * x + (d.x - a.x + h * d.x) * y + a.x) / divisor,
        y: ((b.y - a.y + g * b.y) * x + (d.y - a.y + h * d.y) * y + a.y) / divisor,
      };
    };
  }

  function rectify(crop, det) {
    const project = quadMap(det.loc);
    if (!project) return null;
    const modules = moduleCount(det);
    const margin = 4 / modules;
    const size = Math.min(900, Math.max(256, (modules + 8) * 4));
    const data = new Uint8ClampedArray(size * size * 4);
    const map = (p) => project(p.x / size * (1 + margin * 2) - margin,
      p.y / size * (1 + margin * 2) - margin);
    const source = crop.pixels;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const p = crop.unmap(map({ x: x + 0.5, y: y + 0.5 }));
        // Clamp at the actual crop boundary instead of inventing a white quiet
        // zone where the exported image has no pixels.
        const sx = Math.min(source.width - 1, Math.max(0, Math.floor(p.x)));
        const sy = Math.min(source.height - 1, Math.max(0, Math.floor(p.y)));
        const src = (sy * source.width + sx) * 4, dest = (y * size + x) * 4;
        data[dest] = source.data[src];
        data[dest + 1] = source.data[src + 1];
        data[dest + 2] = source.data[src + 2];
        data[dest + 3] = source.data[src + 3];
      }
    }
    return { pixels: { data, width: size, height: size }, map };
  }

  async function verifyTarget(canvas, det, expectedText, signal) {
    const base = { id: det.id };
    if (!det.enabled) return { ...base, status: "skipped", message: "未启用替换，无需验证" };
    if (typeof expectedText !== "string" || expectedText.length === 0) {
      return { ...base, status: "failed", message: "替换内容为空，无法验证二维码" };
    }
    if (!validQuad(det.loc)) return { ...base, status: "failed", message: "二维码四角无效，请重新调整" };
    if (CORNERS.some((key) => det.loc[key].x < 0 || det.loc[key].y < 0 ||
      det.loc[key].x > canvas.width || det.loc[key].y > canvas.height)) {
      return { ...base, status: "failed", message: "二维码区域超出图片范围，请调整四角" };
    }
    if (typeof root.jsQR !== "function") return { ...base, status: "skipped", message: "识别组件未加载，无法验证" };
    const crop = readCrop(canvas, det);
    let decoded = await decodeTarget(crop.pixels, crop.map, det.loc, signal);
    let rectified = false;
    if (!decoded) {
      await yieldToUI(signal);
      const straight = rectify(crop, det);
      if (straight) decoded = await decodeTarget(straight.pixels, straight.map, det.loc, signal);
      rectified = !!decoded;
    }
    if (!decoded) return { ...base, status: "failed", message: "未能读出此区域的二维码，请检查尺寸、四角或清晰度" };
    if (decoded.data !== expectedText) return { ...base, status: "failed", decoded: decoded.data, message: "回扫内容与替换内容不一致" };
    return {
      ...base, status: "passed", decoded: decoded.data,
      message: rectified ? "透视校正后回扫通过，内容一致" :
        crop.reduced ? "缩放回扫通过，内容一致" : "回扫通过，内容一致",
    };
  }

  /**
   * @returns {Promise<Array<{id: *, status: string, message: string, decoded?: string}>>}
   * onProgress({completed, total, result}) is called once per target, including
   * disabled targets. Abort rejects with AbortError; it never reports a pass.
   * Caller must keep the canvas unchanged until completion, or abort when edits
   * occur. Successful decoding only certifies this decoder, not every scanner.
   */
  async function verifyCanvas(canvas, detections, expectedText, options = {}) {
    if (!canvas || typeof canvas.getContext !== "function" ||
      !Number.isInteger(canvas.width) || !Number.isInteger(canvas.height) ||
      canvas.width < 1 || canvas.height < 1) throw new Error("没有可验证的导出图片");
    if (!Array.isArray(detections)) throw new TypeError("二维码目标必须是数组");
    const { signal, onProgress } = options;
    const results = [];
    for (const detection of detections) {
      await yieldToUI(signal);
      const det = detection || {};
      let result;
      try {
        result = await verifyTarget(canvas, det, expectedText, signal);
      } catch (error) {
        if (error.name === "AbortError") throw error;
        result = { id: det.id, status: "failed", message: "无法读取或验证此区域，请重新导入图片后重试" };
      }
      abortIfNeeded(signal);
      results.push(result);
      if (typeof onProgress === "function") onProgress({ completed: results.length, total: detections.length, result });
    }
    abortIfNeeded(signal);
    return results;
  }

  root.QRValidation = Object.freeze({ verifyCanvas });
})(typeof window !== "undefined" ? window : globalThis);
