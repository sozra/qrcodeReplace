'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EditorHistory = require('../history.js');

test('the first edit can be undone and redone', () => {
  const history = new EditorHistory();
  assert.equal(history.current, null);
  assert.equal(history.undo(), null);
  assert.equal(history.redo(), null);
  history.reset({ text: 'original', detections: [] });
  assert.equal(history.canUndo, false);
  assert.equal(history.commit({ text: 'replacement', detections: [] }), true);
  assert.equal(history.canUndo, true);
  assert.deepEqual(history.undo(), { text: 'original', detections: [] });
  assert.equal(history.canRedo, true);
  assert.deepEqual(history.redo(), { text: 'replacement', detections: [] });
  assert.equal(history.redo(), null);
});

test('a new edit after undo discards the old redo branch', () => {
  const history = new EditorHistory();
  history.reset({ text: 'a' });
  history.commit({ text: 'b' });
  history.commit({ text: 'c' });
  history.undo();
  history.commit({ text: 'd' });
  assert.equal(history.canRedo, false);
  assert.equal(history.redo(), null);
  assert.deepEqual(history.undo(), { text: 'b' });
  assert.deepEqual(history.redo(), { text: 'd' });
});

test('saved state and every returned snapshot are independent deep clones', () => {
  const history = new EditorHistory();
  const initial = { detections: [{ corners: [{ x: 1, y: 2 }] }] };
  history.reset(initial);
  initial.detections[0].corners[0].x = 99;
  const current = history.current;
  current.detections[0].corners[0].y = 99;
  assert.deepEqual(history.current, { detections: [{ corners: [{ x: 1, y: 2 }] }] });
  const next = { detections: [{ corners: [{ x: 3, y: 4 }] }] };
  history.commit(next);
  next.detections.length = 0;
  const undone = history.undo();
  undone.detections[0].corners[0].x = 99;
  const redone = history.redo();
  redone.detections[0].corners[0].x = 99;
  assert.deepEqual(history.current, { detections: [{ corners: [{ x: 3, y: 4 }] }] });
  assert.deepEqual(history.undo(), { detections: [{ corners: [{ x: 1, y: 2 }] }] });
});

test('duplicate snapshots do not create entries or discard a redo branch', () => {
  const history = new EditorHistory();
  history.reset({ text: 'a', settings: { ec: 'M', enabled: true } });
  assert.equal(history.commit({ settings: { enabled: true, ec: 'M' }, text: 'a' }), false);
  assert.equal(history.canUndo, false);
  history.commit({ text: 'b' });
  history.undo();
  assert.equal(history.commit({ text: 'a', settings: { ec: 'M', enabled: true } }), false);
  assert.equal(history.canRedo, true);
});

test('history retains only the requested capacity and reset clears both directions', () => {
  const history = new EditorHistory(3);
  history.reset({ step: 0 });
  for (let step = 1; step <= 5; step += 1) history.commit({ step });
  assert.deepEqual(history.undo(), { step: 4 });
  assert.deepEqual(history.undo(), { step: 3 });
  assert.equal(history.undo(), null);
  history.reset({ step: 10 });
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
  assert.deepEqual(history.current, { step: 10 });
});

test('capacity is normalized and defaults to 60 snapshots', () => {
  const one = new EditorHistory(-1);
  one.reset({ step: 0 });
  one.commit({ step: 1 });
  assert.equal(one.canUndo, false);
  assert.deepEqual(one.current, { step: 1 });

  const fractional = new EditorHistory(2.9);
  fractional.reset({ step: 0 });
  fractional.commit({ step: 1 });
  fractional.commit({ step: 2 });
  assert.deepEqual(fractional.undo(), { step: 1 });
  assert.equal(fractional.undo(), null);

  for (const limit of [undefined, NaN, Infinity, 'invalid']) {
    const history = new EditorHistory(limit);
    for (let step = 0; step <= 60; step += 1) history.commit({ step });
    let undoCount = 0;
    while (history.canUndo) {
      history.undo();
      undoCount += 1;
    }
    assert.equal(undoCount, 59);
    assert.deepEqual(history.current, { step: 1 });
  }
});
