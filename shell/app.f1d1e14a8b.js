/* ===== src/shell/shell.js ===== */
;(function(){
/* src/shell/shell.js — defines window.APP: payloads, tier, router, frames,
   sections, tabs. V1's shell (SPEC §6, §6.1, §7), evolved for V2 (src/V2-CONTRACT.md):
   five tabs instead of nine nav items, the V2 routes (#today, #weeks, #practice,
   #library, #lab, #view/<path>) with route.params.rest, ?today=YYYY-MM-DD,
   APP.v2now, APP.viewHref, APP.onBoot. Every V1 route and redirect is unchanged.
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
/* SPEC §4, plus one thing V2's copy adds (V1's copy, in build-site.js, is unchanged):
   when a payload file named by window.__MANIFEST is gone (a deploy gave it a new
   content-hashed name while this page was open, or a build left next.html behind),
   the manifest is read again once from V1's document and the key retried once. */

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

/* The manifest as V1's document (window.__MANIFEST_DOC, index.html) carries it
   now, past the HTTP cache. One read per page; a read that failed (offline) may
   be tried again by the next payload that fails. Resolves to the new index. */
var _refresh = null;
function refreshManifest() {
  if (_refresh) return _refresh;
  _refresh = (async function () {
    var res = await fetch(assetURL(window.__MANIFEST_DOC || 'index.html'), { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) throw new Error('manifest: HTTP ' + res.status);
    var m = /<script>window\.__MANIFEST=(\[[\s\S]*?\]);<\/script>/.exec(await res.text());
    if (!m) throw new Error('manifest: none in ' + (window.__MANIFEST_DOC || 'index.html'));
    var list = JSON.parse(m[1]);
    if (!Array.isArray(list) || !list.length) throw new Error('manifest: empty');
    window.__MANIFEST = list;
    _index = null;
    return payloadIndex();
  })();
  _refresh.catch(function () { _refresh = null; });
  return _refresh;
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
    var res = null, failed = null;
    if (rec && rec.file) {
      try { res = await fetch(assetURL(rec.file), { credentials: 'same-origin' }); } catch (e) { failed = e; }
    }
    if (!res || !res.ok) {
      /* not listed, 404 or no answer: the manifest may be stale. Read it again
         (once per page), and retry once with the name it gives now. */
      var fresh = null;
      try { fresh = (await refreshManifest())[key]; } catch (e) { /* offline too: keep the first error */ }
      if (fresh && fresh.file) {
        rec = fresh;
        try { res = await fetch(assetURL(rec.file), { credentials: 'same-origin' }); failed = null; } catch (e) { failed = e; }
      }
    }
    if (!rec || !rec.file) throw new Error('no payload: ' + key);
    if (!res) throw failed || new Error('payload ' + key + ': no response');
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
  /* V2: other modules (the viewer's link interceptor) attach to every frame. */
  for (var i = 0; i < frameLoadHooks.length; i++) {
    try { frameLoadHooks[i](f, d, w); } catch (e) { console.warn('frame load hook failed', e); }
  }
}
var frameLoadHooks = [];
APP.frames._onLoad = onFrameLoad;
/* APP.frames.onLoad(fn(iframe, doc, win)): run fn for every srcdoc frame that
   loads from now on, and once for each frame already loaded. */
APP.frames.onLoad = function (fn) {
  frameLoadHooks.push(fn);
  live.forEach(function (f) {
    var d = APP.frames.doc(f);
    if (d && d.readyState !== 'loading' && d.body) { try { fn(f, d, APP.frames.win(f)); } catch (e) {} }
  });
};

/* ================================================================ sections */

/* Every section the router knows, authored here, not derived from what happened
   to build. The order is the order search groups render in; it never re-sorts
   (SPEC rule 1). `tab` is the V2 tab the section lives under. */
var NAV = [
  { id: 'today',    title: 'Today',    navOrder: 0,  hash: 'today',    tab: 'today' },
  { id: 'weeks',    title: 'Weeks',    navOrder: 1,  hash: 'weeks',    tab: 'weeks' },
  { id: 'practice', title: 'Practice', navOrder: 2,  hash: 'practice', tab: 'practice' },
  { id: 'drill',    title: 'Drill',    navOrder: 3,  hash: 'drill',    tab: 'practice' },
  { id: 'library',  title: 'Library',  navOrder: 4,  hash: 'library',  tab: 'library' },
  { id: 'plan',     title: 'Plan',     navOrder: 5,  hash: 'plan',     tab: 'library' },
  { id: 'packs',    title: 'Packs',    navOrder: 6,  hash: 'packs',    tab: 'library' },
  { id: 'demos',    title: 'Demos',    navOrder: 7,  hash: 'demos',    tab: 'library' },
  { id: 'map',      title: 'Map',      navOrder: 8,  hash: 'map',      tab: 'library' },
  { id: 'cases',    title: 'Cases',    navOrder: 9,  hash: 'cases',    tab: 'library' },
  { id: 'sprint',   title: 'Sprint',   navOrder: 10, hash: 'sprint',   tab: 'library' },
  { id: 'manual',   title: 'Manual',   navOrder: 11, hash: 'manual',   tab: 'library' },
  { id: 'view',     title: 'Viewer',   navOrder: 12, hash: 'library',  tab: 'library' },
  { id: 'lab',      title: 'Lab',      navOrder: 13, hash: 'lab',      tab: 'lab' }
];
APP.NAV = NAV;

/* The five tabs, in their one order. */
var TABS = [
  { id: 'today',    title: 'Today',    hash: 'today' },
  { id: 'weeks',    title: 'Weeks',    hash: 'weeks' },
  { id: 'practice', title: 'Practice', hash: 'practice' },
  { id: 'library',  title: 'Library',  hash: 'library' },
  { id: 'lab',      title: 'Lab',      hash: 'lab' }
];
APP.TABS = TABS;
APP.tabOf = function (sectionId) {
  for (var i = 0; i < NAV.length; i++) if (NAV[i].id === sectionId) return NAV[i].tab;
  return 'today';
};

/* Sections new in V2 get route.params.rest (the decoded remainder after the
   first "/") and parse it themselves. */
var V2_SECTIONS = { today: 1, weeks: 1, practice: 1, library: 1, lab: 1, view: 1 };
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

  /* V2: Today shows the next Saturday only; any other week is a Weeks page.
     #today/week-NN (V1's week strip, also week-N and wN) -> #weeks/N. */
  if (head === 'today' && (m = /^w(?:eek)?-?(\d{1,2})$/i.exec(tail))) return 'weeks/' + Number(m[1]);

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
    if (V2_SECTIONS[head] === 1) {
      /* absent when there is no remainder, so #weeks restores its scroll position */
      try { r.params.rest = decodeURIComponent(rest); } catch (e) { r.params.rest = rest; }
      return r;
    }
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
var replacing = false;
APP.navigate = function (hash, opts) {
  var h = stripHash(hash) || 'today';
  var target = '#' + h;
  if (location.hash === target) { handleHash(); return; }
  if (opts && opts.replace) { replacing = true; history.replaceState(null, '', target); handleHash(); }
  else location.hash = target;
};

/* V2: each history entry the shell shows carries, in history.state,
     v2i      its place in this tab's history, counted as entries are pushed
     v2from   the route it was opened from (the last route of another section;
              a film opened from a film keeps the first one's), v2fromI its v2i
     v2tab    the tab it lights: a section's own tab, except that a film, a pack,
              a demo or a Library door keeps the tab it was opened from
   Stamped the first time the entry is shown, so Back and Forward find it as it
   was. The viewer's close and the doors' back pill use v2from to step back in
   history instead of pushing one more entry (APP.backTo). */
var BORROWED = { view: 1, packs: 1, demos: 1, plan: 1, map: 1, cases: 1, sprint: 1, manual: 1 };
var _entry = { i: 0, raw: null, section: null, tab: null, from: null, fromI: 0 };
function readState() {
  var st = null;
  try { st = history.state; } catch (e) {}
  return st && typeof st === 'object' ? st : null;
}
function stampEntry(r) {
  var st = readState();
  var own = APP.tabOf(r.section);
  if (!st || typeof st.v2i !== 'number') {
    var prev = _entry, s = {};
    if (replacing) {
      /* it takes the place of the entry on screen: same place, same opener */
      s.v2i = prev.i || 1;
      if (prev.from != null) { s.v2from = prev.from; s.v2fromI = prev.fromI; }
      s.v2tab = BORROWED[r.section] === 1 && prev.tab ? prev.tab : own;
    } else {
      s.v2i = prev.i + 1;
      if (prev.raw != null) {
        if (prev.section === r.section) { if (prev.from != null) { s.v2from = prev.from; s.v2fromI = prev.fromI; } }
        else { s.v2from = prev.raw; s.v2fromI = prev.i; }
      }
      s.v2tab = BORROWED[r.section] === 1 && prev.tab ? prev.tab : own;
    }
    st = Object.assign({}, st || {}, s);
    try { history.replaceState(st, '', location.href); } catch (e) {}
  }
  replacing = false;
  _entry = {
    i: st.v2i, raw: r.raw, section: r.section,
    tab: (window.TARA_SHELL === 'v2' && st.v2tab) || own,
    from: st.v2from == null ? null : st.v2from, fromI: st.v2fromI || 0
  };
}
/* APP.entry() -> {i, from, fromI, tab}: the entry on screen. */
APP.entry = function () { return { i: _entry.i, from: _entry.from, fromI: _entry.fromI, tab: _entry.tab }; };
/* APP.backTo(fallback, extra): back in history to where this entry was opened
   from; with no opener in this tab's history (a deep link, a reload of an old
   tab), replace this entry with `fallback` instead, so Back never reopens it.
   `extra`: entries a frame pushed on top of the shell's own (the viewer counts
   them), stepped back over as well. */
APP.backTo = function (fallback, extra) {
  var n = _entry.from != null && _entry.fromI > 0 ? _entry.i - _entry.fromI : 0;
  if (n > 0) { history.go(-(n + (extra > 0 ? extra : 0))); return; }
  APP.navigate(fallback || 'today', { replace: true });
};
/* history.replaceState that keeps this entry's v2 stamps (for code that moves the
   hash in place: the viewer, the decks, the search panel). */
APP.replaceHash = function (h) {
  try { history.replaceState(readState(), '', '#' + stripHash(h)); } catch (e) {}
  _entry.raw = stripHash(h);
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
    try { history.replaceState(readState(), '', '#' + h); } finally { navLock = false; }
  }

  var r = parseRoute(h);

  /* #search/<q> opens the panel and leaves the section alone (SPEC §7). */
  if (r.section === 'search') {
    /* an entry of the section on screen (closing the panel puts its hash back) */
    var cur = APP._route;
    stampEntry({ section: cur ? cur.section : 'today', raw: cur ? cur.raw : 'today' });
    if (typeof APP.openSearch === 'function') APP.openSearch(r.params.q);
    return;
  }

  APP._route = r;
  _clickInDrill = false;
  stampEntry(r);
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

  var olds = el.querySelectorAll('.v2-secoops');
  for (var oi = 0; oi < olds.length; oi++) olds[oi].parentNode.removeChild(olds[oi]);
  try {
    await rec.def.mount(el, r);
    rec.mounted = true;
  } catch (e) {
    console.error('mount failed: ' + id, e);
    if (window.TARA_SHELL === 'v2') {
      /* the oops panel at the top of the section; in a framed section, under its
         bar and in place of the frame (an older frame there would pass for this one) */
      var panel = APP.oops(e, function () { handleHash(); }, 'v2-secoops');
      var host = el.querySelector('.app-fr-wrap:not([hidden]) > .app-fr-host');
      if (host) { APP.frames.only(host, null); host.insertBefore(panel, host.firstChild); }
      else el.insertBefore(panel, el.firstChild);
    } else if (!el.firstChild) {
      el.appendChild(APP.el('div', { 'class': 'app-sec-pad' }, [
        APP.el('p', { 'class': 'app-empty', text: 'This section failed to load: ' + (e && e.message ? e.message : e) })
      ]));
    }
  }
  restoreScroll(r, id, el);
}

/* V2: was this failure the network's? (offline, or a fetch that got no answer) */
APP.isOffline = function (e) {
  if (navigator.onLine === false) return true;
  var m = String((e && (e.message || e)) || '');
  return /failed to fetch|networkerror|network error|load failed|offline|HTTP 503/i.test(m);
};
/* APP.oops(err, retry, cls, opts): the brand's oops panel, calm, with Try again.
   opts.line replaces the line when the network is up; opts.link {href, text}
   adds a way out beside Try again. */
APP.oops = function (err, retry, cls, opts) {
  var off = APP.isOffline(err);
  var line = off ? 'offline, and this part was not saved yet. it will be after one visit online.'
    : (opts && opts.line) || 'that fumbled. nothing is lost; try again.';
  var box = APP.el('div', { 'class': 'fu-oops', role: 'alert' }, [
    APP.el('p', { 'class': 'fu-oops__line', text: line }),
    off || (opts && opts.line) ? null : APP.el('p', { 'class': 'fu-oops__detail', text: String((err && err.message) || err || 'it did not load') })
  ]);
  var acts = APP.el('div', { 'class': 'v2-oopsacts' });
  var b = APP.el('button', { type: 'button', 'class': 'fu-btn', text: 'Try again' });
  b.addEventListener('click', function () {
    var w = b.closest('.v2-oopswrap');
    if (w && w.parentNode) w.parentNode.removeChild(w);
    if (retry) retry();
  });
  acts.appendChild(b);
  if (opts && opts.link) acts.appendChild(APP.el('a', { 'class': 'fu-btn fu-btn--ghost', href: opts.link.href, text: opts.link.text }));
  box.appendChild(acts);
  return APP.el('div', { 'class': 'app-sec-pad v2-oopswrap' + (cls ? ' ' + cls : '') }, [box]);
};

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

/* V2: the tabs ([data-tab], in the top bar and the phone tab bar) light up for
   the tab that owns the section on screen. A V1 nav list, if a template still
   carries one, is painted as before. */
function paintNav(activeId) {
  var tab = window.TARA_SHELL === 'v2' && _entry.section === activeId && _entry.tab ? _entry.tab : APP.tabOf(activeId);
  document.documentElement.setAttribute('data-tab', tab);
  document.documentElement.setAttribute('data-section', activeId);
  var tabs = document.querySelectorAll('[data-tab]:not(html)');
  for (var t = 0; t < tabs.length; t++) {
    if (tabs[t].getAttribute('data-tab') === tab) tabs[t].setAttribute('aria-current', 'page');
    else tabs[t].removeAttribute('aria-current');
  }
  var list = document.getElementById('app-navlist');
  if (!list) return;
  var links = list.querySelectorAll('.app-navlink');
  for (var i = 0; i < links.length; i++) {
    var on = links[i].getAttribute('data-sec') === activeId;
    if (on) links[i].setAttribute('aria-current', 'page');
    else links[i].removeAttribute('aria-current');
  }
}
APP._paintNav = paintNav;

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
  if (quizOwnsDigits(t)) return;
  APP.setTier(Number(e.key), { announce: true });
}

/* V2: a quiz answers 1-9 itself (the drill room, Practice's mixed drill, check
   questions anywhere, in the shell or in a frame), so the tier keys stand aside
   while one is on screen or has the focus. A quiz inside a frame (a pack's check
   questions) owns the digits only once the learner pressed, clicked or tabbed into
   it (packs.js marks it data-v2-armed): the engine focuses its quiz on render, far
   below the fold, and 1/2/3 must not answer a question nobody has seen.
   V1 (no TARA_SHELL) is unchanged. */
function quizOwnsDigits(t) {
  if (window.TARA_SHELL !== 'v2') return false;
  try {
    var r = APP.route && APP.route();
    if (r && (r.section === 'drill' || (r.section === 'practice' && /^mixed/.test((r.params && r.params.rest) || '')))) return true;
    var q = t && t.closest ? t.closest('.tara-quiz') : null;
    if (q) return q.ownerDocument === document || q.hasAttribute('data-v2-armed');
    var qs = document.querySelectorAll('.tara-quiz');
    for (var i = 0; i < qs.length; i++) if (qs[i].getClientRects().length) return true;
  } catch (x) {}
  return false;
}

/* =================================================================== today */
/* APP.schedule() / APP.today() — SPEC §9. today.js renders; this computes. */

var _schedule = null;
APP.schedule = function () { return _schedule; };

/* ?today=YYYY-MM-DD in the page URL (before the hash) stands in for the real
   date everywhere that asks APP.todayISO() — for trying Saturday mode, the
   project phase or the course's end without waiting for them. */
var DATE_OVERRIDE = (function () {
  try {
    var m = /[?&]today=(\d{4}-\d{2}-\d{2})(?:&|$)/.exec(location.search || '');
    if (m && !isNaN(Date.parse(m[1] + 'T00:00:00'))) return m[1];
  } catch (e) {}
  return null;
})();
APP.dateOverride = function () { return DATE_OVERRIDE; };

function todayISO(d) {
  if (!d && DATE_OVERRIDE) return DATE_OVERRIDE;
  d = d || new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
APP.todayISO = todayISO;
function dayDiff(a, b) { return Math.round((Date.parse(b + 'T00:00:00') - Date.parse(a + 'T00:00:00')) / 86400000); }
APP.dayDiff = dayDiff;

/* ---------------------------------------------------------------- V2 now */
/* One meaning of "this week": the next Saturday (today, if today is one).
   The Saturday 1-6 days back is "just done". W12-W14 are the project phase.
   On Mon 9 Nov 2026: target W10 (Sat 14 Nov, 5 days), justDone W9. */
APP.v2now = function (iso) {
  var today = iso || todayISO();
  var weeks = (_schedule && _schedule.weeks) || [];
  var out = { today: today, target: null, daysTo: null, isSaturday: false, justDone: null, phase: 'course' };
  if (!weeks.length) return out;
  for (var i = 0; i < weeks.length; i++) {
    if (weeks[i].saturday >= today) { out.target = weeks[i]; break; }
  }
  for (var j = weeks.length - 1; j >= 0; j--) {
    var back = dayDiff(weeks[j].saturday, today);
    if (back >= 1 && back <= 6) { out.justDone = weeks[j]; break; }
    if (back > 6) break;
  }
  var first = weeks[0], last = weeks[weeks.length - 1];
  if (out.target) {
    out.daysTo = dayDiff(today, out.target.saturday);
    out.isSaturday = out.daysTo === 0;
  }
  /* W0 has no Saturday session; the course starts with its first date all the same. */
  if (today < first.saturday) out.phase = 'before';
  else if (!out.target) out.phase = 'after';
  else if (out.target.n >= 12) out.phase = 'project';
  else out.phase = 'course';
  return out;
};

/* ------------------------------------------------------------ V2 helpers */
APP.viewHref = function (p) { return '#view/' + String(p == null ? '' : p).replace(/^\/+/, ''); };

/* The brand's chapter tint for a TARA week: found W0-1, interp W2-4, rl W5-6,
   evals W7-9, align W10-11, project W12-14. Use as var(--ch-<key>). */
APP.chapterKey = function (n) {
  n = Number(n);
  if (n <= 1) return 'found';
  if (n <= 4) return 'interp';
  if (n <= 6) return 'rl';
  if (n <= 9) return 'evals';
  if (n <= 11) return 'align';
  return 'project';
};

var MON3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
var DOW3 = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
/* Kept from V1's today.js (which V2 does not bundle): "Sat 14 Nov". */
APP.prettyDate = function (iso) {
  if (!iso) return '';
  var d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return iso;
  return DOW3[d.getDay()] + ' ' + d.getDate() + ' ' + MON3[d.getMonth()];
};
/* "14 Nov" */
APP.dayMonth = function (iso) {
  var d = new Date(iso + 'T00:00:00');
  return isNaN(d) ? '' : d.getDate() + ' ' + MON3[d.getMonth()];
};
/* Kept from V1's today.js: "steering-persona-vectors" -> "Steering Persona Vectors". */
APP.titleCaseSlug = function (slug) {
  return String(slug || '').replace(/-/g, ' ').replace(/\b([a-z])/g, function (m, c) { return c.toUpperCase(); });
};

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

/* Which TARA weeks a pack (or a drill bank, same slug) serves, from calendar.md.
   Pack slugs are content ids from the first build (week-01 ... week-11), not TARA
   week numbers: week-11 serves weeks 7-9, week-07 weeks 3 and 4. */
APP.weekByN = function (n) {
  var weeks = (_schedule && _schedule.weeks) || [];
  for (var i = 0; i < weeks.length; i++) if (weeks[i].n === Number(n)) return weeks[i];
  return null;
};
APP.weeksOfPack = function (slug) {
  var out = [];
  ((_schedule && _schedule.weeks) || []).forEach(function (w) {
    if ((w.packSlugs || [w.packSlug]).indexOf(slug) >= 0) out.push(w.n);
  });
  return out;
};
APP.weeksOfDemo = function (slug) {
  var out = [];
  ((_schedule && _schedule.weeks) || []).forEach(function (w) {
    if ((w.demoSlugs || []).indexOf(slug) >= 0) out.push(w.n);
  });
  return out;
};
/* [3,4] -> "Weeks 3–4", [7,8,9] -> "Weeks 7–9", [0] -> "Week 0"; short form "W3–4". */
APP.weekSpan = function (ns, short) {
  if (!ns || !ns.length) return '';
  var a = ns[0], b = ns[ns.length - 1];
  if (short) return a === b ? 'W' + a : 'W' + a + '–' + b;
  return a === b ? 'Week ' + a : 'Weeks ' + a + '–' + b;
};
/* The hash that opens a week's nth pack, at the part that week uses. */
APP.packHash = function (w, i) {
  var slugs = (w && (w.packSlugs || [w.packSlug])) || [];
  var slug = slugs[i || 0];
  if (!slug) return null;
  var a = w.packAnchors && w.packAnchors[slug];
  return a ? slug + '/' + a : slug;
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
    PACK_SLUGS = [];
    _schedule.weeks.forEach(function (w) {
      (w.packSlugs || [w.packSlug]).forEach(function (p) { if (p && PACK_SLUGS.indexOf(p) < 0) PACK_SLUGS.push(p); });
    });
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

  /* V2: modules that need the schedule before the first route (chrome, session,
     paths...) registered with APP.onBoot; a failing one never stops the app. */
  for (var b = 0; b < bootHooks.length; b++) {
    try { await bootHooks[b](); } catch (e) { console.warn('onBoot hook failed', e); }
  }
  _booted = true;
  try { _bootResolve(); } catch (e) {}

  window.addEventListener('hashchange', function () { if (!navLock) handleHash(); });
  await handleHash();
  document.documentElement.setAttribute('data-app-ready', '1');
}

/* APP.onBoot(fn): fn runs once the schedule is loaded, before the first route
   renders (fn may return a promise; boot waits for it). Registered after boot,
   it runs on the next tick. APP.booted resolves at the same moment. */
var bootHooks = [];
var _booted = false;
var _bootResolve = null;
APP.booted = new Promise(function (res) { _bootResolve = res; });
APP.onBoot = function (fn) {
  if (typeof fn !== 'function') return;
  if (_booted) { setTimeout(function () { try { fn(); } catch (e) { console.warn('onBoot hook failed', e); } }, 0); return; }
  bootHooks.push(fn);
};

/* Every module in the bundle is parsed before this fires, so today/search/review
   and any section files from B and C are registered by the time boot runs. */
setTimeout(function () {
  boot().catch(function (e) {
    console.error('boot failed', e);
    fatal('The app failed to start: ' + (e && e.message ? e.message : e));
  });
}, 0);
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
  /* V2: nothing typed yet -> one quiet line, not a column of empty groups */
  if (!String(q || '').trim()) {
    b.appendChild(APP.el('p', { 'class': 'app-none v2-searchhint', text: 'Type a word: a concept, a case, a week. Results come in the same groups every time.' }));
    return 0;
  }
  /* V2: only the groups that matched, still in their one order; nothing at all
     matched -> one line instead of a column of "no match" */
  var v2 = window.TARA_SHELL === 'v2';
  if (v2) {
    groups = groups.filter(function (g) { return g.rows.length; });
    if (!groups.length) {
      b.appendChild(APP.el('p', { 'class': 'app-none v2-searchhint', text: 'nothing matches “' + String(q).trim() + '”. try a shorter word, or a week number.' }));
      return 0;
    }
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
    if (APP.replaceHash) APP.replaceHash(back);
    else history.replaceState(null, '', '#' + back);
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
    if (e.target.closest('[data-search-keep]')) return;      /* V2: other search fields and the phone's search button */
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

/* ===== src/sections/packs.js ===== */
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

  /* label = the TARA week(s) the pack serves, in TARA's own order (26 Oct 2026).
     The live label comes from calendar.md via APP.weeksOfPack (packLabel below);
     these are the fallback. Slugs are stable content ids, not week numbers. */
  var PACKS = [
    { slug: 'week-01', label: 'Week 0',  title: 'Einops and Ray Tracing',              sub: '[0.0] Prerequisites · [0.1] Ray Tracing' },
    { slug: 'week-02', label: 'Week 1',  title: 'Modules and ResNets',                 sub: '[0.2] CNNs & ResNets' },
    { slug: 'week-03', label: 'Week 1',  title: 'Optimizers and Sweeps',               sub: '[0.3] Optimization' },
    { slug: 'week-04', label: 'Week 1',  title: 'Your Own Autograd',                   sub: '[0.4] Backprop · [0.5] VAEs & GANs (optional)' },
    { slug: 'week-05', label: 'Week 2',  title: 'Transformer From Scratch',            sub: '[1.1] Transformer from Scratch' },
    { slug: 'week-06', label: 'Week 3',  title: 'Hooks and the Cache',                 sub: '[1.2] §1–3 · TransformerLens, induction heads, hooks' },
    { slug: 'week-07', label: 'Weeks 3–4', title: 'Induction Circuits and Patching',   sub: '[1.2] §4 circuits · [1.4.1] IOI & path patching' },
    { slug: 'week-08', label: 'Week 4',  title: 'Superposition and Sparse Autoencoders', sub: '[1.5.4] Superposition · [1.3.3] SAEs' },
    { slug: 'week-09', label: 'Week 5',  title: 'Value Functions and DQN',             sub: '[2.1] Intro to RL · [2.2.1] DQN' },
    { slug: 'week-10', label: 'Week 6',  title: 'Policy Gradients, PPO and RLHF',      sub: '[2.2.2] VPG · [2.3] PPO · [2.4] RLHF' },
    { slug: 'week-11', label: 'Weeks 7–9', title: 'Eval Design and Inspect',           sub: '[3.1]–[3.3] in depth · [3.4] agents and [3.5] AI control in brief' },
    { slug: 'alignment-science',    label: 'Weeks 10–11', title: 'Model Organisms and Open Problems', sub: '[4.1]–[4.5] alignment science · capstone quarry' },
    { slug: 'capstone-weeks-12-14', label: 'Weeks 12–14', title: 'Three Saturdays and a Talk',        sub: 'project phase · final presentation 12 Dec' }
  ];

  /* weeks = TARA weeks (fallback; live from calendar.md via APP.weeksOfDemo) */
  var DEMOS = [
    { slug: 'tensors-einops',           title: 'Einops Bench',                     weeks: [0] },
    { slug: 'convolutions-cnn',         title: 'Sliding Window Lab',               weeks: [1] },
    { slug: 'backprop-training',        title: 'Backprop Bench',                   weeks: [1] },
    { slug: 'transformer-block',        title: 'Residual Stream Anatomy',          weeks: [2] },
    { slug: 'sampling-decoding',        title: "Decoder's Bench",                  weeks: [2] },
    { slug: 'residual-stream-bus',      title: 'Residual Stream Bus',              weeks: [2, 3] },
    { slug: 'induction-heads-patching', title: 'Induction Circuit Workbench',      weeks: [3, 4] },
    { slug: 'superposition-sae',        title: 'Superposition Bench',              weeks: [4] },
    { slug: 'rl-foundations-dqn',       title: 'Bellman to DQN',                   weeks: [5] },
    { slug: 'policy-gradients-ppo',     title: 'Reading the PPO Objective',        weeks: [6] },
    { slug: 'rlhf-overoptimisation',    title: 'The Overoptimisation Curve',       weeks: [6] },
    { slug: 'evals-pipeline',           title: 'The Measurement Is Not the Property', weeks: [7, 8, 9] },
    { slug: 'steering-persona-vectors', title: 'Persona Vector Bench',             weeks: [10, 11] }
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

  /* Live week labels from the schedule (calendar.md), falling back to the tables. */
  function packWeeks(slug) {
    var ns = (window.APP && APP.weeksOfPack) ? APP.weeksOfPack(slug) : [];
    return ns.length ? ns : null;
  }
  function packLabel(slug) {
    var p = PACK_BY[slug], ns = packWeeks(slug);
    return ns ? APP.weekSpan(ns) : (p ? p.label : slug);
  }
  function demoWeeks(slug) {
    var ns = (window.APP && APP.weeksOfDemo) ? APP.weeksOfDemo(slug) : [];
    var d = DEMO_BY[slug];
    return ns.length ? ns : (d ? d.weeks : []);
  }

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

  /* V2: a pack's check questions answer 1-9 only once the learner chose them. The
     quiz engine focuses its quiz on every render (this.el.focus, preventScroll), so
     on opening a pack the focus sat in a quiz far below the fold and the tier keys
     answered questions nobody had seen (recorded as wrong answers, then imported by
     Recall). This gate runs before the engine: a press inside a quiz arms it (a
     press anywhere else disarms it), a Tab into it arms it, and any other focus that
     lands in an unarmed quiz is blurred back to the document. A digit that still
     reaches an unarmed quiz never gets to it (the shell's tier keys, on the document
     in capture, have already taken it). shell.js and chrome.js read the same mark. */
  var QUIZ_GATE =
    '<script>/*app: quiz gate*/(function(){' +
    'var tabAt=0;' +
    'function quiz(n){try{return n&&n.closest?n.closest(".tara-quiz"):null;}catch(e){return null;}}' +
    'function topTab(){try{var A=window.parent&&window.parent.APP;return (A&&A._tabAt)||0;}catch(e){return 0;}}' +
    'document.addEventListener("keydown",function(e){if(e.key==="Tab")tabAt=Date.now();},true);' +
    'document.addEventListener("pointerdown",function(e){' +
    'var q=quiz(e.target),on=document.querySelectorAll(".tara-quiz[data-v2-armed]");' +
    'for(var i=0;i<on.length;i++)if(on[i]!==q)on[i].removeAttribute("data-v2-armed");' +
    'if(q)q.setAttribute("data-v2-armed","1");},true);' +
    'document.addEventListener("focusin",function(e){' +
    'var q=quiz(e.target);if(!q||q.hasAttribute("data-v2-armed"))return;' +
    'if(Date.now()-Math.max(tabAt,topTab())<1000){q.setAttribute("data-v2-armed","1");return;}' +
    'try{e.target.blur();}catch(x){}},true);' +
    'document.documentElement.addEventListener("keydown",function(e){' +
    'if(e.metaKey||e.ctrlKey||e.altKey||!/^[1-9]$/.test(e.key||""))return;' +
    'var q=quiz(e.target);if(q&&!q.hasAttribute("data-v2-armed"))e.stopPropagation();},true);' +
    '})();<\/script>';
  /* a Tab pressed in the shell that carries the focus into a pack counts too */
  if (window.TARA_SHELL === 'v2') {
    document.addEventListener('keydown', function (e) { if (e.key === 'Tab') APP._tabAt = Date.now(); }, true);
  }

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
      return splice(prelude(r[0], window.TARA_SHELL === 'v2' ? QUIZ_GATE : ''), bootBlock({
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

  /* V2: the opener back pills (scaffold opts.opener), painted for the entry on screen */
  function tabTitle(id) {
    var T = APP.TABS || [];
    for (var i = 0; i < T.length; i++) if (T[i].id === id) return T[i].title;
    return 'Library';
  }
  function paintOpener(a) {
    var e = APP.entry ? APP.entry() : null;
    var tab = e && e.tab ? e.tab : 'library';
    a.textContent = '← ' + tabTitle(tab);
    a.href = '#' + (e && e.from != null ? e.from : 'library');
  }
  if (window.TARA_SHELL === 'v2' && APP.onRoute) {
    APP.onRoute(function () {
      var all = document.querySelectorAll('a.app-fr-back[data-v2-opener]');
      for (var i = 0; i < all.length; i++) paintOpener(all[i]);
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

  /* The first h2/h3 whose text holds the anchor's word(s), any case:
     "primer" finds "Saturday primer". null when none does. */
  function headingFor(d, id) {
    var words = '';
    try { words = decodeURIComponent(String(id)); } catch (e) { words = String(id); }
    words = words.replace(/[-_]+/g, ' ').replace(/[^\w\s]/g, '').trim();
    if (!words) return null;
    var re = new RegExp('(^|\\W)' + words.split(/\s+/).join('\\s+') + '(\\W|$)', 'i');
    var hs = d.querySelectorAll('h2, h3');
    for (var i = 0; i < hs.length; i++) if (re.test(hs[i].textContent || '')) return hs[i];
    return null;
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
            /* V2: an anchor some packs never gave an id (#primer in week-01, -02, -09,
               -10) lands on the first h2/h3 that says it, once the page has parsed */
            if (!n && window.TARA_SHELL === 'v2' && (d.readyState === 'complete' || tries > 25)) n = headingFor(d, id);
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
    packWeeks: packWeeks, packLabel: packLabel, demoWeeks: demoWeeks,
    scriptSafe: scriptSafe, jsonLit: jsonLit, splice: splice, prelude: prelude,
    envelopeConfig: envelopeConfig, bootBlock: bootBlock, payloadOr: payloadOr,
    composePack: composePack, composeDemo: composeDemo, composeSimple: composeSimple,
    frameDoc: frameDoc, ready: ready, scrollTo: scrollTo, show: show,
    tierToFrame: tierToFrame, SPRINT_TIER: SPRINT_TIER, SPRINT_BACK: SPRINT_BACK,
    headingIndex: headingIndex, strip: strip, score: score, cap: cap,
    /* every framed section renders the same two-part shell.
       opts.opener (V2): the back pill returns where the section was opened from
       (the Library, Today, a Weeks step), by stepping back in history, and says
       so ("← Library"); opened from nowhere (a deep link), it goes to the Library. */
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
      if (opts.opener && window.TARA_SHELL === 'v2' && APP.entry) {
        back.setAttribute('data-v2-opener', '1');
        back.addEventListener('click', function (e) {
          if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          APP.backTo('library');
        });
        paintOpener(back);
      }
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
    /* #packs/week-NN: the index, with that TARA week's packs marked */
    var wm = /^packs\/w(?:eek)?-?(\d{1,2})$/i.exec(h);
    if (wm) return { slug: null, anchor: null, week: Number(wm[1]) };
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
      '<p class="app-idx-note">Thirteen packs in TARA&rsquo;s week order, week 0 to week 14. Some weeks use ' +
      'two or three packs and some packs serve two or three weeks. Each pack carries its own ' +
      'eight-question drill.</p>';
    idx.appendChild(head);
    var grid = document.createElement('div');
    grid.className = 'app-idx-grid';
    fk().PACKS.forEach(function (p) {
      var a = document.createElement('a');
      a.className = 'app-idx-card';
      a.href = '#' + p.slug;
      a.setAttribute('data-pack', p.slug);
      a.setAttribute('data-weeks', (fk().packWeeks(p.slug) || []).join(','));
      a.innerHTML =
        '<span class="app-idx-k">' + APP.esc(fk().packLabel(p.slug)) + '</span>' +
        '<span class="app-idx-t">' + APP.esc(p.title) + '</span>' +
        '<span class="app-idx-s">' + APP.esc(p.sub) + '</span>';
      grid.appendChild(a);
    });
    idx.appendChild(grid);
    APP._order = APP._order || {};
    APP._order[SEC] = fk().PACKS.map(function (p) { return p.slug; });
  }

  /* #packs/week-NN: mark that week's cards in place (nothing reorders or hides),
     and say so in the note, the way #demo-week-NN does for demos. */
  function markWeek(idx, week) {
    var cards = idx.querySelectorAll('.app-idx-card');
    for (var i = 0; i < cards.length; i++) {
      var ws = (cards[i].getAttribute('data-weeks') || '').split(',');
      if (week != null && ws.indexOf(String(week)) !== -1) cards[i].setAttribute('data-now', '1');
      else cards[i].removeAttribute('data-now');
    }
    var note = idx.querySelector('.app-idx-note');
    if (!note) return;
    if (!note.__base) note.__base = note.innerHTML;
    var w = week != null && APP.weekByN ? APP.weekByN(week) : null;
    note.innerHTML = w
      ? 'Week ' + w.n + ' &middot; ' + APP.esc(w.chapter) + ' &middot; ' + APP.esc(w.arena || '') +
        '. Its packs are marked; open them in order.'
      : note.__base;
  }

  var openSlug = null, openFrame = null;

  function mount(el, route) {
    var K = fk();
    var parts = K.scaffold(el, { backHash: '#packs', backLabel: '← All packs' });
    buildIndex(parts.idx);
    var r = parse(route);
    if (!r.slug || !K.PACK_BY[r.slug]) {
      markWeek(parts.idx, r.week == null ? null : r.week);
      K.showIndex(parts, true);
      openSlug = null; openFrame = null;
      return Promise.resolve();
    }
    var p = K.PACK_BY[r.slug];
    K.showIndex(parts, false);
    parts.name.textContent = K.packLabel(r.slug) + ' · ' + p.title;
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
      var lab = K.packLabel(p.slug);
      var s = K.score(q, { id: p.slug, slug: p.slug, title: p.title, body: p.sub + ' ' + lab });
      if (!s) s = K.score(q, { id: lab.toLowerCase(), title: lab });
      if (s) direct.push({ title: p.title, sub: lab, hash: '#' + p.slug, score: s + 5, _o: p.order });
    });
    return ensureIndex().then(function (all) {
      var rows = direct.slice();
      all.forEach(function (entry) {
        entry.rows.forEach(function (row, i) {
          var s = K.score(q, { id: row.id, title: row.title, body: row.sub });
          if (!s) return;
          rows.push({
            title: row.title,
            sub: K.packLabel(entry.pack.slug) + ' · ' + entry.pack.title,
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

/* ===== src/sections/demos.js ===== */
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
      '<p class="app-idx-note">Thirteen benches, in TARA&rsquo;s week order. Labels show the weeks each one serves.</p>';
    idx.appendChild(head);
    var grid = document.createElement('div');
    grid.className = 'app-idx-grid';
    fk().DEMOS.forEach(function (d) {
      var a = document.createElement('a');
      a.className = 'app-idx-card';
      a.href = '#demo/' + d.slug;
      a.setAttribute('data-demo', d.slug);
      var ws = fk().demoWeeks(d.slug);
      a.setAttribute('data-weeks', ws.join(','));
      a.innerHTML =
        '<span class="app-idx-k">' + APP.esc(ws.map(function (w) { return 'W' + w; }).join(' · ')) + '</span>' +
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
        ? 'Thirteen benches, in TARA’s week order. Labels show the weeks each one serves.'
        : 'Week ' + week + ' has more than one demo. They are marked below.';
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
      var ws = K.demoWeeks(d.slug);
      var s = K.score(q, {
        id: d.slug, slug: d.slug, title: d.title,
        body: ws.map(function (w) { return 'week ' + w + ' w' + w; }).join(' ')
      });
      if (s) rows.push({ title: d.title, sub: 'Demo · ' + ws.map(function (w) { return 'W' + w; }).join(' · '),
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

/* ===== src/sections/plan.js ===== */
;(function(){
/* ==========================================================================
   sections/plan.js — the master plan (tara-plan.current.html) in a frame.
   Routes: #plan, #plan/<anchor>  where anchor is one of
   now sprint loop calendar retention demos capstone risk failure  (SPEC §7)
   and #plan/week-N, which picks week N in the plan's week picker and opens
   its row, for any week, earlier or later than the current one.
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

  /* week-3, week-03, w3, w-3 -> 3; week-0 -> 0 (TARA's online week); anything else -> null */
  function weekOf(anchor) {
    var m = /^w(?:eek)?-?(\d{1,2})$/i.exec(String(anchor || ''));
    var n = m ? Number(m[1]) : -1;
    return n >= 0 && n <= 14 ? n : null;
  }

  /* V2: the plan sits under the app's own bar. Below 720px its two sticky bars
     (135px and 38px) scroll away with the page instead of covering a third of
     the phone, and its "What to do right now" card is gone at every width: Today
     says what to do now, and on a rest day the card disagreed with it. V1 keeps
     the plan exactly as it was. */
  var V2 = window.TARA_SHELL === 'v2';
  var V2_CSS =
    '#now,nav.sections a[href="#now"]{display:none!important}' +
    '@media (max-width:719.98px){header.top,nav.sections{position:static!important}}';
  function narrowV2(w) {
    try { return V2 && w.innerWidth < 720; } catch (e) { return false; }
  }
  function rowTo(w, n) {
    try {
      var row = w.document.getElementById('wk-' + n);
      if (!row) return;
      row.open = true;
      var y = row.getBoundingClientRect().top + (w.pageYOffset || 0) - 12;
      w.scrollTo(0, Math.max(0, y));
    } catch (e) { /* the row is the plan's; nothing to do */ }
  }

  /* The plan defines window.__planWeek(n, opts) in its own script. Wait for it
     the way K.scrollTo waits for an anchor, then give it one more pass after
     layout settles (web fonts, the reading layer). */
  function pickWeek(f, n) {
    var K = fk();
    return K.ready(f).then(function () {
      return new Promise(function (res) {
        var tries = 0;
        (function tick() {
          var w = null;
          try { w = f.contentWindow; } catch (e) { return res(false); }
          if (w && typeof w.__planWeek === 'function') {
            /* V2 below 720px: the plan's bars do not stick (V2_CSS), but its own
               scroll still leaves room for them; open the row and land it here */
            var own = narrowV2(w);
            var go = function () { w.__planWeek(n, { scroll: !own }); if (own) rowTo(w, n); };
            go();
            try { w.requestAnimationFrame(go); } catch (e) {}
            return res(true);
          }
          if (++tries > 200) return res(false);
          setTimeout(tick, 20);
        })();
      });
    });
  }

  function mount(el, route) {
    var K = fk();
    var parts = K.scaffold(el, { backHash: '#today', backLabel: '← Today', opener: true });
    K.showIndex(parts, false);
    parts.name.textContent = 'Fourteen Saturdays — the plan';
    var r = parse(route);
    return K.show(parts.host, 'plan', function () {
      return K.composeSimple('plan', 'tier:plan', V2 ? { css: V2_CSS } : undefined);
    }).then(function (f) {
      openFrame = f;
      var wk = weekOf(r.anchor);
      if (wk != null) pickWeek(f, wk);
      else if (r.anchor) K.scrollTo(f, r.anchor);
      return f;
    });
  }

  function search(q) {
    var K = fk();
    var rows = [];
    ANCHORS.forEach(function (a, i) {
      if (V2 && a === 'now') return; /* hidden in V2 (V2_CSS) */
      var s = K.score(q, { id: a, title: a });
      if (s) rows.push({ title: a.charAt(0).toUpperCase() + a.slice(1), sub: 'Plan', hash: '#plan/' + a, score: s, _o: i });
    });
    for (var n = 0; n <= 14; n++) {
      var s = K.score(q, { id: 'week-' + n, title: 'Week ' + n });
      if (s) rows.push({ title: 'Week ' + n + ' in the plan', sub: 'Plan · its checklist, pack, demo, drill and film', hash: '#plan/week-' + n, score: s, _o: ANCHORS.length + n });
    }
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

/* ===== src/sections/sprint.js ===== */
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
    var parts = K.scaffold(el, { backHash: '#today', backLabel: '← Today', opener: true });
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

/* ===== src/sections/manual.js ===== */
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
    var parts = K.scaffold(el, { backHash: '#today', backLabel: '← Today', opener: true });
    K.showIndex(parts, false);
    parts.name.textContent = window.TARA_SHELL === 'v2' ? 'Study agents · the TARA system manual' : 'How this system works';
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

/* ===== src/sections/map.js ===== */
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
    var parts = K.scaffold(el, { backHash: '#today', backLabel: '← Today', opener: true });
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
      var list = [];
      var a = (html || '').indexOf(HEAD + '[');
      var b = a === -1 ? -1 : html.indexOf(TAIL, a);
      if (a !== -1 && b !== -1) {
        try { list = JSON.parse(html.slice(a + HEAD.length, b)); }
        catch (e) { try { console.warn('[app] map index: ' + e.message); } catch (_) {} }
      }
      loading = null;
      /* an empty list (the map did not load: offline, say) is not kept, so a
         later search tries again */
      if (list && list.length) nodes = list;
      return list || [];
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

/* ===== src/sections/cases.js ===== */
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
  /* TARA's Saturdays (the schedule payload's dates win when it is loaded) */
  var WEEK_DATE = {
    0: 'Sat 5 Sep', 1: 'Sat 12 Sep', 2: 'Sat 19 Sep', 3: 'Sat 26 Sep', 4: 'Sat 3 Oct', 5: 'Sat 10 Oct',
    6: 'Sat 17 Oct', 7: 'Sat 24 Oct', 8: 'Sat 31 Oct', 9: 'Sat 7 Nov', 10: 'Sat 14 Nov', 11: 'Sat 21 Nov',
    12: 'Sat 28 Nov', 13: 'Sat 5 Dec', 14: 'Sat 12 Dec'
  };
  /* TARA's chapters (the brand's chapter keys) and their names */
  var TARA_CH = [
    { key: 'found', head: 'Prerequisites and foundations', chip: 'Foundations', from: 0, to: 1 },
    { key: 'interp', head: 'Mech interp', chip: 'Mech interp', from: 2, to: 4 },
    { key: 'rl', head: 'Reinforcement learning', chip: 'RL', from: 5, to: 6 },
    { key: 'evals', head: 'Model evaluations', chip: 'Evals', from: 7, to: 9 },
    { key: 'align', head: 'Alignment science', chip: 'Alignment', from: 10, to: 11 }
  ];
  function chOfWeek(n) {
    for (var i = 0; i < TARA_CH.length; i++) if (n != null && n >= TARA_CH[i].from && n <= TARA_CH[i].to) return TARA_CH[i];
    return null;
  }
  /* The TARA Saturday a case belongs to, from the ARENA section it comes from.
     (The payload's own `week` is ARENA's numbering, which is not TARA's.)
     W0 [0.0] [0.1] · W1 [0.2]-[0.5] · W2 [1.1] · W3 [1.2] · W4 [1.3]-[1.5] ·
     W5 [2.1] [2.2.1] · W6 [2.2.2] [2.3]-[2.5] · W7 [3.1] [3.2] · W8 [3.3] ·
     W9 [3.4] [3.5] · W10 [4.1] [4.2] · W11 [4.3]-[4.5]; the same weeks
     intuition/nodes/index.json gives each section. */
  function taraWeek(sec) {
    var m = /^\[(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(sec || '').trim());
    if (!m) return null;
    var a = +m[1], b = +m[2], c = m[3] == null ? null : +m[3];
    if (a === 0) return b <= 1 ? 0 : 1;
    if (a === 1) return b <= 1 ? 2 : b === 2 ? 3 : 4;
    if (a === 2) return b === 1 || (b === 2 && c === 1) ? 5 : 6;
    if (a === 3) return b <= 2 ? 7 : b === 3 ? 8 : 9;
    if (a === 4) return b <= 2 ? 10 : 11;
    return null;
  }
  function weekDate(n) {
    try {
      var sch = APP.schedule && APP.schedule();
      var ws = sch && sch.weeks;
      for (var i = 0; ws && i < ws.length; i++) {
        if (ws[i].n === n && ws[i].saturday && APP.prettyDate) return APP.prettyDate(ws[i].saturday);
      }
    } catch (e) {}
    return WEEK_DATE[n] || '';
  }
  function chHead(ch) {
    /* the schedule's own chapter names for the chapter's weeks, e.g. "Prerequisites and foundations" */
    try {
      var sch = APP.schedule && APP.schedule();
      var ws = (sch && sch.weeks) || [], names = [];
      for (var i = 0; i < ws.length; i++) {
        if (ws[i].n >= ch.from && ws[i].n <= ch.to && ws[i].chapter && names.indexOf(ws[i].chapter) < 0) names.push(ws[i].chapter);
      }
      if (names.length) {
        return names.map(function (x, j) { return j ? x.charAt(0).toLowerCase() + x.slice(1) : x; }).join(' and ');
      }
    } catch (e) {}
    return ch.head;
  }
  function wkKey(c) { return c._tw == null ? 'none' : String(c._tw); }
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

  /* V2: the diagram's links as 44px buttons, shown instead of it below 720px
     (cases.css), where its chips are 17px tall. Same data-go, same handlers. */
  function fitsList(c) {
    var rows = [
      ['depends on', c.depends_on || [], 'nothing upstream', ' is-up'],
      ['builds into', c.builds_into || [], 'nothing builds on it yet', ' is-down'],
      ['alongside', c.neighbours || [], null, '']
    ];
    var h = ['<div class="cases-fits-list">'];
    rows.forEach(function (r) {
      if (!r[1].length && !r[2]) return;
      h.push('<div class="cases-frow"><span class="cases-frow-lab">' + r[0] + '</span>');
      if (!r[1].length) h.push('<span class="cases-frow-none">' + r[2] + '</span>');
      r[1].forEach(function (id) {
        h.push('<button type="button" class="cases-fchip cases-fbtn' + r[3] + '" data-go="' + attr(id) +
          '" aria-label="Go to ' + attr(label(id)) + '">' + esc(label(id)) + '</button>');
      });
      h.push('</div>');
    });
    h.push('</div>');
    return h.join('');
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
    if (c._tw != null) h.push('<span class="cases-tag is-week">W' + c._tw + '</span>');
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
    if (window.TARA_SHELL === 'v2') h.push(fitsList(c));
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
    var curCh, curWk, wkOpen = false, chOpen = false;
    var chapters = [], weeks = [], kindCount = {}, chCount = {}, wkCount = {};

    for (i = 0; i < cards.length; i++) {
      c = cards[i];
      var chKey = c._ch || 'none';
      kindCount[c.kind] = (kindCount[c.kind] || 0) + 1;
      chCount[chKey] = (chCount[chKey] || 0) + 1;
      var wkey = wkKey(c);
      wkCount[wkey] = (wkCount[wkey] || 0) + 1;

      if (chKey !== curCh) {
        if (wkOpen) { mh.push('</div></section>'); wkOpen = false; }
        if (chOpen) { mh.push('</section>'); chOpen = false; }
        curCh = chKey; curWk = undefined;
        var ch = chOfWeek(c._tw);
        var head = ch ? chHead(ch) : 'Without a Saturday';
        var eyebrow = ch ? (ch.from === ch.to ? 'W' + ch.from : 'W' + ch.from + '–' + ch.to) : '—';
        var chId = 'cases-ch-' + chKey;
        chapters.push({ key: chKey, head: head, chip: ch ? ch.chip : '—', eyebrow: eyebrow, id: chId });
        mh.push('<section class="cases-chapter fu-ch-' + attr(chKey) + '" id="' + chId + '"><div class="cases-ch-head">' +
          '<span class="cases-ch-eyebrow">' + esc(eyebrow) + '</span>' +
          '<h2 class="cases-ch-title">' + esc(head) + '</h2></div>');
        rh.push('<button type="button" class="cases-rail-ch" data-go="' + chId + '">' + esc(head) + '</button>');
        chOpen = true;
      }
      if (c._tw !== curWk) {
        if (wkOpen) { mh.push('</div></section>'); wkOpen = false; }
        curWk = c._tw;
        var gid = 'cases-g-' + chKey + '-' + (curWk == null ? 'none' : curWk);
        var wh;
        if (curWk == null) {
          wh = '<span class="cases-wk-n">—</span><span class="cases-wk-date">No Saturday</span>';
          rh.push('<button type="button" class="cases-rail-wk" data-go="' + gid + '" data-g="' + gid +
            '"><b>—</b><span>no Saturday</span><span class="cases-n"></span></button>');
        } else {
          var wd = weekDate(curWk);
          wh = '<span class="cases-wk-n">W' + curWk + '</span><span class="cases-wk-date">' + esc(wd) + '</span>';
          rh.push('<button type="button" class="cases-rail-wk" data-go="' + gid + '" data-g="' + gid +
            '"><b>W' + curWk + '</b><span>' + esc(wd.replace(/^Sat\s+/, '')) + '</span>' +
            '<span class="cases-n"></span></button>');
        }
        mh.push('<section class="cases-week' + (curWk == null ? ' is-capstone' : '') + '" id="' + gid +
          '" data-g="' + gid + '"><div class="cases-wk-head">' + wh +
          '<span class="cases-wk-count" data-c="' + gid + '"></span></div><div class="cases-cards">');
        weeks.push({ key: wkKey(c), gid: gid });
        wkOpen = true;
      }
      S.gids.push('cases-g-' + chKey + '-' + (c._tw == null ? 'none' : c._tw));
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
      hud.push(chipHTML('chapter', ch.key, ch.chip, chCount[ch.key] || 0));
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

    /* the way back sits in the card you landed on, in flow, never over content */
    S.back = document.createElement('button');
    S.back.type = 'button';
    S.back.className = 'cases-back fu-chip';
    S.back.innerHTML = '<span class="cases-bx" aria-hidden="true">←</span><span class="cases-bt"></span>';
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
    if (f.chapter && (c._ch || 'none') !== f.chapter) return false;
    if (f.week && wkKey(c) !== f.week) return false;
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
      var head = el.querySelector('.cases-c-head');
      if (head && head.nextSibling !== S.back) el.insertBefore(S.back, head.nextSibling);
      S.back.classList.add('is-on');
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
        var list = (r[0] || []).map(function (c, i) {
          c._tw = taraWeek(c.arena_section);
          var ch = chOfWeek(c._tw);
          c._ch = ch ? ch.key : null;
          c._i = i;
          return c;
        });
        /* TARA's week order, set once; filters only dim, so nothing moves after this */
        list.sort(function (a, b) {
          var wa = a._tw == null ? 99 : a._tw, wb = b._tw == null ? 99 : b._tw;
          return wa - wb || a._i - b._i;
        });
        S.cards = list;
      })
      .catch(function (e) {
        loading = null;            /* a failure (offline, say) is not kept: Try again loads afresh */
        throw e;
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

/* ===== src/sections/drill.js ===== */
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

  /* One chip per bank. Banks share their pack's slug, a stable content id, so the
     labels are TARA weeks (26 Oct 2026 order): week-11's bank serves W7-W9, the
     three chapter-0 banks all serve W1. name/saturday/when are the fallback;
     liveWeeks() refreshes them from calendar.md. saturday = the last Saturday the
     bank serves, so the default chip stays on a shared bank until its block ends. */
  var WEEKS = [
    { slug: 'week-01', name: 'W0', saturday: '2026-09-05', when: '5 Sep', topic: 'Einops', title: 'Einops and Ray Tracing', count: 78, accent: '#c2477f' },
    { slug: 'week-02', name: 'W1', saturday: '2026-09-12', when: '12 Sep', topic: 'ResNets', title: 'Modules and ResNets', count: 88, accent: '#a86a1f' },
    { slug: 'week-03', name: 'W1', saturday: '2026-09-12', when: '12 Sep', topic: 'Optimisers', title: 'Optimizers and Sweeps', count: 72, accent: '#4a5fc4' },
    { slug: 'week-04', name: 'W1', saturday: '2026-09-12', when: '12 Sep', topic: 'Autograd', title: 'Your Own Autograd', count: 76, accent: '#c05a34' },
    { slug: 'week-05', name: 'W2', saturday: '2026-09-19', when: '19 Sep', topic: 'Transformer', title: 'Transformer From Scratch', count: 81, accent: '#4c58bd' },
    { slug: 'week-06', name: 'W3', saturday: '2026-09-26', when: '26 Sep', topic: 'Hooks', title: 'Hooks and the Cache', count: 79, accent: '#4c58bd' },
    { slug: 'week-07', name: 'W3–4', saturday: '2026-10-03', when: '26 Sep – 3 Oct', topic: 'Circuits', title: 'Induction circuits, ablation and activation patching', count: 91, accent: '#4a5fc4' },
    { slug: 'week-08', name: 'W4', saturday: '2026-10-03', when: '3 Oct', topic: 'SAEs', title: 'Superposition, feature geometry and sparse autoencoders', count: 96, accent: '#6f8a20' },
    { slug: 'week-09', name: 'W5', saturday: '2026-10-10', when: '10 Oct', topic: 'DQN', title: 'Value functions, DQN and vanilla policy gradients', count: 70, accent: '#5561c9' },
    { slug: 'week-10', name: 'W6', saturday: '2026-10-17', when: '17 Oct', topic: 'PPO & RLHF', title: 'PPO and RLHF', count: 73, accent: '#a1519f' },
    { slug: 'week-11', name: 'W7–9', saturday: '2026-11-07', when: '24 Oct – 7 Nov', topic: 'Evals', title: 'Eval Design, Inspect and AI Control', count: 78, accent: '#4a63c0' },
    { slug: 'alignment-science', name: 'W10–11', saturday: '2026-11-21', when: '14 – 21 Nov', topic: 'Alignment', title: 'Alignment science — chapter 4, the capstone quarry', count: 68, accent: '#b45a2a' },
    { slug: 'capstone-weeks-12-14', name: 'W12–14', saturday: '2026-12-12', when: '28 Nov – 12 Dec', topic: 'Capstone', title: 'Capstone — three Saturdays and a talk', count: 233, accent: '#8759c0' }
  ];
  var MON3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function dm(iso) { var p = String(iso).split('-'); return Number(p[2]) + ' ' + MON3[Number(p[1]) - 1]; }
  /* Labels from the schedule, so calendar.md stays the one place weeks are decided. */
  function liveWeeks() {
    if (!APP.weeksOfPack || !APP.weekByN) return;
    WEEKS.forEach(function (w) {
      var ns = APP.weeksOfPack(w.slug);
      if (!ns.length) return;
      var a = APP.weekByN(ns[0]), b = APP.weekByN(ns[ns.length - 1]);
      w.name = APP.weekSpan(ns, true);
      w.saturday = b.saturday;
      w.when = a === b ? dm(a.saturday) : dm(a.saturday) + ' – ' + dm(b.saturday);
      w.first = ns[0];
    });
    WEEKS.sort(function (x, y) { return (x.first == null ? 99 : x.first) - (y.first == null ? 99 : y.first) || x.order - y.order; });
  }
  WEEKS.forEach(function (w, i) { w.order = i; });

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
    }).catch(function (e) { S.loadErr = e; return false; })
      .then(function (ok) {
        if (!ok) S.engineReady = null;   /* a failure is not kept: the next draw tries again */
        return ok;
      });
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
    }).catch(function (e) { S.loadErr = e; return null; });
  }

  /* Index every bank once, so "what's shaky" can aggregate across banks and
     search() can see all thirteen. Cheap next to the decode itself. */
  var allLoaded = null;
  function loadAll() {
    if (allLoaded) return allLoaded;
    allLoaded = Promise.all(WEEKS.map(function (w) { return loadBank(w.slug); })).then(function (r) {
      for (var i = 0; i < r.length; i++) if (!r[i]) { allLoaded = null; break; }  /* try the missing ones again next time */
      return r;
    });
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

    liveWeeks();
    WEEKS.forEach(function (w) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'drill-wk';
      b.setAttribute('data-slug', w.slug);
      b.setAttribute('aria-pressed', 'false');
      b.title = w.title + ' — ' + w.name + ' · ' + w.when + ' · ' + w.count + ' questions';
      b.style.setProperty('--dw', w.accent);
      b.innerHTML = '<span class="drill-wk-id"></span><span class="drill-wk-meta"></span>';
      b.querySelector('.drill-wk-id').textContent = w.name;
      b.querySelector('.drill-wk-meta').textContent = w.topic + ' · ' + w.count;
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
        if (window.TARA_SHELL === 'v2' && APP.oops) {
          /* V2: the calm oops panel (offline: "not saved yet"), with Try again */
          S.els.stage.className = 'drill-stage';
          S.els.stage.textContent = '';
          S.els.stage.appendChild(APP.oops(S.loadErr || new Error(okEngine ? 'the ' + slug + ' questions did not load' : 'the quiz engine did not load'),
            function () { S.loadErr = null; draw(true); }));
          return;
        }
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

/* ===== src/v2/chrome.js ===== */
;(function(){
/* src/v2/chrome.js — V2's chrome (owner: shell).
   The top bar (lockup, five tabs from 720px, search, the tier as a compact
   segmented 1/2/3, the theme lamp, a slot for objects/hook.js's 2D|3D pill) and
   the phone tab bar. The tabs are painted by shell.js's paintNav ([data-tab]);
   the tier buttons by its paintTier (#app-tier). This file adds the theme, the
   phone search sheet, and keeps nothing floating over content. */

'use strict';

var THEME_KEY = 'tara.v2.theme';

/* The lamp (BRAND.md §10). tara.v2.theme is "light", "dark" or absent (follow
   the OS). <html data-theme> carries "light"/"dark" when one is chosen and is
   removed to follow the OS; tokens.css handles all three. The lamp itself has
   two states, on (light) and off (dark): pulling it flips what you see, and a
   flip that lands on what the OS already shows goes back to following the OS,
   so auto / light / dark are all reachable with one chain. */

function themePref() {
  var v = null;
  try { v = localStorage.getItem(THEME_KEY); } catch (e) {}
  return v === 'light' || v === 'dark' ? v : 'auto';
}
function osDark() {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return false; }
}
function resolveTheme(p) { return p === 'auto' ? (osDark() ? 'dark' : 'light') : p; }

function applyTheme(p) {
  var html = document.documentElement;
  if (p === 'light' || p === 'dark') html.setAttribute('data-theme', p);
  else html.removeAttribute('data-theme');
  html.setAttribute('data-theme-pref', p);
  paintLamp(resolveTheme(p), p);
}

function paintLamp(r, p) {
  var b = document.getElementById('v2-themebtn');
  if (!b) return;
  var dark = r === 'dark';
  b.setAttribute('aria-pressed', dark ? 'true' : 'false');
  b.setAttribute('aria-label', dark ? 'Lamp: lights on' : 'Lamp: lights off (dark mode)');
  b.setAttribute('title', (dark ? 'Lamp off (dark)' : 'Lamp on (light)') + (p === 'auto' ? ', following your device' : ''));
}

/* APP.theme: get() -> 'auto'|'light'|'dark' (the choice), resolved() -> 'light'|'dark',
   set(pref), toggle() (the lamp's pull). */
APP.theme = {
  get: themePref,
  resolved: function () { return resolveTheme(themePref()); },
  set: function (p) {
    if (p !== 'light' && p !== 'dark') p = 'auto';
    try {
      if (p === 'auto') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, p);
    } catch (e) {}
    applyTheme(p);
    try { window.dispatchEvent(new CustomEvent('tara:theme', { detail: { pref: p, theme: resolveTheme(p) } })); } catch (e) {}
    return p;
  },
  toggle: function () {
    var next = resolveTheme(themePref()) === 'dark' ? 'light' : 'dark';
    return APP.theme.set(next === (osDark() ? 'dark' : 'light') ? 'auto' : next);
  }
};

/* ------------------------------------------------------------ search sheet */
/* From 1024px the bar has its own field (search.js wires it). Below that the bar
   has only an icon; it opens the same results panel with its own field: a sheet
   from the top on a phone (so the keyboard never covers what you type), a window
   under the bar from 720px. */

function wireSearch() {
  var btn = document.getElementById('v2-searchbtn');
  var panel = document.getElementById('app-searchpanel');
  if (!btn || !panel) return;

  var head = panel.querySelector('.app-panel-head');
  var form = document.createElement('form');
  form.className = 'v2-sheetsearch';
  form.setAttribute('role', 'search');
  form.setAttribute('autocomplete', 'off');
  var input = document.createElement('input');
  input.type = 'search';
  input.id = 'v2-sheetbox';
  input.className = 'fu-input v2-sheetbox';
  input.placeholder = 'Search a concept, a case, a week';
  input.setAttribute('aria-label', 'Search everything');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('enterkeyhint', 'search');
  form.appendChild(input);
  if (head) head.parentNode.insertBefore(form, head.nextSibling);

  var t = 0;
  input.addEventListener('input', function () {
    clearTimeout(t);
    var v = input.value;
    t = setTimeout(function () { APP.openSearch(v); }, 140);
  });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = input.value.trim();
    if (v) APP.navigate('search/' + encodeURIComponent(v));
    input.blur();
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { input.blur(); APP.closeSearch(); }
    if (e.key === 'ArrowDown') {
      var first = panel.querySelector('.app-hit');
      if (first) { e.preventDefault(); first.focus(); }
    }
  });

  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (APP.isSearchOpen && APP.isSearchOpen()) { APP.closeSearch(); return; }
    APP.openSearch(input.value || '');
    setTimeout(function () { try { input.focus(); } catch (err) {} }, 30);
  });

  /* keep the two fields and the button's state in step with the panel */
  var mo = new MutationObserver(function () {
    var open = !panel.hidden;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.documentElement.toggleAttribute('data-search-open', open);
    var bar = document.getElementById('app-searchbox');
    if (open && bar && bar.value && !input.value) input.value = bar.value;
    if (open) placePanel(); else { anchorEl = null; placePanel(); }
  });
  mo.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('resize', placePanel);

  /* the Library's own box: results drop down under it wherever the panel is a
     window (>= 720px); the panel's own field steps aside while it is anchored */
  var anchorEl = null;
  APP.searchAnchor = function (el) { anchorEl = el || null; placePanel(); };
  function placePanel() {
    if (anchorEl && panelFloats() && !panel.hidden) {
      var r = anchorEl.getBoundingClientRect();
      panel.style.top = Math.round(r.bottom + 8) + 'px';
      panel.style.left = Math.round(r.left) + 'px';
      panel.style.right = 'auto';
      panel.style.width = Math.round(Math.max(360, Math.min(r.width, 640))) + 'px';
      panel.setAttribute('data-anchored', '1');
    } else {
      panel.style.removeProperty('top'); panel.style.removeProperty('left');
      panel.style.removeProperty('right'); panel.style.removeProperty('width');
      panel.removeAttribute('data-anchored');
    }
  }

  /* APP.focusSearch(q?): put the caret where search is typed on this screen —
     the bar's field from 1024px, else the panel's own field — and show results. */
  APP.focusSearch = function (q) {
    if (barHasField()) {
      var box = document.getElementById('app-searchbox');
      if (!box) return;
      if (q != null && q !== '') box.value = q;
      box.focus();
      if (box.value.trim()) APP.openSearch(box.value);
      return;
    }
    if (q != null) input.value = q;
    anchorEl = null;
    APP.openSearch(input.value || '');
    setTimeout(function () { try { input.focus(); } catch (err) {} }, 30);
  };
}

/* The breakpoints (chrome.css): the dock below 720px and the tabs from 720px
   (the brand's); the bar's own search field from 1024px, an icon below that. */
function mq(q) { try { return window.matchMedia(q).matches; } catch (e) { return true; } }
function panelFloats() { return mq('(min-width: 720px)'); }
function barHasField() { return mq('(min-width: 1024px)'); }

/* ------------------------------------------------------------------ boot */

function wireTheme() {
  var b = document.getElementById('v2-themebtn');
  applyTheme(themePref());
  if (b) b.addEventListener('click', function () { APP.theme.toggle(); });
  try {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var follow = function () { applyTheme(themePref()); };
    if (mq.addEventListener) mq.addEventListener('change', follow); else if (mq.addListener) mq.addListener(follow);
  } catch (e) {}
  /* another tab (or a page in the viewer) changed it */
  window.addEventListener('storage', function (e) { if (e && e.key === THEME_KEY) applyTheme(themePref()); });
}

/* The Recall count rides on Practice (BRAND.md §5): the dock item and the tab. */
function paintRecallBadge() {
  var n = 0;
  try { if (window.APP && APP.recall && typeof APP.recall.dueCount === 'function') n = Number(APP.recall.dueCount()) || 0; } catch (e) { n = 0; }
  var dock = document.getElementById('v2-recallbadge');
  var tab = document.querySelector('#v2-tabs [data-tab="practice"]');
  var tb = tab && tab.querySelector('.v2-tabbadge');
  if (tab && !tb) {
    tb = APP.el('span', { 'class': 'fu-badge fu-badge--count v2-tabbadge', hidden: 'hidden' });
    tab.appendChild(tb);
  }
  [dock, tb].forEach(function (el) {
    if (!el) return;
    el.textContent = n > 99 ? '99+' : String(n);
    el.hidden = !n;
  });
  var label = n ? 'Practice, ' + n + ' to recall' : null;
  var items = document.querySelectorAll('[data-tab="practice"]');
  for (var i = 0; i < items.length; i++) {
    if (label) items[i].setAttribute('aria-label', label); else items[i].removeAttribute('aria-label');
  }
}

/* Each tab remembers the last route of its own it showed (sessionStorage, this
   tab of the browser only), so a tab tapped from elsewhere comes back where it
   was: Weeks to the step, Library to the pack. The viewer is never remembered (it
   is gone once left, and its film or 3D room would load again), nor a pack or a
   door shown under another tab: a film opened from a Weeks step keeps Weeks lit,
   and Weeks taps back to the step.
   Tapping the tab that is lit: from a film or a door it opened, back to its last
   route (a step back in history when that is where it was opened from); from
   deeper in the tab, its root; on its root, back to the top (the phone
   convention). */
var TAB_ROUTES_KEY = 'tara.v2.tabroutes';
var tabRoutes = (function () {
  try { var o = JSON.parse(sessionStorage.getItem(TAB_ROUTES_KEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; }
})();
function rememberTab(r) {
  if (!r || r.section === 'view' || r.section === 'search') return;
  var tab = APP.entry ? APP.entry().tab : APP.tabOf(r.section);
  /* a pack or a door shown under another tab (opened from a Weeks step) is not
     that tab's own: Weeks keeps the step */
  if (!tab || APP.tabOf(r.section) !== tab || tabRoutes[tab] === r.raw) return;
  tabRoutes[tab] = r.raw;
  try { sessionStorage.setItem(TAB_ROUTES_KEY, JSON.stringify(tabRoutes)); } catch (e) {}
}
function wireTabs() {
  APP.onRoute(rememberTab);
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest('a[data-tab]');
    if (!a) return;
    var r = APP.route && APP.route();
    var tab = a.getAttribute('data-tab');
    var lit = APP.entry ? APP.entry().tab : (r ? APP.tabOf(r.section) : null);
    var last = tabRoutes[tab];
    var dest;
    if (r && lit === tab) {
      if (r.section === tab && !r.params.rest) {
        var sec = document.getElementById('app-sec-' + tab);
        if (sec && sec.scrollTop > 0) {
          e.preventDefault();
          try { sec.scrollTo({ top: 0, behavior: 'smooth' }); } catch (err) { sec.scrollTop = 0; }
        }
        return;
      }
      dest = last && last !== r.raw ? last : tab;
    } else {
      dest = last || tab;
    }
    /* going back to where this film or door was opened from: step back in
       history (the viewer counts its frame's own entries), so Back afterwards
       does not reopen it */
    var en = APP.entry ? APP.entry() : null;
    if (r && en && en.from != null && en.from === dest && lit === tab) {
      e.preventDefault();
      if (r.section === 'view' && APP.viewer && APP.viewer.close) APP.viewer.close();
      else APP.backTo(dest);
      return;
    }
    if (dest === tab) return;                     /* the link's own #tab does it */
    e.preventDefault();
    APP.navigate(dest);
  });
}

/* Inside a quiz the learner chose (pressed, clicked or tabbed into: packs.js
   marks it data-v2-armed), 1-9 pick answers. shell.js's tier keys stand aside
   there; in a srcdoc frame the reading layer also answers 1/2/3, from the
   frame's document (bubble), so a digit coming up out of an armed quiz stops at
   <html>: after the quiz has used it, before the layer can flip the tier. A quiz
   nobody chose never keeps the focus its engine gave it on render (packs.js
   blurs it as it happens; this catches a frame that loaded before that gate). */
function guardQuizDigits(f, d) {
  if (!d || !d.documentElement || d.__v2QuizDigits) return;
  d.__v2QuizDigits = 1;
  try {
    var act = d.activeElement, q0 = act && act.closest ? act.closest('.tara-quiz') : null;
    if (q0 && !q0.hasAttribute('data-v2-armed')) act.blur();
  } catch (e) {}
  d.documentElement.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey || !/^[1-9]$/.test(e.key || '')) return;
    var t = e.target, q = t && t.closest ? t.closest('.tara-quiz') : null;
    if (q && q.hasAttribute('data-v2-armed')) e.stopPropagation();
  });
}

wireTheme();
wireTabs();
if (APP.frames && APP.frames.onLoad) APP.frames.onLoad(guardQuizDigits);
APP.onBoot(function () { wireSearch(); paintRecallBadge(); });
window.addEventListener('tara:recall', paintRecallBadge);
document.addEventListener('visibilitychange', function () { if (!document.hidden) paintRecallBadge(); });
})();

/* ===== src/v2/viewer.js ===== */
;(function(){
/* src/v2/viewer.js — #view/<site-relative path> (owner: shell).
   Films, concept films, the Model Room and the 3D objects open inside the shell:
   a same-origin iframe under the chrome with a slim header (title, close, "open
   on its own"), so the top bar, the session timer and Back keep working.

   Links are routed in one place, the capture phase of each document's window:
   the shell's own, every srcdoc frame's (APP.frames.onLoad) and the viewed
   page's (re-attached on each load). For a plain left click on <a href>:
     - intuition/**.html, objects/**.html  -> #view/<path> in the shell
     - index.html / next.html / classic.html (with or without #x) -> the shell
       routes to #x (or #today) and the viewer closes
     - lab/**                              -> the whole window goes there
   Bare "#x" hrefs, target=_blank, modified clicks, download links and anything
   marked data-v2-pass are left alone. A routed click calls preventDefault()
   (and stopPropagation()), so a page's own handler that checks
   event.defaultPrevented never navigates a second time.

   Before a page is shown it is checked (HEAD, then a GET through the service
   worker when the network is down): a page that is not there, or not saved for
   offline yet, gets the shell's calm oops panel with Try again instead of a
   server's 404 or the browser's dinosaur.

   Close (X) steps back in history to where the viewer was opened from
   (APP.backTo), so Back afterwards does not reopen the film and reload its
   WebGL. A page in the viewer that moves itself (the Model Room's cards, an
   object's hub link, a hash of its own) adds entries to the same history; the
   viewer counts them (history.length grew by one) and steps back over them too.
   A move it cannot count (a full history) makes close replace this entry with
   the opener instead, and a check after the step replaces it if Back still
   landed inside the viewer.

   APP.viewer.open(path) / .close() / .path() / .route(url) -> 'view'|'shell'|'lab'|null */

'use strict';

var SHELL_DOCS = { '': 1, 'index.html': 1, 'next.html': 1, 'classic.html': 1 };
var VIEWABLE = /^(intuition|objects)\/(?:[^?#]*\.html|[^?#]*\/|)$/i;

function scope() {
  try { return new URL('./', document.baseURI); } catch (e) { return null; }
}

/* site-relative path of an absolute URL, or null when it is not ours */
function sitePath(u) {
  var s = scope();
  if (!s || u.origin !== s.origin) return null;
  if (u.pathname.indexOf(s.pathname) !== 0) return null;
  return u.pathname.slice(s.pathname.length);
}

/* What a URL is to the shell. */
function classify(u) {
  var p = sitePath(u);
  if (p == null) return null;
  if (SHELL_DOCS[p] === 1) return { kind: 'shell', hash: (u.hash || '').replace(/^#/, '') };
  if (/^lab(\/|$)/i.test(p)) return { kind: 'lab', href: u.href };
  var path = p;
  if (/^(intuition|objects)$/i.test(path)) path += '/';
  if (!VIEWABLE.test(path)) return null;
  if (/\/$/.test(path)) path += 'index.html';
  return { kind: 'view', path: path + (u.search || '') + (u.hash || '') };
}

/* ------------------------------------------------------------ interceptor */

function onClickCapture(e) {
  if (e.defaultPrevented) return;
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  var t = e.target;
  if (t && t.nodeType !== 1) t = t.parentElement;
  var a = t && t.closest ? t.closest('a[href]') : null;
  if (!a) return;
  if (a.hasAttribute('download') || a.hasAttribute('data-v2-pass')) return;
  var target = (a.getAttribute('target') || '').toLowerCase();
  if (target && target !== '_self' && target !== '_top' && target !== '_parent') return;
  var raw = (a.getAttribute('href') || '').trim();
  if (!raw || raw.charAt(0) === '#' || /^(javascript|mailto|tel|data|blob):/i.test(raw)) return;
  var u;
  try { u = new URL(a.href); } catch (err) { return; }
  var c = classify(u);
  if (!c) return;

  var inShell = a.ownerDocument === document;
  if (c.kind === 'lab') {
    if (inShell) return;                       /* the browser does exactly this already */
    e.preventDefault(); e.stopPropagation();
    window.location.href = c.href;
    return;
  }
  e.preventDefault(); e.stopPropagation();
  if (c.kind === 'shell') { APP.navigate(c.hash || 'today'); return; }
  APP.navigate('view/' + c.path);
}

function attach(win) {
  if (!win) return;
  try {
    if (win.__v2links === win.document) return;
    win.__v2links = win.document;
    win.addEventListener('click', onClickCapture, true);
  } catch (e) { /* cross-origin: not ours to route */ }
}

attach(window);
if (APP.frames && APP.frames.onLoad) APP.frames.onLoad(function (f, d, w) { attach(w); });

/* ----------------------------------------------------------------- section */

var lastOutside = null;          /* the last non-viewer route, for close */
var frame = null;                /* the one viewer iframe; destroyed on leave */
var hostEl = null;
var requested = null;            /* the URL the shell last put in the frame */
var lenAtShow = 0;               /* history.length when it did (or last looked) */
var framePushes = 0;             /* entries the frame's pages pushed since the viewer opened */
var selfNav = false;             /* ...and a move that could not be counted */
var openSeq = 0;                 /* the check in flight; a newer route wins */

APP.onRoute(function (r) {
  if (r && r.section !== 'view') lastOutside = r.raw;
});

function titleFromPath(p) {
  var f = String(p || '').split(/[?#]/)[0].split('/').pop().replace(/\.html$/i, '');
  if (!f || f === 'index') {
    if (/^objects\//.test(p)) return 'Model Room';
    if (/^intuition\//.test(p)) return 'Films';
    return 'Viewer';
  }
  return APP.titleCaseSlug(f.replace(/^(w\d+|deep-w\d+)-/, ''));
}

function build(el) {
  if (el.getAttribute('data-built') === '1') return;
  el.setAttribute('data-built', '1');
  el.textContent = '';
  var head = APP.el('div', { 'class': 'v2-viewhead' });
  var close = APP.el('button', { 'class': 'v2-viewclose', type: 'button', 'aria-label': 'Close the viewer', title: 'Close' });
  close.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';
  close.addEventListener('click', function () { APP.viewer.close(); });
  var title = APP.el('span', { 'class': 'v2-viewtitle', id: 'v2-viewtitle' });
  var out = APP.el('a', { 'class': 'v2-viewout', id: 'v2-viewout', href: '#', 'data-v2-pass': '1', text: 'open on its own' });
  out.addEventListener('click', function () {
    /* the page will want to come back here, not to V1 */
    try { sessionStorage.setItem('tara.dim.back', '#' + (lastOutside || 'today')); } catch (e) {}
  });
  head.appendChild(close); head.appendChild(title); head.appendChild(out);
  var box = APP.el('div', { 'class': 'v2-viewbox', id: 'v2-viewbox' });
  var empty = APP.el('div', { 'class': 'v2-viewempty app-sec-pad', id: 'v2-viewempty', hidden: 'hidden' });
  el.appendChild(head); el.appendChild(box); el.appendChild(empty);
}

function dropOops(el) {
  var old = el.querySelector('.v2-viewoops');
  if (old && old.parentNode) old.parentNode.removeChild(old);
}

function showEmpty(el, msg, linkHref, linkText) {
  var empty = el.querySelector('#v2-viewempty');
  var box = el.querySelector('#v2-viewbox');
  dropFrame();
  dropOops(el);
  if (box) box.hidden = true;
  if (!empty) return;
  empty.hidden = false;
  empty.textContent = '';
  empty.appendChild(APP.el('p', { 'class': 'app-empty', text: msg }));
  var out = el.querySelector('#v2-viewout');
  if (out) out.hidden = true;
  if (linkHref) empty.appendChild(APP.el('p', {}, [APP.el('a', { 'class': 'app-a', href: linkHref, text: linkText || linkHref })]));
  var title = el.querySelector('#v2-viewtitle');
  if (title) title.textContent = 'Viewer';
}

function dropFrame() {
  if (!frame) return;
  try { if (frame.parentNode) frame.parentNode.removeChild(frame); } catch (e) {}
  frame = null;
}

function frameHref() {
  try { return frame && frame.contentWindow ? frame.contentWindow.location.href : null; } catch (e) { return null; }
}

function onViewLoad() {
  if (!frame) return;
  var w = null, d = null;
  try { w = frame.contentWindow; d = frame.contentDocument; } catch (e) {}
  if (!w || !d) return;
  attach(w);
  var title = document.getElementById('v2-viewtitle');
  var t = '';
  try { t = (d.title || '').replace(/\s+[·|—-]\s+(TARA|Object Lessons|Intuition).*$/i, '').trim(); } catch (e) {}
  if (title && t) title.textContent = t;
  /* the page moved by itself (its own script): keep the shell's hash honest */
  var u = null;
  try { u = new URL(w.location.href); } catch (e) {}
  var c = u && classify(u);
  if (u && requested && noHash(u.href) !== noHash(requested)) {
    /* a move the shell did not ask for */
    countMove();
    requested = u.href;
  }
  /* a page's own #hash moves push entries too, with no load */
  try {
    if (w.__v2hashwatch !== w.document) {
      w.__v2hashwatch = w.document;
      w.addEventListener('hashchange', function () { if (frame && frame.contentWindow === w) countMove(); });
    }
  } catch (e) {}
  if (c && c.kind === 'view') {
    var want = 'view/' + c.path;
    if (APP._route && APP._route.raw !== want && location.hash !== '#' + want) {
      /* in place, keeping this entry's v2 stamps (where it was opened from) */
      if (APP.replaceHash) APP.replaceHash(want);
      else history.replaceState(null, '', '#' + want);
      APP._route.raw = want; APP._route.params.rest = c.path;
    }
    var out = document.getElementById('v2-viewout');
    if (out) out.setAttribute('href', c.path);
  }
  try { window.dispatchEvent(new CustomEvent('tara:view', { detail: { path: c && c.path, title: t } })); } catch (e) {}
}

function noHash(h) { return String(h || '').split('#')[0]; }

/* One entry more: a push by the frame's page. None, before any push: the page
   replaced itself (a concept film handing over to its full film). None after a
   push could be Back or Forward inside the frame, and anything else (the
   50-entry cap, forward entries cut) cannot be counted either: then close
   replaces this entry instead of stepping back. */
function countMove() {
  var d = history.length - lenAtShow;
  if (d === 1 && history.length < 50) framePushes++;
  else if (d !== 0 || history.length >= 50 || framePushes > 0) selfNav = true;
  lenAtShow = history.length;
}

function show(el, path) {
  var box = el.querySelector('#v2-viewbox');
  var empty = el.querySelector('#v2-viewempty');
  if (empty) empty.hidden = true;
  dropOops(el);
  if (box) box.hidden = false;
  var s = scope();
  var url = new URL(path, s).href;
  requested = url; lenAtShow = history.length;
  var title = el.querySelector('#v2-viewtitle');
  var out = el.querySelector('#v2-viewout');
  if (out) { out.setAttribute('href', path); out.hidden = false; }
  if (!frame) {
    selfNav = false; framePushes = 0;   /* a new frame: no history of its own yet */
    if (title) title.textContent = titleFromPath(path);
    frame = document.createElement('iframe');
    frame.className = 'v2-viewframe';
    frame.setAttribute('title', titleFromPath(path));
    frame.setAttribute('allow', 'fullscreen; autoplay');
    frame.setAttribute('allowfullscreen', '');
    frame.addEventListener('load', onViewLoad);
    frame.src = url;
    box.appendChild(frame);
    return;
  }
  var cur = frameHref();
  if (cur === url) return;
  if (title) title.textContent = titleFromPath(path);
  frame.setAttribute('title', titleFromPath(path));
  /* replace, so the shell's hash change is the only history entry */
  try { frame.contentWindow.location.replace(url); }
  catch (e) { frame.src = url; }
}

/* Is the page there? HEAD first (the service worker lets HEAD through to the
   network); with no network, a GET through the worker finds a saved copy. */
function check(path) {
  var url = noHash(new URL(path, scope()).href);
  return fetch(url, { method: 'HEAD', credentials: 'same-origin' })
    .catch(function () { return fetch(url, { credentials: 'same-origin' }); })
    .then(function (res) {
      /* read the body to its end (empty for HEAD; offline, the saved copy), so
         the request finishes instead of being cancelled half-read */
      return res.text().catch(function () { return ''; }).then(function () { return res; });
    })
    .then(function (res) {
      if (res.ok) return true;
      var e = new Error('HTTP ' + res.status + ' for ' + path);
      e.status = res.status;
      throw e;
    });
}

function showOops(el, err, retry) {
  dropFrame();
  dropOops(el);
  var box = el.querySelector('#v2-viewbox');
  var empty = el.querySelector('#v2-viewempty');
  if (box) box.hidden = true;
  if (empty) empty.hidden = true;
  var gone = err && (err.status === 404 || err.status === 410);
  var out = el.querySelector('#v2-viewout');
  if (out) out.hidden = true;                 /* nothing there to open on its own */
  var p = APP.oops(err, retry, 'v2-viewoops', gone ? {
    line: 'that page is not here. it may have moved; the Library has every film and object.',
    link: { href: '#library', text: 'Go to the Library' }
  } : null);
  el.appendChild(p);
  var title = el.querySelector('#v2-viewtitle');
  if (title) title.textContent = gone ? 'Not here' : 'Viewer';
}

/* check, then show; the Try again button runs it again */
function open(el, path) {
  var seq = ++openSeq;
  /* the frame already shows it (a hash the page moved to itself): nothing to check */
  if (frame && noHash(frameHref()) === noHash(new URL(path, scope()).href)) { show(el, path); return; }
  check(path).then(function () {
    if (seq === openSeq) show(el, path);
  }, function (err) {
    if (seq !== openSeq) return;
    showOops(el, err, function () { open(el, path); });
  });
}

APP.registerSection({
  id: 'view',
  title: 'Viewer',
  mount: function (el, route) {
    hostEl = el;
    el.classList.add('v2-viewsec');
    build(el);
    var rest = (route && route.params && route.params.rest) || '';
    if (!rest) {
      showEmpty(el, 'Nothing is open in the viewer. Films and the Model Room are in the Library.', '#library', 'Go to the Library');
      return;
    }
    var u;
    try { u = new URL(rest, scope()); } catch (e) { u = null; }
    var c = u && classify(u);
    if (!c) {
      if (u && sitePath(u) != null && !/^(https?:)?\/\//i.test(rest)) {
        /* ours but not a film or an object: show it all the same, once it is there */
        open(el, rest.replace(/^\/+/, ''));
        return;
      }
      showEmpty(el, 'That page does not open here.', null);
      return;
    }
    if (c.kind === 'shell') { APP.navigate(c.hash || 'today', { replace: true }); return; }
    if (c.kind === 'lab') { window.location.href = c.href; return; }
    open(el, c.path);
  },
  unmount: function () {
    /* one live viewer page at a time, and none in the background: a film keeps
       its sound and a 3D room its GPU until the frame is gone */
    openSeq++;
    dropFrame();
    if (hostEl) dropOops(hostEl);
  }
});

APP.viewer = {
  open: function (path) { APP.navigate(APP.viewHref(path)); },
  close: function () {
    var back = lastOutside;
    if (!back || /^view\//.test(back)) back = 'library';
    var e = APP.entry ? APP.entry() : null;
    if (!APP.backTo || selfNav || !e || e.from == null) { APP.navigate(back, { replace: true }); return; }
    APP.backTo(back, framePushes);
    /* the safety net: a history entry of the frame's own that went unseen keeps
       Back inside the viewer; then close by replacing this entry after all */
    setTimeout(function () {
      if (/^#view\//.test(location.hash)) APP.navigate(back, { replace: true });
    }, 800);
  },
  path: function () {
    var r = APP.route && APP.route();
    return r && r.section === 'view' ? (r.params.rest || null) : null;
  },
  route: function (url) {
    try { var c = classify(new URL(url, scope())); return c ? c.kind : null; } catch (e) { return null; }
  },
  frame: function () { return frame; }
};
})();

/* ===== src/v2/session.js ===== */
;(function(){
/* src/v2/session.js — the study session (owner: shell).
   Started only from Today's Start button. While it runs, a slim bar sits in
   normal flow under the top bar (never over content): "12 of 30 min" and End.
   When the box is up it says so, calmly, in the same row and at the same
   height ("time's up." with Stop here / Keep going in place of the time), so
   nothing under it moves mid-read. State lives in localStorage tara.v2.session
   and closes on its own once the box plus an hour has passed; when that
   happens while the app is open (or not long before it is opened again) a
   short toast says so, and a session forgotten for longer goes quietly, so it
   never nags the next day. Landscape phones (max-height 500px) get one thin row.

   APP.session.start(minutes, extra?) -> state
   APP.session.end(quiet?)
   APP.session.state() -> { startedAt, minutes, week?, over? } | null
   APP.session.elapsed() -> minutes | null
   APP.session.keepGoing()
   window event 'tara:session' { state } on every change. */

'use strict';

var SKEY = 'tara.v2.session';
var GRACE_MIN = 60;            /* after the box, how long a session waits before it closes itself */
var NOTE_WITHIN_MIN = 180;     /* closed longer ago than this when we notice: no toast, it just goes */
var tick = 0;
var wasAsking = false;
var noted = 0;                 /* startedAt of the last session whose closing was noted */

function now() { return Date.now(); }

function expiresAt(s) { return Number(s.startedAt) + (Number(s.minutes) + GRACE_MIN) * 60000; }

function readState() {
  var s = null;
  try { s = JSON.parse(localStorage.getItem(SKEY) || 'null'); } catch (e) { s = null; }
  if (!s || typeof s !== 'object' || !s.startedAt || !s.minutes) return null;
  if (now() > expiresAt(s)) {             /* the box and the grace are over: close it, and say so once */
    try { localStorage.removeItem(SKEY); } catch (e) {}
    closedOnItsOwn(s);
    return null;
  }
  return s;
}
function writeState(s) {
  try {
    if (s) localStorage.setItem(SKEY, JSON.stringify(s));
    else localStorage.removeItem(SKEY);
  } catch (e) {}
}
function emit() {
  try { window.dispatchEvent(new CustomEvent('tara:session', { detail: { state: readState() } })); } catch (e) {}
}

/* A session that ran out of grace: the bar goes, Today repaints, and if this is
   close to when it happened, one calm line says so (never the next day). */
function closedOnItsOwn(s) {
  if (noted === s.startedAt) return;
  noted = s.startedAt;
  var late = now() - expiresAt(s);
  setTimeout(function () {
    paint(); emit();
    if (late <= NOTE_WITHIN_MIN * 60000 && typeof APP.toast === 'function') APP.toast('the session closed on its own. it still counts.');
  }, 0);
}

function elapsedMin(s) { return Math.max(0, Math.floor((now() - s.startedAt) / 60000)); }

APP.session = {
  start: function (minutes, extra) {
    var m = Number(minutes);
    if (!(m > 0)) m = 30;
    var s = { startedAt: now(), minutes: m };
    if (extra && typeof extra === 'object') for (var k in extra) if (!(k in s)) s[k] = extra[k];
    writeState(s);
    paint(); emit();
    return s;
  },
  end: function (quiet) {
    var had = readState();
    writeState(null);
    paint(); emit();
    if (had && !quiet) APP.toast('session done. that counts.');
  },
  state: function () {
    var s = readState();
    return s ? { startedAt: s.startedAt, minutes: s.minutes, week: s.week, over: !!s.over } : null;
  },
  /* minutes since start, or null without a session */
  elapsed: function () { var s = readState(); return s ? elapsedMin(s) : null; },
  keepGoing: function () {
    var s = readState();
    if (!s) return;
    s.over = true;
    writeState(s);
    paint(); emit();
  }
};

/* ------------------------------------------------------------------- bar */

function bar() { return document.getElementById('v2-session'); }

function build(el) {
  if (el.getAttribute('data-built') === '1') return;
  el.setAttribute('data-built', '1');
  el.textContent = '';
  var E = APP.el;
  var row = E('div', { 'class': 'v2-sess-row' });
  var dot = E('span', { 'class': 'v2-sess-dot', 'aria-hidden': 'true' });
  var txt = E('span', { 'class': 'v2-sess-t', id: 'v2-sess-t' });
  var prog = E('span', { 'class': 'v2-sess-track fu-progress fu-progress--thin', 'aria-hidden': 'true' }, [E('span', { 'class': 'v2-sess-fill fu-progress__fill', id: 'v2-sess-fill' })]);
  /* time's up: the same row, the same height; the line and two ways on take the time's place */
  var ask = E('span', { 'class': 'v2-sess-ask', id: 'v2-sess-ask', hidden: 'hidden' });
  ask.appendChild(E('span', { 'class': 'v2-sess-q fu-voice' }, [
    document.createTextNode('time’s up.'),
    E('span', { 'class': 'v2-sess-q2', text: ' a good place to stop; it will be here next time.' })
  ]));
  var stop = E('button', { 'class': 'v2-sess-btn fu-btn fu-btn--small', type: 'button', 'data-act': 'stop', text: 'Stop here' });
  var more = E('button', { 'class': 'v2-sess-btn fu-btn fu-btn--small fu-btn--ghost', type: 'button', 'data-act': 'more', text: 'Keep going' });
  ask.appendChild(stop); ask.appendChild(more);
  var end = E('button', { 'class': 'v2-sess-btn v2-sess-end fu-btn fu-btn--small fu-btn--ghost', type: 'button', 'data-act': 'end', id: 'v2-sess-end', text: 'End', 'aria-label': 'End the session' });
  /* for screen readers: said once, when the box is up */
  var live = E('span', { 'class': 'v2-sess-live', id: 'v2-sess-live', 'aria-live': 'polite' });
  row.appendChild(dot); row.appendChild(txt); row.appendChild(prog); row.appendChild(ask); row.appendChild(end); row.appendChild(live);
  el.appendChild(row);
  el.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    if (act === 'end' || act === 'stop') APP.session.end();
    else if (act === 'more') { APP.session.keepGoing(); APP.toast('carry on. end it whenever you like.'); }
  });
}

function paint() {
  var el = bar();
  if (!el) return;
  var s = readState();
  var on = !!s;
  if (el.hidden === on) el.hidden = !on;
  document.documentElement.toggleAttribute('data-session', on);
  if (!on) { wasAsking = false; stopTick(); return; }
  build(el);
  var m = elapsedMin(s), box = Number(s.minutes);
  var up = m >= box;
  var t = document.getElementById('v2-sess-t');
  if (t) t.textContent = m + ' of ' + box + ' min';
  var fill = document.getElementById('v2-sess-fill');
  if (fill) fill.style.width = Math.min(100, Math.round(100 * m / box)) + '%';
  var ask = document.getElementById('v2-sess-ask');
  var asking = up && !s.over;
  if (ask && ask.hidden === asking) ask.hidden = !asking;
  var end = document.getElementById('v2-sess-end');
  if (end && end.hidden === !asking) end.hidden = asking;
  el.setAttribute('data-state', asking ? 'ask' : (up ? 'over' : 'run'));
  var live = document.getElementById('v2-sess-live');
  if (live) {
    if (asking && !wasAsking) live.textContent = 'time’s up. stop here, or keep going?';
    else if (!asking && live.textContent) live.textContent = '';
  }
  wasAsking = asking;
  startTick();
}

function startTick() {
  if (tick) return;
  tick = setInterval(function () {
    if (document.hidden) return;
    paint();
  }, 15000);
}
function stopTick() { if (tick) { clearInterval(tick); tick = 0; } }

document.addEventListener('visibilitychange', function () { if (!document.hidden) paint(); });
window.addEventListener('storage', function (e) { if (e && e.key === SKEY) { paint(); emit(); } });
APP.onBoot(paint);
})();

/* ===== src/v2/today.js ===== */
;(function(){
/* src/v2/today.js — V2's Today, #today (owner: shell).
   Opens on the next Saturday (APP.v2now().target: W10 on Mon 9 Nov) with one
   Start button that picks up where the learner stopped, and a 10 / 30 / 60
   minute box that sizes the session. Below it, fixed slots that never move:
   the week just done, Recall, the Capstone, and the strip of every Saturday.
   Built once; afterwards only text and attributes are swapped in place.

   Fixed places: every part of the hero keeps its height in every state (the
   title has two lines on a phone, one from 700px; the plan has its rows
   reserved and folds what does not fit into "+N"; a calm line takes the plan's
   place when there is nothing to list), and every slot keeps one height, so
   progress, the box and the date never move Start, the slots or the strip.

   What Start does is decided in one place, heroState(), for the hero's words
   and for the click alike:
   - a week with open steps: the step to resume (P.next), sized by the box;
   - a session Saturday (W1+): that week's checklist first, then its ready step;
   - Sat 5 Dec before the freeze: the Lab's W13 block (capstone summary's next);
   - after the freeze up to the talk (6-12 Dec): the talk builder, #lab/talk;
   - a finished week: a recall round if anything is due, else the warm-up
     (checked for cards before any clock starts);
   - after 12 Dec: the course is done; recall or the warm-up, and no clock.

   Reads (all optional, feature-tested): APP.paths (week, next, progress, plan,
   ready), APP.recall (summary, dueCount, session), APP.capstone.summary,
   APP.session, localStorage tara.v2.capstone (only whether the talk has words).
   Repaints on 'tara:path', 'tara:recall', 'tara:session', 'tara:review',
   'tara:capstone'. */

'use strict';

var BOX_KEY = 'tara.v2.box';
var BOXES = [10, 30, 60];
var BOX_SAY = { 10: 'a quick look', 30: 'a proper go', 60: 'the full week' };
var FREEZE = '2026-12-05';      /* fallbacks when the capstone module is absent */
var TALK = '2026-12-12';
var CAP_KEY = 'tara.v2.capstone';

/* step kinds as the plan chips name them (short, so a full plan fits its rows) */
var CHIP = {
  film: 'film', films: 'film', video: 'film', watch: 'film',
  idea: 'idea card', ideas: 'idea cards', card: 'idea card', cards: 'idea cards', concept: 'idea card', concepts: 'idea cards',
  demo: 'demo', play: 'demo', lab: 'Lab mission', mission: 'Lab mission',
  check: 'check', checks: 'check', quiz: 'check', questions: 'check', drill: 'check',
  checklist: 'checklist', saturday: 'checklist', 'do': 'checklist',
  ready: 'ready', runway: 'runway',
  pack: 'pack', read: 'reading', reading: 'reading', recall: 'recall', skip: 'skippable',
  freeze: 'freeze', talk: 'talk builder', warm: 'warm-up'
};
function chipLabel(k) { return CHIP[String(k || '').toLowerCase()] || String(k || 'step'); }

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

function box() {
  var v = Number(lsGet(BOX_KEY));
  return BOXES.indexOf(v) >= 0 ? v : 30;
}

function paths() {
  var P = window.APP && APP.paths;
  return P && typeof P.week === 'function' ? P : null;
}
function safe(fn, dflt) { try { var v = fn(); return v == null ? dflt : v; } catch (e) { return dflt; } }

function countdown(d) {
  if (d == null) return '';
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  return 'in ' + d + ' days';
}
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

/* the voice line's short form, for a phone too narrow for the whole line:
   "done. see you tomorrow." -> "see you tomorrow." */
function shortVoice(v) {
  v = String(v || '');
  var i = v.indexOf('. ');
  return i > 0 ? v.slice(i + 2) : v;
}

/* "Alignment science" -> "alignment science" after "Week 10, " (BRAND voice: names
   are sentence case); an acronym at the front (RL, RLHF) keeps its capitals. */
function afterComma(t) {
  t = String(t || '');
  if (/^[A-Z0-9]{2,}\b/.test(t)) return t;
  return t.charAt(0).toLowerCase() + t.slice(1);
}

/* the week's name, as the Weeks tab shows it: the path's short title */
function weekName(w, pw) {
  return (pw && (pw.short || pw.title)) || (w && w.chapter) || '';
}

/* a date said the calm way: today, tomorrow, else "Sat 28 Nov" */
function whenDate(iso, today) {
  var d = APP.dayDiff(today, iso);
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  return APP.prettyDate(iso);
}

function fallbackHash(w) {
  if (!w) return 'library';
  return APP.packHash(w, 0) || ('weeks/' + w.n);
}

/* ------------------------------------------------------------- the world */

function recallInfo() {
  var R = window.APP && APP.recall;
  if (!R) return null;
  var s = typeof R.summary === 'function' ? safe(function () { return R.summary(); }, null) : null;
  if (s) {
    return {
      due: Number(s.due) || 0, total: Number(s.total) || 0, session: Number(s.session) || 0,
      minutes: Number(s.minutes) || 0, next: s.next && s.next.count ? s.next : null
    };
  }
  if (typeof R.dueCount === 'function') {
    var d = safe(function () { return R.dueCount(); }, 0);
    return { due: d, total: d, session: Math.min(d, 7), minutes: 0, next: null };
  }
  return null;
}

function capInfo(today) {
  var C = window.APP && APP.capstone;
  var cs = C && typeof C.summary === 'function' ? safe(function () { return C.summary(); }, null) : null;
  var dF = cs && cs.daysToFreeze != null ? cs.daysToFreeze : APP.dayDiff(today, FREEZE);
  var dT = cs && cs.daysToTalk != null ? cs.daysToTalk : APP.dayDiff(today, TALK);
  /* past the freeze? The capstone module knows the clock (6pm on the day), so
     its next milestone decides; without it, the day after the freeze does. */
  var next = cs && cs.next && cs.next.date ? cs.next : null;
  var frozen = next ? next.date === (cs.talk || TALK) : dF < 0;
  return { cs: cs, dF: dF, dT: dT, next: next, frozen: frozen };
}

/* has the learner written anything in the talk builder yet? (read only) */
function talkStarted() {
  var raw = lsGet(CAP_KEY);
  if (!raw) return false;
  try {
    var t = (JSON.parse(raw) || {}).talk || {};
    for (var k in t) if (Object.prototype.hasOwnProperty.call(t, k) && typeof t[k] === 'string' && t[k].trim()) return true;
  } catch (e) {}
  return false;
}

/* a session Saturday: the checklist first, then the ready step, then the rest
   of the open steps (sized as the paths module sizes them) while they fit */
function sessionDayPlan(n, left) {
  var P = paths();
  var all = P && typeof P.plan === 'function' ? safe(function () { return P.plan(n, 600); }, []) : [];
  var lead = [], rest = [];
  all.forEach(function (st) { (st.id === 'do' || st.id === 'ready' ? lead : rest).push(st); });
  lead.sort(function (a, b) { return (a.id === 'do' ? 0 : 1) - (b.id === 'do' ? 0 : 1); });
  var out = [];
  lead.concat(rest).forEach(function (st) {
    if (left <= 0) return;
    var m = Number(st.minutes) || 0;
    if (m <= left) { out.push(st); left -= m; return; }
    if (!out.length) {             /* the first thing is bigger than the box: cut it to the box */
      var c = {};
      for (var k in st) if (Object.prototype.hasOwnProperty.call(st, k)) c[k] = st[k];
      c.minutes = left; c.partial = true;
      out.push(c); left = 0;
    }
  });
  return out;
}
function firstOpen(pw, ids) {
  var steps = (pw && pw.steps) || [];
  for (var i = 0; i < ids.length; i++) {
    for (var j = 0; j < steps.length; j++) if (steps[j].id === ids[i] && steps[j].state !== 'done') return steps[j];
  }
  return null;
}

/* the one "next:" line for a path step: its title and the minutes it has left,
   as the plan sizes it (idea cards by the cards still to read), so the line and
   its chip say the same number */
function stepLine(st, n) {
  var m = Number(st.minutes) || 0;
  var P = paths();
  var all = P && typeof P.plan === 'function' ? safe(function () { return P.plan(n, 600); }, []) : [];
  for (var i = 0; i < all.length; i++) if (all[i].id === st.id && all[i].minutes) { m = all[i].minutes; break; }
  return (st.title || chipLabel(st.kind)) + (m ? ' · ' + m + ' min' : '');
}

/* After the path (or the course): a recall round when something is due, else a
   warm-up. Both have cards; the warm-up is checked on the click (see onStart). */
function restMode(S) {
  var rc = S.rc;
  if (rc && rc.due > 0) {
    var n = rc.session || Math.min(rc.due, 7);
    S.mode = 'recall';
    S.hash = '#practice/recall';
    S.label = 'Start a recall round';
    S.next = 'Recall · ' + plural(n, 'card') + (rc.minutes ? ' · ' + rc.minutes + ' min' : '');
  } else {
    S.mode = 'warm';
    S.hash = '#practice/warm';
    S.label = 'Warm up';
    S.next = 'Warm-up · five cards · 4 min';
    S.checkWarm = true;
  }
}
function comeBack(rc) {
  return rc && rc.next ? rc.next.count + ' come back ' + rc.next.when + '.' : '';
}

/* Everything the hero says and where Start goes, for one moment. */
function heroState(now) {
  var today = now.today || APP.todayISO();
  var w = now.target || null;
  var P = paths();
  var bx = box();
  var S = {
    w: w, today: today, box: bx, rc: recallInfo(), cap: capInfo(today),
    mode: 'path', title: '', date: '', voice: '', label: 'Start', hash: null, timer: true,
    next: '', lead: null, sessionDay: false, note: '', noBox: false, pr: null, allDone: false, long: '',
    voiceShort: ''
  };

  /* after the last Saturday: the course is done; no clock */
  if (!w) {
    S.title = 'The course is done';
    S.date = 'after 12 Dec';
    S.voice = 'well done. it all keeps.';
    S.voiceShort = 'well done.';
    restMode(S);
    S.mode = 'after';
    S.timer = false;
    S.noBox = true;
    S.note = (S.rc && S.rc.due ? 'every week stays open. recall keeps it fresh.'
      : (comeBack(S.rc) ? 'nothing due; ' + comeBack(S.rc) : 'every week stays open in Weeks.'));
    return S;
  }

  var pw = P ? safe(function () { return P.week(w.n); }, null) : null;
  var step = P ? safe(function () { return P.next(w.n); }, null) : null;
  var pr = P ? safe(function () { return P.progress(w.n); }, null) : null;
  var allDone = !!(pr && pr.total && pr.done >= pr.total);
  S.pr = pr && pr.total ? pr : null;
  S.allDone = allDone;
  S.title = 'Week ' + w.n + ', ' + afterComma(weekName(w, pw));
  S.long = (pw && pw.title) || w.chapter || '';
  S.date = now.isSaturday ? 'today' : APP.prettyDate(w.saturday);
  var sessionDay = !!(now.isSaturday && w.n >= 1);
  var cap = S.cap;

  if (!cap.frozen && cap.dF === 0) {
    /* Sat 5 Dec, before 6pm: the freeze comes first */
    S.mode = 'freeze';
    S.voice = 'results freeze at 6pm.';
    S.hash = (cap.next && cap.next.hash) || '#lab/week-13';
    S.next = 'Freeze at 6pm · the W' + w.n + ' list';
    S.lead = { kind: 'freeze', text: 'freeze', meta: '6pm', minutes: 0, title: 'Results freeze at 6pm: the week ' + w.n + ' list in the Lab' };
    S.sessionDay = sessionDay;
    return S;
  }
  if (cap.frozen && cap.dT >= 0) {
    /* from the freeze to the talk: the talk builder comes first */
    S.mode = 'talk';
    if (cap.dT === 0) S.voice = 'talk day. you know this.';
    else if (cap.dF === 0) S.voice = 'results are in. rest tonight.';
    else S.voice = cap.dT === 1 ? 'the talk is tomorrow.' : 'the talk is in ' + cap.dT + ' days.';
    S.hash = '#lab/talk';
    S.label = talkStarted() ? 'Pick up where you stopped' : 'Start';
    S.next = cap.dT === 0 ? 'Talk builder · one last read' : 'Talk builder · six parts';
    S.lead = { kind: 'talk', text: 'talk builder', minutes: bx <= 10 ? bx : bx - 10, title: 'The talk builder, in the Lab' };
    S.sessionDay = sessionDay;
    return S;
  }

  if (!allDone) {
    var first = step;
    if (sessionDay) {
      S.sessionDay = true;
      var lead = firstOpen(pw, ['do', 'ready']);
      if (lead) first = lead;
      S.voice = lead ? 'session day. go well.' : 'session day. all set.';
    } else if (now.isSaturday) S.voice = 'online week. your own pace.';
    else if (now.phase === 'before') S.voice = 'starts ' + countdown(now.daysTo) + '.';
    else S.voice = countdown(now.daysTo) + '.';
    S.hash = first && first.hash ? first.hash : '#' + fallbackHash(w);
    var started = first && (first.state === 'doing' || (first === step && pr && pr.done > 0));
    S.label = started ? 'Pick up where you stopped' : 'Start';
    if (first) S.next = stepLine(first, w.n);
    else {
      var slug = (w.packSlugs || [w.packSlug])[0];
      S.next = 'The pack · ' + (slug ? APP.titleCaseSlug(slug) : weekName(w, pw));
    }
    return S;
  }

  /* the week's path is done */
  S.voice = sessionDay ? 'session day. all set.' : (now.isSaturday ? 'done. enjoy the day.'
    : (now.daysTo === 1 ? 'done. see you tomorrow.' : 'done. see you saturday.'));
  restMode(S);
  S.note = S.rc && S.rc.due ? 'a recall round keeps week ' + w.n + ' fresh.'
    : 'anything now is extra. a warm-up is five cards, no score.';
  return S;
}

/* what fits in the box, as chips: a lead (the freeze, the talk) first */
function chipsFor(S) {
  var out = [];
  var left = S.box;
  if (S.lead) { out.push(S.lead); left -= S.lead.minutes || 0; }
  var P = paths();
  if (!S.w || S.allDone || left <= 0 || !P || typeof P.plan !== 'function') return out;
  var steps = S.sessionDay ? sessionDayPlan(S.w.n, left) : safe(function () { return P.plan(S.w.n, left); }, []);
  (steps || []).forEach(function (st) {
    out.push({ kind: st.kind, text: chipLabel(st.kind), minutes: st.minutes, title: st.title });
  });
  return out;
}

/* ----------------------------------------------------------------- build */

function build(el) {
  if (el.getAttribute('data-built') === '1') return;
  el.setAttribute('data-built', '1');
  el.textContent = '';
  var E = APP.el;

  var pad = E('div', { 'class': 'app-sec-pad v2-today' });

  /* the hero: two short lines, then Start */
  var hero = E('section', { 'class': 'v2-hero fu-card', id: 'v2-hero', 'aria-labelledby': 'v2-hero-h' });
  /* the name sits at the foot of its two reserved lines, next to the date */
  hero.appendChild(E('h1', { 'class': 'v2-hero-h fu-display', id: 'v2-hero-h' }, [E('span', { 'class': 'v2-hero-ht', id: 'v2-hero-ht' })]));
  var line2 = E('p', { 'class': 'v2-hero-s', id: 'v2-hero-s' });
  line2.appendChild(E('span', { 'class': 'fu-plate v2-hero-date', id: 'v2-hero-date' }));
  line2.appendChild(E('span', { 'class': 'fu-voice v2-hero-voice', id: 'v2-hero-voice' }));
  hero.appendChild(line2);

  var go = E('div', { 'class': 'v2-hero-go' });
  var start = E('button', { 'class': 'v2-start fu-btn fu-btn--big', type: 'button', id: 'v2-start', 'aria-describedby': 'v2-next-t' });
  start.appendChild(E('span', { 'class': 'v2-start-t', id: 'v2-start-t', text: 'Start' }));
  start.addEventListener('click', onStart);
  go.appendChild(start);

  /* the box, or (after the course, when there is no clock) a calm line in its place */
  var boxSlot = E('div', { 'class': 'v2-boxslot' });
  var bx = E('div', { 'class': 'v2-box fu-seg', role: 'radiogroup', 'aria-label': 'How long you have', id: 'v2-box' });
  BOXES.forEach(function (m) {
    var b = E('button', { 'class': 'v2-boxbtn fu-seg__opt', type: 'button', role: 'radio', 'data-min': String(m), 'aria-label': m + ' minutes, ' + BOX_SAY[m] });
    var inner = E('span', { 'class': 'v2-boxbtn-in' });
    inner.appendChild(E('b', { text: m + ' min' }));
    inner.appendChild(E('span', { 'class': 'fu-seg__sub', text: BOX_SAY[m] }));
    b.appendChild(inner);
    bx.appendChild(b);
  });
  bx.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.v2-boxbtn');
    if (!b) return;
    lsSet(BOX_KEY, b.getAttribute('data-min'));
    paint();
  });
  bx.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    var i = BOXES.indexOf(box()) + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1);
    if (i < 0 || i >= BOXES.length) return;
    e.preventDefault();
    lsSet(BOX_KEY, String(BOXES[i]));
    paint();
    var nb = bx.querySelector('[data-min="' + BOXES[i] + '"]');
    if (nb) nb.focus();
  });
  boxSlot.appendChild(bx);
  boxSlot.appendChild(E('p', { 'class': 'v2-box-note fu-voice', id: 'v2-box-note', hidden: 'hidden', text: 'no clock now. come back whenever.' }));
  go.appendChild(boxSlot);
  hero.appendChild(go);

  var next = E('p', { 'class': 'v2-next', id: 'v2-next' });
  next.appendChild(E('span', { 'class': 'fu-label v2-next-k', text: 'next' }));
  next.appendChild(E('span', { 'class': 'v2-next-t', id: 'v2-next-t' }));
  hero.appendChild(next);

  /* the plan: its rows are reserved; a calm line stands in when there is nothing to list */
  var planSlot = E('div', { 'class': 'v2-planslot', id: 'v2-planslot' });
  var plan = E('ol', { 'class': 'v2-plan', id: 'v2-plan', 'aria-label': 'What fits in this box' });
  planSlot.appendChild(plan);
  planSlot.appendChild(E('p', { 'class': 'v2-plan-note fu-voice', id: 'v2-plan-note', hidden: 'hidden' }));
  hero.appendChild(planSlot);
  if (typeof ResizeObserver === 'function') {
    var lastW = -1;
    new ResizeObserver(function () {
      if (hero.clientWidth !== lastW) { lastW = hero.clientWidth; fitVoice(); fitChips(); }
    }).observe(hero);
  }

  var prog = E('div', { 'class': 'v2-prog', id: 'v2-prog' });
  prog.appendChild(E('span', { 'class': 'fu-progress v2-prog-bar', id: 'v2-prog-bar', role: 'progressbar', 'aria-valuemin': '0' },
    [E('span', { 'class': 'fu-progress__fill', id: 'v2-prog-fill' })]));
  prog.appendChild(E('span', { 'class': 'v2-prog-t', id: 'v2-prog-t' }));
  hero.appendChild(prog);
  pad.appendChild(hero);

  /* fixed slots: never reordered, never removed; text swaps in place */
  var slots = E('div', { 'class': 'v2-slots' });
  [['done', 'Just done'], ['recall', 'Recall'], ['capstone', 'Capstone']].forEach(function (s) {
    var a = E('a', { 'class': 'v2-slot fu-card fu-card--lift', href: '#today', 'data-slot': s[0] });
    a.appendChild(E('span', { 'class': 'v2-slot-k fu-label', text: s[1] }));
    a.appendChild(E('span', { 'class': 'v2-slot-t fu-h3' }));
    a.appendChild(E('span', { 'class': 'v2-slot-s' }));
    a.appendChild(E('span', { 'class': 'v2-slot-go', 'aria-hidden': 'true', text: '→' }));
    slots.appendChild(a);
  });
  pad.appendChild(slots);

  /* every Saturday, in date order; any of them opens its Weeks page */
  var stripWrap = E('section', { 'class': 'v2-wkwrap', 'aria-labelledby': 'v2-wk-h' });
  stripWrap.appendChild(E('h2', { 'class': 'v2-wk-h fu-label', id: 'v2-wk-h', text: 'Every Saturday' }));
  var strip = E('nav', { 'class': 'v2-wkstrip', id: 'v2-wkstrip', 'aria-label': 'Any week, earlier or later' });
  var sch = APP.schedule();
  ((sch && sch.weeks) || []).forEach(function (w) {
    var a = E('a', {
      'class': 'v2-wk fu-chip fu-ch-' + APP.chapterKey(w.n), href: '#weeks/' + w.n, 'data-wk': String(w.n),
      title: 'Week ' + w.n + ' · ' + APP.prettyDate(w.saturday) + ' · ' + w.chapter + (w.n === 0 ? ' (no Saturday session)' : '')
    });
    a.appendChild(E('b', { text: 'W' + w.n }));
    a.appendChild(E('span', { 'class': 'v2-wk-d', text: APP.dayMonth(w.saturday) }));
    a.appendChild(E('i', { 'class': 'v2-wk-p', 'aria-hidden': 'true' }));
    strip.appendChild(a);
  });
  stripWrap.appendChild(strip);
  pad.appendChild(stripWrap);

  el.appendChild(pad);
  if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') document.fonts.ready.then(function () { fitVoice(); fitChips(); }, function () {});
}

/* ----------------------------------------------------------------- paint */

function setSlot(key, spec) {
  var el = document.getElementById('app-sec-today');
  var a = el && el.querySelector('.v2-slot[data-slot="' + key + '"]');
  if (!a || !spec) return;
  a.setAttribute('href', '#' + String(spec.hash || 'today').replace(/^#/, ''));
  if (spec.label) a.querySelector('.v2-slot-k').textContent = spec.label;
  a.querySelector('.v2-slot-t').textContent = spec.title || '';
  var sub = a.querySelector('.v2-slot-s');
  sub.textContent = spec.sub || '';
  sub.className = 'v2-slot-s ' + (spec.voice ? 'fu-voice' : 'fu-small');
  a.classList.toggle('fu-card--done', spec.state === 'done');
  if (spec.state) a.setAttribute('data-state', spec.state); else a.removeAttribute('data-state');
  setCh(a, spec.ch || null);
}

/* one chapter tint class at a time (fu-ch-* sets --fu-bg for .fu-card) */
var CHS = ['found', 'interp', 'rl', 'evals', 'align', 'project'];
function setCh(el, key) {
  for (var i = 0; i < CHS.length; i++) el.classList.toggle('fu-ch-' + CHS[i], CHS[i] === key);
}

var startBusy = false;
function onStart() {
  if (startBusy) return;
  var S = heroState(APP.v2now());
  var running = !!(APP.session && APP.session.state && APP.session.state());
  function go(timer) {
    if (timer && !running && APP.session && APP.session.start) APP.session.start(box(), { week: S.w ? S.w.n : null });
    APP.navigate(String(S.hash || 'today').replace(/^#/, ''));
  }
  /* never a clock on an empty screen: a warm-up starts one only once it has cards
     (the recall module caches the banks it loads, so the warm-up opens at once) */
  var R = window.APP && APP.recall;
  if (S.checkWarm && S.timer && !running && R && typeof R.session === 'function') {
    var btn = document.getElementById('v2-start');
    var settled = false;
    startBusy = true;
    if (btn) btn.setAttribute('aria-busy', 'true');
    var finish = function (items, ok) {
      if (settled) return;
      settled = true;
      startBusy = false;
      if (btn) btn.removeAttribute('aria-busy');
      if (!ok) { go(false); return; }
      if (items && items.length) go(true);
      else if (APP.toast) APP.toast('nothing to warm up with yet. rest counts too.');
    };
    setTimeout(function () { finish(null, false); }, 2500);
    Promise.resolve().then(function () { return R.session({ warm: true }); })
      .then(function (items) { finish(items, true); }, function () { finish(null, false); });
    return;
  }
  go(S.timer);
}

/* the voice line in its one row: the whole line, or its short form where the
   whole line would be cut (a narrow phone) */
function fitVoice() {
  var v = document.getElementById('v2-hero-voice');
  if (!v || !v.offsetParent) return;
  var whole = v.getAttribute('data-whole') || '';
  var short = v.getAttribute('data-short') || '';
  if (v.textContent !== whole) v.textContent = whole;
  if (short && short !== whole && v.scrollWidth > v.clientWidth + 1) v.textContent = short;
}

/* the plan's chips into their reserved rows; what does not fit folds into "+N" */
function fitChips() {
  var ol = document.getElementById('v2-plan');
  if (!ol || ol.hidden || !ol.offsetParent) return;
  var items = [].slice.call(ol.querySelectorAll('.v2-plan-i:not(.v2-plan-more)'));
  var more = ol.querySelector('.v2-plan-more');
  items.forEach(function (li) { li.hidden = false; });
  if (more) more.hidden = true;
  if (!items.length || !more) return;
  var limit = ol.clientHeight + 1;
  function over(el) { return el.offsetTop + el.offsetHeight > limit; }
  var cut = -1;
  for (var i = 0; i < items.length; i++) if (over(items[i])) { cut = i; break; }
  if (cut < 0) return;
  for (var j = cut; j < items.length; j++) items[j].hidden = true;
  more.hidden = false;
  function say(k) {
    var n = items.length - k;
    more.textContent = '+' + n;
    more.setAttribute('aria-label', 'and ' + n + ' more');
  }
  say(cut);
  while (over(more) && cut > 0) { cut--; items[cut].hidden = true; say(cut); }
}

function paintHero(now) {
  var S = heroState(now);
  var h = document.getElementById('v2-hero-h');
  var ht = document.getElementById('v2-hero-ht');
  var date = document.getElementById('v2-hero-date');
  var voice = document.getElementById('v2-hero-voice');
  var hero = document.getElementById('v2-hero');
  if (!h || !ht || !date || !voice || !hero) return;
  var running = !!(APP.session && APP.session.state && APP.session.state());

  setCh(hero, S.w ? APP.chapterKey(S.w.n) : 'project');
  hero.setAttribute('data-mode', S.mode);

  /* two short lines, then Start */
  ht.textContent = S.title;
  if (S.long && S.long !== S.title) h.setAttribute('title', S.long); else h.removeAttribute('title');
  date.textContent = S.date;
  voice.textContent = S.voice;
  voice.setAttribute('title', S.voice);
  voice.setAttribute('data-whole', S.voice);
  voice.setAttribute('data-short', S.voiceShort || shortVoice(S.voice));
  fitVoice();

  var startT = document.getElementById('v2-start-t');
  if (startT) startT.textContent = running ? 'Keep going' : S.label;

  /* the box, or the calm line in its place when there is no clock */
  var bx = document.getElementById('v2-box');
  var bnote = document.getElementById('v2-box-note');
  if (bx && bnote) {
    if (S.noBox) { bx.setAttribute('data-off', '1'); bx.setAttribute('aria-hidden', 'true'); bnote.hidden = false; }
    else { bx.removeAttribute('data-off'); bx.removeAttribute('aria-hidden'); bnote.hidden = true; }
    var bxv = box();
    var btns = bx.querySelectorAll('.v2-boxbtn');
    for (var k = 0; k < btns.length; k++) {
      var on2 = Number(btns[k].getAttribute('data-min')) === bxv;
      btns[k].setAttribute('aria-checked', on2 ? 'true' : 'false');
      btns[k].setAttribute('tabindex', on2 && !S.noBox ? '0' : '-1');
    }
  }

  /* the one "next:" line */
  var nextT = document.getElementById('v2-next-t');
  if (nextT) { nextT.textContent = S.next; nextT.setAttribute('title', S.next); }

  /* what fits in the box, or a calm line in the same rows */
  var plan = document.getElementById('v2-plan');
  var note = document.getElementById('v2-plan-note');
  if (plan && note) {
    var chips = S.note ? [] : chipsFor(S);
    plan.textContent = '';
    if (chips.length) {
      chips.forEach(function (c) {
        var li = APP.el('li', { 'class': 'v2-plan-i fu-chip', 'data-kind': String(c.kind || '') });
        li.appendChild(APP.el('span', { text: c.text }));
        if (c.minutes) li.appendChild(APP.el('b', { 'class': 'fu-mono', text: c.minutes + "'" }));
        else if (c.meta) li.appendChild(APP.el('b', { 'class': 'fu-mono', text: c.meta }));
        if (c.title) li.setAttribute('title', c.title + (c.minutes ? ' · ' + c.minutes + ' min' : (c.meta ? ' · ' + c.meta : '')));
        plan.appendChild(li);
      });
      plan.appendChild(APP.el('li', { 'class': 'v2-plan-i fu-chip v2-plan-more', hidden: 'hidden' }));
      plan.hidden = false;
      plan.setAttribute('aria-label', 'What fits in ' + S.box + ' minutes');
      note.hidden = true;
      fitChips();
    } else {
      plan.hidden = true;
      note.textContent = S.note || '';
      note.hidden = !S.note;
    }
  }

  /* the week's path: steps done, never a percentage in words. No week: the row
     keeps its place, empty. */
  var bar = document.getElementById('v2-prog-bar');
  var fill = document.getElementById('v2-prog-fill');
  var pt = document.getElementById('v2-prog-t');
  var progBox = document.getElementById('v2-prog');
  if (bar && fill && pt && progBox) {
    var pr = S.pr;
    if (pr && S.w) {
      var d = Math.min(pr.done, pr.total);
      fill.style.width = (100 * d / pr.total).toFixed(2) + '%';
      bar.setAttribute('aria-valuemax', String(pr.total));
      bar.setAttribute('aria-valuenow', String(d));
      bar.setAttribute('aria-label', 'Week ' + S.w.n + ' path');
      pt.textContent = S.allDone ? 'all ' + pr.total + ' steps done' : d + ' of ' + plural(pr.total, 'step') + ' done';
      progBox.removeAttribute('data-off');
      progBox.removeAttribute('aria-hidden');
    } else {
      pt.textContent = '';
      fill.style.width = '0%';
      progBox.setAttribute('data-off', '1');
      progBox.setAttribute('aria-hidden', 'true');
    }
  }
}

function paintSlots(now) {
  var P = paths();
  var weeks = (APP.schedule() && APP.schedule().weeks) || [];
  var today = now.today || APP.todayISO();

  /* 1. the week just done (or the one before the target, so the slot never empties).
     Named as Weeks names it; no counts: a calm line and an optional way back in. */
  var jd = now.justDone;
  var label = 'Just done';
  if (!jd) {
    var tn = now.target ? now.target.n - 1 : (weeks.length ? weeks[weeks.length - 1].n : null);
    jd = tn != null && tn >= 0 ? APP.weekByN(tn) : null;
    label = now.target ? 'Last week' : 'Last Saturday';
  }
  if (jd) {
    var pw = P ? safe(function () { return P.week(jd.n); }, null) : null;
    var pr = P ? safe(function () { return P.progress(jd.n); }, null) : null;
    var spec = {
      label: label + ' · W' + jd.n, title: weekName(jd, pw), voice: true,
      hash: 'weeks/' + jd.n, ch: APP.chapterKey(jd.n)
    };
    if (now.phase === 'after') {
      spec.sub = 'every week stays open.';
      spec.state = 'done'; spec.ch = null;
    } else if (!pr || !pr.total) {
      spec.sub = APP.prettyDate(jd.saturday) + ' · open the week';
      spec.voice = false;
    } else if (pr.done >= pr.total) {
      spec.sub = 'week ' + jd.n + ', done. it keeps.';
      spec.state = 'done'; spec.ch = null;
    } else if (pr.done > 0) {
      spec.sub = 'pick up where you stopped, if you like.';
      var nx = safe(function () { return P.next(jd.n); }, null);
      if (nx && nx.hash) spec.hash = nx.hash;
    } else {
      spec.sub = 'there whenever you want it.';
    }
    setSlot('done', spec);
  } else {
    setSlot('done', { label: 'Just done', title: 'No Saturday yet', sub: 'the first one is on its way.', voice: true, hash: 'weeks' });
  }

  /* 2. recall: what is due today, else when the next ones come back */
  var rc = recallInfo();
  if (rc) {
    if (rc.due) setSlot('recall', { title: plural(rc.due, 'thing') + ' to look at again', sub: 'five minutes at a time.', voice: true, hash: 'practice/recall' });
    else if (rc.next) setSlot('recall', { title: 'Nothing due today', sub: comeBack(rc), voice: true, hash: 'practice/recall' });
    else if (rc.total) setSlot('recall', { title: 'Nothing due today', sub: 'all quiet for now.', voice: true, hash: 'practice/recall' });
    else setSlot('recall', { title: 'Nothing to recall yet', sub: 'misses and shaky cards land here.', voice: true, hash: 'practice/recall' });
  } else {
    var saved = safe(function () { return APP.review.list().length; }, 0);
    setSlot('recall', {
      title: saved ? plural(saved, 'saved sentence') : 'Nothing saved yet',
      sub: saved ? 'from the packs and demos' : 'select a sentence in any pack and save it.',
      voice: !saved, hash: 'practice'
    });
  }

  /* 3. capstone: freeze Sat 5 Dec 6pm, talk Sat 12 Dec */
  var cap = capInfo(today);
  var dF = cap.dF, dT = cap.dT, next = cap.next;
  var cspec;
  if (dT < 0) cspec = { title: 'Talk given', sub: 'sat 12 dec. well done.', voice: true, state: 'done' };
  else if (cap.frozen) cspec = {
    title: dT === 0 ? 'The talk is today' : plural(dT, 'day') + ' to the talk',
    sub: dT === 0 ? 'you know this. say it like you would to a friend.'
      : (dF === 0 ? 'results froze at 6pm. rest tonight; the talk can wait a day.' : 'results froze sat 5 dec. one run-through today is plenty.'),
    voice: true
  };
  else if (dF === 0) cspec = { title: 'Freeze today, 6pm', sub: 'save what you have before six. that is the whole job today.', voice: true };
  else cspec = {
    title: plural(dF, 'day') + ' to the freeze',
    sub: next && next.title ? 'next: ' + next.title + (next.date ? ' · ' + whenDate(next.date, today) : '') : 'one small thing today is plenty.',
    voice: !(next && next.title)
  };
  cspec.hash = (next && next.hash) || 'lab';
  cspec.ch = cspec.state === 'done' ? null : 'project';
  setSlot('capstone', cspec);
}

function paintStrip(now) {
  var strip = document.getElementById('v2-wkstrip');
  if (!strip) return;
  var P = paths();
  var t = now.target ? now.target.n : null;
  var jd = now.justDone ? now.justDone.n : null;
  var links = strip.querySelectorAll('.v2-wk');
  for (var i = 0; i < links.length; i++) {
    var a = links[i], n = Number(a.getAttribute('data-wk'));
    var w = APP.weekByN(n);
    var d = a.querySelector('.v2-wk-d');
    if (n === t) { a.setAttribute('data-now', '1'); a.setAttribute('aria-current', 'date'); if (d) d.textContent = now.isSaturday ? 'today' : 'next'; }
    else { a.removeAttribute('data-now'); a.removeAttribute('aria-current'); if (d && w) d.textContent = APP.dayMonth(w.saturday); }
    if (n === jd) a.setAttribute('data-just', '1'); else a.removeAttribute('data-just');
    if (w) a.setAttribute('data-past', w.saturday < now.today ? '1' : '0');
    var pw = P ? safe(function () { return P.week(n); }, null) : null;
    if (w) a.setAttribute('title', 'Week ' + n + ' · ' + APP.prettyDate(w.saturday) + ' · ' + weekName(w, pw) + (n === 0 ? ' (no Saturday session)' : ''));
    var pr = P ? safe(function () { return P.progress(n); }, null) : null;
    var p = a.querySelector('.v2-wk-p');
    if (p) {
      if (pr && pr.total) {
        var f = Math.min(1, pr.done / pr.total);
        p.style.width = (Math.round(f * 1000) / 10) + '%';
        a.setAttribute('data-prog', f >= 1 ? 'done' : (f > 0 ? 'some' : 'none'));
      } else { p.style.removeProperty('width'); a.removeAttribute('data-prog'); }
    }
  }
  /* bring the target into view in the sideways strip without moving the page */
  var cur = strip.querySelector('.v2-wk[data-now="1"]');
  if (cur && strip.scrollWidth > strip.clientWidth + 2 && !strip.__centred) {
    strip.__centred = 1;
    strip.scrollLeft = Math.max(0, cur.offsetLeft - (strip.clientWidth - cur.offsetWidth) / 2);
  }
}

function paint() {
  var el = document.getElementById('app-sec-today');
  if (!el || el.getAttribute('data-built') !== '1') return;
  var now = APP.v2now();
  paintHero(now);
  paintSlots(now);
  paintStrip(now);
}
APP._paintToday = paint;

APP.registerSection({
  id: 'today',
  title: 'Today',
  mount: function (el) {
    build(el);
    paint();
    var P = paths();
    if (P && P.ready && typeof P.ready.then === 'function' && !P.__todayHooked) {
      P.__todayHooked = 1;
      P.ready.then(paint, function () {});
    }
  },
  onTier: function () { /* Today has no tiered prose */ }
});

['tara:path', 'tara:recall', 'tara:session', 'tara:review', 'tara:capstone'].forEach(function (ev) {
  window.addEventListener(ev, function () { paint(); });
});
document.addEventListener('visibilitychange', function () { if (!document.hidden) paint(); });
/* paths.json may arrive after Today's first paint */
APP.onBoot(function () {
  var P = paths();
  if (P && P.ready && typeof P.ready.then === 'function') P.ready.then(paint, function () {});
});
})();

/* ===== src/v2/weeks.js ===== */
;(function(){
/* src/v2/weeks.js — the Weeks section and APP.paths (owner: paths).

   Routes: #weeks (every week as a tile in a fixed grid), #weeks/N (one week as one
   path), #weeks/N/<step>[/<i>] (one screen per step; the ideas deck takes a 1-based
   card number). Data: data/paths.json, built by tools/build-paths.js (the build
   copies it to shell/paths.<hash>.json and sets window.__PATHS_URL).

   Steps, in order: watch, ideas, play, do, check, ready (+ runway in W12-14).
   Progress lives in localStorage 'tara.v2.path'; the plan's ticks stay in
   'tara.fourteen.v1' (written only when it is in TARA order). Every change fires
   window 'tara:path' { week, step, progress }.

   Rules kept here: nothing reorders (cards keep their slots, state swaps text and
   attributes in place), tiers swap text inside a stable box (no jump), keys 1/2/3
   stay the shell's (answers use A-D), no scores or percentages, one big button per
   screen, every storage call in try/catch. */

'use strict';

var KEY = 'tara.v2.path';
var PLAN = 'tara.fourteen.v1';
var STEP_KIND = { watch: 'film', ideas: 'ideas', play: 'demo', 'do': 'checklist', check: 'check', ready: 'ready', runway: 'runway' };
var STEP_LABEL = { watch: 'Film', ideas: 'Ideas', play: 'Play', 'do': 'Checklist', check: 'Check', ready: 'Saturday', runway: 'Runway' };
var TIER_NAME = { 1: 'Plain', 2: 'Generalist', 3: 'Expert' };
var ROLE = { main: 'This week', deep: 'Deep dive', related: 'Related', course: 'The course' };
var LETTERS = 'ABCDEFGH';

/* ================================================================ helpers */

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
function own(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function count(o) { var n = 0; if (o) for (var k in o) if (own(o, k)) n++; return n; }
function safeCall(fn, dflt) { try { var v = fn(); return v == null ? dflt : v; } catch (e) { return dflt; } }
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
var NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
function word(n) { return NUM[n] || String(n); }
function coarse() { try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } }

function todayISO() {
  if (APP.todayISO) return APP.todayISO();
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function dayDiff(a, b) { return Math.round((Date.parse(b + 'T00:00:00') - Date.parse(a + 'T00:00:00')) / 86400000); }
function prettyDate(iso) { return APP.prettyDate ? APP.prettyDate(iso) : iso; }
function dayMonth(iso) { return APP.dayMonth ? APP.dayMonth(iso) : iso; }
function viewHref(p) { return APP.viewHref ? APP.viewHref(p) : '#view/' + String(p || '').replace(/^\/+/, ''); }
function now2() { return safeCall(function () { return APP.v2now(); }, { today: todayISO(), target: null, justDone: null, isSaturday: false }); }
function when(days) {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 1) return 'in ' + days + ' days';
  if (days === -1) return 'yesterday';
  return -days + ' days ago';
}
function mmss(sec) { sec = Math.max(0, Math.round(Number(sec) || 0)); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); }
function shuffle(a) {
  a = a.slice();
  for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}

/* Bank and path text may carry a little inline HTML. Keep b i em strong code sub
   sup br (no attributes), drop anything executable, unwrap the rest. */
var OK_TAGS = { B: 1, I: 1, EM: 1, STRONG: 1, CODE: 1, SUB: 1, SUP: 1, BR: 1 };
var DROP_TAGS = { SCRIPT: 1, STYLE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, TEMPLATE: 1, NOSCRIPT: 1, SVG: 1, MATH: 1, LINK: 1, META: 1 };
function cleanTree(node) {
  var kids = Array.prototype.slice.call(node.childNodes);
  for (var i = 0; i < kids.length; i++) {
    var c = kids[i];
    if (c.nodeType === 3) continue;
    if (c.nodeType !== 1) { node.removeChild(c); continue; }
    var tag = String(c.tagName).toUpperCase();
    if (DROP_TAGS[tag]) { node.removeChild(c); continue; }
    cleanTree(c);
    if (OK_TAGS[tag]) {
      while (c.attributes.length) c.removeAttribute(c.attributes[0].name);
      if (tag === 'CODE') c.className = 'fu-code';
      continue;
    }
    while (c.firstChild) node.insertBefore(c.firstChild, c);
    node.removeChild(c);
  }
}
function rich(html) {
  var t = document.createElement('template');
  t.innerHTML = String(html == null ? '' : html);
  cleanTree(t.content);
  return t.content;
}
function textOf(html) {
  var t = document.createElement('template');
  t.innerHTML = String(html == null ? '' : html);
  return (t.content.textContent || '').replace(/\s+/g, ' ').trim();
}

/* h('a', {class, text, html, onclick, ...attrs}, kids) */
function h(tag, a, kids) {
  var n = document.createElement(tag);
  if (a) for (var k in a) {
    if (!own(a, k)) continue;
    var v = a[k];
    if (v == null || v === false) continue;
    if (k === 'text') n.textContent = v;
    else if (k === 'html') n.appendChild(rich(v));
    else if (k === 'class') n.className = v;
    else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else n.setAttribute(k, String(v));
  }
  put(n, kids);
  return n;
}
function put(n, kids) {
  if (kids == null || kids === false) return;
  if (!Array.isArray(kids)) kids = [kids];
  for (var i = 0; i < kids.length; i++) {
    var c = kids[i];
    if (c == null || c === false) continue;
    if (Array.isArray(c)) put(n, c);
    else n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}
function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }

/* line icons on the 24px grid: 2.5px stroke, round caps (BRAND.md §7) */
var ICON = {
  prev: '<path d="M15 5l-7 7 7 7"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="M10 8.6l5.4 3.4-5.4 3.4z"/>',
  tri: '<path d="M8.5 5.8l10 6.2-10 6.2z"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  'case': '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5h6v2M3 12.5h18"/>',
  map: '<circle cx="6" cy="6.5" r="2.4"/><circle cx="18" cy="8" r="2.4"/><circle cx="9.5" cy="18" r="2.4"/><path d="M8.4 6.8l7.2.9M6.8 8.8l1.8 6.9M16.4 9.9l-5.3 6.2"/>',
  flask: '<path d="M9 3h6M10 3v6l-5.6 9.6A1.6 1.6 0 005.8 21h12.4a1.6 1.6 0 001.4-2.4L14 9V3"/><path d="M7.3 15h9.4"/>',
  dial: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
  book: '<path d="M5 4.5h10.5A3.5 3.5 0 0119 8v12.5H8.5A3.5 3.5 0 015 17z"/><path d="M5 17a3.5 3.5 0 013.5-3.5H19"/>',
  arrow: '<path d="M5 12h13M13 6l6 6-6 6"/>'
};
function icon(name, cls) {
  var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  s.setAttribute('class', 'wk-ic' + (cls ? ' ' + cls : ''));
  s.innerHTML = ICON[name] || '';
  return s;
}

/* ================================================================== data */

var DATA = null;
var BY_N = Object.create(null);
var CARD_AT = Object.create(null);   // node id -> [{ n, i, list, card }]
var VIEW_AT = Object.create(null);   // site path -> [{ n, kind: 'film'|'obj', id }]
var loadErr = null;
var loading = null;
var readyRes = null;
var ready = new Promise(function (res) { readyRes = res; });

function stepOf(W, id) {
  var s = (W && W.steps) || [];
  for (var i = 0; i < s.length; i++) if (s[i].id === id) return s[i];
  return null;
}

function indexData(d) {
  BY_N = Object.create(null);
  CARD_AT = Object.create(null);
  VIEW_AT = Object.create(null);
  d.weeks.forEach(function (W) {
    BY_N[W.n] = W;
    var st = stepOf(W, 'ideas');
    if (st) ['cards', 'library', 'background'].forEach(function (list) {
      (st[list] || []).forEach(function (c, i) {
        (CARD_AT[c.id] = CARD_AT[c.id] || []).push({ n: W.n, i: i, list: list, card: c });
      });
    });
    var wa = stepOf(W, 'watch');
    if (wa) (wa.films || []).forEach(function (f) { (VIEW_AT[f.path] = VIEW_AT[f.path] || []).push({ n: W.n, kind: 'film', id: f.id }); });
    var pl = stepOf(W, 'play');
    if (pl) (pl.objects || []).forEach(function (o) { (VIEW_AT[o.path] = VIEW_AT[o.path] || []).push({ n: W.n, kind: 'obj', id: o.id }); });
  });
}

function load() {
  if (loading) return loading;
  var url = window.__PATHS_URL || 'data/paths.json';
  loadErr = null;
  loading = fetch(url, { credentials: 'same-origin' }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
    return r.json();
  }).then(function (d) {
    if (!d || !Array.isArray(d.weeks) || !d.weeks.length) throw new Error('paths.json has no weeks');
    DATA = d;
    indexData(d);
    readyRes(true);
    fire(null, null);
    rerender(true);
    return true;
  }).catch(function (e) {
    console.warn('paths: could not load the week paths', e);
    loadErr = e;
    loading = null;
    readyRes(false);
    rerender(true);
    return false;
  });
  return loading;
}

/* ============================================================== progress */

/* tara.v2.path = { v: 1, w: { "<n>": { d: {step: ts}  marked done
                                         o: {step: ts}  opened
                                         f: {film: ts}  films opened
                                         c: {node: 'got'|'shaky'}
                                         p: {item: ts}  play items opened
                                         k: { r: rounds finished, a: [asked ids] } } },
                    last: { n, step, i, at } } */
var _st = null;
function store(fresh) {
  if (_st && !fresh) return _st;
  var s = null;
  try { s = JSON.parse(lsGet(KEY) || 'null'); } catch (e) { s = null; }
  s = obj(s) || {};
  if (!obj(s.w)) s.w = {};
  s.v = 1;
  _st = s;
  return s;
}
function peek(n) { return obj(store().w[String(n)]); }
function part(w, f) { return (w && obj(w[f])) || {}; }

function fire(n, step) {
  var detail = { week: n == null ? null : Number(n), step: step || null, progress: n == null ? null : progress(n) };
  try { window.dispatchEvent(new CustomEvent('tara:path', { detail: detail })); } catch (e) {}
}

/* re-read, change, write, tell everyone */
function edit(n, fn, step) {
  var s = store(true);
  var k = String(n);
  var w = obj(s.w[k]) || (s.w[k] = {});
  ['d', 'o', 'f', 'c', 'p'].forEach(function (f) { if (!obj(w[f])) w[f] = {}; });
  if (!obj(w.k)) w.k = {};
  fn(w, s);
  lsSet(KEY, JSON.stringify(s));
  _st = s;
  fire(n, step);
}

/* the plan's ticks, the same rules as the Lab tab (src/v2/lab.js) so the three views
   agree: never held between writes, re-read before every write, written only when
   the store is in TARA order or empty (which is exactly what the plan's own first run
   writes), then the cached plan frame is dropped and 'tara:ticks' fires */
function planRead() {
  var raw = lsGet(PLAN);
  if (raw == null || raw === '') return { state: 'empty', data: {} };
  var d = null;
  try { d = JSON.parse(raw); } catch (e) { return { state: 'bad', data: {} }; }
  d = obj(d);
  if (!d) return { state: 'bad', data: {} };
  if (d.__order === 'tara') return { state: 'tara', data: d };
  return Object.keys(d).length ? { state: 'old', data: d } : { state: 'empty', data: d };
}
function ticks() { var p = planRead(); return p.state === 'tara' ? p.data : {}; }
function setTick(key, on) {
  var p = planRead();
  if (p.state === 'old' || p.state === 'bad') return false;     // older ticks wait for the plan to move them
  var d = p.data;
  d.__order = 'tara';
  if (on) d[key] = 1; else delete d[key];
  if (!lsSet(PLAN, JSON.stringify(d))) return false;
  try { if (APP.frames && typeof APP.frames.drop === 'function' && (!APP.frames.has || APP.frames.has('plan'))) APP.frames.drop('plan'); } catch (e) {}
  try { window.dispatchEvent(new CustomEvent('tara:ticks', { detail: { key: key, on: !!on, source: 'weeks' } })); } catch (e) {}
  return true;
}
function tickKeys(st) {
  var out = [];
  (st.pre || []).forEach(function (x) { if (x && x.k) out.push(x.k); });
  (st.ex || []).forEach(function (x) { if (x && x.k) out.push(x.k); });
  return out;
}

function stateOf(n, st, w) {
  var id = st.id;
  var seen = !!part(w, 'o')[id];
  /* the checklist is done when its ticks are: the plan, the lab and this view agree */
  if (id === 'do') {
    var keys = tickKeys(st);
    if (!keys.length) return seen ? 'done' : 'todo';
    var t = ticks(), on = 0;
    keys.forEach(function (k) { if (t[k]) on++; });
    if (on >= keys.length) return 'done';
    return on || seen ? 'doing' : 'todo';
  }
  if (part(w, 'd')[id]) return 'done';
  if (id === 'watch') return count(part(w, 'f')) ? 'done' : (seen ? 'doing' : 'todo');
  if (id === 'ideas') {
    var cards = st.cards || [];
    if (!cards.length) return seen ? 'done' : 'todo';
    var c = part(w, 'c'), m = 0;
    for (var i = 0; i < cards.length; i++) if (c[cards[i].id]) m++;
    if (m >= cards.length) return 'done';
    return m || seen ? 'doing' : 'todo';
  }
  if (id === 'play') return count(part(w, 'p')) ? 'done' : (seen ? 'doing' : 'todo');
  if (id === 'check') {
    var k2 = part(w, 'k');
    if ((Number(k2.r) || 0) >= 1) return 'done';
    return seen || (Array.isArray(k2.a) && k2.a.length) ? 'doing' : 'todo';
  }
  return seen ? 'done' : 'todo';            // ready, runway: opening is the step
}

function kindOf(st) {
  if (st.id === 'play') return (st.demos && st.demos.length) ? 'demo' : ((st.missions && st.missions.length) ? 'mission' : 'demo');
  return STEP_KIND[st.id] || st.id;
}
function pubStep(n, st, w) {
  return {
    id: st.id, kind: kindOf(st), title: st.title, sub: st.sub || '', minutes: Number(st.minutes) || 0,
    hash: st.hash || ('#weeks/' + n + '/' + st.id), state: stateOf(n, st, w)
  };
}

function progress(n) {
  var W = BY_N[Number(n)];
  if (!W) return { done: 0, total: 0 };
  var w = peek(W.n), done = 0;
  W.steps.forEach(function (st) { if (stateOf(W.n, st, w) === 'done') done++; });
  return { done: done, total: W.steps.length };
}

function firstOpenCard(st, w, prefer) {
  var cards = st.cards || [];
  var c = part(w, 'c');
  if (prefer != null && cards[prefer] && !c[cards[prefer].id]) return prefer;
  for (var i = 0; i < cards.length; i++) if (!c[cards[i].id]) return i;
  return null;
}

/* where to resume: the step the learner stopped in (if it is not done), else the
   first step not done; for ideas the hash points at a card */
function nextStep(n) {
  var W = BY_N[Number(n)];
  if (!W) return null;
  var w = peek(W.n);
  var s = store();
  var last = obj(s.last) && Number(s.last.n) === W.n ? s.last : null;
  var pick = null;
  if (last) { var ls = stepOf(W, last.step); if (ls && stateOf(W.n, ls, w) !== 'done') pick = ls; }
  if (!pick) for (var i = 0; i < W.steps.length; i++) if (stateOf(W.n, W.steps[i], w) !== 'done') { pick = W.steps[i]; break; }
  if (!pick) return null;
  var out = pubStep(W.n, pick, w);
  if (pick.id === 'ideas') {
    var ci = firstOpenCard(pick, w, last && last.step === 'ideas' && last.i != null ? Number(last.i) - 1 : null);
    if (ci != null) out.hash = '#weeks/' + W.n + '/ideas/' + (ci + 1);
  }
  return out;
}

function perCard(st) { var c = (st.cards || []).length; return c ? Math.max(0.5, (Number(st.minutes) || c) / c) : 1; }
function cardsLeft(st, w) { var c = part(w, 'c'), m = 0; (st.cards || []).forEach(function (x) { if (!c[x.id]) m++; }); return m; }

/* what fits in a 10 / 30 / 60 minute box: the resume step first (cut down to the
   box when it is bigger), then the other open steps in path order while they fit */
function planFor(n, minutes) {
  var W = BY_N[Number(n)];
  if (!W) return [];
  var box = Math.max(5, Number(minutes) || 30);
  var w = peek(W.n);
  var first = nextStep(W.n);
  if (!first) return [];
  var out = [], left = box;
  function sized(st) {
    var p = pubStep(W.n, st, w);
    if (st.id === 'ideas' && (st.cards || []).length) {
      var k = cardsLeft(st, w) || st.cards.length;
      p.minutes = Math.max(1, Math.round(k * perCard(st)));
      p.cards = k;
    }
    return p;
  }
  var head = stepOf(W, first.id);
  var p0 = sized(head);
  p0.hash = first.hash;
  if (p0.minutes > left) {
    if (head.id === 'ideas' && p0.cards) {
      var k0 = Math.max(1, Math.floor(left / perCard(head)));
      p0.title = plural(k0, 'idea card');
      p0.sub = 'of ' + p0.cards + ' left this week';
      p0.cards = k0;
      p0.minutes = Math.max(1, Math.round(k0 * perCard(head)));
    } else {
      p0.minutes = left;
    }
    p0.partial = true;
  }
  out.push(p0);
  left -= p0.minutes;
  W.steps.forEach(function (st) {
    if (st.id === head.id || left <= 0) return;
    if (stateOf(W.n, st, w) === 'done') return;
    var p = sized(st);
    if (p.minutes <= left) { out.push(p); left -= p.minutes; return; }
    if (st.id === 'ideas' && p.cards && left >= Math.ceil(perCard(st))) {
      var k = Math.floor(left / perCard(st));
      if (k >= 1) {
        p.title = plural(k, 'idea card');
        p.sub = 'of ' + p.cards + ' left this week';
        p.cards = k;
        p.minutes = Math.max(1, Math.round(k * perCard(st)));
        p.partial = true;
        out.push(p);
        left -= p.minutes;
      }
    }
  });
  return out;
}

/* a card's tiered text as plain strings (for Recall and anything else) */
function tierPlain(c, t) {
  var T = c.tiers || {};
  var t1 = T[1] || T['1'] || {}, t2 = T[2] || T['2'] || {}, t3 = T[3] || T['3'] || {};
  if (t === 1) return textOf(t1.pic || t1.plain);
  if (t === 2) return [t2.what, t2.when, t2.why].filter(Boolean).map(textOf).join(' ');
  var where = (t3.where || []).map(textOf).filter(Boolean);
  var bits = [textOf(t3.judge || t2.what || t1.plain)];
  if (where.length) bits.push('Also shows up in: ' + where.join('; ') + '.');
  return bits.filter(Boolean).join(' ');
}
function cardFor(id, n) {
  var at = CARD_AT[String(id)];
  if (!at || !at.length) return null;
  var hit = null, i;
  if (n != null) for (i = 0; i < at.length && !hit; i++) if (at[i].n === Number(n) && at[i].list === 'cards') hit = at[i];
  if (!hit && n != null) for (i = 0; i < at.length && !hit; i++) if (at[i].n === Number(n)) hit = at[i];
  if (!hit) for (i = 0; i < at.length && !hit; i++) if (at[i].list === 'cards') hit = at[i];
  hit = hit || at[0];
  var c = hit.card, t1 = (c.tiers && (c.tiers[1] || c.tiers['1'])) || {};
  return {
    id: c.id, label: c.label, title: c.title, week: hit.n, need: c.need,
    plain: textOf(t1.plain),
    tiers: { 1: tierPlain(c, 1), 2: tierPlain(c, 2), 3: tierPlain(c, 3) },
    film: c.film ? viewHref(c.film) : null,
    object: c.object ? viewHref(c.object) : null,
    hash: '#weeks/' + hit.n + '/ideas' + (hit.list === 'cards' ? '/' + (hit.i + 1) : '')
  };
}

/* Next (and APP.paths.mark) marks a step done, except the checklist: only its ticks do */
function markDone(n, step) { if (step === 'do') return; edit(n, function (w) { w.d[step] = Date.now(); }, step); }
function visit(n, step, i) {
  edit(n, function (w, s) {
    if (!w.o[step]) w.o[step] = Date.now();
    s.last = { n: Number(n), step: step, i: i == null ? null : Number(i), at: Date.now() };
  }, step);
}

/* ================================================================ APP.paths */

APP.paths = {
  ready: ready,
  week: function (n) {
    var W = BY_N[Number(n)];
    if (!W) return null;
    var w = peek(W.n);
    return {
      n: W.n, saturday: W.saturday, chapter: W.chapter, title: W.title, short: W.short,
      tint: W.tint, arena: W.arena, sections: (W.sections || []).slice(), online: !!W.online, risk: W.risk || null,
      steps: W.steps.map(function (st) { return pubStep(W.n, st, w); }),
      missions: (W.missions || []).map(function (m) { var o = {}; for (var k in m) if (own(m, k)) o[k] = m[k]; return o; })
    };
  },
  next: nextStep,
  progress: progress,
  plan: planFor,
  card: cardFor,
  /* extras, not in the contract */
  data: function () { return DATA; },
  weeks: function () { return DATA ? DATA.weeks.map(function (W) { return W.n; }) : []; },
  mark: function (n, step) { if (BY_N[Number(n)] && stepOf(BY_N[Number(n)], step)) { markDone(Number(n), step); repaint(); } },
  reload: function () { loading = null; return load(); }
};

/* ================================================================== view */

var V = { el: null, key: null, root: null, update: null, paint: null, onKey: null, onTier: null, cleanup: null };

function sectionEl() { return V.el || document.getElementById('app-sec-weeks'); }
function onScreen() { return document.documentElement.getAttribute('data-section') === 'weeks'; }

function parseRest(rest) {
  var parts = String(rest || '').split('/').filter(Boolean);
  var out = { n: null, step: null, i: null };
  if (!parts.length) return out;
  var m = /^(?:w|week-?)?(\d{1,2})$/i.exec(parts[0]);
  if (!m) return out;
  out.n = Number(m[1]);
  if (parts[1]) out.step = String(parts[1]).toLowerCase();
  if (parts[2] && /^\d{1,3}$/.test(parts[2])) out.i = Number(parts[2]);
  return out;
}

function mount(el, route) {
  V.el = el;
  el.classList.add('wk-sec');
  var r = parseRest(route && route.params && route.params.rest);
  if (!DATA) {
    if (V.key === 'wait' && V.root && el.contains(V.root) && !loadErr) return;
    if (V.cleanup) { try { V.cleanup(); } catch (e) {} V.cleanup = null; }
    clear(el);
    V.root = loadErr ? oops() : waiting();
    V.key = loadErr ? 'oops' : 'wait';
    V.update = V.paint = V.onKey = V.onTier = null;
    el.appendChild(V.root);
    if (!loadErr) load();
    return;
  }
  var W = r.n != null ? BY_N[r.n] : null;
  var st = W && r.step ? stepOf(W, r.step) : null;
  var key = !W ? 'index' : (!st ? 'week:' + W.n : 'step:' + W.n + ':' + st.id);
  if (V.key === key && V.root && el.contains(V.root)) {
    _st = null;
    if (V.update) V.update(r);
    if (W && st) visit(W.n, st.id, r.i);
    return;
  }
  if (V.cleanup) { try { V.cleanup(); } catch (e) {} V.cleanup = null; }
  V.update = V.paint = V.onKey = V.onTier = null;
  clear(el);
  _st = null;
  var view = !W ? buildIndex() : (!st ? buildWeek(W) : buildStep(W, st, r));
  V.key = key;
  V.root = view.root;
  V.update = view.update || null;
  V.paint = view.paint || null;
  V.onKey = view.onKey || null;
  V.onTier = view.onTier || null;
  V.cleanup = view.cleanup || null;
  el.appendChild(view.root);
  el.scrollTop = 0;
  if (W && st) visit(W.n, st.id, r.i);
  if (V.paint) V.paint();
}

function unmount() { /* the DOM stays (no reorder, no rebuild on return); keys check data-section */ }

function rerender(force) {
  var el = sectionEl();
  if (!el || el.hidden || !onScreen()) { if (force) V.key = null; return; }
  var r = APP.route && APP.route();
  if (!r || r.section !== 'weeks') return;
  if (force) V.key = null;
  mount(el, r);
}
function repaint() { _st = null; if (V.paint && onScreen()) { try { V.paint(); } catch (e) { console.warn('weeks: repaint failed', e); } } }

function waiting() {
  return h('div', { 'class': 'app-sec-pad wk' }, h('div', { 'class': 'fu-loading wk-wait', role: 'status' }, [
    h('span', { 'class': 'fu-loading__lamp', 'aria-hidden': 'true' }),
    h('p', { 'class': 'fu-loading__line', text: 'setting out the cards...' })
  ]));
}
function oops() {
  return h('div', { 'class': 'app-sec-pad wk' }, h('div', { 'class': 'fu-oops', role: 'alert' }, [
    h('p', { 'class': 'fu-oops__line', text: 'that fumbled. nothing is lost; try again.' }),
    h('p', { 'class': 'fu-oops__detail', text: String((loadErr && loadErr.message) || 'the week paths did not load') }),
    h('button', { type: 'button', 'class': 'fu-btn', text: 'Try again', onclick: function () { loadErr = null; V.key = null; loading = null; rerender(true); load(); } })
  ]));
}

function progressBar(label, done, total, thin) {
  var bar = h('span', {
    'class': 'fu-progress' + (thin ? ' fu-progress--thin' : '') + ' wk-prog', role: 'progressbar',
    'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(done)
  }, h('span', { 'class': 'fu-progress__fill' }));
  return bar;
}
function setProgress(bar, done, total, label) {
  if (!bar) return;
  bar.setAttribute('aria-valuemax', String(total));
  bar.setAttribute('aria-valuenow', String(done));
  bar.setAttribute('aria-valuetext', done + ' of ' + plural(total, 'step') + ' done');
  if (label) bar.setAttribute('aria-label', label);
  var f = bar.firstChild;
  if (f) f.style.width = (total ? Math.round(1000 * Math.min(done, total) / total) / 10 : 0) + '%';
}

/* ------------------------------------------------------------- the index */

function buildIndex() {
  var root = h('div', { 'class': 'app-sec-pad wk wk-index' });
  root.appendChild(h('header', { 'class': 'wk-ihead' }, [
    h('h1', { 'class': 'fu-h1', text: 'Weeks' }),
    h('p', { 'class': 'fu-voice wk-lede', text: 'one path per saturday. start anywhere; each one remembers.' })
  ]));
  var grid = h('ol', { 'class': 'wk-grid', 'aria-label': 'Every week, in order' });
  var tiles = [];
  DATA.weeks.forEach(function (W) {
    var badge = h('span', { 'class': 'wk-tile-b' });
    var bar = progressBar('Week ' + W.n + ' path', 0, W.steps.length, true);
    var a = h('a', { 'class': 'wk-tile fu-card fu-card--lift fu-ch-' + W.tint, href: '#weeks/' + W.n, 'data-n': W.n }, [
      h('span', { 'class': 'wk-tile-top' }, [
        h('b', { 'class': 'wk-tile-n', text: 'W' + W.n }),
        h('span', { 'class': 'wk-tile-d', text: dayMonth(W.saturday) })
      ]),
      h('span', { 'class': 'wk-tile-t', lang: 'en', text: W.short || W.title }),
      badge,
      bar
    ]);
    tiles.push({ W: W, a: a, badge: badge, bar: bar });
    grid.appendChild(h('li', { 'class': 'wk-cell' }, a));
  });
  root.appendChild(grid);

  /* the chapters, in course order: a legend for the tints */
  var legend = h('ul', { 'class': 'wk-legend', 'aria-label': 'Chapters' });
  var seen = {};
  DATA.weeks.forEach(function (W) {
    if (seen[W.tint]) return;
    seen[W.tint] = 1;
    var span = (DATA.tints && DATA.tints[W.tint]) || [W.n, W.n];
    legend.appendChild(h('li', null, h('span', { 'class': 'fu-chip fu-ch-' + W.tint },
      [h('b', { text: span[0] === span[1] ? 'W' + span[0] : 'W' + span[0] + '–' + span[1] }), ' ' + W.chapter])));
  });
  root.appendChild(legend);

  function paint() {
    var now = now2();
    var t = now.target ? now.target.n : null, jd = now.justDone ? now.justDone.n : null;
    tiles.forEach(function (x) {
      var pr = progress(x.W.n);
      setProgress(x.bar, pr.done, pr.total, 'Week ' + x.W.n + ' path');
      clear(x.badge);
      var b = null;
      if (x.W.n === t) b = h('span', { 'class': 'fu-badge fu-badge--signal', text: now.isSaturday ? 'today' : 'next saturday' });
      else if (x.W.n === jd) b = h('span', { 'class': 'fu-badge fu-badge--quiet', text: 'just done' });
      else if (pr.total && pr.done >= pr.total) b = h('span', { 'class': 'fu-badge fu-badge--gold', text: 'path done' });
      if (b) x.badge.appendChild(b);
      x.a.setAttribute('data-state', pr.done >= pr.total && pr.total ? 'done' : (pr.done ? 'doing' : 'todo'));
      if (x.W.n === t) x.a.setAttribute('aria-current', 'date'); else x.a.removeAttribute('aria-current');
      x.a.setAttribute('aria-label', 'Week ' + x.W.n + ', ' + prettyDate(x.W.saturday) + ': ' + (x.W.short || x.W.title) +
        '. ' + pr.done + ' of ' + plural(pr.total, 'step') + ' done' + (b ? '. ' + b.textContent : ''));
    });
  }
  return { root: root, paint: paint, update: paint };
}

/* -------------------------------------------------------------- one week */

function weekHead(W, opts) {
  var date = h('span', { 'class': 'fu-small wk-hero-d' });
  var bar = progressBar('Week ' + W.n + ' path', 0, W.steps.length, false);
  var pt = h('span', { 'class': 'fu-small wk-hero-p' });
  var head = h('header', { 'class': 'wk-hero fu-card fu-ch-' + W.tint }, [
    h('div', { 'class': 'wk-hero-top' }, [h('span', { 'class': 'fu-plate', text: 'Week ' + W.n }), date]),
    h(opts && opts.h2 ? 'h2' : 'h1', { 'class': 'fu-h1 wk-hero-t', text: W.title }),
    h('p', { 'class': 'fu-small wk-hero-a' }, [h('b', { text: W.chapter }), W.arena ? ' · ' + W.arena : '']),
    h('div', { 'class': 'wk-hero-pr' }, [bar, pt])
  ]);
  function paint() {
    var t = todayISO(), d = dayDiff(t, W.saturday);
    var bits = [prettyDate(W.saturday)];
    if (W.n === 0) bits.push('online, no session');
    bits.push(d === 0 ? 'today' : when(d));
    date.textContent = bits.join(' · ');
    var pr = progress(W.n);
    setProgress(bar, pr.done, pr.total);
    pt.textContent = pr.done >= pr.total ? 'every step done' : pr.done + ' of ' + plural(pr.total, 'step') + ' done';
  }
  return { el: head, paint: paint };
}

function buildWeek(W) {
  var root = h('div', { 'class': 'app-sec-pad wk wk-week', 'data-n': W.n });
  var prevW = BY_N[W.n - 1], nextW = BY_N[W.n + 1];
  root.appendChild(h('nav', { 'class': 'wk-crumbs', 'aria-label': 'Weeks' }, [
    h('a', { 'class': 'fu-btn fu-btn--link wk-crumb', href: '#weeks', text: '← All weeks' }),
    h('span', { 'class': 'wk-crumbs-r' }, [
      prevW ? h('a', { 'class': 'fu-iconbtn wk-wknav', href: '#weeks/' + prevW.n, 'aria-label': 'Week ' + prevW.n, title: 'Week ' + prevW.n }, icon('prev'))
        : h('span', { 'class': 'wk-wknav wk-wknav--off', 'aria-hidden': 'true' }),
      nextW ? h('a', { 'class': 'fu-iconbtn wk-wknav', href: '#weeks/' + nextW.n, 'aria-label': 'Week ' + nextW.n, title: 'Week ' + nextW.n }, icon('next'))
        : h('span', { 'class': 'wk-wknav wk-wknav--off', 'aria-hidden': 'true' })
    ])
  ]));
  var head = weekHead(W);
  root.appendChild(head.el);

  var voice = h('p', { 'class': 'fu-voice wk-go-v' });
  var go = h('a', { 'class': 'fu-btn fu-btn--big fu-btn--wide wk-go-b', href: '#weeks/' + W.n });
  var nextLine = h('p', { 'class': 'fu-small wk-go-n' });
  root.appendChild(h('div', { 'class': 'wk-go' }, [voice, go, nextLine]));

  var ol = h('ol', { 'class': 'wk-steps', 'aria-label': 'The path for week ' + W.n });
  var rows = W.steps.map(function (st, i) {
    var tick = h('span', { 'class': 'fu-tick wk-step-tick', 'aria-hidden': 'true' });
    var flag = h('span', { 'class': 'wk-step-flag' });
    var a = h('a', { 'class': 'wk-step fu-card fu-card--lift', href: st.hash, 'data-step': st.id }, [
      h('span', { 'class': 'wk-step-n', 'aria-hidden': 'true', text: String(i + 1) }),
      h('span', { 'class': 'wk-step-main' }, [
        h('span', { 'class': 'fu-label wk-step-k', text: STEP_LABEL[st.id] || st.id }),
        h('span', { 'class': 'wk-step-t', text: st.title }),
        h('span', { 'class': 'fu-small wk-step-s', text: st.sub || '' })
      ]),
      h('span', { 'class': 'wk-step-side' }, [tick, h('span', { 'class': 'fu-mono wk-step-m', text: (st.minutes || 0) + ' min' }), flag])
    ]);
    ol.appendChild(h('li', { 'class': 'wk-step-li' }, a));
    return { st: st, a: a, tick: tick, flag: flag };
  });
  root.appendChild(ol);

  /* the plan row and the pack, quietly, at the foot */
  var packs = (stepOf(W, 'do') || {}).packs || [];
  root.appendChild(h('div', { 'class': 'wk-foot wk-foot--week' }, [
    h('a', { 'class': 'fu-btn fu-btn--ghost', href: '#plan/week-' + W.n }, [icon('book'), 'The plan row']),
    packs.length ? h('a', { 'class': 'fu-btn fu-btn--ghost', href: packs[0].hash }, [icon('book'), 'The pack']) : null
  ]));

  function paint() {
    head.paint();
    var w = peek(W.n), nx = nextStep(W.n), pr = progress(W.n);
    rows.forEach(function (r) {
      var s = stateOf(W.n, r.st, w);
      r.a.setAttribute('data-state', s);
      r.a.classList.toggle('fu-card--done', s === 'done');
      r.tick.className = 'fu-tick wk-step-tick' + (s === 'done' ? ' is-on' : (s === 'doing' ? ' is-doing' : ''));
      clear(r.flag);
      var isNext = nx && nx.id === r.st.id;
      if (isNext) r.flag.appendChild(h('span', { 'class': 'fu-badge fu-badge--signal', text: 'next' }));
      r.a.setAttribute('aria-label', (W.steps.indexOf(r.st) + 1) + '. ' + (STEP_LABEL[r.st.id] || '') + ': ' + r.st.title +
        (r.st.sub ? ', ' + r.st.sub : '') + '. ' + (r.st.minutes || 0) + ' minutes. ' +
        (s === 'done' ? 'Done.' : s === 'doing' ? 'Started.' : 'Not started.') + (isNext ? ' Next.' : ''));
      if (r.st.id === 'ideas' && nx && nx.id === 'ideas') r.a.setAttribute('href', nx.hash); else r.a.setAttribute('href', r.st.hash);
    });
    if (nx) {
      voice.hidden = true;
      go.textContent = pr.done ? 'Pick up where you stopped' : 'Start the path';
      go.setAttribute('href', nx.hash);
      var bits = [nx.title];
      var m = /\/ideas\/(\d+)$/.exec(nx.hash);
      var ist = stepOf(W, 'ideas');
      if (m && ist) bits.push('card ' + m[1] + ' of ' + ist.cards.length);
      bits.push(nx.minutes + ' min');
      nextLine.textContent = 'next · ' + bits.join(' · ');
      nextLine.hidden = false;
    } else {
      voice.hidden = false;
      var past = W.saturday < todayISO();
      voice.textContent = 'week ' + W.n + ', done. ' + (past ? 'it keeps; recall brings it back.' : 'see you saturday.');
      if (nextW) { go.textContent = 'On to week ' + nextW.n; go.setAttribute('href', '#weeks/' + nextW.n); }
      else { go.textContent = 'Back to Today'; go.setAttribute('href', '#today'); }
      nextLine.hidden = true;
    }
  }
  return { root: root, paint: paint, update: paint };
}

/* ------------------------------------------------------------ step frame */

function buildStep(W, st, r) {
  var idx = W.steps.indexOf(st), nx = W.steps[idx + 1];
  var root = h('div', { 'class': 'app-sec-pad wk wk-sv', 'data-step': st.id, 'data-n': W.n });
  root.appendChild(h('nav', { 'class': 'wk-crumbs', 'aria-label': 'Week ' + W.n + ' path' }, [
    h('a', { 'class': 'fu-btn fu-btn--link wk-crumb', href: '#weeks/' + W.n, text: '← Week ' + W.n + ' path' }),
    h('span', { 'class': 'fu-mono wk-crumb-pos', 'aria-label': 'Step ' + (idx + 1) + ' of ' + W.steps.length, text: (idx + 1) + ' / ' + W.steps.length })
  ]));
  var tick = h('span', { 'class': 'fu-tick', 'aria-hidden': 'true' });
  root.appendChild(h('header', { 'class': 'wk-shead fu-ch-' + W.tint }, [
    h('span', { 'class': 'wk-shead-k' }, [tick, h('span', { 'class': 'fu-label', text: (STEP_LABEL[st.id] || st.id) + ' · W' + W.n })]),
    h('h1', { 'class': 'fu-h2 wk-shead-t', text: st.title }),
    st.sub ? h('p', { 'class': 'fu-small wk-shead-s', text: st.sub }) : null
  ]));
  var body = h('div', { 'class': 'wk-sbody' });
  root.appendChild(body);
  var nextBtn = h('a', {
    'class': 'fu-btn fu-btn--big fu-btn--wide wk-nextbtn', href: nx ? nx.hash : '#weeks/' + W.n,
    text: nx ? 'Next: ' + nx.title : 'Finish week ' + W.n,
    onclick: function () { markDone(W.n, st.id); }
  });
  root.appendChild(h('footer', { 'class': 'wk-foot' }, [
    nextBtn,
    h('a', { 'class': 'fu-btn fu-btn--link wk-quiet', href: '#weeks/' + W.n, text: 'back to the path' })
  ]));

  function paintHead() {
    var s = stateOf(W.n, st, peek(W.n));
    tick.className = 'fu-tick' + (s === 'done' ? ' is-on' : (s === 'doing' ? ' is-doing' : ''));
    root.setAttribute('data-state', s);
  }
  var F = { W: W, st: st, root: root, body: body, paintStep: paintHead };
  var inner = (BUILD[st.id] || buildPlain)(F, r) || {};
  function paint() {
    paintHead();
    if (inner.paint) inner.paint();
  }
  return {
    root: root, paint: paint,
    update: function (r2) { if (inner.update) inner.update(r2); paint(); },
    onKey: inner.onKey || null, onTier: inner.onTier || null, cleanup: inner.cleanup || null
  };
}

function buildPlain(F) {
  F.body.appendChild(h('p', { 'class': 'fu-voice', text: 'nothing to set out here.' }));
  return {};
}

function sub(title, extra) { return h('h2', { 'class': 'fu-label wk-sub' }, [title, extra || null]); }

/* ----------------------------------------------------------------- watch */

function filmCard(W, f, big) {
  var tick = h('span', { 'class': 'fu-tick', 'aria-hidden': 'true' });
  var a = h('a', {
    'class': 'wk-film fu-card fu-card--lift' + (big ? ' wk-film--big' : ''), href: viewHref(f.path), 'data-film': f.id,
    onclick: function () { edit(W.n, function (w) { w.f[f.id] = Date.now(); }, 'watch'); }
  }, [
    h('span', { 'class': 'wk-film-ic' }, icon('tri')),
    h('span', { 'class': 'wk-film-main' }, [
      big ? null : h('span', { 'class': 'fu-label wk-film-k', text: ROLE[f.role] || 'Film' }),
      h('span', { 'class': 'wk-film-t', text: f.title }),
      f.blurb ? h('span', { 'class': 'fu-small wk-film-s', text: f.blurb }) : null
    ]),
    h('span', { 'class': 'wk-film-side' }, [h('span', { 'class': 'fu-mono', text: mmss(f.seconds) }), tick])
  ]);
  return { a: a, tick: tick, f: f };
}

function buildWatch(F) {
  var W = F.W, st = F.st, all = [];
  var main = h('div', { 'class': 'wk-films' });
  (st.films || []).forEach(function (f) { var c = filmCard(W, f, true); all.push(c); main.appendChild(c.a); });
  F.body.appendChild(main);
  if ((st.extras || []).length) {
    F.body.appendChild(sub('More films'));
    var more = h('div', { 'class': 'wk-films wk-films--more' });
    st.extras.forEach(function (f) { var c = filmCard(W, f, false); all.push(c); more.appendChild(c.a); });
    F.body.appendChild(more);
  }
  F.body.appendChild(h('p', { 'class': 'fu-small wk-hint', text: 'Films open in the viewer; Back brings you here.' }));
  return {
    paint: function () {
      var seen = part(peek(W.n), 'f');
      all.forEach(function (c) { var on = !!seen[c.f.id]; c.tick.className = 'fu-tick' + (on ? ' is-on' : ''); c.a.setAttribute('data-seen', on ? '1' : '0'); });
    }
  };
}

/* ----------------------------------------------------------------- ideas */

function toRecall(spec, fallbackText, fallbackMeta) {
  try {
    if (APP.recall && typeof APP.recall.add === 'function') { var it = APP.recall.add(spec); if (it) return it; }
  } catch (e) { console.warn('weeks: recall.add failed', e); }
  try { if (APP.review && typeof APP.review.add === 'function') APP.review.add(fallbackText, fallbackMeta || {}); } catch (e) {}
  return null;
}
function comesBack(item) {
  if (!item || !item.due) return 'it is saved for review';
  var d = dayDiff(todayISO(), item.due);
  return 'it comes back ' + (d <= 0 ? 'today' : d === 1 ? 'tomorrow' : 'in ' + d + ' days');
}

/* "Five cards went to Recall; they come back tomorrow." */
function sentLine(items) {
  var n = items.length;
  if (!n) return 'Nothing went to Recall this round.';
  var head = word(n).charAt(0).toUpperCase() + word(n).slice(1) + (n === 1 ? ' card' : ' cards');
  var dues = items.map(function (it) { return it && it.due ? dayDiff(todayISO(), it.due) : null; });
  if (dues.some(function (d) { return d == null; })) return head + (n === 1 ? ' is' : ' are') + ' saved for review.';
  var soon = Math.min.apply(null, dues), same = dues.every(function (d) { return d === soon; });
  var at = soon <= 0 ? 'today' : soon === 1 ? 'tomorrow' : 'in ' + soon + ' days';
  return head + ' went to Recall; ' + (n === 1 ? 'it comes' : same ? 'they come' : 'the first comes') + ' back ' + at + '.';
}

function door(label, ic, href, title) {
  if (!href) return h('span', { 'class': 'fu-btn fu-btn--ghost fu-btn--small wk-door', 'aria-disabled': 'true', title: title || 'not for this one' }, [icon(ic), label]);
  return h('a', { 'class': 'fu-btn fu-btn--ghost fu-btn--small wk-door', href: href, title: title || null }, [icon(ic), label]);
}

function tierLayers(c, W) {
  var T = c.tiers || {};
  var t1 = T[1] || T['1'] || {}, t2 = T[2] || T['2'] || {}, t3 = T[3] || T['3'] || {};
  var secName = c.section && DATA.sections ? DATA.sections[c.section] : null;
  /* the plain line leads the card in every tier; the layers below it go deeper */
  var l1 = h('div', { 'class': 'wk-tier', 'data-t': '1' }, [
    h('span', { 'class': 'fu-label wk-tier-n', text: TIER_NAME[1] }),
    t1.pic ? h('div', { 'class': 'wk-pic' }, [h('span', { 'class': 'fu-label', text: 'Picture it' }), h('p', { html: t1.pic })]) : null
  ]);
  var dl = h('dl', { 'class': 'wk-www' });
  [['What', t2.what], ['When', t2.when], ['Why', t2.why]].forEach(function (p) {
    if (!p[1]) return;
    dl.appendChild(h('div', { 'class': 'wk-www-r' }, [h('dt', { 'class': 'fu-label', text: p[0] }), h('dd', { html: p[1] })]));
  });
  var l2 = h('div', { 'class': 'wk-tier', 'data-t': '2' }, [h('span', { 'class': 'fu-label wk-tier-n', text: TIER_NAME[2] }), dl]);
  var where = (t3.where || []).filter(Boolean);
  var l3 = h('div', { 'class': 'wk-tier', 'data-t': '3' }, [
    h('span', { 'class': 'fu-label wk-tier-n', text: TIER_NAME[3] }),
    t2.what ? h('p', { 'class': 'wk-tier-p', html: t2.what }) : null,
    t3.judge ? h('div', { 'class': 'wk-judge' }, [h('span', { 'class': 'fu-label', text: 'Where the field stands' }), h('p', { html: t3.judge })]) : null,
    where.length ? h('div', { 'class': 'wk-where' }, [h('span', { 'class': 'fu-label', text: 'Where else it shows up' }),
      h('ul', null, where.map(function (x) { return h('li', { html: x }); }))]) : null,
    c.section ? h('p', { 'class': 'fu-small wk-arena' }, [h('b', { text: 'ARENA ' + c.section }), secName ? ' ' + secName : '']) : null
  ]);
  return [l1, l2, l3];
}

function buildIdeas(F, r) {
  var W = F.W, st = F.st, cards = st.cards || [];
  var deck = { i: 0 };
  var wrap = h('div', { 'class': 'wk-deck', 'data-tier': String(APP.tier ? APP.tier() : 2) });
  F.body.appendChild(wrap);
  var card = null, set = null, pos = null, dots = null, prevB = null, nextB = null, layersBox = null, label = null, badges = null,
      title = null, lead = null, doorsBox = null, gotB = null, shakyB = null, doneLine = null, dotEls = [];

  if (cards.length) {
    prevB = h('button', { type: 'button', 'class': 'fu-iconbtn wk-dnav', 'aria-label': 'Previous card' }, icon('prev'));
    nextB = h('button', { type: 'button', 'class': 'fu-iconbtn wk-dnav', 'aria-label': 'Next card' }, icon('next'));
    pos = h('span', { 'class': 'wk-dpos', 'aria-live': 'polite' });
    dots = h('div', { 'class': 'wk-dots', 'aria-hidden': 'true' });
    cards.forEach(function () { var d = h('i', { 'class': 'wk-dot' }); dotEls.push(d); dots.appendChild(d); });
    wrap.appendChild(h('div', { 'class': 'wk-deckbar' }, [prevB, h('div', { 'class': 'wk-dmid' }, [pos, dots]), nextB]));

    label = h('span', { 'class': 'fu-label wk-card-l' });
    badges = h('span', { 'class': 'wk-card-b' });
    title = h('h2', { 'class': 'wk-card-t fu-voice', id: 'wk-card-t-' + W.n });
    lead = h('p', { 'class': 'wk-card-p' });
    layersBox = h('div', { 'class': 'wk-tiers wk-more' });
    doorsBox = h('div', { 'class': 'wk-doors', role: 'group', 'aria-label': 'Open it as' });
    gotB = h('button', { type: 'button', 'class': 'fu-btn wk-grade', 'data-g': 'got', 'aria-pressed': 'false' }, 'Got it');
    shakyB = h('button', { type: 'button', 'class': 'fu-btn fu-btn--ghost wk-grade', 'data-g': 'shaky', 'aria-pressed': 'false' }, 'Shaky');
    doneLine = h('p', { 'class': 'fu-voice wk-deckdone', 'aria-live': 'polite' });
    /* the card holds what you grade on (title, plain line) and the grade row, so a phone
       never scrolls to grade; the tier layers sit under it, sharing one cell */
    card = h('div', { 'class': 'wk-card fu-card' }, [
      h('div', { 'class': 'wk-card-top' }, [label, badges]),
      title,
      lead,
      h('div', { 'class': 'wk-grades', role: 'group', 'aria-label': 'How solid is it' }, [gotB, shakyB]),
      doorsBox
    ]);
    set = h('article', { 'class': 'wk-cardset', 'aria-labelledby': 'wk-card-t-' + W.n }, [card, layersBox]);
    wrap.appendChild(set);
    wrap.appendChild(doneLine);
    prevB.addEventListener('click', function () { go(deck.i - 1); });
    nextB.addEventListener('click', function () { go(deck.i + 1); });
    gotB.addEventListener('click', function () { grade('got'); });
    shakyB.addEventListener('click', function () { grade('shaky'); });
    swipe(set, function (dir) { go(deck.i + dir); });
  } else {
    wrap.appendChild(h('div', { 'class': 'fu-empty wk-nocards' }, [
      h('p', { 'class': 'fu-empty__line', text: 'no core cards this week. the library calls below are the whole deck.' })
    ]));
  }

  /* library calls and background: collapsed under the deck, never in the way */
  function shelf(list, head, line, open) {
    if (!list || !list.length) return null;
    var ul = h('ul', { 'class': 'wk-libl' });
    list.forEach(function (c) {
      ul.appendChild(h('li', { 'class': 'fu-item wk-libi' }, [
        h('span', { 'class': 'wk-libi-main' }, [h('b', { text: c.label }), h('span', { 'class': 'fu-small', text: c.title })]),
        h('span', { 'class': 'wk-libi-doors' }, [
          c.film ? h('a', { 'class': 'fu-iconbtn', href: viewHref(c.film), 'aria-label': 'Film: ' + c.label, title: 'Film' }, icon('play')) : null,
          h('a', { 'class': 'fu-iconbtn', href: '#map/node=' + encodeURIComponent(c.id), 'aria-label': 'On the map: ' + c.label, title: 'Map' }, icon('map'))
        ])
      ]));
    });
    var d = h('details', { 'class': 'wk-lib fu-card fu-card--flat' }, [
      h('summary', { 'class': 'wk-lib-s' }, [h('span', { 'class': 'fu-label', text: head }), h('span', { 'class': 'fu-badge fu-badge--quiet', text: String(list.length) })]),
      h('p', { 'class': 'fu-voice wk-lib-v', text: line }),
      ul
    ]);
    if (open) d.open = true;
    return d;
  }
  var lib = shelf(st.library, 'Library calls', 'library call, low utility. skip it guilt-free.', !cards.length);
  if (lib) F.body.appendChild(lib);
  var bg = shelf(st.background, 'Background', 'cards from the map with no week of their own. browse if curious.', false);
  if (bg) F.body.appendChild(bg);

  function marks() { return part(peek(W.n), 'c'); }

  function fill(i) {
    var c = cards[i];
    label.textContent = c.label;
    clear(badges);
    if (c.need === 'contested') badges.appendChild(h('span', { 'class': 'fu-badge fu-badge--gold', text: 'contested' }));
    if (c.again != null) badges.appendChild(h('span', { 'class': 'fu-badge fu-badge--quiet', text: 'again from W' + c.again }));
    if (c.section) badges.appendChild(h('span', { 'class': 'fu-badge fu-badge--quiet', text: c.section.replace(/[\[\]]/g, '') }));
    title.textContent = c.title || c.label;
    var T = c.tiers || {}, p1 = (T[1] || T['1'] || {}).plain || (T[2] || T['2'] || {}).what || '';
    lead.innerHTML = p1;
    lead.hidden = !p1;
    clear(layersBox);
    put(layersBox, tierLayers(c, W));
    clear(doorsBox);
    put(doorsBox, [
      door('Film', 'play', c.film ? viewHref(c.film) : null, '1-minute film'),
      door('3D', 'cube', c.object ? viewHref(c.object) : null, c.objectTitle ? '3D: ' + c.objectTitle : '3D twin'),
      door('Case', 'case', c['case'] ? '#cases/' + encodeURIComponent(c['case']) : null, c['case'] ? 'The case' : 'no case for this one'),
      door('Map', 'map', '#map/node=' + encodeURIComponent(c.id), 'On the concept map')
    ]);
    applyTier();
  }
  function applyTier() {
    var t = String(APP.tier ? APP.tier() : 2);
    wrap.setAttribute('data-tier', t);
    if (!layersBox) return;
    var ls = layersBox.children;
    for (var k = 0; k < ls.length; k++) {
      var on = ls[k].getAttribute('data-t') === t;
      if (on) ls[k].removeAttribute('aria-hidden'); else ls[k].setAttribute('aria-hidden', 'true');
    }
  }
  function paintMarks() {
    if (!cards.length) return;
    var m = marks(), done = 0;
    cards.forEach(function (c, k) {
      var g = m[c.id];
      if (g) done++;
      dotEls[k].className = 'wk-dot' + (g === 'got' ? ' is-got' : g === 'shaky' ? ' is-shaky' : '') + (k === deck.i ? ' is-here' : '');
    });
    var g2 = m[cards[deck.i].id];
    gotB.setAttribute('aria-pressed', g2 === 'got' ? 'true' : 'false');
    shakyB.setAttribute('aria-pressed', g2 === 'shaky' ? 'true' : 'false');
    card.setAttribute('data-grade', g2 || '');
    pos.textContent = 'Card ' + (deck.i + 1) + ' of ' + cards.length;
    prevB.disabled = deck.i <= 0;
    nextB.disabled = deck.i >= cards.length - 1;
    var how = coarse() ? 'swipe for the next card' : '← → move · G got it · S shaky';
    doneLine.textContent = done >= cards.length
      ? 'all ' + word(cards.length) + ' marked. the next step is below.'
      : (done ? done + ' of ' + cards.length + ' marked · ' + how : how);
  }
  function show(i) {
    if (!cards.length) return;
    i = Math.max(0, Math.min(cards.length - 1, i));
    var changed = i !== deck.i || !label.textContent;
    deck.i = i;
    if (changed) fill(i);
    paintMarks();
  }
  /* in-deck moves keep the shell's hash honest without a re-mount (as viewer.js does) */
  function go(i, keepScroll) {
    if (!cards.length) return;
    i = Math.max(0, Math.min(cards.length - 1, i));
    if (i === deck.i) return;
    show(i);
    var want = 'weeks/' + W.n + '/ideas/' + (i + 1);
    try {
      if (location.hash !== '#' + want) {
        /* in place, keeping this entry's v2 stamps (the shell's back and tab memory read them) */
        if (APP.replaceHash) APP.replaceHash(want);
        else history.replaceState(history.state, '', '#' + want);
      }
      if (APP._route && APP._route.section === 'weeks') { APP._route.raw = want; APP._route.params.rest = want.slice(6); }
    } catch (e) {}
    edit(W.n, function (w, s) { s.last = { n: W.n, step: 'ideas', i: i + 1, at: Date.now() }; }, 'ideas');
    if (!keepScroll) bringIntoView();
  }
  function bringIntoView() {
    var sec = sectionEl();
    if (!sec || !wrap) return;
    var top = wrap.getBoundingClientRect().top - sec.getBoundingClientRect().top;
    if (top < 0) sec.scrollTop += top - 8;
  }
  function grade(g) {
    var c = cards[deck.i];
    if (!c) return;
    var was = marks()[c.id];
    edit(W.n, function (w) { w.c[c.id] = g; }, 'ideas');
    if (g === 'shaky' && was !== 'shaky') {
      var plain = textOf(((c.tiers || {})[1] || {}).plain);
      var it = toRecall({ kind: 'concept', id: c.id, concept: c.id, week: W.n, title: c.label, text: plain, hash: '#weeks/' + W.n + '/ideas/' + (deck.i + 1) },
        c.label + ': ' + plain, { title: 'Week ' + W.n + ' · ' + c.label, hash: '#weeks/' + W.n + '/ideas/' + (deck.i + 1) });
      if (APP.toast) APP.toast('shaky is fine. ' + comesBack(it) + '.');
    }
    paintMarks();
    if (F.paintStep) F.paintStep();
    var at = deck.i;
    if (at < cards.length - 1) setTimeout(function () { if (deck.i === at && document.contains(card)) go(at + 1); }, 320);
  }

  function update(r2) {
    if (!cards.length) return;
    var want = r2 && r2.i != null ? r2.i - 1 : null;
    if (want == null) {
      var s = store().last;
      want = firstOpenCard(st, peek(W.n), obj(s) && Number(s.n) === W.n && s.step === 'ideas' && s.i ? Number(s.i) - 1 : null);
      if (want == null) want = 0;
    }
    show(want);
  }
  update(r);

  return {
    update: update,
    paint: function () { paintMarks(); },
    onTier: applyTier,
    onKey: function (e) {
      if (!cards.length) return;
      if (e.target && e.target.closest && e.target.closest('.fu-seg, [role="radiogroup"], [role="tablist"], details')) return;
      var k = e.key;
      if (k === 'ArrowLeft') { e.preventDefault(); go(deck.i - 1, true); }
      else if (k === 'ArrowRight') { e.preventDefault(); go(deck.i + 1, true); }
      else if (k === 'g' || k === 'G') { e.preventDefault(); grade('got'); }
      else if (k === 's' || k === 'S') { e.preventDefault(); grade('shaky'); }
    }
  };
}

/* horizontal swipes on touch and pen; vertical scrolling stays the browser's */
function swipe(el, cb) {
  var x0 = null, y0 = 0, id = null;
  el.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' || !e.isPrimary) return;
    if (e.target.closest && e.target.closest('a, button, input, summary')) return;
    x0 = e.clientX; y0 = e.clientY; id = e.pointerId;
  });
  function end(e) {
    if (x0 == null || e.pointerId !== id) return;
    var dx = e.clientX - x0, dy = e.clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 56 && Math.abs(dx) > 1.4 * Math.abs(dy)) cb(dx < 0 ? 1 : -1);
  }
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', function () { x0 = null; });
}

/* ------------------------------------------------------------------ play */

function playCard(W, key, href, ic, kicker, t, s, ext) {
  var tick = h('span', { 'class': 'fu-tick', 'aria-hidden': 'true' });
  var a = h('a', {
    'class': 'wk-play fu-card fu-card--lift', href: href, 'data-key': key,
    onclick: function () { edit(W.n, function (w) { w.p[key] = Date.now(); }, 'play'); }
  }, [
    h('span', { 'class': 'wk-play-ic' }, icon(ic)),
    h('span', { 'class': 'wk-play-main' }, [
      h('span', { 'class': 'fu-label wk-play-k', text: kicker }),
      h('span', { 'class': 'wk-play-t', text: t }),
      s ? h('span', { 'class': 'fu-small wk-play-s', text: s }) : null,
      ext ? h('span', { 'class': 'fu-small wk-play-x', text: ext }) : null
    ]),
    tick
  ]);
  return { a: a, tick: tick, key: key };
}

function buildPlay(F) {
  var W = F.W, st = F.st, all = [];
  var grid = h('div', { 'class': 'wk-plays' });
  (st.demos || []).forEach(function (d) {
    var c = playCard(W, 'demo:' + d.slug, d.hash, 'dial', 'Demo', d.title, d.blurb);
    all.push(c); grid.appendChild(c.a);
  });
  (st.objects || []).forEach(function (o) {
    var c = playCard(W, 'obj:' + o.id, viewHref(o.path), 'cube', '3D object', o.title, o.sub);
    all.push(c); grid.appendChild(c.a);
  });
  var byId = {};
  (W.missions || []).forEach(function (m) { byId[m.id] = m; });
  (st.missions || []).forEach(function (id) {
    var m = byId[id];
    if (!m) return;
    var c = playCard(W, 'mis:' + m.id, m.href, 'flask', 'Lab mission', m.title, m.why, (m.steps ? plural(m.steps, 'step') + ' · ' : '') + 'opens the Lab');
    all.push(c); grid.appendChild(c.a);
  });
  F.body.appendChild(grid);
  F.body.appendChild(h('p', { 'class': 'fu-small wk-hint', text: 'One is plenty. Demos and 3D open here; Lab missions open the Lab in this window.' }));
  return {
    paint: function () {
      var p = part(peek(W.n), 'p');
      all.forEach(function (c) { var on = !!p[c.key]; c.tick.className = 'fu-tick' + (on ? ' is-on' : ''); c.a.setAttribute('data-seen', on ? '1' : '0'); });
    }
  };
}

/* -------------------------------------------------------------------- do */

function buildDo(F) {
  var W = F.W, st = F.st, rows = [];
  var note = h('div', { 'class': 'fu-note wk-oldplan', hidden: true }, [
    'Your plan ticks are in the old week order. Open the plan once and they move across; then they tick here too. ',
    h('a', { 'class': 'app-a', href: '#plan/week-' + W.n, text: 'Open the plan' })
  ]);
  F.body.appendChild(note);

  function list(items, head) {
    if (!items || !items.length) return;
    F.body.appendChild(sub(head));
    var ul = h('ul', { 'class': 'wk-ticks' });
    items.forEach(function (x) {
      var cb = h('input', { type: 'checkbox', 'class': 'wk-cb', 'data-k': x.k, id: 'wk-cb-' + x.k });
      var row = h('li', { 'class': 'wk-tickrow' }, h('label', { 'class': 'wk-tickl', 'for': 'wk-cb-' + x.k }, [
        cb, h('span', { 'class': 'fu-tick wk-cbbox', 'aria-hidden': 'true' }), h('span', { 'class': 'wk-tickt', html: x.t })
      ]));
      cb.addEventListener('change', function () {
        var ok = setTick(x.k, cb.checked);
        if (!ok) {
          cb.checked = !cb.checked;
          note.hidden = false;
          if (APP.toast) APP.toast('that tick waits for the plan. open it once and your ticks move across.');
        }
        edit(W.n, function () {}, 'do');
        paint();
        if (F.paintStep) F.paintStep();
      });
      rows.push({ cb: cb, k: x.k, li: row });
      ul.appendChild(row);
    });
    F.body.appendChild(ul);
  }
  var proj = W.n >= 12;
  list(st.pre, proj ? 'Before the day' : 'Before Saturday');
  list(st.ex, st.lead || (proj ? 'On the day' : 'Exercises to attempt'));

  if (st.skip) F.body.appendChild(h('div', { 'class': 'wk-skip fu-card fu-card--well' }, [
    h('span', { 'class': 'fu-label', text: 'Skip it guilt-free' }),
    h('p', { 'class': 'wk-skip-t', html: st.skip })
  ]));

  if ((st.parts || []).length) {
    F.body.appendChild(sub('In the capstone pack'));
    var pl = h('ul', { 'class': 'wk-links' });
    st.parts.forEach(function (p) { pl.appendChild(h('li', null, h('a', { 'class': 'fu-item wk-link', href: p.hash }, [icon('book'), h('span', { text: p.label }), icon('arrow', 'wk-go-ic')]))); });
    F.body.appendChild(pl);
  }

  if ((st.exercise || []).length) {
    F.body.appendChild(sub('Ideas behind the exercises'));
    var ex = h('ul', { 'class': 'wk-links' });
    st.exercise.forEach(function (c) {
      ex.appendChild(h('li', { 'class': 'fu-item wk-exi' }, [
        h('span', { 'class': 'wk-libi-main' }, [h('b', { text: c.label }), h('span', { 'class': 'fu-small', text: c.title })]),
        h('span', { 'class': 'wk-libi-doors' }, [
          c.film ? h('a', { 'class': 'fu-iconbtn', href: viewHref(c.film), 'aria-label': 'Film: ' + c.label, title: 'Film' }, icon('play')) : null,
          c.object ? h('a', { 'class': 'fu-iconbtn', href: viewHref(c.object), 'aria-label': '3D: ' + c.label, title: '3D' }, icon('cube')) : null
        ])
      ]));
    });
    F.body.appendChild(ex);
  }

  if ((st.packs || []).length) F.body.appendChild(h('div', { 'class': 'wk-actions' }, st.packs.map(function (p) {
    return h('a', { 'class': 'fu-btn', href: p.hash }, [icon('book'), (st.packs.length > 1 ? 'Open ' + p.title : 'Open the pack')]);
  })));

  function paint() {
    var p = planRead();
    var t = p.state === 'tara' ? p.data : {};
    note.hidden = p.state !== 'old';
    rows.forEach(function (r) {
      var on = !!t[r.k];
      r.cb.checked = on;
      r.li.setAttribute('data-on', on ? '1' : '0');
      var box = r.li.querySelector('.wk-cbbox');
      if (box) box.className = 'fu-tick wk-cbbox' + (on ? ' is-on' : '');
    });
  }
  return { paint: paint };
}

/* ----------------------------------------------------------------- check */

var BANKS = Object.create(null);   // slug -> Promise<bank|null>
function bank(slug) {
  if (!BANKS[slug]) {
    BANKS[slug] = Promise.resolve().then(function () {
      if (!APP.payloadJSON) throw new Error('no payloads');
      return APP.payloadJSON('bank:' + slug);
    }).catch(function (e) { console.warn('weeks: bank ' + slug + ' failed', e); delete BANKS[slug]; return null; });
  }
  return BANKS[slug];
}

/* the quiz engine's own reading of a number: commas, the unicode minus, 2x10^3 */
function parseNumber(str) {
  if (str == null) return NaN;
  var s = String(str).trim().replace(/,/g, '').replace(/−/g, '-').replace(/\s+/g, '');
  if (!s) return NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
    var m = s.match(/^([+-]?(?:\d+\.?\d*|\.\d+))(?:[x*×]10\^([+-]?\d+))$/i);
    if (m) return Number(m[1]) * Math.pow(10, Number(m[2]));
    return NaN;
  }
  return Number(s);
}

/* a number said back: "24", "22,500 elements", "10×", "1 token", "$57.6". The unit follows
   only when it reads as a count of things; a setting's label ("layer index", "fraction of
   ||h||", "trait score", "hour (24h clock)") stays on the input and out of the sentence. */
function numberSaid(v, unit) {
  var n = Number(v);
  var s = isFinite(n) && Math.floor(n) === n && Math.abs(n) >= 10000 ? String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : String(Math.abs(n));
  if (!isFinite(n)) s = String(v);
  else if (n < 0) s = '−' + s;
  var u = String(unit || '').trim();
  if (!u) return s;
  if (u === '%' || /^percent\b/i.test(u)) return s + '%';
  if (/^(x|×|times)$/i.test(u)) return s + '×';
  if (/^(usd|dollars?|\$)$/i.test(u)) return '$' + s;
  if (/[|()^]|\b(index|offset|fraction|proportion|ratio|rate|score|similarity|clock|value|probability)\b/i.test(u)) return s;
  if (Math.abs(n) === 1) {
    var w = u.split(' '), at = w.indexOf('per') > 0 ? w.indexOf('per') - 1 : w.length - 1;
    w[at] = w[at].replace(/sses$/, 'ss').replace(/([^aeiou])ies$/, '$1y').replace(/([^s])s$/, '$1');
    u = w.join(' ');
  }
  return s + ' ' + u;
}

function prepQ(q, slug) {
  var stems = [q.stem].concat(Array.isArray(q.variants) ? q.variants : []).filter(Boolean);
  var o = { q: q, slug: slug, id: q.id, type: q.type, stem: stems[Math.floor(Math.random() * stems.length)] || q.stem || '' };
  if (q.type === 'mcq') {
    o.options = shuffle((q.options || []).map(function (x, i) {
      return { id: x && x.id != null ? String(x.id) : 'o' + i, text: x && x.text != null ? String(x.text) : String(x), correct: !!(x && x.correct), why: (x && x.why) || '' };
    }));
    o.multi = o.options.filter(function (x) { return x.correct; }).length > 1;
    o.map = {};
    o.options.forEach(function (x, i) { if (/^[a-h]$/i.test(x.id)) o.map[x.id.toLowerCase()] = LETTERS[i]; });
  } else if (q.type === 'numeric') {
    o.answer = Number(q.answer);
    o.tol = q.tolerance == null ? 1e-9 : Math.abs(Number(q.tolerance));
    o.unit = q.unit || '';
  } else if (q.type === 'ordering') {
    o.items = (q.items || []).map(String);
    var order = o.items.map(function (x, i) { return i; }), tries = 0;
    do { order = shuffle(order); } while (o.items.length > 1 && tries++ < 8 && order.every(function (v, i) { return v === i; }));
    o.shown = order;                 // shown[k] = index into items (the right order)
  }
  return o;
}

/* explanations name options by their letter in the bank ("Option (c) is tempting"); the
   options are shown shuffled, so point those references at the letters on screen.
   Only "Option(s) x" and a free-standing "(x)" are touched, never f(a) or T(s,a). */
function relabel(html, map) {
  if (!html || !map) return html;
  return String(html)
    .replace(/\b(Options?|options?)(\s+)([a-h])\b/g, function (m, w, sp, x) { return map[x] ? w + sp + map[x] : m; })
    .replace(/(^|[^\w)\]`'’])\(([a-h])\)/g, function (m, pre, x) { return map[x] ? pre + '(' + map[x] + ')' : m; });
}

function buildCheck(F) {
  var W = F.W, st = F.st;
  var slugs = Object.keys(st.pool || {});
  var box = h('div', { 'class': 'wk-check', 'aria-live': 'off' });
  F.body.appendChild(box);
  var S = { byId: null, round: null, at: 0, results: [], sent: [], done: false };

  box.appendChild(h('div', { 'class': 'fu-loading wk-wait', role: 'status' }, [
    h('span', { 'class': 'fu-loading__lamp', 'aria-hidden': 'true' }),
    h('p', { 'class': 'fu-loading__line', text: 'setting out the cards...' })
  ]));

  Promise.all(slugs.map(function (slug) { return bank(slug).then(function (b) { return [slug, b]; }); })).then(function (pairs) {
    var byId = Object.create(null), n = 0;
    pairs.forEach(function (p) {
      var qs = (p[1] && p[1].questions) || [];
      qs.forEach(function (q) { if (q && q.id && !byId[q.id] && (q.type === 'mcq' || q.type === 'numeric' || q.type === 'ordering')) { byId[q.id] = { q: q, slug: p[0] }; n++; } });
    });
    if (!document.contains(box)) return;
    if (!n) { clear(box); box.appendChild(h('div', { 'class': 'fu-oops', role: 'alert' }, [
      h('p', { 'class': 'fu-oops__line', text: 'that fumbled. nothing is lost; try again.' }),
      h('button', { type: 'button', 'class': 'fu-btn', text: 'Try again', onclick: function () { V.key = null; rerender(true); } })
    ])); return; }
    S.byId = byId;
    newRound();
  });

  function draw() {
    var w = peek(W.n), k = part(w, 'k');
    var asked = Array.isArray(k.a) ? k.a : [];
    var poolIds = [];
    slugs.forEach(function (s) { (st.pool[s] || []).forEach(function (id) { if (S.byId[id] && poolIds.indexOf(id) < 0) poolIds.push(id); }); });
    var firstEver = !(Number(k.r) > 0) && !asked.length;
    /* at most one question in six that is not multiple choice (a number or an order) */
    var pick = [], odd = 0, concepts = {};
    function isOdd(id) { return S.byId[id].q.type !== 'mcq'; }
    function take(id) {
      if (pick.length >= 6 || pick.indexOf(id) >= 0 || (isOdd(id) && odd >= 1)) return;
      pick.push(id); concepts[S.byId[id].q.concept] = 1;
      if (isOdd(id)) odd++;
    }
    if (firstEver) (st.six || []).forEach(function (id) { if (S.byId[id]) take(id); });
    if (pick.length < 6) {
      var fresh = poolIds.filter(function (id) { return asked.indexOf(id) < 0 && pick.indexOf(id) < 0; });
      if (fresh.length < 6 - pick.length) {
        fresh = poolIds.filter(function (id) { return pick.indexOf(id) < 0; });
        edit(W.n, function (w2) { w2.k.a = []; }, 'check');   // the pool is through once: start it over
      }
      fresh = shuffle(fresh);
      fresh.forEach(function (id) { if (!concepts[S.byId[id].q.concept]) take(id); });
      fresh.forEach(take);
    }
    if (!pick.length) shuffle(poolIds).forEach(take);
    return shuffle(pick).map(function (id) { return prepQ(S.byId[id].q, S.byId[id].slug); });
  }

  function newRound() {
    S.round = draw();
    S.at = 0;
    S.results = [];
    S.sent = [];
    S.done = false;
    renderQ();
  }

  /* the dots say where you are in the six, never how it went */
  var dotsEl = null;
  function dotsRow() {
    dotsEl = h('div', { 'class': 'wk-qdots', 'aria-hidden': 'true' });
    S.round.forEach(function (x, i) {
      dotsEl.appendChild(h('i', { 'class': 'wk-dot' + (S.results[i] != null ? ' is-done' : '') + (i === S.at && !S.done ? ' is-here' : '') }));
    });
    return dotsEl;
  }

  function renderQ() {
    clear(box);
    var Q = S.round[S.at];
    if (!Q) return finish();
    var head = h('div', { 'class': 'wk-qhead' }, [
      h('span', { 'class': 'fu-label', text: 'Question ' + (S.at + 1) + ' of ' + S.round.length }),
      dotsRow()
    ]);
    var qcard = h('section', { 'class': 'wk-q fu-card', 'aria-label': 'Question ' + (S.at + 1) + ' of ' + S.round.length, 'data-type': Q.type });
    qcard.appendChild(h('p', { 'class': 'wk-qstem', html: Q.stem }));
    var answer = h('div', { 'class': 'wk-qa' });
    var after = h('div', { 'class': 'wk-qafter', hidden: true, tabindex: '-1' });
    qcard.appendChild(answer);
    qcard.appendChild(after);
    box.appendChild(head);
    box.appendChild(qcard);
    S.cur = { Q: Q, card: qcard, answer: answer, after: after, answered: false };
    if (Q.type === 'mcq') renderMcq(S.cur);
    else if (Q.type === 'numeric') renderNum(S.cur);
    else renderOrder(S.cur);
  }

  function renderMcq(C) {
    var Q = C.Q, picked = {};
    var ul = h('div', { 'class': 'wk-opts', role: 'group', 'aria-label': Q.multi ? 'Pick every answer that fits' : 'Pick one' });
    C.opts = Q.options.map(function (o, i) {
      var b = h('button', { type: 'button', 'class': 'wk-opt', 'data-i': i, 'aria-pressed': Q.multi ? 'false' : null }, [
        h('span', { 'class': 'wk-opt-l', 'aria-hidden': 'true', text: LETTERS[i] }),
        h('span', { 'class': 'wk-opt-t', html: o.text })
      ]);
      b.setAttribute('aria-label', LETTERS[i] + ': ' + textOf(o.text));
      b.addEventListener('click', function () {
        if (C.answered) return;
        if (Q.multi) { picked[i] = !picked[i]; b.setAttribute('aria-pressed', picked[i] ? 'true' : 'false'); return; }
        picked = {}; picked[i] = true;
        gradeMcq(C, picked);
      });
      ul.appendChild(b);
      return b;
    });
    C.answer.appendChild(ul);
    if (Q.multi) {
      var chk = h('button', { type: 'button', 'class': 'fu-btn wk-qcheck', text: 'Check' });
      chk.addEventListener('click', function () { if (!C.answered) gradeMcq(C, picked); });
      C.answer.appendChild(h('p', { 'class': 'fu-small wk-qhint', text: 'More than one fits. Pick them all, then Check.' }));
      C.answer.appendChild(chk);
    } else {
      C.answer.appendChild(h('p', { 'class': 'fu-small wk-qhint', text: 'Tap one, or press A to ' + LETTERS[Q.options.length - 1] + '.' }));
    }
    C.pick = function (i) {
      var b = C.opts[i];
      if (b) b.click();
    };
  }

  function gradeMcq(C, picked) {
    var Q = C.Q, ok = true, right = [];
    Q.options.forEach(function (o, i) {
      if (o.correct) right.push(LETTERS[i]);
      if (!!picked[i] !== o.correct) ok = false;
    });
    C.opts.forEach(function (b, i) {
      var o = Q.options[i];
      b.disabled = true;
      if (o.correct) b.setAttribute('data-mark', 'answer');
      else if (picked[i]) b.setAttribute('data-mark', 'picked');
      if (picked[i]) b.appendChild(h('span', { 'class': 'fu-badge fu-badge--quiet wk-opt-b', text: 'your pick' }));
      else if (o.correct && !ok) b.appendChild(h('span', { 'class': 'fu-badge fu-badge--quiet wk-opt-b', text: 'the answer' }));
    });
    var why = '';
    Q.options.forEach(function (o, i) { if (picked[i] && !o.correct && o.why) why = o.why; });
    settle(C, ok, ok ? '' : 'the answer was ' + right.join(' and '), why);
  }

  function renderNum(C) {
    var Q = C.Q;
    var inp = h('input', { 'class': 'fu-input wk-num', type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Your answer' + (Q.unit ? ' in ' + Q.unit : '') });
    var chk = h('button', { type: 'button', 'class': 'fu-btn wk-qcheck', text: 'Check' });
    C.answer.appendChild(h('div', { 'class': 'wk-numrow' }, [inp, Q.unit ? h('span', { 'class': 'fu-small wk-unit', text: Q.unit }) : null, chk]));
    C.answer.appendChild(h('p', { 'class': 'fu-small wk-qhint', text: 'A number is enough. 2e-3 and 2x10^-3 both work.' }));
    function go() {
      if (C.answered) return;
      var v = parseNumber(inp.value);
      if (isNaN(v)) { inp.setAttribute('aria-invalid', 'true'); inp.focus(); return; }
      inp.removeAttribute('aria-invalid');
      var ok = Math.abs(v - Q.answer) <= Q.tol;
      inp.disabled = true; chk.disabled = true;
      inp.setAttribute('data-mark', ok ? 'answer' : 'picked');
      settle(C, ok, ok ? '' : 'the answer was ' + numberSaid(Q.answer, Q.unit) + (Q.tol > 1e-6 ? ' (within ±' + numberSaid(Q.tol) + ')' : ''), '');
    }
    chk.addEventListener('click', go);
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    setTimeout(function () { try { inp.focus({ preventScroll: true }); } catch (e) {} }, 0);
  }

  /* tap to order: items keep their places; each tap gives the next number, a tap on
     a numbered item takes its number back */
  function renderOrder(C) {
    var Q = C.Q, nums = Q.shown.map(function () { return 0; }), nextN = 1;
    var list = h('div', { 'class': 'wk-ord', role: 'group', 'aria-label': 'Tap the steps in order' });
    var chk = h('button', { type: 'button', 'class': 'fu-btn wk-qcheck', text: 'Check', disabled: true });
    var reset = h('button', { type: 'button', 'class': 'fu-btn fu-btn--ghost wk-qclear', text: 'Clear' });
    C.items = Q.shown.map(function (ix, k) {
      var num = h('span', { 'class': 'wk-ord-n', 'aria-hidden': 'true' });
      var b = h('button', { type: 'button', 'class': 'wk-opt wk-ord-i' }, [num, h('span', { 'class': 'wk-opt-t', html: Q.items[ix] })]);
      b.addEventListener('click', function () {
        if (C.answered) return;
        if (nums[k]) { var gone = nums[k]; nums = nums.map(function (v) { return v > gone ? v - 1 : (v === gone ? 0 : v); }); }
        else nums[k] = nextN;
        nextN = Math.max.apply(null, nums) + 1;
        paintOrd();
      });
      list.appendChild(b);
      return { b: b, num: num, ix: ix };
    });
    function paintOrd() {
      C.items.forEach(function (it, k) {
        it.num.textContent = nums[k] ? String(nums[k]) : '';
        it.b.setAttribute('data-n', nums[k] ? '1' : '0');
        it.b.setAttribute('aria-label', (nums[k] ? 'Number ' + nums[k] + ': ' : 'Not placed: ') + textOf(Q.items[it.ix]));
      });
      chk.disabled = nums.some(function (v) { return !v; });
    }
    reset.addEventListener('click', function () { if (C.answered) return; nums = nums.map(function () { return 0; }); nextN = 1; paintOrd(); });
    chk.addEventListener('click', function () {
      if (C.answered || chk.disabled) return;
      var ok = C.items.every(function (it, k) { return nums[k] === it.ix + 1; });
      C.items.forEach(function (it, k) { it.b.disabled = true; it.b.setAttribute('data-mark', nums[k] === it.ix + 1 ? 'answer' : 'picked'); });
      chk.disabled = true; reset.disabled = true;
      var extra = null;
      if (!ok) extra = h('ol', { 'class': 'wk-ordright' }, Q.items.map(function (t) { return h('li', { html: t }); }));
      settle(C, ok, ok ? '' : 'here is the order', '', extra);
    });
    C.answer.appendChild(h('p', { 'class': 'fu-small wk-qhint', text: 'Tap them in order, first to last. Tap again to take a number back.' }));
    C.answer.appendChild(list);
    C.answer.appendChild(h('div', { 'class': 'wk-qbtns' }, [chk, reset]));
    paintOrd();
  }

  function settle(C, ok, missLine, why, extra) {
    C.answered = true;
    var Q = C.Q;
    S.results[S.at] = ok;
    edit(W.n, function (w) {
      var a = Array.isArray(w.k.a) ? w.k.a : [];
      if (a.indexOf(Q.id) < 0) a.push(Q.id);
      w.k.a = a;
    }, 'check');
    var line;
    if (ok) line = 'got it.';
    else {
      var it = toRecall({ kind: 'question', id: Q.id, bank: Q.slug, concept: Q.q.concept, week: W.n, title: 'Week ' + W.n + ' check', text: textOf(Q.stem), hash: '#drill/' + Q.slug },
        textOf(Q.stem), { title: 'Week ' + W.n + ' check', hash: '#drill/' + Q.slug });
      S.sent.push(it);
      line = 'almost. ' + missLine + '; ' + comesBack(it) + '.';
    }
    C.card.setAttribute('data-result', ok ? 'got' : 'revisit');
    clear(C.after);
    C.after.appendChild(h('p', { 'class': 'fu-voice wk-qline', text: line }));
    if (extra) C.after.appendChild(extra);
    if (why) C.after.appendChild(h('p', { 'class': 'wk-qwhy', html: relabel(why, Q.map) }));
    if (Q.q.explanation) C.after.appendChild(h('p', { 'class': 'wk-qexp', html: relabel(Q.q.explanation, Q.map) }));
    var last = S.at >= S.round.length - 1;
    var nb = h('button', { type: 'button', 'class': 'fu-btn wk-qnext', text: last ? 'See how it went' : 'Next question' });
    nb.addEventListener('click', function () { S.at++; renderQ(); scrollToBox(); });
    C.after.appendChild(nb);
    C.after.hidden = false;
    C.next = nb;
    var d = dotsEl && dotsEl.children[S.at];
    if (d) d.className = 'wk-dot is-done is-here';
    try { nb.focus({ preventScroll: true }); } catch (e) {}
    var sec = sectionEl();
    if (sec) {
      var rb = C.after.getBoundingClientRect(), rs = sec.getBoundingClientRect();
      if (rb.bottom > rs.bottom) sec.scrollTop += Math.min(rb.top - rs.top - 80, rb.bottom - rs.bottom + 16);
    }
  }

  function scrollToBox() {
    var sec = sectionEl();
    if (!sec) return;
    var top = box.getBoundingClientRect().top - sec.getBoundingClientRect().top;
    if (top < 0) sec.scrollTop += top - 8;
  }

  /* the end of a round says where the misses went, never a tally of what was right */
  function finish() {
    S.done = true;
    clear(box);
    edit(W.n, function (w) { w.k.r = (Number(w.k.r) || 0) + 1; }, 'check');
    if (F.paintStep) F.paintStep();
    var again = h('button', { type: 'button', 'class': 'fu-btn', text: 'Another six' });
    again.addEventListener('click', function () { newRound(); scrollToBox(); });
    box.appendChild(h('section', { 'class': 'wk-qend fu-card', 'aria-live': 'polite' }, [
      h('div', { 'class': 'wk-qhead' }, [h('span', { 'class': 'fu-label', text: 'Round done' })]),
      h('h2', { 'class': 'fu-h2 wk-qend-t', text: sentLine(S.sent) }),
      h('p', { 'class': 'fu-voice', text: S.sent.length ? 'a miss is a card worth keeping. another six whenever you like.' : 'it keeps better with a little air. another six whenever you like.' }),
      h('div', { 'class': 'wk-qbtns' }, [again, st.drill ? h('a', { 'class': 'fu-btn fu-btn--ghost', href: st.drill, text: 'The full drill' }) : null])
    ]));
    try { again.focus({ preventScroll: true }); } catch (e) {}
  }

  return {
    onKey: function (e) {
      var C = S.cur;
      if (!C || S.done) return;
      var k = String(e.key || '');
      if (!C.answered && C.Q.type === 'mcq' && /^[a-h]$/i.test(k)) {
        var i = LETTERS.indexOf(k.toUpperCase());
        if (i < C.Q.options.length) { e.preventDefault(); C.pick(i); }
      } else if (C.answered && k === 'Enter' && C.next && !(e.target && e.target.closest && e.target.closest('a, button'))) {
        e.preventDefault(); C.next.click();
      }
    }
  };
}

/* ----------------------------------------------------------------- ready */

function buildReady(F) {
  var W = F.W, st = F.st;
  if (st.checkpoint) F.body.appendChild(h('div', { 'class': 'fu-note wk-checkpoint' }, [
    h('span', { 'class': 'fu-label', text: 'By the end of Saturday' }), h('p', { html: st.checkpoint })
  ]));
  if ((st.three || []).length) {
    F.body.appendChild(sub(st.threeLabel || 'Three things to have solid'));
    F.body.appendChild(h('ol', { 'class': 'wk-three' }, st.three.map(function (t, i) {
      return h('li', { 'class': 'wk-three-i fu-card fu-card--flat' }, [h('span', { 'class': 'wk-three-n', 'aria-hidden': 'true', text: String(i + 1) }), h('p', { html: t })]);
    })));
  }
  if ((st.anchors || []).length) {
    F.body.appendChild(sub('In the pack'));
    var ul = h('ul', { 'class': 'wk-links' });
    st.anchors.forEach(function (a) {
      ul.appendChild(h('li', null, h('a', { 'class': 'fu-item wk-link', href: a.hash }, [
        icon('book'), h('span', { 'class': 'wk-link-t' }, [h('b', { text: a.label }), a.pack ? h('span', { 'class': 'fu-small', text: a.pack }) : null]), icon('arrow', 'wk-go-ic')
      ])));
    });
    F.body.appendChild(ul);
  }
  F.body.appendChild(h('div', { 'class': 'wk-actions' }, [
    h('a', { 'class': 'fu-btn', href: st.plan || '#plan/week-' + W.n }, [icon('book'), 'Your plan row for week ' + W.n])
  ]));
  return {};
}

/* ---------------------------------------------------------------- runway */

function buildRunway(F) {
  var W = F.W;
  var line = h('p', { 'class': 'fu-voice wk-runway-v' });
  var nextRow = h('div', { 'class': 'wk-runway-next' });
  F.body.appendChild(h('div', { 'class': 'wk-runway fu-card fu-ch-project' }, [
    line, nextRow,
    h('div', { 'class': 'wk-actions' }, [h('a', { 'class': 'fu-btn', href: F.st.link || '#lab' }, [icon('flask'), 'Open the capstone runway'])])
  ]));
  function paint() {
    var cs = safeCall(function () { return APP.capstone && APP.capstone.summary ? APP.capstone.summary() : null; }, null);
    var t = todayISO();
    var dF = cs && cs.daysToFreeze != null ? cs.daysToFreeze : dayDiff(t, '2026-12-05');
    var dT = cs && cs.daysToTalk != null ? cs.daysToTalk : dayDiff(t, '2026-12-12');
    if (dT < 0) line.textContent = 'the talk is given. well done.';
    else if (dF < 0) line.textContent = (dT === 0 ? 'the talk is today.' : 'results are frozen; the talk is ' + when(dT) + '.') + ' one small thing today is plenty.';
    else line.textContent = (dF === 0 ? 'the freeze is today, 6pm.' : plural(dF, 'day') + ' to the freeze.') + ' one small thing today is plenty.';
    clear(nextRow);
    if (cs && cs.next && cs.next.title) {
      nextRow.appendChild(h('a', { 'class': 'fu-item wk-link', href: cs.next.hash || '#lab' }, [
        h('span', { 'class': 'wk-link-t' }, [h('b', { text: cs.next.title }), cs.next.date ? h('span', { 'class': 'fu-small', text: prettyDate(cs.next.date) }) : null]),
        icon('arrow', 'wk-go-ic')
      ]));
    }
  }
  paint();
  return { paint: paint };
}

var BUILD = { watch: buildWatch, ideas: buildIdeas, play: buildPlay, 'do': buildDo, check: buildCheck, ready: buildReady, runway: buildRunway };

/* ================================================================ search */

function search(q) {
  if (!DATA) return [];
  var score = typeof APP.score === 'function' ? APP.score : function (qq, rec) {
    qq = String(qq || '').toLowerCase().trim();
    return qq && String(rec.title || '').toLowerCase().indexOf(qq) >= 0 ? 40 : 0;
  };
  var rows = [];
  DATA.weeks.forEach(function (W) {
    var s = score(q, { id: 'w' + W.n, title: 'Week ' + W.n + ' ' + (W.short || ''), body: W.title + ' ' + W.chapter + ' ' + (W.arena || '') });
    if (s) rows.push({ title: 'Week ' + W.n + ' · ' + (W.short || W.title), sub: 'Weeks · ' + prettyDate(W.saturday) + ' · ' + W.chapter, hash: '#weeks/' + W.n, score: s });
    var ist = stepOf(W, 'ideas');
    if (!ist) return;
    ['cards', 'library', 'background'].forEach(function (list) {
      (ist[list] || []).forEach(function (c, i) {
        var sc = score(q, { id: c.id, title: c.label, body: c.title });
        if (!sc) return;
        rows.push({
          title: c.label, sub: 'Week ' + W.n + (list === 'cards' ? ' idea card' : list === 'library' ? ' library call' : ' background') + ' · ' + c.title,
          hash: '#weeks/' + W.n + '/ideas' + (list === 'cards' ? '/' + (i + 1) : ''), score: sc - (list === 'cards' ? 0 : 5)
        });
      });
    });
  });
  return rows;
}

/* ================================================================ wiring */

function onTier(n) { if (V.onTier) { try { V.onTier(n); } catch (e) { console.warn('weeks: onTier failed', e); } } }

document.addEventListener('keydown', function (e) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  if (!V.onKey || !onScreen()) return;
  var t = e.target, tag = t && t.tagName ? t.tagName.toLowerCase() : '';
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable)) return;
  if (document.querySelector('.app-panel:not([hidden])')) return;
  V.onKey(e);
});

/* the Lab tab writes the same ticks in this window */
window.addEventListener('tara:ticks', function (e) {
  if (e && e.detail && e.detail.source === 'weeks') return;
  repaint();
  fire(null, null);
});

/* other tabs (and the plan) write the same keys */
window.addEventListener('storage', function (e) {
  if (!e || (e.key !== KEY && e.key !== PLAN && e.key !== null)) return;
  _st = null;
  repaint();
  fire(null, null);
});
document.addEventListener('visibilitychange', function () { if (!document.hidden) repaint(); });

/* a film or 3D object opened anywhere (Today, the Library, a link in a pack) counts
   for the weeks that hold it */
window.addEventListener('tara:view', function (e) {
  var p = e && e.detail && e.detail.path;
  if (!p || !DATA) return;
  p = String(p).split('#')[0].split('?')[0];
  var hits = VIEW_AT[p];
  if (!hits) return;
  hits.forEach(function (x) {
    var already = x.kind === 'film' ? part(peek(x.n), 'f')[x.id] : part(peek(x.n), 'p')['obj:' + x.id];
    if (already) return;
    edit(x.n, function (w) { if (x.kind === 'film') w.f[x.id] = Date.now(); else w.p['obj:' + x.id] = Date.now(); }, x.kind === 'film' ? 'watch' : 'play');
  });
});

APP.registerSection({ id: 'weeks', title: 'Weeks', mount: mount, unmount: unmount, onTier: onTier, search: search });

/* start loading now; the first route waits for it briefly, so Today paints once */
load();
if (typeof APP.onBoot === 'function') APP.onBoot(function () {
  return Promise.race([ready, new Promise(function (res) { setTimeout(res, 1500); })]);
});
})();

/* ===== src/v2/recall.js ===== */
;(function(){
/* src/v2/recall.js — owner: recall.
 *
 * One spaced-repetition queue for the whole app (contract §Shared APIs).
 * It holds three kinds of item:
 *   question  a real drill question, rendered from its bank payload
 *   concept   "say it in one line" for a node of the intuition map
 *   sentence  a line saved from a page (V1's review queue)
 * and fills itself from V1's stores without ever writing them:
 *   tara.review             saved sentences            -> sentence items
 *   tara-quiz-mastery-v1    the drill's per-question record
 *                           (missed questions)          -> question items
 *                           (the drill's "what's shaky") -> concept items
 * plus whatever the week paths send through APP.recall.add().
 *
 * Schedule: rungs 1 -> 3 -> 7 -> 16 -> 35 -> 75 days. "solid" climbs a rung,
 * "shaky" holds the rung (due again after the same interval, at least
 * tomorrow), "blank" drops to the 1-day rung. Store: localStorage
 * "tara.v2.recall". Event: window "tara:recall" after every change.
 */
(function () {
  'use strict';

  var APP = (window.APP = window.APP || {});
  if (APP.recall && APP.recall.__v2) return;

  var KEY = 'tara.v2.recall';
  var K_REVIEW = 'tara.review';
  var K_MASTERY = 'tara-quiz-mastery-v1';
  var RUNGS = [1, 3, 7, 16, 35, 75];
  var SESSION_MAX = 7;
  var WARM_SIZE = 5;
  var IMPORT_PER_DAY = 7;          // a first import never floods one day
  var SHAKY_CONCEPTS = 6;          // the drill's "what's shaky" shows six
  var SECS = { question: 45, concept: 40, sentence: 20 };
  var GRADES = ['solid', 'shaky', 'blank'];
  var GRADE_WORD = { solid: 'Got it', shaky: 'Shaky', blank: 'Blank' };
  var TIER_NAME = { 1: 'Plain', 2: 'Generalist', 3: 'Expert' };

  /* Banks are content ids; the TARA weeks each serves come from the schedule.
     This table is only the fallback for before the schedule payload lands. */
  var BANK_WEEKS = {
    'week-01': [0], 'week-02': [1], 'week-03': [1], 'week-04': [1], 'week-05': [2],
    'week-06': [3], 'week-07': [3, 4], 'week-08': [4], 'week-09': [5], 'week-10': [6],
    'week-11': [7, 8, 9], 'alignment-science': [10, 11], 'capstone-weeks-12-14': [12, 13, 14]
  };
  var BANKS = Object.keys(BANK_WEEKS);
  var BANK_TOPIC = {
    'week-01': 'einops', 'week-02': 'resnets', 'week-03': 'optimisers', 'week-04': 'autograd',
    'week-05': 'transformer', 'week-06': 'hooks', 'week-07': 'circuits', 'week-08': 'saes',
    'week-09': 'dqn', 'week-10': 'ppo & rlhf', 'week-11': 'evals', 'alignment-science': 'alignment',
    'capstone-weeks-12-14': 'capstone'
  };
  /* Question ids carry their bank: w01-q001 ... w11-q078, ch4-q01, cap12-q01. */
  function bankOf(qid) {
    var p = String(qid || '').split('-')[0].toLowerCase(), m;
    if ((m = /^w(\d\d)$/.exec(p)) && BANK_WEEKS['week-' + m[1]]) return 'week-' + m[1];
    if (p === 'ch4') return 'alignment-science';
    if (/^cap\d+$/.test(p)) return 'capstone-weeks-12-14';
    return bankFromHistory(qid);
  }
  /* The engine's own per-bank history (tara.quiz.<slug>) is the second witness. */
  function bankFromHistory(qid) {
    for (var i = 0; i < BANKS.length; i++) {
      var h = readJSON('tara.quiz.' + BANKS[i], null);
      if (h && h.history && Object.prototype.hasOwnProperty.call(h.history, qid)) return BANKS[i];
    }
    return null;
  }
  function weeksOfBank(slug) {
    var ns = [];
    try { if (typeof APP.weeksOfPack === 'function' && APP.schedule && APP.schedule()) ns = APP.weeksOfPack(slug) || []; }
    catch (e) { ns = []; }
    return ns.length ? ns : (BANK_WEEKS[slug] || []);
  }
  function weekOfQuestion(slug, qid) {
    var m = /^cap(\d+)-/.exec(String(qid || ''));
    if (m && Number(m[1]) >= 12) return Number(m[1]);
    var ns = weeksOfBank(slug);
    return ns.length ? ns[ns.length - 1] : null;
  }

  /* ------------------------------------------------------------ storage -- */

  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function readJSON(k, fb) {
    var raw = lsGet(k);
    if (!raw) return fb;
    try { var v = JSON.parse(raw); return v == null ? fb : v; } catch (e) { return fb; }
  }

  /* ---------------------------------------------------------------- dates -- */

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function localISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function isISO(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  /* ?today=YYYY-MM-DD before the hash overrides the date everywhere (contract). */
  function todayISO() {
    try { var m = /[?&]today=(\d{4}-\d{2}-\d{2})(?:&|$)/.exec(location.search); if (m) return m[1]; } catch (e) {}
    try { if (typeof APP.todayISO === 'function') { var t = APP.todayISO(); if (isISO(t)) return t; } } catch (e) {}
    return localISO(new Date());
  }
  function utc(iso) { var p = iso.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function addDays(iso, n) {
    var d = new Date(utc(iso) + n * 864e5);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  function daysBetween(a, b) { return Math.round((utc(b) - utc(a)) / 864e5); }
  function isoOfMs(ms) { return ms ? localISO(new Date(Number(ms))) : null; }
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /* "today", "tomorrow", "Thu", "Thu 26 Nov" */
  function whenWord(iso, from) {
    var d = daysBetween(from || todayISO(), iso);
    if (d <= 0) return 'today';
    if (d === 1) return 'tomorrow';
    var dt = new Date(utc(iso));
    if (d < 7) return 'on ' + DOW[dt.getUTCDay()];
    return 'on ' + DOW[dt.getUTCDay()] + ' ' + dt.getUTCDate() + ' ' + MON[dt.getUTCMonth()];
  }
  function inDays(n) {
    if (n <= 1) return 'tomorrow';
    if (n < 14) return 'in ' + n + ' days';
    if (n < 60) return 'in ' + Math.round(n / 7) + ' weeks';
    return 'in ' + Math.round(n / 30) + ' months';
  }

  /* ---------------------------------------------------------------- store -- */

  var S = null, mem = null;

  function blank() {
    return { v: 1, items: {}, cursor: { review: 0, drill: 0, drillInit: 0, concepts: {} }, log: [] };
  }
  function store() {
    if (S) return S;
    var v = readJSON(KEY, null);
    if (!v || typeof v !== 'object' || !v.items || typeof v.items !== 'object') v = mem || blank();
    if (!v.cursor || typeof v.cursor !== 'object') v.cursor = blank().cursor;
    if (!v.cursor.concepts || typeof v.cursor.concepts !== 'object') v.cursor.concepts = {};
    if (!Array.isArray(v.log)) v.log = [];
    v.v = 1;
    S = v;
    return S;
  }
  function save(quiet) {
    mem = S;
    lsSet(KEY, JSON.stringify(S));
    if (!quiet) emit();
  }

  var emitT = 0;
  function emit() {
    if (emitT) return;
    emitT = setTimeout(function () {
      emitT = 0;
      var detail = { due: 0, total: 0 };
      try { detail.due = dueCount(); detail.total = activeCount(); } catch (e) {}
      try { window.dispatchEvent(new CustomEvent('tara:recall', { detail: detail })); } catch (e) {}
    }, 0);
  }

  function copy(it) {
    if (!it) return null;
    var o = {};
    for (var k in it) if (Object.prototype.hasOwnProperty.call(it, k)) o[k] = it[k];
    return o;
  }
  function active(it) { return !!it && !it.off && !it.gone; }
  function normText(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }

  var PFX = { question: 'q:', concept: 'c:', sentence: 's:' };
  function normKind(k) {
    k = String(k || '').toLowerCase();
    if (k === 'question' || k === 'check' || k === 'miss' || k === 'q') return 'question';
    if (k === 'concept' || k === 'idea' || k === 'card' || k === 'c') return 'concept';
    if (k === 'sentence' || k === 'line' || k === 'review' || k === 's') return 'sentence';
    return null;
  }
  function keyOf(kind, id) {
    id = String(id == null ? '' : id).trim();
    if (!id) return null;
    var p = PFX[kind];
    return id.indexOf(p) === 0 ? id : p + id;
  }
  function find(id) {
    var s = store();
    id = String(id == null ? '' : id);
    if (!id) return null;
    if (s.items[id]) return s.items[id];
    for (var k in PFX) if (s.items[PFX[k] + id]) return s.items[PFX[k] + id];
    return null;
  }
  function normGrade(g) {
    g = String(g || '').toLowerCase();
    if (g === 'solid' || g === 'got it' || g === 'got' || g === 'good') return 'solid';
    if (g === 'shaky' || g === 'hard') return 'shaky';
    if (g === 'blank' || g === 'again') return 'blank';
    return null;
  }
  function normWeek(w) {
    if (w == null || w === '') return null;
    var m = /(\d{1,2})/.exec(String(w));
    return m ? Number(m[1]) : null;
  }

  /* ------------------------------------------------------------- schedule -- */

  /* Days until the item is due again after grade g, from today. */
  function intervalFor(it, g) {
    var r = (it && it.rung) || 0;
    if (g === 'solid') return RUNGS[Math.min(r + 1, RUNGS.length - 1)];
    if (g === 'shaky') return Math.max(1, RUNGS[Math.min(r, RUNGS.length - 1)]);
    return RUNGS[0];
  }

  function gradeItem(id, g) {
    g = normGrade(g);
    var it = find(id);
    if (!g || !it) return null;
    var t = todayISO(), r = it.rung || 0;
    var days = intervalFor(it, g);
    if (g === 'solid') r = Math.min(r + 1, RUNGS.length - 1);
    else if (g === 'blank') { r = 0; it.lapses = (it.lapses || 0) + 1; }
    it.rung = r;
    it.due = addDays(t, days);
    it.last = t;
    it.grade = g;
    it.reps = (it.reps || 0) + 1;
    var s = store();
    s.log.push([t, it.id, g]);
    if (s.log.length > 400) s.log = s.log.slice(s.log.length - 400);
    save();
    return copy(it);
  }

  /* add(): new items start on the 1-day rung. Adding one that is already there
     means "this came up shaky again": back to the first rung, due no later
     than tomorrow. */
  function addItem(spec, opts) {
    if (!spec || typeof spec !== 'object') return null;
    opts = opts || {};
    var kind = normKind(spec.kind);
    if (!kind) return null;
    var ref = spec.id != null && spec.id !== '' ? String(spec.id) : '';
    if (!ref && kind === 'concept' && spec.concept) ref = String(spec.concept);
    if (!ref && kind === 'sentence' && spec.text) ref = 'h' + hashStr(normText(spec.text));
    var id = keyOf(kind, ref);
    if (!id) return null;
    var s = store(), t = todayISO();
    var due = opts.due || addDays(t, RUNGS[0]);
    var it = s.items[id];
    if (!it) {
      it = { id: id, ref: id.slice(2), kind: kind, src: spec.src || opts.src || 'app', added: t, due: due, rung: 0, reps: 0, lapses: 0 };
      s.items[id] = it;
    } else if (!opts.keep) {
      it.rung = 0;
      if (!it.due || it.due > due) it.due = due;
      if (!opts.import) it.off = false;
    }
    ['title', 'text', 'hash', 'concept', 'bank', 'url', 'ts', 'label'].forEach(function (f) {
      if (spec[f] != null && spec[f] !== '') it[f] = spec[f];
    });
    var wk = normWeek(spec.week);
    if (wk != null) it.week = wk;
    if (kind === 'question') {
      if (!it.bank) it.bank = bankOf(it.ref);
      if (it.week == null && it.bank) it.week = weekOfQuestion(it.bank, it.ref);
    }
    if (kind === 'concept' && !it.concept) it.concept = it.ref;
    if (!opts.batch) save(opts.quiet);
    return it;
  }

  /* --------------------------------------------------------------- import -- */

  /* Spread a batch over days: nothing before its natural day, at most
     IMPORT_PER_DAY on any day (counting what is already due there). */
  function placeBatch(batch) {
    if (!batch.length) return;
    var s = store(), t = todayISO(), load = {};
    for (var id in s.items) {
      var it = s.items[id];
      if (active(it) && it.due) { var d = it.due < t ? t : it.due; load[d] = (load[d] || 0) + 1; }
    }
    batch.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });   // freshest first
    batch.forEach(function (b) {
      var d = b.natural && b.natural > t ? b.natural : t;
      var guard = 0;
      while ((load[d] || 0) >= IMPORT_PER_DAY && guard++ < 400) d = addDays(d, 1);
      load[d] = (load[d] || 0) + 1;
      addItem(b.spec, { due: d, batch: true, import: true, src: b.spec.src });
    });
  }
  function naturalDay(ms) {
    var d = isoOfMs(ms);
    return d ? addDays(d, RUNGS[0]) : null;
  }

  /* V1's saved sentences. Cursor = the newest ts imported, so a re-import
     takes only what was saved since. Removing a line in V1 hides it here too
     (unless V1's 300-line cap could have trimmed it). */
  var PAGE_TITLES = [
    ['Einops and Ray Tracing', '#week-01'], ['Modules and ResNets', '#week-02'],
    ['Optimizers and Sweeps', '#week-03'], ['Your Own Autograd', '#week-04'],
    ['Transformer From Scratch', '#week-05'], ['Hooks and the Cache', '#week-06'],
    ['Induction Circuits and Patching', '#week-07'], ['Superposition and Sparse Autoencoders', '#week-08'],
    ['Value Functions and DQN', '#week-09'], ['Policy Gradients, PPO and RLHF', '#week-10'],
    ['Eval Design and Inspect', '#week-11'], ['Model Organisms and Open Problems', '#alignment-science'],
    ['Three Saturdays and a Talk', '#capstone-weeks-12-14'],
    ['Backprop Bench', '#demo/backprop-training'], ['Sliding Window Lab', '#demo/convolutions-cnn'],
    ['The Measurement Is Not the Property', '#demo/evals-pipeline'],
    ['Induction Circuit Workbench', '#demo/induction-heads-patching'],
    ['Reading the PPO Objective', '#demo/policy-gradients-ppo'], ['Residual Stream Bus', '#demo/residual-stream-bus'],
    ['Bellman to DQN', '#demo/rl-foundations-dqn'], ['The Overoptimisation Curve', '#demo/rlhf-overoptimisation'],
    ["Decoder's Bench", '#demo/sampling-decoding'], ['Persona Vector Bench', '#demo/steering-persona-vectors'],
    ['Superposition Bench', '#demo/superposition-sae'], ['Einops Bench', '#demo/tensors-einops'],
    ['Residual Stream Anatomy', '#demo/transformer-block']
  ];
  function viewHref(path) {
    try { if (typeof APP.viewHref === 'function') return APP.viewHref(path); } catch (e) {}
    return '#view/' + path;
  }
  /* Where a saved line came from, as something the shell can open. */
  function sourceOf(r) {
    var title = String((r && r.title) || '').trim();
    var url = String((r && r.url) || '');
    var out = { hash: null, href: null, label: title };
    try {
      if (url && !/^about:/i.test(url)) {
        var u = new URL(url, location.href);
        if (u.origin === location.origin) {
          var base = new URL('.', location.href).pathname;
          var p = u.pathname;
          var rel = p.indexOf(base) === 0 ? p.slice(base.length) : p.replace(/^\/+/, '');
          if (!rel || /^(index|next|classic)\.html$/.test(rel)) {
            if (u.hash && u.hash.length > 1) out.hash = u.hash;
          } else if (/^lab\//.test(rel)) {
            out.href = rel + u.search + u.hash;           // the Lab is never in the viewer
          } else if (/\.html$/.test(rel)) {
            out.hash = viewHref(rel + u.search + u.hash);
          }
        }
      }
    } catch (e) {}
    if (!out.hash && !out.href && title) {
      for (var i = 0; i < PAGE_TITLES.length; i++) {
        if (title.indexOf(PAGE_TITLES[i][0]) >= 0) { out.hash = PAGE_TITLES[i][1]; out.label = PAGE_TITLES[i][0]; break; }
      }
    }
    if (/^TARA\b/.test(out.label || '')) out.label = '';
    return out;
  }

  /* A saved line's week, read off its source: a pack or a demo hash. */
  function weekOfHash(hash) {
    var m = /^#([a-z0-9-]+)/.exec(String(hash || '')), slug = m && m[1];
    if (!slug) return null;
    if (BANK_WEEKS[slug]) { var ns = weeksOfBank(slug); return ns.length ? ns[ns.length - 1] : null; }
    var d = /^#demo\/([a-z0-9-]+)/.exec(hash);
    if (d) {
      try { if (typeof APP.weeksOfDemo === 'function') { var ws = APP.weeksOfDemo(d[1]) || []; if (ws.length) return ws[ws.length - 1]; } } catch (e) {}
    }
    return null;
  }

  function importReview() {
    var list = readJSON(K_REVIEW, []);
    if (!Array.isArray(list)) return [];
    var s = store(), c = s.cursor, cur = Number(c.review) || 0, max = cur, batch = [], live = {};
    var byText = {}, changed = false;
    for (var id in s.items) if (s.items[id].kind === 'sentence') byText[normText(s.items[id].text)] = true;
    list.forEach(function (r) {
      if (!r || typeof r.text !== 'string' || !r.text.trim()) return;
      var ts = Number(r.ts) || 0;
      if (ts) { live[ts] = true; if (ts > max) max = ts; }
      if (ts && ts <= cur) return;
      var nt = normText(r.text);
      var key = 's:' + (ts || 'h' + hashStr(nt));
      if (s.items[key] || byText[nt]) return;
      byText[nt] = true;
      var src = sourceOf(r);
      batch.push({
        at: ts, natural: naturalDay(ts),
        spec: { kind: 'sentence', id: key, text: r.text.replace(/\s+/g, ' ').trim(), title: src.label || '',
                hash: src.hash || src.href || '', url: r.url || '', ts: ts || undefined, src: 'review',
                week: weekOfHash(src.hash) }
      });
    });
    if (list.length < 300) {
      for (var k in s.items) {
        var it = s.items[k];
        if (it.kind !== 'sentence' || it.src !== 'review' || !it.ts) continue;
        var gone = !live[it.ts];
        if (!!it.gone !== gone) { it.gone = gone; changed = true; }
      }
    }
    if (max !== cur) { c.review = max; changed = true; }
    if (changed && !batch.length) save(true);
    return batch;
  }

  /* The drill's per-question record (quiz engine, tara-quiz-mastery-v1):
     { [qid]: { seen, correct, wrong, lastSeen, lastWrong, streak, ease } }.
     First import: every question whose latest answer was a miss (streak 0).
     After that: every question missed since the cursor (newest lastWrong). */
  function importDrill() {
    var m = readJSON(K_MASTERY, {});
    if (!m || typeof m !== 'object') return [];
    var s = store(), c = s.cursor, cur = Number(c.drill) || 0, first = !c.drillInit, max = cur, batch = [];
    Object.keys(m).forEach(function (qid) {
      var r = m[qid];
      if (!r || !(Number(r.wrong) > 0)) return;
      var lw = Number(r.lastWrong) || 0;
      if (lw > max) max = lw;
      var take = first ? (Number(r.streak) || 0) === 0 : lw > cur;
      if (!take) return;
      var bank = bankOf(qid);
      if (!bank) return;
      var key = 'q:' + qid;
      if (!first && s.items[key]) {
        /* missed again since we last looked: back to the first rung */
        addItem({ kind: 'question', id: key }, { due: maxISO(naturalDay(lw), todayISO()), batch: true, import: true });
        return;
      }
      if (s.items[key]) return;
      batch.push({ at: lw, natural: naturalDay(lw),
                   spec: { kind: 'question', id: key, bank: bank, week: weekOfQuestion(bank, qid), src: 'drill' } });
    });
    var changed = max !== cur || first;
    c.drill = max; c.drillInit = 1;
    if (changed && !batch.length) save(true);
    return batch;
  }
  function maxISO(a, b) { return !a ? b : !b ? a : (a > b ? a : b); }

  var synced = false;
  function syncNow() {
    var batch = importReview().concat(importDrill());
    if (batch.length) { placeBatch(batch); save(); }
    return batch.length;
  }
  function ensure() {
    if (synced) return;
    synced = true;
    try { syncNow(); } catch (e) { if (window.console) console.warn('recall import failed', e); }
  }

  /* ----------------------------------------------- payloads (banks, nodes) -- */

  var bankCache = {}, bankP = {}, QIDX = {}, CLABEL = {};
  function loadBank(slug) {
    if (bankCache[slug]) return Promise.resolve(bankCache[slug]);
    if (bankP[slug]) return bankP[slug];
    if (typeof APP.payloadJSON !== 'function') return Promise.resolve(null);
    bankP[slug] = Promise.resolve().then(function () { return APP.payloadJSON('bank:' + slug); }).then(function (b) {
      if (!b || !Array.isArray(b.questions)) return null;
      b.__byId = {};
      (b.concepts || []).forEach(function (c) { if (c && c.id && !CLABEL[c.id]) CLABEL[c.id] = c.label || c.id; });
      b.questions.forEach(function (q) { if (q && q.id) { b.__byId[q.id] = q; QIDX[q.id] = { c: q.concept, w: slug }; } });
      bankCache[slug] = b;
      return b;
    }).catch(function () { delete bankP[slug]; return null; });
    return bankP[slug];
  }
  function questionOf(it) {
    var slug = it.bank || bankOf(it.ref);
    if (!slug) return Promise.resolve(null);
    return loadBank(slug).then(function (b) { return b && b.__byId[it.ref] ? { q: b.__byId[it.ref], bank: b, slug: slug } : null; });
  }

  var nodesP = null, NODES = null;
  function siteURL(path) { try { return new URL(path, document.baseURI).href; } catch (e) { return path; } }
  function nodesIndex() {
    if (nodesP) return nodesP;
    nodesP = fetch(siteURL('intuition/nodes/index.json'), { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (ix) {
        NODES = {};
        ((ix && ix.nodes) || []).forEach(function (n) { if (n && n.id) NODES[n.id] = n; });
        return NODES;
      }).catch(function () { nodesP = null; return {}; });
    return nodesP;
  }
  var nodeP = {};
  function nodeFull(id) {
    if (!id) return Promise.resolve(null);
    if (nodeP[id]) return nodeP[id];
    nodeP[id] = fetch(siteURL('intuition/nodes/' + encodeURIComponent(id) + '.json'), { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(function () { delete nodeP[id]; return null; });
    return nodeP[id];
  }

  /* The drill's "what's shaky": concepts ranked by misses over answers across
     every bank touched, top six. Those that are nodes of the intuition map
     become concept items (a concept that is not a node has nothing to show
     but its questions, and those are already in as question items). */
  var conceptsP = null;
  function importConcepts() {
    if (conceptsP) return conceptsP;
    var m = readJSON(K_MASTERY, {});
    var slugs = {};
    Object.keys(m || {}).forEach(function (qid) {
      if (m[qid] && Number(m[qid].wrong) > 0) { var b = bankOf(qid); if (b) slugs[b] = true; }
    });
    var s = store();
    for (var id in s.items) { var it = s.items[id]; if (it.kind === 'question' && it.bank && !it.concept) slugs[it.bank] = true; }
    var list = Object.keys(slugs);
    conceptsP = Promise.all([nodesIndex(), Promise.all(list.map(loadBank))]).then(function (r) {
      var nodes = r[0] || {}, s2 = store(), changed = false, t = todayISO();
      for (var k in s2.items) {
        var q = s2.items[k];
        if (q.kind !== 'question' || q.concept) continue;
        var ix = QIDX[q.ref];
        if (ix && ix.c) { q.concept = ix.c; q.label = CLABEL[ix.c] || ix.c; changed = true; }
      }
      var agg = {};
      Object.keys(m || {}).forEach(function (qid) {
        var rec = m[qid], ix = QIDX[qid];
        if (!rec || !rec.seen || !ix || !ix.c) return;
        var a = agg[ix.c] || (agg[ix.c] = { id: ix.c, seen: 0, wrong: 0, bank: ix.w, at: 0 });
        a.seen += Number(rec.seen) || 0; a.wrong += Number(rec.wrong) || 0;
        a.at = Math.max(a.at, Number(rec.lastWrong) || 0);
      });
      var rows = Object.keys(agg).map(function (k2) { return agg[k2]; })
        .filter(function (a) { return a.wrong > 0; })
        .sort(function (a, b) { return (b.wrong / b.seen) - (a.wrong / a.seen) || b.wrong - a.wrong; })
        .slice(0, SHAKY_CONCEPTS);
      var batch = [];
      rows.forEach(function (a) {
        if (!nodes[a.id] || s2.cursor.concepts[a.id]) return;
        s2.cursor.concepts[a.id] = t;
        changed = true;
        if (s2.items['c:' + a.id]) return;
        var n = nodes[a.id];
        batch.push({ at: a.at, natural: naturalDay(a.at),
                     spec: { kind: 'concept', id: 'c:' + a.id, concept: a.id, label: n.label || CLABEL[a.id] || a.id,
                             title: n.label || CLABEL[a.id] || a.id, week: weekOfQuestion(a.bank, ''), bank: a.bank, src: 'drill' } });
      });
      if (batch.length) placeBatch(batch);
      if (changed || batch.length) save();
      return batch.length;
    }).catch(function (e) { if (window.console) console.warn('recall concept import failed', e); return 0; })
      .then(function (n) { conceptsP = null; return n; });
    return conceptsP;
  }

  /* -------------------------------------------------------------- queries -- */

  function sortDue(a, b) {
    if (a.due !== b.due) return a.due < b.due ? -1 : 1;
    if ((a.rung || 0) !== (b.rung || 0)) return (a.rung || 0) - (b.rung || 0);
    if (a.added !== b.added) return a.added < b.added ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  }
  function dueRaw(iso) {
    var t = isISO(iso) ? iso : todayISO(), s = store(), out = [];
    for (var id in s.items) { var it = s.items[id]; if (active(it) && it.due && it.due <= t) out.push(it); }
    return out.sort(sortDue);
  }
  function dueCount(iso) { ensure(); return dueRaw(iso).length; }
  function activeCount() { var s = store(), n = 0; for (var id in s.items) if (active(s.items[id])) n++; return n; }
  function nextAfter(iso) {
    ensure();
    var t = isISO(iso) ? iso : todayISO(), s = store(), best = null, n = 0;
    for (var id in s.items) {
      var it = s.items[id];
      if (!active(it) || !it.due || it.due <= t) continue;
      if (!best || it.due < best) { best = it.due; n = 1; } else if (it.due === best) n++;
    }
    return best ? { date: best, count: n, when: whenWord(best, t) } : null;
  }
  function minutesFor(items) {
    var secs = 0;
    (items || []).forEach(function (it) { secs += SECS[it.kind] || 40; });
    return Math.max(1, Math.round(secs / 60));
  }
  function shuffle(a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  /* Recent TARA weeks: up to five whose Saturday has come (the warm-up and the
     mixed drill draw from them). Before the course: the first week. */
  function recentWeeks(n) {
    n = n || 5;
    var t = todayISO(), weeks = [];
    try { weeks = (APP.schedule && APP.schedule() && APP.schedule().weeks) || []; } catch (e) { weeks = []; }
    var past = weeks.filter(function (w) { return w && w.saturday && w.saturday <= t; }).map(function (w) { return w.n; });
    if (!past.length) {
      var nxt = weeks.filter(function (w) { return w && w.saturday > t; })[0];
      return nxt ? [nxt.n] : [0];
    }
    return past.slice(-n);
  }
  function banksOfWeeks(ns) {
    var out = [];
    var weeks = [];
    try { weeks = (APP.schedule && APP.schedule() && APP.schedule().weeks) || []; } catch (e) { weeks = []; }
    ns.forEach(function (n) {
      var w = null;
      for (var i = 0; i < weeks.length; i++) if (weeks[i].n === n) w = weeks[i];
      var slugs = w ? (w.packSlugs || [w.packSlug]) : BANKS.filter(function (b) { return BANK_WEEKS[b].indexOf(n) >= 0; });
      slugs.forEach(function (sl) { if (sl && BANK_WEEKS[sl] && out.indexOf(sl) < 0) out.push(sl); });
    });
    return out;
  }

  /* A warm-up: items from recent weeks that are not due yet (soonest first),
     then fresh questions from those weeks' banks. A fresh question joins the
     queue only if it comes back shaky or blank. */
  function warmList(size) {
    size = size || WARM_SIZE;
    ensure();
    var t = todayISO(), recent = recentWeeks(5), lo = Math.min.apply(null, recent), s = store();
    var mine = [];
    for (var id in s.items) {
      var it = s.items[id];
      if (!active(it)) continue;
      if (it.week != null && it.week >= lo) mine.push(it);
    }
    mine.sort(sortDue);
    var out = mine.slice(0, Math.min(3, size)).map(copy);
    var have = {};
    out.forEach(function (x) { have[x.id] = true; });
    out.forEach(function (x) { if (x.kind === 'question') have['q:' + x.ref] = true; });
    var slugs = banksOfWeeks(recent);
    return Promise.all(slugs.map(loadBank)).then(function (banks) {
      var mastery = readJSON(K_MASTERY, {}) || {};
      var pool = [];
      banks.forEach(function (b, i) {
        if (!b) return;
        b.questions.forEach(function (q) {
          if (!q || !q.id || s.items['q:' + q.id] || have['q:' + q.id]) return;
          var rec = mastery[q.id];
          var w = !rec || !rec.seen ? 3 : (rec.streak || 0) >= 3 ? 0.5 : 1 + (rec.wrong || 0);
          pool.push({ q: q, slug: slugs[i], k: Math.random() * w });
        });
      });
      pool.sort(function (a, b) { return b.k - a.k; });
      for (var j = 0; j < pool.length && out.length < size; j++) {
        var p = pool[j];
        out.push({ id: 'q:' + p.q.id, ref: p.q.id, kind: 'question', bank: p.slug, week: weekOfQuestion(p.slug, p.q.id),
                   concept: p.q.concept, transient: true, rung: 0 });
      }
      /* not enough fresh questions (offline, or every one is queued): any
         queued item, soonest first */
      if (out.length < size) {
        var any = [];
        for (var k in s.items) if (active(s.items[k])) any.push(s.items[k]);
        mine.concat(any.sort(sortDue)).forEach(function (x) {
          if (out.length < size && !have[x.id]) { have[x.id] = true; out.push(copy(x)); }
        });
      }
      return shuffle(out);
    });
  }

  function sessionList(opts) {
    opts = opts || {};
    ensure();
    var size = opts.size || SESSION_MAX;
    if (opts.warm) return warmList(opts.size || WARM_SIZE);
    return Promise.resolve(shuffle(dueRaw(todayISO()).slice(0, size)).map(copy));
  }

  /* ================================================================== UI === */

  function h(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'class') n.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    (kids || []).forEach(function (c) {
      if (c == null || c === false) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }
  function tierNow() {
    try { if (typeof APP.tier === 'function') { var n = Number(APP.tier()); if (n >= 1 && n <= 3) return n; } } catch (e) {}
    return 2;
  }
  function reduced() {
    try { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  function go(hash) {
    if (!hash) return;
    if (typeof APP.navigate === 'function') APP.navigate(hash); else location.hash = hash;
  }
  function weekLabel(it) { return it.week != null ? 'W' + it.week : ''; }
  var LETTERS = 'ABCDEFGH';   // shown A-H like the week check; keys a-h and A-H both work
  function letterIndex(k) { return typeof k === 'string' && k.length === 1 ? LETTERS.indexOf(k.toUpperCase()) : -1; }
  function pickKeys(n) { return n <= 4 ? LETTERS.slice(0, n).split('').join(' ') : 'A–' + LETTERS.charAt(n - 1); }

  /* bank explanations name options by their bank letter ("Option (c) is tempting"); options are
     shown shuffled, so point those references at the letters on screen (same rule as weeks.js:
     only "Option(s) x" and a free-standing "(x)", never f(a) or T(s,a)). */
  function relabel(html, map) {
    if (!html || !map) return html;
    return String(html)
      .replace(/\b(Options?|options?)(\s+)([a-h])\b/g, function (m, w, sp, x) { return map[x] ? w + sp + map[x] : m; })
      .replace(/(^|[^\w)\]`'’])\(([a-h])\)/g, function (m, pre, x) { return map[x] ? pre + '(' + map[x] + ')' : m; });
  }

  /* A link that stays in the shell: #hash goes through APP.navigate. A Lab
     path is linked directly (this window, never the viewer), as lab.js does. */
  function doorLink(text, target, cls) {
    if (!target) return null;
    var isHash = target.charAt(0) === '#';
    var a = h('a', { class: cls || 'rc-link', href: isHash ? target : siteURL(target), text: text });
    if (isHash) a.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault(); go(target);
    });
    return a;
  }

  /* --------------------------------------------------------- the player -- */

  var players = [];

  function mountSession(host, opts) {
    opts = opts || {};
    var P = {
      host: host, opts: opts, items: [], i: 0, done: 0, results: [], card: null, phase: 'load',
      suggest: null, keyOff: null, destroyed: false, onTierCard: null
    };
    host.textContent = '';
    var root = h('div', { class: 'rc-player', 'data-phase': 'load' });
    var top = h('div', { class: 'rc-top' });
    var fill = h('span', { class: 'fu-progress__fill' });
    var track = h('div', { class: 'rc-track fu-progress fu-progress--thin', role: 'progressbar', 'aria-label': 'Recall session', 'aria-valuemin': '0' }, [fill]);
    var stop = h('button', { type: 'button', class: 'rc-stop fu-btn fu-btn--link', text: 'Stop here' });
    top.appendChild(track);
    top.appendChild(stop);
    var stage = h('div', { class: 'rc-stage', 'aria-live': 'polite' });
    root.appendChild(top);
    root.appendChild(stage);
    host.appendChild(root);
    P.root = root; P.track = track; P.fill = fill; P.stage = stage; P.stopBtn = stop;
    stop.addEventListener('click', function () { finish(P, true); });

    stage.appendChild(loadingEl());
    sessionList({ warm: !!opts.warm, size: opts.size }).then(function (items) {
      if (P.destroyed) return;
      P.items = items || [];
      paintTrack(P);
      if (!P.items.length) { finish(P, false); return; }
      showCard(P);
    }, function () { if (!P.destroyed) { P.items = []; finish(P, false); } });

    P.keyOff = bindKeys(P);
    players.push(P);
    return {
      destroy: function () { destroyPlayer(P); },
      state: function () { return { total: P.items.length, done: P.done, phase: P.phase, finished: P.phase === 'end' }; },
      el: root
    };
  }

  function destroyPlayer(P) {
    P.destroyed = true;
    if (P.keyOff) P.keyOff();
    var i = players.indexOf(P);
    if (i >= 0) players.splice(i, 1);
  }

  function loadingEl() {
    return h('div', { class: 'rc-loading fu-loading', role: 'status' }, [
      h('span', { class: 'fu-loading__lamp', 'aria-hidden': 'true' }),
      h('p', { class: 'fu-loading__line', text: 'setting out the cards…' })
    ]);
  }

  /* The slim line: how far through this round, never a score. */
  function paintTrack(P) {
    var n = P.items.length, d = Math.min(P.done, n);
    P.track.setAttribute('aria-valuemax', String(n));
    P.track.setAttribute('aria-valuenow', String(d));
    P.track.setAttribute('aria-valuetext', n ? (d + ' of ' + n) : 'nothing to do');
    P.fill.style.width = n ? (100 * d / n).toFixed(1) + '%' : '0%';
    P.track.hidden = !n;
  }

  function setPhase(P, ph) {
    P.phase = ph;
    P.root.setAttribute('data-phase', ph);
  }

  function showCard(P) {
    var it = P.items[P.i];
    if (!it) { finish(P, false); return; }
    P.suggest = null;
    P.stage.textContent = '';
    paintTrack(P);
    setPhase(P, 'ask');
    var card = h('article', { class: 'rc-card fu-card', 'data-kind': it.kind, 'aria-label': KIND_LABEL[it.kind] || 'Card' });
    P.card = card;
    P.stage.appendChild(card);
    var C = { it: it, card: card };
    P.cur = C;
    if (it.kind === 'question') renderQuestion(P, C);
    else if (it.kind === 'concept') renderConcept(P, C);
    else renderSentence(P, C);
  }

  /* The bottom slot: before the reveal it holds the one action ("show me",
     "check"); after, the three grades, in the same place. */
  function actionSlot(C) {
    var slot = h('div', { class: 'rc-actions' });
    C.card.appendChild(slot);
    C.slot = slot;
    return slot;
  }
  var KIND_LABEL = { question: 'Question', concept: 'Idea', sentence: 'Saved line' };
  function kicker(C, bits) {
    C.card.appendChild(h('p', { class: 'rc-kicker fu-label', text: bits.filter(Boolean).join(' · ') }));
  }
  /* Desktop key hints: [['space', 'shows'], ['G S B', 'grade']]. Letters show as
     capitals (keycaps, and the week check's A-D); either case works. */
  function keysHint(C, pairs) {
    var p = h('p', { class: 'rc-keys', 'aria-hidden': 'true' });
    pairs.forEach(function (pr, i) {
      if (i) p.appendChild(document.createTextNode(' · '));
      pr[0].split(' ').forEach(function (k) { p.appendChild(h('kbd', { class: 'fu-kbd', text: k })); p.appendChild(document.createTextNode(' ')); });
      p.appendChild(document.createTextNode(pr[1]));
    });
    C.card.appendChild(p);
  }

  function showGrades(P, C, suggest) {
    P.suggest = suggest || null;
    setPhase(P, 'grade');
    var it = C.it;
    var slot = C.slot;
    slot.textContent = '';
    slot.className = 'rc-actions rc-grades';
    slot.setAttribute('role', 'group');
    slot.setAttribute('aria-label', 'How did that feel?');
    GRADES.forEach(function (g) {
      var days = intervalFor(it.transient ? { rung: 0 } : it, g);
      var b = h('button', { type: 'button', class: 'rc-grade fu-btn fu-btn--ghost', 'data-g': g,
                            'aria-label': GRADE_WORD[g] + ', back ' + inDays(days) + (g === suggest ? ' (suggested)' : '') },
                [h('span', { class: 'rc-grade-w', text: GRADE_WORD[g] }), h('span', { class: 'rc-grade-d', text: inDays(days) })]);
      if (g === suggest) b.setAttribute('data-suggest', '1');
      b.addEventListener('click', function () { commit(P, C, g); });
      slot.appendChild(b);
    });
    /* Focus goes to what was revealed, never to a grade: a second press of
       space must not grade by accident. g / s / b or a tap does that. */
    focusSoft(C.after && !C.after.hidden ? C.after : C.card.querySelector('.rc-prompt'));
    bringIntoView(slot);
  }

  function focusSoft(el) {
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
  }
  function scrollBox(el) {
    for (var p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      var oy = '';
      try { oy = getComputedStyle(p).overflowY; } catch (e) {}
      if (oy === 'auto' || oy === 'scroll') return p;
    }
    return null;
  }
  function bringIntoView(el) {
    if (!el || !el.getBoundingClientRect) return;
    requestAnimationFrame(function () {
      if (!el.isConnected) return;
      var r = el.getBoundingClientRect();
      var top = 0, bottom = window.innerHeight || document.documentElement.clientHeight;
      var box = scrollBox(el);
      if (box) { var b = box.getBoundingClientRect(); top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom); }
      if (r.bottom > bottom - 8 || r.top < top) {
        try { el.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' }); } catch (e) { el.scrollIntoView(false); }
      }
    });
  }

  function commit(P, C, g) {
    if (P.phase !== 'grade') return;
    setPhase(P, 'commit');
    var it = C.it;
    if (it.transient) {
      if (g !== 'solid') {
        addItem({ kind: 'question', id: it.id, bank: it.bank, week: it.week, concept: it.concept, src: 'warm' });
        gradeItem(it.id, g);
      }
    } else {
      gradeItem(it.id, g);
    }
    P.results.push({ id: it.id, kind: it.kind, g: g });
    P.done++;
    P.i++;
    if (P.i >= P.items.length) finish(P, false);
    else showCard(P);
  }

  function skip(P, why) {
    var it = P.items[P.i];
    if (it && why === 'missing' && !it.transient) {
      var x = find(it.id);
      if (x) { x.off = true; x.offWhy = 'missing'; save(); }
    }
    P.items.splice(P.i, 1);
    if (P.i >= P.items.length) finish(P, false); else showCard(P);
  }

  function finish(P, early) {
    setPhase(P, 'end');
    P.stage.textContent = '';
    paintTrack(P);
    P.stopBtn.hidden = true;
    var t = todayISO();
    var left = dueRaw(t).length;
    var nx = nextAfter(t);
    var box = h('div', { class: 'rc-end fu-card' + (!P.items.length && !P.done ? ' rc-end--empty' : '') });
    var big, sub = [];
    if (!P.items.length && !P.done) {
      big = activeCount() || P.opts.warm ? 'nothing due. every bench starts like this.' : 'nothing to recall yet. misses and shaky cards land here.';
    } else if (early) {
      big = 'stopped. the rest keep.';
    } else {
      big = left ? 'that’s this round.' : 'that’s the lot.';
    }
    if (P.done) sub.push(P.done + (P.done === 1 ? ' card' : ' cards') + ' looked at');
    if (left) sub.push(left + ' still due, whenever you like');
    else if (nx) sub.push('next: ' + nx.count + ' ' + nx.when);
    box.appendChild(h('p', { class: 'rc-end-big fu-voice', tabindex: '-1', text: big }));
    if (sub.length) box.appendChild(h('p', { class: 'rc-end-sub fu-small', text: sub.join('. ') + '.' }));
    var acts = h('div', { class: 'rc-end-actions' });
    var back = h('button', { type: 'button', class: 'rc-btn fu-btn fu-btn--ghost', 'data-act': 'back', text: 'Back to practice' });
    back.addEventListener('click', function () {
      if (typeof P.opts.onExit === 'function') P.opts.onExit(); else go('#practice');
    });
    acts.appendChild(back);
    if (left) {
      var more = h('button', { type: 'button', class: 'rc-btn fu-btn fu-btn--big', 'data-act': 'more', text: 'Five more minutes' });
      more.addEventListener('click', function () { restart(P, false); });
      acts.appendChild(more);
    } else if (!P.opts.warm) {
      var warm = h('button', { type: 'button', class: 'rc-btn fu-btn', 'data-act': 'warm', text: 'Warm up anyway' });
      warm.addEventListener('click', function () { restart(P, true); });
      acts.appendChild(warm);
    }
    box.appendChild(acts);
    P.stage.appendChild(box);
    focusSoft(box.querySelector('.rc-end-big'));
    if (typeof P.opts.onDone === 'function') { try { P.opts.onDone({ done: P.done, results: P.results.slice() }); } catch (e) {} }
  }

  function restart(P, warm) {
    P.opts.warm = !!warm;
    P.items = []; P.i = 0; P.done = 0; P.results = [];
    P.stopBtn.hidden = false;
    setPhase(P, 'load');
    P.stage.textContent = '';
    P.stage.appendChild(loadingEl());
    if (typeof P.opts.onRestart === 'function') { try { P.opts.onRestart(!!warm); } catch (e) {} }
    sessionList({ warm: !!warm, size: P.opts.size }).then(function (items) {
      if (P.destroyed) return;
      P.items = items || [];
      paintTrack(P);
      if (!P.items.length) finish(P, false); else showCard(P);
    });
  }

  /* ------------------------------------------------------------ question -- */

  function renderQuestion(P, C) {
    var it = C.it;
    kicker(C, ['Question', weekLabel(it), BANK_TOPIC[it.bank] || '']);
    var stem = h('h2', { class: 'rc-prompt rc-stem', tabindex: '-1' });
    stem.textContent = '…';
    C.card.appendChild(stem);
    var body = h('div', { class: 'rc-body' });
    C.card.appendChild(body);
    var after = h('div', { class: 'rc-after', tabindex: '-1', hidden: true });
    C.card.appendChild(after);
    actionSlot(C);
    C.after = after;

    questionOf(it).then(function (hit) {
      if (P.destroyed || P.cur !== C) return;
      if (!hit) {
        stem.textContent = 'this question has moved on.';
        body.appendChild(h('p', { class: 'rc-note fu-small', text: 'it is no longer in its bank, so it leaves the queue. nothing is lost.' }));
        var nb = h('button', { type: 'button', class: 'rc-btn fu-btn', text: 'Next card' });
        nb.addEventListener('click', function () { skip(P, 'missing'); });
        C.slot.appendChild(nb);
        return;
      }
      var q = hit.q;
      C.q = q;
      if (!it.concept && q.concept) it.concept = q.concept;
      var stems = [q.stem].concat(Array.isArray(q.variants) ? q.variants.filter(Boolean) : []);
      stem.innerHTML = stems[Math.floor(Math.random() * stems.length)] || q.stem || '';
      var type = String(q.type || 'mcq').toLowerCase();
      if (type === 'scenario') type = 'mcq';
      if (type === 'mcq') askMCQ(P, C, q, body);
      else if (type === 'numeric') askNumeric(P, C, q, body);
      else if (type === 'ordering') askOrdering(P, C, q, body);
      else askShort(P, C, q, body);
    });
  }

  function verdict(P, C, ok, extra) {
    var q = C.q, it = C.it, after = C.after;
    after.hidden = false;
    after.textContent = '';
    after.appendChild(h('p', { class: 'rc-verdict fu-voice', 'data-ok': ok ? '1' : '0',
                              text: ok ? 'got it.' : 'almost. here’s the why.' }));
    if (extra) after.appendChild(extra);
    if (q.explanation || q.why) after.appendChild(h('div', { class: 'rc-explain', html: relabel(q.explanation || q.why, C.map) }));
    var links = h('p', { class: 'rc-links' });
    var cid = q.concept || it.concept;
    if (NODES && cid && NODES[cid]) {
      links.appendChild(doorLink('▶ 1-minute film', viewHref('intuition/' + (NODES[cid].film || 'node.html?id=' + cid)), 'rc-door rc-film fu-btn fu-btn--ghost'));
    }
    if (it.bank) {
      links.appendChild(doorLink(CLABEL[cid] ? 'Drill ' + CLABEL[cid].toLowerCase() : 'More from this bank',
        '#drill/' + it.bank + (cid ? '/' + encodeURIComponent(cid) : ''), 'rc-door fu-btn fu-btn--ghost'));
    }
    if (links.childNodes.length) after.appendChild(links);
    showGrades(P, C, ok ? 'solid' : 'shaky');
  }

  function askMCQ(P, C, q, body) {
    var opts = shuffle((q.options || []).map(function (o, i) {
      return { id: o && o.id != null ? String(o.id) : 'o' + i, text: o && o.text != null ? String(o.text) : String(o), correct: !!(o && o.correct) };
    }));
    C.map = {};
    opts.forEach(function (o, i) { if (/^[a-h]$/i.test(o.id)) C.map[o.id.toLowerCase()] = LETTERS.charAt(i); });
    var multi = opts.filter(function (o) { return o.correct; }).length > 1;
    var picked = [];
    var ul = h('ul', { class: 'rc-options', role: 'list' });
    var btns = [];
    opts.forEach(function (o, i) {
      var b = h('button', { type: 'button', class: 'rc-opt', 'data-oid': o.id, 'aria-pressed': 'false' },
                [h('kbd', { class: 'rc-opt-k fu-kbd', 'aria-hidden': 'true', text: LETTERS.charAt(i) }), h('span', { class: 'rc-opt-t', html: o.text })]);
      b.addEventListener('click', function () { pick(i); });
      btns.push(b);
      ul.appendChild(h('li', null, [b]));
    });
    body.appendChild(ul);
    var check = null;
    if (multi) {
      body.appendChild(h('p', { class: 'rc-note fu-small', text: 'more than one fits. pick them all, then check.' }));
      check = h('button', { type: 'button', class: 'rc-btn fu-btn fu-btn--big fu-btn--wide', text: 'Check', disabled: true });
      check.addEventListener('click', grade);
      C.slot.appendChild(check);
    }
    function pick(i) {
      if (P.phase !== 'ask') return;
      var id = opts[i] && opts[i].id;
      if (id == null) return;
      if (multi) {
        var k = picked.indexOf(id);
        if (k >= 0) picked.splice(k, 1); else picked.push(id);
        btns.forEach(function (b) { b.setAttribute('aria-pressed', String(picked.indexOf(b.getAttribute('data-oid')) >= 0)); });
        check.disabled = !picked.length;
      } else {
        picked = [id];
        grade();
      }
    }
    function grade() {
      if (P.phase !== 'ask' || !picked.length) return;
      var right = opts.filter(function (o) { return o.correct; }).map(function (o) { return o.id; });
      var ok = right.length === picked.length && right.every(function (id) { return picked.indexOf(id) >= 0; });
      btns.forEach(function (b) {
        var id = b.getAttribute('data-oid');
        b.disabled = true;
        if (right.indexOf(id) >= 0) { b.classList.add('is-right'); b.appendChild(h('span', { class: 'rc-tag fu-badge fu-badge--gold', text: 'this one' })); }
        else if (picked.indexOf(id) >= 0) { b.classList.add('is-picked'); b.appendChild(h('span', { class: 'rc-tag fu-badge fu-badge--quiet', text: 'your pick' })); }
      });
      if (check) check.remove();
      verdict(P, C, ok);
    }
    C.key = function (k) {
      var i = letterIndex(k);
      if (i >= 0 && i < opts.length) { pick(i); return true; }
      if (k === 'enter' && check && !check.disabled) { grade(); return true; }
      return false;
    };
    keysHint(C, [[pickKeys(opts.length), 'pick'], ['enter', 'takes the marked grade'], ['G S B', 'grade']]);
    focusSoft(C.card.querySelector('.rc-prompt'));
  }

  function parseNumber(str) {
    var s = String(str == null ? '' : str).trim().replace(/,/g, '').replace(/−/g, '-').replace(/\s+/g, '');
    if (!s) return NaN;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
      var m = s.match(/^([+-]?(?:\d+\.?\d*|\.\d+))(?:[x*]10\^([+-]?\d+))$/i);
      return m ? Number(m[1]) * Math.pow(10, Number(m[2])) : NaN;
    }
    return Number(s);
  }

  function askNumeric(P, C, q, body) {
    var id = 'rc-num-' + Math.random().toString(36).slice(2, 8);
    var input = h('input', { id: id, class: 'rc-input fu-input', type: 'text', inputmode: 'decimal', autocomplete: 'off',
                             spellcheck: 'false', placeholder: 'a number (1.5e-3 works)' });
    var row = h('div', { class: 'rc-numrow' }, [
      h('label', { class: 'fu-sr', for: id, text: 'Your answer' }), input,
      q.unit ? h('span', { class: 'rc-unit fu-small', text: q.unit }) : null
    ]);
    body.appendChild(row);
    var check = h('button', { type: 'button', class: 'rc-btn fu-btn fu-btn--big fu-btn--wide', text: 'Check' });
    C.slot.appendChild(check);
    keysHint(C, [['enter', 'checks'], ['G S B', 'grade']]);
    function grade() {
      if (P.phase !== 'ask') return;
      var val = parseNumber(input.value);
      if (isNaN(val)) { input.setAttribute('aria-invalid', 'true'); focusSoft(input); return; }
      var tol = q.tolerance == null ? 1e-9 : Math.abs(Number(q.tolerance));
      var ok = Math.abs(val - Number(q.answer)) <= tol;
      input.disabled = true;
      input.classList.add(ok ? 'is-right' : 'is-picked');
      check.remove();
      var extra = ok ? null : h('p', { class: 'rc-note fu-small', text: 'it was ' + q.answer + (q.unit ? ' ' + q.unit : '') + ' (anything within ±' + tol + ' counts).' });
      verdict(P, C, ok, extra);
    }
    check.addEventListener('click', grade);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); grade(); }
    });
    C.key = function (k) { if (k === 'enter') { grade(); return true; } return false; };
    focusSoft(input);
  }

  function askOrdering(P, C, q, body) {
    var truth = (q.items || []).map(String);
    var remaining = shuffle(truth), placed = [];
    body.appendChild(h('p', { class: 'rc-note fu-small', text: 'tap them in order. tap a placed one to take it back.' }));
    var seq = h('ol', { class: 'rc-seq', 'aria-label': 'Your order' });
    var pool = h('ul', { class: 'rc-pool', 'aria-label': 'Still to place' });
    body.appendChild(seq);
    body.appendChild(pool);
    var check = h('button', { type: 'button', class: 'rc-btn fu-btn fu-btn--big fu-btn--wide', text: 'Check', disabled: true });
    C.slot.appendChild(check);
    function paint() {
      seq.textContent = ''; pool.textContent = '';
      placed.forEach(function (t, i) {
        var b = h('button', { type: 'button', class: 'rc-item is-placed', 'data-i': String(i) },
                  [h('span', { class: 'rc-item-n fu-mono', text: String(i + 1) }), h('span', { class: 'rc-opt-t', html: t })]);
        b.addEventListener('click', function () {
          if (P.phase !== 'ask') return;
          placed.splice(i, 1); remaining.push(t); paint();
        });
        seq.appendChild(h('li', null, [b]));
      });
      remaining.forEach(function (t, i) {
        var b = h('button', { type: 'button', class: 'rc-item' },
                  [h('kbd', { class: 'rc-opt-k fu-kbd', 'aria-hidden': 'true', text: LETTERS.charAt(i) }), h('span', { class: 'rc-opt-t', html: t })]);
        b.addEventListener('click', function () { place(i); });
        pool.appendChild(h('li', null, [b]));
      });
      check.disabled = remaining.length !== 0;
      seq.hidden = !placed.length;
    }
    function place(i) {
      if (P.phase !== 'ask' || remaining[i] == null) return;
      placed.push(remaining[i]); remaining.splice(i, 1); paint();
      if (!remaining.length) focusSoft(check);
    }
    function grade() {
      if (P.phase !== 'ask' || remaining.length) return;
      var ok = placed.length === truth.length && placed.every(function (x, i) { return x === truth[i]; });
      Array.prototype.forEach.call(seq.querySelectorAll('.rc-item'), function (b, i) {
        b.disabled = true;
        b.classList.add(placed[i] === truth[i] ? 'is-right' : 'is-picked');
      });
      check.remove();
      var extra = null;
      if (!ok) {
        extra = h('div', { class: 'rc-note fu-small' }, [h('span', { text: 'the order runs:' })]);
        var ol = h('ol', { class: 'rc-truth' });
        truth.forEach(function (t) { ol.appendChild(h('li', { html: t })); });
        extra.appendChild(ol);
      }
      verdict(P, C, ok, extra);
    }
    check.addEventListener('click', grade);
    C.key = function (k) {
      var i = letterIndex(k);
      if (i >= 0 && i < remaining.length) { place(i); return true; }
      if (k === 'enter') { grade(); return true; }
      return false;
    };
    keysHint(C, [[pickKeys(truth.length), 'place'], ['enter', 'checks'], ['G S B', 'grade']]);
    paint();
    focusSoft(C.card.querySelector('.rc-prompt'));
  }

  function askShort(P, C, q, body) {
    var reveal = h('button', { type: 'button', class: 'rc-btn rc-reveal fu-btn fu-btn--big fu-btn--wide', text: 'Show me' });
    C.slot.appendChild(reveal);
    function show() {
      if (P.phase !== 'ask') return;
      reveal.remove();
      C.after.hidden = false;
      C.after.appendChild(h('p', { class: 'rc-plain', html: String(q.answer || '') }));
      if (q.explanation) C.after.appendChild(h('div', { class: 'rc-explain', html: q.explanation }));
      showGrades(P, C, null);
    }
    reveal.addEventListener('click', show);
    C.reveal = show;
    keysHint(C, [['space', 'shows'], ['G S B', 'grade']]);
    void body;
  }

  /* ------------------------------------------------------------- concept -- */

  /* Each tier adds one thing the plain line above it does not say: the picture
     (Plain), when to reach for it (Generalist), why it matters (Expert). The
     node's "what" mostly restates the plain line, so it is only a fallback.
     One short paragraph each keeps the answer and the grades on one phone screen. */
  var PART_SUB = { allegory: 'picture it', what: 'what it is', when: 'when to use it', why: 'why it matters' };
  function tierPart(node, n) {
    if (!node) return null;
    var hm = node.hamming || {};
    var order = n === 1 ? [['allegory', node.allegory], ['what', hm.what]]
      : n === 3 ? [['why', hm.why], ['what', hm.what], ['allegory', node.allegory]]
      : [['when', hm.when], ['what', hm.what], ['allegory', node.allegory]];
    for (var i = 0; i < order.length; i++) {
      if (order[i][1] && typeof order[i][1] === 'string') return { key: order[i][0], text: order[i][1] };
    }
    return null;
  }
  /* The week path's card (APP.paths.card): its plain line, and its tier text
     when the node file has none. */
  function pathsCard(it) {
    try {
      if (APP.paths && typeof APP.paths.card === 'function') return APP.paths.card(it.concept || it.ref, it.week) || null;
    } catch (e) {}
    return null;
  }

  function renderConcept(P, C) {
    var it = C.it, cid = it.concept || it.ref;
    kicker(C, ['Idea', weekLabel(it)]);
    C.card.appendChild(h('p', { class: 'rc-ask fu-voice', text: 'say it in one line:' }));
    var label = h('h2', { class: 'rc-prompt rc-label', tabindex: '-1', text: it.label || it.title || cid });
    C.card.appendChild(label);
    var hint = h('p', { class: 'rc-hint fu-small' });
    C.card.appendChild(hint);
    var after = h('div', { class: 'rc-after', tabindex: '-1', hidden: true });
    var plain = h('p', { class: 'rc-plain' });
    /* all three tiers share one grid cell, so the tallest sets the height and a
       tier change only swaps which one is visible: nothing moves (the week
       path's ideas deck does the same) */
    var tiers = h('div', { class: 'rc-tiers', 'data-tier': String(tierNow()), hidden: true });
    var layers = {};
    [1, 2, 3].forEach(function (n) {
      layers[n] = h('div', { class: 'rc-tier', 'data-t': String(n) }, [h('p', { class: 'rc-tier-k fu-label' }), h('p', { class: 'rc-tier-t' })]);
      tiers.appendChild(layers[n]);
    });
    var links = h('p', { class: 'rc-links' });
    after.appendChild(plain);
    after.appendChild(tiers);
    after.appendChild(links);
    C.card.appendChild(after);
    C.after = after;
    actionSlot(C);
    var reveal = h('button', { type: 'button', class: 'rc-btn rc-reveal fu-btn fu-btn--big fu-btn--wide', text: 'Show me' });
    C.slot.appendChild(reveal);
    keysHint(C, [['space', 'shows'], ['G S B', 'grade']]);

    var data = { node: null, full: null, card: pathsCard(it) };
    function fillTiers() {
      var any = false;
      [1, 2, 3].forEach(function (n) {
        /* the node's one short thought first; the week path's card text (whole
           what / when / why, where else) is the fallback, being a page long */
        var part = tierPart(data.full, n);
        if (!part) {
          var ct = data.card && data.card.tiers ? (data.card.tiers[n] || data.card.tiers[String(n)]) : '';
          if (typeof ct === 'string' && ct) part = { key: '', text: ct };
        }
        layers[n].firstChild.textContent = part ? TIER_NAME[n] + (part.key ? ' · ' + PART_SUB[part.key] : '') : '';
        layers[n].lastChild.textContent = part ? part.text : '';
        if (part) any = true;
      });
      tiers.hidden = !any;
      applyTier();
    }
    function applyTier() {
      var t = String(tierNow());
      tiers.setAttribute('data-tier', t);
      [1, 2, 3].forEach(function (n) {
        if (String(n) === t) layers[n].removeAttribute('aria-hidden'); else layers[n].setAttribute('aria-hidden', 'true');
      });
    }
    C.onTier = applyTier;

    nodesIndex().then(function (nodes) {
      if (P.destroyed || P.cur !== C) return;
      var n = nodes && nodes[cid];
      data.node = n || null;
      if (n) {
        if (!it.label && !it.title) label.textContent = n.label || cid;
        hint.textContent = '';
        if (n.title) { hint.appendChild(document.createTextNode('hint: ')); hint.appendChild(h('span', { class: 'rc-hint-t', text: n.title })); }
        hint.hidden = !n.title;
      } else {
        hint.hidden = true;
      }
      plain.textContent = (data.card && typeof data.card.plain === 'string' && data.card.plain) || (n && n.plain) || it.text || '';
      links.textContent = '';
      var film = n ? viewHref('intuition/' + (n.film || 'node.html?id=' + cid)) : null;
      if (film) links.appendChild(doorLink('▶ 1-minute film', film, 'rc-door rc-film fu-btn fu-btn--ghost'));
      if (it.hash) links.appendChild(doorLink('Open the card', it.hash, 'rc-door fu-btn fu-btn--ghost'));
      else if (it.bank) links.appendChild(doorLink('Drill it', '#drill/' + it.bank + '/' + encodeURIComponent(cid), 'rc-door fu-btn fu-btn--ghost'));
      return n ? nodeFull(cid) : null;
    }).then(function (full) {
      if (P.destroyed || P.cur !== C) return;
      data.full = full || null;
      fillTiers();
      if (P.phase === 'grade') bringIntoView(C.slot);   // the text came after the reveal
    });

    function show() {
      if (P.phase !== 'ask') return;
      after.hidden = false;
      reveal.remove();
      applyTier();
      showGrades(P, C, null);
    }
    reveal.addEventListener('click', show);
    C.reveal = show;
    focusSoft(reveal);
  }

  /* ------------------------------------------------------------ sentence -- */

  function renderSentence(P, C) {
    var it = C.it;
    kicker(C, ['Saved line', weekLabel(it)]);
    if (it.title) C.card.appendChild(h('p', { class: 'rc-from fu-small', text: 'from ' + it.title }));
    C.card.appendChild(h('blockquote', { class: 'rc-quote rc-prompt', tabindex: '-1', text: it.text || '' }));
    C.card.appendChild(h('p', { class: 'rc-ask fu-voice', text: 'still clear?' }));
    var links = h('p', { class: 'rc-links' });
    if (it.hash) links.appendChild(doorLink('Open where it came from', it.hash, 'rc-door fu-btn fu-btn--ghost'));
    var letGo = h('button', { type: 'button', class: 'rc-quiet fu-btn fu-btn--link', text: 'Let it go' });
    letGo.addEventListener('click', function () {
      var x = find(it.id);
      if (x) { x.off = true; x.offWhy = 'let go'; x.offOn = todayISO(); save(); }
      P.results.push({ id: it.id, kind: it.kind, g: 'off' });
      P.done++;
      P.i++;
      if (P.i >= P.items.length) finish(P, false); else showCard(P);
    });
    links.appendChild(letGo);
    C.card.appendChild(links);
    actionSlot(C);
    keysHint(C, [['G S B', 'grade']]);
    showGrades(P, C, null);
  }

  /* ---------------------------------------------------------------- keys -- */

  function editable(t) {
    if (!t) return false;
    var tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable === true;
  }
  /* Digits are the app-wide tier keys, so the player never reads them:
     space reveals, letters pick and grade, enter accepts the suggestion. */
  function bindKeys(P) {
    function onKey(e) {
      if (P.destroyed || e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!P.root.isConnected || (!P.root.offsetParent && P.root.getClientRects().length === 0)) return;
      if (editable(e.target)) return;
      var k = e.key === ' ' || e.key === 'Spacebar' ? 'space' : String(e.key || '').toLowerCase();
      if (/^[0-9]$/.test(k)) return;
      var C = P.cur;
      var used = false;
      if (P.phase === 'grade') {
        if (k === 'g') { commit(P, C, 'solid'); used = true; }
        else if (k === 's') { commit(P, C, 'shaky'); used = true; }
        else if (k === 'b') { commit(P, C, 'blank'); used = true; }
        else if (k === 'enter' && P.suggest && !(e.target && e.target.closest && e.target.closest('button, a'))) {
          commit(P, C, P.suggest); used = true;
        }
      } else if (P.phase === 'ask' && C) {
        if (k === 'space' && C.reveal && !(e.target && e.target.closest && e.target.closest('button, a'))) { C.reveal(); used = true; }
        else if (C.key && k !== 'space') used = !!C.key(k);
      }
      if (used) e.preventDefault();
    }
    document.addEventListener('keydown', onKey);
    return function () { document.removeEventListener('keydown', onKey); };
  }

  function onTierAll() {
    players.forEach(function (P) { if (P.cur && typeof P.cur.onTier === 'function') { try { P.cur.onTier(); } catch (e) {} } });
  }
  try { if (typeof APP.onTierChange === 'function') APP.onTierChange(onTierAll); else window.addEventListener('tara:tier', onTierAll); }
  catch (e) { window.addEventListener('tara:tier', onTierAll); }

  /* ---------------------------------------------------------------- sync -- */

  var resyncT = 0;
  function resync() {
    clearTimeout(resyncT);
    resyncT = setTimeout(function () {
      ensure();
      try { if (syncNow()) importConcepts(); } catch (e) {}
    }, 60);
  }
  window.addEventListener('storage', function (e) {
    if (!e) return;
    if (e.key === KEY || e.key === null) { S = null; emit(); }
    if (e.key === K_REVIEW || e.key === K_MASTERY || e.key === null) resync();
  });
  window.addEventListener('tara:review', resync);
  document.addEventListener('tara:quiz-answered', function (e) {
    if (e && e.detail && e.detail.ok === false) resync();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { S = null; resync(); emit(); }
  });

  var readyResolve;
  var ready = new Promise(function (res) { readyResolve = res; });
  setTimeout(function () {
    ensure();
    emit();
    /* concepts need the bank payloads and the node index: after the first paint */
    setTimeout(function () {
      importConcepts().then(function () { readyResolve(true); }, function () { readyResolve(false); });
    }, 400);
  }, 0);

  /* ----------------------------------------------------------------- API -- */

  APP.recall = {
    __v2: true,
    RUNGS: RUNGS.slice(),
    SESSION_MAX: SESSION_MAX,
    ready: ready,
    add: function (spec) { ensure(); var it = addItem(spec); return copy(it); },
    get: function (id) { ensure(); return copy(find(id)); },
    list: function () { ensure(); var s = store(), out = []; for (var id in s.items) out.push(copy(s.items[id])); return out.sort(sortDue); },
    dueCount: function (iso) { return dueCount(iso); },
    due: function (iso) { ensure(); return dueRaw(iso).map(copy); },
    grade: function (id, g) { ensure(); return gradeItem(id, g); },
    /* when the item would come back after grade g: { days, date, word } */
    preview: function (id, g) {
      ensure();
      var it = find(id); g = normGrade(g);
      if (!it || !g) return null;
      var d = intervalFor(it, g);
      return { days: d, date: addDays(todayISO(), d), word: inDays(d) };
    },
    letGo: function (id) { ensure(); var it = find(id); if (!it) return null; it.off = true; it.offWhy = 'let go'; it.offOn = todayISO(); save(); return copy(it); },
    restore: function (id) { ensure(); var it = find(id); if (!it) return null; it.off = false; save(); return copy(it); },
    next: function (iso) { return nextAfter(iso); },
    minutes: function (items) { return minutesFor(items || dueRaw(todayISO()).slice(0, SESSION_MAX)); },
    summary: function (iso) {
      ensure();
      var t = isISO(iso) ? iso : todayISO(), list = dueRaw(t), byKind = { question: 0, concept: 0, sentence: 0 };
      list.forEach(function (it) { byKind[it.kind] = (byKind[it.kind] || 0) + 1; });
      var take = list.slice(0, SESSION_MAX);
      return { today: t, due: list.length, session: take.length, minutes: minutesFor(take), byKind: byKind,
               total: activeCount(), next: nextAfter(t) };
    },
    session: function (opts) { return sessionList(opts); },
    mountSession: mountSession,
    recentWeeks: recentWeeks,
    banksOfWeeks: banksOfWeeks,
    sync: function () { ensure(); syncNow(); return importConcepts(); },
    todayISO: todayISO,
    whenWord: whenWord,
    _store: function () { return store(); },
    _reload: function () { S = null; synced = false; ensure(); emit(); return store(); }
  };
})();
})();

/* ===== src/v2/practice.js ===== */
;(function(){
/* src/v2/practice.js — owner: recall.
 *
 * The Practice tab (contract §Routes): section id "practice".
 *   #practice            the Recall card on top, the drill's week banks below
 *   #practice/recall     a Recall session, one card at a time (recall.js)
 *   #practice/recall/warm  the same, as a warm-up from recent weeks
 *   #practice/mixed      a drill session interleaving the recent weeks' banks
 * The week tiles open the existing drill room at #drill/<slug>, which stays.
 *
 * No-reorder: every slot is built once and only its text changes. The tiles
 * sit in TARA week order and never move; "this week" / "just done" are marks
 * on a tile, not a new position.
 */
(function () {
  'use strict';

  var APP = window.APP;
  if (!APP || typeof APP.registerSection !== 'function') return;

  /* One tile per bank. Topics and counts as the drill room labels them; the
     TARA weeks come from the schedule (APP.weeksOfPack), this is the fallback. */
  var BANKS = [
    { slug: 'week-01', topic: 'Einops', count: 78, weeks: [0] },
    { slug: 'week-02', topic: 'ResNets', count: 88, weeks: [1] },
    { slug: 'week-03', topic: 'Optimisers', count: 72, weeks: [1] },
    { slug: 'week-04', topic: 'Autograd', count: 76, weeks: [1] },
    { slug: 'week-05', topic: 'Transformer', count: 81, weeks: [2] },
    { slug: 'week-06', topic: 'Hooks', count: 79, weeks: [3] },
    { slug: 'week-07', topic: 'Circuits', count: 91, weeks: [3, 4] },
    { slug: 'week-08', topic: 'SAEs', count: 96, weeks: [4] },
    { slug: 'week-09', topic: 'DQN', count: 70, weeks: [5] },
    { slug: 'week-10', topic: 'PPO & RLHF', count: 73, weeks: [6] },
    { slug: 'week-11', topic: 'Evals', count: 78, weeks: [7, 8, 9] },
    { slug: 'alignment-science', topic: 'Alignment', count: 68, weeks: [10, 11] },
    { slug: 'capstone-weeks-12-14', topic: 'Capstone', count: 233, weeks: [12, 13, 14] }
  ];
  BANKS.forEach(function (b, i) { b.order = i; });
  var BYSLUG = {};
  BANKS.forEach(function (b) { BYSLUG[b.slug] = b; });

  /* Chapter tints by TARA week (contract §Brand). */
  function chapterOf(n) {
    if (n == null) return 'found';
    if (n <= 1) return 'found';
    if (n <= 4) return 'interp';
    if (n <= 6) return 'rl';
    if (n <= 9) return 'evals';
    if (n <= 11) return 'align';
    return 'project';
  }
  var KIND_WORD = { question: ['question', 'questions'], concept: ['idea', 'ideas'], sentence: ['saved line', 'saved lines'] };
  var PREF_KEY = 'tara-drill-prefs-v1';     // the drill room's own: read, never written

  function lsJSON(k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function h(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    (kids || []).forEach(function (c) { if (c != null && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function go(hash) { if (typeof APP.navigate === 'function') APP.navigate(hash); else location.hash = hash; }
  /* A real link that still routes through the shell. */
  function link(cls, hash, kids, label) {
    var a = h('a', { class: cls, href: hash, 'aria-label': label || null }, kids);
    a.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      go(hash);
    });
    return a;
  }
  function recall() { return APP.recall && typeof APP.recall.summary === 'function' ? APP.recall : null; }
  function todayISO() {
    var r = recall();
    if (r && r.todayISO) return r.todayISO();
    try { var m = /[?&]today=(\d{4}-\d{2}-\d{2})(?:&|$)/.exec(location.search); if (m) return m[1]; } catch (e) {}
    return typeof APP.todayISO === 'function' ? APP.todayISO() : new Date().toISOString().slice(0, 10);
  }
  function scheduleWeeks() {
    try { return (APP.schedule && APP.schedule() && APP.schedule().weeks) || []; } catch (e) { return []; }
  }
  function weeksOf(slug) {
    var ns = [];
    try { if (typeof APP.weeksOfPack === 'function' && scheduleWeeks().length) ns = APP.weeksOfPack(slug) || []; } catch (e) { ns = []; }
    return ns.length ? ns : (BYSLUG[slug] ? BYSLUG[slug].weeks : []);
  }
  function span(ns) {
    if (!ns || !ns.length) return '';
    if (typeof APP.weekSpan === 'function') { try { return APP.weekSpan(ns, true); } catch (e) {} }
    return ns[0] === ns[ns.length - 1] ? 'W' + ns[0] : 'W' + ns[0] + '–' + ns[ns.length - 1];
  }
  /* "this week" = the next Saturday's week; "just done" = the one 1-6 days ago. */
  function nowWeeks() {
    var out = { target: null, justDone: null };
    try {
      if (typeof APP.v2now === 'function') {
        var v = APP.v2now() || {};
        out.target = v.target != null ? (typeof v.target === 'object' ? v.target.n : v.target) : null;
        out.justDone = v.justDone != null ? (typeof v.justDone === 'object' ? v.justDone.n : v.justDone) : null;
        if (out.target != null || out.justDone != null) return out;
      }
    } catch (e) {}
    var t = todayISO(), weeks = scheduleWeeks();
    for (var i = 0; i < weeks.length; i++) {
      var w = weeks[i];
      if (out.target == null && w.saturday >= t) out.target = w.n;
      var ago = (Date.parse(t + 'T00:00:00Z') - Date.parse(w.saturday + 'T00:00:00Z')) / 864e5;
      if (ago >= 1 && ago <= 6) out.justDone = w.n;
    }
    return out;
  }

  /* ------------------------------------------------------------ state ---- */
  var V = { built: false, root: null, els: {}, view: null, player: null, playerWarm: false, mixed: null };

  /* ------------------------------------------------------------- build ---- */
  function build(el) {
    var root = h('div', { class: 'pr-root' });

    /* --- home --- */
    var home = h('div', { class: 'pr-view pr-home', 'data-view': 'home' });
    home.appendChild(h('h1', { class: 'fu-sr', text: 'Practice' }));

    var card = h('section', { class: 'pr-recall fu-card', 'aria-labelledby': 'pr-recall-k' });
    var eyebrow = h('h2', { class: 'pr-eyebrow fu-label', id: 'pr-recall-k', text: 'Recall' });
    var big = h('p', { class: 'pr-recall-big', 'data-slot': 'big' });
    var sub = h('p', { class: 'pr-recall-sub fu-small', 'data-slot': 'sub' });
    var start = h('button', { type: 'button', class: 'pr-start fu-btn fu-btn--big', 'data-slot': 'start' });
    start.addEventListener('click', function () {
      go(start.getAttribute('data-warm') === '1' ? '#practice/recall/warm' : '#practice/recall');
    });
    var foot = h('p', { class: 'pr-recall-foot fu-small', 'data-slot': 'foot' });
    card.appendChild(eyebrow);
    card.appendChild(big);
    card.appendChild(sub);
    card.appendChild(h('div', { class: 'pr-recall-act' }, [start]));
    card.appendChild(foot);
    home.appendChild(card);

    var drill = h('section', { class: 'pr-drill', 'aria-labelledby': 'pr-drill-h' });
    drill.appendChild(h('div', { class: 'pr-head' }, [
      h('h2', { class: 'pr-h2 fu-h2', id: 'pr-drill-h', text: 'Drill' }),
      h('p', { class: 'pr-lede fu-voice', text: 'a week’s question bank, shuffled fresh every time.' })
    ]));
    var mixedLabel = h('span', { class: 'pr-tile-w' });
    var mixedSub = h('span', { class: 'pr-tile-t' });
    var mixed = link('pr-tile pr-tile--mixed fu-card fu-card--lift fu-tint-sky', '#practice/mixed', [
      h('span', { class: 'pr-tile-k fu-label', text: 'Mixed' }), mixedLabel, mixedSub
    ]);
    drill.appendChild(mixed);
    var grid = h('ol', { class: 'pr-tiles', 'aria-label': 'Week banks' });
    var sorted = BANKS.slice().sort(function (a, b) {
      var fa = weeksOf(a.slug)[0], fb = weeksOf(b.slug)[0];
      return (fa == null ? 99 : fa) - (fb == null ? 99 : fb) || a.order - b.order;
    });
    var tiles = {};
    sorted.forEach(function (b) {
      var ns = weeksOf(b.slug);
      var mark = h('span', { class: 'pr-tile-mark fu-badge', hidden: true });
      var a = link('pr-tile fu-card fu-card--lift fu-ch-' + chapterOf(ns[0]), '#drill/' + b.slug, [
        h('span', { class: 'pr-tile-w', text: span(ns) }),
        h('span', { class: 'pr-tile-t', text: b.topic }),
        h('span', { class: 'pr-tile-n', text: b.count + ' questions' }),
        mark
      ]);
      a.setAttribute('data-slug', b.slug);
      a.setAttribute('data-ch', chapterOf(ns[0]));
      tiles[b.slug] = { a: a, mark: mark, weeks: ns };
      grid.appendChild(h('li', { class: 'pr-tiles-i' }, [a]));
    });
    drill.appendChild(grid);
    drill.appendChild(h('p', { class: 'pr-more' }, [
      link('pr-link fu-btn fu-btn--link', '#drill', ['The full drill room, with what’s shaky'])
    ]));
    home.appendChild(drill);

    /* --- recall session --- */
    var sess = h('div', { class: 'pr-view pr-session', 'data-view': 'session', hidden: true });
    sess.appendChild(h('div', { class: 'pr-bar' }, [
      link('pr-back fu-btn fu-btn--ghost', '#practice', ['← Practice'], 'Back to practice'),
      h('h1', { class: 'pr-bar-t fu-h3', 'data-slot': 'sess-title', text: 'Recall' })
    ]));
    var host = h('div', { class: 'pr-player' });
    sess.appendChild(host);

    /* --- mixed drill --- */
    var mix = h('div', { class: 'pr-view pr-mix', 'data-view': 'mixed', hidden: true });
    var mixTitle = h('h1', { class: 'pr-bar-t fu-h3', text: 'Mixed' });
    var redraw = h('button', { type: 'button', class: 'pr-redraw fu-btn fu-btn--ghost', text: 'New draw' });
    redraw.addEventListener('click', function () { mountMixed(true); });
    mix.appendChild(h('div', { class: 'pr-bar' }, [
      link('pr-back fu-btn fu-btn--ghost', '#practice', ['← Practice'], 'Back to practice'), mixTitle, redraw
    ]));
    var mixLede = h('p', { class: 'pr-lede pr-mix-lede fu-voice' });
    mix.appendChild(mixLede);
    var mixStage = h('div', { class: 'pr-mix-stage' });
    mix.appendChild(mixStage);

    root.appendChild(home);
    root.appendChild(sess);
    root.appendChild(mix);
    el.appendChild(root);

    V.root = root;
    V.els = {
      home: home, sess: sess, mix: mix, host: host, big: big, sub: sub, start: start, foot: foot,
      mixedLabel: mixedLabel, mixedSub: mixedSub, mixedTile: mixed, tiles: tiles,
      mixTitle: mixTitle, mixLede: mixLede, mixStage: mixStage,
      sessTitle: sess.querySelector('[data-slot="sess-title"]')
    };
    V.built = true;

    window.addEventListener('tara:recall', paintRecall);
  }

  /* --------------------------------------------------- the Recall card --- */
  function plural(n, w) { return n + ' ' + (n === 1 ? w[0] : w[1]); }
  function paintRecall() {
    if (!V.built) return;
    var E = V.els, r = recall();
    var sum = r ? r.summary() : { due: 0, session: 0, minutes: 0, byKind: {}, total: 0, next: null };
    E.big.textContent = '';
    if (sum.due > 0) {
      E.big.className = 'pr-recall-big';
      E.big.appendChild(h('span', { class: 'pr-count fu-badge fu-badge--count', text: String(sum.due) }));
      E.big.appendChild(document.createTextNode(' due · about ' + sum.minutes + ' min'));
      var parts = [];
      ['concept', 'question', 'sentence'].forEach(function (k) { if (sum.byKind[k]) parts.push(plural(sum.byKind[k], KIND_WORD[k])); });
      E.sub.textContent = sum.due > sum.session
        ? 'the first ' + sum.session + ', then stop or keep going.'
        : parts.join(' · ');
      E.start.textContent = 'Start';
      E.start.removeAttribute('data-warm');
      E.start.className = 'pr-start fu-btn fu-btn--big';
      E.sub.hidden = !E.sub.textContent;
      E.foot.textContent = '';
      E.foot.hidden = true;
    } else {
      E.big.className = 'pr-recall-big pr-recall-big--calm fu-voice';
      E.big.textContent = sum.total ? 'nothing due. every bench starts like this.' : 'nothing to recall yet. misses and shaky cards land here.';
      E.sub.textContent = sum.next ? 'next: ' + sum.next.count + ' ' + sum.next.when + '.' : '';
      E.sub.hidden = !sum.next;
      E.start.textContent = 'Warm up anyway';
      E.start.setAttribute('data-warm', '1');
      E.start.className = 'pr-start fu-btn';
      E.foot.textContent = 'five quick ones from recent weeks.';
      E.foot.hidden = false;
    }
    V.root.setAttribute('data-due', String(sum.due));
  }

  /* --------------------------------------------------------- the tiles --- */
  function paintTiles() {
    if (!V.built) return;
    var nw = nowWeeks(), E = V.els;
    Object.keys(E.tiles).forEach(function (slug) {
      var t = E.tiles[slug], mark = '';
      if (nw.target != null && t.weeks.indexOf(nw.target) >= 0) mark = 'this week';
      else if (nw.justDone != null && t.weeks.indexOf(nw.justDone) >= 0) mark = 'just done';
      t.mark.textContent = mark;
      t.mark.hidden = !mark;
      t.mark.className = 'pr-tile-mark fu-badge' + (mark === 'this week' ? ' fu-badge--signal' : ' fu-badge--quiet');
      if (mark) t.a.setAttribute('data-mark', mark === 'this week' ? 'now' : 'done'); else t.a.removeAttribute('data-mark');
    });
    var rw = mixedWeeks();
    E.mixedLabel.textContent = span(rw.weeks);
    E.mixedSub.textContent = 'recent weeks, interleaved';
    E.mixedTile.setAttribute('aria-label', 'Mixed drill across ' + span(rw.weeks) + ', recent weeks interleaved');
  }
  function mixedWeeks() {
    var r = recall();
    var ns = r && r.recentWeeks ? r.recentWeeks(5) : [0];
    var slugs = r && r.banksOfWeeks ? r.banksOfWeeks(ns) : [];
    if (!slugs.length) slugs = ['week-01'];
    return { weeks: ns, slugs: slugs };
  }

  /* ------------------------------------------------------------- views --- */
  function show(name) {
    V.view = name;
    var E = V.els;
    E.home.hidden = name !== 'home';
    E.sess.hidden = name !== 'session';
    E.mix.hidden = name !== 'mixed';
    V.root.setAttribute('data-view', name);
  }

  function parseRest(route) {
    var rest = route && route.params && route.params.rest != null ? String(route.params.rest) : null;
    if (rest == null) {
      var raw = String((route && (route.raw || route.hash)) || location.hash || '').replace(/^#/, '');
      var m = /^practice(?:\/(.*))?$/.exec(raw);
      rest = m && m[1] ? m[1] : '';
    }
    try { rest = decodeURIComponent(rest); } catch (e) {}
    return rest.replace(/^\/+|\/+$/g, '').toLowerCase();
  }

  function openSession(warm) {
    var E = V.els, r = recall();
    show('session');
    E.sessTitle.textContent = warm ? 'Warm-up' : 'Recall';
    var st = V.player && V.player.state ? V.player.state() : null;
    var keep = st && !st.finished && st.phase !== 'load' && V.playerWarm === !!warm;
    if (keep) return;
    if (V.player && V.player.destroy) V.player.destroy();
    V.player = null;
    if (!r || typeof r.mountSession !== 'function') {
      E.host.textContent = '';
      E.host.appendChild(h('p', { class: 'pr-lede', text: 'recall is not in this build.' }));
      return;
    }
    V.playerWarm = !!warm;
    V.player = r.mountSession(E.host, {
      warm: !!warm,
      onExit: function () { go('#practice'); },
      onRestart: function (w) { V.playerWarm = !!w; E.sessTitle.textContent = w ? 'Warm-up' : 'Recall'; }
    });
  }

  /* ------------------------------------------------- the mixed drill ---- */
  var engineP = null;
  function loadEngine() {
    if (engineP) return engineP;
    if (window.TARA_QUIZ && window.TARA_QUIZ.__installed) { engineP = Promise.resolve(true); return engineP; }
    if (typeof APP.payload !== 'function') return Promise.resolve(false);
    engineP = APP.payload('engine').then(function (src) {
      if (window.TARA_QUIZ && window.TARA_QUIZ.__installed) return true;
      var s = document.createElement('script');
      s.textContent = src;                       /* inline, as the drill room does: no eval */
      (document.head || document.documentElement).appendChild(s);
      return !!(window.TARA_QUIZ && window.TARA_QUIZ.mount);
    }).catch(function () { engineP = null; return false; });
    return engineP;
  }
  function sessionSize() {
    var p = lsJSON(PREF_KEY);
    var n = p && Number(p.size);
    return n === 8 || n === 12 || n === 20 ? n : 12;
  }

  function mountMixed(force) {
    var E = V.els, rw = mixedWeeks();
    show('mixed');
    var label = span(rw.weeks);
    E.mixTitle.textContent = 'Mixed · ' + label;
    E.mixLede.textContent = 'questions from ' + rw.slugs.map(function (s) {
      var b = BYSLUG[s]; return (span(weeksOf(s)) + ' ' + (b ? b.topic : s)).trim();
    }).join(', ') + ', shuffled together.';
    var key = rw.slugs.join('|') + '|' + sessionSize();
    if (!force && V.mixed && V.mixed.key === key && V.mixed.inst && E.mixStage.contains(V.mixed.inst.el || E.mixStage.firstChild)) return Promise.resolve();
    E.mixStage.textContent = '';
    E.mixStage.appendChild(h('p', { class: 'pr-lede', text: 'shuffling…' }));
    return Promise.all([loadEngine(), Promise.all(rw.slugs.map(function (s) {
      return APP.payloadJSON('bank:' + s).then(function (b) { return { slug: s, bank: b }; }, function () { return null; });
    }))]).then(function (res) {
      var ok = res[0], banks = (res[1] || []).filter(function (x) { return x && x.bank && Array.isArray(x.bank.questions); });
      E.mixStage.textContent = '';
      if (!ok || !banks.length) {
        E.mixStage.appendChild(h('p', { class: 'pr-lede', text: ok ? 'those banks would not load. try a week tile instead.' : 'the quiz engine would not load, so there is nothing to drill right now.' }));
        return;
      }
      var concepts = [], seen = {}, home = {}, questions = [];
      banks.forEach(function (x) {
        (x.bank.concepts || []).forEach(function (c) { if (c && c.id && !seen[c.id]) { seen[c.id] = 1; concepts.push(c); } });
        x.bank.questions.forEach(function (q) { if (q && q.id) { questions.push(q); if (q.concept && !home[q.concept]) home[q.concept] = x.slug; } });
      });
      /* week: '' keeps the engine from writing a tara.quiz.<week> record for a
         bank that does not exist; per-question mastery is still recorded, so
         the drill room and Recall both see these answers. */
      var merged = { week: '', title: 'Mixed', arenaSections: [], concepts: concepts, questions: questions };
      var stage = h('div', { class: 'pr-mix-quiz' });
      E.mixStage.appendChild(stage);
      var inst = window.TARA_QUIZ.mount({
        el: stage, bank: merged, sessionSize: sessionSize(),
        onConcept: function (id) { if (home[id]) go('#drill/' + home[id] + '/' + encodeURIComponent(id)); }
      });
      V.mixed = { key: key, inst: inst };
      if (!inst) E.mixStage.appendChild(h('p', { class: 'pr-lede', text: 'that draw would not start. try a week tile instead.' }));
    });
  }

  /* -------------------------------------------------------------- mount --- */
  APP.registerSection({
    id: 'practice',
    title: 'Practice',
    navOrder: 20,

    mount: function (el, route) {
      if (!V.built) build(el);
      else if (!el.contains(V.root)) el.appendChild(V.root);
      var rest = parseRest(route || (APP.route && APP.route()));
      var head = rest.split('/')[0];
      if (head === 'recall') { openSession(rest.split('/')[1] === 'warm'); return; }
      if (head === 'warm') { openSession(true); return; }
      if (head === 'mixed') return mountMixed(false);
      show('home');
      paintRecall();
      paintTiles();
    },

    unmount: function () { /* the player and the mixed draw stay alive for a resume */ },

    /* Tiered text lives on the concept cards, and recall.js swaps it in place
       through APP.onTierChange; nothing here moves on a tier change. */
    onTier: function () {}
  });
})();
})();

/* ===== src/v2/library.js ===== */
;(function(){
/* src/v2/library.js — V2's Library, #library (owner: shell).
   A fixed grid of doors with counts, the search box on top. The doors never
   move; counts are read from the site's own indexes when they are at hand and
   otherwise show the numbers the site shipped with. Films and the Model Room
   open in the shell's viewer; "classic version" is V1 (index.html), in a new
   tab (and it says so), so this tab stays where it is. V1 in that tab stays V1:
   lab/hook.js hands index.html over to next.html only when it was reached from
   a film, 3D or Lab page, and a tab that copied tara.shell clears its own copy. */

'use strict';

var DOORS = [
  { id: 'map',     title: 'Map',          hash: '#map',                          count: '215 concepts',                    sub: 'Every idea in the course, and how they lean on each other.', tint: 'sky' },
  { id: 'films',   title: 'Films',        hash: '#view/intuition/index.html',    count: '28 films · 215 concept films',    sub: 'One idea per film, the real numbers on screen.', tint: 'butter' },
  { id: 'room',    title: 'Model Room',   hash: '#view/objects/index.html',      count: '28 objects · 215 twins',          sub: 'Hold the idea in 3D and turn it over.', tint: 'lilac' },
  { id: 'cases',   title: 'Cases',        hash: '#cases',                        count: '104 cases',                       sub: 'Worked cases in TARA’s week order.', tint: 'blush' },
  { id: 'packs',   title: 'Packs',        hash: '#packs',                        count: '13 packs',                        sub: 'The long read for each chapter, at your tier.', tint: 'mint' },
  { id: 'demos',   title: 'Demos',        hash: '#demos',                        count: '13 demos',                        sub: 'Poke one idea until it gives itself up.', tint: 'sea' },
  { id: 'plan',    title: 'Plan',         hash: '#plan',                         count: '14 Saturdays',                    sub: 'Pre-reads and exercises, any week.', tint: 'sky' },
  { id: 'sprint',  title: 'Sprint',       hash: '#sprint',                       count: '7 evenings',                      sub: 'The prerequisites, Python included.', tint: 'butter' },
  { id: 'manual',  title: 'Study agents', hash: '#manual',                       count: '6 agents · 7 commands',           sub: 'The Claude Code manual: what primes you before Saturday and makes you re-derive it after.', tint: 'mint' },
  { id: 'classic', title: 'Classic version', hash: 'index.html',                 count: 'opens in a new tab',              sub: 'The app before V2, beside this one: same ticks and tiers.', tint: 'paper', classic: true }
];

var counted = false;

function build(el) {
  if (el.getAttribute('data-built') === '1') return;
  el.setAttribute('data-built', '1');
  el.textContent = '';
  var E = APP.el;
  var pad = E('div', { 'class': 'app-sec-pad v2-lib' });

  pad.appendChild(E('h1', { 'class': 'v2-lib-h fu-h1', text: 'Library' }));

  var form = E('form', { 'class': 'v2-libsearch', role: 'search', autocomplete: 'off', id: 'v2-libsearchform', 'data-search-keep': '1' });
  var input = E('input', {
    'class': 'v2-libsearchbox fu-input', id: 'v2-libsearch', type: 'search', placeholder: 'search a concept, a case, a week',
    'aria-label': 'Search everything', spellcheck: 'false', enterkeyhint: 'search'
  });
  form.appendChild(input);
  pad.appendChild(form);
  wireSearch(form, input);

  var grid = E('ul', { 'class': 'v2-doors', 'aria-label': 'Everything in the library' });
  DOORS.forEach(function (d) {
    var li = E('li', { 'class': 'v2-doorli' });
    var a = E('a', { 'class': 'v2-door fu-card fu-card--lift', href: d.hash, 'data-door': d.id, 'data-tint': d.tint });
    if (d.classic) {
      a.setAttribute('data-v2-pass', '1');
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');
    }
    a.appendChild(E('span', { 'class': 'v2-door-t', text: d.title }));
    a.appendChild(E('span', { 'class': 'v2-door-c fu-label', 'data-count': d.id, text: d.count }));
    a.appendChild(E('span', { 'class': 'v2-door-s', text: d.sub }));
    li.appendChild(a);
    grid.appendChild(li);
  });
  pad.appendChild(grid);
  el.appendChild(pad);
}

function wireSearch(form, input) {
  var t = 0;
  function wide() { try { return window.matchMedia('(min-width: 720px)').matches; } catch (e) { return true; } }
  /* On a phone (< 720px) the results come as a sheet from the top with its own
     field; the library's box hands over to it rather than typing under it. */
  input.addEventListener('focus', function () {
    if (wide()) return;
    var v = input.value;
    input.blur();
    if (APP.focusSearch) APP.focusSearch(v);
  });
  input.addEventListener('input', function () {
    clearTimeout(t);
    var v = input.value;
    t = setTimeout(function () {
      if (!v.trim()) { if (APP.closeSearch) APP.closeSearch(); return; }
      if (APP.searchAnchor) APP.searchAnchor(form);
      APP.openSearch(v);
    }, 140);
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { input.blur(); if (APP.closeSearch) APP.closeSearch(); }
    if (e.key === 'ArrowDown') {
      var first = document.querySelector('#app-searchpanel .app-hit');
      if (first) { e.preventDefault(); first.focus(); }
    }
  });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = input.value.trim();
    if (!v) return;
    if (APP.searchAnchor) APP.searchAnchor(form);
    APP.navigate('search/' + encodeURIComponent(v));
  });
}

/* Counts from the site's own small indexes (cached by the service worker);
   the shipped numbers stay if any of them is missing. */
function countLive(el) {
  if (counted) return;
  counted = true;
  function set(id, text) {
    var c = el.querySelector('[data-count="' + id + '"]');
    if (c && text) c.textContent = text;
  }
  function getJSON(u) { return fetch(u, { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); }
  Promise.all([getJSON('intuition/films.json'), getJSON('objects/objects.json'), getJSON('intuition/nodes/index.json')]).then(function (r) {
    var films = Array.isArray(r[0]) ? r[0].length : null;
    var objs = Array.isArray(r[1]) ? r[1].filter(function (o) { return o && o.ready !== false; }).length : null;
    var nodes = r[2] && Array.isArray(r[2].nodes) ? r[2].nodes : null;
    var nf = nodes ? nodes.filter(function (n) { return n.film; }).length : null;
    var no = nodes ? nodes.filter(function (n) { return n.object; }).length : null;
    if (films != null && nf != null) set('films', films + ' films · ' + nf + ' concept films');
    if (objs != null && no != null) set('room', objs + ' objects · ' + no + ' twins');
    if (nodes) set('map', nodes.length + ' concepts');
  });
  var packs = (APP.packSlugs || []).length, demos = (APP.demoSlugs || []).length;
  if (packs) set('packs', packs + ' packs');
  if (demos) set('demos', demos + ' demos');
  var s = APP.schedule && APP.schedule();
  if (s && s.weeks) {
    var sats = s.weeks.filter(function (w) { return w.n >= 1; }).length;
    if (sats) set('plan', sats + ' Saturdays');
    if (s.sprint && s.sprint.days) set('sprint', s.sprint.days + ' evenings');
  }
}

APP.registerSection({
  id: 'library',
  title: 'Library',
  mount: function (el) {
    build(el);
    countLive(el);
  },
  onTier: function () {}
});
})();

/* ===== src/v2/lab.js ===== */
;(function(){
/* src/v2/lab.js — V2's Lab tab: #lab and #lab/<rest>. Owner: capstone.

   One page in fixed slots, top to bottom (nothing ever moves; text swaps in place):
     1. runway    the Capstone runway: days to the results freeze and to the talk, five
                  milestones with today's place marked, "your pick" (one line, kept on
                  this device only) and two links that open in claude.ai
     2. weeks     weeks 12 to 14: the plan's checklist (ticks shared with the plan and the
                  Weeks tab through tara.fourteen.v1) and the capstone pack, section by section
     3. talk-card the talk builder's card; #lab/talk is the builder itself
     4. door      the Lab (lab/index.html) in this same window, never in the viewer: it needs
                  its own window for the local Qwen server
     5. missions  this week's Lab missions (APP.paths.week(n).missions, else the Lab's own list)
     6. results   the three newest results from the 3090 bench (lab/findings/index.json)
   #lab/<block> (runway, weeks, talk-card, door, missions, results) and #lab/week-12..14
   open the page at that block.

   Also APP.capstone.summary(iso?) for Today's capstone slot (dates only, synchronous).

   Storage. Written: tara.v2.capstone = { v, pick, talk: { question, why, did, result, means,
   next } } (only what the learner types); tara.fourteen.v1 ticks w<N>p<k> / w<N>e<k>,
   re-read before every write, written only when its __order is "tara" (or when it is empty,
   which is exactly what the plan's own first run writes). Read: tara.lab.done (the Lab's
   mission ticks). Every storage call is wrapped; nothing here throws on a locked-down browser.

   Styling: the brand's fu-* components (src/brand/BRAND.md); lab-* classes are layout only.
   Public site: no capstone idea, no names, nothing personal in this file. */
(function () {
  'use strict';

  var APP = (window.APP = window.APP || {});

  /* ================================================================ constants */

  var START = '2026-11-28';          // W12: the project phase starts
  var RUNS = '2026-12-04';           // the last day for experiments (Fri)
  var FREEZE = '2026-12-05';         // W13: results freeze at 6pm
  var REHEARSE = '2026-12-06';       // rehearsal week, Sun 6 to Fri 11 Dec
  var REHEARSE_END = '2026-12-11';
  var TALK = '2026-12-12';           // W14: the talk
  var FREEZE_AT = Date.parse('2026-12-05T18:00:00+10:00');   // 6pm AEST (UTC+10), the course's time zone

  var KEY = 'tara.v2.capstone';
  var TICKS = 'tara.fourteen.v1';
  var LAB_DONE = 'tara.lab.done';

  var LAB = 'lab/index.html';
  var IDEAS_URL = 'https://claude.ai/artifact/33LioUpULRJHo7QZTevQFU';
  var PLAN_URL = 'https://claude.ai/artifact/XJzMjRkV1JhbMA7LYYAKbc';
  var PACK = 'capstone-weeks-12-14';

  var WPM = 150;                     // spoken words a minute
  var TALK_LO = 8, TALK_HI = 10;     // the talk, in minutes: the one place its length is set (the capstone pack's ten-minute slot)
  var METER_MAX = TALK_HI + 1;       // the meter's right end, in minutes
  var NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
  var SPAN_W = (NUM[TALK_LO] || TALK_LO) + ' to ' + (NUM[TALK_HI] || TALK_HI);   // 'five to seven'
  var SPAN_D = TALK_LO + ' to ' + TALK_HI;                                       // '5 to 7'

  /* The talk: six fixed parts. w is each part's share; aim (seconds) is that share of the
     middle of the talk's length (8 to 10 minutes: 45, 70, 115, 180, 90 and 45 s, about nine minutes). */
  var PARTS = [
    { id: 'question', title: 'The question', w: 2,
      prompt: 'one sentence, ending in a question mark. smaller than feels impressive.' },
    { id: 'why', title: 'Why it matters for alignment', w: 3,
      prompt: 'the risk it touches, in plain words. one reason is plenty.' },
    { id: 'did', title: 'What I did', w: 5,
      prompt: 'model, data, and the one thing you changed. picture the diagram.' },
    { id: 'result', title: 'The result and its control', w: 8,
      prompt: 'the number, and the control it beat. the control is what makes it a result.' },
    { id: 'means', title: 'What it means, and its limits', w: 4,
      prompt: 'what you can now say, and the bigger claim you are careful not to make.' },
    { id: 'next', title: "What's next", w: 2,
      prompt: "the experiment you'd run with another month. one is enough." }
  ];
  (function () {
    var units = 0, mid = (TALK_LO + TALK_HI) / 2 * 60;
    PARTS.forEach(function (p) { units += p.w; });
    PARTS.forEach(function (p) { p.aim = Math.round(p.w * mid / units / 5) * 5; });
  })();

  /* The runway's milestones, in their fixed places along the track (pos, 0..1). */
  var MS = [
    { id: 'start', date: START, pos: 0.08, when: '28 Nov', short: 'Start', long: 'Project phase starts', day: 'Saturday 28 November', week: 12 },
    { id: 'runs', date: RUNS, pos: 0.29, when: '4 Dec', short: 'Last runs', long: 'Last experiment runs', day: 'Friday 4 December' },
    { id: 'freeze', date: FREEZE, pos: 0.5, when: '5 Dec', short: 'Freeze 6pm', long: 'Results freeze, 6pm', day: 'Saturday 5 December', week: 13 },
    { id: 'rehearse', date: REHEARSE, pos: 0.71, when: '6–11 Dec', short: 'Rehearse', long: 'Rehearse the talk', day: 'Sunday 6 to Friday 11 December' },
    { id: 'talk', date: TALK, pos: 0.92, when: '12 Dec', short: 'Talk', long: 'The talk', day: 'Saturday 12 December', week: 14 }
  ];
  var LEAD_IN = 21;                  // days before the start over which today's pin creeps in

  /* The capstone pack's sections as of this build, so the list has its height on first
     paint; the pack payload is read on first open and replaces it if it ever changes. */
  var PACK_FALLBACK = [
    ['budget', '00', 'What you actually have'], ['early', '01', 'Pick early, not at week 12'],
    ['projects', '02', 'The candidate list'], ['scoping', '03', 'Cutting a question until it fits'],
    ['derisk', '04', 'The de-risking checklist'], ['weeks', '05', 'The three weeks, day by day'],
    ['hygiene', '06', 'Research hygiene'], ['talk', '07', 'The ten minutes you are graded on'],
    ['claims', '08', 'Not overclaiming'], ['resources', '09', 'Resources'], ['card', '10', 'The one-page card']
  ];

  var KINDS = { steer: 'Steering', probe: 'Probe', features: 'Features', diff: 'Model diff',
    circuit: 'Circuit', graph: 'Attribution graph' };

  var BLOCKS = { runway: 1, weeks: 1, 'talk-card': 1, door: 1, missions: 1, results: 1 };

  /* ==================================================================== dates */

  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
    'October', 'November', 'December'];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var DOWL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function isISO(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
  function localISO(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function overrideISO() {
    try { if (typeof APP.dateOverride === 'function') return APP.dateOverride() || null; } catch (e) { /* */ }
    try {
      var m = /[?&]today=(\d{4}-\d{2}-\d{2})(?:&|$)/.exec(location.search || '');
      return m ? m[1] : null;
    } catch (e) { return null; }
  }
  /* The shell's today (it honours ?today=YYYY-MM-DD); the same rule when it is absent. */
  function todayISO() {
    try {
      if (typeof APP.todayISO === 'function') { var t = APP.todayISO(); if (isISO(t)) return t; }
    } catch (e) { /* */ }
    return overrideISO() || localISO(new Date());
  }
  function utc(iso) { var p = iso.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function days(a, b) { return Math.round((utc(b) - utc(a)) / 864e5); }
  function dateOf(iso) { var p = iso.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function isoAdd(iso, n) { var d = dateOf(iso); d.setDate(d.getDate() + n); return localISO(d); }
  function pretty(iso) { var d = dateOf(iso); return DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MON[d.getMonth()]; }
  function dayMonth(iso) { var d = dateOf(iso); return d.getDate() + ' ' + MON[d.getMonth()]; }
  function longDate(iso) { var d = dateOf(iso); return DOWL[d.getDay()] + ' ' + d.getDate() + ' ' + MONL[d.getMonth()]; }

  /* Frozen as of today t. On 5 Dec itself it is the clock that decides, unless a date is
     being tried out with ?today= (no clock then: the freeze is still ahead, at 6pm). */
  function isFrozen(t) {
    if (t > FREEZE) return true;
    if (t < FREEZE) return false;
    return !overrideISO() && Date.now() >= FREEZE_AT;
  }

  /* The week this is about: the shell's target (the next Saturday, today if it is one). */
  function targetWeek(t) {
    try {
      if (typeof APP.v2now === 'function') {
        var v = APP.v2now(t);
        if (v && v.target && typeof v.target === 'object' && v.target.n != null) return Number(v.target.n);
        if (v && typeof v.target === 'number') return v.target;
        if (v && !v.target && v.phase === 'after') return null;
      }
    } catch (e) { /* */ }
    var n = Math.ceil(days('2026-09-05', t) / 7);       // W0 is Sat 5 Sep; one Saturday a week
    return n > 14 ? null : Math.max(0, n);
  }
  function saturdayOf(n) {
    try { var w = typeof APP.weekByN === 'function' && APP.weekByN(n); if (w && isISO(w.saturday)) return w.saturday; } catch (e) { /* */ }
    return isoAdd('2026-09-05', 7 * n);
  }

  /* The next milestone, for Today's capstone slot. */
  function nextMilestone(t) {
    if (t <= START) return { title: 'Project phase starts', date: START, hash: '#lab/week-12' };
    if (t <= RUNS) return { title: 'Experiments wrap up', date: RUNS, hash: '#lab/week-12' };
    if (!isFrozen(t)) return { title: 'Results freeze at 6pm', date: FREEZE, hash: '#lab/week-13' };
    return { title: 'The talk', date: TALK, hash: '#lab/talk' };
  }

  APP.capstone = APP.capstone || {};
  APP.capstone.summary = function (iso) {
    var t = isISO(iso) ? iso : todayISO();
    return {
      freeze: FREEZE,
      talk: TALK,
      daysToFreeze: days(t, FREEZE),
      daysToTalk: days(t, TALK),
      next: nextMilestone(t)
    };
  };

  /* Today's place on the track (0..1), between the milestones' fixed places. */
  function pinPos(t) {
    if (t > TALK) return 0.98;
    if (t < START) return Math.max(0, MS[0].pos * (1 - days(t, START) / LEAD_IN));
    for (var i = MS.length - 1; i >= 0; i--) {
      if (t >= MS[i].date) {
        if (i === MS.length - 1) return MS[i].pos;
        var span = days(MS[i].date, MS[i + 1].date);
        var f = span > 0 ? days(MS[i].date, t) / span : 0;
        return MS[i].pos + f * (MS[i + 1].pos - MS[i].pos);
      }
    }
    return 0;
  }

  /* ================================================================== storage */

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function readJSON(k) {
    var raw = lsGet(k);
    if (raw == null) return { ok: true, absent: true, value: {} };
    try {
      var v = JSON.parse(raw);
      return v && typeof v === 'object' && !Array.isArray(v) ? { ok: true, value: v } : { ok: false, value: {} };
    } catch (e) { return { ok: false, value: {} }; }
  }

  /* --- the learner's own lines: tara.v2.capstone */
  function readCap() {
    var v = readJSON(KEY).value;
    var talk = v.talk && typeof v.talk === 'object' ? v.talk : {};
    var out = { v: 1, pick: typeof v.pick === 'string' ? v.pick : '', talk: {} };
    PARTS.forEach(function (p) { out.talk[p.id] = typeof talk[p.id] === 'string' ? talk[p.id] : ''; });
    return out;
  }
  /* re-read, change, write: two tabs typing into two different parts both keep their words */
  function writeCap(change) {
    var c = readCap();
    change(c);
    return lsSet(KEY, JSON.stringify(c));
  }

  /* --- the plan's ticks: tara.fourteen.v1, shared with the plan and the Weeks tab.
     Never held in memory between writes: every read and every write starts from storage. */
  function readTicks() { return readJSON(TICKS); }
  function setTick(k, on) {
    var r = readTicks();
    if (!r.ok) return false;
    var s = r.value;
    var empty = Object.keys(s).length === 0;
    if (s.__order !== 'tara' && !empty) return false;     // older ticks wait for the plan to move them
    s.__order = 'tara';
    if (on) s[k] = 1; else delete s[k];
    if (!lsSet(TICKS, JSON.stringify(s))) return false;
    /* a plan frame kept alive by the shell holds the old ticks in memory; it reloads fresh */
    try { if (APP.frames && typeof APP.frames.drop === 'function' && APP.frames.has && APP.frames.has('plan')) APP.frames.drop('plan'); } catch (e) { /* */ }
    try { window.dispatchEvent(new CustomEvent('tara:ticks', { detail: { key: k, on: !!on, source: 'lab' } })); } catch (e) { /* */ }
    return true;
  }

  function labDone() { var r = readJSON(LAB_DONE); return r.ok ? r.value : {}; }

  /* ================================================================== helpers */

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    if (kids) add(n, kids);
    return n;
  }
  function add(n, kids) {
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) add(n, c);
      else n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
  }
  function sr(text) { return el('span', { 'class': 'fu-sr', text: text }); }
  function toast(msg) { try { if (typeof APP.toast === 'function') APP.toast(msg); } catch (e) { /* */ } }
  function withTimeout(p, ms) {
    return Promise.race([Promise.resolve(p).catch(function () { return null; }),
      new Promise(function (res) { setTimeout(function () { res(null); }, ms); })]);
  }
  function capFirst(s) { s = String(s || '').trim(); return s.charAt(0).toUpperCase() + s.slice(1); }
  function plural(n, one, many) { return n === 1 ? one : many; }

  /* Authored HTML from a payload (the plan's checklist items) as safe nodes: text, plus b,
     strong, i, em and code. Everything else is flattened to its text. */
  var KEEP = { B: 1, STRONG: 1, I: 1, EM: 1, CODE: 1 };
  function richText(html) {
    var tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');           // inert: nothing in a template runs or loads
    var frag = document.createDocumentFragment();
    (function walk(src, dst) {
      for (var c = src.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) dst.appendChild(document.createTextNode(c.nodeValue));
        else if (c.nodeType === 1) {
          if (KEEP[c.tagName]) {
            var e = document.createElement(c.tagName.toLowerCase());
            if (c.tagName === 'CODE') e.className = 'fu-code';
            walk(c, e);
            dst.appendChild(e);
          } else walk(c, dst);
        }
      }
    })(tpl.content, frag);
    return frag;
  }

  /* A JavaScript literal (arrays, objects, strings, numbers; identifiers read as null),
     enough to read the plan's `var WEEKS = [...]` without running any of its code. */
  function readLiteral(src, at) {
    var i = at;
    function ws() {
      for (;;) {
        var c = src[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
        if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
        if (c === '/' && src[i + 1] === '*') { var e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
        return;
      }
    }
    function str() {
      var q = src[i++], out = '';
      while (i < src.length) {
        var c = src[i++];
        if (c === q) return out;
        if (c !== '\\') { out += c; continue; }
        var n = src[i++];
        if (n === 'n') out += '\n';
        else if (n === 't') out += '\t';
        else if (n === 'u') { out += String.fromCharCode(parseInt(src.substr(i, 4), 16)); i += 4; }
        else if (n !== '\n') out += n;
      }
      throw new Error('unterminated string');
    }
    function val() {
      ws();
      var c = src[i], m;
      if (c === '[') {
        i++;
        var arr = [];
        for (;;) {
          ws();
          if (src[i] === ']') { i++; return arr; }
          arr.push(val()); ws();
          if (src[i] === ',') i++;
          else if (src[i] !== ']') throw new Error('expected , or ] at ' + i);
        }
      }
      if (c === '{') {
        i++;
        var obj = {};
        for (;;) {
          ws();
          if (src[i] === '}') { i++; return obj; }
          var key;
          if (src[i] === '"' || src[i] === "'") key = str();
          else {
            m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 80));
            if (!m) throw new Error('bad key at ' + i);
            key = m[0]; i += key.length;
          }
          ws();
          if (src[i] !== ':') throw new Error('expected : at ' + i);
          i++;
          obj[key] = val(); ws();
          if (src[i] === ',') i++;
          else if (src[i] !== '}') throw new Error('expected , or } at ' + i);
        }
      }
      if (c === '"' || c === "'") {
        var s = str(); ws();
        while (src[i] === '+') { i++; s += String(val()); ws(); }
        return s;
      }
      if ((m = /^-?\d+(?:\.\d+)?/.exec(src.slice(i, i + 40)))) { i += m[0].length; return Number(m[0]); }
      if ((m = /^[A-Za-z_$][\w$.]*/.exec(src.slice(i, i + 200)))) {
        i += m[0].length;
        return m[0] === 'true' ? true : m[0] === 'false' ? false : null;
      }
      throw new Error('unexpected ' + JSON.stringify(c) + ' at ' + i);
    }
    return val();
  }

  /* =================================================================== loaders */
  /* Content only (never ticks): the plan's weeks 12-14, the pack's sections, the missions
     and the bench's index, each read once per page load. */

  var _plan = null, _pack = null, _results = null, _missions = {};

  function loadPlan() {
    if (_plan) return _plan;
    _plan = Promise.resolve().then(function () {
      if (typeof APP.payload !== 'function') return null;
      return APP.payload('plan');
    }).then(function (html) {
      if (!html) return null;
      var m = /var\s+WEEKS\s*=\s*\[/.exec(html);
      if (!m) return null;
      var weeks = readLiteral(html, m.index + m[0].length - 1);
      var out = {};
      (weeks || []).forEach(function (w) {
        if (!w || w.n < 12 || w.n > 14) return;
        out[w.n] = {
          n: w.n, date: w.d,
          title: capFirst(String(w.title || '').split(/\s+—\s+/).pop()),
          stage: String(w.chL || '').split('·').pop().trim(),
          pre: Array.isArray(w.pre) ? w.pre : [], ex: Array.isArray(w.ex) ? w.ex : [],
          check: w.check || '', skip: w.skip || ''
        };
      });
      return out[12] && out[13] && out[14] ? out : null;
    }).catch(function (e) { console.warn('lab: the plan checklist did not load', e); _plan = null; return null; });
    return _plan;
  }

  function loadPack() {
    if (_pack) return _pack;
    _pack = Promise.resolve().then(function () {
      if (typeof APP.payload !== 'function') return null;
      return APP.payload('pack:' + PACK);
    }).then(function (html) {
      if (!html || typeof DOMParser !== 'function') return null;
      var doc = new DOMParser().parseFromString(html, 'text/html');   // inert: nothing loads or runs
      var out = [];
      Array.prototype.forEach.call(doc.querySelectorAll('section[id]'), function (s) {
        var h2 = s.querySelector('h2');
        if (!h2 || !s.id) return;
        var num = h2.querySelector('.num');
        var kick = num ? num.textContent.trim() : '';
        var title = h2.textContent.replace(kick, '').replace(/\s+/g, ' ').trim();
        var m = /^(\d+)\s*\/\s*/.exec(kick);
        if (title) out.push([s.id, m ? m[1] : '', title]);
      });
      return out.length ? out : null;
    }).catch(function (e) { console.warn('lab: the capstone pack did not load', e); _pack = null; return null; });
    return _pack;
  }

  function loadResults() {
    if (_results) return _results;
    _results = fetch(new URL('lab/findings/index.json', document.baseURI).href, { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (idx) {
        var packs = idx && Array.isArray(idx.packs) ? idx.packs.slice() : [];
        packs = packs.filter(function (p) { return p && p.id; });
        packs.sort(function (a, b) { return String(b.created || '').localeCompare(String(a.created || '')); });
        return packs.slice(0, 3);
      })
      .catch(function () { _results = null; return null; });
    return _results;
  }

  /* This week's missions: the paths builder's list when it has one, else the Lab's own. */
  function loadMissions(n) {
    if (n == null) return Promise.resolve(null);
    if (_missions[n]) return _missions[n];
    _missions[n] = Promise.resolve().then(function () {
      var P = APP.paths;
      if (!P || typeof P.week !== 'function') return null;
      return withTimeout(P.ready, 2500).then(function () {
        var w = P.week(n);
        return w && Array.isArray(w.missions) && w.missions.length ? w.missions : null;
      });
    }).catch(function () { return null; }).then(function (list) {
      if (list) return list;
      return import(new URL('lab/ui/missions.js', document.baseURI).href).then(function (mod) {
        var fn = mod && mod.missionsFor;
        return typeof fn === 'function' ? fn(n) : null;
      }).catch(function () { return null; });
    }).then(function (list) {
      if (!list) _missions[n] = null;
      return list;
    });
    return _missions[n];
  }

  /* The Lab's own hash for a mission, built the way lab/ui/app.js builds it. */
  function labHash(view, parts, params) {
    var p = [view].concat(parts || []).map(encodeURIComponent).join('/');
    var q = Object.keys(params || {}).filter(function (k) {
      var v = params[k]; return v !== undefined && v !== null && v !== '';
    }).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    return '#' + p + (q ? '?' + q : '');
  }
  function labLink(h) {
    h = String(h || '');
    if (h.charAt(0) === '#') return LAB + h;
    var m = /^(?:\.\.\/|\.\/)?lab\/(?:index\.html)?(#.*)?$/.exec(h);
    if (m) return LAB + (m[1] || '');
    return h;
  }
  /* Straight into the tool or the result. paths.json gives `tool` as a ready link
     ("lab/index.html#tool/steer?preset=rude") and `href` as the week's missions page; the
     Lab's own list gives `tool` as an id with `params`, or a `result` id. */
  function missionHref(m) {
    var t = typeof m.tool === 'string' ? m.tool : '';
    if (t && /[#\/]/.test(t)) return labLink(t);
    if (t) return LAB + labHash('tool', [t], m.params || {});
    if (m.result) return LAB + '#results/' + encodeURIComponent(m.result);
    if (m.href) return labLink(m.href);
    return LAB + '#about';
  }

  function modelName(s) {
    s = String(s || '');
    if (s === 'gpt2') return 'GPT-2 small';
    var q = /^qwen(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)b(-base)?$/i.exec(s);
    return q ? 'Qwen ' + q[1] + ' ' + q[2] + 'B' + (q[3] ? ' base' : '') : s;
  }

  /* ==================================================================== build */

  function block(id, label, cls, kids) {
    return el('section', { 'class': 'lab-block lab-b-' + id + (cls ? ' ' + cls : ''), id: 'lab-' + id, 'aria-label': label, 'data-block': id }, kids);
  }
  function head(title, aside) {
    return el('div', { 'class': 'lab-head' }, [el('h2', { 'class': 'fu-h2', text: title }), aside || null]);
  }
  function more(href, text) {
    return el('a', { 'class': 'fu-btn fu-btn--link lab-more', href: href }, [text, el('span', { 'aria-hidden': 'true', text: ' →' })]);
  }

  function buildRunway(ui) {
    var tiles = el('div', { 'class': 'lab-tiles' });
    ui.tiles = {};
    ['freeze', 'talk'].forEach(function (id) {
      var big = el('span', { 'class': 'lab-tile-big', 'aria-hidden': 'true' });
      var lbl = el('span', { 'class': 'lab-tile-k', 'aria-hidden': 'true' });
      var sub = el('span', { 'class': 'lab-tile-s', 'aria-hidden': 'true' });
      var said = el('span', { 'class': 'fu-sr' });
      var t = el('div', { 'class': 'fu-card fu-card--flat lab-tile lab-tile-' + id }, [big, lbl, sub, said]);
      tiles.appendChild(t);
      ui.tiles[id] = { box: t, big: big, k: lbl, s: sub, said: said };
    });

    var track = el('div', { 'class': 'lab-track', 'aria-hidden': 'true' });
    var bar = el('span', { 'class': 'fu-progress fu-progress--thin lab-track-bar' }, [el('span', { 'class': 'fu-progress__fill lab-track-fill' })]);
    track.appendChild(bar);
    ui.fill = bar.firstChild;
    ui.ticks = [];
    MS.forEach(function (m) {
      var tick = el('span', { 'class': 'fu-tick lab-ms-tick' });
      var dot = el('span', { 'class': 'lab-ms', 'data-ms': m.id, style: 'left:' + (m.pos * 100) + '%' }, [
        tick,
        el('span', { 'class': 'lab-ms-t' }, [
          el('b', { 'class': 'lab-ms-date', text: m.when }),
          el('span', { 'class': 'lab-ms-short', text: m.short }),
          el('span', { 'class': 'lab-ms-long', text: m.long })
        ])
      ]);
      track.appendChild(dot);
      ui.ticks.push({ box: dot, tick: tick });
    });
    ui.pinT = el('span', { 'class': 'fu-badge fu-badge--signal lab-pin-t' });
    ui.pin = el('span', { 'class': 'lab-pin' }, [ui.pinT, el('span', { 'class': 'lab-pin-stem' })]);
    track.appendChild(ui.pin);

    /* the same five milestones as a list, for screen readers */
    ui.msList = el('ol', { 'class': 'fu-sr' });
    MS.forEach(function () { ui.msList.appendChild(el('li')); });

    ui.pick = el('input', {
      'class': 'fu-input lab-pick-in', id: 'lab-pick-in', type: 'text', maxlength: '160', autocomplete: 'off',
      spellcheck: 'true', enterkeyhint: 'done', placeholder: 'your question, in one line',
      'aria-describedby': 'lab-pick-note'
    });
    var pick = el('div', { 'class': 'lab-pick' }, [
      el('label', { 'class': 'fu-label lab-pick-k', 'for': 'lab-pick-in', text: 'Your pick' }),
      ui.pick,
      el('p', { 'class': 'fu-small fu-muted lab-fine', id: 'lab-pick-note', text: 'kept on this device only. never sent anywhere.' })
    ]);

    function ext(href, text) {
      return el('a', { 'class': 'fu-btn fu-btn--ghost lab-ext', href: href, target: '_blank', rel: 'noopener' },
        [text, el('span', { 'class': 'lab-ext-ico', 'aria-hidden': 'true', text: '↗' }), sr(' (opens claude.ai in a new tab)')]);
    }
    var links = el('div', { 'class': 'lab-links' }, [ext(IDEAS_URL, 'Your ideas form'), ext(PLAN_URL, 'The Lab research plan')]);

    ui.status = el('p', { 'class': 'fu-voice lab-status' });
    return block('runway', 'Capstone runway', 'fu-window', [
      el('header', { 'class': 'fu-titlebar' }, [el('span', { 'class': 'fu-titlebar__title', text: 'Capstone runway' })]),
      el('div', { 'class': 'fu-window__body lab-runway-body' }, [
        el('h1', { 'class': 'fu-h1 lab-h1', text: 'Three Saturdays and a talk' }),
        ui.status,
        tiles,
        track,
        ui.msList,
        pick,
        links
      ])
    ]);
  }

  function checkItem(n, kind, k, html) {
    var key = 'w' + n + kind + k;
    var box = el('input', { type: 'checkbox', 'class': 'fu-sr lab-check-box', 'data-k': key });
    var tick = el('span', { 'class': 'fu-tick lab-tick', 'aria-hidden': 'true' });
    var li = el('li', { 'class': 'lab-check' }, [el('label', { 'class': 'lab-check-l' }, [box, tick, el('span', { 'class': 'lab-check-t' }, [richText(html)])])]);
    return { li: li, box: box, tick: tick, key: key };
  }

  function buildWeeks(ui, plan, t) {
    ui.boxes = [];
    ui.weekBtns = {};
    ui.weekPanels = {};
    ui.weekDots = {};
    var seg = el('div', { 'class': 'fu-seg fu-seg--wide lab-wkpick', role: 'group', 'aria-label': 'Show one week' });
    var grid = el('div', { 'class': 'lab-wkgrid' });
    var titles = { 12: 'Get a number on the board', 13: 'Scope freeze', 14: 'Final project presentations' };
    [12, 13, 14].forEach(function (n) {
      var w = plan && plan[n];
      var sat = saturdayOf(n);
      var dots = el('span', { 'class': 'lab-dots', 'aria-hidden': 'true' });
      var btn = el('button', { type: 'button', 'class': 'fu-seg__opt lab-wkbtn', 'aria-pressed': 'false', 'aria-controls': 'lab-wk-' + n, 'data-n': String(n) }, [
        el('b', { text: 'W' + n }), el('span', { 'class': 'fu-seg__sub', text: dayMonth(sat) }), dots
      ]);
      btn.addEventListener('click', function () { selectWeek(ui, n); });
      seg.appendChild(btn);
      ui.weekBtns[n] = btn;
      ui.weekDots[n] = dots;

      var panel = el('article', { 'class': 'fu-card lab-wk', id: 'lab-wk-' + n, 'data-n': String(n), 'aria-labelledby': 'lab-wk-h-' + n });
      panel.appendChild(el('p', { 'class': 'fu-label lab-wk-k', text: 'W' + n + ' · ' + pretty(sat) + (w && w.stage ? ' · ' + w.stage : '') }));
      panel.appendChild(el('h3', { 'class': 'fu-h3 lab-wk-h', id: 'lab-wk-h-' + n, text: (w && w.title) || titles[n] }));
      if (!w) {
        panel.appendChild(el('p', { 'class': 'fu-small lab-fine', text: 'the checklist lives in the plan.' }));
      } else {
        [['p', w.pre, 'Before Saturday'], ['e', w.ex, 'On the day']].forEach(function (L) {
          if (!L[1].length) return;
          var ul = el('ul', { 'class': 'lab-checks', 'aria-label': 'W' + n + ', ' + L[2].toLowerCase() });
          L[1].forEach(function (html, k) {
            var c = checkItem(n, L[0], k, html);
            ui.boxes.push(c);
            ul.appendChild(c.li);
            dots.appendChild(el('i', { 'data-k': c.key }));
          });
          panel.appendChild(el('p', { 'class': 'fu-label lab-wk-sub', text: L[2] }));
          panel.appendChild(ul);
        });
        if (w.check) panel.appendChild(el('p', { 'class': 'fu-small lab-wk-note' }, [el('b', { text: 'Done when: ' }), richText(w.check)]));
        if (w.skip) panel.appendChild(el('p', { 'class': 'fu-small lab-wk-note' }, [el('b', { text: 'Skip: ' }), richText(w.skip)]));
      }
      panel.appendChild(more('#plan/week-' + n, 'W' + n + ' in the plan'));
      grid.appendChild(panel);
      ui.weekPanels[n] = panel;
    });

    ui.tickNote = el('p', { 'class': 'fu-small lab-ticknote', hidden: true }, [
      'some older ticks are waiting to move across. ', el('a', { href: '#plan/week-12', text: 'open the plan once' }), ', then tick here.'
    ]);

    /* the capstone pack, section by section (fixed rows; text swaps in when the pack loads) */
    ui.packList = el('nav', { 'class': 'lab-pack', 'aria-label': 'The capstone pack' });
    fillPack(ui, PACK_FALLBACK);
    ui.packCount = el('span', { 'class': 'fu-badge fu-badge--quiet lab-pack-count' });
    var packBox = el('details', { 'class': 'fu-card lab-packbox' }, [
      el('summary', { 'class': 'lab-pack-sum' }, [el('span', { 'class': 'fu-h3', text: 'The capstone pack' }), ui.packCount]),
      ui.packList
    ]);
    ui.packBox = packBox;
    try { if (window.matchMedia && window.matchMedia('(min-width: 720px)').matches) packBox.open = true; } catch (e) { /* */ }

    grid.addEventListener('change', function (e) {
      var b = e.target;
      if (!b || !b.matches || !b.matches('input.lab-check-box')) return;
      var k = b.getAttribute('data-k');
      if (setTick(k, b.checked)) { ui.tickNote.hidden = true; paintTicks(ui); }
      else {
        b.checked = !b.checked;
        ui.tickNote.hidden = false;
        toast('open the plan once so your older ticks move across.');
      }
    });

    selectWeek(ui, defaultWeek(t));
    var nowWeek = targetWeek(t);
    if (ui.weekPanels[nowWeek]) ui.weekPanels[nowWeek].setAttribute('data-now', '1');
    return block('weeks', 'Weeks 12 to 14', '', [
      head('Weeks 12 to 14', more('#plan/week-12', 'The plan')),
      seg,
      grid,
      ui.tickNote,
      packBox
    ]);
  }

  function fillPack(ui, rows) {
    var have = ui.packList.children;
    var same = have.length === rows.length;
    for (var i = 0; same && i < rows.length; i++) if (have[i].getAttribute('data-id') !== rows[i][0]) same = false;
    if (same) {
      for (var j = 0; j < rows.length; j++) {
        have[j].querySelector('.lab-pack-n').textContent = rows[j][1];
        have[j].querySelector('.lab-pack-t').textContent = rows[j][2];
      }
    } else {
      ui.packList.textContent = '';
      rows.forEach(function (r) {
        ui.packList.appendChild(el('a', { 'class': 'fu-item lab-pack-a', href: '#' + PACK + '/' + r[0], 'data-id': r[0] }, [
          el('span', { 'class': 'fu-badge fu-ch-project lab-pack-n', 'aria-hidden': 'true', text: r[1] }),
          el('span', { 'class': 'lab-pack-t', text: r[2] })
        ]));
      });
    }
    if (ui.packCount) ui.packCount.textContent = rows.length + ' sections';
  }

  function defaultWeek(t) {
    var n = targetWeek(t);
    if (n == null) return 14;
    return n < 12 ? 12 : n > 14 ? 14 : n;
  }
  /* On a phone one week shows at a time under the three week buttons (the buttons never
     move); on a wide screen all three stand side by side and the buttons are hidden. */
  function selectWeek(ui, n) {
    ui.week = n;
    [12, 13, 14].forEach(function (m) {
      ui.weekBtns[m].setAttribute('aria-pressed', m === n ? 'true' : 'false');
      ui.weekPanels[m].setAttribute('data-on', m === n ? '1' : '0');
    });
  }

  function paintTicks(ui) {
    var s = readTicks().value || {};
    ui.boxes.forEach(function (c) {
      var on = !!s[c.key];
      c.box.checked = on;
      c.tick.classList.toggle('is-on', on);
      c.li.setAttribute('data-done', on ? '1' : '0');
    });
    [12, 13, 14].forEach(function (n) {
      var dots = ui.weekDots[n].children, done = 0;
      for (var i = 0; i < dots.length; i++) {
        var on = !!s[dots[i].getAttribute('data-k')];
        dots[i].className = on ? 'on' : '';
        if (on) done++;
      }
      ui.weekBtns[n].setAttribute('aria-label', 'Week ' + n + ', ' + longDate(saturdayOf(n)) +
        (dots.length ? ': ' + done + ' of ' + dots.length + ' ticked' : ''));
    });
  }

  function buildTalkCard(ui) {
    ui.talkCardS = el('span', { 'class': 'fu-small lab-card-s' });
    return block('talk-card', 'Talk builder', '', [
      el('a', { 'class': 'fu-card fu-card--lift lab-card lab-talkcard', href: '#lab/talk' }, [
        el('span', { 'class': 'fu-label lab-card-k', text: 'Talk builder' }),
        el('span', { 'class': 'fu-h3 lab-card-t', text: 'Your talk, in six parts' }),
        ui.talkCardS,
        el('span', { 'class': 'lab-card-go', 'aria-hidden': 'true', text: '→' })
      ])
    ]);
  }

  function flask() {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 48 48'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
    s.setAttribute('class', 'lab-door-ico');
    s.innerHTML = '<path d="M18 5h12M20 5v14L8.6 38.4A4 4 0 0 0 12 44.5h24a4 4 0 0 0 3.4-6.1L28 19V5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M13.6 30.5h20.8l5 8A4 4 0 0 1 36 44.5H12a4 4 0 0 1-3.4-6.1z" fill="var(--signal)" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/>' +
      '<circle cx="21" cy="37" r="2" fill="#141A24"/><circle cx="28.5" cy="34.6" r="1.4" fill="#141A24"/>';
    return s;
  }

  function buildDoor() {
    return block('door', 'The Lab', '', [
      el('a', { 'class': 'fu-card fu-card--lift lab-door', href: LAB, 'data-v2-pass': '1' }, [
        el('span', { 'class': 'lab-door-top' }, [
          flask(),
          el('span', { 'class': 'lab-door-body' }, [
            el('span', { 'class': 'fu-label lab-card-k', text: 'The Lab' }),
            el('span', { 'class': 'fu-small lab-door-line', text: 'Twelve tools that take a real language model apart: GPT-2 in this browser, or Qwen 3.5 9B on your 3090.' })
          ])
        ]),
        el('span', { 'class': 'fu-btn fu-btn--big lab-door-btn' }, ['Open the Lab', el('span', { 'aria-hidden': 'true', text: ' →' })])
      ])
    ]);
  }

  function buildMissions(ui, n, list) {
    ui.missionCards = [];
    var grid = el('div', { 'class': 'lab-mgrid' });
    var wk = n == null ? 14 : n;
    if (list && list.length) {
      list.forEach(function (m) {
        if (!m || !m.title) return;
        var done = el('span', { 'class': 'fu-badge fu-badge--gold lab-done', hidden: true }, [el('span', { 'aria-hidden': 'true', text: '✓ ' }), 'done in the Lab']);
        var a = el('a', { 'class': 'fu-card fu-card--lift lab-card lab-mission', href: missionHref(m), 'data-v2-pass': '1', 'data-id': m.id || '' }, [
          el('span', { 'class': 'fu-label lab-card-k', text: 'W' + wk + ' mission' }),
          el('span', { 'class': 'fu-h3 lab-card-t', text: m.title }),
          (m.why || m.sub) ? el('span', { 'class': 'fu-small lab-card-s lab-clamp', text: m.why || m.sub }) : null,
          done,
          el('span', { 'class': 'lab-card-go', 'aria-hidden': 'true', text: '→' })
        ]);
        grid.appendChild(a);
        ui.missionCards.push({ a: a, id: m.id, done: done });
      });
    } else {
      grid.appendChild(el('div', { 'class': 'fu-empty lab-empty' }, [el('p', { 'class': 'fu-empty__line', text: 'this week\'s missions are waiting in the Lab.' })]));
    }
    return block('missions', "This week's missions", '', [
      head("This week's missions", el('span', { 'class': 'fu-label lab-head-k', text: 'W' + wk + ' · ' + pretty(saturdayOf(wk)) })),
      grid,
      el('a', { 'class': 'fu-btn fu-btn--link lab-more', href: LAB + '#missions/week-' + wk, 'data-v2-pass': '1' },
        ['All week ' + wk + ' missions in the Lab', el('span', { 'aria-hidden': 'true', text: ' →' })])
    ]);
  }

  function paintMissionsDone(ui) {
    var d = labDone();
    (ui.missionCards || []).forEach(function (c) {
      var on = !!(c.id && d[c.id]);
      c.done.hidden = !on;
      c.a.classList.toggle('fu-card--done', on);
    });
  }

  function buildResults(ui) {
    ui.resultCards = [];
    var grid = el('div', { 'class': 'lab-rgrid' });
    for (var i = 0; i < 3; i++) {
      var k = el('span', { 'class': 'fu-label lab-card-k' }, [el('span', { 'class': 'fu-skel lab-skel-k' })]);
      var t = el('span', { 'class': 'fu-h3 lab-card-t' }, [el('span', { 'class': 'fu-skel' })]);
      var s = el('span', { 'class': 'fu-small lab-card-s lab-clamp' }, [el('span', { 'class': 'fu-skel lab-skel-s' })]);
      var a = el('a', { 'class': 'fu-card fu-card--lift lab-card lab-result', href: LAB + '#results', 'data-v2-pass': '1' }, [k, t, s]);
      grid.appendChild(a);
      ui.resultCards.push({ a: a, k: k, t: t, s: s });
    }
    return block('results', 'Latest results', '', [
      head('Latest results', el('a', { 'class': 'fu-btn fu-btn--link lab-more', href: LAB + '#results', 'data-v2-pass': '1' },
        ['All results', el('span', { 'aria-hidden': 'true', text: ' →' })])),
      grid
    ]);
  }

  function fillResults(ui, packs) {
    ui.resultCards.forEach(function (c, i) {
      var p = packs && packs[i];
      if (!p) {
        c.a.classList.add('lab-result-empty');
        c.a.href = LAB + '#results';
        c.k.textContent = 'Result';
        c.t.textContent = packs ? 'room for the next one' : 'results open in the Lab';
        c.s.textContent = packs ? 'new results land here after a run on the 3090.' : '';
        return;
      }
      c.a.classList.remove('lab-result-empty');
      c.a.href = LAB + '#results/' + encodeURIComponent(p.id);
      c.k.textContent = [KINDS[p.kind] || capFirst(p.kind || 'Result'), (p.models || []).map(modelName).join(' vs '),
        p.created && isISO(String(p.created).slice(0, 10)) ? dayMonth(String(p.created).slice(0, 10)) : ''].filter(Boolean).join(' · ');
      c.t.textContent = p.title || p.id;
      c.s.textContent = p.headline || p.question || '';
    });
  }

  /* ---------------------------------------------------------------- the talk */

  function fmtTime(sec) {
    sec = Math.round(sec);
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }
  function words(s) { var m = String(s || '').trim().match(/\S+/g); return m ? m.length : 0; }
  function spoken(sec) {
    sec = Math.round(sec / 5) * 5;
    var m = Math.floor(sec / 60), s = sec % 60;
    if (!m) return s + ' seconds';
    return m + ' min' + (s ? ' ' + s + ' s' : '');
  }

  function buildTalk(ui) {
    ui.parts = {};
    var list = el('ol', { 'class': 'lab-parts' });
    PARTS.forEach(function (p, i) {
      var id = 'lab-t-' + p.id;
      var ta = el('textarea', { 'class': 'fu-input lab-part-in', id: id, rows: '3', 'aria-describedby': id + '-p ' + id + '-e', spellcheck: 'true' });
      var est = el('span', { 'class': 'fu-mono lab-part-est', id: id + '-e' });
      list.appendChild(el('li', { 'class': 'fu-card lab-part', 'data-part': p.id }, [
        el('div', { 'class': 'lab-part-h' }, [
          el('span', { 'class': 'lab-part-n', 'aria-hidden': 'true', text: String(i + 1) }),
          el('label', { 'class': 'fu-h3 lab-part-t', 'for': id, text: p.title }),
          est
        ]),
        el('p', { 'class': 'fu-voice lab-part-p', id: id + '-p', text: p.prompt }),
        ta
      ]));
      ui.parts[p.id] = { ta: ta, est: est, part: p };
      ta.addEventListener('input', function () { grow(ta); queueSave(p.id, ta.value); paintTalk(ui); });
      ta.addEventListener('blur', flush);
    });

    ui.meterFill = el('span', { 'class': 'fu-progress__fill lab-meter-fill' });
    var band = el('span', { 'class': 'lab-meter-band', style: 'left:' + (TALK_LO / METER_MAX * 100) + '%;width:' + ((TALK_HI - TALK_LO) / METER_MAX * 100) + '%' },
      [el('span', { 'class': 'fu-label lab-meter-band-k', text: SPAN_D + ' min' })]);
    var ticks = el('span', { 'class': 'lab-meter-ticks fu-mono', 'aria-hidden': 'true' });
    for (var m = 0; m <= METER_MAX; m++) ticks.appendChild(el('span', { style: 'left:' + (m / METER_MAX * 100) + '%', text: String(m) }));
    ui.meterLine = el('p', { 'class': 'fu-small lab-meter-line', 'aria-live': 'polite' });
    ui.talkTitle = el('p', { 'class': 'fu-small lab-talk-title' });

    var save = el('button', { type: 'button', 'class': 'fu-btn lab-save' }, ['Save as markdown']);
    save.addEventListener('click', function () { flush(); download(ui); });

    return el('div', { 'class': 'lab-talk-in' }, [
      el('a', { 'class': 'fu-btn fu-btn--link lab-back', href: '#lab' }, [el('span', { 'aria-hidden': 'true', text: '← ' }), 'Lab']),
      el('p', { 'class': 'fu-label lab-kicker', text: 'Talk builder' }),
      el('h1', { 'class': 'fu-h1 lab-h1', text: 'Your talk' }),
      ui.talkTitle,
      el('p', { 'class': 'fu-voice lab-lede', text: 'six parts, ' + SPAN_W + ' minutes out loud. a few lines each is plenty; it saves as you type, on this device.' }),
      el('div', { 'class': 'lab-meter' }, [
        el('div', { 'class': 'lab-meter-wrap', 'aria-hidden': 'true' }, [
          el('span', { 'class': 'fu-progress lab-meter-bar' }, [ui.meterFill]),
          band
        ]),
        ticks,
        ui.meterLine
      ]),
      list,
      el('div', { 'class': 'lab-talk-actions' }, [
        save,
        el('p', { 'class': 'fu-small fu-muted lab-fine', text: 'one .md file with all six parts, for your slides or your notes.' })
      ])
    ]);
  }

  function grow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(Math.max(ta.scrollHeight + 4, 88), 520) + 'px';
  }

  var pending = {}, saveT = 0;
  function queueSave(id, value) {
    pending[id] = value;
    clearTimeout(saveT);
    saveT = setTimeout(flush, 350);
  }
  function flush() {
    clearTimeout(saveT);
    var ids = Object.keys(pending);
    if (!ids.length) return;
    var vals = pending;
    pending = {};
    writeCap(function (c) {
      ids.forEach(function (id) {
        if (id === '__pick') c.pick = vals[id];
        else c.talk[id] = vals[id];
      });
    });
  }

  function talkTotals(talk) {
    var w = 0, started = 0;
    PARTS.forEach(function (p) { var n = words(talk[p.id]); w += n; if (n) started++; });
    return { words: w, sec: w / WPM * 60, started: started };
  }

  function paintTalk(ui) {
    var talk = {};
    PARTS.forEach(function (p) { talk[p.id] = ui.parts[p.id].ta.value; });
    PARTS.forEach(function (p) {
      var sec = words(talk[p.id]) / WPM * 60;
      var est = ui.parts[p.id].est;
      est.textContent = fmtTime(sec) + ' of ~' + fmtTime(p.aim);
      est.setAttribute('aria-label', 'about ' + spoken(sec) + ' spoken; aim for about ' + spoken(p.aim));
    });
    var tot = talkTotals(talk);
    var min = tot.sec / 60;
    ui.meterFill.style.width = (Math.min(min, METER_MAX) / METER_MAX * 100) + '%';
    var say;
    if (!tot.words) say = 'nothing written yet. start with the question; the rest leans on it.';
    else if (min < TALK_LO) say = 'about ' + spoken(tot.sec) + ' spoken (' + tot.words + ' words). the talk is ' + SPAN_W + ' minutes.';
    else if (min <= TALK_HI) say = 'about ' + spoken(tot.sec) + ' spoken (' + tot.words + ' words). right in the ' + SPAN_W + '.';
    else say = 'about ' + spoken(tot.sec) + ' spoken (' + tot.words + ' words). a touch long: trim the part furthest past its aim.';
    ui.meterLine.textContent = say;
    var pick = (ui.pick && ui.pick.value || '').trim();
    ui.talkTitle.textContent = pick ? 'Working title: ' + pick : '';
    ui.talkTitle.hidden = !pick;
  }

  function paintTalkCard(ui) {
    var tot = talkTotals(readCap().talk);
    ui.talkCardS.textContent = tot.started
      ? tot.started + ' of 6 parts started · about ' + spoken(tot.sec) + ' spoken · the talk is ' + SPAN_D + ' minutes'
      : 'six short boxes, ' + SPAN_W + ' minutes out loud. saved on this device as you type.';
  }

  function markdown(c) {
    var tot = talkTotals(c.talk);
    var out = ['# ' + (c.pick.trim() || 'My capstone talk'), '',
      'TARA capstone talk, Saturday 12 December 2026. About ' + spoken(tot.sec) + ' spoken (' + tot.words +
      ' words at ' + WPM + ' a minute); the talk is ' + SPAN_W + ' minutes.', ''];
    PARTS.forEach(function (p, i) {
      var txt = String(c.talk[p.id] || '').trim();
      out.push('## ' + (i + 1) + '. ' + p.title, '', txt || '_Not written yet._', '');
    });
    return out.join('\n');
  }

  function download(ui) {
    var c = readCap();
    PARTS.forEach(function (p) { c.talk[p.id] = ui.parts[p.id].ta.value; });   // what is on screen, saved or not
    if (ui.pick) c.pick = ui.pick.value;
    try {
      var blob = new Blob([markdown(c)], { type: 'text/markdown;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = el('a', { href: url, download: 'capstone-talk.md', hidden: true });
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 1500);
      toast('saved capstone-talk.md');
    } catch (e) {
      toast('that fumbled. nothing is lost; try again.');
    }
  }

  /* ================================================================== painting */

  function paintRunway(ui, t) {
    var F = days(t, FREEZE), T = days(t, TALK), S = days(t, START);
    var frozen = isFrozen(t);

    var st;
    if (S > 1) st = 'the project phase starts in ' + S + ' days. one small thing today is plenty.';
    else if (S === 1) st = 'the project phase starts tomorrow. bring the environment that already works.';
    else if (S === 0) st = 'project phase, day one. get a number on the board.';
    else if (t < RUNS) st = 'experiment days. results freeze on saturday at 6pm.';
    else if (t === RUNS) st = 'last day for experiments. results freeze tomorrow at 6pm.';
    else if (!frozen) st = 'results freeze today at 6pm. after that, it is all talk.';
    else if (T > 0) st = 'results are frozen. this week is for rehearsing, out loud.';
    else if (T === 0) st = 'talk day. you know this work better than anyone in the room.';
    else st = 'talk given. that is the capstone done.';
    ui.status.textContent = st;

    var fz = ui.tiles.freeze, tk = ui.tiles.talk;
    if (frozen) { fz.big.textContent = 'Frozen'; fz.k.textContent = 'results, since'; fz.s.textContent = 'Sat 5 Dec, 6pm'; }
    else if (F === 0) { fz.big.textContent = 'Today'; fz.k.textContent = 'the results freeze'; fz.s.textContent = 'at 6pm'; }
    else { fz.big.textContent = String(F); fz.k.textContent = plural(F, 'day', 'days') + ' to the results freeze'; fz.s.textContent = F === 1 ? 'tomorrow, 6pm' : 'Sat 5 Dec, 6pm'; }
    fz.said.textContent = frozen ? 'Results are frozen, since Saturday 5 December at 6pm.'
      : F === 0 ? 'Results freeze today at 6pm.' : F + ' ' + plural(F, 'day', 'days') + ' to the results freeze, Saturday 5 December at 6pm.';
    fz.box.setAttribute('data-state', frozen ? 'done' : F === 0 ? 'today' : 'ahead');

    if (T < 0) { tk.big.textContent = 'Done'; tk.k.textContent = 'talk given'; tk.s.textContent = 'Sat 12 Dec'; }
    else if (T === 0) { tk.big.textContent = 'Today'; tk.k.textContent = 'the talk'; tk.s.textContent = 'Sat 12 Dec'; }
    else { tk.big.textContent = String(T); tk.k.textContent = plural(T, 'day', 'days') + ' to the talk'; tk.s.textContent = T === 1 ? 'tomorrow' : 'Sat 12 Dec'; }
    tk.said.textContent = T < 0 ? 'The talk was given on Saturday 12 December.' : T === 0 ? 'The talk is today.'
      : T + ' ' + plural(T, 'day', 'days') + ' to the talk, Saturday 12 December.';
    tk.box.setAttribute('data-state', T < 0 ? 'done' : T === 0 ? 'today' : 'ahead');

    /* the track: milestones passed go gold, today's one shows the signal, the pin is today */
    var x = pinPos(t);
    ui.fill.style.width = (x * 100) + '%';
    ui.pin.style.left = (x * 100) + '%';
    ui.pin.setAttribute('data-edge', x < 0.12 ? 'start' : x > 0.88 ? 'end' : 'mid');
    ui.pinT.textContent = 'Today · ' + dayMonth(t);
    MS.forEach(function (m, i) {
      var passed = m.id === 'freeze' ? frozen : m.id === 'rehearse' ? t > REHEARSE_END : t > m.date;
      var now = !passed && (m.id === 'rehearse' ? (t >= REHEARSE && t <= REHEARSE_END) : t === m.date);
      var tk2 = ui.ticks[i];
      tk2.tick.classList.toggle('is-on', passed);
      tk2.tick.classList.toggle('is-doing', now);
      tk2.box.setAttribute('data-state', passed ? 'done' : now ? 'now' : 'ahead');
      ui.msList.children[i].textContent = m.long + ', ' + m.day + (m.week ? ' (week ' + m.week + ')' : '') + ': ' +
        (passed ? 'passed' : now ? 'today' : 'ahead') + '.';
    });
    ui.msList.setAttribute('aria-label', 'Milestones. Today is ' + longDate(t) + '.');
  }

  function paintPick(ui) {
    if (document.activeElement === ui.pick || pending.__pick != null) return;
    ui.pick.value = readCap().pick;
  }

  function paintTalkFields(ui) {
    var c = readCap();
    PARTS.forEach(function (p) {
      var ta = ui.parts[p.id].ta;
      if (document.activeElement === ta || pending[p.id] != null) return;
      if (ta.value !== c.talk[p.id]) ta.value = c.talk[p.id];
    });
    paintTalk(ui);
  }

  function paintAll(ui) {
    paintRunway(ui, todayISO());
    paintPick(ui);
    if (ui.boxes) paintTicks(ui);
    paintTalkCard(ui);
    paintMissionsDone(ui);
  }

  /* ============================================================== the section */

  function build(host, data) {
    var t = todayISO();
    var ui = { root: host, n: targetWeek(t) };
    var main = el('div', { 'class': 'lab-v2 lab-main', 'data-view': 'main' }, [
      buildRunway(ui),
      buildWeeks(ui, data.plan, t),
      buildTalkCard(ui),
      buildDoor(),
      buildMissions(ui, ui.n, data.missions),
      buildResults(ui)
    ]);
    var talk = el('div', { 'class': 'lab-v2 lab-talk', 'data-view': 'talk', hidden: true }, [buildTalk(ui)]);
    host.textContent = '';
    host.appendChild(main);
    host.appendChild(talk);
    ui.main = main;
    ui.talk = talk;

    ui.pick.addEventListener('input', function () { queueSave('__pick', ui.pick.value); });
    ui.pick.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); ui.pick.blur(); } });
    ui.pick.addEventListener('blur', flush);

    if (data.pack) { ui.packFilled = true; fillPack(ui, data.pack); }
    if (data.results) ui.resultsFilled = true;
    fillResults(ui, data.results);
    host.__lab = ui;
    return ui;
  }

  var building = null;
  function ensureBuilt(host) {
    if (host.__lab) return Promise.resolve(host.__lab);
    if (building) return building;
    var n = targetWeek(todayISO());
    /* everything arrives before the first paint, so nothing jumps; a slow piece gives up
       and its slot says where to find it instead */
    building = Promise.all([
      withTimeout(loadPlan(), 4000),
      withTimeout(loadPack(), 4000),
      withTimeout(loadMissions(n), 3000),
      withTimeout(loadResults(), 3000)
    ]).then(function (r) {
      building = null;
      if (host.__lab) return host.__lab;
      return build(host, { plan: r[0], pack: r[1], missions: r[2], results: r[3] });
    }, function (e) { building = null; throw e; });
    return building;
  }

  function mount(host, route) {
    var rest = String((route && route.params && route.params.rest) || '').replace(/^\/+|\/+$/g, '');
    return ensureBuilt(host).then(function (ui) {
      var view = /^talk(\/|$)/.test(rest) ? 'talk' : 'main';
      ui.main.hidden = view !== 'main';
      ui.talk.hidden = view !== 'talk';
      host.setAttribute('data-lab-view', view);
      paintAll(ui);
      if (view === 'talk') {
        paintTalkFields(ui);
        PARTS.forEach(function (p) { grow(ui.parts[p.id].ta); });
        return;
      }
      /* results and the pack: fill in later if they were slow the first time */
      if (!ui.resultsFilled) loadResults().then(function (p) { if (p) { ui.resultsFilled = true; fillResults(ui, p); } });
      if (!ui.packFilled) loadPack().then(function (p) { if (p) { ui.packFilled = true; fillPack(ui, p); } });
      var wk = /^week-(1[234])$/.exec(rest);
      if (wk) selectWeek(ui, Number(wk[1]));
      var target = wk ? 'weeks' : (BLOCKS[rest] ? rest : null);
      if (target) {
        var node = document.getElementById('lab-' + target);
        if (node) requestAnimationFrame(function () { try { node.scrollIntoView({ block: 'start' }); } catch (e) { node.scrollIntoView(); } });
      }
    });
  }

  function unmount() { flush(); }

  /* other tabs and frames (the plan, the Lab) write the same keys */
  window.addEventListener('storage', function (e) {
    var host = document.getElementById('app-sec-lab');
    var ui = host && host.__lab;
    if (!ui || !e) return;
    if (e.key === TICKS || e.key === null) { if (ui.boxes) paintTicks(ui); }
    if (e.key === KEY || e.key === null) { paintPick(ui); paintTalkFields(ui); paintTalkCard(ui); }
    if (e.key === LAB_DONE || e.key === null) paintMissionsDone(ui);
  });
  window.addEventListener('tara:path', function () {
    var host = document.getElementById('app-sec-lab');
    if (host && host.__lab && host.__lab.boxes) paintTicks(host.__lab);
  });
  window.addEventListener('pagehide', flush);

  /* a tab left open: the runway catches up when it is looked at again, and at 6pm on
     freeze day (Today repaints on 'tara:capstone', as the summary's next step changes) */
  function repaintIfShown() {
    var host = document.getElementById('app-sec-lab');
    if (host && host.__lab && !host.hidden) paintAll(host.__lab);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush(); else repaintIfShown();
  });
  (function () {
    var wait = FREEZE_AT - Date.now();
    if (overrideISO() || wait <= 0 || wait > 7 * 864e5) return;
    setTimeout(function () {
      repaintIfShown();
      try { window.dispatchEvent(new CustomEvent('tara:capstone', { detail: { frozen: true, source: 'lab' } })); } catch (e) { /* */ }
    }, wait + 1000);
  })();

  /* search: the runway's parts by name */
  var SEARCH = [
    { id: 'capstone', title: 'Capstone runway', sub: 'Lab · days to the freeze and the talk', hash: '#lab/runway', body: 'freeze talk countdown milestones pick' },
    { id: 'talk', title: 'Talk builder', sub: 'Lab · six parts, ' + SPAN_W + ' minutes', hash: '#lab/talk', body: 'capstone talk presentation slides markdown rehearse' },
    { id: 'weeks-12-14', title: 'Weeks 12 to 14', sub: 'Lab · the project checklist and the capstone pack', hash: '#lab/weeks', body: 'capstone project checklist freeze week 12 13 14' },
    { id: 'lab', title: 'The Lab', sub: 'Lab · tools, missions, results', hash: '#lab/door', body: 'gpt-2 qwen 3090 tools interpretability' },
    { id: 'missions', title: "This week's missions", sub: 'Lab', hash: '#lab/missions', body: 'mission lab' },
    { id: 'results', title: 'Latest results', sub: 'Lab · from the 3090 bench', hash: '#lab/results', body: 'bench findings results probe steering' }
  ];
  function search(q) {
    var score = typeof APP.score === 'function' ? APP.score : function (qq, r) {
      qq = String(qq || '').toLowerCase(); return String(r.title).toLowerCase().indexOf(qq) >= 0 ? 40 : 0;
    };
    var rows = [];
    SEARCH.forEach(function (r) { var s = score(q, r); if (s) rows.push({ title: r.title, sub: r.sub, hash: r.hash, score: s }); });
    return rows;
  }

  if (typeof APP.registerSection === 'function') {
    APP.registerSection({ id: 'lab', title: 'Lab', mount: mount, unmount: unmount, search: search });
  }

  /* for checks (tools and tests); not an interface */
  APP.capstone._test = { readLiteral: readLiteral, pinPos: pinPos, nextMilestone: nextMilestone, isFrozen: isFrozen, markdown: markdown };
})();
})();
