const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cleanWhisperOutput, extractSpeech } = require('../lib/transcript');

const seg = (start, end, text) => `[00:00:${start}.000 --> 00:00:${end}.000]   ${text}`;

test('cleanWhisperOutput strips timestamps and joins segments', () => {
  const raw = `\n${seg('00', '02', 'Hello there.')}\n${seg('02', '05', 'How are you?')}\n`;
  assert.equal(cleanWhisperOutput(raw), 'Hello there. How are you?');
});

test('cleanWhisperOutput accepts comma decimal separators and CRLF', () => {
  const raw = '[00:00:00,000 --> 00:00:02,000]  One\r\n[00:00:02,000 --> 00:00:04,000]  two';
  assert.equal(cleanWhisperOutput(raw), 'One two');
});

test('cleanWhisperOutput passes through text with no timestamps', () => {
  assert.equal(cleanWhisperOutput('  plain   text '), 'plain text');
  assert.equal(cleanWhisperOutput(''), '');
  assert.equal(cleanWhisperOutput(undefined), '');
});

test('extractSpeech drops silence and non-speech annotations', () => {
  for (const marker of ['[BLANK_AUDIO]', '[Music]', '(upbeat music)', '*silence*', '♪ ♪', '[ Silence ]']) {
    assert.equal(extractSpeech(seg('00', '05', marker)), '', marker);
  }
});

test('extractSpeech drops whole-segment filler hallucinations', () => {
  for (const filler of ['Thank you.', 'you', 'Thanks for watching!', 'Bye.', 'Thank you. [BLANK_AUDIO]']) {
    assert.equal(extractSpeech(seg('00', '05', filler)), '', filler);
  }
});

test('extractSpeech keeps filler words inside real speech', () => {
  assert.equal(
    extractSpeech(seg('00', '05', 'So, thank you for coming [laughs] today.')),
    'So, thank you for coming today.'
  );
});
