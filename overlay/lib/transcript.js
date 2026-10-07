// Pure helpers for turning raw whisper.cpp output into transcript text.
// Kept free of Electron imports so they can be unit-tested with plain Node.

// whisper-cli prints each segment as
//   [00:00:00.000 --> 00:00:04.320]   Hello there.
// and nodejs-whisper hands back that stdout unchanged.
const TIMESTAMP_PREFIX = /^\s*\[\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}\]\s*/;

// Strips per-segment timestamps and joins the segments into one line of text.
function cleanWhisperOutput(raw) {
  if (!raw) return '';
  return String(raw)
    .split(/\r?\n/)
    .map((line) => line.replace(TIMESTAMP_PREFIX, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { cleanWhisperOutput };
