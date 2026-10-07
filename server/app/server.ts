// Entry point: minimal local-only server bridging the overlay to a local
// Ollama instance. No cloud APIs, no API keys - Ollama running on localhost
// is the only external dependency.

import { createApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();

createApp(config).listen(config.port, () => {
  console.log(`[server] listening on http://localhost:${config.port}`);
  console.log(
    `[server] forwarding to Ollama at ${config.ollamaUrl} (vision=${config.visionModel}, text=${config.textModel}, fallback=${config.textFallbackModel})`
  );
});
