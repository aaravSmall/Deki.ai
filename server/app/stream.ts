// Relays Ollama's NDJSON generate stream to the overlay as our own NDJSON
// events.
//
// A plain-text stream can't tell the client *why* it stopped, so errors that
// happen after streaming has started (Ollama crash, model unloaded, bad line)
// are sent as an explicit `error` event, and a clean finish ends with `done`.
// A stream that ends without either means the connection was cut.

import type { OllamaGenerateChunk } from './ollama';

export type StreamEvent =
  | { type: 'chunk'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done'; model: string };

// Reads the whole Ollama stream, calling `send` for each event. Always ends
// with exactly one `done` or `error` event unless `isAborted()` turns true,
// in which case it stops quietly (the client is gone).
export async function relayOllamaStream(
  body: ReadableStream<Uint8Array>,
  modelUsed: string,
  send: (event: StreamEvent) => void,
  isAborted: () => boolean = () => false
): Promise<void> {
  const reader = body.getReader();
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
    if (isAborted()) return;
    const message = (err as Error).message || String(err);
    console.error('[server] streaming error:', message);
    send({ type: 'error', message });
  }
}
