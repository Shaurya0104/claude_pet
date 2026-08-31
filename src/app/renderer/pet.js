'use strict';
/**
 * Renderer: animates the sprite sheet, keeps the session panel in sync, and
 * hit-tests the cursor so the transparent parts of the window stay
 * click-through.
 */
const api = window.jarvis;

const els = {
  wrap: document.getElementById('pet-wrap'),
  pet: document.getElementById('pet'),
  badge: document.getElementById('badge'),
  bubble: document.getElementById('bubble'),
  bubbleText: document.getElementById('bubble-text'),
  actions: document.getElementById('actions'),
  panel: document.getElementById('panel'),
  list: document.getElementById('list'),
  title: document.getElementById('panel-title'),
  seenAll: document.getElementById('seen-all'),
  settings: document.getElementById('settings'),
  hide: document.getElementById('hide'),
  quit: document.getElementById('quit'),
};

let pet = null;
let opts = { animate: true, randomIdle: true };
let snap = { overall: 'idle', sessions: [], counts: {} };
let panelOpen = false;

// ------------------------------------------------------------ animation ---
let animName = 'idle';
let anim = null;
let frame = 0;
let timer = null;
let playingAction = false;   // a one-shot that returns to the state when done
let variantTimer = null;

function animFor(name) {
  return pet?.animations?.[name] || pet?.animations?.idle || null;
}

/**
 * Which row should represent `state` right now. Pets can declare variants —
 * several takes on the same state — and we rotate through them so a long idle
 * does not loop identically forever.
 */
function pickRow(state) {
  const variants = (pet?.variants?.[state] || []).filter((v) => pet?.animations?.[v]);
  if (opts.randomIdle && opts.animate && variants.length > 1) {
    return variants[Math.floor(Math.random() * variants.length)];
  }
  return pet?.animations?.[state] ? state : 'idle';
}

function applyPet(p) {
  pet = p;
  if (!p) return;
  const w = p.frameWidth * p.scale;
  const h = p.frameHeight * p.scale;
  els.wrap.style.width = `${w}px`;
  els.wrap.style.height = `${h}px`;
  els.pet.style.width = `${w}px`;
  els.pet.style.height = `${h}px`;
  els.pet.style.backgroundImage = `url("${p.sheetUrl}")`;
  // Pixel art wants nearest-neighbour; a downscaled detailed sprite wants
  // smoothing, or its edges crawl. The pet decides.
  els.pet.style.imageRendering = p.rendering || 'pixelated';

  const cols = Math.max(...Object.values(p.animations).map((a) => a.frames));
  const rows = Math.max(...Object.values(p.animations).map((a) => a.row)) + 1;
  els.pet.style.backgroundSize =
    `${p.frameWidth * cols * p.scale}px ${p.frameHeight * rows * p.scale}px`;

  renderActions();
  playingAction = false;
  setRow(pickRow(snap.overall));
}

function setRow(name, once = false) {
  const a = animFor(name);
  if (!a) return;
  animName = name;
  anim = a;
  playingAction = once;
  frame = 0;
  draw();
  schedule();
}

function draw() {
  if (!pet || !anim) return;
  const x = -frame * pet.frameWidth * pet.scale;
  const y = -anim.row * pet.frameHeight * pet.scale;
  els.pet.style.backgroundPosition = `${x}px ${y}px`;
}

/**
 * Step the sprite on a timer at the animation's own frame rate, not on
 * requestAnimationFrame.
 *
 * rAF fires 60 times a second no matter what the animation needs. Idle runs at
 * 4fps, so 56 of every 60 wakeups did nothing but keep the renderer's main
 * thread and the compositor hot. A single-frame animation, a paused one, or a
 * hidden window schedules nothing at all.
 */
function schedule() {
  clearTimeout(timer);
  if (document.hidden || !anim || anim.frames <= 1) return;
  // "Animate off" freezes the state rows, but a one-shot you asked for still
  // plays — you triggered it deliberately.
  if (!opts.animate && !playingAction) return;
  timer = setTimeout(step, 1000 / (anim.fps || 6));
}

function step() {
  frame++;
  if (frame >= anim.frames) {
    if (playingAction) { playingAction = false; setRow(pickRow(snap.overall)); return; }
    frame = 0;
  }
  draw();
  schedule();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(timer);
  else schedule();
});

/** Re-pick an idle variant every so often, so it stays alive without cost. */
function scheduleVariant() {
  clearTimeout(variantTimer);
  if (!opts.animate || !opts.randomIdle) return;
  variantTimer = setTimeout(() => {
    if (!playingAction && snap.overall === 'idle') setRow(pickRow('idle'));
    scheduleVariant();
  }, 10000 + Math.random() * 14000);
}

function playAction(key) {
  const a = pet?.actions?.[key];
  if (!a) return;
  setRow(a.animation || key, a.once !== false);
}

// --------------------------------------------------------------- bubbles ---
let bubbleTimer = null;

function say(text, ms = 4000) {
  if (!text) return;
  els.bubbleText.textContent = text;
  els.bubble.hidden = false;
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => { els.bubble.hidden = true; }, ms);
}

function lineFor(state) {
  const lines = pet?.bubbles?.[state];
  if (!lines || !lines.length) return null;
  return lines[Math.floor(Math.random() * lines.length)];
}

// --------------------------------------------------------------- actions ---
function renderActions() {
  els.actions.innerHTML = '';
  const entries = Object.entries(pet?.actions || {}).filter(([, a]) => a.label);
  if (!entries.length) { els.actions.hidden = true; return; }
  for (const [key, a] of entries) {
    const b = document.createElement('button');
    b.textContent = a.label;
    b.addEventListener('click', (e) => { e.stopPropagation(); playAction(key); });
    els.actions.appendChild(b);
  }
  els.actions.hidden = !panelOpen;
}

// ----------------------------------------------------------------- panel ---
function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const ORDER = { needs_input: 0, blocked: 1, ready: 2, running: 3, idle: 4 };

function renderPanel() {
  const sessions = [...snap.sessions].sort(
    (a, b) => ORDER[a.state] - ORDER[b.state] || (b.updatedAt || 0) - (a.updatedAt || 0)
  );

  els.title.textContent = `Sessions · ${sessions.length}`;
  els.list.innerHTML = '';

  if (!sessions.length) {
    const li = document.createElement('li');
    li.id = 'empty';
    li.textContent = 'no Claude Code sessions running';
    els.list.appendChild(li);
    return;
  }

  for (const s of sessions) {
    const li = document.createElement('li');
    li.className = s.state;

    const dot = document.createElement('div');
    dot.className = `dot ${s.state}`;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = s.name;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = s.reason
      ? `${s.project} — ${s.reason}`
      : s.message
        ? `${s.project} — ${s.message.replace(/\s+/g, ' ').slice(0, 60)}`
        : s.project;
    meta.append(name, sub);

    const age = document.createElement('div');
    age.className = 'age';
    age.textContent = ago(s.updatedAt);

    li.append(dot, meta, age);
    li.title = `${s.cwd}\npid ${s.pid} · ${s.version || ''}`;
    li.addEventListener('click', () => api.focus(s.sessionId));
    els.list.appendChild(li);
  }
}

function renderBadge() {
  const c = snap.counts || {};
  const n = (c.needs_input || 0) + (c.blocked || 0) + (c.ready || 0);
  if (!n) { els.badge.hidden = true; return; }
  els.badge.hidden = false;
  els.badge.textContent = String(n);
  els.badge.className = `state-${snap.overall}`;
}

function setPanel(open) {
  panelOpen = open;
  api.setPanel(open);
  els.panel.hidden = !open;
  els.actions.hidden = !open || !els.actions.childElementCount;
  if (open) { renderPanel(); els.bubble.hidden = true; }
}

// -------------------------------------------------------------- hit-test ---
// The window ignores mouse events (so clicks reach whatever is underneath),
// but `forward: true` keeps mousemove flowing here. We flip the flag off only
// while the cursor is genuinely over the pet or a panel.
let ignoring = true;

function setIgnore(next) {
  if (next === ignoring) return;
  ignoring = next;
  api.setIgnoreMouse(next);
}

function hitTest(x, y) {
  const el = document.elementFromPoint(x, y);
  setIgnore(!(el && el.closest('.interactive')));
}

document.addEventListener('mousemove', (e) => {
  if (!dragging) hitTest(e.clientX, e.clientY);
});
document.addEventListener('mouseleave', () => setIgnore(true));

// ---------------------------------------------------------------- dragging ---
let dragging = false;
let moved = false;
let originX = 0;
let originY = 0;

els.wrap.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  moved = false;
  originX = e.screenX;
  originY = e.screenY;
  els.wrap.classList.add('dragging');
});

window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const dx = e.screenX - originX;
  const dy = e.screenY - originY;
  if (Math.abs(dx) + Math.abs(dy) < 3) return;
  moved = true;
  originX = e.screenX;
  originY = e.screenY;
  api.moveBy(dx, dy);
});

window.addEventListener('mouseup', (e) => {
  if (!dragging) return;
  dragging = false;
  els.wrap.classList.remove('dragging');
  if (moved) { api.savePosition(); return; }
  // A click, not a drag: toggle the session panel and give a little reaction.
  setPanel(!panelOpen);
  if (pet?.actions?.poke) playAction('poke');
  // The window just resized under the cursor, so re-test rather than wait for
  // the next mousemove — otherwise the click-through state goes stale.
  requestAnimationFrame(() => hitTest(e.clientX, e.clientY));
});

els.seenAll.addEventListener('click', (e) => { e.stopPropagation(); api.acknowledgeAll(); });
els.settings.addEventListener('click', (e) => { e.stopPropagation(); api.openSettings(); });
els.hide.addEventListener('click', (e) => { e.stopPropagation(); setPanel(false); api.minimize(); });
els.quit.addEventListener('click', (e) => { e.stopPropagation(); api.quit(); });

// ------------------------------------------------------------------ alert ---
// A permanently running CSS animation keeps the compositor busy 60 times a
// second for as long as a session is waiting, which is most of the time. So
// nudge in short bursts on a long cycle: same "look at me", ~2% of the cost.
const NUDGE_MS = 2800;
const NUDGE_EVERY_MS = 30000;

let alerting = false;
let nudgeStop = null;
let nudgeCycle = null;

function burst() {
  els.wrap.classList.remove('nudging');
  void els.wrap.offsetWidth;            // reflow, so the animation restarts
  els.wrap.classList.add('nudging');
  clearTimeout(nudgeStop);
  nudgeStop = setTimeout(() => els.wrap.classList.remove('nudging'), NUDGE_MS);
}

function setAlert(on) {
  if (on === alerting) return;          // state pushes are frequent; only act on change
  alerting = on;
  clearInterval(nudgeCycle);
  clearTimeout(nudgeStop);
  els.wrap.classList.remove('nudging');
  if (!on || !opts.animate) return;
  burst();
  nudgeCycle = setInterval(burst, NUDGE_EVERY_MS);
}

// ------------------------------------------------------------------- wire ---
let prevOverall = 'idle';

api.onPet(applyPet);
api.onAction(playAction);

api.onSettings((s) => {
  const wasAnimate = opts.animate;
  opts = { ...opts, ...s };
  if (!opts.animate) { clearTimeout(timer); frame = 0; draw(); setAlert(false); }
  else if (!wasAnimate) { setRow(pickRow(snap.overall)); setAlert(alertingState()); }
  scheduleVariant();
});

function alertingState() {
  return snap.overall === 'needs_input' || snap.overall === 'blocked';
}

api.onState((s) => {
  const changed = s.overall !== prevOverall;
  snap = s;
  if (changed && !playingAction) setRow(pickRow(s.overall));
  renderBadge();
  setAlert(alertingState());
  if (panelOpen) renderPanel();

  if (changed && s.overall !== 'idle' && !panelOpen) {
    const blocking = s.sessions.find((x) => x.state === s.overall);
    say(blocking?.reason || lineFor(s.overall) || null);
  }
  prevOverall = s.overall;
});

scheduleVariant();
api.ready();
