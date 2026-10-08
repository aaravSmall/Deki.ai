const { test } = require('node:test');
const assert = require('node:assert/strict');
const { describeHealth } = require('../lib/health');

const backendUrl = 'http://localhost:3232';
const model = (name, installed) => ({ name, installed });
const report = (overrides = {}) => ({
  ok: false,
  ollama: { url: 'http://localhost:11434', reachable: true },
  models: { vision: model('moondream', true), text: model('llama3', true), fallback: model('mistral', false) },
  ...overrides,
});

test('healthy backend produces no message', () => {
  assert.equal(describeHealth({ backendUrl, status: 200, report: { ...report(), ok: true } }), null);
});

test('backend down tells you how to start it', () => {
  assert.match(describeHealth({ backendUrl, error: new Error('ECONNREFUSED') }), /npm run dev/);
});

test('Ollama down tells you to run ollama serve', () => {
  const message = describeHealth({
    backendUrl,
    status: 503,
    report: report({ ollama: { url: 'http://localhost:11434', reachable: false } }),
  });
  assert.match(message, /ollama serve/);
});

test('missing models are named with the pull command', () => {
  const message = describeHealth({
    backendUrl,
    status: 503,
    report: report({
      models: { vision: model('moondream', false), text: model('llama3', false), fallback: model('mistral', false) },
    }),
  });
  assert.equal(message, 'Missing Ollama models. Run: ollama pull moondream && ollama pull llama3');
});

test('a non-JSON /health answer is reported with its status', () => {
  assert.match(describeHealth({ backendUrl, status: 404, report: null }), /status 404/);
});
