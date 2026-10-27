/* lab/ui/corpusviews.js: views of the GPU precompute's corpus-wide data (loaded by lab/ui/corpus.js), shared by the
   neuron explorer and the SAE features tool: strongest and typical-strength examples, the activation histogram,
   the steer lens, and the steering sweep against its random-direction controls. */

import { h, mount, fmt, tokText, pct } from './dom.js';
import { tokens as strip, bars, columns, tipRow } from './charts.js';
import { rollouts } from './corpus.js';

const piece = (names, t) => (t === 50256 ? '⟨end⟩' : names.get(t) ?? '?');

/* Examples as token strips coloured by activation, peak outlined. top: the unit's strongest value (the colour scale
   and the unit of the stored activations); onTry(example, text) puts a passage into the tool's text box. limit:
   [strongest, typical] shown before "Show all". */
export function examplesView(el, { examples, names, top, onTry, what = 'it', limit = [5, 3] }) {
  const block = (list) => h('div.examples', null, list.map((x) => {
    const row = h('div');
    strip(row, { pieces: x.tokens.map((t) => piece(names, t)), values: x.acts.map((a) => a * top), scale: 'seq', max: top, selected: x.peak,
      tip: (i) => [h('div.tip-head', null, tokText(piece(names, x.tokens[i]))),
        tipRow(fmt(x.acts[i] * top, 2), i === x.peak ? 'activation, this passage\'s peak' : 'activation')] });
    return h('div.ex-row', null, h('span.ex-v', { title: 'activation at the outlined token' }, fmt(x.value, 2)), row,
      onTry ? h('button.btn.small.ghost.ex-try', { type: 'button', title: 'Put this passage in the text box above and read it live',
        onclick: () => onTry(x, x.tokens.map((t) => piece(names, t)).join('')) }, 'Try it') : null);
  }));
  const strongest = examples.filter((x) => x.kind === 'top'), typical = examples.filter((x) => x.kind === 'band');
  const draw = (lim) => {
    const more = lim && (strongest.length > lim[0] || typical.length > lim[1]);
    mount(el,
      h('div.small-caps', null, `Where ${what} fires hardest`), block(lim ? strongest.slice(0, lim[0]) : strongest),
      typical.length ? [h('div.small-caps', { style: { marginTop: '10px' } }, 'At ordinary strength (a quarter to 60% of its strongest)'),
        block(lim ? typical.slice(0, lim[1]) : typical)] : null,
      more ? h('button.btn.small.ghost', { type: 'button', style: { marginTop: '6px' }, onclick: () => draw(null) },
        `Show all ${strongest.length} strongest and ${typical.length} ordinary`) : null,
      h('p.small.muted', null, 'Each passage is 24 tokens around the outlined token, cut from a longer context. "Try it" reads it live; with only these 24 tokens before it the value can come out a little different.'));
  };
  draw(limit);
}

/* hist: 17 counts (16 bins of 0 .. scale, then "off"); log scale, because most firing is weak */
export function histView(el, { hist, scale, what = 'it' }) {
  const total = hist.reduce((a, b) => a + b, 0) || 1, off = hist[16] / total, offText = off > 0.999 && off < 1 ? `all but ${pct(1 - off, 3)}` : pct(off, 1);
  const bins = hist.slice(0, 16).map((c, i) => {
    const lo = (i / 16) * scale, hi = ((i + 1) / 16) * scale, per = (c / total) * 1e6;
    return { value: per, label: i % 4 === 0 ? fmt(lo, 1) : '',
      tip: [h('div.tip-head', null, `${fmt(lo, 2)} to ${i === 15 ? fmt(hi, 2) + ' and above' : fmt(hi, 2)}`),
        tipRow(per >= 10 ? Math.round(per).toLocaleString('en') : fmt(per, 1), 'tokens per million'), tipRow(c.toLocaleString('en'), 'tokens in all')] };
  });
  columns(el, { bins, height: 150, x: { label: 'activation' }, y: { label: 'per million', log: true },
    caption: `Off (zero or below) on ${offText} of tokens. The bars share out the rest by strength, on a log scale: each gridline is ten times the one below, so the rare strong firings at the right still show.` });
  return { off };
}

/* steer: {up, down: [[token, rise]], kl: [up, down], dose} */
export function steerView(el, { steer, names, l }) {
  const side = (list) => {
    const box = h('div');
    const items = list.filter(([, v]) => v > 0).slice(0, 8).map(([t, v]) => ({ label: tokText(piece(names, t)), value: v }));
    if (items.length) bars(box, { items, fmtv: (v) => '+' + fmt(v, 2) });
    else box.appendChild(h('p.small.muted', null, 'Nothing rose.'));
    return box;
  };
  mount(el,
    h('div.res-cols', null,
      h('div', null, h('div.small-caps', null, `Pushed up (+${steer.dose}): likelier`), side(steer.up), h('div.small.muted', null, `moves the prediction ${fmt(steer.kl[0], 2)} nats (KL)`)),
      h('div', null, h('div.small-caps', null, `Pushed down (−${steer.dose}): likelier`), side(steer.down), h('div.small.muted', null, `moves the prediction ${fmt(steer.kl[1], 2)} nats (KL)`))),
    h('div.chart-cap', null, `Average rise in log-probability of the next token over four short prompts, when the stream after layer ${l} is pushed along this neuron's write direction by ${steer.dose} × its typical size, with every later layer reacting. "What it writes" above is the direct path only; where the two lists agree, the later layers pass the push on.`));
}

/* ---------------------------------------------------------------- the steering sweep */

/* per layer, once: for every token, how many of the control rollouts contain it, and how often a control changes
   the start of the text */
const CTRL = new WeakMap();
function controlStats(S, base) {
  if (CTRL.has(S)) return CTRL.get(S);
  const count = new Map();
  let changed = 0;
  for (let c = 0; c < S.C; c++) {
    rollouts(S, S.N + c).forEach((r) => {
      for (const t of new Set(r.tokens)) count.set(t, (count.get(t) || 0) + 1);
      if (differs(r, base)) changed++;
    });
  }
  const st = { count, rows: S.C * S.R, changed: changed / S.C };
  CTRL.set(S, st);
  return st;
}

/* does a rollout leave its prompt's unpushed continuation within the first 8 tokens? */
function differs(r, base, n = 8) {
  const b = base[r.prompt] && base[r.prompt].tokens;
  if (!b) return false;
  for (let i = 0; i < n; i++) if (r.tokens[i] !== b[i]) return true;
  return false;
}

/* tokens over-represented in one unit's rollouts against the controls: a binomial z-score on the number of rollouts
   that contain the token, with the control rate floored at half a rollout so a token no control wrote is not
   infinitely surprising */
export function themeWords(S, base, u, k = 8) {
  const ctrl = controlStats(S, base), rows = rollouts(S, u), R = rows.length, have = new Map();
  for (const r of rows) for (const t of new Set(r.tokens)) have.set(t, (have.get(t) || 0) + 1);
  const out = [];
  for (const [t, n] of have) {
    if (n < 2) continue;
    const p = Math.max(0.5 / ctrl.rows, (ctrl.count.get(t) || 0) / ctrl.rows), z = (n - R * p) / Math.sqrt(R * p * (1 - p));
    if (z > 3) out.push({ t, n, p, z });
  }
  out.sort((a, b) => b.z - a.z);
  return { words: out.slice(0, k), changed: rows.filter((r) => differs(r, base)).length, ctrlChanged: ctrl.changed, R };
}

/* every neuron of a layer scored for a set of tokens: the z-score of how many of its rollouts contain one of them,
   against the layer's controls (the same floor as themeWords) */
export function sweepScores(S, toks) {
  const want = new Set(toks), hit = (u) => rollouts(S, u).filter((r) => r.tokens.some((t) => want.has(t))).length;
  let c = 0;
  for (let j = 0; j < S.C; j++) c += hit(S.N + j);
  const p = Math.max(0.5 / (S.C * S.R), c / (S.C * S.R)), sd = Math.sqrt(S.R * p * (1 - p)), z = new Float32Array(S.N), n = new Uint8Array(S.N);
  for (let u = 0; u < S.N; u++) { n[u] = hit(u); z[u] = (n[u] - S.R * p) / sd; }
  return { z, n, p };
}

/* the ten rollouts of one unit beside the unpushed continuations; the part that matches the unpushed text is muted */
export function sweepView(el, { S, base, u, names, unitLabel }) {
  const rows = rollouts(S, u), th = themeWords(S, base, u);
  const line = (r, label) => {
    const b = base[r.prompt] ? base[r.prompt].tokens : [];
    let same = 0;
    while (same < r.tokens.length && r.tokens[same] === b[same]) same++;
    const text = (a, z) => r.tokens.slice(a, z).map((t) => piece(names, t)).join('');
    return h('div.sweep-row', null, h('span.sweep-d', null, label),
      h('div.gen', null, same ? h('span.prompt', { title: 'the same as with no push' }, text(0, same)) : null, text(same)));
  };
  const groups = [];
  for (const p of Object.keys(S.prompts)) {
    const mine = rows.filter((r) => r.prompt === p);
    if (!mine.length) continue;
    const b = base[p];
    groups.push(h('div.sweep-group', null,
      h('div.gen-h', null, p === 'free' ? 'From nothing (just ⟨bos⟩), pushed hard' : ['"', S.prompts[p].trim(), '…"']),
      b ? h('div.sweep-row', null, h('span.sweep-d', null, 'no push'), h('div.gen', null, b.text)) : null,
      mine.map((r) => line(r, (r.dose > 0 ? '+' : '−') + Math.abs(r.dose)))));
  }
  const words = th.words.length
    ? h('div.chips', { style: { marginTop: '6px' } }, th.words.map((w) => h('span.chip.static', { title: `in ${w.n} of ${th.R} rollouts; random pushes: ${pct(w.p, 1)} of theirs (z = ${fmt(w.z, 1)})` },
      h('code.tok-inline', null, tokText(piece(names, w.t))), ` ${w.n}/${th.R}`)))
    : h('p.small.muted', null, 'No word turns up in its rollouts much more often than in the random pushes\', so it has no clear theme at these doses.');
  // at the sweep's doses a random push often changes every rollout too, and then the count says nothing
  const all = S.C * th.R, tot = Math.round(th.ctrlChanged * S.C), n = (x) => x.toLocaleString('en');
  const ctrl = `${tot >= all ? 'every one' : n(tot)} of the ${n(all)} rollouts of ${S.C} random directions`;
  const lead = th.ctrlChanged >= 0.9 * th.R
    ? `At these doses any push changes the text, random ones included (${ctrl}), so the test is which words pushing ${unitLabel} brings in.`
    : `Pushing ${unitLabel} changes the start of the text in ${th.changed} of its ${th.R} rollouts; random directions pushed just as hard change ${fmt(th.ctrlChanged, 1)} on average (${S.C} of them).`;
  mount(el,
    h('p.small', null, lead),
    h('div.small-caps', null, 'Words it makes GPT-2 write, beyond what random pushes do'), words,
    h('div.sweep', null, groups),
    h('p.small.muted', null, `Greedy continuations of ${S.T} tokens, with the push added after its layer at every position, in units of the stream's typical size there. Muted text is the same as with no push. The design and the random-direction controls (${S.C} per layer) follow Lyra's neuron-explorer.`));
  return th;
}
