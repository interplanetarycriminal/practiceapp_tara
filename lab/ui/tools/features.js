/* lab/ui/tools/features.js: SAE features. A sparse autoencoder rewrites the residual stream at one layer as a short
   sum of directions picked from a large dictionary, most of them easier to name than neurons. For your text: which
   features are on at each token, how many, and how much of the stream they rebuild. For any feature: where it fires,
   what its direction writes, which features point almost the same way, and what pushing along it does. The card
   follows Neuronpedia's and Anthropic's feature browsers.
     GPT-2: Joseph Bloom's gpt2-small-res-jb (the dictionary ARENA's SAE chapter loads) for the stream entering layer
       7, 24,576 features, run in the lab's engine (lab/core/recipes.js: saeEncode, saeTrace, saeRow, saeNeighbors);
       the corpus views read lab/data/sae (lab/ui/corpus.js).
     Qwen 3.5 9B: the Qwen team's Qwen-Scope dictionaries, 65,536 TopK features for the stream leaving any layer,
       which the live lab server loads onto the 3090 on request, one layer at a time. With no corpus files for Qwen,
       saeLens and saeSearch (lab/bench/tarabench/live/recipes.py) read every feature's direction exactly instead. */

import { h, mount as put, tokText, debounce, fmt, pct, store, bytes as size } from '../dom.js';
import { toolPage, field, textArea, textInput, select, slider, presets, runner, whenReady, intParam, numParam, tk, wordForms, layerOpts, CFG, onGPT2 } from './kit.js';
import { engine } from '../engine.js';
import { tokens as strip, bars, stat, tipRow } from '../charts.js';
import { randomUnit } from '../../core/recipes.js';
import * as corpus from '../corpus.js';
import { examplesView, histView } from '../corpusviews.js';

const MAXT = 128, LIST = 16, KTOK = 10;
const G_LAYER = 7;                // GPT-2's dictionary reads the stream entering layer 7
const DEFAULT_F = 7626;           // opened on a first visit before the dictionary loads: the " rain" feature, which writes bows, forest, drops
const QKEY = 'tara.lab.sae.qwen'; // the Qwen layer whose dictionary was loaded last, loaded again on the next visit
const GONE = /dictionary is not loaded|dictionary on the card is layer/;    // the 3090 lost it: idle release, or another page

const TEACH = {
  what: {
    1: `<p>A <b>sparse autoencoder</b> (SAE) is a dictionary for the residual stream. At every token GPT-2's stream is
768 numbers; the SAE rewrites it as a short list of <b>features</b>, picked from 24,576, each with a strength. Only a
few dozen are on at any token, and most are far easier to name than neurons: one fires on weather, one inside
quotation marks, one on the word after "Dear".</p>
<p>Think of mixing paint. The stream at a token is one mixed colour, and the SAE is a box of 24,576 paints, chosen so
that every colour GPT-2 mixes can be matched with just a few of them. Having far more paints than the colour has
dimensions is fine, because each colour uses so few: that is superposition, read back out.</p>`,
    2: `<p>The SAE reads the stream x entering layer 7 and computes f = ReLU(W<sub>enc</sub>(x − b<sub>dec</sub>) + b<sub>enc</sub>):
24,576 numbers, almost all zero. It rebuilds the stream as x̂ = W<sub>dec</sub>f + b<sub>dec</sub>, one decoder direction per
feature. Training traded two things: rebuild x well, and keep few features on (an L1 penalty on f). This page shows,
for your text, which features are on at each token, how many (L0) and how much of the stream they rebuild; and for
one feature the same views as a neuron: where it fires, what it writes, and what pushing along it does.</p>
<div data-angle="analogy"><p>Where the paint picture breaks: the match is never exact (the leftover is what the dictionary
misses, shown under your text), and a paint's name is a guess from its examples, not a guarantee. A "weather"
feature may also fire on a few unrelated things, and one concept can be shared out between several near-identical
features (feature splitting): "Features like it" shows them.</p></div>`,
    3: `<p>Dictionary: Joseph Bloom's gpt2-small-res-jb for layer 7 (<code>blocks.7.hook_resid_pre</code>, 24,576 latents), the one
ARENA's [1.3.3] loads through SAELens. TransformerLens centres GPT-2's residual stream (each position minus its mean
across the 768 dimensions); the precompute measured the SAE on both versions and uses the better one, recorded in
<code>lab/data/sae/L07/info.json</code> with its explained variance and L0. The browser copy is int8 in groups of 64 with
fp16 scales, checked against the original. Explained variance over your text is 1 − Σ|x − x̂|² / Σ|x − x̄|²; the
miss at a token is |x − x̂|² / |x|².</p>`,
  },
  read: {
    1: `<p>Start with the dictionary's grade on your text: the share of the stream it rebuilds. Tap a word to list the
features on it, and open one. Name it from its strongest passages, check the passages at ordinary strength, then
test the name: write a sentence that should switch it on, and one that should not.</p>`,
    2: `<p>Activations are in the SAE's own units: the decoder directions have length 1, so an activation is how far the
stream moves along that direction. "On" is the feature's density in the corpus; a feature on for more than about 1%
of tokens tends to be generic, and one on for almost none is nearly dead. The push works like the neuron push: the
feature's direction added at every position, in units of the stream's typical size at layer 7, beside a random
direction of the same size.</p>`,
    3: `<p>"What it writes" reads the decoder direction through the unembedding, after ln_f's weights, relative to the
average word and at a typical final-layer scale, the units of a neuron's "What it writes". The words come in
Neuronpedia's order (its positive and negative logits); its raw numbers also carry a shift that every word shares,
which softmax ignores. "Features like it" ranks every decoder direction by its cosine with this one. The
passages, histogram and density come from the precompute's corpus with the neurons' settings. Encoding runs on the
int8 copy in plain JavaScript, about a second for a sentence.</p>`,
  },
  why: {
    1: `<p>Sparse autoencoders are how the field got past polysemantic neurons, and the building block of the newest
tools: transcoders, attribution graphs and feature steering. ARENA's SAE chapter, and the persona and misalignment
work later in the course, read models through them.</p>`,
    2: `<p>Bricken et al. (2023) and Cunningham et al. (2023) showed that SAE features of a small model are far easier to
interpret than its neurons; Templeton et al. (2024) scaled them to Claude 3 Sonnet (the Golden Gate Bridge feature).
Their weak spots are now studied in their own right: dead and dense latents, feature splitting and absorption
(Chanin et al., 2024), and the error term, which attribution graphs keep as "error nodes".</p>`,
    3: `<p>Gated and JumpReLU SAEs (Rajamanoharan et al., 2024) and TopK SAEs (Gao et al., 2024; the Qwen-Scope
dictionaries the bench uses are TopK) fix the L1 penalty's habit of shrinking activations. Steering with a feature is
cheap and readable but rarely clean, because its decoder direction overlaps with others; check the random push before
believing a change. Decomposing a steering vector into features, as ARENA's persona chapter does with Gemma's SAEs,
is the same encoder run on a direction instead of a token.</p>`,
  },
  qwen: `<p>On Qwen 3.5 9B this page reads <b>Qwen-Scope</b>, the dictionaries the Qwen team published for every layer of
Qwen 3.5 (May 2026): 65,536 features per layer, each reading the stream leaving its layer. They are <b>TopK</b> SAEs: at
each token only the 50 strongest features stay on, so L0 is capped by design and the grade to watch is the share of the
stream they rebuild. They were trained on the Base model and the lab runs the post-trained 9B in 4-bit, so the
dictionary is borrowed: the share rebuilt on your text says how well it carries over. Pick a layer (early layers tend
to hold features about the words themselves, middle ones the most abstract ideas, late ones what comes next), load it
onto the 3090, then read your text. Strongest passages and histograms come from a corpus precompute that covers GPT-2
only so far; here, "What it writes" and the word search are exact, read from every feature's direction.</p>`,
};

const EXAMPLES = [
  { label: 'Eiffel Tower and rain', text: 'The Eiffel Tower is in Paris. I wrote a short poem about love and rain.' },
  { label: 'A letter', text: 'Dear Professor Smith,\n\nThank you for your kind reply. I would be glad to meet on Tuesday.' },
  { label: 'Code', text: 'def add(a, b):\n    return a + b\n\nprint(add(2, 3))' },
  { label: 'A news line', text: 'Shares in the company fell 4% on Monday after it reported weaker sales in China.' },
];
const PROMPTS = ['I think the most important thing to remember is', 'Today we are going to talk about', 'Once upon a time,', 'The best thing about'];

export function mount(el, meta, api) {
  const P = api.params, life = { dead: false };
  forModel(CFG.id);
  /* GPT-2 has one dictionary, run in this browser; Qwen has one per layer, and the 3090 holds one at a time */
  const gpt2 = onGPT2(), kept = gpt2 ? null : store.get(QKEY, null);
  const st = {
    text: P.text ?? EXAMPLES[0].text,
    layer: gpt2 ? G_LAYER : intParam(P.layer ?? kept, 0, CFG.L - 1, Math.floor(CFG.L / 2)),
    open: P.feature !== undefined ? intParam(P.feature, 0, gpt2 ? 24575 : 1 << 20, 0) : gpt2 ? DEFAULT_F : null, auto: P.feature === undefined,
    at: null, E: null, ids: null, pieces: null, loaded: false, F: gpt2 ? 24576 : null, I: null, Q: null, Qerr: null, meta: null,
    prompt: PROMPTS[0], dose: numParam(P.dose, -2, 2, 0.8), find: P.find || '',
  };
  const hook = gpt2 ? 'resid_pre' : 'resid_post';
  const stream = () => `the stream ${gpt2 ? 'entering' : 'leaving'} layer ${st.layer}`;
  const page = toolPage(el, meta, TEACH);
  const save = debounce(() => api.setParams({ text: st.text, feature: st.open !== null && !st.auto ? st.open : null, find: st.find || null, layer: gpt2 ? null : st.layer }), 400);

  /* ---- controls */
  const count = h('span');
  const ta = textArea(st.text, { rows: 2, oninput: (e) => { st.text = e.target.value; st.at = null; save(); go(); } });
  const fIn = h('input', { type: 'number', min: 0, step: 1, inputmode: 'numeric', style: { width: '8em' } });
  const fName = h('span');
  const sizeF = () => { fName.textContent = st.F ? `Feature, 0 to ${(st.F - 1).toLocaleString('en')}` : 'Feature'; if (st.F) fIn.max = String(st.F - 1); };
  sizeF();
  fIn.value = st.open === null ? '' : String(st.open);
  fIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') openTyped(); });
  const openTyped = () => { if (fIn.value !== '') open(intParam(fIn.value, 0, (st.F || 1 << 20) - 1, 0)); };
  const findIn = textInput(st.find, { placeholder: 'a word, such as rain' });
  findIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') find(); });
  const findOut = h('div');
  put(page.controls,
    field('Your text', ta, count),
    presets(EXAMPLES, (x) => { ta.value = st.text = x.text; st.at = null; save(); go.now(); }),
    h('div.row', { style: { marginTop: '10px', alignItems: 'flex-end' } },
      field(fName, fIn),
      h('button.btn', { type: 'button', onclick: openTyped }, 'Open'),
      h('button.btn', { type: 'button', onclick: () => randomLive().then(open) }, 'A random feature')),
    h('div.find-row', null, field('Or find the features that write a word', findIn), h('button.btn', { type: 'button', onclick: () => find() }, 'Find')),
    findOut);

  /* ---- the dictionary, your text, the card */
  const dict = h('div'), loadSlot = h('div');
  const loadRun = runner(gpt2 ? 'Load the dictionary' : 'Load it onto the 3090', loadSlot, (onP, ctl) => (gpt2 ? loadDict(onP, ctl) : loadDictQ(onP, ctl)));
  const layerSel = gpt2 ? null : select(layerOpts(), st.layer, (v) => pickLayer(Number(v)));
  if (layerSel) Object.assign(layerSel.style, { width: 'auto', minWidth: '12em' });
  const markLayers = () => { if (layerSel && st.Q) for (const o of layerSel.options) o.textContent = `layer ${o.value}${st.Q.cached.includes(Number(o.value)) ? ' · on your PC' : ''}`; };
  const textStrip = h('div'), missStrip = h('div'), list = h('div.picklist'), listNote = h('p.small.muted'), card = h('div');
  const textSec = h('div', { hidden: true },
    h('div.subhead', null, h('h3', null, 'Features on your text'), h('span.small.muted', null, 'tap a word to list the features on it')),
    textStrip,
    h('div.small-caps', { style: { marginTop: '8px' } }, 'What the dictionary misses at each token'), missStrip,
    list, listNote);
  put(page.result, dict, textSec, card);

  /* ---- the push test: made once, placed into each card */
  const pIn = textInput(st.prompt, { oninput: (e) => { st.prompt = e.target.value; } });
  const doseOut = h('span.small');
  const dose = slider({ min: -2, max: 2, step: 0.1, value: st.dose, oninput: (e) => { st.dose = Number(e.target.value); doseOut.textContent = doseText(); } });
  const pushSlot = h('div'), genOut = h('div');
  const run = runner('Push it', pushSlot, (onP, ctl) => push(onP, ctl));
  const pushPanel = h('div.panel', null,
    h('div.fields.two', null, field('Prompt', pIn), field('How hard', dose, doseOut)),
    presets([...PROMPTS.map((p) => ({ label: p, text: p })), { label: 'your text', text: null }], (x) => { pIn.value = st.prompt = x.text ?? st.text; }),
    h('div.row', { style: { marginTop: '10px' } }, run.btn, h('span.small.muted', null, 'A few seconds: three short continuations.')),
    pushSlot);
  const unit = () => (engine.status.residNorm || [])[gpt2 ? st.layer - 1 : st.layer] || 80;   // GPT-2: the stream entering layer 7 leaves layer 6
  function doseText() {
    return `${st.dose > 0 ? '+' : st.dose < 0 ? '−' : ''}${Math.abs(st.dose).toFixed(1)} × the typical size of ${stream()} (about ${Math.round(Math.abs(st.dose) * unit())})`;
  }

  /* A dictionary recipe. On the 3090 it names the layer, and when the card has lost the dictionary (the server lets the
     model go after 20 idle minutes, or another page loaded another layer) it loads it again and asks once more. */
  function sae(name, args, opts) {
    if (gpt2) return engine.recipe(name, args, opts);
    const a = { ...args, layer: st.layer }, first = engine.recipe(name, a, opts);
    const p = first.catch(async (e) => {
      if (!GONE.test(String(e && e.message))) throw e;
      await engine.lab.call('saeLoad', { layer: a.layer });
      return engine.recipe(name, a, opts);
    });
    p.id = first.id;                                 // so a run's Stop still reaches it
    return p;
  }

  /* what features' directions write, through the unembedding (Qwen: saeLens on the 3090), kept per layer */
  async function lensQ(fs) {
    const L = st.layer, key = (f) => L + ':' + f, need = [...new Set(fs)].filter((f) => !LQ.has(key(f)));
    if (need.length) {
      const r = await sae('saeLens', { features: need, k: 8 });
      if (LQ.size > 4000) LQ.clear();
      need.forEach((f, i) => LQ.set(key(f), r.lens[i]));
      await vocabOf(r.lens.flatMap((x) => [...x.up, ...x.down].map(([t]) => t)));
    }
    return fs.map((f) => LQ.get(key(f)));
  }

  /* one line per feature in a list: GPT-2's from the corpus files, Qwen's from what its direction writes */
  const hints = (root) => (gpt2 ? fillHints(root, st.layer) : hintsQ(root));
  async function hintsQ(root) {
    const btns = [...root.querySelectorAll('button[data-f]')];
    if (!btns.length || !st.loaded) return;
    const lz = await lensQ(btns.map((b) => Number(b.dataset.f))).catch(() => null);
    if (!lz || life.dead) return;
    btns.forEach((b, i) => {
      const hint = b.querySelector('.hint');
      if (hint && lz[i]) hint.textContent = 'writes ' + lz[i].up.slice(0, 3).map(([t]) => word(t)).join(', ');
    });
  }

  /* the dictionary card: a button until it is loaded, then its grade on your text */
  function drawDict() {
    if (!gpt2) { drawDictQ(); return; }
    const I = st.I;
    if (!I) { put(dict, h('div.card.flat', null, h('p.small', { style: { margin: 0 } }, 'This tool reads the SAE files that the lab\'s GPU precompute writes, and they are not in this copy of the lab yet.'))); return; }
    const chk = I.check && I.check[I.centred_input ? 'centred' : 'raw'];
    const corpusLine = chk ? `On a sample of the precompute's corpus it rebuilt ${pct(Math.max(0, chk.explained_variance))} of the stream's variance, with ${fmt(chk.l0, 0)} features on per token.` : '';
    if (!st.loaded) {
      put(dict, h('div.card.flat', null,
        h('div.small-caps', null, 'Read your text with the dictionary'),
        h('p.small', { style: { margin: '4px 0 8px' } }, `The dictionary is ${size(dictBytes(I))}: all ${I.d_sae.toLocaleString('en')} features of layer ${st.layer}, in int8. It downloads once and then runs on this device. The passages, histograms and words of any feature work without it.`),
        h('div.row', null, loadRun.btn), loadSlot));
      return;
    }
    const E = st.E, l0 = E ? mean(Array.from(E.l0).slice(1)) : NaN;
    put(dict, h('div.stats', null,
      stat('Rebuilt on your text', E && Number.isFinite(E.ev) ? pct(Math.max(0, E.ev)) : '–', 'of the stream\'s variance'),
      stat('Features on', E ? fmt(l0, 0) : '–', 'per token, on average (L0)'),
      stat('Dictionary', I.d_sae.toLocaleString('en'), `features at layer ${st.layer}`)),
    h('p.small.muted', { style: { margin: '0 0 4px' } }, corpusLine, I.int8_check ? ` The int8 copy agrees with the original on ${pct(I.int8_check.same_on_off, 1)} of on/off calls.` : ''));
  }

  /* Qwen: pick a layer and load its dictionary onto the 3090, then the same grade on your text */
  function drawDictQ() {
    const Q = st.Q;
    if (!Q) { put(dict, h('div.card.flat', null, h('p.small', { style: { margin: 0 } }, st.Qerr || 'Asking the lab server which dictionaries it has…'))); return; }
    const pick = field('Layer', layerSel), onPC = Q.cached.includes(st.layer);
    if (!st.loaded) {
      put(dict, h('div.card.flat', null,
        h('div.small-caps', null, 'Read your text with Qwen-Scope\'s dictionary'),
        h('p.small', { style: { margin: '4px 0 8px' } },
          `The Qwen team published one for every layer of ${CFG.name}${st.F ? `, ${st.F.toLocaleString('en')} features each` : ''}. `,
          'The one you load goes onto the 3090 beside the model (about 1 GB) and stays while you work; ',
          Q.cached.length ? `layers ${andList(Q.cached)} are on your PC already.` : 'none is on your PC yet.'),
        h('div.row', { style: { alignItems: 'flex-end' } }, pick, loadRun.btn,
          h('span.small.muted', null, onPC ? 'About half a minute.' : 'About 2 GB to download once, then half a minute.')),
        loadSlot));
      return;
    }
    const E = st.E, l0 = E ? mean(Array.from(E.l0).slice(1)) : NaN, m = st.meta;
    const held = (engine.status.entry || {}).precision === 'nf4' ? ' in 4-bit' : '';
    put(dict, h('div.stats', null,
      stat('Rebuilt on your text', E && Number.isFinite(E.ev) ? pct(Math.max(0, E.ev)) : '–', 'of the stream\'s variance'),
      stat('Features on', E ? fmt(l0, 0) : '–', `per token, on average (L0; TopK keeps at most ${m.k})`),
      stat('Dictionary', m.F.toLocaleString('en'), `features at layer ${st.layer}`)),
    h('div.row', { style: { alignItems: 'flex-end', margin: '0 0 6px' } }, pick, h('span.small.muted', null, 'Another layer takes this one\'s place on the card.')),
    m.borrowed ? h('p.small.muted', { style: { margin: '0 0 4px' } }, `Trained on ${CFG.name} Base, and the lab runs the post-trained model${held}, so this dictionary is borrowed: the share rebuilt on your text says how well it carries over.`) : null);
  }

  async function loadDict(onP, ctl) {
    const total = dictBytes(st.I);
    await ctl.track(engine.lab.call('saeLoad', { layer: st.layer }, {
      onProgress: (p) => { const t = p.total && p.total >= p.done ? p.total : total; onP(p.done, t, `Downloading the dictionary: ${size(p.done)} of ${size(t)}`); },
    }));
    if (life.dead) return;
    st.loaded = true;
    store.set('tara.lab.sae', true);
    await go.now();
  }

  async function loadDictQ(onP, ctl) {
    const layer = st.layer, t0 = Date.now(), expect = st.Q && st.Q.cached.includes(layer) ? 30 : 150;
    let what = expect === 30 ? `Loading the layer ${layer} dictionary onto the 3090` : `Downloading the layer ${layer} dictionary (about 2 GB, once), then loading it onto the 3090`;
    const tick = () => {
      if (['loading', 'waiting'].includes(engine.status.state)) return;           // the model itself is coming back first
      const s = Math.round((Date.now() - t0) / 1000);
      onP(Math.min(0.95, s / expect), 1, `${what}: ${s} s of about ${expect} s`);
    };
    const timer = setInterval(tick, 1000);
    tick();
    let m;
    try {
      m = await ctl.track(engine.lab.call('saeLoad', { layer }, { onStage: (x) => { if (x.stage === 'downloading' && x.note) what = x.note; } }));
    } finally { clearInterval(timer); }
    if (life.dead || layer !== st.layer) return;
    Object.assign(st, { loaded: true, meta: m, F: m.F });
    if (st.Q && !st.Q.cached.includes(layer)) { st.Q.cached.push(layer); st.Q.cached.sort((a, b) => a - b); markLayers(); }
    sizeF();
    store.set(QKEY, layer);
    await go.now();
    if (st.find) find();
  }

  /* another layer's dictionary takes the card's place (at once when it is on the PC already); feature numbers belong to
     one layer, so the open feature closes */
  function pickLayer(l) {
    if (l === st.layer) return;
    const busy = loadRun.busy;
    if (busy) loadRun.go();                          // stops the load in flight
    Object.assign(st, { layer: l, loaded: false, E: null, at: null, meta: null, open: null, auto: true });
    fIn.value = '';
    textSec.hidden = true;
    put(card); put(findOut); put(genOut);
    save();
    drawDict();
    if (!busy && st.Q && st.Q.cached.includes(l)) loadRun.go();
  }

  /* ---- reading the text */
  const go = debounce(async () => {
    const text = st.text;
    if (!text.trim()) return;
    try {
      const t = await engine.tok(text);
      const ids = t.ids.slice(0, MAXT + 1);
      count.textContent = t.ids.length - 1 > MAXT ? `${t.ids.length - 1} tokens; the first ${MAXT} are used` : `${t.ids.length - 1} tokens`;
      Object.assign(st, { ids, pieces: t.pieces.slice(0, ids.length) });
      if (!st.loaded) { st.E = null; drawDict(); if (st.open !== null) drawCard(); return; }
      page.result.classList.add('busy');
      const E = await sae('saeEncode', { ids, k: KTOK, top: 40 }, { channel: 'features-encode' });
      if (life.dead || text !== st.text || !st.loaded) return;
      st.E = E;
      textSec.hidden = false;
      drawDict(); drawText(); drawList();
      if (st.open === null || st.auto) { const s0 = E.strongest[0]; if (s0) { st.open = s0[0]; st.auto = true; fIn.value = String(s0[0]); } }
      if (st.open !== null) drawCard();
    } catch (e) {
      if (!/cancelled/.test(String(e && e.message))) put(listNote, h('span.err', null, String(e.message || e)));
    } finally { page.result.classList.remove('busy'); }
  }, 500);

  function drawText() {
    const E = st.E;
    strip(textStrip, { pieces: st.pieces, values: st.pieces.map(() => NaN), skip: new Set([0]), selected: st.at ?? undefined,
      tip: (t) => (t ? [h('div.tip-head', null, tokText(st.pieces[t])), tipRow(String(E.l0[t]), 'features on'), tipRow(pct(E.miss[t]), 'of its stream missed')] : null),
      onPick: (t) => { if (t === 0) return; st.at = st.at === t ? null : t; drawText(); drawList(); if (st.open !== null) drawCard(); } });
    const worst = Math.max(0.25, ...Array.from(E.miss).slice(1));
    strip(missStrip, { pieces: st.pieces, values: Array.from(E.miss), scale: 'seq', max: worst, skip: new Set([0]),
      tip: (t) => (t ? [h('div.tip-head', null, tokText(st.pieces[t])), tipRow(pct(E.miss[t], 1), 'of this token\'s stream is not rebuilt'),
        h('div.tip-sub', null, '|x − x̂|² / |x|²: what the features on here leave out')] : null) });
  }

  /* the features on the chosen word, or the strongest anywhere in the text */
  function drawList() {
    const E = st.E, at = st.at;
    const rows = at !== null
      ? Array.from({ length: E.k }, (_, q) => [E.topF[at * E.k + q], E.topV[at * E.k + q], at]).filter(([f]) => f >= 0)
      : E.strongest.slice(0, LIST);
    put(list, rows.map(([f, v, t]) => featureButton(f, [fmt(v, 2), ' on ', tk(st.pieces[t])])));
    put(listNote, at !== null ? [`The ${rows.length} strongest of the ${E.l0[at]} features on `, tk(st.pieces[at]), '; tap the word again for the whole text.']
      : 'The features that reach the highest activation anywhere in your text, each at its strongest word.');
    hints(list);
  }

  const isOpen = (f) => st.open === f;
  function open(f) {
    if (run.busy) run.go();
    st.open = f; st.auto = false; fIn.value = String(f);
    save();
    for (const b of page.result.querySelectorAll('button[data-f]')) b.setAttribute('aria-pressed', b.dataset.f === String(f) ? 'true' : 'false');
    put(genOut);
    drawCard();
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* a feature that opens on a tap; its hint fills in once the hints are loaded */
  function featureButton(f, value, title) {
    const b = h('button', { type: 'button', title, 'aria-pressed': isOpen(f) ? 'true' : 'false', onclick: () => open(f) },
      h('span.k', null, `F${f}`), h('span.hint', null, '…'), h('span.v', null, value));
    b.dataset.f = String(f);
    return b;
  }

  /* ---- one feature */
  let cardSeq = 0;
  async function drawCard() {
    if (st.open === null || (gpt2 && !st.I)) return;
    const seq = ++cardSeq, f = st.open, stale = () => seq !== cardSeq || life.dead;
    const live = h('div'), exBox = h('div'), writes = h('div'), near = h('div'), link = h('span.small');
    const tPeak = h('div.stat', { hidden: true }), tOn = h('div.stat', { hidden: true }), tWrites = h('div.stat', { hidden: true });
    doseOut.textContent = doseText();
    put(card,
      h('div.subhead', null, h('h2', { style: { margin: '0' } }, `Feature ${f}`), h('span.small.muted', null, `layer ${st.layer}${st.F ? ` · one of ${st.F.toLocaleString('en')}` : ''}`, gpt2 ? [' · ', link] : null)),
      h('div.stats', null, tPeak, tOn, tWrites),
      h('div.small-caps', { style: { marginTop: '8px' } }, 'Where it fires on your text'), live,
      exBox,
      h('div.res-cols', { style: { marginTop: '10px' } },
        h('div', null, h('h3', null, 'What it writes'), writes),
        h('div', null, h('h3', null, 'Features like it'), near)),
      h('div.subhead', null, h('h3', null, 'What pushing it does'), h('span.small.muted', null, `its direction added to ${stream()}; a random direction of the same size is the control`)),
      pushPanel, genOut);
    /* what its direction writes: the corpus files' lens on GPT-2, saeLens on Qwen */
    const drawWrites = (lz) => {
      const ups = lz.up.filter(([, v]) => Number.isFinite(v));
      if (!ups.length) return;
      put(tWrites, h('div.stat-label', null, 'Pushes most'), h('div.stat-value', null, tokText(PIECES.get(ups[0][0]))),
        h('div.stat-sub', null, `${signed(ups[0][1])} ${lz.centred ? 'logits' : 'raw logits'} per unit, directly`));
      tWrites.hidden = false;
      bars(writes, { signed: true, fmtv: signed,
        items: [...lz.up.slice(0, 8), ...lz.down.slice(0, 5)].map(([t, v]) => ({ label: tokText(PIECES.get(t)), value: v })),
        caption: lz.centred
          ? 'Logits added to each word per unit of activation, through the direct path, relative to the average word and at a typical final-layer scale: the same units as a neuron\'s "What it writes".' + (gpt2 ? ' The order is Neuronpedia\'s positive and negative logits.' : ' Read exactly from its decoder direction.')
          : 'Its decoder direction read through the unembedding (after ln_f\'s weights): the words it pushes up and down directly, per unit of activation. These are Neuronpedia\'s positive and negative logits; compare within a feature.' });
    };
    let N = null;
    if (gpt2) {
      try { N = await corpus.feature(st.layer, f); } catch (e) { put(exBox, h('p.small.err', null, 'Its corpus passages did not load: ' + (e.message || e))); }
      if (stale()) return;
    } else {
      put(exBox, h('div.card.flat', { style: { marginTop: '12px' } }, h('div.small-caps', null, 'Where it fires across a large body of text'),
        h('p.small', { style: { margin: '4px 0 0' } }, `A feature is usually named from the passages, out of millions, where it fires hardest. The lab's corpus precompute covers GPT-2 so far, not ${CFG.name}. Until it does, test a name with the text box above: write a sentence that should switch this feature on, and one that should not.`)));
    }
    if (N) {
      put(link, N.neuronpedia ? h('a', { href: N.neuronpedia, target: '_blank', rel: 'noopener' }, 'on Neuronpedia ↗') : '');
      await vocabOf([...N.examples.flatMap((x) => x.tokens), ...N.up.map(([t]) => t), ...N.down.map(([t]) => t)]);
      if (stale()) return;
      const S = await corpus.info().catch(() => ({})), H = corpus.size({ corpus: S.corpus, neurons: { tokens: N.tokens } });
      const top = N.examples.length ? N.examples[0].value : N.max, eb = h('div'), hb = h('div');
      put(exBox, h('div.subhead', null, h('h3', null, `Where it fires in ${H.long}`), h('span.small.muted', null, 'precomputed on a graphics card; "Try it" reads a passage live')),
        eb, h('div.small-caps', { style: { marginTop: '12px' } }, 'How often it fires, and how hard'), hb);
      if (N.examples.length) examplesView(eb, { examples: N.examples, names: PIECES, top, onTry: tryText, what: 'it' });
      else put(eb, h('p.small.muted', null, 'It never fired in the corpus: a dead feature.'));
      histView(hb, { hist: N.hist, scale: N.scale });
      put(tOn, h('div.stat-label', null, 'In the corpus'), h('div.stat-value', null, densityText(N.density)), h('div.stat-sub', null, `of ${H.short} tokens it is on; strongest ${fmt(N.max, 2)}`));
      tOn.hidden = false;
      drawWrites(lensOf(N));
    }
    /* live on your text, its neighbours, and on Qwen what it writes: these need the dictionary */
    if (!st.loaded) {
      put(live, h('p.small.muted', null, 'Load the dictionary above to read your text with it.'));
      put(near, h('p.small.muted', null, 'Load the dictionary above to compare its direction with all the others.'));
      if (!gpt2) put(writes, h('p.small.muted', null, 'Load the dictionary above to read what its direction writes.'));
    } else {
      const [r, nb, lz] = await Promise.all([
        sae('saeTrace', { ids: st.ids, feature: f }, { channel: 'features-trace' }),
        sae('saeNeighbors', { feature: f, k: 6 }, { channel: 'features-near' }),
        gpt2 ? null : lensQ([f]).then((x) => x[0]),
      ]).catch((e) => { if (!/cancelled/.test(String(e && e.message))) put(live, h('p.small.err', null, String(e.message || e))); return [null, null, null]; });
      if (stale() || !r) return;
      if (lz) drawWrites({ ...lz, centred: true });
      const acts = Array.from(r.acts);
      let pt = 1;
      for (let t = 1; t < acts.length; t++) if (acts[t] > acts[pt]) pt = t;
      const peak = acts[pt] || 0, scaleMax = N && N.max > 0 ? N.max : Math.max(gpt2 ? 0.5 : 1e-3, peak);
      strip(live, { pieces: st.pieces, values: acts, scale: 'seq', max: scaleMax, skip: new Set([0]), selected: st.at ?? undefined,
        tip: (t) => (t ? [h('div.tip-head', null, tokText(st.pieces[t])), tipRow(fmt(acts[t], 2), t === pt ? 'activation, its peak on this text' : 'activation')] : null),
        onPick: (t) => { if (t === 0) return; st.at = st.at === t ? null : t; drawText(); drawList(); drawCard(); } });
      put(tPeak, h('div.stat-label', null, 'Peak on your text'), h('div.stat-value', null, fmt(peak, 2)),
        h('div.stat-sub', null, peak > 0 ? ['on ', tokText(st.pieces[pt]), N && N.max > 0 ? `, ${pct(Math.min(1, peak / N.max))} of its strongest` : ''] : 'off everywhere here'));
      tPeak.hidden = false;
      put(near, h('div.small-caps', null, 'Decoder directions closest to its own'),
        h('div.picklist', null, nb.near.map(([j, c]) => featureButton(j, `cos ${c.toFixed(2)}`, `the cosine between the two decoder directions is ${c.toFixed(2)}`))),
        h('p.small.muted', null, `Two features whose directions are nearly the same (a cosine near 1) often split one idea between them, such as one word in two contexts. Unrelated directions in ${CFG.D.toLocaleString('en')} dimensions sit near 0.`));
      hints(near);
    }
  }

  /* "Try it" on a corpus passage: read it live, with this feature kept open */
  async function tryText(x, text) {
    ta.value = st.text = text; st.auto = false; st.at = null;
    save();
    await go.now();
    if (life.dead) return;
    if (st.ids && st.ids.length === x.tokens.length + 1 && x.tokens.every((t, i) => t === st.ids[i + 1])) {
      st.at = x.peak + 1;
      if (st.E) { drawText(); drawList(); }
      drawCard();
    }
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---- the push: three greedy continuations, no push / this feature / a random direction of the same size */
  async function push(onP, ctl) {
    const f = st.open, d = st.dose;
    if (!st.loaded) throw new Error('Load the dictionary above first: the push needs this feature\'s direction.');
    const t = await engine.tok(st.prompt.trim() || PROMPTS[0]);
    const ids = t.ids.slice(0, 64), rn = unit();
    onP(0, 2, 'Reading its direction…');
    const { dec } = await ctl.track(sae('saeRow', { feature: f }));
    let nn = 0;
    for (const v of dec) nn += v * v;
    nn = Math.sqrt(nn) || 1;
    const vec = Float32Array.from(dec, (v) => (v / nn) * rn);
    let s = (f * 2654435761) >>> 0;
    const rv = randomUnit(() => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }, CFG.D);
    for (let i = 0; i < rv.length; i++) rv[i] *= rn;
    const iv = [{ hook, layer: st.layer, op: 'add', rows: [1], vec, value: d }, { hook, layer: st.layer, op: 'add', rows: [2], vec: rv, value: d }];
    const cols = [0, 1, 2].map(() => h('div.gen', null, h('span.prompt', null, st.prompt.trim())));
    put(genOut, h('div.gencol.three', null,
      ['No push', `F${f} pushed (${d > 0 ? '+' : ''}${d.toFixed(1)})`, 'A random direction, same size'].map((title, i) => h('div', null, h('div.gen-h', null, title), cols[i]))),
    h('p.small.muted', null, 'Greedy (the likeliest word each time), so the only difference between the three is the push.'));
    const NT = 24;
    await ctl.track(engine.generate({ prompt: ids, R: 3, maxNew: NT, temperature: 0, iv }, (pr) => {
      pr.pieces.forEach((p, i) => cols[i].appendChild(document.createTextNode(p)));
      onP(1 + (pr.step + 1) / NT, 2, 'Writing three continuations…');
    }));
  }

  /* ---- from a word to the features whose direction writes it: on GPT-2 out of each feature's top 10 promoted words
     (the corpus files), on Qwen ranked exactly over the whole dictionary (saeSearch) */
  let findSeq = 0;
  async function find(pick) {
    const w = findIn.value.replace(/\s+$/, ''), seq = ++findSeq, stale = () => seq !== findSeq || life.dead;
    st.find = w.trim() ? w : ''; save();
    if (!st.find) { put(findOut); return; }
    if (!engine.ready() && !engine.remote) { put(findOut, h('p.small.muted', null, 'The search starts once GPT-2 has loaded (the button at the top).')); return; }
    if (gpt2 && !st.I) { put(findOut, h('p.small.muted', null, 'This search reads the SAE files from the GPU precompute, which are not in this copy of the lab yet.')); return; }
    if (!gpt2 && !st.loaded) { put(findOut, h('p.small.muted', null, 'Load the dictionary above first: the search reads every feature\'s direction on the 3090.')); return; }
    put(findOut, h('p.small.muted', null, 'Looking…'));
    try {
      const vars = await wordForms(w);
      if (stale()) return;
      if (!vars.length) { put(findOut, h('p.small.muted', null, `"${w.trim()}" is more than one token in every form tried (with and without a leading space, with and without a capital), and the search works on single tokens.`)); return; }
      const v = vars[Math.max(0, vars.findIndex((x) => x.id === pick))];
      let rows, note;
      if (gpt2) {
        const [Lz, mu] = await Promise.all([corpus.saeLens(st.layer), corpus.saeLensMean(st.layer)]);
        if (stale()) return;
        const best = [], sc = lensScale();
        for (let j = 0; j < st.F; j++) for (let q = 0; q < 10; q++) if (Lz.t[j * 20 + q] === v.id) { best.push([j, mu ? (Lz.v[j * 20 + q] / 100 - mu[j]) * sc : Lz.v[j * 20 + q] / 100]); break; }
        best.sort((a, b) => b[1] - a[1]);
        rows = best.slice(0, LIST);
        note = 'From each feature\'s ten most promoted words. To find features that fire on a word instead, put it in your text, load the dictionary and tap it.';
      } else {
        const r = await sae('saeSearch', { token: v.id, k: LIST }, { channel: 'features-find' });
        if (stale()) return;
        rows = r.up;
        note = `Ranked over all ${st.F.toLocaleString('en')} features from their decoder directions, in the units of each card's "What it writes". Writing a word is not the same as firing on it: to see what fires on a word, put it in your text and tap it.`;
      }
      put(findOut, h('div.small-caps', { style: { marginTop: '10px' } }, ['The features whose direction writes ', tk(v.piece), ' most']),
        rows.length ? h('div.picklist', null, rows.map(([j, x]) => featureButton(j, signed(x), `${signed(x)} logits for ${tokText(v.piece)} per unit of activation, directly`)))
          : h('p.small.muted', null, 'No feature has it among the ten words it pushes most.'),
        h('p.small.muted', null, note,
          vars.length > 1 ? h('span.chips', { style: { display: 'inline-flex', marginLeft: '6px' } }, vars.map((x) => h('button.chip', { type: 'button', 'aria-pressed': x.id === v.id ? 'true' : 'false', onclick: () => find(x.id) }, tokText(x.piece)))) : null));
      hints(findOut);
    } catch (e) {
      if (!stale() && !/cancelled/.test(String(e && e.message))) put(findOut, h('p.small.err', null, String(e.message || e)));
    }
  }

  /* a random feature that is not dead (Qwen has no corpus statistics yet, so any of them) */
  async function randomLive() {
    if (!gpt2) return Math.floor(Math.random() * (st.F || 1));
    const S = await corpus.saeStats(st.layer).catch(() => null);
    for (let k = 0; k < 64; k++) { const j = Math.floor(Math.random() * st.F); if (!S || S.f[j * 4 + 2] > 0) return j; }
    return Math.floor(Math.random() * st.F);
  }

  whenReady(page, life, async () => {
    if (!gpt2) { await startQ(); return; }
    st.I = await corpus.saeInfo(st.layer).catch(() => null);
    if (life.dead) return;
    if (st.I) { st.F = st.I.d_sae; sizeF(); }
    drawDict();
    // loaded on an earlier visit and still in this device's cache: load it again without asking (about a second)
    const again = st.I && store.get('tara.lab.sae', false) && await engine.lab.call('saeCached', { layer: st.layer }).then((r) => r.cached, () => false);
    if (life.dead) return;
    if (again) loadRun.go();
    else await go.now();
    if (st.find) find();
  });

  /* Qwen: which layers' dictionaries are on the PC; the one loaded on an earlier visit loads again without asking */
  async function startQ() {
    try { st.Q = await engine.lab.call('saeLayers', {}); } catch (e) { st.Qerr = `The lab server did not say which dictionaries it has: ${e.message || e}`; }
    if (life.dead) return;
    if (st.Q) {
      const w = /-W(\d+)K-/.exec(st.Q.repo || '');
      if (w) st.F = Number(w[1]) * 1024;
      if (P.layer === undefined && kept === null && st.Q.cached.length && !st.Q.cached.includes(st.layer)) st.layer = st.Q.cached[Math.floor(st.Q.cached.length / 2)];
      layerSel.value = String(st.layer);
      markLayers(); sizeF();
    }
    drawDict();
    if (st.Q && kept !== null && st.Q.cached.includes(st.layer)) loadRun.go();
    else await go.now();
    if (st.find && !loadRun.busy) find();
  }
  return { destroy() { life.dead = true; } };
}

/* ---- helpers */

/* The caches below hold token ids and feature numbers, which mean different things in another model: a page mounted
   for a different model starts them afresh. */
let MODEL = null;
function forModel(id) {
  if (MODEL === id) return;
  MODEL = id;
  PIECES.clear(); LQ.clear();
}
const LQ = new Map();             // Qwen: 'layer:feature' -> what its direction writes ({up, down}, from saeLens)

/* the direct-path lens at a typical final-layer scale, as for neurons: sqrt(D) over the stream's median norm after the
   last layer */
function lensScale() { return Math.sqrt(CFG.D) / ((engine.status.residNorm || [])[CFG.L - 1] || 100); }

/* a feature's lens relative to the average word when the precompute stored its shift, else raw */
function lensOf(N) {
  if (N.shift === null || N.shift === undefined) return { up: N.up, down: N.down, centred: false };
  const sc = lensScale(), c = ([t, v]) => [t, (v - N.shift) * sc];
  return { up: N.up.map(c), down: N.down.map(c), centred: true };
}

function dictBytes(I) {
  const W = { int8: 1, float16: 2, float32: 4 };
  return I && I.sae_bin ? Object.values(I.sae_bin).reduce((m, x) => Math.max(m, x.offset + x.shape.reduce((a, b) => a * b, 1) * (W[x.dtype] || 4)), 0) : 0;
}

/* GPT-2: one line per feature for lists: what it fires on (its strongest passages' peak words), else what it writes */
async function fillHints(root, layer) {
  const btns = [...root.querySelectorAll('button[data-f]')];
  if (!btns.length) return;
  const [pk, Lz] = await Promise.all([corpus.saePeaks(layer), corpus.saeLens(layer).catch(() => null)]);
  const want = [];
  for (const b of btns) {
    const f = Number(b.dataset.f);
    if (pk) for (let q = 0; q < 3; q++) if (pk[f * 3 + q] !== 65535) want.push(pk[f * 3 + q]);
    if (Lz) for (let q = 0; q < 3; q++) want.push(Lz.t[f * 20 + q]);
  }
  await vocabOf(want);
  for (const b of btns) {
    const f = Number(b.dataset.f), hint = b.querySelector('.hint');
    if (!hint) continue;
    const on = pk ? [...new Set([0, 1, 2].map((q) => pk[f * 3 + q]).filter((t) => t !== 65535))].map(word) : [];
    const wr = Lz ? [0, 1, 2].map((q) => word(Lz.t[f * 20 + q])) : [];
    hint.textContent = on.length ? `fires on ${on.join(', ')}${wr.length ? ' · writes ' + wr.slice(0, 2).join(', ') : ''}` : wr.length ? 'writes ' + wr.join(', ') : '';
  }
}

const PIECES = new Map();
async function vocabOf(ids) {
  const need = [...new Set(ids)].filter((i) => !PIECES.has(i) && !(MODEL === 'gpt2' && i === 65535));   // 65535: no token, in GPT-2's corpus files
  if (need.length) (await engine.vocab(need)).forEach((p, j) => PIECES.set(need[j], p));
  return PIECES;
}
const word = (t) => { const p = String(PIECES.get(t) ?? '?'); return tokText(p.trim()) || tokText(p); };

function andList(xs) { return xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`; }
function densityText(d) { return d >= 0.01 ? pct(d, 1) : d >= 1e-4 ? pct(d, 3) : d > 0 ? '<0.01%' : '0%'; }
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }
function signed(x) { return (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(2); }
