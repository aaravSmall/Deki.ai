// Test helpers: a scriptable stand-in for Ollama's HTTP API, and a way to run
// the Express app on an ephemeral port.

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';
import type { ServerConfig } from '../app/config';
import type { FetchLike } from '../app/ollama';

export const testConfig: ServerConfig = {
  port: 0,
  ollamaUrl: 'http://ollama.test',
  visionModel: 'vision-model',
  textModel: 'primary-model',
  textFallbackModel: 'fallback-model',
};

export interface OllamaCall {
  url: string;
  body: { model: string; prompt: string; images?: string[]; stream: boolean };
}

// Builds a streaming body out of raw string pieces, so tests control exactly
// where line breaks fall between network chunks.
export function streamOf(pieces: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
}

export function ndjson(...objects: object[]): string {
  return objects.map((o) => JSON.stringify(o) + '\n').join('');
}

type Handler = (call: OllamaCall) => Response | Promise<Response>;

// Routes each request by model name; records every call for assertions.
export function fakeOllama(handlers: Record<string, Handler>) {
  const calls: OllamaCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as OllamaCall['body'];
      const call = { url, body };
      calls.push(call);
      const handler = handlers[body.model];
      if (!handler) return new Response(`model "${body.model}" not found`, { status: 404 });
      return handler(call);
    }
    const handler = handlers[`GET ${new URL(url).pathname}`];
    if (!handler) return new Response('not found', { status: 404 });
    return handler({ url, body: { model: '', prompt: '', stream: false } });
  }) as FetchLike;
  return { fetchImpl, calls };
}

export async function listen(app: Express): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export async function readEvents(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
