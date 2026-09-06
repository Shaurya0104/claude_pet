#!/usr/bin/env node
'use strict';
/**
 * Real screenshots of the real UI, for the README.
 *
 * Run with `npm run shots`. Electron can capture its own windows with
 * capturePage(), so this needs no Screen Recording permission — these are the
 * actual renderer and settings pages, drawn by the actual CSS, just fed
 * example sessions instead of yours.
 */
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs');
const PRELOAD = path.join(ROOT, 'src', 'app', 'preload.js');
fs.mkdirSync(OUT, { recursive: true });

const pet = JSON.parse(fs.readFileSync(path.join(ROOT, 'pets', 'helmet', 'pet.json'), 'utf8'));
pet.dir = path.join(ROOT, 'pets', 'helmet');
pet.sheetUrl = `file://${path.join(pet.dir, pet.sheet)}`;
pet.scale = (pet.scale ?? 2) * 1;

const now = Date.now();
const mins = (n) => now - n * 60000;

// Example sessions — the shapes and states are real, the names are not yours.
const SESSIONS = [
  { sessionId: '1', pid: 101, name: 'api-server-4f', display: 'Rate limiter for the public API', project: 'api-server', cwd: '~/code/api-server', state: 'needs_input', label: 'needs you', reason: 'input needed', updatedAt: mins(2), version: '2.1.251' },
  { sessionId: '2', pid: 102, name: 'checkout-a9', display: 'Stripe webhook retries', project: 'checkout', cwd: '~/code/checkout', state: 'running', label: 'working', reason: null, updatedAt: mins(0.2), version: '2.1.251' },
  { sessionId: '3', pid: 103, name: 'billing sweep', display: 'billing sweep', renamed: true, project: 'billing', cwd: '~/code/billing', state: 'ready', label: 'ready', reason: null, message: 'Migrated 41 invoices and all tests pass.', updatedAt: mins(6), version: '2.1.251' },
  { sessionId: '4', pid: 104, name: 'infra-2c', display: 'Terraform module for the CDN', project: 'infra', cwd: '~/code/infra', state: 'blocked', label: 'blocked', reason: 'rate limited', updatedAt: mins(11), version: '2.1.251' },
  { sessionId: '5', pid: 105, name: 'docs-site-71', display: 'Search indexing on the docs site', project: 'docs-site', cwd: '~/code/docs-site', state: 'idle', label: 'idle', reason: null, updatedAt: mins(48), version: '2.1.251' },
  { sessionId: '6', pid: 106, name: 'mobile-8b', display: 'Offline queue for the mobile app', project: 'mobile', cwd: '~/code/mobile', state: 'idle', label: 'idle', reason: null, updatedAt: mins(180), version: '2.1.250' },
];

const SNAP = {
  overall: 'needs_input',
  sessions: SESSIONS,
  counts: { needs_input: 1, blocked: 1, ready: 1, running: 1, idle: 2 },
};

const SETTINGS = {
  petId: 'helmet', sizeScale: 1, animate: true, randomIdle: true,
  notify: true, sound: true, minimized: false, autoRestore: true,
  restoreOn: ['needs_input', 'blocked', 'ready'], buttons: {},
};

// --- stubs for what the pages ask the main process for ----------------------
ipcMain.on('renderer-ready', () => {});
for (const ch of ['ignore-mouse', 'focus-session', 'acknowledge', 'acknowledge-all',
                  'quit', 'minimize', 'open-settings', 'move-by', 'save-position',
                  'set-panel', 'hover-watch', 'open-url']) ipcMain.on(ch, () => {});
ipcMain.handle('feed', () => null);
ipcMain.handle('settings:get', () => ({
  settings: SETTINGS,
  pets: [
    { id: 'helmet', name: 'Helmet', source: 'colourised line art', frameWidth: pet.frameWidth, frameHeight: pet.frameHeight, baseScale: 0.5, rendering: 'auto', sheetWidth: 3584, sheetHeight: 3744, sheetUrl: pet.sheetUrl, animations: Object.keys(pet.animations) },
    { id: 'jarvis', name: 'Jarvis', source: 'drawn from primitives', frameWidth: 48, frameHeight: 48, baseScale: 2, rendering: 'pixelated', sheetWidth: 288, sheetHeight: 240, sheetUrl: `file://${path.join(ROOT, 'pets', 'jarvis', 'jarvis.png')}`, animations: ['idle', 'running', 'needs_input', 'ready', 'blocked'] },
  ],
  sizeSteps: [0.2, 0.4, 0.6, 0.8, 1, 1.25, 1.5, 2],
  sizeMin: 0.2, sizeMax: 2, packaged: true, loginItem: false,
  petsDir: path.join(ROOT, 'pets'),
  actions: Object.entries(pet.actions || {}).filter(([, a]) => a.label).map(([k, a]) => ({ key: k, label: a.label })),
  buttons: [
    ...Object.entries(pet.actions || {}).filter(([, a]) => a.label).map(([k, a]) => ({ key: k, label: a.label, enabled: true })),
    { key: 'fact', label: 'Fact', enabled: true },
    { key: 'news', label: 'News', enabled: true },
  ],
}));
for (const ch of ['settings:set', 'settings:loginItem', 'settings:pickImage',
                  'settings:importPet', 'settings:action', 'settings:openPets',
                  'settings:resetPosition']) ipcMain.handle(ch, () => SETTINGS);

/** Capture a window, trim fully transparent margins, and write it out. */
async function shoot(win, file, pad = 0) {
  const img = await win.webContents.capturePage();
  const { width, height } = img.getSize();
  const buf = img.toBitmap();                       // BGRA
  let minx = width, maxx = -1, miny = height, maxy = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (buf[(y * width + x) * 4 + 3] > 8) {
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
      }
    }
  }
  let out = img;
  if (maxx >= minx && maxy >= miny) {
    out = img.crop({
      x: Math.max(0, minx - pad),
      y: Math.max(0, miny - pad),
      width: Math.min(width, maxx - minx + 1 + pad * 2),
      height: Math.min(height, maxy - miny + 1 + pad * 2),
    });
  }
  fs.writeFileSync(path.join(OUT, file), out.toPNG());
  const s = out.getSize();
  console.log(`docs/${file}  ${s.width}x${s.height}`);
}

function overlayWindow(w, h) {
  return new BrowserWindow({
    width: w, height: h, show: false, frame: false, transparent: true,
    hasShadow: false, backgroundColor: '#00000000',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * loadFile can reject with ERR_FAILED when a previous window was torn down a
 * moment earlier, so give it a couple of tries.
 */
async function ready(win, file) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await win.loadFile(file);
      await wait(450);
      return;
    } catch (err) {
      if (attempt === 3) throw err;
      await wait(400);
    }
  }
}

/** Tear a window down and let Electron settle before the next one. */
async function close(win) {
  win.destroy();
  await wait(500);
}

// Destroying a window fires window-all-closed, whose default is to quit — which
// ended the run after the first shot.
app.on('window-all-closed', (e) => e.preventDefault());

app.whenReady().then(async () => {
  try {
  const overlayHtml = path.join(ROOT, 'src', 'app', 'renderer', 'index.html');

  // 1. the session panel, open
  {
    const win = overlayWindow(420, 620);
    await ready(win, overlayHtml);
    win.webContents.send('pet', pet);
    win.webContents.send('settings', SETTINGS);
    win.webContents.send('state', SNAP);
    await win.webContents.executeJavaScript('hovering = true; setPanel(true); renderActions(); null');
    await wait(700);
    await shoot(win, 'panel.png', 6);
    await close(win);
  }

  // 2. hover buttons over the pet
  {
    const win = overlayWindow(420, 340);
    await ready(win, overlayHtml);
    win.webContents.send('pet', pet);
    win.webContents.send('settings', SETTINGS);
    win.webContents.send('state', { ...SNAP, overall: 'running' });
    await win.webContents.executeJavaScript('hovering = true; renderActions(); null');
    await wait(700);
    await shoot(win, 'hover-buttons.png', 6);
    await close(win);
  }

  // 3. the speech bubble
  {
    const win = overlayWindow(420, 320);
    await ready(win, overlayHtml);
    win.webContents.send('pet', pet);
    win.webContents.send('settings', SETTINGS);
    win.webContents.send('state', { ...SNAP, overall: 'idle' });
    win.webContents.send('speak', {
      text: 'Octopuses have three hearts, and two of them stop beating when the animal swims.',
      meta: 'uselessfacts', url: 'https://example.com', ms: 60000,
    });
    await wait(700);
    await shoot(win, 'bubble.png', 6);
    await close(win);
  }

  // 4. settings
  {
    const win = new BrowserWindow({
      width: 460, height: 900, show: false, backgroundColor: '#12171c',
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
    });
    await ready(win, path.join(ROOT, 'src', 'app', 'settings', 'index.html'));
    await wait(900);
    // Grow the window to the full page, so nothing is cut off below the fold.
    const h = await win.webContents.executeJavaScript(
      'Math.ceil(document.documentElement.scrollHeight)');
    win.setSize(460, Math.min(2000, h + 24));
    await wait(600);
    await shoot(win, 'settings.png');
    await close(win);
  }

  } catch (err) {
    console.error('shot failed:', err.message);
    app.exit(1);
  }
  app.exit(0);
});
