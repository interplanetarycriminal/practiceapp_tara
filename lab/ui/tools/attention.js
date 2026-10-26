/* lab/ui/tools/attention.js: attention patterns. Where one head looks from every token of your text, and a
   fingerprint of all 144 heads: ARENA's detectors (previous-token, duplicate-token, induction, first-token) measured
   on random tokens repeated twice (lab/data/heads.json, or recomputed here), plus the same summaries on your text. */

import { h, mount as put, fmt, tokText, debounce } from '../dom.js';
import { toolPage, field, textArea, select, presets, whenReady, LAYERS, HEADS, intParam, tk, toolLink } from './kit.js';
import { engine } from '../engine.js';
import { grid, tokens, tipRow } from '../charts.js';

const TEACH = {
  what: {
    1: `<p>Attention is how one token gets information from earlier tokens. Each of GPT-2's 144 <b>heads</b> decides, for
every token, how to share out its attention over the tokens before it (the shares add up to 1), then copies a little
of what it found.</p>
<p>Some heads do simple, recognisable jobs: look at the previous token, look back at an earlier copy of the same
word, or look at whatever came <i>after</i> that earlier copy. The last kind, the <b>induction head</b>, is how GPT-2
continues patterns it has seen once.</p>`,
    2: `<p>For each head, every query position computes a score against every earlier key position (a dot product of a
query vector and a key vector), and a softmax over those scores gives the <b>attention pattern</b>: one row of weights
per query, summing to 1, zero above the diagonal because of the causal mask. The head then writes a weighted sum of
value vectors into the query's residual stream.</p>
<div data-angle="analogy"><p>A reading room where each reader (a token) may only look at books on shelves to their
left. Every head is a different research assistant with its own habit: one always fetches the book right next to
you, another fetches the book that followed the last time your topic came up.</p></div>`,
    3: `<p>A<sup>h</sup> = softmax(mask(Q<sup>h</sup>K<sup>hT</sup>/√d<sub>head</sub>)), with Q, K, V linear in LN<sub>1</sub>(x). The
fingerprints follow ARENA 1.2: the previous-token score is the mean of A[t, t−1]; the duplicate-token score is the
mean attention from the second copy of a random sequence to the first copy's same token; the induction score is the
mean attention to the token just after it. Many heads rest on the first token when they have nothing to do (an
attention sink), which is why "first-token" is worth a fingerprint of its own. Patterns say where a head reads, not
what it writes: that is the OV circuit, next door.</p>`,
  },
  read: {
    1: `<p>Left: all 144 heads, one cell each (layer down the side, head across), coloured by the habit you choose. Tap a
cell to open that head. Right: the head's pattern on your text. Each row is a token looking back; each column is a
token being looked at; darker means more attention.</p>
<p>Below it, tap any token to colour your text by where that token looks.</p>`,
    2: `<p>Pattern rows sum to 1. A previous-token head draws a line just under the diagonal; a head resting on the first
token draws a dark first column; an induction head on repeated text draws a stripe offset by the length of the
repeat. Fingerprint scores are from 0 to 1 (1 = all of the attention goes where the detector expects).</p>`,
    3: `<p>The precomputed fingerprints use 32 sequences of 50 random tokens repeated (<code>lab/data/heads.json</code>); "Recompute"
redoes them here with 4 sequences, so expect small differences. On-your-text scores average over every query token
after the first.</p>`,
  },
  why: {
    1: `<p>Induction heads are the first circuit most people meet in mechanistic interpretability, and they matter: they
appear suddenly during training, at the same moment the model gets good at learning from its prompt.</p>`,
    2: `<p>The same "who looks at whom" reading appears in week 4's IOI circuit (name movers look at the right name), in
week 11's thought anchors (which earlier sentences later reasoning attends to), and anywhere a model copies from its
context: retrieval, quoting, few-shot learning.</p>`,
    3: `<p>Olsson et al. (2022) tie the induction-head phase change to in-context learning; Elhage et al. (2021) give the
QK/OV decomposition. Attention patterns alone can mislead: a head can attend strongly but write nothing useful, so pair
patterns with DLA, OV circuits or patching before claiming a function.</p>`,
  },
};

const DURSLEY = 'Mr and Mrs Dursley, of number four, Privet Drive, were proud to say that they were perfectly normal, thank you very much. Mr and Mrs Dursley, of number four, Privet Drive, were proud to say that they were perfectly normal, thank you very much.';
const EXAMPLES = [
  { label: 'A plain sentence', text: 'The quick brown fox jumps over the lazy dog while the cat sleeps in the sun.', layer: 4, head: 11 },
  { label: 'A repeated passage', text: DURSLEY, layer: 5, head: 5, color: 'induction' },
  { label: 'Mary and John', text: 'When Mary and John went to the store, John gave a drink to', layer: 9, head: 9 },
];
const PRINTS = {
  prev: { name: 'looks one back', src: 'random', key: 'prev', desc: 'previous-token score on random tokens' },
  dup: { name: 'finds its earlier copy', src: 'random', key: 'dup', desc: 'duplicate-token score on random repeated tokens' },
  induction: { name: 'induction', src: 'random', key: 'induction', desc: 'induction score: attention to the token after the earlier copy' },
  bos: { name: 'rests on the first token', src: 'random', key: 'bos', desc: 'attention on the first token, random tokens' },
  tprev: { name: 'looks one back', src: 'text', key: 'prev', desc: 'previous-token attention on your text' },
  tbos: { name: 'rests on the first token', src: 'text', key: 'bos', desc: 'attention on the first token, your text' },
  tself: { name: 'looks at itself', src: 'text', key: 'self', desc: 'attention to its own position, your text' },
  tent: { name: 'spreads out', src: 'text', key: 'entropy', desc: 'how spread out its attention is on your text (entropy ÷ its maximum)' },
};

let HEADS_DATA = null;
async function headsData() {
  if (HEADS_DATA) return HEADS_DATA;
  try { const j = await (await fetch('data/heads.json')).json(); HEADS_DATA = { ...j.scores, source: 'shipped', n: 32 }; } catch (e) { HEADS_DATA = null; }
  return HEADS_DATA;
}

const bosName = (p) => (p === '<|endoftext|>' ? '⟨bos⟩' : p);

export function mount(el, meta, api) {
  const P = api.params, life = { dead: false };
  const st = { text: P.text ?? EXAMPLES[0].text, layer: intParam(P.layer, 0, 11, 4), head: intParam(P.head, 0, 11, 11), color: PRINTS[P.color] ? P.color : 'prev', query: null };
  const page = toolPage(el, meta, TEACH);
  const save = debounce(() => api.setParams({ text: st.text, layer: st.layer, head: st.head, color: st.color === 'prev' ? null : st.color }), 300);
  const count = h('span');
  const ta = textArea(st.text, { rows: 2, oninput: (e) => { st.text = e.target.value; st.query = null; save(); go(); } });
  const lSel = select(LAYERS, st.layer, (v) => { st.layer = Number(v); save(); drawHead(); drawPrint(); });
  const hSel = select(HEADS, st.head, (v) => { st.head = Number(v); save(); drawHead(); drawPrint(); });
  put(page.controls,
    field('Your text', ta, count),
    presets(EXAMPLES, (x) => { ta.value = st.text = x.text; st.layer = x.layer; st.head = x.head; if (x.color) st.color = x.color; lSel.value = String(x.layer); hSel.value = String(x.head); st.query = null; save(); go.now(); drawPrint(); }),
    h('div.fields.two', { style: { marginTop: '10px' } }, field('Layer', lSel), field('Head', hSel)));

  const printBox = h('div'), printChips = h('div'), printNote = h('p.small.muted'), recompute = h('div.small');
  const headTitle = h('h3'), headSum = h('p.small'), patBox = h('div'), stripBox = h('div'), stripNote = h('p.small.muted');
  put(page.result, h('div.res-cols', null,
    h('div', null, h('h3', null, 'All 144 heads'), printChips, printBox, printNote, recompute),
    h('div', null, headTitle, headSum, patBox)),
  h('div.subhead', null, h('h3', null, 'Where one token looks'), stripNote), stripBox);

  let cur = null, prints = null;

  /* ---------------- fingerprints */
  const chipFor = (id) => {
    const b = h('button.chip', { type: 'button', 'aria-pressed': String(id === st.color), title: PRINTS[id].desc }, PRINTS[id].name);
    b.addEventListener('click', () => { st.color = id; save(); for (const x of printChips.querySelectorAll('.chip')) x.setAttribute('aria-pressed', String(x === b)); drawPrint(); });
    return b;
  };
  put(printChips,
    h('div.small-caps', null, 'On random tokens, repeated'), h('div.chips', null, ['prev', 'dup', 'induction', 'bos'].map(chipFor)),
    h('div.small-caps', { style: { marginTop: '6px' } }, 'On your text'), h('div.chips', null, ['tprev', 'tbos', 'tself', 'tent'].map(chipFor)));

  function printValue(id, l, hh) {
    const pr = PRINTS[id];
    if (pr.src === 'random') return prints ? prints[pr.key][l][hh] : NaN;
    if (!cur) return NaN;
    const v = cur.r[pr.key][l * 12 + hh];
    return pr.key === 'entropy' ? v / Math.log(Math.max(2, cur.T - 1)) : v;
  }

  function drawPrint() {
    const id = st.color, pr = PRINTS[id];
    grid(printBox, {
      rows: 12, cols: 12, cell: 40, minCell: 22, aspect: 0.75, scale: 'seq', min: 0, max: 1, fmt: (v) => fmt(v, 0),
      value: (l, hh) => printValue(id, l, hh),
      text: (l, hh) => { const v = printValue(id, l, hh); return v >= 0.5 ? String(Math.round(v * 100)) : ''; },
      rowLabels: [...Array(12).keys()].map((l) => 'L' + l), colLabels: [...Array(12).keys()].map((x) => 'H' + x),
      selected: [st.layer, st.head],
      tip: (l, hh) => [h('div.tip-head', null, `L${l}H${hh}`), tipRow(fmt(printValue(id, l, hh), 2), pr.desc)],
      onPick: (l, hh) => { st.layer = l; st.head = hh; lSel.value = String(l); hSel.value = String(hh); save(); drawHead(); },
      caption: 'Rows: layers 0 (top) to 11. Columns: heads 0 to 11. Numbers show scores of 0.5 and above, as percentages.',
    });
    put(printNote, pr.src === 'random'
      ? (prints && prints.source === 'here' ? 'Computed on this device just now, from 4 sequences of 50 random tokens repeated twice.' : 'Computed from 32 sequences of 50 random tokens, each repeated twice, so only the head\'s habit can explain the score.')
      : 'Measured on your text, averaged over every token after the first.');
  }

  /* ---------------- one head */
  function drawHead() {
    headTitle.textContent = `Layer ${st.layer}, head ${st.head} on your text`;
    if (!cur) return;
    const { T, r, pieces } = cur;
    const A = r.patterns[st.layer], hh = st.head, q = (st.query ?? T - 1);
    const i = st.layer * 12 + hh;
    put(headSum, `On average across your text it puts ${pc(r.prev[i])} of its attention on the previous token, ${pc(r.bos[i])} on the first token and ${pc(r.self[i])} on itself. `,
      toolLink('ov', { layer: st.layer, head: hh }, 'What does it write?'));
    const labels = pieces.map(bosName);
    grid(patBox, {
      rows: T, cols: T, square: true, cell: 28, minCell: 3, scale: 'seq', min: 0, max: 1, fmt: (v) => fmt(v, 0),
      value: (a, b) => (b > a ? NaN : A[(hh * T + a) * T + b]),
      rowLabels: labels, colLabels: labels,
      selected: [q, q],
      tip: (a, b) => b > a ? [h('div', null, 'Above the diagonal: a token cannot look at later tokens.')] : [
        h('div.tip-head', null, h('span.tok-inline', null, tokText(labels[a])), ' looks at ', h('span.tok-inline', null, tokText(labels[b]))),
        tipRow(pc(A[(hh * T + a) * T + b]), `of its attention (token ${a} to token ${b})`)],
      onPick: (a) => { st.query = a; drawStrip(); },
      caption: 'Rows: each token looking back (the query). Columns: the token it looks at (the key). Each row sums to 100%.',
    });
    drawStrip();
  }

  function drawStrip() {
    if (!cur) return;
    const { T, r, pieces } = cur;
    const A = r.patterns[st.layer], hh = st.head, q = st.query ?? T - 1;
    const vals = pieces.map((_, k) => (k <= q ? A[(hh * T + q) * T + k] : NaN));
    tokens(stripBox, { pieces, values: vals, scale: 'seq', max: 1, min: 0, selected: q,
      tip: (k) => k > q ? [h('div', null, 'Later than the chosen token: out of its reach.')] : [h('div.tip-head', null, h('span.tok-inline', null, tokText(bosName(pieces[k])))),
        tipRow(pc(vals[k]), `of the attention from ${tokText(bosName(pieces[q]))}`)],
      onPick: (k) => { st.query = k; drawHead(); } });
    put(stripNote, h('span', null, `L${st.layer}H${hh}, from `, tk(bosName(pieces[q])), ' (tap any token to look from it instead)'));
  }

  /* ---------------- running */
  const go = debounce(async () => {
    const text = st.text;
    if (!text.trim()) return;
    try {
      const t = await engine.tok(text);
      count.textContent = `${t.ids.length - 1} tokens`;
      if (t.ids.length > 160) { put(patBox, h('p.err', null, `That is ${t.ids.length - 1} tokens; the pattern view takes up to 159. Try a shorter text.`)); return; }
      page.result.classList.add('busy');
      const r = await engine.recipe('attention', { ids: t.ids }, { channel: 'attention' });
      if (life.dead || text !== st.text) return;
      cur = { T: r.T, r, pieces: t.pieces };
      drawHead();
      if (PRINTS[st.color].src === 'text') drawPrint();
    } catch (e) {
      if (!/cancelled/.test(String(e && e.message))) put(patBox, h('p.err', null, String(e.message || e)));
    } finally { page.result.classList.remove('busy'); }
  }, 350);

  const reBtn = h('button.btn.small.ghost', { type: 'button' }, 'Recompute on this device');
  reBtn.addEventListener('click', async () => {
    reBtn.disabled = true; reBtn.textContent = 'Recomputing… (about 10 seconds on a processor)';
    try {
      const r = await engine.recipe('headScores', { seqLen: 50, batch: 4, seed: 7 });
      const as2d = (a) => [...Array(12).keys()].map((l) => Array.from(a.slice(l * 12, l * 12 + 12)));
      prints = { prev: as2d(r.prev), dup: as2d(r.dup), induction: as2d(r.induction), bos: as2d(r.bos), source: 'here' };
      if (!life.dead) drawPrint();
      reBtn.textContent = 'Recomputed';
    } catch (e) { reBtn.disabled = false; reBtn.textContent = 'Recompute on this device'; put(recompute, reBtn, h('span.err', null, ' ' + (e.message || e))); }
  });
  put(recompute, reBtn);

  headTitle.textContent = `Layer ${st.layer}, head ${st.head} on your text`;
  headsData().then((d) => { if (!prints) prints = d; if (!life.dead) drawPrint(); });
  whenReady(page, life, () => go.now());
  return { destroy() { life.dead = true; } };
}

function pc(p) { return Number.isFinite(p) ? (p >= 0.995 ? '100%' : (100 * p).toFixed(p >= 0.1 ? 0 : 1) + '%') : '–'; }
