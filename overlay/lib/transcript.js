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

// Non-speech annotations whisper emits for silence, music, noise, etc.:
// [BLANK_AUDIO], [Music], (upbeat music), *silence*, ♪ ... ♪
const NON_SPEECH_TOKEN = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g;

// Phrases whisper is known to invent on silent or near-silent audio (it was
// trained on lots of subtitled video). Only dropped when a whole segment is
// nothing but one of these, so they still survive inside real speech.
const SILENCE_HALLUCINATIONS = new Set([
  'you',
  'thank you',
  'thanks',
  'thank you very much',
  'thanks for watching',
  'thank you for watching',
  'thank you so much for watching',
  'please subscribe',
  'bye',
  'okay',
  'oh',
  'um',
  'uh',
]);

function normalizeForComparison(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Turns raw whisper output into speech text, or '' when the segment holds no
// real speech (only silence markers, music tags, or a filler hallucination).
// Returning '' matters: the overlay treats any new words as "something
// changed" and re-runs analysis, so silence must not produce words.
function extractSpeech(raw) {
  const text = cleanWhisperOutput(raw)
    .replace(NON_SPEECH_TOKEN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const normalized = normalizeForComparison(text);
  if (!normalized) return '';
  if (SILENCE_HALLUCINATIONS.has(normalized)) return '';
  return text;
}

module.exports = { cleanWhisperOutput, extractSpeech };
