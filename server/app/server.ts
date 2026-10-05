// Minimal local-only Express server. Receives screen + transcript context
// from the Electron overlay and forwards it to a local Ollama instance for
// inference. No cloud APIs, no API keys - Ollama running on localhost is the
// only external dependency.

import express, { Request, Response } from 'express';

const app = express();
app.use(express.json({ limit: '15mb' })); // screenshots are base64 PNGs, can be a few MB

const PORT = process.env.PORT ? Number(process.env.PORT) : 3232;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

// Two-stage pipeline: a small vision model captions the screenshot in plain
// text, then a text-only instruct model reasons over that caption + the
// transcript + question. Small vision models like moondream are tuned for
// short direct captioning prompts and produce empty/garbled output when
// given the verbose instructional prompt a "helpful assistant" response
// needs - so that reasoning is left entirely to the text model instead.
const VISION_MODEL = process.env.OLLAMA_VISION_MODEL || 'moondream';
const TEXT_MODEL = process.env.OLLAMA_MODEL || 'llama3';
const TEXT_FALLBACK_MODEL = process.env.OLLAMA_FALLBACK_MODEL || 'mistral';

interface AnalyzeRequestBody {
  screenshot?: string;
  transcript?: string;
  question?: string;
  stream?: boolean;
}

interface OllamaGenerateChunk {
  response?: string;
  done?: boolean;
  error?: string;
}

// Events streamed back to the overlay, one JSON object per line (NDJSON).
// A plain-text stream can't tell the client *why* it stopped, so errors that
// happen after streaming has started (Ollama crash, model unloaded, bad line)
// are sent as an explicit `error` event, and a clean finish ends with `done`.
// A stream that ends without either means the connection was cut.
type StreamEvent =
  | { type: 'chunk'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done'; model: string };

async function callOllama(
  model: string,
  prompt: string,
  images: string[] | undefined,
  stream: boolean,
  signal?: AbortSignal
) {
  return fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, images, stream }),
    signal,
  });
}

// Captions the screenshot with a short, direct prompt (best-effort). Returns
// null on any failure - the caller falls back to reasoning without screen
// context rather than failing the whole request.
async function captionScreenshot(screenshot: string, signal: AbortSignal): Promise<string | null> {
  try {
    const response = await callOllama(
      VISION_MODEL,
      'Describe what is currently shown on the screen in detail.',
      [screenshot],
      false,
      signal
    );
    if (!response.ok) {
      console.warn(`[server] vision model "${VISION_MODEL}" failed to caption screenshot: status ${response.status}`);
      return null;
    }
    const data = (await response.json()) as OllamaGenerateChunk;
    return data.response?.trim() || null;
  } catch (err) {
    if (signal.aborted) return null;
    console.warn(`[server] vision model "${VISION_MODEL}" unreachable:`, (err as Error).message);
    return null;
  }
}

function buildPrompt(transcript: string, question: string | undefined, screenDescription: string | null): string {
  const parts = [
    'You are a real-time assistant. Based on the screen content, conversation transcript, and question below, provide a concise, helpful response.',
    '',
    `Screen content: ${screenDescription || '(no screen context available)'}`,
    '',
    `Conversation transcript (most recent ~500 words):\n${transcript || '(no transcript yet)'}`,
  ];

  if (question) {
    parts.push('', `User question: ${question}`);
  }

  return parts.join('\n');
}

async function tryTextModel(model: string, prompt: string, stream: boolean, signal: AbortSignal) {
  const response = await callOllama(model, prompt, undefined, stream, signal);
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`status ${response.status}: ${errBody}`);
  }
  return response;
}

async function callTextModelWithFallback(prompt: string, stream: boolean, signal: AbortSignal) {
  try {
    const response = await tryTextModel(TEXT_MODEL, prompt, stream, signal);
    return { response, modelUsed: TEXT_MODEL };
  } catch (err) {
    if (signal.aborted) return null;
    console.warn(
      `[server] primary model "${TEXT_MODEL}" failed (${(err as Error).message}), falling back to "${TEXT_FALLBACK_MODEL}"`
    );
    try {
      const response = await tryTextModel(TEXT_FALLBACK_MODEL, prompt, stream, signal);
      return { response, modelUsed: TEXT_FALLBACK_MODEL };
    } catch (fallbackErr) {
      console.error(`[server] fallback model "${TEXT_FALLBACK_MODEL}" also failed:`, (fallbackErr as Error).message);
      return null;
    }
  }
}

app.post('/api/analyze', async (req: Request<{}, {}, AnalyzeRequestBody>, res: Response) => {
  const { screenshot, transcript = '', question, stream } = req.body;
  const useStreaming = stream !== false;

  // If the overlay abandons this request (e.g. a typed question interrupts an
  // automatic cycle), stop the Ollama work too instead of letting it finish
  // generating an answer nobody will see.
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });

  const screenDescription = screenshot ? await captionScreenshot(screenshot, abort.signal) : null;
  if (abort.signal.aborted) return;
  const prompt = buildPrompt(transcript, question, screenDescription);

  const result = await callTextModelWithFallback(prompt, useStreaming, abort.signal);
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

  const reader = ollamaResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawDone = false;

  // Parses one Ollama NDJSON line. Returns an error message if the line
  // reports (or is) a failure, otherwise forwards its text.
  const handleLine = (line: string): string | null => {
    if (!line.trim()) return null;
    let parsed: OllamaGenerateChunk;
    try {
      parsed = JSON.parse(line) as OllamaGenerateChunk;
    } catch {
      return `Malformed line from Ollama: ${line.slice(0, 200)}`;
    }
    if (parsed.error) return `Ollama error: ${parsed.error}`;
    if (parsed.response) send({ type: 'chunk', text: parsed.response });
    if (parsed.done) sawDone = true;
    return null;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const error = handleLine(line);
        if (error) throw new Error(error);
      }
    }
    const tailError = handleLine(buffer + decoder.decode());
    if (tailError) throw new Error(tailError);

    if (!sawDone) throw new Error(`Ollama stream from "${modelUsed}" ended before the response finished`);
    send({ type: 'done', model: modelUsed });
  } catch (err) {
    if (abort.signal.aborted) return;
    const message = (err as Error).message || String(err);
    console.error('[server] streaming error:', message);
    send({ type: 'error', message });
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(
    `[server] forwarding to Ollama at ${OLLAMA_URL} (vision=${VISION_MODEL}, text=${TEXT_MODEL}, fallback=${TEXT_FALLBACK_MODEL})`
  );
});
