/* lab/core/host.js: owns the model. Loads and caches the weights, picks the engine (WebGPU, else plain JS),
   and answers requests. The same code runs inside a worker (lab/core/worker.js) or, when a browser only offers
   WebGPU on the page itself, on the main thread. Requests: {op, args}; see Host.handle. */

import { BPE } from './bpe.js';
import { CFG, GPT2, loadWeights, logSoftmax, topk } from './gpt2.js';
import { GPUEngine, gpuAvailable } from './gpu.js';
import { RECIPES } from './recipes.js';

const MODEL = new URL('../model/', import.meta.url);
const DATA = new URL('../data/', import.meta.url);
const CACHE = 'tara-lab-model';
const CHECK_IDS = [50256, 464, 3139, 286, 4881, 318];      // <|endoftext|>The capital of France is

const hasCaches = () => typeof caches !== 'undefined';

/* A WebGPU emulated on the CPU (SwiftShader and friends) runs no faster than the plain engine. */
function isSoftware(adapter) {
  const i = adapter.info || {};
  if (i.isFallbackAdapter || adapter.isFallbackAdapter) return true;
  return /swiftshader|llvmpipe|software|microsoft basic render/i.test([i.vendor, i.architecture, i.device, i.description].join(' '));
}

async function sha256hex(buf) {
  if (!globalThis.crypto || !crypto.subtle) return null;
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class Host {
  constructor(emit) {
    this.emit = emit;                 // emit({type:'status', ...}) to whoever owns the host
    this.state = { state: 'idle' };
    this.queue = Promise.resolve();   // engine work runs one request at a time
  }

  status(s) {
    this.state = { ...this.state, ...s };
    this.emit({ type: 'status', ...this.state });
  }

  /* ------------------------------------------------------------ loading */

  async manifest() {
    if (this.man) return this.man;
    const url = new URL('manifest.json', MODEL).href;
    let res = null;
    try { res = await fetch(url, { cache: 'no-cache' }); } catch (e) { /* offline */ }
    if ((!res || !res.ok) && hasCaches()) res = await (await caches.open(CACHE)).match(url);
    if (!res || !res.ok) throw new Error('Could not load the model manifest (offline and not downloaded yet?)');
    const man = await res.clone().json();
    if (hasCaches()) (await caches.open(CACHE)).put(url, res);
    this.man = man;
    return man;
  }

  /* How much of the model is already on this device. */
  async probe() {
    const man = await this.manifest();
    const total = man.files.reduce((a, f) => a + f.bytes, 0);
    let have = 0;
    if (hasCaches()) {
      const c = await caches.open(CACHE);
      for (const f of man.files) if (await c.match(new URL(f.name, MODEL).href)) have += f.bytes;
    }
    let gpuInHere = false, softGpu = false;
    try { const a = await gpuAvailable(); softGpu = !!a && isSoftware(a); gpuInHere = !!a && !softGpu; } catch (e) { /* none */ }
    return { total, have, cached: have === total, gpuInHere, softGpu, persistent: hasCaches() };
  }

  async fetchFile(f, onBytes) {
    const url = new URL(f.name, MODEL).href;
    const cache = hasCaches() ? await caches.open(CACHE) : null;
    if (cache) {
      const hit = await cache.match(url);
      if (hit) { const b = await hit.arrayBuffer(); onBytes(b.byteLength); return b; }
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${f.name} (${res.status})`);
    let buf;
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      const out = new Uint8Array(f.bytes);
      let off = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (off + value.length > out.length) throw new Error(`${f.name} is larger than the manifest says`);
        out.set(value, off); off += value.length; onBytes(value.length);
      }
      if (off !== f.bytes) throw new Error(`${f.name} arrived incomplete (${off} of ${f.bytes} bytes)`);
      buf = out.buffer;
    } else { buf = await res.arrayBuffer(); onBytes(buf.byteLength); }
    const h = await sha256hex(buf);
    if (h && f.sha256 && h !== f.sha256) throw new Error(`${f.name} failed its checksum; try again`);
    if (cache) await cache.put(url, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } }));
    return buf;
  }

  async load({ allowDownload = false, engine = 'auto' } = {}) {
    if (this.ready) return this.ready;
    const man = await this.manifest();
    const p = await this.probe();
    if (!p.cached && !allowDownload) {
      this.status({ state: 'needs-download', total: p.total, have: p.have, persistent: p.persistent });
      return { needsDownload: true, ...p };
    }
    this.ready = (async () => {
      const total = man.files.reduce((a, f) => a + f.bytes, 0);
      let loaded = 0, last = 0;
      this.status({ state: p.cached ? 'loading' : 'downloading', loaded: 0, total });
      const bufs = [];
      for (const f of man.files) {
        bufs.push(await this.fetchFile(f, (n) => {
          loaded += n;
          const now = Date.now();
          if (now - last > 120) { last = now; this.status({ loaded }); }
        }));
      }
      this.status({ state: 'building', loaded: total });
      const W = loadWeights(man, bufs);
      this.cpu = new GPT2(W);
      this.tok = new BPE(await (await this.fetchJSON(new URL('bpe.json', MODEL))));
      try {
        const stats = await this.fetchJSON(new URL('stats.json', DATA));
        if (stats && stats.resid_norm) {
          this.stats = stats;
          stats.resid_norm.resid_post.p50.forEach((v, l) => { this.cpu.residNorm[l] = v; });
        }
      } catch (e) { /* precompute not shipped yet: the engine keeps its default unit */ }
      this.gpu = null;
      let gpuNote = '';
      if (engine !== 'cpu') {
        try {
          const adapter = await gpuAvailable();
          if (adapter && isSoftware(adapter) && engine !== 'webgpu') {
            gpuNote = 'This browser only offers a software WebGPU, which is no faster than the plain engine.';
          } else if (adapter) {
            this.status({ state: 'gpu' });
            const g = await GPUEngine.create(adapter, W, this.cpu);
            const ok = await this.gpuCheck(g);
            if (ok === true) this.gpu = g;
            else gpuNote = ok;
          } else gpuNote = 'This browser does not offer WebGPU here.';
        } catch (e) { gpuNote = 'WebGPU failed to start: ' + (e && e.message); }
      }
      this.E = this.gpu || this.cpu;
      this.cleanCache(man).catch(() => {});
      const info = {
        state: 'ready', engine: this.gpu ? 'webgpu' : 'cpu', gpuInfo: this.gpu ? this.gpu.info : '', gpuNote,
        residNorm: Array.from(this.cpu.residNorm), statsLoaded: !!this.stats, total, loaded: total,
      };
      this.status(info);
      return info;
    })();
    try { return await this.ready; } catch (e) { this.ready = null; this.status({ state: 'error', error: String(e && e.message || e) }); throw e; }
  }

  async fetchJSON(url) {
    const res = await fetch(url.href || url);
    if (!res.ok) throw new Error('fetch ' + url + ' ' + res.status);
    return res.json();
  }

  /* The GPU must agree with the plain engine before anything is trusted to it. */
  async gpuCheck(g) {
    try {
      const a = this.cpu.forward({ ids: CHECK_IDS });
      const b = await g.forward({ ids: CHECK_IDS });
      let worst = 0;
      for (const i of topk(a.logits, 20)) worst = Math.max(worst, Math.abs(a.logits[i] - b.logits[i]));
      if (!(worst < 0.05)) return `WebGPU gave different numbers (off by ${worst.toFixed(3)}), so the lab uses the plain engine.`;
      return true;
    } catch (e) { return 'WebGPU check failed: ' + (e && e.message); }
  }

  async cleanCache(man) {
    if (!hasCaches()) return;
    const c = await caches.open(CACHE);
    const keep = new Set(man.files.map((f) => new URL(f.name, MODEL).href).concat([new URL('manifest.json', MODEL).href]));
    for (const req of await c.keys()) if (!keep.has(req.url)) await c.delete(req);
  }

  async forget() {
    if (hasCaches()) await caches.delete(CACHE);
    return { forgotten: true };
  }

  /* ------------------------------------------------------------ requests */

  /* Engine calls are serialised: the GPU engine reuses buffers between passes. */
  exclusive(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  env(ctx) {
    const host = this;
    return {
      cpu: this.cpu, gpu: this.gpu, E: this.E, tok: this.tok, cfg: CFG, stats: this.stats, ctx,
      forward: (opts) => this.E.forward(opts),
      async unembedRows(X, N) { return host.unembedRows(X, N); },
    };
  }

  /* logits for N rows of 768 that have already been through ln_f (or any 768-d vectors) */
  async unembedRows(X, N) {
    const w = this.cpu.W.wte;
    if (this.gpu) {
      const nr = w.nr, nk = w.nk, D = CFG.D;
      const xr = new Float32Array(N * nr), xk = new Float32Array(N * nk);
      for (let n = 0; n < N; n++) {
        for (let i = 0; i < nr; i++) xr[n * nr + i] = X[n * D + w.restIdx[i]];
        for (let k = 0; k < nk; k++) xk[n * nk + k] = X[n * D + w.keepIdx[k]];
      }
      return this.gpu.unembedRows(xr, xk, N);
    }
    return this.cpu.unembedMany(X, N, new Float32Array(N * CFG.V));
  }

  async handle(op, args = {}, ctx = {}) {
    if (op === 'probe') return this.probe();
    if (op === 'load') return this.load(args);
    if (op === 'forget') return this.forget();
    if (!this.ready) throw new Error('The model is not loaded yet');
    await this.ready;
    switch (op) {
      case 'tokenize': {
        const ids = (args.bos === false ? [] : [50256]).concat(this.tok.encode(args.text || ''));
        return { ids, pieces: this.tok.pieces(ids) };
      }
      case 'decode': return { text: this.tok.decode(args.ids) };
      case 'pieces': return { pieces: this.tok.pieces(args.ids) };
      case 'vocab': return { vocab: args.ids.map((i) => this.tok.piece(i)) };
      case 'find': return { ids: this.findTokens(args.query, args.k || 20) };
      case 'forward': return this.exclusive(() => this.E.forward(args));
      case 'generate': return this.exclusive(() => this.generate(args, ctx));
      case 'recipe': {
        const fn = RECIPES[args.name];
        if (!fn) throw new Error('Unknown recipe ' + args.name);
        return this.exclusive(() => fn(this.env(ctx), args.args || {}));
      }
      default: throw new Error('Unknown request ' + op);
    }
  }

  findTokens(q, k) {
    const out = [];
    const v = this.tok.vocab;
    const qq = String(q || '');
    if (!qq) return out;
    const exact = [], starts = [], has = [];
    for (let i = 0; i < CFG.V; i++) {
      const s = this.tok.piece(i);
      if (s === qq || s === ' ' + qq) exact.push(i);
      else if (s.trim().toLowerCase() === qq.trim().toLowerCase()) starts.push(i);
      else if (has.length < k && s.toLowerCase().includes(qq.toLowerCase())) has.push(i);
    }
    return exact.concat(starts, has).slice(0, k);
  }

  /* Rows that share a prompt and differ by their interventions, decoded together, streamed token by token. */
  async generate(args, ctx) {
    const { prompt, R = 1, maxNew = 40, temperature = 0, topK = 0, topP = 1, iv = [], seed = 1 } = args;
    const E = this.E, V = CFG.V;
    const Tmax = Math.min(CFG.ctx, prompt.length + maxNew);
    const kv = E.newCache(R, Tmax);
    let rng = seed >>> 0 || 1;
    const rand = () => { rng = (rng * 1664525 + 1013904223) >>> 0; return rng / 4294967296; };
    const out = Array.from({ length: R }, () => []);
    const lps = Array.from({ length: R }, () => []);
    try {
      let res = await E.forward({ ids: Array.from({ length: R }, () => prompt), cache: kv, iv, logits: 'last' });
      const steps = Math.min(maxNew, Tmax - prompt.length);
      for (let s = 0; s < steps; s++) {
        await new Promise((r) => setTimeout(r, 0));     // let a cancel message in
        if (ctx.cancelled && ctx.cancelled()) break;
        const next = [];
        for (let r = 0; r < R; r++) {
          const lg = res.logits.subarray(r * V, (r + 1) * V);
          const t = sample(lg, temperature, topK, topP, rand);
          const lp = logSoftmax(lg);
          next.push(t); out[r].push(t); lps[r].push(lp[t]);
        }
        if (ctx.progress) ctx.progress({ step: s, tokens: next, pieces: next.map((t) => this.tok.piece(t)), logprobs: lps.map((a) => a[a.length - 1]) });
        if (s === steps - 1) break;
        res = await E.forward({ ids: next.map((t) => [t]), cache: kv, iv, logits: 'last' });
      }
    } finally { if (E.freeCache) E.freeCache(kv); }
    return { tokens: out, logprobs: lps, texts: out.map((ids) => this.tok.decode(ids)) };
  }
}

/* temperature 0 = greedy; topK 0 = off; topP 1 = off */
export function sample(lg, temperature, topK, topP, rand) {
  if (!temperature) { let b = 0; for (let i = 1; i < lg.length; i++) if (lg[i] > lg[b]) b = i; return b; }
  const K = topK || 200;
  const idx = topk(lg, K);
  let mx = -Infinity; for (const i of idx) mx = Math.max(mx, lg[i]);
  let p = idx.map((i) => Math.exp((lg[i] - mx) / temperature));
  let sum = p.reduce((a, b) => a + b, 0);
  p = p.map((x) => x / sum);
  if (topP < 1) {
    let c = 0, cut = p.length;
    for (let j = 0; j < p.length; j++) { c += p[j]; if (c >= topP) { cut = j + 1; break; } }
    p = p.slice(0, cut); sum = p.reduce((a, b) => a + b, 0); p = p.map((x) => x / sum);
  }
  let u = rand();
  for (let j = 0; j < p.length; j++) { u -= p[j]; if (u <= 0) return idx[j]; }
  return idx[p.length - 1];
}
