/* lab/core/probes.js: the statistics behind the lab's linear probe tool, kept free of the page so a script can run
   them too (lab/checks/missions.mjs). The method follows the bench's probe engine (lab/bench/tarabench/engines/probe.py),
   scaled down to a few dozen sentences: k-fold instead of one split, and the logistic probe fitted in its dual. */

export const FOLDS = 5, SHUFFLES = 5, LAMBDA = 0.05;
const D = 768, L = 12;

/* X: n x L x D residual vectors, y: 0/1 labels. Per layer: cross-validated logistic and difference-of-means accuracy,
   the same logistic probe on null labels, which sentences it got right, and a PCA of the layer.
   paired (both lists the same length): sentence i and sentence i + n/2 are a matched pair, held out together so the
   probe is never tested on a sentence whose twin it trained on, and the null swaps the two labels within random
   pairs, which keeps every training fold balanced. Unpaired: stratified folds, and the null permutes all labels and
   re-stratifies on them, the same procedure on labels that mean nothing. */
export function probeAll(X, y, n, paired = false) {
  const k = Math.min(FOLDS, count(y, 1), count(y, 0)), P = n / 2;
  const folds = paired ? pairFolds(P, k, 13) : stratified(y, k, 13);
  let s = 99;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const nulls = Array.from({ length: SHUFFLES }, (_, q) => {
    if (!paired) { const yp = shuffle(y.slice(), rand); return { y: yp, folds: stratified(yp, k, 17 + q) }; }
    const yp = y.slice();
    for (let i = 0; i < P; i++) if (rand() < 0.5) { yp[i] = 0; yp[i + P] = 1; }
    return { y: yp, folds };
  });
  const layers = [];
  for (let l = 0; l < L; l++) {
    const rows = Array.from({ length: n }, (_, i) => X.subarray((i * L + l) * D, (i * L + l + 1) * D));
    const right = new Array(n).fill(false);
    let dmRight = 0;
    for (const te of folds) {
      const tr = trainOf(te, n);
      const { Ktr, Kte } = kernels(rows, tr, te);
      const a = klr(Ktr, tr.map((i) => y[i]), LAMBDA);
      te.forEach((i, j) => { right[i] = (dotRow(Kte, j, tr.length, a) > 0) === (y[i] === 1); });
      dmRight += diffMeans(rows, y, tr, te);
    }
    const sh = nulls.map((nl) => {
      let ok = 0;
      for (const te of nl.folds) {
        const tr = trainOf(te, n), { Ktr, Kte } = kernels(rows, tr, te);
        const ap = klr(Ktr, tr.map((i) => nl.y[i]), LAMBDA);
        te.forEach((i, j) => { if ((dotRow(Kte, j, tr.length, ap) > 0) === (nl.y[i] === 1)) ok++; });
      }
      return ok / n;
    });
    layers.push({ acc: right.filter(Boolean).length / n, dm: dmRight / n, right,
      shufMean: sh.reduce((u, v) => u + v, 0) / sh.length, shufMin: Math.min(...sh), shufMax: Math.max(...sh), pca: pca2(rows) });
  }
  let best = 0;
  layers.forEach((x, l) => { if (x.acc > layers[best].acc + 1e-9 || (Math.abs(x.acc - layers[best].acc) < 1e-9 && x.dm > layers[best].dm + 1e-9)) best = l; });
  return { n, layers, best };
}

/* standardise on the training rows, then K = z.z / D + 1 (the +1 is the bias) */
function kernels(rows, tr, te) {
  const mu = new Float64Array(D), sd = new Float64Array(D);
  for (const i of tr) for (let d = 0; d < D; d++) mu[d] += rows[i][d];
  for (let d = 0; d < D; d++) mu[d] /= tr.length;
  for (const i of tr) for (let d = 0; d < D; d++) sd[d] += (rows[i][d] - mu[d]) ** 2;
  for (let d = 0; d < D; d++) sd[d] = Math.max(1e-3, Math.sqrt(sd[d] / tr.length));
  const z = (i) => { const o = new Float64Array(D); for (let d = 0; d < D; d++) o[d] = (rows[i][d] - mu[d]) / sd[d]; return o; };
  const Ztr = tr.map(z), Zte = te.map(z), m = tr.length;
  const dot = (u, v) => { let s = 0; for (let d = 0; d < D; d++) s += u[d] * v[d]; return s / D + 1; };
  const Ktr = new Float64Array(m * m), Kte = new Float64Array(te.length * m);
  for (let i = 0; i < m; i++) for (let j = i; j < m; j++) Ktr[i * m + j] = Ktr[j * m + i] = dot(Ztr[i], Ztr[j]);
  for (let i = 0; i < te.length; i++) for (let j = 0; j < m; j++) Kte[i * m + j] = dot(Zte[i], Ztr[j]);
  return { Ktr, Kte };
}

/* L2-regularised logistic regression in its dual: minimise mean log-loss(K a) + lam/2 a'Ka by Newton's method,
   step (W K / n + lam I) da = -((p - y) / n + lam a), halved until the objective falls */
export function klr(K, y, lam, iters = 30) {
  const n = y.length, a = new Float64Array(n);
  const obj = (al) => {
    let s = 0, q = 0;
    for (let i = 0; i < n; i++) {
      let f = 0;
      for (let j = 0; j < n; j++) f += K[i * n + j] * al[j];
      s += (f > 0 ? f + Math.log1p(Math.exp(-f)) : Math.log1p(Math.exp(f))) - y[i] * f;
      q += al[i] * f;
    }
    return s / n + lam / 2 * q;
  };
  let J = obj(a);
  for (let it = 0; it < iters; it++) {
    const f = new Float64Array(n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) f[i] += K[i * n + j] * a[j];
    const A = new Float64Array(n * n), r = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = 1 / (1 + Math.exp(-f[i])), w = p * (1 - p);
      for (let j = 0; j < n; j++) A[i * n + j] = w * K[i * n + j] / n + (i === j ? lam : 0);
      r[i] = -((p - y[i]) / n + lam * a[i]);
    }
    const da = solve(A, r, n);
    let t = 1, next = null, Jn = Infinity;
    for (let k = 0; k < 20; k++) {
      next = a.map((v, i) => v + t * da[i]);
      Jn = obj(next);
      if (Jn <= J) break;
      t /= 2;
    }
    if (!(Jn <= J)) break;
    let mx = 0;
    for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(next[i] - a[i]));
    a.set(next);
    const done = J - Jn < 1e-10 || mx < 1e-8;
    J = Jn;
    if (done) break;
  }
  return a;
}

function dotRow(K, j, m, a) { let s = 0; for (let i = 0; i < m; i++) s += K[j * m + i] * a[i]; return s; }

/* Gaussian elimination with partial pivoting */
function solve(A, b, n) {
  const M = A.slice(), x = b.slice();
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
    if (p !== c) { for (let k = 0; k < n; k++) { const t = M[c * n + k]; M[c * n + k] = M[p * n + k]; M[p * n + k] = t; } const t = x[c]; x[c] = x[p]; x[p] = t; }
    const d = M[c * n + c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = M[r * n + c] / d;
      if (!f) continue;
      for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
      x[r] -= f * x[c];
    }
  }
  for (let c = n - 1; c >= 0; c--) {
    let s = x[c];
    for (let k = c + 1; k < n; k++) s -= M[c * n + k] * x[k];
    x[c] = s / (M[c * n + c] || 1e-12);
  }
  return x;
}

/* difference of class means on the raw vectors, threshold halfway; returns how many held-out rows it gets right */
function diffMeans(rows, y, tr, te) {
  const m1 = new Float64Array(D), m0 = new Float64Array(D);
  let n1 = 0, n0 = 0;
  for (const i of tr) { const m = y[i] ? m1 : m0; for (let d = 0; d < D; d++) m[d] += rows[i][d]; if (y[i]) n1++; else n0++; }
  const dir = new Float64Array(D);
  let p1 = 0, p0 = 0;
  for (let d = 0; d < D; d++) { m1[d] /= n1; m0[d] /= n0; dir[d] = m1[d] - m0[d]; }
  for (let d = 0; d < D; d++) { p1 += m1[d] * dir[d]; p0 += m0[d] * dir[d]; }
  const thr = (p1 + p0) / 2;
  let ok = 0;
  for (const i of te) { let s = 0; for (let d = 0; d < D; d++) s += rows[i][d] * dir[d]; if ((s > thr) === (y[i] === 1)) ok++; }
  return ok;
}

/* the two directions of greatest spread, through the n x n Gram matrix (power iteration with deflation) */
function pca2(rows) {
  const n = rows.length, mu = new Float64Array(D);
  for (const r of rows) for (let d = 0; d < D; d++) mu[d] += r[d] / n;
  const G = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = i; j < n; j++) {
    let s = 0;
    for (let d = 0; d < D; d++) s += (rows[i][d] - mu[d]) * (rows[j][d] - mu[d]);
    G[i * n + j] = G[j * n + i] = s;
  }
  let tr = 0;
  for (let i = 0; i < n; i++) tr += G[i * n + i];
  const vecs = [], vals = [];
  for (let k = 0; k < 2; k++) {
    let v = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 1.7 + k + 1));
    let lam = 0;
    for (let it = 0; it < 300; it++) {
      const w = new Float64Array(n);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) w[i] += G[i * n + j] * v[j];
      for (const [u, lu] of vecs.map((u, q) => [u, vals[q]])) { let c = 0; for (let i = 0; i < n; i++) c += u[i] * v[i]; for (let i = 0; i < n; i++) w[i] -= lu * c * u[i]; }
      let nn = 0;
      for (let i = 0; i < n; i++) nn += w[i] * w[i];
      nn = Math.sqrt(nn) || 1;
      lam = nn;
      v = w.map((x) => x / nn);
    }
    vecs.push(v); vals.push(lam);
  }
  return { coords: [...Array(n).keys()].map((i) => [vecs[0][i] * Math.sqrt(vals[0]), vecs[1][i] * Math.sqrt(vals[1])]), ratio: vals.map((v) => (tr ? v / tr : 0)) };
}

/* folds that keep the two labels in proportion */
function stratified(y, k, seed) {
  let s = seed;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const folds = Array.from({ length: k }, () => []);
  let c = 0;
  for (const lab of [1, 0]) for (const i of shuffle(y.map((v, i) => (v === lab ? i : -1)).filter((i) => i >= 0), rand)) folds[c++ % k].push(i);
  return folds;
}

/* folds of whole pairs: pair p is sentences p and p + P */
function pairFolds(P, k, seed) {
  let s = seed;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const folds = Array.from({ length: k }, () => []);
  shuffle([...Array(P).keys()], rand).forEach((p, c) => folds[c % k].push(p, p + P));
  return folds;
}

function trainOf(te, n) { const out = new Set(te); return [...Array(n).keys()].filter((i) => !out.has(i)); }

function shuffle(a, rand) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function count(y, v) { return y.filter((x) => x === v).length; }

/* Wilson 95% interval for a proportion */
export function wilson(p, n) {
  const z = 1.96, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, w = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - w), Math.min(1, c + w)];
}
