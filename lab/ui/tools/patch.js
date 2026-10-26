/* lab/ui/tools/patch.js: activation patching (ARENA 1.4.1). Run a corrupted prompt, paste in one piece of the clean
   run (one layer at one position, or one head), and measure how much of the clean answer comes back. Or the reverse
   (noising): paste one piece of the corrupted run into the clean one and measure what breaks. */

import { h, mount as put, fmt, tokText, debounce } from '../dom.js';
import { toolPage, field, textArea, textInput, select, presets, runner, whenReady, memo, toolLink, tk } from './kit.js';
import { engine, isGPU } from '../engine.js';
import { grid, stat, tipRow } from '../charts.js';

const TEACH = {
  what: {
    1: `<p>Take two prompts that differ in one detail: "…John gave a drink to" (answer: Mary) and "…Mary gave a drink to"
(answer: John). Run the second, but at one place inside the model paste in what the first prompt had there. If the
model's answer flips back to Mary, that one place was carrying the information that decides the answer.</p>
<p>Do it at every layer and every word, and you get a map of where the decisive information lives, and how it moves.</p>`,
    2: `<p>Activation patching is a controlled experiment on the network's internals: <b>clean</b> and <b>corrupted</b>
prompts differ minimally, and you swap one activation between the runs. <b>Denoising</b> (corrupted run, one clean
activation pasted in) asks "is this enough to restore the behaviour?"; <b>noising</b> (clean run, one corrupted
activation pasted in) asks "is this necessary?". Scores are normalised: 1 means this single swap carries the whole
difference, 0 means it carries none.</p>
<div data-angle="analogy"><p>Two nearly identical relay races, one won and one lost. Swap one runner at one leg from
the winning team into the losing team: if the losing team now wins, that leg carried the race.</p></div>`,
    3: `<p>Score = (m(patched) − m(corrupt)) / (m(clean) − m(corrupt)) for denoising, and (m(clean) − m(patched)) / (m(clean) −
m(corrupt)) for noising, with m the logit difference. Patching resid_pre at (layer, position) traces information flow
through the stream; patching a head's hook_z (all positions) localises components. The two directions answer
different questions (sufficiency versus necessity) and can disagree when components are redundant (Heimersheim and
Nanda, 2024). Corruptions should stay on-distribution: a name swap is clean; Gaussian noise on embeddings is not
(Zhang and Nanda, 2023). Path patching restricts the swap to one path between components.</p>`,
  },
  read: {
    1: `<p>Bright cells are the places that carry the answer. On the stream map, rows are layers (layer 0 at the top) and
columns are your tokens; watch the bright cell move from the word that differs to the last word as you go down the
layers. That move is attention heads carrying the information across.</p>`,
    2: `<p>Blue: the swap moves the answer towards the clean one (1 = all the way). Red: it moves it the other way. Columns
for tokens that differ between the prompts are labelled "clean/corrupted". Both prompts must have exactly the same
number of tokens, so that position p means the same slot in both.</p>`,
    3: `<p>The metric is computed at the last position. Positions before the first difference are identical in both runs,
so their columns are zero by construction (a free sanity check). Head patching swaps a head's output at every
position at once.</p>`,
  },
  why: {
    1: `<p>This is the workhorse of causal interpretability: it turns "this looks important" into "this is where the
decision is carried", with a measurement.</p>`,
    2: `<p>The IOI circuit was mapped this way, and so are most circuit papers since. The same paired-prompt design runs
through evals (week 7: minimal pairs that differ in one feature) and through the bench's circuit results, which
patch dictionary features instead of layers.</p>`,
    3: `<p>Scaling it up: attribution patching (a first-order approximation computed with one backward pass), path
patching, and feature-level patching over SAE latents (Marks et al., 2024). Report the corruption, the metric and the
direction; results are only as good as the minimal pair.</p>`,
  },
};

const IOI = 'When Mary and John went to the store, John gave a drink to';
const EXAMPLES = [
  { label: 'Mary or John', clean: IOI, corrupt: 'When Mary and John went to the store, Mary gave a drink to', answer: ' Mary', foil: ' John' },
  { label: 'Alice or Bob', clean: 'When Alice and Bob went to the park, Bob handed a ball to', corrupt: 'When Alice and Bob went to the park, Alice handed a ball to', answer: ' Alice', foil: ' Bob' },
  { label: 'Paris or Rome', clean: 'The Eiffel Tower is in the city of', corrupt: 'The Colosseum is in the city of', answer: ' Paris', foil: ' Rome' },
];

export function mount(el, meta, api) {
  const P = api.params, life = { dead: false };
  const E0 = EXAMPLES[0];
  const st = { clean: P.clean ?? E0.clean, corrupt: P.corrupt ?? E0.corrupt, answer: P.answer ?? E0.answer, foil: P.foil ?? E0.foil,
    hook: P.hook === 'head' ? 'head' : 'resid_pre', direction: P.direction === 'noise' ? 'noise' : 'denoise' };
  const page = toolPage(el, meta, TEACH);
  const save = debounce(() => api.setParams({ clean: st.clean, corrupt: st.corrupt, answer: st.answer, foil: st.foil, hook: st.hook, direction: st.direction === 'noise' ? 'noise' : null }), 400);
  const cIn = textArea(st.clean, { rows: 2, oninput: (e) => { st.clean = e.target.value; save(); check(); } });
  const xIn = textArea(st.corrupt, { rows: 2, oninput: (e) => { st.corrupt = e.target.value; save(); check(); } });
  const aIn = textInput(st.answer, { oninput: (e) => { st.answer = e.target.value; save(); } });
  const fIn = textInput(st.foil, { oninput: (e) => { st.foil = e.target.value; save(); } });
  const hSel = select([['resid_pre', 'the stream at every layer and token'], ['head', 'every attention head']], st.hook, (v) => { st.hook = v; save(); });
  const dSel = select([['denoise', 'clean into corrupted: what restores the answer?'], ['noise', 'corrupted into clean: what breaks it?']], st.direction, (v) => { st.direction = v; save(); });
  const pairBox = h('div.small'), runSlot = h('div'), cost = h('span.small.muted');
  const run = runner('Patch', runSlot, (onP, ctl) => compute(onP, ctl));
  put(page.controls,
    h('div.fields.two', null, field('Clean prompt (gives the answer)', cIn), field('Corrupted prompt (one detail changed)', xIn)),
    presets(EXAMPLES, (x) => { cIn.value = st.clean = x.clean; xIn.value = st.corrupt = x.corrupt; aIn.value = st.answer = x.answer; fIn.value = st.foil = x.foil; save(); check(); }),
    pairBox,
    h('div.fields.four', { style: { marginTop: '10px' } }, field('Answer', aIn), field('Foil', fIn), field('Patch', hSel), field('Direction', dSel)),
    h('div.row', { style: { marginTop: '10px' } }, run.btn, cost), runSlot);

  const tiles = h('div.stats'), gridBox = h('div'), note = h('p.small');
  put(page.result, tiles, gridBox, note);

  /* the two prompts side by side, token by token, with the differences marked */
  const check = debounce(async () => {
    try {
      const [c, x] = await Promise.all([engine.tok(st.clean), engine.tok(st.corrupt)]);
      if (life.dead) return;
      const same = c.ids.length === x.ids.length;
      const row = (t, other) => h('div.toks', { 'data-tara-noglossary': true }, t.pieces.map((p, i) => {
        const diff = !other || other.ids[i] !== t.ids[i];
        return h('span.tok' + (i === 0 ? '.bos' : ''), { style: diff && i > 0 ? { outline: '2px solid var(--accent)', outlineOffset: '1px' } : null }, i === 0 ? '⟨bos⟩' : tokText(p));
      }));
      put(pairBox,
        h('div', null, h('span.muted', null, `clean, ${c.ids.length - 1} tokens: `), row(c, x)),
        h('div', null, h('span.muted', null, `corrupted, ${x.ids.length - 1} tokens: `), row(x, c)),
        same ? h('div.muted', null, 'Outlined: the tokens that differ.') : h('div.err', null, `The prompts must have the same number of tokens (${c.ids.length - 1} and ${x.ids.length - 1}). Change words for words of the same length in tokens.`));
      run.btn.disabled = !same;
    } catch (e) { /* model not ready yet */ }
  }, 300);

  async function compute(onP, ctl) {
    const [c, x] = await Promise.all([engine.tok(st.clean), engine.tok(st.corrupt)]);
    if (c.ids.length !== x.ids.length) throw new Error('The prompts must have the same number of tokens.');
    const a = await engine.token(st.answer), b = await engine.token(st.foil);
    const key = ['patch', st.hook, st.direction, a.id, b.id, c.ids.join(','), x.ids.join(',')].join('|');
    let res = memo.get(key);
    if (!res) {
      const metric = { kind: 'logitdiff', a: a.id, b: b.id, pos: c.ids.length - 1 };
      const r = await ctl.track(engine.recipe('patch', { clean: c.ids, corrupt: x.ids, metric, hook: st.hook, direction: st.direction },
        { onProgress: (p) => onP(p.done, p.total, `${p.done} of ${p.total} patched runs`) }));
      res = { r, c, x, a, b, hook: st.hook, direction: st.direction };
      memo.set(key, res);
    }
    if (!life.dead) draw(res);
  }

  function draw({ r, c, x, a, b, hook, direction }) {
    const val = (i) => (direction === 'noise' ? 1 - r.score[i] : r.score[i]);
    let best = 0, m = 1;
    for (let i = 0; i < r.score.length; i++) { m = Math.max(m, Math.abs(val(i))); if (val(i) > val(best)) best = i; }
    const ab = `${tokText(a.piece)} minus ${tokText(b.piece)}`;
    const label = (p) => (c.ids[p] === x.ids[p] ? (p === 0 ? '⟨bos⟩' : c.pieces[p]) : `${c.pieces[p]}/${x.pieces[p]}`);
    const where = (i) => hook === 'head' ? `L${Math.floor(i / 12)}H${i % 12}` : `layer ${Math.floor(i / r.cols)}, at ${tokText(label(i % r.cols))}`;
    put(tiles,
      stat('Clean prompt', signed(r.clean), ab),
      stat('Corrupted prompt', signed(r.corrupt), ab),
      stat(direction === 'noise' ? 'Breaks the most' : 'Restores the most', hook === 'head' ? where(best) : `L${Math.floor(best / r.cols)}, ${tokText(label(best % r.cols))}`, `${Math.round(100 * val(best))}% of the difference`));
    const what = direction === 'noise' ? 'of the answer broken' : 'of the answer restored';
    grid(gridBox, {
      rows: r.rows, cols: r.cols, cell: hook === 'head' ? 40 : 64, minCell: 22, aspect: hook === 'head' ? 0.75 : 0.5, scale: 'div', max: m, fmt: (v) => fmt(v, 1),
      value: (l, j) => val(l * r.cols + j),
      text: (l, j) => { const v = val(l * r.cols + j); return Math.abs(v) >= 0.25 ? String(Math.round(100 * v)) : ''; },
      rowLabels: [...Array(r.rows).keys()].map((l) => 'L' + l),
      colLabels: hook === 'head' ? [...Array(12).keys()].map((j) => 'H' + j) : [...Array(r.cols).keys()].map(label),
      loLabel: 'the other way', hiLabel: direction === 'noise' ? 'all broken' : 'all restored', midLabel: '(gray = no change)',
      tip: (l, j) => { const i = l * r.cols + j; return [h('div.tip-head', null, where(i)), tipRow(`${Math.round(100 * val(i))}%`, what), tipRow(signed(r.raw[i]), `${ab} after the swap`)]; },
      caption: hook === 'head'
        ? `Each cell: swap one head's output at every position (${direction === 'noise' ? 'corrupted into the clean run' : 'clean into the corrupted run'}). Rows: layers 0 (top) to 11. Numbers are percentages.`
        : `Each cell: swap the stream entering one layer at one token (${direction === 'noise' ? 'corrupted into the clean run' : 'clean into the corrupted run'}). Rows: layers 0 (top) to 11. Columns: tokens. Numbers are percentages.`,
    });
    const dl = toolLink('dla', { text: st.clean, answer: st.answer, foil: st.foil }, 'Who wrote the answer');
    if (hook === 'head') put(note, 'Compare with ', dl, ': heads that matter here but wrote little there moved information rather than writing the answer.');
    else put(note, 'To see which heads carried the information from one token to another, switch Patch to every attention head, or compare with ', dl, '.');
  }

  whenReady(page, life, async () => {
    cost.textContent = isGPU() ? 'Seconds on this graphics card.' : 'A few minutes on a processor; it can run while you read.';
    check.now();
    const [c, x] = await Promise.all([engine.tok(st.clean), engine.tok(st.corrupt)]);
    const a = await engine.token(st.answer), b = await engine.token(st.foil);
    const res = memo.get(['patch', st.hook, st.direction, a.id, b.id, c.ids.join(','), x.ids.join(',')].join('|'));
    if (res) draw(res); else if (isGPU() && c.ids.length === x.ids.length) run.go();
  });
  return { destroy() { life.dead = true; } };
}

function signed(x) { return (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(2); }
