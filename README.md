# Deki.ai — local AI overlay (portfolio demo)

An always-on-top Electron overlay that captures your screen and mic, transcribes
speech locally with whisper.cpp, and streams a response from a local Ollama
model. Everything runs on your machine — no cloud APIs, no API keys.

This is a portfolio/learning project demonstrating screen capture, overlay
windows, local LLM inference, and local speech-to-text. It is **not** built
for use in real interviews or exams: the overlay does not hide itself from
screen shares or recordings — it behaves like any other window, so anyone
viewing a shared screen sees it too.

## Prerequisites

1. **Node.js 18+** (`node --version`)
2. **A C/C++ compiler toolchain**, needed to build `whisper.cpp` locally via `nodejs-whisper`:
   - macOS: Xcode Command Line Tools — `xcode-select --install`
   - Linux: `sudo apt install build-essential`
   - Windows: MSYS2 or MinGW-w64 (make sure `make`/`mingw32-make` is on PATH)
3. **ffmpeg on your PATH** — `nodejs-whisper` shells out to the `ffmpeg` CLI to
   convert recorded mic audio to 16kHz mono WAV before transcription:
   - macOS: `brew install ffmpeg`
   - Linux: `sudo apt install ffmpeg`
   - Windows: install from https://ffmpeg.org/download.html and add to PATH
4. **Ollama**, running locally as the inference engine:
   ```bash
   ollama serve
   ollama pull llama3
   # optional fallback model used if llama3 is unavailable:
   ollama pull mistral
   ```

## 1. Backend

```bash
cd server
npm install
npm run dev
```

Starts an Express + TypeScript server on `http://localhost:3232` (override with
`PORT`). It exposes `POST /api/cluely/analyze`, builds a prompt from the
screenshot + rolling transcript + optional typed question, and forwards it to
Ollama's `/api/generate` at `http://localhost:11434` (override with
`OLLAMA_URL`). Model defaults to `llama3` (`OLLAMA_MODEL`), falling back to
`mistral` (`OLLAMA_FALLBACK_MODEL`) if the primary model call fails. Responses
stream back chunk-by-chunk; set `"stream": false` in the request body for a
single non-streaming JSON response instead.

> **Note on the screenshot:** the base64 screenshot is passed to Ollama via
> the `images` field, which only does anything with a vision-capable model
> (e.g. `llava`, `llama3.2-vision`). Plain `llama3`/`mistral` are text-only
> and will silently ignore the image — the response will be grounded in the
> transcript and typed question only, unless you swap in a vision model via
> `OLLAMA_MODEL`.

## 2. Whisper model download (one-time)

The overlay app depends on `nodejs-whisper`, which bundles whisper.cpp source
and builds a `whisper-cli` binary + downloads a ggml model the first time you
run its downloader:

```bash
cd overlay
npm install
npx nodejs-whisper download
# pick a model (base.en is a good default: fast, English-only)
```

This step is what actually invokes your compiler toolchain (`make`/`cmake`) to
build whisper.cpp — `npm install` alone does not compile anything.

## 3. Overlay app

```bash
cd overlay
npm start
```

- **Ctrl/Cmd+Shift+Space** — show/hide the overlay
- **Ctrl/Cmd+Shift+R** — force an immediate screenshot + analysis cycle
- Otherwise it captures a screenshot every 3s, transcribes mic audio in ~5s
  segments, and sends `{ screenshot, transcript, question? }` to the backend,
  streaming the response into the overlay card as it arrives.

Configure the backend URL and Whisper model via env vars if you change
defaults:

```bash
CLUELY_BACKEND_URL=http://localhost:3232 WHISPER_MODEL_NAME=base.en npm start
```

## Notes

- Local-dev only: no deployment config, no CI/CD, no cloud hosting.
- All inference (LLM + speech-to-text) runs on-device against Ollama and
  whisper.cpp — nothing leaves your machine.
- The overlay does not attempt to hide from screen capture/sharing by design.
