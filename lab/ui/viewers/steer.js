/* lab/ui/viewers/steer.js: a steering result. The dose curve against its random-direction controls, what the push
   costs on ordinary text, what the model writes at each dose, what the direction says through the unembedding, and
   where it came from. */

import { h, mount, fmt, signed } from '../dom.js';
import { lineChart, col, tipRow } from '../charts.js';
import { arr, section, lensLists } from './common.js';

const METRIC = {
  logit_diff: 'logit difference', prob: 'probability', logprob: 'log-probability', seq_logprob: 'sequence log-prob difference',
};

export async function render(el, p) {
  const d = p.data;
  const doses = d.doses;
  const L = (d.direction && d.direction.layer) ?? d.layers[0];
  const [per, rnd] = await Promise.all([arr(p, 'per_prompt'), arr(p, 'random_curve')]);
  const j0 = doses.indexOf(0);
  const base = j0 >= 0 ? d.curve[j0].mean : null;
  const top = d.curve[d.curve.length - 1], bot = d.curve[0];
  const R = rnd ? rnd.shape[0] : (d.random && d.random.n) || 0;
  const xLabel = d.units === 'resid' ? 'push (× the typical size of the residual stream)' : 'push (raw units)';
  const yLabel = METRIC[d.metric && d.metric.kind] || 'metric';
  const nP = per ? per.shape[1] : (d.metric && d.metric.n_prompts) || 0;
  const tInt = /Student/.test(d.interval || '');
  const rmax = (j) => {
    if (!rnd || j0 < 0) return null;
    let m = 0;
    for (let r = 0; r < R; r++) m = Math.max(m, Math.abs(rnd.at(r, j) - rnd.at(r, j0)));
    return m;
  };

  /* ---------------- the dose curve */
  const dc = section('The dose curve', 'steer-dose', {
    1: `<p>Each blue dot is how strongly the model prefers one next word over another (${esc(d.metric && d.metric.describe || 'the metric')})
after its thoughts are pushed along the direction by that much. Higher means more of the behaviour. The gray lines
are pushes of exactly the same size along random directions. If the blue line climbs and the gray ones stay flat, it
is the <i>direction</i> that matters, not just the size of the push.</p>`,
    2: `<p>x is the dose: the push added to the residual stream at layer ${L}, in multiples of its typical size there
(${d.resid_norm && d.resid_norm[L] ? fmt(d.resid_norm[L], 1) : 'the median norm'}). y is the metric averaged over ${nP} prompt${nP === 1 ? '' : 's'}, with a 95%
${tInt ? 'Student t' : 'bootstrap'} interval across prompts as the band${nP < 2 ? ' (one prompt gives none)' : ''}. With no push it sits at ${fmt(base, 2)}; at dose ${fd(top.dose)} it reaches
${fmt(top.mean, 2)}, a shift of ${signed(top.mean - base, 2)}, while ${R} random directions of the same size move it by at most
${fmt(rmax(doses.length - 1), 2)}.</p>
<div data-angle="analogy"><p>A dimmer switch tested against random switches on the same wall: if only one switch dims the
light, it is wired to the light.</p></div>`,
    3: `<p>Intervention: x<sub>L</sub> ← x<sub>L</sub> + α·‖r‖·d̂ at every position, with ‖r‖ the median residual norm at layer ${L}
over a reference corpus and d̂ the unit direction. Controls are isotropic random unit vectors at the same α, so they match
the perturbation's norm but not its direction. The stamp needs the effect (relative to α = 0) to have a CI excluding
zero and to exceed both 3 sd and the maximum of the random effects.${tInt ? ' Intervals are Student t over prompts, because a percentile bootstrap of a few prompts is too narrow; one prompt has no interval, so it cannot earn the stamp.' : ''} Dose curves are not linear: past a point the stream
leaves the distribution the later layers were trained on, which the loss panel below measures.</p>`,
  });
  const modeRow = h('div.chips', { role: 'group', 'aria-label': 'What the curve shows' });
  const chart = h('div');
  const modes = [['mean', 'Average with its interval'], ['each', `Each of the ${nP} prompts`]];
  let mode = 'mean';
  const drawCurve = () => {
    const ctrl = col('ctrl'), blue = col('s1');
    const ser = [];
    for (let r = 0; r < R; r++) ser.push({ name: `${R} random directions, same size`, color: ctrl, muted: true, marker: false, width: 1.1,
      hideLegend: r > 0, noTip: true, pts: doses.map((x, j) => [x, rnd.at(r, j)]) });
    if (mode === 'mean' || !per) {
      ser.push({ name: 'the direction (mean, 95% interval)', color: blue, pts: d.curve.map((c) => [c.dose, c.mean]),
        band: d.curve.map((c) => [c.dose, c.lo, c.hi]) });
    } else {
      for (let q = 0; q < nP; q++) ser.push({ name: 'the direction, one line per prompt', color: blue, width: 1.4, marker: false, hideLegend: q > 0,
        noTip: true, pts: doses.map((x, j) => [x, per.at(j, q)]) });
    }
    lineChart(chart, {
      height: 260, series: ser,
      x: { label: xLabel, fmt: fd, ticks: spaced(doses) },
      y: { label: yLabel, zero: false },
      hlines: base !== null ? [{ y: base, label: 'no push' }] : [],
      tipExtra: (xv) => {
        const j = doses.indexOf(xv);
        const rows = [];
        if (mode === 'each' && per) {
          let lo = Infinity, hi = -Infinity;
          for (let q = 0; q < nP; q++) { lo = Math.min(lo, per.at(j, q)); hi = Math.max(hi, per.at(j, q)); }
          rows.push(tipRow(`${fmt(lo, 2)} to ${fmt(hi, 2)}`, `the ${nP} prompts`, blue));
        }
        if (rnd) {
          let lo = Infinity, hi = -Infinity;
          for (let r = 0; r < R; r++) { lo = Math.min(lo, rnd.at(r, j)); hi = Math.max(hi, rnd.at(r, j)); }
          rows.push(tipRow(`${fmt(lo, 2)} to ${fmt(hi, 2)}`, `${R} random directions`, ctrl));
        }
        return rows.length ? h('div', null, rows) : null;
      },
      caption: `${d.metric && d.metric.describe ? d.metric.describe[0].toUpperCase() + d.metric.describe.slice(1) : 'The metric'}, averaged over ${nP} prompts. Hover or tap for values.`,
    });
  };
  for (const [k, label] of modes) {
    const b = h('button.chip', { type: 'button', 'aria-pressed': String(k === mode) }, label);
    b.addEventListener('click', () => { mode = k; for (const x of modeRow.children) x.setAttribute('aria-pressed', String(x === b)); drawCurve(); });
    modeRow.appendChild(b);
  }
  if (!per) modeRow.hidden = true;
  mount(dc.body, modeRow, chart);
  drawCurve();
  const n = d.curve.length, bends = [];
  if (base !== null && n >= 3) {
    if (bot.dose < 0 && Math.abs(bot.mean - base) < Math.abs(d.curve[1].mean - base)) bends.push('negative');
    if (top.dose > 0 && Math.abs(top.mean - base) < Math.abs(d.curve[n - 2].mean - base)) bends.push('positive');
  }
  if (bends.length) dc.body.appendChild(h('p.note', null, `The curve bends back on the ${bends.join(' and ')} side: the biggest push does less than a smaller one. Past a certain size a push stops steering and starts breaking the text, which the next panel measures.`));

  /* ---------------- what it costs */
  const nll = d.nll;
  let cost = null;
  if (nll && nll.direction) {
    cost = section('What the push costs', 'steer-cost', {
      1: `<p>Pushing hard also makes the model worse at ordinary writing. This is how surprised it is by ${nll.n_texts} plain,
neutral texts at each push size: flat is free, a rise is damage. Gray lines are random pushes of the same size, so the
gap between blue and gray is the damage caused by this direction in particular.</p>`,
      2: `<p>Mean next-token loss (cross-entropy, in nats) on ${nll.n_texts} neutral texts with the push applied at every position.
Without a push it is ${fmt(nll.base, 2)}. At dose ${fd(top.dose)} the direction raises it by ${signed(nll.direction[nll.direction.length - 1] - nll.base, 2)} nats,
so perplexity (the model's effective number of choices per word) grows about ${fmt(Math.exp(nll.direction[nll.direction.length - 1] - nll.base), 1)}-fold. A steering result is only
useful in the range where the behaviour moves and this cost is still small.</p>`,
      3: `<p>This is the side-effect control from the steering literature (for example the KL or loss on unrelated text reported
alongside persona vectors). Random directions of equal norm give the floor of damage from perturbation size alone; the
difference from that floor is the direction-specific damage. Loss is the per-token NLL averaged over all positions.</p>`,
    });
    const c2 = h('div');
    const ser = (nll.random || []).map((rv, r) => ({ name: `${nll.random.length} random directions, same size`, color: col('ctrl'), muted: true,
      marker: false, hideLegend: r > 0, noTip: true, pts: doses.map((x, j) => [x, rv[j]]) }));
    ser.push({ name: 'the direction', color: col('s1'), pts: doses.map((x, j) => [x, nll.direction[j]]) });
    mount(cost.body, c2);
    lineChart(c2, { height: 220, series: ser, x: { label: xLabel, fmt: fd, ticks: spaced(doses) },
      y: { label: 'loss on neutral text (nats)', zero: false }, hlines: [{ y: nll.base, label: 'no push' }],
      tipExtra: (xv) => {
        const j = doses.indexOf(xv);
        const vs = (nll.random || []).map((rv) => rv[j]);
        return vs.length ? tipRow(`${fmt(Math.min(...vs), 2)} to ${fmt(Math.max(...vs), 2)}`, 'random directions', col('ctrl')) : null;
      },
      caption: 'Lower is better. Hover or tap for values.' });
  }

  /* ---------------- what it writes */
  let samples = null;
  if (d.samples && d.samples.length) {
    samples = section('What it writes', 'steer-samples', {
      1: '<p>The same opening, continued by the model with different pushes. Greedy decoding (always the top word), so the only thing that changes between columns is the push.</p>',
      2: '<p>Greedy continuations with the push applied at every position, including the new tokens. Repetition loops at large doses are the text-level face of the loss rise above.</p>',
      3: '<p>Greedy decoding removes sampling noise from the comparison, at the price of repetition; a sampled comparison needs several seeds per dose to be fair.</p>',
    });
    const byPrompt = new Map();
    for (const s of d.samples) { if (!byPrompt.has(s.prompt)) byPrompt.set(s.prompt, []); byPrompt.get(s.prompt).push(s); }
    for (const [prompt, list] of byPrompt) {
      list.sort((a, b) => a.dose - b.dose);
      samples.body.appendChild(h('div.sample-group', null,
        h('div.gencol' + (list.length === 3 ? '.three' : '.two'), null, list.map((s) => h('div', null,
          h('div.gen-h', null, s.dose === 0 ? 'no push' : `push ${fd(s.dose)}`),
          h('div.gen', null, h('span.prompt', null, prompt), s.text))))));
    }
  }

  /* ---------------- the direction through the unembedding */
  let lens = null;
  if (d.logit_lens && (d.logit_lens.up || d.logit_lens.down)) {
    lens = section('What the direction says, read as words', 'steer-lens', {
      1: '<p>A direction is a list of numbers, but you can ask: if the model wrote it straight into its answer, which words would it make more likely, and which less? It is a hint about meaning, not a proof.</p>',
      2: `<p>The direction passed through the final normalisation and the unembedding, as the logit lens does: the tokens it pushes
up and down most. It was added at layer ${L}, and ${(p.models && p.models[0] && p.models[0].layers || 12) - L - 1} more layers read it before the output, so this is the
direct effect only. Use it to write alternative explanations (is it a mood, or just praise words?), then test them.</p>`,
      3: '<p>Computed as W<sub>U</sub>ᵀ(γ ⊙ (d̂ − mean(d̂))) for a LayerNorm model (the centring and gain of the final norm, no bias), or W<sub>U</sub>ᵀ(γ ⊙ d̂) for RMSNorm. It ignores the final norm\'s scale, which depends on the whole stream, so only the ranking is meaningful.</p>',
    });
    lens.body.appendChild(lensLists(d.logit_lens.up, d.logit_lens.down, { upName: 'Makes more likely', downName: 'Makes less likely' }));
  }

  /* ---------------- where it came from */
  const dir = d.direction || {};
  const where = section('Where the direction came from', 'steer-dir', null);
  const kv = [];
  const add = (k, v) => { if (v !== undefined && v !== null && v !== '') kv.push(h('dt', null, k), h('dd', null, v)); };
  add('Built from', { contrast: `the difference between the average activations of ${dir.n_positive} and ${dir.n_negative} contrasting texts`,
    pack: `a saved direction from the result "${dir.pack}" (${dir.array === 'dirs_lr' ? 'logistic probe' : 'difference of means'})`,
    sae: `dictionary feature ${dir.feature}'s decoder direction`, random: 'a random direction (a control run)' }[dir.from] || dir.from);
  add('Layer', `${L}${dir.pool ? `, ${dir.pool === 'mean' ? 'averaged over every token' : 'read at the last token'}` : ''}`);
  if (dir.train_auc !== undefined) add('Separates its own texts', `AUC ${fmt(dir.train_auc, 2)} (measured on the texts that built it, so optimistic)`);
  add('Size before scaling', dir.raw_norm !== undefined ? `${fmt(dir.raw_norm, 2)} (${fmt(dir.raw_norm_in_resid_units, 2)} of a typical residual)` : null);
  add('Overlap with the average stream', dir.cos_with_mean_residual !== undefined ? `cosine ${fmt(dir.cos_with_mean_residual, 3)}${Math.abs(dir.cos_with_mean_residual) < 0.1 ? ' (so it is not just "more of what is usually there")' : ''}` : null);
  where.body.appendChild(h('dl.kv', null, kv));
  const sd = p.spec && p.spec.direction;
  if (sd && Array.isArray(sd.positive) && Array.isArray(sd.negative)) {
    where.body.appendChild(h('details.more', null, h('summary', null, `The ${sd.positive.length} + ${sd.negative.length} texts it was built from`),
      h('div.grid2', null,
        h('div', null, h('div.small-caps', null, 'Positive side'), h('ul.small', null, sd.positive.map((t) => h('li', null, t)))),
        h('div', null, h('div.small-caps', null, 'Negative side'), h('ul.small', null, sd.negative.map((t) => h('li', null, t)))))));
  }
  if (d.metric && Array.isArray(d.metric.prompts)) {
    where.body.appendChild(h('details.more', null, h('summary', null, `The ${d.metric.prompts.length} prompts the metric is measured on`),
      h('ul.small', null, d.metric.prompts.map((t) => h('li', null, t)))));
  }

  mount(el, dc.el, cost && cost.el, samples && samples.el, lens && lens.el, where.el);
}

/* a dose as a short signed number: −1, −0.25, 0, +0.1 */
function fd(v) { return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2).replace(/\.?0+$/, ''); }

/* tick values from the doses, dropping any that would crowd its neighbour */
function spaced(vals) {
  const lo = Math.min(...vals), hi = Math.max(...vals), gap = (hi - lo) / 7;
  const out = [];
  for (const v of [...vals].sort((a, b) => Math.abs(a) - Math.abs(b))) if (out.every((u) => Math.abs(u - v) >= gap)) out.push(v);
  return out.sort((a, b) => a - b);
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
