/* lab/ui/viewers/graph.js: attribution graphs from circuit-tracer. One prompt at a time: the model's top answers, the
   graph, and the features that matter most, with their labels where the transcoders have them. */

import { h, mount, fmt, tokText } from '../dom.js';
import { bars } from '../charts.js';
import { json, section } from './common.js';
import { graphView } from './graphview.js';

export async function render(el, p) {
  const d = p.data;
  const graphs = d.graphs || [];
  const intro = section('Reading an attribution graph', 'graph-intro', {
    1: `<p>The model's middle layers are swapped for a "replacement" made of readable features, and the graph traces which
features, at which words of the prompt, pushed the model toward its answer. Bottom row: your words. Top: the answer.
Gray squares are <b>errors</b>, the part the replacement gets wrong, so a graph is a hypothesis about the model, to be
tested by switching features on and off.</p>`,
    2: `<p>circuit-tracer replaces each MLP with a transcoder (${d.transcoders || 'per-model transcoders'}), freezes attention and
normalisation at their values for this prompt, and computes direct effects between every pair of active features, then
prunes to the nodes and edges that carry most of the influence on the top logits. Node size here is influence; edge
colour is sign.</p>`,
    3: `<p>Ameisen et al. (2025) report satisfying graphs on about a quarter of attempted prompts; errors and frozen attention
are the usual culprits. Influence is computed on the pruned graph's adjacency (a Neumann series), so a node's influence
depends on the pruning thresholds in the spec.</p>`,
  });
  const pick = h('div.chips', { role: 'group', 'aria-label': 'Prompt' });
  const out = h('div');
  intro.body.appendChild(h('div', { style: { marginTop: '10px' } }, pick, out));
  let cur = 0;
  const show = async () => {
    const gi = graphs[cur];
    mount(out, h('p.muted', null, 'Loading the graph…'));
    let g = null;
    try { g = await json(p, gi.file); } catch (e) { mount(out, h('p.err', null, String(e.message || e))); return; }
    const tokens = (g.metadata && g.metadata.prompt_tokens) || [];
    const top = h('div'), view = h('div'), feats = h('div');
    mount(out,
      h('p', null, h('b', null, 'Prompt: '), gi.prompt),
      h('div.small-caps', null, 'Its top answers'), top,
      view,
      h('h3', null, 'The strongest features'), feats);
    bars(top, { items: (gi.top_logits || []).map((t) => ({ label: tokText(t.clerp || t.node_id), value: t.token_prob || 0 })),
      max: 1, fmtv: (v) => (100 * v).toFixed(1) + '%' });
    graphView(view, g, { tokens, maxNodes: 44 });
    mount(feats, h('ol.small', null, (gi.top_features || []).slice(0, 15).map((f) => h('li', null,
      h('b', null, `layer ${f.layer}`), f.ctx_idx >= 0 && tokens[f.ctx_idx] !== undefined ? ` at "${tokText(tokens[f.ctx_idx])}"` : '',
      `: ${f.clerp || 'no label'} `, h('span.muted', null, `(influence ${fmt(f.influence, 3)})`)))));
  };
  graphs.forEach((gi, i) => {
    const b = h('button.chip', { type: 'button', 'aria-pressed': String(i === cur), title: gi.prompt }, gi.prompt.length > 34 ? gi.prompt.slice(0, 32) + '…' : gi.prompt);
    b.addEventListener('click', () => { cur = i; for (const x of pick.children) x.setAttribute('aria-pressed', String(x === b)); show(); });
    pick.appendChild(b);
  });
  mount(el, intro.el);
  if (graphs.length) await show(); else mount(out, h('p.muted', null, 'This result has no graphs.'));
}
