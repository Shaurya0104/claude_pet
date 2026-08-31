'use strict';
/**
 * Turn an image file into a pet folder. Used by both `npm run add-pet` and the
 * "Add your own" button in Settings, so the two can never drift apart.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PETS_DIR } = require('./paths');

const STATES = ['idle', 'running', 'needs_input', 'ready', 'blocked'];
const DEFAULT_FPS = { idle: 4, running: 12, needs_input: 6, ready: 5, blocked: 3 };

/** PNG dimensions live in the IHDR chunk — no decoder needed. */
function pngSize(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(24);
  fs.readSync(fd, head, 0, 24, 0);
  fs.closeSync(fd);
  if (head.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
}

/**
 * @param {object} o
 * @param {string} o.image      source image (png, or anything sips can convert)
 * @param {number} o.cols       frames across
 * @param {number} o.rows       rows down
 * @param {string} [o.name]     folder name; defaults to the file's basename
 * @param {number} [o.scale]    render scale; guessed from the frame size
 * @param {number[]} [o.frames] per-row frame counts, when rows differ
 * @param {string} [o.rendering] 'pixelated' | 'auto'
 */
function importPet(o) {
  if (!fs.existsSync(o.image)) throw new Error(`no such file: ${o.image}`);
  const cols = Number(o.cols), rows = Number(o.rows);
  if (!cols || !rows || cols < 1 || rows < 1) throw new Error('cols and rows must both be at least 1');

  const name = (o.name || path.basename(o.image, path.extname(o.image)))
    .replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'pet';
  const dir = path.join(PETS_DIR, name);
  fs.mkdirSync(dir, { recursive: true });

  // Normalise to PNG so the sheet always has an alpha channel available.
  const sheet = `${name}.png`;
  const dest = path.join(dir, sheet);
  if (path.extname(o.image).toLowerCase() === '.png') fs.copyFileSync(o.image, dest);
  else execFileSync('sips', ['-s', 'format', 'png', o.image, '--out', dest], { stdio: 'ignore' });

  const size = pngSize(dest);
  if (!size) throw new Error('could not read the image dimensions');

  const frameWidth = Math.floor(size.w / cols);
  const frameHeight = Math.floor(size.h / rows);
  const scale = Number(o.scale) || (frameWidth <= 32 ? 3 : frameWidth <= 64 ? 2 : frameWidth <= 128 ? 1 : 0.5);

  const animations = {};
  STATES.forEach((state, i) => {
    const row = i < rows ? i : 0;                       // reuse row 0 if the sheet is short
    animations[state] = { row, frames: o.frames?.[row] ?? cols, fps: DEFAULT_FPS[state] };
  });

  const manifest = {
    id: name,
    name: name.replace(/(^|-)(\w)/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase()),
    sheet,
    source: o.source || 'imported — record where you got it and its licence',
    frameWidth,
    frameHeight,
    scale,
    rendering: o.rendering || (frameWidth <= 96 ? 'pixelated' : 'auto'),
    animations,
    bubbles: {
      needs_input: ['I need you', 'waiting on you'],
      ready: ['all done', 'have a look'],
      blocked: ['something broke', "I'm stuck"],
    },
  };

  fs.writeFileSync(path.join(dir, 'pet.json'), JSON.stringify(manifest, null, 2) + '\n');

  return {
    name, dir, sheetPath: dest,
    width: size.w, height: size.h,
    frameWidth, frameHeight, scale,
    even: size.w % cols === 0 && size.h % rows === 0,
    animations,
  };
}

module.exports = { importPet, pngSize, STATES, DEFAULT_FPS };
