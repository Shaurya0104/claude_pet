'use strict';
/**
 * Jarvis — the desktop pet process.
 *
 * A frameless, transparent, click-through window that floats above every
 * other window on every Space, a menubar tray, and a settings window.
 */
const {
  app, BrowserWindow, Tray, Menu, ipcMain, nativeImage,
  Notification, screen, shell, dialog,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { PetState } = require('../core/state');
const { focusSession } = require('../core/focus');
const { importPet, pngSize } = require('../core/import-pet');
const { JARVIS_DIR, SETTINGS_FILE, PETS_DIR } = require('../core/paths');

let win = null;          // the pet overlay
let settingsWin = null;  // the settings window
let tray = null;
let state = null;
let pet = null;
let panelOpen = false;
let anchor = null;       // window's bottom-right corner, so it stays put as it resizes

const DEFAULTS = {
  anchor: null,
  petId: 'jarvis',
  sizeScale: 1,          // multiplies the pet's own scale
  animate: true,
  randomIdle: true,      // rotate through a pet's idle variants
  notify: true,
  sound: true,
  minimized: false,
  autoRestore: true,     // pop back up when a session needs you
  restoreOn: ['needs_input', 'blocked', 'ready'],
};
let settings = { ...DEFAULTS };

const SIZE_STEPS = [0.6, 0.8, 1, 1.25, 1.5, 2];

// ------------------------------------------------------------- settings ---
function loadSettings() {
  try {
    Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
  } catch { /* first run */ }
}

function saveSettings() {
  try {
    fs.mkdirSync(JARVIS_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch { /* not fatal */ }
}

/** Apply a settings patch and push the consequences everywhere. */
function updateSettings(patch) {
  const prevPet = settings.petId;
  Object.assign(settings, patch);
  saveSettings();

  if (patch.petId && patch.petId !== prevPet) {
    try {
      pet = loadPet(patch.petId);
    } catch {
      pet = loadPet('jarvis');
    }
    win?.webContents.send('pet', effectivePet());
  }
  if ('sizeScale' in patch || 'petId' in patch) {
    win?.webContents.send('pet', effectivePet());
    applyBounds();
  }
  if ('minimized' in patch) applyVisibility();

  win?.webContents.send('settings', settings);
  settingsWin?.webContents.send('settings', settings);
  buildTray(state?.snapshot());
}

// ------------------------------------------------------------------ pet ---
function loadPet(id) {
  const dir = path.join(PETS_DIR, id);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'pet.json'), 'utf8'));
  manifest.id = manifest.id || id;
  manifest.dir = dir;
  manifest.sheetUrl = `file://${path.join(dir, manifest.sheet)}`;
  manifest.sheetPath = path.join(dir, manifest.sheet);
  return manifest;
}

/** The pet as the renderer should draw it, with the user's size applied. */
function effectivePet() {
  if (!pet) return null;
  return { ...pet, scale: (pet.scale ?? 2) * (settings.sizeScale || 1) };
}

function listPets() {
  try {
    return fs.readdirSync(PETS_DIR)
      .filter((d) => fs.existsSync(path.join(PETS_DIR, d, 'pet.json')))
      .map((d) => {
        try {
          const m = JSON.parse(fs.readFileSync(path.join(PETS_DIR, d, 'pet.json'), 'utf8'));
          const sheetPath = path.join(PETS_DIR, d, m.sheet);
          const size = pngSize(sheetPath) || { w: 0, h: 0 };
          return {
            id: d,
            name: m.name || d,
            source: m.source || '',
            sheetUrl: `file://${sheetPath}`,
            sheetWidth: size.w,
            sheetHeight: size.h,
            frameWidth: m.frameWidth,
            frameHeight: m.frameHeight,
            rendering: m.rendering || 'pixelated',
            animations: Object.keys(m.animations || {}),
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ----------------------------------------------------------------- window ---
/**
 * Window size is derived from the pet, so a big sprite gets room and a small
 * one does not pay for compositing area it never uses.
 */
function sizes() {
  const p = effectivePet();
  const w = Math.round((p?.frameWidth ?? 48) * (p?.scale ?? 2));
  const h = Math.round((p?.frameHeight ?? 48) * (p?.scale ?? 2));
  const width = Math.max(340, w + 56);
  return { collapsed: [width, h + 130], expanded: [width, h + 400] };
}

function applyBounds() {
  if (!win || !anchor) return;
  const s = sizes();
  const [w, h] = panelOpen ? s.expanded : s.collapsed;
  win.setBounds({
    x: Math.round(anchor.right - w),
    y: Math.round(anchor.bottom - h),
    width: w,
    height: h,
  });
}

function applyVisibility() {
  if (!win) return;
  if (settings.minimized) win.hide();
  else win.showInactive();
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  anchor = settings.anchor || {
    right: area.x + area.width - 24,
    bottom: area.y + area.height - 24,
  };

  const [w, h] = sizes().collapsed;

  win = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round(anchor.right - w),
    y: Math.round(anchor.bottom - h),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    focusable: false,       // never steal focus from your editor
    fullscreenable: false,
    acceptFirstMouse: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // --- the lines that make it a real desktop pet ---
  win.setAlwaysOnTop(true, 'screen-saver');                            // above fullscreen apps
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });  // every Space
  win.setIgnoreMouseEvents(true, { forward: true });                   // clicks pass through

  if (process.env.JARVIS_DEBUG) {
    win.webContents.on('console-message', (_e, _lvl, msg, line, src) =>
      console.log(`[renderer] ${msg}  (${src}:${line})`));
    win.webContents.on('render-process-gone', (_e, d) => console.error('[renderer gone]', d));
    win.webContents.on('did-fail-load', (_e, code, desc) => console.error('[load failed]', code, desc));
  }

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!settings.minimized) win.showInactive(); });
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 460,
    height: 680,
    resizable: true,
    minWidth: 400,
    minHeight: 520,
    title: 'Jarvis Settings',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#12171c',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings', 'index.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ------------------------------------------------------------------- tray ---
const TRAY_LABEL = {
  needs_input: 'needs you',
  blocked: 'blocked',
  ready: 'ready',
  running: 'working',
  idle: 'idle',
};

/** Crop frame 0 of the current state out of the sprite sheet for the tray. */
function trayIcon(stateName) {
  try {
    const anim = pet.animations[stateName] || pet.animations.idle;
    const img = nativeImage.createFromPath(pet.sheetPath).crop({
      x: 0,
      y: anim.row * pet.frameHeight,
      width: pet.frameWidth,
      height: pet.frameHeight,
    });
    return img.resize({ width: 18, height: 18, quality: 'best' });
  } catch {
    return nativeImage.createEmpty();
  }
}

function buildTray(snap) {
  if (!tray || !snap) return;
  const { sessions, counts, overall } = snap;

  const sessionItems = sessions.length
    ? sessions.slice(0, 20).map((s) => ({
        label: `${{ needs_input: '!', blocked: '×', ready: '✓', running: '›', idle: '·' }[s.state]}  ${s.name}  —  ${TRAY_LABEL[s.state]}${s.reason ? ` (${s.reason})` : ''}`,
        click: () => doFocus(s.sessionId),
      }))
    : [{ label: 'no sessions running', enabled: false }];

  const actions = Object.entries(pet?.actions || {})
    .filter(([, a]) => a.label)
    .map(([key, a]) => ({ label: a.label, click: () => win?.webContents.send('action', key) }));

  const menu = Menu.buildFromTemplate([
    { label: `Jarvis — ${TRAY_LABEL[overall]}`, enabled: false },
    {
      label: `${sessions.length} session${sessions.length === 1 ? '' : 's'} · ` +
        `${counts.needs_input} need you · ${counts.running} working`,
      enabled: false,
    },
    { type: 'separator' },
    ...sessionItems,
    { type: 'separator' },
    { label: 'Mark all as seen', click: () => state.acknowledgeAll() },
    {
      label: settings.minimized ? 'Show pet' : 'Hide pet',
      accelerator: 'CommandOrControl+Shift+J',
      click: () => updateSettings({ minimized: !settings.minimized }),
    },
    ...(actions.length ? [{ label: 'Do something', submenu: actions }] : []),
    { type: 'separator' },
    {
      label: 'Pet',
      submenu: listPets().map((p) => ({
        label: p.name,
        type: 'radio',
        checked: p.id === settings.petId,
        click: () => updateSettings({ petId: p.id }),
      })),
    },
    {
      label: 'Size',
      submenu: SIZE_STEPS.map((s) => ({
        label: `${Math.round(s * 100)}%`,
        type: 'radio',
        checked: Math.abs(s - settings.sizeScale) < 0.001,
        click: () => updateSettings({ sizeScale: s }),
      })),
    },
    {
      label: 'Animate',
      type: 'checkbox',
      checked: settings.animate,
      click: (mi) => updateSettings({ animate: mi.checked }),
    },
    {
      label: 'Notifications',
      type: 'checkbox',
      checked: settings.notify,
      click: (mi) => updateSettings({ notify: mi.checked }),
    },
    { type: 'separator' },
    { label: 'Settings…', accelerator: 'CommandOrControl+,', click: openSettings },
    { label: 'Open pets folder', click: () => shell.openPath(PETS_DIR) },
    { type: 'separator' },
    { label: 'Quit Jarvis', click: () => app.quit() },
  ]);

  tray.setToolTip(`Jarvis — ${TRAY_LABEL[overall]} · ${sessions.length} sessions`);
  tray.setImage(trayIcon(overall));
  tray.setContextMenu(menu);
}

// ---------------------------------------------------------- notifications ---
const lastNotified = new Map(); // sessionId -> the state we last shouted about

function maybeNotify(snap) {
  if (!settings.notify || !Notification.isSupported()) return;

  for (const s of snap.sessions) {
    const prev = lastNotified.get(s.sessionId);
    if (prev === s.state) continue;
    lastNotified.set(s.sessionId, s.state);

    let title = null, body = null;
    if (s.state === 'needs_input') {
      title = `${s.name} needs you`;
      body = s.reason || 'waiting for your input';
    } else if (s.state === 'blocked') {
      title = `${s.name} is blocked`;
      body = s.reason || 'the turn ended with an error';
    } else if (s.state === 'ready' && prev === 'running') {
      title = `${s.name} finished`;
      body = s.message || 'ready for review';
    }
    if (!title) continue;

    const n = new Notification({ title, body, silent: !settings.sound });
    n.on('click', () => doFocus(s.sessionId));
    n.show();
  }

  const live = new Set(snap.sessions.map((s) => s.sessionId));
  for (const id of lastNotified.keys()) if (!live.has(id)) lastNotified.delete(id);
}

/**
 * Being hidden should not mean being uninformed: when something starts
 * actually wanting your attention, come back on screen.
 */
function maybeRestore(snap, prevOverall) {
  if (!settings.minimized || !settings.autoRestore) return;
  if (snap.overall === prevOverall) return;
  if (!(settings.restoreOn || []).includes(snap.overall)) return;
  updateSettings({ minimized: false });
}

// ------------------------------------------------------------------ wiring ---
async function doFocus(sessionId) {
  const s = state.snapshot().sessions.find((x) => x.sessionId === sessionId);
  if (!s) return;
  state.acknowledge(sessionId);       // looking at it clears the badge
  await focusSession(s);
}

function push() {
  const snap = state.snapshot();
  win?.webContents.send('state', snap);
  settingsWin?.webContents.send('state', snap);
  buildTray(snap);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    loadSettings();
    try {
      pet = loadPet(settings.petId);
    } catch {
      pet = loadPet('jarvis');
    }

    app.dock?.hide();                 // menubar accessory, no Dock icon

    state = new PetState().start();
    createWindow();
    tray = new Tray(trayIcon('idle'));
    tray.on('click', () => tray.popUpContextMenu());

    let prevOverall = state.snapshot().overall;
    state.on('change', (snap) => {
      maybeNotify(snap);
      maybeRestore(snap, prevOverall);
      prevOverall = snap.overall;
      push();
    });

    push();
    // Relative ages are only rendered while the panel is open.
    setInterval(() => { if (panelOpen && !settings.minimized) push(); }, 5000);

    // JARVIS_SMOKE=1 boots, reports, and exits — used to verify the window
    // flags and the wiring without a human looking at the screen.
    if (process.env.JARVIS_SMOKE) {
      openSettings();
      setTimeout(() => {
        const p = effectivePet();
        console.log(JSON.stringify({
          visible: win.isVisible(),
          alwaysOnTop: win.isAlwaysOnTop(),
          allWorkspaces: win.isVisibleOnAllWorkspaces(),
          size: win.getSize(),
          settingsWindow: !!settingsWin && !settingsWin.isDestroyed(),
          pet: p.id,
          effectiveScale: p.scale,
          renderedPx: [Math.round(p.frameWidth * p.scale), Math.round(p.frameHeight * p.scale)],
          animations: Object.keys(p.animations),
          variants: p.variants || null,
          actions: Object.keys(p.actions || {}),
          pets: listPets().map((x) => `${x.id} (${x.sheetWidth}x${x.sheetHeight})`),
          overall: state.snapshot().overall,
          sessions: state.snapshot().sessions.length,
        }, null, 2));
        app.exit(0);
      }, 3000);
    }
  });

  app.on('window-all-closed', (e) => e.preventDefault()); // tray app, stays alive
}

// ---------------------------------------------------------------------- IPC ---
ipcMain.on('renderer-ready', () => {
  win?.webContents.send('pet', effectivePet());
  win?.webContents.send('settings', settings);
  push();
});
ipcMain.on('ignore-mouse', (_e, ignore) => {
  win?.setIgnoreMouseEvents(!!ignore, { forward: true });
});
ipcMain.on('focus-session', (_e, id) => doFocus(id));
ipcMain.on('acknowledge', (_e, id) => state?.acknowledge(id));
ipcMain.on('acknowledge-all', () => state?.acknowledgeAll());
ipcMain.on('quit', () => app.quit());
ipcMain.on('open-settings', openSettings);
ipcMain.on('minimize', () => updateSettings({ minimized: true }));

ipcMain.on('move-by', (_e, { dx, dy }) => {
  if (!win || !anchor) return;
  anchor.right += dx;
  anchor.bottom += dy;
  applyBounds();
});
ipcMain.on('save-position', () => {
  settings.anchor = anchor;
  saveSettings();
});
ipcMain.on('set-panel', (_e, open) => {
  panelOpen = !!open;
  applyBounds();
  if (panelOpen) push();
});

// --- settings window channels
ipcMain.handle('settings:get', () => ({
  settings,
  pets: listPets(),
  sizeSteps: SIZE_STEPS,
  packaged: app.isPackaged,
  loginItem: app.isPackaged ? app.getLoginItemSettings().openAtLogin : false,
  petsDir: PETS_DIR,
  actions: Object.entries(pet?.actions || {}).map(([k, a]) => ({ key: k, label: a.label || k })),
}));
ipcMain.handle('settings:set', (_e, patch) => { updateSettings(patch); return settings; });
ipcMain.handle('settings:loginItem', (_e, on) => {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!on, openAsHidden: true });
  return app.isPackaged ? app.getLoginItemSettings().openAtLogin : false;
});
ipcMain.handle('settings:pickImage', async () => {
  const r = await dialog.showOpenDialog(settingsWin, {
    title: 'Choose a sprite sheet',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('settings:importPet', (_e, opts) => {
  try {
    const r = importPet(opts);
    updateSettings({ petId: r.name });
    return { ok: true, ...r };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('settings:action', (_e, key) => { win?.webContents.send('action', key); });
ipcMain.handle('settings:openPets', () => shell.openPath(PETS_DIR));
