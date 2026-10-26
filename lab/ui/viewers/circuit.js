/* lab/ui/viewers/circuit.js: a feature-circuit result. Does the behaviour exist (clean against corrupt), the circuit
   itself, and whether it is real: patching its top features for real against random features, and how much of each
   layer's effect the first-order estimate accounts for. */

import { h, mount, fmt, pct } from '../dom.js';
import { dumbbell, intervals, bars } from '../charts.js';
import { arr, json, section } from './common.js';
import { graphView } from './graphview.js';

export async function render(el, p) {
  const d = p.data;
  const [mc, mx] = await Promise.all([arr(p, 'm_clean'), arr(p, 'm_corrupt')]);
  const ex = d.examples || [];

  /* ---------------- the task */
  const task = section('First: does the behaviour exist?', 'circ-task', {
    1: `<p>Each row is one sentence. The blue dot is how strongly the model prefers the right name over the wrong one; the
gray dot is the same for a <b>corrupted</b> version where the right answer has no clue to go on. A circuit can only be found
if blue sits clearly to the right of gray: that gap is the behaviour we want to explain.</p>`,
    2: `<p>Metric: logit difference (answer minus foil) at the last token. Clean prompts contain the information; corrupt
prompts replace the names so the answer has nothing to point back to (the ABC baseline of Wang et al., 2022). The
circuit is whatever carries the clean-minus-corrupt gap, averaged over ${d.n_items} pairs.</p>`,
    3: '<p>The gap\'s bootstrap interval must exclude zero (first claim). A model can be right for reasons the corrupt baseline does not remove (for example a prior for the first-named person), which inflates the gap without a circuit; vary templates to check.</p>',
  });
  const c1 = h('div');
  task.body.appendChild(c1);
  if (mc && mx) {
    const n = mc.data.length;
    dumbbell(c1, {
      rows: Array.from({ length: n }, (_, i) => ({ label: ex[i] ? `${ex[i].answer.trim()} over ${ex[i].foil.trim()}: ${ex[i].clean}` : `pair ${i + 1}`, a: mx.data[i], b: mc.data[i],
        note: ex[i] ? ex[i].clean : '' })).slice(0, 24),
      aName: 'corrupted prompt', bName: 'clean prompt', ref: 0, x: { label: 'preference for the right name (logit difference)' },
      caption: `${n} pairs${n > 24 ? ' (the first 24 shown)' : ''}. Right of the zero line means the right name is preferred.`,
    });
  }

  /* ---------------- the circuit */
  let circ = null;
  if (d.graph) {
    circ = section('The circuit', 'circ-graph', {
      1: `<p>Each node is a <b>feature</b>: one entry in the dictionary that rewrites the model's thinking at a layer. Bigger
nodes matter more for the answer. Lines show which features feed which; blue lines help the right answer, red ones hurt
it. Gray squares are <b>errors</b>: the part of the model's thinking the dictionary could not rewrite, so the circuit cannot
see what happens there.</p>`,
      2: `<p>Node effect: how much the clean-minus-corrupt gap changes if this feature alone took its corrupt value, estimated
${d.method === 'ig' ? 'with integrated gradients (several steps between clean and corrupt)' : 'to first order (attribution patching: activation difference × gradient)'}, summed over ${d.aligned ? 'each position' : 'positions'}.
Link weight: the same estimate for the path from one feature to another, with the dictionaries spliced into the model so
gradients flow through the features. The top-${(p.spec && p.spec.top_nodes) || ''} nodes by effect are drawn.</p>`,
      3: '<p>This is Marks et al.\'s sparse feature circuits (2024) on residual-stream dictionaries: nodes are SAE latents and error terms at chosen layers, edges are linearised effects through the spliced model. First-order estimates fail where the model is far from linear between clean and corrupt (attention saturation, LayerNorm); the completeness check below measures how badly, layer by layer.</p>',
    });
    try {
      const g = await json(p, d.graph);
      const gv = h('div');
      circ.body.appendChild(gv);
      graphView(gv, g, { tokens: d.aligned ? d.tokens : [], maxNodes: 40 });
    } catch (e) {
      circ.body.appendChild(h('p.err', null, String(e.message || e)));
    }
  }

  /* ---------------- is it real */
  const real = section('Is it real? Patching the top features for real', 'circ-real', {
    1: `<p>The drawing is an estimate. The test: actually switch the top few features to their corrupted values and see how
much of the behaviour disappears. Blue is how much of the gap the top features remove; gray dots are the same number of
<b>random</b> active features, which should remove little. If blue is not clearly right of gray, the circuit is not
the explanation.</p>`,
    2: `<p>For k = ${(d.validation || []).map((v) => v.k).join(', ')}: patch the k highest-effect features from the corrupt run into the clean run (real
forward passes, not the linear estimate) and report the share of the clean-minus-corrupt gap removed, with a bootstrap
interval over pairs. 100% means those k features carry the whole behaviour.</p>`,
    3: '<p>Faithfulness by ablation is the standard check (Marks et al. 2024; Conmy et al. 2023), with random active features of the same count as the null. Intervals over pairs are wide with few pairs; a share above 100% means the patch overshoots (the features also carry part of the corrupt behaviour).</p>',
  });
  const c3 = h('div');
  real.body.appendChild(c3);
  if (d.validation && d.validation.length) {
    intervals(c3, {
      rows: d.validation.map((v) => ({ label: `top ${v.k} feature${v.k === 1 ? '' : 's'}`, est: v.top, lo: v.top_ci && v.top_ci[0], hi: v.top_ci && v.top_ci[1], ctrl: v.random || [] })),
      x: { label: 'share of the behaviour removed', fmt: (v) => pct(v), min: Math.min(-0.5, ...d.validation.map((v) => Math.max(-2, v.top_ci ? v.top_ci[0] : v.top))), max: Math.max(1.1, ...d.validation.map((v) => Math.min(2, v.top_ci ? v.top_ci[1] : v.top))) },
      ref: 0, estName: 'top features (95% interval)', ctrlName: 'random active features, same number',
      caption: 'Further right means more of the behaviour removed. Arrows mark intervals that run off the chart.',
    });
  }
  if (d.completeness) {
    const comp = h('div');
    real.body.appendChild(h('h3', null, 'How much of each layer the estimate accounts for'));
    real.body.appendChild(comp);
    bars(comp, { items: Object.entries(d.completeness).map(([L, v]) => ({ label: `layer ${L}`, value: v, note: Math.abs(v - 1) < 0.25 ? 'close to 1: trustworthy' : 'far from 1: read with care' })),
      signed: true, max: Math.max(1.5, ...Object.values(d.completeness).map(Math.abs)), fmtv: (v) => fmt(v, 2),
      caption: d.completeness_note || 'Summed node effects divided by the real gap; near 1 is good.' });
  }

  /* ---------------- the pairs */
  const pairs = section('The sentences', 'circ-pairs', null);
  pairs.body.appendChild(h('ul.small', null, ex.slice(0, 12).map((x) => h('li', null, x.clean, h('b', null, ' →' + x.answer), h('span.muted', null, ` (not${x.foil})`)))));
  if (d.skipped && (d.skipped.length || d.skipped.same_first_token)) {
    pairs.body.appendChild(h('p.small.muted', null, `Skipped: ${d.skipped.length || 0} pairs whose two prompts tokenised to different lengths, ${d.skipped.same_first_token || 0} whose answer and foil share a first token.`));
  }

  mount(el, task.el, circ && circ.el, real.el, pairs.el);
}
