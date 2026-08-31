#!/usr/bin/env node
'use strict';
/**
 * Builds the images used in the README, straight from the generated sprite
 * sheet — so they are the real frames the app draws, and they refresh whenever
 * the art does. Run with `npm run docs`.
 */
const fs = require('fs');
const path = require('path');
const { Canvas } = require('./lib/pixel');
const { decode } = require('./lib/png-decode');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs');
fs.mkdirSync(OUT, { recursive: true });

const pet = JSON.parse(fs.readFileSync(path.join(ROOT, 'pets', 'helmet', 'pet.json'), 'utf8'));
const sheet = decode(path.join(ROOT, 'pets', 'helmet', 'helmet.png'));
const FW = pet.frameWidth, FH = pet.frameHeight;

const BG = [15, 17, 21, 255];
const PANEL = [22, 25, 30, 255];

/** Pull one frame and scale it to a target height. */
function frame(row, col, h) {
  const src = sheet.crop(col * FW, row * FH, FW, FH);
  return src.downscale(Math.round((h * FW) / FH), h);
}

/** A row of frames on a dark strip, evenly spaced. */
function strip(items, h, gap, pad, file, bg = BG) {
  const cells = items.map(({ row, col }) => frame(row, col, h));
  const w = pad * 2 + cells.reduce((a, c) => a + c.w, 0) + gap * (cells.length - 1);
  const out = new Canvas(w, h + pad * 2);
  out.rect(0, 0, out.w, out.h, bg);
  let x = pad;
  for (const c of cells) { out.blitScaled(c, x, pad, 1); x += c.w + gap; }
  fs.writeFileSync(path.join(OUT, file), out.png());
  console.log(`docs/${file}  ${out.w}x${out.h}`);
}

// --- the five states, side by side -----------------------------------------
strip(
  ['idle', 'running', 'needs_input', 'ready', 'blocked'].map((name) => ({
    row: pet.animations[name].row,
    // Pick the frame that shows the state at its most characteristic:
    // needs_input on the frame carrying its exclamation mark, ready mid-shimmer.
    col: { idle: 0, running: 1, needs_input: 0, ready: 2, blocked: 0 }[name] ?? 0,
  })),
  180, 14, 18, 'states.png'
);

// --- the boot sequence ------------------------------------------------------
{
  const a = pet.animations.boot;
  const pick = [0, 2, 3, 4, 5, 6, 8, 10, 12, a.frames - 1].filter((i) => i < a.frames);
  strip(pick.map((col) => ({ row: a.row, col })), 132, 6, 14, 'boot.png');
}

// --- the arc blast ----------------------------------------------------------
{
  const a = pet.animations.arc_blast;
  strip([...Array(a.frames).keys()].map((col) => ({ row: a.row, col })), 132, 6, 14, 'arc-blast.png');
}

// --- one big hero shot ------------------------------------------------------
{
  const h = 420;
  const c = frame(pet.animations.idle.row, 0, h);
  const out = new Canvas(c.w + 80, h + 80);
  // soft radial ground so it doesn't float on a flat block
  for (let y = 0; y < out.h; y++) {
    for (let x = 0; x < out.w; x++) {
      const d = Math.hypot((x - out.w / 2) / (out.w / 2), (y - out.h / 2) / (out.h / 2));
      const t = Math.max(0, 1 - d);
      out.px(x, y, [
        Math.round(BG[0] + t * 16), Math.round(BG[1] + t * 20), Math.round(BG[2] + t * 26), 255,
      ]);
    }
  }
  out.blitScaled(c, 40, 40, 1);
  fs.writeFileSync(path.join(OUT, 'hero.png'), out.png());
  console.log(`docs/hero.png  ${out.w}x${out.h}`);
}

// --- every animation row, one frame each ------------------------------------
{
  const names = Object.keys(pet.animations);
  const h = 96, gap = 8, pad = 14, perRow = 7;
  const cells = names.map((n) => frame(pet.animations[n].row, 0, h));
  const cw = cells[0].w;
  const rows = Math.ceil(names.length / perRow);
  const out = new Canvas(pad * 2 + perRow * cw + (perRow - 1) * gap, pad * 2 + rows * h + (rows - 1) * gap);
  out.rect(0, 0, out.w, out.h, PANEL);
  cells.forEach((c, i) => {
    const r = Math.floor(i / perRow), col = i % perRow;
    out.blitScaled(c, pad + col * (cw + gap), pad + r * (h + gap), 1);
  });
  fs.writeFileSync(path.join(OUT, 'animations.png'), out.png());
  console.log(`docs/animations.png  ${out.w}x${out.h}  (${names.length} rows: ${names.join(', ')})`);
}
