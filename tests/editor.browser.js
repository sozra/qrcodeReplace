/* Run against the local app with agent-browser eval --stdin < tests/editor.browser.js.
 * Uses synthetic local images; clipboard writes and downloads are intercepted.
 */
(async () => {
  const passed = [];
  const assert = (condition, label) => { if (!condition) throw new Error(label); passed.push(label); };
  const click = id => document.getElementById(id).click();
  const text = value => { inpText.value = value; inpText.dispatchEvent(new Event("input", { bubbles: true })); };
  async function fixture({ width = 800, height = 900, size = 232, x = 260, y = 240, data = "123456789012" } = {}) {
    const qr = qrcode(3, "M"); qr.addData(data); qr.make();
    const c = document.createElement("canvas"); c.width = width; c.height = height;
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height); ctx.fillStyle = "#000";
    const n = qr.getModuleCount();
    for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (qr.isDark(r, col)) ctx.fillRect(x + col * size / n, y + r * size / n, size / n, size / n);
    ctx.font = "24px Arial"; ctx.textAlign = "center"; ctx.fillText("1234 5678 9012", x + size / 2, y + size + 36);
    const img = new Image(); await new Promise(resolve => { img.onload = resolve; img.src = c.toDataURL(); });
    await loadImage(img, "sample.png");
  }
  function decode(c) { const p = c.getContext("2d").getImageData(0, 0, c.width, c.height); return jsQR(p.data, p.width, p.height)?.data; }
  const preferenceBefore = JSON.parse(JSON.stringify(preferences));
  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  const originalValidation = window.QRValidation;
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const originalPointerMethods = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"].map(k => [k, Object.getOwnPropertyDescriptor(viewport, k)]);
  let downloads = [], copied = [];
  HTMLAnchorElement.prototype.click = function () { downloads.push({ url: this.href, name: this.download }); };
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write: async items => { copied.push(await items[0].getType("image/png")); } } });
  // Synthetic events exercise handlers; real pointer capture is separately checked via browser mouse input.
  viewport.setPointerCapture = () => {}; viewport.releasePointerCapture = () => {}; viewport.hasPointerCapture = () => false;
  const pointer = (type, id, x, y) => {
    const rect = viewport.getBoundingClientRect();
    viewport.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: "touch", button: 0, clientX: rect.left + camera.x + x * camera.scale, clientY: rect.top + camera.y + y * camera.scale, bubbles: true }));
  };
  try {
    preferences = QRPreferences.normalize(QRPreferences.DEFAULTS);
    state.text = preferences.text; state.defaultMode = preferences.defaultMode;
    await fixture();
    assert(state.detections.length === 1, "initial image detection");
    assert(decode(resultCanvas) === "你还真扫啊", "replacement is readable");
    await verifyResult();
    assert(document.querySelector(".validation-row.passed"), "final PNG verification passes");
    text("updated content"); click("btnUndo");
    assert(state.detections[0].text === "你还真扫啊", "pending text edit is undoable");
    click("btnRedo"); assert(state.detections[0].text === "updated content", "redo restores replacement");
    assert(!document.querySelector(".validation-row"), "edit invalidates validation results");
    text(""); assert(!!renderError && btnDownload.disabled && decode(resultCanvas) === "123456789012", "empty text preserves original and blocks export");
    text("A".repeat(3000)); assert(!!renderError && btnDownload.disabled, "oversized text is recoverable");
    text("verified output"); commitHistory();
    assert(!renderError && !btnDownload.disabled, "valid text recovers export");
    const output = resultCanvas.toDataURL();
    click("btnCompare");
    assert(view.toDataURL() === state.srcCanvas.toDataURL(), "original comparison is pixel exact");
    assert(resultCanvas.toDataURL() === output, "comparison does not alter output");
    click("btnCompare"); const scale = camera.scale; click("btnZoomIn");
    assert(camera.scale > scale && resultCanvas.width === 800 && resultCanvas.height === 900, "zoom preserves original export resolution");
    click("btnFit");
    let det = state.detections[0], point = { ...det.loc.tl };
    pointer("pointerdown", 1, point.x, point.y); pointer("pointermove", 1, point.x - 12, point.y - 6); pointer("pointerup", 1, point.x - 12, point.y - 6);
    assert(state.detections[0].loc.tl.x < point.x - 5, "corner drag changes geometry");
    click("btnUndo"); assert(state.detections[0].loc.tl.x === point.x, "corner drag undone");
    click("btnRedo"); assert(state.detections[0].loc.tl.x < point.x - 5, "corner drag redone"); click("btnUndo");
    editorHistory.reset(captureEdit());
    pointer("pointerdown", 1, point.x, point.y); pointer("pointermove", 1, point.x - 10, point.y - 10);
    pointer("pointerdown", 2, point.x + 100, point.y + 100); pointer("pointerup", 2, point.x + 100, point.y + 100); pointer("pointerup", 1, point.x, point.y);
    assert(state.detections[0].loc.tl.x === point.x && !editorHistory.canUndo, "pinch cancels partial edit without polluting history");
    pointer("pointerdown", 1, point.x, point.y); pointer("pointermove", 1, point.x - 10, point.y - 10); pointer("pointercancel", 1, point.x, point.y);
    assert(state.detections[0].loc.tl.x === point.x && !editorHistory.canUndo, "pointer cancellation restores geometry");
    det = state.detections[0]; det.numMode = "cover"; det.numRegion.x += 10; editChanged();
    const preserved = JSON.stringify(det.numRegion); await runDetection();
    assert(state.detections[0].numMode === "cover" && JSON.stringify(state.detections[0].numRegion) === preserved, "rescan retains edited number region");
    await verifyResult("download");
    assert(downloads.length === 1 && downloads[0].name.startsWith("sample-qr-"), "download follows successful validation");
    const downloaded = await (await fetch(downloads[0].url)).blob(), canvas = await blobCanvas(downloaded);
    assert(canvas.width === 800 && canvas.height === 900 && decode(canvas) === state.detections[0].text, "downloaded PNG has full size and expected content");
    await verifyResult("copy"); assert(copied.length === 1 && copied[0].type === "image/png", "copy uses validated PNG");
    let writeReject;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write: () => new Promise((_, reject) => { writeReject = reject; }) } });
    const staleCopy = performExport({ blob: downloaded, action: "copy", revision });
    text("edited during copy"); writeReject(new Error("test rejection")); await staleCopy;
    assert(!$("exportDialog").open && !pendingExport, "stale copy failure does not reopen dialog");
    const staleRun = verifyResult("download"); text("edited during validation"); await staleRun;
    assert(downloads.length === 1 && !document.querySelector(".validation-row"), "editing cancels stale export");
    window.QRValidation = { verifyCanvas: async (_, targets) => targets.map(d => ({ id: d.id, status: "failed", message: "test failure" })) };
    await verifyResult("download");
    assert($("exportDialog").open && downloads.length === 1, "failed verification requires explicit decision");
    click("btnExportCancel"); assert(!$("exportDialog").open && !pendingExport, "cancel failure export");
    await verifyResult("download"); click("btnExportAnyway");
    assert(downloads.length === 2, "explicit override exports frozen result");
    window.QRValidation = { verifyCanvas: async (_, targets) => targets.map(d => ({ id: d.id, status: "skipped", message: "decoder unavailable" })) };
    await verifyResult("download");
    assert($("exportDialog").open && downloads.length === 2, "unverified enabled target also requires decision"); click("btnExportCancel");
    window.QRValidation = originalValidation;
    await fixture({ width: 4000, height: 3000, size: 58 });
    assert(state.detections.length === 1, "native tile scan automatically recovers small code");
    document.querySelector('.det [data-act="delete"]').click(); editorHistory.reset(captureEdit());
    click("btnAddQr"); pointer("pointerdown", 1, 252, 232); pointer("pointermove", 1, 326, 306); pointer("pointerup", 1, 326, 306);
    assert(state.detections.length === 1 && state.detections[0].data === "123456789012", "manual box recovers small code at original resolution");
    click("btnUndo"); assert(state.detections.length === 0, "manual addition is undoable"); click("btnRedo"); assert(state.detections.length === 1, "manual addition redo");
    click("btnAddQr"); pointer("pointerdown", 1, 800, 800); pointer("pointermove", 1, 1032, 1032); pointer("pointerup", 1, 1032, 1032);
    assert(state.detections.length === 2 && state.detections[1].data === "" && state.detections[1].manual, "unreadable box retains editable manual target");
    click("btnUndo");
    click("btnAddQr"); pointer("pointerdown", 1, 900, 900); pointer("pointermove", 1, 1100, 1100); click("btnCancelEdit");
    assert(state.detections.length === 1 && state.tool === "select", "cancel unfinished manual box");
    await fixture(); assert(!editorHistory.canUndo && !editorHistory.canRedo, "new image resets history");
    text("你还真扫啊"); commitHistory(); await verifyResult();
    return { passed: passed.length, checks: passed };
  } finally {
    preferences = preferenceBefore;
    HTMLAnchorElement.prototype.click = originalAnchorClick; window.QRValidation = originalValidation;
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor); else delete navigator.clipboard;
    for (const [key, descriptor] of originalPointerMethods) { if (descriptor) Object.defineProperty(viewport, key, descriptor); else delete viewport[key]; }
  }
})()
