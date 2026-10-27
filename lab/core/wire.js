/* lab/core/wire.js: the live lab's message format, shared with lab/bench/tarabench/live/wire.py. A message is a JSON
   value whose typed arrays travel as raw little-endian bytes after it:

     'TLB1' | u32 header length | header JSON, space-padded to 8 bytes | blob, blob, ... (each 8-byte aligned)

   The header is {v: value, b: [[offset, bytes, dtype], ...]}. Inside value, {$b: i} stands for blob i and
   {$f: 'nan' | 'inf' | '-inf'} for a number JSON cannot hold. float16 blobs arrive as Float32Array. */

const TYPES = { f32: Float32Array, f64: Float64Array, i32: Int32Array, i16: Int16Array, i8: Int8Array, u8: Uint8Array, u16: Uint16Array };
const NAMES = new Map(Object.entries(TYPES).map(([k, T]) => [T, k]));
const enc = new TextEncoder(), dec = new TextDecoder();

let HALF = null;
/* every float16 bit pattern's value, so a 20-million-number array converts in one pass of look-ups */
function halfTable() {
  if (HALF) return HALF;
  HALF = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
    HALF[h] = e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15);
  }
  return HALF;
}

export function pack(value) {
  const blobs = [];
  const walk = (x) => {
    if (x === undefined || x === null) return null;
    if (ArrayBuffer.isView(x) && !(x instanceof DataView)) {
      let a = x, name = NAMES.get(x.constructor);
      if (!name) { a = Float64Array.from(x, Number); name = 'f64'; }
      blobs.push([new Uint8Array(a.buffer, a.byteOffset, a.byteLength), name]);
      return { $b: blobs.length - 1 };
    }
    if (Array.isArray(x)) return x.map(walk);
    if (typeof x === 'number') return Number.isFinite(x) ? x : { $f: Number.isNaN(x) ? 'nan' : x > 0 ? 'inf' : '-inf' };
    if (typeof x === 'object') {
      const o = {};
      for (const [k, v] of Object.entries(x)) if (v !== undefined) o[k] = walk(v);
      return o;
    }
    return x;
  };
  const v = walk(value);
  const table = [];
  let off = 0;
  for (const [b, dt] of blobs) { table.push([off, b.byteLength, dt]); off += b.byteLength + ((8 - (b.byteLength % 8)) % 8); }
  const head = enc.encode(JSON.stringify({ v, b: table }));
  const n = head.length + ((8 - (head.length % 8)) % 8), base = 8 + n;
  const out = new Uint8Array(base + off);
  out.set([0x54, 0x4c, 0x42, 0x31], 0);
  new DataView(out.buffer).setUint32(4, n, true);
  out.set(head, 8);
  out.fill(0x20, 8 + head.length, base);
  blobs.forEach(([b], i) => out.set(b, base + table[i][0]));
  return out;
}

export function unpack(data) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (!(u8[0] === 0x54 && u8[1] === 0x4c && u8[2] === 0x42 && u8[3] === 0x31)) return revive(JSON.parse(dec.decode(u8)), []);
  const n = new DataView(u8.buffer, u8.byteOffset, 8).getUint32(4, true);
  const head = JSON.parse(dec.decode(u8.subarray(8, 8 + n)));
  const base = u8.byteOffset + 8 + n;
  const arrays = head.b.map(([off, nb, dt]) => {
    const buf = u8.buffer.slice(base + off, base + off + nb);          // a copy: aligned, and free of the frame
    if (dt === 'f16') {
      const hh = new Uint16Array(buf), t = halfTable(), out = new Float32Array(hh.length);
      for (let i = 0; i < hh.length; i++) out[i] = t[hh[i]];
      return out;
    }
    return new TYPES[dt](buf);
  });
  return revive(head.v, arrays);
}

function revive(x, arrays) {
  if (Array.isArray(x)) return x.map((v) => revive(v, arrays));
  if (x && typeof x === 'object') {
    const keys = Object.keys(x);
    if (keys.length === 1 && keys[0] === '$b') return arrays[x.$b];
    if (keys.length === 1 && keys[0] === '$f') return x.$f === 'nan' ? NaN : x.$f === 'inf' ? Infinity : -Infinity;
    const o = {};
    for (const k of keys) o[k] = revive(x[k], arrays);
    return o;
  }
  return x;
}
