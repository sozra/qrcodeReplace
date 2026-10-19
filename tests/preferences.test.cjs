'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Preferences = require('../preferences.js');

function memoryStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key) => entries.has(key) ? entries.get(key) : null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
  };
}

test('new storage loads independent defaults and never writes on load', () => {
  const storage = memoryStorage();
  const first = Preferences.load(storage);
  assert.equal(first.ok, true);
  assert.deepEqual(first.value, Preferences.DEFAULTS);
  first.value.presets.push({ id: 'a', name: 'a', text: 'a' });
  first.value.text = 'changed';
  assert.deepEqual(Preferences.load(storage).value, Preferences.DEFAULTS);
  assert.equal(storage.entries.size, 0);
  assert.equal(Object.isFrozen(Preferences.DEFAULTS), true);
  assert.equal(Object.isFrozen(Preferences.DEFAULTS.presets), true);
});

test('explicitly saved preferences round-trip through a versioned allowlist', () => {
  const storage = memoryStorage();
  const input = {
    text: '  中文 https://example.test/🟢  ',
    ec: 'H', matchVersion: false, allowUpgrade: true, defaultMode: 'cover',
    maskColor: '#Ab12Cd', maskAuto: false,
    presets: [{ id: 'one', name: 'My preset', text: 'replacement', original: 'sensitive' }],
    image: 'data:image/png;base64,should-never-be-saved',
    original: 'detected-secret', detections: [{ text: 'detected-secret' }],
  };
  const saved = Preferences.save(input, storage);
  assert.equal(saved.ok, true);
  assert.equal(saved.value.maskColor, '#ab12cd');
  const raw = storage.getItem(Preferences.KEY);
  assert.equal(JSON.parse(raw).version, 1);
  assert.equal(raw.includes('secret'), false);
  assert.equal(raw.includes('sensitive'), false);
  assert.equal(raw.includes('data:image'), false);
  assert.deepEqual(Preferences.load(storage).value, saved.value);
  input.presets[0].text = 'changed';
  saved.value.presets[0].text = 'changed again';
  assert.equal(Preferences.load(storage).value.presets[0].text, 'replacement');
});

test('corrupt JSON, unsupported versions and invalid envelopes fall back without deletion', () => {
  for (const raw of ['{broken', 'null', '[]', 'true', '{"version":2,"value":{}}',
    '{"version":"1","value":{}}', '{"version":1}', '{"version":1,"value":[]}']) {
    const storage = memoryStorage({ [Preferences.KEY]: raw });
    const result = Preferences.load(storage);
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
    assert.deepEqual(result.value, Preferences.DEFAULTS);
    assert.equal(storage.getItem(Preferences.KEY), raw);
  }
});

test('invalid preference types use defaults and unknown values are ignored', () => {
  for (const invalid of [null, [], 'value', 0, true]) {
    assert.deepEqual(Preferences.normalize(invalid), Preferences.DEFAULTS);
  }
  assert.deepEqual(Preferences.normalize({
    text: 42, ec: 'highest', matchVersion: 'false', allowUpgrade: 1,
    defaultMode: 'mask', maskColor: 'url(evil)', maskAuto: 0, presets: {},
    __proto__: null,
  }), Preferences.DEFAULTS);
  for (const mode of ['replace', 'cover', 'keep']) {
    assert.equal(Preferences.normalize({ defaultMode: mode }).defaultMode, mode);
  }
  for (const ec of ['L', 'M', 'Q', 'H']) {
    assert.equal(Preferences.normalize({ ec }).ec, ec);
  }
});

test('preset limits discard invalid and duplicate records while preserving Unicode', () => {
  const presets = [
    null, 'bad', {}, { id: 123, name: 'Bad', text: 'x' },
    { id: ' ', name: 'Bad', text: 'x' }, { id: 'x', name: ' ', text: 'x' },
    { id: 'valid', name: '  First  ', text: '  exact text  ' },
    { id: 'valid', name: 'Duplicate', text: 'discard' },
    ...Array.from({ length: 30 }, (_, i) => ({
      id: `preset-${i}`, name: '😀'.repeat(41), text: '🧩'.repeat(3001),
    })),
  ];
  const value = Preferences.normalize({ text: '😀'.repeat(3001), presets });
  assert.equal(value.presets.length, 24);
  assert.deepEqual(value.presets[0], { id: 'valid', name: 'First', text: '  exact text  ' });
  assert.equal(Array.from(value.presets[1].name).length, 40);
  assert.equal(Array.from(value.presets[1].text).length, 3000);
  assert.equal(Array.from(value.text).length, 3000);
  assert.equal(value.presets.some((entry) => entry.name === 'Duplicate'), false);
  assert.equal(Preferences.normalize({ presets: [{ id: 'i'.repeat(100), name: 'a', text: '' }] }).presets[0].id.length, 80);
});

test('stored markup remains inert string data and cannot add object properties', () => {
  const storage = memoryStorage();
  const text = '<img src=x onerror="globalThis.executed=true">';
  const input = JSON.parse('{"__proto__":{"polluted":true},"presets":[]}');
  input.text = text;
  input.presets.push({ id: '__proto__', name: '<script>alert(1)</script>', text });
  Preferences.save(input, storage);
  const value = Preferences.load(storage).value;
  assert.equal(value.text, text);
  assert.equal(value.presets[0].text, text);
  assert.equal(value.presets[0].name, '<script>alert(1)</script>');
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.hasOwn(value, '__proto__'), false);
  assert.equal(globalThis.executed, undefined);
});

test('security and quota failures return safe errors rather than throwing', () => {
  const securityError = Object.assign(new Error('do not expose private error detail'), { name: 'SecurityError' });
  const blocked = {
    getItem() { throw securityError; },
    setItem() { throw securityError; },
    removeItem() { throw securityError; },
  };
  for (const result of [Preferences.load(blocked), Preferences.save({}, blocked), Preferences.clear(blocked),
    Preferences.load(null), Preferences.save({}, null), Preferences.clear(null)]) {
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
    assert.equal(result.error.includes('private'), false);
  }
  const quota = Preferences.save({}, { setItem() { throw Object.assign(new Error(), { name: 'QuotaExceededError' }); } });
  assert.equal(quota.ok, false);
  assert.match(quota.error, /空间不足/);
  assert.deepEqual(quota.value, Preferences.DEFAULTS);
});

test('clear removes only this application key and leaves unrelated storage intact', () => {
  const storage = memoryStorage({ unrelated: 'keep', 'qr-replace.preferences.v0': 'old' });
  Preferences.save({ text: 'saved' }, storage);
  assert.deepEqual(Preferences.clear(storage), { ok: true });
  assert.equal(storage.getItem(Preferences.KEY), null);
  assert.equal(storage.getItem('unrelated'), 'keep');
  assert.equal(storage.getItem('qr-replace.preferences.v0'), 'old');
  assert.deepEqual(Preferences.clear(storage), { ok: true });
});

test('browser global works and guards localStorage property access', () => {
  const script = fs.readFileSync(require.resolve('../preferences.js'), 'utf8');
  const normalContext = vm.createContext({ localStorage: memoryStorage() });
  vm.runInContext(script, normalContext);
  assert.equal(normalContext.QRPreferences.save({ text: 'saved' }).ok, true);
  assert.equal(normalContext.QRPreferences.load().value.text, 'saved');
  assert.equal(normalContext.QRPreferences.clear().ok, true);

  const blockedContext = vm.createContext({});
  Object.defineProperty(blockedContext, 'localStorage', {
    get() { throw new Error('restricted access'); },
  });
  vm.runInContext(script, blockedContext);
  assert.equal(blockedContext.QRPreferences.load().ok, false);
  assert.equal(blockedContext.QRPreferences.save({}).ok, false);
  assert.equal(blockedContext.QRPreferences.clear().ok, false);
});
