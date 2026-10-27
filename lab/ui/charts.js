/* lab/ui/charts.js: the lab's charts. Line charts and scatters are SVG, grids are canvas (a 12 x 144 or 40 x 40 grid
   is too many nodes for SVG on a phone), token strips and bar lists are plain HTML so text stays selectable.

   Colour does one job per chart (dataviz method): series identity uses the validated slots --s1 blue, --s2 orange,
   --s3 aqua (blue and orange are the only pair used without direct labels); magnitude uses one blue ramp; signed
   values use blue (+) and red (-) around a gray midpoint; controls (random directions, shuffled labels) are muted
   gray, so the eye goes to the real effect first. Every mark has a hover or tap readout. */

import { h, clear, fmt, isDark, cssVar, tokText } from './dom.js';

/* ---------------------------------------------------------------- tooltip */

let tipEl = null;
export const tip = {
  el() {
    if (!tipEl) { tipEl = h('div.tip', { role: 'tooltip' }); tipEl.hidden = true; document.body.appendChild(tipEl); }
    return tipEl;
  },
  show(content, x, y) {
    if (!content) { this.hide(); return; }
    const t = this.el();
    clear(t);
    for (const c of [].concat(content)) if (c) t.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    t.hidden = false;
    const r = t.getBoundingClientRect(), W = innerWidth, H = innerHeight;
    let left = x + 14, top = y + 14;
    if (left + r.width > W - 8) left = Math.max(8, x - r.width - 14);
    if (top + r.height > H - 8) top = Math.max(8, y - r.height - 14);
    t.style.left = left + 'px'; t.style.top = top + 'px';
  },
  hide() { if (tipEl) tipEl.hidden = true; },
};
addEventListener('scroll', () => tip.hide(), { passive: true });

/* a tooltip row: value first (strong), then what it is, keyed by a short line of the series colour */
export function tipRow(value, label, color) {
  return h('div.tip-row', null,
    color ? h('span.tip-key', { style: { background: color } }) : null,
    h('b', null, value), ' ', h('span', null, label));
}

/* ---------------------------------------------------------------- colour */

const RAMP_LIGHT = ['#f3f7fc', '#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
const RAMP_DARK = ['#2b2833', '#1d3554', '#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'];
const NEG_LIGHT = ['#f0efec', '#f7c8c3', '#ef948c', '#e34948', '#b52f2f', '#7d1f1f'];
const POS_LIGHT = ['#f0efec', '#b7d3f6', '#6da7ec', '#2a78d6', '#1c5cab', '#104281'];
const NEG_DARK = ['#383835', '#5c2e30', '#8f3838', '#c94747', '#e66767', '#f3a3a0'];
const POS_DARK = ['#383835', '#1f3a5f', '#1c5cab', '#2a78d6', '#3987e5', '#86b6ef'];

function hex2rgb(x) { const n = parseInt(x.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
const cache = new Map();
function rgbOf(x) { let v = cache.get(x); if (!v) { v = hex2rgb(x); cache.set(x, v); } return v; }

function lerp(stops, t) {
  t = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  const f = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(f)), u = f - i;
  const a = rgbOf(stops[i]), b = rgbOf(stops[i + 1]);
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}
const css = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;

/* magnitude in [0, 1] -> one blue ramp (dark mode flips the anchor: near zero recedes into the dark surface) */
export function seq(t) { return css(lerp(isDark() ? RAMP_DARK : RAMP_LIGHT, t)); }
export function seqRGB(t) { return lerp(isDark() ? RAMP_DARK : RAMP_LIGHT, t); }

/* signed value in [-1, 1] -> red (negative) . gray . blue (positive) */
export function div(t) { return css(divRGB(t)); }
export function divRGB(t) {
  const d = isDark();
  if (!(t < 0)) return lerp(d ? POS_DARK : POS_LIGHT, Math.min(1, t || 0));
  return lerp(d ? NEG_DARK : NEG_LIGHT, Math.min(1, -t));
}

/* readable text on a fill */
export function inkOn(rgb) {
  const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.32 ? '#14121a' : '#ffffff';
}

export function series(i) { return cssVar(['--s1', '--s2', '--s3'][i] || '--s1'); }

/* a palette token resolved now (SVG attributes get plain colours): col('s1'), col('ctrl'), col('neg') */
export const col = (name) => cssVar('--' + name);

/* ---------------------------------------------------------------- responsive helper */

/* Draw now and again whenever the element's width changes. Returns a function that redraws on demand. */
function responsive(el, draw) {
  let w = 0;
  const run = () => { const nw = Math.round(el.clientWidth); if (nw && nw !== w) { w = nw; draw(nw); } };
  if (window.ResizeObserver) {
    if (el.__ro) el.__ro.disconnect();
    el.__ro = new ResizeObserver(() => run());
    el.__ro.observe(el);
  }
  requestAnimationFrame(run);
  run();
  return () => { w = 0; run(); };
}

/* tick labels with just enough decimals for the step: 0, 2.5, 5 rather than 0.00, 2.50, 5.00 */
function tickFmt(ticks) {
  const step = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 1;
  let d = 0;
  while (d < 4 && Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) > 1e-6) d++;
  return (v) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(d);
}

function niceTicks(lo, hi, n = 5) {
  if (!(hi > lo)) { hi = lo + 1; }
  const span = hi - lo, step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || mag * 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

const SVGNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  for (const k of kids) if (k) el.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
  return el;
}

/* ---------------------------------------------------------------- legend */

export function legend(items) {
  return h('div.legend', { 'data-tara-noglossary': true },
    items.map((it) => h('span.legend-item', null,
      h('span.legend-key' + (it.kind === 'band' ? '.band' : it.kind === 'dot' ? '.dot' : ''),
        { style: { '--k': it.color } }),
      it.name)));
}

/* ---------------------------------------------------------------- line chart */

/* opts: { height, x: {label, fmt, min, max, ticks}, y: {label, fmt, min, max, zero}, series: [{name, color, pts:
   [[x, y]], band: [[x, lo, hi]], muted, dash, marker, width}], hlines: [{y, label}], vlines: [{x, label}],
   legend: true, caption } */
export function lineChart(el, opts) {
  clear(el);
  el.classList.add('chart');
  const leg = opts.legend === false ? null : legend(opts.series.filter((q) => !q.hideLegend).map((q) => ({
    name: q.name, color: q.color, kind: q.band && !q.pts ? 'band' : 'line' })));
  if (leg && opts.series.filter((q) => !q.hideLegend).length > 1) el.appendChild(leg);
  const box = h('div.chart-box', { 'data-tara-noglossary': true });
  el.appendChild(box);
  if (opts.caption) el.appendChild(h('div.chart-cap', null, opts.caption));
  const H = opts.height || 220;
  const xs = [], ys = [];
  for (const q of opts.series) {
    for (const p of q.pts || []) { xs.push(p[0]); if (Number.isFinite(p[1])) ys.push(p[1]); }
    for (const b of q.band || []) { xs.push(b[0]); if (Number.isFinite(b[1])) ys.push(b[1]); if (Number.isFinite(b[2])) ys.push(b[2]); }
  }
  for (const l of opts.hlines || []) ys.push(l.y);
  let x0 = opts.x.min ?? Math.min(...xs), x1 = opts.x.max ?? Math.max(...xs);
  let y0 = opts.y.min ?? Math.min(...ys), y1 = opts.y.max ?? Math.max(...ys);
  if (opts.y.zero !== false && opts.y.min === undefined) y0 = Math.min(0, y0);
  if (y1 === y0) { y1 += 1; y0 -= 1; }
  const pad = (y1 - y0) * 0.06;
  if (opts.y.min === undefined) y0 -= pad;
  if (opts.y.max === undefined) y1 += pad;
  const xf = opts.x.fmt || ((v) => fmt(v, 2)), yf = opts.y.fmt || ((v) => fmt(v, 2));
  const allX = [...new Set(xs)].sort((a, b) => a - b);

  const draw = (W) => {
    clear(box);
    const m = { l: 46, r: 12, t: 10, b: opts.x.label ? 40 : 26 };
    const pw = Math.max(40, W - m.l - m.r), ph = H - m.t - m.b;
    const X = (v) => m.l + (x1 === x0 ? pw / 2 : (v - x0) / (x1 - x0) * pw);
    const Y = (v) => m.t + (1 - (v - y0) / (y1 - y0)) * ph;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': opts.aria || opts.caption || 'chart' });
    const g = s('g');
    const yt = niceTicks(y0, y1, 4), ytf = opts.y.fmt || tickFmt(yt);
    for (const t of yt) {
      g.appendChild(s('line', { x1: m.l, x2: m.l + pw, y1: Y(t), y2: Y(t), class: t === 0 ? 'axis' : 'grid' }));
      g.appendChild(s('text', { x: m.l - 6, y: Y(t) + 4, class: 'tick', 'text-anchor': 'end' }, ytf(t)));
    }
    const xt = opts.x.ticks || (allX.length <= 13 ? allX : niceTicks(x0, x1, 6));
    for (const t of xt) g.appendChild(s('text', { x: X(t), y: m.t + ph + 16, class: 'tick', 'text-anchor': 'middle' }, xf(t)));
    if (opts.x.label) g.appendChild(s('text', { x: m.l + pw / 2, y: H - 4, class: 'axis-label', 'text-anchor': 'middle' }, opts.x.label));
    if (opts.y.label) g.appendChild(s('text', { x: 12, y: m.t + ph / 2, class: 'axis-label', 'text-anchor': 'middle', transform: `rotate(-90 12 ${m.t + ph / 2})` }, opts.y.label));
    for (const l of opts.hlines || []) {
      g.appendChild(s('line', { x1: m.l, x2: m.l + pw, y1: Y(l.y), y2: Y(l.y), class: 'ref' }));
      if (l.label) g.appendChild(s('text', { x: m.l + pw - 2, y: Y(l.y) - 4, class: 'ref-label', 'text-anchor': 'end' }, l.label));
    }
    for (const l of opts.vlines || []) {
      g.appendChild(s('line', { x1: X(l.x), x2: X(l.x), y1: m.t, y2: m.t + ph, class: 'ref' }));
      if (l.label) g.appendChild(s('text', { x: X(l.x) + 4, y: m.t + 10, class: 'ref-label' }, l.label));
    }
    for (const q of opts.series) {
      const col = q.color;
      if (q.band && q.band.length) {
        const top = q.band.map((b) => `${X(b[0])},${Y(b[2])}`), bot = q.band.slice().reverse().map((b) => `${X(b[0])},${Y(b[1])}`);
        g.appendChild(s('polygon', { points: top.concat(bot).join(' '), fill: col, 'fill-opacity': q.muted ? 0.14 : 0.12, stroke: 'none' }));
      }
      if (q.pts && q.pts.length) {
        const pts = q.pts.filter((p) => Number.isFinite(p[1]));
        g.appendChild(s('polyline', { points: pts.map((p) => `${X(p[0])},${Y(p[1])}`).join(' '), fill: 'none', stroke: col,
          'stroke-width': q.width || (q.muted ? 1.25 : 2), 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
          'stroke-opacity': q.muted ? 0.75 : 1, 'stroke-dasharray': q.dash ? '4 4' : null }));
        if (q.marker !== false && !q.muted) for (const p of pts) g.appendChild(s('circle', { cx: X(p[0]), cy: Y(p[1]), r: 4, fill: col, class: 'mark' }));
        if (q.endLabel && pts.length) {
          const p = pts[pts.length - 1];
          g.appendChild(s('text', { x: X(p[0]) - 6, y: Y(p[1]) - 8, class: 'end-label', 'text-anchor': 'end' }, q.endLabel));
        }
      }
    }
    const cross = s('line', { y1: m.t, y2: m.t + ph, class: 'cross', visibility: 'hidden' });
    g.appendChild(cross);
    const hit = s('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'transparent', style: 'cursor:crosshair' });
    const near = (cx) => {
      let best = allX[0], bd = Infinity;
      for (const v of allX) { const d = Math.abs(X(v) - cx); if (d < bd) { bd = d; best = v; } }
      return best;
    };
    const move = (ev) => {
      const r = svg.getBoundingClientRect(), cx = (ev.clientX - r.left) * (W / r.width);
      const xv = near(cx);
      cross.setAttribute('x1', X(xv)); cross.setAttribute('x2', X(xv)); cross.setAttribute('visibility', 'visible');
      const rows = [h('div.tip-head', null, (opts.x.label ? opts.x.label + ' ' : '') + xf(xv))];
      for (const q of opts.series) {
        if (q.noTip) continue;
        const p = (q.pts || []).find((pp) => pp[0] === xv), b = (q.band || []).find((bb) => bb[0] === xv);
        if (p && Number.isFinite(p[1])) rows.push(tipRow(yf(p[1]), q.name + (b ? ` (${yf(b[1])} to ${yf(b[2])})` : ''), q.color));
        else if (b) rows.push(tipRow(`${yf(b[1])} to ${yf(b[2])}`, q.name, q.color));
      }
      if (opts.tipExtra) { const ex = opts.tipExtra(xv); if (ex) rows.push(ex); }
      tip.show(rows, ev.clientX, ev.clientY);
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); tip.hide(); });
    g.appendChild(hit);
    svg.appendChild(g);
    box.appendChild(svg);
  };
  return responsive(box, draw);
}

/* ---------------------------------------------------------------- scatter */

/* opts: { height, points: [{x, y, c, hollow, label, tag}], classes: [{name, color}], x: {label, fmt}, y: {label, fmt},
   caption, ticks (draw value axes with zero lines), ref: {slope, intercept, label} (a reference line y = slope x + b),
   onPick(p) }. tag is a short direct label drawn beside the point (use sparingly). */
export function scatter(el, opts) {
  clear(el);
  el.classList.add('chart');
  if (opts.classes.length > 1 || opts.legend) el.appendChild(legend(opts.classes.map((c) => ({ name: c.name, color: c.color, kind: 'dot' }))));
  const box = h('div.chart-box', { 'data-tara-noglossary': true });
  el.appendChild(box);
  if (opts.caption) el.appendChild(h('div.chart-cap', null, opts.caption));
  const H = opts.height || 240;
  const xs = opts.points.map((p) => p.x), ys = opts.points.map((p) => p.y);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (opts.ticks) {
    const px = (x1 - x0 || 1) * 0.06, py = (y1 - y0 || 1) * 0.06;
    x0 -= px; x1 += px; y0 -= py; y1 += py;
  }
  const xf = (opts.x && opts.x.fmt) || null, yf = (opts.y && opts.y.fmt) || null;
  const draw = (W) => {
    clear(box);
    const m = opts.ticks ? { l: 46, r: 12, t: 8, b: 40 } : { l: 18, r: 10, t: 8, b: 22 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const X = (v) => m.l + (x1 === x0 ? 0.5 : (v - x0) / (x1 - x0)) * pw, Y = (v) => m.t + (1 - (y1 === y0 ? 0.5 : (v - y0) / (y1 - y0))) * ph;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': opts.caption || 'scatter' });
    if (opts.ticks) {
      const xt = niceTicks(x0, x1, Math.max(3, Math.min(6, Math.floor(pw / 70)))), yt = niceTicks(y0, y1, 4);
      const xtf = xf || tickFmt(xt), ytf = yf || tickFmt(yt);
      for (const t of yt) {
        svg.appendChild(s('line', { x1: m.l, x2: m.l + pw, y1: Y(t), y2: Y(t), class: t === 0 ? 'axis' : 'grid' }));
        svg.appendChild(s('text', { x: m.l - 6, y: Y(t) + 4, class: 'tick', 'text-anchor': 'end' }, ytf(t)));
      }
      for (const t of xt) {
        svg.appendChild(s('line', { x1: X(t), x2: X(t), y1: m.t, y2: m.t + ph, class: t === 0 ? 'axis' : 'grid' }));
        svg.appendChild(s('text', { x: X(t), y: m.t + ph + 15, class: 'tick', 'text-anchor': 'middle' }, xtf(t)));
      }
    } else svg.appendChild(s('rect', { x: m.l, y: m.t, width: pw, height: ph, class: 'frame' }));
    if (opts.ref) {
      const { slope = 1, intercept = 0, label } = opts.ref;
      // clip the line to the plot box
      const pts = [];
      for (const xv of [x0, x1]) { const yv = slope * xv + intercept; if (yv >= y0 && yv <= y1) pts.push([xv, yv]); }
      if (slope) for (const yv of [y0, y1]) { const xv = (yv - intercept) / slope; if (xv > x0 && xv < x1) pts.push([xv, yv]); }
      if (pts.length >= 2) {
        pts.sort((a, b) => a[0] - b[0]);
        const [a, b] = [pts[0], pts[pts.length - 1]];
        svg.appendChild(s('line', { x1: X(a[0]), y1: Y(a[1]), x2: X(b[0]), y2: Y(b[1]), class: 'ref', 'stroke-dasharray': '4 4' }));
        if (label) {
          // at whichever end of the line clears the dots and their tags; neither, and the caption has to say it
          const tw = label.length * 6;
          const boxes = opts.points.flatMap((p) => {
            const px = X(p.x), py = Y(p.y), out = [[px - 6, py - 6, px + 6, py + 6]];
            if (p.tag) { const w = p.tag.length * 6.5; out.push(px < m.l + pw - 60 ? [px + 6, py - 8, px + 10 + w, py + 6] : [px - 10 - w, py - 8, px - 6, py + 6]); }
            return out;
          });
          const clear = ([x, y, anchor]) => { const q = anchor === 'end' ? [x - tw, y - 10, x, y + 2] : [x, y - 10, x + tw, y + 2]; return !boxes.some((o) => o[0] < q[2] && o[2] > q[0] && o[1] < q[3] && o[3] > q[1]); };
          const at = [[X(b[0]) - 4, Y(b[1]) + (slope < 0 ? -6 : 14), 'end'], [X(a[0]) + 4, Y(a[1]) + (slope < 0 ? 14 : -6), 'start']].find(clear);
          if (at) svg.appendChild(s('text', { x: at[0], y: at[1], class: 'ref-label', 'text-anchor': at[2] }, label));
        }
      }
    }
    if (opts.x && opts.x.label) svg.appendChild(s('text', { x: m.l + pw / 2, y: H - 6, class: 'axis-label', 'text-anchor': 'middle' }, opts.x.label));
    if (opts.y && opts.y.label) svg.appendChild(s('text', { x: 11, y: m.t + ph / 2, class: 'axis-label', 'text-anchor': 'middle', transform: `rotate(-90 11 ${m.t + ph / 2})` }, opts.y.label));
    const tags = s('g');
    opts.points.forEach((p) => {
      const col = opts.classes[p.c] ? opts.classes[p.c].color : '#888';
      const dot = s('circle', { cx: X(p.x), cy: Y(p.y), r: p.r || 4.5, fill: p.hollow ? 'var(--card)' : col, stroke: p.hollow ? col : 'var(--card)', 'stroke-width': p.hollow ? 2 : 1.5 });
      const hit = s('circle', { cx: X(p.x), cy: Y(p.y), r: 12, fill: 'transparent', style: opts.onPick ? 'cursor:pointer' : null });
      const show = (ev) => tip.show([h('div.tip-head', null, p.head || (opts.classes[p.c] ? opts.classes[p.c].name : '')), p.label ? h('div', null, p.label) : null,
        p.hollow ? h('div.tip-sub', null, p.hollowNote || 'held out (the probe never saw it)') : null], ev.clientX, ev.clientY);
      hit.addEventListener('pointermove', show); hit.addEventListener('pointerdown', show); hit.addEventListener('pointerleave', () => tip.hide());
      if (opts.onPick) hit.addEventListener('click', () => opts.onPick(p));
      svg.appendChild(dot); svg.appendChild(hit);
      if (p.tag) {
        const right = X(p.x) < m.l + pw - 60;
        tags.appendChild(s('text', { x: X(p.x) + (right ? 8 : -8), y: Y(p.y) + 4, class: 'end-label', 'text-anchor': right ? 'start' : 'end' }, p.tag));
      }
    });
    svg.appendChild(tags);
    box.appendChild(svg);
  };
  return responsive(box, draw);
}

/* ---------------------------------------------------------------- grid (canvas) */

/* opts: { rows, cols, value(r, c), scale: 'seq' | 'div', max (abs max for div, max for seq), min,
   rowLabels, colLabels, cell (preferred px), minCell, square (rows as tall as columns are wide; labels thin out
   when cells get small), text(r, c) (short label drawn when cells are big),
   tip(r, c) -> nodes, onPick(r, c), selected: [r, c], marks: [[r, c]], caption, rowTitle, colTitle } */
export function grid(el, opts) {
  clear(el);
  el.classList.add('chart');
  const wrap = h('div.grid-scroll', { 'data-tara-noglossary': true });
  const canvas = h('canvas', { role: 'img', 'aria-label': opts.caption || 'grid' });
  wrap.appendChild(canvas);
  el.appendChild(wrap);
  if (opts.legend !== false) el.appendChild(scaleLegend(opts));
  if (opts.caption) el.appendChild(h('div.chart-cap', null, opts.caption));
  const R = opts.rows, C = opts.cols;
  const rowL = opts.rowLabels || [], colL = opts.colLabels || [];
  let sel = opts.selected || null;
  let geo = null;

  const draw = (W) => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const ctx0 = canvas.getContext('2d');
    ctx0.font = '11px system-ui, sans-serif';
    const lw = Math.min(110, Math.max(26, ...rowL.map((t) => ctx0.measureText(String(t)).width + 10)));
    const colLabelW = Math.min(90, Math.max(20, ...colL.map((t) => ctx0.measureText(tokText(t)).width + 8)));
    const minCell = opts.minCell || 14;
    let cw = Math.max(minCell, Math.min(opts.cell || 44, (W - lw - 4) / C));
    const ch = opts.square ? cw : opts.cellH || Math.max(14, Math.min(opts.cell || 30, cw * (opts.aspect || 0.8)));
    const rEvery = Math.max(1, Math.ceil(12 / ch)), cEvery = Math.max(1, Math.ceil(12 / cw));
    const rotate = colL.length && cw < colLabelW;
    const top = opts.colTitle ? 16 : 2;
    const bottom = colL.length ? (rotate ? Math.min(90, colLabelW * 0.75) + 8 : 20) : 4;
    const width = Math.ceil(lw + cw * C + 4), height = Math.ceil(top + ch * R + bottom);
    canvas.width = width * dpr; canvas.height = height * dpr;
    canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const ink = cssVar('--ink'), muted = cssVar('--muted'), card = cssVar('--card');
    ctx.font = '11px system-ui, sans-serif';
    if (opts.colTitle) { ctx.fillStyle = muted; ctx.textAlign = 'left'; ctx.fillText(opts.colTitle, lw, 11); }
    const max = opts.max || 1, min = opts.min || 0;
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        const v = opts.value(r, c);
        let rgb;
        if (!Number.isFinite(v)) rgb = rgbOf(isDark() ? '#2d2935' : '#f6f1e6');
        else if (opts.scale === 'div') rgb = divRGB(v / max);
        else rgb = seqRGB((v - min) / ((max - min) || 1));
        const x = lw + c * cw, y = top + r * ch;
        ctx.fillStyle = css(rgb);
        ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
        if (opts.text && cw >= 26 && ch >= 15) {
          const t = opts.text(r, c);
          if (t) {
            ctx.fillStyle = inkOn(rgb);
            ctx.textAlign = 'center';
            ctx.font = (cw >= 40 ? '11px' : '9.5px') + ' system-ui, sans-serif';
            let tt = tokText(t);
            while (tt.length > 1 && ctx.measureText(tt).width > cw - 4) tt = tt.slice(0, -1);
            ctx.fillText(tt, x + cw / 2, y + ch / 2 + 4);
            ctx.font = '11px system-ui, sans-serif';
          }
        }
      }
      ctx.fillStyle = muted; ctx.textAlign = 'right';
      if (rowL[r] !== undefined && r % rEvery === 0) ctx.fillText(tokText(String(rowL[r])), lw - 6, top + r * ch + ch / 2 + 4);
    }
    for (const [r, c] of opts.marks || []) {
      ctx.strokeStyle = ink; ctx.lineWidth = 1.5; ctx.strokeRect(lw + c * cw + 1.5, top + r * ch + 1.5, cw - 3, ch - 3);
    }
    if (sel) { ctx.strokeStyle = ink; ctx.lineWidth = 2.5; ctx.strokeRect(lw + sel[1] * cw + 1, top + sel[0] * ch + 1, cw - 2, ch - 2); }
    ctx.fillStyle = muted;
    for (let c = 0; c < C; c++) {
      if (colL[c] === undefined || (rotate && c % cEvery)) continue;
      let t = tokText(colL[c]);
      const x = lw + c * cw + cw / 2, y = top + R * ch + 12;
      if (rotate) {
        while (t.length > 1 && ctx.measureText(t).width > 84) t = t.slice(0, -1);
        ctx.save(); ctx.translate(x + 3, y - 4); ctx.rotate(-Math.PI / 4); ctx.textAlign = 'right'; ctx.fillText(t, 0, 0); ctx.restore();
      } else { ctx.textAlign = 'center'; ctx.fillText(t, x, y); }
    }
    void card;
    geo = { lw, cw, ch, top };
  };

  const cellAt = (ev) => {
    if (!geo) return null;
    const r0 = canvas.getBoundingClientRect();
    const x = ev.clientX - r0.left, y = ev.clientY - r0.top;
    const c = Math.floor((x - geo.lw) / geo.cw), r = Math.floor((y - geo.top) / geo.ch);
    return r >= 0 && r < R && c >= 0 && c < C ? [r, c] : null;
  };
  const show = (ev) => {
    const rc = cellAt(ev);
    if (!rc || !opts.tip) { tip.hide(); return; }
    tip.show(opts.tip(rc[0], rc[1]), ev.clientX, ev.clientY);
  };
  canvas.addEventListener('pointermove', show);
  canvas.addEventListener('pointerleave', () => tip.hide());
  canvas.addEventListener('click', (ev) => {
    const rc = cellAt(ev);
    if (!rc) return;
    if (opts.onPick) { sel = rc; redraw(); opts.onPick(rc[0], rc[1]); }
    show(ev);
  });
  const redraw = responsive(wrap, draw);
  return { redraw: () => { draw(Math.round(wrap.clientWidth)); }, select(rc) { sel = rc; draw(Math.round(wrap.clientWidth)); } };
}

function scaleLegend(opts) {
  const bar = h('span.scale-bar' + (opts.scale === 'div' ? '.div' : ''));
  const max = opts.max || 1, min = opts.min || 0;
  const f = opts.fmt || ((v) => fmt(v, 2));
  const lo = opts.scale === 'div' ? f(-max) : f(min), hi = f(max);
  return h('div.scale', { 'data-tara-noglossary': true },
    h('span', null, opts.loLabel ? `${lo} ${opts.loLabel}` : lo), bar,
    h('span', null, opts.hiLabel ? `${hi} ${opts.hiLabel}` : hi),
    opts.scale === 'div' ? h('span.scale-mid', null, opts.midLabel || '(gray = 0)') : null);
}

/* ---------------------------------------------------------------- bars (HTML) */

/* items: [{label, value, note, onClick, color, title}]; signed values draw from a centre line. */
export function bars(el, { items, max, signed = false, fmtv = (v) => fmt(v, 2), labelW = null, caption }) {
  clear(el);
  el.classList.add('bars');
  const m = max || Math.max(1e-9, ...items.map((it) => Math.abs(it.value)));
  /* every row's value and note get the same width, so the tracks line up and bar lengths compare */
  const wide = (xs) => Math.max(0, ...xs.map((x) => String(x ?? '').length));
  el.style.setProperty('--val-w', Math.max(5, wide(items.map((it) => fmtv(it.value))) + 1) + 'ch');
  const nw = wide(items.map((it) => it.note));
  el.style.setProperty('--note-w', nw ? nw + 1 + 'ch' : 'auto');
  for (const it of items) {
    const w = Math.min(1, Math.abs(it.value) / m);
    const col = it.color || (signed ? (it.value >= 0 ? 'var(--s1)' : 'var(--neg)') : 'var(--s1)');
    const track = h('span.bar-track' + (signed ? '.signed' : ''));
    const fill = h('span.bar-fill', { style: { width: (signed ? w * 50 : w * 100) + '%', background: col } });
    if (signed) { fill.style[it.value >= 0 ? 'left' : 'right'] = '50%'; fill.classList.add(it.value >= 0 ? 'pos' : 'neg'); }
    track.appendChild(fill);
    const row = h(it.onClick ? 'button.bar-row' : 'div.bar-row', { type: it.onClick ? 'button' : null, title: it.title || null, onclick: it.onClick || null },
      h('span.bar-label', { style: labelW ? { flexBasis: labelW } : null, 'data-tara-noglossary': true }, it.label),
      track,
      h('span.bar-val', null, fmtv(it.value)),
      it.note ? h('span.bar-note', null, it.note) : null);
    el.appendChild(row);
  }
  if (caption) el.appendChild(h('div.chart-cap', null, caption));
}

/* ---------------------------------------------------------------- token strip (HTML) */

/* opts: { pieces, values (per token), scale 'seq'|'div', max, min, tip(i), onPick(i), selected, skip: Set of
   positions to draw plainly (for example <|endoftext|>) } */
export function tokens(el, opts) {
  clear(el);
  el.classList.add('toks');
  el.setAttribute('data-tara-noglossary', '');
  const max = opts.max || Math.max(1e-9, ...opts.values.map((v) => Math.abs(v || 0)));
  const min = opts.min || 0;
  opts.pieces.forEach((p, i) => {
    const v = opts.values[i];
    let rgb = null;
    if (!(opts.skip && opts.skip.has(i)) && Number.isFinite(v)) rgb = opts.scale === 'div' ? divRGB(v / max) : seqRGB((v - min) / ((max - min) || 1));
    const sp = h('span.tok' + (opts.selected === i ? '.sel' : '') + (opts.onPick ? '.pick' : ''),
      { tabindex: opts.onPick ? 0 : null, style: rgb ? { background: css(rgb), color: inkOn(rgb) } : null }, tokText(p));
    if (p === '<|endoftext|>') { sp.textContent = '⟨bos⟩'; sp.classList.add('bos'); }
    if (opts.tip) {
      const show = (ev) => { const r = sp.getBoundingClientRect(); tip.show(opts.tip(i), ev.clientX || r.left, ev.clientY || r.bottom); };
      sp.addEventListener('pointermove', show);
      sp.addEventListener('pointerleave', () => tip.hide());
      sp.addEventListener('focus', show);
      sp.addEventListener('blur', () => tip.hide());
    }
    if (opts.onPick) {
      sp.addEventListener('click', () => opts.onPick(i));
      sp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); opts.onPick(i); } });
    }
    el.appendChild(sp);
  });
}

/* ---------------------------------------------------------------- small pieces */

export function stat(label, value, sub) {
  return h('div.stat', null, h('div.stat-label', null, label), h('div.stat-value', null, value), sub ? h('div.stat-sub', null, sub) : null);
}

export function progress(el) {
  clear(el);
  const bar = h('div.progress', { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('span'));
  const label = h('span.progress-label');
  el.appendChild(bar); el.appendChild(label);
  return {
    set(frac, text) {
      bar.firstChild.style.width = Math.round(100 * Math.max(0, Math.min(1, frac))) + '%';
      bar.setAttribute('aria-valuenow', Math.round(100 * frac));
      if (text !== undefined) label.textContent = text;
    },
    done() { clear(el); },
  };
}

/* ---------------------------------------------------------------- intervals (a forest plot, SVG) */

/* One row per estimate: a dot with its 95% interval, and the controls as gray dots on the same line, so "does the
   blue interval clear the gray dots?" is answered by eye. rows: [{label, est, lo, hi, ctrl: [values], note}];
   x: {label, fmt, min, max}; ref: the "no effect" value; estName, ctrlName name the two marks. */
export function intervals(el, opts) {
  clear(el);
  el.classList.add('chart');
  const items = [{ name: opts.estName || 'estimate, with its 95% interval', color: col('s1'), kind: 'dot' }];
  if (opts.rows.some((r) => r.ctrl && r.ctrl.length)) items.push({ name: opts.ctrlName || 'controls', color: col('ctrl'), kind: 'dot' });
  el.appendChild(legend(items));
  const box = h('div.chart-box', { 'data-tara-noglossary': true });
  el.appendChild(box);
  if (opts.caption) el.appendChild(h('div.chart-cap', null, opts.caption));
  const vals = [];
  for (const r of opts.rows) vals.push(r.est, r.lo, r.hi, ...(r.ctrl || []));
  if (opts.ref !== undefined) vals.push(opts.ref);
  const fin = vals.filter(Number.isFinite);
  let x0 = opts.x.min ?? Math.min(...fin), x1 = opts.x.max ?? Math.max(...fin);
  if (!(x1 > x0)) { x0 -= 1; x1 += 1; }
  const pad = (x1 - x0) * 0.06;
  if (opts.x.min === undefined) x0 -= pad;
  if (opts.x.max === undefined) x1 += pad;
  const f = opts.x.fmt || ((v) => fmt(v, 2));
  const rowH = 36;
  const draw = (W) => {
    clear(box);
    const lw = Math.round(Math.min(170, Math.max(64, W * 0.3)));
    const m = { l: lw, r: 16, t: 6, b: opts.x.label ? 40 : 24 };
    const pw = Math.max(60, W - m.l - m.r), H = m.t + opts.rows.length * rowH + m.b;
    const X = (v) => m.l + Math.max(0, Math.min(1, (v - x0) / (x1 - x0))) * pw;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': opts.caption || 'intervals' });
    for (const t of niceTicks(x0, x1, W < 420 ? 3 : 5)) {
      svg.appendChild(s('line', { x1: X(t), x2: X(t), y1: m.t, y2: H - m.b, class: 'grid' }));
      svg.appendChild(s('text', { x: X(t), y: H - m.b + 15, class: 'tick', 'text-anchor': 'middle' }, f(t)));
    }
    if (opts.ref !== undefined) svg.appendChild(s('line', { x1: X(opts.ref), x2: X(opts.ref), y1: m.t, y2: H - m.b, class: 'axis' }));
    if (opts.x.label) svg.appendChild(s('text', { x: m.l + pw / 2, y: H - 4, class: 'axis-label', 'text-anchor': 'middle' }, opts.x.label));
    opts.rows.forEach((r, i) => {
      const y = m.t + i * rowH + rowH / 2;
      let lab = String(r.label);
      const t = s('text', { x: m.l - 10, y: y + 4, class: 'tick', 'text-anchor': 'end' }, lab);
      svg.appendChild(t);
      for (const c of r.ctrl || []) if (Number.isFinite(c)) svg.appendChild(s('circle', { cx: X(c), cy: y, r: 4, fill: col('ctrl'), 'fill-opacity': 0.75 }));
      if (Number.isFinite(r.lo) && Number.isFinite(r.hi)) {
        svg.appendChild(s('line', { x1: X(r.lo), x2: X(r.hi), y1: y, y2: y, stroke: col('s1'), 'stroke-width': 2.5, 'stroke-linecap': 'round' }));
        if (r.lo < x0) svg.appendChild(s('path', { d: `M${X(x0) + 7} ${y - 5} L${X(x0) + 1} ${y} L${X(x0) + 7} ${y + 5}`, stroke: col('s1'), fill: 'none', 'stroke-width': 2 }));
        if (r.hi > x1) svg.appendChild(s('path', { d: `M${X(x1) - 7} ${y - 5} L${X(x1) - 1} ${y} L${X(x1) - 7} ${y + 5}`, stroke: col('s1'), fill: 'none', 'stroke-width': 2 }));
      }
      if (Number.isFinite(r.est)) svg.appendChild(s('circle', { cx: X(r.est), cy: y, r: 6, fill: col('s1'), class: 'mark' }));
      const hit = s('rect', { x: 0, y: y - rowH / 2, width: W, height: rowH, fill: 'transparent' });
      const show = (ev) => tip.show([h('div.tip-head', null, r.label),
        tipRow(f(r.est), (opts.estName || 'estimate') + (Number.isFinite(r.lo) ? ` (${f(r.lo)} to ${f(r.hi)})` : ''), col('s1')),
        r.ctrl && r.ctrl.length ? tipRow(r.ctrl.map(f).join(', '), opts.ctrlName || 'controls', col('ctrl')) : null,
        r.note ? h('div.tip-sub', null, r.note) : null], ev.clientX, ev.clientY);
      hit.addEventListener('pointermove', show); hit.addEventListener('pointerdown', show); hit.addEventListener('pointerleave', () => tip.hide());
      svg.appendChild(hit);
      // shorten labels that do not fit the gutter
      requestAnimationFrame(() => { try { while (lab.length > 4 && t.getComputedTextLength() > lw - 14) { lab = lab.slice(0, -2); t.textContent = lab + '…'; } } catch (e) { /* not rendered */ } });
    });
    box.appendChild(svg);
  };
  return responsive(box, draw);
}

/* ---------------------------------------------------------------- paired dots (SVG) */

/* Two values per item on one axis, joined by a line: rows [{label, a, b, note}], aName/bName; a is drawn gray (the
   baseline), b blue. */
export function dumbbell(el, opts) {
  clear(el);
  el.classList.add('chart');
  el.appendChild(legend([{ name: opts.bName, color: col('s1'), kind: 'dot' }, { name: opts.aName, color: col('ctrl'), kind: 'dot' }]));
  const box = h('div.chart-box', { 'data-tara-noglossary': true });
  el.appendChild(box);
  if (opts.caption) el.appendChild(h('div.chart-cap', null, opts.caption));
  const fin = opts.rows.flatMap((r) => [r.a, r.b]).concat(opts.ref !== undefined ? [opts.ref] : []).filter(Number.isFinite);
  let x0 = Math.min(...fin), x1 = Math.max(...fin);
  if (!(x1 > x0)) { x0 -= 1; x1 += 1; }
  const pad = (x1 - x0) * 0.06; x0 -= pad; x1 += pad;
  const f = opts.x && opts.x.fmt || ((v) => fmt(v, 2));
  const rowH = 26;
  const ticks = niceTicks(x0, x1, 5), tf = opts.x && opts.x.fmt || tickFmt(ticks);
  const draw = (W) => {
    clear(box);
    const lw = Math.round(Math.min(220, Math.max(70, W * 0.38)));
    const m = { l: lw, r: 14, t: 4, b: opts.x && opts.x.label ? 40 : 24 };
    const pw = Math.max(60, W - m.l - m.r), H = m.t + opts.rows.length * rowH + m.b;
    const X = (v) => m.l + (v - x0) / (x1 - x0) * pw;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': opts.caption || 'paired values' });
    for (const t of (W < 420 ? niceTicks(x0, x1, 3) : ticks)) {
      svg.appendChild(s('line', { x1: X(t), x2: X(t), y1: m.t, y2: H - m.b, class: 'grid' }));
      svg.appendChild(s('text', { x: X(t), y: H - m.b + 15, class: 'tick', 'text-anchor': 'middle' }, tf(t)));
    }
    if (opts.ref !== undefined) svg.appendChild(s('line', { x1: X(opts.ref), x2: X(opts.ref), y1: m.t, y2: H - m.b, class: 'axis' }));
    if (opts.x && opts.x.label) svg.appendChild(s('text', { x: m.l + pw / 2, y: H - 4, class: 'axis-label', 'text-anchor': 'middle' }, opts.x.label));
    opts.rows.forEach((r, i) => {
      const y = m.t + i * rowH + rowH / 2;
      let lab = String(r.label);
      const t = s('text', { x: m.l - 8, y: y + 4, class: 'tick', 'text-anchor': 'end' }, lab);
      svg.appendChild(t);
      svg.appendChild(s('line', { x1: X(r.a), x2: X(r.b), y1: y, y2: y, stroke: col('axis'), 'stroke-width': 2 }));
      svg.appendChild(s('circle', { cx: X(r.a), cy: y, r: 4.5, fill: col('ctrl'), class: 'mark' }));
      svg.appendChild(s('circle', { cx: X(r.b), cy: y, r: 5, fill: col('s1'), class: 'mark' }));
      const hit = s('rect', { x: 0, y: y - rowH / 2, width: W, height: rowH, fill: 'transparent' });
      const show = (ev) => tip.show([h('div.tip-head', null, r.label), tipRow(f(r.b), opts.bName, col('s1')), tipRow(f(r.a), opts.aName, col('ctrl')),
        r.note ? h('div.tip-sub', null, r.note) : null], ev.clientX, ev.clientY);
      hit.addEventListener('pointermove', show); hit.addEventListener('pointerdown', show); hit.addEventListener('pointerleave', () => tip.hide());
      svg.appendChild(hit);
      requestAnimationFrame(() => { try { while (lab.length > 4 && t.getComputedTextLength() > lw - 12) { lab = lab.slice(0, -2); t.textContent = lab + '…'; } } catch (e) { /* */ } });
    });
    box.appendChild(svg);
  };
  return responsive(box, draw);
}

/* ---------------------------------------------------------------- columns (a histogram, SVG) */

/* bins: [{label, value, tip}]; one series, so one colour; labels are thinned to fit. */
export function columns(el, { bins, height = 160, x = {}, y = {}, caption, color }) {
  clear(el);
  el.classList.add('chart');
  const box = h('div.chart-box', { 'data-tara-noglossary': true });
  el.appendChild(box);
  if (caption) el.appendChild(h('div.chart-cap', null, caption));
  const vmax = Math.max(1e-9, ...bins.map((b) => b.value));
  /* y.log: powers of ten from just below the smallest bar, so a heavy tail stays visible */
  const pos = bins.map((b) => b.value).filter((v) => v > 0);
  const lo = y.log ? Math.floor(Math.log10(Math.min(...pos, vmax))) : 0, hi = y.log ? Math.max(lo + 1, Math.ceil(Math.log10(vmax))) : 0;
  const yf = y.fmt || (y.log ? (v) => (v >= 1e6 ? +(v / 1e6).toPrecision(3) + 'M' : v >= 1e3 ? +(v / 1e3).toPrecision(3) + 'k' : v >= 1 ? String(Math.round(v)) : String(+v.toPrecision(1))) : (v) => fmt(v, 0));
  const draw = (W) => {
    clear(box);
    const m = { l: 44, r: 8, t: 8, b: x.label ? 40 : 24 };
    const pw = Math.max(40, W - m.l - m.r), ph = height - m.t - m.b, bw = pw / bins.length;
    const Y = y.log ? (v) => m.t + (1 - (Math.log10(Math.max(v, 10 ** lo)) - lo) / (hi - lo)) * ph : (v) => m.t + (1 - v / vmax) * ph;
    const svg = s('svg', { viewBox: `0 0 ${W} ${height}`, width: W, height, role: 'img', 'aria-label': caption || 'histogram' });
    const ticks = y.log ? Array.from({ length: hi - lo + 1 }, (_, i) => 10 ** (lo + i)).filter((t, i, a) => a.length <= 4 || i % 2 === (a.length - 1) % 2) : niceTicks(0, vmax, 3);
    for (const t of ticks) {
      svg.appendChild(s('line', { x1: m.l, x2: m.l + pw, y1: Y(t), y2: Y(t), class: (y.log ? t === 10 ** lo : t === 0) ? 'axis' : 'grid' }));
      svg.appendChild(s('text', { x: m.l - 6, y: Y(t) + 4, class: 'tick', 'text-anchor': 'end' }, yf(t)));
    }
    // callers that blank some labels have already chosen which to show
    const every = bins.some((b) => b.label === '') ? 1 : Math.max(1, Math.ceil(bins.length / Math.max(2, Math.floor(pw / 46))));
    bins.forEach((b, i) => {
      const x0 = m.l + i * bw;
      if (b.value > 0) {
        const top = Y(b.value), hgt = m.t + ph - top;
        svg.appendChild(s('path', { d: roundTop(x0 + 1, top, Math.max(1, bw - 2), hgt, Math.min(4, (bw - 2) / 2)), fill: color || col('s1') }));
      }
      if (i % every === 0) svg.appendChild(s('text', { x: x0 + bw / 2, y: m.t + ph + 15, class: 'tick', 'text-anchor': 'middle' }, b.label));
      const hit = s('rect', { x: x0, y: m.t, width: bw, height: ph, fill: 'transparent' });
      const show = (ev) => tip.show(b.tip || [h('div.tip-head', null, b.label), tipRow(yf(b.value), y.label || '')], ev.clientX, ev.clientY);
      hit.addEventListener('pointermove', show); hit.addEventListener('pointerdown', show); hit.addEventListener('pointerleave', () => tip.hide());
      svg.appendChild(hit);
    });
    if (x.label) svg.appendChild(s('text', { x: m.l + pw / 2, y: height - 4, class: 'axis-label', 'text-anchor': 'middle' }, x.label));
    if (y.label) svg.appendChild(s('text', { x: 11, y: m.t + ph / 2, class: 'axis-label', 'text-anchor': 'middle', transform: `rotate(-90 11 ${m.t + ph / 2})` }, y.label));
    box.appendChild(svg);
  };
  return responsive(box, draw);
}

/* a bar with its two top corners rounded and its base square on the axis */
function roundTop(x, y, w, hgt, r) {
  r = Math.max(0, Math.min(r, hgt));
  return `M${x} ${y + hgt} L${x} ${y + r} Q${x} ${y} ${x + r} ${y} L${x + w - r} ${y} Q${x + w} ${y} ${x + w} ${y + r} L${x + w} ${y + hgt} Z`;
}
