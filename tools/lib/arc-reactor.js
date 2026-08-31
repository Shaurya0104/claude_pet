'use strict';
/**
 * The arc reactor, drawn from primitives.
 *
 * Generated rather than downloaded, for the same reason as everything else
 * here: no licence to honour, no asset to ship, and it scales to any size
 * because it is geometry rather than pixels.
 */

const C = {
  shell:    [0x2a, 0x2f, 0x36, 255],
  shellHi:  [0x5c, 0x66, 0x72, 255],
  shellLo:  [0x14, 0x18, 0x1d, 255],
  copper:   [0xc8, 0x93, 0x4a, 255],
  coreHot:  [0xff, 0xff, 0xff, 255],
  coreCool: [0x8f, 0xe9, 0xff, 255],
  ring:     [0x5a, 0xd8, 0xff, 255],
};

/**
 * @param {Canvas} cv
 * @param {number} cx,cy   centre
 * @param {number} r       outer radius
 * @param {object} [o]
 * @param {number} [o.glow=1]      0 = dark and dead, 1 = fully lit, >1 = flaring
 * @param {number} [o.spin=0]      rotation in turns, for the coil segments
 * @param {number} [o.blast=0]     0 = none, else radius of the shockwave ring
 * @param {number} [o.alpha=1]     overall opacity
 * @param {boolean} [o.housing=true] draw the metal ring and coils. Turn it off
 *   when fading out: dark metal at low alpha reads as a grey smudge rather
 *   than a dimming light, so a fading reactor should be glow only.
 */
function drawArcReactor(cv, cx, cy, r, o = {}) {
  const glow = o.glow ?? 1;
  const spin = o.spin ?? 0;
  const alpha = o.alpha ?? 1;
  const A = (c, a) => [c[0], c[1], c[2], Math.max(0, Math.min(255, Math.round(255 * a * alpha)))];

  // --- outer halo, drawn first so everything else sits on top
  const halo = r * (2.1 + glow * 0.7);
  for (let y = -halo; y <= halo; y++) {
    for (let x = -halo; x <= halo; x++) {
      const d = Math.hypot(x, y);
      if (d > halo || d < r * 0.9) continue;
      const t = 1 - (d - r * 0.9) / (halo - r * 0.9);
      const a = t * t * 0.5 * glow;
      if (a > 0.004) cv.px(cx + x, cy + y, A(C.coreCool, a));
    }
  }

  const housing = o.housing !== false;

  // --- housing: a metal ring with a lit upper-left edge
  if (housing) {
  cv.ellipse(cx, cy, r, r, A(C.shell, 1));
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      const d = Math.hypot(x, y);
      if (d > r || d < r * 0.78) continue;
      const lit = (-x - y) / (r * 2) + 0.5;         // upper-left is brightest
      cv.px(cx + x, cy + y, A(lit > 0.55 ? C.shellHi : C.shellLo, 1));
    }
  }

  // --- copper coil segments around the inner bezel
  const SEG = 10;
  for (let s = 0; s < SEG; s++) {
    const ang = (s / SEG + spin) * Math.PI * 2;
    const rr = r * 0.63;
    const sx = cx + Math.cos(ang) * rr;
    const sy = cy + Math.sin(ang) * rr;
    cv.ellipse(sx, sy, r * 0.115, r * 0.115, A(C.copper, 1));
    cv.ellipse(sx, sy, r * 0.055, r * 0.055, A(C.shellLo, 1));
  }

  // --- inner well
  cv.ellipse(cx, cy, r * 0.52, r * 0.52, A(C.shellLo, 1));
  }

  // --- the light itself: a ring and a hot core
  const ringR = r * 0.44;
  for (let y = -ringR - 2; y <= ringR + 2; y++) {
    for (let x = -ringR - 2; x <= ringR + 2; x++) {
      const d = Math.hypot(x, y);
      const band = Math.exp(-((d - ringR * 0.86) ** 2) / (r * r * 0.006));
      if (band > 0.02) cv.px(cx + x, cy + y, A(C.ring, band * glow));
    }
  }

  const coreR = r * 0.3;
  for (let y = -coreR * 2; y <= coreR * 2; y++) {
    for (let x = -coreR * 2; x <= coreR * 2; x++) {
      const d = Math.hypot(x, y) / coreR;
      if (d > 2) continue;
      const a = Math.exp(-d * d * 1.6) * glow;
      if (a > 0.01) cv.px(cx + x, cy + y, A(d < 0.55 ? C.coreHot : C.coreCool, a));
    }
  }

  // --- the triangle, the bit everyone actually recognises.
  // Signed distance to an equilateral triangle: the max of its three edge
  // half-planes. Negative inside, so a band just inside zero is the outline.
  const triR = r * 0.4;
  const T = 0.26;                     // outline thickness, in triangle radii
  for (let y = -triR * 1.2; y <= triR * 1.2; y++) {
    for (let x = -triR * 1.2; x <= triR * 1.2; x++) {
      const px = x / triR, py = y / triR;
      const f = Math.max(
        py - 0.5,                     // bottom edge
        0.866 * px - 0.5 * py - 0.5,  // right edge
        -0.866 * px - 0.5 * py - 0.5  // left edge
      );
      if (f < 0 && f > -T) cv.px(cx + x, cy + y, A(C.coreHot, 0.9 * glow));
    }
  }

  // --- shockwave ring, for the blast
  if (o.blast) {
    const br = o.blast;
    for (let y = -br - 4; y <= br + 4; y++) {
      for (let x = -br - 4; x <= br + 4; x++) {
        const d = Math.hypot(x, y);
        const band = Math.exp(-((d - br) ** 2) / (br * 0.9));
        if (band > 0.02) cv.px(cx + x, cy + y, A(C.coreCool, band * 0.75));
      }
    }
  }
}

module.exports = { drawArcReactor, ARC: C };
