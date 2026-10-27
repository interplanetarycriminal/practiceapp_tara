/* lab/ui/tools/neurons.js: the neuron explorer. Which of GPT-2's 36,864 MLP neurons fire on your text and, for any one
   of them: where it fires (on your text, and in the passages of a large corpus where it fires hardest), what it
   writes (its logit lens), which neurons it is wired to, fires with, and pushed it on your text, and what pushing it
   does to the next word and to what GPT-2 writes, beside random pushes of the same size; plus a search for the
   neurons behind a word. The card follows Lyra's neuron-explorer (github.com/lyramakesmusic/neuron-explorer),
   reimplemented for GPT-2 in the browser; the wiring and the push test run live (lab/core/recipes.js: neuronLinks,
   neuronPush, lensSearch), the corpus views read the GPU precompute's files (lab/ui/corpus.js). */

import { h, mount as put, tokText, debounce, fmt, pct } from '../dom.js';
import { toolPage, field, textArea, textInput, select, slider, presets, runner, whenReady, LAYERS, intParam, numParam, tk, wordForms } from './kit.js';
import { engine } from '../engine.js';
import { tokens as strip, bars, stat, tipRow, intervals, progress } from '../charts.js';
import { randomUnit } from '../../core/recipes.js';
import { topk } from '../../core/gpt2.js';
import * as corpus from '../corpus.js';
import { examplesView, histView, steerView, sweepView, sweepScores } from '../corpusviews.js';

const M = 3072, MAXT = 128, LIST = 16;

const TEACH = {
  what: {
    1: `<p>Each of GPT-2's 12 layers has a block of 3,072 <b>neurons</b>, 36,864 in all. At every word, each neuron gives
one number: how strongly the pattern it looks for is present right here. When it fires, it adds its own fixed
direction to the stream, and that nudges what the model says next.</p>
<p>Some neurons are easy to name: one fires on "rain" and pushes weather words. Many are not: they fire on unrelated
things (one fires on both "court" and "win"). That mess is called <b>polysemanticity</b>, and it is why the field
moved on from neurons to sparse autoencoders.</p>`,
    2: `<p>A neuron reads the stream through its input weights w<sub>in</sub> (after the layer norm), passes the sum through
GELU, and writes activation × w<sub>out</sub> back into the stream. This page gives four views of one neuron, each
answering a different question: <b>where it fires</b> (on your text, and in the passages of a large corpus where it
fires hardest or at ordinary strength), <b>what it writes</b> (w<sub>out</sub> read through the unembedding: its direct
effect on the next word), <b>who it talks to</b> (whose input weights line up with its output, which neurons of its
layer fire with it, and which earlier neurons pushed it on your text), and <b>what pushing it does</b> (add more of
w<sub>out</sub> and let every later layer react, on your prompt and in a precomputed sweep beside random pushes).</p>
<div data-angle="analogy"><p>A neuron is a word in an overloaded dictionary. Some words have one meaning
("photosynthesis"); many have several unrelated ones ("bank"). You learn a word from the sentences it turns up in
(where it fires) and from what it does to a sentence (what pushing it does). Polysemantic neurons are the
"bank"s.</p></div>`,
    3: `<p>Activation = GELU(w<sub>in</sub>·LN<sub>2</sub>(x) + b), TransformerLens' <code>blocks.l.mlp.hook_post</code>. The output
lens is W<sub>U</sub>(γ<sub>f</sub> ⊙ centre(w<sub>out</sub>)) at a typical ln_f scale, measured from the vocabulary's mean (a
shift shared by every token is invisible to softmax). Wiring is the direct path: S = centre(w<sub>out,A</sub>)·(γ<sub>2</sub> ⊙
w<sub>in,B</sub>), ranked by the z-score of the cosine within each layer. The push adds dose × the layer's median
residual norm along unit(w<sub>out</sub>) at every position, against random unit directions at the same size.</p>
<p>The corpus views come from the GPU precompute (<code>lab/precompute</code>): per neuron, the 12 contexts with the
highest peak (one example per context) and 6 random contexts whose peak falls between 25% and 60% of its maximum,
as 24-token windows; a 16-bin histogram plus "off"; its 16 strongest Pearson co-firing partners in its layer; the
steer lens (dose ±0.8 at every position of four prompts, mean rise in log-probability of the next token); and the
sweep (40 greedy tokens at −0.7, +0.5 and +0.8 on three prompts and +3 from ⟨bos⟩, against 256 random unit
directions per layer).</p>`,
  },
  read: {
    1: `<p>Start with the list: the neurons that fire most on your text. Tap a word to rank the neurons on that word, and
open one. Then ask two questions: what makes it fire, and what does it push? It is clean when the first answer is one
thing, and polysemantic when it fires on several unrelated things (test a guess by changing the text). The two
answers need not match: many late neurons fire where a word is likely to come next, and push that word.</p>
<p>The fastest way to name a neuron is its strongest passages from the corpus: read the outlined words and what
comes just before them. Then check the passages at ordinary strength: a name that only fits the extremes is not the
whole story. To go the other way, from a word to its neurons, use "Find neurons for a word".</p>`,
    2: `<p>The list skips neurons that are on almost everywhere in your text (their average is more than half their peak),
so the ones that pick out particular words come first. Output words are in logits per unit of activation (multiply by the activation to get the
push). Wiring strengths are in standard deviations: 8σ means the pair is far better aligned than the layer's typical
pair. In the push test, KL says how far the prediction moved; the gray dots are random directions pushed just as
hard, so the blue dot means something only when it is clear of them.</p>
<p>The histogram is on a log scale (each gridline is ten times the one below), because most neurons are off on most
tokens and their strong firings are rare. Co-firing is a correlation over the corpus: near 1, the two rise and fall
together. In the sweep, a theme word turns up in the pushed continuations far more often than in the random
pushes' (more than three standard deviations above their rate).</p>`,
    3: `<p>Activations share one scale across layers, although later layers run larger; the layer filter compares within
a layer. The output lens and the wiring are direct paths and ignore attention; the push test includes everything
downstream. Its rises are changes in log-probability among tokens with at least 0.01% probability after the push
(falls: before it), so near-impossible tokens do not top the list.</p>
<p>Corpus passages are 24-token windows cut from 128-token contexts, so "Try it" gives the neuron less context than
it had and the live value can differ a little. The steer lens averages four fixed prompts and the sweep is greedy, so
both sample a neuron's effect rather than exhaust it. The word search by "what it writes" ranks all 36,864 neurons
exactly from the weights; by pushing, it reads each neuron's precomputed top 12 rising tokens.</p>`,
  },
  why: {
    1: `<p>If each neuron meant one thing, reading a model would come down to naming 36,864 neurons. They mostly do not,
and seeing that for yourself is the best reason for what comes next in the course: sparse autoencoders, which find
cleaner features spread across many neurons.</p>`,
    2: `<p>Superposition (Elhage et al., 2022) is the leading explanation: a model can store more features than it has
neurons by giving each feature a direction that is nearly at right angles to the others, at the cost of a little
interference. Week 6's SAEs, transcoders and attribution graphs are all ways of reading those directions, and the
same four views (where it fires, what it writes, who it talks to, what pushing does) carry over unchanged to SAE
features.</p>`,
    3: `<p>Neuron tools in practice: Neuroscope-style max-activating examples, automated neuron explanations (Bills et al.,
2023) and Lyra's neuron-explorer, whose card, push unit (the median residual norm) and random-direction controls this
page reimplements for GPT-2; its wiring z-scores |S|, this page the cosine, so a few neurons with long write vectors
do not top every list. Max-activating examples favour the extreme end of a neuron's range; typical-strength examples
often tell a different story.</p>`,
  },
};

const EXAMPLES = [
  { label: 'Eiffel Tower and rain', text: 'The Eiffel Tower is in Paris. I wrote a short poem about love and rain.' },
  { label: 'Days of the week', text: 'We met on Monday, argued on Tuesday, and made up by Friday.' },
  { label: 'Code', text: 'def add(a, b):\n    return a + b\n\nprint(add(2, 3))' },
  { label: 'A recipe', text: 'Whisk two eggs with a cup of flour, then bake for twenty minutes.' },
];
const PROMPTS = ['I think the most important thing to remember is', 'Today we are going to talk about', 'Once upon a time,', 'The best thing about'];
const BY = [['writes', 'what it writes, directly (all neurons, exact)'], ['steer', 'what pushing it makes likelier'], ['sweep', 'what it makes GPT-2 write when pushed']];

/* what each neuron writes, kept for this visit: gid -> {up, down} */
const LENS = new Map();

export function mount(el, meta, api) {
  const P = api.params, life = { dead: false };
  const hasN = P.layer !== undefined && P.neuron !== undefined;
  const st = {
    text: P.text ?? EXAMPLES[0].text,
    open: hasN ? [intParam(P.layer, 0, 11, 6), intParam(P.neuron, 0, M - 1, 974)] : P.text === undefined ? [6, 974] : null,
    auto: false, at: null, sort: 'stand', only: 'all',
    prompt: PROMPTS[0], dose: numParam(P.dose, -2, 2, 0.8),
    F: null, ids: null, pieces: null, ranked: [], tryAt: null,
    find: P.find || '', by: BY.some(([v]) => v === P.by) ? P.by : 'writes',
  };
  const page = toolPage(el, meta, TEACH);
  const save = debounce(() => api.setParams({ text: st.text, layer: st.open && !st.auto ? st.open[0] : null, neuron: st.open && !st.auto ? st.open[1] : null,
    find: st.find || null, by: st.find && st.by !== 'writes' ? st.by : null }), 400);

  /* ---- controls */
  const count = h('span');
  const ta = textArea(st.text, { rows: 2, oninput: (e) => { st.text = e.target.value; st.at = null; save(); go(); } });
  const lSel = select(LAYERS, st.open ? st.open[0] : 6);
  const nIn = h('input', { type: 'number', min: 0, max: M - 1, step: 1, inputmode: 'numeric', style: { width: '7.5em' } });
  nIn.value = String(st.open ? st.open[1] : 974);
  nIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') openTyped(); });
  const openTyped = () => open(Number(lSel.value), intParam(nIn.value, 0, M - 1, 0));
  const findIn = textInput(st.find, { placeholder: 'a word, such as rain' });
  findIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') find(); });
  const bySel = select(BY, st.by, (v) => { st.by = v; if (findIn.value.trim()) find(); });
  const findOut = h('div');
  put(page.controls,
    field('Your text', ta, count),
    presets(EXAMPLES, (x) => { ta.value = st.text = x.text; st.at = null; save(); go.now(); }),
    h('div.row', { style: { marginTop: '10px', alignItems: 'flex-end' } },
      field('Layer', lSel), field('Neuron, 0 to 3,071', nIn),
      h('button.btn', { type: 'button', onclick: openTyped }, 'Open'),
      h('button.btn', { type: 'button', onclick: () => open(Math.floor(Math.random() * 12), Math.floor(Math.random() * M)) }, 'A random neuron')),
    h('div.find-row', null, field('Or find the neurons for a word', findIn), field('by', bySel),
      h('button.btn', { type: 'button', onclick: () => find() }, 'Find')),
    findOut);
  corpusHave().then((H) => {
    for (const o of bySel.options) if (o.value !== 'writes' && !H[o.value]) { o.disabled = true; o.textContent += ' (after the GPU precompute)'; }
    if (!H[st.by] && st.by !== 'writes') bySel.value = st.by = 'writes';
  });

  /* ---- the list */
  const textStrip = h('div'), list = h('div.picklist'), listNote = h('p.small.muted');
  const sSel = select([['stand', 'most active, skipping neurons that are on almost everywhere'], ['peak', 'most active, all of them']], st.sort, (v) => { st.sort = v; drawList(); });
  const oSel = select([['all', 'every layer'], ...LAYERS], st.only, (v) => { st.only = v; drawList(); });
  const card = h('div');
  put(page.result,
    h('div.subhead', null, h('h3', null, 'Strongest on your text'), h('span.small.muted', null, 'tap a word to rank the neurons on that word')),
    textStrip,
    h('div.row', { style: { marginTop: '8px' } }, field('Rank by', sSel), field('Layers', oSel)),
    list, listNote, card);

  /* ---- the push test: made once, placed into each card */
  const pIn = textInput(st.prompt, { oninput: (e) => { st.prompt = e.target.value; } });
  const doseOut = h('span.small');
  const dose = slider({ min: -2, max: 2, step: 0.1, value: st.dose, oninput: (e) => { st.dose = Number(e.target.value); doseOut.textContent = doseText(); } });
  const pushSlot = h('div'), pushOut = h('div'), genOut = h('div');
  const run = runner('Push it', pushSlot, (onP, ctl) => push(onP, ctl));
  const pushPanel = h('div.panel', null,
    h('div.fields.two', null, field('Prompt', pIn), field('How hard', dose, doseOut)),
    presets([...PROMPTS.map((p) => ({ label: p, text: p })), { label: 'your text', text: null }], (x) => { pIn.value = st.prompt = x.text ?? st.text; }),
    h('div.row', { style: { marginTop: '10px' } }, run.btn, h('span.small.muted', null, 'A few seconds; it also writes three short continuations.')),
    pushSlot);
  function doseText() {
    const [l] = st.open || [0], rn = (engine.status.residNorm || [])[l];
    return `${st.dose > 0 ? '+' : st.dose < 0 ? '−' : ''}${Math.abs(st.dose).toFixed(1)} × the typical size of the stream at layer ${l}${rn ? ` (about ${Math.round(Math.abs(st.dose) * rn)})` : ''}`;
  }

  /* ---- reading the text */
  const go = debounce(async () => {
    const text = st.text;
    if (!text.trim()) return;
    try {
      const t = await engine.tok(text);
      const ids = t.ids.slice(0, MAXT + 1);
      count.textContent = t.ids.length - 1 > MAXT ? `${t.ids.length - 1} tokens; the first ${MAXT} are used` : `${t.ids.length - 1} tokens`;
      page.result.classList.add('busy');
      const F = await engine.recipe('fires', { ids }, { channel: 'neurons-fires' });
      if (life.dead || text !== st.text) return;
      Object.assign(st, { F, ids, pieces: t.pieces.slice(0, ids.length) });
      if (st.tryAt) {                        // a corpus passage: rank on its peak word when it tokenizes the same way
        const w = st.tryAt.tokens;
        if (ids.length === w.length + 1 && w.every((x, i) => x === ids[i + 1])) st.at = st.tryAt.peak + 1;
        st.tryAt = null;
      }
      drawText();
      drawList();
      if (!st.open || st.auto) { const top = st.ranked[0]; if (top) { st.open = [top.l, top.n]; st.auto = true; } }
      if (st.open) drawCard();
    } catch (e) {
      if (!/cancelled/.test(String(e && e.message))) put(listNote, h('span.err', null, String(e.message || e)));
    } finally { page.result.classList.remove('busy'); }
  }, 400);

  function drawText() {
    strip(textStrip, { pieces: st.pieces, values: st.pieces.map(() => NaN), skip: new Set([0]), selected: st.at ?? undefined,
      onPick: (t) => { if (t === 0) return; st.at = st.at === t ? null : t; drawText(); drawList(); if (st.open) drawCard(); } });
  }

  /* rank every neuron (or one layer's) by its activation on the chosen word, or at its peak */
  function rank() {
    const F = st.F, T = F.T, A = F.acts, at = st.at;
    const layers = st.only === 'all' ? [...Array(12).keys()] : [Number(st.only)];
    const score = new Float32Array(layers.length * M).fill(-Infinity), info = [];
    layers.forEach((l, li) => {
      for (let n = 0; n < M; n++) {
        let sum = 0, peak = -Infinity, pt = 1;
        for (let t = 1; t < T; t++) { const v = A[l * T * M + t * M + n]; sum += v; if (v > peak) { peak = v; pt = t; } }
        const t0 = at ?? pt, a = A[l * T * M + t0 * M + n], mean = sum / Math.max(1, T - 1);
        score[li * M + n] = st.sort === 'stand' && T > 4 && mean > 0.5 * a ? -Infinity : a;
      }
    });
    for (const i of topk(score, LIST)) {
      const l = layers[Math.floor(i / M)], n = i % M;
      let pt = 1, on = 0, peak = -Infinity;
      for (let t = 1; t < T; t++) { const v = A[l * T * M + t * M + n]; if (v > peak) { peak = v; pt = t; } }
      for (let t = 1; t < T; t++) if (A[l * T * M + t * M + n] > Math.max(0.1, 0.5 * peak)) on++;
      const t0 = at ?? pt;
      info.push({ l, n, t: t0, act: A[l * T * M + t0 * M + n], on });
    }
    return info;
  }

  function drawList() {
    if (!st.F) return;
    st.ranked = rank();
    const T = st.F.T;
    const rows = st.ranked.map((x) => {
      const hint = h('span.hint', null, hintText(x.l * M + x.n));
      const b = h('button', { type: 'button', 'aria-pressed': isOpen(x.l, x.n) ? 'true' : 'false', onclick: () => open(x.l, x.n) },
        h('span.k', null, `L${x.l} N${x.n}`), hint, h('span.v', null, fmt(x.act, 2), ' on ', tk(st.pieces[x.t])));
      b.dataset.gid = String(x.l * M + x.n);
      b.title = `fires above half its peak on ${x.on} of ${T - 1} tokens`;
      return { b, hint, gid: x.l * M + x.n };
    });
    put(list, rows.map((r) => r.b));
    const skip = st.sort === 'stand' && T > 4 ? ' Skipped: neurons whose average on this text is more than half of that, which are on almost everywhere.' : '';
    put(listNote, st.at !== null ? ['Ranked by how strongly each fires on ', tk(st.pieces[st.at]), '; tap the word again for the whole text.', skip]
      : ['Ranked by each neuron\'s peak activation on this text.', skip]);
    lensFor(rows.map((r) => r.gid)).then(() => { if (!life.dead) for (const r of rows) r.hint.textContent = hintText(r.gid); });
  }

  const isOpen = (l, n) => !!st.open && st.open[0] === l && st.open[1] === n;

  function open(l, n) {
    if (run.busy) run.go();                 // a push still running for the last neuron: stop it
    st.open = [l, n]; st.auto = false;
    lSel.value = String(l); nIn.value = String(n);
    save();
    for (const b of list.querySelectorAll('button[data-gid]')) b.setAttribute('aria-pressed', b.dataset.gid === String(l * M + n) ? 'true' : 'false');
    put(pushOut); put(genOut);
    drawCard();
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---- one neuron */
  let cardSeq = 0;
  async function drawCard() {
    if (!st.F || !st.open) return;
    const seq = ++cardSeq, [l, n] = st.open, gid = l * M + n, F = st.F, T = F.T;
    const acts = Array.from({ length: T }, (_, t) => F.acts[l * T * M + t * M + n]);
    let pt = 1;
    for (let t = 1; t < T; t++) if (acts[t] > acts[pt]) pt = t;
    const peak = acts[pt], at = st.at ?? pt;
    let on = 0;
    for (let t = 1; t < T; t++) if (acts[t] > Math.max(0.1, 0.5 * peak)) on++;
    const tiles = h('div.stats'), actStrip = h('div'), writes = h('div'), feeds = h('div'), fedBy = h('div'), pushed = h('div');
    const slot = { tile: h('div.stat', { hidden: true }), examples: h('div'), cofire: h('div'), steer: h('div'), sweep: h('div') };
    doseOut.textContent = doseText();
    put(card,
      h('div.subhead', null, h('h2', { style: { margin: '0' } }, `Layer ${l}, neuron ${n}`), h('span.small.muted', null, `L${l} N${n} · one of 36,864`)),
      tiles,
      h('div.small-caps', { style: { marginTop: '8px' } }, 'Where it fires on your text'), actStrip,
      slot.examples,
      h('div.res-cols', { style: { marginTop: '10px' } },
        h('div', null, h('h3', null, 'What it writes'), writes),
        h('div', null, h('h3', null, 'Who it talks to'),
          h('div.small-caps', null, 'Feeds: later neurons it pushes'), feeds,
          h('div.small-caps', { style: { marginTop: '10px' } }, 'Fed by: earlier neurons that push it'), fedBy, slot.cofire)),
      pushed,
      h('div.subhead', null, h('h3', null, 'What pushing it does'), h('span.small.muted', null, 'everything after this layer reacts; random pushes of the same size are the control')),
      slot.steer,
      h('div.small-caps', { style: { marginTop: '12px' } }, 'On a prompt of your choosing'),
      pushPanel, pushOut, genOut,
      slot.sweep);
    drawCorpus(seq, l, n, peak, slot);

    strip(actStrip, { pieces: st.pieces, values: acts.map((v) => Math.max(0, v)), scale: 'seq', max: Math.max(0.5, peak), skip: new Set([0]), selected: st.at ?? undefined,
      tip: (t) => [h('div.tip-head', null, tokText(st.pieces[t])), tipRow(fmt(acts[t], 2), t === pt ? 'activation, its peak on this text' : 'activation'),
        acts[t] < 0 ? h('div.tip-sub', null, 'GELU lets a neuron go slightly negative (down to −0.17); shown as off') : null],
      onPick: (t) => { if (t === 0) return; st.at = st.at === t ? null : t; drawText(); drawList(); drawCard(); } });

    await lensFor([gid]);
    if (seq !== cardSeq || life.dead) return;
    const lens = LENS.get(gid), names = await vocabOf([...lens.up, ...lens.down].map((x) => x[0]));
    put(tiles,
      stat('Peak on your text', fmt(peak, 2), ['on ', tokText(st.pieces[pt])]),
      stat('Fires on', `${on} of ${T - 1}`, 'tokens, above half its peak'),
      stat('Pushes most', tokText(names.get(lens.up[0][0])), `${signed(lens.up[0][1])} logits per unit, directly`),
      slot.tile);
    bars(writes, { signed: true, fmtv: signed,
      items: [...lens.up.slice(0, 8), ...lens.down.slice(0, 5)].map(([t, v]) => ({ label: tokText(names.get(t)), value: v })),
      caption: `Logits added to each word per unit of activation, through the direct path, at a typical final-layer scale. At its peak here (${fmt(peak, 2)} on ${tokText(st.pieces[pt])}) that is about ${signed(peak * lens.up[0][1])} for ${tokText(names.get(lens.up[0][0]))}.` });

    /* wiring, and who pushed it at the chosen word */
    const prev = new Float32Array(l * M);
    for (let i = 0; i < l; i++) for (let a = 0; a < M; a++) prev[i * M + a] = F.acts[i * T * M + at * M + a];
    const links = await engine.recipe('neuronLinks', { layer: l, neuron: n, k: 6, acts: l ? prev : null, sigma: F.sigma[l * T + at] }, { channel: 'neurons-links' });
    if (seq !== cardSeq || life.dead) return;
    const actAt = (g) => F.acts[Math.floor(g / M) * T * M + at * M + (g % M)];
    const linkRows = (rows, empty) => (rows.length ? h('div.picklist', null, rows.map(([g, z, cos]) => {
      const hint = h('span.hint', null, hintText(g));
      const b = h('button', { type: 'button', onclick: () => open(Math.floor(g / M), g % M),
        title: `cosine ${cos.toFixed(2)} between the write and read directions; fires ${fmt(actAt(g), 2)} on ${tokText(st.pieces[at])}` },
      h('span.k', null, `L${Math.floor(g / M)} N${g % M}`), h('span', { style: { minWidth: '5.6em' } }, cos > 0 ? '▲ excites' : '▼ inhibits'), hint, h('span.v', null, `${z.toFixed(1)}σ`));
      b.hint = hint; b.gid = g;
      return b;
    })) : h('p.small.muted', null, empty));
    const fe = linkRows(links.feeds, 'Nothing: layer 11 is the last.'), fb = linkRows(links.fedBy, 'Nothing: layer 0 reads only the embeddings and attention.');
    put(feeds, fe); put(fedBy, fb);
    lensFor([...links.feeds, ...links.fedBy].map((x) => x[0])).then(() => {
      if (seq !== cardSeq || life.dead) return;
      for (const b of card.querySelectorAll('.picklist button')) if (b.hint) b.hint.textContent = hintText(b.gid);
    });
    if (l && links.pushed && links.pushed.length) {
      const bx = h('div');
      put(pushed, h('div.subhead', null, h('h3', null, ['Who pushed it on ', tk(st.pieces[at])]), h('span.small.muted', null, st.at === null ? 'its peak word; tap another word above' : 'tap another word above')), bx);
      bars(bx, { signed: true, fmtv: signed,
        items: links.pushed.map(([g, c]) => ({ label: `L${Math.floor(g / M)} N${g % M}`, value: c, note: `fires ${fmt(actAt(g), 2)}`, onClick: () => open(Math.floor(g / M), g % M) })),
        caption: `Direct pushes from earlier neurons into this neuron's input on ${tokText(st.pieces[at])}, in units of its pre-activation. All ${(l * M).toLocaleString('en')} earlier neurons together pushed ${signed(links.pushedTotal)}; attention heads, the embeddings and its own bias make up the rest of its input.` });
    } else put(pushed);
  }

  /* ---- the corpus (the GPU precompute, read by lab/ui/corpus.js): passages, histogram, co-firing, steer lens, sweep */
  async function drawCorpus(seq, l, n, peak, slot) {
    const stale = () => seq !== cardSeq || life.dead;
    const H = await corpusHave();
    if (stale()) return;
    if (!H.neurons) {
      put(slot.examples, h('div.card.flat', { style: { marginTop: '12px' } }, h('div.small-caps', null, 'Its strongest passages across a large body of text'),
        h('p.small', { style: { margin: '4px 0 0' } }, 'The usual way to name a neuron is to collect the passages, out of millions, where it fires hardest. A graphics card does that once for all 36,864 neurons in the lab\'s GPU precompute, and its results are not in this copy of the lab yet. Until then the fastest test of a guess is the text box above: write a sentence that should make this neuron fire, and one that should not.')));
      return;
    }
    put(slot.examples, h('p.small.muted', null, 'Loading its passages from the corpus…'));
    let N;
    try { N = await corpus.neuron(l, n); await vocabOf(N.examples.flatMap((x) => x.tokens)); } catch (e) {
      if (!stale()) put(slot.examples, h('p.small.err', null, 'Its corpus passages did not load: ' + (e.message || e)));
      return;
    }
    if (stale()) return;
    const top = N.examples.length ? N.examples[0].value : N.max, exBox = h('div'), histBox = h('div');
    put(slot.examples,
      h('div.subhead', null, h('h3', null, `Where it fires in ${H.size.long}`), h('span.small.muted', null, 'precomputed on a graphics card; "Try it" reads a passage live')),
      exBox, h('div.small-caps', { style: { marginTop: '12px' } }, 'How often it fires, and how hard'), histBox);
    if (N.examples.length) examplesView(exBox, { examples: N.examples, names: PIECES, top, onTry: tryText });
    else put(exBox, h('p.small.muted', null, 'It never fired in the corpus.'));
    histView(histBox, { hist: N.hist, scale: N.scale });
    put(slot.tile, h('div.stat-label', null, 'In the corpus'), h('div.stat-value', null, pct(N.on, N.on < 0.1 ? 1 : 0)),
      h('div.stat-sub', null, `of ${H.size.short} tokens it is on; strongest ${fmt(N.max, 2)}${peak > 0 && N.max > 0 ? ` (your text: ${pct(Math.min(1, peak / N.max))})` : ''}`));
    slot.tile.hidden = false;
    const co = N.cofire.filter(([, r]) => r > 0).slice(0, 6);
    if (co.length) put(slot.cofire, h('div.small-caps', { style: { marginTop: '10px' } }, `Fires with: layer ${l} neurons that rise and fall with it`),
      neuronList(co.map(([m, r]) => ({ gid: l * M + m, v: `r ${r.toFixed(2)}`, title: `correlation ${r.toFixed(2)} between the two across the corpus` }))));
    if (H.steer) {
      const sv = await corpus.steer(l, n).catch(() => null);
      if (sv) await vocabOf([...sv.up, ...sv.down].map(([t]) => t));
      if (stale()) return;
      if (sv) {
        const box = h('div');
        put(slot.steer, h('div.small-caps', null, 'Over four everyday prompts (precomputed)'), box);
        steerView(box, { steer: sv, names: PIECES, l });
      }
    }
    if (H.sweep) {
      const [S, base] = await Promise.all([corpus.sweepLayer(l), corpus.sweepBase()]).catch(() => [null, null]);
      if (stale() || !S || !base || n >= S.N) return;
      await vocabOf([...corpus.rollouts(S, n).flatMap((r) => r.tokens), ...Object.values(base).flatMap((b) => b.tokens)]);
      if (stale()) return;
      const box = h('div');
      put(slot.sweep, h('div.subhead', null, h('h3', null, 'What it makes GPT-2 write'),
        h('span.small.muted', null, `ten pushed continuations, against ${S.C} random pushes (precomputed)`)), box);
      sweepView(box, { S, base, u: n, names: PIECES, unitLabel: `Pushing L${l} N${n}` });
    }
  }

  /* "Try it" on a corpus passage: read it live, ranked on its peak word, with this neuron kept open */
  async function tryText(x, text) {
    ta.value = st.text = text; st.at = null; st.auto = false; st.tryAt = { tokens: x.tokens, peak: x.peak };
    save();
    await go.now();
    if (!life.dead) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* neurons that open on a tap: items [{gid, v, title}] */
  function neuronList(items) {
    const btns = items.map((it) => {
      const hint = h('span.hint', null, hintText(it.gid));
      const b = h('button', { type: 'button', title: it.title, 'aria-pressed': isOpen(Math.floor(it.gid / M), it.gid % M) ? 'true' : 'false',
        onclick: () => open(Math.floor(it.gid / M), it.gid % M) }, h('span.k', null, `L${Math.floor(it.gid / M)} N${it.gid % M}`), hint, h('span.v', null, it.v));
      b.hint = hint; b.gid = it.gid;
      return b;
    });
    lensFor(items.map((it) => it.gid)).then(() => { if (!life.dead) for (const b of btns) b.hint.textContent = hintText(b.gid); }).catch(() => {});
    return h('div.picklist', null, btns);
  }

  /* ---- from a word to its neurons: by what they write (exact, every neuron), or from the precompute by what pushing
     them makes likelier (the steer lens) or makes GPT-2 write (the sweep, against random pushes) */
  let findSeq = 0;
  async function find(pick) {
    const w = findIn.value.replace(/\s+$/, ''), by = bySel.value, seq = ++findSeq;
    st.find = w.trim() ? w : ''; st.by = by; save();
    if (!st.find) { put(findOut); return; }
    if (!engine.ready()) { put(findOut, h('p.small.muted', null, 'The search starts once GPT-2 has loaded (the button at the top).')); return; }
    const stale = () => seq !== findSeq || life.dead, bar = progress(findOut);
    bar.set(0, 'Looking…');
    try {
      const vars = await wordForms(w);
      if (stale()) return;
      if (!vars.length) {
        put(findOut, h('p.small.muted', null, `"${w.trim()}" is more than one token in every form tried (with and without a leading space, with and without a capital), and the search works on single tokens. A shorter or more common word will be one.`));
        return;
      }
      const H = await corpusHave(), want = new Set(vars.map((v) => v.id)), forms = vars.map((v, i) => [i ? ', ' : '', tk(v.piece)]);
      let rows = [], head, note;
      if (by === 'writes') {
        const v = vars[Math.max(0, vars.findIndex((x) => x.id === pick))];
        const r = await engine.recipe('lensSearch', { token: v.id, k: LIST }, { channel: 'neurons-find' });
        if (stale()) return;
        rows = r.up.map(([g, x]) => ({ gid: g, v: signed(x), title: `adds ${signed(x)} logits to ${tokText(v.piece)} per unit of activation, directly` }));
        head = ['The neurons that write ', tk(v.piece), ' most, directly, out of all 36,864'];
        note = ['Logits added per unit of activation (the "What it writes" number on each card), ranked from the weights. Writing a word is not the same as firing on it: open one to see where it fires.',
          vars.length > 1 ? h('span.chips', { style: { display: 'inline-flex', marginLeft: '6px' } }, vars.map((x) => h('button.chip', { type: 'button', 'aria-pressed': x.id === v.id ? 'true' : 'false', onclick: () => find(x.id) }, tokText(x.piece)))) : null];
      } else if (by === 'steer') {
        const best = [];
        for (let l = 0; l < 12; l++) {
          bar.set(l / 12, `Reading the steer lens, layer ${l}…`);
          const S = await corpus.steerLayer(l);
          if (stale()) return;
          if (!S) continue;
          for (let n = 0; n < S.N; n++) {
            let v = 0;
            for (let j = 0; j < S.k; j++) { const o = n * 2 * S.k + j; if (want.has(S.toks[o]) && S.rise[o] > v) v = S.rise[o]; }
            if (v > 0) best.push([l * M + n, v]);
          }
        }
        best.sort((a, b) => b[1] - a[1]);
        const dose = (await corpus.info()).steer.dose;
        rows = best.slice(0, LIST).map(([g, v]) => ({ gid: g, v: '+' + fmt(v, 2), title: `pushing it up by ${dose} raises the log-probability by ${fmt(v, 2)} on average over four prompts` }));
        head = ['Neurons whose push makes ', forms, ' likelier'];
        note = `From the steer lens: each neuron pushed up by ${dose} × the typical size of the stream after its layer, every later layer reacting; the rise in log-probability of the next token, averaged over four prompts. Only each neuron's 12 biggest risers are stored, so a neuron that raises the word a little less is not listed.`;
      } else {
        const best = [];
        let C = 0, R = 0;
        for (let l = 0; l < 12; l++) {
          bar.set(l / 12, `Reading the steering sweep, layer ${l}…`);
          const S = await corpus.sweepLayer(l);
          if (stale()) return;
          if (!S) continue;
          C = S.C; R = S.R;
          const sc = sweepScores(S, [...want]);
          for (let n = 0; n < S.N; n++) if (sc.n[n] >= 2 && sc.z[n] > 3) best.push([l * M + n, sc.z[n], sc.n[n], sc.p]);
          await new Promise((r) => setTimeout(r, 0));
        }
        best.sort((a, b) => b[1] - a[1] || b[2] - a[2]);
        rows = best.slice(0, LIST).map(([g, z, k, p]) => ({ gid: g, v: `${k}/${R}`, title: `in ${k} of its ${R} pushed continuations; random pushes on its layer: ${pct(p, 1)} of theirs (z = ${fmt(z, 1)})` }));
        head = ['Neurons that make GPT-2 write ', forms];
        note = `From the steering sweep: how many of each neuron's ${R} pushed continuations contain the word, against the ${C} random pushes on its layer. Listed only when that is more than three standard deviations above the random rate.`;
      }
      if (stale()) return;
      put(findOut, h('div.small-caps', { style: { marginTop: '10px' } }, head),
        rows.length ? neuronList(rows) : h('p.small.muted', null, by === 'writes' ? 'Nothing found.' : 'No neuron clears the bar for this word.'),
        h('p.small.muted', null, note));
      if (!H[by] && by !== 'writes') put(findOut, h('p.small.muted', null, 'This search needs the GPU precompute\'s results, which are not in this copy of the lab yet.'));
    } catch (e) {
      if (!stale() && !/cancelled/.test(String(e && e.message))) put(findOut, h('p.small.err', null, String(e.message || e)));
    }
  }

  /* ---- the push test */
  async function push(onP, ctl) {
    const [l, n] = st.open, d = st.dose;
    const t = await engine.tok(st.prompt.trim() || PROMPTS[0]);
    const ids = t.ids.slice(0, 64);
    onP(0, 3, 'Pushing it, and four random directions, and reading the next word…');
    const r = await ctl.track(engine.recipe('neuronPush', { ids, layer: l, neuron: n, dose: d, controls: 4 }));
    if (life.dead || !isOpen(l, n)) return;
    const names = await vocabOf([...r.up, ...r.down, ...r.before, ...r.after].map((x) => x[0]));
    const klBox = h('div'), upBox = h('div'), downBox = h('div');
    put(pushOut,
      h('p.small', null, `Next word after "${st.prompt.trim()}". Before: `, r.before.map(([x, p]) => [tk(names.get(x)), ' ', pc(p), '  ']),
        h('br'), 'After the push: ', r.after.map(([x, p]) => [tk(names.get(x)), ' ', pc(p), '  '])),
      klBox,
      h('div.res-cols', null, h('div', null, h('div.small-caps', null, 'Made more likely'), upBox), h('div', null, h('div.small-caps', null, 'Made less likely'), downBox)));
    const lo = Math.min(...r.klCtrl), hi = Math.max(...r.klCtrl);
    intervals(klBox, {
      rows: [{ label: `L${l} N${n}`, est: r.kl, lo: r.kl, hi: r.kl, ctrl: r.klCtrl, note: `${fmt(r.kl, 2)} nats` }],
      x: { label: 'how far the prediction moved (KL divergence, nats)', fmt: (v) => fmt(v, 1), min: 0 },
      ref: 0, estName: 'this neuron', ctrlName: 'random directions, same size',
    });
    klBox.appendChild(h('p.small', null, r.kl > hi ? `Pushing this neuron moves the prediction more than any of the four random pushes (${fmt(lo, 2)} to ${fmt(hi, 2)}).`
      : `A random push of the same size moves the prediction about as much (${fmt(lo, 2)} to ${fmt(hi, 2)}), so the size of the change says little here; what changes, in the lists below, still can.`));
    const item = ([x, dl, p0, p1], col) => ({ label: tokText(names.get(x)), value: Math.abs(dl), color: col, note: `${pc(p0)} → ${pc(p1)}` });
    bars(upBox, { items: r.up.slice(0, 8).map((x) => item(x, 'var(--s1)')), fmtv: (v) => '+' + fmt(v, 1) });
    bars(downBox, { items: r.down.slice(0, 6).map((x) => item(x, 'var(--neg)')), fmtv: (v) => '−' + fmt(v, 1) });
    upBox.appendChild(h('div.chart-cap', null, 'Change in log-probability, nats; then the chance before → after.'));

    /* three greedy continuations: no push, this neuron, one random direction at the same size */
    onP(1, 3, 'Writing three continuations…');
    let s = (l * M + n) * 2654435761 >>> 0;
    const vec = randomUnit(() => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; });
    const rn = (engine.status.residNorm || [])[l] || 100;
    for (let i = 0; i < vec.length; i++) vec[i] *= rn;
    const iv = [{ hook: 'mlp_post', layer: l, neuron: n, op: 'addr', rows: [1], value: d }, { hook: 'mlp_out', layer: l, op: 'add', rows: [2], vec, value: d }];
    const cols = [0, 1, 2].map(() => h('div.gen', null, h('span.prompt', null, st.prompt.trim())));
    put(genOut, h('div.gencol.three', null,
      ['No push', `L${l} N${n} pushed (${d > 0 ? '+' : ''}${d.toFixed(1)})`, 'A random direction, same size'].map((title, i) => h('div', null, h('div.gen-h', null, title), cols[i]))),
    h('p.small.muted', null, 'Greedy (the likeliest word each time), so the only difference between the three is the push.'));
    const N = 24;
    await ctl.track(engine.generate({ prompt: ids, R: 3, maxNew: N, temperature: 0, iv }, (pr) => {
      pr.pieces.forEach((p, i) => cols[i].appendChild(document.createTextNode(p)));
      onP(1 + 2 * (pr.step + 1) / N, 3, 'Writing three continuations…');
    }));
  }

  whenReady(page, life, async () => { await go.now(); if (st.find && !life.dead) find(); });
  return { destroy() { life.dead = true; } };
}

/* ---- the precompute and words */

/* which GPU precompute jobs have run on a real corpus (checked once per visit), and the corpus's size in words */
let HAVE = null;
function corpusHave() {
  if (!HAVE) HAVE = (async () => {
    const [neurons, steer, sweep] = await Promise.all(['neurons', 'steer', 'sweep'].map((k) => corpus.done(k)));
    const s = await corpus.info().catch(() => ({}));
    return { neurons, steer, sweep, size: corpus.size(s) };
  })();
  return HAVE;
}

/* ---- helpers */

async function lensFor(gids) {
  const need = [...new Set(gids)].filter((g) => !LENS.has(g));
  const pk = await peaksReady();
  if (pk) await vocabOf(gids.flatMap((g) => [pk[g * 3], pk[g * 3 + 1], pk[g * 3 + 2]]).filter((t) => t !== 65535));
  if (!need.length) return;
  const r = await engine.recipe('neuronLens', { neurons: need, k: 10 });
  need.forEach((g, i) => LENS.set(g, r.lens[i]));
  await vocabOf(r.lens.flatMap((x) => [...x.up, ...x.down].map((y) => y[0])));
}

/* the peak words of each neuron's three strongest corpus passages (null until the precompute has run) */
let PEAKS = null, peaksP = null;
function peaksReady() {
  if (!peaksP) peaksP = corpusHave().then((H) => (H.neurons ? corpus.neuronPeaks() : null)).then((p) => (PEAKS = p)).catch(() => null);
  return peaksP;
}

const PIECES = new Map();
async function vocabOf(ids) {
  const need = [...new Set(ids)].filter((i) => !PIECES.has(i));
  if (need.length) (await engine.vocab(need)).forEach((p, j) => PIECES.set(need[j], p));
  return PIECES;
}

/* one line per neuron for lists: what it fires on across the corpus (when the precompute has run), then what it writes */
function hintText(gid) {
  const x = LENS.get(gid), word = (t) => { const p = String(PIECES.get(t) ?? '?'); return tokText(p.trim()) || tokText(p); };
  const on = PEAKS ? [...new Set([0, 1, 2].map((q) => PEAKS[gid * 3 + q]).filter((t) => t !== 65535 && PIECES.has(t)))].map(word) : [];
  const wr = x ? x.up.slice(0, on.length ? 2 : 3).map(([t]) => word(t)) : [];
  if (!on.length) return x ? 'writes ' + wr.join(', ') : 'writes …';
  return `fires on ${on.join(', ')}${wr.length ? ' · writes ' + wr.join(', ') : ''}`;
}

function signed(x) { return (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(2); }
function pc(p) { return p >= 0.1 ? (100 * p).toFixed(0) + '%' : p >= 0.001 ? (100 * p).toFixed(1) + '%' : p >= 1e-5 ? (100 * p).toFixed(3) + '%' : '<0.001%'; }
