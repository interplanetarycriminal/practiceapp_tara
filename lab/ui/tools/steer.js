/* lab/ui/tools/steer.js: steering. Build a direction from two sets of sentences (the residual stream's mean on one set
   minus its mean on the other, at one layer), add it while GPT-2 writes, and compare with random directions pushed
   just as hard. Same recipe and units as the bench's steering engine (dose x the layer's median residual norm, at
   every position of resid_post), live on one prompt. */

import { h, mount as put, tokText, debounce, fmt } from '../dom.js';
import { toolPage, field, textArea, textInput, select, slider, presets, runner, whenReady, layerOpts, intParam, numParam, memo, answerToken, CFG, scaleLayer } from './kit.js';
import { engine, isGPU } from '../engine.js';
import { lineChart, bars, stat, col } from '../charts.js';
import { PRESETS } from '../missions.js';
import { randomUnit } from '../../core/recipes.js';

const CONTROLS = 3, NEW = 32, STEPS = CONTROLS + 3;   // progress: sentences, the dial for each direction, writing

const TEACH = {
  what: {
    1: `<p>Some ideas inside GPT-2 point in a direction you can find with nothing but examples. Average its inner state on
happy sentences, subtract its average on angry ones, and the difference is a "happy minus angry" arrow. Add that arrow
while it writes and the writing turns happier; subtract it and it turns darker. No training and no new weights: a dial
you can turn while it runs.</p>
<p>The test that the arrow means something: push in random directions just as hard. They should do much less.</p>`,
    2: `<p>A contrastive steering vector (ActAdd, Turner et al., 2023, in its difference-of-means form): v = mean over set A
of the residual stream at layer l, minus the mean over set B, each sentence averaged over its tokens. Steering adds
dose × the layer's typical stream length along v/‖v‖ at every position. The page measures one number across doses,
the logit difference between a word that fits the trait and one that does not, against random unit directions at
the same doses, and shows what GPT-2 writes with the push on.</p>
<div data-angle="analogy"><p>A mixing desk. Average a recording of a cheerful band and of a sombre one, and the
difference is a "cheer" fader: sliding it changes the mood of any song. Push it too far and the song distorts. Slide
a random fader just as far and you mostly get noise, which is how you know the cheer fader is real.</p></div>`,
    3: `<p>h<sub>l</sub> ← h<sub>l</sub> + α·r̄<sub>l</sub>·v̂ at <code>resid_post[l]</code> for every position, prompt and generated; α
is the dose, r̄<sub>l</sub> the median ‖resid_post[l]‖ on reference text, v̂ = (μ<sub>A</sub> − μ<sub>B</sub>)/‖μ<sub>A</sub> − μ<sub>B</sub>‖
with each sentence's mean over its tokens after ⟨bos⟩. Controls replace v̂ with seeded uniform random unit vectors at
the same α. The lens is W<sub>U</sub>(γ<sub>f</sub> ⊙ centre(v̂)), measured from the vocabulary mean. A library call for your
whole career: steering-vectors, repeng, nnsight and TransformerLens hooks all do this in a few lines.</p>`,
  },
  read: {
    1: `<p>The line is the dial. Left: pushing against the direction. Right: pushing along it. Up: GPT-2 prefers the word
that fits the trait. The gray band is what random pushes of the same size do; a real direction leaves the band
behind. Below the chart, the same push while GPT-2 writes.</p>`,
    2: `<p>Dose 1 is a push as long as a typical stream vector at this layer, which is big: it competes with everything
else in the stream, so expect grammar to bend. The metric is the trait word's logit minus its foil's at the prompt's
last token. The lens lists the words the direction points to directly; for a clean direction they match the
trait.</p>`,
    3: `<p>One prompt and four plus four sentences make this a live sketch, not a result. The bench version uses sixteen
plus sixteen sentences, eight prompts, 95% intervals over prompts and eight random controls, and it measures the cost
as the rise in loss on neutral text. Mean-pooling over tokens is one choice; the last token is another, and they can
disagree.</p>`,
  },
  qwen: `<p>The recipe is the same on Qwen 3.5 9B: the difference of the two sets' average streams at one layer,
added at every position while it writes, in units of that layer's typical stream size. The presets' layers are
GPT-2's, moved to the same relative depth in Qwen's 32 (GPT-2's layer 6 becomes about 17). A dose of 1 is a push as
long as a typical stream at that layer, on either model, so doses compare across the two. Qwen is a chat model, so a
plain prompt may already pull it towards an assistant's voice; the no-push column is the baseline.</p>`,
  why: {
    1: `<p>Steering is how you check that a direction you found does something (a cause, not just a correlation), and it
is one of the cheapest ways to change a model's behaviour at all.</p>`,
    2: `<p>The same recipe builds persona vectors (Chen et al., 2025) and the refusal direction (Arditi et al., 2024:
removing one direction stops a chat model refusing). Week 6 sets it beside RLHF, which changes weights instead; week
10 uses it as a reversible model of "train narrowly, change broadly".</p>`,
    3: `<p>Capstone-sized questions: how linear is the dose response before it breaks, does a direction carry over to
other prompts and layers, and how much of an effect is the direction rather than any large disturbance of the stream
(which is what the random controls bound).</p>`,
  },
};

export function mount(el, meta, api) {
  const P = api.params, life = { dead: false };
  const presetId = PRESETS.steer[P.preset] ? P.preset : 'mood';
  const pr0 = PRESETS.steer[presetId];
  const st = {
    preset: presetId, pos: pr0.pos.join('\n'), neg: pr0.neg.join('\n'),
    layer: intParam(P.layer, 0, CFG.L - 1, scaleLayer(pr0.layer)), prompt: P.prompt ?? pr0.prompt, target: P.target ?? pr0.target, foil: P.foil ?? pr0.foil,
    dose: numParam(P.dose, -3, 3, 0.5),
  };
  const page = toolPage(el, meta, TEACH);
  const save = debounce(() => api.setParams({ preset: st.preset, layer: st.layer, prompt: st.prompt, target: st.target, foil: st.foil, dose: st.dose }), 400);
  const posIn = textArea(st.pos, { rows: 4, oninput: (e) => { st.pos = e.target.value; st.preset = null; save(); } });
  const negIn = textArea(st.neg, { rows: 4, oninput: (e) => { st.neg = e.target.value; st.preset = null; save(); } });
  const lSel = select(layerOpts(), st.layer, (v) => { st.layer = Number(v); save(); doseOut.textContent = doseText(); });
  const pIn = textInput(st.prompt, { oninput: (e) => { st.prompt = e.target.value; save(); } });
  const tIn = textInput(st.target, { oninput: (e) => { st.target = e.target.value; save(); } });
  const fIn = textInput(st.foil, { oninput: (e) => { st.foil = e.target.value; save(); } });
  const doseOut = h('span.small');
  const dose = slider({ min: -3, max: 3, step: 0.1, value: st.dose, oninput: (e) => { st.dose = Number(e.target.value); doseOut.textContent = doseText(); save(); } });
  const warn = h('div.small.muted');
  const slot = h('div');
  const run = runner('Build the direction and push', slot, (onP, ctl) => compute(onP, ctl));
  const choose = (id) => {
    const x = PRESETS.steer[id];
    Object.assign(st, { preset: id, pos: x.pos.join('\n'), neg: x.neg.join('\n'), layer: scaleLayer(x.layer), prompt: x.prompt, target: x.target, foil: x.foil });
    posIn.value = st.pos; negIn.value = st.neg; lSel.value = String(st.layer); pIn.value = st.prompt; tIn.value = st.target; fIn.value = st.foil;
    doseOut.textContent = doseText(); save();
  };
  put(page.controls,
    presets(Object.entries(PRESETS.steer).map(([id, x]) => ({ id, label: x.label })), (x) => choose(x.id)),
    h('div.fields.two', { style: { marginTop: '10px' } },
      field('Sentences with the trait, one per line', posIn), field('Sentences without it', negIn)),
    h('div.fields.three', { style: { marginTop: '10px' } }, field('Layer', lSel), field('A word that fits the trait', tIn), field('Its opposite (the foil)', fIn)),
    h('div', { style: { marginTop: '10px' } }, field('Prompt to write from', pIn)),
    h('div', { style: { marginTop: '10px' } }, field('How hard to push while writing', dose, doseOut)),
    warn,
    h('div.row', { style: { marginTop: '10px' } }, run.btn, h('span.small.muted', null, engine.remote ? 'Seconds on the 3090.' : isGPU() ? 'A few seconds.' : 'Under a minute on a processor; it can run while you read.')),
    slot);
  function doseText() {
    const rn = (engine.status.residNorm || [])[st.layer];
    return `${st.dose > 0 ? '+' : st.dose < 0 ? '−' : ''}${Math.abs(st.dose).toFixed(1)} × the typical length of the stream at layer ${st.layer}${rn ? ` (about ${Math.round(Math.abs(st.dose) * rn)})` : ''}`;
  }
  doseOut.textContent = doseText();

  const tiles = h('div.stats'), curve = h('div'), lensUp = h('div'), lensDown = h('div'), gen = h('div');
  put(page.result, tiles,
    h('div.subhead', null, h('h3', null, 'The dial'), h('span.small.muted', null, 'its effect on one word against another, with random pushes as the control')), curve,
    h('div.subhead', null, h('h3', null, 'What the direction points at'), h('span.small.muted', null, 'read straight through the unembedding')),
    h('div.res-cols', null, h('div', null, h('div.small-caps', null, 'Towards'), lensUp), h('div', null, h('div.small-caps', null, 'Away from'), lensDown)),
    h('div.subhead', null, h('h3', null, 'Writing with the push'), h('span.small.muted', null, 'greedy, so the push is the only difference')), gen);

  async function compute(onP, ctl) {
    const L = st.layer, pos = lines(st.pos), neg = lines(st.neg);
    if (pos.length < 2 || neg.length < 2) throw new Error('Give at least two sentences on each side, one per line.');
    const a = await answerToken(st.target, null), b = await answerToken(st.foil, null);
    put(warn, [a, b].filter((x) => x.n > 1).map((x) => `"${x.pieces.join('')}" is ${x.n} tokens; its first, ${JSON.stringify(x.pieces[0])}, is scored.`).join(' '));
    const tp = await engine.tok(st.prompt.trim() || PRESETS.steer.mood.prompt);
    const ids = tp.ids.slice(0, 96);
    const rn = (engine.status.residNorm || [])[L] || 100;

    /* 1. the direction */
    const key = ['steer-dir', L, pos.join('\u0001'), neg.join('\u0001')].join('|');
    let dir = memo.get(key);
    if (!dir) {
      const texts = [];
      for (const s of [...pos, ...neg]) texts.push((await engine.tok(s)).ids);
      const r = await ctl.track(engine.recipe('residuals', { texts, hook: 'resid_post', pos: 'mean' },
        { onProgress: (x) => onP(x.done / x.total, STEPS, `Reading your sentences: ${x.done} of ${x.total}`) }));
      const D = CFG.D, Lc = CFG.L, v = new Float32Array(D);
      texts.forEach((_, j) => {
        const w = j < pos.length ? 1 / pos.length : -1 / neg.length, o = (j * Lc + L) * D;
        for (let i = 0; i < D; i++) v[i] += w * r.vecs[o + i];
      });
      let n2 = 0;
      for (let i = 0; i < D; i++) n2 += v[i] * v[i];
      const norm = Math.sqrt(n2);
      for (let i = 0; i < D; i++) v[i] /= norm;
      const lens = await ctl.track(engine.recipe('unembedVec', { vec: v, k: 10 }));
      dir = { unit: v, norm, lens };
      memo.set(key, dir);
    }
    if (life.dead) return;
    drawLens(dir.lens);

    /* 2. the dial: the metric across doses, for the direction and for random directions */
    const doses = isGPU() ? [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1] : [-1, -0.5, 0, 0.5, 1];
    const metric = { kind: 'logitdiff', a: a.id, b: b.id, pos: ids.length - 1 };
    let seed = 7;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const dirs = [dir.unit, ...Array.from({ length: CONTROLS }, () => randomUnit(rand, CFG.D))];
    const scaled = dirs.map((u) => u.map((x) => x * rn));
    const vals = [];
    for (let k = 0; k < dirs.length; k++) {
      onP(1 + k, STEPS, k ? `Random direction ${k} of ${CONTROLS}, same doses` : 'Turning the dial');
      const ivs = doses.map((d) => (d === 0 ? [] : [{ hook: 'resid_post', layer: L, op: 'add', vec: scaled[k], value: d }]));
      vals.push((await ctl.track(engine.recipe('metric', { ids, metric, ivs }))).values);
      if (life.dead) return;
    }
    drawCurve(doses, vals, a, b, rn, dir);

    /* 3. writing: no push, along, against, and one random direction, all at the chosen dose */
    const d = st.dose;
    const iv = [
      { hook: 'resid_post', layer: L, op: 'add', vec: scaled[0], value: d, rows: [1] },
      { hook: 'resid_post', layer: L, op: 'add', vec: scaled[0], value: -d, rows: [2] },
      { hook: 'resid_post', layer: L, op: 'add', vec: scaled[1], value: d, rows: [3] },
    ];
    const titles = ['No push', `Along the direction (${signed1(d)})`, `Against it (${signed1(-d)})`, `A random direction (${signed1(d)})`];
    const cols = titles.map(() => h('div.gen', null, h('span.prompt', null, st.prompt.trim())));
    put(gen, h('div.gencol.two', null, titles.map((t, i) => h('div', null, h('div.gen-h', null, t), cols[i]))));
    await ctl.track(engine.generate({ prompt: ids, R: 4, maxNew: NEW, temperature: 0, iv }, (x) => {
      x.pieces.forEach((p, i) => cols[i].appendChild(document.createTextNode(p)));
      onP(STEPS - 1 + (x.step + 1) / NEW, STEPS, 'Writing four continuations…');
    }));
  }

  function drawLens(lens) {
    const names = new Map();
    engine.vocab([...lens.up, ...lens.down].map((x) => x[0])).then((ps) => {
      [...lens.up, ...lens.down].forEach((x, i) => names.set(x[0], ps[i]));
      bars(lensUp, { items: lens.up.map(([t, v]) => ({ label: tokText(names.get(t)), value: v })), fmtv: (v) => '+' + fmt(v, 2) });
      bars(lensDown, { items: lens.down.map(([t, v]) => ({ label: tokText(names.get(t)), value: Math.abs(v), color: 'var(--neg)' })), fmtv: (v) => '−' + fmt(v, 2) });
    });
  }

  function drawCurve(doses, vals, a, b, rn, dir) {
    const real = vals[0], ctrl = vals.slice(1), i0 = doses.indexOf(0), i1 = doses.indexOf(1), im = doses.indexOf(-1);
    const band = doses.map((d, i) => [d, Math.min(...ctrl.map((c) => c[i])), Math.max(...ctrl.map((c) => c[i]))]);
    const ab = `${tokText(a.piece)} minus ${tokText(b.piece)}`;
    const ctrlAt = (i) => ctrl.map((c) => c[i] - c[i0]);
    const range = (xs) => `${signed(Math.min(...xs))} to ${signed(Math.max(...xs))}`;
    put(tiles,
      stat('No push', signed(real[i0]), ab),
      stat('Change at dose +1', signed(real[i1] - real[i0]), `random pushes: ${range(ctrlAt(i1))}`),
      stat('Change at dose −1', signed(real[im] - real[i0]), `random pushes: ${range(ctrlAt(im))}`));
    lineChart(curve, { height: 240,
      x: { label: `dose (× the typical stream length at layer ${st.layer}, about ${Math.round(rn)})`, fmt: (v) => fmt(v, 2) },
      y: { label: `logits: ${tokText(a.piece)} − ${tokText(b.piece)}` },
      hlines: [{ y: real[i0], label: 'no push' }],
      series: [
        { name: 'random directions, same size (range of 3)', color: col('ctrl'), band, muted: true },
        { name: 'the direction you built', color: col('s1'), pts: doses.map((d, i) => [d, real[i]]) },
      ],
      caption: `Logit difference at the last token of the prompt as the push grows. The direction's own length before normalising was ${fmt(dir.norm, 1)}, or ${fmt(dir.norm / rn, 2)} of a typical stream.` });
  }

  whenReady(page, life, () => { doseOut.textContent = doseText(); });
  return { destroy() { life.dead = true; } };
}

function lines(s) { return String(s || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 32); }
function signed(x) { return (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(2); }
function signed1(x) { return (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(1); }
