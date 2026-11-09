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
