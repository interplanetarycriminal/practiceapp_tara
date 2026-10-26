/* lab/ui/tools/ablate.js: the knock-out sweep. Switch off each of the 144 heads in turn (replace its output with its
   average over this prompt, or with zero) and measure how the answer's logit difference changes. Plotted against
   direct attribution, it separates heads that write the answer from heads that matter by feeding others, and shows
   the model repairing itself. */

import { h, mount as put, fmt, tokText, debounce } from '../dom.js';
import { toolPage, field, textArea, textInput, select, presets, runner, whenReady, memo, toolLink } from './kit.js';
import { engine, isGPU } from '../engine.js';
import { grid, scatter, bars, stat, tipRow, col } from '../charts.js';

const TEACH = {
  what: {
    1: `<p>Attribution says who <i>wrote</i> the answer. But a part of the model can matter without writing the answer
itself, for example by telling another part where to look. The blunt test: switch each head off, one at a time, and
see how much the answer suffers.</p>
<p>Sometimes switching off an important head barely hurts, because other heads step in and do its job. That
self-repair is one of the surprises of real models.</p>`,
    2: `<p>For each of the 144 heads, the lab reruns the prompt with that head's output replaced, then measures the logit
difference (answer minus foil) again. <b>Mean ablation</b> replaces the head's output with its average over this prompt's
tokens: it removes what the head does here, not the head's typical background contribution. <b>Zero ablation</b> sets
it to zero, which also removes that background and can break things the head never did on purpose.</p>
<div data-angle="analogy"><p>Testing which players matter by benching them one at a time. A star scorer may barely be
missed if the substitute also scores; the playmaker who never scores may be the one whose absence collapses the
team.</p></div>`,
    3: `<p>Δ<sub>h</sub> = m(x | do(z<sub>h</sub> = z̄<sub>h</sub>)) − m(x), with z<sub>h</sub> the head's hook_z (before W<sub>O</sub>) and z̄<sub>h</sub> its mean
over positions 1…T−1 of this prompt (a dataset mean is the stricter standard). Single-head ablations miss redundancy:
when two heads back each other up, each looks unimportant alone. Compare with the scatter: points far above the
y = −x line wrote a lot but cost little when removed (backup and self-repair; Wang et al., 2022; McGrath et al.,
2023); points below it matter more than they wrote (indirect effects through later heads).</p>`,
  },
  read: {
    1: `<p>Red heads: the answer got weaker without them (they were helping). Blue heads: the answer got stronger without
them (they were arguing for the foil). The scatter puts each head's knock-out effect next to what it wrote directly:
heads near the dashed line did their work themselves; heads far from it are where the interesting story is.</p>`,
    2: `<p>Units are logits of the difference. The dashed line is "removing the head removes exactly what it wrote
directly" (y = −x). Above the line: removal cost less than its direct effect (someone else compensated). Below: removal
cost more (it also mattered through other heads). Tap a head for links.</p>`,
    3: `<p>Each run is one forward pass per head, batched in groups; results are kept for this visit, so returning to the
page does not recompute. Mean over the prompt's own positions includes positions where the head is idle, which is the
usual ARENA convention for a single prompt.</p>`,
  },
  why: {
    1: `<p>Knock-outs are the first causal test: they ask "does the model need this?", not just "what does it look like?".
Week 4's activation patching refines the same idea.</p>`,
    2: `<p>Ablation is how circuits are checked in the IOI paper (and how a "minimal circuit" is defined: keep these heads,
ablate everything else, and the behaviour survives). It also underpins evals of safety interventions: ablating a
refusal direction (Arditi et al., 2024) is a knock-out of a direction rather than a head.</p>`,
    3: `<p>Resample ablation (replace with activations from a different prompt) and causal scrubbing generalise this.
Self-repair means single ablations understate importance; report it, and test pairs or paths when a head's direct
effect is large but its ablation effect is small.</p>`,
  },
};

const EXAMPLES = [
  { label: 'Mary or John', text: 'When Mary and John went to the store, John gave a drink to', answer: ' Mary', foil: ' John' },
  { label: 'Alice or Bob', text: 'When Alice and Bob went to the park, Bob handed a ball to', answer: ' Alice', foil: ' Bob' },
];

export function mount(el, meta, api) {
  const P = api.params, life = { dead: false };
  const st = { text: P.text ?? EXAMPLES[0].text, answer: P.answer ?? EXAMPLES[0].answer, foil: P.foil ?? EXAMPLES[0].foil, mode: P.mode === 'zero' ? 'zero' : 'mean', pick: null };
  const page = toolPage(el, meta, TEACH);
  const save = debounce(() => api.setParams({ text: st.text, answer: st.answer, foil: st.foil, mode: st.mode }), 400);
  const count = h('span'), warn = h('div.small.muted');
  const ta = textArea(st.text, { rows: 2, oninput: (e) => { st.text = e.target.value; save(); } });
  const aIn = textInput(st.answer, { oninput: (e) => { st.answer = e.target.value; save(); } });
  const fIn = textInput(st.foil, { oninput: (e) => { st.foil = e.target.value; save(); } });
  const mSel = select([['mean', 'mean over this prompt (recommended)'], ['zero', 'zero']], st.mode, (v) => { st.mode = v; save(); });
  const runSlot = h('div');
  const run = runner('Knock out all 144 heads', runSlot, (onP, ctl) => compute(onP, ctl));
  const cost = h('span.small.muted');
  put(page.controls,
    field('Your text', ta, count),
    presets(EXAMPLES, (x) => { ta.value = st.text = x.text; aIn.value = st.answer = x.answer; fIn.value = st.foil = x.foil; save(); }),
    h('div.fields.three', { style: { marginTop: '10px' } }, field('Answer', aIn), field('Foil', fIn), field('Replace each head\'s output with', mSel)),
    warn, h('div.row', { style: { marginTop: '10px' } }, run.btn, cost), runSlot);

  const tiles = h('div.stats'), gridBox = h('div'), pickBox = h('div.small', { style: { minHeight: '2.4em' } }), sc = h('div'), lists = h('div');
  put(page.result, tiles,
    h('div.res-cols', null,
      h('div', null, h('h3', null, 'What breaks without each head'), gridBox, pickBox),
      h('div', null, h('h3', null, 'Knocked out versus written directly'), sc)),
    lists);

  async function compute(onP, ctl) {
    const t = await engine.tok(st.text);
    count.textContent = `${t.ids.length - 1} tokens`;
    const a = await engine.token(st.answer), b = await engine.token(st.foil);
    put(warn, [a, b].filter((x) => x.n > 1).map((x) => `"${x.pieces.join('')}" is ${x.n} tokens; its first is scored`).join('. '));
    const key = ['ablate', st.mode, a.id, b.id, t.ids.join(',')].join('|');
    let res = memo.get(key);
    if (!res) {
      const metric = { kind: 'logitdiff', a: a.id, b: b.id, pos: t.ids.length - 1 };
      const sweep = await ctl.track(engine.recipe('headSweep', { ids: t.ids, metric, mode: st.mode },
        { onProgress: (x) => onP(x.done, x.total, `${x.done} of ${x.total} heads knocked out`) }));
      const d = await ctl.track(engine.recipe('dla', { ids: t.ids, a: a.id, b: b.id, neurons: 1 }));
      res = { sweep, heads: d.heads, a, b, mode: st.mode };
      memo.set(key, res);
    }
    if (!life.dead) draw(res);
  }

  function draw(res) {
    const { sweep, heads, a, b } = res, D = sweep.delta;
    let m = 1e-9, lo = 0, hi = 0;
    for (let i = 0; i < 144; i++) { m = Math.max(m, Math.abs(D[i])); if (D[i] < D[lo]) lo = i; if (D[i] > D[hi]) hi = i; }
    const nm = (i) => `L${Math.floor(i / 12)}H${i % 12}`;
    const ab = `${tokText(a.piece)} minus ${tokText(b.piece)}`;
    put(tiles,
      stat('With every head on', signed(sweep.clean), ab),
      stat('Hurt most without', nm(lo), `${signed(D[lo])}: the answer gets weaker`),
      stat('Helped most without', nm(hi), `${signed(D[hi])}: it was arguing for ${tokText(b.piece)}`));
    const choose = (l, x) => {
      st.pick = [l, x];
      const i = l * 12 + x;
      put(pickBox, h('b', null, nm(i)), `: knocking it out changes the score by ${signed(D[i])}; it wrote ${signed(heads[i])} directly. `,
        toolLink('attention', { text: st.text, layer: l, head: x }, 'Where does it look?'), ' · ', toolLink('ov', { layer: l, head: x }, 'What does it write?'));
    };
    grid(gridBox, {
      rows: 12, cols: 12, cell: 40, minCell: 22, aspect: 0.75, scale: 'div', max: m, fmt: (v) => fmt(v, 1),
      value: (l, x) => D[l * 12 + x], text: (l, x) => { const v = D[l * 12 + x]; return Math.abs(v) >= 0.35 * m ? fmt(v, 1) : ''; },
      rowLabels: [...Array(12).keys()].map((l) => 'L' + l), colLabels: [...Array(12).keys()].map((x) => 'H' + x),
      loLabel: 'answer weaker', hiLabel: 'answer stronger', selected: st.pick,
      tip: (l, x) => [h('div.tip-head', null, nm(l * 12 + x)), tipRow(signed(D[l * 12 + x]), 'change when knocked out'), tipRow(signed(heads[l * 12 + x]), 'written directly')],
      onPick: choose,
      caption: `Rows: layers 0 (top) to 11. Columns: heads. ${res.mode === 'mean' ? 'Mean' : 'Zero'} ablation, one head at a time.`,
    });
    if (st.pick) choose(...st.pick); else put(pickBox, h('span.muted', null, 'Tap a head for links to look at it more closely.'));
    // tag the heads that stand out on either axis
    const byD = [...Array(144).keys()].sort((u, v) => Math.abs(D[v]) - Math.abs(D[u])).slice(0, 4);
    const byA = [...Array(144).keys()].sort((u, v) => Math.abs(heads[v]) - Math.abs(heads[u])).slice(0, 3);
    const tagged = new Set([...byD, ...byA]);
    scatter(sc, { height: 280, ticks: true,
      classes: [{ name: 'a head', color: col('s1') }],
      points: [...Array(144).keys()].map((i) => ({ x: heads[i], y: D[i], c: 0, r: tagged.has(i) ? 5 : 3.5, tag: tagged.has(i) ? nm(i) : null,
        head: nm(i), label: `wrote ${signed(heads[i])} directly; knocking it out changes the score by ${signed(D[i])}` })),
      x: { label: 'written directly (logits)' }, y: { label: 'change when knocked out' },
      ref: { slope: -1, intercept: 0, label: 'removes just what it wrote' },
      onPick: (p) => { const i = p.head.match(/L(\d+)H(\d+)/); choose(Number(i[1]), Number(i[2])); },
      caption: 'Each dot is one head. On the dashed line, knocking a head out removes exactly what it wrote. Above it: others made up for it. Below it: it mattered through other heads too.' });
    const order = [...Array(144).keys()].sort((u, v) => D[u] - D[v]);
    const hurt = h('div'), help = h('div');
    put(lists, h('div.res-cols', null,
      h('div', null, h('h3', null, 'Hurt most when removed'), hurt),
      h('div', null, h('h3', null, 'Helped when removed'), help)));
    bars(hurt, { items: order.slice(0, 8).map((i) => ({ label: nm(i), value: D[i], note: `wrote ${signed(heads[i])}` })), signed: true, max: m, fmtv: signed });
    bars(help, { items: order.slice(-5).reverse().map((i) => ({ label: nm(i), value: D[i], note: `wrote ${signed(heads[i])}` })), signed: true, max: m, fmtv: signed });
  }

  whenReady(page, life, async () => {
    cost.textContent = isGPU() ? 'A few seconds on this graphics card.' : 'Two to three minutes on a processor; it can run while you read.';
    const t = await engine.tok(st.text);
    count.textContent = `${t.ids.length - 1} tokens`;
    // show a result straight away if this visit already computed it
    const a = await engine.token(st.answer), b = await engine.token(st.foil);
    const res = memo.get(['ablate', st.mode, a.id, b.id, t.ids.join(',')].join('|'));
    if (res) draw(res); else if (isGPU()) run.go();
  });
  return { destroy() { life.dead = true; } };
}

function signed(x) { return (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(2); }
