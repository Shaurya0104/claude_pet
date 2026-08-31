'use strict';
/** A tiny RGBA canvas with just enough primitives, plus a hand-rolled PNG encoder. */
const zlib = require('zlib');

class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.buf = new Uint8Array(w * h * 4); // transparent
  }

  px(x, y, c) {
    if (!c) return;
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const a = c[3] / 255;
    if (a >= 1) {
      this.buf[i] = c[0]; this.buf[i + 1] = c[1]; this.buf[i + 2] = c[2]; this.buf[i + 3] = 255;
      return;
    }
    const da = this.buf[i + 3] / 255;
    const oa = a + da * (1 - a);
    for (let k = 0; k < 3; k++) {
      this.buf[i + k] = Math.round((c[k] * a + this.buf[i + k] * da * (1 - a)) / oa);
    }
    this.buf[i + 3] = Math.round(oa * 255);
  }

  get(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return [0, 0, 0, 0];
    const i = (y * this.w + x) * 4;
    return [this.buf[i], this.buf[i + 1], this.buf[i + 2], this.buf[i + 3]];
  }

  rect(x, y, w, h, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, c);
  }

  /** Filled ellipse; `edge` outlines it. */
  ellipse(cx, cy, rx, ry, c, edge) {
    for (let y = Math.floor(cy - ry) - 1; y <= Math.ceil(cy + ry) + 1; y++) {
      for (let x = Math.floor(cx - rx) - 1; x <= Math.ceil(cx + rx) + 1; x++) {
        const dx = (x - cx) / rx, dy = (y - cy) / ry;
        const d = dx * dx + dy * dy;
        if (d <= 1) this.px(x, y, c);
        else if (edge && d <= 1.42) this.px(x, y, edge);
      }
    }
  }

  roundRect(x, y, w, h, r, c) {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const dx = Math.max(r - i, i - (w - 1 - r), 0);
        const dy = Math.max(r - j, j - (h - 1 - r), 0);
        if (dx * dx + dy * dy <= r * r) this.px(x + i, y + j, c);
      }
    }
  }

  /** Nearest-neighbour blit, so pixel art stays sharp when scaled up. */
  blitScaled(src, dx, dy, factor, sx = 0, sy = 0, sw = src.w, sh = src.h) {
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const c = src.get(sx + x, sy + y);
        if (!c[3]) continue;
        for (let j = 0; j < factor; j++) {
          for (let i = 0; i < factor; i++) {
            this.px(dx + x * factor + i, dy + y * factor + j, c);
          }
        }
      }
    }
  }

  crop(x, y, w, h) {
    const out = new Canvas(w, h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const c = this.get(x + i, y + j);
        const o = (j * w + i) * 4;
        out.buf[o] = c[0]; out.buf[o + 1] = c[1]; out.buf[o + 2] = c[2]; out.buf[o + 3] = c[3];
      }
    }
    return out;
  }

  /** Box-filter downscale, averaging in premultiplied alpha so edges stay clean. */
  downscale(w, h) {
    const out = new Canvas(w, h);
    const sx = this.w / w, sy = this.h / h;
    for (let y = 0; y < h; y++) {
      const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let j = y0; j < y1; j++) {
          for (let i = x0; i < x1; i++) {
            const c = this.get(i, j);
            const al = c[3] / 255;
            r += c[0] * al; g += c[1] * al; b += c[2] * al; a += c[3];
            n++;
          }
        }
        if (!n) continue;
        const alphaSum = a / n;
        const o = (y * w + x) * 4;
        if (alphaSum > 0) {
          const wsum = a / 255;
          out.buf[o] = Math.round(r / wsum);
          out.buf[o + 1] = Math.round(g / wsum);
          out.buf[o + 2] = Math.round(b / wsum);
        }
        out.buf[o + 3] = Math.round(alphaSum);
      }
    }
    return out;
  }

  png() {
    const CRC = (() => {
      const t = new Int32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
      }
      return t;
    })();
    const crc32 = (b) => {
      let c = -1;
      for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
      return (c ^ -1) >>> 0;
    };
    const chunk = (type, data) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length, 0);
      const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(body), 0);
      return Buffer.concat([len, body, crc]);
    };

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // RGBA
    const stride = this.w * 4 + 1;
    const raw = Buffer.alloc(stride * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * stride] = 0; // filter: none
      Buffer.from(this.buf.buffer, y * this.w * 4, this.w * 4).copy(raw, y * stride + 1);
    }
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

module.exports = { Canvas };
