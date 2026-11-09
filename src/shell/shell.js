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
