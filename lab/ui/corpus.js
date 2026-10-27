/* lab/ui/corpus.js: the lab's corpus-wide data, written once by the GPU precompute (lab/precompute) into lab/data:
   every neuron's strongest and typical examples, its histogram and co-firing partners, the steer lens, the steering
   sweep with its random-direction controls, and ARENA's layer-7 SAE features. Formats are documented at the top of
   each precompute job. Files load when a view asks for them and stay cached for the visit. */

const BASE = new URL('../data/', import.meta.url);
const M = 3072;
const cache = new Map();

function once(key, fn) {
  if (!cache.has(key)) cache.set(key, fn().catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key);
}

async function bytes(path) {
  const res = await fetch(new URL(path, BASE));
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) return buf.buffer;            // not gzip (or the server already unpacked it)
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unpack the lab\'s data files; a newer browser can.');
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

/* float16 -> float32 */
const F16 = (() => {
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
    t[h] = e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15);
  }
  return t;
})();
export function half(u16) { const o = new Float32Array(u16.length); for (let i = 0; i < u16.length; i++) o[i] = F16[u16[i]]; return o; }

/* stats.json: the corpus, residual norms, and each finished job's settings. done(kind) says whether a job ran on a
   real corpus (the file ships with provisional norms from course prose before the precompute runs). */
export const info = () => once('stats', async () => (await fetch(new URL('stats.json', BASE))).json());
export async function done(kind) {
  try {
    const s = await info();
    return !!s[kind] && !(s.corpus && s.corpus.provisional);
  } catch (e) { return false; }
}

/* the corpus in words: {long: "25 million tokens of web text", short: "25M"} */
export function size(s) {
  const n = (s.neurons && s.neurons.tokens) || (s.corpus && s.corpus.tokens) || 0;
  const what = /OpenWebText/i.test((s.corpus && s.corpus.source) || '') ? 'web text' : 'text';
  return n >= 1e6 ? { long: `${Math.round(n / 1e6)} million tokens of ${what}`, short: `${Math.round(n / 1e6)}M` }
    : { long: `${Math.round(n / 1e3)} thousand tokens of ${what}`, short: `${Math.round(n / 1e3)}k` };
}

/* one block of examples: K examples of `win` tokens for each of `n` units (neurons or features) */
function examplesOf(buf, n, K, win) {
  let o = 0;
  const toks = new Uint16Array(buf, o, n * K * win); o += toks.byteLength;
  const act = new Uint8Array(buf, o, n * K * win); o += act.byteLength;
  const pk = new Uint8Array(buf, o, n * K); o += pk.byteLength;
  const val = half(new Uint16Array(buf.slice(o, o + n * K * 2)));
  return { n, K, win, toks, act, pk, val };
}

/* the examples of unit u of a block, as [{tokens, acts (0..1 of the unit's top value), peak, value, kind}] */
function unitExamples(B, u, kTop) {
  const out = [];
  for (let k = 0; k < B.K; k++) {
    const v = B.val[u * B.K + k];
    if (!(v > 0)) continue;
    const o = (u * B.K + k) * B.win;
    out.push({ tokens: Array.from(B.toks.subarray(o, o + B.win)), acts: Array.from(B.act.subarray(o, o + B.win), (x) => x / 255),
      peak: B.pk[u * B.K + k], value: v, kind: k < kTop ? 'top' : 'band' });
  }
  return out;
}

function statsOf(buf, n) {
  const f = new Float32Array(buf, 0, n * 4), hist = new Uint32Array(buf, n * 16, n * 17);
  return { f, hist };
}

const two = (l) => String(l).padStart(2, '0');

/* ---------------------------------------------------------------- neurons */

export async function neuron(l, n) {
  const s = await info(), cfg = s.neurons, chunk = cfg.chunk_neurons || 768, K = cfg.k_top + cfg.k_mid;
  const c = Math.floor(n / chunk);
  const [B, S, C] = await Promise.all([
    once(`nex${l}.${c}`, async () => examplesOf(await bytes(`neurons/L${two(l)}.ex${c}.bin.gz`), chunk, K, cfg.window)),
    once(`nst${l}`, async () => statsOf(await bytes(`neurons/L${two(l)}.stats.bin`), M)),
    once(`nco${l}`, async () => { const b = await bytes(`neurons/L${two(l)}.cofire.bin`); return { idx: new Uint16Array(b, 0, M * 16), cor: new Int16Array(b, M * 32, M * 16) }; }),
  ]);
  const f = S.f.subarray(n * 4, n * 4 + 4);
  return {
    max: f[0], mean: f[1], on: f[2], scale: f[3], hist: Array.from(S.hist.subarray(n * 17, n * 17 + 17)),
    examples: unitExamples(B, n % chunk, cfg.k_top),
    cofire: Array.from({ length: 16 }, (_, j) => [C.idx[n * 16 + j], C.cor[n * 16 + j] / 10000]).filter(([, r]) => r !== 0),
    tokens: s.neurons.tokens, band: cfg.band, cofireContexts: cfg.cofire_contexts,
  };
}

/* the steer lens of one layer: for each neuron and sign (0 pushed up, 1 down), the k tokens that rise most */
export async function steerLayer(l) {
  const s = await info();
  if (!s.steer) return null;
  return once(`steer${l}`, async () => {
    const b = await bytes(`steer/L${two(l)}.bin`), k = s.steer.k || 12, N = b.byteLength / (2 * k * 4 + 4);
    return { N, k, toks: new Uint16Array(b, 0, N * 2 * k), rise: half(new Uint16Array(b, N * 2 * k * 2, N * 2 * k)), kl: half(new Uint16Array(b, N * 2 * k * 4, N * 2)) };
  }).catch(() => null);
}

/* the steer lens of one neuron: {up: [[token, rise]], down: [...], kl: [up, down]}, or null when not computed */
export async function steer(l, n) {
  const s = await info(), L = await steerLayer(l);
  if (!L || n >= L.N) return null;
  const side = (sg) => Array.from({ length: L.k }, (_, j) => [L.toks[(n * 2 + sg) * L.k + j], L.rise[(n * 2 + sg) * L.k + j]]);
  return { up: side(0), down: side(1), kl: [L.kl[n * 2], L.kl[n * 2 + 1]], dose: s.steer.dose, prompts: s.steer.prompts };
}

/* the steering sweep of one layer: rollouts for its neurons, then its random-direction controls */
export async function sweepLayer(l) {
  const s = await info();
  if (!s.sweep) return null;
  return once(`sweep${l}`, async () => {
    const cfg = s.sweep, N = cfg.neurons, C = cfg.controls, R = cfg.design.length, T = cfg.new_tokens;
    const b = await bytes(`sweep/L${two(l)}.bin.gz`);
    return { N, C, R, T, design: cfg.design, prompts: cfg.prompts, toks: new Uint16Array(b, 0, (N + C) * R * T),
      lp: half(new Uint16Array(b.slice((N + C) * R * T * 2, (N + C) * R * T * 2 + (N + C) * R * 2))) };
  }).catch(() => null);
}
export const sweepBase = () => once('sweepbase', async () => (await fetch(new URL('sweep/base.json', BASE))).json());

/* rows of one unit (a neuron index, or N + j for control j): [{prompt, dose, tokens, lp}] */
export function rollouts(S, u) {
  return S.design.map(([p, d], r) => ({ prompt: p, dose: d, tokens: Array.from(S.toks.subarray((u * S.R + r) * S.T, (u * S.R + r + 1) * S.T)), lp: S.lp[u * S.R + r] }));
}

/* ---------------------------------------------------------------- SAE features */

export const saeInfo = (l) => once(`saeinfo${l}`, async () => {
  const r = await fetch(new URL(`sae/L${two(l)}/info.json`, BASE));
  if (!r.ok) throw new Error('no SAE for layer ' + l);
  return r.json();
});

export async function feature(l, f) {
  const I = await saeInfo(l), ex = I.examples, chunk = ex.chunk || 1024, K = ex.k_top + ex.k_mid, F = I.d_sae;
  const c = Math.floor(f / chunk), n = Math.min(chunk, F - c * chunk);
  const [B, S, Lz, mu] = await Promise.all([
    once(`fex${l}.${c}`, async () => examplesOf(await bytes(`sae/L${two(l)}/ex${two(c)}.bin.gz`), n, K, ex.window)),
    saeStats(l), saeLens(l), saeLensMean(l),
  ]);
  const st = S.f.subarray(f * 4, f * 4 + 4);
  return {
    max: st[0], mean: st[1], density: st[2], scale: st[3], hist: Array.from(S.hist.subarray(f * 17, f * 17 + 17)),
    examples: unitExamples(B, f % chunk, ex.k_top),
    up: Array.from({ length: 10 }, (_, j) => [Lz.t[f * 20 + j], Lz.v[f * 20 + j] / 100]),
    down: Array.from({ length: 10 }, (_, j) => [Lz.t[f * 20 + 10 + j], Lz.v[f * 20 + 10 + j] / 100]),
    shift: mu ? mu[f] : null, tokens: I.tokens, band: ex.band, neuronpedia: I.neuronpedia ? I.neuronpedia + f : null,
  };
}

/* per feature, the logit its decoder direction adds to the average word (lab/precompute/summarise.py), so the lens
   can be read relative to the average word like a neuron's; null when absent */
export const saeLensMean = (l) => once(`saemean${l}`, async () => { try { return new Float32Array(await bytes(`sae/L${two(l)}/lensmean.bin`)); } catch (e) { return null; } });

export const saeStats = (l) => once(`saest${l}`, async () => { const I = await saeInfo(l); return statsOf(await bytes(`sae/L${two(l)}/stats.bin`), I.d_sae); });
export const saeLens = (l) => once(`saelens${l}`, async () => {
  const I = await saeInfo(l), F = I.d_sae, b = await bytes(`sae/L${two(l)}/lens.bin`);
  return { t: new Uint16Array(b, 0, F * 20), v: new Int16Array(b, F * 40, F * 20) };
});

/* the peak tokens of each unit's three strongest corpus passages, a one-line "fires on" hint for lists (written
   from the example files by lab/precompute/summarise.py); null when absent */
export const neuronPeaks = () => once('npeaks', async () => { try { return new Uint16Array(await bytes('neurons/peaks.bin')); } catch (e) { return null; } });
export const saePeaks = (l) => once(`speaks${l}`, async () => { try { return new Uint16Array(await bytes(`sae/L${two(l)}/peaks.bin`)); } catch (e) { return null; } });

/* the int8 copy of a layer's SAE, for encoding text in the browser (the layout is in info.json) */
export const saeWeights = (l, onProgress) => once(`saebin${l}`, async () => {
  const I = await saeInfo(l), res = await fetch(new URL(`sae/L${two(l)}/sae.bin`, BASE));
  if (!res.ok) throw new Error('sae.bin: ' + res.status);
  const total = Number(res.headers.get('content-length')) || 0, parts = [];
  let got = 0;
  const rd = res.body.getReader();
  for (;;) {
    const { done: end, value } = await rd.read();
    if (end) break;
    parts.push(value); got += value.length;
    if (onProgress) onProgress(got, total);
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return { info: I, buf: buf.buffer };
});
