/* Run with agent-browser eval --stdin < tests/workflow.browser.js against the local app.
 * Independent workflow checks use synthetic images and restore saved preferences.
 */
(async () => {
  const passed = [];
  const assert = (condition, label) => { if (!condition) throw new Error(label); passed.push(label); };
  const click = id => document.getElementById(id).click();
  const text = value => { inpText.value = value; inpText.dispatchEvent(new Event("input", { bubbles: true })); };
  const mode = value => document.querySelector(`#segMode [data-mode="${value}"]`).click();
  const storedBefore = localStorage.getItem(QRPreferences.KEY);
  const preferenceBefore = JSON.parse(JSON.stringify(preferences));
  const anchorClick = HTMLAnchorElement.prototype.click;
  const pointerMethods = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"].map(key => [key, Object.getOwnPropertyDescriptor(viewport, key)]);
  let downloads = 0, frame = null;
  HTMLAnchorElement.prototype.click = function () { downloads++; };
  viewport.setPointerCapture = () => {}; viewport.releasePointerCapture = () => {}; viewport.hasPointerCapture = () => false;

  function pointer(type, x, y) {
    const rect = viewport.getBoundingClientRect();
    viewport.dispatchEvent(new PointerEvent(type, { pointerId: 91, pointerType: "mouse", button: 0,
      clientX: rect.left + camera.x + x * camera.scale, clientY: rect.top + camera.y + y * camera.scale, bubbles: true }));
  }
  function drag(x0, y0, x1, y1) {
    pointer("pointerdown", x0, y0); pointer("pointermove", x1, y1); pointer("pointerup", x1, y1);
  }
  function decodeAt(det, canvas = resultCanvas) {
    const points = Object.values(det.loc), pad = 30;
    const x = Math.max(0, Math.floor(Math.min(...points.map(p => p.x))) - pad);
    const y = Math.max(0, Math.floor(Math.min(...points.map(p => p.y))) - pad);
    const w = Math.min(canvas.width - x, Math.ceil(Math.max(...points.map(p => p.x))) + pad - x);
    const h = Math.min(canvas.height - y, Math.ceil(Math.max(...points.map(p => p.y))) + pad - y);
    const pixels = canvas.getContext("2d").getImageData(x, y, w, h);
    return jsQR(pixels.data, w, h)?.data;
  }
  function samePixels(a, b, rect) {
    const p = a.getContext("2d").getImageData(rect.x, rect.y, rect.w, rect.h).data;
    const q = b.getContext("2d").getImageData(rect.x, rect.y, rect.w, rect.h).data;
    return p.length === q.length && p.every((value, i) => value === q[i]);
  }
  function pixel(canvas, x, y) { return [...canvas.getContext("2d").getImageData(x, y, 1, 1).data]; }
  async function fixture() {
    const c = document.createElement("canvas"); c.width = 960; c.height = 620;
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    for (const [data, x] of [["123456789012", 120], ["original second", 620]]) {
      const qr = qrcode(3, "M"); qr.addData(data); qr.make(); ctx.fillStyle = "#000";
      for (let row = 0; row < 29; row++) for (let col = 0; col < 29; col++) {
        if (qr.isDark(row, col)) ctx.fillRect(x + col * 6, 120 + row * 6, 6, 6);
      }
    }
    ctx.font = "24px Arial"; ctx.textAlign = "center"; ctx.fillText("1234 5678 9012", 207, 332);
    const img = new Image(); await new Promise(resolve => { img.onload = resolve; img.src = c.toDataURL(); });
    await loadImage(img, "workflow-sample.png");
    return c.toDataURL();
  }

  try {
    preferences = QRPreferences.normalize(QRPreferences.DEFAULTS); QRPreferences.clear();
    state.text = preferences.text; state.defaultMode = preferences.defaultMode;
    state.ec = "M"; state.matchVersion = true; state.allowUpgrade = false;
    renderPresets(); updateEditor();
    await fixture();
    assert(state.detections.length === 2, "both independently editable QR targets are detected");
    const firstId = state.detections.find(d => d.data === "123456789012").id;
    const secondId = state.detections.find(d => d.data === "original second").id;
    const first = () => state.detections.find(d => d.id === firstId);
    const second = () => state.detections.find(d => d.id === secondId);
    selectDetection(firstId); text("first replacement"); commitHistory();
    selectDetection(secondId); text("second replacement"); commitHistory();
    assert(decodeAt(first()) === "first replacement" && decodeAt(second()) === "second replacement", "editing each target produces different scannable contents");
    assert(state.text === preferences.text, "per-target edits do not overwrite new-target defaults");
    await verifyResult();
    assert(document.querySelectorAll(".validation-row.passed").length === 2, "both different payloads pass final PNG verification");
    click("btnApplyAll");
    assert(decodeAt(first()) === "second replacement" && decodeAt(second()) === "second replacement", "explicit apply-all changes both replacement targets");
    click("btnUndo");
    assert(decodeAt(first()) === "first replacement" && decodeAt(second()) === "second replacement", "undo restores separate payloads after apply-all");
    selectDetection(secondId); mode("keep");
    assert(decodeAt(second()) === "original second" && inpText.disabled, "keep mode preserves the original QR and disables replacement input");
    mode("cover");
    assert(decodeAt(second()) === undefined && !renderError && !btnDownload.disabled, "explicit cover mode removes the QR without an empty-text error");
    mode("replace");
    assert(decodeAt(second()) === "second replacement", "returning to replace retains that target's text");

    selectDetection(firstId);
    assert(!!first().numRegion, "numeric QR gets an editable ticket-number region");
    document.querySelector(`.det[data-id="${firstId}"] [data-m="cover"]`).click();
    const numberRect = { x: 95, y: 302, w: 225, h: 40 };
    assert(!samePixels(resultCanvas, state.srcCanvas, numberRect), "ticket-number cover changes final pixels");
    const master = document.querySelector(`.det[data-id="${firstId}"] .target-toggle input`);
    master.checked = false; master.dispatchEvent(new Event("change", { bubbles: true }));
    assert(decodeAt(first()) === "123456789012" && samePixels(resultCanvas, state.srcCanvas, numberRect), "master disable restores both original QR and ticket number");
    click("btnUndo");
    assert(first().enabled && first().numMode === "cover" && !samePixels(resultCanvas, state.srcCanvas, numberRect), "undo restores all edits in the disabled group");
    document.querySelector(`.det[data-id="${firstId}"] [data-m="off"]`).click();

    selectDetection(secondId); text("A".repeat(160));
    assert(!!renderError && btnDownload.disabled && /容量/.test(renderError), "strict original version blocks oversized text with a capacity error");
    const upgrade = document.getElementById("chkAllowUpgrade"); upgrade.checked = true; upgrade.dispatchEvent(new Event("change", { bubbles: true }));
    assert(!renderError && second().generatedVersion > second().version && decodeAt(second()) === "A".repeat(160), "explicit density upgrade yields a larger readable QR");
    assert(document.querySelector(`.det[data-id="${secondId}"]`).textContent.includes(`新码 v${second().generatedVersion}`), "target card reports actual generated version");
    text("second replacement"); commitHistory();

    click("btnAddMask"); drag(110, 440, 230, 510);
    assert(state.masks.length === 1 && !document.getElementById("maskEditor").classList.contains("hidden"), "drawing an arbitrary region opens the mask editor");
    const maskId = state.masks[0].id;
    const mask = () => state.masks.find(m => m.id === maskId);
    const color = document.getElementById("inpMaskColor"); color.value = "#123456"; color.dispatchEvent(new Event("input", { bubbles: true })); color.dispatchEvent(new Event("change", { bubbles: true }));
    assert(pixel(resultCanvas, 160, 470).join() === "18,52,86,255", "custom mask color writes opaque final pixels");
    drag(165, 475, 205, 495);
    assert(Math.abs(mask().rect.x - 150) < 0.1 && Math.abs(mask().rect.y - 460) < 0.1, "dragging a mask moves its rectangle");
    const moved = { ...mask().rect };
    drag(moved.x + moved.w, moved.y + moved.h, moved.x + moved.w + 30, moved.y + moved.h + 20);
    assert(Math.abs(mask().rect.w - 150) < 0.1 && Math.abs(mask().rect.h - 90) < 0.1, "dragging a mask corner resizes its rectangle");
    click("btnUndo");
    assert(Math.abs(mask().rect.w - moved.w) < 0.1 && Math.abs(mask().rect.h - moved.h) < 0.1, "mask resize is undoable");
    click("btnRedo");
    assert(Math.abs(mask().rect.w - 150) < 0.1, "mask resize is redoable");
    const beforeCancel = JSON.stringify(mask().rect);
    pointer("pointerdown", mask().rect.x + 45, mask().rect.y + 40); pointer("pointermove", mask().rect.x + 65, mask().rect.y + 60); click("btnCancelEdit");
    assert(JSON.stringify(mask().rect) === beforeCancel, "cancelled mask movement restores the previous rectangle");

    click("btnAddMask"); drag(610, 110, 804, 304);
    await verifyResult("download");
    assert(document.querySelectorAll(".validation-row.failed").length === 1 && document.getElementById("exportDialog").open && downloads === 0, "a real mask covering a QR fails scanning and gates export");
    click("btnExportCancel"); click("btnDeleteMask");
    await verifyResult();
    assert(document.querySelectorAll(".validation-row.passed").length === 2, "removing the obstructing mask restores successful verification");

    selectDetection(firstId); text("saved default text"); commitHistory();
    document.getElementById("inpPresetName").value = '<img src=x onerror="bad">'; click("btnSavePreset");
    assert(QRPreferences.load().value.presets.some(p => p.text === "saved default text") && !document.querySelector("#customPresets img"), "custom preset saves as inert text without interpreting markup");
    assert(QRPreferences.load().value.text !== "saved default text", "saving a preset does not implicitly remember current replacement text");
    click("btnRememberDefaults");
    assert(QRPreferences.load().value.text === "saved default text", "remember-defaults explicitly persists replacement text");
    const frameLoaded = new Promise((resolve, reject) => {
      frame = document.createElement("iframe"); frame.style.cssText = "position:fixed;left:-2000px;width:800px;height:600px";
      frame.onload = resolve; frame.onerror = reject; frame.src = location.href; document.body.appendChild(frame);
    });
    await frameLoaded;
    assert(frame.contentWindow.eval("state.text") === "saved default text" && frame.contentDocument.querySelectorAll("#customPresets .custom-preset").length === 1,
      "a fresh app document reloads the saved default and custom preset");
    frame.remove(); frame = null;
    text("temporary"); document.querySelector("#customPresets .chip").click();
    assert(decodeAt(first()) === "saved default text", "using a saved preset changes the selected target's output");
    document.querySelector("#customPresets .preset-delete").click();
    assert(QRPreferences.load().value.presets.length === 0 && !document.querySelector("#customPresets .custom-preset"), "deleting a custom preset updates storage and controls");
    const editedOutput = resultCanvas.toDataURL(); click("btnResetEdits");
    assert(state.masks.length === 0 && first().text === "你还真扫啊" && second().text === "你还真扫啊", "reset restores initial targets and removes arbitrary masks");
    click("btnUndo");
    assert(resultCanvas.toDataURL() === editedOutput, "undoing reset restores the complete edited image");
    return { passed: passed.length, checks: passed };
  } finally {
    frame?.remove();
    cancelInteraction(); clearTimeout(historyTimer);
    HTMLAnchorElement.prototype.click = anchorClick;
    for (const [key, descriptor] of pointerMethods) { if (descriptor) Object.defineProperty(viewport, key, descriptor); else delete viewport[key]; }
    if (storedBefore === null) localStorage.removeItem(QRPreferences.KEY); else localStorage.setItem(QRPreferences.KEY, storedBefore);
    preferences = preferenceBefore; renderPresets();
  }
})()
