/* lab/ui/viewers/features.js: a dictionary-features result. First how faithful the dictionary is on this model,
   then one card per feature (where it fires, what it makes the model say), then the reader's prompts decoded into
   features token by token. */

import { h, mount, fmt, pct, tokText } from '../dom.js';
import { columns, tokens, stat, tipRow, col } from '../charts.js';
import { section, lensLists, corpusName } from './common.js';

const FIRST = 12;

export async function render(el, p) {
  const d = p.data;
  const q = d.quality || {};
  const cards = d.cards || [];

  /* ---------------- faithfulness */
  const fit = section('First: does the dictionary fit this model?', 'feat-fit', {
    1: `<p>A dictionary (a sparse autoencoder) rewrites each moment of the model's thinking as a short list of
<b>features</b> picked from a big vocabulary of ${d.width ? d.width.toLocaleString() : 'many'} features, about ${fmt(q.l0, 0)} at a time. Before
trusting any single feature, check the rewrite keeps the meaning: "variance explained" says how much of the original
survives. Below about 60%, a single feature is a shaky guide.</p>`,
    2: `<p>Measured on ${q.rows ? q.rows.toLocaleString() : 'the'} tokens of ${corpusName(d.corpus && d.corpus.source)} at layer ${d.layer}.
<b>Variance explained</b> is 1 − (reconstruction error ÷ the stream's own variance); <b>cosine</b> compares each reconstructed
vector with the original; <b>L0</b> is how many features are active per token (a TopK dictionary fixes it at k = ${d.k ?? '?'}).
The histogram shows how often each feature fires: very common features are not specific, and dead ones never fire.</p>`,
    3: `<p>FVE = 1 − E‖x − x̂‖² / E‖x − x̄‖² over tokens, computed in the dictionary's own input space (some dictionaries
normalise the stream first). A dictionary trained on a base model loses fidelity on its instruct sibling, and the
error term is what any circuit built from these features cannot see. Density is the fraction of tokens with a nonzero
activation; on a corpus this small, the left tail of the histogram is poorly estimated.</p>`,
  });
  const tiles = h('div.stats', null,
    stat('Variance explained', q.fve !== undefined ? pct(q.fve) : '–', q.fve !== undefined && q.fve < 0.6 ? 'below 60%: read features with care' : 'of the stream survives the rewrite'),
    stat('Cosine', q.cos !== undefined ? fmt(q.cos, 2) : '–', 'reconstruction against original'),
    stat('Active per token', q.l0 !== undefined ? fmt(q.l0, 0) : '–', `of ${d.width ? d.width.toLocaleString() : '?'} features`),
    stat('Never fired', d.density_hist ? String(d.density_hist.dead) : '–', `on ${(d.corpus && d.corpus.tokens || q.rows || 0).toLocaleString()} tokens`));
  fit.body.appendChild(tiles);
  if (d.density_hist && d.density_hist.counts) {
    const e = d.density_hist.edges_log10, c = d.density_hist.counts;
    const hist = h('div');
    fit.body.appendChild(hist);
    columns(hist, {
      bins: c.map((v, i) => ({ label: Number.isInteger(e[i]) ? rate(e[i]) : '', value: v,
        tip: [h('div.tip-head', null, `fires on ${dens(10 ** e[i])} to ${dens(10 ** e[i + 1])} of tokens`), tipRow(String(v), 'features', col('s1'))] })),
      x: { label: 'how often a feature fires (fraction of tokens, log scale)' }, y: { label: 'features' },
      caption: 'Each column counts the features in one band of firing rate. Hover or tap a column.',
    });
  }

  /* ---------------- cards */
  const cs = section(`${cards.length} features, one card each`, 'feat-cards', {
    1: '<p>Each card shows the texts where the feature fired hardest, with the firing tokens highlighted (darker means stronger), and the words it makes the model more or less likely to say next. Guess what the feature means from the examples first, then check the words.</p>',
    2: '<p>Top-activating examples from the corpus (the token where it peaks is outlined), plus the feature\'s decoder direction read through the unembedding. Examples show what <i>triggers</i> a feature, the word lists what it <i>does</i>; a good label needs both, and they often disagree.</p>',
    3: '<p>Max-activating examples are a biased sample: they show the extreme of the activation distribution, where features are most interpretable, and hide the weak activations that make up most of its firing. The logit lens of a decoder direction ignores everything between the feature\'s layer and the output.</p>',
  });
  const filter = h('input', { type: 'text', placeholder: 'Find a feature by number, label or a word in its examples', spellcheck: 'false' });
  const sortSel = h('select', null, h('option', { value: 'as' }, 'In the order chosen'), h('option', { value: 'max' }, 'Strongest first'),
    h('option', { value: 'dense' }, 'Most frequent first'), h('option', { value: 'rare' }, 'Rarest first'));
  const grid = h('div.grid2');
  const more = h('button.btn.ghost', { type: 'button' }, `Show all ${cards.length}`);
  let showAll = cards.length <= FIRST;
  const drawCards = () => {
    const f = filter.value.trim().toLowerCase();
    let list = cards.slice();
    if (sortSel.value === 'max') list.sort((a, b) => b.max_act - a.max_act);
    if (sortSel.value === 'dense') list.sort((a, b) => b.density - a.density);
    if (sortSel.value === 'rare') list.sort((a, b) => a.density - b.density);
    if (f) list = list.filter((c) => String(c.feature) === f.replace(/^#/, '') || (c.label || '').toLowerCase().includes(f)
      || (c.examples || []).some((x) => x.tokens.join('').toLowerCase().includes(f)));
    const shown = showAll || f ? list : list.slice(0, FIRST);
    mount(grid, shown.length ? shown.map(card) : h('p.muted', null, 'No feature matches.'));
    more.hidden = showAll || !!f || list.length <= FIRST;
  };
  filter.addEventListener('input', drawCards);
  sortSel.addEventListener('change', drawCards);
  more.addEventListener('click', () => { showAll = true; drawCards(); });
  mount(cs.body, h('div.fields.two', null, h('label.field', null, h('span', null, 'Find'), filter), h('label.field', null, h('span', null, 'Order'), sortSel)),
    grid, h('div.row', { style: { marginTop: '10px' } }, more));
  drawCards();

  /* ---------------- prompts */
  let pr = null;
  if (d.prompts && d.prompts.length) {
    pr = section('Your prompts, decoded into features', 'feat-prompts', {
      1: '<p>Each token is shaded by how strongly its strongest feature fires. Tap a token to see which features were active there; the numbers link to their cards when the result has one.</p>',
      2: '<p>For every token: the dictionary\'s top features and their activations. Most tokens light up a handful of features at once; the shading is the largest single activation, not a sum.</p>',
      3: '<p>Activations are the dictionary\'s encoder outputs after TopK, at the same layer and with the same input normalisation as the cards, so they are comparable to the cards\' maxima.</p>',
    });
    for (const pp of d.prompts) {
      const vals = pp.top.map((t) => (t && t.length ? t[0][1] : 0));
      const strip = h('div');
      const detail = h('div.small', { style: { minHeight: '28px', marginTop: '4px' } });
      const show = (i) => {
        const t = pp.top[i] || [];
        mount(detail, h('b', null, tokText(pp.tokens[i]) + ': '), t.length ? t.map(([f, a]) => {
          const has = cards.some((c) => c.feature === f);
          return h(has ? 'button.chip' : 'span.chip', { type: has ? 'button' : null, onclick: has ? () => jump(f) : null,
            title: has ? 'Open its card' : 'No card for this feature in this result' }, `#${f} · ${fmt(a, 2)}`);
        }) : h('span.muted', null, 'no feature fired'));
      };
      tokens(strip, { pieces: pp.tokens, values: vals, scale: 'seq', max: Math.max(...vals, 1e-6), onPick: show,
        tip: (i) => [h('div.tip-head', null, tokText(pp.tokens[i])), (pp.top[i] || []).slice(0, 4).map(([f, a]) => tipRow(fmt(a, 2), `feature ${f}`))] });
      pr.body.appendChild(h('div.card.flat', { style: { marginBottom: '10px' } }, strip, detail));
    }
  }

  function jump(f) {
    filter.value = '#' + f;
    drawCards();
    const c = document.getElementById('feat-' + f);
    if (c) { c.scrollIntoView({ behavior: 'smooth', block: 'start' }); c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 1400); }
  }

  mount(el, fit.el, cs.el, pr && pr.el);
}

function card(c) {
  const ex = (c.examples || []).map((x) => {
    const strip = h('div.feat-ex');
    tokens(strip, { pieces: x.tokens, values: x.acts, scale: 'seq', max: c.max_act || x.max || 1, selected: x.at,
      tip: (i) => [h('div.tip-head', null, tokText(x.tokens[i])), tipRow(fmt(x.acts[i], 2), 'activation', col('s1'))] });
    return strip;
  });
  return h('div.card.featcard', { id: 'feat-' + c.feature },
    h('div.spread', null, h('h3', null, `Feature ${c.feature}`), h('span.small.muted', null, `fires on ${dens(c.density)} of tokens · strongest ${fmt(c.max_act, 2)}`)),
    c.label ? h('p', null, h('b', null, 'Label: '), c.label) : null,
    h('div.small-caps', null, 'Where it fires hardest'),
    ex.length ? ex : h('p.muted.small', null, 'It never fired on the corpus.'),
    c.logit_lens ? h('div', { style: { marginTop: '8px' } }, lensLists(c.logit_lens.up, c.logit_lens.down, { upName: 'Makes more likely', downName: 'Makes less likely' })) : null);
}

/* an axis label for a power of ten: 10%, 1%, 0.1%, 1/10k, 1/1M */
function rate(e) {
  if (e >= -3) return (100 * 10 ** e).toFixed(Math.max(0, -e - 2)) + '%';
  const n = 10 ** -e;
  return '1/' + (n >= 1e6 ? n / 1e6 + 'M' : n / 1e3 + 'k');
}

/* a firing rate as a readable fraction: 12%, 0.3%, 1 in 40,000 */
function dens(x) {
  if (!(x > 0)) return '0%';
  if (x >= 0.01) return pct(x, x >= 0.1 ? 0 : 1);
  if (x >= 0.001) return pct(x, 2);
  return '1 in ' + Math.round(1 / x).toLocaleString();
}

