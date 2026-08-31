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
const { drawArcReactor } = require('./lib/arc-reactor');

const SRC_JPG = process.argv[2] ||
  path.join(__dirname, '..', 'pets', 'jarvis',
    'vecteezy_detailed-robot-warrior-helmet-design-simple-line-art_67835659.jpg');

const OUT_DIR = path.join(__dirname, '..', 'pets', 'helmet');
const FRAME_W = 224;
const FRAME_H = 288;

// ------------------------------------------------------------------ palette ---
const P = {
  lineRed:  [0x24, 0x05, 0x09, 255],   // linework inside red plating
  lineGold: [0x3a, 0x22, 0x04, 255],   // linework inside gold plating
  redHi:    [0xc9, 0x36, 0x35, 255],   // lit crimson
  redMid:   [0x8a, 0x18, 0x1e, 255],
  redLo:    [0x36, 0x06, 0x0b, 255],   // deep maroon in shadow
  goldHi:   [0xff, 0xef, 0xbe, 255],   // near-cream highlight on polished gold
  goldMid:  [0xe2, 0xac, 0x33, 255],
  goldLo:   [0x6f, 0x45, 0x08, 255],   // bronze shadow
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
let eyesFound = [], leftEye = null, rightEye = null;
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

// ----------------------------------------- 4. silhouette + region labelling ---
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

/** Flood fill every enclosed area and collect its statistics. */
function labelRegions() {
  const label = new Int32Array(W * H).fill(-1);
  const regions = [];
  for (let start = 0; start < W * H; start++) {
    if (kind[start] !== INSIDE || label[start] !== -1) continue;
    const id = regions.length;
    const r = { id, area: 0, minx: W, maxx: 0, miny: H, maxy: 0, sx: 0, sy: 0, nxSum: 0 };
    const st = [start];
    label[start] = id;
    while (st.length) {
      const i = st.pop();
      const x = i % W, y = (i / W) | 0;
      r.area++;
      r.sx += x; r.sy += y;
      r.nxSum += Math.abs(normX(x, y));
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
    r.nx = r.nxSum / r.area;
    r.w = r.maxx - r.minx + 1;
    r.h = r.maxy - r.miny + 1;
    regions.push(r);
  }
  return { label, regions };
}

/** The two eye slits: wide, flat, mirrored, in the upper-middle band. */
function findEyes(regions) {
  const c = regions
    .filter((r) =>
      r.cy > H * 0.36 && r.cy < H * 0.58 &&
      r.w > W * 0.14 && r.w < W * 0.48 &&
      r.h < r.w * 0.75 &&
      r.area > W * H * 0.0015 &&
      Math.abs(r.cx - W / 2) > W * 0.06)
    .sort((a, b) => b.area - a.area);
  return { left: c.find((r) => r.cx < W / 2), right: c.find((r) => r.cx > W / 2) };
}

const { label, regions } = labelRegions();
console.log(`found ${regions.length} enclosed regions`);
{
  const e = findEyes(regions);
  if (!e.left || !e.right) throw new Error('could not find both eye slits');
  leftEye = e.left;
  rightEye = e.right;
  eyesFound = [leftEye, rightEye];
}

const RED = 'red', GOLD = 'gold', EYE = 'eye';

/**
 * A panel is gold when its centroid sits inside the faceplate the seams just
 * carved out. Because the boundary is now a drawn line, no region straddles
 * it, so a whole-region test is exact.
 */
/**
 * Red is now only two things: the raised crest at the crown, and the panels
 * down the outer edges. Everything else — dome, brow, faceplate, jaw — is gold.
 *
 * That means no synthetic seams at all. Every one of those boundaries is a line
 * the artist already drew, so the colour cannot land anywhere a line isn't.
 */
const CREST_Y = 0.26;    // the crest sits above this height
const CREST_X = 0.46;    // ...and within this far of the centre line
const SIDE_X = 0.78;     // outboard of this are the red edge panels

function isRed(r) {
  if (r.nx > SIDE_X) return true;                       // outer edge panels
  return r.ny < CREST_Y && r.nx < CREST_X;              // the crown crest
}

for (const r of regions) {
  if (eyesFound.includes(r)) { r.kind = EYE; continue; }
  r.ny = r.cy / H;
  r.kind = isRed(r) ? RED : GOLD;
}
if (process.env.SEAM_DEBUG) {
  console.log('  panels overlapping the eye band (y 0.30-0.60):  [below% = pixels under the seam]');
  regions
    .filter((r) => r.maxy / H > 0.30 && r.miny / H < 0.60 && r.area > W * H * 0.0004)
    .sort((a, b) => b.area - a.area).slice(0, 14)
    .forEach((r) => {
      const sy = seamCurve[Math.min(W - 1, Math.max(0, Math.round(r.cx)))] / H;
      const bp = (100 * belowSeam[r.id] / r.area).toFixed(0);
      console.log(`    ${r.kind.padEnd(4)} area ${(100 * r.area / (W * H)).toFixed(2)}%  ` +
        `below ${bp.padStart(3)}%  nx ${r.nx.toFixed(2)}  cy ${(r.cy / H).toFixed(2)}  ` +
        `y ${(r.miny / H).toFixed(2)}-${(r.maxy / H).toFixed(2)}  x ${(r.minx / W).toFixed(2)}-${(r.maxx / W).toFixed(2)}`);
    });
}
console.log(`  eyes: ${eyesFound.length}  gold panels: ${regions.filter(r => r.kind === GOLD).length}  red panels: ${regions.filter(r => r.kind === RED).length}`);

// Distance to the silhouette edge, for the rim light.
const nearEdge = new Uint8Array(W * H);
for (let y = 1; y < H - 1; y++) {
  for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (kind[i] === BG) continue;
    if (kind[i - 1] === BG || kind[i + 1] === BG || kind[i - W] === BG || kind[i + W] === BG) nearEdge[i] = 3;
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

    const nxSigned = normX(x, y);
    const nx = Math.abs(nxSigned);
    const ny = y / H;
    // Which plating is this pixel sitting on? Line pixels have no region of
    // their own, so fall back to the same rule the regions were classified by.
    const zoneGold = !(nx > SIDE_X || (ny < CREST_Y && nx < CREST_X));

    let c;
    if (kind[i] === LINE) {
      // Tinting the linework to its surroundings stops the panel seams reading
      // as flat black scratches over the paint.
      c = zoneGold ? P.lineGold : P.lineRed;
    } else {
      const r = regions[label[i]];

      /**
       * Treat the helmet as a curved shell lit from the upper left, rather
       * than running a flat top-to-bottom ramp. Fake a surface normal from the
       * pixel's position — horizontal curve from the silhouette, vertical from
       * the helmet's height — and shade by how much it faces the light. This
       * is what makes it read as domed metal instead of a filled outline.
       */
      const sx = clamp(nxSigned, -1, 1);              // -1 left edge, +1 right
      const sy = clamp((ny - 0.46) * 2.1, -1, 1);     // -1 crown, +1 chin
      const nz = Math.sqrt(Math.max(0.02, 1 - sx * sx * 0.86 - sy * sy * 0.40));
      const lambert = clamp(-sx * 0.42 - sy * 0.46 + nz * 0.78, 0, 1);

      // A little per-panel variation so neighbouring plates stay legible.
      const ty = clamp((y - r.miny) / Math.max(1, r.h), 0, 1);
      const t = clamp((1 - lambert) * 0.86 + ty * 0.14, 0, 1);

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
      const broad = Math.exp(-((d - 0.60) ** 2) / 0.030) * 0.30;
      const tight = Math.exp(-((d - 0.52) ** 2) / 0.0022) * 0.42;   // hot highlight streak
      const sheen = r.kind === EYE ? 0 : broad + tight;
      if (sheen > 0.01) c = mix(c, [255, 255, 255, 255], Math.min(0.85, sheen));

      // Ambient occlusion into the outer edges so the silhouette reads.
      if (nx > 0.74 && r.kind !== EYE) c = mix(c, P.lineRed, (nx - 0.74) * 0.9);
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

// Group the drawn panels into plates, so the reboot assembles the helmet out
// of its actual parts rather than arbitrary pie slices.
//
// The seams gave us ~120 real panels. The biggest ones become plate seeds and
// every smaller panel joins its nearest seed, which keeps neighbouring pieces
// travelling together the way physical plating would.
const PLATE_COUNT = 15;
const plateHi = new Int16Array(W * H).fill(-1);
const plates = [];
{
  const seeds = regions
    .filter((r) => r.kind !== EYE)
    .sort((a, b) => b.area - a.area)
    .slice(0, PLATE_COUNT);

  const plateOfRegion = new Int32Array(regions.length);
  for (const r of regions) {
    let best = 0, bd = Infinity;
    seeds.forEach((sd, i) => {
      const d = (r.cx - sd.cx) ** 2 + (r.cy - sd.cy) ** 2;
      if (d < bd) { bd = d; best = i; }
    });
    plateOfRegion[r.id] = best;
  }

  for (let i = 0; i < W * H; i++) if (kind[i] === INSIDE) plateHi[i] = plateOfRegion[label[i]];

  // Grow the plates across the linework so no pixel is left behind in flight.
  const q = [];
  for (let i = 0; i < W * H; i++) if (plateHi[i] >= 0) q.push(i);
  for (let head = 0; head < q.length; head++) {
    const i = q[head];
    const x = i % W, y = (i / W) | 0;
    const p = plateHi[i];
    if (x > 0 && kind[i - 1] === LINE && plateHi[i - 1] < 0) { plateHi[i - 1] = p; q.push(i - 1); }
    if (x < W - 1 && kind[i + 1] === LINE && plateHi[i + 1] < 0) { plateHi[i + 1] = p; q.push(i + 1); }
    if (y > 0 && kind[i - W] === LINE && plateHi[i - W] < 0) { plateHi[i - W] = p; q.push(i - W); }
    if (y < H - 1 && kind[i + W] === LINE && plateHi[i + W] < 0) { plateHi[i + W] = p; q.push(i + W); }
  }

  for (let i = 0; i < seeds.length; i++) plates.push({ n: 0, sx: 0, sy: 0 });
}

// Plate map at sprite resolution, plus each plate's arrival vector and timing.
const plateSmall = new Int16Array(fitW * fitH).fill(-1);
for (let y = 0; y < fitH; y++) {
  for (let x = 0; x < fitW; x++) {
    const sx = Math.min(W - 1, Math.floor(((x + 0.5) * W) / fitW));
    const sy = Math.min(H - 1, Math.floor(((y + 0.5) * H) / fitH));
    plateSmall[y * fitW + x] = plateHi[sy * W + sx];
  }
}
for (let y = 0; y < fitH; y++) {
  for (let x = 0; x < fitW; x++) {
    const p = plateSmall[y * fitW + x];
    if (p < 0 || !plates[p]) continue;
    plates[p].n++; plates[p].sx += x; plates[p].sy += y;
  }
}

// Far enough that the plates read as separate, close enough that they stay in
// frame while they travel — at 210 they simply vanished off the edges and the
// helmet appeared to pop into existence.
const ASSEMBLE_SPREAD = 56;
{
  const cx = fitW / 2, cy = fitH / 2;
  // Outermost plates set off first and travel furthest, so the helmet closes
  // inward instead of every piece landing at once.
  const ordered = plates
    .map((p, i) => ({ i, d: p.n ? Math.hypot(p.sx / p.n - cx, p.sy / p.n - cy) : 0 }))
    .sort((a, b) => b.d - a.d);
  ordered.forEach((o, rank) => {
    const p = plates[o.i];
    const px = p.n ? p.sx / p.n : cx;
    const py = p.n ? p.sy / p.n : cy;
    const len = Math.max(1, Math.hypot(px - cx, py - cy));
    p.dx = (px - cx) / len;
    p.dy = (py - cy) / len;
    p.reach = 0.62 + (o.d / (fitH * 0.5)) * 0.75;
    // Stagger arrivals across the first two thirds of the animation.
    p.delay = (rank / Math.max(1, ordered.length - 1)) * 0.55;
  });
}
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
    arc: null,          // { r, glow, blast, spin, alpha, y } arc reactor overlay
    revealY: null,      // materialise upward: clear everything above this row
    revealScan: null,   // a lit band sweeping down, nothing cleared
    assemble: null,     // 0 = pieces scattered, 1 = fully assembled
    rays: null,         // { n, r0, r1, power, spin, color } radial beams
    burst: null,        // { r, power } full-frame flash centred on the reactor
    sparks: null,       // { n, r, power, seed } debris flecks
    flare: null,        // { len, power } anamorphic streak through the reactor
    lit: null,          // { power, r } reactor light spilling onto the plating
    helmetAlpha: 1,     // fade the helmet itself in or out
    ...opt,
  };

  const cv = new Canvas(FRAME_W, FRAME_H);

  if (o.assemble !== null) {
    // Every plate travels along its own vector on its own clock, easing out as
    // it seats. Outer plates leave first, so the helmet closes inward.
    for (let y = 0; y < fitH; y++) {
      for (let x = 0; x < fitW; x++) {
        const c = small.get(x, y);
        if (!c[3]) continue;
        const p = plates[plateSmall[y * fitW + x]];
        if (!p) continue;
        const prog = clamp((o.assemble - p.delay) / Math.max(0.001, 1 - p.delay), 0, 1);
        const k = (1 - prog) ** 2;
        cv.px(
          OX + o.dx + x + Math.round(p.dx * p.reach * k * ASSEMBLE_SPREAD),
          OY + o.dy + y + Math.round(p.dy * p.reach * k * ASSEMBLE_SPREAD),
          [c[0], c[1], c[2], Math.round(c[3] * Math.min(1, prog * 2.6))]
        );
      }
    }
  } else {
    cv.blitScaled(small, OX + o.dx, OY + o.dy, 1);
  }

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
  // Skipped mid-assembly: the eyes are dark then, and their pixels have moved
  // off their resting position along with the rest of their wedge.
  const midAssembly = o.assemble !== null && o.assemble < 1;
  for (let y = 0; !midAssembly && y < fitH; y++) {
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

  // A lit band sweeping down the faceplate, without clearing anything.
  if (o.revealScan != null) {
    const band = o.revealScan * cv.h;
    for (let y = Math.max(0, band - 12); y < Math.min(cv.h, band + 12); y++) {
      const t = Math.exp(-((y - band) ** 2) / 40);
      for (let x = 0; x < cv.w; x++) {
        if (cv.buf[(y * cv.w + x) * 4 + 3] > 20) addLight(cv, x, y, P.eyeGlow, t * 0.55);
      }
    }
  }

  // Materialise: clear everything above the reveal line, and run a bright
  // edge along it so the helmet looks like it is being built upward.
  if (o.revealY !== null) {
    const cut = Math.round(o.revealY);
    for (let y = 0; y < Math.min(cut, cv.h); y++) {
      for (let x = 0; x < cv.w; x++) cv.buf[(y * cv.w + x) * 4 + 3] = 0;
    }
    for (let y = cut; y < Math.min(cv.h, cut + 9); y++) {
      const t = 1 - (y - cut) / 9;
      for (let x = 0; x < cv.w; x++) {
        if (cv.buf[(y * cv.w + x) * 4 + 3] > 20) addLight(cv, x, y, P.eyeGlow, t * 0.7);
      }
    }
  }

  if (o.helmetAlpha < 1) {
    for (let i = 0; i < cv.w * cv.h; i++) {
      cv.buf[i * 4 + 3] = Math.round(cv.buf[i * 4 + 3] * o.helmetAlpha);
    }
  }

  const arcY = o.arc?.y ?? FRAME_H * 0.62;

  // Radial beams. Positive `converge` pulls them inward for the charge-up.
  if (o.rays) {
    const { n = 14, r0 = 20, r1 = 120, power = 0.6, spin = 0, color = P.eyeGlow } = o.rays;
    const cx = FRAME_W / 2;
    for (let i = 0; i < n; i++) {
      const ang = (i / n + spin) * Math.PI * 2;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      for (let r = r0; r < r1; r += 0.7) {
        const t = 1 - (r - r0) / (r1 - r0);
        const fall = t * t * power;
        if (fall < 0.01) continue;
        for (let w = -1.5; w <= 1.5; w += 0.75) {
          addLight(cv, Math.round(cx + ca * r - sa * w), Math.round(arcY + sa * r + ca * w),
            color, fall * (1 - Math.abs(w) / 2.2));
        }
      }
    }
  }

  // Light thrown back onto the plating by the reactor. Without this the blast
  // looks like a sticker sitting on top of the helmet rather than a light
  // source in front of it.
  if (o.lit) {
    const { power = 0.5, r: lr = 110 } = o.lit;
    for (let y = 0; y < cv.h; y++) {
      for (let x = 0; x < cv.w; x++) {
        const q = (y * cv.w + x) * 4;
        if (cv.buf[q + 3] < 30) continue;
        const d = Math.hypot(x - FRAME_W / 2, y - arcY) / lr;
        if (d > 1.6) continue;
        addLight(cv, x, y, P.eyeGlow, Math.exp(-d * d * 1.5) * power);
      }
    }
  }

  // Anamorphic streak — the wide horizontal flare a bright point source makes.
  if (o.flare) {
    const { len = 150, power = 0.8 } = o.flare;
    for (let dx = -len; dx <= len; dx++) {
      const t = 1 - Math.abs(dx) / len;
      const a = t * t * t * power;
      for (let dy = -3; dy <= 3; dy++) {
        addLight(cv, Math.round(FRAME_W / 2 + dx), Math.round(arcY + dy),
          [200, 240, 255, 255], a * (1 - Math.abs(dy) / 4));
      }
    }
    for (let dy = -len * 0.45; dy <= len * 0.45; dy++) {
      const t = 1 - Math.abs(dy) / (len * 0.45);
      addLight(cv, Math.round(FRAME_W / 2), Math.round(arcY + dy), [220, 245, 255, 255], t * t * power * 0.7);
    }
  }

  // The detonation itself: a soft white dome over the whole frame.
  if (o.burst) {
    const { r: br = 160, power = 0.8 } = o.burst;
    for (let y = 0; y < cv.h; y++) {
      for (let x = 0; x < cv.w; x++) {
        const d = Math.hypot(x - FRAME_W / 2, y - arcY) / br;
        if (d > 1.4) continue;
        addLight(cv, x, y, [255, 255, 255, 255], Math.exp(-d * d * 2.2) * power);
      }
    }
  }

  // Debris flecks thrown outward. Seeded, so frames stay reproducible.
  if (o.sparks) {
    const { n = 22, r = 90, power = 0.9, seed = 1 } = o.sparks;
    let rnd = seed * 9301;
    const next = () => ((rnd = (rnd * 9301 + 49297) % 233280) / 233280);
    for (let i = 0; i < n; i++) {
      const ang = next() * Math.PI * 2;
      const dist = r * (0.55 + next() * 0.65);
      const sx = Math.round(FRAME_W / 2 + Math.cos(ang) * dist);
      const sy = Math.round(arcY + Math.sin(ang) * dist);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          addLight(cv, sx + dx, sy + dy, P.goldHi, power * (dx || dy ? 0.28 : 1));
        }
      }
    }
  }

  // Arc reactor, drawn over everything.
  if (o.arc) {
    drawArcReactor(cv, FRAME_W / 2, arcY, o.arc.r, {
      glow: o.arc.glow ?? 1,
      spin: o.arc.spin ?? 0,
      blast: o.arc.blast ?? 0,
      alpha: o.arc.alpha ?? 1,
      housing: o.arc.housing,
    });
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
  // Completely static: one frame, no animation clock at all. A desktop pet
  // that moves while it has nothing to say is a distraction, and the renderer
  // schedules no timer for a single-frame row, so idle costs literally nothing.
  // Life comes from the flourishes below, a few minutes apart.
  { name: 'idle', fps: 1, frames: [
    { eyeLevel: 0.92, bloom: 0.68 },
  ]},
  // A status the pet holds for minutes at a time, so no bouncing: just the
  // scanner sweeping the eye slits, slowly.
  { name: 'running', fps: 5, frames: [
    { eyeLevel: 0.95, bloom: 0.80, scanY: fitH * 0.38 },
    { eyeLevel: 1.00, bloom: 0.88, scanY: fitH * 0.42 },
    { eyeLevel: 1.00, bloom: 0.90, scanY: fitH * 0.46 },
    { eyeLevel: 1.00, bloom: 0.88, scanY: fitH * 0.50 },
    { eyeLevel: 0.95, bloom: 0.80, scanY: fitH * 0.46 },
    { eyeLevel: 0.92, bloom: 0.76 },
  ]},
  // Loud enough to catch your eye, not so loud it is annoying to sit next to.
  // The renderer settles this to a still frame after a minute anyway.
  { name: 'needs_input', fps: 4, frames: [
    { dx: -2, eye: AMBER, eyeLevel: 1.0, bloom: 1.1, bang: true },
    { dx: 2, eye: P.eyeCore, eyeLevel: 0.75, bloom: 0.55, bang: true },
    { dx: -2, eye: AMBER, eyeLevel: 1.0, bloom: 1.1, bang: true },
    { dx: 2, eye: P.eyeCore, eyeLevel: 0.75, bloom: 0.55, bang: true },
  ]},
  { name: 'ready', fps: 4, frames: [
    { eyeLevel: 1.0, bloom: 0.95, shimmer: 0.2 },
    { dy: -1, eyeLevel: 1.0, bloom: 1.0, shimmer: 0.45 },
    { dy: -1, eyeLevel: 1.0, bloom: 1.0, shimmer: 0.7 },
    { eyeLevel: 0.95, bloom: 0.9, shimmer: 0.95 },
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

ROWS.push({ name: 'idle_look', fps: 3, frames: [
  { eyeLevelL: 1.0, eyeLevelR: 0.40, bloom: 0.6 },
  { eyeLevelL: 1.0, eyeLevelR: 0.40, bloom: 0.6 },
  { eyeLevel: 0.88, bloom: 0.62 },
  { eyeLevelL: 0.40, eyeLevelR: 1.0, bloom: 0.6 },
  { eyeLevelL: 0.40, eyeLevelR: 1.0, bloom: 0.6 },
  { eyeLevel: 0.88, bloom: 0.62 },
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

// Arc reactor: wind up, overload, detonate, recoil, settle.
ROWS.push({ name: 'arc_blast', fps: 14, frames: [
  // --- wind-up: beams drawn inward, plating starting to catch the light
  { eyeLevel: 0.9, bloom: 0.7, arc: { r: 11, glow: 0.5, alpha: 0.9 },
    rays: { n: 16, r0: 78, r1: 28, power: 0.2 }, lit: { power: 0.1, r: 80 } },
  { dy: 1, eyeLevel: 1.0, bloom: 0.9, arc: { r: 18, glow: 1.0, spin: 0.02 },
    rays: { n: 16, r0: 60, r1: 25, power: 0.32, spin: 0.02 }, lit: { power: 0.2, r: 95 } },
  { dy: 2, eyeLevel: 1.15, bloom: 1.1, arc: { r: 24, glow: 1.6, spin: 0.05 },
    rays: { n: 16, r0: 44, r1: 23, power: 0.48, spin: 0.05 }, lit: { power: 0.34, r: 110 } },
  // --- overload: the helmet leans back into it
  { dy: 4, eyeLevel: 1.35, bloom: 1.5, arc: { r: 29, glow: 2.3, spin: 0.09 },
    lit: { power: 0.55, r: 130 }, flare: { len: 70, power: 0.35 }, burst: { r: 80, power: 0.3 } },
  // --- detonation
  { dy: -6, eyeLevel: 1.7, bloom: 2.1, arc: { r: 34, glow: 3.0, spin: 0.13, blast: 34 },
    burst: { r: 230, power: 1.0 }, flare: { len: 210, power: 1.0 },
    rays: { n: 22, r0: 24, r1: 165, power: 0.9, spin: 0.13 },
    lit: { power: 0.9, r: 190 }, sparks: { n: 30, r: 62, power: 0.95, seed: 3 } },
  { dy: -5, eyeLevel: 1.6, bloom: 1.8, arc: { r: 31, glow: 2.4, spin: 0.18, blast: 76 },
    burst: { r: 175, power: 0.58 }, flare: { len: 165, power: 0.6 },
    rays: { n: 22, r0: 58, r1: 205, power: 0.62, spin: 0.18 },
    lit: { power: 0.6, r: 160 }, sparks: { n: 26, r: 112, power: 0.8, seed: 5 } },
  { dy: -2, eyeLevel: 1.4, bloom: 1.5, arc: { r: 27, glow: 1.6, spin: 0.22, blast: 124 },
    flare: { len: 110, power: 0.32 },
    rays: { n: 22, r0: 104, r1: 240, power: 0.38, spin: 0.22 },
    lit: { power: 0.34, r: 140 }, sparks: { n: 22, r: 158, power: 0.55, seed: 7 }, shimmer: 0.4 },
  // --- recoil and aftershock
  { dy: 3, eyeLevel: 1.2, bloom: 1.2, arc: { r: 23, glow: 1.0, spin: 0.26, blast: 172 },
    sparks: { n: 16, r: 196, power: 0.32, seed: 11 }, shimmer: 0.65, lit: { power: 0.16, r: 120 } },
  { dy: 1, eyeLevel: 1.05, bloom: 0.95, arc: { r: 18, glow: 0.7, alpha: 0.35, housing: false },
    shimmer: 0.88 },
  { dy: 0, eyeLevel: 0.95, bloom: 0.78 },
]});

// A diagnostic sweep down the whole faceplate.
ROWS.push({ name: 'scan', fps: 10, frames: [
  { eyeLevel: 1.0, bloom: 0.8, revealScan: 0.05 },
  { eyeLevel: 1.0, bloom: 0.85, revealScan: 0.25 },
  { eyeLevel: 1.1, bloom: 0.9, revealScan: 0.45 },
  { eyeLevel: 1.1, bloom: 0.9, revealScan: 0.65 },
  { eyeLevel: 1.0, bloom: 0.85, revealScan: 0.85 },
  { eyeLevel: 0.95, bloom: 0.75 },
]});

// Boot: the reactor spins up, then the helmet's own plates fly in and seat.
ROWS.push({ name: 'boot', fps: 12, frames: [
  { assemble: 0, eyeLevel: 0, bloom: 0, arc: { r: 7, glow: 0.35, y: FRAME_H * 0.5 } },
  { assemble: 0, eyeLevel: 0, bloom: 0, arc: { r: 16, glow: 0.85, y: FRAME_H * 0.5, spin: 0.03 },
    rays: { n: 14, r0: 62, r1: 26, power: 0.28, spin: 0.03 } },
  { assemble: 0, eyeLevel: 0, bloom: 0, arc: { r: 28, glow: 1.7, y: FRAME_H * 0.5, spin: 0.08 },
    rays: { n: 14, r0: 44, r1: 24, power: 0.5, spin: 0.08 }, flare: { len: 90, power: 0.4 } },
  { assemble: 0.06, eyeLevel: 0, bloom: 0, arc: { r: 33, glow: 2.3, y: FRAME_H * 0.5, spin: 0.12, blast: 40 },
    burst: { r: 130, power: 0.45 }, flare: { len: 150, power: 0.6 } },
  { assemble: 0.18, eyeLevel: 0, bloom: 0, arc: { r: 29, glow: 1.8, y: FRAME_H * 0.5, spin: 0.16, blast: 86 } },
  { assemble: 0.31, eyeLevel: 0, bloom: 0, arc: { r: 26, glow: 1.5, y: FRAME_H * 0.5, spin: 0.2 } },
  { assemble: 0.44, eyeLevel: 0, bloom: 0, arc: { r: 24, glow: 1.3, y: FRAME_H * 0.5, spin: 0.24 } },
  { assemble: 0.57, eyeLevel: 0, bloom: 0, arc: { r: 21, glow: 1.1, y: FRAME_H * 0.5, spin: 0.28, alpha: 0.85 } },
  { assemble: 0.70, eyeLevel: 0, bloom: 0, arc: { r: 18, glow: 0.9, y: FRAME_H * 0.5, alpha: 0.6, housing: false } },
  { assemble: 0.82, eyeLevel: 0, bloom: 0, arc: { r: 15, glow: 0.7, y: FRAME_H * 0.5, alpha: 0.4, housing: false } },
  { assemble: 0.92, eyeLevel: 0, bloom: 0, arc: { r: 12, glow: 0.5, y: FRAME_H * 0.5, alpha: 0.22, housing: false } },
  { assemble: 1, eyeLevel: 0, bloom: 0, sparks: { n: 18, r: 76, power: 0.45, seed: 2 } },
  { assemble: 1, eyeLevel: 0.12, bloom: 0.1 },
  { dy: -3, eyeLevel: 1.7, bloom: 2.0, flash: { at: 0.4, color: [255, 255, 255, 255], power: 0.9 },
    flare: { len: 60, power: 0.3 } },
  { dy: -1, eyeLevel: 1.15, bloom: 1.05, shimmer: 0.5 },
  { dy: 0, eyeLevel: 0.95, bloom: 0.78 },
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
  flourishes: { idle: ['idle_scan', 'idle_look', 'idle_power'] },
  settles: ['needs_input', 'blocked', 'ready'],
  boot: 'boot',
  actions: {
    poke:      { animation: 'poke', once: true },
    ping:      { animation: 'ping', once: true, label: 'Repulsor' },
    arc_blast: { animation: 'arc_blast', once: true, label: 'Arc Blast' },
    scan:      { animation: 'scan', once: true, label: 'Scan' },
    boot:      { animation: 'boot', once: true, label: 'Reboot' },
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
