// Electron main process: overlay window, global shortcuts, screenshot capture loop,
// local mic-chunk transcription (whisper.cpp via nodejs-whisper), and the backend fetch/stream.
//
// NOTE: This overlay intentionally does NOT call setContentProtection() or any
// capture-exclusion API. It behaves like a normal window and stays visible in
// screen shares/recordings (Zoom, Meet, etc.) - see README for why.

const { app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const util = require('util');

const { extractSpeech } = require('./lib/transcript');
const windowState = require('./lib/windowState');

const execFileAsync = util.promisify(execFile);

const BACKEND_URL = process.env.DEKI_BACKEND_URL || 'http://localhost:3232';
// How long to wait after one cycle finishes before checking whether another is
// needed. Cycles never overlap, so the real cadence is this plus however long
// the two model calls take.
const CAPTURE_INTERVAL_MS = 3000;
// A screen counts as "changed" when the average per-channel difference of a
// 32x18 fingerprint exceeds this (0-255 scale). Filters out cursor blinks and
// clock ticks while still catching scrolling, new windows, slide changes.
const SCREEN_CHANGE_THRESHOLD = 4;
const FINGERPRINT_SIZE = { width: 32, height: 18 };
// Screenshots are downscaled to this width before being sent; a full Retina
// PNG is several MB and makes the vision model much slower for no benefit.
const SCREENSHOT_MAX_WIDTH = 1280;
// After answering a typed question, keep that answer on screen at least this
// long before automatic cycles may replace it.
const MANUAL_ANSWER_HOLD_MS = 20000;
// If whisper falls behind real time, drop the oldest waiting segments beyond
// this many so the transcript stays current instead of lagging further.
const MAX_PENDING_TRANSCRIPTIONS = 3;
const TRANSCRIPT_WORD_LIMIT = 500;
// Which audio *input* device carries system audio. Each OS needs a loopback
// device for this (see README); these defaults match their usual labels and
// DEKI_AUDIO_DEVICE (a case-insensitive regex) overrides them.
const DEFAULT_AUDIO_DEVICE_PATTERNS = {
  darwin: 'blackhole', // BlackHole virtual driver
  linux: 'monitor', // PulseAudio/PipeWire "Monitor of <output>" sources
  win32: 'cable output|stereo mix', // VB-Audio Virtual Cable, or Realtek Stereo Mix
};
const AUDIO_DEVICE_PATTERN =
  process.env.DEKI_AUDIO_DEVICE || DEFAULT_AUDIO_DEVICE_PATTERNS[process.platform] || 'blackhole';
const WHISPER_MODEL = process.env.WHISPER_MODEL_NAME || 'base.en';
// English-only models (*.en) can't auto-detect language, so pin them to 'en';
// multilingual models default to auto-detection. WHISPER_LANGUAGE overrides.
const WHISPER_LANGUAGE =
  process.env.WHISPER_LANGUAGE || (WHISPER_MODEL.endsWith('.en') ? 'en' : 'auto');

let overlayWindow = null;
let captureTimer = null;
let captureLoopRunning = false;
let transcriptWords = [];
let transcriptVersion = 0; // bumps whenever new words arrive
let lastAnalyzed = { fingerprint: null, transcriptVersion: -1 };
let holdAutoUntil = 0;

// --- rolling transcript buffer (capped at last ~500 words) ---

function appendTranscript(text) {
  if (!text) return;
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return;
  transcriptWords.push(...words);
  if (transcriptWords.length > TRANSCRIPT_WORD_LIMIT) {
    transcriptWords = transcriptWords.slice(transcriptWords.length - TRANSCRIPT_WORD_LIMIT);
  }
  transcriptVersion++;
  sendToRenderer('transcript:update', getTranscriptText());
}

function getTranscriptText() {
  return transcriptWords.join(' ');
}

// --- overlay window ---

function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function createOverlayWindow() {
  const bounds = windowState.restoreBounds(
    windowState.loadSavedBounds(windowStatePath()),
    screen.getAllDisplays().map((display) => display.workArea),
    screen.getPrimaryDisplay().workArea
  );

  overlayWindow = new BrowserWindow({
    ...bounds,
    minWidth: windowState.MIN_SIZE.width,
    minHeight: windowState.MIN_SIZE.height,
    frame: false,
    transparent: true,
    // Native edge resizing works for transparent frameless windows on macOS
    // and Linux but is unreliable on Windows; the corner grip in the UI
    // (window:resize) works everywhere.
    resizable: process.platform !== 'win32',
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

  // Answers can contain links. Never navigate the overlay itself; open
  // http(s) links in the default browser instead.
  const openExternally = (url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  };
  overlayWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });
  overlayWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    openExternally(url);
  });

  // Remember where the user put the overlay and how big they made it.
  let saveTimer = null;
  const persistBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        windowState.saveBounds(windowStatePath(), overlayWindow.getBounds());
      }
    }, 300);
  };
  overlayWindow.on('resize', persistBounds);
  overlayWindow.on('move', persistBounds);
  overlayWindow.on('close', () => {
    clearTimeout(saveTimer);
    windowState.saveBounds(windowStatePath(), overlayWindow.getBounds());
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
    // Nothing left to show an answer in; stop the request (and, via the
    // dropped connection, the backend's Ollama call) instead of finishing it.
    if (currentCycle) currentCycle.abort.abort();
  });
}

// Every send goes through here: the window can be closed while a cycle is
// still awaiting a screenshot or reading the stream, and calling
// webContents.send on a destroyed window throws.
function sendToRenderer(channel, ...args) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.webContents.send(channel, ...args);
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

// desktopCapturer doesn't order sources by display, so with more than one
// monitor sources[0] can be any of them. Match on display_id, falling back to
// the first source only when the platform leaves display_id blank (some Linux
// setups do) or there's a single screen anyway.
function pickPrimarySource(sources) {
  const primaryId = String(screen.getPrimaryDisplay().id);
  return sources.find((source) => source.display_id === primaryId) || sources[0];
}

async function capturePrimaryScreen(thumbnailSize) {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  const primarySource = pickPrimarySource(sources);
  if (!primarySource || primarySource.thumbnail.isEmpty()) return null;
  return primarySource.thumbnail;
}

async function captureScreenshotBase64() {
  const { width, height } = screen.getPrimaryDisplay().size;
  const scale = Math.min(1, SCREENSHOT_MAX_WIDTH / width);
  const image = await capturePrimaryScreen({
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  });
  return image ? image.toPNG().toString('base64') : null;
}

// Tiny, cheap capture used only to decide whether the screen changed.
async function captureFingerprint() {
  const image = await capturePrimaryScreen(FINGERPRINT_SIZE);
  if (!image) return null;
  // desktopCapturer keeps aspect ratio, so normalize to an exact size.
  return image.resize(FINGERPRINT_SIZE).toBitmap();
}

function screenChanged(a, b) {
  if (!a || !b || a.length !== b.length) return true;
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length > SCREEN_CHANGE_THRESHOLD;
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
    sendToRenderer('ai:error', `Screenshot capture failed: ${err.message || err}`);
    return;
  }

  const transcript = getTranscriptText();
  lastAnalyzed = {
    fingerprint: await captureFingerprint().catch(() => null),
    transcriptVersion,
  };

  sendToRenderer('ai:chunk-start', { question: manualQuestion || null });

  try {
    const response = await fetch(`${BACKEND_URL}/api/analyze`, {
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
      sendToRenderer('ai:chunk', data.response || '');
      sendToRenderer('ai:done');
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
        sendToRenderer('ai:chunk', event.text);
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

    sendToRenderer('ai:done');
  } catch (err) {
    if (signal.aborted) return; // superseded by a newer question - not an error
    sendToRenderer('ai:error', err.message || String(err));
  }
}

// Self-pacing loop: each tick waits for the previous cycle to finish, then
// only runs a new analysis if the screen or transcript actually changed.
async function autoTick() {
  captureTimer = null;
  if (!captureLoopRunning) return;
  try {
    if (overlayWindow && overlayWindow.isVisible() && Date.now() >= holdAutoUntil) {
      const changed =
        transcriptVersion !== lastAnalyzed.transcriptVersion ||
        screenChanged(await captureFingerprint(), lastAnalyzed.fingerprint);
      if (changed) await runAnalysisCycle();
    }
  } catch (err) {
    console.error('[overlay] auto cycle failed:', err.message || err);
  } finally {
    if (captureLoopRunning && !captureTimer) {
      captureTimer = setTimeout(autoTick, CAPTURE_INTERVAL_MS);
    }
  }
}

function startCaptureLoop() {
  if (captureLoopRunning) return;
  captureLoopRunning = true;
  captureTimer = setTimeout(autoTick, CAPTURE_INTERVAL_MS);
}

function stopCaptureLoop() {
  captureLoopRunning = false;
  if (captureTimer) {
    clearTimeout(captureTimer);
    captureTimer = null;
  }
}

// --- global shortcuts ---

function registerShortcuts() {
  const toggleOk = globalShortcut.register('CommandOrControl+Shift+Space', toggleOverlay);
  const forceOk = globalShortcut.register('CommandOrControl+Shift+R', () => {
    holdAutoUntil = 0;
    runAnalysisCycle();
  });

  if (!toggleOk) console.warn('[overlay] Failed to register toggle shortcut (Ctrl/Cmd+Shift+Space)');
  if (!forceOk) console.warn('[overlay] Failed to register force-capture shortcut (Ctrl/Cmd+Shift+R)');
}

// --- system audio -> local whisper.cpp transcription ---
//
// Renderer records system audio (via a loopback input device such as
// BlackHole, not the microphone - see README) with MediaRecorder (webm/opus) and ships each
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

    const rawOutput = await nodewhisper(wavPath, {
      modelName: WHISPER_MODEL,
      autoDownloadModelName: WHISPER_MODEL,
      removeWavFileAfterTranscription: true,
      whisperOptions: {
        outputInText: true,
        language: WHISPER_LANGUAGE,
      },
    });

    // nodejs-whisper returns whisper-cli's raw stdout, timestamps included.
    // extractSpeech also drops silence markers and filler hallucinations, so a
    // quiet segment adds no words and doesn't trigger a re-analysis.
    const speech = extractSpeech(rawOutput);
    appendTranscript(speech);
    sendToRenderer('audio:transcribed', { ok: true, heardSpeech: Boolean(speech) });
  } catch (err) {
    const message = err.code === 'ENOENT' ? 'ffmpeg not found on PATH' : err.message || String(err);
    console.error('[overlay] transcription failed:', message);
    sendToRenderer('audio:transcribed', { ok: false, message });
  } finally {
    fs.rm(rawPath, { force: true }, () => {});
    fs.rm(wavPath, { force: true }, () => {});
  }
}

// Whisper jobs run one at a time in arrival order. Running them in parallel
// let a slow segment finish after a later one, scrambling the transcript, and
// let jobs pile up without bound when whisper was slower than real time.
const pendingAudio = [];
let transcribing = false;

async function drainAudioQueue() {
  if (transcribing) return;
  transcribing = true;
  try {
    while (pendingAudio.length > 0) {
      await transcribeAudioChunk(pendingAudio.shift());
    }
  } finally {
    transcribing = false;
  }
}

ipcMain.on('audio:chunk', (_event, arrayBuffer) => {
  pendingAudio.push(arrayBuffer);
  if (pendingAudio.length > MAX_PENDING_TRANSCRIPTIONS) {
    const dropped = pendingAudio.length - MAX_PENDING_TRANSCRIPTIONS;
    pendingAudio.splice(0, dropped);
    console.warn(`[overlay] transcription falling behind - dropped ${dropped} oldest audio segment(s)`);
  }
  drainAudioQueue();
});

ipcMain.handle('manual:ask', async (_event, question) => {
  // Hold off automatic cycles while the question runs and for a while after,
  // so the answer isn't immediately replaced by an auto refresh.
  holdAutoUntil = Infinity;
  try {
    await runAnalysisCycle(question);
  } finally {
    holdAutoUntil = Date.now() + MANUAL_ANSWER_HOLD_MS;
  }
});

// Static settings the sandboxed renderer can't read from process.env itself.
ipcMain.handle('app:config', () => ({
  platform: process.platform,
  audioDevicePattern: AUDIO_DEVICE_PATTERN,
  transcriberAvailable: Boolean(nodewhisper),
}));

// Corner-grip resizing from the renderer (see resizable above).
ipcMain.on('window:resize', (_event, size) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const { width, height } = windowState.clampSize(size || {});
  overlayWindow.setSize(width, height);
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
