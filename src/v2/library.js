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
