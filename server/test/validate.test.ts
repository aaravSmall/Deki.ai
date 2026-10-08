import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, validateAnalyzeBody } from '../app/validate';

const errorOf = (body: unknown) => {
  const result = validateAnalyzeBody(body);
  assert.equal(result.ok, false);
  return (result as { error: string }).error;
};

test('accepts a normal overlay request and fills defaults', () => {
  assert.deepEqual(validateAnalyzeBody({ screenshot: 'aGVsbG8=', transcript: 'hi', question: '  why?  ' }), {
    ok: true,
    value: { screenshot: 'aGVsbG8=', transcript: 'hi', question: 'why?', stream: true },
  });
});

test('treats null fields as absent', () => {
  const result = validateAnalyzeBody({ screenshot: null, transcript: 'hi', question: null });
  assert.equal(result.ok, true);
});

test('rejects non-object bodies', () => {
  for (const body of [null, 'text', [1, 2], 42]) {
    assert.match(errorOf(body), /JSON object/);
  }
});

test('rejects wrongly typed fields', () => {
  assert.match(errorOf({ transcript: 5 }), /"transcript" must be a string/);
  assert.match(errorOf({ question: ['a'] }), /"question" must be a string/);
  assert.match(errorOf({ transcript: 'hi', stream: 'yes' }), /"stream" must be a boolean/);
});

test('rejects screenshots that are not plain base64', () => {
  assert.match(errorOf({ screenshot: 'data:image/png;base64,aGVsbG8=' }), /base64/);
  assert.match(errorOf({ screenshot: 'aGVsbG8' }), /base64/);
});

test('enforces length limits', () => {
  assert.match(errorOf({ transcript: 'a'.repeat(LIMITS.transcriptChars + 1) }), /at most/);
  assert.match(errorOf({ question: 'a'.repeat(LIMITS.questionChars + 1) }), /at most/);
});

test('rejects a request with nothing to analyze', () => {
  assert.match(errorOf({}), /Nothing to analyze/);
  assert.match(errorOf({ transcript: '   ', question: ' ' }), /Nothing to analyze/);
});
