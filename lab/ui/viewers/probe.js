/* lab/ui/viewers/probe.js: a probe result. Held-out accuracy by layer against the shuffled-label control, the words
   alone and any rival-property probe, the two classes flattened to two dimensions at any layer, and the examples the
   saved direction gets wrong. A transfer test (trained on one set, scored on another in other wording) reads the
   same way, with the new set in place of the held-out half. */

import { h, mount, fmt, pct } from '../dom.js';
import { lineChart, scatter, stat, col, tipRow } from '../charts.js';
import { arr, section, classNames } from './common.js';

export async function render(el, p) {
  const d = p.data;
  const rows = d.rows;
  const [pca, labels, isTest, scores, source] = await Promise.all([arr(p, 'pca'), arr(p, 'labels'), arr(p, 'is_test'),
    arr(p, 'scores_best'), arr(p, 'source')]);
  const names = classNames(p);
  const best = rows[d.best];
  const nL = (p.models && p.models[0] && p.models[0].layers) || rows.length;
  const tr = d.transfer || null;
  const nTrain = tr ? tr.n_train : d.n - d.n_test;
  const w = d.words || null;
  const cf = d.confound || null;
  const mn = d.meanings || null;
  const R = rows[0].random_dir_max !== undefined ? d.random_directions : 0;
  const floor = Math.max(...rows.map((r) => r.shuffled_max ?? 0.5));
  const setName = (s) => (typeof s === 'string' && s.startsWith('builtin:') ? s.slice(8) : 'a custom set');
  const fp = (v) => (v < 0.001 ? 'below 0.001' : '= ' + v.toPrecision(2));
  const trained = (i) => (tr ? !(source && source.data[i]) : !isTest.data[i]);
  let pick = d.best;

  /* ---------------- accuracy by layer */
  const acc = section(tr ? 'Does the line carry over to new wording, layer by layer?' : 'Can a straight line read it, layer by layer?', 'probe-acc', {
    1: `<p>A probe is a ruler laid across the model's thoughts. At each layer we ask: does one straight cut separate the
${names[1]}s from the ${names[0]}s, on examples the ruler never saw while it was being placed? The blue line is how often it
gets them right. The gray band is the same ruler placed using <i>shuffled</i> labels: it shows how good pure luck can look.
Only blue well above gray counts.${tr ? ` Here the ruler is placed on one set of texts (${setName(tr.train)}) and tested on a
different one (${setName(tr.test)}: other items, and the label shows only in how they read). If it still works there, it
found the idea, not the first set's words.` : ''}${w ? ` The dashed gray line is a ruler that sees only which words each text
contains, with no model at all: if blue does no better, the words gave the answer away.` : ''}${mn ? ` The dotted gray line
knows what each word means to the model but not how the words combine: if blue does no better, the meanings of the words
gave the answer away.` : ''}${R ? ` The thin gray line is the best of ${R} rulers pointed in random directions: when two
kinds of text differ in many ways at once, even a random ruler can separate them.` : ''}${cf ? ` The aqua line is a
ruler for a rival idea (${cf.name}), placed on its own texts: if it does as well as blue, blue may be reading ${cf.name}.` : ''}</p>`,
    2: `<p>For each of ${d.n} texts, the residual stream ${d.pool === 'last' ? 'at the last token' : 'averaged over the tokens'} is
read after every layer. ${tr ? `A logistic regression is fit on the ${nTrain} texts of ${setName(tr.train)}. The ${d.n - nTrain} texts of
${setName(tr.test)} are new to it: ${tr.n_dev ? `${tr.n_dev} of them re-centre each probe's cut (the direction is kept; a whole new set
can sit to one side of the old cut) and pick the layer (★), and the other ${d.n_test} are scored (blue, with a 95%
exact binomial interval). Every control is re-centred the same way on the same texts.` : `all ${d.n_test} are scored with the cut from training.`}`
    : `A logistic regression is fit on ${nTrain} texts and scored on the ${d.n_test} held out (blue, with a 95%
${d.interval ? 'exact binomial' : 'bootstrap'} interval).${d.paired ? ` The texts come in matched pairs (the same item once with each label), and whole pairs
are held out, so every held-out text is about something the probe never saw.` : ''}${d.best_by ? ' The starred layer (★) has the best cross-validated accuracy inside the training texts, so it is not picked by its held-out score.' : ''}`}
The orange line fits nothing: it uses only the difference between the two class averages, the
simplest possible probe. The gray band is the permutation control, a probe trained and scored on shuffled labels
(average to best of ${p.spec && p.spec.controls && p.spec.controls.shuffle || 'several'}): with ${p.models && p.models[0] && p.models[0].d_model || 'hundreds of'} dimensions and only ${nTrain}
training examples, a line can fit noise, and the control shows how well.${w ? ` The words-only probe is a logistic regression on
which of the ${w.vocabulary} tokens of the training texts each text contains.` : ''}${mn ? ` The word-meaning probe is the
same logistic regression on the average input embedding of each text's own tokens (no chat template), before any layer has
combined them.` : ''}${R ? ` The random directions are ${R} unit vectors in the probe's standardised space, each pointed the
way it splits the training texts and cut like the probe.` : ''}${cf ? ` The ${cf.name} probe is trained on
${setName(cf.dataset)} (${cf.n} texts) at each layer, pointed the way ${cf.name} runs in the training texts (a probe that only
read ${cf.name} would inherit that sign) and re-centred like the probe.` : ''}</p>
<div data-angle="analogy"><p>A metal detector swept over a beach: it beeps over coins (the property is there) but says nothing
about whether anyone ever spends them. Steering and patching test the spending.</p></div>`,
    3: `<p>Accuracy is the mean over held-out items; ${d.interval ? `intervals are exact binomial (Clopper-Pearson), which stay
honest at a perfect score: ${d.n_test} of ${d.n_test} right only pins the true rate above ${pct(0.025 ** (1 / d.n_test), 1)} (at 95% confidence), where a
bootstrap would say 100% to 100%` : 'intervals bootstrap the items'}.${d.paired ? ' The control swaps labels within pairs, so it keeps the pairs balanced.' : ''} The stamp needs the interval's lower bound to
clear max(best shuffled probe, 50%) by 5 points. ${w ? `The words-only${mn ? ', word-meaning' : ''} and rival probes are compared with the best layer on the same texts by an exact McNemar test, which counts only the texts where exactly one of the two is right. ` : ''}${R ? 'Against the random directions the stamp needs the interval\'s lower bound to clear the best of them by 5 points. ' : ''}Linear decodability is evidence of a representation, not of use: a
probe with enough capacity can read information the model never reads itself (Hewitt and Liang's control tasks make the
same point). Marks and Tegmark (2023) found difference-of-means directions generalise better than logistic ones and are
the better steering vectors; both are saved in this result (one unit vector per layer) for a steering spec to test.${tr ? ' A probe that carries over to new wording is the stronger evidence: it cannot be matching the training texts\' surface, though it can still be reading a property the two sets share by accident; the rival probe tests the likeliest one.' : ''}</p>`,
  });
  const chart = h('div');
  const picker = h('div.chips', { role: 'group', 'aria-label': 'Layer to show below' });
  const lo = Math.min(0.4, ...rows.map((r) => Math.min(r.logreg_ci[0], r.diffmeans, r.shuffled ?? 1, r.confound ?? 1, r.random_dir_max ?? 1)),
    w ? w.acc : 1, mn ? mn.acc : 1);
  const series = [
    { name: 'shuffled-label control (average to best)', color: col('ctrl'), muted: true, band: rows.filter((r) => r.shuffled !== null).map((r) => [r.layer, r.shuffled, r.shuffled_max]), noTip: true },
  ];
  if (w) series.push({ name: 'words alone, no model', color: col('ctrl'), dash: true, marker: false, width: 1.4, noTip: true, pts: rows.map((r) => [r.layer, w.acc]) });
  if (mn) series.push({ name: 'word meanings, no context', color: col('ctrl'), dash: '0 5', marker: false, width: 2.4, noTip: true, pts: rows.map((r) => [r.layer, mn.acc]) });
  if (R) series.push({ name: `random directions (best of ${R})`, color: col('ctrl'), width: 1.4, noTip: true, pts: rows.map((r) => [r.layer, r.random_dir_max]) });
  if (cf) series.push({ name: `${cf.name} probe (rival)`, color: col('s3'), pts: rows.map((r) => [r.layer, r.confound]) });
  series.push({ name: `logistic probe${tr ? ', new wording' : ''} (95% interval)`, color: col('s1'), pts: rows.map((r) => [r.layer, r.logreg]), band: rows.map((r) => [r.layer, r.logreg_ci[0], r.logreg_ci[1]]) });
  series.push({ name: 'difference of means', color: col('s2'), pts: rows.map((r) => [r.layer, r.diffmeans]) });
  lineChart(chart, {
    height: 260,
    series,
    x: { label: 'layer', fmt: (v) => String(v) },
    y: { label: tr ? 'accuracy on the new set' : 'held-out accuracy', min: Math.max(0, Math.floor(lo * 10) / 10), max: 1, fmt: (v) => pct(v) },
    hlines: [{ y: 0.5, label: 'chance' }],
    tipExtra: (L) => {
      const r = rows.find((x) => x.layer === L);
      if (!r) return null;
      return h('div', null, tipRow(`${pct(r.diffmeans_ci[0])} to ${pct(r.diffmeans_ci[1])}`, 'difference of means, 95% interval', col('s2')),
        r.shuffled !== null ? tipRow(`${pct(r.shuffled)} (best ${pct(r.shuffled_max)})`, 'shuffled labels', col('ctrl')) : null,
        r.random_dir_max !== undefined ? tipRow(`${pct(r.random_dir)} (best ${pct(r.random_dir_max)})`, `random directions, ${R}`, col('ctrl')) : null,
        r.confound !== undefined ? tipRow(pct(r.confound), `${cf.name} probe`, col('s3')) : null,
        r.confound_any !== undefined && r.confound_any_sign !== r.confound_sign ? tipRow(pct(r.confound_any), `${cf.name} probe the other way round`) : null,
        tr && r.dev_acc !== undefined ? tipRow(pct(r.dev_acc), 'on the dev texts (picks the layer)') : null,
        tipRow(pct(r.cv_acc), tr ? 'on the training wording, cross-validated' : 'cross-validated, training texts'));
    },
    caption: `${tr ? `Accuracy on ${d.n_test} texts of the new set` : `Held-out accuracy on ${d.n_test} texts`} at each layer of ${nL}. Hover or tap for values.`,
  });
  const tiles = [stat(`Layer ${best.layer} ★`, pct(best.logreg), `exact 95%: ${pct(best.logreg_ci[0], 1)} to ${pct(best.logreg_ci[1], 1)}`)];
  if (w) tiles.push(stat('Words alone', pct(w.acc), `no model; McNemar p ${fp(w.p_vs_best)}`));
  if (mn) tiles.push(stat('Word meanings', pct(mn.acc), `no context; McNemar p ${fp(mn.p_vs_best)}`));
  if (R) tiles.push(stat('Random directions', `at most ${pct(best.random_dir_max)}`, `best of ${R} at layer ${best.layer}`));
  if (cf) tiles.push(stat(`${cf.name[0].toUpperCase()}${cf.name.slice(1)} probe`, pct(cf.acc), `rival idea; McNemar p ${fp(cf.p_vs_best)}`));
  tiles.push(stat('Shuffled labels', `at most ${pct(floor)}`, 'the luck bar'));
  if (tr) tiles.push(stat('On the training wording', pct(best.cv_acc), `layer ${best.layer}, cross-validated`));
  mount(acc.body, chart, h('div.stats', null, tiles), h('div.row.small', { style: { marginTop: '8px' } }, h('span.muted', null, 'Look inside layer:'), picker));

  /* ---------------- the two classes at one layer */
  const geo = section('The two kinds of text, flattened to a picture', 'probe-pca', {
    1: `<p>Each dot is one text, placed by the two strongest patterns in the model's activity at this layer. If the two colours sit in separate clouds, even a picture this crude can tell them apart. ${tr ? 'Hollow dots are the new set, which the probe never trained on.' : 'Hollow dots are the held-out texts.'}</p>`,
    2: `<p>PCA of the residual stream at the chosen layer, keeping the two directions of greatest spread (the axis labels say how much of the variance each keeps). The probe's best line can lie in a direction PCA dropped, so overlap here does not mean the probe fails; clean separation here means the property is one of the biggest things varying at that layer.${tr ? ' When the two sets sit apart, the biggest difference at that layer is which set a text came from, and the label has to be read along a smaller direction.' : ''}</p>`,
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
    for (let i = 0; i < d.n; i++) pts.push({ x: pca.at(li, i, 0), y: pca.at(li, i, 1), c: labels.data[i], hollow: !trained(i), label: d.texts[i] });
    scatter(pcaChart, {
      height: 280, points: pts,
      classes: [{ name: names[0], color: col('s2') }, { name: names[1], color: col('s1') }],
      x: { label: `first direction${r ? ` (${pct(r[0])} of the spread)` : ''}` }, y: { label: `second${r ? ` (${pct(r[1])})` : ''}` },
      caption: `Layer ${rows[li].layer}. ${tr ? 'Filled dots are the training set; hollow ones the new set.' : 'Filled dots trained the probe; hollow ones were held out.'} Hover or tap a dot to read its text.`,
    });
    const rr = rows[li];
    pcaNote.textContent = `At layer ${rr.layer}: logistic probe ${pct(rr.logreg)} ${tr ? 'on the new set' : 'held-out'}, difference of means ${pct(rr.diffmeans)}, shuffled labels ${rr.shuffled !== null ? pct(rr.shuffled) : 'not run'}${rr.confound !== undefined ? `, ${cf.name} probe ${pct(rr.confound)}` : ''}.`;
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
${names[0]} to the average ${names[1]}, at layer ${best.layer}. The list under the chart shows the ${tr ? 'scored texts of the new set' : 'held-out texts'} that land on
the wrong side. Reading them is often the fastest way to see what the probe really picked up.</p>`,
      2: `<p>Projection of each text's residual stream (layer ${best.layer}) on the unit difference-of-means direction. ${tr && tr.n_dev
        ? 'The direction comes from the training set; the cut is re-centred half-way between the two means of the dev texts.'
        : 'The cut is placed half-way between the two training means.'} Wrong-side ${tr ? 'scored' : 'held-out'} texts are the probe's errors; when they share a
surface feature (a word, a length, a template), the probe may be reading that feature instead of the property.</p>`,
      3: '<p>The midpoint cut assumes equal class variances along the direction; logistic regression would place it with the class spread taken into account, so its errors can differ. Scores are raw dot products in residual units, so their scale differs from layer to layer.</p>',
    });
    const xs = Array.from(scores.data);
    const m = [0, 1].map((c) => {
      let s = 0, k = 0;
      for (let i = 0; i < d.n; i++) if (trained(i) && labels.data[i] === c) { s += xs[i]; k++; }
      return k ? s / k : 0;
    });
    const cut = d.cut ?? (m[0] + m[1]) / 2, sign = m[1] >= m[0] ? 1 : -1;
    const pts = xs.map((x, i) => ({ x, y: labels.data[i] + jitter(i), c: labels.data[i], hollow: !trained(i), label: d.texts[i] }));
    const strip = h('div');
    along.body.appendChild(strip);
    scatter(strip, { height: 170, points: pts, classes: [{ name: names[0], color: col('s2') }, { name: names[1], color: col('s1') }],
      x: { label: `position along the direction (the cut is at ${fmt(cut, 2)})` },
      caption: `One row per kind of text; hollow dots ${tr ? 'are the new set' : 'were held out'}. Hover or tap a dot to read it.` });
    const wrong = [];
    for (let i = 0; i < d.n; i++) if (isTest.data[i] && ((xs[i] - cut) * sign > 0 ? 1 : 0) !== labels.data[i]) wrong.push(i);
    along.body.appendChild(wrong.length
      ? h('div', null, h('div.small-caps', null, `${tr ? 'Scored' : 'Held-out'} texts on the wrong side (${wrong.length} of ${d.n_test})`),
        h('ul.small', null, wrong.slice(0, 12).map((i) => h('li', null, d.texts[i], h('span.muted', null, ` (really ${names[labels.data[i]]})`)))))
      : h('p.small', null, `Every ${tr ? 'scored' : 'held-out'} text lands on the right side of the cut.`));
  }

  /* ---------------- the data */
  const data = section('The texts', 'probe-data', null);
  const block = (idx, title) => {
    const ex = [0, 1].map((c) => idx.filter((i) => labels.data[i] === c).map((i) => d.texts[i]));
    return h('div', null, title ? h('h3', null, title) : null, h('div.grid2', null, [1, 0].map((c) => h('div', null, h('div.small-caps', null, names[c]),
      h('ul.small', null, ex[c].slice(0, tr ? 6 : 8).map((t) => h('li', null, t)), ex[c].length > (tr ? 6 : 8) ? h('li.muted', null, `and ${ex[c].length - (tr ? 6 : 8)} more`) : null)))));
  };
  const all = Array.from({ length: d.n }, (_, i) => i);
  if (tr) {
    data.body.appendChild(h('p.small.muted', null, `Trained on the ${nTrain} texts of ${setName(tr.train)}; tested on the ${d.n - nTrain} texts of ${setName(tr.test)}${tr.n_dev ? ` (${tr.n_dev} re-centre the cut and pick the layer, ${d.n_test} are scored)` : ''}.`));
    data.body.appendChild(block(all.filter((i) => trained(i)), `Training set: ${setName(tr.train)}`));
    data.body.appendChild(block(all.filter((i) => !trained(i)), `New set: ${setName(tr.test)}`));
  } else {
    const n1 = all.filter((i) => labels.data[i] === 1).length;
    data.body.appendChild(h('p.small.muted', null, `${d.n} texts: ${n1} ${names[1]} and ${d.n - n1} ${names[0]}; ${d.n_test} held out at random${d.paired ? ', whole pairs at a time' : ''}. Dataset: ${p.spec && p.spec.dataset || 'custom'}.`));
    data.body.appendChild(block(all, null));
  }

  mount(el, acc.el, geo.el, along && along.el, data.el);
}

/* a fixed vertical scatter for a 1-D strip, so the picture does not change between visits */
function jitter(i) {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 0.6;
}
