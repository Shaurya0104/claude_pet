'use strict';
/**
 * The pet, drawn from primitives.
 *
 * This is the file to edit if you want a different creature. Everything the
 * app shows comes from here, so there is no third-party art anywhere in the
 * project and nothing to license or attribute.
 */

const C = {
  ink:    [0x10, 0x2a, 0x38, 255],
  body:   [0x4f, 0xc3, 0xf7, 255],
  bodyLo: [0x29, 0x93, 0xc4, 255],
  bodyHi: [0x9d, 0xe4, 0xff, 255],
  white:  [0xff, 0xff, 0xff, 255],
  pupil:  [0x0d, 0x1f, 0x29, 255],
  blush:  [0xff, 0x8a, 0x9b, 200],
  gold:   [0xff, 0xd1, 0x66, 255],
  goldLo: [0xd9, 0xa4, 0x2f, 255],
  red:    [0xff, 0x6b, 0x6b, 255],
  grey:   [0x8a, 0x9b, 0xa6, 255],
  greyLo: [0x5e, 0x6d, 0x78, 255],
  greyHi: [0xb8, 0xc6, 0xcf, 255],
  green:  [0x7b, 0xe0, 0x8a, 255],
};

const FRAME = 48; // every frame is 48x48

const DEFAULTS = {
  bob: 0,            // vertical offset — the breathing
  squash: 0,         // >0 wider and shorter, <0 taller and thinner
  eyes: 'open',      // open | blink | happy | wide | dead
  lookX: 0,
  mouth: 'smile',    // smile | flat | open | frown
  body: C.body, bodyLo: C.bodyLo, bodyHi: C.bodyHi,
  antenna: C.gold,
  antennaLean: 0,
  arms: 0,           // 0 rest, 1 waving, -1 down
  blush: false,
  item: null,        // spark | bang | box | zzz
  itemPhase: 0,
  shadow: true,
};

function drawPet(cv, ox, oy, opts) {
  const o = { ...DEFAULTS, ...opts };
  const cx = ox + FRAME / 2;
  const baseY = oy + 30 + o.bob;
  const rx = 13 + o.squash;
  const ry = 12 - o.squash;

  if (o.shadow) cv.ellipse(cx, oy + 43, 11 - o.squash * 0.5, 2.5, [0, 0, 0, 46]);

  // antenna
  const topY = baseY - ry;
  for (let i = 0; i < 6; i++) cv.px(cx + (o.antennaLean * i) / 6, topY - i, C.ink);
  cv.ellipse(cx + o.antennaLean, topY - 8, 2.6, 2.6, o.antenna, C.ink);
  cv.px(cx + o.antennaLean - 1, topY - 9, C.white);

  // ears
  const earY = baseY - ry + 2;
  cv.ellipse(cx - rx + 2, earY, 3.4, 4.2, o.body, C.ink);
  cv.ellipse(cx + rx - 2, earY, 3.4, 4.2, o.body, C.ink);

  // body, with a lit upper-left and a shaded lower-right
  cv.ellipse(cx, baseY, rx, ry, o.body, C.ink);
  for (let y = -ry; y <= ry; y++) {
    for (let x = -rx; x <= rx; x++) {
      if ((x / rx) ** 2 + (y / ry) ** 2 > 1) continue;
      if (x - y > rx * 0.75) cv.px(cx + x, baseY + y, o.bodyLo);
    }
  }
  cv.ellipse(cx - rx * 0.42, baseY - ry * 0.45, 3.2, 2.4, o.bodyHi);

  // arms
  const armY = baseY + 2;
  if (o.arms === 1) {
    cv.ellipse(cx - rx - 1, armY, 2.6, 3.2, o.body, C.ink);
    cv.ellipse(cx + rx + 1, armY - 7, 2.8, 2.8, o.body, C.ink);
    for (let i = 0; i < 5; i++) cv.px(cx + rx + 0.5, armY - i, C.ink);
  } else if (o.arms === -1) {
    cv.ellipse(cx - rx - 1, armY + 3, 2.6, 3, o.body, C.ink);
    cv.ellipse(cx + rx + 1, armY + 3, 2.6, 3, o.body, C.ink);
  } else {
    cv.ellipse(cx - rx - 1, armY, 2.6, 3.2, o.body, C.ink);
    cv.ellipse(cx + rx + 1, armY, 2.6, 3.2, o.body, C.ink);
  }

  // eyes
  const ey = baseY - 2;
  const eye = (x) => {
    if (o.eyes === 'blink') {
      cv.rect(x - 2, ey, 5, 1, C.ink);
    } else if (o.eyes === 'happy') {
      cv.px(x - 2, ey, C.ink); cv.px(x - 1, ey - 1, C.ink); cv.px(x, ey - 2, C.ink);
      cv.px(x + 1, ey - 1, C.ink); cv.px(x + 2, ey, C.ink);
    } else if (o.eyes === 'dead') {
      for (let i = -2; i <= 2; i++) { cv.px(x + i, ey + i, C.ink); cv.px(x + i, ey - i, C.ink); }
    } else {
      const r = o.eyes === 'wide' ? 3.4 : 2.7;
      cv.ellipse(x, ey, r, r + 0.4, C.white, C.ink);
      cv.ellipse(x + o.lookX, ey + 0.4, r - 1.3, r - 1, C.pupil);
      cv.px(x + o.lookX - 1, ey - 1, C.white);
    }
  };
  eye(cx - 5); eye(cx + 5);

  if (o.blush) {
    cv.ellipse(cx - 9, ey + 4, 2.2, 1.3, C.blush);
    cv.ellipse(cx + 9, ey + 4, 2.2, 1.3, C.blush);
  }

  // mouth
  const my = ey + 6;
  if (o.mouth === 'smile') {
    cv.px(cx - 2, my, C.ink); cv.px(cx - 1, my + 1, C.ink);
    cv.px(cx, my + 1, C.ink); cv.px(cx + 1, my + 1, C.ink); cv.px(cx + 2, my, C.ink);
  } else if (o.mouth === 'flat') {
    cv.rect(cx - 2, my, 5, 1, C.ink);
  } else if (o.mouth === 'open') {
    cv.ellipse(cx, my + 1, 2.4, 2.2, C.ink);
  } else if (o.mouth === 'frown') {
    cv.px(cx - 2, my + 1, C.ink); cv.px(cx - 1, my, C.ink);
    cv.px(cx, my, C.ink); cv.px(cx + 1, my, C.ink); cv.px(cx + 2, my + 1, C.ink);
  }

  // held item / effect
  const ix = ox + 38, iy = oy + 12 - o.itemPhase;
  if (o.item === 'spark') {
    cv.px(ix, iy, C.gold); cv.px(ix + 1, iy, C.gold); cv.px(ix, iy + 1, C.goldLo);
    cv.px(ix + 4, iy + 5 + o.itemPhase, C.gold);
  } else if (o.item === 'bang') {
    cv.rect(ix - 1, iy, 3, 7, C.red);
    cv.rect(ix - 1, iy + 9, 3, 3, C.red);
  } else if (o.item === 'box') {
    cv.rect(ix - 5, iy + 4, 11, 9, C.gold);
    for (let i = 0; i < 11; i++) { cv.px(ix - 5 + i, iy + 4, C.ink); cv.px(ix - 5 + i, iy + 12, C.ink); }
    for (let j = 0; j < 9; j++) { cv.px(ix - 5, iy + 4 + j, C.ink); cv.px(ix + 5, iy + 4 + j, C.ink); }
    cv.rect(ix - 1, iy + 4, 2, 9, C.green);
  } else if (o.item === 'zzz') {
    const z = (x, y, s) => {
      for (let i = 0; i < s; i++) {
        cv.px(x + i, y, C.white); cv.px(x + s - 1 - i, y + i, C.white); cv.px(x + i, y + s - 1, C.white);
      }
    };
    z(ix, iy + 6, 3); z(ix + 4, iy + 1, 4);
  }
}

const grey = { body: C.grey, bodyLo: C.greyLo, bodyHi: C.greyHi, antenna: C.greyLo };

/** One entry per state, in sprite-sheet row order. */
const STATES = [
  {
    name: 'idle',
    frames: [
      { bob: 0, eyes: 'open' },
      { bob: -1, eyes: 'open' },
      { bob: 0, eyes: 'open' },
      { bob: 1, eyes: 'blink' },
    ],
  },
  {
    name: 'running',
    frames: [
      { bob: 1, squash: 1.5, mouth: 'open', item: 'spark', itemPhase: 0, lookX: 1 },
      { bob: -2, squash: -1.5, mouth: 'open', item: 'spark', itemPhase: 2, lookX: 1 },
      { bob: 0, squash: 0, mouth: 'open', item: 'spark', itemPhase: 4, lookX: -1 },
      { bob: 1, squash: 1.5, mouth: 'open', item: 'spark', itemPhase: 1, lookX: -1 },
      { bob: -2, squash: -1.5, mouth: 'open', item: 'spark', itemPhase: 3, lookX: 0 },
      { bob: 0, squash: 0, mouth: 'open', item: 'spark', itemPhase: 5, lookX: 0 },
    ],
  },
  {
    name: 'needs_input',
    frames: [
      { bob: 0, eyes: 'wide', mouth: 'open', arms: 1, item: 'bang', antennaLean: 2 },
      { bob: -2, eyes: 'wide', mouth: 'open', arms: 1, item: 'bang', antennaLean: -2 },
      { bob: 0, eyes: 'wide', mouth: 'open', arms: 1, item: null, antennaLean: 2 },
      { bob: -2, eyes: 'wide', mouth: 'open', arms: 1, item: null, antennaLean: -2 },
    ],
  },
  {
    name: 'ready',
    frames: [
      { bob: 0, eyes: 'happy', blush: true, item: 'box', arms: -1 },
      { bob: -1, eyes: 'happy', blush: true, item: 'box', arms: -1, itemPhase: 1 },
      { bob: 0, eyes: 'happy', blush: true, item: 'box', arms: -1 },
      { bob: -1, eyes: 'open', blush: true, item: 'box', arms: -1, itemPhase: 1 },
    ],
  },
  {
    name: 'blocked',
    frames: [
      { ...grey, bob: 2, squash: 2, eyes: 'dead', mouth: 'frown', arms: -1, antennaLean: 4 },
      { ...grey, bob: 3, squash: 2, eyes: 'dead', mouth: 'frown', arms: -1, antennaLean: 5 },
      { ...grey, bob: 2, squash: 2, eyes: 'dead', mouth: 'frown', arms: -1, antennaLean: 4 },
      { ...grey, bob: 3, squash: 2, eyes: 'dead', mouth: 'flat', arms: -1, antennaLean: 3 },
    ],
  },
];

module.exports = { C, FRAME, drawPet, STATES };
