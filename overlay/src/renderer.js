// Renderer: system audio capture (getUserMedia + MediaRecorder), streamed AI
// response rendering, and the manual question input. Talks to the main
// process only through the narrow `window.overlayAPI` bridge exposed by
// preload.js.

const statusDot = document.getElementById('status-dot');
const responseText = document.getElementById('response-text');
const askForm = document.getElementById('ask-form');
const askInput = document.getElementById('ask-input');
const closeBtn = document.getElementById('close-btn');

closeBtn.addEventListener('click', () => {
  window.overlayAPI.quitApp();
});

const AUDIO_SEGMENT_MS = 5000;
const BLACKHOLE_LABEL_MATCH = /blackhole/i;

let currentResponseBuffer = '';

function setStatus(state) {
  statusDot.classList.remove('thinking', 'error');
  if (state === 'thinking') statusDot.classList.add('thinking');
  if (state === 'error') statusDot.classList.add('error');
}

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
  responseText.classList.add('error');
  responseText.textContent = `Error: ${message}`;
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
// Captures from a BlackHole virtual audio device (not the microphone) so the
// transcript reflects what's actually playing on the laptop - a call, a
// video, etc. - rather than whatever the mic happens to pick up. Requires
// BlackHole to be installed and set as (or part of) the system output device;
// see README for the one-time setup. Each segment is a fresh MediaRecorder
// start/stop cycle so every blob is an independently-decodable webm file (a
// single recorder with `timeslice` only puts container headers in the first
// chunk, which breaks ffmpeg on later chunks). The small stop/restart gap is
// an acceptable tradeoff for a demo.

let audioStream = null;

async function findBlackHoleDeviceId() {
  let devices = await navigator.mediaDevices.enumerateDevices();
  let match = devices.find((d) => d.kind === 'audioinput' && BLACKHOLE_LABEL_MATCH.test(d.label));

  if (!match) {
    // Device labels are blank until permission has been granted at least
    // once; open the default input briefly just to unlock labels, then
    // re-enumerate and look for BlackHole specifically.
    try {
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      tempStream.getTracks().forEach((track) => track.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
      match = devices.find((d) => d.kind === 'audioinput' && BLACKHOLE_LABEL_MATCH.test(d.label));
    } catch (err) {
      console.error('[overlay] could not enumerate audio input devices:', err);
    }
  }

  return match ? match.deviceId : null;
}

async function startAudioCaptureLoop() {
  const blackHoleId = await findBlackHoleDeviceId();

  if (!blackHoleId) {
    console.warn(
      '[overlay] BlackHole input device not found - system audio capture disabled. ' +
        'See README for one-time setup (brew install blackhole-2ch + Audio MIDI Setup).'
    );
    return;
  }

  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: blackHoleId } },
    });
  } catch (err) {
    console.error('[overlay] failed to open BlackHole input:', err);
    return;
  }

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
