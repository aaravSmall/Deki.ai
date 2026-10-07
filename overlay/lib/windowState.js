// Remembers the overlay's size and position between launches. The pure
// helpers (no Electron imports) are unit-tested; main.js does the I/O.

const fs = require('fs');

const DEFAULT_SIZE = { width: 420, height: 340 };
const MIN_SIZE = { width: 320, height: 220 };
const EDGE_MARGIN = 20;

function clampSize({ width, height }) {
  return {
    width: Math.max(MIN_SIZE.width, Math.round(Number(width) || DEFAULT_SIZE.width)),
    height: Math.max(MIN_SIZE.height, Math.round(Number(height) || DEFAULT_SIZE.height)),
  };
}

// Default spot: top-right corner of the primary display's work area.
function defaultBounds(primaryWorkArea) {
  return {
    ...DEFAULT_SIZE,
    x: primaryWorkArea.x + primaryWorkArea.width - DEFAULT_SIZE.width - EDGE_MARGIN,
    y: primaryWorkArea.y + 40,
  };
}

// Uses saved bounds only if the window's top-left area would still be on one
// of the current displays (a monitor may have been unplugged since), so the
// overlay never reopens somewhere it can't be seen or dragged back from.
function restoreBounds(saved, workAreas, primaryWorkArea) {
  if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) {
    return defaultBounds(primaryWorkArea);
  }
  const size = clampSize(saved);
  const onScreen = workAreas.some(
    (area) =>
      saved.x + 40 >= area.x &&
      saved.x + 40 <= area.x + area.width &&
      saved.y >= area.y &&
      saved.y + 20 <= area.y + area.height
  );
  return onScreen ? { ...size, x: Math.round(saved.x), y: Math.round(saved.y) } : defaultBounds(primaryWorkArea);
}

function loadSavedBounds(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null; // first launch, or an unreadable file - use defaults
  }
}

function saveBounds(filePath, bounds) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(bounds));
  } catch (err) {
    console.warn('[overlay] could not save window position:', err.message || err);
  }
}

module.exports = { DEFAULT_SIZE, MIN_SIZE, clampSize, defaultBounds, restoreBounds, loadSavedBounds, saveBounds };
