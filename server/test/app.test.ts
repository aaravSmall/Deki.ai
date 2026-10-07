import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app/app';
import { fakeOllama, listen, ndjson, readEvents, streamOf, testConfig } from './helpers';

const streamed = (...objects: object[]) => () => new Response(streamOf([ndjson(...objects)]));

async function analyze(handlers: Parameters<typeof fakeOllama>[0], body: object) {
  const ollama = fakeOllama(handlers);
  const server = await listen(createApp(testConfig, ollama.fetchImpl));
  try {
    const response = await fetch(`${server.baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { response, calls: ollama.calls, close: server.close };
  } catch (err) {
    await server.close();
    throw err;
  }
}

test('captions the screenshot, then streams the text model answer', async () => {
  const { response, calls, close } = await analyze(
    {
      'vision-model': () => Response.json({ response: 'A code editor showing binary search.' }),
      'primary-model': streamed({ response: 'It is ' }, { response: 'binary search.', done: true }),
    },
    { screenshot: 'aGVsbG8=', transcript: 'what is this', question: 'explain' }
  );
  try {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-model-used'), 'primary-model');
    assert.deepEqual(await readEvents(response), [
      { type: 'chunk', text: 'It is ' },
      { type: 'chunk', text: 'binary search.' },
      { type: 'done', model: 'primary-model' },
    ]);

    const [vision, text] = calls;
    assert.deepEqual(vision.body.images, ['aGVsbG8=']);
    assert.equal(text.body.images, undefined, 'images must never reach the text model');
    assert.match(text.body.prompt, /Screen content: A code editor showing binary search\./);
    assert.match(text.body.prompt, /what is this/);
    assert.match(text.body.prompt, /User question: explain/);
  } finally {
    await close();
  }
});

test('falls back to the second text model when the first fails', async () => {
  const { response, close } = await analyze(
    { 'fallback-model': streamed({ response: 'from fallback', done: true }) },
    { transcript: 'hi' }
  );
  try {
    assert.equal(response.headers.get('x-model-used'), 'fallback-model');
    const events = await readEvents(response);
    assert.deepEqual(events.at(-1), { type: 'done', model: 'fallback-model' });
  } finally {
    await close();
  }
});

test('answers without screen context when captioning fails', async () => {
  const { response, calls, close } = await analyze(
    {
      'vision-model': () => new Response('boom', { status: 500 }),
      'primary-model': streamed({ response: 'ok', done: true }),
    },
    { screenshot: 'aGVsbG8=' }
  );
  try {
    assert.equal(response.status, 200);
    await readEvents(response);
    assert.match(calls[1].body.prompt, /Screen content: \(no screen context available\)/);
  } finally {
    await close();
  }
});

test('returns 502 when both text models fail', async () => {
  const { response, close } = await analyze({}, { transcript: 'hi' });
  try {
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /both primary and fallback/);
  } finally {
    await close();
  }
});

test('sends one JSON payload when stream is false', async () => {
  const { response, calls, close } = await analyze(
    { 'primary-model': () => Response.json({ response: 'whole answer', done: true }) },
    { transcript: 'hi', stream: false }
  );
  try {
    assert.deepEqual(await response.json(), { response: 'whole answer', model: 'primary-model' });
    assert.equal(calls[0].body.stream, false);
  } finally {
    await close();
  }
});
