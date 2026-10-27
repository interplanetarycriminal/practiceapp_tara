/* lab/ui/viewers/probe.js: a probe result. Held-out accuracy by layer against the shuffled-label control, the two
   classes flattened to two dimensions at any layer, and the examples the saved direction gets wrong. */

import { h, mount, fmt, pct } from '../dom.js';
import { lineChart, scatter, col, tipRow } from '../charts.js';
import { arr, section, classNames } from './common.js';

export async function render(el, p) {
  const d = p.data;
  const rows = d.rows;
  const [pca, labels, isTest, scores] = await Promise.all([arr(p, 'pca'), arr(p, 'labels'), arr(p, 'is_test'), arr(p, 'scores_best')]);
  const names = classNames(p);
  const best = rows[d.best];
  const nL = (p.models && p.models[0] && p.models[0].layers) || rows.length;
  const nTrain = d.n - d.n_test;
  let pick = d.best;

  /* ---------------- accuracy by layer */
  const acc = section('Can a straight line read it, layer by layer?', 'probe-acc', {
    1: `<p>A probe is a ruler laid across the model's thoughts. At each layer we ask: does one straight cut separate the
${names[1]}s from the ${names[0]}s, on examples the ruler never saw while it was being placed? The blue line is how often it
gets them right. The gray band is the same ruler placed using <i>shuffled</i> labels: it shows how good pure luck can look.
Only blue well above gray counts.</p>`,
    2: `<p>For each of ${d.n} texts, the residual stream ${d.pool === 'last' ? 'at the last token' : 'averaged over the tokens'} is
read after every layer. A logistic regression is fit on ${nTrain} texts and scored on the ${d.n_test} held out (blue, with a 95%
${d.interval ? 'exact binomial' : 'bootstrap'} interval).${d.paired ? ` The texts come in matched pairs (the same item once with each label), and whole pairs
are held out, so every held-out text is about something the probe never saw.` : ''} The orange line fits nothing: it uses only the difference between the two class averages, the
simplest possible probe. The gray band is the permutation control, a probe trained and scored on shuffled labels
(average to best of ${p.spec && p.spec.controls && p.spec.controls.shuffle || 'several'}): with ${p.models && p.models[0] && p.models[0].d_model || 'hundreds of'} dimensions and only ${nTrain}
training examples, a line can fit noise, and the control shows how well.</p>
<div data-angle="analogy"><p>A metal detector swept over a beach: it beeps over coins (the property is there) but says nothing
about whether anyone ever spends them. Steering and patching test the spending.</p></div>`,
    3: `<p>Accuracy is the mean over held-out items; ${d.interval ? `intervals are exact binomial (Clopper-Pearson), which stay
honest at a perfect score: ${d.n_test} of ${d.n_test} right only pins the true rate above ${pct(0.025 ** (1 / d.n_test), 1)} (at 95% confidence), where a
bootstrap would say 100% to 100%` : 'intervals bootstrap the items'}.${d.paired ? ' The control swaps labels within pairs, so it keeps the pairs balanced.' : ''} The stamp needs the interval's lower bound to
clear max(best shuffled probe, 50%) by 5 points. Linear decodability is evidence of a representation, not of use: a
probe with enough capacity can read information the model never reads itself (Hewitt and Liang's control tasks make the
same point). Marks and Tegmark (2023) found difference-of-means directions generalise better than logistic ones and are
the better steering vectors; both are saved in this result (one unit vector per layer) for a steering spec to test.</p>`,
  });
  const chart = h('div');
  const picker = h('div.chips', { role: 'group', 'aria-label': 'Layer to show below' });
  const lo = Math.min(0.4, ...rows.map((r) => Math.min(r.logreg_ci[0], r.diffmeans, r.shuffled ?? 1)));
  lineChart(chart, {
    height: 250,
    series: [
      { name: 'shuffled-label control (average to best)', color: col('ctrl'), muted: true, band: rows.filter((r) => r.shuffled !== null).map((r) => [r.layer, r.shuffled, r.shuffled_max]), noTip: true },
      { name: 'logistic probe (95% interval)', color: col('s1'), pts: rows.map((r) => [r.layer, r.logreg]), band: rows.map((r) => [r.layer, r.logreg_ci[0], r.logreg_ci[1]]) },
      { name: 'difference of means', color: col('s2'), pts: rows.map((r) => [r.layer, r.diffmeans]) },
    ],
    x: { label: 'layer', fmt: (v) => String(v) },
    y: { label: 'held-out accuracy', min: Math.max(0, Math.floor(lo * 10) / 10), max: 1, fmt: (v) => pct(v) },
    hlines: [{ y: 0.5, label: 'chance' }],
    tipExtra: (L) => {
      const r = rows.find((x) => x.layer === L);
      if (!r) return null;
      return h('div', null, tipRow(`${pct(r.diffmeans_ci[0])} to ${pct(r.diffmeans_ci[1])}`, 'difference of means, 95% interval', col('s2')),
        r.shuffled !== null ? tipRow(`${pct(r.shuffled)} (best ${pct(r.shuffled_max)})`, 'shuffled labels', col('ctrl')) : null);
    },
    caption: `Held-out accuracy on ${d.n_test} texts at each layer of ${nL}. Hover or tap for values.`,
  });
  mount(acc.body, chart, h('div.row.small', { style: { marginTop: '8px' } }, h('span.muted', null, 'Look inside layer:'), picker));

  /* ---------------- the two classes at one layer */
  const geo = section('The two kinds of text, flattened to a picture', 'probe-pca', {
    1: '<p>Each dot is one text, placed by the two strongest patterns in the model\'s activity at this layer. If the two colours sit in separate clouds, even a picture this crude can tell them apart. Hollow dots are the held-out texts.</p>',
    2: '<p>PCA of the residual stream at the chosen layer, keeping the two directions of greatest spread (the axis labels say how much of the variance each keeps). The probe\'s best line can lie in a direction PCA dropped, so overlap here does not mean the probe fails; clean separation here means the property is one of the biggest things varying at that layer.</p>',
    3: '<p>PCA is unsupervised and fit on all texts (train and held-out), so it cannot overfit the labels. A class split on PC1 means the label direction carries a large share of the variance in this set, which can also mean the dataset varies mainly along the label: check for surface cues before reading it as the model\'s concept.</p>',
  });
  const pcaChart = h('div');
  geo.body.appendChild(pcaChart);
  const pcaNote = h('p.small.muted');
  geo.body.appendChild(pcaNote);
  const drawPCA = () => {
    const li = pick;
    const r = d.pca_ratio && d.pca_ratio[li];
    const pts = [];
    for (let i = 0; i < d.n; i++) pts.push({ x: pca.at(li, i, 0), y: pca.at(li, i, 1), c: labels.data[i], hollow: !!isTest.data[i], label: d.texts[i] });
    scatter(pcaChart, {
      height: 280, points: pts,
      classes: [{ name: names[0], color: col('s2') }, { name: names[1], color: col('s1') }],
      x: { label: `first direction${r ? ` (${pct(r[0])} of the spread)` : ''}` }, y: { label: `second${r ? ` (${pct(r[1])})` : ''}` },
      caption: `Layer ${rows[li].layer}. Filled dots trained the probe; hollow ones were held out. Hover or tap a dot to read its text.`,
    });
    pcaNote.textContent = `At layer ${rows[li].layer}: logistic probe ${pct(rows[li].logreg)} held-out, difference of means ${pct(rows[li].diffmeans)}, shuffled labels ${rows[li].shuffled !== null ? pct(rows[li].shuffled) : 'not run'}.`;
  };
  rows.forEach((r, li) => {
    const b = h('button.chip', { type: 'button', 'aria-pressed': String(li === pick), title: `layer ${r.layer}: ${pct(r.logreg)}` }, String(r.layer) + (li === d.best ? ' ★' : ''));
    b.addEventListener('click', () => { pick = li; for (const x of picker.children) x.setAttribute('aria-pressed', String(x === b)); drawPCA(); });
    picker.appendChild(b);
  });
  drawPCA();

  /* ---------------- scores along the saved direction */
  let along = null;
  if (scores) {
    along = section(`Every text along the best layer's direction`, 'probe-along', {
      1: `<p>The simplest probe turned into a single number per text: how far it points along the line from the average
${names[0]} to the average ${names[1]}, at layer ${best.layer}. The list under the chart shows the held-out texts that land on
the wrong side. Reading them is often the fastest way to see what the probe really picked up.</p>`,
      2: `<p>Projection of each text's residual stream (layer ${best.layer}) on the unit difference-of-means direction. The cut is
placed half-way between the two training means. Wrong-side held-out texts are the probe's errors; when they share a
surface feature (a word, a length, a template), the probe may be reading that feature instead of the property.</p>`,
      3: '<p>The midpoint cut assumes equal class variances along the direction; logistic regression would place it with the class spread taken into account, so its errors can differ. Scores are raw dot products in residual units, so their scale differs from layer to layer.</p>',
    });
    const xs = Array.from(scores.data);
    const m = [0, 1].map((c) => {
      let s = 0, k = 0;
      for (let i = 0; i < d.n; i++) if (!isTest.data[i] && labels.data[i] === c) { s += xs[i]; k++; }
      return k ? s / k : 0;
    });
    const cut = (m[0] + m[1]) / 2, sign = m[1] >= m[0] ? 1 : -1;
    const pts = xs.map((x, i) => ({ x, y: labels.data[i] + jitter(i), c: labels.data[i], hollow: !!isTest.data[i], label: d.texts[i] }));
    const strip = h('div');
    along.body.appendChild(strip);
    scatter(strip, { height: 170, points: pts, classes: [{ name: names[0], color: col('s2') }, { name: names[1], color: col('s1') }],
      x: { label: `position along the direction (the cut is at ${fmt(cut, 2)})` },
      caption: 'One row per kind of text; hollow dots were held out. Hover or tap a dot to read it.' });
    const wrong = [];
    for (let i = 0; i < d.n; i++) if (isTest.data[i] && ((xs[i] - cut) * sign > 0 ? 1 : 0) !== labels.data[i]) wrong.push(i);
    along.body.appendChild(wrong.length
      ? h('div', null, h('div.small-caps', null, `Held-out texts on the wrong side (${wrong.length} of ${d.n_test})`),
        h('ul.small', null, wrong.slice(0, 12).map((i) => h('li', null, d.texts[i], h('span.muted', null, ` (really ${names[labels.data[i]]})`)))))
      : h('p.small', null, `Every held-out text lands on the right side of the cut.`));
  }

  /* ---------------- the data */
  const data = section('The texts', 'probe-data', null);
  const ex = [0, 1].map((c) => d.texts.filter((_, i) => labels.data[i] === c));
  data.body.appendChild(h('p.small.muted', null, `${d.n} texts: ${ex[1].length} ${names[1]} and ${ex[0].length} ${names[0]}; ${d.n_test} held out at random. Dataset: ${p.spec && p.spec.dataset || 'custom'}.`));
  data.body.appendChild(h('div.grid2', null, [1, 0].map((c) => h('div', null, h('div.small-caps', null, names[c]),
    h('ul.small', null, ex[c].slice(0, 8).map((t) => h('li', null, t)), ex[c].length > 8 ? h('li.muted', null, `and ${ex[c].length - 8} more`) : null)))));

  mount(el, acc.el, geo.el, along && along.el, data.el);
}

/* a fixed vertical scatter for a 1-D strip, so the picture does not change between visits */
function jitter(i) {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 0.6;
}
