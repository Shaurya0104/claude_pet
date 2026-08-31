'use strict';
const api = window.jarvis.settings;

const $ = (id) => document.getElementById(id);
const STATE_LABEL = {
  needs_input: 'needs input',
  blocked: 'blocked',
  ready: 'ready',
  running: 'working',
};

let cfg = null;      // { settings, pets, sizeSteps, packaged, loginItem, actions }
let importFile = null;

// -------------------------------------------------------------- rendering ---
function renderPets() {
  const box = $('pets');
  box.innerHTML = '';
  for (const p of cfg.pets) {
    const card = document.createElement('div');
    card.className = 'pet-card' + (p.id === cfg.settings.petId ? ' active' : '');

    // Thumbnail: frame 0 only. Scale the whole sheet by `fit` and keep the
    // background pinned at the origin, so exactly one frame lands in the box.
    const THUMB_W = 80, THUMB_H = 62;
    const fit = Math.min(THUMB_W / p.frameWidth, THUMB_H / p.frameHeight);
    const thumb = document.createElement('div');
    thumb.className = 'pet-thumb';
    thumb.style.width = `${Math.round(p.frameWidth * fit)}px`;
    thumb.style.height = `${Math.round(p.frameHeight * fit)}px`;
    thumb.style.margin = '0 auto 6px';
    thumb.style.backgroundImage = `url("${p.sheetUrl}")`;
    thumb.style.backgroundRepeat = 'no-repeat';
    thumb.style.backgroundPosition = '0 0';
    thumb.style.backgroundSize = `${p.sheetWidth * fit}px ${p.sheetHeight * fit}px`;
    thumb.style.imageRendering = p.rendering === 'auto' ? 'auto' : 'pixelated';

    const name = document.createElement('div');
    name.className = 'pet-name';
    name.textContent = p.name;

    const meta = document.createElement('div');
    meta.className = 'pet-meta';
    meta.textContent = `${p.frameWidth}×${p.frameHeight} · ${p.animations.length} anims`;

    card.append(thumb, name, meta);
    card.title = p.source || p.id;
    card.addEventListener('click', () => set({ petId: p.id }));
    box.appendChild(card);
  }
}

function renderSizes() {
  const box = $('sizes');
  box.innerHTML = '';
  for (const s of cfg.sizeSteps) {
    const b = document.createElement('button');
    b.className = 'chip' + (Math.abs(s - cfg.settings.sizeScale) < 0.001 ? ' active' : '');
    b.textContent = `${Math.round(s * 100)}%`;
    b.addEventListener('click', () => set({ sizeScale: s }));
    box.appendChild(b);
  }
}

function renderRestoreOn() {
  const box = $('restore-on');
  box.innerHTML = '';
  const on = cfg.settings.restoreOn || [];
  for (const key of ['needs_input', 'blocked', 'ready', 'running']) {
    const b = document.createElement('button');
    b.className = 'chip' + (on.includes(key) ? ' active' : '');
    b.textContent = STATE_LABEL[key];
    b.disabled = !cfg.settings.autoRestore;
    b.addEventListener('click', () => {
      const next = on.includes(key) ? on.filter((k) => k !== key) : [...on, key];
      set({ restoreOn: next });
    });
    box.appendChild(b);
  }
}

function renderActions() {
  const section = $('actions-section');
  const box = $('actions');
  box.innerHTML = '';
  if (!cfg.actions?.length) { section.hidden = true; return; }
  section.hidden = false;
  for (const a of cfg.actions) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = a.label;
    b.addEventListener('click', () => api.action(a.key));
    box.appendChild(b);
  }
}

function renderToggles() {
  for (const key of ['animate', 'randomIdle', 'notify', 'sound', 'minimized', 'autoRestore']) {
    $(key).checked = !!cfg.settings[key];
  }
  $('sound').disabled = !cfg.settings.notify;
  $('loginItem').checked = !!cfg.loginItem;
  $('loginItem').disabled = !cfg.packaged;
  $('loginItem-note').textContent = cfg.packaged
    ? 'Starts hidden in the menubar.'
    : 'Only available in the built app (npm run build).';
}

function renderAll() {
  renderPets();
  renderSizes();
  renderRestoreOn();
  renderActions();
  renderToggles();
}

// ------------------------------------------------------------------ wiring ---
async function set(patch) {
  cfg.settings = await api.set(patch);
  renderAll();
}

for (const key of ['animate', 'randomIdle', 'notify', 'sound', 'minimized', 'autoRestore']) {
  $(key).addEventListener('change', (e) => set({ [key]: e.target.checked }));
}

$('loginItem').addEventListener('change', async (e) => {
  cfg.loginItem = await api.loginItem(e.target.checked);
  renderToggles();
});

$('open-pets').addEventListener('click', () => api.openPets());

$('add-pet').addEventListener('click', async () => {
  const file = await api.pickImage();
  if (!file) return;
  importFile = file;
  $('import-file').textContent = file.split('/').pop();
  $('petname').value = '';
  $('import-error').hidden = true;
  $('import').hidden = false;
  $('import').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

$('cancel-import').addEventListener('click', () => { $('import').hidden = true; importFile = null; });

$('do-import').addEventListener('click', async () => {
  if (!importFile) return;
  const r = await api.importPet({
    image: importFile,
    cols: Number($('cols').value),
    rows: Number($('rows').value),
    name: $('petname').value.trim() || undefined,
    scale: Number($('petscale').value) || undefined,
  });
  if (!r.ok) {
    $('import-error').textContent = r.error;
    $('import-error').hidden = false;
    return;
  }
  $('import').hidden = true;
  importFile = null;
  cfg = await api.get();
  renderAll();
  $('status').textContent =
    `imported ${r.name} — ${r.frameWidth}×${r.frameHeight} frames` + (r.even ? '' : ' (grid does not divide evenly)');
});

window.jarvis.onSettings((s) => { if (cfg) { cfg.settings = s; renderAll(); } });

window.jarvis.onState((snap) => {
  const n = snap.sessions.length;
  $('status').textContent = `${n} session${n === 1 ? '' : 's'} · ${snap.counts.needs_input} need you`;
});

(async () => {
  cfg = await api.get();
  renderAll();
})();
