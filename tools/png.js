'use strict';
/* tools/png.js — a minimal RGBA PNG encoder + a tiny 4x-supersampled rasteriser.
   No dependencies: the icons are generated, not shipped as binary blobs. */

const zlib = require('zlib');

function crc32(buf) {
  let c, table = crc32._t;
  if (!table) {
    table = crc32._t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

/** rgba: Buffer of w*h*4 */
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;       // bit depth
  ihdr[9] = 6;       // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;   // filter: none — deterministic and plenty small here
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function hex(c) {
  const s = c.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

/* A 4x supersampled canvas: draw in device pixels * 4, then box-filter down.
   Enough antialiasing for a rounded square and a couple of bars. */
function canvas(size, ss) {
  ss = ss || 4;
  const W = size * ss;
  const buf = Buffer.alloc(W * W * 4, 0);
  const api = {
    W, ss,
    clear() { buf.fill(0); },
    px(x, y, rgb, a) {
      if (x < 0 || y < 0 || x >= W || y >= W) return;
      const i = (y * W + x) * 4;
      const na = a == null ? 255 : a;
      // source-over onto whatever is there
      const da = buf[i + 3];
      const out = na + da * (255 - na) / 255;
      if (out <= 0) { buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0; return; }
      for (let k = 0; k < 3; k++) {
        buf[i + k] = Math.round((rgb[k] * na + buf[i + k] * da * (255 - na) / 255) / out);
      }
      buf[i + 3] = Math.round(out);
    },
    fillRect(x, y, w, h, rgb) {
      const x0 = Math.round(x * ss), y0 = Math.round(y * ss);
      const x1 = Math.round((x + w) * ss), y1 = Math.round((y + h) * ss);
      for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) api.px(px, py, rgb, 255);
    },
    fillRoundRect(x, y, w, h, r, rgb) {
      const x0 = x * ss, y0 = y * ss, x1 = (x + w) * ss, y1 = (y + h) * ss, rr = r * ss;
      for (let py = Math.floor(y0); py < Math.ceil(y1); py++) {
        for (let px = Math.floor(x0); px < Math.ceil(x1); px++) {
          const cx = px + 0.5, cy = py + 0.5;
          let dx = 0, dy = 0;
          if (cx < x0 + rr) dx = x0 + rr - cx; else if (cx > x1 - rr) dx = cx - (x1 - rr);
          if (cy < y0 + rr) dy = y0 + rr - cy; else if (cy > y1 - rr) dy = cy - (y1 - rr);
          if (dx * dx + dy * dy > rr * rr) continue;
          api.px(px, py, rgb, 255);
        }
      }
    },
    fillCircle(cxu, cyu, ru, rgb) {
      const cx = cxu * ss, cy = cyu * ss, r = ru * ss;
      for (let py = Math.floor(cy - r); py <= Math.ceil(cy + r); py++) {
        for (let px = Math.floor(cx - r); px <= Math.ceil(cx + r); px++) {
          const ddx = px + 0.5 - cx, ddy = py + 0.5 - cy;
          if (ddx * ddx + ddy * ddy > r * r) continue;
          api.px(px, py, rgb, 255);
        }
      }
    },
    /* box-filter down to `size` x `size` RGBA */
    resolve() {
      const out = Buffer.alloc(size * size * 4);
      const n = ss * ss;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          let r = 0, g = 0, b = 0, a = 0;
          for (let sy = 0; sy < ss; sy++) {
            for (let sx = 0; sx < ss; sx++) {
              const i = ((y * ss + sy) * W + (x * ss + sx)) * 4;
              const pa = buf[i + 3];
              r += buf[i] * pa; g += buf[i + 1] * pa; b += buf[i + 2] * pa; a += pa;
            }
          }
          const o = (y * size + x) * 4;
          if (a === 0) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; }
          else {
            out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a);
            out[o + 2] = Math.round(b / a); out[o + 3] = Math.round(a / n);
          }
        }
      }
      return out;
    }
  };
  return api;
}

module.exports = { encodePNG, canvas, hex };
