/* lab/core/recipes.js: the lab's techniques as procedures over the engine.

   Each recipe is async (env, args) => result. env: { E, cpu, gpu, tok, cfg, forward(opts), unembedRows(X, N), ctx }
   where ctx.progress(x) reports progress and ctx.cancelled() says the caller gave up. Recipes return compact
   summaries (typed arrays when large), never raw 50,257-wide logits for many rows.

   Positions are absolute token positions in the prompt, and prompts start with <|endoftext|> (position 0), as in
   TransformerLens. Metrics: {kind:'logitdiff', a, b, pos} | {kind:'logprob', t, pos} | {kind:'prob', t, pos}. */

import { CFG, logSoftmax, topk, matmulQ } from './gpt2.js';

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

/* logits measured from their mean over the vocabulary (softmax ignores a shift shared by every token) */
function vocabCentred(lg) {
  let mu = 0;
  for (let i = 0; i < lg.length; i++) mu += lg[i];
  mu /= lg.length;
  const o = new Float32Array(lg.length);
  for (let i = 0; i < lg.length; i++) o[i] = lg[i] - mu;
  return o;
}

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

  /* What comes next: the top k tokens at the last position, the entropy, and any target tokens' standing.
     full: also return all 50,257 logits (200 KB), so a page can redo sampling dials and look-ups without the model. */
  async predict(env, { ids, k = 10, targets = [], full = false }) {
    const r = await env.forward({ ids, logits: 'last' });
    const lg = r.logits, lp = logSoftmax(lg), top = topk(lg, k);
    return {
      top, probs: top.map((i) => Math.exp(lp[i])), logits: top.map((i) => lg[i]), entropy: entropyOf(lp),
      targets: targets.map((t) => ({ id: t, prob: Math.exp(lp[t]), logit: lg[t], rank: rankOf(lg, t) })),
      all: full ? Float32Array.from(lg) : null,
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
        let sb = 0, sp = 0, ss = 0, se = 0, n = 0, nb = 0;
        for (let t = 1; t < T; t++) {
          const row = (h * T + t) * T;
          if (t >= 2) { sb += A[row]; nb++; }      // at t = 1 the first token is also the previous one
          sp += A[row + t - 1]; ss += A[row + t];
          for (let s = 0; s <= t; s++) { const a = A[row + s]; if (a > 1e-9) se -= a * Math.log(a); }
          n++;
        }
        const q = l * H + h;
        bos[q] = nb ? sb / nb : 0; prev[q] = n ? sp / n : 0; self[q] = n ? ss / n : 0; ent[q] = n ? se / n : 0;
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
    const lg = r.logits, lp = logSoftmax(lg);
    const actual = lg[a] - (b === null || b === undefined ? 0 : lg[b]);
    const probs = [Math.exp(lp[a]), b === null || b === undefined ? null : Math.exp(lp[b])];
    const ranks = [rankOf(lg, a), b === null || b === undefined ? null : rankOf(lg, b)];
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
      pos: p, embed, posEmbed: posE, constant: konst, heads, attnBias, mlp, sum, actual, inv, probs, ranks,
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

  /* Which neurons fire on this text: every neuron's activation at every position (36,864 x T), and ln_2's scale (the
     σ it divides the stream by) at every layer and position, which turns a direct push into pre-activation units. */
  async fires(env, { ids }) {
    const T = ids.length;
    const r = await env.forward({ ids, capture: { mlp_post: true, resid_mid: true }, logits: 'none' });
    const acts = new Float32Array(L * T * M), sigma = new Float32Array(L * T);
    for (let l = 0; l < L; l++) {
      acts.set(r.cap.mlp_post[l], l * T * M);
      const X = r.cap.resid_mid[l];
      for (let t = 0; t < T; t++) {
        let mu = 0, v = 0;
        for (let i = 0; i < D; i++) mu += X[t * D + i];
        mu /= D;
        for (let i = 0; i < D; i++) v += (X[t * D + i] - mu) ** 2;
        sigma[l * T + t] = Math.sqrt(v / D + 1e-5);
      }
    }
    const mx = new Float32Array(L * M).fill(-1), arg = new Int16Array(L * M);
    for (let l = 0; l < L; l++) for (let t = 1; t < T; t++) {
      const off = l * T * M + t * M;
      for (let n = 0; n < M; n++) if (acts[off + n] > mx[l * M + n]) { mx[l * M + n] = acts[off + n]; arg[l * M + n] = t; }
    }
    return { T, acts, max: mx, argmax: arg, sigma };
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
    const lg = vocabCentred(await env.unembedRows(X, 1));
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
     Rows: the attended token, columns: the predicted token.

     What the head reads at a token is not the raw embedding: every later layer sees the stream after block 0, whose
     MLP does much of the embedding's work in GPT-2 (the IOI paper and ARENA use this "extended embedding"). So by
     default each token is run as [<|endoftext|>, token] and its stream after block 0 is the input; embed: 'raw' uses
     the token embedding alone, to show the difference. The head's output is read through ln_f's gain and the
     unembedding (its scale is unknown out of context, so values compare within a row). mat is column-centred:
     each predicted token's average over the rows is removed, so a column's baseline does not hide the pattern.
     For every row the whole vocabulary is scored too: the attended token's own rank among all 50,257 tokens and the
     top k tokens the head raises. */
  async ovCircuit(env, { layer, head, tokens, embed = 'block0', k = 8 }) {
    const cpu = env.cpu, Ly = cpu.W.layers[layer], n = tokens.length;
    const q = Ly.qkv, o = Ly.o, gF = cpu.W.lnfg;
    const E = new Float32Array(n * D);
    if (embed === 'raw') tokens.forEach((t, j) => cpu.embedRow(t, E, j * D));
    else {
      const r = await env.forward({ ids: tokens.map((t) => [50256, t]), capture: { resid_post: [0] }, logits: 'none' });
      const X = r.cap.resid_post[0];
      for (let j = 0; j < n; j++) E.set(X.subarray((j * 2 + 1) * D, (j * 2 + 2) * D), j * D);
    }
    const outs = new Float32Array(n * D);
    const x = new Float32Array(D), v = new Float32Array(dh);
    for (let j = 0; j < n; j++) {
      lnRow(E, j * D, Ly.ln1g, Ly.ln1b, x, 0);
      for (let d = 0; d < dh; d++) {
        const row = 2 * D + head * dh + d;           // V rows of the fused qkv matrix
        let s = 0;
        for (let i = 0; i < D; i++) s += x[i] * q.q[row * D + i] * q.s[row * q.NG + (i >> 6)];
        v[d] = s + q.b[row];
      }
      for (let i = 0; i < D; i++) {
        let s = 0;
        for (let d = 0; d < dh; d++) s += v[d] * o.q[i * D + head * dh + d];
        outs[j * D + i] = s * o.s[i * o.NG + head];   // a head's 64 inputs are exactly one quant group
      }
    }
    // through ln_f: its centring, its gain, and a typical scale (1/sigma for a stream of the median norm after layer
    // 11), so values read roughly as logits if the head put all of its attention on that one token
    const scale = Math.sqrt(D) / (cpu.residNorm[L - 1] || 100);
    const X = new Float32Array(n * D);
    for (let j = 0; j < n; j++) {
      const c = centred(outs.subarray(j * D, (j + 1) * D));
      for (let i = 0; i < D; i++) X[j * D + i] = c[i] * gF[i] * scale;
    }
    const lgAll = await env.unembedRows(X, n);
    const raw = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let c = 0; c < n; c++) raw[j * n + c] = lgAll[j * V + tokens[c]];
    const mat = new Float32Array(n * n);
    for (let c = 0; c < n; c++) {
      let mu = 0;
      for (let j = 0; j < n; j++) mu += raw[j * n + c];
      mu /= n;
      for (let j = 0; j < n; j++) mat[j * n + c] = raw[j * n + c] - mu;
    }
    const selfRank = new Int32Array(n), top = [];
    for (let j = 0; j < n; j++) {
      const lg = lgAll.subarray(j * V, (j + 1) * V);
      selfRank[j] = rankOf(lg, tokens[j]);
      top.push(topk(lg, k).map((t) => [t, lg[t]]));
    }
    return { n, mat, raw, selfRank, top, embed, scale };
  },

  /* What a list of neurons write, read straight through the unembedding (weights only, the direct path). neurons are
     global ids, layer * 3072 + index. Values are logits per unit of activation for a final stream of median norm
     (ln_f's real scale depends on the context), so they compare across neurons, and are measured from the average
     over the vocabulary: adding the same amount to every logit changes no probability, and some neurons lower
     every token by about the same large amount. */
  async neuronLens(env, { neurons, k = 6 }) {
    const cpu = env.cpu, n = neurons.length, gF = cpu.W.lnfg, X = new Float32Array(n * D);
    const scale = Math.sqrt(D) / (cpu.residNorm[L - 1] || 100);
    neurons.forEach((g, j) => {
      const c = centred(cpu.wout(Math.floor(g / M), g % M));
      for (let i = 0; i < D; i++) X[j * D + i] = c[i] * gF[i] * scale;
    });
    const lg = await env.unembedRows(X, n);
    const lens = [];
    for (let j = 0; j < n; j++) {
      const row = vocabCentred(lg.subarray(j * V, (j + 1) * V));
      lens.push({ up: topk(row, k).map((t) => [t, row[t]]), down: topk(row, k, -1).map((t) => [t, row[t]]) });
    }
    return { lens, scale };
  },

  /* Which neurons one neuron is wired to through the residual stream: the direct path, weights only, ignoring
     everything attention and the other neurons do in between. Neuron B in layer j reads neuron A in an earlier layer
     through ln_2: S = centre(w_out,A) · (γ_j ⊙ w_in,B) is how far B's pre-activation moves per unit of A's activation,
     before ln_2 divides by the stream's σ. Lists rank partners by how unusual the alignment of the two directions is:
     the cosine, z-scored against every other candidate in the same layer, as neuron-explorer z-scores |S|; using
     the cosine keeps a few loud neurons (long write vectors) from topping every list. Given acts, the activations of
     every neuron in the layers before this one at one token, also says which of them pushed it there: act_A × S / σ,
     with sigma the ln_2 scale at that token (or a typical one), in units of B's pre-activation. */
  async neuronLinks(env, { layer, neuron, k = 8, acts = null, sigma = null }) {
    const cpu = env.cpu, N = linkNorms(cpu);
    const take = (rows) => {
      rows.sort((p, q) => q[1] - p[1]);
      return rows.slice(0, k);
    };
    /* feeds: later neurons B that read this one's write direction */
    const dA = centred(cpu.wout(layer, neuron));
    const nA = N.wCn[layer][neuron], feeds = [];
    const x = new Float32Array(D), S = new Float32Array(M);
    for (let j = layer + 1; j < L; j++) {
      const g = cpu.W.layers[j].ln2g;
      for (let i = 0; i < D; i++) x[i] = dA[i] * g[i];
      matmulQ(x, 1, cpu.W.layers[j].fc, S, true);
      const cos = new Float32Array(M);
      for (let b = 0; b < M; b++) cos[b] = S[b] / (nA * N.rCn[j][b]);
      const z = zAbs(cos);
      const best = topk(z, k);
      for (const b of best) feeds.push([j * M + b, z[b], cos[b], S[b]]);
    }
    /* fed by: earlier neurons A whose write direction this one reads */
    const F = cpu.W.layers[layer].fc, g = cpu.W.layers[layer].ln2g, u = new Float32Array(D);
    let su = 0;
    for (let i = 0; i < D; i++) { u[i] = F.q[neuron * D + i] * F.s[neuron * F.NG + (i >> 6)] * g[i]; su += u[i]; }
    const nB = N.rCn[layer][neuron], fedBy = [], pushed = [];
    let total = 0;
    for (let i = 0; i < layer; i++) {
      const Z = writeDots(cpu.W.layers[i].proj, u);
      for (let a = 0; a < M; a++) Z[a] -= N.wMean[i][a] * su;
      const cos = new Float32Array(M);
      for (let a = 0; a < M; a++) cos[a] = Z[a] / (N.wCn[i][a] * nB);
      const z = zAbs(cos);
      for (const a of topk(z, k)) fedBy.push([i * M + a, z[a], cos[a], Z[a]]);
      if (acts) {
        const s = 1 / (sigma || 1);
        for (let a = 0; a < M; a++) {
          const c = acts[i * M + a] * Z[a] * s;
          total += c;
          if (Math.abs(c) > 1e-4) pushed.push([i * M + a, Math.abs(c), c]);
        }
      }
    }
    return { feeds: take(feeds), fedBy: take(fedBy), pushed: acts ? take(pushed).map(([gid, , c]) => [gid, c]) : null, pushedTotal: total };
  },

  /* What pushing one neuron does to the next-token prediction, with random pushes of the same size as the control:
     neuron-explorer's steer lens, live on one prompt. Adds dose x (the layer's median residual norm) along the
     neuron's write direction at every position, runs the rest of the model, and compares the last position's
     log-probabilities with the unpushed run. Each control writes a random unit direction into the same place
     (the layer's MLP output) at the same size. Tokens are ranked by the change in log-probability, among tokens
     with at least floor probability on the side that matters (after the push for rises, before it for falls), so
     a one-in-a-billion token becoming one-in-a-hundred-million does not top the list. KL is in nats. */
  async neuronPush(env, { ids, layer, neuron, dose = 0.8, controls = 4, seed = 11, k = 10, floor = 1e-4 }) {
    const R = 2 + controls, rn = env.cpu.residNorm[layer], rand = rngFrom(seed + 7919 * layer + neuron);
    const iv = [{ hook: 'mlp_post', layer, neuron, op: 'addr', rows: [1], value: dose }];
    for (let c = 0; c < controls; c++) {
      const vec = randomUnit(rand);
      for (let i = 0; i < D; i++) vec[i] *= rn;
      iv.push({ hook: 'mlp_out', layer, op: 'add', rows: [2 + c], vec, value: dose });
    }
    const res = await env.forward({ ids: Array.from({ length: R }, () => ids), iv, logits: 'last' });
    const lp = [];
    for (let r = 0; r < R; r++) lp.push(logSoftmax(res.logits.subarray(r * V, (r + 1) * V)));
    const kl = (r) => { let s = 0; for (let i = 0; i < V; i++) { const p = Math.exp(lp[r][i]); if (p > 1e-12) s += p * (lp[r][i] - lp[0][i]); } return s; };
    const lf = Math.log(floor);
    const rise = new Float32Array(V), fall = new Float32Array(V);
    for (let i = 0; i < V; i++) {
      const d = lp[1][i] - lp[0][i];
      rise[i] = lp[1][i] >= lf ? d : -Infinity;
      fall[i] = lp[0][i] >= lf ? d : Infinity;
    }
    const row = (t) => [t, lp[1][t] - lp[0][t], Math.exp(lp[0][t]), Math.exp(lp[1][t])];
    return {
      up: topk(rise, k).filter((t) => rise[t] > 0).map(row),
      down: topk(fall, k, -1).filter((t) => fall[t] < 0).map(row),
      before: topk(lp[0], 5).map((t) => [t, Math.exp(lp[0][t])]),
      after: topk(lp[1], 5).map((t) => [t, Math.exp(lp[1][t])]),
      kl: kl(1), klCtrl: [...Array(controls).keys()].map((c) => kl(2 + c)), unit: rn, dose,
    };
  },

  /* Every one of the 36,864 neurons ranked by how much it writes one token directly: neuronLens for a single token,
     (W_U[t] − mean over the vocabulary) · (γ_f ⊙ centre(w_out)) at the same scale, so the values match the neuron
     card's "What it writes". Weights only; a few hundredths of a second per layer. */
  async lensSearch(env, { token, k = 40 }) {
    const cpu = env.cpu, gF = cpu.W.lnfg, scale = Math.sqrt(D) / (cpu.residNorm[L - 1] || 100), N = linkNorms(cpu);
    const mu = meanEmbed(cpu), e = cpu.embedRow(token, new Float32Array(D)), u = new Float32Array(D);
    let su = 0;
    for (let i = 0; i < D; i++) { u[i] = (e[i] - mu[i]) * gF[i] * scale; su += u[i]; }
    const val = new Float32Array(L * M);
    for (let l = 0; l < L; l++) {
      await checkpoint(env);
      const Z = writeDots(cpu.W.layers[l].proj, u);
      for (let n = 0; n < M; n++) val[l * M + n] = Z[n] - N.wMean[l][n] * su;
    }
    return { up: topk(val, k).map((g) => [g, val[g]]), down: topk(val, k, -1).map((g) => [g, val[g]]) };
  },

  /* A sparse autoencoder's features on a text: the dictionary loaded by the host (saeLoad) reads the residual
     stream entering its layer at every token, f = ReLU(W_enc (x − b_dec) + b_enc), with x centred first when the
     SAE was trained that way. Returns each token's k strongest features, how many were on (L0), how far the
     rebuilt stream x̂ = W_dec f + b_dec misses each token's (|x − x̂|² / |x|²), the explained variance over the whole
     text (1 − Σ|x − x̂|² / Σ|x − x̄|², the measure the precompute reports for its corpus), and the features strongest
     anywhere in the text. */
  async saeEncode(env, { ids, k = 6, top = 40 }) {
    const S = env.sae;
    if (!S) throw new Error('The dictionary is not loaded yet');
    const T = ids.length, F = S.F, G = S.G, NG = D / G;
    const r = await env.forward({ ids, capture: { resid_pre: [S.layer] }, logits: 'none' });
    const X = r.cap.resid_pre[S.layer];
    const topF = new Int32Array(T * k).fill(-1), topV = new Float32Array(T * k), l0 = new Int16Array(T), miss = new Float32Array(T);
    const XC = new Float32Array(T * D), ERR = new Float32Array(T);
    const fmax = new Float32Array(F), farg = new Int16Array(F), xx = new Float32Array(D), f = new Float32Array(F);
    for (let t = 1; t < T; t++) {
      if (t % 4 === 1) { await checkpoint(env); if (env.ctx.progress) env.ctx.progress({ done: t, total: T - 1 }); }
      let mu = 0;
      for (let i = 0; i < D; i++) mu += X[t * D + i];
      mu = S.centred ? mu / D : 0;
      for (let i = 0; i < D; i++) xx[i] = X[t * D + i] - mu - (S.subDec ? S.bDec[i] : 0);
      let on = 0;
      for (let j = 0; j < F; j++) {
        const qo = j * D, so = j * NG;
        let y = 0;
        for (let g = 0; g < NG; g++) {
          let a = 0;
          for (let i = g * G, e = i + G; i < e; i++) a += S.encQ[qo + i] * xx[i];
          y += a * S.encS[so + g];
        }
        y += S.bEnc[j];
        f[j] = y > 0 ? y : 0;
        if (y > 0) { on++; if (y > fmax[j]) { fmax[j] = y; farg[j] = t; } }
      }
      l0[t] = on;
      const best = topk(f, k);
      best.forEach((j, q) => { if (f[j] > 0) { topF[t * k + q] = j; topV[t * k + q] = f[j]; } });
      /* reconstruction from the active features: x̂ = Σ f_j d_j + b_dec, against the input it was given */
      const rec = new Float32Array(D);
      for (let j = 0; j < F; j++) {
        if (!(f[j] > 0)) continue;
        const qo = j * D, so = j * NG, a = f[j];
        for (let i = 0; i < D; i++) rec[i] += a * S.decQ[qo + i] * S.decS[so + (i >> 6)];
      }
      let num = 0, den = 0;
      for (let i = 0; i < D; i++) {
        const x = X[t * D + i] - mu, d = x - (rec[i] + S.bDec[i]);
        XC[t * D + i] = x; num += d * d; den += x * x;
      }
      ERR[t] = num;
      miss[t] = num / Math.max(1e-9, den);
    }
    const xbar = new Float32Array(D);
    for (let t = 1; t < T; t++) for (let i = 0; i < D; i++) xbar[i] += XC[t * D + i] / (T - 1);
    let sErr = 0, sVar = 0;
    for (let t = 1; t < T; t++) { sErr += ERR[t]; for (let i = 0; i < D; i++) sVar += (XC[t * D + i] - xbar[i]) ** 2; }
    const strongest = topk(fmax, top).filter((j) => fmax[j] > 0).map((j) => [j, fmax[j], farg[j]]);
    return { T, k, topF, topV, l0, miss, ev: T > 2 ? 1 - sErr / Math.max(1e-9, sVar) : NaN, strongest };
  },

  /* One feature's activation at every token of a text (the same encoder as saeEncode, one row of it). */
  async saeTrace(env, { ids, feature }) {
    const S = env.sae;
    if (!S) throw new Error('The dictionary is not loaded yet');
    const T = ids.length, G = S.G, NG = D / G, j = feature;
    const r = await env.forward({ ids, capture: { resid_pre: [S.layer] }, logits: 'none' });
    const X = r.cap.resid_pre[S.layer], out = new Float32Array(T);
    for (let t = 1; t < T; t++) {
      let mu = 0;
      for (let i = 0; i < D; i++) mu += X[t * D + i];
      mu = S.centred ? mu / D : 0;
      let y = 0;
      for (let g = 0; g < NG; g++) {
        let a = 0;
        for (let i = g * G, e = i + G; i < e; i++) a += S.encQ[j * D + i] * (X[t * D + i] - mu - (S.subDec ? S.bDec[i] : 0));
        y += a * S.encS[j * NG + g];
      }
      y += S.bEnc[j];
      out[t] = y > 0 ? y : 0;
    }
    return { acts: out };
  },

  /* One feature's decoder direction: what it adds to the stream per unit of activation (dequantised). */
  async saeRow(env, { feature }) {
    const S = env.sae;
    if (!S) throw new Error('The dictionary is not loaded yet');
    const NG = D / S.G, dec = new Float32Array(D);
    for (let i = 0; i < D; i++) dec[i] = S.decQ[feature * D + i] * S.decS[feature * NG + Math.floor(i / S.G)];
    return { dec };
  },

  /* The features whose decoder directions point most nearly the same way as one feature's (cosine over all of the
     dictionary): near-duplicates that share out one concept are the signature of feature splitting. */
  async saeNeighbors(env, { feature, k = 8 }) {
    const S = env.sae;
    if (!S) throw new Error('The dictionary is not loaded yet');
    const F = S.F, G = S.G, NG = D / G;
    if (!S.decNorm) {
      S.decNorm = new Float32Array(F);
      for (let j = 0; j < F; j++) {
        let s = 0;
        for (let i = 0; i < D; i++) { const v = S.decQ[j * D + i] * S.decS[j * NG + Math.floor(i / G)]; s += v * v; }
        S.decNorm[j] = Math.sqrt(s) || 1;
      }
    }
    const q = new Float32Array(D);
    for (let i = 0; i < D; i++) q[i] = S.decQ[feature * D + i] * S.decS[feature * NG + Math.floor(i / G)];
    const cos = new Float32Array(F);
    for (let j = 0; j < F; j++) {
      if (j % 4096 === 0) await checkpoint(env);
      let y = 0;
      for (let g = 0; g < NG; g++) {
        let a = 0;
        for (let i = g * G, e = i + G; i < e; i++) a += S.decQ[j * D + i] * q[i];
        y += a * S.decS[j * NG + g];
      }
      cos[j] = y / (S.decNorm[j] * S.decNorm[feature]);
    }
    cos[feature] = -2;
    return { near: topk(cos, k).map((j) => [j, cos[j]]) };
  },
};

/* A layer's SAE from the precompute's int8 file (lab/data/sae/L{ll}/sae.bin, its layout in info.json), in the form
   the sae recipes read: int8 rows with float32 group scales. The host loads it into env.sae; lab/checks does too. */
export function saeFrom(info, buffer, layer) {
  const lay = info.sae_bin, T = { int8: Int8Array, float16: Uint16Array, float32: Float32Array };
  const view = (k) => new T[lay[k].dtype](buffer, lay[k].offset, lay[k].shape.reduce((a, b) => a * b, 1));
  const half = (h) => {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
    return e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15);
  };
  const f32 = (u) => Float32Array.from(u, half);
  return {
    layer, F: info.d_sae, G: info.group || 64, encQ: view('enc_q'), encS: f32(view('enc_s')), bEnc: view('b_enc'),
    decQ: view('dec_q'), decS: f32(view('dec_s')), bDec: view('b_dec'),
    centred: !!info.centred_input, subDec: info.apply_b_dec_to_input !== false,
  };
}

/* the average token embedding (the unembedding is tied to it), for logits measured from the vocabulary's mean */
function meanEmbed(cpu) {
  if (cpu.meanEmbed) return cpu.meanEmbed;
  const mu = new Float64Array(D), row = new Float32Array(D);
  for (let v = 0; v < V; v++) { cpu.embedRow(v, row); for (let i = 0; i < D; i++) mu[i] += row[i]; }
  cpu.meanEmbed = Float32Array.from(mu, (x) => x / V);
  return cpu.meanEmbed;
}

/* Per layer, once: each neuron's mean write coordinate and centred write length, and the centred length of what each
   neuron reads (γ ⊙ w_in), for neuronLinks' cosines. About a tenth of a second on a slow processor. */
function linkNorms(cpu) {
  if (cpu.linkNorms) return cpu.linkNorms;
  const wMean = [], wCn = [], rCn = [];
  for (let l = 0; l < L; l++) {
    const P = cpu.W.layers[l].proj, mean = new Float32Array(M);
    for (let d = 0; d < D; d++) {
      const qo = d * M, so = d * P.NG;
      for (let a = 0; a < M; a++) mean[a] += P.q[qo + a] * P.s[so + (a >> 6)];
    }
    const cn = new Float32Array(M);
    for (let a = 0; a < M; a++) { mean[a] /= D; cn[a] = Math.sqrt(Math.max(1e-12, cpu.woutNorm[l][a] ** 2 - D * mean[a] ** 2)); }
    const F = cpu.W.layers[l].fc, g = cpu.W.layers[l].ln2g, rn = new Float32Array(M);
    for (let b = 0; b < M; b++) {
      let s = 0, s2 = 0;
      for (let i = 0; i < D; i++) { const v = F.q[b * D + i] * F.s[b * F.NG + (i >> 6)] * g[i]; s += v; s2 += v * v; }
      rn[b] = Math.sqrt(Math.max(1e-12, s2 - s * s / D));
    }
    wMean.push(mean); wCn.push(cn); rCn.push(rn);
  }
  cpu.linkNorms = { wMean, wCn, rCn };
  return cpu.linkNorms;
}

/* u · w_out for every neuron of one layer's MLP output matrix (stored [768 out, 3072 neurons]) */
function writeDots(P, u) {
  const Z = new Float32Array(M);
  for (let d = 0; d < D; d++) {
    const qo = d * M, so = d * P.NG, ud = u[d];
    for (let a = 0; a < M; a++) Z[a] += ud * P.q[qo + a] * P.s[so + (a >> 6)];
  }
  return Z;
}

/* |x| z-scored over its own entries */
function zAbs(x) {
  const n = x.length;
  let mu = 0, s2 = 0;
  for (let i = 0; i < n; i++) mu += Math.abs(x[i]);
  mu /= n;
  for (let i = 0; i < n; i++) s2 += (Math.abs(x[i]) - mu) ** 2;
  const sd = Math.sqrt(s2 / n) + 1e-8, z = new Float32Array(n);
  for (let i = 0; i < n; i++) z[i] = (Math.abs(x[i]) - mu) / sd;
  return z;
}

/* a random direction of length 1, uniform on the sphere (Gaussian coordinates, normalised) */
export function randomUnit(rand, n = D) {
  const v = new Float32Array(n);
  let s = 0;
  for (let i = 0; i < n; i += 2) {
    const u = Math.max(1e-12, rand()), w = rand(), r = Math.sqrt(-2 * Math.log(u));
    v[i] = r * Math.cos(2 * Math.PI * w);
    if (i + 1 < n) v[i + 1] = r * Math.sin(2 * Math.PI * w);
  }
  for (let i = 0; i < n; i++) s += v[i] * v[i];
  s = Math.sqrt(s);
  for (let i = 0; i < n; i++) v[i] /= s;
  return v;
}
