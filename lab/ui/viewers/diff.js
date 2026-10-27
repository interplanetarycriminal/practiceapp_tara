/* lab/ui/viewers/diff.js: a model-diff result (base model A against tuned model B, the same prompts through both).
   Where in depth the activations moved, token by token for two showcase prompts, how much the next-token bet
   changed, whether one average shift vector reproduces the change, what that shift says, and which dictionary
   features grew or faded. */

import { h, mount, fmt, pct, tokText } from '../dom.js';
import { lineChart, grid, bars, intervals, stat, col, tipRow } from '../charts.js';
import { arr, section, lensLists } from './common.js';

export async function render(el, p) {
  const d = p.data;
  const rows = d.rows || [];
  const A = d.a, B = d.b;
  const ss = d.steer_split || {};

  /* ---------------- where */
  const where = section('Where the change lives', 'diff-where', {
    1: `<p>The same ${d.n_prompts} prompts go through both models: <b>${A}</b> (before) and <b>${B}</b> (after). At every
layer we measure how different B's thinking is from A's, as a share of its size. Peaks show where the extra training
did most of its work.</p>`,
    2: `<p>For each of the ${d.n_tokens} tokens: ‖h<sub>B</sub> − h<sub>A</sub>‖ ÷ ‖h<sub>A</sub>‖ at the output of each layer; the blue line is the median
token, the orange the 90th percentile (the most-changed tenth). The tooltip also gives the cosine between the two
states and the size of the <i>average</i> shift: a large per-token change with a small average shift means the change
depends on the token, not a constant offset.</p>
<div data-angle="analogy"><p>Two editions of the same book compared page by page: the chart says which chapters were rewritten.</p></div>`,
    3: `<p>This compares activations in one coordinate system, which is valid for a fine-tune of the same base (shared
initialisation, small updates) and meaningless across independently trained models. Both models ran in ${d.precision || 'the same precision'}
with ${d.format === 'chat' ? 'the chat template' : 'raw text'}; the activation-difference lens follows Minder et al. (2025).</p>`,
  });
  const c1 = h('div');
  where.body.appendChild(c1);
  lineChart(c1, {
    height: 240,
    series: [
      { name: 'median token', color: col('s1'), pts: rows.map((r) => [r.layer, r.rel_median]) },
      { name: 'most-changed tenth (90th percentile)', color: col('s2'), pts: rows.map((r) => [r.layer, r.rel_p90]) },
    ],
    x: { label: 'layer', fmt: (v) => String(v) }, y: { label: 'change (share of the state)', fmt: (v) => pct(v) },
    tipExtra: (L) => {
      const r = rows.find((x) => x.layer === L);
      return r ? h('div', null, tipRow(fmt(r.cos_mean, 3), 'cosine between the two states'), tipRow(pct(r.delta_rel, 1), 'size of the average shift')) : null;
    },
    caption: `${d.n_tokens} tokens from ${d.n_prompts} prompts. Hover or tap a layer.`,
  });

  /* ---------------- showcase */
  let show = null;
  if (d.showcase && d.showcase.length) {
    show = section('Token by token', 'diff-show', {
      1: '<p>Two of the prompts, every token and every layer: darker cells changed more. Look for tokens that stand out, such as the start of an answer or a word the tuned model treats differently.</p>',
      2: '<p>Each cell is the relative change for one token at one layer, the same measure as the median line above. Rows are layers (first at the top), columns are tokens.</p>',
      3: '<p>Per-token relative change is dominated by tokens with small norms; the first token (attention sink) is often extreme in both models, so it is shown but worth discounting.</p>',
    });
    for (const sc of d.showcase) {
      const a = await arr(p, sc.array);
      if (!a) continue;
      const [nl, nt] = a.shape;
      let mx = 1e-6;
      for (const v of a.data) if (Number.isFinite(v)) mx = Math.max(mx, v);
      const g = h('div');
      show.body.appendChild(h('div.card.flat', { style: { marginBottom: '10px' } }, h('div.small.muted', null, sc.prompt), g));
      grid(g, { rows: nl, cols: nt, value: (r, c) => a.at(r, c), scale: 'seq', max: mx, min: 0,
        rowLabels: (d.layers || []).map((L) => 'L' + L), colLabels: sc.tokens, cell: 34, minCell: 16,
        fmt: (v) => pct(v), loLabel: '', hiLabel: 'change',
        tip: (r, c) => [h('div.tip-head', null, `layer ${d.layers[r]} · ${tokText(sc.tokens[c])}`), tipRow(pct(a.at(r, c), 1), 'relative change', col('s1'))] });
    }
  }

  /* ---------------- next-token bet */
  let bet = null;
  if (d.kl) {
    bet = section('How much the next-word bet changed', 'diff-kl', {
      1: '<p>For each prompt, how differently the two models bet on the next word. Zero means identical bets; bigger means the tuned model would write something else.</p>',
      2: `<p>KL(B ‖ A) of the next-token distributions in nats, averaged over positions and then over prompts, with a ${/KL: Student/.test(d.interval || '') ? 'Student t' : 'bootstrap'} interval over prompts. The list shows the prompts where the bets differ most, a quick way to see what kind of text the training changed.</p>`,
      3: '<p>KL is asymmetric; KL(B‖A) weights the tokens the tuned model likes. It measures the size of the behavioural change, not its direction; the steering test below asks whether one vector carries it.</p>',
    });
    bet.body.appendChild(h('div.stats', null, stat('Average KL', fmt(d.kl.mean, 3) + ' nats', d.kl.ci ? `95% interval ${fmt(d.kl.ci[0], 3)} to ${fmt(d.kl.ci[1], 3)}` : '')));
    const kla = d.kl.per_prompt_array ? await arr(p, d.kl.per_prompt_array) : null;
    if (kla && d.prompts) {
      const items = Array.from(kla.data).map((v, i) => ({ label: d.prompts[i], value: v })).sort((x, y) => y.value - x.value).slice(0, 8);
      const b = h('div');
      bet.body.appendChild(b);
      bars(b, { items: items.map((it) => ({ ...it, title: it.label })), fmtv: (v) => fmt(v, 3), caption: 'The eight prompts where the two models disagree most (KL in nats).' });
    }
  }

  /* ---------------- one vector? */
  let vec = null;
  if (d.steer && d.steer.length) {
    vec = section('Can one vector reproduce the change?', 'diff-vec', {
      1: `<p>If the training mostly added one fixed "nudge" to the model's thinking, then adding that same nudge to the
<b>before</b> model should make it bet like the <b>after</b> model.${ss.held_out ? ' The nudge is made from half the prompts and tested on the other half, so it cannot just memorise them.' : ''} Blue: how much of the gap the average nudge closes. Gray: random
nudges of the same size, which should close nothing.</p>`,
      2: `<p>The average shift Δ̄ = mean(h<sub>B</sub> − h<sub>A</sub>) at one layer${ss.held_out ? `, over the ${ss.fit} fitting prompts,` : ''} is added to model A at every position, and the
next-token KL to model B is measured again${ss.held_out ? ` on the ${ss.eval} other prompts` : ''}. "Closed" is 1 − (total KL after ÷ total KL before), a ratio of means, with a
bootstrap interval that resamples prompts whole. ${ss.held_out ? 'The starred row is the layer and dose that did best on the fitting prompts; its score here is on the others. ' : ''}100% would mean the whole behavioural difference is one direction
at that layer.</p>`,
      3: '<p>A fine-tune that installs a single direction (as reported for some narrow fine-tunes and refusal) closes much of the gap; a diffuse change closes little. The random vector controls for "any push of this size moves the distribution". Negative values mean the push moved A further from B.</p>',
    });
    const c = h('div');
    vec.body.appendChild(c);
    const fit = (s) => (s.delta.closed_fit ?? s.delta.closed);
    const star = d.steer.reduce((a, s) => (fit(s) > fit(a) ? s : a), d.steer[0]);
    const R = (d.steer[0].random && (d.steer[0].random.n || (d.steer[0].random.closed_all || []).length)) || 1;
    intervals(c, {
      rows: d.steer.map((s) => ({ label: `layer ${s.layer}, dose ${fmt(s.dose, 1)}${ss.held_out && s === star ? ' ★' : ''}`, est: s.delta.closed, lo: s.delta.closed_ci && s.delta.closed_ci[0],
        hi: s.delta.closed_ci && s.delta.closed_ci[1], ctrl: s.random ? (s.random.closed_all || [s.random.closed]) : [] })),
      x: { label: `share of the KL gap closed${ss.held_out ? ', on held-out prompts' : ''}`, fmt: (v) => pct(v) }, ref: 0,
      estName: 'average shift (95% interval)', ctrlName: `${R === 1 ? 'a random vector' : R + ' random vectors'}, same size`,
      caption: `Further right is better; gray dots are the random controls.${ss.held_out ? ' ★ marks the layer and dose picked on the fitting prompts.' : ''}`,
    });
  }

  /* ---------------- the shift through the unembedding */
  let lens = null;
  const lensLayers = Object.keys(d.lens || {}).map(Number).sort((x, y) => x - y);
  if (lensLayers.length) {
    lens = section('What the shift says, read as words', 'diff-lens', {
      1: '<p>The average nudge at each layer, read as words: what it makes more and less likely if it went straight to the output.</p>',
      2: `<p>The mean shift at the chosen layer through ${A}'s final norm and unembedding (the logit lens). Late layers read most directly; early ones are a hint at best.</p>`,
      3: '<p>Only the direct path to the logits; the later layers can transform the shift entirely. Pair with the steering test above before reading it as what the training did.</p>',
    });
    const picker = h('div.chips', { role: 'group', 'aria-label': 'Layer' });
    const out = h('div');
    let cur = lensLayers[lensLayers.length - 1];
    const draw = () => mount(out, lensLists(d.lens[cur].up, d.lens[cur].down, { upName: `More likely after training (layer ${cur})`, downName: 'Less likely' }));
    for (const L of lensLayers) {
      const b = h('button.chip', { type: 'button', 'aria-pressed': String(L === cur) }, 'L' + L);
      b.addEventListener('click', () => { cur = L; for (const x of picker.children) x.setAttribute('aria-pressed', String(x === b)); draw(); });
      picker.appendChild(b);
    }
    mount(lens.body, picker, out, d.lens_note ? h('p.small.muted', null, d.lens_note) : null);
    draw();
  }

  /* ---------------- features */
  let feats = null;
  const fl = Object.keys(d.features || {});
  if (fl.length) {
    feats = section('Dictionary features that grew and faded', 'diff-feats', {
      1: '<p>Reading both models with the same dictionary: which features fire more after training, and which less. Feature numbers are the dictionary\'s own; the features result for that layer shows what each one means.</p>',
      2: '<p>Mean activation over every token in A and in B, and how often each fires (density). The dictionary was trained on the base model, so it reads B less faithfully; changes in a feature that B barely uses can be reconstruction error.</p>',
      3: '<p>Ranked by the change in mean activation. Model-diffing work (crosscoders, Lindsey et al. 2024; Minder et al. 2025) warns that dictionary-based diffs over-attribute change to features that are merely reconstructed differently; check a feature with a steering spec before claiming it.</p>',
    });
    for (const L of fl) {
      const f = d.features[L];
      const row = (x) => h('li', null, h('b', null, `#${x.feature}`), ` ${fmt(x.mean_a, 3)} → ${fmt(x.mean_b, 3)}`,
        h('span.muted', null, ` (fires ${pct(x.density_a, 1)} → ${pct(x.density_b, 1)})`));
      feats.body.appendChild(h('div.card.flat', { style: { marginBottom: '10px' } }, h('div.small-caps', null, `Layer ${L}`),
        h('div.grid2', null,
          h('div', null, h('div.small', null, h('b', null, 'Grew')), h('ul.small', null, (f.grew || []).map(row))),
          h('div', null, h('div.small', null, h('b', null, 'Faded')), h('ul.small', null, (f.faded || []).map(row))))));
    }
  }

  mount(el, where.el, show && show.el, bet && bet.el, vec && vec.el, lens && lens.el, feats && feats.el);
}
