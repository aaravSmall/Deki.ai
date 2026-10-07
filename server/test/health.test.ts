import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app/app';
import { isModelInstalled } from '../app/health';
import { fakeOllama, listen, testConfig } from './helpers';

const tags = (...names: string[]) => () => Response.json({ models: names.map((name) => ({ name })) });

async function getHealth(handlers: Parameters<typeof fakeOllama>[0]) {
  const server = await listen(createApp(testConfig, fakeOllama(handlers).fetchImpl));
  try {
    const response = await fetch(`${server.baseUrl}/health`);
    return { status: response.status, body: await response.json() };
  } finally {
    await server.close();
  }
}

test('isModelInstalled treats an untagged name as :latest', () => {
  assert.equal(isModelInstalled('llama3', ['llama3:latest']), true);
  assert.equal(isModelInstalled('llama3', ['llama3:70b']), false);
  assert.equal(isModelInstalled('llama3:70b', ['llama3:70b']), true);
  assert.equal(isModelInstalled('mistral', ['llama3:latest']), false);
});

test('200 when Ollama is up and the models are pulled', async () => {
  const { status, body } = await getHealth({
    'GET /api/tags': tags('vision-model:latest', 'primary-model:latest'),
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.models.fallback.installed, false, 'fallback is optional');
});

test('503 naming the missing model', async () => {
  const { status, body } = await getHealth({ 'GET /api/tags': tags('primary-model:latest') });
  assert.equal(status, 503);
  assert.equal(body.ok, false);
  assert.deepEqual(body.models.vision, { name: 'vision-model', installed: false });
});

test('503 when Ollama is unreachable', async () => {
  const { status, body } = await getHealth({});
  assert.equal(status, 503);
  assert.equal(body.ollama.reachable, false);
  assert.match(body.ollama.error, /404/);
});
