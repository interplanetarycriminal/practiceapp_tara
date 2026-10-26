/* lab/core/recipes.js: the lab's techniques as procedures over the engine.

   Each recipe is async (env, args) => result. env: { E, cpu, gpu, tok, cfg, forward(opts), unembedRows(X, N), ctx }
   where ctx.progress(x) reports progress and ctx.cancelled() says the caller gave up. Recipes return compact
   summaries (typed arrays when large), never raw 50,257-wide logits for many rows.

   Positions are absolute token positions in the prompt, and prompts start with <|endoftext|> (position 0), as in
   TransformerLens. Metrics: {kind:'logitdiff', a, b, pos} | {kind:'logprob', t, pos} | {kind:'prob', t, pos}. */

import { CFG, logSoftmax, topk } from './gpt2.js';

const { L, H, D, dh, M, V } = CFG;

/* ------------------------------------------------------------ helpers */

function lnRow(x, off, g, b, out, ooff) {
  let mu = 0;
  for (let i = 0; i < D; i++) mu += x[off + i];
  mu /= D;
  let v = 0;
  for (let i = 0; i < D; i++) { const d = x[off + i] - mu; v += d * d; }
  const inv = 1 / Math.sqrt(v / D + 1e-5);
  for (let i = 0; i < D; i++) out[ooff + i] = (x[off + i] - mu) * inv * g[i] + b[i];
  return inv;
}

function rankOf(lg, t) {
  const v = lg[t];
  let r = 0;
  for (let i = 0; i < lg.length; i++) if (lg[i] > v) r++;
  return r;
}

function entropyOf(lp) {
  let h = 0;
  for (let i = 0; i < lp.length; i++) { const p = Math.exp(lp[i]); if (p > 1e-12) h -= p * lp[i]; }
  return h;
}

function lastPos(ids, pos) { return pos === undefined || pos < 0 ? ids.length + (pos === undefined ? -1 : pos) : pos; }

/* metric for every row of a forward result whose logits were requested at the metric's position */
function metricRows(res, metric, R) {
  const out = new Float64Array(R);
  const P = res.lpos.length;
  const j = res.lpos.indexOf(metric.pos);
  if (j < 0) throw new Error('metric position missing');
  for (let r = 0; r < R; r++) {
    const lg = res.logits.subarray((r * P + j) * V, (r * P + j + 1) * V);
    if (metric.kind === 'logitdiff') out[r] = lg[metric.a] - lg[metric.b];
    else {
      const lp = logSoftmax(lg);
      out[r] = metric.kind === 'prob' ? Math.exp(lp[metric.t]) : lp[metric.t];
    }
  }
  return out;
}

function centred(v) {
  let mu = 0;
  for (let i = 0; i < v.length; i++) mu += v[i];
  mu /= v.length;
  const o = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) o[i] = v[i] - mu;
  return o;
}

function dot(a, ao, b, bo, n) { let s = 0; for (let i = 0; i < n; i++) s += a[ao + i] * b[bo + i]; return s; }

/* Let the worker read its mailbox (a cancel may be waiting: the plain engine never yields on its own), then stop if
   the caller gave up. */
function checkpoint(env) {
  return new Promise((resolve, reject) => setTimeout(() => {
    if (env.ctx.cancelled && env.ctx.cancelled()) reject(new Error('cancelled')); else resolve();
  }, 0));
}

function rngFrom(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/* the unembedding direction for "logit of a minus logit of b" (b may be absent), through ln_f's gamma */
function logitDir(cpu, a, b) {
  const ua = cpu.embedRow(a, new Float32Array(D));
  const ub = b === undefined || b === null ? null : cpu.embedRow(b, new Float32Array(D));
  const g = cpu.W.lnfg, beta = cpu.W.lnfb;
  const dW = new Float32Array(D), dir = new Float32Array(D);
  let konst = 0;
  for (let i = 0; i < D; i++) { dW[i] = ua[i] - (ub ? ub[i] : 0); dir[i] = g[i] * dW[i]; konst += beta[i] * dW[i]; }
  return { dir, konst };
}

/* contribution of a vector written into the residual stream to the directional logit, at a position whose final
   layer norm scale is inv: inv * (v - mean(v)) . dir */
function contrib(v, off, dir, inv) {
  let mu = 0;
  for (let i = 0; i < D; i++) mu += v[off + i];
  mu /= D;
  let s = 0;
  for (let i = 0; i < D; i++) s += (v[off + i] - mu) * dir[i];
  return s * inv;
}

/* ------------------------------------------------------------ recipes */

export const RECIPES = {

  /* What comes next: the top k tokens at the last position, the entropy, and any target tokens' standing. */
  async predict(env, { ids, k = 10, targets = [] }) {
    const r = await env.forward({ ids, logits: 'last' });
    const lg = r.logits, lp = logSoftmax(lg), top = topk(lg, k);
    return {
      top, probs: top.map((i) => Math.exp(lp[i])), logits: top.map((i) => lg[i]), entropy: entropyOf(lp),
      targets: targets.map((t) => ({ id: t, prob: Math.exp(lp[t]), logit: lg[t], rank: rankOf(lg, t) })),
    };
  },

  /* Every position's prediction: how surprised the model was by the token that actually came next, and its top k. */
  async perToken(env, { ids, k = 5 }) {
    const T = ids.length;
    const r = await env.forward({ ids, logits: 'all' });
    const top = new Int32Array(T * k), prob = new Float32Array(T * k);
    const nextLp = new Float32Array(T).fill(NaN), nextRank = new Int32Array(T).fill(-1), ent = new Float32Array(T);
    for (let p = 0; p < T; p++) {
      const lg = r.logits.subarray(p * V, (p + 1) * V), lp = logSoftmax(lg);
      const tk = topk(lg, k);
      tk.forEach((t, j) => { top[p * k + j] = t; prob[p * k + j] = Math.exp(lp[t]); });
      ent[p] = entropyOf(lp);
      if (p + 1 < T) { nextLp[p] = lp[ids[p + 1]]; nextRank[p] = rankOf(lg, ids[p + 1]); }
    }
    return { k, top, prob, nextLp, nextRank, entropy: ent };
  },

  /* Logit lens: decode the residual stream after every layer as if it were the last one (nostalgebraist, 2020). */
  async logitLens(env, { ids, k = 3, target = null, positions = null }) {
    const T = ids.length, S = L + 1;
    const r = await env.forward({ ids, capture: { resid_pre: [0], resid_post: true }, logits: 'none' });
    const pos = positions || [...Array(T).keys()];
    const P = pos.length, g = env.cpu.W.lnfg, b = env.cpu.W.lnfb;
    const top = new Int32Array(S * P * k), prob = new Float32Array(S * P * k);
    const tProb = new Float32Array(S * P).fill(NaN), tRank = new Int32Array(S * P).fill(-1), ent = new Float32Array(S * P);
    const rows = [];
    for (let s = 0; s < S; s++) for (let j = 0; j < P; j++) rows.push([s, j]);
    const CH = env.gpu ? 96 : 16;
    for (let c0 = 0; c0 < rows.length; c0 += CH) {
      await checkpoint(env);
      const part = rows.slice(c0, c0 + CH), N = part.length, X = new Float32Array(N * D);
      part.forEach(([s, j], n) => {
        const src = s === 0 ? r.cap.resid_pre[0] : r.cap.resid_post[s - 1];
        lnRow(src, pos[j] * D, g, b, X, n * D);
      });
      const lgAll = await env.unembedRows(X, N);
      part.forEach(([s, j], n) => {
        const lg = lgAll.subarray(n * V, (n + 1) * V), lp = logSoftmax(lg), q = s * P + j;
        topk(lg, k).forEach((t, i) => { top[q * k + i] = t; prob[q * k + i] = Math.exp(lp[t]); });
        ent[q] = entropyOf(lp);
        if (target !== null && target !== undefined) { tProb[q] = Math.exp(lp[target]); tRank[q] = rankOf(lg, target); }
      });
      if (env.ctx.progress) env.ctx.progress({ done: Math.min(rows.length, c0 + CH), total: rows.length });
    }
    return { S, P, k, positions: pos, top, prob, tProb, tRank, entropy: ent };
  },

  /* Attention patterns of every head, plus per-head summaries on this prompt. */
  async attention(env, { ids }) {
    const T = ids.length;
    const r = await env.forward({ ids, capture: { attn_pattern: true }, logits: 'none' });
    const bos = new Float32Array(L * H), prev = new Float32Array(L * H), self = new Float32Array(L * H), ent = new Float32Array(L * H);
    for (let l = 0; l < L; l++) {
      const A = r.cap.attn_pattern[l];
      for (let h = 0; h < H; h++) {
        let sb = 0, sp = 0, ss = 0, se = 0, n = 0;
        for (let t = 1; t < T; t++) {
          const row = (h * T + t) * T;
          sb += A[row]; sp += A[row + t - 1]; ss += A[row + t];
          for (let s = 0; s <= t; s++) { const a = A[row + s]; if (a > 1e-9) se -= a * Math.log(a); }
          n++;
        }
        const q = l * H + h;
        bos[q] = n ? sb / n : 0; prev[q] = n ? sp / n : 0; self[q] = n ? ss / n : 0; ent[q] = n ? se / n : 0;
      }
    }
    return { T, patterns: r.cap.attn_pattern, bos, prev, self, entropy: ent };
  },

  /* ARENA's head detectors on random tokens repeated twice: previous-token, duplicate-token and induction scores. */
  async headScores(env, { seqLen = 50, batch = 4, seed = 7 }) {
    const rand = rngFrom(seed);
    const ids = [];
    for (let r = 0; r < batch; r++) {
      const half = Array.from({ length: seqLen }, () => Math.floor(rand() * 50256));
      ids.push([50256, ...half, ...half]);
    }
    const res = await env.forward({ ids, capture: { attn_pattern: true }, logits: 'none' });
    const T = 2 * seqLen + 1;
    const prev = new Float32Array(L * H), dup = new Float32Array(L * H), ind = new Float32Array(L * H), bos = new Float32Array(L * H);
    for (let l = 0; l < L; l++) {
      const A = res.cap.attn_pattern[l];
      for (let h = 0; h < H; h++) {
        let sp = 0, sd = 0, si = 0, sb = 0, np = 0, nr = 0;
        for (let r = 0; r < batch; r++) {
          const base = (r * H + h) * T * T;
          for (let t = 1; t < T; t++) { sp += A[base + t * T + t - 1]; sb += A[base + t * T]; np++; }
          for (let i = 0; i < seqLen; i++) {
            const t = seqLen + 1 + i, first = 1 + i;
            sd += A[base + t * T + first];
            if (first + 1 < t) si += A[base + t * T + first + 1];
            nr++;
          }
        }
        const q = l * H + h;
        prev[q] = sp / np; bos[q] = sb / np; dup[q] = sd / nr; ind[q] = si / nr;
      }
    }
    return { prev, dup, induction: ind, bos, seqLen, batch };
  },

  /* Direct logit attribution: split logit(a) - logit(b) at one position into what every component wrote.
     The pieces add up exactly, because the residual stream is a sum and the final layer norm's scale is fixed. */
  async dla(env, { ids, a, b = null, pos, neurons = 30 }) {
    const p = lastPos(ids, pos), cpu = env.cpu;
    const r = await env.forward({ ids, capture: { head_out: true, mlp_out: true, mlp_post: true, resid_final: true }, logits: [p] });
    const { dir, konst } = logitDir(cpu, a, b);
    const inv = 1 / Math.sqrt((() => {
      const x = r.cap.resid_final; let mu = 0;
      for (let i = 0; i < D; i++) mu += x[p * D + i];
      mu /= D; let v = 0;
      for (let i = 0; i < D; i++) { const d = x[p * D + i] - mu; v += d * d; }
      return v / D + 1e-5;
    })());
    const tokE = cpu.embedRow(ids[p], new Float32Array(D));
    const embed = contrib(tokE, 0, dir, inv);
    const posE = contrib(cpu.W.wpe, p * D, dir, inv);
    const heads = new Float32Array(L * H), attnBias = new Float32Array(L), mlp = new Float32Array(L);
    for (let l = 0; l < L; l++) {
      const ho = r.cap.head_out[l];
      for (let h = 0; h < H; h++) heads[l * H + h] = contrib(ho, (p * H + h) * D, dir, inv);
      attnBias[l] = contrib(cpu.W.layers[l].o.b, 0, dir, inv);
      mlp[l] = contrib(r.cap.mlp_out[l], p * D, dir, inv);
    }
    let sum = embed + posE + konst;
    for (let i = 0; i < L * H; i++) sum += heads[i];
    for (let l = 0; l < L; l++) sum += attnBias[l] + mlp[l];
    const lg = r.logits;
    const actual = lg[a] - (b === null || b === undefined ? 0 : lg[b]);
    // neurons: activation x what one unit of it writes along the direction, inv * (w - mean(w)) . dir
    const nScore = new Float32Array(L * M);
    let sumDir = 0;
    for (let i = 0; i < D; i++) sumDir += dir[i];
    for (let l = 0; l < L; l++) {
      const act = r.cap.mlp_post[l], P = cpu.W.layers[l].proj;
      const sd = new Float64Array(M), sm = new Float64Array(M);
      for (let o = 0; o < D; o++) {
        const qo = o * M, so = o * P.NG, dd = dir[o];
        for (let n = 0; n < M; n++) { const w = P.q[qo + n] * P.s[so + (n >> 6)]; sd[n] += w * dd; sm[n] += w; }
      }
      for (let n = 0; n < M; n++) nScore[l * M + n] = act[p * M + n] * inv * (sd[n] - sm[n] / D * sumDir);
    }
    const up = topk(nScore, neurons), down = topk(nScore, neurons, -1);
    return {
      pos: p, embed, posEmbed: posE, constant: konst, heads, attnBias, mlp, sum, actual, inv,
      neuronsUp: up.map((i) => [i, nScore[i]]), neuronsDown: down.map((i) => [i, nScore[i]]),
    };
  },

  /* One forward pass per set of interventions, reporting the metric for each. iv lists rows explicitly. */
  async metric(env, { ids, metric, ivs = [[]] }) {
    const R = ivs.length;
    const iv = [];
    ivs.forEach((list, r) => list.forEach((x) => iv.push({ ...x, rows: [r] })));
    const res = await env.forward({ ids: Array.from({ length: R }, () => ids), iv, logits: [metric.pos] });
    return { values: Array.from(metricRows(res, metric, R)) };
  },

  /* Knock out every attention head in turn (zero or mean over this prompt's positions) and measure the change. */
  async headSweep(env, { ids, metric, mode = 'zero', chunk }) {
    const T = ids.length;
    let mean = null;
    if (mode === 'mean') {
      const c = await env.forward({ ids, capture: { attn_z: true }, logits: 'none' });
      mean = c.cap.attn_z.map((z) => {
        const m = new Float32Array(D);
        for (let t = 1; t < T; t++) for (let i = 0; i < D; i++) m[i] += z[t * D + i] / (T - 1);
        return m;
      });
    }
    const jobs = [];
    for (let l = 0; l < L; l++) for (let h = 0; h < H; h++) jobs.push([l, h]);
    const CH = chunk || (env.gpu ? 48 : 12);
    const base = await env.forward({ ids, logits: [metric.pos] });
    const clean = metricRows(base, metric, 1)[0];
    const delta = new Float32Array(L * H);
    for (let c0 = 0; c0 < jobs.length; c0 += CH) {
      await checkpoint(env);
      const part = jobs.slice(c0, c0 + CH), R = part.length;
      const iv = part.map(([l, h], r) => mode === 'mean'
        ? { hook: 'head', layer: l, head: h, op: 'mean', mean: mean[l], rows: [r] }
        : { hook: 'head', layer: l, head: h, op: 'mul', value: 0, rows: [r] });
      const res = await env.forward({ ids: Array.from({ length: R }, () => ids), iv, logits: [metric.pos] });
      const m = metricRows(res, metric, R);
      part.forEach(([l, h], r) => { delta[l * H + h] = m[r] - clean; });
      if (env.ctx.progress) env.ctx.progress({ done: c0 + R, total: jobs.length });
    }
    return { clean, delta, mode };
  },

  /* Activation patching (ARENA 1.4.1). denoise: run the corrupted prompt and paste in one activation from the clean
     run; noise: the reverse. Score 1 = that one paste gives the clean behaviour, 0 = it changes nothing. */
  async patch(env, { clean, corrupt, metric, hook = 'resid_pre', direction = 'denoise', chunk }) {
    if (clean.length !== corrupt.length) throw new Error('The two prompts must have the same number of tokens');
    const T = clean.length;
    const src = direction === 'denoise' ? clean : corrupt, dst = direction === 'denoise' ? corrupt : clean;
    const capName = hook === 'head' ? 'attn_z' : hook;
    const s = await env.forward({ ids: src, capture: { [capName]: true }, logits: [metric.pos] });
    const d = await env.forward({ ids: dst, logits: [metric.pos] });
    const mc = metricRows(direction === 'denoise' ? s : d, metric, 1)[0];
    const mx = metricRows(direction === 'denoise' ? d : s, metric, 1)[0];
    const jobs = [];
    if (hook === 'head') { for (let l = 0; l < L; l++) for (let h = 0; h < H; h++) jobs.push([l, h]); }
    else { for (let l = 0; l < L; l++) for (let p = 0; p < T; p++) jobs.push([l, p]); }
    const CH = chunk || (env.gpu ? 48 : 12);
    const raw = new Float32Array(jobs.length);
    for (let c0 = 0; c0 < jobs.length; c0 += CH) {
      await checkpoint(env);
      const part = jobs.slice(c0, c0 + CH), R = part.length;
      const iv = part.map(([l, x], r) => hook === 'head'
        ? { hook: 'head', layer: l, head: x, op: 'set', src: s.cap.attn_z[l], rows: [r] }
        : { hook, layer: l, op: 'set', src: s.cap[hook][l], pos: x, rows: [r] });
      const res = await env.forward({ ids: Array.from({ length: R }, () => dst), iv, logits: [metric.pos] });
      const m = metricRows(res, metric, R);
      part.forEach((_, r) => { raw[c0 + r] = m[r]; });
      if (env.ctx.progress) env.ctx.progress({ done: c0 + R, total: jobs.length });
    }
    const span = mc - mx;
    const score = raw.map((v) => (v - mx) / (span || 1));
    return { rows: L, cols: hook === 'head' ? H : T, raw, score, clean: mc, corrupt: mx, hook, direction };
  },

  /* Which neurons fire on this text: every neuron's activation at every position (36,864 x T). */
  async fires(env, { ids }) {
    const T = ids.length;
    const r = await env.forward({ ids, capture: { mlp_post: true }, logits: 'none' });
    const acts = new Float32Array(L * T * M);
    for (let l = 0; l < L; l++) acts.set(r.cap.mlp_post[l], l * T * M);
    const mx = new Float32Array(L * M).fill(-1), arg = new Int16Array(L * M);
    for (let l = 0; l < L; l++) for (let t = 1; t < T; t++) {
      const off = l * T * M + t * M;
      for (let n = 0; n < M; n++) if (acts[off + n] > mx[l * M + n]) { mx[l * M + n] = acts[off + n]; arg[l * M + n] = t; }
    }
    return { T, acts, max: mx, argmax: arg };
  },

  /* One neuron's activation at every position, and what it would write. */
  async neuronTrace(env, { ids, layer, neuron }) {
    const r = await env.forward({ ids, capture: { mlp_post: [layer] }, logits: 'none' });
    const A = r.cap.mlp_post[layer], T = ids.length, out = new Float32Array(T);
    for (let t = 0; t < T; t++) out[t] = A[t * M + neuron];
    return { acts: out };
  },

  /* A steering vector from a contrast (Turner et al.'s ActAdd): the residual stream on one prompt minus another. */
  async vector(env, { pos, neg, layer, hook = 'resid_pre', mode = 'last' }) {
    const a = await env.forward({ ids: pos, capture: { [hook]: [layer] }, logits: 'none' });
    const b = await env.forward({ ids: neg, capture: { [hook]: [layer] }, logits: 'none' });
    const A = a.cap[hook][layer], B = b.cap[hook][layer], v = new Float32Array(D);
    if (mode === 'last') {
      const pa = pos.length - 1, pb = neg.length - 1;
      for (let i = 0; i < D; i++) v[i] = A[pa * D + i] - B[pb * D + i];
    } else {
      for (let t = 1; t < pos.length; t++) for (let i = 0; i < D; i++) v[i] += A[t * D + i] / (pos.length - 1);
      for (let t = 1; t < neg.length; t++) for (let i = 0; i < D; i++) v[i] -= B[t * D + i] / (neg.length - 1);
    }
    let n2 = 0;
    for (let i = 0; i < D; i++) n2 += v[i] * v[i];
    return { vec: v, norm: Math.sqrt(n2) };
  },

  /* Which tokens a direction in the residual stream promotes and suppresses, read straight through the unembedding. */
  async unembedVec(env, { vec, k = 12 }) {
    const g = env.cpu.W.lnfg, c = centred(vec), X = new Float32Array(D);
    for (let i = 0; i < D; i++) X[i] = c[i] * g[i];
    const lg = await env.unembedRows(X, 1);
    const up = topk(lg, k), down = topk(lg, k, -1);
    return { up: up.map((i) => [i, lg[i]]), down: down.map((i) => [i, lg[i]]) };
  },

  /* Residual vectors for a batch of texts at every layer, for probes. pos: 'last' or 'mean' (over real tokens). */
  async residuals(env, { texts, hook = 'resid_post', pos = 'last' }) {
    const n = texts.length, out = new Float32Array(n * L * D);
    for (let j = 0; j < n; j++) {
      await checkpoint(env);
      const ids = texts[j], T = ids.length;
      const r = await env.forward({ ids, capture: { [hook]: true }, logits: 'none' });
      for (let l = 0; l < L; l++) {
        const X = r.cap[hook][l], o = (j * L + l) * D;
        if (pos === 'last') out.set(X.subarray((T - 1) * D, T * D), o);
        else for (let t = 1; t < T; t++) for (let i = 0; i < D; i++) out[o + i] += X[t * D + i] / (T - 1);
      }
      if (env.ctx.progress) env.ctx.progress({ done: j + 1, total: n });
    }
    return { n, vecs: out };
  },

  /* Weights of one neuron: what it reads (W_in, after ln_2's gain) and writes (W_out), and their logit lenses. */
  async neuronWeights(env, { layer, neuron, k = 12 }) {
    const cpu = env.cpu;
    const wout = cpu.wout(layer, neuron), win = cpu.win(layer, neuron);
    const g2 = cpu.W.layers[layer].ln2g;
    const read = new Float32Array(D);
    for (let i = 0; i < D; i++) read[i] = win[i] * g2[i];
    const lens = await RECIPES.unembedVec(env, { vec: wout, k });
    return { wout, win, read, lens, woutNorm: cpu.woutNorm[layer][neuron], residNorm: cpu.residNorm[layer] };
  },

  /* A head's OV circuit on a handful of tokens: if head (l, h) attends to token s, how much does it raise token t?
     Rows: the attended token, columns: the predicted token. Uses layer l's ln_1 on the raw token embedding. */
  async ovCircuit(env, { layer, head, tokens }) {
    const cpu = env.cpu, Ly = cpu.W.layers[layer], n = tokens.length;
    const q = Ly.qkv, o = Ly.o, gF = cpu.W.lnfg;
    const outs = new Float32Array(n * D);
    const e = new Float32Array(D), x = new Float32Array(D), v = new Float32Array(dh);
    tokens.forEach((t, j) => {
      cpu.embedRow(t, e);
      lnRow(e, 0, Ly.ln1g, Ly.ln1b, x, 0);
      for (let d = 0; d < dh; d++) {
        const row = 2 * D + head * dh + d;           // V rows of the fused qkv matrix
        let s = 0;
        for (let i = 0; i < D; i++) s += x[i] * q.q[row * D + i] * q.s[row * q.NG + (i >> 6)];
        v[d] = s + q.b[row];
      }
      for (let i = 0; i < D; i++) {
        let s = 0;
        for (let d = 0; d < dh; d++) s += v[d] * o.q[i * D + head * dh + d];
        outs[j * D + i] = s * o.s[i * o.NG + head];
      }
    });
    const U = tokens.map((t) => { const u = cpu.embedRow(t, new Float32Array(D)); for (let i = 0; i < D; i++) u[i] *= gF[i]; return u; });
    const mat = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      const c = centred(outs.subarray(j * D, (j + 1) * D));
      for (let k = 0; k < n; k++) mat[j * n + k] = dot(c, 0, U[k], 0, D);
    }
    return { n, mat };
  },
};
