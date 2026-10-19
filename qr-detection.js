/* Local, cancellable multi-scale QR detection. Load after vendor/jsQR.js.
 * Only small working copies are decoded; the supplied canvas is never changed.
 */
(function (root) {
  "use strict";

  const OVERVIEW_SIZE = 1600;
  const TILE_SIZE = 1024;
  const TILE_OVERLAP = 256;
  const SMALL_TILE_SIZE = 512;
  const SMALL_TILE_OVERLAP = 192;
  const MAX_TILES = 256;
  const MAX_RETRY_TILES = 256;
  const CORNERS = ["tl", "tr", "br", "bl"];
  const scriptURL = root.document && root.document.currentScript && root.document.currentScript.src;

  function abortError() {
    const error = new Error("识别已取消");
    error.name = "AbortError";
    return error;
  }

  function abortIfNeeded(signal) {
    if (signal && signal.aborted) throw abortError();
  }

  async function yieldToUI(signal) {
    abortIfNeeded(signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    abortIfNeeded(signal);
  }

  function locationOf(result) {
    const q = result.location;
    if (!q) return null;
    const loc = { tl: q.topLeftCorner, tr: q.topRightCorner,
      br: q.bottomRightCorner, bl: q.bottomLeftCorner };
    if (CORNERS.some((key) => !loc[key] || !Number.isFinite(loc[key].x) || !Number.isFinite(loc[key].y))) return null;
    return loc;
  }

  function bounds(loc) {
    const points = CORNERS.map((key) => loc[key]);
    const left = Math.min(...points.map((p) => p.x)), right = Math.max(...points.map((p) => p.x));
    const top = Math.min(...points.map((p) => p.y)), bottom = Math.max(...points.map((p) => p.y));
    return { left, right, top, bottom, area: (right - left) * (bottom - top) };
  }

  function cross(a, b, p) {
    return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  }

  function signedArea(points) {
    return points.reduce((sum, p, i) => {
      const next = points[(i + 1) % points.length];
      return sum + p.x * next.y - next.x * p.y;
    }, 0) / 2;
  }

  function intersectionArea(subject, clip) {
    let output = subject;
    const orientation = signedArea(clip) < 0 ? -1 : 1;
    for (let i = 0; i < clip.length && output.length; i++) {
      const a = clip[i], b = clip[(i + 1) % clip.length];
      const input = output;
      output = [];
      let previous = input[input.length - 1];
      let previousDistance = cross(a, b, previous) * orientation;
      for (const current of input) {
        const distance = cross(a, b, current) * orientation;
        if ((distance >= 0) !== (previousDistance >= 0)) {
          const t = previousDistance / (previousDistance - distance);
          output.push({ x: previous.x + (current.x - previous.x) * t,
            y: previous.y + (current.y - previous.y) * t });
        }
        if (distance >= 0) output.push(current);
        previous = current;
        previousDistance = distance;
      }
    }
    return output.length >= 3 ? Math.abs(signedArea(output)) : 0;
  }

  function samePosition(a, b) {
    const x = bounds(a), y = bounds(b);
    const overlap = Math.max(0, Math.min(x.right, y.right) - Math.max(x.left, y.left)) *
      Math.max(0, Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top));
    if (!overlap) return false;
    // Bounding boxes alone can overlap heavily for distinct, tilted codes.
    const first = CORNERS.map((key) => a[key]), second = CORNERS.map((key) => b[key]);
    const intersection = intersectionArea(first, second);
    return intersection / (Math.abs(signedArea(first)) + Math.abs(signedArea(second)) - intersection) > 0.55;
  }

  // Mask only the actual QR polygon, with a 1px margin. A broad rectangular
  // mask can destroy a neighbouring QR, especially when either code is tilted.
  function maskCandidate(pixels, loc) {
    const center = CORNERS.reduce((sum, key) => ({ x: sum.x + loc[key].x / 4,
      y: sum.y + loc[key].y / 4 }), { x: 0, y: 0 });
    const side = CORNERS.reduce((sum, key, i) => {
      const next = loc[CORNERS[(i + 1) % 4]];
      return sum + Math.hypot(loc[key].x - next.x, loc[key].y - next.y);
    }, 0) / 4;
    if (side < 1) return false;
    const factor = 1 + 2 / side;
    const points = CORNERS.map((key) => ({ x: center.x + (loc[key].x - center.x) * factor,
      y: center.y + (loc[key].y - center.y) * factor }));
    const minY = Math.max(0, Math.floor(Math.min(...points.map((p) => p.y))));
    const maxY = Math.min(pixels.height, Math.ceil(Math.max(...points.map((p) => p.y))));
    for (let y = minY; y < maxY; y++) {
      const intersections = [];
      for (let i = 0; i < 4; i++) {
        const a = points[i], b = points[(i + 1) % 4];
        if ((a.y > y + 0.5) !== (b.y > y + 0.5)) {
          intersections.push(a.x + (y + 0.5 - a.y) * (b.x - a.x) / (b.y - a.y));
        }
      }
      if (intersections.length < 2) continue;
      const start = Math.max(0, Math.floor(Math.min(...intersections)));
      const end = Math.min(pixels.width, Math.ceil(Math.max(...intersections)));
      pixels.data.fill(255, (y * pixels.width + start) * 4, (y * pixels.width + end) * 4);
    }
    return true;
  }

  function detectionLimit(value) {
    return Number.isInteger(value) && value > 0 ? Math.min(value, 128) : 32;
  }

  /** Low-level decoder shared with detection-worker.js. Mutates working pixels. */
  async function scanPixels(pixels, options = {}) {
    const { signal } = options;
    const limit = detectionLimit(options.maxDetections);
    if (typeof root.jsQR !== "function") throw new Error("二维码识别组件未加载，请刷新页面重试");
    const found = [];
    for (let i = 0; i < limit; i++) {
      await yieldToUI(signal);
      const result = root.jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: "attemptBoth" });
      abortIfNeeded(signal);
      if (!result) break;
      const loc = locationOf(result);
      if (!loc || found.some((previous) => samePosition(previous.loc, loc))) break;
      found.push({ data: result.data, version: result.version || 0, loc });
      if (!maskCandidate(pixels, loc)) break;
    }
    return found;
  }

  function tileAxis(length, size, overlap) {
    if (length <= size) return [0];
    const step = size - overlap;
    const positions = [];
    for (let start = 0; start < length - size; start += step) positions.push(start);
    positions.push(length - size);
    return positions;
  }

  function scanPlan(width, height) {
    const scale = Math.min(1, OVERVIEW_SIZE / Math.max(width, height));
    const plan = [{ x: 0, y: 0, width, height, outWidth: Math.max(1, Math.round(width * scale)),
      outHeight: Math.max(1, Math.round(height * scale)), phase: "overview",
      retrySize: Math.max(width, height) <= SMALL_TILE_SIZE && Math.max(width, height) > 256 ? 256 : 0 }];
    if (Math.max(width, height) <= SMALL_TILE_SIZE) return plan;
    // Even a full-resolution overview can confuse aligned finder patterns
    // belonging to separate codes. Isolate codes in smaller overlapping crops.
    const size = scale === 1 ? SMALL_TILE_SIZE : TILE_SIZE;
    const overlap = scale === 1 ? SMALL_TILE_OVERLAP : TILE_OVERLAP;
    const step = size - overlap;
    const cols = Math.max(1, Math.ceil((width - size) / step) + 1);
    const rows = Math.max(1, Math.ceil((height - size) / step) + 1);
    if (cols * rows > MAX_TILES) throw new Error("图片过大，无法完整扫描；请先裁剪图片或降低尺寸");
    for (const y of tileAxis(height, size, overlap)) {
      for (const x of tileAxis(width, size, overlap)) {
        const w = Math.min(size, width), h = Math.min(size, height);
        plan.push({ x, y, width: w, height: h, outWidth: w, outHeight: h, phase: "tiles", retrySize: size / 2 });
      }
    }
    return plan;
  }

  function hasDetail(pixels) {
    // Skip retrying blank image areas. Sample one pixel in eight before the
    // worker transfer; never retain an extra full pixel copy for this check.
    let darkest = 255, lightest = 0;
    for (let i = 0; i < pixels.data.length; i += 32) {
      const light = (pixels.data[i] + pixels.data[i + 1] + pixels.data[i + 2]) / 3;
      darkest = Math.min(darkest, light); lightest = Math.max(lightest, light);
      if (lightest - darkest >= 48) return true;
    }
    return false;
  }

  function createWorkerDecoder(signal) {
    // Most browsers reject workers loaded from file://. Main-thread decoding
    // remains fully local and yields between attempts on that entry point.
    if (!root.Worker || !root.location || !/^https?:$/.test(root.location.protocol)) return null;
    let worker;
    try {
      worker = new root.Worker(new URL("detection-worker.js", scriptURL || root.location.href));
    } catch (_) {
      return null;
    }
    let pending = null, sequence = 0, closed = false;
    function close(error) {
      if (closed) return;
      closed = true;
      worker.terminate();
      if (signal) signal.removeEventListener("abort", onAbort);
      if (pending) {
        const request = pending;
        pending = null;
        request.reject(error || new Error("识别线程已关闭"));
      }
    }
    function onAbort() { close(abortError()); }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    worker.onerror = () => close(new Error("识别线程不可用"));
    worker.onmessageerror = () => close(new Error("无法读取识别线程结果"));
    worker.onmessage = (event) => {
      if (!pending || event.data.id !== pending.id) return;
      const request = pending;
      pending = null;
      if (event.data.error) request.reject(new Error(event.data.error));
      else request.resolve(event.data.results);
    };
    return {
      close,
      run(pixels, maxDetections) {
        abortIfNeeded(signal);
        if (closed) return Promise.reject(new Error("识别线程不可用"));
        return new Promise((resolve, reject) => {
          const id = ++sequence;
          pending = { id, resolve, reject };
          try { worker.postMessage({ id, pixels, maxDetections }, [pixels.data.buffer]); }
          catch (error) { close(error); }
        });
      },
    };
  }

  /**
   * @returns {Promise<Array<{data:string, version:number, loc:{tl:object,tr:object,br:object,bl:object}}>>}
   * Locations use original canvas pixels. Same text at separate positions is
   * retained. onProgress({completed,total,phase,message,found}) covers the
   * overview and every original-resolution tile, even after an overview hit.
   * Abort rejects with AbortError. Source pixels must stay fixed until settled.
   */
  async function detectCanvas(canvas, options = {}) {
    const { signal, onProgress } = options;
    abortIfNeeded(signal);
    if (!canvas || typeof canvas.getContext !== "function" || !Number.isSafeInteger(canvas.width) ||
      !Number.isSafeInteger(canvas.height) || canvas.width < 1 || canvas.height < 1) {
      throw new Error("没有可识别的图片");
    }
    const plan = scanPlan(canvas.width, canvas.height);
    const limit = detectionLimit(options.maxDetections);
    const work = root.document.createElement("canvas");
    let worker = createWorkerDecoder(signal);
    const found = [];
    let completed = 0, retryTiles = 0;
    const plannedRegions = new Set(plan.map((r) => [r.x, r.y, r.width, r.height].join(",")));
    function report(phase, message) {
      if (typeof onProgress === "function") onProgress({ completed, total: plan.length, phase,
        message, found: found.length });
    }
    function readPixels(region) {
      work.width = region.outWidth;
      work.height = region.outHeight;
      const ctx = work.getContext("2d", { willReadFrequently: true });
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, work.width, work.height);
      ctx.drawImage(canvas, region.x, region.y, region.width, region.height, 0, 0, work.width, work.height);
      return ctx.getImageData(0, 0, work.width, work.height);
    }
    try {
      report("overview", "正在识别整张图片…");
      for (const region of plan) {
        await yieldToUI(signal);
        let pixels = readPixels(region);
        const shouldRetry = region.retrySize && hasDetail(pixels);
        let results;
        if (worker) {
          try { results = await worker.run(pixels, limit); }
          catch (error) {
            if (error.name === "AbortError") throw error;
            worker.close();
            worker = null;
            // A transferred buffer cannot be reused after worker failure.
            // Read this bounded crop again for a safe local fallback.
            pixels = readPixels(region);
          }
        }
        if (!results) results = await scanPixels(pixels, { signal, maxDetections: limit });
        abortIfNeeded(signal);
        if (!results.length && shouldRetry && retryTiles < MAX_RETRY_TILES) {
          const size = region.retrySize, overlap = Math.round(size * 0.375);
          for (const y of tileAxis(region.height, size, overlap)) {
            for (const x of tileAxis(region.width, size, overlap)) {
              const width = Math.min(size, region.width), height = Math.min(size, region.height);
              const key = [region.x + x, region.y + y, width, height].join(",");
              if (plannedRegions.has(key) || retryTiles >= MAX_RETRY_TILES) continue;
              plannedRegions.add(key); retryTiles++;
              plan.push({ x: region.x + x, y: region.y + y, width, height,
                outWidth: width, outHeight: height, phase: "detail", retrySize: 0 });
            }
          }
        }
        const scaleX = region.width / region.outWidth, scaleY = region.height / region.outHeight;
        for (const result of results) {
          const loc = {};
          for (const key of CORNERS) loc[key] = { x: region.x + result.loc[key].x * scaleX,
            y: region.y + result.loc[key].y * scaleY };
          const candidate = { data: result.data, version: result.version, loc };
          const previous = found.findIndex((det) => samePosition(det.loc, loc));
          if (previous >= 0) {
            // Native-resolution tiles also refine overview coordinates.
            if (region.phase !== "overview") found[previous] = candidate;
          } else if (found.length < limit) found.push(candidate);
        }
        completed++;
        report(region.phase, region.phase === "overview" ? "整图识别完成，正在检查细小二维码…" :
          `正在检查细小二维码 ${completed - 1}/${plan.length - 1}…`);
        abortIfNeeded(signal);
        if (found.length >= limit) break;
      }
      report("complete", found.length >= limit ? `已找到 ${found.length} 个二维码，达到单次识别上限` :
        `识别完成，找到 ${found.length} 个二维码`);
      abortIfNeeded(signal);
      return found;
    } finally {
      if (worker) worker.close();
      work.width = work.height = 0;
    }
  }

  root.QRDetection = Object.freeze({ detectCanvas, scanPixels });
})(typeof window !== "undefined" ? window : globalThis);
