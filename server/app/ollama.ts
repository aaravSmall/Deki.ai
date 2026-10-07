// Thin client for the parts of the Ollama HTTP API the server uses, plus the
// caption -> reasoning pipeline built on it. `fetch` is injectable so tests
// can stand in for Ollama.

import type { ServerConfig } from './config';

export type FetchLike = typeof fetch;

export interface OllamaGenerateChunk {
  response?: string;
  done?: boolean;
  error?: string;
}

export class OllamaClient {
  constructor(
    private readonly config: ServerConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  generate(model: string, prompt: string, images: string[] | undefined, stream: boolean, signal?: AbortSignal) {
    return this.fetchImpl(`${this.config.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, images, stream }),
      signal,
    });
  }

  // Captions the screenshot with a short, direct prompt (best-effort). Returns
  // null on any failure - the caller falls back to reasoning without screen
  // context rather than failing the whole request.
  async captionScreenshot(screenshot: string, signal: AbortSignal): Promise<string | null> {
    const { visionModel } = this.config;
    try {
      const response = await this.generate(
        visionModel,
        'Describe what is currently shown on the screen in detail.',
        [screenshot],
        false,
        signal
      );
      if (!response.ok) {
        console.warn(`[server] vision model "${visionModel}" failed to caption screenshot: status ${response.status}`);
        return null;
      }
      const data = (await response.json()) as OllamaGenerateChunk;
      return data.response?.trim() || null;
    } catch (err) {
      if (signal.aborted) return null;
      console.warn(`[server] vision model "${visionModel}" unreachable:`, (err as Error).message);
      return null;
    }
  }

  private async tryTextModel(model: string, prompt: string, stream: boolean, signal: AbortSignal) {
    const response = await this.generate(model, prompt, undefined, stream, signal);
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`status ${response.status}: ${errBody}`);
    }
    return response;
  }

  // Images are never sent here: plain instruct models like llama3/mistral
  // reject multimodal input outright (HTTP 400) rather than ignoring it.
  async generateWithFallback(prompt: string, stream: boolean, signal: AbortSignal) {
    const { textModel, textFallbackModel } = this.config;
    try {
      const response = await this.tryTextModel(textModel, prompt, stream, signal);
      return { response, modelUsed: textModel };
    } catch (err) {
      if (signal.aborted) return null;
      console.warn(
        `[server] primary model "${textModel}" failed (${(err as Error).message}), falling back to "${textFallbackModel}"`
      );
      try {
        const response = await this.tryTextModel(textFallbackModel, prompt, stream, signal);
        return { response, modelUsed: textFallbackModel };
      } catch (fallbackErr) {
        console.error(`[server] fallback model "${textFallbackModel}" also failed:`, (fallbackErr as Error).message);
        return null;
      }
    }
  }
}

export function buildPrompt(transcript: string, question: string | undefined, screenDescription: string | null): string {
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
