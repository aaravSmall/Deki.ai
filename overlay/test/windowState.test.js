const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  MIN_SIZE,
  clampSize,
  defaultBounds,
  restoreBounds,
  loadSavedBounds,
  saveBounds,
} = require('../lib/windowState');

const laptop = { x: 0, y: 0, width: 1440, height: 875 };
const external = { x: 1440, y: 0, width: 1920, height: 1055 };

test('defaults to the top-right of the primary work area', () => {
  assert.deepEqual(defaultBounds(laptop), { width: 420, height: 340, x: 1000, y: 40 });
  assert.deepEqual(restoreBounds(null, [laptop], laptop), defaultBounds(laptop));
});

test('restores saved bounds that are still on a display', () => {
  const saved = { x: 2000, y: 100, width: 600, height: 500 };
  assert.deepEqual(restoreBounds(saved, [laptop, external], laptop), saved);
});

test('falls back to defaults when the saved display is gone', () => {
  const saved = { x: 2000, y: 100, width: 600, height: 500 };
  assert.deepEqual(restoreBounds(saved, [laptop], laptop), defaultBounds(laptop));
});

test('ignores garbage saved data', () => {
  assert.deepEqual(restoreBounds({ x: 'a' }, [laptop], laptop), defaultBounds(laptop));
});

test('clampSize enforces the minimum size', () => {
  assert.deepEqual(clampSize({ width: 10, height: 10 }), MIN_SIZE);
  assert.deepEqual(clampSize({ width: 500.4, height: 400.6 }), { width: 500, height: 401 });
});

test('saveBounds and loadSavedBounds round-trip; a missing file loads as null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deki-window-'));
  const file = path.join(dir, 'window-state.json');
  try {
    assert.equal(loadSavedBounds(file), null);
    saveBounds(file, { x: 1, y: 2, width: 400, height: 300 });
    assert.deepEqual(loadSavedBounds(file), { x: 1, y: 2, width: 400, height: 300 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
