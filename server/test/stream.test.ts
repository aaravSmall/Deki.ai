import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relayOllamaStream, type StreamEvent } from '../app/stream';
import { ndjson, streamOf } from './helpers';

async function relay(pieces: string[], isAborted?: () => boolean) {
  const events: StreamEvent[] = [];
  await relayOllamaStream(streamOf(pieces), 'm', (e) => events.push(e), isAborted);
  return events;
}

test('forwards text chunks and ends with done', async () => {
  const events = await relay([ndjson({ response: 'Hel' }, { response: 'lo' }, { response: '', done: true })]);
  assert.deepEqual(events, [
    { type: 'chunk', text: 'Hel' },
    { type: 'chunk', text: 'lo' },
    { type: 'done', model: 'm' },
  ]);
});

test('reassembles lines split across network chunks', async () => {
  const line = ndjson({ response: 'split across reads' });
  const events = await relay([line.slice(0, 7), line.slice(7), ndjson({ done: true })]);
  assert.deepEqual(events, [
    { type: 'chunk', text: 'split across reads' },
    { type: 'done', model: 'm' },
  ]);
});

test('handles a final line with no trailing newline', async () => {
  const events = await relay([ndjson({ response: 'a' }) + JSON.stringify({ done: true })]);
  assert.deepEqual(events.at(-1), { type: 'done', model: 'm' });
});

test('reports an Ollama error line as an error event', async () => {
  const events = await relay([ndjson({ response: 'partial' }, { error: 'model unloaded' })]);
  assert.deepEqual(events, [
    { type: 'chunk', text: 'partial' },
    { type: 'error', message: 'Ollama error: model unloaded' },
  ]);
});

test('reports a malformed line as an error event', async () => {
  const events = await relay(['not json\n']);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'error');
  assert.match((events[0] as { message: string }).message, /Malformed line/);
});

test('reports a stream that ends without done as cut off', async () => {
  const events = await relay([ndjson({ response: 'trailing off' })]);
  assert.deepEqual(events.at(-1), {
    type: 'error',
    message: 'Ollama stream from "m" ended before the response finished',
  });
});

test('stays quiet about errors once the client has gone', async () => {
  const events = await relay([ndjson({ error: 'boom' })], () => true);
  assert.deepEqual(events, []);
});
