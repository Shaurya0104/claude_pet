'use strict';
/**
 * Minimal PNG reader — enough to load an 8-bit image into a Canvas.
 *
 * We already hand-roll the encoder in pixel.js; this is the other direction,
 * so source art can be read without pulling in an image library.
 * Supports bit depth 8, colour types 0/2/4/6, non-interlaced.
 */
const fs = require('fs');
const zlib = require('zlib');
const { Canvas } = require('./pixel');

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 }; // grey, RGB, grey+alpha, RGBA

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decode(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: not a PNG`);

  let pos = 8;
  let ihdr = null;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len; // length + type + data + crc
  }

  if (!ihdr) throw new Error('no IHDR');
  if (ihdr.depth !== 8) throw new Error(`unsupported bit depth ${ihdr.depth} (need 8)`);
  if (ihdr.interlace) throw new Error('interlaced PNGs are not supported');
  const ch = CHANNELS[ihdr.colorType];
  if (!ch) throw new Error(`unsupported colour type ${ihdr.colorType}`);

  const { width: w, height: h } = ihdr;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(stride * h);

  // Undo the per-scanline filters.
  let ri = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[ri++];
    const line = raw.subarray(ri, ri + stride);
    ri += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      cur[x] = v & 0xff;
    }
  }

  const cv = new Canvas(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * stride + x * ch;
      let r, g, b, a = 255;
      if (ch === 1) { r = g = b = out[i]; }
      else if (ch === 2) { r = g = b = out[i]; a = out[i + 1]; }
      else if (ch === 3) { r = out[i]; g = out[i + 1]; b = out[i + 2]; }
      else { r = out[i]; g = out[i + 1]; b = out[i + 2]; a = out[i + 3]; }
      const o = (y * w + x) * 4;
      cv.buf[o] = r; cv.buf[o + 1] = g; cv.buf[o + 2] = b; cv.buf[o + 3] = a;
    }
  }
  return cv;
}

module.exports = { decode };
