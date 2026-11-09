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
