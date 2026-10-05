// Electron main process: overlay window, global shortcuts, screenshot capture loop,
// local mic-chunk transcription (whisper.cpp via nodejs-whisper), and the backend fetch/stream.
//
// NOTE: This overlay intentionally does NOT call setContentProtection() or any
// capture-exclusion API. It behaves like a normal window and stays visible in
// screen shares/recordings (Zoom, Meet, etc.) - see README for why.

const { app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const util = require('util');

const execFileAsync = util.promisify(execFile);

const BACKEND_URL = process.env.CLUELY_BACKEND_URL || 'http://localhost:3232';
const CAPTURE_INTERVAL_MS = 3000;
const TRANSCRIPT_WORD_LIMIT = 500;
const WHISPER_MODEL = process.env.WHISPER_MODEL_NAME || 'base.en';

let overlayWindow = null;
let captureTimer = null;
let transcriptWords = [];

// --- rolling transcript buffer (capped at last ~500 words) ---

function appendTranscript(text) {
  if (!text) return;
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return;
  transcriptWords.push(...words);
  if (transcriptWords.length > TRANSCRIPT_WORD_LIMIT) {
    transcriptWords = transcriptWords.slice(transcriptWords.length - TRANSCRIPT_WORD_LIMIT);
  }
}

function getTranscriptText() {
  return transcriptWords.join(' ');
}

// --- overlay window ---

function createOverlayWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width } = primaryDisplay.workAreaSize;

  overlayWindow = new BrowserWindow({
    width: 420,
    height: 340,
    x: width - 440,
    y: 40,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

function toggleOverlay() {
  if (!overlayWindow) return;
  if (overlayWindow.isVisible()) {
    overlayWindow.hide();
  } else {
    overlayWindow.show();
  }
}

// --- screenshot capture ---

async function captureScreenshotBase64() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.size;

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
  });

  const primarySource = sources[0];
  if (!primarySource || primarySource.thumbnail.isEmpty()) return null;

  return primarySource.thumbnail.toPNG().toString('base64');
}

// --- analysis cycle: screenshot + transcript -> backend -> stream to renderer ---

// The cycle currently running, if any: { abort: AbortController, done: Promise }.
// Automatic ticks skip if something is already running; a typed question
// cancels whatever is running (the backend aborts its Ollama call when the
// request is dropped) and then runs, so a question is never silently lost.
let currentCycle = null;

async function runAnalysisCycle(manualQuestion) {
  if (!overlayWindow) return;

  if (currentCycle) {
    if (!manualQuestion) return; // auto tick: let the running cycle finish
    currentCycle.abort.abort();
    await currentCycle.done.catch(() => {});
    // Another question may have claimed the slot while we waited; newest wins.
    if (currentCycle) {
      currentCycle.abort.abort();
      await currentCycle.done.catch(() => {});
    }
  }

  const abort = new AbortController();
  const done = runAnalysisCycleInner(manualQuestion, abort.signal);
  const cycle = { abort, done };
  currentCycle = cycle;
  try {
    await done;
  } finally {
    if (currentCycle === cycle) currentCycle = null;
  }
}

async function runAnalysisCycleInner(manualQuestion, signal) {
  let screenshot;
  try {
    screenshot = await captureScreenshotBase64();
  } catch (err) {
    overlayWindow.webContents.send('ai:error', `Screenshot capture failed: ${err.message || err}`);
    return;
  }

  const transcript = getTranscriptText();

  overlayWindow.webContents.send('ai:chunk-start');

  try {
    const response = await fetch(`${BACKEND_URL}/api/cluely/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        screenshot,
        transcript,
        question: manualQuestion || undefined,
      }),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Backend responded with ${response.status}: ${errText}`);
    }

    if (!response.body) {
      // Non-streaming fallback: whole response arrives as one JSON payload.
      const data = await response.json();
      overlayWindow.webContents.send('ai:chunk', data.response || '');
      overlayWindow.webContents.send('ai:done');
      return;
    }

    // Backend streams NDJSON events: {type:'chunk'|'error'|'done', ...}.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;

    const handleEvent = (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new Error(`Malformed stream line from backend: ${line.slice(0, 200)}`);
      }
      if (event.type === 'chunk' && event.text) {
        overlayWindow.webContents.send('ai:chunk', event.text);
      } else if (event.type === 'error') {
        finished = true;
        throw new Error(event.message || 'Backend reported an error mid-stream');
      } else if (event.type === 'done') {
        finished = true;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) handleEvent(line);
    }
    handleEvent(buffer + decoder.decode());

    if (!finished) {
      throw new Error('Connection to backend closed before the response finished');
    }

    overlayWindow.webContents.send('ai:done');
  } catch (err) {
    if (signal.aborted) return; // superseded by a newer question - not an error
    overlayWindow.webContents.send('ai:error', err.message || String(err));
  }
}

function startCaptureLoop() {
  if (captureTimer) return;
  captureTimer = setInterval(() => {
    runAnalysisCycle();
  }, CAPTURE_INTERVAL_MS);
}

function stopCaptureLoop() {
  if (captureTimer) {
    clearInterval(captureTimer);
    captureTimer = null;
  }
}

// --- global shortcuts ---

function registerShortcuts() {
  const toggleOk = globalShortcut.register('CommandOrControl+Shift+Space', toggleOverlay);
  const forceOk = globalShortcut.register('CommandOrControl+Shift+R', () => {
    runAnalysisCycle();
  });

  if (!toggleOk) console.warn('[overlay] Failed to register toggle shortcut (Ctrl/Cmd+Shift+Space)');
  if (!forceOk) console.warn('[overlay] Failed to register force-capture shortcut (Ctrl/Cmd+Shift+R)');
}

// --- system audio -> local whisper.cpp transcription ---
//
// Renderer records system audio (via a BlackHole virtual input device, not
// the microphone - see README) with MediaRecorder (webm/opus) and ships each
// ~5s chunk over IPC as an ArrayBuffer. We convert it to 16kHz mono WAV with
// ffmpeg (required on PATH - see README) and hand it to nodejs-whisper, which
// shells out to a locally-built whisper.cpp binary. Nothing here calls out
// to any cloud API.

let nodewhisper = null;
try {
  ({ nodewhisper } = require('nodejs-whisper'));
} catch (err) {
  console.warn('[overlay] nodejs-whisper not installed yet - run `npm install` in /overlay.');
}

async function convertToWav16kMono(inputPath, outputPath) {
  await execFileAsync('ffmpeg', [
    '-y',
    '-loglevel', 'error',
    '-i', inputPath,
    '-ar', '16000',
    '-ac', '1',
    '-c:a', 'pcm_s16le',
    outputPath,
  ]);
}

async function transcribeAudioChunk(arrayBuffer) {
  if (!nodewhisper) return;

  const stamp = Date.now();
  const rawPath = path.join(os.tmpdir(), `overlay-audio-${stamp}.webm`);
  const wavPath = path.join(os.tmpdir(), `overlay-audio-${stamp}.wav`);

  fs.writeFileSync(rawPath, Buffer.from(arrayBuffer));

  try {
    await convertToWav16kMono(rawPath, wavPath);

    const text = await nodewhisper(wavPath, {
      modelName: WHISPER_MODEL,
      autoDownloadModelName: WHISPER_MODEL,
      removeWavFileAfterTranscription: true,
      whisperOptions: {
        outputInText: true,
        language: 'auto',
      },
    });

    appendTranscript(text);
  } catch (err) {
    console.error('[overlay] transcription failed:', err.message || err);
  } finally {
    fs.rm(rawPath, { force: true }, () => {});
    fs.rm(wavPath, { force: true }, () => {});
  }
}

ipcMain.on('audio:chunk', (_event, arrayBuffer) => {
  transcribeAudioChunk(arrayBuffer);
});

ipcMain.handle('manual:ask', async (_event, question) => {
  // Restart the auto-capture timer around the manual ask so the next
  // automatic tick doesn't immediately clobber the answer on screen.
  stopCaptureLoop();
  await runAnalysisCycle(question);
  startCaptureLoop();
});

ipcMain.on('app:quit', () => {
  app.quit();
});

// --- app lifecycle ---

app.whenReady().then(() => {
  createOverlayWindow();
  registerShortcuts();
  startCaptureLoop();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopCaptureLoop();
});

app.on('window-all-closed', () => {
  app.quit();
});
