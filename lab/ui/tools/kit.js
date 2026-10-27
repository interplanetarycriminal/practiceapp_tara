/* lab/ui/tools/kit.js: the parts every tool page shares: the header with its weeks and concept links, the three
   reading tiers, the model card, form fields, preset chips, and a run button with progress and cancel. */

import { h, mount, tiers, rescan, hashFor, tokText } from '../dom.js';
import { progress } from '../charts.js';
import { needModel, engine, CFG, waitLine, trackModel, isGPU } from '../engine.js';
import { nodeIndex } from './index.js';

export { CFG };

/* teach = {what: {1,2,3}, read: {...}, why: {...}, qwen: html}; returns the slots a tool fills. The teaching copy is
   written about GPT-2; on another model, teach.qwen says at the top what is different there. */
export function toolPage(el, meta, teach) {
  const links = h('div.links');
  const other = CFG.where !== 'browser';
  const cost = other ? meta.costLive || 'seconds on the 3090' : meta.cost;
  const head = h('div.tool-head', null,
    h('div', null,
      h('h1', null, meta.name),
      h('div.row', null, ...(meta.weeks || []).map((w) => h('a.week', { href: `#missions/week-${w}`, title: `TARA week ${w} missions` }, 'W' + w)),
        cost ? h('span.muted.small', null, '· ' + cost) : null,
        other ? h('span.pill.model-pill', { title: `The tools are running on ${CFG.name}, ${CFG.place}. Change it in the header.` }, CFG.name) : null)),
    links);
  const note = other && teach.qwen ? h('div.callout.model-note', null, h('b.k', null, `On ${CFG.name}`), h('div', { html: teach.qwen })) : null;
  const model = h('div');
  const controls = h('div.panel');
  const result = h('div.result', { 'aria-live': 'polite' });
  const read = teach.read ? tiers(`read-${meta.id}`, teach.read) : null;
  const why = teach.why ? h('details.more', null, h('summary', null, 'Why this matters, and where else the pattern shows up'),
    tiers(`why-${meta.id}`, teach.why)) : null;
  mount(el,
    head,
    note,
    teach.what ? tiers(`what-${meta.id}`, teach.what) : null,
    model, controls, result,
    read ? h('div.card.flat', { style: { marginTop: '14px' } }, h('div.small-caps', null, 'How to read it'), read) : null,
    why);
  conceptLinks(links, meta.nodes || []);
  rescan(el);
  return { head, model, controls, result, read };
}

export async function conceptLinks(el, ids) {
  const N = await nodeIndex();
  const out = [];
  for (const id of ids) {
    const n = N[id];
    if (!n) continue;
    out.push(h('a', { href: `../index.html#map/node=${encodeURIComponent(id)}`, title: 'On the concept map' }, n.label));
  }
  const first = ids.map((id) => N[id]).find((n) => n && n.film && /films\//.test(n.film)) || N[ids[0]];
  if (first && first.film) out.push(h('a', { href: '../intuition/' + first.film }, '▶ film'));
  if (first && first.object) out.push(h('a', { href: '../objects/' + first.object }, '3D'));
  mount(el, ...out);
}

/* ---------------------------------------------------------------- fields */

export function field(label, input, hint) {
  return h('label.field', null, h('span', null, label), input, hint ? h('span.tokcount', null, hint) : null);
}

export function textArea(value, { rows = 2, oninput, placeholder } = {}) {
  return h('textarea', { rows, spellcheck: 'false', placeholder, oninput }, value);
}

export function textInput(value, { oninput, placeholder, size } = {}) {
  const i = h('input', { type: 'text', spellcheck: 'false', placeholder, oninput, size });
  i.value = value || '';
  return i;
}

export function select(options, value, onchange) {
  const s = h('select', { onchange: (e) => onchange && onchange(e.target.value) },
    options.map(([v, label]) => h('option', { value: v }, label)));
  s.value = String(value);
  return s;
}

export function slider({ min, max, step, value, oninput }) {
  const i = h('input', { type: 'range', min, max, step, oninput });
  i.value = String(value);
  return i;
}

export function presets(list, apply) {
  return h('div.chips', null, h('span.muted.small', { style: { alignSelf: 'center' } }, 'Try:'),
    list.map((p) => h('button.chip', { type: 'button', onclick: () => apply(p) }, p.label)));
}

/* ---------------------------------------------------------------- running */

/* runs in flight on this page, so leaving a tool can stop them */
const current = new Set();
export function cancelAll() { for (const c of current) c.cancel(); current.clear(); }

/* A run button wired to a slot that shows progress; run(onProgress, ctl) does the work and passes every engine call
   through ctl.track() so a second press (Stop) or leaving the page cancels it. */
export function runner(label, slot, run) {
  let busy = false, ctl = null;
  const btn = h('button.btn.primary', { type: 'button' }, label);
  const go = async () => {
    if (busy) { if (ctl) ctl.cancel(); return; }
    busy = true;
    btn.textContent = 'Stop';
    const bar = progress(slot), client = engine.lab;
    bar.set(0, 'Starting…');
    ctl = {
      cancelled: false, ids: [],
      track(pr) { if (pr && pr.id) this.ids.push(pr.id); return pr; },
      cancel() { this.cancelled = true; if (this.stopWaiting) this.stopWaiting(); for (const id of this.ids) client.cancel(id); },
    };
    current.add(ctl);
    let err = null, off = null;
    try {
      if (engine.remote) {
        /* the 3090: a request loads the model itself (after an idle release) and waits its turn on the card; the bar
           says so while it does */
        if (['offline', 'error', 'connecting'].includes(engine.status.state)) await engine.boot();
        let last = '';
        off = engine.on((s) => {
          if (s.state !== 'loading' && s.state !== 'waiting') { if (last) { bar.set(0, 'Running…'); last = ''; } return; }
          last = waitLine(s);
          bar.set(s.state === 'loading' && s.expect ? Math.min(0.97, (s.elapsed || 0) / s.expect) : 0, last);
        });
      } else if (!engine.ready()) await waitForModel(bar, ctl);
      await run((done, total, text) => bar.set(total ? done / total : 0, text || (total ? `${done} of ${total}` : '')), ctl);
    } catch (e) {
      if (!/cancelled/.test(String(e && e.message))) { err = e; console.error(e); }
    } finally {
      if (off) off();
      current.delete(ctl);
      bar.done();
      if (err) slot.appendChild(h('div.err', null, String(err.message || err)));
      busy = false;
      btn.textContent = label;
    }
  };
  btn.addEventListener('click', go);
  return { btn, go, get busy() { return busy; } };
}

/* A run pressed before GPT-2 is ready waits for it, showing why, and starts by itself once the model loads; Stop still
   works while it waits. */
function waitForModel(bar, ctl) {
  return new Promise((resolve, reject) => {
    let off = null, settled = false;
    const end = (fn, x) => { if (settled) return; settled = true; ctl.stopWaiting = null; if (off) off(); fn(x); };
    ctl.stopWaiting = () => end(reject, new Error('cancelled'));
    off = engine.on((s) => {
      if (s.state === 'ready') end(resolve);
      else if (s.state === 'error') end(reject, new Error(s.error || `${CFG.short} did not start`));
      else bar.set(s.total ? (s.loaded || 0) / s.total : 0, waitLine(s));
    });
    if (settled) off();
  });
}

/* every tool awaits the model through this, so the download card shows in the tool's own model slot */
export async function model(slot) { await needModel(slot); return engine; }

/* Run fn once the model is ready, unless the reader has left the tool by then (life.dead, set by destroy). Tools never
   await the model inside mount(), so the page finishes routing while the download card waits for a click. On the
   3090 the card comes back whenever the model is away (the server lets it go after 20 idle minutes). */
export function whenReady(page, life, fn) {
  model(page.model).then(() => { if (life.dead) return; trackModel(page.model); return fn(); })
    .catch((e) => { if (!life.dead) errorBox(page.result, e); });
}

/* a link to another tool with its inputs filled in */
export function toolLink(id, params, text) { return h('a', { href: hashFor('tool', [id], params) }, text); }

/* ---------------------------------------------------------------- the model's shape
   GPT-2 small: 12 layers of 12 attention heads. Qwen 3.5: 32 layers, every fourth one attention (16 heads) and the
   rest Gated DeltaNet (32 value heads), so head arrays from the recipes are L x H with H the most heads in any layer
   and NaN past a layer's own count. These read CFG when called, so a tool mounted after a switch gets the new model. */
const range = (n) => [...Array(n).keys()];
export const layerList = () => range(CFG.L);
export const layerOpts = (ls) => (ls || range(CFG.L)).map((l) => [l, 'layer ' + l]);
export const isAttn = (l) => CFG.kinds[l] === 'attention';
export const nHeads = (l) => CFG.heads[l] ?? CFG.H;
export const headOpts = (l) => range(nHeads(l)).map((x) => [x, 'head ' + x]);
export const hix = (l, x) => l * CFG.H + x;                         // a head's place in the L x H arrays
export const headList = (ls) => (ls || range(CFG.L)).flatMap((l) => range(nHeads(l)).map((x) => [l, x]));
export const headCount = () => CFG.heads.reduce((a, b) => a + b, 0);
export const neuronCount = () => CFG.L * CFG.M;
export const kindOf = (l) => (isAttn(l) ? 'attention' : 'Gated DeltaNet');
export const onGPT2 = () => CFG.id === 'gpt2';
/* a GPT-2 layer (from a preset) at the same depth in the chosen model */
export const scaleLayer = (l) => (CFG.L === 12 ? l : Math.round(l * (CFG.L - 1) / 11));
export const nearestAttn = (l) => CFG.attnLayers.reduce((b, x) => (Math.abs(x - l) < Math.abs(b - l) ? x : b), CFG.attnLayers[0]);
/* where the tools run, for "a few seconds ..." lines */
export const whereRun = () => (CFG.where !== 'browser' ? 'on the 3090' : isGPU() ? 'on this graphics card' : 'on a processor');
/* NaN-safe largest |value| and arg max of an array */
export function absMax(a, floor = 1e-9) { let m = floor; for (const v of a) if (Number.isFinite(v) && Math.abs(v) > m) m = Math.abs(v); return m; }
export function argBest(a, better = (u, v) => u > v) { let b = -1; for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && (b < 0 || better(a[i], a[b]))) b = i; return b; }

/* clamp a URL parameter to an integer range */
export function intParam(v, lo, hi, dflt) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}
export function numParam(v, lo, hi, dflt) {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}

/* expensive results kept for this visit, so coming back to a tool does not recompute them */
const MEMO = new Map();
export const memo = {
  get(k) { return MEMO.get(CFG.id + '|' + k); },
  set(k, v) { if (MEMO.size > 40) MEMO.delete(MEMO.keys().next().value); MEMO.set(CFG.id + '|' + k, v); },
};

/* "1st", "2nd", "92nd" */
export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n.toLocaleString('en') + (s[(v - 20) % 10] || s[v] || s[0]);
}

/* a token shown inline in running text, spaces visible */
export function tk(s) { return h('code.tok-inline', null, tokText(s)); }

/* tokens of a prompt, with a count shown under the field */
export async function tokensOf(text) { return engine.tok(text); }

export function errorBox(el, e) {
  mount(el, h('div.err', null, String(e && e.message || e)));
}

export function notice(text) { return h('div.note', null, text); }

/* a token's first id, and a visible warning when the word is several tokens (only the first one is scored) */
export async function answerToken(s, warnSlot) {
  const t = await engine.token(s);
  if (warnSlot) mount(warnSlot, t.n > 1 ? `"${s}" is ${t.n} tokens (${t.pieces.map((p) => JSON.stringify(p)).join(' + ')}); only the first is scored.` : '');
  return t;
}

/* the single-token forms of a word, in the order tried (the form typed first): " rain", "rain", " Rain", "Rain" */
export async function wordForms(w) {
  const b = w.replace(/^\s+/, ''), cap = b.charAt(0).toUpperCase() + b.slice(1), low = b.charAt(0).toLowerCase() + b.slice(1);
  const out = [];
  for (const c of [...new Set([' ' + b, b, ' ' + cap, cap, ' ' + low, low])]) {
    const t = await engine.token(c);
    if (t.whole && !out.some((x) => x.id === t.id)) out.push({ id: t.id, piece: t.piece });
  }
  return out;
}

export { rescan };
