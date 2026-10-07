// Preload script: the only bridge between the sandboxed renderer and the
// main process. Exposes a narrow, typed set of IPC methods - no direct
// access to Node or Electron internals from the renderer.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
  // Renderer -> main
  sendAudioChunk: (arrayBuffer) => ipcRenderer.send('audio:chunk', arrayBuffer),
  askQuestion: (question) => ipcRenderer.invoke('manual:ask', question),
  quitApp: () => ipcRenderer.send('app:quit'),
  getConfig: () => ipcRenderer.invoke('app:config'),
  resizeWindow: (width, height) => ipcRenderer.send('window:resize', { width, height }),

  // Main -> renderer (streamed AI response + status)
  onChunkStart: (callback) => ipcRenderer.on('ai:chunk-start', (_event, meta) => callback(meta)),
  onChunk: (callback) => ipcRenderer.on('ai:chunk', (_event, text) => callback(text)),
  onDone: (callback) => ipcRenderer.on('ai:done', () => callback()),
  onError: (callback) => ipcRenderer.on('ai:error', (_event, message) => callback(message)),
  onHealth: (callback) => ipcRenderer.on('backend:health', (_event, health) => callback(health)),
  onTranscript: (callback) => ipcRenderer.on('transcript:update', (_event, text) => callback(text)),
  onAudioTranscribed: (callback) =>
    ipcRenderer.on('audio:transcribed', (_event, result) => callback(result)),
});
