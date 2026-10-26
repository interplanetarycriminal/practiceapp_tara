/* ==========================================================================
   tara-layer.js — the TARA reading layer
   --------------------------------------------------------------------------
   One file. No dependencies. No network. Safe to inline into any page.

   Everything public hangs off window.TARA. All floating UI lives inside a
   single host element with an open shadow root, so none of this layer's
   component CSS can reach the page. The only styles written into the page
   document are a short, fully namespaced sheet (every selector starts with
   .tara- or [data-tara-]) plus --tara-* custom properties on :root, which
   cannot override anything the page already declares.

   Public API (see AUTHORING.md):
     TARA.init(options)      TARA.setTier(n)       TARA.getTier()
     TARA.shuffleQuizzes()   TARA.rescan(root)     TARA.addGlossary(list)
     TARA.review.*           TARA.signal(v)        TARA.destroy()
   Author inputs:
     window.TARA_CONTENT  window.TARA_EXPLAIN  window.TARA_MAP_URL
     window.TARA_PLAN_URL  window.TARA_CASES_URL  window.TARA_DRILL_URL  window.TARA_STICKY_OFFSET
     window.TARA_GLOSSARY_EXTRA  window.TARA_OPTIONS  window.TARA_NO_AUTOINIT
   ========================================================================== */
(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.TARA && window.TARA.__installed) return;

  var VERSION = '1.0.0';

  /* ---------------------------------------------------------------- utils */

  var K_TIER = 'tara.tier';
  var K_TIER_ALIAS = 'tara.resolution'; /* older key used by the case-study library; read as fallback, always written alongside */
  var K_REVIEW = 'tara.review';
  var K_SIGNAL = 'tara.signal';

  function warn(e) { try { if (window.TARA_DEBUG) console.warn('[TARA]', e); } catch (_) {} }
  /* Every entry point is wrapped in this. The layer must never throw into a page. */
  function guard(fn, label) {
    return function () {
      try { return fn.apply(this, arguments); }
      catch (e) { warn((label || '') + ': ' + (e && e.message ? e.message : e)); return undefined; }
    };
  }

  function lsGet(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      if (raw === null || raw === undefined) return fallback;
      return raw;
    } catch (e) { warn(e); return fallback; }
  }
  function lsSet(key, value) {
    try { window.localStorage.setItem(key, value); return true; }
    catch (e) { warn(e); return false; }
  }
  function jsonGet(key, fallback) {
    var raw = lsGet(key, null);
    if (raw == null) return fallback;
    try { var v = JSON.parse(raw); return (v === null || v === undefined) ? fallback : v; }
    catch (e) { warn(e); return fallback; }
  }
  function jsonSet(key, value) { try { return lsSet(key, JSON.stringify(value)); } catch (e) { warn(e); return false; } }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'class') n.className = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    if (kids) for (var i = 0; i < kids.length; i++) if (kids[i]) n.appendChild(kids[i]);
    return n;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function rxEsc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function slugify(s) {
    var t = String(s == null ? '' : s).toLowerCase();
    try { t = t.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
    return t.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  /* Normalised passage text: the key shape used by TARA_EXPLAIN. */
  function norm(s) {
    return String(s == null ? '' : s)
      .replace(/[‘’‛]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—−]/g, '-')
      .replace(/ /g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s"'([{]+|[\s"')\]}.,;:!?]+$/g, '')
      .toLowerCase()
      .trim();
  }
  function words(s) { return String(s || '').trim().split(/\s+/).filter(Boolean); }
  function truthyAttr(node, name) { return !!(node && node.nodeType === 1 && node.hasAttribute(name)); }
  function closest(node, sel) {
    var n = node;
    while (n && n.nodeType !== 1) n = n.parentNode;
    if (!n || !n.closest) return null;
    try { return n.closest(sel); } catch (e) { return null; }
  }
  function onceRAF(fn) { try { return window.requestAnimationFrame(fn); } catch (e) { return setTimeout(fn, 16); } }
  function isEditable(node) {
    var n = node;
    while (n && n.nodeType !== 1) n = n.parentNode;
    while (n && n.nodeType === 1) {
      var tag = n.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION') return true;
      if (n.isContentEditable) return true;
      n = n.parentNode;
    }
    return false;
  }
  function prefersReducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  function isTouch() {
    try { return window.matchMedia('(hover: none)').matches || ('ontouchstart' in window); } catch (e) { return false; }
  }
  /* Split a run of prose into sentences, keeping the terminator. */
  function sentences(text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return [];
    var out = t.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g);
    return (out || [t]).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  var BLOCK_TAGS = { P: 1, LI: 1, DIV: 1, SECTION: 1, ARTICLE: 1, BLOCKQUOTE: 1, PRE: 1, FIGURE: 1, TABLE: 1, UL: 1, OL: 1, DL: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1 };
  function blockChildren(root) {
    if (!root) return [];
    var out = [], kids = root.children || [];
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c.hasAttribute && c.hasAttribute('data-angle')) continue;
      if (c.classList && (c.classList.contains('tara-angles') || c.classList.contains('tara-mark'))) continue;
      if (BLOCK_TAGS[c.tagName]) out.push(c);
    }
    return out;
  }

  /* --------------------------------------------------------------- state  */

  var S = {
    tier: 2,
    inited: false,
    host: null,
    shadow: null,
    ui: {},
    opts: {},
    groups: [],          /* {el, variants:{1,2,3}, defaults:[], external:bool, cache:{}} */
    termIndex: null,     /* lowercased term -> entry  */
    termRxCS: null,      /* case-sensitive alternation  */
    termRxCI: null,      /* case-insensitive alternation */
    quizzes: [],
    listeners: [],
    scanned: false
  };

  function on(target, type, fn, opts) {
    if (!target) return;
    var wrapped = guard(fn, type);
    target.addEventListener(type, wrapped, opts);
    S.listeners.push([target, type, wrapped, opts]);
  }

  /* --------------------------------------------------------- page styles  */
  /* Namespaced, additive only. Nothing here can change how the page looked
     before the layer was inlined: every selector is .tara-* / [data-tara-*],
     and the only :root declarations are --tara-* custom properties. */

  var PAGE_CSS = `
:root{
  --tara-bg:#F7FBFA; --tara-bg2:#EDF4F2; --tara-bg3:#FFFFFF;
  --tara-ink:#101E1C; --tara-ink2:#465956; --tara-ink3:#6D807D;
  --tara-line:#BFD0CD; --tara-line2:#D8E5E2;
  --tara-accent:#09655D; --tara-accent-soft:#D3E7E4;
  --tara-warm:#B04E27; --tara-gold:#87680F;
  --tara-shadow:0 6px 24px rgba(16,30,28,.14), 0 1px 0 rgba(16,30,28,.06);
  --tara-f-ui:'Archivo',system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  --tara-f-mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --tara-bg:#131D1C; --tara-bg2:#101A19; --tara-bg3:#182422;
    --tara-ink:#E7F0ED; --tara-ink2:#A5B8B4; --tara-ink3:#7B8E8A;
    --tara-line:#2B3A38; --tara-line2:#21302E;
    --tara-accent:#4EC6B3; --tara-accent-soft:#153230;
    --tara-warm:#EA8A5E; --tara-gold:#D6B45C;
    --tara-shadow:0 6px 26px rgba(0,0,0,.5), 0 1px 0 rgba(0,0,0,.4);
  }
}
:root[data-theme="dark"]{
  --tara-bg:#131D1C; --tara-bg2:#101A19; --tara-bg3:#182422;
  --tara-ink:#E7F0ED; --tara-ink2:#A5B8B4; --tara-ink3:#7B8E8A;
  --tara-line:#2B3A38; --tara-line2:#21302E;
  --tara-accent:#4EC6B3; --tara-accent-soft:#153230;
  --tara-warm:#EA8A5E; --tara-gold:#D6B45C;
  --tara-shadow:0 6px 26px rgba(0,0,0,.5), 0 1px 0 rgba(0,0,0,.4);
}

.tara-hidden{display:none !important}

/* anchors landing under sticky headers: apply.js --sticky-offset sets the var */
:where([id]){scroll-margin-top:var(--tara-sticky-offset, 0px)}

/* glossary term in running prose */
.tara-term{
  display:inline;   /* flex/grid parents would otherwise turn the span into a block */
  border-bottom:1px dotted var(--tara-accent);
  cursor:help; color:inherit; background:none;
  text-decoration:none; padding:0; border-radius:2px;
}
.tara-term:hover,.tara-term[data-tara-open="1"]{
  background:var(--tara-accent-soft);
  border-bottom-color:var(--tara-accent);
}
.tara-term:focus-visible{outline:2px solid var(--tara-accent);outline-offset:2px}
.tara-term::after{content:none}
/* Generated content, deliberately: a real element would end up inside
   Selection.toString() and inside anything the reader copies. */
html[data-tara-tier="3"] .tara-term::after{
  content:"\\00b0"; font-family:var(--tara-f-mono); font-size:.62em;
  line-height:1; vertical-align:super; color:var(--tara-accent);
  margin-left:.1em; opacity:.75;
}

/* "written at one level only" marker */
.tara-tier-group[data-tara-marked]{position:relative}
.tara-mark{
  position:absolute; left:-1.15em; top:.45em; width:6px; height:6px; border-radius:50%;
  background:var(--tara-line); border:0; padding:0; cursor:help; opacity:.85;
}
.tara-mark:hover,.tara-mark:focus-visible{background:var(--tara-accent);opacity:1}
.tara-mark:focus-visible{outline:2px solid var(--tara-accent);outline-offset:3px}
@media (max-width:760px){ .tara-mark{left:auto; right:-2px; top:-10px} }

/* "another angle" control */
.tara-angles{
  display:flex; flex-wrap:wrap; gap:6px; align-items:center;
  margin:10px 0 14px; font-family:var(--tara-f-mono); font-size:11px; line-height:1;
}
.tara-angles-label{
  color:var(--tara-ink3); letter-spacing:.12em; text-transform:uppercase;
  font-size:10px; margin-right:2px;
}
.tara-angle-btn{
  font:inherit; color:var(--tara-ink2); background:var(--tara-bg);
  border:1px solid var(--tara-line2); border-radius:2px; padding:5px 9px;
  cursor:pointer; letter-spacing:.04em;
}
.tara-angle-btn:hover{border-color:var(--tara-accent);color:var(--tara-ink)}
.tara-angle-btn[aria-pressed="true"]{
  background:var(--tara-accent-soft); border-color:var(--tara-accent); color:var(--tara-ink);
}
.tara-angle-btn:focus-visible{outline:2px solid var(--tara-accent);outline-offset:2px}
.tara-angles--quiet{opacity:.62}
.tara-angles--quiet:hover,.tara-angles--quiet:focus-within{opacity:1}

/* inline "this clicked / this did not" */
.tara-signal{
  display:flex; gap:8px; align-items:center; flex-wrap:wrap;
  font-family:var(--tara-f-mono); font-size:11px; color:var(--tara-ink3);
  margin:18px 0; padding:10px 0; border-top:1px solid var(--tara-line2);
}
.tara-signal button{
  font:inherit; background:var(--tara-bg); color:var(--tara-ink2);
  border:1px solid var(--tara-line2); border-radius:2px; padding:6px 10px; cursor:pointer;
}
.tara-signal button[aria-pressed="true"]{background:var(--tara-accent-soft);border-color:var(--tara-accent);color:var(--tara-ink)}
.tara-signal button:focus-visible{outline:2px solid var(--tara-accent);outline-offset:2px}

@media (prefers-reduced-motion: reduce){ .tara-term,.tara-angle-btn{transition:none !important} }

@media print{
  .tara-angles,.tara-mark,.tara-signal{display:none !important}
  .tara-term{border-bottom:0 !important;background:none !important}
  .tara-term::after{content:none !important}
  [data-tara-host]{display:none !important}
}
`;

  /* -------------------------------------------------------- shadow styles */

  var UI_CSS = `
:host,*{box-sizing:border-box}
.root{
  position:fixed; inset:0; pointer-events:none; z-index:2147483000;
  font-family:var(--tara-f-ui,system-ui,sans-serif);
  color:var(--tara-ink,#101E1C);
  -webkit-font-smoothing:antialiased;
}
.root > *{pointer-events:auto}
button{font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer}
button:focus-visible,a:focus-visible,[tabindex]:focus-visible{
  outline:2px solid var(--tara-accent,#09655D); outline-offset:2px; border-radius:2px;
}
.mono{font-family:var(--tara-f-mono,monospace)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

/* ---------- the control ---------- */
.control{
  position:absolute; top:14px; right:14px; width:max-content; max-width:min(300px,calc(100vw - 28px));
  background:var(--tara-bg,#F7FBFA); border:1px solid var(--tara-line,#BFD0CD);
  border-radius:3px; box-shadow:var(--tara-shadow); overflow:hidden;
}
.tabs{display:flex; align-items:stretch}
.tab{
  display:flex; flex-direction:column; gap:2px; align-items:flex-start;
  padding:8px 11px 9px; min-width:82px; border-right:1px solid var(--tara-line2,#D8E5E2);
  color:var(--tara-ink3,#6D807D); background:transparent; text-align:left;
}
.tab:last-of-type{border-right:0}
.tab .n{font-family:var(--tara-f-mono,monospace);font-size:10px;letter-spacing:.14em}
.tab .lab{font-size:12.5px;font-weight:600;letter-spacing:-.005em;color:inherit}
.tab:hover{background:var(--tara-bg2,#EDF4F2); color:var(--tara-ink2,#465956)}
.tab[aria-selected="true"]{
  background:var(--tara-accent-soft,#D3E7E4); color:var(--tara-ink,#101E1C);
  box-shadow:inset 0 -2px 0 var(--tara-accent,#09655D);
}
.foot{
  display:flex; align-items:center; gap:2px; border-top:1px solid var(--tara-line2,#D8E5E2);
  background:var(--tara-bg2,#EDF4F2);
}
.foot button{
  flex:1 1 auto; padding:6px 9px; font-family:var(--tara-f-mono,monospace);
  font-size:10.5px; letter-spacing:.08em; color:var(--tara-ink3,#6D807D); text-transform:uppercase;
  border-right:1px solid var(--tara-line2,#D8E5E2); white-space:nowrap;
}
.foot button:last-child{border-right:0}
.foot button:hover{color:var(--tara-ink,#101E1C); background:var(--tara-bg,#F7FBFA)}
.foot button[aria-expanded="true"]{color:var(--tara-ink);background:var(--tara-bg)}
.foot a{
  flex:0 0 auto; padding:6px 10px; font-family:var(--tara-f-mono,monospace);
  font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; text-decoration:none;
  color:var(--tara-ink3,#6D807D); border-right:1px solid var(--tara-line2,#D8E5E2); white-space:nowrap;
}
.foot a:last-child{border-right:0}
.foot a:hover{color:var(--tara-ink,#101E1C); background:var(--tara-bg,#F7FBFA)}
.badge{
  display:inline-block; min-width:15px; padding:0 4px; margin-left:5px; border-radius:8px;
  background:var(--tara-accent,#09655D); color:var(--tara-bg,#fff);
  font-size:9.5px; line-height:14px; text-align:center; letter-spacing:0;
}
.badge[data-empty="1"]{display:none}

/* collapsed pill (narrow screens / user collapse) */
.pill{
  position:absolute; top:10px; right:10px; display:none;
  align-items:stretch; gap:0; padding:0; overflow:hidden;
  background:var(--tara-bg,#F7FBFA); border:1px solid var(--tara-line,#BFD0CD);
  border-radius:999px; box-shadow:var(--tara-shadow);
  font-family:var(--tara-f-mono,monospace); font-size:11px; letter-spacing:.06em;
  color:var(--tara-ink2,#465956);
}
.pill .dot{width:6px;height:6px;border-radius:50%;background:var(--tara-accent,#09655D)}
.pill .open{display:flex;align-items:center;gap:7px;padding:7px 11px;color:inherit}
.pill a{
  padding:7px 10px; border-left:1px solid var(--tara-line2,#D8E5E2); text-decoration:none;
  color:var(--tara-ink3,#6D807D); font:inherit; letter-spacing:.06em; text-transform:uppercase; font-size:10px;
}
.pill a:hover{color:var(--tara-ink,#101E1C)}
.root[data-collapsed="1"] .control{display:none}
.root[data-collapsed="1"] .pill{display:flex}
@media (max-width:760px){
  .root:not([data-collapsed="0"]) .control{display:none}
  .root:not([data-collapsed="0"]) .pill{display:flex}
  .control{top:10px; right:10px; left:10px; width:auto; max-width:none}
  .tab{flex:1 1 0; min-width:0}
  .panel{top:auto; bottom:10px; right:10px; left:10px; width:auto; max-height:66vh}
}

/* ---------- panel (review queue) ---------- */
.panel{
  /* sits under the control so the tier tabs stay reachable while it is open */
  position:absolute; top:96px; right:14px; width:min(390px, calc(100vw - 28px));
  max-height:min(72vh, 640px); display:flex; flex-direction:column;
  background:var(--tara-bg,#F7FBFA); border:1px solid var(--tara-line,#BFD0CD);
  border-radius:3px; box-shadow:var(--tara-shadow);
}
.panel[hidden]{display:none}
.panel-head{
  display:flex;align-items:baseline;gap:10px;padding:11px 13px 9px;
  border-bottom:1px solid var(--tara-line,#BFD0CD); background:var(--tara-bg2,#EDF4F2);
}
.panel-head h2{
  margin:0; font-size:12px; letter-spacing:.14em; text-transform:uppercase;
  font-family:var(--tara-f-mono,monospace); font-weight:600; color:var(--tara-ink,#101E1C);
}
.panel-head .count{font-family:var(--tara-f-mono,monospace);font-size:11px;color:var(--tara-ink3,#6D807D)}
.panel-head .x{margin-left:auto;font-size:16px;line-height:1;color:var(--tara-ink3,#6D807D);padding:0 2px}
.panel-head .x:hover{color:var(--tara-ink,#101E1C)}
.panel-body{overflow:auto; padding:4px 0 8px; -webkit-overflow-scrolling:touch}
.panel-foot{
  display:flex;gap:0;border-top:1px solid var(--tara-line,#BFD0CD);background:var(--tara-bg2,#EDF4F2);
}
.panel-foot button{
  flex:1; padding:8px 10px; font-family:var(--tara-f-mono,monospace); font-size:10.5px;
  letter-spacing:.08em; text-transform:uppercase; color:var(--tara-ink3,#6D807D);
  border-right:1px solid var(--tara-line2,#D8E5E2);
}
.panel-foot button:last-child{border-right:0}
.panel-foot button:hover{color:var(--tara-ink,#101E1C);background:var(--tara-bg,#F7FBFA)}
.sect{padding:10px 13px 4px;font-family:var(--tara-f-mono,monospace);font-size:10px;
  letter-spacing:.14em;text-transform:uppercase;color:var(--tara-ink3,#6D807D)}
.item{padding:9px 13px 10px;border-bottom:1px solid var(--tara-line2,#D8E5E2);display:flex;gap:9px}
.item:last-child{border-bottom:0}
.item .q{
  flex:1 1 auto; min-width:0; font-size:13px; line-height:1.5; color:var(--tara-ink,#101E1C);
  border-left:2px solid var(--tara-line,#BFD0CD); padding-left:9px;
}
.item .src{
  display:block;margin-top:5px;font-family:var(--tara-f-mono,monospace);font-size:10px;
  color:var(--tara-ink3,#6D807D);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.item .src a{color:inherit;text-decoration:none;border-bottom:1px dotted currentColor}
.item .rm{flex:0 0 auto;align-self:flex-start;color:var(--tara-ink3,#6D807D);font-size:14px;line-height:1;padding:2px 3px}
.item .rm:hover{color:var(--tara-warm,#B04E27)}
.empty{padding:16px 13px;font-size:13px;line-height:1.55;color:var(--tara-ink3,#6D807D)}
.sig-row{display:flex;gap:8px;align-items:center;padding:8px 13px 12px;flex-wrap:wrap}
.sig-row button{
  border:1px solid var(--tara-line2,#D8E5E2); border-radius:2px; padding:6px 10px;
  font-family:var(--tara-f-mono,monospace); font-size:10.5px; color:var(--tara-ink2,#465956);
  background:var(--tara-bg,#F7FBFA);
}
.sig-row button[aria-pressed="true"]{background:var(--tara-accent-soft);border-color:var(--tara-accent);color:var(--tara-ink)}
.sig-list{padding:0 13px 10px;font-size:12px;line-height:1.6;color:var(--tara-ink2,#465956)}
.sig-list div{display:flex;gap:8px;padding:3px 0;border-bottom:1px dotted var(--tara-line2,#D8E5E2)}
.sig-list div:last-child{border-bottom:0}
.sig-list .k{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sig-list .v{flex:0 0 auto;font-family:var(--tara-f-mono,monospace);font-size:10px;letter-spacing:.06em;text-transform:uppercase}
.sig-list .v[data-v="unclear"]{color:var(--tara-warm,#B04E27)}
.sig-list .v[data-v="clicked"]{color:var(--tara-accent,#09655D)}

/* ---------- popovers ---------- */
.pop{
  position:absolute; z-index:5; max-width:min(360px, calc(100vw - 20px));
  background:var(--tara-bg,#F7FBFA); border:1px solid var(--tara-line,#BFD0CD);
  border-radius:3px; box-shadow:var(--tara-shadow); overflow:hidden;
}
.pop[hidden]{display:none}
.pop-head{
  display:flex; align-items:baseline; gap:8px; padding:9px 12px 7px;
  border-bottom:1px solid var(--tara-line2,#D8E5E2); background:var(--tara-bg2,#EDF4F2);
}
.pop-term{font-family:var(--tara-f-mono,monospace);font-size:12.5px;font-weight:600;color:var(--tara-ink,#101E1C)}
.pop-exp{font-size:12px;color:var(--tara-ink2,#465956);line-height:1.35}
.pop-arena{margin-left:auto;font-family:var(--tara-f-mono,monospace);font-size:10px;color:var(--tara-ink3,#6D807D);white-space:nowrap}
.pop-body{padding:10px 12px 11px;font-size:13.5px;line-height:1.55;color:var(--tara-ink,#101E1C);max-height:46vh;overflow:auto}
.pop-body p{margin:0 0 8px}
.pop-body p:last-child{margin-bottom:0}
.pop-why{margin-top:7px;padding-top:7px;border-top:1px dotted var(--tara-line,#BFD0CD);
  font-size:12.5px;color:var(--tara-ink2,#465956)}
.pop-why b{font-family:var(--tara-f-mono,monospace);font-size:9.5px;letter-spacing:.14em;
  text-transform:uppercase;color:var(--tara-ink3,#6D807D);display:block;margin-bottom:2px;font-weight:600}
.pop-foot{display:flex;border-top:1px solid var(--tara-line2,#D8E5E2);background:var(--tara-bg2,#EDF4F2)}
.pop-foot button,.pop-foot a{
  flex:1 1 auto; padding:8px 10px; text-align:center; text-decoration:none;
  font-family:var(--tara-f-mono,monospace); font-size:10.5px; letter-spacing:.07em;
  text-transform:uppercase; color:var(--tara-ink3,#6D807D);
  border-right:1px solid var(--tara-line2,#D8E5E2); white-space:nowrap;
}
.pop-foot > *:last-child{border-right:0}
.pop-foot button:hover,.pop-foot a:hover{color:var(--tara-ink,#101E1C);background:var(--tara-bg,#F7FBFA)}
.pop-foot button[data-state="done"]{color:var(--tara-accent,#09655D)}

/* selection popover: compact bar, expands when an answer is shown */
.pop--sel{max-width:min(440px, calc(100vw - 20px))}
.pop--sel .bar{display:flex;background:var(--tara-bg,#F7FBFA)}
.pop--sel .bar button{
  padding:8px 12px; font-family:var(--tara-f-mono,monospace); font-size:10.5px;
  letter-spacing:.07em; text-transform:uppercase; color:var(--tara-ink2,#465956);
  border-right:1px solid var(--tara-line2,#D8E5E2);white-space:nowrap;
}
.pop--sel .bar > *:last-child{border-right:0}
.pop--sel .bar button:hover{background:var(--tara-accent-soft,#D3E7E4);color:var(--tara-ink,#101E1C)}
.pop--sel .bar a{
  padding:8px 12px;text-decoration:none;font-family:var(--tara-f-mono,monospace);font-size:10.5px;
  letter-spacing:.07em;text-transform:uppercase;color:var(--tara-ink2,#465956);
  border-right:1px solid var(--tara-line2,#D8E5E2);white-space:nowrap;
}
.pop--sel .bar a:hover{background:var(--tara-accent-soft,#D3E7E4);color:var(--tara-ink,#101E1C)}
.ans{border-top:1px solid var(--tara-line2,#D8E5E2);padding:11px 12px 12px;max-height:44vh;overflow:auto}
.ans[hidden]{display:none}
.ans .kicker{
  font-family:var(--tara-f-mono,monospace);font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--tara-ink3,#6D807D);margin:0 0 6px;
}
.ans .txt{font-size:14px;line-height:1.6;color:var(--tara-ink,#101E1C)}
.ans .txt p{margin:0 0 9px}
.ans .txt p:last-child{margin-bottom:0}
.ans .txt code{font-family:var(--tara-f-mono,monospace);font-size:.88em}
.ans .terms{margin-top:10px;padding-top:9px;border-top:1px dotted var(--tara-line,#BFD0CD)}
.ans .terms dl{margin:0;font-size:12.5px;line-height:1.5}
.ans .terms dt{font-family:var(--tara-f-mono,monospace);font-weight:600;color:var(--tara-ink,#101E1C);margin-top:6px}
.ans .terms dt:first-child{margin-top:0}
.ans .terms dd{margin:1px 0 0;color:var(--tara-ink2,#465956)}
.ans .none{font-size:13px;line-height:1.55;color:var(--tara-ink2,#465956)}

@media (prefers-reduced-motion: no-preference){
  .pop,.panel{animation:tara-in .12s ease-out}
  @keyframes tara-in{from{opacity:0}to{opacity:1}}
}
@media print{ .root{display:none !important} }
`;

  /* ------------------------------------------------------------ glossary */
  /* [ term, expansion, plain meaning, why it matters, ARENA section, map slug, aliases ] */

  var GLOSSARY_SEED = [

    /* ---- shapes, tensors, the vocabulary of a forward pass ---- */
    ["d_model", "model dimension / residual-stream width", "How many numbers each token carries as it moves through the model.", "Nearly every activation you print is (batch, seq, d_model). When a matmul fails, this is usually the axis you got wrong.", "[1.1]", "residual-stream"],
    ["n_heads", "number of attention heads per layer", "How many separate attention heads run side by side in one layer.", "Heads are the unit of mech interp: you name a head by (layer, head index), so n_heads sets your search space.", "[1.1]", "attention-head"],
    ["d_head", "dimension of one attention head", "The width of the small space a single head works in, usually d_model / n_heads.", "It sets the 1/sqrt(d_head) scaling. Shrink d_head and attention goes flat; grow it without scaling and it goes one-hot.", "[1.1]", "attention-head"],
    ["d_mlp", "MLP hidden dimension", "The width of the wide middle layer inside an MLP block, usually 4 x d_model.", "It is where most parameters and most features live, which is why SAEs are usually trained on MLP or residual activations.", "[1.1]", "mlp"],
    ["n_layers", "number of transformer blocks", "How many attention+MLP blocks are stacked.", "Depth is what lets heads compose: an induction head in layer 1 needs a previous-token head in layer 0.", "[1.1]", "transformer-block"],
    ["seq", "sequence position axis", "The position of a token in the input, counted from zero.", "Mech interp lives on this axis: attention patterns are (query position, key position) and off-by-one here is the most common bug.", "[1.1]", "attention-pattern"],
    ["batch", "batch axis", "How many independent sequences you push through at once.", "It changes nothing mathematically and everything about memory. Bugs hide when batch and seq are the same size, so never test with batch == seq.", "[0.2]", "batch"],
    ["minibatch", "one batch of a larger dataset", "A small slice of the training data used for one weight update.", "Gradient noise from small minibatches is a real training signal, not just an efficiency trick.", "[0.2]", "batch"],
    ["tensor", "multi-dimensional array", "A block of numbers with a named shape, like a spreadsheet with more than two directions.", "Thinking in shapes rather than in loops is the single biggest jump from software engineering into ML.", "[0.0]", "tensor"],
    ["einsum", "Einstein-summation notation", "A way to write a matrix multiply by naming the axes instead of remembering their order.", "It removes the transpose guessing game: you say which index is summed, and the shapes stop lying to you.", "[0.0]", "einsum"],
    ["einops", "Einstein-operations library", "A library for reshaping tensors by writing the shape you want as a string.", "rearrange/reduce/repeat make shape changes readable, and readable shape changes are debuggable shape changes.", "[0.0]", "einops"],
    ["rearrange", "einops.rearrange", "Move and merge axes by describing the before and after shapes.", "It replaces chains of permute/reshape that silently reorder your data.", "[0.0]", "einops"],
    ["broadcasting", "implicit shape expansion", "Rules that let a small tensor be stretched to match a bigger one in an operation.", "It is the source of the worst silent bugs in ML: the wrong shapes still run and quietly compute nonsense.", "[0.0]", "broadcasting"],
    ["dim=-1", "operate along the last axis", "Do the operation across the final axis of the tensor.", "For logits the last axis is vocabulary, so softmax(dim=-1) is the difference between a distribution over words and garbage.", "[1.1]", "softmax"],
    ["as_strided", "torch.as_strided", "Make a new view of the same memory by changing how far you step to reach the next element.", "It is how convolutions and sliding windows are built without copying, and it is where a Saturday goes if you rush it.", "[0.2]", "as-strided"],
    ["dataloader", "torch.utils.data.DataLoader", "The thing that hands your training loop one batch at a time.", "Shuffling, batching and device transfer live here, so a slow or non-shuffling dataloader looks like a broken model.", "[0.3]", "dataloader"],

    /* ---- transformer architecture ---- */
    ["residual stream", "the running sum passed between blocks", "A shared bus of numbers that every layer reads from and writes into.", "Everything in a transformer communicates by adding to this one vector, which is why activation patching on it is so informative.", "[1.1]", "residual-stream", ["residual-stream"]],
    ["resid_pre", "residual stream before a block", "The bus contents as a layer starts reading it.", "It is the standard place to patch or read: hooks named blocks.N.hook_resid_pre are your first probe point.", "[1.2]", "residual-stream"],
    ["resid_post", "residual stream after a block", "The bus contents after a layer has written into it.", "Comparing resid_pre and resid_post isolates exactly what one block contributed.", "[1.2]", "residual-stream"],
    ["attention head", "one independent attention unit", "A small unit that moves information from one token position to another.", "Circuits are made of heads. Naming a behaviour and finding the head that does it is most of mech interp.", "[1.1]", "attention-head"],
    ["attention pattern", "the matrix of attention probabilities", "A grid showing how much each token looked at each earlier token.", "It is the fastest read on what a head does, and the thing you screenshot when you claim to have found a circuit.", "[1.2]", "attention-pattern"],
    ["QK", "query-key circuit (W_Q W_K transpose)", "The half of a head that decides where to look.", "If you want to know what a head attends to, you read QK. It never touches the content being moved.", "[1.2]", "qk-circuit", ["QK circuit"]],
    ["OV", "output-value circuit (W_V W_O)", "The half of a head that decides what gets copied once it has chosen where to look.", "QK picks the source, OV picks the payload. Splitting a head this way makes it analysable instead of mystical.", "[1.2]", "ov-circuit", ["OV circuit"]],
    ["MLP", "multi-layer perceptron", "The two-layer feed-forward part of a transformer block, applied to each position on its own.", "It cannot move information between positions; it can only transform what is already at one position. That asymmetry is a real constraint on circuits.", "[1.1]", "mlp"],
    ["LN", "LayerNorm", "A step that rescales each token vector to a standard size before a layer reads it.", "It is non-linear and it makes attribution messy, which is why people fold or freeze it when doing careful interp.", "[1.1]", "layernorm", ["LayerNorm", "layer norm"]],
    ["layernorm", "layer normalisation", "Rescale each token vector to zero mean and unit variance, then apply a learned scale and shift.", "It stabilises training, but it also means the residual stream has no fixed scale, so absolute magnitudes mislead you.", "[1.1]", "layernorm"],
    ["batchnorm", "batch normalisation", "Normalise each feature across the batch instead of across the vector.", "Standard in CNNs, wrong for transformers: it makes one sequence depend on the others in its batch.", "[0.3]", "batchnorm"],
    ["positional embedding", "position information added to tokens", "Extra numbers added to each token so the model knows where it sits in the sequence.", "Attention has no built-in order; without this, a sentence and its shuffle look identical to the model.", "[1.1]", "positional-embedding"],
    ["token embedding", "W_E lookup", "The table that turns a token id into its starting vector.", "It is the only place raw identity enters the model; induction heads exploit exactly this identity information.", "[1.1]", "token-embedding", ["W_E"]],
    ["unembedding", "W_U projection to vocabulary", "The final matrix that turns the residual stream into one score per token in the vocabulary.", "Direct logit attribution works by pushing intermediate activations through this matrix early.", "[1.1]", "unembedding", ["W_U"]],
    ["logits", "unnormalised scores", "The raw scores the model gives every possible next token before they are turned into probabilities.", "Differences between logits are what matter; adding a constant to all of them changes nothing.", "[1.1]", "logits", ["logit"]],
    ["softmax", "exponential normalisation", "Turn a list of scores into positive numbers that add to one.", "It is where temperature acts, where attention probabilities come from, and where dim=-1 mistakes hide.", "[1.1]", "softmax"],
    ["causal mask", "autoregressive attention mask", "A rule that stops a token attending to anything after it.", "Mask before the softmax, not after: masking after breaks the row sums and quietly leaks the future.", "[1.1]", "causal-mask", ["attention mask"]],
    ["autoregressive", "predicts the next item from previous ones", "The model only ever predicts the next token, using the tokens before it.", "It is why generation is a loop, why training can be parallel but sampling cannot, and why the causal mask exists.", "[1.1]", "autoregressive"],
    ["tokeniser", "text-to-token converter", "The component that chops text into the pieces the model actually sees.", "Tokens are not words. Half of the surprising model behaviour you will meet is a tokenisation artefact.", "[1.1]", "tokeniser", ["tokenizer"]],
    ["BPE", "byte-pair encoding", "A tokenisation scheme that merges the most common character pairs into single tokens.", "It explains why leading spaces matter and why rare names split into strange fragments.", "[1.1]", "tokeniser"],
    ["context window", "maximum sequence length", "The most tokens the model can attend over at once.", "Attention cost grows with the square of this number, which is why it is a hard architectural limit rather than a setting.", "[1.1]", "context-window"],
    ["KV cache", "cached keys and values", "Saved key and value vectors from earlier tokens so generation does not recompute them.", "It is the difference between generation being linear and quadratic, and a common source of position bugs.", "[1.1]", "kv-cache"],
    ["transformer block", "attention + MLP with residual connections", "One repeated unit: attend, add, normalise, feed-forward, add.", "The whole model is this block stacked. Understanding one block is understanding the architecture.", "[1.1]", "transformer-block"],

    /* ---- training ---- */
    ["training", "fitting weights to data", "The phase where the model changes its own numbers to reduce a loss.", "Weights change, gradients exist, dropout is on. Almost every confusing behaviour is really a training/inference mix-up.", "[0.2]", "training-vs-inference"],
    ["inference", "running a trained model", "The phase where the weights are frozen and you just get outputs.", "No gradients, no dropout, no weight updates. Interp work is nearly all done at inference time.", "[0.2]", "training-vs-inference"],
    ["forward pass", "input to output computation", "Pushing data through the model to get an output.", "It is the only thing that happens at inference, and the thing you hook into for interp.", "[0.2]", "forward-pass"],
    ["backward pass", "gradient computation", "Walking the computation backwards to work out how each weight affected the loss.", "It costs roughly twice a forward pass and is why training memory is dominated by stored activations.", "[0.2]", "backprop"],
    ["backprop", "backpropagation", "The chain rule applied automatically through the whole network.", "You rarely write it, but you constantly debug it: detached tensors and in-place ops break it silently.", "[0.2]", "backprop", ["backpropagation"]],
    ["autograd", "automatic differentiation", "The machinery that records operations so gradients can be computed later.", "requires_grad, detach and no_grad are all levers on this recorder, not on the maths.", "[0.2]", "backprop"],
    ["gradient", "direction of steepest increase", "A list of numbers saying how much the loss would change if each weight nudged up.", "Training is repeatedly stepping against it. Exploding or vanishing gradients are shape and scale problems, not mysteries.", "[0.2]", "gradient"],
    ["Jacobian", "matrix of all partial derivatives", "A table of how every output changes with every input.", "You almost never build one; you multiply by it. That is exactly what a backward pass does.", "[0.2]", "gradient"],
    ["cross-entropy", "negative log-likelihood loss", "A loss that is small when the model gave high probability to the correct token.", "It is the language-model loss. Its units are nats per token, and exp of it is perplexity.", "[1.1]", "cross-entropy"],
    ["perplexity", "exp(cross-entropy)", "Roughly how many equally likely options the model was choosing between.", "It makes loss legible: perplexity 20 means the model was about as unsure as picking from 20 words.", "[1.1]", "cross-entropy"],
    ["teacher forcing", "training on ground-truth prefixes", "During training the model always sees the real previous tokens, not its own guesses.", "It is why training is fast and parallel, and why a model can look great in training and drift when it generates.", "[1.1]", "teacher-forcing"],
    ["SGD", "stochastic gradient descent", "Step the weights a little bit against the gradient, one batch at a time.", "Every fancier optimiser is this plus bookkeeping.", "[0.3]", "optimiser"],
    ["Adam", "adaptive moment estimation", "An optimiser that keeps running averages of the gradient and its square to set a per-weight step size.", "It is the default for transformers, and its state doubles or triples optimiser memory.", "[0.3]", "optimiser", ["AdamW"]],
    ["weight decay", "L2 pull towards zero", "A small constant pull that shrinks weights every step.", "In AdamW it is applied separately from the gradient, which is the whole point of the W.", "[0.3]", "regularisation"],
    ["learning rate", "step size", "How big a step the optimiser takes each update.", "It is the hyperparameter that matters most. Too high diverges, too low looks like a broken model.", "[0.3]", "learning-rate"],
    ["LR schedule", "learning-rate schedule", "A plan for changing the learning rate over training, usually warmup then decay.", "Transformers genuinely need warmup: the first steps with a cold Adam state can wreck a run.", "[0.3]", "learning-rate", ["learning rate schedule"]],
    ["epoch", "one full pass over the dataset", "Seeing every training example once.", "Large language models often train for less than one epoch, so epoch counting is a small-data habit.", "[0.3]", "epoch"],
    ["overfitting", "memorising instead of generalising", "The model gets better on the training data and worse on anything else.", "The tell is a widening gap between train and validation loss, not a bad absolute number.", "[0.3]", "overfitting"],
    ["regularisation", "constraints that improve generalisation", "Anything that stops the model from fitting the training data too exactly.", "Weight decay, dropout, and early stopping are all the same idea with different mechanics.", "[0.3]", "regularisation"],
    ["dropout", "random unit deactivation", "Randomly switch off some activations during training.", "It is on in training and off at inference; forgetting model.eval() makes evaluation noisy and irreproducible.", "[0.3]", "regularisation"],
    ["checkpoint", "saved model state", "A file with the weights (and often optimiser state) at a point in training.", "Interp results are only reproducible if you name the exact checkpoint you used.", "[0.3]", "checkpoint"],
    ["fine-tune", "further training of a pretrained model", "Take an existing model and train it a bit more on a narrower task.", "Most alignment-relevant behaviour, good and bad, is introduced here rather than in pretraining.", "[2.4]", "fine-tuning", ["fine-tuning", "finetune"]],
    ["LoRA", "low-rank adaptation", "Train two small matrices that add a low-rank correction instead of updating all the weights.", "It makes fine-tuning cheap enough to do on one GPU, and it keeps the original weights intact for comparison.", "[2.4]", "lora"],
    ["distillation", "training a student on a teacher's outputs", "Train a smaller model to copy a bigger model's probabilities.", "The soft probabilities carry more signal than hard labels, which is why the student can beat direct training.", "[3.1]", "distillation"],
    ["KL", "Kullback-Leibler divergence", "A number saying how far one probability distribution is from another.", "It is the leash in RLHF: it measures how far the tuned policy has drifted from the base model.", "[2.4]", "kl-divergence", ["KL divergence", "KL penalty"]],
    ["entropy", "average surprise of a distribution", "How spread out a set of probabilities is.", "High entropy means the policy is still exploring; collapsing entropy in RL is an early warning of a degenerate policy.", "[2.3]", "entropy"],

    /* ---- sampling ---- */
    ["temperature", "logit scaling before softmax", "A dial that makes the output distribution flatter or sharper.", "Temperature 0 is greedy and deterministic; high temperature is chaotic. It scales logits, it does not add randomness on its own.", "[1.1]", "temperature"],
    ["top-k", "keep the k highest-probability tokens", "Only ever sample from the k most likely next tokens.", "It caps the tail, but a fixed k is wrong whenever the model is either very sure or very unsure.", "[1.1]", "top-k"],
    ["top-p", "nucleus sampling", "Keep the smallest set of tokens whose probabilities add up to p, then sample from those.", "It adapts to how confident the model is, which is why it beats a fixed top-k in practice.", "[1.1]", "top-p", ["nucleus sampling"]],
    ["beam search", "keep the best n partial sequences", "Explore several candidate continuations at once and keep the best few.", "It maximises sequence probability, which for open-ended text produces bland repetitive output. Good for translation, bad for chat.", "[1.1]", "beam-search"],
    ["greedy decoding", "always take the top token", "Always pick the single most likely next token.", "Deterministic and often repetitive; it is the baseline every other sampling method is measured against.", "[1.1]", "greedy-decoding"],
    ["frequency penalty", "penalty on repeated tokens", "Reduce the score of tokens the model has already produced.", "It is a blunt patch for repetition loops rather than a fix for the underlying distribution.", "[1.1]", "sampling"],

    /* ---- mech interp ---- */
    ["induction head", "a head implementing [A][B] ... [A] -> [B]", "A head that spots a repeated token and predicts whatever followed it last time.", "It is the first real circuit you can find end to end, and it explains a visible bump in the training loss curve.", "[1.3]", "induction-head", ["induction heads"]],
    ["previous-token head", "a head attending to position i-1", "A head that always looks one token back.", "It is the layer-0 half of the induction circuit: it writes what came before into the current position so a later head can match on it.", "[1.3]", "previous-token-head", ["previous token head"]],
    ["duplicate-token head", "a head attending to earlier copies of the current token", "A head that looks back at previous occurrences of the same token.", "It shows up in the indirect-object identification circuit and is easy to confuse with an induction head.", "[1.3]", "duplicate-token-head"],
    ["skip trigram", "a bigram-with-a-gap pattern", "A pattern of the form A ... B -> C that skips over the middle.", "One-layer attention models can only do these, which is exactly why induction needs two layers.", "[1.2]", "skip-trigram"],
    ["K-composition", "one head writing into another head's keys", "An early head changes what a later head's key vectors say, so it changes where the later head looks.", "This is the mechanism of induction: the previous-token head composes with the induction head through K.", "[1.3]", "composition"],
    ["Q-composition", "one head writing into another head's queries", "An early head changes what a later head is asking for.", "One of the three ways heads can chain into a circuit rather than acting alone.", "[1.3]", "composition"],
    ["V-composition", "one head writing into another head's values", "An early head changes the content a later head will move.", "It is the composition type that changes payload rather than routing.", "[1.3]", "composition"],
    ["circuit", "a minimal subgraph that implements a behaviour", "The small set of heads and MLPs that actually do one specific thing.", "A circuit claim is falsifiable: knock the parts out and the behaviour should disappear.", "[1.3]", "circuit"],
    ["logit lens", "unembed intermediate activations", "Read the model's guess partway through by applying the final unembedding early.", "It shows when a prediction is formed, layer by layer. Cheap, and wrong often enough that you should check it against patching.", "[1.3]", "logit-lens"],
    ["direct logit attribution", "project activations onto the logit direction", "Measure how much each component pushed the final answer up or down.", "It is additive because the residual stream is a sum, so contributions genuinely decompose.", "[1.3]", "direct-logit-attribution", ["DLA"]],
    ["activation patching", "replace an activation from another run", "Swap one internal value from a clean run into a corrupted run and see if the answer comes back.", "It is causal, not correlational. This is the method that turns interp stories into evidence.", "[1.3]", "activation-patching", ["causal tracing"]],
    ["causal tracing", "activation patching over positions and layers", "Patch one activation at a time to map where the answer is stored.", "The heatmap it produces is the standard picture of where a fact lives in the model.", "[1.3]", "activation-patching"],
    ["path patching", "patch a specific edge, not a node", "Patch the information flowing along one path between two components.", "It separates a head that matters directly from one that only matters through a downstream head.", "[1.3]", "path-patching"],
    ["attribution patching", "gradient approximation of patching", "Estimate patching results with gradients instead of running every patch.", "It makes whole-model sweeps affordable, at the cost of being a first-order approximation.", "[1.3]", "attribution-patching"],
    ["ablation", "delete a component and measure the damage", "Turn a head or neuron off and see what breaks.", "Zero ablation is off-distribution; mean ablation is usually the more honest control.", "[1.3]", "ablation"],
    ["mean ablation", "replace with the dataset mean", "Swap a component's output for its average value across a dataset.", "It removes the component's information without dropping the model into a state it has never seen.", "[1.3]", "ablation"],
    ["zero ablation", "replace with zeros", "Set a component's output to zero.", "Simple, but zeros are not a neutral value in a network trained with LayerNorm and biases.", "[1.3]", "ablation"],
    ["superposition", "more features than dimensions", "The model packs more concepts into a space than it has directions, so features overlap.", "It is why single neurons look like a mess of unrelated concepts, and why we need SAEs at all.", "[1.4]", "superposition"],
    ["polysemanticity", "one neuron, several meanings", "A single neuron fires for several unrelated things.", "It is the observable symptom of superposition, and the reason neuron-level interp stalls.", "[1.4]", "superposition"],
    ["monosemantic", "one meaning per unit", "A unit that fires for exactly one interpretable thing.", "It is the property SAE latents are supposed to have, and the thing you must actually check rather than assume.", "[1.4]", "sparse-autoencoder"],
    ["feature", "a direction in activation space that means something", "A direction in the model's internal space that stands for one concept.", "Features, not neurons, are the units interp is trying to recover. Directions can be interpretable even when neurons are not.", "[1.4]", "feature"],
    ["SAE", "sparse autoencoder", "A small network trained to rewrite activations as a sparse mix of many learned directions.", "It is the current best tool for pulling monosemantic features out of superposition.", "[1.4]", "sparse-autoencoder", ["sparse autoencoder"]],
    ["dictionary learning", "learn an overcomplete sparse basis", "Learn a large set of directions such that any activation is a sum of just a few of them.", "It is the mathematical framing an SAE implements; the sparsity is what buys interpretability.", "[1.4]", "sparse-autoencoder"],
    ["latent", "one learned SAE direction", "A single feature the sparse autoencoder learned.", "Latents, not neurons, are what you read and steer with in modern interp work.", "[1.4]", "sparse-autoencoder"],
    ["dead latent", "a latent that never fires", "An SAE feature that stops activating on any input.", "A large dead fraction means wasted capacity and usually a bad sparsity coefficient or learning rate.", "[1.4]", "sparse-autoencoder"],
    ["L1 penalty", "sparsity penalty", "A cost on the total size of the latent activations, which pushes most of them to zero.", "It is the knob that trades reconstruction quality against sparsity, and the main thing you tune in an SAE.", "[1.4]", "sparse-autoencoder", ["sparsity penalty"]],
    ["reconstruction loss", "how well the autoencoder rebuilds its input", "How close the SAE's output is to the activation it was given.", "Reported with sparsity as a pair: either number alone can be made to look good.", "[1.4]", "sparse-autoencoder"],
    ["probe", "a small classifier on internal activations", "Train a tiny model on the internals to see whether some information is present.", "A probe shows information is there, not that the model uses it. That gap is where careless claims are made.", "[1.4]", "linear-probe"],
    ["linear probe", "a single linear layer probe", "Check whether a concept can be read off the activations with just a weighted sum.", "If a linear probe works, the concept is stored as a direction, which is what makes steering possible.", "[1.4]", "linear-probe"],
    ["steering vector", "a direction added to activations to shift behaviour", "A direction you add into the residual stream to push the model's behaviour a certain way.", "It converts an interp finding into a control lever, and it is the honest test that a direction really means what you claimed.", "[4.4]", "steering-vector"],
    ["activation addition", "adding a steering vector at inference", "Add a fixed vector to the activations while the model runs.", "No fine-tuning, no gradients, effect visible immediately. The cheapest intervention in the whole field.", "[4.4]", "steering-vector", ["ActAdd"]],
    ["persona vector", "a direction associated with a character or trait", "A direction in activation space that tracks a persona the model is playing.", "It links interp to alignment: personas that can be measured can be monitored and steered.", "[4.4]", "persona-vector"],
    ["TransformerLens", "the interp library used by ARENA", "A library that runs transformers with every internal activation exposed and hookable.", "It is the main tool for chapter 1: HookedTransformer, run_with_cache and run_with_hooks are your daily verbs.", "[1.2]", "transformerlens"],
    ["HookPoint", "a named tap inside the model", "A named place in the model where you can read or overwrite an activation.", "Hook names like blocks.0.attn.hook_pattern are the addressing scheme for every interp experiment you will run.", "[1.2]", "hookpoint", ["hook point"]],
    ["run_with_cache", "forward pass that stores activations", "Run the model and keep every internal activation.", "It is how you get the ActivationCache that patching, DLA and pattern plots all read from.", "[1.2]", "activation-cache"],
    ["ActivationCache", "the stored activations from a run", "A dictionary of everything the model computed internally, keyed by hook name.", "Clean and corrupted caches are the two halves of every patching experiment.", "[1.2]", "activation-cache", ["cache"]],
    ["hook", "a function attached to a HookPoint", "A function that runs at a named point and can read or replace the value passing through.", "Returning a modified tensor is what makes ablation and steering possible without touching weights.", "[1.2]", "hookpoint"],
    ["neuron", "one unit in an MLP hidden layer", "A single number in the wide middle of an MLP block.", "Neurons are the tempting unit of analysis and usually the wrong one, because of superposition.", "[1.4]", "mlp"],
    ["IOI", "indirect object identification", "The task of predicting the right name in sentences like: John gave a drink to Mary, so John gave it to ___.", "It is the canonical worked circuit: a specific set of heads, mapped end to end, with ablations to prove it.", "[1.3]", "ioi"],

    /* ---- RL ---- */
    ["policy", "the thing that chooses actions", "The rule, usually a network, that maps a situation to what to do next.", "In RLHF the language model is the policy, and its tokens are its actions.", "[2.1]", "policy"],
    ["value function", "expected future return from a state", "An estimate of how good a situation is, in terms of reward still to come.", "It is the baseline that makes policy-gradient updates low-variance enough to work.", "[2.2]", "value-function"],
    ["value head", "a value output on the policy network", "An extra output that predicts how much reward is coming.", "In PPO it shares a trunk with the policy, which is why value-loss weighting matters.", "[2.3]", "value-function"],
    ["Q-value", "value of an action in a state", "How good it is to take one particular action from here.", "DQN learns Q directly and reads the policy off it by taking the argmax.", "[2.1]", "q-learning"],
    ["advantage", "how much better than average an action was", "How much better an action turned out to be than what you expected from that state.", "It centres the learning signal: without it, every action in a good state gets reinforced, including the bad ones.", "[2.3]", "advantage"],
    ["GAE", "generalised advantage estimation", "A way to blend short and long horizon estimates of the advantage with one parameter.", "Lambda trades bias against variance: 0 is fast and biased, 1 is unbiased and noisy.", "[2.3]", "gae"],
    ["return", "total discounted future reward", "The sum of rewards from here on, with later ones worth less.", "It is what the value function is trying to predict, so its scale silently sets your value-loss scale.", "[2.1]", "return"],
    ["discount factor", "gamma", "How much less a reward is worth if it arrives later.", "It sets the effective horizon: gamma 0.99 means about a hundred steps of foresight.", "[2.1]", "discount-factor", ["gamma"]],
    ["PPO", "proximal policy optimisation", "A policy-gradient method that refuses to change the policy too much in one update.", "It clips the probability ratio rather than using an explicit KL constraint. That distinction is the classic exam question.", "[2.3]", "ppo"],
    ["clip ratio", "PPO clipping range", "A limit on how far the new policy's probability may move from the old one, per action.", "It is what makes PPO stable and what makes its gradient go to zero outside the trust region.", "[2.3]", "ppo", ["clip_coef"]],
    ["TRPO", "trust region policy optimisation", "PPO's stricter ancestor, which constrains the update with an explicit KL bound.", "Worth holding because it is the one with the KL constraint, unlike PPO which clips.", "[2.3]", "trpo"],
    ["VPG", "vanilla policy gradient", "The simplest policy-gradient method: push up the probability of actions that did well.", "Everything else in policy-gradient RL is this plus variance reduction.", "[2.2]", "policy-gradient", ["REINFORCE"]],
    ["policy gradient", "gradient ascent on expected reward", "Adjust the policy directly, using reward as the signal.", "It works with non-differentiable rewards, which is precisely why RLHF uses it.", "[2.2]", "policy-gradient"],
    ["actor-critic", "policy plus value estimator", "One network chooses actions, another judges how good the situation was.", "The critic is what makes the actor's updates stable enough to learn from.", "[2.3]", "actor-critic"],
    ["rollout", "a run of the policy to collect data", "Let the policy act for a while and record what happened.", "In RLHF a rollout is a generated completion; rollout length sets both batch shape and memory.", "[2.3]", "rollout"],
    ["trajectory", "a sequence of states, actions and rewards", "One episode's worth of what happened, step by step.", "It is the unit of RL data the way a batch of text is the unit of LM data.", "[2.1]", "trajectory"],
    ["on-policy", "learn only from your current policy's data", "Only use data the current policy generated.", "It is why PPO throws away its data after a few epochs, and why it is sample-hungry.", "[2.3]", "on-policy"],
    ["off-policy", "learn from other policies' data", "Learn from data generated by an older or different policy.", "It is what lets DQN reuse a replay buffer, and what makes it harder to keep stable.", "[2.1]", "off-policy"],
    ["replay buffer", "stored past experience", "A pool of past transitions to train from repeatedly.", "It breaks the correlation between consecutive samples, which is what made deep Q-learning work at all.", "[2.1]", "replay-buffer"],
    ["DQN", "deep Q-network", "A network that learns the value of each action, trained on replayed experience.", "It is the off-policy, value-based half of the RL syllabus, opposite PPO.", "[2.1]", "dqn"],
    ["target network", "a frozen copy of the Q-network", "A slowly updated copy used to compute the learning target.", "Without it the target moves as fast as the learner and training oscillates.", "[2.1]", "dqn"],
    ["epsilon-greedy", "explore with probability epsilon", "Mostly take the best known action, but sometimes act at random.", "It is the simplest exploration rule, and its decay schedule is a real hyperparameter.", "[2.1]", "exploration"],
    ["entropy bonus", "reward for staying uncertain", "A small reward for keeping the action distribution spread out.", "It delays premature collapse onto one strategy. Too much and the policy never commits.", "[2.3]", "entropy"],
    ["bandit", "one-state reinforcement learning", "Repeatedly choose among options with unknown payoffs and no state to track.", "It is the cleanest setting for exploration ideas, and in ARENA it is bonus material that nothing later depends on.", "[2.1]", "bandit"],
    ["UCB", "upper confidence bound", "Pick the option with the best optimistic estimate, not the best average.", "It makes exploration principled rather than random, and it belongs to the bonus bandit section.", "[2.1]", "bandit"],
    ["MCTS", "Monte Carlo tree search", "Plan by simulating many possible futures and expanding the promising branches.", "It is how AlphaZero turns a mediocre value network into strong play, and it is the search half of search-plus-learning.", "[2.5]", "mcts"],
    ["reward model", "a learned stand-in for human preference", "A model trained on human comparisons that scores how good an output is.", "It is the target RLHF optimises, so every flaw in it becomes a flaw the policy is paid to exploit.", "[2.4]", "reward-model"],
    ["RLHF", "reinforcement learning from human feedback", "Fine-tune a model with RL against a reward model built from human preferences.", "It is where alignment meets optimisation pressure, and where over-optimisation shows up first.", "[2.4]", "rlhf"],
    ["DPO", "direct preference optimisation", "Train directly on preference pairs, skipping the separate reward model and RL loop.", "Simpler and more stable than PPO-based RLHF, with a different failure profile rather than none.", "[2.4]", "dpo"],
    ["over-optimisation", "Goodharting the reward model", "The policy keeps scoring higher while actually getting worse.", "It is the reason for the KL penalty: reward-model score and true quality come apart past a point.", "[2.4]", "over-optimisation", ["overoptimisation", "over-optimization"]],
    ["Goodhart", "when a measure becomes a target", "Once you optimise a proxy hard enough, it stops measuring the thing you cared about.", "It is the compact statement of why every eval and reward model has a shelf life.", "[2.4]", "goodhart"],

    /* ---- evals, control, alignment science ---- */
    ["evals", "evaluations", "Structured tests that measure what a model can do or will do.", "The distinction that matters is capability versus propensity: can it, versus will it.", "[3.1]", "evals", ["eval"]],
    ["capability eval", "test of what a model can do", "A test of the model's maximum ability when it is trying.", "It sets an upper bound on danger, and it is only valid if elicitation was strong enough.", "[3.1]", "evals"],
    ["propensity eval", "test of what a model tends to do", "A test of what the model actually does when not pushed.", "A model that can do something harmful but rarely does still needs a capability answer, not a propensity one.", "[3.1]", "evals"],
    ["elicitation", "getting the model to show its best", "Working hard to make the model actually demonstrate what it can do.", "A weak elicitation makes a dangerous model look safe, which is the most expensive kind of eval mistake.", "[3.2]", "elicitation"],
    ["red-teaming", "adversarial testing", "Deliberately trying to make the model behave badly.", "It finds failures that average-case evals never touch, and it produces the cases worth turning into permanent tests.", "[3.2]", "red-teaming", ["red teaming"]],
    ["jailbreak", "a prompt that defeats safety training", "An input that gets the model to do what it was trained to refuse.", "Each one is evidence that safety training is shallow and prompt-shaped rather than deep.", "[3.2]", "jailbreak"],
    ["sandbagging", "deliberately underperforming", "The model hides how capable it really is.", "It attacks the foundation of evals: if a model can sandbag, a low score means nothing on its own.", "[3.5]", "sandbagging"],
    ["AI control", "safety without assuming alignment", "Design the deployment so that even a scheming model cannot cause harm.", "It shifts the question from is it aligned to what happens if it is not, which is testable today.", "[3.5]", "ai-control"],
    ["trusted monitoring", "a weaker trusted model watching a stronger one", "Use a model you trust to check the outputs of a model you do not.", "It is the workhorse control protocol, and its cost is measured in how much usefulness you lose.", "[3.5]", "ai-control"],
    ["scheming", "deceptive pursuit of hidden goals", "The model behaves well while it is watched and pursues something else when it is not.", "It is the threat model behind AI control, and it makes behavioural evidence alone insufficient.", "[3.5]", "scheming", ["deceptive alignment"]],
    ["emergent misalignment", "narrow bad training generalising broadly", "Fine-tuning on one narrow bad behaviour makes the model broadly worse.", "It shows that fine-tuning moves something general, not just the task you trained on, which is why chapter 4 exists.", "[4.1]", "emergent-misalignment"],
    ["chain of thought", "step-by-step reasoning in the output", "The model writes out intermediate steps before answering.", "It improves accuracy and it is not guaranteed to be a faithful account of the real computation.", "[4.3]", "chain-of-thought", ["CoT"]],
    ["faithfulness", "whether stated reasoning matches real reasoning", "Whether the model's explanation is what actually drove its answer.", "Unfaithful reasoning is the reason interp exists: you cannot take the transcript as the mechanism.", "[4.3]", "faithfulness"],
    ["investigator agent", "an agent that audits another model", "An automated agent that probes a model for hidden behaviour.", "Petri in chapter 4 is this: auditing scaled up so it is not bottlenecked on human red-teamers.", "[4.5]", "investigator-agent", ["Petri"]],
    ["threat model", "the specific way harm could happen", "A concrete story of who does what and how it goes wrong.", "Without one, an eval measures something arbitrary and a safety case cannot be argued.", "[3.1]", "threat-model"],
    ["Inspect", "the UK AISI eval framework", "The framework ARENA uses to build and run evals.", "It gives you solvers, scorers and logs so an eval is reproducible rather than a one-off script.", "[3.3]", "inspect"],
    ["agentic eval", "evaluating a model with tools", "Testing a model that can take actions, not just answer questions.", "Tool use changes the threat model completely: capability now includes what the environment allows.", "[3.4]", "agentic-eval"],
    ["ARENA", "Alignment Research Engineer Accelerator", "The curriculum this course follows.", "Its section numbers, like [1.3] or [2.4], are how everything here is indexed.", "", "arena"],

    /* ---- general ML vocabulary a five-year IT generalist may not have ---- */
    ["logit lens direction", "unembedding row for a token", "The direction in the residual stream that pushes one specific token's score up.", "Dotting an activation with it is the whole of direct logit attribution.", "[1.3]", "direct-logit-attribution"],
    ["zero-shot", "no examples given", "Ask the model to do a task with no worked examples.", "It is the honest baseline; few-shot numbers are often measuring prompt engineering.", "[3.1]", "zero-shot"],
    ["few-shot", "a handful of examples in the prompt", "Show the model a few worked examples before the real question.", "Induction heads are part of why this works at all, which links chapter 1 to chapter 3.", "[1.3]", "few-shot"],
    ["system prompt", "the instruction block before the conversation", "Standing instructions given to the model before the user speaks.", "It is the cheapest behavioural lever and the first thing to control for in any eval.", "[3.1]", "system-prompt"],
    ["logit bias", "manual adjustment of token scores", "Directly add or subtract from specific tokens' scores before sampling.", "It is a blunt but exact way to forbid or force tokens without touching the model.", "[1.1]", "sampling"],
    ["convolution", "sliding weighted window", "Slide a small grid of weights over an image and record the response at each place.", "It is the chapter 0 workhorse and the clearest example of weight sharing.", "[0.2]", "convolution"],
    ["kernel", "the small weight grid in a convolution", "The little patch of numbers being slid over the input.", "Kernel size, stride and padding fully determine the output shape, and that arithmetic is examinable.", "[0.2]", "convolution"],
    ["stride", "step size of a sliding window", "How far the window jumps each time.", "Stride 2 halves the output size; getting it wrong is the classic shape-mismatch error.", "[0.2]", "convolution"],
    ["ResNet", "residual network", "A CNN with skip connections that add the input back to the output of a block.", "It is the same trick as the transformer residual stream: an easy path for gradients to flow.", "[0.3]", "resnet"],
    ["GPU", "graphics processing unit", "A chip that does many small numeric operations at once.", "It is why batching matters and why device mismatch is a daily error message.", "[0.0]", "gpu"],
    ["VRAM", "GPU memory", "The memory on the graphics card.", "It is nearly always the binding constraint: batch size, sequence length and optimiser state all compete for it.", "[0.0]", "gpu"],
    ["float32", "32-bit floating point", "The default number format for training.", "Half precision halves the memory and changes the numerics, which is why interp results can move between dtypes.", "[0.0]", "precision"],
    ["seed", "the number that fixes randomness", "A value that makes random choices repeatable.", "An unseeded experiment is not reproducible, and in interp that is the difference between a result and an anecdote.", "[0.0]", "seed"]
  ];

  var TERMS = [];   /* normalised entry objects */

  function addEntries(list) {
    if (!list || !list.length) return;
    for (var i = 0; i < list.length; i++) {
      var r = list[i], e;
      if (!r) continue;
      if (Object.prototype.toString.call(r) === '[object Array]') {
        e = { term: r[0], expansion: r[1], plain: r[2], why: r[3], arena: r[4] || '', slug: r[5] || slugify(r[0]), aliases: r[6] || [] };
      } else if (typeof r === 'object' && r.term) {
        e = { term: r.term, expansion: r.expansion || '', plain: r.plain || '', why: r.why || '', arena: r.arena || '', slug: r.slug || slugify(r.term), aliases: r.aliases || [] };
      } else continue;
      if (!e.term) continue;
      e.key = String(e.term).toLowerCase();
      TERMS.push(e);
    }
    S.termIndex = null; /* force rebuild */
  }

  /* Build the two alternation regexes plus the lookup index.
     Terms containing an uppercase letter match case-sensitively (QK, LN, MLP,
     Adam) so ordinary prose words are not mistaken for acronyms. All-lowercase
     terms match case-insensitively so "Superposition" at the start of a
     sentence still resolves. */
  function buildIndex() {
    var idx = Object.create(null), cs = [], ci = [];
    for (var i = 0; i < TERMS.length; i++) {
      var e = TERMS[i];
      var forms = [e.term].concat(e.aliases || []);
      for (var j = 0; j < forms.length; j++) {
        var f = String(forms[j]); if (!f) continue;
        var lower = f.toLowerCase();
        if (!(lower in idx)) idx[lower] = e;
        (/[A-Z]/.test(f) ? cs : ci).push(f);
      }
    }
    function alt(list) {
      if (!list.length) return null;
      list.sort(function (a, b) { return b.length - a.length; });
      var seen = Object.create(null), parts = [];
      for (var k = 0; k < list.length; k++) {
        var s = list[k]; if (seen[s]) continue; seen[s] = 1;
        parts.push(rxEsc(s).replace(/\\?[ ]/g, '[ \\u00a0]'));
      }
      return '(?<![\\w-])(?:' + parts.join('|') + ')(?![\\w-])';
    }
    var aCS = alt(cs), aCI = alt(ci);
    /* Lookbehind is supported everywhere the artifacts run; degrade if not. */
    function mk(src, flags) {
      if (!src) return null;
      try { return new RegExp(src, flags); }
      catch (e2) {
        try { return new RegExp(src.replace('(?<![\\w-])', '\\b'), flags); } catch (e3) { return null; }
      }
    }
    S.termRxCS = mk(aCS, 'g');
    S.termRxCI = mk(aCI, 'gi');
    S.termIndex = idx;
  }
  function lookupTerm(text) {
    if (!S.termIndex) buildIndex();
    return S.termIndex[String(text || '').toLowerCase()] || null;
  }

  /* --------------------------------------------------------- tier engine  */

  var TIER_LABEL = { 1: 'Plain', 2: 'Practitioner', 3: 'Expert' };
  var TIER_HINT = {
    1: 'Short sentences. No jargon left standing.',
    2: 'Assumes you can code. Explains the maths and the shapes.',
    3: 'Full vocabulary, with definitions one hover away.'
  };

  function readStoredTier() {
    var raw = lsGet(K_TIER, null);
    if (raw == null) raw = lsGet(K_TIER_ALIAS, null);
    var n = parseInt(raw, 10);
    return (n === 1 || n === 2 || n === 3) ? n : null;
  }

  /* Collect every tier group on the page, inline and external. */
  function collectGroups(root) {
    var scope = root || document;
    var out = [];
    var nodes = scope.querySelectorAll('[data-tier-group]');
    for (var i = 0; i < nodes.length; i++) {
      var g = nodes[i];
      if (g.__taraGroup) { out.push(g.__taraGroup); continue; }
      var rec = { el: g, variants: {}, external: false, hasVariants: false };
      var kids = g.children;
      for (var j = 0; j < kids.length; j++) {
        var c = kids[j];
        var t = c.getAttribute && c.getAttribute('data-tier');
        if (t === '1' || t === '2' || t === '3') { rec.variants[t] = c; rec.hasVariants = true; }
      }
      g.classList.add('tara-tier-group');
      g.__taraGroup = rec;
      out.push(rec);
    }
    /* External content: TARA_CONTENT maps element id -> {1,2,3} */
    var ext = window.TARA_CONTENT;
    if (ext && typeof ext === 'object') {
      for (var id in ext) {
        if (!Object.prototype.hasOwnProperty.call(ext, id)) continue;
        var host = document.getElementById(id);
        if (!host) continue;
        if (host.__taraGroup && host.__taraGroup.external) { continue; }
        var map = ext[id] || {};
        var rec2 = host.__taraGroup;
        if (!rec2) {
          rec2 = { el: host, variants: {}, external: true, hasVariants: false };
          host.classList.add('tara-tier-group');
          host.setAttribute('data-tier-group', '');
          host.__taraGroup = rec2;
          out.push(rec2);
        }
        rec2.external = true;
        rec2.baseHTML = host.innerHTML;
        rec2.extHTML = {};
        for (var t2 = 1; t2 <= 3; t2++) {
          var html = map[t2] || map[String(t2)];
          if (typeof html === 'string' && html.length) { rec2.extHTML[t2] = html; rec2.hasVariants = true; }
        }
      }
    }
    return out;
  }

  /* Which variant do we show for tier n? Exact, else nearest, else default. */
  function pickVariant(rec, n) {
    if (rec.external) {
      if (rec.extHTML[n]) return { kind: 'exact', tier: n };
      var order = n === 1 ? [2, 3] : n === 2 ? [1, 3] : [2, 1];
      for (var i = 0; i < order.length; i++) if (rec.extHTML[order[i]]) return { kind: 'near', tier: order[i] };
      return { kind: 'base', tier: null };
    }
    if (rec.variants[n]) return { kind: 'exact', tier: n };
    var ord = n === 1 ? [2, 3] : n === 2 ? [1, 3] : [2, 1];
    for (var j = 0; j < ord.length; j++) if (rec.variants[ord[j]]) return { kind: 'near', tier: ord[j] };
    return { kind: 'base', tier: null };
  }

  function applyGroup(rec, n) {
    var pick = pickVariant(rec, n);
    if (rec.external) {
      var html = pick.tier ? rec.extHTML[pick.tier] : rec.baseHTML;
      if (rec.__shownTier !== (pick.tier || 'base')) {
        rec.el.innerHTML = html;
        rec.__shownTier = pick.tier || 'base';
        rec.__needsRescan = true;
      }
    } else {
      for (var t = 1; t <= 3; t++) {
        var v = rec.variants[t];
        if (!v) continue;
        var show = (pick.tier === t);
        v.classList.toggle('tara-hidden', !show);
        if (show) v.removeAttribute('aria-hidden'); else v.setAttribute('aria-hidden', 'true');
      }
    }
    markGroup(rec, pick, n);
    setupAngles(rec, n);
  }

  /* The unobtrusive marker. Never a blank section, always an honest label. */
  function markGroup(rec, pick, n) {
    var need = (pick.kind !== 'exact');
    var existing = rec.__mark;
    if (!need) {
      if (existing) { existing.remove(); rec.__mark = null; rec.el.removeAttribute('data-tara-marked'); }
      return;
    }
    var title = (pick.kind === 'base')
      ? 'Written at one level only'
      : 'No tier ' + n + ' version of this section — showing tier ' + pick.tier;
    if (!existing) {
      existing = el('button', {
        'class': 'tara-mark', type: 'button', 'aria-label': title, title: title, 'data-tara-mark': ''
      });
      rec.el.insertBefore(existing, rec.el.firstChild);
      rec.__mark = existing;
      rec.el.setAttribute('data-tara-marked', '');
    } else {
      existing.setAttribute('title', title);
      existing.setAttribute('aria-label', title);
      if (existing.parentNode !== rec.el) rec.el.insertBefore(existing, rec.el.firstChild);
    }
  }

  /* --------------------------------------------------- "another angle"    */

  var ANGLE_LABEL = { analogy: 'Analogy', mechanism: 'Mechanism', maths: 'Maths', applied: 'Applied' };

  function angleHost(rec, n) {
    if (rec.external) return rec.el;
    var pick = pickVariant(rec, n);
    return (pick.tier && rec.variants[pick.tier]) ? rec.variants[pick.tier] : rec.el;
  }

  function setupAngles(rec, n) {
    var host = angleHost(rec, n);
    if (!host) return;
    var angles = [];
    var kids = host.children;
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i], a = c.getAttribute && c.getAttribute('data-angle');
      if (a && ANGLE_LABEL[a]) angles.push({ name: a, el: c });
    }
    /* tear down a control that belongs to a variant we are no longer showing */
    if (rec.__angleBar && rec.__angleBar.parentNode && rec.__angleBar.parentNode !== host) {
      rec.__angleBar.remove(); rec.__angleBar = null;
    }
    if (!angles.length) {
      if (rec.__angleBar) { rec.__angleBar.remove(); rec.__angleBar = null; }
      return;
    }
    var bar = rec.__angleBar;
    if (!bar) {
      bar = el('div', { 'class': 'tara-angles', role: 'group', 'aria-label': 'Another angle on this section' });
      rec.__angleBar = bar;
    }
    bar.className = 'tara-angles' + (n === 3 ? ' tara-angles--quiet' : '');
    bar.innerHTML = '';
    bar.appendChild(el('span', { 'class': 'tara-angles-label', text: 'Another angle' }));

    var base = [];
    for (var j = 0; j < kids.length; j++) {
      var k = kids[j];
      if (k === bar) continue;
      if (k.classList && k.classList.contains('tara-mark')) continue;
      if (k.getAttribute && k.getAttribute('data-angle')) continue;
      base.push(k);
    }
    var choices = [{ name: '', label: 'Straight' }].concat(angles.map(function (a) {
      return { name: a.name, label: ANGLE_LABEL[a.name] };
    }));
    var current = host.__taraAngle || '';

    function paint() {
      for (var b = 0; b < base.length; b++) base[b].classList.toggle('tara-hidden', current !== '');
      for (var m = 0; m < angles.length; m++) angles[m].el.classList.toggle('tara-hidden', angles[m].name !== current);
      var btns = bar.querySelectorAll('.tara-angle-btn');
      for (var q = 0; q < btns.length; q++) {
        btns[q].setAttribute('aria-pressed', btns[q].getAttribute('data-angle-name') === current ? 'true' : 'false');
      }
      host.__taraAngle = current;
    }
    choices.forEach(function (ch) {
      var b = el('button', { 'class': 'tara-angle-btn', type: 'button', 'data-angle-name': ch.name, text: ch.label, 'aria-pressed': 'false' });
      b.addEventListener('click', guard(function () {
        current = (current === ch.name) ? '' : ch.name;
        paint();
        if (S.scanned) scanGlossary(host);
      }, 'angle'));
      bar.appendChild(b);
    });
    if (bar.parentNode !== host) host.insertBefore(bar, host.firstChild);
    paint();
  }

  /* ------------------------------------------------------------- setTier  */

  function setTier(n, opts) {
    n = parseInt(n, 10);
    if (n !== 1 && n !== 2 && n !== 3) return;
    S.tier = n;
    if (!opts || opts.persist !== false) { lsSet(K_TIER, String(n)); lsSet(K_TIER_ALIAS, String(n)); }
    try { document.documentElement.setAttribute('data-tara-tier', String(n)); } catch (e) { warn(e); }

    S.groups = collectGroups();
    for (var i = 0; i < S.groups.length; i++) applyGroup(S.groups[i], n);

    /* new HTML from external variants needs its glossary wraps rebuilt */
    for (var j = 0; j < S.groups.length; j++) {
      if (S.groups[j].__needsRescan) { S.groups[j].__needsRescan = false; if (S.opts.glossary !== false) scanGlossary(S.groups[j].el); }
    }
    paintTabs();
    announce('Reading level ' + n + ': ' + TIER_LABEL[n]);
    try {
      window.dispatchEvent(new CustomEvent('tara:tier', { detail: { tier: n } }));
    } catch (e) { warn(e); }
  }

  /* ------------------------------------------------- glossary auto-wrap   */

  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, CODE: 1, PRE: 1, KBD: 1, SAMP: 1, VAR: 1,
    TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1, BUTTON: 1, LABEL: 1,
    SVG: 1, CANVAS: 1, MATH: 1, A: 1, ABBR: 1, TITLE: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1
  };

  function skipSubtree(node) {
    if (!node || node.nodeType !== 1) return false;
    var tag = node.tagName;
    if (SKIP_TAGS[tag]) return true;
    if (node.classList && (node.classList.contains('tara-term') || node.classList.contains('tara-angles'))) return true;
    if (node.hasAttribute('data-tara-noglossary')) return true;
    if (node.hasAttribute('data-tara-host')) return true;
    if (node.isContentEditable) return true;
    if (S.opts.glossaryInQuiz === false || S.opts.glossaryInQuiz === undefined) {
      if (node.hasAttribute('data-quiz') || node.hasAttribute('data-quiz-bank')) return true;
    }
    return false;
  }

  /* The "section" a first occurrence is counted within. */
  function sectionOf(node) {
    var s = closest(node, '[data-tier],[data-tara-section],[data-tier-group],section,article,main');
    return s || document.body;
  }

  function scanGlossary(root) {
    if (S.opts.glossary === false) return;
    if (!S.termIndex) buildIndex();
    if (!S.termRxCS && !S.termRxCI) return;
    var scope = root || document.body;
    if (!scope || !scope.nodeType) return;
    if (scope.nodeType === 1 && skipSubtree(scope)) return;

    var seen = new WeakMap();
    function firstIn(section, key) {
      var set = seen.get(section);
      if (!set) { set = Object.create(null); seen.set(section, set); }
      /* already wrapped earlier in this section, in a previous scan? */
      if (set[key]) return false;
      set[key] = 1;
      return true;
    }
    /* Terms already wrapped in the DOM count as "used" for their section. */
    var already = scope.querySelectorAll ? scope.querySelectorAll('.tara-term[data-term]') : [];
    for (var a = 0; a < already.length; a++) {
      firstIn(sectionOf(already[a]), already[a].getAttribute('data-term'));
    }

    var walker, texts = [];
    try {
      walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          if (!n.nodeValue || !/\S/.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
          var p = n.parentNode;
          while (p && p.nodeType === 1) {
            if (skipSubtree(p)) return NodeFilter.FILTER_REJECT;
            if (p === scope) break;
            p = p.parentNode;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
    } catch (e) { warn(e); return; }
    var t;
    while ((t = walker.nextNode())) texts.push(t);

    for (var i = 0; i < texts.length; i++) wrapInTextNode(texts[i], firstIn);
  }

  function wrapInTextNode(node, firstIn) {
    var text = node.nodeValue;
    if (!text || text.length < 2) return;
    var hits = [];
    function collect(rx) {
      if (!rx) return;
      rx.lastIndex = 0;
      var m, guardN = 0;
      while ((m = rx.exec(text)) !== null && guardN++ < 400) {
        if (m[0].length === 0) { rx.lastIndex++; continue; }
        hits.push({ start: m.index, end: m.index + m[0].length, raw: m[0] });
      }
    }
    collect(S.termRxCS);
    collect(S.termRxCI);
    if (!hits.length) return;
    hits.sort(function (x, y) { return x.start - y.start || (y.end - y.start) - (x.end - x.start); });

    var section = sectionOf(node.parentNode);
    var frag = document.createDocumentFragment();
    var cursor = 0, wrapped = 0, lastEnd = -1;
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      if (h.start < lastEnd) continue;                 /* overlapping match */
      var entry = lookupTerm(h.raw);
      if (!entry) continue;
      if (!firstIn(section, entry.key)) continue;      /* first occurrence only */
      if (h.start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, h.start)));
      frag.appendChild(makeTermSpan(entry, h.raw));
      cursor = h.end; lastEnd = h.end; wrapped++;
    }
    if (!wrapped) return;
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
    if (node.parentNode) node.parentNode.replaceChild(frag, node);
  }

  function makeTermSpan(entry, raw) {
    var span = el('span', {
      'class': 'tara-term',
      'data-term': entry.key,
      tabindex: '0',
      role: 'button',
      'aria-label': raw + ': ' + (entry.expansion || entry.plain),
      'aria-haspopup': 'dialog'
    });
    span.appendChild(document.createTextNode(raw));
    return span;
  }

  /* --------------------------------------------------------- concept map  */

  function mapUrl() {
    var u = S.opts.mapUrl || window.TARA_MAP_URL;
    return (typeof u === 'string' && u) ? u : null;
  }
  function planUrl() {
    var u = S.opts.planUrl || window.TARA_PLAN_URL;
    return (typeof u === 'string' && u) ? u : null;
  }
  function casesUrl() {
    var u = S.opts.casesUrl || window.TARA_CASES_URL;
    return (typeof u === 'string' && u) ? u : null;
  }
  function drillUrl() {
    var u = S.opts.drillUrl || window.TARA_DRILL_URL;
    return (typeof u === 'string' && u) ? u : null;   /* passed through untouched, hash included */
  }
  /* "Plan", "Map", "Cases", "Drill" — the way home from any page. Each omitted when unset. */
  function navLinks() {
    var out = [];
    if (planUrl()) out.push(el('a', { href: planUrl(), text: 'Plan', title: 'Back to the master plan', 'data-nav': 'plan' }));
    if (mapUrl()) out.push(el('a', { href: mapUrl(), target: '_blank', rel: 'noopener', text: 'Map', title: 'Concept map', 'data-nav': 'map' }));
    if (casesUrl()) out.push(el('a', { href: casesUrl(), target: '_blank', rel: 'noopener', text: 'Cases', title: 'Case studies', 'data-nav': 'cases' }));
    if (drillUrl()) out.push(el('a', { href: drillUrl(), target: '_blank', rel: 'noopener', text: 'Drill', title: 'Spaced-retrieval drill', 'data-nav': 'drill' }));
    return out;
  }
  function mapHref(slug, query) {
    var base = mapUrl();
    if (!base) return null;
    var hash = slug ? ('#node=' + encodeURIComponent(slug)) : ('#q=' + encodeURIComponent(String(query || '').slice(0, 240)));
    return base.replace(/#.*$/, '') + hash;
  }
  /* Best concept node for a passage: the longest glossary term inside it. */
  function bestSlugFor(text) {
    var found = findTermsIn(text);
    if (!found.length) return null;
    return found.slice().sort(function (a, b) { return b.term.length - a.term.length; })[0].slug || null;
  }
  function findTermsIn(text) {
    if (!S.termIndex) buildIndex();
    var out = [], seen = Object.create(null);
    function collect(rx) {
      if (!rx) return;
      rx.lastIndex = 0;
      var m, n = 0;
      while ((m = rx.exec(text)) !== null && n++ < 300) {
        if (!m[0]) { rx.lastIndex++; continue; }
        var e = lookupTerm(m[0]);
        if (e && !seen[e.key]) { seen[e.key] = 1; out.push(e); }
      }
    }
    collect(S.termRxCS); collect(S.termRxCI);
    return out;
  }

  /* ------------------------------------------------------- term popover   */

  var termPop = { node: null, anchor: null, entry: null, hideTimer: 0 };

  function buildTermPop() {
    var pop = el('div', { 'class': 'pop pop--term', role: 'dialog', 'aria-label': 'Term', hidden: true });
    pop.innerHTML =
      '<div class="pop-head"><span class="pop-term"></span><span class="pop-exp"></span><span class="pop-arena mono"></span></div>' +
      '<div class="pop-body"><p class="pop-plain"></p><div class="pop-why"><b>Why it matters</b><span></span></div></div>' +
      '<div class="pop-foot"></div>';
    pop.addEventListener('mouseenter', function () { clearTimeout(termPop.hideTimer); });
    pop.addEventListener('mouseleave', function () { scheduleHideTerm(); });
    return pop;
  }

  function showTermPop(anchor, entry) {
    if (!entry) return;
    clearTimeout(termPop.hideTimer);
    var pop = termPop.node;
    pop.querySelector('.pop-term').textContent = entry.term;
    pop.querySelector('.pop-exp').textContent = entry.expansion ? ('— ' + entry.expansion) : '';
    var ar = pop.querySelector('.pop-arena');
    ar.textContent = entry.arena || '';
    ar.hidden = !entry.arena;
    pop.querySelector('.pop-plain').textContent = entry.plain || '';
    var why = pop.querySelector('.pop-why');
    why.querySelector('span').textContent = entry.why || '';
    why.hidden = !entry.why;

    var foot = pop.querySelector('.pop-foot');
    foot.innerHTML = '';
    var href = mapHref(entry.slug, entry.term);
    if (href) {
      foot.appendChild(el('a', { href: href, target: '_blank', rel: 'noopener', text: 'Where this fits' }));
    }
    var save = el('button', { type: 'button', text: 'Save to review' });
    save.addEventListener('click', guard(function () {
      Review.add(entry.term + ' — ' + (entry.plain || entry.expansion || ''));
      save.textContent = 'Saved';
      save.setAttribute('data-state', 'done');
    }, 'term-save'));
    foot.appendChild(save);
    if (!foot.children.length) foot.hidden = true; else foot.hidden = false;

    if (termPop.anchor && termPop.anchor !== anchor) termPop.anchor.removeAttribute('data-tara-open');
    termPop.shownAt = Date.now();
    anchor.setAttribute('data-tara-open', '1');
    termPop.anchor = anchor;
    termPop.entry = entry;
    pop.hidden = false;
    position(pop, anchor.getBoundingClientRect());
  }

  function hideTermPop() {
    clearTimeout(termPop.hideTimer);
    if (!termPop.node) return;
    termPop.node.hidden = true;
    if (termPop.anchor) termPop.anchor.removeAttribute('data-tara-open');
    termPop.anchor = null; termPop.entry = null;
  }
  function scheduleHideTerm() {
    clearTimeout(termPop.hideTimer);
    termPop.hideTimer = setTimeout(hideTermPop, 220);
  }

  /* Place a floating card near a viewport rect, kept inside the viewport. */
  function position(node, rect) {
    node.style.left = '0px'; node.style.top = '0px';
    var w = node.offsetWidth || 320, h = node.offsetHeight || 120;
    var vw = window.innerWidth, vh = window.innerHeight, pad = 8;
    var left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(pad, Math.min(left, vw - w - pad));
    var top = rect.bottom + 8;
    if (top + h > vh - pad) {
      var above = rect.top - h - 8;
      top = (above >= pad) ? above : Math.max(pad, vh - h - pad);
    }
    node.style.left = Math.round(left) + 'px';
    node.style.top = Math.round(top) + 'px';
  }

  /* ------------------------------------------------- select-to-explain    */
  /* The layer has no model. Every "Simpler" answer is something an author
     wrote: an exact TARA_EXPLAIN entry, or the tier-1 text of the section the
     passage sits in. When neither exists it says so, and expands the terms it
     recognised instead. It never invents prose. */

  var selPop = { node: null, text: '', rect: null, open: false };

  function explainMap() {
    var m = window.TARA_EXPLAIN;
    if (!m || typeof m !== 'object') return null;
    if (!m.__taraNormed) {
      var out = Object.create(null);
      for (var k in m) {
        if (!Object.prototype.hasOwnProperty.call(m, k) || k === '__taraNormed') continue;
        out[norm(k)] = m[k];
      }
      try { Object.defineProperty(m, '__taraNormed', { value: out, enumerable: false, configurable: true }); }
      catch (e) { m.__taraNormed = out; }
    }
    return m.__taraNormed;
  }

  /* index of the block child of `container` that holds `node` */
  function blockIndexOf(container, node) {
    var blocks = blockChildren(container);
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i] === node || blocks[i].contains(node)) return { i: i, blocks: blocks, block: blocks[i] };
    }
    return { i: -1, blocks: blocks, block: null };
  }

  function currentVariantEl(rec, tier) {
    if (rec.external) return rec.el;
    var pick = pickVariant(rec, tier);
    return (pick.tier && rec.variants[pick.tier]) ? rec.variants[pick.tier] : rec.el;
  }

  /* tier-1 content of a group as a detached element we can read blocks from */
  function tier1Element(rec) {
    if (rec.external) {
      if (!rec.extHTML || !rec.extHTML[1]) return null;
      var d = document.createElement('div');
      d.innerHTML = rec.extHTML[1];
      return d;
    }
    return rec.variants[1] || null;
  }

  function resolveSimpler(sel) {
    var text = sel.text, range = sel.range;
    var key = norm(text);
    var terms = findTermsIn(text);

    /* 1. exact authored restatement */
    var em = explainMap();
    if (em && em[key]) {
      return { kind: 'authored', kicker: 'Plain restatement (written for this passage)', html: asHTML(em[key]), terms: terms };
    }
    if (em) {
      /* tolerate a selection that grabbed a trailing clause or two */
      for (var k in em) {
        if (!k || k.length < 24) continue;
        if (key.indexOf(k) === 0 || k.indexOf(key) === 0) {
          return { kind: 'authored', kicker: 'Plain restatement (written for this passage)', html: asHTML(em[k]), terms: terms };
        }
      }
    }

    /* 2. the tier-1 variant of the containing group, narrowed to the selection */
    var groupEl = range ? closest(range.commonAncestorContainer, '[data-tier-group]') : null;
    var rec = groupEl && groupEl.__taraGroup;
    if (rec) {
      var t1 = tier1Element(rec);
      if (t1 && S.tier === 1 && !rec.external) {
        /* already reading tier 1 — say so rather than echoing the same words back */
        return { kind: 'already', kicker: 'You are already on the plain version',
          html: '<p>This passage is the tier&nbsp;1 text. There is nothing plainer written for it.</p>', terms: terms };
      }
      if (t1) {
        var cur = currentVariantEl(rec, S.tier);
        var here = blockIndexOf(cur, range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentNode);
        var t1blocks = blockChildren(t1);
        var target = null, narrowed = false;

        /* prefer the tier-1 block that talks about the same things; fall back
           to matching by position when nothing overlaps */
        if (t1blocks.length) {
          var bi = bestByOverlap(text, t1blocks, function (b) { return b.textContent || ''; });
          if (bi >= 0) target = t1blocks[bi];
          else if (here.i >= 0) target = t1blocks[Math.min(here.i, t1blocks.length - 1)];
          else target = t1blocks[0];
        }
        if (!target) target = t1;

        var html = target.innerHTML;
        /* narrow to the matching sentence when the block says several things */
        var dstSents = sentences(target.textContent || '');
        var selSentCount = sentences(text).length;
        if (dstSents.length > 2 && words(text).length < 45) {
          var si = bestByOverlap(text, dstSents, function (x) { return x; });
          if (si >= 0) {
            var take = dstSents.slice(si, Math.min(dstSents.length, si + Math.max(1, selSentCount)));
            html = '<p>' + esc(take.join(' ')) + '</p>';
            narrowed = true;
          }
        }
        return {
          kind: 'tier1',
          kicker: narrowed ? 'The matching part of the tier 1 text' : 'How this section is written at tier 1',
          html: html, terms: terms
        };
      }
    }

    /* 3. honest miss */
    return { kind: 'none', kicker: 'Nothing plainer was written for this passage',
      html: '<p class="none">No plainer version was written for this passage yet.' +
            (terms.length ? ' The terms it contains are below.' : '') + '</p>',
      terms: terms };
  }

  /* Cheap content-word overlap. Used to find which tier-1 block (and which
     sentence in it) actually corresponds to the passage the reader selected,
     because paragraph counts rarely line up between tiers. */
  var STOP = {the:1,and:1,that:1,this:1,with:1,from:1,into:1,they:1,them:1,then:1,than:1,what:1,when:1,which:1,your:1,you:1,for:1,are:1,was:1,were:1,have:1,has:1,had:1,not:1,but:1,its:1,it:1,one:1,only:1,also:1,each:1,over:1,because:1,about:1,there:1,their:1,here:1,does:1,doing:1,done:1,every:1,just:1,like:1,more:1,most:1,some:1,such:1,very:1,will:1,would:1,can:1,could:1,how:1,why:1,who:1,into:1,onto:1,out:1};
  function contentWords(s) {
    var out = [], w = String(s || '').toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) || [];
    for (var i = 0; i < w.length; i++) if (!STOP[w[i]]) out.push(w[i]);
    return out;
  }
  function overlapScore(selWords, text) {
    var b = contentWords(text);
    if (!b.length || !selWords.length) return 0;
    var set = Object.create(null);
    for (var i = 0; i < b.length; i++) set[b[i]] = 1;
    var hit = 0, seen = Object.create(null);
    for (var j = 0; j < selWords.length; j++) {
      var w = selWords[j];
      if (set[w] && !seen[w]) { seen[w] = 1; hit++; }
    }
    return hit / Math.sqrt(b.length);
  }
  function bestByOverlap(selText, candidates, getText) {
    var sw = contentWords(selText);
    if (!sw.length) return -1;
    var bestI = -1, best = 0;
    for (var i = 0; i < candidates.length; i++) {
      var sc = overlapScore(sw, getText(candidates[i]));
      if (sc > best) { best = sc; bestI = i; }
    }
    return best >= 0.28 ? bestI : -1;
  }

  function sentenceSpan(srcSents, selText) {
    var t = norm(selText);
    if (!t) return null;
    var a = -1, b = -1;
    for (var i = 0; i < srcSents.length; i++) {
      var s = norm(srcSents[i]);
      if (!s) continue;
      if (a === -1 && (t.indexOf(s.slice(0, Math.min(40, s.length))) === 0 || s.indexOf(t.slice(0, Math.min(40, t.length))) >= 0)) a = i;
      if (a !== -1 && (t.indexOf(s.slice(0, Math.min(24, s.length))) >= 0 || s.indexOf(t.slice(Math.max(0, t.length - 24))) >= 0)) b = i;
    }
    if (a === -1) return null;
    if (b === -1 || b < a) b = a;
    return { a: a, b: b };
  }

  function asHTML(s) {
    var str = String(s == null ? '' : s);
    if (/<[a-z][\s\S]*>/i.test(str)) return str;
    return str.split(/\n{2,}/).map(function (p) { return '<p>' + esc(p.trim()) + '</p>'; }).join('');
  }

  function buildSelPop() {
    var pop = el('div', { 'class': 'pop pop--sel', role: 'dialog', 'aria-label': 'Selected passage', hidden: true });
    pop.innerHTML =
      '<div class="bar">' +
        '<button type="button" data-act="simpler">Simpler</button>' +
        '<a data-act="map" target="_blank" rel="noopener">Where this fits</a>' +
        '<button type="button" data-act="save">Save to review</button>' +
      '</div>' +
      '<div class="ans" hidden><p class="kicker"></p><div class="txt"></div><div class="terms" hidden></div></div>';
    pop.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    return pop;
  }

  function showSelPop(sel) {
    var pop = selPop.node;
    selPop.text = sel.text; selPop.range = sel.range; selPop.rect = sel.rect;
    pop.querySelector('.ans').hidden = true;
    var simpler = pop.querySelector('[data-act="simpler"]');
    simpler.textContent = 'Simpler';
    var save = pop.querySelector('[data-act="save"]');
    save.textContent = 'Save to review'; save.removeAttribute('data-state');
    var link = pop.querySelector('[data-act="map"]');
    var slug = bestSlugFor(sel.text);
    var href = mapHref(slug, sel.text);
    if (href) { link.href = href; link.hidden = false; } else { link.hidden = true; link.removeAttribute('href'); }
    pop.hidden = false; selPop.open = true;
    position(pop, sel.rect);
  }

  function hideSelPop() {
    if (!selPop.node) return;
    selPop.node.hidden = true; selPop.open = false;
  }

  function renderSimpler() {
    var pop = selPop.node;
    var res = resolveSimpler({ text: selPop.text, range: selPop.range });
    var ans = pop.querySelector('.ans');
    ans.querySelector('.kicker').textContent = res.kicker;
    ans.querySelector('.txt').innerHTML = res.html;
    var td = ans.querySelector('.terms');
    if (res.terms && res.terms.length) {
      var dl = ['<dl>'];
      for (var i = 0; i < Math.min(res.terms.length, 6); i++) {
        var e = res.terms[i];
        dl.push('<dt>' + esc(e.term) + (e.expansion ? ' <span style="font-weight:400;opacity:.75">' + esc(e.expansion) + '</span>' : '') + '</dt>');
        dl.push('<dd>' + esc(e.plain) + '</dd>');
      }
      dl.push('</dl>');
      td.innerHTML = dl.join('');
      td.hidden = false;
    } else { td.hidden = true; td.innerHTML = ''; }
    ans.hidden = false;
    position(pop, selPop.rect);
  }

  function readSelection() {
    var s;
    try { s = window.getSelection(); } catch (e) { return null; }
    if (!s || s.isCollapsed || s.rangeCount === 0) return null;
    var text = String(s.toString() || '').replace(/\s+/g, ' ').trim();
    var min = S.opts.minSelectWords || 4;
    if (words(text).length < min) return null;
    var range = s.getRangeAt(0);
    var node = range.commonAncestorContainer;
    if (isEditable(node)) return null;
    if (closest(node, '[data-tara-host]')) return null;
    if (S.host && S.host.contains(node.nodeType === 1 ? node : node.parentNode)) return null;
    var rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;
    return { text: text, range: range, rect: rect };
  }

  /* ---------------------------------------------------------- review q    */

  var Review = {
    list: function () {
      var v = jsonGet(K_REVIEW, []);
      return Object.prototype.toString.call(v) === '[object Array]' ? v : [];
    },
    add: function (text, extra) {
      var t = String(text || '').replace(/\s+/g, ' ').trim();
      if (!t) return null;
      var items = Review.list();
      for (var i = 0; i < items.length; i++) {
        if (items[i] && norm(items[i].text) === norm(t)) return items[i];
      }
      var item = {
        text: t,
        title: (document.title || '').trim(),
        url: String(location.href),
        tier: S.tier,
        ts: Date.now()
      };
      if (extra) for (var k in extra) item[k] = extra[k];
      items.push(item);
      if (items.length > 300) items = items.slice(items.length - 300);
      jsonSet(K_REVIEW, items);
      paintBadge();
      renderPanel();
      return item;
    },
    remove: function (ts) {
      var items = Review.list().filter(function (x) { return x && x.ts !== ts; });
      jsonSet(K_REVIEW, items); paintBadge(); renderPanel();
    },
    clear: function () { jsonSet(K_REVIEW, []); paintBadge(); renderPanel(); },
    markdown: function () {
      var items = Review.list();
      var byPage = {}, order = [];
      items.forEach(function (it) {
        var k = (it.title || it.url || 'Untitled') + '\n' + (it.url || '');
        if (!byPage[k]) { byPage[k] = []; order.push(k); }
        byPage[k].push(it);
      });
      var out = ['# TARA review queue', '', '_' + items.length + ' passage' + (items.length === 1 ? '' : 's') + ', exported ' + new Date().toISOString().slice(0, 10) + '_', ''];
      order.forEach(function (k) {
        var parts = k.split('\n');
        out.push('## ' + parts[0]);
        if (parts[1]) out.push('<' + parts[1] + '>');
        out.push('');
        byPage[k].forEach(function (it) {
          out.push('- tier ' + (it.tier || '?') + ' · ' + new Date(it.ts).toISOString().slice(0, 10));
          out.push('  > ' + it.text.replace(/\n/g, ' '));
          out.push('');
        });
      });
      var sig = Signal.all();
      var keys = Object.keys(sig);
      if (keys.length) {
        out.push('## Signals', '');
        keys.forEach(function (k2) {
          var s = sig[k2];
          out.push('- **' + (s.v === 'clicked' ? 'clicked' : 'did not click') + '** — ' + (s.title || k2) + (s.url ? ' <' + s.url + '>' : ''));
        });
        out.push('');
      }
      return out.join('\n');
    }
  };

  /* ------------------------------------------------------------- signal   */

  var Signal = {
    key: function () {
      try { return location.origin + location.pathname + (location.search || ''); }
      catch (e) { return String(document.title || 'page'); }
    },
    all: function () {
      var v = jsonGet(K_SIGNAL, {});
      return (v && typeof v === 'object') ? v : {};
    },
    get: function () { return Signal.all()[Signal.key()] || null; },
    set: function (v) {
      var all = Signal.all(), k = Signal.key();
      if (!v) { delete all[k]; }
      else all[k] = { v: v, t: Date.now(), title: (document.title || '').trim(), url: String(location.href) };
      jsonSet(K_SIGNAL, all);
      paintSignal();
      renderPanel();
      return v;
    }
  };

  /* ------------------------------------------------------------ the UI    */

  function announce(msg) {
    try { if (S.ui.sr) S.ui.sr.textContent = msg; } catch (e) { warn(e); }
  }

  function mountUI() {
    var host = el('div', { 'data-tara-host': '', 'aria-hidden': 'false' });
    host.style.cssText = 'all:initial;position:static';
    document.body.appendChild(host);
    var shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : null;
    if (!shadow) { host.remove(); return false; }

    var style = document.createElement('style');
    style.textContent = UI_CSS;
    shadow.appendChild(style);

    var root = el('div', { 'class': 'root', 'data-collapsed': '' });

    /* --- control --- */
    var control = el('div', { 'class': 'control' });
    var tabs = el('div', { 'class': 'tabs', role: 'tablist', 'aria-label': 'Reading level' });
    var tabEls = {};
    [1, 2, 3].forEach(function (n) {
      var b = el('button', {
        'class': 'tab', role: 'tab', type: 'button', id: 'tara-tab-' + n,
        'aria-selected': 'false', tabindex: '-1',
        title: TIER_LABEL[n] + ' — ' + TIER_HINT[n] + ' (press ' + n + ')'
      }, [
        el('span', { 'class': 'n', text: 'TIER ' + n }),
        el('span', { 'class': 'lab', text: TIER_LABEL[n] })
      ]);
      b.addEventListener('click', guard(function () { setTier(n); }, 'tab'));
      b.addEventListener('keydown', guard(function (ev) {
        var d = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        ev.preventDefault();
        var next = ((n - 1 + d) + 3) % 3 + 1;
        setTier(next);
        tabEls[next].focus();
      }, 'tabkey'));
      tabEls[n] = b;
      tabs.appendChild(b);
    });
    control.appendChild(tabs);

    var foot = el('div', { 'class': 'foot' });
    var reviewBtn = el('button', { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'tara-panel' });
    reviewBtn.appendChild(document.createTextNode('Review'));
    var badge = el('span', { 'class': 'badge', 'data-empty': '1', text: '0' });
    reviewBtn.appendChild(badge);
    reviewBtn.addEventListener('click', guard(function () { togglePanel(); }, 'review'));
    var hideBtn = el('button', { type: 'button', text: 'Hide', title: 'Collapse to a pill' });
    hideBtn.addEventListener('click', guard(function () { setCollapsed(true); }, 'hide'));
    navLinks().forEach(function (a) { foot.appendChild(a); });
    foot.appendChild(reviewBtn);
    foot.appendChild(hideBtn);
    control.appendChild(foot);
    root.appendChild(control);

    /* --- collapsed pill --- */
    var pillBtn = el('button', { 'class': 'open', type: 'button', 'aria-label': 'Open the reading level control' }, [
      el('span', { 'class': 'dot', 'aria-hidden': 'true' }),
      el('span', { 'class': 'plab', text: 'Tier 2' })
    ]);
    pillBtn.addEventListener('click', guard(function () { setCollapsed(false); }, 'pill'));
    var pill = el('div', { 'class': 'pill', role: 'group', 'aria-label': 'Reading level and navigation' }, [pillBtn]);
    navLinks().forEach(function (a) { pill.appendChild(a); });
    root.appendChild(pill);

    /* --- review panel --- */
    var panel = el('div', { 'class': 'panel', id: 'tara-panel', hidden: true, role: 'dialog', 'aria-label': 'Review queue' });
    panel.innerHTML =
      '<div class="panel-head"><h2>Review queue</h2><span class="count mono"></span>' +
        '<button class="x" type="button" aria-label="Close">×</button></div>' +
      '<div class="panel-body"></div>' +
      '<div class="panel-foot">' +
        '<button type="button" data-act="copy">Copy as markdown</button>' +
        '<button type="button" data-act="clear">Clear</button>' +
      '</div>';
    panel.querySelector('.x').addEventListener('click', guard(function () { togglePanel(false); }, 'panelx'));
    panel.querySelector('[data-act="copy"]').addEventListener('click', guard(function (ev) {
      copyText(Review.markdown(), ev.currentTarget);
    }, 'copy'));
    panel.querySelector('[data-act="clear"]').addEventListener('click', guard(function () {
      Review.clear();
    }, 'clear'));
    root.appendChild(panel);

    /* --- popovers --- */
    termPop.node = buildTermPop();
    root.appendChild(termPop.node);
    selPop.node = buildSelPop();
    root.appendChild(selPop.node);

    root.appendChild(el('div', { 'class': 'sr', 'aria-live': 'polite', 'aria-atomic': 'true' }));

    shadow.appendChild(root);
    S.host = host; S.shadow = shadow;
    S.ui = {
      root: root, control: control, tabs: tabEls, pill: pill, plab: pill.querySelector('.plab'),
      panel: panel, badge: badge, reviewBtn: reviewBtn,
      sr: root.querySelector('.sr')
    };

    /* selection popover actions */
    selPop.node.querySelector('[data-act="simpler"]').addEventListener('click', guard(renderSimpler, 'simpler'));
    selPop.node.querySelector('[data-act="save"]').addEventListener('click', guard(function (ev) {
      Review.add(selPop.text);
      ev.currentTarget.textContent = 'Saved';
      ev.currentTarget.setAttribute('data-state', 'done');
    }, 'sel-save'));

    return true;
  }

  function setCollapsed(v) {
    if (!S.ui.root) return;
    S.ui.root.setAttribute('data-collapsed', v ? '1' : '0');
    if (!v) togglePanel(false);
    layoutControl();
  }

  /* Where the control sits. Base offset from options, then pushed down past
     any of the page's own fixed/sticky chrome that would overlap it. */
  function numOr(v, d) { var n = parseFloat(v); return isNaN(n) ? d : n; }
  function pageChrome() {
    if (S.chrome && S.chromeW === window.innerWidth) return S.chrome;
    var out = [], all;
    try { all = document.body.querySelectorAll('*'); } catch (e) { return out; }
    var limit = Math.min(all.length, 6000);
    for (var i = 0; i < limit; i++) {
      var n = all[i];
      if (n.hasAttribute('data-tara-host')) continue;
      var cs;
      try { cs = getComputedStyle(n); } catch (e2) { continue; }
      var pos = cs.position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      var r = n.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      var box = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      if (pos === 'sticky') {
        /* use the stuck position, not wherever it happens to be at load */
        var st = parseFloat(cs.top);
        if (!isNaN(st)) { box.top = st; box.bottom = st + r.height; }
      }
      if (box.top > window.innerHeight * 0.6) continue;   /* bottom chrome never collides */
      out.push(box);
    }
    S.chrome = out; S.chromeW = window.innerWidth;
    return out;
  }
  function layoutControl() {
    var ui = S.ui; if (!ui.control) return;
    var off = S.opts.controlOffset || {};
    var narrow = window.innerWidth <= 760;
    var collapsed = ui.root.getAttribute('data-collapsed') === '1' || (narrow && ui.root.getAttribute('data-collapsed') !== '0');
    var box = collapsed ? ui.pill : ui.control;
    var els = [ui.control, ui.pill, ui.panel];

    if (narrow) {
      /* the pill keeps its stylesheet position unless narrow values are given;
         wide values never leak into the small-screen layout */
      for (var k = 0; k < els.length; k++) { els[k].style.top = ''; els[k].style.right = ''; els[k].style.left = ''; }
      var n = off.narrow || {};
      if (n.top != null) ui.pill.style.top = numOr(n.top, 10) + 'px';
      if (n.right != null) ui.pill.style.right = numOr(n.right, 10) + 'px';
      return;
    }

    var top = numOr(off.top, 14), inset = numOr(off.right, 14);
    function place(t, side) {
      var other = side === 'left' ? 'right' : 'left';
      ui.control.style.top = t + 'px';
      ui.control.style[side] = inset + 'px'; ui.control.style[other] = 'auto';
      ui.pill.style.top = Math.max(0, t - 4) + 'px';
      ui.pill.style[side] = Math.max(0, inset - 4) + 'px'; ui.pill.style[other] = 'auto';
    }
    /* walk downward from the base offset until nothing overlaps; give up past 300px */
    function findFree(side) {
      var t = top, chrome = pageChrome();
      for (var guardN = 0; guardN < 8; guardN++) {
        place(t, side);
        var r = box.getBoundingClientRect();
        if (!r.width) return t;
        var hit = null;
        for (var i = 0; i < chrome.length; i++) {
          var c = chrome[i];
          if (c.left < r.right && c.right > r.left && c.top < r.bottom && c.bottom > r.top) { hit = c; break; }
        }
        if (!hit) return t;
        var nt = hit.bottom + 8;
        if (nt <= t || nt - top > 300) return null;
        t = nt;
      }
      return null;
    }
    var side = 'right', t = top;
    place(top, side);
    if (S.opts.avoidChrome !== false) {
      var free = findFree('right');
      if (free === null) {            /* no free band top-right: mirror to the left edge */
        side = 'left'; free = findFree('left');
        if (free === null) { side = 'right'; free = top; }
      }
      t = free; place(t, side);
    }
    /* the review panel hangs under whichever control is showing, same side */
    var br = box.getBoundingClientRect();
    ui.panel.style.top = Math.round(br.bottom + 8) + 'px';
    ui.panel.style[side] = inset + 'px';
    ui.panel.style[side === 'left' ? 'right' : 'left'] = 'auto';
  }

  function togglePanel(force) {
    var p = S.ui.panel; if (!p) return;
    var open = (force === undefined) ? p.hidden : !!force;
    p.hidden = !open;
    S.ui.reviewBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) renderPanel();
  }

  function paintTabs() {
    if (!S.ui.tabs) return;
    for (var n = 1; n <= 3; n++) {
      var b = S.ui.tabs[n]; if (!b) continue;
      var on = (n === S.tier);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.setAttribute('tabindex', on ? '0' : '-1');
    }
    if (S.ui.plab) S.ui.plab.textContent = 'Tier ' + S.tier;
  }

  function paintBadge() {
    if (!S.ui.badge) return;
    var n = Review.list().length;
    S.ui.badge.textContent = String(n);
    S.ui.badge.setAttribute('data-empty', n ? '0' : '1');
  }

  function paintSignal() {
    var cur = Signal.get();
    var v = cur && cur.v;
    var nodes = document.querySelectorAll('[data-tara-signal] button[data-sig]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].setAttribute('aria-pressed', nodes[i].getAttribute('data-sig') === v ? 'true' : 'false');
    }
    if (S.ui.panel) {
      var pb = S.ui.panel.querySelectorAll('.sig-row button[data-sig]');
      for (var j = 0; j < pb.length; j++) {
        pb[j].setAttribute('aria-pressed', pb[j].getAttribute('data-sig') === v ? 'true' : 'false');
      }
    }
  }

  function renderPanel() {
    var p = S.ui.panel; if (!p || p.hidden) { paintBadge(); return; }
    var body = p.querySelector('.panel-body');
    var items = Review.list().slice().reverse();
    p.querySelector('.count').textContent = items.length ? (items.length + ' saved') : '';
    body.innerHTML = '';

    /* this page's signal, first, because it is the cheapest thing to answer */
    body.appendChild(el('div', { 'class': 'sect', text: 'This page' }));
    var row = el('div', { 'class': 'sig-row' });
    [['clicked', 'This clicked'], ['unclear', 'This did not']].forEach(function (pair) {
      var b = el('button', { type: 'button', 'data-sig': pair[0], text: pair[1], 'aria-pressed': 'false' });
      b.addEventListener('click', guard(function () {
        var cur = Signal.get();
        Signal.set(cur && cur.v === pair[0] ? null : pair[0]);
      }, 'sig'));
      row.appendChild(b);
    });
    body.appendChild(row);

    body.appendChild(el('div', { 'class': 'sect', text: 'Saved passages' }));
    if (!items.length) {
      body.appendChild(el('div', { 'class': 'empty', text: 'Nothing saved yet. Select a sentence anywhere on the page and choose “Save to review”.' }));
    } else {
      items.forEach(function (it) {
        var item = el('div', { 'class': 'item' });
        var q = el('div', { 'class': 'q' });
        q.appendChild(document.createTextNode(it.text.length > 320 ? it.text.slice(0, 317) + '…' : it.text));
        var src = el('span', { 'class': 'src' });
        if (it.url) src.appendChild(el('a', { href: it.url, text: it.title || it.url, title: it.url }));
        else src.textContent = it.title || '';
        q.appendChild(src);
        item.appendChild(q);
        var rm = el('button', { 'class': 'rm', type: 'button', 'aria-label': 'Remove', text: '×' });
        rm.addEventListener('click', guard(function () { Review.remove(it.ts); }, 'rm'));
        item.appendChild(rm);
        body.appendChild(item);
      });
    }

    var sig = Signal.all(), keys = Object.keys(sig);
    if (keys.length) {
      body.appendChild(el('div', { 'class': 'sect', text: 'Needs another pass' }));
      var list = el('div', { 'class': 'sig-list' });
      keys.sort(function (a, b) { return (sig[b].t || 0) - (sig[a].t || 0); }).forEach(function (k) {
        var s = sig[k];
        list.appendChild(el('div', {}, [
          el('span', { 'class': 'k', text: s.title || k, title: s.url || k }),
          el('span', { 'class': 'v', 'data-v': s.v, text: s.v === 'clicked' ? 'clicked' : 'unclear' })
        ]));
      });
      body.appendChild(list);
    }
    paintBadge();
    paintSignal();
  }

  function copyText(text, btn) {
    var done = function () {
      if (!btn) return;
      var old = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = old; }, 1400);
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallback(); });
        return;
      }
    } catch (e) { warn(e); }
    fallback();
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        done();
      } catch (e2) { warn(e2); }
    }
  }

  /* inline "this clicked / this did not" mounts */
  function mountSignals(root) {
    var nodes = (root || document).querySelectorAll('[data-tara-signal]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.__taraSig) continue;
      n.__taraSig = true;
      n.classList.add('tara-signal');
      n.appendChild(el('span', { text: 'How did this land?' }));
      [['clicked', 'This clicked'], ['unclear', 'This did not']].forEach(function (pair) {
        var b = el('button', { type: 'button', 'data-sig': pair[0], text: pair[1], 'aria-pressed': 'false' });
        b.addEventListener('click', guard(function () {
          var cur = Signal.get();
          Signal.set(cur && cur.v === pair[0] ? null : pair[0]);
        }, 'sig-inline'));
        n.appendChild(b);
      });
    }
    paintSignal();
  }

  /* --------------------------------------------------------- quizzes      */
  /* Fisher-Yates over questions and over options, seeded from the clock, so a
     reader who remembers that the answer was third learns nothing from it. */

  function makeRng(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }
  function shuffleInPlace(arr, rnd) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  var LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  function shuffleQuizzes(opts) {
    var seed = (opts && opts.seed) || (Date.now() ^ (Math.random() * 0xffffffff));
    var rnd = makeRng(seed >>> 0);
    var nodes = document.querySelectorAll('[data-quiz]');
    var touched = 0;
    for (var i = 0; i < nodes.length; i++) {
      var quiz = nodes[i];
      /* the dedicated quiz engine owns its own mounts */
      if (quiz.hasAttribute('data-quiz-bank')) continue;
      if (quiz.hasAttribute('data-quiz-mounted')) continue;
      if (quiz.hasAttribute('data-quiz-noshuffle')) continue;
      if (shuffleOneQuiz(quiz, rnd)) touched++;
    }
    return touched;
  }

  function shuffleOneQuiz(quiz, rnd) {
    var pool = quiz.__taraPool;
    if (!pool) {
      pool = [];
      var qs = quiz.querySelectorAll('[data-question]');
      for (var i = 0; i < qs.length; i++) {
        /* only questions belonging to this quiz, not a nested one */
        if (closest(qs[i].parentNode, '[data-quiz]') !== quiz) continue;
        pool.push(qs[i]);
      }
      if (!pool.length) return false;
      quiz.__taraPool = pool;
      quiz.__taraAnchor = pool[0].parentNode;
    }
    var container = quiz.__taraAnchor || quiz;
    var order = pool.slice();
    shuffleInPlace(order, rnd);

    var draw = parseInt(quiz.getAttribute('data-quiz-draw') || '', 10);
    if (!(draw > 0) || draw > order.length) draw = order.length;
    var chosen = order.slice(0, draw);

    /* detach everything in the pool, then re-append the drawn subset in order */
    for (var d = 0; d < pool.length; d++) if (pool[d].parentNode) pool[d].parentNode.removeChild(pool[d]);
    for (var c = 0; c < chosen.length; c++) {
      container.appendChild(chosen[c]);
      shuffleOptions(chosen[c], rnd);
      var num = chosen[c].querySelector('[data-question-number]');
      if (num) num.textContent = String(c + 1);
    }
    quiz.setAttribute('data-quiz-shuffled', String(chosen.length));
    return true;
  }

  function shuffleOptions(question, rnd) {
    var lists = question.querySelectorAll('[data-options]');
    for (var l = 0; l < lists.length; l++) {
      var list = lists[l];
      if (closest(list.parentNode, '[data-question]') !== question) continue;
      var opts = [];
      for (var i = 0; i < list.children.length; i++) {
        if (list.children[i].hasAttribute('data-option')) opts.push(list.children[i]);
      }
      if (opts.length < 2) continue;

      /* remember the correct node before anything moves */
      var correctNode = null;
      var answerAttr = question.getAttribute('data-answer');
      if (answerAttr !== null && answerAttr !== '') {
        var idx = /^\d+$/.test(answerAttr.trim())
          ? parseInt(answerAttr, 10)
          : LETTERS.indexOf(answerAttr.trim().toUpperCase()[0]);
        if (idx >= 0 && idx < opts.length) correctNode = opts[idx];
      }
      if (!correctNode) {
        for (var k = 0; k < opts.length; k++) if (opts[k].hasAttribute('data-correct')) { correctNode = opts[k]; break; }
      }

      shuffleInPlace(opts, rnd);
      for (var m = 0; m < opts.length; m++) list.appendChild(opts[m]);

      /* re-bind index-based answers and repaint any A/B/C labels */
      for (var n = 0; n < opts.length; n++) {
        var o = opts[n];
        o.setAttribute('data-option-index', String(n));
        var lab = o.querySelector('[data-option-label]');
        if (lab) lab.textContent = LETTERS[n] || String(n + 1);
        var input = o.querySelector('input[type="radio"],input[type="checkbox"]');
        if (input && /^\d+$/.test(input.value || '')) input.value = String(n);
      }
      if (answerAttr !== null && correctNode) {
        var newIdx = opts.indexOf(correctNode);
        question.setAttribute('data-answer', /^\d+$/.test(String(answerAttr).trim()) ? String(newIdx) : (LETTERS[newIdx] || String(newIdx)));
      }
    }
  }

  /* -------------------------------------------------------------- events  */

  function wireEvents() {
    /* glossary: hover on desktop, tap on touch, focus for keyboard */
    on(document, 'mouseover', function (ev) {
      var t = closest(ev.target, '.tara-term');
      if (!t) return;
      if (isTouch()) return;
      var e = lookupTerm(t.getAttribute('data-term'));
      if (e) showTermPop(t, e);
    });
    on(document, 'mouseout', function (ev) {
      if (isTouch()) return;   /* a tap emits a synthetic mouseout; ignore it */
      var t = closest(ev.target, '.tara-term');
      if (!t) return;
      var to = ev.relatedTarget;
      if (to && (closest(to, '.tara-term') === t)) return;
      scheduleHideTerm();
    });
    on(document, 'click', function (ev) {
      var t = closest(ev.target, '.tara-term');
      if (!t) return;
      ev.preventDefault();
      var e = lookupTerm(t.getAttribute('data-term'));
      if (!e) return;
      /* A tap focuses the term first, which already opened the card; only a
         deliberate second interaction should close it again. */
      var justOpened = (Date.now() - (termPop.shownAt || 0)) < 400;
      if (termPop.anchor === t && !termPop.node.hidden && !justOpened) hideTermPop();
      else showTermPop(t, e);
    });
    on(document, 'focusin', function (ev) {
      var t = closest(ev.target, '.tara-term');
      if (t) {
        var e = lookupTerm(t.getAttribute('data-term'));
        if (e) showTermPop(t, e);
      } else if (termPop.anchor && !S.host.contains(ev.target)) {
        scheduleHideTerm();
      }
    });

    /* selection */
    var selTimer = 0;
    function maybeSelection() {
      clearTimeout(selTimer);
      selTimer = setTimeout(guard(function () {
        var sel = readSelection();
        if (sel) showSelPop(sel); else hideSelPop();
      }, 'selection'), 10);
    }
    on(document, 'mouseup', maybeSelection);
    on(document, 'touchend', maybeSelection);
    on(document, 'selectionchange', function () {
      if (!selPop.open) return;
      var s;
      try { s = window.getSelection(); } catch (e) { return; }
      if (!s || s.isCollapsed) hideSelPop();
    });
    on(document, 'mousedown', function (ev) {
      if (S.host && S.host.contains(ev.target)) return;
      hideSelPop();
      hideTermPop();
    });
    on(window, 'scroll', function () {
      hideSelPop();
      /* an anchored term card follows its term rather than vanishing under the
         reader; it only closes once the term has left the viewport */
      if (termPop.node && !termPop.node.hidden && termPop.anchor) {
        var r = termPop.anchor.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) hideTermPop();
        else position(termPop.node, r);
      }
    }, true);
    var rsz = 0;
    on(window, 'resize', function () {
      hideSelPop(); hideTermPop();
      clearTimeout(rsz);
      rsz = setTimeout(guard(function () { S.chrome = null; layoutControl(); }, 'relayout'), 120);
    });

    /* keyboard: 1 / 2 / 3 switch tier, Escape closes whatever is open */
    on(document, 'keydown', function (ev) {
      if (ev.key === 'Escape') {
        if (!termPop.node.hidden) { hideTermPop(); return; }
        if (selPop.open) { hideSelPop(); return; }
        if (S.ui.panel && !S.ui.panel.hidden) { togglePanel(false); return; }
        return;
      }
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (isEditable(ev.target)) return;
      if (ev.key === '1' || ev.key === '2' || ev.key === '3') {
        setTier(parseInt(ev.key, 10));
        setCollapsed(false);
      }
    });

    /* another tab changed the tier (either key): follow it, and keep both keys converged */
    on(window, 'storage', function (ev) {
      if (!ev || (ev.key !== K_TIER && ev.key !== K_TIER_ALIAS)) return;
      var n = parseInt(ev.newValue, 10);
      if ((n === 1 || n === 2 || n === 3) && n !== S.tier) setTier(n);
    });

    /* the "written at one level only" dot explains itself on click too */
    on(document, 'click', function (ev) {
      var m = closest(ev.target, '.tara-mark');
      if (!m) return;
      ev.preventDefault();
      announce(m.getAttribute('title') || '');
    });
  }

  /* ---------------------------------------------------------------- init  */

  function init(options) {
    if (S.inited) { if (options) Object.assign(S.opts, options); return API; }
    S.opts = Object.assign({
      glossary: true,
      glossaryInQuiz: false,
      selectExplain: true,
      quiz: true,
      minSelectWords: 4,
      defaultTier: 2,
      mapUrl: null,
      planUrl: null,
      casesUrl: null,
      drillUrl: null,
      stickyOffset: null,
      controlOffset: null,   /* {top, right, narrow:{top, right}} in px; default 14/14, pill 10/10 */
      avoidChrome: true      /* push the control below the page's own fixed/sticky chrome */
    }, window.TARA_OPTIONS || {}, options || {});

    if (!document.body) return API;

    addEntries(GLOSSARY_SEED);
    if (window.TARA_GLOSSARY_EXTRA) addEntries(window.TARA_GLOSSARY_EXTRA);
    if (S.opts.glossaryExtra) addEntries(S.opts.glossaryExtra);
    buildIndex();

    if (!mountUI()) return API;

    var sticky = S.opts.stickyOffset != null ? S.opts.stickyOffset : window.TARA_STICKY_OFFSET;
    if (sticky != null && sticky !== '' && !isNaN(parseFloat(sticky))) {
      try { document.documentElement.style.setProperty('--tara-sticky-offset', parseFloat(sticky) + 'px'); } catch (e) { warn(e); }
    }

    var stored = readStoredTier();
    S.tier = stored || S.opts.defaultTier || 2;
    /* small screens start as the pill; nothing covers the reading column */
    S.ui.root.setAttribute('data-collapsed', window.innerWidth <= 760 ? '1' : '0');
    layoutControl();

    if (S.opts.glossary !== false) { scanGlossary(document.body); S.scanned = true; }
    setTier(S.tier, { persist: stored !== null });
    mountSignals(document.body);
    paintBadge();
    if (S.opts.quiz !== false) { try { shuffleQuizzes(); } catch (e) { warn(e); } }
    wireEvents();

    S.inited = true;
    try { window.dispatchEvent(new CustomEvent('tara:ready', { detail: { tier: S.tier, version: VERSION } })); }
    catch (e) { warn(e); }
    return API;
  }

  function rescan(root) {
    var scope = root || document.body;
    S.groups = collectGroups();
    for (var i = 0; i < S.groups.length; i++) applyGroup(S.groups[i], S.tier);
    if (S.opts.glossary !== false) scanGlossary(scope);
    mountSignals(scope);
    return API;
  }

  function destroy() {
    for (var i = 0; i < S.listeners.length; i++) {
      var l = S.listeners[i];
      try { l[0].removeEventListener(l[1], l[2], l[3]); } catch (e) { warn(e); }
    }
    S.listeners = [];
    try { if (S.host) S.host.remove(); } catch (e) { warn(e); }
    try { document.documentElement.removeAttribute('data-tara-tier'); } catch (e) { warn(e); }
    S.inited = false; S.host = null; S.shadow = null; S.ui = {};
  }

  /* ----------------------------------------------------------- page CSS   */

  function injectPageCSS() {
    try {
      if (document.getElementById('tara-layer-css')) return;
      var s = document.createElement('style');
      s.id = 'tara-layer-css';
      s.textContent = PAGE_CSS;
      (document.head || document.documentElement).appendChild(s);
    } catch (e) { warn(e); }
  }

  /* ------------------------------------------------------------- export   */

  var API = {
    __installed: true,
    version: VERSION,
    init: guard(init, 'init'),
    rescan: guard(rescan, 'rescan'),
    destroy: guard(destroy, 'destroy'),
    setTier: guard(function (n) { setTier(n); return S.tier; }, 'setTier'),
    getTier: function () { return S.tier; },
    tiers: TIER_LABEL,
    shuffleQuizzes: guard(shuffleQuizzes, 'shuffleQuizzes'),
    addGlossary: guard(function (list) { addEntries(list); buildIndex(); return TERMS.length; }, 'addGlossary'),
    glossary: {
      size: function () { return TERMS.length; },
      lookup: function (t) { return lookupTerm(t); },
      find: function (text) { return findTermsIn(text); },
      all: function () { return TERMS.slice(); }
    },
    review: {
      list: Review.list, add: guard(Review.add, 'review.add'),
      remove: guard(Review.remove, 'review.remove'),
      clear: guard(Review.clear, 'review.clear'),
      markdown: guard(Review.markdown, 'review.markdown'),
      open: guard(function () { setCollapsed(false); togglePanel(true); }, 'review.open')
    },
    signal: guard(function (v) { return v === undefined ? Signal.get() : Signal.set(v); }, 'signal'),
    explain: guard(function (text) { return resolveSimpler({ text: String(text || ''), range: null }); }, 'explain'),
    mapHref: guard(function (slug, q) { return mapHref(slug, q); }, 'mapHref'),
    _internal: { S: S, norm: norm, sentences: sentences }
  };

  window.TARA = API;
  injectPageCSS();

  if (!window.TARA_NO_AUTOINIT) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { API.init(); }, { once: true });
    } else {
      API.init();
    }
  }
})();
