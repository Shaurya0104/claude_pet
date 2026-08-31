'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The renderer gets a small, explicit surface — no node, no remote.
contextBridge.exposeInMainWorld('jarvis', {
  onState: (fn) => ipcRenderer.on('state', (_e, snap) => fn(snap)),
  onPet: (fn) => ipcRenderer.on('pet', (_e, pet) => fn(pet)),
  ready: () => ipcRenderer.send('renderer-ready'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('ignore-mouse', ignore),
  focus: (sessionId) => ipcRenderer.send('focus-session', sessionId),
  acknowledge: (sessionId) => ipcRenderer.send('acknowledge', sessionId),
  acknowledgeAll: () => ipcRenderer.send('acknowledge-all'),
  quit: () => ipcRenderer.send('quit'),
  moveBy: (dx, dy) => ipcRenderer.send('move-by', { dx, dy }),
  savePosition: () => ipcRenderer.send('save-position'),
  setPanel: (open) => ipcRenderer.send('set-panel', open),
});
