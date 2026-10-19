(function (root) {
  'use strict';

  const KEY = 'qr-replace.preferences.v1';
  const VERSION = 1;
  const DEFAULTS = Object.freeze({
    text: '你还真扫啊',
    ec: 'M',
    matchVersion: true,
    allowUpgrade: false,
    defaultMode: 'replace',
    maskColor: '#ffffff',
    maskAuto: true,
    presets: Object.freeze([]),
  });

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  // Preserve whole Unicode characters when bounding user-entered text.
  function bounded(value, limit) {
    return Array.from(value).slice(0, limit).join('');
  }

  function normalize(value) {
    const source = isRecord(value) ? value : {};
    const presets = [];
    const ids = new Set();
    if (Array.isArray(source.presets)) {
      for (const entry of source.presets) {
        if (!isRecord(entry) || typeof entry.id !== 'string' ||
            typeof entry.name !== 'string' || typeof entry.text !== 'string') continue;
        const id = bounded(entry.id.trim(), 80);
        const name = bounded(entry.name.trim(), 40);
        if (!id || !name || ids.has(id)) continue;
        ids.add(id);
        presets.push({ id, name, text: bounded(entry.text, 3000) });
        if (presets.length === 24) break;
      }
    }

    // Only these explicitly remembered defaults and custom presets are stored.
    // Image data, detected contents and per-image edits are deliberately absent.
    return {
      text: typeof source.text === 'string' ? bounded(source.text, 3000) : DEFAULTS.text,
      ec: ['L', 'M', 'Q', 'H'].includes(source.ec) ? source.ec : DEFAULTS.ec,
      matchVersion: typeof source.matchVersion === 'boolean' ? source.matchVersion : DEFAULTS.matchVersion,
      allowUpgrade: typeof source.allowUpgrade === 'boolean' ? source.allowUpgrade : DEFAULTS.allowUpgrade,
      defaultMode: ['replace', 'cover', 'keep'].includes(source.defaultMode) ? source.defaultMode : DEFAULTS.defaultMode,
      maskColor: typeof source.maskColor === 'string' && /^#[0-9a-f]{6}$/i.test(source.maskColor)
        ? source.maskColor.toLowerCase() : DEFAULTS.maskColor,
      maskAuto: typeof source.maskAuto === 'boolean' ? source.maskAuto : DEFAULTS.maskAuto,
      presets,
    };
  }

  function storageFor(storage) {
    const target = storage === undefined ? root.localStorage : storage;
    if (!target) throw new Error('Storage unavailable');
    return target;
  }

  function load(storage) {
    try {
      const raw = storageFor(storage).getItem(KEY);
      if (raw === null || raw === undefined) return { ok: true, value: normalize(DEFAULTS) };
      let envelope;
      try {
        envelope = JSON.parse(raw);
      } catch (_) {
        return { ok: false, value: normalize(DEFAULTS), error: '保存的偏好设置已损坏，已使用默认设置。' };
      }
      if (!isRecord(envelope) || envelope.version !== VERSION || !isRecord(envelope.value)) {
        return { ok: false, value: normalize(DEFAULTS), error: '保存的偏好设置格式不受支持，已使用默认设置。' };
      }
      return { ok: true, value: normalize(envelope.value) };
    } catch (_) {
      return { ok: false, value: normalize(DEFAULTS), error: '无法读取浏览器偏好设置，已使用默认设置。' };
    }
  }

  function save(value, storage) {
    const normalized = normalize(value);
    try {
      storageFor(storage).setItem(KEY, JSON.stringify({ version: VERSION, value: normalized }));
      return { ok: true, value: normalized };
    } catch (error) {
      return {
        ok: false,
        value: normalized,
        error: error && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
          ? '浏览器存储空间不足，偏好设置未保存。'
          : '当前浏览器无法保存偏好设置。',
      };
    }
  }

  function clear(storage) {
    try {
      storageFor(storage).removeItem(KEY);
      return { ok: true };
    } catch (_) {
      return { ok: false, error: '当前浏览器无法清除偏好设置。' };
    }
  }

  const api = Object.freeze({ KEY, VERSION, DEFAULTS, normalize, load, save, clear });
  root.QRPreferences = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
