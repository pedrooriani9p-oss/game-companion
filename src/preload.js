const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('get-state'),
  saveNote: (gameId, text) => ipcRenderer.invoke('save-note', gameId, text),
  saveReminders: (r) => ipcRenderer.invoke('save-reminders', r),
  setGame: (gameId) => ipcRenderer.invoke('set-game', gameId),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  setCompact: (on) => ipcRenderer.invoke('set-compact', on),
  openWeb: () => ipcRenderer.invoke('open-web'),
  openWebExternal: () => ipcRenderer.invoke('open-web-external'),
  captureScore: () => ipcRenderer.invoke('capture-score'),
  fps: () => ipcRenderer.invoke('fps'),
  fpsAdmin: () => ipcRenderer.invoke('fps-admin'),
  openUpdate: (url) => ipcRenderer.invoke('open-update', url),
  onToast: (cb) => ipcRenderer.on('toast', (_e, t) => cb(t)),
  onUpdate: (cb) => ipcRenderer.on('update', (_e, u) => cb(u)),
  hide: () => ipcRenderer.invoke('hide'),
  show: () => ipcRenderer.invoke('show'),
  systemStats: () => ipcRenderer.invoke('system-stats'),
  onGameChanged: (cb) => ipcRenderer.on('game-changed', (_e, g) => cb(g)),
  onMode: (cb) => ipcRenderer.on('mode', (_e, m) => cb(m))
});
