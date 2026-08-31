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
  bubbleMeta: document.getElementById('bubble-meta'),
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
const ctx = els.pet.getContext('2d');
let sheet = null;          // decoded sprite sheet
let dw = 0, dh = 0;        // css pixels the pet occupies

let animName = 'idle';
let anim = null;
let frame = 0;
let timer = null;
let playingAction = false;   // a one-shot that returns to the state when done
let variantTimer = null;

function animFor(name) {
  return pet?.animations?.[name] || pet?.animations?.idle || null;
}

/** Which row represents `state`. States map straight to their own row. */
function pickRow(state) {
  return pet?.animations?.[state] ? state : 'idle';
}

function applyPet(p) {
  pet = p;
  if (!p) return;
  dw = Math.round(p.frameWidth * p.scale);
  dh = Math.round(p.frameHeight * p.scale);

  els.wrap.style.width = `${dw}px`;
  els.wrap.style.height = `${dh}px`;
  els.pet.style.width = `${dw}px`;
  els.pet.style.height = `${dh}px`;

  // Back the canvas at device resolution so it stays sharp on a Retina display.
  const dpr = window.devicePixelRatio || 1;
  els.pet.width = Math.round(dw * dpr);
  els.pet.height = Math.round(dh * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Pixel art wants nearest-neighbour; a downscaled detailed sprite wants
  // smoothing, or its edges crawl. The pet decides.
  ctx.imageSmoothingEnabled = (p.rendering || 'pixelated') !== 'pixelated';
  ctx.imageSmoothingQuality = 'high';

  const img = new Image();
  img.onload = () => { sheet = img; draw(); };
  img.onerror = () => console.log(`failed to load sheet: ${p.sheetUrl}`);
  img.src = p.sheetUrl;

  renderActions();
  playingAction = false;
  setRow(pickRow(snap.overall));
}

function setRow(name, once = false) {
  const a = animFor(name);
  if (!a) return;
  if (once) frozen = false;
  animName = name;
  anim = a;
  playingAction = once;
  frame = 0;
  draw();
  schedule();
}

function draw() {
  if (!pet || !anim || !sheet) return;
  ctx.clearRect(0, 0, dw, dh);
  ctx.drawImage(
    sheet,
    frame * pet.frameWidth, anim.row * pet.frameHeight,   // source frame
    pet.frameWidth, pet.frameHeight,
    0, 0, dw, dh                                          // destination
  );
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
  if (frozen && !playingAction) return;
  if (paused || document.hidden || !anim || anim.frames <= 1) return;
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

let paused = false;
api.onPaused((p) => {
  paused = !!p;
  if (paused) { clearTimeout(timer); clearInterval(nudgeCycle); clearTimeout(variantTimer); clearSettle(); }
  else { schedule(); scheduleFlourish(); armSettle(snap.overall); }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(timer);
  else schedule();
});

/**
 * Every few minutes, while genuinely idle, play one of the pet's livelier idle
 * rows once and then settle back. Rotating them continuously made the pet look
 * restless; a rare flourish reads as alive rather than fidgety.
 */
const FLOURISH_MIN_MS = 90000;    // 1.5 minutes
const FLOURISH_MAX_MS = 240000;   // 4 minutes

function scheduleFlourish() {
  clearTimeout(variantTimer);
  if (paused || !opts.animate || !opts.randomIdle) return;
  const wait = FLOURISH_MIN_MS + Math.random() * (FLOURISH_MAX_MS - FLOURISH_MIN_MS);
  variantTimer = setTimeout(() => {
    const list = (pet?.flourishes?.[snap.overall] || []).filter((n) => pet?.animations?.[n]);
    if (list.length && !playingAction && snap.overall === 'idle' && !paused) {
      setRow(list[Math.floor(Math.random() * list.length)], true);
    }
    scheduleFlourish();
  }, wait);
}

/**
 * Alerts should be loud when they happen and quiet once you have had a chance
 * to see them.
 *
 * A session can sit in `needs_input` for days. Animating that the whole time is
 * exhausting to sit next to, but going silent loses the signal. So after a
 * minute the sprite freezes on its first frame — the badge and the colour still
 * say what is going on — and every so often it plays for a few seconds as a
 * reminder.
 */
const SETTLE_AFTER_MS = 60000;
const REMIND_EVERY_MS = 90000;
const REMIND_FOR_MS = 4000;

let settleTimer = null;
let remindTimer = null;
let frozen = false;

function clearSettle() {
  clearTimeout(settleTimer); settleTimer = null;
  clearTimeout(remindTimer); remindTimer = null;
  frozen = false;
}

function freeze() {
  frozen = true;
  clearTimeout(timer);
  frame = 0;
  draw();
  remindTimer = setTimeout(remind, REMIND_EVERY_MS);
}

function remind() {
  if (!frozen || paused) return;
  frozen = false;
  frame = 0;
  schedule();
  remindTimer = setTimeout(() => { if (!playingAction) freeze(); }, REMIND_FOR_MS);
}

/** Called whenever the overall state changes. */
function armSettle(state) {
  clearSettle();
  if (!opts.animate) return;
  if (!(pet?.settles || []).includes(state)) return;
  settleTimer = setTimeout(() => { if (!playingAction) freeze(); }, SETTLE_AFTER_MS);
}

function playAction(key) {
  const a = pet?.actions?.[key];
  if (!a) return;
  setRow(a.animation || key, a.once !== false);
}

// --------------------------------------------------------------- bubbles ---
let bubbleTimer = null;
let bubbleUrl = null;

/**
 * @param {string} text
 * @param {object} [o] { ms, meta, url } — a url makes the bubble clickable,
 *                     and interactive so the click actually reaches us.
 */
function say(text, o = {}) {
  if (!text) return;
  els.bubbleText.textContent = text;
  els.bubbleMeta.textContent = o.meta || '';
  els.bubbleMeta.hidden = !o.meta;
  bubbleUrl = o.url || null;
  els.bubble.classList.toggle('linked', !!bubbleUrl);
  els.bubble.classList.toggle('interactive', !!bubbleUrl);
  els.bubble.hidden = false;
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(hideBubble, o.ms || 4000);
}

function hideBubble() {
  els.bubble.hidden = true;
  els.bubble.classList.remove('interactive', 'linked');
  bubbleUrl = null;
}

els.bubble.addEventListener('click', (e) => {
  e.stopPropagation();
  if (bubbleUrl) { api.openUrl(bubbleUrl); hideBubble(); }
});

function lineFor(state) {
  const lines = pet?.bubbles?.[state];
  if (!lines || !lines.length) return null;
  return lines[Math.floor(Math.random() * lines.length)];
}

// --------------------------------------------------------------- actions ---
function addButton(label, onClick, title) {
  const b = document.createElement('button');
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(b); });
  els.actions.appendChild(b);
  return b;
}

/** Buttons you have switched off in Settings never get built. */
function wanted(key) {
  return opts.buttons?.[key] !== false;
}

function renderActions() {
  els.actions.innerHTML = '';

  // The pet's own one-shot animations, whichever of them carry a label.
  for (const [key, a] of Object.entries(pet?.actions || {})) {
    if (a.label && wanted(key)) addButton(a.label, () => playAction(key));
  }

  // Not animations: these go and fetch something for the pet to say.
  if (wanted('fact')) {
    addButton('Fact', async (b) => {
      b.disabled = true;
      try { await api.feed('fact'); } finally { b.disabled = false; }
    }, 'A random fact, from a different source each time');
  }
  if (wanted('news')) {
    addButton('News', async (b) => {
      b.disabled = true;
      try { await api.feed('news'); } finally { b.disabled = false; }
    }, 'A headline, from a different outlet each time');
  }

  // Keep the grid tidy when there are three or fewer.
  const n = els.actions.childElementCount;
  els.actions.style.gridTemplateColumns = `repeat(${Math.min(3, Math.max(1, n))}, 1fr)`;
  els.actions.style.width = n <= 3 ? 'auto' : '268px';

  els.actions.hidden = !hovering || n === 0;
  console.log(`actions: ${n} [${[...els.actions.children].map((b) => b.textContent).join(', ')}]`);
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
  els.actions.hidden = !hovering || !els.actions.childElementCount;
  if (open) { renderPanel(); hideBubble(); }
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
  const over = !!(el && el.closest('.interactive'));
  setIgnore(!over);
  // The hover zone is deliberately wider than the interactive elements, so
  // travelling between the pet and the buttons does not drop the hover.
  const stage = document.getElementById('stage').getBoundingClientRect();
  setHover(over || (x >= stage.left - 8 && x <= stage.right + 8 &&
                    y >= stage.top - 8 && y <= stage.bottom + 8));
}

document.addEventListener('mousemove', (e) => {
  if (!dragging) hitTest(e.clientX, e.clientY);
});
document.addEventListener('mouseleave', () => { setIgnore(true); setHover(false); });

// --------------------------------------------------------------- hovering ---
// The action buttons sit above the pet and appear on hover, so they are
// reachable without opening the session panel.
//
// This used to ask the main process to grow the window on hover. That fed back
// into the hit-test: the resize moved the layout under a stationary cursor, the
// next mousemove landed on empty space, and the bar hid itself again. The
// window is now always big enough and hovering only toggles a class.
let hovering = false;
let hoverOff = null;

function setHover(on) {
  if (on) {
    clearTimeout(hoverOff);
    hoverOff = null;
    if (hovering) return;
    hovering = true;
    showActions(true);
    api.hoverWatch(true);      // main watches the real cursor from here
    return;
  }
  if (!hovering || hoverOff) return;
  // Leaving is delayed: the pet and the buttons are separate boxes with a gap
  // between them, and the cursor crosses that gap on the way to a button.
  hoverOff = setTimeout(endHover, 400);
}

function endHover() {
  clearTimeout(hoverOff);
  hoverOff = null;
  if (!hovering) return;
  hovering = false;
  showActions(false);
  api.hoverWatch(false);
}

// The overlay stops receiving mousemove the moment the cursor moves onto
// another window, so the main process tells us when it has really left.
api.onHoverEnd(endHover);

// The bar is tied to hovering the pet and nothing else — opening the session
// panel no longer pins it open.
function showActions(on) {
  els.actions.hidden = !(on && els.actions.childElementCount);
}

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
  if (!on || !opts.animate || paused) return;
  burst();
  nudgeCycle = setInterval(burst, NUDGE_EVERY_MS);
}

// ------------------------------------------------------------------- wire ---
let prevOverall = 'idle';

api.onPet(applyPet);
api.onAction(playAction);
api.onSpeak((m) => say(m.text, m));

api.onSettings((s) => {
  const wasAnimate = opts.animate;
  const prevButtons = JSON.stringify(opts.buttons || {});
  opts = { ...opts, ...s };
  if (JSON.stringify(opts.buttons || {}) !== prevButtons) renderActions();
  if (!opts.animate) { clearSettle(); clearTimeout(timer); frame = 0; draw(); setAlert(false); }
  else if (!wasAnimate) { setRow(pickRow(snap.overall)); armSettle(snap.overall); setAlert(alertingState()); }
  scheduleFlourish();
});

function alertingState() {
  return snap.overall === 'needs_input' || snap.overall === 'blocked';
}

api.onState((s) => {
  const changed = s.overall !== prevOverall;
  snap = s;
  if (changed) armSettle(s.overall);
  if (changed && !playingAction) setRow(pickRow(s.overall));
  renderBadge();
  setAlert(alertingState());
  if (panelOpen) renderPanel();

  if (changed && s.overall !== 'idle' && !panelOpen) {
    const blocking = s.sessions.find((x) => x.state === s.overall);
    say(blocking?.reason || lineFor(s.overall) || null, { ms: 4000 });
  }
  prevOverall = s.overall;
});

scheduleFlourish();
api.ready();
