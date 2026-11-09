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
