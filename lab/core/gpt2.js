/* lab/core/gpt2.js: GPT-2 small in plain JavaScript, with hooks and interventions.
   Written for the TARA mech interp lab. Runs in a worker (and in Node for tests).

   Weights come from lab/model/ (see manifest.json): matrices are int8 in groups of 64 along the
   reduction axis with one fp16 scale per (output, group); the embedding keeps its 64 most
   output-sensitive columns in fp16. Everything is computed in float64 accumulators over
   float32 storage.

   Hook names follow TransformerLens so what you do here maps onto ARENA notebooks:
     resid_pre, attn_pattern, attn_z (hook_z), head_out (per-head write into the residual),
     attn_out, resid_mid, mlp_pre, mlp_post (the neurons), mlp_out, resid_post, lnf_scale. */

export const CFG = { L: 12, H: 12, D: 768, dh: 64, M: 3072, V: 50257, G: 64, ctx: 1024 };
const { L, H, D, dh, M, V, G } = CFG;

export function f16ToF32(u16) {
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) {
    const h = u16[i], s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    out[i] = e === 0 ? s * f * 5.960464477539063e-8 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * Math.pow(2, e - 15);
  }
  return out;
}

/* buffers: array of ArrayBuffers in manifest.files order. */
export function loadWeights(man, buffers) {
  const T = man.tensors;
  const get = (name) => {
    const t = T[name], buf = buffers[t.file], n = t.shape.reduce((a, b) => a * b, 1);
    if (t.dtype === 'i8') return new Int8Array(buf, t.offset, n);
    if (t.dtype === 'f32') return new Float32Array(buf, t.offset, n);
    if (t.dtype === 'u16') return new Uint16Array(buf, t.offset, n);
    if (t.dtype === 'f16') return f16ToF32(new Uint16Array(buf, t.offset, n));
    throw new Error('dtype ' + t.dtype);
  };
  const mat = (l, k, O, K) => ({ q: get(`${l}.${k}.q`), s: get(`${l}.${k}.s`), b: get(`${l}.${k}.b`), O, K, NG: K / G });
  const layers = [];
  for (let l = 0; l < L; l++) {
    layers.push({
      ln1g: get(`${l}.ln_1.g`), ln1b: get(`${l}.ln_1.b`), ln2g: get(`${l}.ln_2.g`), ln2b: get(`${l}.ln_2.b`),
      qkv: mat(l, 'qkv', 3 * D, D), o: mat(l, 'o', D, D), fc: mat(l, 'fc', M, D), proj: mat(l, 'proj', D, M),
    });
  }
  const wte = {
    q0: get('wte.q0'), q1: get('wte.q1'), split: man.wte_split, s: get('wte.s'), keep: get('wte.keep'),
    keepIdx: get('wte.keep_idx'), restIdx: get('wte.rest_idx'),
  };
  wte.nr = wte.restIdx.length; wte.nk = wte.keepIdx.length; wte.ng = wte.nr / G;
  return { layers, wte, wpe: get('wpe'), lnfg: get('ln_f.g'), lnfb: get('ln_f.b') };
}

/* Y[n,o] = b[o] + sum_g s[o,g] * sum_{i in g} X[n,i] q[o,i]   (X: N x K, Y: N x O) */
export function matmulQ(X, N, W, Y, noBias) {
  const { q, s, b, O, K, NG } = W;
  let n = 0;
  for (; n + 4 <= N; n += 4) {
    const x0 = n * K, x1 = x0 + K, x2 = x1 + K, x3 = x2 + K;
    const y0r = n * O, y1r = y0r + O, y2r = y1r + O, y3r = y2r + O;
    for (let o = 0; o < O; o++) {
      const qo = o * K, so = o * NG;
      let y0 = 0, y1 = 0, y2 = 0, y3 = 0;
      for (let g = 0, base = 0; g < NG; g++, base += G) {
        let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
        const qb = qo + base;
        for (let i = 0; i < G; i++) {
          const w = q[qb + i], k = base + i;
          a0 += X[x0 + k] * w; a1 += X[x1 + k] * w; a2 += X[x2 + k] * w; a3 += X[x3 + k] * w;
        }
        const sc = s[so + g];
        y0 += a0 * sc; y1 += a1 * sc; y2 += a2 * sc; y3 += a3 * sc;
      }
      const bo = noBias ? 0 : b[o];
      Y[y0r + o] = y0 + bo; Y[y1r + o] = y1 + bo; Y[y2r + o] = y2 + bo; Y[y3r + o] = y3 + bo;
    }
  }
  for (; n < N; n++) {
    const x0 = n * K, yr = n * O;
    for (let o = 0; o < O; o++) {
      const qo = o * K, so = o * NG;
      let y = 0;
      for (let g = 0, base = 0; g < NG; g++, base += G) {
        let a = 0;
        const qb = qo + base;
        for (let i = 0; i < G; i++) a += X[x0 + base + i] * q[qb + i];
        y += a * s[so + g];
      }
      Y[yr + o] = y + (noBias ? 0 : b[o]);
    }
  }
  return Y;
}

function layerNorm(X, N, g, b, Y, scaleOut) {
  for (let n = 0; n < N; n++) {
    const r = n * D;
    let mu = 0;
    for (let i = 0; i < D; i++) mu += X[r + i];
    mu /= D;
    let v = 0;
    for (let i = 0; i < D; i++) { const d = X[r + i] - mu; v += d * d; }
    const inv = 1 / Math.sqrt(v / D + 1e-5);
    if (scaleOut) scaleOut[n] = inv;
    for (let i = 0; i < D; i++) Y[r + i] = (X[r + i] - mu) * inv * g[i] + b[i];
  }
  return Y;
}

const GC = Math.sqrt(2 / Math.PI);
export function gelu(x) { return 0.5 * x * (1 + Math.tanh(GC * (x + 0.044715 * x * x * x))); }

/* ------------------------------------------------------------------ model */

export class GPT2 {
  constructor(W) {
    this.W = W;
    this.cfg = CFG;
    // each neuron's write direction length ||W_out[n]|| (row n of the MLP output matrix), per layer
    this.woutNorm = [];
    for (let l = 0; l < L; l++) {
      const P = W.layers[l].proj, nrm = new Float32Array(M);
      for (let o = 0; o < D; o++) {
        const qo = o * M, so = o * P.NG;
        for (let n = 0; n < M; n++) { const w = P.q[qo + n] * P.s[so + (n >> 6)]; nrm[n] += w * w; }
      }
      for (let n = 0; n < M; n++) nrm[n] = Math.sqrt(nrm[n]);
      this.woutNorm.push(nrm);
    }
    this.residNorm = new Float32Array(L).fill(100);   // replaced by lab data (median resid norm per layer)
  }

  /* ---- weight views (dequantised on the fly) ---- */
  embedRow(tok, out, off = 0) {
    const w = this.W.wte, r = tok < w.split ? tok : tok - w.split, q = tok < w.split ? w.q0 : w.q1;
    for (let i = 0; i < w.nr; i++) out[off + w.restIdx[i]] = q[r * w.nr + i] * w.s[tok * w.ng + (i >> 6)];
    for (let k = 0; k < w.nk; k++) out[off + w.keepIdx[k]] = w.keep[tok * w.nk + k];
    return out;
  }
  /* MLP output direction of neuron n in layer l (768) */
  wout(l, n, out = new Float32Array(D)) {
    const P = this.W.layers[l].proj;
    for (let o = 0; o < D; o++) out[o] = P.q[o * M + n] * P.s[o * P.NG + (n >> 6)];
    return out;
  }
  /* MLP input weights of neuron n in layer l (768): what it reads from ln_2(resid) */
  win(l, n, out = new Float32Array(D)) {
    const F = this.W.layers[l].fc;
    for (let i = 0; i < D; i++) out[i] = F.q[n * D + i] * F.s[n * F.NG + (i >> 6)];
    return out;
  }
  /* logits for one residual vector already passed through ln_f (or any 768 vector): out[V] */
  unembed(x, out = new Float32Array(V)) {
    const w = this.W.wte, nr = w.nr, nk = w.nk, ng = w.ng;
    const xr = new Float64Array(nr), xk = new Float64Array(nk);
    for (let i = 0; i < nr; i++) xr[i] = x[w.restIdx[i]];
    for (let k = 0; k < nk; k++) xk[k] = x[w.keepIdx[k]];
    for (let v = 0; v < V; v++) {
      const q = v < w.split ? w.q0 : w.q1, r = (v < w.split ? v : v - w.split) * nr, so = v * ng;
      let y = 0;
      for (let g = 0, base = 0; g < ng; g++, base += G) {
        let a = 0;
        const qb = r + base;
        for (let i = 0; i < G; i++) a += xr[base + i] * q[qb + i];
        y += a * w.s[so + g];
      }
      const kb = v * nk;
      for (let k = 0; k < nk; k++) y += xk[k] * w.keep[kb + k];
      out[v] = y;
    }
    return out;
  }
  /* unembed several rows at once (rows of X, each 768, already ln_f'd) -> out [N x V] */
  unembedMany(X, N, out) {
    const w = this.W.wte, nr = w.nr, nk = w.nk, ng = w.ng;
    const xr = new Float64Array(N * nr), xk = new Float64Array(N * nk);
    for (let n = 0; n < N; n++) {
      for (let i = 0; i < nr; i++) xr[n * nr + i] = X[n * D + w.restIdx[i]];
      for (let k = 0; k < nk; k++) xk[n * nk + k] = X[n * D + w.keepIdx[k]];
    }
    for (let v = 0; v < V; v++) {
      const q = v < w.split ? w.q0 : w.q1, r = (v < w.split ? v : v - w.split) * nr, so = v * ng, kb = v * nk;
      for (let n = 0; n < N; n++) {
        const xo = n * nr;
        let y = 0;
        for (let g = 0, base = 0; g < ng; g++, base += G) {
          let a = 0;
          const qb = r + base, xb = xo + base;
          for (let i = 0; i < G; i++) a += xr[xb + i] * q[qb + i];
          y += a * w.s[so + g];
        }
        const xko = n * nk;
        for (let k = 0; k < nk; k++) y += xk[xko + k] * w.keep[kb + k];
        out[n * V + v] = y;
      }
    }
    return out;
  }

  newCache(R, Tmax) {
    const kv = { R, Tmax, T: 0, K: [], Vv: [] };
    for (let l = 0; l < L; l++) { kv.K.push(new Float32Array(R * H * Tmax * dh)); kv.Vv.push(new Float32Array(R * H * Tmax * dh)); }
    return kv;
  }

  /* forward(opts)
     ids:      array of R rows of token ids (all rows the same length), or one array (R = 1)
     cache:    a cache from newCache(); the ids are appended after cache.T positions
     capture:  { name: true | [layers] }   names as in the header; 'lnf_scale' and 'resid_final' have no layer
     iv:       interventions, see applyIv
     logits:   'last' (default) | 'all' | 'none' | [positions]
     Returns { R, T (new positions), T0 (offset), logits: Float32Array [R*P*V], lpos: [positions], cap } */
  forward(opts) {
    let ids = opts.ids;
    if (!Array.isArray(ids[0]) && !(ids[0] instanceof Int32Array)) ids = [ids];
    const R = ids.length, Tn = ids[0].length, kv = opts.cache || null, T0 = kv ? kv.T : 0, Tt = T0 + Tn, N = R * Tn;
    const cap = {}, want = opts.capture || {}, iv = opts.iv || [];
    const wantL = (name, l) => want[name] === true || (Array.isArray(want[name]) && want[name].includes(l));
    const record = (name, l, arr) => {
      if (!wantL(name, l)) return;
      (cap[name] || (cap[name] = []))[l] = Float32Array.from(arr);
    };
    const ivAt = (hook, l) => iv.filter((x) => x.hook === hook && (x.layer === l || x.layer === undefined || x.layer === 'all'));
    const W = this.W;
    // embeddings
    const x = new Float32Array(N * D);
    for (let r = 0; r < R; r++) for (let t = 0; t < Tn; t++) {
      const n = r * Tn + t, p = T0 + t;
      this.embedRow(ids[r][t], x, n * D);
      for (let i = 0; i < D; i++) x[n * D + i] += W.wpe[p * D + i];
    }
    const h = new Float32Array(N * D), qkv = new Float32Array(N * 3 * D), z = new Float32Array(N * D);
    const ao = new Float32Array(N * D), pre = new Float32Array(N * M), mo = new Float32Array(N * D);
    const Kc = kv ? null : new Float32Array(R * H * Tt * dh), Vc = kv ? null : new Float32Array(R * H * Tt * dh);
    const scale = 1 / Math.sqrt(dh);
    const scores = new Float64Array(Tt);
    for (let l = 0; l < L; l++) {
      const Ly = W.layers[l];
      this.applyIv(ivAt('resid_pre', l), x, R, Tn, T0, D);
      record('resid_pre', l, x);
      layerNorm(x, N, Ly.ln1g, Ly.ln1b, h);
      matmulQ(h, N, Ly.qkv, qkv);
      // write K, V into the cache
      const K = kv ? kv.K[l] : Kc, Vv = kv ? kv.Vv[l] : Vc, Tm = kv ? kv.Tmax : Tt;
      for (let r = 0; r < R; r++) for (let t = 0; t < Tn; t++) {
        const n = r * Tn + t, p = T0 + t;
        for (let hh = 0; hh < H; hh++) {
          const dst = ((r * H + hh) * Tm + p) * dh, src = n * 3 * D + hh * dh;
          for (let d = 0; d < dh; d++) { K[dst + d] = qkv[src + D + d]; Vv[dst + d] = qkv[src + 2 * D + d]; }
        }
      }
      const wantPat = wantL('attn_pattern', l);
      const pat = wantPat ? new Float32Array(R * H * Tn * Tt) : null;
      const ivPat = ivAt('attn_pattern', l);
      for (let r = 0; r < R; r++) for (let hh = 0; hh < H; hh++) {
        const kvb = (r * H + hh) * Tm * dh;
        for (let t = 0; t < Tn; t++) {
          const n = r * Tn + t, p = T0 + t, qo = n * 3 * D + hh * dh;
          let mx = -Infinity;
          for (let s = 0; s <= p; s++) {
            let a = 0;
            const ko = kvb + s * dh;
            for (let d = 0; d < dh; d++) a += qkv[qo + d] * K[ko + d];
            a *= scale;
            scores[s] = a;
            if (a > mx) mx = a;
          }
          let sum = 0;
          for (let s = 0; s <= p; s++) { const e = Math.exp(scores[s] - mx); scores[s] = e; sum += e; }
          for (let s = 0; s <= p; s++) scores[s] /= sum;
          if (ivPat.length) this.applyPatIv(ivPat, scores, r, hh, p);
          if (pat) { const pb = ((r * H + hh) * Tn + t) * Tt; for (let s = 0; s <= p; s++) pat[pb + s] = scores[s]; }
          const zo = n * D + hh * dh;
          for (let d = 0; d < dh; d++) z[zo + d] = 0;
          for (let s = 0; s <= p; s++) {
            const w = scores[s];
            if (w === 0) continue;
            const vo = kvb + s * dh;
            for (let d = 0; d < dh; d++) z[zo + d] += w * Vv[vo + d];
          }
        }
      }
      if (pat) (cap.attn_pattern || (cap.attn_pattern = []))[l] = pat;
      this.applyHeadIv(ivAt('head', l), z, R, Tn, T0);
      record('attn_z', l, z);
      if (wantL('head_out', l)) cap.head_out = cap.head_out || [], cap.head_out[l] = this.headOut(l, z, N);
      matmulQ(z, N, Ly.o, ao);
      this.applyIv(ivAt('attn_out', l), ao, R, Tn, T0, D);
      record('attn_out', l, ao);
      for (let i = 0; i < N * D; i++) x[i] += ao[i];
      this.applyIv(ivAt('resid_mid', l), x, R, Tn, T0, D);
      record('resid_mid', l, x);
      layerNorm(x, N, Ly.ln2g, Ly.ln2b, h);
      matmulQ(h, N, Ly.fc, pre);
      record('mlp_pre', l, pre);
      for (let i = 0; i < N * M; i++) pre[i] = gelu(pre[i]);
      this.applyNeuronIv(ivAt('mlp_post', l), pre, R, Tn, T0, l);
      record('mlp_post', l, pre);
      matmulQ(pre, N, Ly.proj, mo);
      this.applyIv(ivAt('mlp_out', l), mo, R, Tn, T0, D);
      record('mlp_out', l, mo);
      for (let i = 0; i < N * D; i++) x[i] += mo[i];
      this.applyIv(ivAt('resid_post', l), x, R, Tn, T0, D);
      record('resid_post', l, x);
    }
    if (kv) kv.T = Tt;
    if (want.resid_final) cap.resid_final = Float32Array.from(x);
    // final layer norm and logits
    const sc = new Float32Array(N);
    layerNorm(x, N, W.lnfg, W.lnfb, h, sc);
    if (want.lnf_scale) cap.lnf_scale = sc;
    if (want.lnf_out) cap.lnf_out = Float32Array.from(h);
    let lpos = opts.logits === 'all' ? [...Array(Tn).keys()] : Array.isArray(opts.logits) ? opts.logits.map((p) => p - T0) : opts.logits === 'none' ? [] : [Tn - 1];
    const P = lpos.length;
    let logits = null;
    if (P) {
      const sel = new Float32Array(R * P * D);
      for (let r = 0; r < R; r++) lpos.forEach((t, j) => sel.set(h.subarray((r * Tn + t) * D, (r * Tn + t + 1) * D), (r * P + j) * D));
      logits = this.unembedMany(sel, R * P, new Float32Array(R * P * V));
    }
    return { R, T: Tn, T0, logits, lpos: lpos.map((t) => t + T0), cap };
  }

  /* per-head write into the residual: out[(n*H + h)*D + o] = sum_d z[n, h*64+d] * W_O[o, h*64+d] */
  headOut(l, z, N) {
    const O = this.W.layers[l].o, out = new Float32Array(N * H * D);
    for (let n = 0; n < N; n++) for (let hh = 0; hh < H; hh++) {
      const zo = n * D + hh * dh, ob = (n * H + hh) * D;
      for (let o = 0; o < D; o++) {
        const qo = o * D + hh * dh, s = O.s[o * O.NG + hh];   // a head's 64 inputs are exactly one quant group
        let a = 0;
        for (let d = 0; d < dh; d++) a += z[zo + d] * O.q[qo + d];
        out[ob + o] = a * s;
      }
    }
    return out;
  }

  /* ---- interventions ----
     common fields: rows ('all' | [r...]), pos ('all' | p | [p...]) absolute positions, value (number or per-row array)
     residual-shaped hooks (resid_pre/mid/post, attn_out, mlp_out):
       {op:'add', vec}         x += value * vec        (vec: Float32Array(768); value defaults to 1)
       {op:'set', src, srcT}   x = src  (src: Float32Array [srcT*768], taken at the same absolute position)
       {op:'mul', value}       x *= value
       {op:'project_out', vec} remove the component along vec
     mlp_post (neurons):  {neuron: n | [n...], op: 'add' | 'addr' | 'mul' | 'set', value}  addr = add in units of the
                          layer's median residual norm along the neuron's own write direction (neuron-explorer's unit)
                          or {op:'setsrc', src, srcT} to patch every neuron (or the listed ones) from another run
     head:     {head: h | 'all', op: 'mul' | 'mean' | 'set', value, src, srcT, mean}   acts on hook_z (before W_O)
     attn_pattern: {head, op:'set', src} rarely used                                                           */
  rowsOf(x, R) { return x.rows === undefined || x.rows === 'all' ? [...Array(R).keys()] : x.rows; }
  posOf(x, Tn, T0) {
    const all = [...Array(Tn).keys()].map((t) => t + T0);
    if (x.pos === undefined || x.pos === 'all') return all;
    const ps = Array.isArray(x.pos) ? x.pos : [x.pos];
    return ps.filter((p) => p >= T0 && p < T0 + Tn);
  }
  val(x, r) { const v = x.value === undefined ? 1 : x.value; return Array.isArray(v) ? v[r] : v; }
  applyIv(list, X, R, Tn, T0, width) {
    for (const x of list) for (const r of this.rowsOf(x, R)) {
      const v = this.val(x, r);
      for (const p of this.posOf(x, Tn, T0)) {
        const o = (r * Tn + p - T0) * width;
        if (x.op === 'add') for (let i = 0; i < width; i++) X[o + i] += v * x.vec[i];
        else if (x.op === 'mul') for (let i = 0; i < width; i++) X[o + i] *= v;
        else if (x.op === 'set') { const so = p * width; for (let i = 0; i < width; i++) X[o + i] = x.src[so + i]; }
        else if (x.op === 'project_out') {
          let dot = 0, nn = 0;
          for (let i = 0; i < width; i++) { dot += X[o + i] * x.vec[i]; nn += x.vec[i] * x.vec[i]; }
          const c = dot / (nn || 1);
          for (let i = 0; i < width; i++) X[o + i] -= c * x.vec[i];
        }
      }
    }
  }
  applyNeuronIv(list, A, R, Tn, T0, l) {
    for (const x of list) {
      const ns = x.neuron === undefined || x.neuron === 'all' ? null : Array.isArray(x.neuron) ? x.neuron : [x.neuron];
      for (const r of this.rowsOf(x, R)) {
        const v = this.val(x, r);
        for (const p of this.posOf(x, Tn, T0)) {
          const o = (r * Tn + p - T0) * M;
          const list2 = ns || [...Array(M).keys()];
          for (const n of list2) {
            if (x.op === 'add') A[o + n] += v;
            else if (x.op === 'addr') A[o + n] += v * this.residNorm[l] / (this.woutNorm[l][n] || 1);
            else if (x.op === 'mul') A[o + n] *= v;
            else if (x.op === 'set') A[o + n] = v;
            else if (x.op === 'setsrc') A[o + n] = x.src[p * M + n];
          }
        }
      }
    }
  }
  applyHeadIv(list, Z, R, Tn, T0) {
    for (const x of list) {
      const hs = x.head === undefined || x.head === 'all' ? [...Array(H).keys()] : Array.isArray(x.head) ? x.head : [x.head];
      for (const r of this.rowsOf(x, R)) {
        const v = this.val(x, r);
        for (const p of this.posOf(x, Tn, T0)) {
          const o = (r * Tn + p - T0) * D;
          for (const hh of hs) {
            const b = o + hh * dh;
            if (x.op === 'mul') for (let d = 0; d < dh; d++) Z[b + d] *= v;
            else if (x.op === 'set') { const so = p * D + hh * dh; for (let d = 0; d < dh; d++) Z[b + d] = x.src[so + d]; }
            else if (x.op === 'mean') { const mo = hh * dh; for (let d = 0; d < dh; d++) Z[b + d] = x.mean[mo + d]; }
          }
        }
      }
    }
  }
  applyPatIv(list, scores, r, hh, p) {
    for (const x of list) {
      if (x.rows !== undefined && x.rows !== 'all' && !x.rows.includes(r)) continue;
      if (x.head !== undefined && x.head !== 'all' && x.head !== hh) continue;
      if (x.op === 'uniform') { for (let s = 0; s <= p; s++) scores[s] = 1 / (p + 1); }
    }
  }

  /* Greedy or sampled continuation of one prompt in R rows at once (rows differ only by their interventions).
     onStep(step, tokens[R]) is called after every new token; return false from it to stop.
     Interventions with pos 'all' also act on the generated positions. */
  generate(opts) {
    const { prompt, R = 1, maxNew = 40, temperature = 0, topK = 0, iv = [], onStep, seed = 1 } = opts;
    const Tmax = Math.min(CFG.ctx, prompt.length + maxNew);
    const kv = this.newCache(R, Tmax);
    let rng = seed >>> 0;
    const rand = () => { rng = (rng * 1664525 + 1013904223) >>> 0; return rng / 4294967296; };
    let res = this.forward({ ids: Array.from({ length: R }, () => prompt), cache: kv, iv, logits: 'last' });
    const out = Array.from({ length: R }, () => []);
    const steps = Math.min(maxNew, Tmax - prompt.length);
    for (let s = 0; s < steps; s++) {
      const next = [];
      for (let r = 0; r < R; r++) next.push(this.pick(res.logits.subarray(r * V, (r + 1) * V), temperature, topK, rand));
      next.forEach((t, r) => out[r].push(t));
      if (onStep && onStep(s, next, res) === false) break;
      if (s === steps - 1) break;
      res = this.forward({ ids: next.map((t) => [t]), cache: kv, iv, logits: 'last' });
    }
    return out;
  }
  pick(lg, temperature, topK, rand) {
    if (!temperature) { let b = 0; for (let i = 1; i < lg.length; i++) if (lg[i] > lg[b]) b = i; return b; }
    let idx = [...lg.keys()];
    if (topK) idx = idx.sort((a, b) => lg[b] - lg[a]).slice(0, topK);
    let mx = -Infinity; for (const i of idx) mx = Math.max(mx, lg[i]);
    const p = idx.map((i) => Math.exp((lg[i] - mx) / temperature));
    let sum = p.reduce((a, b) => a + b, 0), u = rand() * sum;
    for (let j = 0; j < idx.length; j++) { u -= p[j]; if (u <= 0) return idx[j]; }
    return idx[idx.length - 1];
  }
}

export function logSoftmax(lg) {
  let mx = -Infinity;
  for (let i = 0; i < lg.length; i++) if (lg[i] > mx) mx = lg[i];
  let s = 0;
  for (let i = 0; i < lg.length; i++) s += Math.exp(lg[i] - mx);
  const lz = mx + Math.log(s), out = new Float32Array(lg.length);
  for (let i = 0; i < lg.length; i++) out[i] = lg[i] - lz;
  return out;
}

export function topk(arr, k, sign = 1) {
  const idx = [];
  for (let i = 0; i < arr.length; i++) {
    const v = sign * arr[i];
    if (idx.length < k) { idx.push(i); if (idx.length === k) idx.sort((a, b) => sign * arr[b] - sign * arr[a]); continue; }
    if (v > sign * arr[idx[k - 1]]) {
      let j = k - 1;
      while (j > 0 && sign * arr[idx[j - 1]] < v) { idx[j] = idx[j - 1]; j--; }
      idx[j] = i;
    }
  }
  if (idx.length < k) idx.sort((a, b) => sign * arr[b] - sign * arr[a]);
  return idx;
}
