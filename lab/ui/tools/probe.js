/* lab/ui/tools/probe.js: linear probes at every layer. Is a property of a sentence written as a straight line in
   GPT-2's residual stream, and from which layer? Two probes per layer (logistic regression and the difference of class
   means), cross-validated so every sentence is scored by a probe that never saw it, against the same probe trained and
   scored on labels that mean nothing. The statistics live in lab/core/probes.js. */

import { h, mount as put, debounce, fmt, pct } from '../dom.js';
import { toolPage, field, textArea, select, presets, runner, whenReady, LAYERS, memo } from './kit.js';
import { engine, isGPU } from '../engine.js';
import { lineChart, scatter, stat, col } from '../charts.js';
import { PRESETS } from '../missions.js';
import { probeAll, wilson, FOLDS, SHUFFLES, LAMBDA } from '../../core/probes.js';

const L = 12;

const TEACH = {
  what: {
    1: `<p>A probe asks a yes-or-no question of the model's insides: is a property, such as "this sentence is true",
written somewhere you can read with one straight cut? Show GPT-2 labelled sentences, record its inner state at every
layer, and see whether a straight line separates the two labels on sentences the probe has not seen.</p>
<p>The control: shuffle the labels and try again. With 768 numbers to play with, a probe can find patterns that are
not there, and the shuffled run shows how well it does when there is nothing to find.</p>`,
    2: `<p>At each layer every sentence becomes one vector: the residual stream at its last token, or averaged over its
tokens. Two probes: logistic regression on standardised features (the best straight line) and the difference of class
means (the simplest line, often the more causal one; Marks and Tegmark, 2023). Accuracy is cross-validated, so every
sentence is scored by a probe that never saw it. The control trains and scores the same probe on shuffled labels.</p>
<div data-angle="analogy"><p>A metal detector swept over a beach, one layer of sand at a time. A beep over ground
you have not dug yet means something is buried there. But a sensitive detector also beeps at bottle caps, so you sweep
a patch where you scattered the "treasure" labels at random: how often it beeps there is how often it beeps at
nothing.</p></div>`,
    3: `<p>Logistic: L2-regularised (λ = ${LAMBDA}) on z-scored features, fitted in its dual by Newton's method (there are far
fewer sentences than dimensions), ${FOLDS}-fold cross-validation. When both lists have the same length, line i on each
side is a matched pair and the pair is held out together, so no sentence is tested against a twin it trained on.
Difference of means: d = μ<sub>+</sub> − μ<sub>−</sub>, threshold at the midpoint of the projected means. Control,
${SHUFFLES} runs per layer: the same procedure on labels that mean nothing, scored against those labels (matched pairs: each
pair's two labels swapped at random, which keeps every training fold balanced; otherwise all labels permuted and the
folds re-stratified). A null that is not balanced the same way scores below 50% and makes the real probe look better
than it is. "Readable from" is the first layer whose accuracy beats every one of the ${SHUFFLES * L} control runs and whose
Wilson 95% interval sits above a coin flip. PCA: the top two eigenvectors of the centred Gram matrix.</p>`,
  },
  read: {
    1: `<p>The blue line is how often the probe is right on sentences it never saw, layer by layer. The gray band is the
same probe trained on shuffled labels; the thin line at 50% is a coin flip. A property is readable where blue rises clearly
above gray.</p>`,
    2: `<p>Orange is the difference-of-means probe: when it nearly matches blue, the property is a simple direction rather
than a pattern only an optimiser can find. The light blue band is the 95% interval for blue at this sample size. Below
the chart, the sentences at one layer, flattened onto their two directions of greatest spread; hollow dots are the
sentences the probe got wrong when they were held out.</p>`,
    3: `<p>A few dozen sentences make the intervals wide, and early layers often separate two sets by their words alone
(city names, punctuation). A probe that works at layer 0 is reading the words, not a concept. Accuracy well below a coin
flip is a clue too: something flips between training and testing, such as a word that sits on one side in the training
folds and on the other in the test fold. Readable is not the same as used: a probe shows the information is there,
and steering is how to test whether the model acts on it.</p>`,
  },
  why: {
    1: `<p>Probes are the cheapest test of whether a model represents something at all, and they are how monitors work:
read one direction, and raise a flag when it moves.</p>`,
    2: `<p>The linear representation hypothesis (concepts are directions) rests on probes and steering together. Probes
found truth directions (Marks and Tegmark, 2023) and the board in Othello-GPT (Nanda et al., 2023); week 11 turns one
into a persona monitor.</p>`,
    3: `<p>Known traps: a probe can learn the dataset instead of the concept (control tasks, Hewitt and Liang, 2019), surface
tokens can do all the work, and an accurate probe direction need not be the one the model uses (difference-of-means
directions tend to steer better than logistic ones).</p>`,
  },
};

export function mount(el, meta, api) {
  const P = api.params, life = { dead: false };
  const id = PRESETS.probe[P.preset] ? P.preset : 'cities';
  const p0 = PRESETS.probe[id];
  const st = { preset: id, pos: p0.pos.join('\n'), neg: p0.neg.join('\n'), posName: p0.posName, negName: p0.negName, pool: p0.pool, show: null, res: null };
  const page = toolPage(el, meta, TEACH);
  const save = debounce(() => api.setParams({ preset: st.preset }), 300);
  const posIn = textArea(st.pos, { rows: 5, oninput: (e) => { st.pos = e.target.value; st.preset = null; save(); } });
  const negIn = textArea(st.neg, { rows: 5, oninput: (e) => { st.neg = e.target.value; st.preset = null; save(); } });
  const posLab = h('span'), negLab = h('span');
  const poolSel = select([['last', 'its last token'], ['mean', 'the average over its tokens']], st.pool, (v) => { st.pool = v; });
  const slot = h('div');
  const run = runner('Probe every layer', slot, (onP, ctl) => compute(onP, ctl));
  const labels = () => { posLab.textContent = `Sentences labelled "${st.posName}", one per line`; negLab.textContent = `Sentences labelled "${st.negName}"`; };
  labels();
  put(page.controls,
    presets(Object.entries(PRESETS.probe).map(([k, x]) => ({ id: k, label: x.label })), (x) => {
      const q = PRESETS.probe[x.id];
      Object.assign(st, { preset: x.id, pos: q.pos.join('\n'), neg: q.neg.join('\n'), posName: q.posName, negName: q.negName, pool: q.pool });
      posIn.value = st.pos; negIn.value = st.neg; poolSel.value = st.pool; labels(); save();
    }),
    h('div.fields.two', { style: { marginTop: '10px' } }, h('label.field', null, posLab, posIn), h('label.field', null, negLab, negIn)),
    h('div', { style: { marginTop: '10px' } }, field('Read each sentence at', poolSel)),
    h('div.row', { style: { marginTop: '10px' } }, run.btn, h('span.small.muted', null, isGPU() ? 'A few seconds.' : 'Under a minute on a processor; it can run while you read.')),
    slot);

  const tiles = h('div.stats'), chart = h('div'), pcaCtl = h('div.row'), pcaBox = h('div'), note = h('p.small');
  put(page.result, tiles, chart, note,
    h('div.subhead', null, h('h3', null, 'Your sentences at one layer'), h('span.small.muted', null, 'flattened onto their two directions of greatest spread')),
    pcaCtl, pcaBox);

  async function compute(onP, ctl) {
    const pos = lines(st.pos), neg = lines(st.neg);
    if (pos.length < 4 || neg.length < 4) throw new Error('Give at least four sentences on each side, one per line.');
    const texts = [...pos, ...neg], y = texts.map((_, i) => (i < pos.length ? 1 : 0));
    const key = ['probe', st.pool, pos.join('\u0001'), neg.join('\u0001')].join('|');
    let X = memo.get(key);
    if (!X) {
      const ids = [];
      for (const s of texts) ids.push((await engine.tok(s)).ids);
      const r = await ctl.track(engine.recipe('residuals', { texts: ids, hook: 'resid_post', pos: st.pool },
        { onProgress: (x) => onP(x.done, x.total + 1, `Reading sentence ${x.done} of ${x.total}`) }));
      X = r.vecs;
      memo.set(key, X);
    }
    if (life.dead) return;
    onP(texts.length, texts.length + 1, 'Fitting probes at every layer…');
    await new Promise((r) => setTimeout(r, 30));
    st.res = probeAll(X, y, texts.length, pos.length === neg.length);
    st.res.texts = texts; st.res.y = y; st.res.paired = pos.length === neg.length;
    st.show = st.res.best;
    draw();
  }

  function draw() {
    const R = st.res, n = R.n;
    const floor = Math.max(...R.layers.map((x) => x.shufMax));
    const from = R.layers.findIndex((x) => x.acc > floor && wilson(x.acc, n)[0] > 0.5);
    const b = R.layers[R.best], nullMean = R.layers.reduce((u, x) => u + x.shufMean, 0) / L;
    put(tiles,
      stat('Best layer', `layer ${R.best}`, `${pct(b.acc)} of held-out sentences right (difference of means ${pct(b.dm)})`),
      stat('Readable from', from < 0 ? 'not shown' : `layer ${from}`, from < 0 ? `no layer beats every shuffled run (best ${pct(floor)}) at this sample size` : `the first layer that beats every shuffled run (best ${pct(floor)})`),
      stat('Shuffled labels', pct(nullMean), `average of ${SHUFFLES * L} runs on meaningless labels; best run ${pct(floor)}`));
    const xs = R.layers.map((_, l) => l);
    lineChart(chart, { height: 250,
      x: { label: 'layer', fmt: (v) => 'L' + v, ticks: xs },
      y: { label: 'held-out accuracy', min: 0, max: 1, fmt: (v) => pct(v) },
      hlines: [{ y: 0.5, label: 'coin flip' }],
      series: [
        { name: `shuffled labels, same probe (range of ${SHUFFLES})`, color: col('ctrl'), band: R.layers.map((x, l) => [l, x.shufMin, x.shufMax]), muted: true },
        { name: 'difference of means', color: col('s2'), pts: R.layers.map((x, l) => [l, x.dm]) },
        { name: 'logistic probe (95% interval shaded)', color: col('s1'), pts: R.layers.map((x, l) => [l, x.acc]), band: R.layers.map((x, l) => [l, ...wilson(x.acc, n)]) },
      ],
      caption: `${n} sentences (${R.y.filter((v) => v).length} "${st.posName}", ${R.y.filter((v) => !v).length} "${st.negName}"), ${FOLDS}-fold cross-validation${R.paired ? ' with line i on each side held out together as a pair' : ''}, each read at ${st.pool === 'last' ? 'its last token' : 'the average over its tokens'} of the residual stream after each layer.` });
    const low = R.layers.map((x, l) => (wilson(x.acc, n)[1] < 0.5 ? l : -1)).filter((l) => l >= 0), l0 = R.layers[0];
    put(note, b.acc - floor < 0.1 ? 'Close to the shuffled control: at this sample size the probe cannot tell this property from noise. More sentences, or a sharper contrast, would.'
      : low.length ? `Worse than a coin flip at ${low.length > 1 ? 'layers' : 'layer'} ${low.join(', ')}: the probe found something that flips between the sentences it trained on and the ones it was tested on, such as a word that sits on one side in training and on the other in testing. Below chance is a clue about your sentences, not noise.`
      : wilson(l0.acc, n)[0] > 0.5 ? `Layer 0 already gets ${pct(l0.acc)} right, after a single block: the two sets probably differ in their words. Try sentences that share their words and differ only in the property, as the city facts do.` : '');
    const lSel = select(LAYERS, st.show, (v) => { st.show = Number(v); drawPCA(); });
    put(pcaCtl, field('Layer', lSel));
    drawPCA();
  }

  function drawPCA() {
    const R = st.res, l = st.show, pc = R.layers[l].pca;
    scatter(pcaBox, { height: 280,
      classes: [{ name: st.posName, color: col('s1') }, { name: st.negName, color: col('s2') }],
      points: R.texts.map((t, i) => ({ x: pc.coords[i][0], y: pc.coords[i][1], c: R.y[i] ? 0 : 1, hollow: !R.layers[l].right[i],
        label: t, hollowNote: 'the logistic probe got this one wrong when it was held out' })),
      x: { label: `first direction (${pct(pc.ratio[0])} of the spread)`, fmt: (v) => fmt(v, 0) },
      y: { label: `second (${pct(pc.ratio[1])})`, fmt: (v) => fmt(v, 0) },
      caption: `Layer ${l}. Filled: the logistic probe was right about it when it was held out; hollow: wrong. The probe's own line is usually not one of these two directions.` });
  }

  whenReady(page, life, () => {});
  return { destroy() { life.dead = true; } };
}

function lines(s) { return String(s || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 64); }
