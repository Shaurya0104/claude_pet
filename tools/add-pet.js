#!/usr/bin/env node
'use strict';
/**
 * Turn a downloaded sprite sheet into a Jarvis pet.
 *
 *   node tools/add-pet.js <image.png> --cols 6 --rows 5 [--name foxy] [--scale 2]
 *   node tools/add-pet.js foxy.png --cols 8 --rows 4 --frames 4,8,4,6
 *
 * The same import runs behind the "Add your own" button in Settings.
 */
const { importPet } = require('../src/core/import-pet');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const image = process.argv[2];
if (!image || image.startsWith('--')) {
  console.error('usage: node tools/add-pet.js <image.png> --cols N --rows N [--name x] [--scale 2] [--frames a,b,c]');
  process.exit(1);
}

try {
  const r = importPet({
    image,
    cols: arg('cols'),
    rows: arg('rows'),
    name: arg('name'),
    scale: arg('scale'),
    frames: arg('frames') ? arg('frames').split(',').map(Number) : null,
    rendering: arg('rendering'),
  });

  console.log(`sheet     ${r.width}x${r.height}`);
  console.log(`grid      ${arg('cols')} x ${arg('rows')}  ->  ${r.frameWidth}x${r.frameHeight} per frame`);
  console.log(`scale     ${r.scale}x  (renders at ${Math.round(r.frameWidth * r.scale)}px)`);
  if (!r.even) console.log('warning:  the sheet does not divide evenly — frames may be misaligned');
  console.log(`\nwrote ${r.dir}/pet.json`);
  console.log('\nRow mapping (edit pet.json if your sheet is ordered differently):');
  for (const [state, a] of Object.entries(r.animations)) {
    console.log(`  ${state.padEnd(12)} row ${a.row}, ${a.frames} frames @ ${a.fps}fps`);
  }
  console.log('\nRestart Jarvis, then pick it in Settings or the menubar.');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
