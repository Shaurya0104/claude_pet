#!/usr/bin/env node
'use strict';
/**
 * Turns the line-art helmet into a coloured, animated sprite sheet.
 *
 * Pipeline:
 *   1. decode the source and crop to the helmet
 *   2. binarise into LINE / not-LINE
 *   3. flood fill from the border to find the background
 *   4. label every enclosed region, and classify it by where it sits:
 *      eye slits, gold faceplate, red shell
 *   5. paint with gradients + a specular sheen, keeping the linework as outline
 *   6. box-downscale to sprite size, then build one row of frames per state
 *
 * Nothing here is hand-placed: the regions come out of the image, so if you
 * swap the source art for another front-facing helmet it still works.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Canvas } = require('./lib/pixel');
const { decode } = require('./lib/png-decode');

const SRC_JPG = process.argv[2] ||
  path.join(__dirname, '..', 'pets', 'jarvis',
    'vecteezy_detailed-robot-warrior-helmet-design-simple-line-art_67835659.jpg');

const OUT_DIR = path.join(__dirname, '..', 'pets', 'helmet');
const FRAME_W = 224;
const FRAME_H = 288;

// ------------------------------------------------------------------ palette ---
const P = {
  lineRed:  [0x2a, 0x06, 0x0b, 255],   // linework inside red plating
  lineGold: [0x33, 0x1c, 0x02, 255],   // linework inside gold plating
  redHi:    [0xe8, 0x44, 0x3a, 255],
  redMid:   [0xc2, 0x18, 0x1f, 255],
  redLo:    [0x64, 0x0b, 0x12, 255],
  goldHi:   [0xff, 0xe0, 0x8a, 255],
  goldMid:  [0xf0, 0xba, 0x37, 255],
  goldLo:   [0x8f, 0x5f, 0x0d, 255],
  eyeCore:  [0xea, 0xff, 0xff, 255],
  eyeGlow:  [0x74, 0xe8, 0xff, 255],
  rim:      [0xff, 0xc9, 0x9a, 255],
};

/** Three-stop gradient: highlight -> midtone -> shadow. */
function ramp(hi, mid, lo, t) {
  return t < 0.5 ? mix(hi, mid, t * 2) : mix(mid, lo, (t - 0.5) * 2);
}

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [
  Math.round(lerp(c1[0], c2[0], t)),
  Math.round(lerp(c1[1], c2[1], t)),
  Math.round(lerp(c1[2], c2[2], t)),
  255,
];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ------------------------------------------------------- 1. load and crop ---
const tmpPng = '/tmp/jarvis-helmet-src.png';
execFileSync('sips', ['-s', 'format', 'png', SRC_JPG, '--out', tmpPng], { stdio: 'ignore' });
const src = decode(tmpPng);

let minx = src.w, maxx = 0, miny = src.h, maxy = 0;
for (let y = 0; y < src.h; y++) {
  for (let x = 0; x < src.w; x++) {
    if (src.get(x, y)[0] < 128) {
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
    }
  }
}
const pad = 8;
const art = src.crop(minx - pad, miny - pad, maxx - minx + 1 + pad * 2, maxy - miny + 1 + pad * 2);
const W = art.w, H = art.h;
console.log(`cropped helmet: ${W}x${H}`);

// ------------------------------------------ 2/3. binarise + find background ---
const LINE = 1, BG = 2, INSIDE = 0;
const kind = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) {
  if (art.buf[i * 4] < 128) kind[i] = LINE;
}

// Iterative flood fill from every border pixel — recursion would blow the stack
// on an image this size.
const stack = [];
for (let x = 0; x < W; x++) { stack.push(x, x + (H - 1) * W); }
for (let y = 0; y < H; y++) { stack.push(y * W, W - 1 + y * W); }
while (stack.length) {
  const i = stack.pop();
  if (kind[i] !== INSIDE) continue;
  kind[i] = BG;
  const x = i % W, y = (i / W) | 0;
  if (x > 0) stack.push(i - 1);
  if (x < W - 1) stack.push(i + 1);
  if (y > 0) stack.push(i - W);
  if (y < H - 1) stack.push(i + W);
}

// ------------------------------------------------- 4. label enclosed regions ---
const label = new Int32Array(W * H).fill(-1);
const regions = [];
for (let start = 0; start < W * H; start++) {
  if (kind[start] !== INSIDE || label[start] !== -1) continue;
  const id = regions.length;
  const r = { id, area: 0, minx: W, maxx: 0, miny: H, maxy: 0, sx: 0, sy: 0 };
  const st = [start];
  label[start] = id;
  while (st.length) {
    const i = st.pop();
    const x = i % W, y = (i / W) | 0;
    r.area++;
    r.sx += x; r.sy += y;
    if (x < r.minx) r.minx = x;
    if (x > r.maxx) r.maxx = x;
    if (y < r.miny) r.miny = y;
    if (y > r.maxy) r.maxy = y;
    if (x > 0 && kind[i - 1] === INSIDE && label[i - 1] === -1) { label[i - 1] = id; st.push(i - 1); }
    if (x < W - 1 && kind[i + 1] === INSIDE && label[i + 1] === -1) { label[i + 1] = id; st.push(i + 1); }
    if (y > 0 && kind[i - W] === INSIDE && label[i - W] === -1) { label[i - W] = id; st.push(i - W); }
    if (y < H - 1 && kind[i + W] === INSIDE && label[i + W] === -1) { label[i + W] = id; st.push(i + W); }
  }
  r.cx = r.sx / r.area;
  r.cy = r.sy / r.area;
  r.w = r.maxx - r.minx + 1;
  r.h = r.maxy - r.miny + 1;
  regions.push(r);
}
console.log(`found ${regions.length} enclosed regions`);

// ------------------------------------------------------- classify the regions ---
// Measure the silhouette row by row. The helmet tapers hard from brow to chin,
// so a single global centre line misjudges where "outer edge" is; normalising
// x against the actual width at each row makes one threshold work everywhere.
const rowMin = new Int32Array(H).fill(-1);
const rowMax = new Int32Array(H).fill(-1);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (kind[y * W + x] !== BG) { if (rowMin[y] < 0) rowMin[y] = x; rowMax[y] = x; }
  }
}

/** Horizontal position within the silhouette: 0 at centre, ±1 at the edge. */
function normX(x, y) {
  if (rowMin[y] < 0) return 0;
  const c = (rowMin[y] + rowMax[y]) / 2;
  const half = Math.max(1, (rowMax[y] - rowMin[y]) / 2);
  return (x - c) / half;
}

const RED = 'red', GOLD = 'gold', EYE = 'eye';

// The eye slits: wide, flat, sitting in the upper-middle band, off-centre,
// and roughly mirrored about the centre line. Pick the two best candidates.
const eyeCandidates = regions
  .filter((r) =>
    r.cy > H * 0.36 && r.cy < H * 0.58 &&
    r.w > W * 0.14 && r.w < W * 0.48 &&
    r.h < r.w * 0.75 &&
    r.area > W * H * 0.0015 &&
    Math.abs(r.cx - W / 2) > W * 0.06)
  .sort((a, b) => b.area - a.area);

const eyes = [];
const leftEye = eyeCandidates.find((r) => r.cx < W / 2);
const rightEye = eyeCandidates.find((r) => r.cx > W / 2);
if (leftEye) eyes.push(leftEye);
if (rightEye) eyes.push(rightEye);

// Mean normalised position per region, so classification uses the region's
// real footprint rather than a single centroid pixel.
for (const r of regions) { r.nxSum = 0; r.nySum = 0; }
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (kind[i] !== INSIDE) continue;
    const r = regions[label[i]];
    r.nxSum += Math.abs(normX(x, y));
    r.nySum += y / H;
  }
}

/**
 * Movie-accurate layout: gold is the faceplate — the brow crest, the panels
 * around the eyes, the cheeks and the mouth. Red is the outer shell: the dome,
 * the side panels and the outer jaw.
 */
const DOME_Y = 0.30;      // above this is the dome
const CREST_X = 0.34;     // the gold crest is this narrow up in the dome
const FACE_X = 0.66;      // below the dome, gold reaches this far out

for (const r of regions) {
  if (eyes.includes(r)) { r.kind = EYE; continue; }
  const nx = r.nxSum / r.area;
  const ny = r.nySum / r.area;
  r.nx = nx; r.ny = ny;
  r.kind = ny < DOME_Y
    ? (nx < CREST_X ? GOLD : RED)
    : (nx < FACE_X ? GOLD : RED);
}
console.log(`  eyes: ${eyes.length}  gold: ${regions.filter(r => r.kind === GOLD).length}  red: ${regions.filter(r => r.kind === RED).length}`);

// Distance to the silhouette edge, for the rim light. A couple of dilation
// passes is plenty — we only light the outermost few pixels.
const nearEdge = new Uint8Array(W * H);
for (let y = 1; y < H - 1; y++) {
  for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (kind[i] === BG) continue;
    if (kind[i - 1] === BG || kind[i + 1] === BG || kind[i - W] === BG || kind[i + W] === BG) {
      nearEdge[i] = 3;
    }
  }
}
for (let pass = 2; pass >= 1; pass--) {
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (kind[i] === BG || nearEdge[i]) continue;
      if (nearEdge[i - 1] > pass || nearEdge[i + 1] > pass ||
          nearEdge[i - W] > pass || nearEdge[i + W] > pass) nearEdge[i] = pass;
    }
  }
}

// ------------------------------------------------------------------ 5. paint ---
const painted = new Canvas(W, H);
const eyeMaskHi = new Uint8Array(W * H);
const eyeSideHi = new Uint8Array(W * H);  // 1 = left slit, 2 = right slit

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const o = i * 4;

    if (kind[i] === BG) continue;                       // stays transparent

    const nx = Math.abs(normX(x, y));
    const ny = y / H;
    // Which plating is this pixel sitting on? Line pixels have no region of
    // their own, so fall back to the same rule the regions were classified by.
    const zoneGold = ny < DOME_Y ? nx < CREST_X : nx < FACE_X;

    let c;
    if (kind[i] === LINE) {
      // Tinting the linework to its surroundings stops the panel seams reading
      // as flat black scratches over the paint.
      c = zoneGold ? P.lineGold : P.lineRed;
    } else {
      const r = regions[label[i]];
      const ty = clamp((y - r.miny) / Math.max(1, r.h), 0, 1);   // within the region
      const gy = clamp(ny, 0, 1);                                // within the helmet
      const t = ty * 0.4 + gy * 0.6;

      if (r.kind === EYE) {
        c = mix(P.eyeCore, P.eyeGlow, ty);
        eyeMaskHi[i] = 255;
        if (r === leftEye) eyeSideHi[i] = 1;
        if (r === rightEye) eyeSideHi[i] = 2;
      } else if (r.kind === GOLD) {
        c = ramp(P.goldHi, P.goldMid, P.goldLo, t);
      } else {
        c = ramp(P.redHi, P.redMid, P.redLo, t);
      }

      // Specular sheen: a soft diagonal band of light across the upper left,
      // which is what sells a curved metal surface.
      const d = (x / W) * 0.75 + ny * 1.25;
      const sheen = Math.exp(-((d - 0.62) ** 2) / 0.022) * (r.kind === EYE ? 0 : 0.38);
      if (sheen > 0.01) c = mix(c, [255, 255, 255, 255], sheen);

      // Ambient occlusion into the outer edges so the silhouette reads.
      if (nx > 0.72 && r.kind !== EYE) c = mix(c, P.lineRed, (nx - 0.72) * 0.9);
    }

    // Rim light along the outer silhouette — the one cue that makes a flat
    // fill look like a lit object.
    if (nearEdge[i] && kind[i] !== LINE) {
      c = mix(c, P.rim, nearEdge[i] * 0.055);
    }

    painted.buf[o] = c[0];
    painted.buf[o + 1] = c[1];
    painted.buf[o + 2] = c[2];
    painted.buf[o + 3] = 255;
  }
}

// ---------------------------------------------------- 6. downscale to sprite ---
// Fit the helmet inside the frame with room left over to bob and shake.
const fitH = Math.round(FRAME_H * 0.86);
const fitW = Math.round(fitH * (W / H));
const small = painted.downscale(fitW, fitH);

// Same downscale for the eye mask, so glow coverage matches the art's edges.
const maskHi = new Canvas(W, H);
for (let i = 0; i < W * H; i++) {
  if (eyeMaskHi[i]) { maskHi.buf[i * 4 + 3] = 255; maskHi.buf[i * 4] = 255; maskHi.buf[i * 4 + 1] = 255; maskHi.buf[i * 4 + 2] = 255; }
}
const maskSmall = maskHi.downscale(fitW, fitH);

function sideMask(side) {
  const hi = new Canvas(W, H);
  for (let i = 0; i < W * H; i++) {
    if (eyeSideHi[i] === side) {
      hi.buf[i * 4] = 255; hi.buf[i * 4 + 1] = 255; hi.buf[i * 4 + 2] = 255; hi.buf[i * 4 + 3] = 255;
    }
  }
  return hi.downscale(fitW, fitH);
}
const maskL = sideMask(1);
const maskR = sideMask(2);

const OX = Math.round((FRAME_W - fitW) / 2);
const OY = Math.round((FRAME_H - fitH) / 2);
console.log(`sprite: helmet ${fitW}x${fitH} inside ${FRAME_W}x${FRAME_H} frame`);

// --------------------------------------------------- eye glow, pre-blurred ---
// The bloom is the thing that makes the eyes read as *lit* rather than just
// pale. Blur the eye mask once, then every frame just adds colour through it.
function boxBlur(field, w, h, radius, passes) {
  let cur = field;
  for (let p = 0; p < passes; p++) {
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, n = 0;
        for (let i = -radius; i <= radius; i++) {
          const xx = x + i;
          if (xx < 0 || xx >= w) continue;
          sum += cur[y * w + xx]; n++;
        }
        tmp[y * w + x] = sum / n;
      }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, n = 0;
        for (let j = -radius; j <= radius; j++) {
          const yy = y + j;
          if (yy < 0 || yy >= h) continue;
          sum += tmp[yy * w + x]; n++;
        }
        out[y * w + x] = sum / n;
      }
    }
    cur = out;
  }
  return cur;
}

const eyeField = new Float32Array(fitW * fitH);
const eyeFieldL = new Float32Array(fitW * fitH);
const eyeFieldR = new Float32Array(fitW * fitH);
for (let i = 0; i < fitW * fitH; i++) {
  eyeField[i] = maskSmall.buf[i * 4 + 3] / 255;
  eyeFieldL[i] = maskL.buf[i * 4 + 3] / 255;
  eyeFieldR[i] = maskR.buf[i * 4 + 3] / 255;
}
const bloomField = boxBlur(eyeField, fitW, fitH, 7, 3);
let bloomMax = 0;
for (const v of bloomField) if (v > bloomMax) bloomMax = v;
for (let i = 0; i < bloomField.length; i++) bloomField[i] /= bloomMax || 1;

// ------------------------------------------------------------ frame builder ---
function addLight(cv, x, y, c, amount) {
  if (amount <= 0) return;
  if (x < 0 || y < 0 || x >= cv.w || y >= cv.h) return;
  const o = (y * cv.w + x) * 4;
  cv.buf[o] = clamp(Math.round(cv.buf[o] + c[0] * amount), 0, 255);
  cv.buf[o + 1] = clamp(Math.round(cv.buf[o + 1] + c[1] * amount), 0, 255);
  cv.buf[o + 2] = clamp(Math.round(cv.buf[o + 2] + c[2] * amount), 0, 255);
  cv.buf[o + 3] = clamp(Math.round(cv.buf[o + 3] + 255 * amount * 0.9), 0, 255);
}

function drawFrame(opt) {
  const o = {
    dx: 0, dy: 0,
    eye: P.eyeCore, eyeLevel: 1, bloom: 0.75,
    eyeLevelL: null, eyeLevelR: null,   // override one slit at a time
    desat: 0, dark: 0,
    scanY: null,        // running: bright bar sweeping the eye slits
    shimmer: null,      // ready: diagonal gold sweep
    bang: false,        // needs_input: exclamation mark
    ...opt,
  };

  const cv = new Canvas(FRAME_W, FRAME_H);
  cv.blitScaled(small, OX + o.dx, OY + o.dy, 1);

  // Desaturate / darken the whole helmet (blocked).
  if (o.desat > 0 || o.dark > 0) {
    for (let i = 0; i < cv.w * cv.h; i++) {
      const q = i * 4;
      if (!cv.buf[q + 3]) continue;
      const lum = 0.299 * cv.buf[q] + 0.587 * cv.buf[q + 1] + 0.114 * cv.buf[q + 2];
      for (let k = 0; k < 3; k++) {
        let v = lerp(cv.buf[q + k], lum, o.desat);
        v = lerp(v, 0, o.dark);
        cv.buf[q + k] = clamp(Math.round(v), 0, 255);
      }
    }
  }

  // Repaint the eye slits, then bloom outward through the blurred mask.
  for (let y = 0; y < fitH; y++) {
    for (let x = 0; x < fitW; x++) {
      const idx = y * fitW + x;
      const cov = eyeField[idx];
      const px = OX + o.dx + x, py = OY + o.dy + y;

      if (cov > 0) {
        let level = o.eyeLevel;
        if (o.eyeLevelL !== null && eyeFieldL[idx] > 0.5) level = o.eyeLevelL;
        if (o.eyeLevelR !== null && eyeFieldR[idx] > 0.5) level = o.eyeLevelR;
        if (o.scanY !== null && Math.abs(y - o.scanY) < 5) level = Math.min(1.6, level + 0.7);
        const q = (py * cv.w + px) * 4;
        if (py >= 0 && py < cv.h && px >= 0 && px < cv.w) {
          for (let k = 0; k < 3; k++) {
            cv.buf[q + k] = clamp(Math.round(lerp(cv.buf[q + k], o.eye[k] * Math.min(1, level), cov)), 0, 255);
          }
          cv.buf[q + 3] = 255;
        }
      }

      const b = bloomField[idx];
      if (b > 0.02) addLight(cv, px, py, o.eye, b * o.bloom * o.eyeLevel * 0.55);

      // Repulsor-style flash: a bright ring pushing out past the bloom.
      if (o.flash) {
        const ring = Math.exp(-((b - o.flash.at) ** 2) / 0.012);
        if (ring > 0.02) addLight(cv, px, py, o.flash.color, ring * o.flash.power);
      }
    }
  }

  // Gold sweep across the plating (ready).
  if (o.shimmer !== null) {
    for (let y = 0; y < fitH; y++) {
      for (let x = 0; x < fitW; x++) {
        const px = OX + o.dx + x, py = OY + o.dy + y;
        if (px < 0 || py < 0 || px >= cv.w || py >= cv.h) continue;
        const q = (py * cv.w + px) * 4;
        if (cv.buf[q + 3] < 40) continue;
        const d = (x / fitW) * 0.65 + (y / fitH) * 0.35;
        const band = Math.exp(-((d - o.shimmer) ** 2) / 0.0016);
        if (band > 0.02) addLight(cv, px, py, P.goldHi, band * 0.5);
      }
    }
  }

  // Exclamation mark (needs_input).
  if (o.bang) {
    const bx = FRAME_W - 34, by = 26;
    cv.roundRect(bx, by, 13, 40, 5, [0xff, 0xd1, 0x3a, 255]);
    cv.roundRect(bx, by + 48, 13, 13, 6, [0xff, 0xd1, 0x3a, 255]);
    for (let y = -10; y < 74; y++) {
      for (let x = -10; x < 24; x++) {
        const d = Math.hypot(x - 6, y - 30) / 40;
        addLight(cv, bx + x, by + y, [0xff, 0xa8, 0x2a, 255], Math.max(0, 0.35 - d * 0.35));
      }
    }
  }

  return cv;
}

// ------------------------------------------------------------------- frames ---
const AMBER = [0xff, 0xb4, 0x3a, 255];
const DIM_RED = [0xff, 0x5a, 0x4a, 255];

const ROWS = [
  { name: 'idle', fps: 5, frames: [
    { dy: 0, eyeLevel: 0.88, bloom: 0.6 },
    { dy: -2, eyeLevel: 1.0, bloom: 0.8 },
    { dy: 0, eyeLevel: 0.94, bloom: 0.7 },
    { dy: 2, eyeLevel: 0.82, bloom: 0.55 },
  ]},
  { name: 'running', fps: 12, frames: [
    { dy: 2, eyeLevel: 1.0, bloom: 0.95, scanY: fitH * 0.40 },
    { dy: -3, eyeLevel: 1.0, bloom: 1.0, scanY: fitH * 0.44 },
    { dy: 0, eyeLevel: 1.0, bloom: 0.9, scanY: fitH * 0.48 },
    { dy: 2, eyeLevel: 1.0, bloom: 0.95, scanY: fitH * 0.52 },
    { dy: -3, eyeLevel: 1.0, bloom: 1.0, scanY: fitH * 0.46 },
    { dy: 0, eyeLevel: 1.0, bloom: 0.9, scanY: fitH * 0.42 },
  ]},
  { name: 'needs_input', fps: 6, frames: [
    { dx: -4, eye: AMBER, eyeLevel: 1.0, bloom: 1.2, bang: true },
    { dx: 4, eye: P.eyeCore, eyeLevel: 0.7, bloom: 0.5, bang: false },
    { dx: -4, eye: AMBER, eyeLevel: 1.0, bloom: 1.2, bang: true },
    { dx: 4, eye: P.eyeCore, eyeLevel: 0.7, bloom: 0.5, bang: false },
  ]},
  { name: 'ready', fps: 6, frames: [
    { dy: 0, eyeLevel: 1.0, bloom: 1.0, shimmer: 0.15 },
    { dy: -2, eyeLevel: 1.0, bloom: 1.1, shimmer: 0.4 },
    { dy: -3, eyeLevel: 1.0, bloom: 1.15, shimmer: 0.65 },
    { dy: -2, eyeLevel: 1.0, bloom: 1.05, shimmer: 0.9 },
  ]},
  { name: 'blocked', fps: 4, frames: [
    { dy: 3, desat: 0.7, dark: 0.35, eye: DIM_RED, eyeLevel: 0.45, bloom: 0.3 },
    { dy: 3, desat: 0.75, dark: 0.45, eye: DIM_RED, eyeLevel: 0.0, bloom: 0.0 },
    { dy: 3, dx: 3, desat: 0.7, dark: 0.35, eye: DIM_RED, eyeLevel: 0.3, bloom: 0.2 },
    { dy: 3, desat: 0.75, dark: 0.5, eye: DIM_RED, eyeLevel: 0.0, bloom: 0.0 },
  ]},
];

// Idle variants, picked at random so it does not loop identically forever.
ROWS.push({ name: 'idle_scan', fps: 8, frames: [
  { dy: 0, eyeLevel: 0.9, bloom: 0.6, scanY: fitH * 0.40 },
  { dy: -1, eyeLevel: 0.95, bloom: 0.7, scanY: fitH * 0.44 },
  { dy: 0, eyeLevel: 0.95, bloom: 0.7, scanY: fitH * 0.48 },
  { dy: 1, eyeLevel: 0.9, bloom: 0.6, scanY: fitH * 0.52 },
  { dy: 0, eyeLevel: 0.88, bloom: 0.6 },
  { dy: -1, eyeLevel: 0.9, bloom: 0.65 },
]});

ROWS.push({ name: 'idle_look', fps: 4, frames: [
  { dy: 0, eyeLevelL: 1.0, eyeLevelR: 0.45, bloom: 0.6 },
  { dy: -1, eyeLevelL: 1.0, eyeLevelR: 0.45, bloom: 0.6 },
  { dy: 0, eyeLevel: 0.9, bloom: 0.65 },
  { dy: 1, eyeLevelL: 0.45, eyeLevelR: 1.0, bloom: 0.6 },
  { dy: 0, eyeLevelL: 0.45, eyeLevelR: 1.0, bloom: 0.6 },
  { dy: -1, eyeLevel: 0.9, bloom: 0.65 },
]});

ROWS.push({ name: 'idle_power', fps: 6, frames: [
  { dy: 0, eyeLevel: 0.2, bloom: 0.1 },
  { dy: 0, eyeLevel: 0.7, bloom: 0.5 },
  { dy: -1, eyeLevel: 1.0, bloom: 1.0 },
  { dy: -2, eyeLevel: 1.0, bloom: 1.2, flash: { at: 0.5, color: P.eyeGlow, power: 0.5 } },
  { dy: -1, eyeLevel: 1.0, bloom: 0.9 },
  { dy: 0, eyeLevel: 0.9, bloom: 0.7 },
]});

// Reactions: play once, then fall back to whatever state we are in.
ROWS.push({ name: 'poke', fps: 14, frames: [
  { dy: 6, eyeLevel: 1.3, bloom: 1.1 },
  { dy: -4, eyeLevel: 1.4, bloom: 1.4, flash: { at: 0.45, color: [255, 255, 255, 255], power: 0.6 } },
  { dy: 2, eyeLevel: 1.1, bloom: 1.0 },
  { dy: -1, eyeLevel: 1.0, bloom: 0.85 },
  { dy: 0, eyeLevel: 0.95, bloom: 0.75 },
]});

ROWS.push({ name: 'ping', fps: 12, frames: [
  { dy: 0, eyeLevel: 1.0, bloom: 0.9, shimmer: 0.1 },
  { dy: -2, eyeLevel: 1.4, bloom: 1.4, shimmer: 0.35, flash: { at: 0.35, color: P.eyeGlow, power: 0.7 } },
  { dy: -3, eyeLevel: 1.5, bloom: 1.7, shimmer: 0.6, flash: { at: 0.2, color: [255, 255, 255, 255], power: 0.8 } },
  { dy: -2, eyeLevel: 1.2, bloom: 1.2, shimmer: 0.85 },
  { dy: 0, eyeLevel: 1.0, bloom: 0.9 },
  { dy: 0, eyeLevel: 0.95, bloom: 0.8 },
]});

ROWS.push({ name: 'salute', fps: 8, frames: [
  { dy: 0, eyeLevel: 0.9, bloom: 0.7 },
  { dy: 4, eyeLevel: 0.6, bloom: 0.4 },
  { dy: 5, eyeLevel: 0.5, bloom: 0.3 },
  { dy: 2, eyeLevel: 1.1, bloom: 1.0 },
  { dy: -2, eyeLevel: 1.3, bloom: 1.3, shimmer: 0.5 },
  { dy: 0, eyeLevel: 1.0, bloom: 0.85 },
]});

const COLS = Math.max(...ROWS.map((r) => r.frames.length));
const sheet = new Canvas(FRAME_W * COLS, FRAME_H * ROWS.length);

ROWS.forEach((row, ri) => {
  row.frames.forEach((f, ci) => {
    const frame = drawFrame(f);
    sheet.blitScaled(frame, ci * FRAME_W, ri * FRAME_H, 1);
  });
  process.stdout.write(`  ${row.name}: ${row.frames.length} frames\n`);
});

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'helmet.png'), sheet.png());

const animations = {};
ROWS.forEach((r, i) => {
  animations[r.name] = { row: i, frames: r.frames.length, fps: r.fps };
});

fs.writeFileSync(path.join(OUT_DIR, 'pet.json'), JSON.stringify({
  id: 'helmet',
  name: 'Helmet',
  sheet: 'helmet.png',
  source: `colourised from ${path.basename(SRC_JPG)} by tools/make-helmet.js`,
  frameWidth: FRAME_W,
  frameHeight: FRAME_H,
  scale: 0.5,
  rendering: 'auto',
  animations,
  variants: { idle: ['idle', 'idle_scan', 'idle_look', 'idle_power'] },
  actions: {
    poke:   { animation: 'poke', once: true },
    ping:   { animation: 'ping', once: true, label: 'Repulsor' },
    salute: { animation: 'salute', once: true, label: 'Salute' },
  },
  bubbles: {
    needs_input: ['sir, I need you', 'awaiting input', 'you are needed'],
    ready: ['task complete', 'ready for review', 'done, sir'],
    blocked: ['systems offline', 'power failure', "I'm stuck"],
    running: ['working on it', 'processing', 'on it, sir'],
  },
}, null, 2) + '\n');

// A clean, large render for the app icon. Taken from the painted canvas
// before the sprite downscale, so the icon is not an upscaled sprite frame.
const iconH = 780;
const iconSrc = painted.downscale(Math.round(iconH * (W / H)), iconH);
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), iconSrc.png());
console.log(`wrote ${path.join(OUT_DIR, 'icon.png')}  (icon source, ${iconSrc.w}x${iconSrc.h})`);

const kb = (fs.statSync(path.join(OUT_DIR, 'helmet.png')).size / 1024).toFixed(0);
console.log(`\nwrote ${path.join(OUT_DIR, 'helmet.png')}  (${sheet.w}x${sheet.h}, ${kb} KB)`);
console.log(`wrote ${path.join(OUT_DIR, 'pet.json')}`);
