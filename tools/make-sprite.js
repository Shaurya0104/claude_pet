#!/usr/bin/env node
'use strict';
/** Builds pets/jarvis/jarvis.png — one row per state, frames left to right. */
const fs = require('fs');
const path = require('path');
const { Canvas } = require('./lib/pixel');
const { FRAME, drawPet, STATES } = require('./lib/art');

const COLS = Math.max(...STATES.map((s) => s.frames.length));
const cv = new Canvas(FRAME * COLS, FRAME * STATES.length);

STATES.forEach((state, row) => {
  state.frames.forEach((f, col) => drawPet(cv, col * FRAME, row * FRAME, f));
});

const out = path.join(__dirname, '..', 'pets', 'jarvis', 'jarvis.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, cv.png());
console.log(`wrote ${out}  (${cv.w}x${cv.h}, ${FRAME}x${FRAME} frames, ${(fs.statSync(out).size / 1024).toFixed(1)} KB)`);
