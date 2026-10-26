/* lab/ui/tools/kit.js: the parts every tool page shares: the header with its weeks and concept links, the three
   reading tiers, the model card, form fields, preset chips, and a run button with progress and cancel. */

import { h, mount, tiers, rescan, hashFor, tokText } from '../dom.js';
import { progress } from '../charts.js';
import { needModel, engine } from '../engine.js';
import { nodeIndex } from './index.js';

/* teach = {what: {1,2,3}, read: {...}, why: {...}}; returns the slots a tool fills */
export function toolPage(el, meta, teach) {
  const links = h('div.links');
  const head = h('div.tool-head', null,
    h('div', null,
      h('h1', null, meta.name),
      h('div.row', null, ...(meta.weeks || []).map((w) => h('a.week', { href: `#missions/week-${w}`, title: `TARA week ${w} missions` }, 'W' + w)),
        meta.cost ? h('span.muted.small', null, '· ' + meta.cost) : null)),
    links);
  const model = h('div');
  const controls = h('div.panel');
  const result = h('div.result', { 'aria-live': 'polite' });
  const read = teach.read ? tiers(`read-${meta.id}`, teach.read) : null;
  const why = teach.why ? h('details.more', null, h('summary', null, 'Why this matters, and where else the pattern shows up'),
    tiers(`why-${meta.id}`, teach.why)) : null;
  mount(el,
    head,
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
    const bar = progress(slot);
    bar.set(0, 'Starting…');
    ctl = {
      cancelled: false, ids: [],
      track(pr) { if (pr && pr.id) this.ids.push(pr.id); return pr; },
      cancel() { this.cancelled = true; for (const id of this.ids) engine.lab.cancel(id); },
    };
    current.add(ctl);
    let err = null;
    try {
      await run((done, total, text) => bar.set(total ? done / total : 0, text || (total ? `${done} of ${total}` : '')), ctl);
    } catch (e) {
      if (!/cancelled/.test(String(e && e.message))) { err = e; console.error(e); }
    } finally {
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

/* every tool awaits the model through this, so the download card shows in the tool's own model slot */
export async function model(slot) { await needModel(slot); return engine; }

/* Run fn once the model is ready, unless the reader has left the tool by then (life.dead, set by destroy). Tools never
   await the model inside mount(), so the page finishes routing while the download card waits for a click. */
export function whenReady(page, life, fn) {
  model(page.model).then(() => { if (!life.dead) return fn(); }).catch((e) => { if (!life.dead) errorBox(page.result, e); });
}

/* a link to another tool with its inputs filled in */
export function toolLink(id, params, text) { return h('a', { href: hashFor('tool', [id], params) }, text); }

export const LAYERS = [...Array(12).keys()].map((l) => [l, 'layer ' + l]);
export const HEADS = [...Array(12).keys()].map((x) => [x, 'head ' + x]);

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
  get(k) { return MEMO.get(k); },
  set(k, v) { if (MEMO.size > 40) MEMO.delete(MEMO.keys().next().value); MEMO.set(k, v); },
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

export { rescan };
