// Minimal local-only Express server. Receives screen + transcript context
// from the Electron overlay and forwards it to a local Ollama instance for
// inference. No cloud APIs, no API keys - Ollama running on localhost is the
// only external dependency.

import express, { Request, Response } from 'express';

const app = express();
app.use(express.json({ limit: '15mb' })); // screenshots are base64 PNGs, can be a few MB

const PORT = process.env.PORT ? Number(process.env.PORT) : 3232;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'llama3';
const FALLBACK_MODEL = process.env.OLLAMA_FALLBACK_MODEL || 'mistral';

interface AnalyzeRequestBody {
  screenshot?: string;
  transcript?: string;
  question?: string;
  stream?: boolean;
}

interface OllamaGenerateChunk {
  response?: string;
  done?: boolean;
}

function buildPrompt(transcript: string, question?: string): string {
  const parts = [
    'You are a real-time assistant. Based on this screen context and conversation transcript, provide a concise, helpful response.',
    '',
    `Conversation transcript (most recent ~500 words):\n${transcript || '(no transcript yet)'}`,
  ];

  if (question) {
    parts.push('', `User question: ${question}`);
  }

  return parts.join('\n');
}

async function callOllama(model: string, prompt: string, images: string[] | undefined, stream: boolean) {
  return fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, images, stream }),
  });
}

async function callOllamaWithFallback(prompt: string, images: string[] | undefined, stream: boolean) {
  try {
    const response = await callOllama(DEFAULT_MODEL, prompt, images, stream);
    if (!response.ok) throw new Error(`status ${response.status}`);
    return { response, modelUsed: DEFAULT_MODEL };
  } catch (err) {
    console.warn(
      `[server] primary model "${DEFAULT_MODEL}" failed (${(err as Error).message}), falling back to "${FALLBACK_MODEL}"`
    );
    try {
      const response = await callOllama(FALLBACK_MODEL, prompt, images, stream);
      if (!response.ok) throw new Error(`status ${response.status}`);
      return { response, modelUsed: FALLBACK_MODEL };
    } catch (fallbackErr) {
      console.error(`[server] fallback model "${FALLBACK_MODEL}" also failed:`, (fallbackErr as Error).message);
      return null;
    }
  }
}

app.post('/api/cluely/analyze', async (req: Request<{}, {}, AnalyzeRequestBody>, res: Response) => {
  const { screenshot, transcript = '', question, stream } = req.body;
  const useStreaming = stream !== false;

  const prompt = buildPrompt(transcript, question);

  // `images` only has an effect with a vision-capable Ollama model (e.g.
  // llava, llama3.2-vision). Plain llama3/mistral are text-only and will
  // silently ignore this field - see README for notes on swapping in a
  // vision model if screen content itself needs to be "seen".
  const images = screenshot ? [screenshot] : undefined;

  const result = await callOllamaWithFallback(prompt, images, useStreaming);

  if (!result) {
    res.status(502).json({ error: 'Ollama unreachable on both primary and fallback models' });
    return;
  }

  const { response: ollamaResponse, modelUsed } = result;
  res.setHeader('X-Model-Used', modelUsed);

  if (!useStreaming) {
    const data = (await ollamaResponse.json()) as OllamaGenerateChunk;
    res.json({ response: data.response || '', model: modelUsed });
    return;
  }

  if (!ollamaResponse.body) {
    res.status(502).json({ error: 'Ollama returned no response body' });
    return;
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  const reader = ollamaResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as OllamaGenerateChunk;
        if (parsed.response) res.write(parsed.response);
      }
    }
    res.end();
  } catch (err) {
    console.error('[server] streaming error:', err);
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] forwarding to Ollama at ${OLLAMA_URL} (model=${DEFAULT_MODEL}, fallback=${FALLBACK_MODEL})`);
});
