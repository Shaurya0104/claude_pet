#!/usr/bin/env node
'use strict';
/**
 * Builds the macOS app icon from the same drawing code as the sprite sheet,
 * then hands it to iconutil for the .icns. Nearest-neighbour upscaling keeps
 * the pixels crisp instead of smearing them.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Canvas } = require('./lib/pixel');
const { FRAME, drawPet } = require('./lib/art');

const SIZE = 1024;
const BUILD = path.join(__dirname, '..', 'build');
fs.mkdirSync(BUILD, { recursive: true });

// The pet on its own, no ground shadow — the icon has its own plate.
const pet = new Canvas(FRAME, FRAME);
drawPet(pet, 0, 0, { bob: 0, eyes: 'open', shadow: false });

const icon = new Canvas(SIZE, SIZE);

// macOS rounded-square plate with a soft vertical gradient.
const inset = 60;
const plate = SIZE - inset * 2;
for (let y = 0; y < plate; y++) {
  const t = y / plate;
  const col = [
    Math.round(0x14 + (0x1d - 0x14) * t),
    Math.round(0x2b + (0x4a - 0x2b) * t),
    Math.round(0x3a + (0x63 - 0x3a) * t),
    255,
  ];
  const row = new Canvas(plate, 1);
  row.rect(0, 0, plate, 1, col);
  // Reuse roundRect's corner test by masking against a full-plate stencil.
  for (let x = 0; x < plate; x++) {
    const r = 210;
    const dx = Math.max(r - x, x - (plate - 1 - r), 0);
    const dy = Math.max(r - y, y - (plate - 1 - r), 0);
    if (dx * dx + dy * dy <= r * r) icon.px(inset + x, inset + y, col);
  }
}

// Pet centred, scaled with nearest neighbour.
const scale = 15;
const w = FRAME * scale;
icon.blitScaled(pet, Math.round((SIZE - w) / 2), Math.round((SIZE - w) / 2) + 20, scale);

const png = path.join(BUILD, 'icon.png');
fs.writeFileSync(png, icon.png());
console.log(`wrote ${png} (${SIZE}x${SIZE})`);

// .icns via the system toolchain.
const iconset = path.join(BUILD, 'icon.iconset');
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset);

const SIZES = [16, 32, 128, 256, 512];
for (const s of SIZES) {
  for (const [px, name] of [[s, `icon_${s}x${s}.png`], [s * 2, `icon_${s}x${s}@2x.png`]]) {
    execFileSync('sips', ['-z', String(px), String(px), png, '--out', path.join(iconset, name)], {
      stdio: 'ignore',
    });
  }
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(BUILD, 'icon.icns')]);
fs.rmSync(iconset, { recursive: true, force: true });
console.log(`wrote ${path.join(BUILD, 'icon.icns')}`);
