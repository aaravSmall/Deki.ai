// GET /health: is Ollama reachable, and are the configured models pulled?
// Lets the overlay say exactly what's missing instead of failing per request.

import type { ServerConfig } from './config';
import type { FetchLike } from './ollama';

export interface ModelStatus {
  name: string;
  installed: boolean;
}

export interface HealthReport {
  ok: boolean;
  ollama: { url: string; reachable: boolean; error?: string };
  models: { vision: ModelStatus; text: ModelStatus; fallback: ModelStatus };
}

// Ollama lists models as "name:tag"; a configured name with no tag means
// ":latest" (that's what `ollama pull llama3` installs).
export function isModelInstalled(configured: string, installed: string[]): boolean {
  const wanted = configured.includes(':') ? configured : `${configured}:latest`;
  return installed.includes(wanted) || installed.includes(configured);
}

export async function checkHealth(config: ServerConfig, fetchImpl: FetchLike, timeoutMs = 3000): Promise<HealthReport> {
  let installed: string[] = [];
  let reachable = false;
  let error: string | undefined;

  try {
    const response = await fetchImpl(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const data = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
    installed = (data.models || []).map((m) => m.name || m.model || '').filter(Boolean);
    reachable = true;
  } catch (err) {
    error = (err as Error).message || String(err);
  }

  const status = (name: string): ModelStatus => ({ name, installed: isModelInstalled(name, installed) });
  const models = {
    vision: status(config.visionModel),
    text: status(config.textModel),
    fallback: status(config.textFallbackModel),
  };

  // The vision stage is best-effort, but without it every answer lacks screen
  // context, so it counts. Either text model is enough to answer.
  const ok = reachable && models.vision.installed && (models.text.installed || models.fallback.installed);

  return { ok, ollama: { url: config.ollamaUrl, reachable, ...(error ? { error } : {}) }, models };
}
