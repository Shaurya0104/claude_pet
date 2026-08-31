#!/usr/bin/env node
'use strict';
/**
 * Turn a downloaded sprite sheet into a Jarvis pet.
 *
 *   node tools/add-pet.js <image.png> --cols 6 --rows 5 [--name foxy] [--scale 2]
 *   node tools/add-pet.js foxy.png --cols 8 --rows 4 --frames 4,8,4,6
 *
 * Reads the PNG header for its real dimensions, works out the frame size,
 * scaffolds pets/<name>/pet.json, and copies the sheet in. Any uniform grid
 * works — rows do not have to be in our order, and you can remap them by
 * editing the generated pet.json afterwards.
 */
const fs = require('fs');
const path = require('path');

const STATES = ['idle', 'running', 'needs_input', 'ready', 'blocked'];
const DEFAULT_FPS = { idle: 4, running: 12, needs_input: 6, ready: 5, blocked: 3 };

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** PNG dimensions live in the IHDR chunk — no decoder needed. */
function pngSize(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(24);
  fs.readSync(fd, head, 0, 24, 0);
  fs.closeSync(fd);
  if (head.readUInt32BE(0) !== 0x89504e47) {
    throw new Error(`${file} is not a PNG. Convert it first (Piskel, Aseprite, or "sips -s format png").`);
  }
  return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
}

const image = process.argv[2];
if (!image || image.startsWith('--')) {
  console.error('usage: node tools/add-pet.js <image.png> --cols N --rows N [--name x] [--scale 2] [--frames a,b,c]');
  process.exit(1);
}
if (!fs.existsSync(image)) {
  console.error(`no such file: ${image}`);
  process.exit(1);
}

const cols = Number(arg('cols'));
const rows = Number(arg('rows'));
if (!cols || !rows) {
  console.error('--cols and --rows are required (how many frames across, how many rows down)');
  process.exit(1);
}

const { w, h } = pngSize(image);
if (w % cols || h % rows) {
  console.warn(
    `warning: ${w}x${h} does not divide evenly into ${cols}x${rows} ` +
    `(${w / cols} x ${h / rows} per frame). Frames may be misaligned.`
  );
}

const frameWidth = Math.floor(w / cols);
const frameHeight = Math.floor(h / rows);
const name = arg('name', path.basename(image, path.extname(image)).replace(/[^a-z0-9-]/gi, '-').toLowerCase());
const scale = Number(arg('scale', frameWidth <= 32 ? 3 : frameWidth <= 64 ? 2 : 1));
const perRow = arg('frames') ? arg('frames').split(',').map(Number) : null;

const animations = {};
STATES.forEach((state, i) => {
  const row = i < rows ? i : 0;                       // reuse row 0 if the sheet is short
  animations[state] = {
    row,
    frames: perRow?.[row] ?? cols,
    fps: DEFAULT_FPS[state],
  };
});

const dir = path.join(__dirname, '..', 'pets', name);
fs.mkdirSync(dir, { recursive: true });
const sheet = `${name}.png`;
fs.copyFileSync(image, path.join(dir, sheet));

const manifest = {
  id: name,
  name: name.replace(/(^|-)(\w)/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase()),
  sheet,
  source: 'REPLACE ME — where you got it, and its license',
  frameWidth,
  frameHeight,
  scale,
  animations,
  bubbles: {
    needs_input: ['I need you', 'waiting on you'],
    ready: ['all done', 'have a look'],
    blocked: ['something broke', "I'm stuck"],
  },
};

fs.writeFileSync(path.join(dir, 'pet.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`sheet     ${w}x${h}`);
console.log(`grid      ${cols} x ${rows}  ->  ${frameWidth}x${frameHeight} per frame`);
console.log(`scale     ${scale}x  (renders at ${frameWidth * scale}px)`);
console.log(`\nwrote ${path.join(dir, 'pet.json')}`);
console.log('\nRow mapping (edit pet.json if your sheet is ordered differently):');
for (const [state, a] of Object.entries(animations)) {
  console.log(`  ${state.padEnd(12)} row ${a.row}, ${a.frames} frames @ ${a.fps}fps`);
}
console.log('\nRestart Jarvis, then pick it from the menubar under "Pet".');
