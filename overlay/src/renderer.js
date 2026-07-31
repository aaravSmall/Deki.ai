// Renderer: mic capture (getUserMedia + MediaRecorder), streamed AI response
// rendering, and the manual question input. Talks to the main process only
// through the narrow `window.overlayAPI` bridge exposed by preload.js.

const statusDot = document.getElementById('status-dot');
const responseText = document.getElementById('response-text');
const askForm = document.getElementById('ask-form');
const askInput = document.getElementById('ask-input');
const closeBtn = document.getElementById('close-btn');

closeBtn.addEventListener('click', () => {
  window.overlayAPI.quitApp();
});

const MIC_SEGMENT_MS = 5000;

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

// --- continuous mic capture in ~5s self-contained segments ---
//
// Each segment is a fresh MediaRecorder start/stop cycle so every blob is an
// independently-decodable webm file (a single recorder with `timeslice` only
// puts container headers in the first chunk, which breaks ffmpeg on later
// chunks). The small stop/restart gap is an acceptable tradeoff for a demo.

let micStream = null;

async function startMicCaptureLoop() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    console.error('[overlay] microphone access failed:', err);
    return;
  }

  recordSegment();
}

function recordSegment() {
  if (!micStream) return;

  const chunks = [];
  const recorder = new MediaRecorder(micStream, { mimeType: 'audio/webm' });

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
  }, MIC_SEGMENT_MS);
}

startMicCaptureLoop();
