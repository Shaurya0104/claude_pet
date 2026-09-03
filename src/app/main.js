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
const { randomFact, randomNews } = require('../core/feeds');
const { JARVIS_DIR, SETTINGS_FILE, PETS_DIR } = require('../core/paths');

let win = null;          // the pet overlay
let settingsWin = null;  // the settings window
let tray = null;
let state = null;
let pet = null;
let panelOpen = false;
let hovering = false;
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
  buttons: {},           // key -> false to hide; anything missing shows
};
let settings = { ...DEFAULTS };

const SIZE_STEPS = [0.2, 0.4, 0.6, 0.8, 1, 1.25, 1.5, 2];
const SIZE_MIN = 0.2;
const SIZE_MAX = 2;

const clampSize = (v) => Math.max(SIZE_MIN, Math.min(SIZE_MAX, Number(v) || 1));

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
  if ('sizeScale' in patch) patch.sizeScale = clampSize(patch.sizeScale);
  const prevPet = settings.petId;
  Object.assign(settings, patch);
  saveSettings();

  if (patch.petId && patch.petId !== prevPet) {
    traySignature = '';
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

let petListCache = null;

/** Invalidate after importing a pet, or when the folder is edited by hand. */
function invalidatePetList() { petListCache = null; }

function listPets() {
  if (petListCache) return petListCache;
  petListCache = readPetList();
  return petListCache;
}

function readPetList() {
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
            baseScale: m.scale ?? 2,
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

/** Every button the hover bar could offer for the current pet. */
function availableButtons() {
  const list = Object.entries(pet?.actions || {})
    .filter(([, a]) => a.label)
    .map(([key, a]) => ({ key, label: a.label }));
  list.push({ key: 'fact', label: 'Fact' });
  list.push({ key: 'news', label: 'News' });
  return list.map((b) => ({ ...b, enabled: settings.buttons?.[b.key] !== false }));
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
  // The window is a transparent surface the compositor redraws in full, so at
  // rest it holds only the pet and room for a speech bubble. It grows for the
  // action bar on hover and for the session panel when open.
  //
  // An earlier attempt at this flickered, because hover *ended* on a hit-test
  // that ran after the resize had moved the layout under a stationary cursor.
  // Hover now ends only when the main process sees the real cursor leave the
  // window, so resizing cannot feed back into it.
  const wide = Math.max(384, w + 56);
  return {
    collapsed: [Math.max(220, w + 56), h + 96],
    hover: [wide, h + 214],
    expanded: [wide, h + 452],
  };
}

/**
 * Keep the pet somewhere you can actually reach it.
 *
 * Anchors are stored in absolute screen coordinates, so unplugging a monitor,
 * changing resolution, or dragging into the gap between two displays can leave
 * the window parked off-screen with no way to grab it. This pulls it back.
 *
 * `strict` fully contains the window in one display's work area — used on
 * startup, on drop, and when the display layout changes. Non-strict only
 * insists that a decent chunk stays visible, so dragging between monitors
 * still feels free.
 */
function clampAnchor({ strict } = { strict: true }) {
  if (!anchor) return;
  const s = sizes();
  const [w, h] = panelOpen ? s.expanded : hovering ? s.hover : s.collapsed;
  const x = anchor.right - w;
  const y = anchor.bottom - h;

  let best = null;
  let bestVisible = 0;
  for (const d of screen.getAllDisplays()) {
    const a = d.workArea;
    const ix = Math.max(0, Math.min(x + w, a.x + a.width) - Math.max(x, a.x));
    const iy = Math.max(0, Math.min(y + h, a.y + a.height) - Math.max(y, a.y));
    const visible = ix * iy;
    if (visible > bestVisible) { bestVisible = visible; best = d; }
  }

  const need = strict ? 0.98 : 0.25;
  if (bestVisible >= w * h * need) return;          // enough of it is reachable

  const a = (best || screen.getPrimaryDisplay()).workArea;
  const nx = Math.min(Math.max(x, a.x), a.x + a.width - w);
  const ny = Math.min(Math.max(y, a.y), a.y + a.height - h);
  anchor = { right: nx + w, bottom: ny + h };
}

/** Park it back in the bottom-right of the display holding the cursor. */
function resetPosition() {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay();
  const a = d.workArea;
  anchor = { right: a.x + a.width - 24, bottom: a.y + a.height - 24 };
  settings.anchor = anchor;
  saveSettings();
  applyBounds();
  if (settings.minimized) updateSettings({ minimized: false });
}

function applyBounds() {
  if (!win || !anchor) return;
  clampAnchor({ strict: true });
  const s = sizes();
  const [w, h] = panelOpen ? s.expanded : hovering ? s.hover : s.collapsed;
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
  // A hidden window still runs its timers, so tell the renderer explicitly.
  win.webContents.send('paused', !!settings.minimized);
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

/**
 * Tray icons, cropped from the sprite sheet — built once per pet.
 *
 * This used to call nativeImage.createFromPath on every tray rebuild, which
 * decodes the whole sheet: 13.4 megapixels, ~51MB, on every state change. That
 * alone was the main process's CPU. Now the sheet is decoded once, every state
 * is cropped out of it, and the big image is dropped on the way out — leaving
 * a handful of 18x18 images.
 */
let iconCache = { petId: null, byState: new Map() };

function buildIconCache() {
  const byState = new Map();
  try {
    const sheet = nativeImage.createFromPath(pet.sheetPath);
    for (const [name, anim] of Object.entries(pet.animations || {})) {
      byState.set(name, sheet.crop({
        x: 0,
        y: anim.row * pet.frameHeight,
        width: pet.frameWidth,
        height: pet.frameHeight,
      }).resize({ width: 18, height: 18, quality: 'best' }));
    }
  } catch { /* fall through to an empty icon */ }
  return byState;                 // `sheet` goes out of scope here
}

function trayIcon(stateName) {
  if (!pet) return nativeImage.createEmpty();
  if (iconCache.petId !== pet.id) {
    iconCache = { petId: pet.id, byState: buildIconCache() };
  }
  return iconCache.byState.get(stateName)
    || iconCache.byState.get('idle')
    || nativeImage.createEmpty();
}

let traySignature = '';

function buildTray(snap) {
  if (!tray || !snap) return;
  const { sessions, counts, overall } = snap;

  // Rebuilding a Menu allocates the whole template. The tray only changes when
  // the state, the session list, or a checked setting does.
  const sig = JSON.stringify([
    overall,
    sessions.map((s) => [s.sessionId, s.state, s.display, s.reason]),
    settings.petId, settings.sizeScale, settings.animate,
    settings.notify, settings.minimized,
  ]);
  if (sig === traySignature) return;
  traySignature = sig;

  const sessionItems = sessions.length
    ? sessions.slice(0, 20).map((s) => ({
        label: `${{ needs_input: '!', blocked: '×', ready: '✓', running: '›', idle: '·' }[s.state]}  ${s.display || s.name}  —  ${TRAY_LABEL[s.state]}${s.reason ? ` (${s.reason})` : ''}`,
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
    {
      label: 'Tell me',
      submenu: [
        { label: 'A random fact', click: () => runFeed('fact') },
        { label: "Today's news", click: () => runFeed('news') },
      ],
    },
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
    { label: 'Reset position', click: resetPosition },
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
// sessionId -> the state we last shouted about. Persisted, because otherwise
// every relaunch re-announced every session that was already waiting.
const NOTIFIED_FILE = path.join(JARVIS_DIR, 'notified.json');
let lastNotified = new Map();
let notifySeeded = false;

function loadNotified() {
  try {
    lastNotified = new Map(Object.entries(JSON.parse(fs.readFileSync(NOTIFIED_FILE, 'utf8'))));
  } catch { lastNotified = new Map(); }
}

function saveNotified() {
  try {
    fs.mkdirSync(JARVIS_DIR, { recursive: true });
    fs.writeFileSync(NOTIFIED_FILE, JSON.stringify(Object.fromEntries(lastNotified)));
  } catch { /* not fatal */ }
}

function maybeNotify(snap) {
  // The first snapshot is the world as we found it, not news. Record it and
  // stay quiet, or opening the app shouts about everything already waiting.
  if (!notifySeeded) {
    notifySeeded = true;
    for (const s of snap.sessions) lastNotified.set(s.sessionId, s.state);
    saveNotified();
    return;
  }
  if (!settings.notify || !Notification.isSupported()) return;

  let dirty = false;
  for (const s of snap.sessions) {
    const prev = lastNotified.get(s.sessionId);
    if (prev === s.state) continue;   // already told you about this exact state
    lastNotified.set(s.sessionId, s.state);
    dirty = true;

    let title = null, body = null;
    if (s.state === 'needs_input') {
      title = `${s.display || s.name} needs you`;
      body = s.reason || 'waiting for your input';
    } else if (s.state === 'blocked') {
      title = `${s.display || s.name} is blocked`;
      body = s.reason || 'the turn ended with an error';
    } else if (s.state === 'ready' && prev === 'running') {
      title = `${s.display || s.name} finished`;
      body = s.message || 'ready for review';
    }
    if (!title) continue;

    const n = new Notification({ title, body, silent: !settings.sound });
    n.on('click', () => doFocus(s.sessionId));
    n.show();
  }

  const live = new Set(snap.sessions.map((s) => s.sessionId));
  for (const id of [...lastNotified.keys()]) {
    if (!live.has(id)) { lastNotified.delete(id); dirty = true; }
  }
  if (dirty) saveNotified();
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

// ------------------------------------------------------------------- feeds ---
let feedBusy = false;

async function runFeed(kind) {
  if (feedBusy) return null;
  feedBusy = true;
  if (!settings.minimized) win?.webContents.send('speak', { text: 'let me look…', ms: 2500 });
  try {
    const r = kind === 'news' ? await randomNews() : await randomFact();
    win?.webContents.send('speak', {
      text: r.text,
      meta: r.meta,
      url: r.url,
      // Headlines are long; give them time to actually be read.
      ms: Math.min(26000, 6000 + r.text.length * 90),
    });
    return r;
  } finally {
    feedBusy = false;
  }
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
    loadNotified();
    try {
      pet = loadPet(settings.petId);
    } catch {
      pet = loadPet('jarvis');
    }

    app.dock?.hide();                 // menubar accessory, no Dock icon

    state = new PetState().start();

    // Record the world as we found it, without announcing any of it. Sessions
    // already waiting when the app starts are not news, and re-announcing them
    // on every relaunch was the repeat-notification problem.
    for (const s of state.snapshot().sessions) lastNotified.set(s.sessionId, s.state);
    notifySeeded = true;
    saveNotified();

    createWindow();

    // A monitor being unplugged or rearranged can strand the window in
    // coordinates that no longer exist.
    for (const ev of ['display-removed', 'display-added', 'display-metrics-changed']) {
      screen.on(ev, () => {
        clampAnchor({ strict: true });
        applyBounds();
        settings.anchor = anchor;
        saveSettings();
      });
    }
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
          displays: screen.getAllDisplays().map((d) =>
            `${d.workArea.width}x${d.workArea.height} @ ${d.workArea.x},${d.workArea.y}`),
          anchor,
          windowRect: win.getBounds(),
          collapsed: sizes().collapsed,
          expanded: sizes().expanded,
        }, null, 2));
        app.exit(0);
      }, 3000);
    }
  });

  app.on('window-all-closed', (e) => e.preventDefault()); // tray app, stays alive
}

// ---------------------------------------------------------------------- IPC ---
let booted = false;
ipcMain.on('renderer-ready', () => {
  win?.webContents.send('pet', effectivePet());
  win?.webContents.send('settings', settings);
  push();
  // Play the pet's boot sequence once per launch, if it has one.
  if (!booted && pet?.boot && !settings.minimized) {
    booted = true;
    setTimeout(() => win?.webContents.send('action', pet.boot), 350);
  }
});
ipcMain.on('open-url', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});
ipcMain.handle('feed', (_e, kind) => runFeed(kind));
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
  // Loose clamp mid-drag: enough must stay visible to grab, but crossing
  // between monitors should not feel like it is fighting you.
  clampAnchor({ strict: false });
  const s = sizes();
  const [w, h] = panelOpen ? s.expanded : hovering ? s.hover : s.collapsed;
  win.setBounds({ x: Math.round(anchor.right - w), y: Math.round(anchor.bottom - h), width: w, height: h });
});
ipcMain.on('save-position', () => {
  clampAnchor({ strict: true });   // on drop, make sure all of it is on screen
  applyBounds();
  settings.anchor = anchor;
  saveSettings();
});
ipcMain.on('reset-position', resetPosition);
/**
 * Watch the real cursor while the hover bar is up.
 *
 * The overlay is click-through, so once the pointer moves off it onto another
 * app the window stops receiving mousemove entirely — the renderer never learns
 * the cursor left, and the buttons stayed up forever. `mouseleave` is not
 * reliable for a forwarded-event window either. So while the bar is showing,
 * poll the actual screen cursor and tell the renderer when it is outside.
 * Nothing runs when the bar is down.
 */
let hoverWatch = null;

let hoverWatchCount = 0;
ipcMain.on('hover-watch', (_e, on) => {
  if (process.env.JARVIS_DEBUG) console.log(`[hover-watch] ${on} (#${++hoverWatchCount})`);
  clearInterval(hoverWatch);
  hoverWatch = null;
  hovering = !!on;
  applyBounds();
  if (!on || !win) return;
  hoverWatch = setInterval(() => {
    if (!win || win.isDestroyed()) { clearInterval(hoverWatch); hoverWatch = null; return; }
    const b = win.getBounds();
    const p = screen.getCursorScreenPoint();
    const m = 12;   // a little slack, so a pixel of jitter at the edge is fine
    const inside = p.x >= b.x - m && p.x <= b.x + b.width + m &&
                   p.y >= b.y - m && p.y <= b.y + b.height + m;
    if (!inside) {
      clearInterval(hoverWatch);
      hoverWatch = null;
      win.webContents.send('hover-end');
    }
  }, 120);
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
  sizeMin: SIZE_MIN,
  sizeMax: SIZE_MAX,
  packaged: app.isPackaged,
  loginItem: app.isPackaged ? app.getLoginItemSettings().openAtLogin : false,
  petsDir: PETS_DIR,
  actions: Object.entries(pet?.actions || {}).map(([k, a]) => ({ key: k, label: a.label || k })),
  buttons: availableButtons(),
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
    invalidatePetList();
    updateSettings({ petId: r.name });
    return { ok: true, ...r };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('settings:action', (_e, key) => { win?.webContents.send('action', key); });
ipcMain.handle('settings:openPets', () => shell.openPath(PETS_DIR));
ipcMain.handle('settings:resetPosition', () => { resetPosition(); });
