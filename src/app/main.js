'use strict';
/**
 * Jarvis — the desktop pet process.
 *
 * A frameless, transparent, click-through window that floats above every
 * other window on every Space, plus a menubar tray that lists the sessions.
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { PetState } = require('../core/state');
const { focusSession } = require('../core/focus');
const { JARVIS_DIR, SETTINGS_FILE, PETS_DIR } = require('../core/paths');

// The window is a transparent always-on-top surface, and macOS composites all
// of it every frame. Keeping it just big enough for the pet while the session
// panel is closed is the single biggest thing we can do for GPU cost.
// Derived from the pet, so a big sprite gets a big enough window and a small
// one does not pay for compositing area it never uses.
function sizes() {
  const w = Math.round((pet?.frameWidth ?? 48) * (pet?.scale ?? 2));
  const h = Math.round((pet?.frameHeight ?? 48) * (pet?.scale ?? 2));
  const width = Math.max(320, w + 56);
  return {
    collapsed: [width, h + 92],    // pet + speech bubble
    expanded: [width, h + 350],    // pet + session panel
  };
}

let win = null;
let tray = null;
let state = null;
let pet = null;
let panelOpen = false;
// Position is stored as the window's bottom-right corner, so the pet stays put
// when the window grows and shrinks around it.
let anchor = null;
let settings = { anchor: null, petId: 'jarvis', notify: true, sound: true };

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

// ------------------------------------------------------------------ pet ---
function loadPet(id) {
  const dir = path.join(PETS_DIR, id);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'pet.json'), 'utf8'));
  manifest.dir = dir;
  manifest.sheetUrl = `file://${path.join(dir, manifest.sheet)}`;
  manifest.sheetPath = path.join(dir, manifest.sheet);
  return manifest;
}

function listPets() {
  try {
    return fs.readdirSync(PETS_DIR).filter((d) =>
      fs.existsSync(path.join(PETS_DIR, d, 'pet.json'))
    );
  } catch {
    return [];
  }
}

// ----------------------------------------------------------------- window ---
function applyBounds() {
  const s = sizes();
  const [w, h] = panelOpen ? s.expanded : s.collapsed;
  win.setBounds({
    x: Math.round(anchor.right - w),
    y: Math.round(anchor.bottom - h),
    width: w,
    height: h,
  });
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
  // Float above normal windows, and above fullscreen apps.
  win.setAlwaysOnTop(true, 'screen-saver');
  // Follow you onto every Space / desktop, including fullscreen ones.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Clicks pass straight through the transparent parts of the window;
  // `forward: true` keeps mousemove flowing so the renderer can hit-test.
  win.setIgnoreMouseEvents(true, { forward: true });

  if (process.env.JARVIS_DEBUG) {
    win.webContents.on('console-message', (_e, _lvl, msg, line, src) =>
      console.log(`[renderer] ${msg}  (${src}:${line})`));
    win.webContents.on('render-process-gone', (_e, d) => console.error('[renderer gone]', d));
    win.webContents.on('did-fail-load', (_e, code, desc) => console.error('[load failed]', code, desc));
  }

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
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
  const { sessions, counts, overall } = snap;

  const sessionItems = sessions.length
    ? sessions.slice(0, 20).map((s) => ({
        label: `${{ needs_input: '!', blocked: '×', ready: '✓', running: '›', idle: '·' }[s.state]}  ${s.name}  —  ${TRAY_LABEL[s.state]}${s.reason ? ` (${s.reason})` : ''}`,
        click: () => doFocus(s.sessionId),
      }))
    : [{ label: 'no sessions running', enabled: false }];

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
      label: 'Pet',
      submenu: listPets().map((id) => ({
        label: id,
        type: 'radio',
        checked: id === settings.petId,
        click: () => {
          settings.petId = id;
          saveSettings();
          pet = loadPet(id);
          win?.webContents.send('pet', pet);
          applyBounds();
          push();
        },
      })),
    },
    {
      label: 'Notifications',
      type: 'checkbox',
      checked: settings.notify,
      click: (mi) => { settings.notify = mi.checked; saveSettings(); },
    },
    {
      label: 'Launch at login',
      type: 'checkbox',
      enabled: app.isPackaged,
      checked: app.isPackaged && app.getLoginItemSettings().openAtLogin,
      click: (mi) => app.setLoginItemSettings({ openAtLogin: mi.checked, openAsHidden: true }),
    },
    { label: 'Open pets folder', click: () => shell.openPath(PETS_DIR) },
    { type: 'separator' },
    { label: 'Quit Jarvis', click: () => app.quit() },
  ]);

  tray.setToolTip(`Jarvis — ${TRAY_LABEL[overall]} · ${sessions.length} sessions`);
  tray.setImage(trayIcon(overall));
  tray.setContextMenu(menu);
}

// ---------------------------------------------------------- notifications ---
const lastNotified = new Map(); // sessionId -> state we last shouted about

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

  // Forget sessions that have gone away.
  const live = new Set(snap.sessions.map((s) => s.sessionId));
  for (const id of lastNotified.keys()) if (!live.has(id)) lastNotified.delete(id);
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
  if (tray) buildTray(snap);
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

    app.dock?.hide();                 // menubar accessory, no dock icon

    state = new PetState().start();

    createWindow();
    tray = new Tray(trayIcon('idle'));

    state.on('change', (snap) => {
      maybeNotify(snap);
      push();
    });

    push();
    // Only tick while the panel is actually on screen — that is the only
    // place relative ages are rendered.
    setInterval(() => { if (panelOpen) push(); }, 5000);

    if (process.env.JARVIS_SMOKE) {
      setTimeout(() => {
        const [x, y] = win.getPosition();
        console.log(JSON.stringify({
          visible: win.isVisible(),
          alwaysOnTop: win.isAlwaysOnTop(),
          allWorkspaces: win.isVisibleOnAllWorkspaces(),
          transparent: win.webContents.getBackgroundThrottling() !== undefined,
          position: [x, y],
          size: win.getSize(),
          trayIconEmpty: trayIcon('idle').isEmpty(),
          pet: pet.id,
          overall: state.snapshot().overall,
          sessions: state.snapshot().sessions.length,
          counts: state.snapshot().counts,
        }, null, 2));
        app.exit(0);
      }, 2500);
    }
  });

  app.on('window-all-closed', (e) => e.preventDefault()); // tray app, stays alive
}

// ---------------------------------------------------------------------- IPC ---
ipcMain.on('renderer-ready', () => {
  win?.webContents.send('pet', pet);
  push();
});
ipcMain.on('ignore-mouse', (_e, ignore) => {
  win?.setIgnoreMouseEvents(!!ignore, { forward: true });
});
ipcMain.on('focus-session', (_e, id) => doFocus(id));
ipcMain.on('acknowledge', (_e, id) => state?.acknowledge(id));
ipcMain.on('acknowledge-all', () => state?.acknowledgeAll());
ipcMain.on('quit', () => app.quit());
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
  if (panelOpen) push();   // the panel shows ages, so refresh on open
});
