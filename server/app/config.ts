// Runtime settings, read once from the environment.

export interface ServerConfig {
  port: number;
  ollamaUrl: string;
  visionModel: string;
  textModel: string;
  textFallbackModel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: env.PORT ? Number(env.PORT) : 3232,
    ollamaUrl: env.OLLAMA_URL || 'http://localhost:11434',
    // Two-stage pipeline: a small vision model captions the screenshot in
    // plain text, then a text-only instruct model reasons over that caption +
    // the transcript + question. Small vision models like moondream are tuned
    // for short direct captioning prompts and produce empty/garbled output when
    // given the verbose instructional prompt a "helpful assistant" response
    // needs - so that reasoning is left entirely to the text model instead.
    visionModel: env.OLLAMA_VISION_MODEL || 'moondream',
    textModel: env.OLLAMA_MODEL || 'llama3',
    textFallbackModel: env.OLLAMA_FALLBACK_MODEL || 'mistral',
  };
}
