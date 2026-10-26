/* lab/ui/viewers/graphview.js: one drawing for both graph layouts the bench writes (circuit-tracer's attribution
   graphs and the circuit engine's feature circuits, which share circuit-tracer's JSON). Layers run bottom to top,
   embeddings at the bottom and the answer at the top, so the picture reads the way the model computes. Links are blue
   when they push toward the answer and red when they push against it; thicker means stronger. Tap a node to pin it
   and list what feeds it and what it feeds. */

import { h, mount, fmt, tokText } from '../dom.js';
import { tip, tipRow, legend, col, div as divColor } from '../charts.js';

const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  for (const k of kids) if (k) el.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
  return el;
}

const isLogit = (n) => n.is_target_logit || n.feature_type === 'logit';
const isEmbed = (n) => n.feature_type === 'embedding' || n.layer === 'E';
const isError = (n) => /error/.test(n.feature_type || '');

/* opts: { tokens (prompt tokens, for per-position graphs), maxNodes } */
export function graphView(el, g, opts = {}) {
  const maxNodes = opts.maxNodes || 40;
  const tokens = opts.tokens || (g.metadata && g.metadata.prompt_tokens) || [];
  const all = g.nodes || [];
  const nLayer = Math.max(0, ...all.filter((n) => !isLogit(n) && !isEmbed(n)).map((n) => Number(n.layer)).filter(Number.isFinite));
  const rank = (n) => (isEmbed(n) ? -1 : isLogit(n) ? nLayer + 1 : Number(n.layer));
  const infl = (n) => Math.abs(n.influence || 0);

  // keep the answer nodes, the strongest features and error nodes, and the embeddings they connect to
  const logits = all.filter(isLogit).sort((a, b) => (b.token_prob || 0) - (a.token_prob || 0)).slice(0, 3);
  const middle = all.filter((n) => !isLogit(n) && !isEmbed(n)).sort((a, b) => infl(b) - infl(a)).slice(0, maxNodes);
  const keep = new Set([...logits, ...middle].map((n) => n.node_id));
  const links0 = g.links || [];
  for (const l of links0) if (keep.has(l.target)) { const src = all.find((n) => n.node_id === l.source); if (src && isEmbed(src)) keep.add(src.node_id); }
  const nodes = all.filter((n) => keep.has(n.node_id));
  const byId = new Map(nodes.map((n) => [n.node_id, n]));
  const links = links0.filter((l) => byId.has(l.source) && byId.has(l.target) && l.weight);
  const wmax = Math.max(1e-9, ...links.map((l) => Math.abs(l.weight)));
  const imax = Math.max(1e-9, ...nodes.map(infl));

  const perPos = nodes.some((n) => n.ctx_idx >= 0) && tokens.length > 0;
  const ranks = [...new Set(nodes.map(rank))].sort((a, b) => a - b);
  const cols = perPos ? [...new Set(nodes.map((n) => Math.max(0, n.ctx_idx)))].sort((a, b) => a - b) : [0];

  const box = h('div.graph-wrap', { 'data-tara-noglossary': true });
  const panel = h('div.graph-panel.small');
  mount(el,
    legend([{ name: 'pushes toward the answer', color: col('s1') }, { name: 'pushes against it', color: col('neg') },
      { name: 'error: what the dictionary misses', color: col('ctrl'), kind: 'dot' }]),
    box, h('div.chart-cap', null, `${nodes.length} of ${all.length} nodes shown (the strongest), ${links.length} links. ${perPos ? 'Columns are token positions. ' : 'Nodes are summed over positions. '}Hover a node to light up its links; tap to pin it.`),
    panel);

  let pinned = null;
  const draw = () => {
    const W0 = Math.max(300, Math.round(box.clientWidth || 600));
    const lw = 64, rowH = 76;
    const perCol = perPos ? Math.max(1, ...cols.map((c) => Math.max(...ranks.map((r) => nodes.filter((n) => rank(n) === r && Math.max(0, n.ctx_idx) === c).length)))) : 1;
    const colW = perPos ? Math.max(70, perCol * 26) : Math.max(W0 - lw - 16, Math.max(...ranks.map((r) => nodes.filter((n) => rank(n) === r).length)) * 34);
    const W = lw + cols.length * colW + 16, H = ranks.length * rowH + (perPos ? 46 : 20);
    const pos = new Map();
    for (const r of ranks) {
      for (const c of cols) {
        const here = nodes.filter((n) => rank(n) === r && (!perPos || Math.max(0, n.ctx_idx) === c)).sort((a, b) => infl(b) - infl(a));
        const k = here.length;
        here.forEach((n, i) => {
          const x = lw + cols.indexOf(c) * colW + colW * (i + 0.5) / k;
          const y = 14 + (ranks.length - 1 - ranks.indexOf(r)) * rowH + rowH / 2;
          pos.set(n.node_id, [x, y]);
        });
      }
    }
    const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'circuit graph' });
    // row labels and guides
    ranks.forEach((r, i) => {
      const y = 14 + (ranks.length - 1 - i) * rowH + rowH / 2;
      svg.appendChild(s('line', { x1: lw - 6, x2: W - 8, y1: y, y2: y, stroke: col('grid'), 'stroke-width': 1 }));
      svg.appendChild(s('text', { x: lw - 10, y: y + 4, 'text-anchor': 'end', class: 'g-row' }, r === -1 ? 'tokens in' : r === nLayer + 1 ? 'answer' : `layer ${r}`));
    });
    if (perPos) cols.forEach((c, i) => {
      const t = tokText(tokens[c] !== undefined ? tokens[c] : '#' + c);
      svg.appendChild(s('text', { x: lw + i * colW + colW / 2, y: H - 12, 'text-anchor': 'middle', class: 'g-tok' }, t.length > 10 ? t.slice(0, 9) + '…' : t));
    });
    // links
    const lg = s('g');
    const linkEls = [];
    for (const l of [...links].sort((a, b) => Math.abs(a.weight) - Math.abs(b.weight))) {
      const [x1, y1] = pos.get(l.source), [x2, y2] = pos.get(l.target);
      const w = Math.abs(l.weight) / wmax;
      const p = s('path', { d: `M${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`, fill: 'none',
        stroke: l.weight > 0 ? col('s1') : col('neg'), 'stroke-width': (0.6 + 3.6 * w).toFixed(2), 'stroke-opacity': (0.18 + 0.6 * w).toFixed(2) });
      p.__l = l;
      linkEls.push(p);
      lg.appendChild(p);
    }
    svg.appendChild(lg);
    // nodes
    const ng = s('g');
    const nodeEls = [];
    for (const n of nodes) {
      const [x, y] = pos.get(n.node_id);
      const r = 5 + 8 * Math.sqrt(infl(n) / imax);
      let shape;
      const lt = isLogit(n) ? logitLabel(n) : '';
      const lw2 = Math.max(44, 12 + 6.8 * lt.length);
      if (isLogit(n)) shape = s('rect', { x: x - lw2 / 2, y: y - 11, width: lw2, height: 22, rx: 6, fill: col('accent'), stroke: col('card'), 'stroke-width': 2 });
      else if (isEmbed(n)) shape = s('rect', { x: x - 8, y: y - 8, width: 16, height: 16, rx: 3, fill: col('paper2'), stroke: col('muted'), 'stroke-width': 1.5 });
      else if (isError(n)) shape = s('rect', { x: x - r, y: y - r, width: 2 * r, height: 2 * r, rx: 2, fill: col('ctrl'), 'fill-opacity': 0.55, stroke: col('card'), 'stroke-width': 1.5 });
      else shape = s('circle', { cx: x, cy: y, r, fill: divColor(Math.max(-1, Math.min(1, (n.influence || 0) / imax)) * 0.85), stroke: col('ink'), 'stroke-width': 1.3 });
      const gnode = s('g', { class: 'graph-node', tabindex: 0, role: 'button', 'aria-label': describe(n, tokens) }, shape);
      if (isLogit(n)) gnode.appendChild(s('text', { x, y: y + 4, 'text-anchor': 'middle', class: 'g-logit' }, lt));
      gnode.__n = n;
      nodeEls.push(gnode);
      const enter = (ev) => { light(n.node_id); tip.show(nodeTip(n, tokens), ev.clientX, ev.clientY); };
      gnode.addEventListener('pointermove', enter);
      gnode.addEventListener('pointerleave', () => { tip.hide(); light(pinned); });
      gnode.addEventListener('click', () => { pinned = pinned === n.node_id ? null : n.node_id; light(pinned); details(pinned); });
      gnode.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pinned = n.node_id; light(pinned); details(pinned); } });
      ng.appendChild(gnode);
    }
    svg.appendChild(ng);
    function light(id) {
      for (const p of linkEls) {
        const on = !id || p.__l.source === id || p.__l.target === id;
        const w = Math.abs(p.__l.weight) / wmax;
        p.setAttribute('stroke-opacity', id ? (on ? (0.45 + 0.5 * w).toFixed(2) : '0.04') : (0.18 + 0.6 * w).toFixed(2));
      }
      for (const e of nodeEls) e.style.opacity = !id || e.__n.node_id === id || links.some((l) => (l.source === id && l.target === e.__n.node_id) || (l.target === id && l.source === e.__n.node_id)) ? '1' : '0.25';
    }
    mount(box, svg);
    light(pinned);
  };

  function details(id) {
    if (!id) { mount(panel); return; }
    const n = byId.get(id);
    const inc = links.filter((l) => l.target === id).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 6);
    const out = links.filter((l) => l.source === id).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 6);
    const li = (l, other) => h('li', null, h('b', null, (l.weight > 0 ? '+' : '−') + fmt(Math.abs(l.weight), 3)), ' ', describe(byId.get(other), tokens));
    mount(panel, h('div.card.flat', null,
      h('div.spread', null, h('b', null, describe(n, tokens)), h('button.btn.small.ghost', { type: 'button', onclick: () => { pinned = null; draw(); details(null); } }, 'Unpin')),
      n.clerp ? h('p', null, n.clerp) : null,
      h('div.grid2', null,
        h('div', null, h('div.small-caps', null, 'Fed by'), inc.length ? h('ul', null, inc.map((l) => li(l, l.source))) : h('p.muted', null, 'nothing shown')),
        h('div', null, h('div.small-caps', null, 'Feeds'), out.length ? h('ul', null, out.map((l) => li(l, l.target))) : h('p.muted', null, 'nothing shown')))));
  }

  draw();
  if (window.ResizeObserver) { let w = 0; const ro = new ResizeObserver(() => { const nw = Math.round(box.clientWidth); if (nw && Math.abs(nw - w) > 24) { w = nw; draw(); } }); ro.observe(box); }
}

/* "␣Paris", or "Peter − Kate" for the circuit engine's logit-difference node */
function logitLabel(n) {
  const c = String(n.clerp || n.feature || '');
  const t = / minus /.test(c) ? c.split(' minus ').map((x) => x.trim()).join(' − ') : tokText(c);
  return t.length > 16 ? t.slice(0, 15) + '…' : t;
}

function describe(n, tokens) {
  if (!n) return '?';
  const at = n.ctx_idx >= 0 && tokens[n.ctx_idx] !== undefined ? ` at "${tokText(tokens[n.ctx_idx])}"` : '';
  if (n.is_target_logit || n.feature_type === 'logit') return `answer ${logitLabel(n)}`;
  if (n.feature_type === 'embedding' || n.layer === 'E') return `token ${tokText(tokens[n.ctx_idx] !== undefined ? tokens[n.ctx_idx] : n.clerp || '')}`;
  if (/error/.test(n.feature_type || '')) return `error, layer ${n.layer}${at}`;
  return `feature ${n.feature}, layer ${n.layer}${at}`;
}

function nodeTip(n, tokens) {
  return [h('div.tip-head', null, describe(n, tokens)),
    n.clerp && !(n.is_target_logit || n.feature_type === 'logit') ? h('div', null, n.clerp) : null,
    Number.isFinite(n.influence) ? tipRow(fmt(n.influence, 3), 'effect on the answer') : null,
    Number.isFinite(n.activation) && n.activation ? tipRow(fmt(n.activation, 3), 'activation') : null,
    Number.isFinite(n.token_prob) && n.token_prob ? tipRow((100 * n.token_prob).toFixed(1) + '%', 'probability') : null];
}
