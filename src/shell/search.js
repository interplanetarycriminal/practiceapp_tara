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
