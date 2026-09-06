/* ===== src/shell/shell.js ===== */
;(function(){
/* app/src/shell/shell.js — SPEC §6, §6.1, §7. Defines window.APP: payloads, tier,
   router, frames, sections, nav. Owner: Worker A.
   window.TARA belongs to the reading layer (SPEC §1). Nothing here touches it. */

'use strict';

var APP = (window.APP = window.APP || {});

/* ===================================================================== util */

APP.esc = function (s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};

APP.el = function (tag, attrs, kids) {
  var n = document.createElement(tag);
  if (attrs) for (var k in attrs) {
    if (k === 'text') n.textContent = attrs[k];
    else if (k === 'html') n.innerHTML = attrs[k];
    else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k]);
  }
  if (kids) for (var i = 0; i < kids.length; i++) if (kids[i]) n.appendChild(kids[i]);
  return n;
};

var toastEl = null, toastT = 0;
APP.toast = function (msg) {
  toastEl = toastEl || document.getElementById('app-toast');
  if (!toastEl) return;
  toastEl.textContent = String(msg == null ? '' : msg);
  toastEl.setAttribute('data-show', '1');
  clearTimeout(toastT);
  toastT = setTimeout(function () { toastEl.removeAttribute('data-show'); }, 2600);
};

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
APP._ls = { get: lsGet, set: lsSet };

/* ================================================================= payloads */
/* SPEC §4 — verbatim. Do not "improve" it. */

var _cache = new Map();
var _inflight = new Map();
var _index = null;

/* window.__MANIFEST carries {key, section, kind, raw, enc, gz, file} for every
   payload; `file` is a content-hashed, immutable path relative to the document. */
function payloadIndex() {
  if (_index) return _index;
  _index = Object.create(null);
  var m = window.__MANIFEST || [];
  for (var i = 0; i < m.length; i++) _index[m[i].key] = m[i];
  return _index;
}

/* Relative to document.baseURI, never root-absolute: the site is served from a
   subpath on GitHub Pages (https://<owner>.github.io/<repo>/). */
function assetURL(file) {
  try { return new URL(file, document.baseURI).href; } catch (e) { return file; }
}

async function fetchPayload(key) {
  var bytes = null;
  var el = document.getElementById('P:' + key);
  if (el) {
    /* still supported, so a single-file build of the same sources works here */
    var bin = atob(el.textContent.trim());
    bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    var rec = payloadIndex()[key];
    if (!rec || !rec.file) throw new Error('no payload: ' + key);
    var res = await fetch(assetURL(rec.file), { credentials: 'same-origin' });
    if (!res.ok) throw new Error('payload ' + key + ': HTTP ' + res.status);
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  /* Same decode as the single-file build. A plain static host serves .gz with
     no Content-Encoding, so the gzip container arrives intact; a host that DOES
     set Content-Encoding: gzip has already inflated it, and the magic number
     says so. */
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  }
  return new TextDecoder('utf-8').decode(bytes);
}

APP.payload = function (key) {
  if (_cache.has(key)) return Promise.resolve(_cache.get(key));
  var p = _inflight.get(key);
  if (p) return p;
  p = fetchPayload(key).then(function (text) {
    _cache.set(key, text); _inflight.delete(key); return text;
  }, function (e) { _inflight.delete(key); throw e; });
  _inflight.set(key, p);
  return p;
};
APP.payloadJSON = async function (key) { return JSON.parse(await APP.payload(key)); };
APP.hasPayload = function (key) { return !!(payloadIndex()[key] || document.getElementById('P:' + key)); };
APP.manifest = function () { return window.__MANIFEST || []; };

/* ===================================================================== tier */
/* SPEC §6.1. Canonical key tara.tier, alias tara.resolution, both written. */

var TIER_LABEL = { 1: 'Plain', 2: 'Generalist', 3: 'Expert' };
var SPRINT_TIER = { 1: 'plain', 2: 'working', 3: 'expert' };
var tierListeners = [];

function readTier() {
  var v = lsGet('tara.tier');
  if (v !== '1' && v !== '2' && v !== '3') v = lsGet('tara.resolution');
  if (v !== '1' && v !== '2' && v !== '3') return 2;
  return Number(v);
}
var _tier = 2;

APP.tier = function () { return _tier; };
APP.tierLabel = function (n) { return TIER_LABEL[n || _tier]; };

APP.setTier = function (n, opts) {
  n = Number(n);
  if (n !== 1 && n !== 2 && n !== 3) return _tier;
  var changed = n !== _tier;
  _tier = n;
  lsSet('tara.tier', String(n));
  lsSet('tara.resolution', String(n));
  document.documentElement.setAttribute('data-tara-tier', String(n));
  paintTier();

  /* The shell document does not host the reading layer, but be a good citizen
     if something ever injects it here. */
  try { if (window.TARA && typeof window.TARA.setTier === 'function') window.TARA.setTier(n); } catch (e) {}

  fanOutTier(n);

  try { window.dispatchEvent(new CustomEvent('tara:tier', { detail: { tier: n } })); } catch (e) {}
  for (var i = 0; i < tierListeners.length; i++) {
    try { tierListeners[i](n); } catch (e) { console.warn('onTierChange listener failed', e); }
  }
  var cur = APP._route && sections[APP._route.section];
  if (cur && typeof cur.def.onTier === 'function') {
    try { cur.def.onTier(n); } catch (e) { console.warn('section onTier failed', e); }
  }
  if (changed && opts && opts.announce) APP.toast('Tier ' + n + ' — ' + TIER_LABEL[n]);
  return _tier;
};

APP.onTierChange = function (cb) {
  tierListeners.push(cb);
  return function off() {
    var i = tierListeners.indexOf(cb);
    if (i >= 0) tierListeners.splice(i, 1);
  };
};

function paintTier() {
  var box = document.getElementById('app-tier');
  if (!box) return;
  var btns = box.querySelectorAll('.app-tierbtn');
  for (var i = 0; i < btns.length; i++) {
    btns[i].setAttribute('aria-pressed', btns[i].getAttribute('data-tier') === String(_tier) ? 'true' : 'false');
  }
}

/* SPEC §6.1 fan-out. Same-origin srcdoc frames only; every reach is guarded. */
function fanOutTier(n) {
  APP.frames.each(function (f) {
    var d = APP.frames.doc(f);
    var w = null;
    try { w = f.contentWindow; } catch (e) { return; }
    if (!w) return;
    try {
      if (w.TARA && typeof w.TARA.setTier === 'function') { w.TARA.setTier(n); return; }
    } catch (e) {}
    if (!d) return;
    try {
      var b = d.querySelector('[data-settier="' + SPRINT_TIER[n] + '"]');
      if (b) { b.click(); return; }
    } catch (e) {}
    try { d.documentElement.setAttribute('data-tara-tier', String(n)); } catch (e) {}
  });
}

/* ================================================================== review */
/* APP.review is filled in by review.js. These stubs keep boot order safe. */

APP.review = APP.review || {
  list: function () { return []; }, add: function () { return null; },
  remove: function () {}, clear: function () {}, open: function () {}
};

/* ================================================================== frames */
/* SPEC §5.1. srcdoc, NO sandbox attribute — the frame must stay same-origin. */

var LRU = 4;
var live = new Map();            // key -> iframe, insertion order = LRU order
var currentFrameKey = null;

APP.frames = {
  max: LRU,

  get: async function (key, composeFn) {
    if (live.has(key)) {
      var have = live.get(key);
      live.delete(key); live.set(key, have);       // touch
      return have;
    }
    var html = await composeFn();
    var f = document.createElement('iframe');
    f.className = 'app-frame';
    f.setAttribute('title', key);
    f.setAttribute('loading', 'eager');
    f.dataset.frameKey = key;
    f.addEventListener('load', function () { onFrameLoad(f); });
    f.srcdoc = html;
    live.set(key, f);
    evict();
    return f;
  },

  doc: function (f) {
    try { return (f && f.contentDocument) || null; } catch (e) { return null; }
  },

  win: function (f) {
    try { return (f && f.contentWindow) || null; } catch (e) { return null; }
  },

  /* Attach f to el and make it the ONLY visible frame in that host.
     The LRU keeps up to four frames alive, and an evicted-from-view frame
     stays attached to its host so its document, its scroll position and its
     state survive; without this, every frame a host has ever shown stacks and
     the section grows by one viewport per visit. Hiding is `hidden` +
     display:none rather than removeChild, because detaching an iframe
     destroys its browsing context and would reload it. */
  show: function (el, f) {
    if (!el || !f) return;
    currentFrameKey = f.dataset.frameKey || null;
    if (f.parentNode !== el) el.appendChild(f);
    APP.frames.only(el, f);
    live.delete(f.dataset.frameKey); live.set(f.dataset.frameKey, f);
  },

  /* Exactly one visible iframe per host. Idempotent, and it never touches a
     frame that is already in the state it wants — no reflow on a re-show. */
  only: function (el, f) {
    if (!el) return;
    var kids = el.children;
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c.tagName !== 'IFRAME') continue;
      if (c === f) {
        if (c.hidden) { c.hidden = false; c.style.removeProperty('display'); }
      } else if (!c.hidden) {
        c.hidden = true; c.style.setProperty('display', 'none', 'important');
      }
    }
  },

  has: function (key) { return live.has(key); },
  each: function (fn) { live.forEach(function (f) { fn(f); }); },

  drop: function (key) {
    var f = live.get(key);
    if (!f) return;
    live.delete(key);
    if (f.parentNode) f.parentNode.removeChild(f);
    try { f.srcdoc = ''; } catch (e) {}
  }
};

function evict() {
  var guard = 0;
  while (live.size > LRU && guard++ < 20) {
    var victim = null;
    var it = live.keys();
    for (var e = it.next(); !e.done; e = it.next()) {
      if (e.value !== currentFrameKey) { victim = e.value; break; }
    }
    if (victim == null) break;
    APP.frames.drop(victim);
  }
}

function onFrameLoad(f) {
  /* Newly loaded frames adopt the shell's tier, and forward 1/2/3 typed inside
     them (frames without the reading layer have no key handler of their own). */
  var d = APP.frames.doc(f);
  var w = APP.frames.win(f);
  try {
    if (w && w.TARA && typeof w.TARA.setTier === 'function') w.TARA.setTier(_tier);
    else if (d) {
      var b = d.querySelector('[data-settier="' + SPRINT_TIER[_tier] + '"]');
      if (b) b.click();
    }
  } catch (e) {}
  if (d && !d.__appKeys) {
    try {
      d.__appKeys = 1;
      d.addEventListener('keydown', onTierKey, true);
    } catch (e) {}
  }
  if (f.__onready) { try { f.__onready(); } catch (e) {} }
}
APP.frames._onLoad = onFrameLoad;

/* ================================================================ sections */

/* The nav is authored here, not derived from what happened to build. Item
   positions are therefore identical in every build (SPEC rule 1). */
var NAV = [
  { id: 'today',  title: 'Now',    navOrder: 0, hash: 'today' },
  { id: 'plan',   title: 'Plan',   navOrder: 1, hash: 'plan' },
  { id: 'packs',  title: 'Packs',  navOrder: 2, hash: 'packs' },
  { id: 'demos',  title: 'Demos',  navOrder: 3, hash: 'demos' },
  { id: 'drill',  title: 'Drill',  navOrder: 4, hash: 'drill' },
  { id: 'cases',  title: 'Cases',  navOrder: 5, hash: 'cases' },
  { id: 'map',    title: 'Map',    navOrder: 6, hash: 'map' },
  { id: 'sprint', title: 'Sprint', navOrder: 7, hash: 'sprint' },
  { id: 'manual', title: 'Manual', navOrder: 8, hash: 'manual' }
];
APP.NAV = NAV;
APP.navOrder = function (id) {
  for (var i = 0; i < NAV.length; i++) if (NAV[i].id === id) return NAV[i].navOrder;
  return 99;
};

var sections = Object.create(null);      // id -> {def, el}
APP._sections = sections;
APP._order = Object.create(null);        // SPEC §10 — per-section sorted-once order
APP._scroll = Object.create(null);

APP.registerSection = function (def) {
  if (!def || !def.id) { console.warn('registerSection without an id'); return; }
  if (sections[def.id]) { console.warn('section already registered: ' + def.id); return; }
  sections[def.id] = { def: def, el: null, mounted: false };
};
APP.section = function (id) { return sections[id] ? sections[id].def : null; };
APP.sectionIds = function () {
  return NAV.map(function (n) { return n.id; }).filter(function (id) { return !!sections[id]; });
};

function containerFor(id) {
  var rec = sections[id];
  var main = document.getElementById('app-main');
  if (rec && rec.el) return rec.el;
  var el = document.getElementById('app-sec-' + id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'app-sec';
    el.id = 'app-sec-' + id;
    el.hidden = true;
    main.appendChild(el);
  }
  if (rec) rec.el = el;
  return el;
}

/* =================================================================== router */
/* SPEC §7. APP.navigate is the only writer of location.hash. */

var SECTION_NAMES = {};
NAV.forEach(function (n) { SECTION_NAMES[n.id] = 1; });
SECTION_NAMES.week = 'packs';            // legacy alias

var PACK_SLUGS = [];                     // filled from the schedule at boot
var DEMO_SLUGS = [];
var routeListeners = [];
APP._route = null;

function stripHash(h) { return String(h == null ? '' : h).replace(/^#+/, ''); }

function isPackSlug(t) {
  if (/^week-(0[1-9]|1[0-4])$/.test(t)) return true;
  return PACK_SLUGS.indexOf(t) >= 0;
}
function isDemoSlug(t) { return DEMO_SLUGS.indexOf(t) >= 0; }

/* The drill-room referrer test (SPEC §7). In-app it means "the click that caused
   this hash change came from inside the drill section"; on a cold load it means
   the browser actually came from the published drill artifact. */
var _clickInDrill = false;
document.addEventListener('click', function (e) {
  var a = e.target && e.target.closest ? e.target.closest('a[href^="#"]') : null;
  _clickInDrill = !!(a && a.closest('#app-sec-drill'));
}, true);
var DRILL_ARTIFACT = '438d8cfc-21dd-4b71-a51b-bc64923e8bc2';
function fromDrill() {
  if (_clickInDrill) return true;
  if (!APP._route) { try { return String(document.referrer || '').indexOf(DRILL_ARTIFACT) >= 0; } catch (e) { return false; } }
  return false;
}

/* Sections may offer resolveToken(tok) -> hash|null for bare-token redirects
   (case-card stems, concept-map node ids). Consulted only when nothing else
   matches, so known routes never wait on a payload decode. */
async function resolveBare(tok) {
  var ids = APP.sectionIds();
  for (var i = 0; i < ids.length; i++) {
    var def = sections[ids[i]].def;
    if (typeof def.resolveToken !== 'function') continue;
    try {
      var hit = await def.resolveToken(tok);
      if (hit) return stripHash(hit);
    } catch (e) { /* a section that cannot resolve just does not resolve */ }
  }
  return null;
}

async function normalizeHash(raw) {
  var h = stripHash(raw);
  if (!h) return 'today';

  /* old conventions -> canonical (SPEC §7) */
  var m;
  if ((m = h.match(/^node=(.+)$/))) return 'map/node=' + m[1];
  if ((m = h.match(/^q=(.*)$/))) return 'map/q=' + m[1];
  if ((m = h.match(/^day-([1-9])$/))) return 'sprint/day-' + m[1];

  var parts = h.split('/');
  var head = parts[0];
  var tail = parts.slice(1).join('/');

  /* canonical multi-part forms pass straight through */
  if (SECTION_NAMES[head] === 1) return h;
  if (head === 'search') return h;
  if (head === 'demo' || /^demo-week-\d{1,2}$/.test(head)) return h;

  /* #week-<slug> and a one-digit #week-N both mean a pack (SPEC §7). */
  if (!isPackSlug(head) && head.indexOf('week-') === 0) {
    var t = head.slice(5);
    if (/^\d$/.test(t)) t = '0' + t;
    var alt = isPackSlug('week-' + t) ? 'week-' + t : (isPackSlug(t) ? t : null);
    if (alt) { head = alt; h = tail ? alt + '/' + tail : alt; }
  }

  if (isPackSlug(head)) {
    /* A bare week arriving *from the drill room* means "drill that week" — the
       drill room links out as <drill-url>#week-NN and keeps no other state.
       An in-app click on a pack link is not that, even while Drill is on screen. */
    if (h.indexOf('/') === -1 && fromDrill()) return 'drill/' + head;
    return h;
  }

  if (h.indexOf('/') === -1) {
    /* a bare token: pack anchor while a pack is open, then ask the sections */
    if (APP._route && APP._route.section === 'packs' && APP._route.params.slug) {
      var known = await resolveBare(h);
      if (known) return known;
      return APP._route.params.slug + '/' + h;
    }
    var hit = await resolveBare(h);
    if (hit) return hit;
  }
  return 'today';
}
APP.normalizeHash = normalizeHash;

function parseRoute(h) {
  var parts = h.split('/');
  var head = parts[0];
  var rest = parts.slice(1).join('/');
  var r = { section: 'today', params: {}, raw: h };

  if (head === 'search') { r.section = 'search'; r.params.q = decodeURIComponent(rest || ''); return r; }
  if (head === 'demo') { r.section = 'demos'; r.params.slug = rest; return r; }
  if (/^demo-week-(\d{1,2})$/.test(head)) {
    r.section = 'demos'; r.params.week = Number(head.match(/(\d{1,2})$/)[1]); return r;
  }
  if (isPackSlug(head)) { r.section = 'packs'; r.params.slug = head; if (rest) r.params.anchor = rest; return r; }
  if (isDemoSlug(head)) { r.section = 'demos'; r.params.slug = head; return r; }

  if (SECTION_NAMES[head] === 1) {
    r.section = head;
    if (!rest) return r;
    var mm;
    if (head === 'map') {
      if ((mm = rest.match(/^node=(.+)$/))) r.params.node = decodeURIComponent(mm[1]);
      else if ((mm = rest.match(/^q=(.*)$/))) r.params.q = decodeURIComponent(mm[1]);
      else r.params.node = decodeURIComponent(rest);
    } else if (head === 'sprint') {
      if ((mm = rest.match(/^day-([1-9])$/))) r.params.day = Number(mm[1]);
    } else if (head === 'cases') {
      r.params.id = decodeURIComponent(rest);
    } else if (head === 'drill') {
      /* #drill/<slug> and #drill/<slug>/<concept> (SPEC §7 covers only the first). */
      var dparts = rest.split('/');
      r.params.slug = decodeURIComponent(dparts[0]);
      if (dparts.length > 1) r.params.concept = decodeURIComponent(dparts.slice(1).join('/'));
    } else if (head === 'plan') {
      r.params.anchor = decodeURIComponent(rest);
    } else if (head === 'packs' || head === 'demos') {
      r.params.slug = decodeURIComponent(rest);
    }
    return r;
  }
  return r;
}
APP.route = function () { return APP._route; };
APP.onRoute = function (cb) {
  routeListeners.push(cb);
  return function off() { var i = routeListeners.indexOf(cb); if (i >= 0) routeListeners.splice(i, 1); };
};

var navLock = false;
APP.navigate = function (hash, opts) {
  var h = stripHash(hash) || 'today';
  var target = '#' + h;
  if (location.hash === target) { handleHash(); return; }
  if (opts && opts.replace) { history.replaceState(null, '', target); handleHash(); }
  else location.hash = target;
};

var visibleSection = null;
var routeSeq = 0;

async function handleHash() {
  var seq = ++routeSeq;
  var raw = stripHash(location.hash);
  var h;
  try { h = await normalizeHash(raw); }
  catch (e) { console.warn('normalizeHash failed', e); h = 'today'; }
  if (seq !== routeSeq) return;

  if (h !== raw) {
    navLock = true;
    try { history.replaceState(null, '', '#' + h); } finally { navLock = false; }
  }

  var r = parseRoute(h);

  /* #search/<q> opens the panel and leaves the section alone (SPEC §7). */
  if (r.section === 'search') {
    if (typeof APP.openSearch === 'function') APP.openSearch(r.params.q);
    return;
  }

  APP._route = r;
  _clickInDrill = false;
  await showSection(r);
  for (var i = 0; i < routeListeners.length; i++) {
    try { routeListeners[i](r); } catch (e) { console.warn('onRoute listener failed', e); }
  }
}

var lastRaw = null;

async function showSection(r) {
  var id = r.section;
  var el = containerFor(id);

  /* Remember where the user was — keyed by the exact route as well as by the
     section, so #packs comes back to the row you left it on even though
     #week-07 lives in the same container. */
  if (visibleSection) {
    var leavingEl = document.getElementById('app-sec-' + visibleSection);
    if (leavingEl && !leavingEl.hidden) {
      if (lastRaw) APP._scroll[lastRaw] = leavingEl.scrollTop;
      APP._scroll[visibleSection] = leavingEl.scrollTop;
    }
  }

  if (visibleSection && visibleSection !== id) {
    var prev = sections[visibleSection];
    var prevEl = document.getElementById('app-sec-' + visibleSection);
    if (prevEl) prevEl.hidden = true;
    if (prev && prev.def && typeof prev.def.unmount === 'function') {
      try { prev.def.unmount(prevEl); } catch (e) { console.warn('unmount failed: ' + visibleSection, e); }
    }
  }
  lastRaw = r.raw;

  el.hidden = false;
  visibleSection = id;
  paintNav(id);

  var rec = sections[id];
  if (!rec) { renderAbsent(el, id); restoreScroll(r, id, el); return; }

  try {
    await rec.def.mount(el, r);
    rec.mounted = true;
  } catch (e) {
    console.error('mount failed: ' + id, e);
    if (!el.firstChild) {
      el.appendChild(APP.el('div', { 'class': 'app-sec-pad' }, [
        APP.el('p', { 'class': 'app-empty', text: 'This section failed to load: ' + (e && e.message ? e.message : e) })
      ]));
    }
  }
  restoreScroll(r, id, el);
}

function restoreScroll(r, id, el) {
  var raw = r.raw;
  var y = APP._scroll[raw];
  /* A deep link (#cases/<id>, #week-07/<anchor>, #drill/<slug>/<concept>) must land
     on the item it names. Only an exact repeat of that route may restore a
     remembered position; the section-wide fallback would fight the section's own
     scrollIntoView. */
  if (y == null) {
    for (var k in r.params) if (Object.prototype.hasOwnProperty.call(r.params, k)) return;
    y = APP._scroll[id];
  }
  if (!y) return;
  requestAnimationFrame(function () {
    el.scrollTop = y;
    /* A section that fills itself in asynchronously is not tall enough yet on
       the first frame; try once more before giving up. */
    if (el.scrollTop < y) setTimeout(function () { if (el.scrollTop < y) el.scrollTop = y; }, 140);
  });
}

function renderAbsent(el, id) {
  if (el.getAttribute('data-absent') === '1') return;
  el.setAttribute('data-absent', '1');
  var nav = NAV.filter(function (n) { return n.id === id; })[0];
  el.textContent = '';
  el.appendChild(APP.el('div', { 'class': 'app-sec-pad' }, [
    APP.el('h1', { 'class': 'app-h1', text: (nav ? nav.title : id) }),
    APP.el('p', { 'class': 'app-empty', text: 'This section is not in this build.' })
  ]));
}

/* ====================================================================== nav */

function paintNav(activeId) {
  var list = document.getElementById('app-navlist');
  if (!list) return;
  var links = list.querySelectorAll('.app-navlink');
  for (var i = 0; i < links.length; i++) {
    var on = links[i].getAttribute('data-sec') === activeId;
    if (on) links[i].setAttribute('aria-current', 'page');
    else links[i].removeAttribute('aria-current');
  }
}

function buildNav() {
  var list = document.getElementById('app-navlist');
  if (!list) return;
  list.textContent = '';
  /* Authored order. Rendered once. Never re-sorted (SPEC §6, rule 1). */
  NAV.slice().sort(function (a, b) { return a.navOrder - b.navOrder; }).forEach(function (n) {
    var def = sections[n.id] ? sections[n.id].def : null;
    var a = APP.el('a', {
      'class': 'app-navlink',
      href: '#' + n.hash,
      'data-sec': n.id,
      text: (def && def.title) || n.title
    });
    if (!def) a.setAttribute('data-absent', '1');
    list.appendChild(APP.el('li', { 'class': 'app-navitem' }, [a]));
  });
}

function wireNavToggle() {
  var btn = document.getElementById('app-navtoggle');
  var nav = document.getElementById('app-nav');
  if (!btn || !nav) return;
  function close() { nav.removeAttribute('data-open'); btn.setAttribute('aria-expanded', 'false'); }
  btn.addEventListener('click', function () {
    var open = nav.getAttribute('data-open') === '1';
    if (open) close();
    else { nav.setAttribute('data-open', '1'); btn.setAttribute('aria-expanded', 'true'); }
  });
  nav.addEventListener('click', function (e) { if (e.target.closest('.app-navlink')) close(); });
  window.addEventListener('hashchange', close);
}

/* =================================================================== keys */

function editable(t) {
  if (!t) return false;
  var tag = (t.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable === true;
}

function onTierKey(e) {
  if (e.defaultPrevented) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key !== '1' && e.key !== '2' && e.key !== '3') return;
  var t = e.target;
  if (editable(t)) return;
  APP.setTier(Number(e.key), { announce: true });
}

/* =================================================================== today */
/* APP.schedule() / APP.today() — SPEC §9. today.js renders; this computes. */

var _schedule = null;
APP.schedule = function () { return _schedule; };

function todayISO(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
APP.todayISO = todayISO;
function dayDiff(a, b) { return Math.round((Date.parse(b + 'T00:00:00') - Date.parse(a + 'T00:00:00')) / 86400000); }
APP.dayDiff = dayDiff;

APP.today = function (whenISO) {
  var s = _schedule;
  var today = whenISO || todayISO();
  var out = { date: today, phase: 'gap', week: null, packSlug: null, demoSlugs: [], nextSaturday: null };
  if (!s) return out;

  if (today >= s.sprint.start && today <= s.sprint.end) {
    out.phase = 'sprint';
    out.dayIndex = 1 + dayDiff(s.sprint.start, today);
    out.sprint = s.sprint;
  }

  var weeks = s.weeks || [];
  for (var i = 0; i < weeks.length; i++) {
    var w = weeks[i], next = weeks[i + 1];
    if (today >= w.saturday && (!next || today < next.saturday)) {
      if (out.phase !== 'sprint') out.phase = 'week';
      out.week = w; out.packSlug = w.packSlug; out.demoSlugs = w.demoSlugs || [];
      break;
    }
  }
  for (var j = 0; j < weeks.length; j++) {
    if (weeks[j].saturday >= today) { out.nextSaturday = weeks[j].saturday; out.nextWeek = weeks[j]; break; }
  }
  /* Before W1 (the sprint window, and the gap between) the "current" material is
     the week that is about to start — that is what the user has to prepare. */
  if (!out.week && out.nextWeek) {
    out.week = out.nextWeek;
    out.packSlug = out.nextWeek.packSlug;
    out.demoSlugs = out.nextWeek.demoSlugs || [];
    out.upcoming = true;
  }
  return out;
};

/* ==================================================================== boot */

function fatal(msg) {
  var main = document.getElementById('app-main') || document.body;
  main.textContent = '';
  var p = document.createElement('p');
  p.className = 'app-empty';
  p.style.margin = '24px';
  p.textContent = msg;
  main.appendChild(p);
}

async function boot() {
  if (typeof DecompressionStream !== 'function') {
    fatal('This app needs a browser with DecompressionStream (Chrome 80+, Safari 16.4+, Firefox 113+).');
    return;
  }

  _tier = readTier();
  document.documentElement.setAttribute('data-tara-tier', String(_tier));
  paintTier();

  var tierBox = document.getElementById('app-tier');
  if (tierBox) tierBox.addEventListener('click', function (e) {
    var b = e.target.closest('.app-tierbtn');
    if (b) APP.setTier(Number(b.getAttribute('data-tier')));
  });
  document.addEventListener('keydown', onTierKey, true);

  window.addEventListener('storage', function (e) {
    if (!e || (e.key !== 'tara.tier' && e.key !== 'tara.resolution')) return;
    var n = readTier();
    if (n !== _tier) APP.setTier(n);
  });

  try {
    _schedule = await APP.payloadJSON('schedule');
    PACK_SLUGS = _schedule.weeks.map(function (w) { return w.packSlug; })
      .filter(function (x, i, a) { return x && a.indexOf(x) === i; });
    if (_schedule.bonus && _schedule.bonus.slug) PACK_SLUGS.push(_schedule.bonus.slug);
    DEMO_SLUGS = [];
    _schedule.weeks.forEach(function (w) {
      (w.demoSlugs || []).forEach(function (d) { if (DEMO_SLUGS.indexOf(d) < 0) DEMO_SLUGS.push(d); });
    });
    APP.packSlugs = PACK_SLUGS.slice();
    APP.demoSlugs = DEMO_SLUGS.slice();
  } catch (e) {
    console.error('schedule payload failed', e);
    APP.packSlugs = []; APP.demoSlugs = [];
  }

  buildNav();
  wireNavToggle();

  if (typeof APP._initReview === 'function') APP._initReview();
  if (typeof APP._initSearch === 'function') APP._initSearch();
  if (typeof APP._initNowLine === 'function') APP._initNowLine();

  window.addEventListener('hashchange', function () { if (!navLock) handleHash(); });
  await handleHash();
  document.documentElement.setAttribute('data-app-ready', '1');
}

/* Every module in the bundle is parsed before this fires, so today/search/review
   and any section files from B and C are registered by the time boot runs. */
setTimeout(function () {
  boot().catch(function (e) {
    console.error('boot failed', e);
    fatal('The app failed to start: ' + (e && e.message ? e.message : e));
  });
}, 0);

})();

/* ===== src/shell/today.js ===== */
;(function(){
/* app/src/shell/today.js — SPEC §9. The default view: what to do right now.
   Six fixed row slots, built once, then text-swapped in place. Owner: Worker A. */

'use strict';

var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
var DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function pretty(iso) {
  if (!iso) return '';
  var d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return iso;
  return DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MON[d.getMonth()];
}

function titleCaseSlug(slug) {
  return String(slug || '').replace(/-/g, ' ').replace(/\b([a-z])/g, function (m, c) { return c.toUpperCase(); });
}

/* Six slots. The order is the order; nothing is ever inserted or moved. */
var SLOTS = [
  { key: 'now',    label: 'Right now' },
  { key: 'pack',   label: 'Pack' },
  { key: 'demo',   label: 'Demo' },
  { key: 'drill',  label: 'Drill' },
  { key: 'review', label: 'Review' },
  { key: 'sprint', label: 'Sprint' }
];

function buildOnce(el) {
  if (el.getAttribute('data-built') === '1') return;
  el.setAttribute('data-built', '1');
  el.textContent = '';

  var pad = APP.el('div', { 'class': 'app-sec-pad app-today' });
  var line = APP.el('p', { 'class': 'app-todayline', id: 'app-todayline' });
  var rows = APP.el('div', { 'class': 'app-rows', id: 'app-todayrows' });

  SLOTS.forEach(function (s) {
    var a = APP.el('a', { 'class': 'app-row', href: '#today', 'data-slot': s.key });
    a.appendChild(APP.el('span', { 'class': 'app-row-k', text: s.label }));
    var body = APP.el('span', { 'class': 'app-row-t' });
    body.appendChild(APP.el('span', { 'class': 'app-row-title' }));
    body.appendChild(APP.el('span', { 'class': 'app-row-s' }));
    a.appendChild(body);
    a.appendChild(APP.el('span', { 'class': 'app-row-go', text: '→', 'aria-hidden': 'true' }));
    rows.appendChild(a);
  });

  pad.appendChild(line);
  pad.appendChild(rows);
  el.appendChild(pad);
}

function setRow(el, key, spec) {
  var a = el.querySelector('.app-row[data-slot="' + key + '"]');
  if (!a) return;
  if (!spec) { a.hidden = true; return; }
  a.hidden = false;
  a.setAttribute('href', '#' + String(spec.hash).replace(/^#/, ''));
  a.querySelector('.app-row-title').textContent = spec.title;
  a.querySelector('.app-row-s').textContent = spec.sub || '';
  if (spec.primary) a.setAttribute('data-primary', '1'); else a.removeAttribute('data-primary');
}

function describe(t) {
  var s = APP.schedule();
  if (!s) return { line: 'The schedule did not load.', rows: {} };

  var w = t.week;
  var rows = {};
  var line;

  if (t.phase === 'sprint') {
    line = 'Crash sprint, day ' + t.dayIndex + ' of ' + s.sprint.days +
           (w ? ' · week ' + w.n + ' (' + w.chapter + ') starts ' + pretty(w.saturday) : '');
    rows.now = {
      title: 'Sprint day ' + t.dayIndex,
      sub: 'One page a day, exercises run in the browser · ends ' + pretty(s.sprint.end),
      hash: 'sprint/day-' + t.dayIndex, primary: true
    };
    rows.sprint = { title: 'All seven sprint days', sub: pretty(s.sprint.start) + ' – ' + pretty(s.sprint.end), hash: 'sprint' };
  } else if (t.phase === 'week' && w) {
    line = 'Week ' + w.n + ' · ' + w.chapter + ' · Saturday ' + pretty(w.saturday);
    rows.now = {
      title: 'Week ' + w.n + ' pack — ' + w.chapter,
      sub: w.arena || '', hash: w.packSlug || 'packs', primary: true
    };
    rows.sprint = { title: 'Crash sprint', sub: 'Seven prerequisite evenings · ' + pretty(s.sprint.start) + ' – ' + pretty(s.sprint.end), hash: 'sprint' };
  } else {
    line = w
      ? 'Between Saturdays · week ' + w.n + ' (' + w.chapter + ') starts ' + pretty(t.nextSaturday)
      : 'The course calendar has run out.';
    rows.now = w
      ? { title: 'Get ahead on week ' + w.n, sub: w.arena || w.chapter, hash: w.packSlug || 'packs', primary: true }
      : { title: 'The plan', sub: 'Fourteen Saturdays', hash: 'plan', primary: true };
    rows.sprint = { title: 'Crash sprint', sub: pretty(s.sprint.start) + ' – ' + pretty(s.sprint.end), hash: 'sprint' };
  }

  if (w && w.packSlug) {
    rows.pack = {
      title: 'Study pack — ' + titleCaseSlug(w.packSlug),
      sub: w.arena || w.chapter, hash: w.packSlug
    };
    rows.drill = {
      title: 'Drill week ' + w.n,
      sub: 'Eight questions from this week’s bank', hash: 'drill/' + w.packSlug
    };
  }

  var demos = (w && w.demoSlugs) || [];
  if (demos.length === 1) {
    rows.demo = { title: 'Demo — ' + titleCaseSlug(demos[0]), sub: 'Interactive, one idea', hash: 'demo/' + demos[0] };
  } else if (demos.length > 1) {
    rows.demo = {
      title: demos.length + ' demos this week',
      sub: demos.map(titleCaseSlug).join(' · '),
      hash: 'demo-week-' + String(w.n).padStart(2, '0')
    };
  }

  return { line: line, rows: rows };
}

function reviewRow() {
  var items = [];
  try { items = APP.review.list() || []; } catch (e) { items = []; }
  if (!items.length) return { title: 'Review queue is empty', sub: 'Select a sentence in any page and save it', hash: 'today' };
  var today = APP.todayISO();
  var due = items.filter(function (i) { return i && i.due && String(i.due).slice(0, 10) <= today; });
  return {
    title: (due.length ? due.length + ' due' : items.length + ' saved') + ' in the review queue',
    sub: due.length ? 'Oldest: ' + (due[0].text || '').slice(0, 90) : (items[0].text || '').slice(0, 90),
    hash: 'today'
  };
}

function render(el) {
  buildOnce(el);
  var t = APP.today();
  var d = describe(t);
  var line = el.querySelector('#app-todayline');
  if (line) line.textContent = d.line;
  SLOTS.forEach(function (s) {
    setRow(el, s.key, s.key === 'review' ? reviewRow() : d.rows[s.key]);
  });
}

APP.registerSection({
  id: 'today',
  title: 'Now',
  navOrder: 0,
  mount: async function (el) { render(el); },
  onTier: function () { /* the today panel has no tiered prose */ }
});

/* Review row must follow the queue without re-rendering the whole panel. */
window.addEventListener('tara:review', function () {
  var el = document.getElementById('app-sec-today');
  if (el && el.getAttribute('data-built') === '1') setRow(el, 'review', reviewRow());
});

/* The one short line, repeated in the chrome so it is visible from any section. */
APP._initNowLine = function () {
  var box = document.getElementById('app-now');
  if (!box) return;
  var t = APP.today();
  var s = APP.schedule();
  if (!s) { box.textContent = ''; return; }
  if (t.phase === 'sprint') box.textContent = 'Sprint day ' + t.dayIndex + ' of ' + s.sprint.days + (t.week ? ' · week ' + t.week.n + ' ' + pretty(t.week.saturday) : '');
  else if (t.phase === 'week' && t.week) box.textContent = 'Week ' + t.week.n + ' · ' + t.week.chapter;
  else if (t.week) box.textContent = 'Week ' + t.week.n + ' starts ' + pretty(t.nextSaturday);
  else box.textContent = '';
};

/* Escape hatch used by the sections that need a friendly slug label. */
APP.titleCaseSlug = titleCaseSlug;
APP.prettyDate = pretty;

})();

/* ===== src/shell/search.js ===== */
;(function(){
/* app/src/shell/search.js — SPEC §8. One box, one grouped result list.
   Groups render in navOrder and their order never changes; only the rows inside
   them do. Selecting a row navigates — it never filters a section. Owner: Worker A. */

'use strict';

var SEARCH_CAP = 8;
var _open = false;
var _q = '';
var _seq = 0;

/* Shared scorer so every section ranks identically (SPEC §8). */
APP.score = function (q, rec) {
  if (!q) return 0;
  var Q = String(q).toLowerCase().trim();
  if (!Q) return 0;
  var id = String(rec.id || '').toLowerCase();
  var title = String(rec.title || '').toLowerCase();
  var body = String(rec.body || '').toLowerCase();
  if (id && id === Q) return 100;
  if (title.indexOf(Q) === 0) return 60;
  if (title.indexOf(Q) >= 0) return 40;
  if (id.indexOf(Q) >= 0) return 40;
  if (body.indexOf(Q) >= 0) return 15;
  return 0;
};

APP.search = async function (q) {
  var groups = [];
  var ids = APP.NAV.map(function (n) { return n.id; });
  for (var i = 0; i < ids.length; i++) {
    var rec = APP._sections[ids[i]];
    if (!rec || typeof rec.def.search !== 'function') continue;
    var navEntry = APP.NAV.filter(function (n) { return n.id === rec.def.id; })[0];
    var g = { id: rec.def.id, title: (navEntry && navEntry.title) || rec.def.title || rec.def.id, rows: [] };
    if (q) {
      try {
        var rows = await rec.def.search(q);
        if (Array.isArray(rows)) {
          rows = rows.filter(function (r) { return r && r.hash; });
          rows.sort(function (a, b) {
            var d = (b.score || 0) - (a.score || 0);
            if (d) return d;
            return String(a.title || '').localeCompare(String(b.title || ''));
          });
          g.rows = rows.slice(0, SEARCH_CAP);
        }
      } catch (e) {
        console.warn('search failed in section ' + g.id, e);
      }
    }
    groups.push(g);
  }
  return groups;
};

function panel() { return document.getElementById('app-searchpanel'); }
function body() { return document.getElementById('app-searchresults'); }

function renderGroups(groups, q) {
  var b = body();
  if (!b) return;
  b.textContent = '';
  var total = 0;
  if (!groups.length) {
    b.appendChild(APP.el('p', { 'class': 'app-none', text: 'No searchable sections are in this build.' }));
    return 0;
  }
  groups.forEach(function (g) {
    var wrap = APP.el('div', { 'class': 'app-group', 'data-group': g.id });
    wrap.appendChild(APP.el('div', { 'class': 'app-group-h', text: g.title + (g.rows.length ? ' · ' + g.rows.length : '') }));
    if (!g.rows.length) {
      wrap.setAttribute('data-empty', '1');
      wrap.appendChild(APP.el('div', { 'class': 'app-none', text: q ? 'no match' : '—' }));
    } else {
      g.rows.forEach(function (r) {
        var a = APP.el('a', { 'class': 'app-hit', href: '#' + String(r.hash).replace(/^#/, '') });
        a.appendChild(APP.el('span', { 'class': 'app-hit-t', text: r.title || r.hash }));
        if (r.sub) a.appendChild(APP.el('span', { 'class': 'app-hit-s', text: r.sub }));
        wrap.appendChild(a);
        total++;
      });
    }
    b.appendChild(wrap);
  });
  return total;
}

async function run(q) {
  var seq = ++_seq;
  _q = q;
  var t = document.getElementById('app-searchtitle');
  if (t) t.textContent = q ? 'Search — “' + q + '”' : 'Search';
  var groups = await APP.search(q);
  if (seq !== _seq) return;
  var n = renderGroups(groups, q);
  if (t && q) t.textContent = 'Search — ' + n + (n === 1 ? ' result' : ' results');
}

APP.openSearch = function (q) {
  var p = panel();
  if (!p) return;
  if (typeof APP.closeReview === 'function') APP.closeReview();
  p.hidden = false;
  _open = true;
  var box = document.getElementById('app-searchbox');
  if (box && q != null && box.value !== q) box.value = q;
  run(q != null ? q : (box ? box.value : ''));
};

APP.closeSearch = function () {
  var p = panel();
  if (!p) return;
  p.hidden = true;
  _open = false;
  /* Leaving #search/<q> in the URL would re-open the panel on the next route
     event; hand the URL back to the section that is actually on screen. */
  if (/^#search\//.test(location.hash)) {
    var r = APP._route;
    var back = r ? r.raw : 'today';
    history.replaceState(null, '', '#' + back);
  }
};

APP.isSearchOpen = function () { return _open; };

APP._initSearch = function () {
  var form = document.getElementById('app-searchform');
  var box = document.getElementById('app-searchbox');
  var p = panel();
  if (!form || !box || !p) return;

  var t = 0;
  box.addEventListener('input', function () {
    clearTimeout(t);
    var v = box.value;
    t = setTimeout(function () {
      if (!v.trim()) { APP.closeSearch(); return; }
      APP.openSearch(v);
    }, 140);
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = box.value.trim();
    if (!v) return;
    APP.navigate('search/' + encodeURIComponent(v));
  });

  box.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { box.blur(); APP.closeSearch(); }
    if (e.key === 'ArrowDown') {
      var first = p.querySelector('.app-hit');
      if (first) { e.preventDefault(); first.focus(); }
    }
  });

  p.addEventListener('click', function (e) {
    if (e.target.closest('[data-close="search"]')) { APP.closeSearch(); return; }
    var hit = e.target.closest('.app-hit');
    if (hit) APP.closeSearch();       /* the anchor's own href does the navigating */
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && _open) APP.closeSearch();
  });

  document.addEventListener('click', function (e) {
    if (!_open) return;
    if (e.target.closest('#app-searchpanel') || e.target.closest('#app-searchform')) return;
    APP.closeSearch();
  });
};

})();

/* ===== src/shell/review.js ===== */
;(function(){
/* app/src/shell/review.js — SPEC §6. One review queue for the whole app.
   Storage is localStorage["tara.review"], the exact shape tara-layer.js writes,
   so the shell and every same-origin frame share one queue. Owner: Worker A. */

'use strict';

var K = 'tara.review';
var MAX = 300;
var _open = false;

function layer() {
  try {
    if (window.TARA && window.TARA.review && typeof window.TARA.review.list === 'function') return window.TARA.review;
  } catch (e) {}
  return null;
}

function read() {
  var raw = APP._ls.get(K);
  if (!raw) return [];
  try {
    var v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(Boolean) : [];
  } catch (e) { return []; }
}

function write(items) {
  if (items.length > MAX) items = items.slice(items.length - MAX);
  APP._ls.set(K, JSON.stringify(items));
  changed();
}

function changed() {
  paintBadge();
  if (_open) renderPanel();
  try { window.dispatchEvent(new CustomEvent('tara:review', { detail: { count: APP.review.list().length } })); } catch (e) {}
}

function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

APP.review = {
  list: function () {
    var L = layer();
    if (L) { try { return L.list() || []; } catch (e) {} }
    return read();
  },

  add: function (text, meta) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    var L = layer();
    if (L) { try { var r = L.add(t, meta); changed(); return r; } catch (e) {} }
    var items = read();
    for (var i = 0; i < items.length; i++) if (norm(items[i].text) === norm(t)) return items[i];
    var item = { text: t, title: (document.title || 'TARA').trim(), url: String(location.href), tier: APP.tier(), ts: Date.now() };
    if (meta) for (var k in meta) item[k] = meta[k];
    items.push(item);
    write(items);
    APP.toast('Saved to review');
    return item;
  },

  remove: function (ts) {
    var L = layer();
    if (L) { try { L.remove(ts); changed(); return; } catch (e) {} }
    write(read().filter(function (x) { return x && x.ts !== ts; }));
  },

  clear: function () {
    var L = layer();
    if (L) { try { L.clear(); changed(); return; } catch (e) {} }
    write([]);
  },

  open: function () { APP.openReview(); },
  count: function () { return APP.review.list().length; }
};

function paintBadge() {
  var b = document.getElementById('app-badge');
  if (!b) return;
  var n = APP.review.list().length;
  b.textContent = String(n);
  if (n) b.removeAttribute('data-empty'); else b.setAttribute('data-empty', '1');
}

function renderPanel() {
  var body = document.getElementById('app-reviewbody');
  if (!body) return;
  var items = APP.review.list().slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
  body.textContent = '';
  if (!items.length) {
    body.appendChild(APP.el('p', {
      'class': 'app-none',
      text: 'Nothing saved yet. Select a sentence in any pack, demo or case and choose “Save to review”.'
    }));
    return;
  }
  items.forEach(function (it) {
    var row = APP.el('div', { 'class': 'app-item' });
    var b = APP.el('div', { 'class': 'app-item-b' });
    b.appendChild(APP.el('div', { 'class': 'app-item-t', text: it.text || '' }));
    var when = it.ts ? new Date(it.ts).toISOString().slice(0, 10) : '';
    b.appendChild(APP.el('div', {
      'class': 'app-item-m',
      text: [it.title || '', when, it.tier ? 'tier ' + it.tier : ''].filter(Boolean).join(' · ')
    }));
    row.appendChild(b);
    var x = APP.el('button', { 'class': 'app-item-x', type: 'button', 'aria-label': 'Remove', text: '×' });
    x.addEventListener('click', function () { APP.review.remove(it.ts); });
    row.appendChild(x);
    body.appendChild(row);
  });
}

APP.openReview = function () {
  var p = document.getElementById('app-reviewpanel');
  var btn = document.getElementById('app-reviewbtn');
  if (!p) return;
  if (typeof APP.closeSearch === 'function' && APP.isSearchOpen && APP.isSearchOpen()) APP.closeSearch();
  p.hidden = false;
  _open = true;
  if (btn) btn.setAttribute('aria-expanded', 'true');
  renderPanel();
};

APP.closeReview = function () {
  var p = document.getElementById('app-reviewpanel');
  var btn = document.getElementById('app-reviewbtn');
  if (!p) return;
  p.hidden = true;
  _open = false;
  if (btn) btn.setAttribute('aria-expanded', 'false');
};

APP.toggleReview = function () { if (_open) APP.closeReview(); else APP.openReview(); };

APP._initReview = function () {
  paintBadge();
  var btn = document.getElementById('app-reviewbtn');
  if (btn) btn.addEventListener('click', function (e) { e.stopPropagation(); APP.toggleReview(); });

  var p = document.getElementById('app-reviewpanel');
  if (p) p.addEventListener('click', function (e) {
    if (e.target.closest('[data-close="review"]')) APP.closeReview();
  });

  var clear = document.getElementById('app-reviewclear');
  if (clear) clear.addEventListener('click', function () {
    if (!APP.review.list().length) return;
    APP.review.clear();
    APP.toast('Review queue cleared');
  });

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && _open) APP.closeReview(); });

  document.addEventListener('click', function (e) {
    if (!_open) return;
    if (e.target.closest('#app-reviewpanel') || e.target.closest('#app-reviewbtn')) return;
    APP.closeReview();
  });

  /* A frame writing tara.review is a different document on the same origin, so
     the shell does get a storage event from it. */
  window.addEventListener('storage', function (e) { if (!e || e.key === K) changed(); });
};

})();

/* ===== sections/packs.js ===== */
;(function(){
/* ==========================================================================
   sections/packs.js — the 13 study packs, and the frame kit the other five
   framed sections share.

   Loaded first of Worker B's files (build order in SPEC §3 step 5), so the kit
   is installed on window.__TARA_FK before demos/plan/sprint/manual/map run.
   Every consumer reaches it as window.__TARA_FK at *call* time, never at file
   scope, so build order can change without breaking anything.
   ========================================================================== */
/* global APP */
(function () {
  'use strict';
  if (window.__TARA_FK) return;

  /* --------------------------------------------------------------- tables */

  var PACKS = [
    { slug: 'week-01', label: 'Week 1',  title: 'Einops and Ray Tracing',              sub: '[0.0] Prerequisites · [0.1] Ray Tracing' },
    { slug: 'week-02', label: 'Week 2',  title: 'Modules and ResNets',                 sub: '[0.2] CNNs & ResNets' },
    { slug: 'week-03', label: 'Week 3',  title: 'Optimizers and Sweeps',               sub: '[0.3] Optimization' },
    { slug: 'week-04', label: 'Week 4',  title: 'Your Own Autograd',                   sub: '[0.4] Backprop · [0.5] VAEs & GANs' },
    { slug: 'week-05', label: 'Week 5',  title: 'Transformer From Scratch',            sub: '[1.1] Transformer from Scratch' },
    { slug: 'week-06', label: 'Week 6',  title: 'Hooks and the Cache',                 sub: 'sampling · TransformerLens' },
    { slug: 'week-07', label: 'Week 7',  title: 'Induction Circuits and Patching',     sub: '[1.2] Intro to Mech Interp' },
    { slug: 'week-08', label: 'Week 8',  title: 'Superposition and Sparse Autoencoders', sub: '[1.4.1] IOI · [1.5.4] Superposition · [1.3.3] SAEs' },
    { slug: 'week-09', label: 'Week 9',  title: 'Value Functions and DQN',             sub: '[2.1] Intro to RL · [2.2] DQN, VPG' },
    { slug: 'week-10', label: 'Week 10', title: 'Policy Gradients, PPO and RLHF',      sub: '[2.3] PPO · [2.4] RLHF' },
    { slug: 'week-11', label: 'Week 11', title: 'Eval Design and Inspect',             sub: '[3.1]–[3.5] incl. AI Control' },
    { slug: 'alignment-science',    label: 'Chapter 4', title: 'Model Organisms and Open Problems', sub: 'bonus · background from W8 · capstone source' },
    { slug: 'capstone-weeks-12-14', label: 'W12–14',    title: 'Three Saturdays and a Talk',        sub: 'capstone · final presentation 12 Dec' }
  ];

  var DEMOS = [
    { slug: 'tensors-einops',           title: 'Einops Bench',                     weeks: [1] },
    { slug: 'convolutions-cnn',         title: 'Sliding Window Lab',               weeks: [2] },
    { slug: 'backprop-training',        title: 'Backprop Bench',                   weeks: [3, 4] },
    { slug: 'transformer-block',        title: 'Residual Stream Anatomy',          weeks: [5] },
    { slug: 'sampling-decoding',        title: "Decoder's Bench",                  weeks: [5] },
    { slug: 'residual-stream-bus',      title: 'Residual Stream Bus',              weeks: [5, 6] },
    { slug: 'induction-heads-patching', title: 'Induction Circuit Workbench',      weeks: [7] },
    { slug: 'superposition-sae',        title: 'Superposition Bench',              weeks: [8] },
    { slug: 'rl-foundations-dqn',       title: 'Bellman to DQN',                   weeks: [9] },
    { slug: 'policy-gradients-ppo',     title: 'Reading the PPO Objective',        weeks: [10] },
    { slug: 'rlhf-overoptimisation',    title: 'The Overoptimisation Curve',       weeks: [10] },
    { slug: 'evals-pipeline',           title: 'The Measurement Is Not the Property', weeks: [11] },
    { slug: 'steering-persona-vectors', title: 'Persona Vector Bench',             weeks: [12] }
  ];

  /* Published-artifact uuid -> the route that now holds that page. Used only to
     keep clicks *inside* the app; nothing is rewritten in the stored bytes. */
  var URL2HASH = {
    'e79da475-aeb2-4350-a639-9be5b33eac50': '#week-01',
    'ab7159ab-c864-42c0-89de-41d0b340f0f6': '#week-02',
    '05bc0689-0163-428a-a580-ff3d539dbc10': '#week-03',
    'fb6e3102-08fe-41b7-a11c-f871e47c07b0': '#week-04',
    'b6eb1f5b-bbb5-476d-8e19-fb6bd2a4ad50': '#week-05',
    '7d8c5235-ecbe-4d31-b424-32a6f57bec73': '#week-06',
    'a7d50b7a-ac24-4365-8b81-b6eaa641de90': '#week-07',
    '9d492ed6-53c0-48e2-847e-000cf294bc59': '#week-08',
    '641c5d41-6744-4dda-aba1-c285e481ffc2': '#week-09',
    '12b22ee1-7be6-452c-a680-887437324f52': '#week-10',
    'ac4e396c-17d0-4e54-9864-387098d15e46': '#week-11',
    '737542f2-9ee3-4283-8676-340bc452c1b3': '#week-alignment-science',
    '523921d4-9788-4819-a3fe-4fe23c3bdf86': '#week-capstone-weeks-12-14',
    '920e23ec-256b-4f12-ae2e-cd9605ae08b8': '#demo/tensors-einops',
    '6a9118aa-9dbb-4e5a-8c32-0c6b7993730b': '#demo/convolutions-cnn',
    'd7d20812-f5b9-4d0c-820f-97c4e37aebd8': '#demo/backprop-training',
    'ca51b950-60f1-46cb-96fa-c62d1cd891e1': '#demo/transformer-block',
    'fb72d423-a493-47d6-bce4-669c9ada6b1d': '#demo/sampling-decoding',
    'efbf7372-bec0-4067-a650-898b543ba0ff': '#demo/residual-stream-bus',
    'd7cf4c22-2ff8-4502-8755-2823aa26bb85': '#demo/induction-heads-patching',
    'adefe783-4539-456d-bec9-5b3a6999f50a': '#demo/superposition-sae',
    '136bb50c-0a86-4129-95d0-c68d95c556be': '#demo/rl-foundations-dqn',
    'fe068b1c-e5e3-4883-ad00-9c2d8064eb86': '#demo/policy-gradients-ppo',
    '3f01988f-2fa3-4e57-b896-cc9823cbc9b6': '#demo/rlhf-overoptimisation',
    'b2724f82-2b83-442d-814a-c8fcf8c37791': '#demo/evals-pipeline',
    '30e29e60-dcb6-41f7-ba2d-d434bc2a0af5': '#demo/steering-persona-vectors',
    '2387b9cb-110d-49b5-b772-ded4804682a8': '#plan',
    '344077c2-aff3-49ea-be40-5a39844a698e': '#map',
    'f40cee0d-e9eb-4cd6-a410-1411bb4f4c30': '#cases',
    '438d8cfc-21dd-4b71-a51b-bc64923e8bc2': '#drill',
    'ca2002f6-eb38-447d-82c7-e2ac9961546a': '#sprint',
    '7ffef4c4-c902-4d05-95c7-a9aae13624d8': '#manual',
    '267222f4-202c-4030-9e9a-4924592f3df3': '#manual'
  };

  var PACK_BY = {}, DEMO_BY = {};
  PACKS.forEach(function (p, i) { p.order = i; PACK_BY[p.slug] = p; });
  DEMOS.forEach(function (d, i) { d.order = i; DEMO_BY[d.slug] = d; });

  /* ---------------------------------------------------------- string bits */

  function scriptSafe(s) {
    return String(s).replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
  }
  function jsonLit(v) { return scriptSafe(JSON.stringify(v === undefined ? null : v)); }

  /* Several demos call history.replaceState('#tab') to remember a tab. Inside an
     `about:srcdoc` frame that throws (the document has no usable URL to rewrite)
     and the page logs an uncaught error on every tab click. Turning both history
     writers into no-ops before any of the page's own script runs costs nothing —
     the frame has no address bar to keep in sync — and the tab still switches. */
  var PRELUDE =
    '<script>/*app*/try{history.replaceState=function(){};history.pushState=function(){};}' +
    'catch(e){}<\/script>';

  /* A prelude has to run first. Fragment documents (every pack, every demo, the
     plan, the manual) take it at the very top; a complete document takes it just
     inside <body>, where it still precedes every script the page carries. */
  function prelude(html, extra) {
    var block = PRELUDE + (extra || '');
    var m = /<body[^>]*>/i.exec(html);
    if (m && m.index < 4000) {
      var at = m.index + m[0].length;
      return html.slice(0, at) + '\n' + block + '\n' + html.slice(at);
    }
    return block + '\n' + html;
  }

  /* Insert a block before the last </body>, or append. Same rule as apply.js —
     most packs and demos have no </body> at all. */
  function splice(html, block) {
    var i = html.toLowerCase().lastIndexOf('</body>');
    if (i === -1) return html + '\n' + block + '\n';
    return html.slice(0, i) + block + '\n' + html.slice(i);
  }

  /* The apply.js envelope mapping, ported (SPEC §11). The only deltas: the four
     nav URLs become in-app hashes, because the app is one page now. */
  function envelopeConfig(env) {
    env = env || {};
    var known = ['content', 'explain', 'glossary', 'options', 'mapUrl', 'planUrl',
      'casesUrl', 'drillUrl', 'stickyOffset', 'controlOffset'];
    var isEnvelope = known.some(function (k) {
      return Object.prototype.hasOwnProperty.call(env, k);
    });
    if (!isEnvelope) env = { content: env };

    var options = Object.assign({}, env.options || {});
    var co = Object.assign({}, env.controlOffset || options.controlOffset || {});
    if (Object.keys(co).length) options.controlOffset = co;

    var lines = ['/* per-page content for the TARA reading layer (ported apply.js) */'];
    if (env.content) lines.push('window.TARA_CONTENT=' + jsonLit(env.content) + ';');
    if (env.explain) lines.push('window.TARA_EXPLAIN=' + jsonLit(env.explain) + ';');
    if (env.glossary) lines.push('window.TARA_GLOSSARY_EXTRA=' + jsonLit(env.glossary) + ';');
    if (Object.keys(options).length) lines.push('window.TARA_OPTIONS=' + jsonLit(options) + ';');
    var sticky = env.stickyOffset;
    if (sticky != null && sticky !== '' && !isNaN(parseFloat(sticky))) {
      lines.push('window.TARA_STICKY_OFFSET=' + parseFloat(sticky) + ';');
    }
    return lines;
  }

  /* --------------------------------------------------- the child-side boot */
  /* Runs inside every frame. Same-origin, so it can reach the shell directly. */

  var CHILD_JS = [
    '(function(){',
    '"use strict";',
    'window.__TARA_APP=1;',
    'var P=null; try{ P=(window.parent&&window.parent!==window)?window.parent:null; }catch(e){}',
    'function app(){ try{ return (P&&P.APP)?P.APP:null; }catch(e){ return null; } }',
    'window.__app=app;',

    /* 1. one visible tier control. The layer keeps its glossary popover and its
          select-to-explain popup — those live in the same shadow root as the
          control, so hiding the whole host would take them with it. */
    'function hideChildControl(){',
    '  try{',
    '    var h=document.querySelector("[data-tara-host]");',
    '    if(!h) return false;',
    '    if(h.shadowRoot){',
    '      if(!h.shadowRoot.querySelector("#app-hide-control")){',
    '        var s=document.createElement("style"); s.id="app-hide-control";',
    '        s.textContent=".control,.pill{display:none!important}";',
    '        h.shadowRoot.appendChild(s);',
    '      }',
    '      return true;',
    '    }',
    '    h.style.setProperty("display","none","important"); return true;',
    '  }catch(e){ return false; }',
    '}',
    'window.addEventListener("tara:ready",hideChildControl);',
    'hideChildControl();',
    'var _n=0,_iv=setInterval(function(){ if(hideChildControl()||++_n>60) clearInterval(_iv); },50);',

    /* 2. keep every link inside the app */
    'var U2H=window.__APP_URL2HASH||{};',
    'function hasId(id){ try{ return !!(id&&document.getElementById(id)); }catch(e){ return false; } }',
    'window.__toAppHash=function(href){',
    '  href=String(href||"");',
    '  if(!href) return null;',
    '  var m=/\\/artifact\\/([0-9a-f-]{36})(?:[?][^#]*)?(#.*)?$/i.exec(href);',
    '  if(m){',
    '    var base=U2H[m[1].toLowerCase()]; if(!base) return null;',
    '    var frag=(m[2]||"").replace(/^#/,"");',
    '    if(!frag) return base;',
    '    var f=frag.match(/^node=(.+)$/); if(f) return "#map/node="+f[1];',
    '    var q=frag.match(/^q=(.*)$/);   if(q) return "#map/q="+q[1];',
    '    if(base==="#cases") return "#cases/"+frag;',
    '    if(base==="#drill") return "#drill/"+frag;',
    '    if(base==="#map")   return "#map/node="+frag;',
    '    if(/^#(week-|demo\\/|plan|sprint|manual)/.test(base)) return base+"/"+frag;',
    '    return base;',
    '  }',
    '  if(href.charAt(0)!=="#") return null;',
    '  var h=href.slice(1);',
    '  if(!h) return null;',
    '  var f2=h.match(/^node=(.+)$/); if(f2) return "#map/node="+f2[1];',
    '  var q2=h.match(/^q=(.*)$/);    if(q2) return "#map/q="+q2[1];',
    /*    an in-page anchor that actually exists here always wins */
    '  if(hasId(h)||hasId(decodeURIComponent(h))) return null;',
    '  if(/^(today|plan|packs|demos|map|cases|drill|sprint|manual)(\\/|$)/.test(h)) return "#"+h;',
    '  if(/^(week-|demo-week-|demo\\/)/.test(h)) return "#"+h;',
    '  return null;',
    '};',
    'document.addEventListener("click",function(ev){',
    '  if(ev.defaultPrevented||ev.button||ev.metaKey||ev.ctrlKey||ev.shiftKey||ev.altKey) return;',
    '  var path=ev.composedPath?ev.composedPath():[ev.target], a=null;',
    '  for(var i=0;i<path.length;i++){ var n=path[i]; if(n&&n.tagName==="A"&&n.getAttribute){ a=n; break; } }',
    '  if(!a) return;',
    '  var to=window.__toAppHash(a.getAttribute("href"));',
    '  if(!to) return;',
    '  var A=app(); if(!A||!A.navigate) return;',
    '  ev.preventDefault(); ev.stopPropagation();',
    '  A.navigate(to);',
    '},true);',

    /* 3. tier, both ways */
    'window.addEventListener("tara:tier",function(ev){',
    '  var A=app(); if(!A||!A.setTier||!A.tier) return;',
    '  var t=ev&&ev.detail&&ev.detail.tier;',
    '  if((t===1||t===2||t===3)&&A.tier()!==t){ try{ A.setTier(t); }catch(e){} }',
    '});',
    /*    frames with no reading layer (sprint, map) still answer 1/2/3 */
    'document.addEventListener("keydown",function(ev){',
    '  if(window.TARA) return;',
    '  if(ev.metaKey||ev.ctrlKey||ev.altKey) return;',
    '  var t=ev.target;',
    '  while(t&&t.nodeType!==1) t=t.parentNode;',
    '  while(t&&t.nodeType===1){',
    '    var g=t.tagName;',
    '    if(g==="INPUT"||g==="TEXTAREA"||g==="SELECT"||t.isContentEditable) return;',
    '    t=t.parentNode;',
    '  }',
    '  if(ev.key!=="1"&&ev.key!=="2"&&ev.key!=="3") return;',
    '  var A=app(); if(!A||!A.setTier) return;',
    '  try{ A.setTier(parseInt(ev.key,10)); }catch(e){}',
    '});',

    /* 4. hold the reading position across a tier change.
          Tier 1 text is shorter than tier 3, so every box between the top of
          the document and the viewport grows or shrinks and the sentence you
          were reading slides away — the published pages have always done this.

          What can be held exactly: the reading layer swaps a whole tier group
          (a card) at a time, so a group's *box* changes height but every group
          boundary survives. Anchoring to a boundary and putting it back where
          it was is therefore exact, to the pixel. Anchoring to anything inside
          a group is not: at another tier that element is hidden (inline
          variants) or gone (external variants), and its rect reads 0.

          Which boundary: the surviving one nearest the top of the viewport,
          either side of it. Whatever sits between the anchor and the fold is
          the only content whose height change can still move the screen, so
          nearest-to-the-fold minimises it. Preferring the first boundary BELOW
          the fold reads better on paper and measures worse: when the next
          boundary is most of a screen down, everything above it slides instead
          (measured 4197 px on week-06, against 698 px unanchored).

          The correctness fix over the first cut is `survives`: the old rule
          took any [id], including ids inside a tier group. At another tier that
          element is hidden or replaced, its rect reads all zeros, and putting
          "it" back scrolls the page to an arbitrary place.

          It only ever adjusts scrollTop; no layout is touched. */
    'function pinned(n){',
    '  for(var e=n;e&&e.nodeType===1;e=e.parentElement){',
    '    var p=getComputedStyle(e).position;',
    '    if(p==="fixed"||p==="sticky") return true;',
    '  }',
    '  return false;',
    '}',
    /*    A candidate has to survive the swap. Group containers do; anything
          inside one does not. Anything outside every group does. */
    'function survives(e){',
    '  try{',
    '    if(e.hasAttribute("data-tier-group")) return true;',
    '    if(e.closest("[data-tier-group]")) return false;',
    '    if(e.closest("[data-tara-host]")) return false;',
    '    return true;',
    '  }catch(x){ return false; }',
    '}',
    'var SNAP_SEL="[data-tier-group],[id],h1,h2,h3,h4,h5,h6";',
    'var SNAP_PAD=8;',
    /*    A chain of tier changes has to be reversible. Each step is exact for
          the boundary it picks, but a fresh pick each time composes into drift
          (measured 372 px on week-07 for 2 -> 3 -> 1 -> 2). So the anchor is
          sticky: while the scroll position is still exactly where the last
          correction left it — i.e. the reader has not scrolled since — the same
          element and the same offset are reused, and the chain returns to the
          pixel it started on. The first scroll of the wheel drops it. */
    'var lastEl=null, lastTop=0, lastST=null;',
    'function snapTop(){',
    '  try{',
    '    var se=document.scrollingElement||document.documentElement;',
    '    if(!se||se.scrollTop<=0) return null;',
    '    if(lastEl && lastST!==null && Math.abs(se.scrollTop-lastST)<=1){',
    '      try{',
    '        if(lastEl.isConnected!==false){',
    '          var lr=lastEl.getBoundingClientRect();',
    '          if(lr.height||lr.width) return { el:lastEl, top:lastTop, se:se, sticky:1 };',
    '        }',
    '      }catch(x){}',
    '      lastEl=null; lastST=null;',
    '    }',
    '    var vh=window.innerHeight||0;',
    '    var all=document.querySelectorAll(SNAP_SEL);',
    '    var best=null, bd=1e9;',
    '    for(var i=0;i<all.length;i++){',
    '      var e=all[i], r=e.getBoundingClientRect();',
    '      if(!r.height||!r.width) continue;',
    '      if(r.height>vh*8) continue;',
    '      if(r.top>vh) continue;',
    '      var d=Math.abs(r.top-SNAP_PAD);',
    '      if(d>=bd) continue;',
    '      if(!survives(e)) continue;',
    '      if(pinned(e)) continue;',
    '      best=e; bd=d;',
    '    }',
    '    if(!best) return null;',
    '    return { el:best, top:best.getBoundingClientRect().top, se:se };',
    '  }catch(e){ return null; }',
    '}',
    /*    Put it back, then once more on the next frame: a group that regains a
          web font or an image settles a frame late, and the second pass costs
          nothing when the first one already landed. */
    'function snapBack(s){',
    '  if(!s||!s.el) return;',
    '  try{',
    '    var apply=function(){',
    '      try{',
    '        if(s.el.isConnected===false) return;',
    '        var r=s.el.getBoundingClientRect();',
    '        if(!r.height&&!r.width) return;',
    '        var d=r.top-s.top;',
    '        if(d) s.se.scrollTop+=d;',
    '      }catch(x){}',
    '    };',
    '    apply();',
    '    try{ requestAnimationFrame(function(){ apply(); remember(); }); }catch(x){ remember(); }',
    '    remember();',
    '    function remember(){',
    '      try{ lastEl=s.el; lastTop=s.top; lastST=s.se.scrollTop; }catch(x){}',
    '    }',
    '  }catch(e){}',
    '}',
    'window.__appSnapTop=snapTop; window.__appSnapBack=snapBack;',
    /*    The reading layer's own 1/2/3 handler calls its private setTier, not
          the public one, so wrapping TARA.setTier alone would miss it. A
          capture-phase listener runs before that handler, snapshots, and puts
          the anchor back once every handler on the key has run. */
    'document.addEventListener("keydown",function(ev){',
    '  if(!ev||ev.metaKey||ev.ctrlKey||ev.altKey) return;',
    '  if(ev.key!=="1"&&ev.key!=="2"&&ev.key!=="3") return;',
    '  var t=ev.target;',
    '  try{ if(t&&(t.isContentEditable||/^(input|textarea|select)$/i.test(t.tagName||""))) return; }catch(x){}',
    '  var s=snapTop();',
    '  if(!s) return;',
    '  setTimeout(function(){ snapBack(s); },0);',
    '},true);',
    'function wrapSetTier(){',
    '  try{',
    '    var T=window.TARA;',
    '    if(!T||typeof T.setTier!=="function"||T.__appWrapped) return !!(T&&T.__appWrapped);',
    '    var orig=T.setTier;',
    '    T.setTier=function(){ var s=snapTop(); var r=orig.apply(this,arguments); snapBack(s); return r; };',
    '    T.__appWrapped=1;',
    '    return true;',
    '  }catch(e){ return false; }',
    '}',
    'window.addEventListener("tara:ready",wrapSetTier);',
    'wrapSetTier();',
    'var _w=0,_wv=setInterval(function(){ if(wrapSetTier()||++_w>60) clearInterval(_wv); },50);',

    /* 5. deep links, driven by a call from the shell */
    'window.__appScrollTo=function(id){',
    '  if(!id) return false;',
    '  var n=null;',
    '  try{ n=document.getElementById(id)||document.getElementById(decodeURIComponent(id)); }catch(e){}',
    '  if(!n){ try{ n=document.querySelector(\'[name="\'+CSS.escape(id)+\'"]\'); }catch(e){} }',
    '  if(!n) return false;',
    '  try{ n.scrollIntoView({block:"start"}); }catch(e){ n.scrollIntoView(); }',
    '  return true;',
    '};',
    '})();'
  ].join('\n');

  /* --------------------------------------------------------- compose sides */

  function bootBlock(parts) {
    /* parts: {css, pre, engine, layer, tiers, post} — every field optional */
    var out = ['<!-- APP-FRAME:BEGIN -->'];
    if (parts.css) out.push('<style>' + parts.css + '</style>');
    var cfg = ['window.__APP_URL2HASH=' + jsonLit(URL2HASH) + ';'];
    if (parts.tiers) cfg = cfg.concat(envelopeConfig(parts.tiers));
    if (parts.nav !== false) {
      cfg.push('window.TARA_MAP_URL="#map";');
      cfg.push('window.TARA_PLAN_URL="#plan";');
      cfg.push('window.TARA_CASES_URL="#cases";');
      if (parts.drill) cfg.push('window.TARA_DRILL_URL=' + jsonLit(parts.drill) + ';');
    }
    if (parts.pre) cfg.push(parts.pre);
    out.push('<script>' + cfg.join('\n') + '<\/script>');
    if (parts.bank) out.push('<script>window.TARA_QUIZ_BANK=' + scriptSafe(parts.bank) + ';<\/script>');
    if (parts.engine) out.push('<script>' + scriptSafe(parts.engine) + '<\/script>');
    if (parts.layer) out.push('<script>' + scriptSafe(parts.layer) + '<\/script>');
    out.push('<script>' + CHILD_JS + '<\/script>');
    if (parts.post) out.push('<script>' + parts.post + '<\/script>');
    out.push('<!-- APP-FRAME:END -->');
    return out.join('\n');
  }

  function payloadOr(key, fallback) {
    return APP.payload(key).catch(function (e) {
      try { console.warn('[app] payload ' + key + ': ' + e.message); } catch (_) {}
      return fallback === undefined ? null : fallback;
    });
  }

  function composePack(slug) {
    return Promise.all([
      APP.payload('pack:' + slug),
      payloadOr('tier:' + slug, null),
      payloadOr('bank:' + slug, null),
      payloadOr('engine', null),
      payloadOr('layer', null)
    ]).then(function (r) {
      var tiers = null;
      try { tiers = r[1] ? JSON.parse(r[1]) : null; } catch (e) { tiers = null; }
      return splice(prelude(r[0]), bootBlock({
        tiers: tiers, bank: r[2], engine: r[3], layer: r[4],
        drill: '#drill/' + slug
      }));
    });
  }

  function composeDemo(slug) {
    return Promise.all([
      APP.payload('demo:' + slug),
      payloadOr('tier:' + slug, null),
      payloadOr('layer', null)
    ]).then(function (r) {
      var tiers = null;
      try { tiers = r[1] ? JSON.parse(r[1]) : null; } catch (e) { tiers = null; }
      return splice(prelude(r[0]), bootBlock({ tiers: tiers, layer: r[2] }));
    });
  }

  /* A one-document section (plan, manual): the page, its tier envelope if it
     has one, and the reading layer. Same recipe as a demo, different keys. */
  function composeSimple(htmlKey, tierKey, extra) {
    return Promise.all([
      APP.payload(htmlKey),
      tierKey ? payloadOr(tierKey, null) : Promise.resolve(null),
      payloadOr('layer', null)
    ]).then(function (r) {
      var tiers = null;
      try { tiers = r[1] ? JSON.parse(r[1]) : null; } catch (e) { tiers = null; }
      var parts = { tiers: tiers, layer: r[2] };
      for (var k in (extra || {})) parts[k] = extra[k];
      return splice(prelude(r[0]), bootBlock(parts));
    });
  }

  /* ----------------------------------------------------------- frame plumb */

  function frameDoc(f) {
    if (!f) return null;
    if (APP.frames && APP.frames.doc) { try { return APP.frames.doc(f); } catch (e) { /* fall through */ } }
    try { return f.contentDocument || null; } catch (e) { return null; }
  }

  /* Resolve once the child has parsed and run its inline scripts. */
  function ready(f) {
    return new Promise(function (res) {
      var tries = 0;
      (function tick() {
        var d = frameDoc(f);
        if (d && (d.readyState === 'complete' || d.readyState === 'interactive') &&
            d.body && d.body.childNodes.length) return res(f);
        if (++tries > 200) return res(f);          /* 4 s: degrade, never hang */
        setTimeout(tick, 20);
      })();
    });
  }

  /* Deep link into a frame. The target can still be unparsed when the frame
     first reports readiness, so this keeps looking for up to ~4 s and then
     gives up quietly — a missing anchor must never break the section. */
  function scrollTo(f, id) {
    if (!id) return Promise.resolve(false);
    return ready(f).then(function () {
      return new Promise(function (res) {
        var tries = 0;
        (function tick() {
          var w = null;
          try { w = f.contentWindow; } catch (e) { return res(false); }
          if (w && typeof w.__appScrollTo === 'function' && w.__appScrollTo(id)) {
            /* one more pass next frame: the reading layer sets scroll-margin
               and the page's own fonts can settle after the first jump */
            try { w.requestAnimationFrame(function () { w.__appScrollTo(id); }); } catch (e) {}
            return res(true);
          }
          var d = frameDoc(f), n = null;
          if (d) {
            try { n = d.getElementById(id) || d.getElementById(decodeURIComponent(id)); } catch (e) {}
            if (n) {
              try { n.scrollIntoView({ block: 'start' }); } catch (e) { n.scrollIntoView(); }
              return res(true);
            }
          }
          if (++tries > 200) return res(false);
          setTimeout(tick, 20);
        })();
      });
    });
  }

  var SPRINT_TIER = { 1: 'plain', 2: 'working', 3: 'expert' };
  var SPRINT_BACK = { plain: 1, working: 2, expert: 3 };

  /* Push tier N into one live frame. Three shapes, tried in order:
       reading layer  -> TARA.setTier(n)
       crash sprint   -> click its own (hidden) button, per SPEC §6.1
       anything else  -> nothing to do; the frame has no tiers
     Always a no-op when the frame is already at N, so it never re-renders and
     never moves anything. */
  function tierToFrame(f, n) {
    if (!f || !(n === 1 || n === 2 || n === 3)) return false;
    var w = null, d = frameDoc(f);
    try { w = f.contentWindow; } catch (e) { w = null; }
    try {
      if (w && w.TARA && typeof w.TARA.setTier === 'function') {
        if (!w.TARA.getTier || w.TARA.getTier() !== n) w.TARA.setTier(n);
        return true;
      }
    } catch (e) { /* fall through */ }
    if (!d) return false;
    try {
      var want = SPRINT_TIER[n];
      var body = d.body;
      if (body && body.hasAttribute('data-showtier')) {
        if (body.getAttribute('data-showtier') === want) return true;
        var b = d.querySelector('.tierbar button[data-settier="' + want + '"]');
        if (b) {
          /* the sprint has no reading layer to wrap, so hold its position here */
          var snap = (w && w.__appSnapTop) ? w.__appSnapTop() : null;
          b.click();
          if (w && w.__appSnapBack) w.__appSnapBack(snap);
          return true;
        }
      }
    } catch (e) { /* degrade: the frame still works, the shell just cannot steer it */ }
    return false;
  }

  /* Mount a frame into a host div. The host holds exactly one frame at a time;
     APP.frames owns the LRU, so a frame taken away stays alive and keeps its
     scroll position. */
  function show(host, key, composeFn) {
    if (!APP.frames || !APP.frames.get) return Promise.reject(new Error('APP.frames missing'));
    return APP.frames.get(key, composeFn).then(function (f) {
      try { f.className = 'app-fr'; } catch (e) {}
      /* APP.frames.show attaches f and hides every other frame in the host
         (shell.js). One visible frame per host is the shell's job, not ours. */
      if (APP.frames.show) APP.frames.show(host, f);
      else if (f.parentNode !== host) host.appendChild(f);
      return f;
    });
  }

  /* ------------------------------------------------------------- searching */

  var STOP = /^(the|a|an|and|or|of|to|in|is|it|for|on|with|that|this|as|at|by|from)$/i;

  /* Headings plus the first sentence after them, keyed to the nearest id.
     Regex over the source string — the pack is never parsed into the shell. */
  function headingIndex(html) {
    var out = [], seen = Object.create(null);
    var rx = /<h([1-4])\b([^>]*)>([\s\S]*?)<\/h\1>/gi, m;
    var idRx = /\bid\s*=\s*["']([^"']+)["']/i;
    while ((m = rx.exec(html)) !== null) {
      var attrs = m[2] || '', title = strip(m[3]);
      if (!title) continue;
      var id = null, am = idRx.exec(attrs);
      if (am) id = am[1];
      if (!id) id = nearestId(html, m.index);
      if (!id) continue;
      if (seen[id + '|' + title]) continue;
      seen[id + '|' + title] = 1;
      out.push({ id: id, title: title, sub: firstSentence(html, rx.lastIndex) });
      if (out.length > 400) break;
    }
    return out;
  }
  function nearestId(html, at) {
    /* the closest id="..." on an open tag before this heading */
    var win = html.slice(Math.max(0, at - 1400), at);
    var rx = /<(?:section|article|div|details|main|aside|h[1-4])\b[^>]*\bid\s*=\s*["']([^"']+)["']/gi;
    var last = null, m;
    while ((m = rx.exec(win)) !== null) last = m[1];
    return last;
  }
  function firstSentence(html, from) {
    var t = strip(html.slice(from, from + 900));
    if (!t) return '';
    var i = t.search(/[.!?](\s|$)/);
    return (i > 0 ? t.slice(0, i + 1) : t).slice(0, 160);
  }
  function strip(s) {
    return String(s)
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ').trim();
  }

  /* SPEC §8 scoring. Ties are broken by the caller, in registration order. */
  function score(q, fields) {
    q = String(q || '').toLowerCase().trim();
    if (!q || STOP.test(q)) return 0;
    var id = (fields.id || '').toLowerCase();
    var title = (fields.title || '').toLowerCase();
    var body = (fields.body || '').toLowerCase();
    if (id === q || (fields.slug || '').toLowerCase() === q) return 100;
    if (title.indexOf(q) === 0) return 60;
    if (title.indexOf(q) !== -1) return 40;
    if (id.indexOf(q) !== -1) return 40;
    if (body.indexOf(q) !== -1) return 15;
    return 0;
  }

  function cap(rows, n) {
    rows.sort(function (a, b) { return b.score - a.score || (a._o || 0) - (b._o || 0); });
    return rows.slice(0, n == null ? 8 : n);
  }

  /* -------------------------------------------------------------- the kit  */

  window.__TARA_FK = {
    PACKS: PACKS, DEMOS: DEMOS, PACK_BY: PACK_BY, DEMO_BY: DEMO_BY, URL2HASH: URL2HASH,
    scriptSafe: scriptSafe, jsonLit: jsonLit, splice: splice, prelude: prelude,
    envelopeConfig: envelopeConfig, bootBlock: bootBlock, payloadOr: payloadOr,
    composePack: composePack, composeDemo: composeDemo, composeSimple: composeSimple,
    frameDoc: frameDoc, ready: ready, scrollTo: scrollTo, show: show,
    tierToFrame: tierToFrame, SPRINT_TIER: SPRINT_TIER, SPRINT_BACK: SPRINT_BACK,
    headingIndex: headingIndex, strip: strip, score: score, cap: cap,
    /* every framed section renders the same two-part shell */
    scaffold: function (el, opts) {
      if (el.__built) return el.__built;
      el.textContent = '';
      var idx = document.createElement('div');
      idx.className = 'app-idx';
      var wrap = document.createElement('div');
      wrap.className = 'app-fr-wrap';
      var bar = document.createElement('div');
      bar.className = 'app-fr-bar';
      var back = document.createElement('a');
      back.className = 'app-fr-back';
      back.href = opts.backHash || '#today';
      back.textContent = opts.backLabel || 'Back';
      var name = document.createElement('span');
      name.className = 'app-fr-name';
      bar.appendChild(back); bar.appendChild(name);
      var host = document.createElement('div');
      host.className = 'app-fr-host';
      wrap.appendChild(bar); wrap.appendChild(host);
      el.appendChild(idx); el.appendChild(wrap);
      el.__built = { idx: idx, wrap: wrap, bar: bar, back: back, name: name, host: host };
      return el.__built;
    },
    /* index vs frame — toggled with `hidden`, so nothing is ever rebuilt */
    showIndex: function (parts, on) {
      parts.idx.hidden = !on;
      parts.wrap.hidden = !!on;
    },
    /* headings of one framed document -> search rows */
    docSearch: function (payloadKey, q, hashPrefix, label, cacheBox) {
      var K = window.__TARA_FK;
      var p = cacheBox.rows
        ? Promise.resolve(cacheBox.rows)
        : K.payloadOr(payloadKey, '').then(function (html) {
            cacheBox.rows = html ? K.headingIndex(html) : [];
            return cacheBox.rows;
          });
      return p.then(function (rows) {
        var out = [];
        rows.forEach(function (row, i) {
          var s = K.score(q, { id: row.id, title: row.title, body: row.sub });
          if (!s) return;
          out.push({ title: row.title, sub: label, hash: hashPrefix + row.id, score: s, _o: i });
        });
        return K.cap(out, 8);
      });
    },

    /* raw hash, minus the leading '#', with the section token peeled off */
    hashOf: function (route) {
      var raw = (route && route.raw) || '';
      if (!raw) { try { raw = location.hash; } catch (e) { raw = ''; } }
      return String(raw).replace(/^#/, '');
    }
  };
})();

/* ============================================================ the section  */
(function () {
  'use strict';
  var SEC = 'packs';

  function fk() { return window.__TARA_FK; }

  /* Every spelling SPEC §7 allows, plus the two bare chapter slugs the router
     normalises to: #week-07, #week-7, #week-07/<anchor>, #alignment-science,
     #week-alignment-science, #pack/<slug>. */
  function parse(route) {
    var h = fk().hashOf(route);
    if (!h || h === 'packs' || h === 'pack') return { slug: null, anchor: null };
    var i = h.indexOf('/');
    var head = i === -1 ? h : h.slice(0, i);
    var anchor = i === -1 ? null : h.slice(i + 1) || null;
    if (head === 'pack' && anchor) {
      var j = anchor.indexOf('/');
      head = j === -1 ? anchor : anchor.slice(0, j);
      anchor = j === -1 ? null : anchor.slice(j + 1) || null;
    }
    var P = fk().PACK_BY;
    if (P[head]) return { slug: head, anchor: anchor };
    var m = /^week-(.+)$/.exec(head);
    if (m) {
      var t = m[1];
      if (P['week-' + t]) return { slug: 'week-' + t, anchor: anchor };
      if (/^\d$/.test(t) && P['week-0' + t]) return { slug: 'week-0' + t, anchor: anchor };
      if (P[t]) return { slug: t, anchor: anchor };
    }
    return { slug: null, anchor: null };
  }

  function buildIndex(idx) {
    if (idx.__filled) return;
    idx.__filled = 1;
    var head = document.createElement('div');
    head.className = 'app-idx-head';
    head.innerHTML = '<h2 class="app-idx-h">Study packs</h2>' +
      '<p class="app-idx-note">Thirteen packs covering all fourteen weeks. Each one carries its own ' +
      'eight-question drill, drawn from that week&rsquo;s bank.</p>';
    idx.appendChild(head);
    var grid = document.createElement('div');
    grid.className = 'app-idx-grid';
    fk().PACKS.forEach(function (p) {
      var a = document.createElement('a');
      a.className = 'app-idx-card';
      a.href = '#' + p.slug;
      a.innerHTML =
        '<span class="app-idx-k">' + APP.esc(p.label) + '</span>' +
        '<span class="app-idx-t">' + APP.esc(p.title) + '</span>' +
        '<span class="app-idx-s">' + APP.esc(p.sub) + '</span>';
      grid.appendChild(a);
    });
    idx.appendChild(grid);
    APP._order = APP._order || {};
    APP._order[SEC] = fk().PACKS.map(function (p) { return p.slug; });
  }

  var openSlug = null, openFrame = null;

  function mount(el, route) {
    var K = fk();
    var parts = K.scaffold(el, { backHash: '#packs', backLabel: '← All packs' });
    buildIndex(parts.idx);
    var r = parse(route);
    if (!r.slug || !K.PACK_BY[r.slug]) {
      K.showIndex(parts, true);
      openSlug = null; openFrame = null;
      return Promise.resolve();
    }
    var p = K.PACK_BY[r.slug];
    K.showIndex(parts, false);
    parts.name.textContent = p.label + ' · ' + p.title;
    openSlug = r.slug;
    return K.show(parts.host, 'pack:' + r.slug, function () {
      return K.composePack(r.slug);
    }).then(function (f) {
      openFrame = f;
      if (r.anchor) K.scrollTo(f, r.anchor);
      return f;
    });
  }

  /* Lazy, one-shot: 13 pack sources decoded in parallel on the first query. */
  var index = null, indexing = null;
  function ensureIndex() {
    if (index) return Promise.resolve(index);
    if (indexing) return indexing;
    var K = fk();
    indexing = Promise.all(K.PACKS.map(function (p) {
      return K.payloadOr('pack:' + p.slug, '').then(function (html) {
        return { pack: p, rows: html ? K.headingIndex(html) : [] };
      });
    })).then(function (all) {
      index = all;
      indexing = null;
      return index;
    });
    return indexing;
  }

  function search(q) {
    var K = fk();
    var direct = [];
    K.PACKS.forEach(function (p) {
      var s = K.score(q, { id: p.slug, slug: p.slug, title: p.title, body: p.sub + ' ' + p.label });
      if (!s) s = K.score(q, { id: p.label.toLowerCase(), title: p.label });
      if (s) direct.push({ title: p.title, sub: p.label, hash: '#' + p.slug, score: s + 5, _o: p.order });
    });
    return ensureIndex().then(function (all) {
      var rows = direct.slice();
      all.forEach(function (entry) {
        entry.rows.forEach(function (row, i) {
          var s = K.score(q, { id: row.id, title: row.title, body: row.sub });
          if (!s) return;
          rows.push({
            title: row.title,
            sub: entry.pack.label + ' · ' + entry.pack.title,
            hash: '#' + entry.pack.slug + '/' + row.id,
            score: s,
            _o: entry.pack.order * 1000 + i
          });
        });
      });
      return K.cap(rows, 8);
    });
  }

  function onTier(n) {
    /* the shell fans out to every live frame (SPEC §6.1); this is the belt for
       a frame that booted just before the shell wrote the key. Idempotent. */
    window.__TARA_FK.tierToFrame(openFrame, n);
  }

  APP.registerSection({
    id: SEC,
    title: 'Packs',
    navOrder: 30,
    mount: mount,
    search: search,
    onTier: onTier
  });
})();

})();

/* ===== sections/demos.js ===== */
;(function(){
/* ==========================================================================
   sections/demos.js — the 13 interactive demos.
   Routes: #demos, #demo/<slug>, #demo-week-NN  (SPEC §7)
   ========================================================================== */
/* global APP */
(function () {
  'use strict';
  var SEC = 'demos';

  function fk() { return window.__TARA_FK; }

  /* Which demos belong to a week: the schedule when the shell has one,
     otherwise the static table in the kit (both come from calendar.md). */
  function demosForWeek(n) {
    try {
      var s = APP.schedule && APP.schedule();
      if (s && s.weeks) {
        for (var i = 0; i < s.weeks.length; i++) {
          if (s.weeks[i].n === n && Array.isArray(s.weeks[i].demoSlugs) && s.weeks[i].demoSlugs.length) {
            return s.weeks[i].demoSlugs.slice();
          }
        }
      }
    } catch (e) { /* fall back */ }
    return fk().DEMOS.filter(function (d) {
      return d.weeks.indexOf(n) !== -1;
    }).map(function (d) { return d.slug; });
  }

  function parse(route) {
    var h = fk().hashOf(route);
    var m = /^demo\/([^/]+)(?:\/(.*))?$/.exec(h);
    if (m) return { slug: m[1], anchor: m[2] || null, week: null };
    m = /^demo-week-(\d+)$/.exec(h);
    if (m) {
      var wk = parseInt(m[1], 10);
      var list = demosForWeek(wk);
      return { slug: list.length === 1 ? list[0] : null, anchor: null, week: wk };
    }
    return { slug: null, anchor: null, week: null };
  }

  function buildIndex(idx) {
    if (idx.__filled) return;
    idx.__filled = 1;
    var head = document.createElement('div');
    head.className = 'app-idx-head';
    head.innerHTML = '<h2 class="app-idx-h">Demos</h2>' +
      '<p class="app-idx-note">Thirteen benches. Every Saturday has one; there are no coverage gaps.</p>';
    idx.appendChild(head);
    var grid = document.createElement('div');
    grid.className = 'app-idx-grid';
    fk().DEMOS.forEach(function (d) {
      var a = document.createElement('a');
      a.className = 'app-idx-card';
      a.href = '#demo/' + d.slug;
      a.setAttribute('data-demo', d.slug);
      a.setAttribute('data-weeks', d.weeks.join(','));
      a.innerHTML =
        '<span class="app-idx-k">' + APP.esc(d.weeks.map(function (w) { return 'W' + w; }).join(' · ')) + '</span>' +
        '<span class="app-idx-t">' + APP.esc(d.title) + '</span>' +
        '<span class="app-idx-s">' + APP.esc(d.slug) + '</span>';
      grid.appendChild(a);
    });
    idx.appendChild(grid);
    APP._order = APP._order || {};
    APP._order[SEC] = fk().DEMOS.map(function (d) { return d.slug; });
  }

  /* #demo-week-NN with more than one demo: mark that week's cards. Marking sets
     an attribute in place — nothing is reordered, hidden or re-packed. */
  function markWeek(idx, week) {
    var cards = idx.querySelectorAll('.app-idx-card');
    for (var i = 0; i < cards.length; i++) {
      var ws = (cards[i].getAttribute('data-weeks') || '').split(',');
      var on = week != null && ws.indexOf(String(week)) !== -1;
      if (on) cards[i].setAttribute('data-now', '1');
      else cards[i].removeAttribute('data-now');
    }
    var head = idx.querySelector('.app-idx-note');
    if (head) {
      head.textContent = week == null
        ? 'Thirteen benches. Every Saturday has one; there are no coverage gaps.'
        : 'Week ' + week + ' has more than one demo. Both are marked below.';
    }
  }

  var openSlug = null, openFrame = null;

  function mount(el, route) {
    var K = fk();
    var parts = K.scaffold(el, { backHash: '#demos', backLabel: '← All demos' });
    buildIndex(parts.idx);
    var r = parse(route);

    if (!r.slug || !K.DEMO_BY[r.slug]) {
      markWeek(parts.idx, r.week);
      K.showIndex(parts, true);
      openSlug = null; openFrame = null;
      return Promise.resolve();
    }
    var d = K.DEMO_BY[r.slug];
    K.showIndex(parts, false);
    parts.name.textContent = d.title;
    openSlug = r.slug;
    return K.show(parts.host, 'demo:' + r.slug, function () {
      return K.composeDemo(r.slug);
    }).then(function (f) {
      openFrame = f;
      if (r.anchor) K.scrollTo(f, r.anchor);
      return f;
    });
  }

  function search(q) {
    var K = fk(), rows = [];
    K.DEMOS.forEach(function (d) {
      var s = K.score(q, {
        id: d.slug, slug: d.slug, title: d.title,
        body: d.weeks.map(function (w) { return 'week ' + w + ' w' + w; }).join(' ')
      });
      if (s) rows.push({ title: d.title, sub: 'Demo · ' + d.weeks.map(function (w) { return 'W' + w; }).join(' · '),
        hash: '#demo/' + d.slug, score: s, _o: d.order });
    });
    return K.cap(rows, 8);
  }

  function onTier(n) { fk().tierToFrame(openFrame, n); }

  APP.registerSection({
    id: SEC,
    title: 'Demos',
    navOrder: 40,
    mount: mount,
    search: search,
    onTier: onTier
  });
})();

})();

/* ===== sections/plan.js ===== */
;(function(){
/* ==========================================================================
   sections/plan.js — the master plan (tara-plan.current.html) in a frame.
   Routes: #plan, #plan/<anchor>  where anchor is one of
   now sprint loop calendar retention demos capstone risk failure  (SPEC §7)
   ========================================================================== */
/* global APP */
(function () {
  'use strict';
  var SEC = 'plan';
  var ANCHORS = ['now', 'sprint', 'loop', 'calendar', 'retention', 'demos', 'capstone', 'risk', 'failure'];

  function fk() { return window.__TARA_FK; }

  function parse(route) {
    var h = fk().hashOf(route);
    var m = /^plan(?:\/(.*))?$/.exec(h);
    return { anchor: (m && m[1]) ? m[1] : null };
  }

  var openFrame = null;
  var cache = {};

  function mount(el, route) {
    var K = fk();
    var parts = K.scaffold(el, { backHash: '#today', backLabel: '← Today' });
    K.showIndex(parts, false);
    parts.name.textContent = 'Fourteen Saturdays — the plan';
    var r = parse(route);
    return K.show(parts.host, 'plan', function () {
      return K.composeSimple('plan', 'tier:plan');
    }).then(function (f) {
      openFrame = f;
      if (r.anchor) K.scrollTo(f, r.anchor);
      return f;
    });
  }

  function search(q) {
    var K = fk();
    var rows = [];
    ANCHORS.forEach(function (a, i) {
      var s = K.score(q, { id: a, title: a });
      if (s) rows.push({ title: a.charAt(0).toUpperCase() + a.slice(1), sub: 'Plan', hash: '#plan/' + a, score: s, _o: i });
    });
    return K.docSearch('plan', q, '#plan/', 'Plan', cache).then(function (more) {
      return K.cap(rows.concat(more), 8);
    });
  }

  function onTier(n) { fk().tierToFrame(openFrame, n); }

  APP.registerSection({
    id: SEC,
    title: 'Plan',
    navOrder: 20,
    mount: mount,
    search: search,
    onTier: onTier
  });
})();

})();

/* ===== sections/sprint.js ===== */
;(function(){
/* ==========================================================================
   sections/sprint.js — the Seven Day Crash Sprint.

   The sprint predates the shared tier contract: it keys its own level off
   localStorage["sprint7.v1.tier"] (a JSON string, "plain" | "working" |
   "expert") and off <body data-showtier>. This bridges both ways:

     shell -> sprint   at compose time the sprint's own key is written from
                       APP.tier(), so the frame boots at the right level and
                       nothing flickers; afterwards onTier() clicks the
                       sprint's own (hidden) button, per SPEC §6.1.
     sprint -> shell   a MutationObserver on body[data-showtier] pushes any
                       change the frame makes back through APP.setTier.

   Routes: #sprint, #sprint/day-N  (N = 1…7)                     (SPEC §7)
   ========================================================================== */
/* global APP */
(function () {
  'use strict';
  var SEC = 'sprint';

  function fk() { return window.__TARA_FK; }

  function parse(route) {
    var h = fk().hashOf(route);
    var m = /^sprint(?:\/day-(\d+))?$/.exec(h);
    if (m) return { day: m[1] ? parseInt(m[1], 10) : null };
    m = /^day-(\d+)$/.exec(h);
    return { day: m ? parseInt(m[1], 10) : null };
  }

  function compose() {
    var K = fk();
    var n = 2;
    try { n = APP.tier(); } catch (e) { n = 2; }
    if (n !== 1 && n !== 2 && n !== 3) n = 2;

    var seed =
      '<style>.tierbar{display:none!important}</style>\n' +
      '<script>try{localStorage.setItem("sprint7.v1.tier",' +
      K.jsonLit(K.SPRINT_TIER[n]) + ');}catch(e){}<\/script>';

    /* pushed back up whenever the frame changes its own level */
    var post = [
      '(function(){',
      'var MAP={plain:1,working:2,expert:3};',
      'function push(){',
      '  var A=window.__app&&window.__app(); if(!A||!A.setTier||!A.tier) return;',
      '  var v=document.body.getAttribute("data-showtier"); var t=MAP[v];',
      '  if(!t) return;',
      '  try{ if(A.tier()!==t) A.setTier(t); }catch(e){}',
      '}',
      'try{',
      '  new MutationObserver(push).observe(document.body,{attributes:true,attributeFilter:["data-showtier"]});',
      '}catch(e){}',
      /* openDay() is private to the sprint's own IIFE: window.SPRINT exposes
         only days/glossary/env/rng/shp/registerDay, so the day rail is the
         public way in. A future build exporting openDay is preferred if found. */
      /* Pyodide: pyodide.js is a script from cdn.jsdelivr.net/npm/, which the
         artifact CSP allows, but loadPyodide() then FETCHES pyodide.asm.wasm,
         pyodide-lock.json and python_stdlib.zip from the same origin, and the
         CSP's connect-src allows no host at all. So the interpreter cannot
         start inside any artifact — this one or the standalone sprint that was
         published before it. Rather than let the reader click Run and watch a
         "Downloading Python" line stall, probe connect-src once with a small
         GET to the same origin: a CSP refusal rejects with a TypeError before
         a packet leaves. Only when it is refused do we say so, so the notice
         never appears anywhere the runner would actually have worked. */
      'window.__appPy={state:"probing"};',
      '(function(){',
      '  var V="0.28.3";',
      '  var IX=window.SPRINT_PYODIDE_INDEX||("https://cdn.jsdelivr.net/npm/pyodide@"+V+"/");',
      '  function verdict(v,why){',
      '    window.__appPy={state:v,why:why||"",index:IX};',
      '    if(v!=="blocked") return;',
      '    try{ if(window.SPRINT&&window.SPRINT.boot) window.SPRINT.boot().catch(function(){}); }catch(e){}',
      '    var A=window.__app&&window.__app(); if(A&&A.sprintPyBlocked) A.sprintPyBlocked(why);',
      '  }',
      '  try{',
      '    fetch(IX+"package.json",{method:"GET",cache:"no-store"})',
      '      .then(function(){ verdict("ok",""); })',
      '      .catch(function(e){ verdict("blocked",String(e&&e.message||e)); });',
      '  }catch(e){ verdict("blocked",String(e&&e.message||e)); }',
      '})();',
      'window.__appOpenDay=function(n){',
      '  if(window.SPRINT&&typeof window.SPRINT.openDay==="function"){',
      '    try{ window.SPRINT.openDay(n); return true; }catch(e){}',
      '  }',
      '  var r=document.getElementById("rail"); if(!r) return false;',
      '  var bs=r.querySelectorAll("button");',
      '  if(!bs.length||n<1||n>bs.length) return false;',
      '  bs[n-1].click(); return true;',
      '};',
      '})();'
    ].join('\n');

    /* The sprint is a complete <!doctype html> document, so the seed rides the
       kit's prelude — injected just inside <body>, ahead of the sprint's own
       script, which reads the tier key while the page is still parsing. */
    return APP.payload('sprint').then(function (html) {
      return K.splice(K.prelude(html, seed), K.bootBlock({ post: post, nav: false }));
    });
  }

  function openDay(f, day) {
    if (!day) return;
    var K = fk();
    K.ready(f).then(function () {
      var tries = 0;
      (function tick() {
        var w = null;
        try { w = f.contentWindow; } catch (e) { return; }
        if (w && typeof w.__appOpenDay === 'function' && w.__appOpenDay(day)) return;
        if (++tries > 150) return;
        setTimeout(tick, 20);
      })();
    });
  }

  var openFrame = null;
  var cache = {};
  var noteEl = null;

  /* Called from inside the frame when the Pyodide probe comes back refused.
     The notice lives in the shell's own bar, above the frame: the sprint's
     layout is not touched, so nothing inside it moves. */
  APP.sprintPyBlocked = function (why) {
    if (!noteEl) return;
    if (noteEl.getAttribute('data-shown')) return;
    noteEl.setAttribute('data-shown', '1');
    noteEl.hidden = false;
    noteEl.textContent =
      'Python exercises cannot run here. Pyodide loads its interpreter by ' +
      'fetching WebAssembly from a CDN, and this page\u2019s sandbox allows no ' +
      'network fetches at all. Everything else in the sprint \u2014 all seven ' +
      'days, the reading levels, the diagrams and every non-Python exercise ' +
      '\u2014 works normally. Run the Python in the standalone sprint page or a ' +
      'local copy.';
    if (why) noteEl.title = 'Pyodide probe: ' + why;
  };

  function mount(el, route) {
    var K = fk();
    var parts = K.scaffold(el, { backHash: '#today', backLabel: '← Today' });
    K.showIndex(parts, false);
    parts.name.textContent = 'Seven Day Crash Sprint';
    if (!noteEl) {
      noteEl = document.createElement('p');
      noteEl.className = 'app-fr-note';
      noteEl.id = 'app-sprint-pynote';
      noteEl.hidden = true;
      parts.wrap.insertBefore(noteEl, parts.host);
    }
    var r = parse(route);
    return K.show(parts.host, 'sprint', compose).then(function (f) {
      openFrame = f;
      /* re-assert on every entry: the shell may have moved tier while the
         frame was detached in the LRU */
      try { K.tierToFrame(f, APP.tier()); } catch (e) {}
      openDay(f, r.day);
      return f;
    });
  }

  function search(q) {
    var K = fk(), rows = [];
    for (var d = 1; d <= 7; d++) {
      var s = K.score(q, { id: 'day-' + d, title: 'Day ' + d, body: 'sprint day ' + d });
      if (s) rows.push({ title: 'Sprint · Day ' + d, sub: 'Seven Day Crash Sprint', hash: '#sprint/day-' + d, score: s, _o: d });
    }
    return K.docSearch('sprint', q, '#sprint/', 'Sprint', cache).then(function (more) {
      /* the sprint renders its days from JS, so headings in the source are the
         shell of the page only; day rows above carry the useful hits */
      return K.cap(rows.concat(more), 8);
    });
  }

  function onTier(n) { fk().tierToFrame(openFrame, n); }

  APP.registerSection({
    id: SEC,
    title: 'Sprint',
    navOrder: 10,
    mount: mount,
    search: search,
    onTier: onTier
  });
})();

})();

/* ===== sections/manual.js ===== */
;(function(){
/* ==========================================================================
   sections/manual.js — the TARA system manual (tara-system/manual.html).
   Local-only source; it has no published URL and never had one (SPEC §13).
   Routes: #manual, #manual/<anchor>
   ========================================================================== */
/* global APP */
(function () {
  'use strict';
  var SEC = 'manual';

  function fk() { return window.__TARA_FK; }

  function parse(route) {
    var h = fk().hashOf(route);
    var m = /^manual(?:\/(.*))?$/.exec(h);
    return { anchor: (m && m[1]) ? m[1] : null };
  }

  var openFrame = null;
  var cache = {};

  function mount(el, route) {
    var K = fk();
    var parts = K.scaffold(el, { backHash: '#today', backLabel: '← Today' });
    K.showIndex(parts, false);
    parts.name.textContent = 'How this system works';
    var r = parse(route);
    return K.show(parts.host, 'manual', function () {
      /* no tier envelope was ever authored for the manual; the layer still
         gives it the glossary and select-to-explain */
      return K.composeSimple('manual', null);
    }).then(function (f) {
      openFrame = f;
      if (r.anchor) K.scrollTo(f, r.anchor);
      return f;
    });
  }

  function search(q) {
    return fk().docSearch('manual', q, '#manual/', 'Manual', cache);
  }

  function onTier(n) { fk().tierToFrame(openFrame, n); }

  APP.registerSection({
    id: SEC,
    title: 'Manual',
    navOrder: 90,
    mount: mount,
    search: search,
    onTier: onTier
  });
})();

})();

/* ===== sections/map.js ===== */
;(function(){
/* ==========================================================================
   sections/map.js — the 215-node concept map.

   The document is regenerated at build time by payloads/frames.js (a port of
   concept-map/build.js) with node geometry copied through untouched, so every
   x/y/w/h is byte-identical to nodes.json and nothing ever moves.

   Deep links are driven by a function call into the frame — __mapFocus(id) and
   __mapSearch(q), installed in the template by frames.js — rather than by
   writing the frame's hash, which inside `about:srcdoc` is a race at best.

   Routes: #map, #map/node=<id>, #map/q=<text>                    (SPEC §7)
   Old forms #node=<id> and #q=<text> are normalised by the shell's router and
   also handled here, so both spellings land.
   ========================================================================== */
/* global APP */
(function () {
  'use strict';
  var SEC = 'map';

  function fk() { return window.__TARA_FK; }

  function parse(route) {
    var h = fk().hashOf(route);
    var m = /^map\/node=(.+)$/.exec(h);
    if (m) return { node: dec(m[1]), q: null };
    m = /^map\/q=(.*)$/.exec(h);
    if (m) return { node: null, q: dec(m[1]) };
    m = /^node=(.+)$/.exec(h);
    if (m) return { node: dec(m[1]), q: null };
    m = /^q=(.*)$/.exec(h);
    if (m) return { node: null, q: dec(m[1]) };
    return { node: null, q: null };
  }
  function dec(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

  function compose() {
    /* No reading layer here: the map is an SVG application with its own plain-
       language text, and the layer's glossary scanner has nothing to scan. */
    return APP.payload('map').then(function (html) {
      return fk().splice(fk().prelude(html), fk().bootBlock({ nav: false }));
    });
  }

  function drive(f, r) {
    if (!r.node && !r.q) return;
    var K = fk();
    K.ready(f).then(function () {
      var tries = 0;
      (function tick() {
        var w = null;
        try { w = f.contentWindow; } catch (e) { return; }
        if (w && typeof w.__mapFocus === 'function') {
          try {
            if (r.node) w.__mapFocus(r.node);
            else w.__mapSearch(r.q);
          } catch (e) { /* the frame still works; the shell just could not steer it */ }
          return;
        }
        if (++tries > 150) return;
        setTimeout(tick, 20);
      })();
    });
  }

  var openFrame = null;

  function mount(el, route) {
    var K = fk();
    var parts = K.scaffold(el, { backHash: '#today', backLabel: '← Today' });
    K.showIndex(parts, false);
    parts.name.textContent = 'Concept map · 215 nodes';
    var r = parse(route);
    return K.show(parts.host, 'map', compose).then(function (f) {
      openFrame = f;
      drive(f, r);
      return f;
    });
  }

  /* ---- search: the node array is sliced straight back out of the payload --- */

  var nodes = null, loading = null;
  var HEAD = 'const RAW = ';
  var TAIL = ';\nconst META = ';

  function ensureNodes() {
    if (nodes) return Promise.resolve(nodes);
    if (loading) return loading;
    loading = fk().payloadOr('map', '').then(function (html) {
      nodes = [];
      var a = html.indexOf(HEAD + '[');
      var b = a === -1 ? -1 : html.indexOf(TAIL, a);
      if (a !== -1 && b !== -1) {
        try { nodes = JSON.parse(html.slice(a + HEAD.length, b)); }
        catch (e) { try { console.warn('[app] map index: ' + e.message); } catch (_) {} }
      }
      loading = null;
      return nodes;
    });
    return loading;
  }

  function search(q) {
    var K = fk();
    return ensureNodes().then(function (ns) {
      var rows = [];
      for (var i = 0; i < ns.length; i++) {
        var n = ns[i];
        var s = K.score(q, {
          id: n.id, slug: n.id, title: n.label,
          body: (n.aliases || []).join(' ') + ' ' + (n.plain || '')
        });
        if (!s && (n.aliases || []).some(function (a) { return a.toLowerCase() === String(q).toLowerCase(); })) s = 100;
        if (!s) continue;
        rows.push({
          title: n.label,
          sub: (n.section_title || n.territory_name || '') + (n.week ? ' · W' + n.week : ''),
          hash: '#map/node=' + encodeURIComponent(n.id),
          score: s,
          _o: i
        });
      }
      return K.cap(rows, 8);
    });
  }

  /* A bare "#<token>" that names a node becomes #map/node=<id> (SPEC §7).
     Consulted by the router only after every known route has missed, so this
     never costs a payload decode on a normal navigation. */
  function resolveToken(tok) {
    tok = String(tok || '').trim().toLowerCase();
    if (!tok) return null;
    return ensureNodes().then(function (ns) {
      for (var i = 0; i < ns.length; i++) {
        if (ns[i].id.toLowerCase() === tok) return '#map/node=' + encodeURIComponent(ns[i].id);
      }
      for (var j = 0; j < ns.length; j++) {
        var al = ns[j].aliases || [];
        for (var k = 0; k < al.length; k++) {
          if (String(al[k]).toLowerCase() === tok) return '#map/node=' + encodeURIComponent(ns[j].id);
        }
      }
      return null;
    });
  }

  function onTier(n) { fk().tierToFrame(openFrame, n); }

  APP.registerSection({
    id: SEC,
    title: 'Map',
    navOrder: 50,
    mount: mount,
    search: search,
    resolveToken: resolveToken,
    onTier: onTier
  });
})();

})();

/* ===== sections/cases.js ===== */
;(function(){
/* app/sections/cases.js — Worker C
 * The applied case-study library (104 cards), rebuilt natively in the shell DOM
 * from case-studies/*.json + concepts-index.json. Ported from the published
 * library (artifact f40cee0d) with three deliberate changes:
 *   1. the shell owns the ONE tier control — this section renders none;
 *   2. all three story tiers live in the DOM at once, stacked in one grid cell,
 *      so a tier change is a visibility flip and nothing moves (SPEC rule 1);
 *   3. filtering DIMS cards in place instead of display:none, so the grid never
 *      re-flows and a remembered position stays a valid position.
 *
 * The index `title` is the concept's human label; the card `title` is the
 * applied-use headline. They are different on purpose. Neither is ever written
 * from the other. (case-studies/README.md, "Settled".)
 */
(function () {
  'use strict';

  var APP = window.APP;
  if (!APP || !APP.registerSection) return;

  var TIER_NAME = { 1: 'plain', 2: 'generalist', 3: 'expert' };
  var CHAPTER_ORDER = ['fundamentals', 'transformers', 'interp', 'rl', 'evals', 'alignment'];
  var WEEK_DATE = {
    1: '12 Sep', 2: '19 Sep', 3: '26 Sep', 4: '3 Oct', 5: '10 Oct', 6: '17 Oct', 7: '24 Oct',
    8: '31 Oct', 9: '7 Nov', 10: '14 Nov', 11: '21 Nov', 12: '28 Nov', 13: '5 Dec', 14: '12 Dec'
  };
  var KINDS = ['workflow', 'debugging', 'breakthrough'];

  /* ------------------------------------------------------------- helpers */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function attr(s) { return esc(s).replace(/"/g, '&quot;'); }
  function rxesc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function trunc(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n - 1).replace(/[\s\-]+$/, '') + '…' : s;
  }
  function isField(el) { return !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''); }

  /* The shell owns the SPEC §8 weights; fall back only if it is not up yet. */
  function score1(q, rec) {
    if (typeof APP.score === 'function') return APP.score(q, rec);
    var id = String(rec.id || '').toLowerCase(), t = String(rec.title || '').toLowerCase();
    if (id === q) return 100;
    if (t.indexOf(q) === 0) return 60;
    if (t.indexOf(q) >= 0 || id.indexOf(q) >= 0) return 40;
    return String(rec.body || '').toLowerCase().indexOf(q) >= 0 ? 15 : 0;
  }

  function scroller(node) {
    var n = node && node.parentNode;
    while (n && n.nodeType === 1) {
      var st = getComputedStyle(n);
      if (/(auto|scroll|overlay)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 4) return n;
      n = n.parentNode;
    }
    return window;
  }
  function scrollTopOf(sc) { return sc === window ? window.pageYOffset : sc.scrollTop; }
  function scrollBy(sc, dy) {
    if (!dy) return;
    if (sc === window) window.scrollBy(0, dy);
    else sc.scrollTop += dy;
  }

  /* --------------------------------------------------------------- state */
  var S = {
    built: false,
    root: null,
    cards: [],          // card objects, in the fixed order established once
    index: {},          // id -> index row (human label + aliases)
    els: [],            // .cases-card elements, parallel to S.cards — never re-ordered
    hay: [],            // lowercase search haystack, parallel
    gids: [],           // week-group id per card, parallel
    groups: {},         // gid -> {sec, out, rail, railN}
    filter: { kind: null, chapter: null, week: null },
    matches: [],        // indices currently matching the filter
    matchAt: -1,
    pop: null,
    popFor: null,
    back: null,
    backTo: null,
    backTimer: 0,
    hitTimer: 0,
    lastHit: null,
    sc: window,
    keyHandler: null
  };

  function label(id) {
    var r = S.index[id];
    return r ? r.title : id;
  }

  /* --------------------------------------------------- glossary marking */
  function gBtn(g, text) {
    return '<button type="button" class="cases-g" data-t="' + attr(g.term) +
      '" data-e="' + attr(g.expansion || '') + '" data-g="' + attr(g.gloss) + '">' + text + '</button>';
  }
  function markGlossary(paras, gloss) {
    var used = {};
    var terms = gloss.slice().sort(function (a, b) { return b.term.length - a.term.length; });
    var out = paras.map(function (p) {
      var html = esc(p);
      for (var i = 0; i < terms.length; i++) {
        var g = terms[i];
        if (used[g.term]) continue;
        var re;
        try { re = new RegExp('(^|[^\\w\\-])(' + rxesc(esc(g.term)) + ')(?![\\w\\-])', 'i'); }
        catch (err) { continue; }
        if (!re.test(html)) continue;
        html = html.replace(re, function (m0, p1, p2) { return p1 + gBtn(g, p2); });
        used[g.term] = 1;
      }
      return '<p>' + html + '</p>';
    }).join('');
    var left = gloss.filter(function (g) { return !used[g.term]; });
    if (left.length) {
      out += '<div class="cases-terms"><span class="cases-lab">also</span>' +
        left.map(function (g) { return gBtn(g, esc(g.term)); }).join('') + '</div>';
    }
    return out;
  }
  function storyBlocks(c) {
    var out = '', n, name;
    for (n = 1; n <= 3; n++) {
      name = TIER_NAME[n];
      var paras = (c.story && c.story[name]) || [];
      var html;
      if (n === 3 && c.glossary && c.glossary.length) html = markGlossary(paras, c.glossary);
      else html = paras.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('');
      out += '<div class="cases-tier" data-t="' + n + '" aria-hidden="' + (n === 2 ? 'false' : 'true') +
        '">' + html + '</div>';
    }
    return out;
  }

  /* -------------------------------------------- where-this-fits diagram */
  var VW = 680, COL = 196, LX1 = 196, MX0 = 232, MX1 = 448, RX0 = 484;
  var ROW_TOP = 24, ROW_H = 28, CHIP_H = 22, CW = 6.05;

  function chip(x, y, w, h, id, text, full, stroke, fill, cls, tfill) {
    return '<g class="cases-fchip" data-go="' + attr(id) + '" tabindex="0" role="link" aria-label="Go to ' +
      attr(full) + '"><title>' + esc(full) + ' — ' + esc(id) + '</title>' +
      '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="3" fill="' + fill +
      '" stroke="' + stroke + '" stroke-width="1"></rect>' +
      '<text class="' + cls + '" x="' + (x + 9) + '" y="' + (y + h / 2 + 4) + '" fill="' + tfill + '">' +
      esc(text) + '</text></g>';
  }

  function fitsSVG(c) {
    var L = c.depends_on || [], R = c.builds_into || [], N = c.neighbours || [];
    var rows = Math.max(L.length, R.length, 1);
    var bandH = rows * ROW_H;
    var p = [], i, y, t, w;

    p.push('<text class="cases-fcap" x="' + LX1 + '" y="12" text-anchor="end">DEPENDS ON</text>');
    p.push('<text class="cases-fcap" x="' + RX0 + '" y="12">BUILDS INTO</text>');

    var ccy = ROW_TOP + bandH / 2 - 2, chH = 32, chY = ccy - chH / 2, ccx = (MX0 + MX1) / 2;

    for (i = 0; i < L.length; i++) {
      y = ROW_TOP + i * ROW_H + CHIP_H / 2;
      p.push('<path d="M' + LX1 + ',' + y + ' C' + (LX1 + 20) + ',' + y + ' ' + (MX0 - 20) + ',' + ccy +
        ' ' + MX0 + ',' + ccy + '" fill="none" stroke="var(--cs-up)" stroke-width="1" opacity=".55"></path>');
    }
    if (L.length) {
      p.push('<path d="M' + (MX0 - 6.5) + ',' + (ccy - 3.6) + ' L' + MX0 + ',' + ccy + ' L' +
        (MX0 - 6.5) + ',' + (ccy + 3.6) + ' Z" fill="var(--cs-up)"></path>');
    }
    for (i = 0; i < R.length; i++) {
      y = ROW_TOP + i * ROW_H + CHIP_H / 2;
      p.push('<path d="M' + MX1 + ',' + ccy + ' C' + (MX1 + 20) + ',' + ccy + ' ' + (RX0 - 20) + ',' + y +
        ' ' + (RX0 - 7) + ',' + y + '" fill="none" stroke="var(--accent)" stroke-width="1" opacity=".55"></path>');
      p.push('<path d="M' + (RX0 - 7) + ',' + (y - 3.6) + ' L' + RX0 + ',' + y + ' L' + (RX0 - 7) + ',' +
        (y + 3.6) + ' Z" fill="var(--accent)"></path>');
    }

    if (!L.length) {
      p.push('<text class="cases-fnone" x="' + LX1 + '" y="' + (ROW_TOP + 15) + '" text-anchor="end">nothing upstream</text>');
    } else {
      for (i = 0; i < L.length; i++) {
        t = trunc(label(L[i]), 28); w = Math.min(COL, Math.ceil(t.length * CW) + 20);
        p.push(chip(LX1 - w, ROW_TOP + i * ROW_H, w, CHIP_H, L[i], t, label(L[i]),
          'var(--cs-up)', 'var(--cs-up-soft)', 'cases-fct', 'var(--ink)'));
      }
    }
    if (!R.length) {
      p.push('<text class="cases-fnone" x="' + RX0 + '" y="' + (ROW_TOP + 15) + '">nothing builds on it yet</text>');
    } else {
      for (i = 0; i < R.length; i++) {
        t = trunc(label(R[i]), 28); w = Math.min(COL, Math.ceil(t.length * CW) + 20);
        p.push(chip(RX0, ROW_TOP + i * ROW_H, w, CHIP_H, R[i], t, label(R[i]),
          'var(--accent)', 'var(--cs-accent-soft)', 'cases-fct', 'var(--ink)'));
      }
    }

    p.push('<rect x="' + MX0 + '" y="' + chY + '" width="' + (MX1 - MX0) + '" height="' + chH +
      '" rx="3" fill="var(--ink)"></rect>');
    p.push('<text class="cases-fcc" x="' + ccx + '" y="' + (chY + chH / 2 + 4.5) +
      '" text-anchor="middle" fill="var(--paper)">' + esc(trunc(label(c.id), 30)) + '</text>');

    var H = ROW_TOP + bandH + 6;

    if (N.length) {
      var sepY = H + 4, capW = 78, x = capW, ny = sepY + 10;
      p.push('<line x1="0" y1="' + sepY + '" x2="' + VW + '" y2="' + sepY +
        '" stroke="var(--cs-rule-2)" stroke-width="1" stroke-dasharray="2 3"></line>');
      p.push('<path d="M' + ccx + ',' + (chY + chH) + ' L' + ccx + ',' + sepY +
        '" stroke="var(--cs-rule-2)" stroke-width="1" stroke-dasharray="2 3" fill="none"></path>');
      p.push('<text class="cases-fcap" x="0" y="' + (ny + 15) + '">ALONGSIDE</text>');
      for (i = 0; i < N.length; i++) {
        t = trunc(label(N[i]), 26); w = Math.min(190, Math.ceil(t.length * CW) + 20);
        if (x + w > VW && x > capW) { x = capW; ny += 26; }
        p.push(chip(x, ny, w, CHIP_H, N[i], t, label(N[i]), 'var(--cs-rule-2)', 'var(--surface)',
          'cases-fct', 'var(--cs-ink-2)'));
        x += w + 7;
      }
      H = ny + CHIP_H + 6;
    }

    return '<svg viewBox="0 0 ' + VW + ' ' + H + '" role="group" aria-label="Where ' +
      attr(label(c.id)) + ' sits among its prerequisites, dependents and neighbours">' +
      p.join('') + '</svg>';
  }

  /* ---------------------------------------------------------------- card */
  function cardHTML(c) {
    var b = c.breakthrough || {}, real = !!b.has_real_story, t = c.troubleshooting || {}, h = [];
    h.push('<article class="cases-card" id="cases-' + attr(c.id) + '" data-id="' + attr(c.id) + '">');
    h.push('<div class="cases-c-head"><div class="cases-tags">');
    h.push('<span class="cases-tag is-' + attr(c.kind) + '">' + esc(c.kind) + '</span>');
    h.push('<span class="cases-tag">ARENA ' + esc(c.arena_section) + '</span>');
    if (!real) h.push('<span class="cases-tag">no origin paper</span>');
    h.push('</div><a class="cases-permalink" href="#cases/' + attr(c.id) + '">' + esc(c.id) + '</a></div>');
    h.push('<h3 class="cases-title">' + esc(c.title) + '</h3>');
    h.push('<p class="cases-lede">' + esc(c.applied_use_summary) + '</p>');
    h.push('<p class="cases-def"><b>plainly</b>' + esc(c.plain_statement) + '</p>');
    h.push('<div class="cases-story">' + storyBlocks(c) + '</div>');

    h.push('<div class="cases-block">');
    if (real) {
      h.push('<span class="cases-block-lab">the paper</span>');
      h.push('<p class="cases-paper-t"><a href="' + attr(b.url) + '" target="_blank" rel="noopener">' +
        esc(b.title) + '</a></p>');
      h.push('<p class="cases-paper-m">' + esc(b.authors) + ' · ' + esc(b.venue) + ' · ' + esc(b.year) + '</p>');
      h.push('<p class="cases-paper-w">' + esc(b.why_it_mattered) + '</p>');
    } else {
      /* has_real_story:false is honest, not a hole to fill. Show the gap. */
      h.push('<div class="cases-nostory"><span class="cases-nlab">No clean real-world story — here’s the failure mode instead.</span><p>' +
        esc(b.why_it_mattered) + '</p></div>');
    }
    h.push('</div>');

    h.push('<div class="cases-block' + (real ? '' : ' is-promoted') + '">');
    h.push('<span class="cases-block-lab">' + (real ? 'when it goes wrong' : 'the failure mode') + '</span>');
    h.push('<p class="cases-sym">' + esc(t.symptom) + '</p>');
    h.push('<details' + (real ? '' : ' open') + '><summary>why this happens, and the fix</summary>' +
      '<dl class="cases-dl"><dt>why</dt><dd>' + esc(t.why) + '</dd><dt>fix</dt><dd>' + esc(t.fix) +
      '</dd></dl></details></div>');

    if (c.steps && c.steps.length) {
      h.push('<div class="cases-block"><span class="cases-block-lab">how it was done</span><details><summary>' +
        c.steps.length + ' steps</summary><ol class="cases-steps">' +
        c.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol></details></div>');
    }

    h.push('<div class="cases-fits"><span class="cases-block-lab">where this fits</span>');
    h.push('<div class="cases-fits-wrap">' + fitsSVG(c) + '</div>');
    h.push('<ul class="cases-fits-lines">' +
      (c.where_this_fits || []).map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') +
      '</ul></div>');

    h.push('<p class="cases-src">' + esc(c.source) +
      (c.citations_verified ? ' <span class="cases-vf">· citations verified ' + esc(c.verified_at) + '</span>' : '') +
      '</p></article>');
    return h.join('');
  }

  /* --------------------------------------------------------------- build */
  function chipHTML(group, value, text, count) {
    return '<button type="button" class="cases-chip" data-f="' + group + '" data-v="' + attr(value) +
      '" aria-pressed="false">' + esc(text) +
      (count == null ? '' : '<span class="cases-n">' + count + '</span>') + '</button>';
  }

  function build(el) {
    var cards = S.cards, i, c;
    var mh = [], rh = [];
    var curCh = null, curWk, wkOpen = false, chOpen = false;
    var chapters = [], weeks = [], kindCount = {}, chCount = {}, wkCount = {};

    for (i = 0; i < cards.length; i++) {
      c = cards[i];
      kindCount[c.kind] = (kindCount[c.kind] || 0) + 1;
      chCount[c.chapter_key] = (chCount[c.chapter_key] || 0) + 1;
      var wkey = c.week === null || c.week === undefined ? 'none' : String(c.week);
      wkCount[wkey] = (wkCount[wkey] || 0) + 1;

      if (c.chapter_label !== curCh) {
        if (wkOpen) { mh.push('</div></section>'); wkOpen = false; }
        if (chOpen) { mh.push('</section>'); chOpen = false; }
        curCh = c.chapter_label; curWk = undefined;
        var bits = String(curCh).split(/\s+[-–—]\s+/);
        var head = bits.length > 1 ? bits.slice(1).join(' — ') : bits[0];
        var chId = 'cases-ch-' + c.chapter_key;
        chapters.push({ key: c.chapter_key, head: head, eyebrow: bits[0], id: chId });
        mh.push('<section class="cases-chapter" id="' + chId + '"><div class="cases-ch-head">' +
          '<span class="cases-ch-eyebrow">' + esc(bits[0]) + '</span>' +
          '<h2 class="cases-ch-title">' + esc(head) + '</h2></div>');
        rh.push('<button type="button" class="cases-rail-ch" data-go="' + chId + '">' + esc(head) + '</button>');
        chOpen = true;
      }
      if (c.week !== curWk) {
        if (wkOpen) { mh.push('</div></section>'); wkOpen = false; }
        curWk = c.week;
        var gid = 'cases-g-' + c.chapter_key + '-' + (curWk === null ? 'none' : curWk);
        var wh;
        if (curWk === null) {
          wh = '<span class="cases-wk-n">—</span><span class="cases-wk-date">No Saturday</span>' +
            '<span class="cases-wk-note">capstone source</span>';
          rh.push('<button type="button" class="cases-rail-wk" data-go="' + gid + '" data-g="' + gid +
            '"><b>—</b><span>no Saturday</span><span class="cases-n"></span></button>');
        } else {
          wh = '<span class="cases-wk-n">W' + curWk + '</span><span class="cases-wk-date">' +
            esc(WEEK_DATE[curWk] || '') + '</span>';
          rh.push('<button type="button" class="cases-rail-wk" data-go="' + gid + '" data-g="' + gid +
            '"><b>W' + curWk + '</b><span>' + esc(WEEK_DATE[curWk] || '') + '</span>' +
            '<span class="cases-n"></span></button>');
        }
        mh.push('<section class="cases-week' + (curWk === null ? ' is-capstone' : '') + '" id="' + gid +
          '" data-g="' + gid + '"><div class="cases-wk-head">' + wh +
          '<span class="cases-wk-count" data-c="' + gid + '"></span></div><div class="cases-cards">');
        weeks.push({ key: curWk === null ? 'none' : String(curWk), gid: gid });
        wkOpen = true;
      }
      S.gids.push('cases-g-' + c.chapter_key + '-' + (c.week === null ? 'none' : c.week));
      mh.push(cardHTML(c));
    }
    if (wkOpen) mh.push('</div></section>');
    if (chOpen) mh.push('</section>');

    /* ---- chrome ---- */
    var hud = [];
    hud.push('<div class="cases-hud">');
    hud.push('<div class="cases-hud-row"><span class="cases-lab">kind</span>');
    KINDS.forEach(function (k) { hud.push(chipHTML('kind', k, k, kindCount[k] || 0)); });
    hud.push('<span class="cases-count" data-count>104 cases</span></div>');
    hud.push('<div class="cases-hud-row"><span class="cases-lab">chapter</span>');
    chapters.forEach(function (ch) {
      hud.push(chipHTML('chapter', ch.key, trunc(ch.head, 26), chCount[ch.key] || 0));
    });
    hud.push('</div>');
    hud.push('<div class="cases-hud-row"><span class="cases-lab">week</span>');
    weeks.forEach(function (w) {
      hud.push(chipHTML('week', w.key, w.key === 'none' ? '—' : 'W' + w.key, wkCount[w.key] || 0));
    });
    hud.push('<span class="cases-nav"><button type="button" data-jump="-1" title="previous match" disabled>↑</button>' +
      '<button type="button" data-jump="1" title="next match" disabled>↓</button>' +
      '<button type="button" data-clear title="clear filters" disabled>clear</button></span>');
    hud.push('</div></div>');

    el.innerHTML =
      '<div class="cases-root" data-tier="2">' +
      '<aside class="cases-rail" aria-label="Chapters and weeks">' +
      '<div class="cases-rail-top">' + cards.length + ' applied cases</div>' + rh.join('') + '</aside>' +
      '<div class="cases-lib">' + hud.join('') + '<div class="cases-flow">' + mh.join('') + '</div></div>' +
      '</div>';

    S.root = el.querySelector('.cases-root');
    S.els = [].slice.call(S.root.querySelectorAll('.cases-card'));
    S.sc = scroller(S.root);

    var railEl = S.root.querySelector('.cases-rail');
    for (i = 0; i < S.els.length; i++) {
      var cc = cards[i], ix = S.index[cc.id] || {};
      S.els[i]._c = cc;
      S.hay.push([
        cc.title, cc.plain_statement, cc.applied_use_summary, cc.summary,
        (cc.breakthrough && cc.breakthrough.title) || '',
        (cc.breakthrough && cc.breakthrough.authors) || '',
        (ix.aliases || []).join(' '), ix.title || '', cc.id
      ].join(' · ').toLowerCase());
    }
    var wkEls = S.root.querySelectorAll('.cases-week');
    for (i = 0; i < wkEls.length; i++) {
      var k = wkEls[i].getAttribute('data-g');
      var rail = railEl.querySelector('.cases-rail-wk[data-g="' + k + '"]');
      S.groups[k] = {
        sec: wkEls[i],
        out: wkEls[i].querySelector('[data-c]'),
        rail: rail,
        railN: rail ? rail.querySelector('.cases-n') : null
      };
    }

    /* back pill lives on <body> so it floats over the whole shell */
    S.back = document.createElement('button');
    S.back.type = 'button';
    S.back.className = 'cases-back';
    S.back.innerHTML = '<span class="cases-bx">←</span><span class="cases-bt"></span>';
    document.body.appendChild(S.back);
    S.back.addEventListener('click', function () {
      if (!S.backTo) return;
      var t = S.backTo;
      S.back.classList.remove('is-on');
      S.backTo = null;
      go(t.getAttribute('data-id'));
      APP.navigate('#cases/' + t.getAttribute('data-id'), { replace: true });
    });

    wire();
    S.built = true;
  }

  /* -------------------------------------------------------------- filter */
  function matchesFilter(i) {
    var c = S.cards[i], f = S.filter;
    if (f.kind && c.kind !== f.kind) return false;
    if (f.chapter && c.chapter_key !== f.chapter) return false;
    if (f.week) {
      var w = c.week === null || c.week === undefined ? 'none' : String(c.week);
      if (w !== f.week) return false;
    }
    return true;
  }

  function applyFilter() {
    var f = S.filter, any = !!(f.kind || f.chapter || f.week);
    var per = {}, shown = 0, i, g;
    S.matches = [];
    for (i = 0; i < S.els.length; i++) {
      var ok = matchesFilter(i);
      /* dim, never hide: the card keeps its box and its coordinates */
      S.els[i].classList.toggle('is-off', any && !ok);
      if (ok) {
        shown++;
        S.matches.push(i);
        per[S.gids[i]] = (per[S.gids[i]] || 0) + 1;
      }
    }
    for (g in S.groups) {
      if (!Object.prototype.hasOwnProperty.call(S.groups, g)) continue;
      var n = per[g] || 0, m = S.groups[g];
      if (m.out) m.out.textContent = n + (n === 1 ? ' case' : ' cases');
      if (m.railN) m.railN.textContent = n;
      if (m.rail) m.rail.classList.toggle('is-zero', n === 0);
    }
    var countEl = S.root.querySelector('[data-count]');
    countEl.textContent = any ? shown + ' of ' + S.els.length + ' · dimmed in place'
      : S.els.length + ' cases';
    countEl.classList.toggle('is-filtered', any);

    [].slice.call(S.root.querySelectorAll('.cases-chip')).forEach(function (b) {
      var grp = b.getAttribute('data-f'), v = b.getAttribute('data-v');
      b.setAttribute('aria-pressed', String(f[grp] === v));
    });
    S.root.querySelector('[data-clear]').disabled = !any;
    var canJump = any && S.matches.length > 0;
    S.root.querySelector('[data-jump="-1"]').disabled = !canJump;
    S.root.querySelector('[data-jump="1"]').disabled = !canJump;
    S.matchAt = -1;
  }

  function toggleFilter(group, value) {
    S.filter[group] = S.filter[group] === value ? null : value;
    applyFilter();
  }

  function jump(dir) {
    if (!S.matches.length) return;
    if (S.matchAt < 0) {
      /* start from whatever is on screen, so the jump feels local */
      var top = 0, i;
      for (i = 0; i < S.matches.length; i++) {
        var r = S.els[S.matches[i]].getBoundingClientRect();
        if (r.bottom > 0) { S.matchAt = i - (dir > 0 ? 1 : 0); break; }
      }
      if (S.matchAt < -1) S.matchAt = -1;
      void top;
    }
    S.matchAt = (S.matchAt + dir + S.matches.length) % S.matches.length;
    var el = S.els[S.matches[S.matchAt]];
    scrollToEl(el);
    hit(el);
  }

  /* ---------------------------------------------------------- navigation */
  function scrollToEl(el) {
    try { el.scrollIntoView({ block: 'start', behavior: 'auto' }); }
    catch (e) { el.scrollIntoView(); }
  }
  function hit(el) {
    if (S.lastHit) S.lastHit.classList.remove('is-hit');
    el.classList.remove('is-hit');
    void el.offsetWidth;
    el.classList.add('is-hit');
    S.lastHit = el;
    clearTimeout(S.hitTimer);
    S.hitTimer = setTimeout(function () { el.classList.remove('is-hit'); }, 2600);
  }
  /* A deep link has to out-live the shell's scroll restore: showSection()
     calls restoreScroll() *after* mount resolves, and it falls back to the
     section's last remembered scrollTop when the exact route is new. So the
     target is re-asserted on the next frame and once more past the shell's
     own 140 ms retry. Cheap, idempotent, and invisible when it is not needed. */
  function goDeep(id) {
    if (!go(id)) return false;
    var el = S.root.querySelector('.cases-card[data-id="' + String(id).replace(/"/g, '') + '"]');
    if (!el) return true;
    requestAnimationFrame(function () { scrollToEl(el); });
    setTimeout(function () { scrollToEl(el); }, 220);
    return true;
  }

  function go(id, fromEl) {
    var el = S.root && S.root.querySelector('#cases-' + (window.CSS && CSS.escape ? CSS.escape(id) : id));
    if (!el) el = S.root && S.root.querySelector('.cases-card[data-id="' + String(id).replace(/"/g, '') + '"]');
    if (!el) return false;
    if (fromEl && fromEl !== el) {
      S.backTo = fromEl;
      S.back.querySelector('.cases-bt').textContent = 'back to ' + label(fromEl.getAttribute('data-id'));
      S.back.classList.add('is-on');
      clearTimeout(S.backTimer);
      S.backTimer = setTimeout(function () {
        S.back.classList.remove('is-on'); S.backTo = null;
      }, 25000);
    }
    scrollToEl(el);
    hit(el);
    return true;
  }

  /* ------------------------------------------------------------ glossary */
  function showPop(el) {
    if (!S.pop) {
      S.pop = document.createElement('div');
      S.pop.className = 'cases-pop';
      S.pop.style.display = 'none';
      document.body.appendChild(S.pop);
    }
    if (S.popFor === el && S.pop.style.display !== 'none') { hidePop(); return; }
    S.popFor = el;
    var ex = el.getAttribute('data-e');
    S.pop.innerHTML = '<span class="cases-pt">' + esc(el.getAttribute('data-t')) + '</span>' +
      (ex ? '<span class="cases-pe">' + esc(ex) + '</span>' : '') + esc(el.getAttribute('data-g'));
    S.pop.style.display = 'block';
    S.pop.style.left = '-9999px';
    S.pop.style.top = '0px';
    var r = el.getBoundingClientRect(), pr = S.pop.getBoundingClientRect();
    var left = Math.min(Math.max(8, r.left - 8), Math.max(8, window.innerWidth - pr.width - 8));
    var top = r.bottom + 8;
    if (top + pr.height > window.innerHeight - 8) top = Math.max(8, r.top - pr.height - 8);
    S.pop.style.left = left + 'px';
    S.pop.style.top = top + 'px';
  }
  function hidePop() { if (S.pop) S.pop.style.display = 'none'; S.popFor = null; }

  /* ---------------------------------------------------------------- wire */
  function wire() {
    var root = S.root;

    root.addEventListener('click', function (e) {
      var t = e.target;

      var f = t.closest && t.closest('.cases-chip');
      if (f) { toggleFilter(f.getAttribute('data-f'), f.getAttribute('data-v')); return; }

      var j = t.closest && t.closest('[data-jump]');
      if (j) { jump(parseInt(j.getAttribute('data-jump'), 10)); return; }

      if (t.closest && t.closest('[data-clear]')) {
        S.filter = { kind: null, chapter: null, week: null };
        applyFilter();
        return;
      }

      var rail = t.closest && t.closest('[data-go]');
      if (rail && rail.classList.contains('cases-fchip')) {
        e.preventDefault();
        var gid = rail.getAttribute('data-go');
        if (go(gid, rail.closest('.cases-card'))) APP.navigate('#cases/' + gid, { replace: true });
        return;
      }
      if (rail) {
        var target = root.querySelector('#' + rail.getAttribute('data-go'));
        if (target) { e.preventDefault(); scrollToEl(target); }
        return;
      }

      var pl = t.closest && t.closest('.cases-permalink');
      if (pl) {
        e.preventDefault();
        APP.navigate(pl.getAttribute('href'));
        return;
      }

      var gl = t.closest && t.closest('.cases-g');
      if (gl) { e.preventDefault(); showPop(gl); }
    });

    root.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var ch = e.target.closest && e.target.closest('.cases-fchip');
      if (!ch) return;
      e.preventDefault();
      var id = ch.getAttribute('data-go');
      if (go(id, ch.closest('.cases-card'))) APP.navigate('#cases/' + id, { replace: true });
    });

    root.addEventListener('mouseover', function (e) {
      var t = e.target.closest && e.target.closest('.cases-g');
      if (t && t !== S.popFor) showPop(t);
    });
    root.addEventListener('mouseout', function (e) {
      var t = e.target.closest && e.target.closest('.cases-g');
      if (t && t === S.popFor && !(S.pop && e.relatedTarget && S.pop.contains(e.relatedTarget))) hidePop();
    });
    root.addEventListener('focusin', function (e) {
      var t = e.target.closest && e.target.closest('.cases-g');
      if (t) showPop(t);
    });
    (S.sc === window ? window : S.sc).addEventListener('scroll', function () {
      if (S.popFor) hidePop();
    }, { passive: true });
    window.addEventListener('resize', hidePop, { passive: true });

    S.keyHandler = function (e) {
      if (!S.root || !S.root.isConnected || S.root.offsetParent === null) return;
      if (e.key === 'Escape') { hidePop(); return; }
      if (isField(document.activeElement) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'n') { e.preventDefault(); jump(1); }
      else if (e.key === 'p') { e.preventDefault(); jump(-1); }
    };
    document.addEventListener('keydown', S.keyHandler);
  }

  /* ---------------------------------------------------------------- tier */
  function anchored(fn) {
    var keep = null, top = 0, j;
    for (j = 0; j < S.els.length; j++) {
      var r = S.els[j].getBoundingClientRect();
      if (r.bottom > 0) { keep = S.els[j]; top = r.top; break; }
    }
    fn();
    if (keep) {
      var d = keep.getBoundingClientRect().top - top;
      if (d) scrollBy(S.sc, d);
    }
  }
  function paintTier(n) {
    if (!S.root) return;
    n = (n === 1 || n === 2 || n === 3) ? n : 2;
    if (S.root.getAttribute('data-tier') === String(n)) return;
    hidePop();
    /* The slot already reserves the tallest tier's height, so this cannot
       move anything. anchored() is belt-and-braces for sub-pixel drift. */
    anchored(function () {
      S.root.setAttribute('data-tier', String(n));
      [].slice.call(S.root.querySelectorAll('.cases-tier')).forEach(function (t) {
        t.setAttribute('aria-hidden', String(t.getAttribute('data-t') !== String(n)));
      });
    });
  }

  /* --------------------------------------------------------------- route */
  function idFromRoute(route) {
    var raw = (route && (route.raw || route.hash)) || '';
    raw = String(raw).replace(/^#/, '');
    if (route && route.params && route.params.id) return route.params.id;
    var m = /^cases\/(.+)$/.exec(raw);
    if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
    return null;
  }

  /* -------------------------------------------------- bare-hash resolving
   * SPEC §7 asks a bare `#<case-id>` to redirect to `#cases/<id>`. The shell
   * owns normalizeHash() but cannot know the 104 stems, so the roster is
   * published on APP for it (APP.casesHasId) and, if the shell has not been
   * taught the rule, this section self-heals the route. concepts-index is
   * ~6 KB encoded, so it is fetched eagerly rather than on first mount.
   */
  var rosterReady = null;
  function roster() {
    if (rosterReady) return rosterReady;
    rosterReady = APP.payloadJSON('concepts-index').then(function (ix) {
      (((ix || {}).concepts) || []).forEach(function (row) {
        if (!S.index[row.id]) S.index[row.id] = row;
      });
      return S.index;
    }).catch(function () {
      rosterReady = null;          /* do not cache a failure */
      return S.index;
    });
    return rosterReady;
  }
  APP.casesHasId = function (id) { return !!(id && S.index[id]); };

  /* the payload tags may be emitted after this script; wait for the document */
  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else setTimeout(fn, 0);
  }
  whenReady(function () { roster().then(function () {
    if (typeof APP.onRoute !== 'function') return;
    /* a card-to-card hop while cases is already mounted needs no re-mount */
    APP.onRoute(function (r) {
      if (!r || r.section !== 'cases' || !S.built) return;
      var id = idFromRoute(r);
      if (id) goDeep(id);
    });
  }); });

  /* --------------------------------------------------------------- mount */
  var loading = null;
  function load() {
    if (loading) return loading;
    loading = Promise.all([APP.payloadJSON('cases'), roster()])
      .then(function (r) {
        S.cards = r[0] || [];
      });
    return loading;
  }

  APP.registerSection({
    id: 'cases',
    title: 'Cases',
    navOrder: 60,

    mount: function (el, route) {
      var self = this;
      return load().then(function () {
        if (!S.built) build(el);
        else if (!el.contains(S.root)) el.appendChild(S.root);
        paintTier(APP.tier());
        if (!S.matches.length && !S.filter.kind && !S.filter.chapter && !S.filter.week) applyFilter();
        var id = idFromRoute(route || APP.route());
        if (id) goDeep(id);
        void self;
      });
    },

    unmount: function () {
      hidePop();
      if (S.back) S.back.classList.remove('is-on');
      S.backTo = null;
    },

    onTier: function (n) { paintTier(n); },

    /* SPEC §7: a bare `#<token>` that is a case-card stem becomes #cases/<id>.
       The shell asks each section in navOrder; only Cases owns these stems. */
    resolveToken: function (tok) {
      return roster().then(function (index) {
        return index[tok] ? 'cases/' + tok : null;
      });
    },

    /* SPEC §8: title / summary / plain_statement / id, hash #cases/<id> */
    search: function (q) {
      return load().then(function () {
        var raw = String(q || '').trim().toLowerCase();
        if (!raw) return [];
        var toks = raw.split(/\s+/), out = [];
        for (var i = 0; i < S.cards.length; i++) {
          var c = S.cards[i];
          var hay = S.hay[i] || [
            c.title, c.plain_statement, c.applied_use_summary, c.summary, c.id
          ].join(' · ').toLowerCase();
          var ok = true, k;
          for (k = 0; k < toks.length; k++) { if (hay.indexOf(toks[k]) < 0) { ok = false; break; } }
          if (!ok) continue;
          /* SPEC §8 weights live in the shell so every section ranks alike.
             The concept's human label and the applied-use headline are both
             legitimate titles here, so score against each and keep the best. */
          var human = (S.index[c.id] || {}).title || '';
          var body = [c.plain_statement, c.applied_use_summary, c.summary].join(' ');
          var score = Math.max(
            score1(raw, { id: c.id, title: c.title, body: body }),
            score1(raw, { id: c.id, title: human, body: body })
          );
          if (!score) score = 15;
          out.push({
            title: c.title,
            sub: (S.index[c.id] || {}).title || c.id,
            hash: '#cases/' + c.id,
            score: score
          });
        }
        out.sort(function (a, b) { return b.score - a.score || a.title.localeCompare(b.title); });
        return out.slice(0, 8);
      });
    }
  });
})();

})();

/* ===== sections/drill.js ===== */
;(function(){
/* app/sections/drill.js — Worker C
 * The drill room, rebuilt natively in the shell DOM from quiz-banks/engine.js
 * plus the thirteen bank payloads. Ported from the published drill room
 * (artifact 438d8cf) with these changes:
 *   - concept side-links stay inside the app (#map/node=… and #cases/…) instead
 *     of opening the two library artifacts in new tabs;
 *   - the room does not repaint the document's --accent per week (the shell owns
 *     the palette); a week's colour is a stripe on its chip only;
 *   - routing goes through APP.navigate, never location.hash.
 *
 * The draw is the engine's: a mastery-weighted random subset, shuffled question
 * order, shuffled options tracked by option id, and a random stem variant per
 * appearance. A repeat visit therefore never reproduces a sequence. Session size
 * is capped at 8 / 12 / 20 — never the whole bank.
 */
(function () {
  'use strict';

  var APP = window.APP;
  if (!APP || !APP.registerSection) return;

  var WEEKS = [
    { slug: 'week-01', name: 'W1', saturday: '2026-09-12', when: '12 Sep', title: 'Einops and Ray Tracing', count: 78, accent: '#c2477f' },
    { slug: 'week-02', name: 'W2', saturday: '2026-09-19', when: '19 Sep', title: 'Modules and ResNets', count: 88, accent: '#a86a1f' },
    { slug: 'week-03', name: 'W3', saturday: '2026-09-26', when: '26 Sep', title: 'Optimizers and Sweeps', count: 72, accent: '#4a5fc4' },
    { slug: 'week-04', name: 'W4', saturday: '2026-10-03', when: '3 Oct', title: 'Your Own Autograd', count: 76, accent: '#c05a34' },
    { slug: 'week-05', name: 'W5', saturday: '2026-10-10', when: '10 Oct', title: 'Transformer From Scratch', count: 81, accent: '#4c58bd' },
    { slug: 'week-06', name: 'W6', saturday: '2026-10-17', when: '17 Oct', title: 'Hooks and the Cache', count: 79, accent: '#4c58bd' },
    { slug: 'week-07', name: 'W7', saturday: '2026-10-24', when: '24 Oct', title: 'Induction circuits, ablation and activation patching', count: 91, accent: '#4a5fc4' },
    { slug: 'week-08', name: 'W8', saturday: '2026-10-31', when: '31 Oct', title: 'Superposition, feature geometry and sparse autoencoders', count: 96, accent: '#6f8a20' },
    { slug: 'week-09', name: 'W9', saturday: '2026-11-07', when: '7 Nov', title: 'Value functions, DQN and vanilla policy gradients', count: 70, accent: '#5561c9' },
    { slug: 'week-10', name: 'W10', saturday: '2026-11-14', when: '14 Nov', title: 'PPO and RLHF', count: 73, accent: '#a1519f' },
    { slug: 'week-11', name: 'W11', saturday: '2026-11-21', when: '21 Nov', title: 'Eval Design, Inspect and AI Control', count: 78, accent: '#4a63c0' },
    { slug: 'alignment-science', name: 'Ch4', saturday: null, when: 'background', title: 'Alignment science — chapter 4, the capstone quarry', count: 68, accent: '#b45a2a' },
    { slug: 'capstone-weeks-12-14', name: 'W12-14', saturday: '2026-12-12', when: '28 Nov – 12 Dec', title: 'Capstone — three Saturdays and a talk', count: 233, accent: '#8759c0' }
  ];

  var SIZES = [8, 12, 20];
  var PREF_KEY = 'tara-drill-prefs-v1';

  /* Node ids from concept-map/nodes.json, inlined at authoring time exactly as
     the published drill room inlined them. 199 of the 358 concept values used
     across the banks are NOT node ids (the quiz-engine contract §3 says they
     must be), so a map link is drawn only where the destination exists. */
  var MAP_IDS = {};
  ["ablation","activation-cache","activation-capping","activation-oracle","activation-patching","activation-pca","actor-critic","adam","adamw-vs-adam","advantage","agentic-misalignment-testbed","ai-control","algorithmic-task-interpretability","alignment-faking","alphazero","as-strided-and-stride-tricks","assistant-axis","attention-head","attention-pattern","attribution-graph","attribution-patching","autoencoder","autointerp","autorater","backdoor","backprop-and-topological-order","backup-name-mover-head","backward-function","barycentric-coordinates","baseline","batched-raytracing","batchnorm","beam-search","bellman-equation","broadcasting","capstone-project","circuit","circuit-pruning","composition-score","computational-graph","contrastive-steering-vector","convolution","cot-faithfulness","counterfactual-importance","cross-entropy-loss","dataset-generation","dead-latent","defer-to-trusted","denoising-vs-noising","direct-feature-attribution","direct-logit-attribution","discount-factor","distributed-training","dqn","duplicate-token-head","einops-rearrange","einops-reduce","einops-repeat","einsum","eligibility-traces","embedding","emergent-misalignment","emergent-world-representation","entropy-bonus","epsilon-greedy","eval-prompt-engineering","eval-task","eval-threat-model-and-spec","factored-matrix","feature","feature-dimensionality","few-shot-prompting","final-presentation","fourier-basis","function-vector","gan","gated-sae","gelu","generalized-advantage-estimation","grokking","grpo","hooks","indirect-object-identification","induction-heads","induction-score","inspect-ai","interference","investigator-agent","jumprelu-sae","k-composition","kl-divergence","kv-cache","l1-penalty","latent-space","layernorm","linear-layer","linear-probe","linear-representation-hypothesis","llm-agent","llm-scorer","logit-difference","logit-lens","lora","lr-schedule","markov-decision-process","max-activating-examples","max-pooling","minimal-circuit","misalignment-phase-transition","mlp-layer","mode-collapse","model-diffing","model-organism","momentum","monte-carlo-tree-search","multi-armed-bandit","name-mover-head","othellogpt","ov-circuit","padding","paper-replication","path-patching","persona-drift","persona-vector","petri","policy","policy-evaluation","policy-gradient-theorem","policy-improvement","policy-iteration","polysemanticity","positional-embedding","ppo","ppo-clipped-surrogate","previous-token-head","probe-environment","probe-intervention","progress-measure","projection-monitoring","puct","q-composition","q-learning","q-network","q-value","qk-circuit","ray-generation","ray-object-intersection","react-framework","receiver-head","red-team-campaign","red-teaming-results","reference-model","reinforce","reparameterisation-trick","replay-buffer","resampling-importance","residual-block","residual-stream","resnet34","reward-hacking","reward-model","reward-shaping","rlhf","rlhf-kl-penalty","rmsprop","rollout-buffer","s-inhibition-head","sae-latent","sae-steering","safety-usefulness-frontier","sampling","sandbagging","sarsa","scorer","scratchpad-reasoning","self-play","sgd","shutdown-resistance","softmax-attention-and-causal-mask","solver","sparse-autoencoder","sparsity","steering-hook","steering-vector","structured-output","superposition","suspiciousness-score","target-network","td-error","temperature","tensor-strides","thought-anchor","tokenization","tool-use","top-k-sampling","top-p-sampling","topological-sort","training-loop","transcoder","transformer-block","transformerlens","trust-region","trusted-editing","trusted-monitoring","ucb-selection","unbroadcast","unembedding","upfront-auditing","vae","value-function","value-function-loss","value-head","variance-prompt","wandb-sweep","weight-decay"].forEach(function (id) { MAP_IDS[id] = true; });

  var BYSLUG = {};
  WEEKS.forEach(function (w) { BYSLUG[w.slug] = w; });

  /* ------------------------------------------------------------ prefs ---- */
  var mem = {};
  function prefGet() {
    try { if (window.localStorage) { var v = localStorage.getItem(PREF_KEY); if (v) return JSON.parse(v); } }
    catch (e) {}
    try { return mem[PREF_KEY] ? JSON.parse(mem[PREF_KEY]) : {}; } catch (e) { return {}; }
  }
  function prefSet(o) {
    var s = JSON.stringify(o);
    mem[PREF_KEY] = s;
    try { if (window.localStorage) localStorage.setItem(PREF_KEY, s); } catch (e) {}
  }

  /* ------------------------------------------------------------ state ---- */
  var prefs = prefGet();
  var S = {
    built: false,
    root: null,
    els: {},
    banks: {},        // slug -> bank JSON (decoded lazily, cached)
    QIDX: {},         // question id -> {c: concept, w: slug}
    CLABEL: {},       // concept id -> human label
    CASE_IDS: {},     // concept id -> true when a case card exists
    slug: null,
    size: SIZES.indexOf(prefs.size) >= 0 ? prefs.size : 12,
    concept: null,
    inst: null,
    answered: 0,
    engineReady: null,
    mo: null
  };

  function esc(s) { return String(s == null ? '' : s); }

  /* --------------------------------------------------------- the engine -- */
  function loadEngine() {
    if (S.engineReady) return S.engineReady;
    if (window.TARA_QUIZ && window.TARA_QUIZ.__installed) {
      S.engineReady = Promise.resolve(true);
      return S.engineReady;
    }
    S.engineReady = APP.payload('engine').then(function (src) {
      /* An inline <script> element, not eval(): the artifact CSP allows inline
         script (the whole app is one) but need not allow unsafe-eval. */
      var s = document.createElement('script');
      s.textContent = src;
      (document.head || document.documentElement).appendChild(s);
      return !!(window.TARA_QUIZ && window.TARA_QUIZ.mount);
    }).catch(function () { return false; });
    return S.engineReady;
  }

  function loadBank(slug) {
    if (S.banks[slug]) return Promise.resolve(S.banks[slug]);
    return APP.payloadJSON('bank:' + slug).then(function (b) {
      S.banks[slug] = b;
      (b.concepts || []).forEach(function (c) {
        if (c && c.id && !S.CLABEL[c.id]) S.CLABEL[c.id] = c.label || c.id;
      });
      (b.questions || []).forEach(function (q) {
        if (q && q.id) S.QIDX[q.id] = { c: q.concept, w: slug };
      });
      return b;
    }).catch(function () { return null; });
  }

  /* Index every bank once, so "what's shaky" can aggregate across banks and
     search() can see all thirteen. Cheap next to the decode itself. */
  var allLoaded = null;
  function loadAll() {
    if (allLoaded) return allLoaded;
    allLoaded = Promise.all(WEEKS.map(function (w) { return loadBank(w.slug); }));
    return allLoaded;
  }

  /* -------------------------------------------------- concept side-links -- */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function arrowSVG() {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M4.2 2.2h5.6v5.6M9.8 2.2 2.4 9.6');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.7');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }
  function makeLink(hash, short, full) {
    var a = document.createElement('a');
    a.className = 'drill-clink';
    a.href = hash;
    a.title = full;
    a.setAttribute('aria-label', full);
    a.appendChild(document.createTextNode(short));
    a.appendChild(arrowSVG());
    a.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();   /* the chip beside this one redraws the session */
      APP.navigate(hash);
    });
    return a;
  }
  function conceptLinks(id) {
    if (!id) return null;
    var hasMap = MAP_IDS[id] === true, hasCase = S.CASE_IDS[id] === true;
    if (!hasMap && !hasCase) return null;
    var lab = S.CLABEL[id] || id;
    var span = document.createElement('span');
    span.className = 'drill-clinks';
    span.setAttribute('data-concept', id);
    if (hasMap) span.appendChild(makeLink('#map/node=' + encodeURIComponent(id), 'map',
      'See ' + lab + ' in the concept map'));
    if (hasCase) span.appendChild(makeLink('#cases/' + encodeURIComponent(id), 'used',
      'See ' + lab + ' used in practice'));
    return span;
  }
  /* The chips belong to the engine, so decorate where they land rather than
     reaching into engine.js. */
  function decorateChips() {
    if (!S.els.stage) return;
    var chips = S.els.stage.querySelectorAll('.tara-quiz-chip[data-concept]');
    Array.prototype.forEach.call(chips, function (chip) {
      if (chip.getAttribute('data-clinked')) return;
      chip.setAttribute('data-clinked', '1');
      var links = conceptLinks(chip.getAttribute('data-concept'));
      if (!links) return;
      if (chip.nextSibling) chip.parentNode.insertBefore(links, chip.nextSibling);
      else chip.parentNode.appendChild(links);
    });
  }

  /* ------------------------------------------------------- which week --- */
  function todayISO() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function defaultSlug() {
    var t = todayISO(), i, last = null;
    for (i = 0; i < WEEKS.length; i++) {
      if (WEEKS[i].saturday && WEEKS[i].saturday >= t) return WEEKS[i].slug;
    }
    for (i = 0; i < WEEKS.length; i++) if (WEEKS[i].saturday) last = WEEKS[i];
    return (last && t > last.saturday) ? last.slug : 'week-01';
  }

  /* ------------------------------------------------------------ chrome --- */
  function build(el) {
    el.innerHTML =
      '<div class="drill-root">' +
        '<div class="drill-rail">' +
          '<div class="drill-rail-top">' +
            '<h2 class="drill-now" data-now>Drill room<span class="drill-now-sub" data-now-sub></span></h2>' +
            '<span class="drill-focus" data-focus><span data-focus-label></span>' +
              '<button type="button" data-focus-clear aria-label="Drill the whole week again">×</button></span>' +
            '<span class="drill-sizer"><span class="drill-sizer-lab">questions</span>' +
              '<span class="drill-seg" data-sizes role="group" aria-label="Questions per session"></span></span>' +
            '<button type="button" class="drill-redraw" data-redraw title="Draw a fresh set from this bank">new draw</button>' +
          '</div>' +
          '<div class="drill-weeks" data-weeks role="group" aria-label="Week"></div>' +
        '</div>' +
        '<div class="drill-floor">' +
          '<div class="drill-stage" data-stage></div>' +
          '<aside class="drill-shaky" data-shaky aria-live="polite"></aside>' +
        '</div>' +
      '</div>';

    S.root = el.querySelector('.drill-root');
    S.els = {
      now: S.root.querySelector('[data-now]'),
      nowSub: S.root.querySelector('[data-now-sub]'),
      weeks: S.root.querySelector('[data-weeks]'),
      sizes: S.root.querySelector('[data-sizes]'),
      stage: S.root.querySelector('[data-stage]'),
      shaky: S.root.querySelector('[data-shaky]'),
      focus: S.root.querySelector('[data-focus]'),
      focusLabel: S.root.querySelector('[data-focus-label]'),
      focusClear: S.root.querySelector('[data-focus-clear]')
    };

    WEEKS.forEach(function (w) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'drill-wk';
      b.setAttribute('data-slug', w.slug);
      b.setAttribute('aria-pressed', 'false');
      b.title = w.title + ' — ' + w.when + ' · ' + w.count + ' questions';
      b.style.setProperty('--dw', w.accent);
      b.innerHTML = '<span class="drill-wk-id"></span><span class="drill-wk-meta"></span>';
      b.querySelector('.drill-wk-id').textContent = w.name;
      b.querySelector('.drill-wk-meta').textContent = w.when + ' · ' + w.count;
      b.addEventListener('click', function () { APP.navigate('#drill/' + w.slug); });
      S.els.weeks.appendChild(b);
      w._btn = b;
    });
    var next = defaultSlug();
    if (BYSLUG[next] && BYSLUG[next]._btn) BYSLUG[next]._btn.classList.add('is-next');

    SIZES.forEach(function (n) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = String(n);
      b.setAttribute('data-size', String(n));
      b.setAttribute('aria-pressed', String(n === S.size));
      b.addEventListener('click', function () {
        if (n === S.size) return;
        S.size = n;
        prefs.size = n;
        prefSet(prefs);
        Array.prototype.forEach.call(S.els.sizes.children, function (c) {
          c.setAttribute('aria-pressed', String(c.getAttribute('data-size') === String(n)));
        });
        draw(true);
      });
      S.els.sizes.appendChild(b);
    });

    S.els.focusClear.addEventListener('click', function () {
      S.concept = null;
      APP.navigate('#drill/' + S.slug, { replace: true });
      draw(true);
    });
    S.root.querySelector('[data-redraw]').addEventListener('click', function () { draw(true); });

    document.addEventListener('tara:quiz-answered', onAnswered);
    if (window.MutationObserver) {
      S.mo = new MutationObserver(decorateChips);
      S.mo.observe(S.els.stage, { childList: true, subtree: true });
    }
    S.built = true;
  }

  function onAnswered() {
    S.answered++;
    paintShaky();
    decorateChips();
  }

  function paintHeader() {
    var w = BYSLUG[S.slug] || {};
    S.els.now.firstChild.nodeValue = w.title || S.slug || 'Drill room';
    S.els.nowSub.textContent = [w.name, w.when, (w.count || 0) + ' questions']
      .filter(Boolean).join(' · ');
    WEEKS.forEach(function (x) {
      if (x._btn) x._btn.setAttribute('aria-pressed', String(x.slug === S.slug));
    });
    var cur = BYSLUG[S.slug];
    if (cur && cur._btn && cur._btn.scrollIntoView) {
      try { cur._btn.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) {}
    }
    if (S.concept) {
      S.els.focusLabel.textContent = 'only ' + (S.CLABEL[S.concept] || S.concept);
      S.els.focus.classList.add('is-on');
    } else {
      S.els.focus.classList.remove('is-on');
    }
  }

  /* -------------------------------------------------------------- draw --- */
  function draw(force) {
    var slug = S.slug;
    if (!slug) return Promise.resolve();
    return Promise.all([loadEngine(), loadBank(slug)]).then(function (r) {
      var okEngine = r[0], bank = r[1];
      paintHeader();
      if (!okEngine || !bank) {
        S.els.stage.className = 'drill-stage drill-fallback';
        S.els.stage.textContent = okEngine
          ? 'That bank would not load. Pick another week above.'
          : 'The quiz engine would not load, so there is nothing to drill right now.';
        return;
      }
      /* Keep an unfinished session alive when re-entering the same week; a
         finished one, or an explicit redraw, always gets a fresh shuffle. */
      if (!force && S.inst && S.inst.el === S.els.stage && S.inst.week === slug &&
          S.answered > 0 && S.answered < S.size) {
        paintShaky();
        return;
      }
      S.els.stage.className = 'drill-stage';
      S.answered = 0;
      var opts = {
        el: S.els.stage,
        bank: bank,
        week: slug,
        sessionSize: S.size,
        onConcept: function (id) {
          if (!S.CLABEL[id]) return;
          S.concept = id;
          APP.navigate('#drill/' + S.slug + '/' + encodeURIComponent(id), { replace: true });
          draw(true);
        }
      };
      if (S.concept) opts.concepts = [S.concept];
      S.inst = window.TARA_QUIZ ? window.TARA_QUIZ.mount(opts) : null;
      if (!S.inst) {
        S.els.stage.className = 'drill-stage drill-fallback';
        S.els.stage.textContent = 'That bank would not load. Pick another week above.';
      }
      decorateChips();
      paintShaky();
    });
  }

  /* ------------------------------------------------------ what's shaky --- */
  function paintShaky() {
    if (!S.els.shaky) return;
    var st = window.TARA_QUIZ && window.TARA_QUIZ.stats ? window.TARA_QUIZ.stats() : null;
    if (!st) return;
    var per = st.perQuestion || {}, agg = {}, touched = {}, banks = {};
    Object.keys(per).forEach(function (qid) {
      var r = per[qid], idx = S.QIDX[qid];
      if (!r || !r.seen || !idx || !idx.c) return;
      banks[idx.w] = true;
      var a = agg[idx.c] || (agg[idx.c] = { id: idx.c, seen: 0, wrong: 0, banks: {} });
      a.seen += r.seen; a.wrong += r.wrong; a.banks[idx.w] = true;
      touched[idx.c] = true;
    });
    var rows = Object.keys(agg).map(function (k) { return agg[k]; })
      .filter(function (a) { return a.wrong > 0; })
      .sort(function (a, b) {
        var sa = a.wrong / a.seen, sb = b.wrong / b.seen;
        return sb - sa || b.wrong - a.wrong;
      }).slice(0, 6);

    var out = document.createDocumentFragment();
    var h = document.createElement('h2');
    h.appendChild(document.createTextNode("What's shaky"));
    if (rows.length) {
      var n = document.createElement('span');
      n.className = 'drill-n';
      n.textContent = String(rows.length);
      h.appendChild(n);
    }
    out.appendChild(h);

    if (!rows.length) {
      var p = document.createElement('p');
      p.className = 'drill-shaky-empty';
      p.textContent = Object.keys(touched).length
        ? 'Nothing shaky yet — everything you have touched has held up. Keep going.'
        : 'Answer a few and the concepts you keep dropping collect here — across every bank you touch, not just this one.';
      out.appendChild(p);
    } else {
      var ol = document.createElement('ol');
      rows.forEach(function (a) {
        var li = document.createElement('li');
        var top = document.createElement('div');
        top.className = 'drill-sh-top';
        var name = document.createElement('button');
        name.type = 'button';
        name.className = 'drill-sh-name';
        name.textContent = S.CLABEL[a.id] || a.id;
        name.title = 'Drill just this concept';
        var home = Object.keys(a.banks)[0];
        name.addEventListener('click', function () {
          APP.navigate('#drill/' + home + '/' + encodeURIComponent(a.id));
        });
        var miss = document.createElement('span');
        miss.className = 'drill-sh-miss';
        miss.textContent = a.wrong + ' missed';
        top.appendChild(name); top.appendChild(miss);
        var bar = document.createElement('div');
        bar.className = 'drill-sh-bar';
        var fill = document.createElement('i');
        fill.style.width = Math.max(8, Math.round(100 * a.wrong / a.seen)) + '%';
        bar.appendChild(fill);
        var from = document.createElement('div');
        from.className = 'drill-sh-from';
        Object.keys(a.banks).forEach(function (slug) {
          var s = document.createElement('span');
          s.textContent = (BYSLUG[slug] && BYSLUG[slug].name) || slug;
          from.appendChild(s);
        });
        var links = conceptLinks(a.id);
        if (links) from.appendChild(links);
        li.appendChild(top); li.appendChild(bar); li.appendChild(from);
        ol.appendChild(li);
      });
      out.appendChild(ol);
    }

    var foot = document.createElement('div');
    foot.className = 'drill-shaky-foot';
    var l = document.createElement('span');
    var nb = Object.keys(banks).length;
    l.textContent = Object.keys(touched).length
      ? Object.keys(touched).length + ' concepts seen · ' + nb + ' bank' + (nb === 1 ? '' : 's')
      : 'nothing tracked yet';
    var rr = document.createElement('span');
    rr.textContent = st.storage === 'memory' ? 'this tab only' : 'saved on this device';
    foot.appendChild(l); foot.appendChild(rr);
    out.appendChild(foot);

    while (S.els.shaky.firstChild) S.els.shaky.removeChild(S.els.shaky.firstChild);
    S.els.shaky.appendChild(out);
  }

  /* ------------------------------------------------------------- route --- */
  var SLUG_BY_LOWER = {};
  WEEKS.forEach(function (w) { SLUG_BY_LOWER[w.slug.toLowerCase()] = w.slug; });

  function parseRoute(route) {
    var raw = (route && (route.raw || route.hash)) || '';
    raw = String(raw).replace(/^#/, '');
    var m = /^drill(?:\/(.*))?$/.exec(raw);
    var rest = m && m[1] ? m[1] : '';
    if (!rest && route && route.params) {
      rest = [route.params.week || route.params.slug || '', route.params.concept || '']
        .filter(Boolean).join('/');
    }
    if (!rest) return { slug: null, concept: null };
    var parts = rest.split('/');
    var slug = SLUG_BY_LOWER[String(parts[0] || '').trim().toLowerCase()] || null;
    var concept = parts[1] ? decodeURIComponent(parts[1]) : null;
    return { slug: slug, concept: concept };
  }

  /* -------------------------------------------------------------- mount -- */
  APP.registerSection({
    id: 'drill',
    title: 'Drill',
    navOrder: 70,

    mount: function (el, route) {
      if (!S.built) build(el);
      else if (!el.contains(S.root)) el.appendChild(S.root);

      /* the case-card roster decides which concepts get a "used" link */
      if (!Object.keys(S.CASE_IDS).length) {
        APP.payloadJSON('concepts-index').then(function (ix) {
          ((ix && ix.concepts) || []).forEach(function (c) {
            S.CASE_IDS[c.id] = true;
            if (!S.CLABEL[c.id]) S.CLABEL[c.id] = c.title || c.id;
          });
        }).catch(function () {});
      }

      var r = parseRoute(route || APP.route());
      var want = r.slug || S.slug || defaultSlug();
      var changed = want !== S.slug || (r.concept || null) !== S.concept;
      S.slug = want;
      S.concept = r.concept || null;

      return loadAll().then(function () {
        return draw(changed || !S.inst);
      });
    },

    unmount: function () {},

    /* SPEC §8: distinct concepts across the banks + question counts.
       Hash is #drill/<slug>/<concept>, which preselects the concept. */
    search: function (q) {
      return loadAll().then(function () {
        var raw = String(q || '').trim().toLowerCase();
        if (!raw) return [];
        var counts = {};
        Object.keys(S.QIDX).forEach(function (qid) {
          var e = S.QIDX[qid];
          if (!e || !e.c) return;
          var a = counts[e.c] || (counts[e.c] = { n: 0, banks: {} });
          a.n++;
          a.banks[e.w] = (a.banks[e.w] || 0) + 1;
        });
        var out = [];
        Object.keys(counts).forEach(function (id) {
          var lab = S.CLABEL[id] || id;
          var l = lab.toLowerCase();
          if (id.indexOf(raw) < 0 && l.indexOf(raw) < 0) return;
          /* SPEC §8 weights come from the shell so every group ranks alike */
          var score = typeof APP.score === 'function'
            ? APP.score(raw, { id: id, title: lab, body: id })
            : (id === raw ? 100 : (l.indexOf(raw) === 0 ? 60 : 40));
          if (!score) score = 15;
          var banks = counts[id].banks;
          var home = Object.keys(banks).sort(function (a, b) { return banks[b] - banks[a]; })[0];
          out.push({
            title: lab,
            sub: counts[id].n + (counts[id].n === 1 ? ' question' : ' questions') +
              ' · ' + ((BYSLUG[home] || {}).name || home),
            hash: '#drill/' + home + '/' + encodeURIComponent(id),
            score: score
          });
        });
        out.sort(function (a, b) { return b.score - a.score || a.title.localeCompare(b.title); });
        return out.slice(0, 8);
      });
    }
  });

  void esc;
})();

})();
