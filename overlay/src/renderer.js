// Renderer: system audio capture (getUserMedia + MediaRecorder), streamed AI
// response rendering, and the manual question input. Talks to the main
// process only through the narrow `window.overlayAPI` bridge exposed by
// preload.js.

const statusDot = document.getElementById('status-dot');
const responseText = document.getElementById('response-text');
const askForm = document.getElementById('ask-form');
const askInput = document.getElementById('ask-input');
const closeBtn = document.getElementById('close-btn');
const audioStatus = document.getElementById('audio-status');

closeBtn.addEventListener('click', () => {
  window.overlayAPI.quitApp();
});

const AUDIO_SEGMENT_MS = 5000;

let currentResponseBuffer = '';

function setStatus(state) {
  statusDot.classList.remove('thinking', 'error');
  if (state === 'thinking') statusDot.classList.add('thinking');
  if (state === 'error') statusDot.classList.add('error');
}

// --- audio status pill ---
//
// States: pending (still looking for a device), live (capturing and
// transcribing), off (no loopback device - screen-only mode), error
// (capturing, but transcription is failing). The tooltip says why.

let heardTimer = null;
let liveDetail = 'Capturing system audio';

function setAudioStatus(state, detail) {
  audioStatus.dataset.state = state;
  audioStatus.title = detail;
}

window.overlayAPI.onAudioTranscribed((result) => {
  if (!result.ok) {
    setAudioStatus('error', `Transcription failing: ${result.message}`);
    return;
  }
  if (audioStatus.dataset.state !== 'live') {
    setAudioStatus('live', liveDetail);
  }
  if (result.heardSpeech) {
    audioStatus.classList.add('heard');
    clearTimeout(heardTimer);
    heardTimer = setTimeout(() => audioStatus.classList.remove('heard'), 800);
  }
});

// --- streamed AI response wiring ---

window.overlayAPI.onChunkStart(() => {
  currentResponseBuffer = '';
  responseText.classList.remove('error');
  responseText.textContent = '';
  setStatus('thinking');
});

window.overlayAPI.onChunk((text) => {
  currentResponseBuffer += text;
  responseText.textContent = currentResponseBuffer;
});

window.overlayAPI.onDone(() => {
  setStatus('idle');
});

window.overlayAPI.onError((message) => {
  // Keep any partial answer that already streamed in and show why it stopped
  // underneath it, rather than wiping it.
  responseText.classList.add('error');
  responseText.textContent = currentResponseBuffer
    ? `${currentResponseBuffer}\n\n⚠ Stopped: ${message}`
    : `Error: ${message}`;
  setStatus('error');
});

// --- manual question input ---

askForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const question = askInput.value.trim();
  if (!question) return;
  askInput.value = '';
  await window.overlayAPI.askQuestion(question);
});

// --- continuous system audio capture in ~5s self-contained segments ---
//
// Captures from a loopback input device (not the microphone) so the
// transcript reflects what's actually playing on the computer - a call, a
// video, etc. - rather than whatever the mic happens to pick up. Which device
// that is depends on the OS: BlackHole on macOS, a PulseAudio/PipeWire
// "Monitor of ..." source on Linux, VB-Audio Virtual Cable or Stereo Mix on
// Windows. The main process supplies a label pattern for the current OS
// (overridable with DEKI_AUDIO_DEVICE); see README for setup. Each segment is
// a fresh MediaRecorder start/stop cycle so every blob is an
// independently-decodable webm file (a single recorder with `timeslice` only
// puts container headers in the first chunk, which breaks ffmpeg on later
// chunks). The small stop/restart gap is an acceptable tradeoff for a demo.

let audioStream = null;

function toDeviceMatcher(pattern) {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    // Not a valid regex - treat it as a plain substring.
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}

async function findLoopbackDevice(matcher) {
  const findMatch = (devices) =>
    devices.find((d) => d.kind === 'audioinput' && matcher.test(d.label));

  let match = findMatch(await navigator.mediaDevices.enumerateDevices());

  if (!match) {
    // Device labels are blank until permission has been granted at least
    // once; open the default input briefly just to unlock labels, then
    // re-enumerate and look for the loopback device specifically.
    try {
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      tempStream.getTracks().forEach((track) => track.stop());
      match = findMatch(await navigator.mediaDevices.enumerateDevices());
    } catch (err) {
      console.error('[overlay] could not enumerate audio input devices:', err);
    }
  }

  return match || null;
}

async function startAudioCaptureLoop() {
  const { audioDevicePattern, transcriberAvailable } = await window.overlayAPI.getConfig();

  if (!transcriberAvailable) {
    setAudioStatus('off', 'nodejs-whisper is not installed - run npm install in overlay/');
    return;
  }

  const device = await findLoopbackDevice(toDeviceMatcher(audioDevicePattern));

  if (!device) {
    console.warn(
      `[overlay] No audio input matching /${audioDevicePattern}/i - system audio capture disabled. ` +
        'See README for loopback device setup, or set DEKI_AUDIO_DEVICE to part of your device name.'
    );
    setAudioStatus(
      'off',
      `No audio input matching /${audioDevicePattern}/i - screen-only mode. See README to set up a loopback device.`
    );
    return;
  }

  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: device.deviceId } },
    });
  } catch (err) {
    console.error('[overlay] failed to open system audio input:', err);
    setAudioStatus('error', `Could not open "${device.label}": ${err.message || err}`);
    return;
  }

  liveDetail = `Capturing system audio from "${device.label}"`;
  setAudioStatus('live', liveDetail);
  recordSegment();
}

function recordSegment() {
  if (!audioStream) return;

  const chunks = [];
  const recorder = new MediaRecorder(audioStream, { mimeType: 'audio/webm' });

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  recorder.onstop = async () => {
    if (chunks.length > 0) {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const arrayBuffer = await blob.arrayBuffer();
      window.overlayAPI.sendAudioChunk(arrayBuffer);
    }
    recordSegment();
  };

  recorder.start();
  setTimeout(() => {
    if (recorder.state !== 'inactive') recorder.stop();
  }, AUDIO_SEGMENT_MS);
}

startAudioCaptureLoop();
