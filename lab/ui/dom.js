/* lab/ui/dom.js: small helpers shared by every view. Text from models, packs and the user always goes in through
   textContent (h() children that are strings become text nodes), never through innerHTML; only the lab's own authored
   teaching copy is inserted as HTML (see teach.js). */

export function h(tag, attrs, ...kids) {
  const [name, ...cls] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (cls.length) el.className = cls.join(' ');
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = (el.className ? el.className + ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
    }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;           // authored copy only
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  add(el, kids);
  return el;
}

function add(el, kids) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) add(el, k);
    else if (k instanceof Node) el.appendChild(k);
    else el.appendChild(document.createTextNode(String(k)));
  }
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function mount(el, ...kids) { clear(el); add(el, kids); return el; }

/* ---------------------------------------------------------------- numbers */

export function fmt(x, d = 2) {
  if (x === null || x === undefined || Number.isNaN(x)) return '–';
  const a = Math.abs(x);
  if (a !== 0 && (a < 10 ** -d || a >= 1e5)) return x.toExponential(1);
  return x.toFixed(d);
}

export function signed(x, d = 2) { return (x > 0 ? '+' : x < 0 ? '−' : '') + fmt(Math.abs(x), d); }

export function pct(x, d = 0) { return (x === null || x === undefined || Number.isNaN(x)) ? '–' : (100 * x).toFixed(d) + '%'; }

export function bytes(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
  if (n >= 1e6) return Math.round(n / 1e6) + ' MB';
  if (n >= 1e3) return Math.round(n / 1e3) + ' KB';
  return n + ' B';
}

/* how a token looks on screen: spaces visible, newlines as a return sign, invisible characters as their code point */
// characters that draw nothing on their own (controls, zero-width and format characters, variation selectors)
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Variation_Selector}]/gu;
const codePoint = (c) => `‹U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}›`;
export function tokText(s) {
  if (s === null || s === undefined) return '';
  const t = String(s).replace(/\n/g, '⏎').replace(/\t/g, '⇥').replace(/^ /, '␣').replace(/ /g, ' ').replace(HIDDEN, codePoint);
  return /^\p{M}+$/u.test(t) ? [...t].map(codePoint).join('') : t;     // a lone combining mark would join its neighbour
}

export function debounce(fn, ms) {
  let t = null;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.now = (...a) => { clearTimeout(t); return fn(...a); };
  return d;
}

/* ---------------------------------------------------------------- storage (never throws) */

export const store = {
  get(k, dflt) { try { const v = localStorage.getItem(k); return v === null ? dflt : JSON.parse(v); } catch (e) { return dflt; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
};

/* ---------------------------------------------------------------- hash routes: #view/a/b?x=1&y=2 */

export function parseHash(hash = location.hash) {
  const raw = (hash || '').replace(/^#/, '');
  const [path, query = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch (e) { return p; } });
  const params = {};
  for (const kv of query.split('&').filter(Boolean)) {
    const [k, v = ''] = kv.split('=');
    try { params[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { params[k] = v; }
  }
  return { view: parts[0] || 'today', parts: parts.slice(1), params };
}

export function hashFor(view, parts = [], params = {}) {
  const p = [view, ...parts].map(encodeURIComponent).join('/');
  const q = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  return '#' + p + (q ? '?' + q : '');
}

/* ---------------------------------------------------------------- the reading layer */

/* After a view injects content: let the layer find new tier groups, glossary terms and angles. */
export function rescan(root) {
  try { if (window.TARA && window.TARA.rescan) window.TARA.rescan(root || document.body); } catch (e) { /* layer absent */ }
}

export function tier() {
  try { if (window.TARA && window.TARA.getTier) return Number(window.TARA.getTier()) || 2; } catch (e) { /* */ }
  const t = store.get('tara.tier', null);
  return Number(t) || 2;
}

/* A tier group from authored copy: {1: html, 2: html, 3: html}; missing tiers fall back as the layer documents. */
export function tiers(id, variants, cls = '') {
  const g = h('div.teach' + (cls ? '.' + cls : ''), { 'data-tier-group': true, id });
  for (const t of ['1', '2', '3']) if (variants[t]) g.appendChild(h('div', { 'data-tier': t, html: variants[t] }));
  if (variants.all) g.appendChild(h('div', { html: variants.all }));
  return g;
}

export function isDark() {
  const r = document.documentElement.getAttribute('data-theme');
  if (r === 'dark') return true;
  if (r === 'light') return false;
  return !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
}

/* resolve a CSS custom property to its current value */
export function cssVar(name, el = document.documentElement) { return getComputedStyle(el).getPropertyValue(name).trim(); }
