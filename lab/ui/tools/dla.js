/* lab/ui/tools/dla.js: Who wrote the answer (direct logit attribution). Split "logit of the answer minus logit of the
   foil" at the last position into what every head, MLP, embedding and neuron wrote. The pieces add up exactly,
   because the residual stream is a sum and the final layer norm's scale is fixed for this prompt. */

import { h, mount as put, fmt, tokText, debounce } from '../dom.js';
import { toolPage, field, textArea, textInput, presets, whenReady, ordinal, tk, toolLink, CFG, nHeads, hix, isAttn, absMax, onGPT2 } from './kit.js';
import { engine } from '../engine.js';
import { grid, bars, lineChart, stat, tipRow, col } from '../charts.js';

const TEACH = {
  what: {
    1: `<p>GPT-2's final answer is built by adding up what every part of the model wrote into the stream. So you can ask
of each part: how much did <i>you</i> push the answer towards "Mary" and away from "John"? The pushes add up exactly to
the model's final preference.</p>
<p>That gives you suspects in one pass: a few heads usually write most of the answer.</p>`,
    2: `<p>The final stream at the last position is a sum: token embedding + position embedding + every head's output + every
MLP's output. The logit of a token is a dot product of the final layer norm's output with that token's unembedding
vector. Freeze the layer norm's scale at its value on this prompt and the whole map is linear, so the <b>logit
difference</b> (answer minus foil) splits into one number per component: its <b>direct logit attribution</b>.</p>
<div data-angle="analogy"><p>A shared bill: the total is fixed, and each person's line on the receipt says exactly what
they added. Some lines are refunds (negative). The receipt tells you who ordered the expensive dish, not who talked
them into it.</p></div>`,
    3: `<p>DLA<sub>c</sub> = (u<sub>a</sub> − u<sub>b</sub>)·(γ<sub>f</sub> ⊙ (c − mean(c)))/σ<sub>final</sub>, with the ln_f bias term
β<sub>f</sub>·(u<sub>a</sub> − u<sub>b</sub>) as a constant. It is exact for the frozen σ and measures <i>direct</i> effects only: a head
that matters by moving information that a later head uses (S-inhibition heads in IOI) gets little or no DLA. That
is why the knock-out sweep and activation patching come next. Neuron attributions are activation × (W<sub>out</sub> row ·
the same direction).</p>`,
  },
  read: {
    1: `<p>The line shows the running total as the stream rises through the model: flat stretches did nothing for the
answer, jumps are where it got written. The grid shows every head: blue pushed towards your answer, red towards the
foil. Tap a head to look at it with other tools.</p>`,
    2: `<p>Units are logits. The total at the top of the line equals the model's real logit difference (the check under
the tiles). Head cells share one colour scale centred on zero; the list ranks every component by its size, including
MLPs and the embeddings.</p>`,
    3: `<p>Attention biases (b<sub>O</sub>) are tiny and folded into each layer's attention step. "Start" is the token embedding,
the position embedding and the ln_f bias term together. Neurons are listed separately; their sum is each layer's MLP
contribution minus the MLP output bias.</p>`,
  },
  qwen: `<p>The split is just as exact on Qwen 3.5 9B, with three differences. Its final norm is an RMS norm: it
divides the stream by its root-mean-square without subtracting the mean, so nothing is centred and the page divides by
the RMS measured on your prompt. A Gated DeltaNet layer's output is also a sum over its 32 heads, so DeltaNet layers
appear in the grid as rows of 32 heads, and attention layers as rows of 16. There is no position embedding and no
norm bias, so the running total starts from the token's own embedding.</p>`,
  why: {
    1: `<p>This is the first move in nearly every circuit analysis: find who wrote the answer, then ask why they did.</p>`,
    2: `<p>A logit difference is also a clean scorer (week 8): it has no sampling noise and measures how strongly the model
prefers one answer. The same attribution idea, applied to features instead of heads, is what attribution graphs
(circuit-tracer) compute at scale.</p>`,
    3: `<p>Generalisations: attribution patching (a gradient approximation of patching), path patching (direct effects
along chosen paths), and attribution graphs over transcoder features (Ameisen et al., 2025), where the frozen-σ trick
is the same. All inherit DLA's blind spot for indirect effects unless they trace paths explicitly.</p>`,
  },
};

const EXAMPLES = [
  { label: 'Mary or John', text: 'When Mary and John went to the store, John gave a drink to', answer: ' Mary', foil: ' John' },
  { label: 'Alice or Bob', text: 'When Alice and Bob went to the park, Bob handed a ball to', answer: ' Alice', foil: ' Bob' },
  { label: 'Paris or London', text: 'The Eiffel Tower is in the city of', answer: ' Paris', foil: ' London' },
  { label: 'Counting', text: 'one, two, three, four,', answer: ' five', foil: ' six' },
];

export function mount(el, meta, api) {
  const P = api.params, life = { dead: false };
  const st = { text: P.text ?? EXAMPLES[0].text, answer: P.answer ?? EXAMPLES[0].answer, foil: P.foil ?? EXAMPLES[0].foil, pick: null };
  const page = toolPage(el, meta, TEACH);
  const save = debounce(() => api.setParams({ text: st.text, answer: st.answer, foil: st.foil || null }), 400);
  const count = h('span'), warn = h('div.small.muted');
  const ta = textArea(st.text, { rows: 2, oninput: (e) => { st.text = e.target.value; save(); go(); } });
  const aIn = textInput(st.answer, { oninput: (e) => { st.answer = e.target.value; save(); go(); } });
  const fIn = textInput(st.foil, { placeholder: 'optional', oninput: (e) => { st.foil = e.target.value; save(); go(); } });
  put(page.controls,
    field('Your text', ta, count),
    presets(EXAMPLES, (x) => { ta.value = st.text = x.text; aIn.value = st.answer = x.answer; fIn.value = st.foil = x.foil; save(); go.now(); }),
    h('div.fields.two', { style: { marginTop: '10px' } }, field('Answer (with its leading space)', aIn), field('Foil: the wrong answer to compare against', fIn)),
    warn);

  const tiles = h('div.stats'), check = h('p.small'), line = h('div'), headGrid = h('div'), pickBox = h('div.small', { style: { minHeight: '2.4em' } });
  const top = h('div'), neurons = h('div');
  put(page.result, tiles, check,
    h('div.subhead', null, h('h3', null, 'Where the answer gets written'), h('span.small.muted', null, 'the running total, from the embedding up')), line,
    h('div.res-cols', null,
      h('div', null, h('h3', null, 'Every head'), headGrid, pickBox),
      h('div', null, h('h3', null, 'The biggest pieces'), top)),
    h('div.subhead', null, h('h3', null, 'The neurons that wrote most'), h('span.small.muted', null, 'tap one to open it in the neuron explorer')), neurons);

  const go = debounce(async () => {
    const text = st.text;
    if (!text.trim() || !st.answer) return;
    try {
      const t = await engine.tok(text);
      count.textContent = `${t.ids.length - 1} tokens`;
      const a = await engine.token(st.answer), b = st.foil ? await engine.token(st.foil) : null;
      const w = [a, b].filter((x) => x && x.n > 1).map((x) => `"${x.pieces.join('')}" is ${x.n} tokens; its first, ${JSON.stringify(x.pieces[0])}, is scored`);
      put(warn, w.join('. '));
      page.result.classList.add('busy');
      const r = await engine.recipe('dla', { ids: t.ids, a: a.id, b: b ? b.id : null, neurons: 12 }, { channel: 'dla' });
      if (life.dead || text !== st.text) return;
      draw(r, a, b, t);
    } catch (e) {
      if (!/cancelled/.test(String(e && e.message))) put(tiles, h('p.err', null, String(e.message || e)));
    } finally { page.result.classList.remove('busy'); }
  }, 350);

  function draw(r, a, b, t) {
    const name = b ? `${tokText(a.piece)} minus ${tokText(b.piece)}` : `the logit of ${tokText(a.piece)}`;
    put(tiles,
      stat(b ? 'Logit difference' : 'Logit', signed(r.actual), name),
      stat(`Chance of ${tokText(a.piece)}`, pc(r.probs[0]), `${CFG.short}'s ${ordinal(r.ranks[0] + 1)} choice`),
      b ? stat(`Chance of ${tokText(b.piece)}`, pc(r.probs[1]), `its ${ordinal(r.ranks[1] + 1)} choice`) : null);
    put(check, `The pieces below add up to ${signed(r.sum)}; the model's own ${b ? 'logit difference' : 'logit'} is ${signed(r.actual)} (they differ by ${fmt(Math.abs(r.sum - r.actual), 4)}, rounding error).`);

    /* the running total */
    const gpt2 = onGPT2(), L = CFG.L, mix = (l) => (isAttn(l) ? 'attention' : 'DeltaNet');
    const start = r.embed + r.posEmbed + r.constant;
    const pts = [[0, start]], steps = [{ name: gpt2 ? 'start: embeddings and ln_f bias' : 'start: the token\'s embedding', v: start }];
    let run = start;
    for (let l = 0; l < L; l++) {
      let at = r.attnBias[l];
      for (let x = 0; x < nHeads(l); x++) at += r.heads[hix(l, x)];
      run += at; pts.push([2 * l + 1, run]); steps.push({ name: `layer ${l} ${mix(l)} (${nHeads(l)} heads)`, v: at });
      run += r.mlp[l]; pts.push([2 * l + 2, run]); steps.push({ name: `layer ${l} MLP`, v: r.mlp[l] });
    }
    const every = L > 12 ? 4 : 1;
    lineChart(line, { height: 210, legend: false,
      x: { label: gpt2 ? 'up through the model (each layer: attention, then MLP)' : 'up through the model (each layer: attention or DeltaNet, then MLP)',
        fmt: (v) => (v === 0 ? 'start' : v % 2 ? `L${(v - 1) / 2} ${gpt2 ? 'attn' : mix((v - 1) / 2)}` : `L${v / 2 - 1}`),
        ticks: [...Array(L + 1).keys()].filter((i) => i % every === 0 || i === L).map((i) => 2 * i) },
      y: { label: 'logits' }, hlines: [{ y: 0 }],
      series: [{ name: 'running total', color: col('s1'), pts }],
      tipExtra: (v) => h('div.tip-sub', null, `${steps[v].name}: ${signed(steps[v].v)}`) });

    /* heads */
    const m = absMax(r.heads);
    const choose = (l, x) => {
      if (x >= nHeads(l)) return;
      st.pick = [l, x];
      const v = r.heads[hix(l, x)];
      put(pickBox, h('b', null, `L${l}H${x}`), gpt2 ? '' : ` (${mix(l)})`, ` wrote ${signed(v)} logits directly${v > 0 ? ` towards ${tokText(a.piece)}` : b ? ` towards ${tokText(b.piece)}` : ''}. `,
        isAttn(l) ? [toolLink('attention', { text: st.text, layer: l, head: x }, 'Where does it look?'), ' · ',
          toolLink('ov', { layer: l, head: x, tokens: [a.piece, b && b.piece].filter(Boolean).map((s) => s.trim()).join(', ') }, 'What does it write?'), ' · '] : null,
        toolLink('ablate', { text: st.text, answer: st.answer, foil: st.foil }, 'Knock heads out'));
    };
    grid(headGrid, {
      rows: L, cols: CFG.H, cell: 40, minCell: L > 12 ? 16 : 22, aspect: 0.75, scale: 'div', max: m, fmt: (v) => fmt(v, 1),
      value: (l, x) => r.heads[hix(l, x)],
      text: (l, x) => { const v = r.heads[hix(l, x)]; return Math.abs(v) >= 0.3 * m ? fmt(v, 1) : ''; },
      rowLabels: [...Array(L).keys()].map((l) => 'L' + l), colLabels: [...Array(CFG.H).keys()].map((x) => 'H' + x),
      loLabel: b ? `for ${tokText(b.piece)}` : 'down', hiLabel: `for ${tokText(a.piece)}`,
      selected: st.pick,
      tip: (l, x) => (x >= nHeads(l) ? [h('div', null, `Layer ${l} has ${nHeads(l)} heads.`)] : [h('div.tip-head', null, `L${l}H${x}`, gpt2 ? '' : ` · ${mix(l)}`), tipRow(signed(r.heads[hix(l, x)]), 'logits, written directly')]),
      onPick: choose,
      caption: gpt2 ? 'Rows: layers 0 (top) to 11. Columns: heads. Blue: pushes towards the answer. Red: towards the foil.'
        : `Rows: layers 0 (top) to ${L - 1}. Columns: heads; attention layers (${CFG.attnLayers.join(', ')}) have ${nHeads(CFG.attnLayers[0])}, so their rows stop halfway. Blue: pushes towards the answer. Red: towards the foil.`,
    });
    if (st.pick) choose(...st.pick);
    else put(pickBox, h('span.muted', null, 'Tap a head for links to look at it more closely.'));

    /* the biggest pieces of any kind */
    const all = [{ label: 'token embedding', value: r.embed }];
    if (gpt2) all.push({ label: 'position embedding', value: r.posEmbed }, { label: 'final norm bias', value: r.constant, title: 'The final layer norm\'s bias: a constant, the same for every prompt' });
    for (let l = 0; l < L; l++) {
      all.push({ label: `L${l} MLP`, value: r.mlp[l] });
      for (let x = 0; x < nHeads(l); x++) all.push({ label: `L${l}H${x}`, value: r.heads[hix(l, x)] });
    }
    all.sort((u, v) => Math.abs(v.value) - Math.abs(u.value));
    bars(top, { items: all.slice(0, 12), signed: true, fmtv: signed });

    /* neurons */
    const link = ([i, v]) => {
      const l = Math.floor(i / CFG.M), n = i % CFG.M;
      return h('a.bar-row', { href: `#tool/neurons?layer=${l}&neuron=${n}&text=${encodeURIComponent(st.text)}`, style: { textDecoration: 'none' }, title: 'Open in the neuron explorer' },
        h('span.bar-label', null, `L${l} N${n}`), h('span.bar-val', null, signed(v)), h('span.bar-note', null, '→'));
    };
    put(neurons, h('div.res-cols', null,
      h('div', null, h('div.small-caps', null, `Towards ${tokText(a.piece)}`), h('div.bars', null, r.neuronsUp.slice(0, 8).map(link))),
      h('div', null, h('div.small-caps', null, b ? `Towards ${tokText(b.piece)}` : 'Against it'), h('div.bars', null, r.neuronsDown.slice(0, 8).map(link)))));
  }

  whenReady(page, life, () => go.now());
  return { destroy() { life.dead = true; } };
}

function signed(x) { return (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(2); }
function pc(p) { return p >= 0.1 ? (100 * p).toFixed(0) + '%' : p >= 0.001 ? (100 * p).toFixed(1) + '%' : (100 * p).toPrecision(1) + '%'; }
