'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Both windows share this preload; each uses the half it needs.
contextBridge.exposeInMainWorld('jarvis', {
  // --- pet overlay
  onState: (fn) => ipcRenderer.on('state', (_e, snap) => fn(snap)),
  onPet: (fn) => ipcRenderer.on('pet', (_e, pet) => fn(pet)),
  onSettings: (fn) => ipcRenderer.on('settings', (_e, s) => fn(s)),
  onAction: (fn) => ipcRenderer.on('action', (_e, key) => fn(key)),
  onSpeak: (fn) => ipcRenderer.on('speak', (_e, msg) => fn(msg)),
  openUrl: (url) => ipcRenderer.send('open-url', url),
  feed: (kind) => ipcRenderer.invoke('feed', kind),
  ready: () => ipcRenderer.send('renderer-ready'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('ignore-mouse', ignore),
  focus: (sessionId) => ipcRenderer.send('focus-session', sessionId),
  acknowledge: (sessionId) => ipcRenderer.send('acknowledge', sessionId),
  acknowledgeAll: () => ipcRenderer.send('acknowledge-all'),
  quit: () => ipcRenderer.send('quit'),
  minimize: () => ipcRenderer.send('minimize'),
  openSettings: () => ipcRenderer.send('open-settings'),
  moveBy: (dx, dy) => ipcRenderer.send('move-by', { dx, dy }),
  savePosition: () => ipcRenderer.send('save-position'),
  setPanel: (open) => ipcRenderer.send('set-panel', open),
  onPaused: (fn) => ipcRenderer.on('paused', (_e, p) => fn(p)),
  onHoverEnd: (fn) => ipcRenderer.on('hover-end', () => fn()),
  hoverWatch: (on) => ipcRenderer.send('hover-watch', on),

  // --- settings window
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    loginItem: (on) => ipcRenderer.invoke('settings:loginItem', on),
    pickImage: () => ipcRenderer.invoke('settings:pickImage'),
    importPet: (opts) => ipcRenderer.invoke('settings:importPet', opts),
    action: (key) => ipcRenderer.invoke('settings:action', key),
    openPets: () => ipcRenderer.invoke('settings:openPets'),
    resetPosition: () => ipcRenderer.invoke('settings:resetPosition'),
  },
});
