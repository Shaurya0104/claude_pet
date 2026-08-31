#!/usr/bin/env node
'use strict';
/**
 * Builds the macOS app icon, then hands it to iconutil for the .icns.
 *
 *   node tools/make-icon.js            use the pet named in settings
 *   node tools/make-icon.js helmet     use a specific pet
 *
 * A pet can ship an `icon.png` — a large, clean render of itself — and we use
 * that. Otherwise we draw the built-in sprite with nearest-neighbour scaling,
 * which keeps pixel art crisp instead of smearing it.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { Canvas } = require('./lib/pixel');
const { decode } = require('./lib/png-decode');
const { FRAME, drawPet } = require('./lib/art');

const SIZE = 1024;
const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
fs.mkdirSync(BUILD, { recursive: true });

/** Which pet should the app wear? CLI arg, else settings, else the helmet. */
function chosenPet() {
  if (process.argv[2]) return process.argv[2];
  try {
    const s = JSON.parse(fs.readFileSync(
      path.join(os.homedir(), '.claude', 'jarvis', 'settings.json'), 'utf8'));
    if (s.petId) return s.petId;
  } catch { /* no settings yet */ }
  return 'helmet';
}

const petId = chosenPet();
const petDir = path.join(ROOT, 'pets', petId);
const icon = new Canvas(SIZE, SIZE);

// macOS rounded-square plate with a soft vertical gradient.
const inset = 60;
const plate = SIZE - inset * 2;
const radius = 210;
for (let y = 0; y < plate; y++) {
  const t = y / plate;
  const col = [
    Math.round(0x14 + (0x1d - 0x14) * t),
    Math.round(0x2b + (0x4a - 0x2b) * t),
    Math.round(0x3a + (0x63 - 0x3a) * t),
    255,
  ];
  for (let x = 0; x < plate; x++) {
    const dx = Math.max(radius - x, x - (plate - 1 - radius), 0);
    const dy = Math.max(radius - y, y - (plate - 1 - radius), 0);
    if (dx * dx + dy * dy <= radius * radius) icon.px(inset + x, inset + y, col);
  }
}

const artwork = path.join(petDir, 'icon.png');
let how;

if (fs.existsSync(artwork)) {
  // A purpose-made render: fit it inside the plate with breathing room.
  const src = decode(artwork);
  const maxH = Math.round(plate * 0.80);
  const maxW = Math.round(plate * 0.80);
  const scale = Math.min(maxW / src.w, maxH / src.h);
  const fitted = src.downscale(Math.round(src.w * scale), Math.round(src.h * scale));
  icon.blitScaled(fitted, Math.round((SIZE - fitted.w) / 2), Math.round((SIZE - fitted.h) / 2), 1);
  how = `${petId}/icon.png (${src.w}x${src.h} -> ${fitted.w}x${fitted.h})`;
} else {
  // Fall back to the built-in drawn pet, scaled with nearest neighbour.
  const pet = new Canvas(FRAME, FRAME);
  drawPet(pet, 0, 0, { bob: 0, eyes: 'open', shadow: false });
  const scale = 15;
  const w = FRAME * scale;
  icon.blitScaled(pet, Math.round((SIZE - w) / 2), Math.round((SIZE - w) / 2) + 20, scale);
  how = 'built-in drawn pet';
}

const png = path.join(BUILD, 'icon.png');
fs.writeFileSync(png, icon.png());
console.log(`icon source: ${how}`);
console.log(`wrote ${png} (${SIZE}x${SIZE})`);

// .icns via the system toolchain.
const iconset = path.join(BUILD, 'icon.iconset');
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset);
for (const s of [16, 32, 128, 256, 512]) {
  for (const [px, name] of [[s, `icon_${s}x${s}.png`], [s * 2, `icon_${s}x${s}@2x.png`]]) {
    execFileSync('sips', ['-z', String(px), String(px), png, '--out', path.join(iconset, name)], { stdio: 'ignore' });
  }
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(BUILD, 'icon.icns')]);
fs.rmSync(iconset, { recursive: true, force: true });
console.log(`wrote ${path.join(BUILD, 'icon.icns')}`);
