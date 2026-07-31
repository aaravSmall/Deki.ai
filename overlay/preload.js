// Preload script: the only bridge between the sandboxed renderer and the
// main process. Exposes a narrow, typed set of IPC methods - no direct
// access to Node or Electron internals from the renderer.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
  // Renderer -> main
  sendAudioChunk: (arrayBuffer) => ipcRenderer.send('mic:audio-chunk', arrayBuffer),
  askQuestion: (question) => ipcRenderer.invoke('manual:ask', question),
  quitApp: () => ipcRenderer.send('app:quit'),

  // Main -> renderer (streamed AI response + status)
  onChunkStart: (callback) => ipcRenderer.on('ai:chunk-start', () => callback()),
  onChunk: (callback) => ipcRenderer.on('ai:chunk', (_event, text) => callback(text)),
  onDone: (callback) => ipcRenderer.on('ai:done', () => callback()),
  onError: (callback) => ipcRenderer.on('ai:error', (_event, message) => callback(message)),
});
