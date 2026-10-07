// Express app: receives screen + transcript context from the Electron
// overlay and forwards it to a local Ollama instance for inference. Built by
// a factory (no listen) so tests can run it against a fake Ollama.

import express, { Request, Response } from 'express';
import type { ServerConfig } from './config';
import { buildPrompt, OllamaClient, type FetchLike, type OllamaGenerateChunk } from './ollama';
import { relayOllamaStream, type StreamEvent } from './stream';

interface AnalyzeRequestBody {
  screenshot?: string;
  transcript?: string;
  question?: string;
  stream?: boolean;
}

export function createApp(config: ServerConfig, fetchImpl: FetchLike = fetch) {
  const app = express();
  app.use(express.json({ limit: '15mb' })); // screenshots are base64 PNGs, can be a few MB

  const ollama = new OllamaClient(config, fetchImpl);

  app.post('/api/analyze', async (req: Request<{}, {}, AnalyzeRequestBody>, res: Response) => {
    const { screenshot, transcript = '', question, stream } = req.body;
    const useStreaming = stream !== false;

    // If the overlay abandons this request (e.g. a typed question interrupts
    // an automatic cycle), stop the Ollama work too instead of letting it
    // finish generating an answer nobody will see.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });

    const screenDescription = screenshot ? await ollama.captionScreenshot(screenshot, abort.signal) : null;
    if (abort.signal.aborted) return;
    const prompt = buildPrompt(transcript, question, screenDescription);

    const result = await ollama.generateWithFallback(prompt, useStreaming, abort.signal);
    if (abort.signal.aborted) return;

    if (!result) {
      res.status(502).json({ error: 'Ollama unreachable on both primary and fallback models' });
      return;
    }

    const { response: ollamaResponse, modelUsed } = result;
    res.setHeader('X-Model-Used', modelUsed);

    if (!useStreaming) {
      const data = (await ollamaResponse.json()) as OllamaGenerateChunk;
      if (data.error) {
        res.status(502).json({ error: data.error, model: modelUsed });
        return;
      }
      res.json({ response: data.response || '', model: modelUsed });
      return;
    }

    if (!ollamaResponse.body) {
      res.status(502).json({ error: 'Ollama returned no response body' });
      return;
    }

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    const send = (event: StreamEvent) => res.write(JSON.stringify(event) + '\n');
    try {
      await relayOllamaStream(ollamaResponse.body, modelUsed, send, () => abort.signal.aborted);
    } finally {
      res.end();
    }
  });

  return app;
}
