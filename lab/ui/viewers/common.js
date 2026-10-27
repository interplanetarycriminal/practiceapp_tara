/* lab/ui/viewers/common.js: what every result page shares. Loading a pack and its arrays, the header, the claim
   ledger (a rubber stamp per claim, icon and label, never colour alone), the notes, and "How it was made" with the
   exact spec, commit and versions, so a reader can rerun any result. */

import { h, fmt, tiers, tokText } from '../dom.js';

const REPO = 'https://github.com/interplanetarycriminal/practiceapp_tara';

export const KINDS = {
  steer: { name: 'Steering', short: 'steering',
    asks: 'Does pushing along one direction change a behaviour, how much per unit of push, and what does it break?',
    control: 'the same pushes along random directions of the same size, and loss on neutral text' },
  probe: { name: 'Probe', short: 'probe',
    asks: 'Is a property written in a straight line inside the model, and from which layer?',
    control: 'the same probe trained and scored on shuffled labels (a permutation test), probes on the words alone and on what they mean, with no context, and random directions' },
  features: { name: 'Features', short: 'features',
    asks: 'What does one dictionary feature respond to, and what does it make the model say?',
    control: 'how well the dictionary reconstructs this model at all' },
  diff: { name: 'Model diff', short: 'model diff',
    asks: 'What did post-training (or a fine-tune) change inside the model, and where?',
    control: 'random vectors of the same size as the measured shift, scored on prompts the shift was not made from' },
  circuit: { name: 'Circuit', short: 'circuit',
    asks: 'Which dictionary features carry a behaviour, and how do they feed each other?',
    control: 'patching the top features for real on pairs they were not ranked on, against random active features' },
  graph: { name: 'Attribution graph', short: 'graph',
    asks: 'Which transcoder features, at which positions, push the model toward its next token?',
    control: 'the graph\'s own error nodes; any claim needs an intervention to back it' },
};

export const kindOf = (k) => KINDS[k] || { name: k || 'Result', short: k || 'result', asks: '', control: '' };

/* ---------------------------------------------------------------- loading */

export async function loadPack(id) {
  const base = `findings/packs/${encodeURIComponent(id)}/`;
  let r;
  try { r = await fetch(base + 'pack.json', { cache: 'no-cache' }); } catch (e) { return null; }
  if (!r.ok) return null;
  const p = await r.json();
  p.base = base;
  return p;
}

/* One of the pack's arrays as {data, shape, at(i, j...), row(i)}; null when the pack has no such array. */
export async function arr(p, name) {
  const a = p.arrays && p.arrays[name];
  if (!a) return null;
  const buf = await (await fetch(p.base + a.file)).arrayBuffer();
  const data = {
    f32: () => new Float32Array(buf), f16: () => f16(new Uint16Array(buf)), i32: () => new Int32Array(buf),
    i16: () => new Int16Array(buf), u16: () => new Uint16Array(buf), u8: () => new Uint8Array(buf), i8: () => new Int8Array(buf),
  }[a.dtype]();
  const shape = a.shape || [data.length];
  const strides = shape.map((_, i) => shape.slice(i + 1).reduce((x, y) => x * y, 1));
  return {
    data, shape,
    at: (...ix) => data[ix.reduce((o, v, i) => o + v * strides[i], 0)],
    row: (i) => data.subarray(i * strides[0], (i + 1) * strides[0]),
  };
}

/* IEEE half floats, as numpy writes them */
function f16(u) {
  const out = new Float32Array(u.length);
  for (let i = 0; i < u.length; i++) {
    const x = u[i], sg = x & 0x8000 ? -1 : 1, e = (x >> 10) & 31, m = x & 1023;
    out[i] = e === 0 ? sg * m * 2 ** -24 : e === 31 ? (m ? NaN : sg * Infinity) : sg * (1 + m / 1024) * 2 ** (e - 15);
  }
  return out;
}

/* a graph file inside the pack (circuit and graph kinds) */
export async function json(p, file) {
  const r = await fetch(p.base + file);
  if (!r.ok) throw new Error(`${file} is missing from this result`);
  return r.json();
}

/* ---------------------------------------------------------------- pieces */

export function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(+d)) return iso;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function modelName(m) {
  return m.id + (m.precision ? ` (${m.precision})` : '');
}

export function header(p) {
  const k = kindOf(p.kind);
  const models = (p.models || []).map(modelName).join(' versus ');
  const pv = p.provenance || {};
  return h('header.res-head', null,
    h('div.row', null, h('a.small.muted', { href: '#results' }, '← All results'), h('span.pill', null, k.name)),
    h('h1', null, p.title || p.id),
    h('p.lede', null, p.question),
    p.summary && p.summary.headline ? h('div.headline', null, p.summary.headline) : null,
    h('div.res-meta', null,
      models ? h('span', null, models) : null,
      p.dictionary && p.dictionary.repo ? h('span', null, 'dictionary ' + shortRepo(p.dictionary.repo) + (p.dictionary.layer !== undefined ? `, layer ${p.dictionary.layer}` : '')) : null,
      p.created ? h('span', null, when(p.created)) : null,
      pv.runtime_s ? h('span', null, `${pv.runtime_s < 120 ? Math.round(pv.runtime_s) + ' s' : Math.round(pv.runtime_s / 60) + ' min'} on ${pv.gpu ? pv.gpu.replace(/^NVIDIA /, '') : 'a processor'}`) : null));
}

function shortRepo(r) { return String(r).replace(/^.*[\\/](?=[^\\/]+[\\/][^\\/]+$)/, ''); }

const STAMP = { supported: ['✓', 'Supported'], weak: ['~', 'Weak'], 'not-supported': ['✗', 'Not supported'] };

export function stamp(status, extra = '') {
  const s = STAMP[status] || ['?', status];
  return h('span.stamp.' + (STAMP[status] ? status : 'weak'), { title: STAMP_MEANING[status] || '' }, `${s[0]} ${s[1]}${extra}`);
}

const STAMP_MEANING = {
  supported: 'beats its control: the fake version of the experiment that should not work',
  weak: 'points the right way but does not clear its control',
  'not-supported': 'fails its test',
};

export function ledger(p) {
  const claims = p.claims || [];
  return h('section', null,
    h('h2', null, 'What was found'),
    claims.length ? h('div.ledger', null, claims.map((c) => h('div.claim', null,
      stamp(c.status),
      h('div.claim-text', null, c.text),
      c.test ? h('div.claim-test', null, 'Test it had to pass: ' + c.test) : null,
      c.evidence ? h('details.evidence', null, h('summary', null, 'The numbers behind it'), evidence(c.evidence)) : null)))
      : h('p.muted', null, 'This result makes no claims.'),
    notes(p.notes),
    h('details.more', null, h('summary', null, 'What the stamps mean'), tiers('stamps-' + p.kind, {
      1: `<p>Every claim had to beat a <b>control</b>: a fake version of the same experiment that should not work. <b>Supported</b>
means it beat the control. <b>Weak</b> means it points the right way but did not beat the control clearly. <b>Not supported</b>
means it failed. A page with a weak claim on it is more trustworthy, not less: it shows the test had teeth.</p>`,
      2: `<p>Each claim states its test. <b>Supported</b>: the 95% interval clears the control (by a margin the test names).
<b>Weak</b>: the estimate points the right way but the interval overlaps the control. <b>Not supported</b>: it fails. The
control for this kind of result: ${kindOf(p.kind).control}.</p>`,
      3: `<p>Intervals are 95%. A mean over prompts or pairs gets a Student t interval: a percentile bootstrap of eight
prompts covers the truth only about 88% of the time, and of one prompt it gives no width at all. A share of a gap (how much
of it a patch or a vector closes) is a ratio of means, with a bootstrap that resamples whole items and the seed in the
spec. A probe's held-out accuracy gets the exact binomial interval (a bootstrap of a perfect score collapses to 100% to
100%). Whatever a test picks (a probe's layer, a circuit's top features, a shift vector's layer and dose) is picked on
items the test then leaves out, so the score is not the best of many tries. Controls are matched to the intervention
(same norm, same layer, same number of features). Thresholds are fixed in the bench before any run, so a claim cannot be
stamped after looking. Multiple comparisons are not corrected for; treat a single supported claim among many as a lead,
not a finding.</p>`,
    })));
}

function evidence(ev) {
  const rows = [];
  for (const [k, v] of Object.entries(ev)) {
    let s;
    if (Array.isArray(v)) s = v.map((x) => (typeof x === 'number' ? fmt(x, 3) : JSON.stringify(x))).join(', ');
    else if (v && typeof v === 'object') s = Object.entries(v).map(([a, b]) => `${a} ${typeof b === 'number' ? fmt(b, 3) : b}`).join(', ');
    else s = typeof v === 'number' ? fmt(v, 3) : String(v);
    rows.push(h('dt', null, k.replace(/_/g, ' ')), h('dd', null, s));
  }
  return h('dl.kv', null, rows);
}

export function notes(list) {
  if (!list || !list.length) return null;
  return h('div.callout.notes', null, h('b.k', null, 'Read this before believing the claims'), list.map((n) => h('p', null, n)));
}

export function howMade(p) {
  const pv = p.provenance || {};
  const kv = [];
  const add = (k, v) => { if (v !== undefined && v !== null && v !== '') kv.push(h('dt', null, k), h('dd', null, v)); };
  add('Spec', h('a', { href: `${REPO}/blob/main/lab/bench/specs/${encodeURIComponent(p.id.replace(/-smoke$/, ''))}.json` }, `lab/bench/specs/${p.id.replace(/-smoke$/, '')}.json`));
  add('Spec hash', pv.spec_hash ? h('code', null, pv.spec_hash) : null);
  add('Bench commit', pv.commit ? h('span', null, h('a', { href: `${REPO}/commit/${pv.commit}` }, h('code', null, pv.commit.slice(0, 7))),
    pv.bench_dirty ? ' (with uncommitted changes, so not exactly reproducible)' : '') : null);
  add('Seed', pv.seed);
  for (const m of p.models || []) {
    add('Model', h('span', null, m.hf && m.hf !== 'local' ? h('a', { href: `https://huggingface.co/${m.hf}` }, m.hf) : m.id,
      m.revision ? ` at ${String(m.revision).slice(0, 10)}` : '', m.precision ? `, ${m.precision}` : '',
      m.layers ? `, ${m.layers} layers, width ${m.d_model}` : '', m.load_note ? `; ${m.load_note}` : ''));
  }
  if (p.dictionary) add('Dictionary', [p.dictionary.kind, p.dictionary.repo, p.dictionary.revision && `at ${String(p.dictionary.revision).slice(0, 10)}`,
    p.dictionary.width && `width ${p.dictionary.width}`, p.dictionary.k && `k ${p.dictionary.k}`].filter(Boolean).join(', '));
  add('Ran on', [pv.gpu || 'a processor', pv.cuda && `CUDA ${pv.cuda}`].filter(Boolean).join(', '));
  add('Libraries', [pv.python && `Python ${pv.python}`, pv.torch && `torch ${pv.torch}`, pv.transformers && `transformers ${pv.transformers}`,
    pv.circuit_tracer && `circuit-tracer ${pv.circuit_tracer}`].filter(Boolean).join(', '));
  add('Finished', pv.finished ? new Date(pv.finished).toUTCString() : null);
  add('Took', pv.runtime_s ? `${fmt(pv.runtime_s, 1)} s` : null);
  return h('details.more.howmade', null,
    h('summary', null, 'How it was made: spec, commit and settings'),
    h('dl.kv', null, kv),
    h('p.small', null, 'To rerun it from the bench folder: ', h('code', null, `python run.py specs/${p.id.replace(/-smoke$/, '')}.json`),
      '. The same seed, spec and commit should give the same claims.'),
    p.spec ? h('pre.spec', null, JSON.stringify(p.spec, null, 2)) : null);
}

/* a section with a heading, an optional three-tier "how to read it", and a body slot */
export function section(title, teachId, teach) {
  const body = h('div');
  const el = h('section.res-sec', null, h('h2', null, title), teach ? tiers(teachId, teach) : null, body);
  return { el, body };
}

/* a token list with values, for logit-lens reads of a direction */
export function lensLists(up, down, { upName = 'Pushes up', downName = 'Pushes down', fmtv = (v) => fmt(v, 2) } = {}) {
  const list = (items, sign) => h('div.toklist', { 'data-tara-noglossary': true }, (items || []).map(([t, v]) =>
    h('span', { title: fmtv(v) }, tokText(t))));
  return h('div.lens-cols', null,
    h('div', null, h('div.small-caps', null, '↑ ' + upName), list(up, 1)),
    h('div', null, h('div.small-caps', null, '↓ ' + downName), list(down, -1)));
}

/* a corpus spec in words: 'builtin:<name>', {hf: name}, or {parquet | jsonl | txt: path} */
export function corpusName(src) {
  if (!src) return 'a reference corpus';
  if (typeof src === 'string') return src.startsWith('builtin:') ? `the bench's built-in ${src.slice(8)} texts` : src;
  if (src.hf) return src.hf;
  const p = src.parquet || src.jsonl || src.txt;
  if (!p) return 'a reference corpus';
  const base = String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return /^(owt|openwebtext)$/i.test(base) ? 'OpenWebText' : base;
}

/* the two halves of a probe's labelled set, named */
export function classNames(p) {
  const d = p.data || {};
  if (Array.isArray(d.classes) && d.classes.length === 2) return d.classes;
  if (p.spec && Array.isArray(p.spec.classes)) return p.spec.classes;
  const ds = p.spec && p.spec.dataset;
  return { 'builtin:cities': ['false statement', 'true statement'], 'builtin:formal_casual': ['casual', 'formal'],
    'builtin:eval_deploy': ['real request', 'test prompt'], 'builtin:eval_deploy_implicit': ['real request', 'test prompt'] }[ds]
    || ['label 0', 'label 1'];
}
