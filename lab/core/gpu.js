/* lab/core/gpu.js: the same GPT-2 forward pass as gpt2.js, on WebGPU.
   Same inputs, same outputs, same hook names and interventions (the plain-JS model is the
   reference it is tested against). Weights stay int8 on the GPU and are unpacked inside the
   matmul kernel, so GPU memory use is the download size (~133 MB). */

import { CFG } from './gpt2.js';
const { L, H, D, dh, M, V, G } = CFG;

const WG = 64;

const MATMUL = /* wgsl */ `
struct Dims { N: u32, K: u32, O: u32, NG: u32, bias: u32, accum: u32, p0: u32, p1: u32 }
@group(0) @binding(0) var<storage, read> X: array<f32>;
@group(0) @binding(1) var<storage, read> Q: array<u32>;
@group(0) @binding(2) var<storage, read> S: array<f32>;
@group(0) @binding(3) var<storage, read> B: array<f32>;
@group(0) @binding(4) var<storage, read_write> Y: array<f32>;
@group(0) @binding(5) var<uniform> dims: Dims;
const TR: u32 = 8u;
var<workgroup> xs: array<f32, 512>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let o = wg.x * 64u + lid.x;
  let n0 = wg.y * TR;
  var acc = array<f32, 8>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  let kw = dims.K / 4u;
  for (var g = 0u; g < dims.NG; g++) {
    for (var r = 0u; r < TR; r++) {
      let n = n0 + r;
      var v = 0.0;
      if (n < dims.N) { v = X[n * dims.K + g * 64u + lid.x]; }
      xs[r * 64u + lid.x] = v;
    }
    workgroupBarrier();
    if (o < dims.O) {
      var part = array<f32, 8>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
      let qb = o * kw + g * 16u;
      for (var w = 0u; w < 16u; w++) {
        let pk = bitcast<i32>(Q[qb + w]);
        let q0 = f32((pk << 24u) >> 24u);
        let q1 = f32((pk << 16u) >> 24u);
        let q2 = f32((pk << 8u) >> 24u);
        let q3 = f32(pk >> 24u);
        let k = w * 4u;
        for (var r = 0u; r < TR; r++) {
          let xb = r * 64u + k;
          part[r] += xs[xb] * q0 + xs[xb + 1u] * q1 + xs[xb + 2u] * q2 + xs[xb + 3u] * q3;
        }
      }
      let sc = S[o * dims.NG + g];
      for (var r = 0u; r < TR; r++) { acc[r] += part[r] * sc; }
    }
    workgroupBarrier();
  }
  if (o < dims.O) {
    var b = 0.0;
    if (dims.bias == 1u) { b = B[o]; }
    for (var r = 0u; r < TR; r++) {
      let n = n0 + r;
      if (n < dims.N) {
        let i = n * dims.O + o;
        if (dims.accum == 1u) { Y[i] = Y[i] + acc[r] + b; } else { Y[i] = acc[r] + b; }
      }
    }
  }
}`;

/* logits: rest columns are int8 in groups of 64 (K = 704), kept columns fp32 (64) */
const UNEMBED = /* wgsl */ `
struct Dims { N: u32, NR: u32, NK: u32, NG: u32, split: u32, V: u32, p0: u32, p1: u32 }
@group(0) @binding(0) var<storage, read> XR: array<f32>;
@group(0) @binding(1) var<storage, read> Q0: array<u32>;
@group(0) @binding(2) var<storage, read> Q1: array<u32>;
@group(0) @binding(3) var<storage, read> S: array<f32>;
@group(0) @binding(4) var<storage, read> KEEP: array<f32>;
@group(0) @binding(5) var<storage, read_write> Y: array<f32>;
@group(0) @binding(6) var<uniform> dims: Dims;
@group(0) @binding(7) var<storage, read> XK: array<f32>;
const TR: u32 = 8u;
var<workgroup> xs: array<f32, 512>;
var<workgroup> ks: array<f32, 512>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let v = wg.x * 64u + lid.x;
  let n0 = wg.y * TR;
  var acc = array<f32, 8>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  let kw = dims.NR / 4u;
  var row = v;
  var hi = false;
  if (v >= dims.split) { row = v - dims.split; hi = true; }
  for (var r = 0u; r < TR; r++) {
    let n = n0 + r;
    var kv = 0.0;
    if (n < dims.N) { kv = XK[n * dims.NK + lid.x]; }
    ks[r * 64u + lid.x] = kv;
  }
  for (var g = 0u; g < dims.NG; g++) {
    for (var r = 0u; r < TR; r++) {
      let n = n0 + r;
      var xv = 0.0;
      if (n < dims.N) { xv = XR[n * dims.NR + g * 64u + lid.x]; }
      xs[r * 64u + lid.x] = xv;
    }
    workgroupBarrier();
    if (v < dims.V) {
      var part = array<f32, 8>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
      let qb = row * kw + g * 16u;
      for (var w = 0u; w < 16u; w++) {
        var u: u32;
        if (hi) { u = Q1[qb + w]; } else { u = Q0[qb + w]; }
        let pk = bitcast<i32>(u);
        let q0 = f32((pk << 24u) >> 24u);
        let q1 = f32((pk << 16u) >> 24u);
        let q2 = f32((pk << 8u) >> 24u);
        let q3 = f32(pk >> 24u);
        let k = w * 4u;
        for (var r = 0u; r < TR; r++) {
          let xb = r * 64u + k;
          part[r] += xs[xb] * q0 + xs[xb + 1u] * q1 + xs[xb + 2u] * q2 + xs[xb + 3u] * q3;
        }
      }
      let sc = S[v * dims.NG + g];
      for (var r = 0u; r < TR; r++) { acc[r] += part[r] * sc; }
    }
    workgroupBarrier();
  }
  if (v < dims.V) {
    for (var r = 0u; r < TR; r++) {
      let n = n0 + r;
      if (n < dims.N) {
        var a = acc[r];
        for (var k = 0u; k < dims.NK; k++) { a += ks[r * 64u + k] * KEEP[v * dims.NK + k]; }
        Y[n * dims.V + v] = a;
      }
    }
  }
}`;

const LAYERNORM = /* wgsl */ `
struct Dims { N: u32, Dm: u32, p0: u32, p1: u32 }
@group(0) @binding(0) var<storage, read> X: array<f32>;
@group(0) @binding(1) var<storage, read> Gm: array<f32>;
@group(0) @binding(2) var<storage, read> Bt: array<f32>;
@group(0) @binding(3) var<storage, read_write> Y: array<f32>;
@group(0) @binding(4) var<storage, read_write> SC: array<f32>;
@group(0) @binding(5) var<uniform> dims: Dims;
var<workgroup> red: array<f32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let n = wg.x;
  let base = n * dims.Dm;
  var s = 0.0;
  for (var i = lid.x; i < dims.Dm; i += 256u) { s += X[base + i]; }
  red[lid.x] = s;
  workgroupBarrier();
  for (var st = 128u; st > 0u; st = st / 2u) {
    if (lid.x < st) { red[lid.x] += red[lid.x + st]; }
    workgroupBarrier();
  }
  let mu = red[0] / f32(dims.Dm);
  workgroupBarrier();
  var q = 0.0;
  for (var i = lid.x; i < dims.Dm; i += 256u) { let d = X[base + i] - mu; q += d * d; }
  red[lid.x] = q;
  workgroupBarrier();
  for (var st = 128u; st > 0u; st = st / 2u) {
    if (lid.x < st) { red[lid.x] += red[lid.x + st]; }
    workgroupBarrier();
  }
  let inv = 1.0 / sqrt(red[0] / f32(dims.Dm) + 1e-5);
  for (var i = lid.x; i < dims.Dm; i += 256u) { Y[base + i] = (X[base + i] - mu) * inv * Gm[i] + Bt[i]; }
  if (lid.x == 0u) { SC[n] = inv; }
}`;

/* q from qkv rows; K, V caches [R, H, Tm, 64]; one workgroup per (row r, head h, new position t) */
const ATTN = /* wgsl */ `
struct Dims { R: u32, Tn: u32, T0: u32, Tm: u32, wantPat: u32, Tt: u32, p0: u32, p1: u32 }
@group(0) @binding(0) var<storage, read> QKV: array<f32>;
@group(0) @binding(1) var<storage, read> Kc: array<f32>;
@group(0) @binding(2) var<storage, read> Vc: array<f32>;
@group(0) @binding(3) var<storage, read_write> Z: array<f32>;
@group(0) @binding(4) var<storage, read_write> PAT: array<f32>;
@group(0) @binding(5) var<uniform> dims: Dims;
var<workgroup> sc: array<f32, 1024>;
var<workgroup> red: array<f32, 64>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let t = wg.x; let h = wg.y; let r = wg.z;
  let n = r * dims.Tn + t;
  let p = dims.T0 + t;
  let qo = n * 2304u + h * 64u;
  let kvb = (r * 12u + h) * dims.Tm * 64u;
  var mx = -3.0e38;
  for (var s = lid.x; s <= p; s += 64u) {
    var a = 0.0;
    let ko = kvb + s * 64u;
    for (var d = 0u; d < 64u; d++) { a += QKV[qo + d] * Kc[ko + d]; }
    a = a * 0.125;
    sc[s] = a;
    mx = max(mx, a);
  }
  red[lid.x] = mx;
  workgroupBarrier();
  for (var st = 32u; st > 0u; st = st / 2u) {
    if (lid.x < st) { red[lid.x] = max(red[lid.x], red[lid.x + st]); }
    workgroupBarrier();
  }
  let m = red[0];
  workgroupBarrier();
  var sum = 0.0;
  for (var s = lid.x; s <= p; s += 64u) { let e = exp(sc[s] - m); sc[s] = e; sum += e; }
  red[lid.x] = sum;
  workgroupBarrier();
  for (var st = 32u; st > 0u; st = st / 2u) {
    if (lid.x < st) { red[lid.x] += red[lid.x + st]; }
    workgroupBarrier();
  }
  let tot = red[0];
  workgroupBarrier();
  for (var s = lid.x; s <= p; s += 64u) {
    sc[s] = sc[s] / tot;
    if (dims.wantPat == 1u) { PAT[((r * 12u + h) * dims.Tn + t) * dims.Tt + s] = sc[s]; }
  }
  workgroupBarrier();
  var z = 0.0;
  for (var s = 0u; s <= p; s++) { z += sc[s] * Vc[kvb + s * 64u + lid.x]; }
  Z[n * 768u + h * 64u + lid.x] = z;
}`;

/* writes the new K and V rows of qkv into the caches */
const KVWRITE = /* wgsl */ `
struct Dims { R: u32, Tn: u32, T0: u32, Tm: u32 }
@group(0) @binding(0) var<storage, read> QKV: array<f32>;
@group(0) @binding(1) var<storage, read_write> Kc: array<f32>;
@group(0) @binding(2) var<storage, read_write> Vc: array<f32>;
@group(0) @binding(3) var<uniform> dims: Dims;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let t = wg.x; let h = wg.y; let r = wg.z;
  let n = r * dims.Tn + t;
  let dst = ((r * 12u + h) * dims.Tm + dims.T0 + t) * 64u + lid.x;
  let src = n * 2304u + h * 64u + lid.x;
  Kc[dst] = QKV[src + 768u];
  Vc[dst] = QKV[src + 1536u];
}`;

const ELEMWISE = /* wgsl */ `
struct Dims { count: u32, op: u32, p0: u32, p1: u32 }
@group(0) @binding(0) var<storage, read_write> A: array<f32>;
@group(0) @binding(1) var<storage, read> Bv: array<f32>;
@group(0) @binding(2) var<uniform> dims: Dims;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let i = gid.x + gid.y * nw.x * 256u;
  if (i >= dims.count) { return; }
  if (dims.op == 0u) { A[i] = A[i] + Bv[i]; }
  else {
    let x = A[i];
    let u = clamp(0.7978845608028654 * (x + 0.044715 * x * x * x), -15.0, 15.0);   // tanh of a huge argument is NaN on some GPUs
    A[i] = 0.5 * x * (1.0 + tanh(u));
  }
}`;

/* interventions: one thread per (edit, channel) */
const EDIT = /* wgsl */ `
struct Edit { n: u32, c0: u32, len: u32, op: u32, val: f32, vec: u32, width: u32, p0: u32 }
struct Dims { count: u32, p0: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var<storage, read_write> A: array<f32>;
@group(0) @binding(1) var<storage, read> E: array<Edit>;
@group(0) @binding(2) var<storage, read> VEC: array<f32>;
@group(0) @binding(3) var<uniform> dims: Dims;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  if (wg.x >= dims.count) { return; }
  let e = E[wg.x];
  let i = wg.y * 64u + lid.x;
  if (i >= e.len) { return; }
  let j = e.n * e.width + e.c0 + i;
  if (e.op == 0u) { A[j] = A[j] + e.val * VEC[e.vec + i]; }
  else if (e.op == 1u) { A[j] = A[j] * e.val; }
  else if (e.op == 2u) { A[j] = VEC[e.vec + i]; }
  else if (e.op == 3u) { A[j] = e.val; }
  else if (e.op == 4u) { A[j] = A[j] + e.val; }
}`;

/* edits run in submission order inside one dispatch only when they touch different elements;
   the engine groups edits so that no two edits in one dispatch overlap */

export async function gpuAvailable() {
  try {
    if (typeof navigator === 'undefined' || !navigator.gpu) return null;
    const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!a) return null;
    return a;
  } catch (e) { return null; }
}

export class GPUEngine {
  static async create(adapter, W, cpu) {
    const lim = adapter.limits;
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: Math.min(lim.maxStorageBufferBindingSize, 1 << 30),
        maxBufferSize: Math.min(lim.maxBufferSize, 1 << 30),
        maxStorageBuffersPerShaderStage: Math.min(lim.maxStorageBuffersPerShaderStage, 10),
      },
    });
    const g = new GPUEngine(device, W, cpu, adapter);
    await g.init();
    return g;
  }
  constructor(device, W, cpu, adapter) {
    this.dev = device; this.W = W; this.cpu = cpu; this.cfg = CFG;
    this.woutNorm = cpu.woutNorm; this.residNorm = cpu.residNorm;
    this.info = (adapter && adapter.info) ? [adapter.info.vendor, adapter.info.architecture, adapter.info.description].filter(Boolean).join(' ') : 'GPU';
    this.lost = false;
    device.lost.then(() => { this.lost = true; });
    device.addEventListener('uncapturederror', (ev) => { this.lastError = ev.error && ev.error.message; console.error('[lab gpu]', this.lastError); });
  }
  buf(data, usage = GPUBufferUsage.STORAGE) {
    const size = Math.max(16, (data.byteLength + 3) & ~3);
    const b = this.dev.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST, mappedAtCreation: true });
    const dst = new Uint8Array(b.getMappedRange());
    dst.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    b.unmap();
    return b;
  }
  empty(bytes, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST) {
    return this.dev.createBuffer({ size: Math.max(16, (bytes + 3) & ~3), usage });
  }
  pipe(code) {
    const m = this.dev.createShaderModule({ code });
    return this.dev.createComputePipeline({ layout: 'auto', compute: { module: m, entryPoint: 'main' } });
  }
  async init() {
    const W = this.W;
    this.P = { mm: this.pipe(MATMUL), un: this.pipe(UNEMBED), ln: this.pipe(LAYERNORM), at: this.pipe(ATTN), kv: this.pipe(KVWRITE), el: this.pipe(ELEMWISE), ed: this.pipe(EDIT) };
    const mat = (m) => ({ q: this.buf(new Uint32Array(m.q.buffer, m.q.byteOffset, m.q.length / 4)), s: this.buf(m.s), b: this.buf(m.b), O: m.O, K: m.K, NG: m.NG });
    this.layers = W.layers.map((ly) => ({
      ln1g: this.buf(ly.ln1g), ln1b: this.buf(ly.ln1b), ln2g: this.buf(ly.ln2g), ln2b: this.buf(ly.ln2b),
      qkv: mat(ly.qkv), o: mat(ly.o), fc: mat(ly.fc), proj: mat(ly.proj),
    }));
    const w = W.wte;
    this.wte = {
      q0: this.buf(new Uint32Array(w.q0.buffer, w.q0.byteOffset, w.q0.length / 4)),
      q1: this.buf(new Uint32Array(w.q1.buffer, w.q1.byteOffset, w.q1.length / 4)),
      s: this.buf(w.s), keep: this.buf(w.keep),
    };
    this.lnfg = this.buf(W.lnfg); this.lnfb = this.buf(W.lnfb);
    this.dummy = this.empty(16);
    this.ubufs = [];
    await this.dev.queue.onSubmittedWorkDone();
  }
  uni(arr) {
    const b = this.dev.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.dev.queue.writeBuffer(b, 0, new Uint32Array(arr.concat(Array(8 - arr.length).fill(0))));
    this.ubufs.push(b);
    return b;
  }
  bind(p, bufs) {
    return this.dev.createBindGroup({ layout: p.getBindGroupLayout(0), entries: bufs.map((b, i) => ({ binding: i, resource: { buffer: b } })) });
  }
  run(enc, p, bufs, x, y = 1, z = 1) {
    const pass = enc.beginComputePass();
    pass.setPipeline(p); pass.setBindGroup(0, this.bind(p, bufs)); pass.dispatchWorkgroups(x, y, z); pass.end();
  }
  matmul(enc, X, N, m, Y, opts = {}) {
    const u = this.uni([N, m.K, m.O, m.NG, opts.noBias ? 0 : 1, opts.accum ? 1 : 0]);
    this.run(enc, this.P.mm, [X, m.q, m.s, m.b, Y, u], Math.ceil(m.O / 64), Math.ceil(N / 8));
  }
  elem(enc, A, Bv, count, op) {
    const u = this.uni([count, op]);
    const groups = Math.ceil(count / 256), gx = Math.min(groups, 65535), gy = Math.ceil(groups / 65535);
    this.run(enc, this.P.el, [A, Bv || this.dummy, u], gx, gy);
  }
  /* edits: [{n, c0, len, op, val, vec: Float32Array|null}] on a tensor whose rows are `width` wide */
  edit(enc, A, width, edits) {
    if (!edits.length) return;
    // split into rounds so no two edits in a round touch the same element (they would race)
    const rounds = [];
    for (const e of edits) {
      let placed = false;
      for (const rd of rounds) {
        if (!rd.some((f) => f.n === e.n && f.c0 < e.c0 + e.len && e.c0 < f.c0 + f.len)) { rd.push(e); placed = true; break; }
      }
      if (!placed) rounds.push([e]);
    }
    for (const rd of rounds) {
      let vlen = 0;
      for (const e of rd) if (e.vec) vlen += e.len;
      const vec = new Float32Array(Math.max(4, vlen));
      const E = new ArrayBuffer(rd.length * 32), u32 = new Uint32Array(E), f32 = new Float32Array(E);
      let vo = 0, maxLen = 0;
      rd.forEach((e, i) => {
        const opc = { add: 0, mul: 1, set: 2, setc: 3, addc: 4 }[e.op];
        u32[i * 8] = e.n; u32[i * 8 + 1] = e.c0; u32[i * 8 + 2] = e.len; u32[i * 8 + 3] = opc;
        f32[i * 8 + 4] = e.val === undefined ? 1 : e.val; u32[i * 8 + 5] = vo; u32[i * 8 + 6] = width;
        if (e.vec) { vec.set(e.vec.subarray ? e.vec.subarray(0, e.len) : e.vec, vo); vo += e.len; }
        maxLen = Math.max(maxLen, e.len);
      });
      const eb = this.buf(new Uint8Array(E)), vb = this.buf(vec);
      this.tmp.push(eb, vb);
      this.run(enc, this.P.ed, [A, eb, vb, this.uni([rd.length])], rd.length, Math.ceil(maxLen / 64));
    }
  }
  newCache(R, Tmax) {
    const kv = { R, Tmax, T: 0, K: [], Vv: [], gpu: true };
    for (let l = 0; l < L; l++) { kv.K.push(this.empty(R * H * Tmax * dh * 4)); kv.Vv.push(this.empty(R * H * Tmax * dh * 4)); }
    return kv;
  }
  freeCache(kv) { if (kv && kv.gpu) { kv.K.forEach((b) => b.destroy()); kv.Vv.forEach((b) => b.destroy()); } }

  /* translate the shared intervention format into GPU edits for one hook */
  edits(list, hook, l, R, Tn, T0, width) {
    const out = [], cpu = this.cpu;
    for (const x of list) {
      if (x.hook !== hook) continue;
      if (!(x.layer === l || x.layer === undefined || x.layer === 'all')) continue;
      for (const r of cpu.rowsOf(x, R)) {
        const v = cpu.val(x, r);
        for (const p of cpu.posOf(x, Tn, T0)) {
          const n = r * Tn + p - T0;
          if (hook === 'mlp_post') {
            const ns = x.neuron === undefined || x.neuron === 'all' ? null : Array.isArray(x.neuron) ? x.neuron : [x.neuron];
            if (!ns) {
              if (x.op === 'mul') out.push({ n, c0: 0, len: M, op: 'mul', val: v });
              else if (x.op === 'set') out.push({ n, c0: 0, len: M, op: 'setc', val: v });
              else if (x.op === 'setsrc') out.push({ n, c0: 0, len: M, op: 'set', vec: x.src.subarray(p * M, (p + 1) * M) });
              else throw new Error('unsupported all-neuron op ' + x.op);
              continue;
            }
            for (const nn of ns) {
              if (x.op === 'add') out.push({ n, c0: nn, len: 1, op: 'addc', val: v });
              else if (x.op === 'addr') out.push({ n, c0: nn, len: 1, op: 'addc', val: v * this.residNorm[l] / (this.woutNorm[l][nn] || 1) });
              else if (x.op === 'mul') out.push({ n, c0: nn, len: 1, op: 'mul', val: v });
              else if (x.op === 'set') out.push({ n, c0: nn, len: 1, op: 'setc', val: v });
              else if (x.op === 'setsrc') out.push({ n, c0: nn, len: 1, op: 'setc', val: x.src[p * M + nn] });
            }
          } else if (hook === 'head') {
            const hs = x.head === undefined || x.head === 'all' ? [...Array(H).keys()] : Array.isArray(x.head) ? x.head : [x.head];
            for (const hh of hs) {
              if (x.op === 'mul') out.push({ n, c0: hh * dh, len: dh, op: 'mul', val: v });
              else if (x.op === 'set') out.push({ n, c0: hh * dh, len: dh, op: 'set', vec: x.src.subarray(p * D + hh * dh, p * D + hh * dh + dh) });
              else if (x.op === 'mean') out.push({ n, c0: hh * dh, len: dh, op: 'set', vec: x.mean.subarray(hh * dh, hh * dh + dh) });
            }
          } else {
            if (x.op === 'add') out.push({ n, c0: 0, len: width, op: 'add', val: v, vec: x.vec });
            else if (x.op === 'mul') out.push({ n, c0: 0, len: width, op: 'mul', val: v });
            else if (x.op === 'set') out.push({ n, c0: 0, len: width, op: 'set', vec: x.src.subarray(p * width, (p + 1) * width) });
            else throw new Error('op ' + x.op + ' needs the CPU engine');
          }
        }
      }
    }
    return out;
  }
  needsCPU(iv) {
    return (iv || []).some((x) => x.op === 'project_out' || x.hook === 'attn_pattern');
  }

  async forward(opts) {
    if (this.needsCPU(opts.iv)) return this.cpu.forward(opts);
    let ids = opts.ids;
    if (!Array.isArray(ids[0]) && !(ids[0] instanceof Int32Array)) ids = [ids];
    const R = ids.length, Tn = ids[0].length, kv = opts.cache || null, T0 = kv ? kv.T : 0, Tt = T0 + Tn, N = R * Tn;
    const want = opts.capture || {}, iv = opts.iv || [];
    const wantL = (name, l) => want[name] === true || (Array.isArray(want[name]) && want[name].includes(l));
    if (Tt > 1024) throw new Error('context longer than 1024 tokens');
    const dev = this.dev, cpu = this.cpu;
    this.tmp = []; this.ubufs = [];
    // embeddings on the CPU (cheap), uploaded once
    const x0 = new Float32Array(N * D);
    for (let r = 0; r < R; r++) for (let t = 0; t < Tn; t++) {
      const n = r * Tn + t, p = T0 + t;
      cpu.embedRow(ids[r][t], x0, n * D);
      for (let i = 0; i < D; i++) x0[n * D + i] += this.W.wpe[p * D + i];
    }
    const x = this.buf(x0, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const h = this.empty(N * D * 4), qkv = this.empty(N * 3 * D * 4), z = this.empty(N * D * 4), ao = this.empty(N * D * 4);
    const pre = this.empty(N * M * 4), mo = this.empty(N * D * 4), sc = this.empty(N * 4);
    const Tm = kv ? kv.Tmax : Tt;
    const Ks = kv ? null : this.empty(R * H * Tt * dh * 4), Vs = kv ? null : this.empty(R * H * Tt * dh * 4);
    this.tmp.push(x, h, qkv, z, ao, pre, mo, sc);
    if (Ks) this.tmp.push(Ks, Vs);
    // capture plan
    const caps = [];   // {name, l, src, bytes, off}
    let capBytes = 0;
    const plan = (name, l, src, bytes) => { caps.push({ name, l, src, bytes, off: capBytes }); capBytes += bytes; };
    const enc = dev.createCommandEncoder();
    const capBuf = { list: caps };
    const pending = [];   // copies into the capture buffer, recorded after it is created
    const snap = (name, l, src, bytes) => {
      // copy now into a fresh buffer (the source is reused later in the pass)
      const b = this.empty(bytes); this.tmp.push(b);
      enc.copyBufferToBuffer(src, 0, b, 0, bytes);
      plan(name, l, b, bytes);
    };
    for (let l = 0; l < L; l++) {
      const Ly = this.layers[l];
      this.edit(enc, x, D, this.edits(iv, 'resid_pre', l, R, Tn, T0, D));
      if (wantL('resid_pre', l)) snap('resid_pre', l, x, N * D * 4);
      this.run(enc, this.P.ln, [x, Ly.ln1g, Ly.ln1b, h, sc, this.uni([N, D])], N);
      this.matmul(enc, h, N, Ly.qkv, qkv);
      const K = kv ? kv.K[l] : Ks, Vv = kv ? kv.Vv[l] : Vs;
      this.run(enc, this.P.kv, [qkv, K, Vv, this.uni([R, Tn, T0, Tm])], Tn, H, R);
      const wp = wantL('attn_pattern', l);
      const pat = wp ? this.empty(R * H * Tn * Tt * 4) : this.dummy;
      if (wp) this.tmp.push(pat);
      this.run(enc, this.P.at, [qkv, K, Vv, z, pat, this.uni([R, Tn, T0, Tm, wp ? 1 : 0, Tt])], Tn, H, R);
      if (wp) plan('attn_pattern', l, pat, R * H * Tn * Tt * 4);
      this.edit(enc, z, D, this.edits(iv, 'head', l, R, Tn, T0, D));
      if (wantL('attn_z', l) || wantL('head_out', l)) snap('attn_z', l, z, N * D * 4);
      this.matmul(enc, z, N, Ly.o, ao);
      this.edit(enc, ao, D, this.edits(iv, 'attn_out', l, R, Tn, T0, D));
      if (wantL('attn_out', l)) snap('attn_out', l, ao, N * D * 4);
      this.elem(enc, x, ao, N * D, 0);
      this.edit(enc, x, D, this.edits(iv, 'resid_mid', l, R, Tn, T0, D));
      if (wantL('resid_mid', l)) snap('resid_mid', l, x, N * D * 4);
      this.run(enc, this.P.ln, [x, Ly.ln2g, Ly.ln2b, h, sc, this.uni([N, D])], N);
      this.matmul(enc, h, N, Ly.fc, pre);
      if (wantL('mlp_pre', l)) snap('mlp_pre', l, pre, N * M * 4);
      this.elem(enc, pre, null, N * M, 1);
      this.edit(enc, pre, M, this.edits(iv, 'mlp_post', l, R, Tn, T0, M));
      if (wantL('mlp_post', l)) snap('mlp_post', l, pre, N * M * 4);
      this.matmul(enc, pre, N, Ly.proj, mo);
      this.edit(enc, mo, D, this.edits(iv, 'mlp_out', l, R, Tn, T0, D));
      if (wantL('mlp_out', l)) snap('mlp_out', l, mo, N * D * 4);
      this.elem(enc, x, mo, N * D, 0);
      this.edit(enc, x, D, this.edits(iv, 'resid_post', l, R, Tn, T0, D));
      if (wantL('resid_post', l)) snap('resid_post', l, x, N * D * 4);
    }
    if (want.resid_final) snap('resid_final', -1, x, N * D * 4);
    this.run(enc, this.P.ln, [x, this.lnfg, this.lnfb, h, sc, this.uni([N, D])], N);
    if (want.lnf_scale) snap('lnf_scale', -1, sc, N * 4);
    if (want.lnf_out) snap('lnf_out', -1, h, N * D * 4);
    // logits at the requested positions
    const lpos = opts.logits === 'all' ? [...Array(Tn).keys()] : Array.isArray(opts.logits) ? opts.logits.map((p) => p - T0) : opts.logits === 'none' ? [] : [Tn - 1];
    const P = lpos.length, w = this.W.wte;
    let lg = null;
    if (P) {
      // gather the chosen rows of ln_f(x) into rest and kept column order on the CPU side would need a readback,
      // so do the gather with copies: first collect rows, then permute with a tiny edit-free kernel-less trick:
      // read the rows back is avoided by permuting inside a dedicated pass below.
      const rows = this.empty(R * P * D * 4); this.tmp.push(rows);
      for (let r = 0; r < R; r++) lpos.forEach((t, j) => enc.copyBufferToBuffer(h, (r * Tn + t) * D * 4, rows, (r * P + j) * D * 4, D * 4));
      lg = { rows, NR: R * P };
    }
    // submit everything recorded so far, then read back rows (small) to permute on the CPU, then unembed on the GPU
    const total = capBytes;
    const readSrc = [];
    if (lg) readSrc.push({ name: '__rows', l: -1, src: lg.rows, bytes: lg.NR * D * 4 });
    for (const c of caps) readSrc.push(c);
    const outs = await this.readMany(enc, readSrc);
    const res = { R, T: Tn, T0, logits: null, lpos: lpos.map((t) => t + T0), cap: {} };
    for (const c of caps) {
      const data = outs.get(c);
      if (c.name === 'lnf_scale' || c.name === 'resid_final' || c.name === 'lnf_out') res.cap[c.name] = data;
      else (res.cap[c.name] || (res.cap[c.name] = []))[c.l] = data;
    }
    if (res.cap.attn_z && wantL) {
      for (let l = 0; l < L; l++) {
        if (wantL('head_out', l) && res.cap.attn_z[l]) (res.cap.head_out || (res.cap.head_out = []))[l] = cpu.headOut(l, res.cap.attn_z[l], N);
        if (!wantL('attn_z', l) && res.cap.attn_z[l]) res.cap.attn_z[l] = undefined;
      }
    }
    if (lg) {
      const rows = outs.get(readSrc[0]);
      const NR = lg.NR, nr = w.nr, nk = w.nk;
      const xr = new Float32Array(NR * nr), xk = new Float32Array(NR * nk);
      for (let n = 0; n < NR; n++) {
        for (let i = 0; i < nr; i++) xr[n * nr + i] = rows[n * D + w.restIdx[i]];
        for (let k = 0; k < nk; k++) xk[n * nk + k] = rows[n * D + w.keepIdx[k]];
      }
      res.logits = await this.unembedRows(xr, xk, NR);
    }
    if (kv) kv.T = Tt;
    for (const b of this.tmp) b.destroy();
    for (const b of this.ubufs) b.destroy();
    this.tmp = []; this.ubufs = [];
    return res;
  }
  async unembedRows(xr, xk, NR) {
    const w = this.W.wte;
    this.tmp = this.tmp || []; this.ubufs = this.ubufs || [];
    const XR = this.buf(xr), XK = this.buf(xk), Y = this.empty(NR * V * 4);
    const enc = this.dev.createCommandEncoder();
    const u = this.uni([NR, w.nr, w.nk, w.ng, w.split, V]);
    this.run(enc, this.P.un, [XR, this.wte.q0, this.wte.q1, this.wte.s, this.wte.keep, Y, u, XK], Math.ceil(V / 64), Math.ceil(NR / 8));
    const item = { src: Y, bytes: NR * V * 4 };
    const outs = await this.readMany(enc, [item]);
    XR.destroy(); XK.destroy(); Y.destroy(); u.destroy();
    return outs.get(item);
  }
  async readMany(enc, items) {
    let total = 0;
    const offs = items.map((it) => { const o = total; total += (it.bytes + 3) & ~3; return o; });
    const out = new Map();
    if (!total) { this.dev.queue.submit([enc.finish()]); return out; }
    const st = this.dev.createBuffer({ size: total, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    items.forEach((it, i) => enc.copyBufferToBuffer(it.src, 0, st, offs[i], it.bytes));
    this.dev.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const all = st.getMappedRange();
    items.forEach((it, i) => out.set(it, new Float32Array(all.slice(offs[i], offs[i] + it.bytes))));
    st.unmap(); st.destroy();
    return out;
  }
}
