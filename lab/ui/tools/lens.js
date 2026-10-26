/* lab/ui/tools/lens.js: the logit lens (nostalgebraist, 2020). Read the residual stream after every layer as if it
   were the last one: apply the final layer norm and the unembedding to the half-built stream and see what the model
   would say if it had to answer now. Drawn as the river flows: the embedding at the bottom, the output at the top. */

import { h, mount as put, fmt, tokText, debounce } from '../dom.js';
import { toolPage, field, textArea, textInput, select, presets, runner, whenReady, ordinal, tk, toolLink } from './kit.js';
import { engine, isGPU } from '../engine.js';
import { grid, lineChart, tipRow, col } from '../charts.js';

const TEACH = {
  what: {
    1: `<p>Inside GPT-2, every token carries a running draft of "what comes next", which each layer adds to. The logit
lens reads that draft half-way through: it takes the stream after, say, layer 5 and asks "if you had to answer now,
what would you say?"</p>
<p>Watching the answer appear, layer by layer, shows <i>where</i> in the model it is put together.</p>`,
    2: `<p>The residual stream is a sum: embedding plus everything each attention layer and MLP wrote. The model's real
output is the final layer norm and unembedding applied to the stream after layer 11. The logit lens applies the same
two steps to the stream after any earlier layer, giving a full next-token distribution at every depth.</p>
<div data-angle="analogy"><p>Reading a document that 12 editors are writing in turn, and asking after each editor
"what does this draft conclude?". Early drafts are notes in the margin; the conclusion firms up when the right editor
has written their part.</p></div>`,
    3: `<p>LensLogits<sub>ℓ</sub> = W<sub>U</sub> · LN<sub>f</sub>(x<sub>ℓ</sub>), with x<sub>ℓ</sub> the resid_post of layer ℓ and LN<sub>f</sub>
recomputing its own scale from x<sub>ℓ</sub>. It assumes intermediate layers already use the output basis. In GPT-2
small that roughly holds in later layers and fails early (early rows are dominated by the current token and generic
words). Current practice: the tuned lens (Belrose et al., 2023) learns an affine translator per layer and is more
faithful; the plain lens remains the quick first look. Agreement with the final output is not proof of mechanism:
pair it with attribution or patching.</p>`,
  },
  read: {
    1: `<p>Columns are your tokens; rows go up through the model, from the embedding at the bottom to the real output at
the top. Each cell names the token the model would bet on at that point, and darker cells are more confident. Give a
target word and the chart below follows its probability up the last column.</p>`,
    2: `<p>Colour is the probability of the cell's top token (or of your target, if you switch the colouring), from 0 to
1 on one blue scale. Row "L5" is the stream after layer 5; the top row equals the model's actual prediction. Tap a cell
to follow the target up that column instead of the last one.</p>`,
    3: `<p>Each cell is a full softmax over 50,257 tokens; the tooltip gives the top three, the entropy and the target's
rank. On a processor the lab reads only the last few positions by default: every cell is one unembedding, 39 million
multiply-adds.</p>`,
  },
  why: {
    1: `<p>The logit lens is the cheapest way to ask "where does the model decide?", and it sets up week 3: once you know
which layer the answer appears in, you know which heads to inspect.</p>`,
    2: `<p>The same "read an intermediate state with the output head" trick appears as early exiting in efficient
inference, as the "direct path" in transformer circuits, and as the logit lens for SAE features and steering vectors
(read a direction through W<sub>U</sub> to see what it promotes), which the Steering and Neuron tools do.</p>`,
    3: `<p>Research uses: locating where facts are retrieved (Geva et al.), comparing base and fine-tuned models layer by
layer, and spotting "overthinking", where a correct early answer is overwritten later (Halawi et al., 2023). For
quantitative work prefer the tuned lens or patching; for a first map, this is enough.</p>`,
  },
};

const EXAMPLES = [
  { label: 'Mary or John', text: 'When Mary and John went to the store, John gave a drink to', target: ' Mary' },
  { label: 'Capital', text: 'The Eiffel Tower is in the city of', target: ' Paris' },
  { label: 'Counting', text: 'one, two, three, four,', target: ' five' },
  { label: 'Opposites', text: 'The opposite of hot is', target: ' cold' },
];

export function mount(el, meta, api) {
  const P = api.params, life = { dead: false };
  const st = { text: P.text ?? EXAMPLES[0].text, target: P.target ?? EXAMPLES[0].target, span: P.span || 'auto', colour: P.colour || 'top', pick: null };
  const page = toolPage(el, meta, TEACH);
  const save = debounce(() => api.setParams({ text: st.text, target: st.target || null, span: st.span === 'auto' ? null : st.span, colour: st.colour === 'top' ? null : st.colour }), 400);
  const count = h('span'), warn = h('span');
  const ta = textArea(st.text, { rows: 2, oninput: (e) => { st.text = e.target.value; save(); auto(); } });
  const tIn = textInput(st.target, { placeholder: 'optional, with its leading space: " Mary"', oninput: (e) => { st.target = e.target.value; save(); auto(); } });
  const spanSel = select([['auto', 'last 8 on a processor, all on a GPU'], ['8', 'last 8 tokens'], ['all', 'every token (slow on a processor)']], st.span, (v) => { st.span = v; save(); });
  const colourSel = select([['top', 'the top token\'s probability'], ['target', 'the target\'s probability']], st.colour, (v) => { st.colour = v; save(); if (cur) draw(); });
  const out = h('div'), lineBox = h('div'), runSlot = h('div');
  const run = runner('Read the stream', runSlot, (onP, ctl) => compute(onP, ctl));
  put(page.controls,
    field('Your text', ta, count),
    presets(EXAMPLES, (x) => { ta.value = st.text = x.text; tIn.value = st.target = x.target; save(); run.go(); }),
    h('div.fields.three', { style: { marginTop: '10px' } }, field('Target word (optional)', tIn, warn), field('Positions to read', spanSel), field('Colour by', colourSel)),
    h('div.row', { style: { marginTop: '10px' } }, run.btn), runSlot);
  put(page.result, out, lineBox);
  const auto = debounce(() => { if (isGPU() && !run.busy) run.go(); }, 700);

  let cur = null;
  async function compute(onP, ctl) {
    const t = await engine.tok(st.text);
    count.textContent = `${t.ids.length - 1} tokens`;
    if (t.ids.length < 2) throw new Error('Type some text first.');
    let target = null;
    put(warn);
    if (st.target) {
      const a = await engine.token(st.target);
      target = a.id;
      if (a.n > 1) put(warn, `"${st.target}" is ${a.n} tokens; the lens follows its first, ${JSON.stringify(a.pieces[0])}.`);
    }
    const T = t.ids.length;
    const lim = st.span === 'all' ? T : st.span === '8' ? 8 : (isGPU() ? 48 : 8);
    const positions = [];
    for (let p = Math.max(1, T - lim); p < T; p++) positions.push(p);
    const r = await ctl.track(engine.recipe('logitLens', { ids: t.ids, k: 3, target, positions }, { onProgress: (x) => onP(x.done, x.total, `${x.done} of ${x.total} readings`) }));
    if (life.dead) return;
    const uniq = [...new Set(Array.from(r.top))];
    const names = await engine.vocab(uniq);
    cur = { r, pieces: t.pieces, piece: new Map(uniq.map((id, i) => [id, names[i]])), target, targetPiece: target === null ? null : (await engine.vocab([target]))[0] };
    st.pick = r.P - 1;
    draw();
  }

  function draw() {
    const { r, pieces, piece, target, targetPiece } = cur, S = r.S, Pn = r.P, k = r.k;
    const byTarget = st.colour === 'target' && target !== null;
    const sOf = (row) => S - 1 - row;               // row 0 is the top (the output)
    const q = (s, j) => s * Pn + j;
    const name = (s) => (s === 0 ? 'embedding' : s === S - 1 ? 'L11 = output' : `after L${s - 1}`);
    const gEl = h('div');
    put(out, gEl);
    grid(gEl, {
      rows: S, cols: Pn, cell: 120, minCell: 30, cellH: 30,
      value: (row, c) => { const s = sOf(row); return byTarget ? r.tProb[q(s, c)] : r.prob[q(s, c) * k]; },
      scale: 'seq', max: 1, min: 0, fmt: (v) => fmt(v, 0),
      rowLabels: [...Array(S).keys()].map((row) => { const s = sOf(row); return s === 0 ? 'embed' : `L${s - 1}`; }),
      colLabels: r.positions.map((p) => pieces[p]),
      text: (row, c) => piece.get(r.top[q(sOf(row), c) * k]),
      selected: target !== null ? [0, st.pick] : null,
      tip: (row, c) => {
        const s = sOf(row), base = q(s, c) * k;
        const rows = [h('div.tip-head', null, `${name(s)}, at `, h('span.tok-inline', null, tokText(pieces[r.positions[c]])))];
        for (let j = 0; j < k; j++) rows.push(tipRow(pc(r.prob[base + j]), tokText(piece.get(r.top[base + j]))));
        rows.push(h('div.tip-sub', null, `entropy ${fmt(r.entropy[q(s, c)], 2)} nats`));
        if (target !== null) rows.push(h('div.tip-sub', null, `${tokText(targetPiece)}: ${pc(r.tProb[q(s, c)])}, ${ordinal(r.tRank[q(s, c)] + 1)} choice`));
        return rows;
      },
      onPick: target !== null ? (row, c) => { st.pick = c; drawLine(); } : null,
      caption: `Bottom row: the embedding. Each row up: the stream after that layer, read with the model's own output head. Top row: the real output. Colour: ${byTarget ? `the probability of ${tokText(targetPiece)}` : 'how sure the cell\'s top token is'}.`,
    });
    drawLine();
  }

  function drawLine() {
    const { r, pieces, target, targetPiece } = cur;
    if (target === null) { put(lineBox); return; }
    const S = r.S, Pn = r.P, j = st.pick ?? Pn - 1;
    const pts = [...Array(S).keys()].map((s) => [s, r.tProb[s * Pn + j]]);
    const box = h('div');
    put(lineBox, h('div.subhead', null, h('h3', null, h('span', null, 'Following '), tk(targetPiece), h('span', null, ' at '), tk(pieces[r.positions[j]])),
      h('span.small.muted', null, 'tap a column above to follow another position')), box,
      h('p.small.muted', null, 'Want to know which heads wrote it? ', toolLink('dla', { text: st.text, answer: st.target }, 'Split the answer by component'), '.'));
    lineChart(box, { height: 200, legend: false,
      x: { label: 'depth', fmt: (v) => (v === 0 ? 'emb' : `L${v - 1}`), ticks: [...Array(S).keys()] },
      y: { label: 'probability', min: 0, max: 1, fmt: (v) => Math.round(v * 100) + '%' },
      series: [{ name: `probability of ${tokText(targetPiece)}`, color: col('s1'), pts }],
      tipExtra: (s) => h('div.tip-sub', null, `${ordinal(r.tRank[s * Pn + j] + 1)} choice of 50,257`) });
  }

  whenReady(page, life, () => run.go());
  return { destroy() { life.dead = true; } };
}

function pc(p) { return p >= 0.1 ? (100 * p).toFixed(0) + '%' : p >= 0.01 ? (100 * p).toFixed(1) + '%' : (100 * p).toPrecision(1) + '%'; }
