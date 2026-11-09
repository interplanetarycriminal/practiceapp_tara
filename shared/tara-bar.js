/* shared/tara-bar.js: the one top bar on TARA's standalone pages (the films, the 3D objects and
   the Model Room, the Lab). Plain script, no build step, no dependencies. Load it with its
   stylesheet, then mount it:

     <link rel="stylesheet" href="<root>/shared/tara-bar.css">
     <script src="<root>/shared/tara-bar.js"></script>
     TaraBar.mount({ tab: 'library', title: 'Model Room', onTier: function (n) { ... } });

   The bar: the TARA lockup (to the shell's #today), the tabs, the page's own slot (an "up" link,
   a title, page tools), the tier control (Plain / Generalist / Expert; keys 1/2/3 unless typing;
   writes tara.tier + tara.resolution) and, on films and objects, the 2D | 3D switch.

   The shell is `sessionStorage['tara.shell']` (V2's next.html writes its own name there) or
   else the site's index.html, resolved against the site root (the folder that holds shared/).
   V2 mode (the shell is V2_DOC, or the page is in V2's viewer): V2's five tabs (Today, Weeks,
   Practice, Library, Lab), the lamp, and the theme from tara.v2.theme. V1 mode (everyone else,
   the live site's visitors): the places V1's own nav has (Now, Plan, Drill, Films, 3D, Lab), no
   lamp, and the page follows the device's theme as it always did.
   A phone on its side (narrower than 1080px and at most 500px tall) gets one row: the mark, the
   page's slot, the tier, 2D | 3D (no tabs).

   Inside the V2 shell's viewer (an iframe whose top window has TARA_SHELL === 'v2') there is
   no bar: mount() renders at most a slim row (title, page tools, 2D | 3D) and hides nothing
   else; links back to the shell route the top window to the hash; the Lab opens in the top
   window. The click protocol with the shell (src/notes/bars.md): handle a click only when
   !e.defaultPrevented, and preventDefault() when you do, so a click never navigates twice.

   API (window.TaraBar; every call is safe before or without a mount):
     mount(opts) -> bar       opts: { tab: 'today'|'weeks'|'practice'|'library'|'lab' (V2's tab),
                                v1tab: 'today'|'plan'|'drill'|'films'|'3d'|'lab' (V1's; default:
                                the page's folder), title, titleTag ('div'|'h1'), titleHref,
                                up: {href, label},
                                tools: [Element], dim: {active: '2d'|'3d', href, title},
                                host (fill this element), replace (replace this element),
                                onTier(n), keys (default true), slim (viewer row, default true),
                                root (site root, when the script cannot find its own URL) }
     bar = { el, mode: 'full'|'slim'|'none', setTitle(t), setUp(u), setDim(d), setTools(list), height() }
     tier() -> 1|2|3   setTier(n)   onTier(fn) -> off()   names {1,2,3}
     inViewer() -> bool   isV2() -> bool (V2 mode)   docs {v1, v2}: the shells' file names
     shellDoc() -> the shell's file name   shellHref('#hash') -> URL
     root() -> site root URL (with a trailing slash)   isShellURL(url)
     theme() -> applies tara.v2.theme (V2 mode)   toggleTheme() -> the lamp's pull (as the shell's)
     heights {narrow, wide, short, slim, wideFrom, shortTo}: the bar's px heights (before the safe
     area)   fullHeight() -> the full bar's height at this viewport, for pages that hold its room

   Brand: the bar wears .fu-scope and the brand's fu-* classes (fu-appbar, fu-lockup, fu-seg,
   fu-lamp) and pulls in <root>/shell/brand-scoped.css (the brand's fonts, tokens scoped to
   .fu-scope, components); shared/tara-bar.css carries the bar's own layout and a copy of the
   tokens, so the bar looks right before (or without) that file. */
(function () {
  'use strict';
  if (window.TaraBar) return;

  /* ---------------------------------------------------------------- where am I */
  var SRC = null;
  try { SRC = document.currentScript && document.currentScript.src; } catch (e) { /* */ }
  if (!SRC) {
    var ss = document.getElementsByTagName('script');
    for (var i = 0; i < ss.length; i++) if (/\/shared\/tara-bar\.js(?:[?#]|$)/.test(ss[i].src)) SRC = ss[i].src;
  }
  var ROOT = SRC ? new URL('../', SRC).href : null;
  function guessRoot() {
    var m = location.pathname.match(/^(.*?\/)(?:intuition|objects|lab|shared)\//);
    return location.origin + (m ? m[1] : location.pathname.replace(/[^\/]*$/, ''));
  }
  function root() { return ROOT || (ROOT = guessRoot()); }

  /* ---------------------------------------------------------------- storage (never throws) */
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function ssGet(k) { try { return window.sessionStorage.getItem(k); } catch (e) { return null; } }

  /* ---------------------------------------------------------------- the shell */
  /* The two shells' file names: the one place that names them (lab/ui/bar.js asks TaraBar.isV2()).
     Today V1, the live site, is index.html and V2 is the preview at next.html. When V2 takes over
     the front door, change these two lines to V2_DOC = 'index.html', V1_DOC = 'classic.html'
     (the classic shell then writes sessionStorage tara.shell = 'classic.html' on boot, as next.html
     writes 'next.html' today, so its visitors keep V1's tabs). FRONT_DOC never changes: it is what
     a tab with no tara.shell goes back to, and what the pages' own links name. */
  var V2_DOC = 'next.html';
  var V1_DOC = 'index.html';
  var FRONT_DOC = 'index.html';
  function shellDoc() {
    var s = ssGet('tara.shell');
    return s && /^[A-Za-z0-9._-]+\.html$/.test(s) ? s : FRONT_DOC;
  }
  function shellHref(hash) {
    hash = hash == null ? '' : String(hash);
    if (hash && hash.charAt(0) !== '#') hash = '#' + hash;
    return new URL(shellDoc() + hash, root()).href;
  }
  /* a link to a shell document: the site root, the front door or V2 (V1 by any other name, such as
     classic.html after the swap, is a request for V1 and is left alone) */
  function isShellURL(u) {
    try { u = u instanceof URL ? u : new URL(u, location.href); } catch (e) { return false; }
    if (u.origin !== location.origin) return false;
    var r = new URL(root()).pathname;
    return u.pathname === r || u.pathname === r + FRONT_DOC || u.pathname === r + V2_DOC;
  }
  function isLabURL(u) {
    if (u.origin !== location.origin) return false;
    return u.pathname.indexOf(new URL(root()).pathname + 'lab/') === 0;
  }
  function inViewer() {
    try { return window.top !== window.self && window.top.TARA_SHELL === 'v2'; } catch (e) { return false; }
  }
  /* V2 mode: inside V2's viewer, or in a tab whose shell is V2 */
  function isV2() { return inViewer() || shellDoc() === V2_DOC; }

  /* ---------------------------------------------------------------- theme: follow the shell's lamp */
  /* V2 mode only: V1 has no lamp, so for its visitors the pages follow the device, as they always did */
  var THEME_SET = false;
  function theme() {
    var html = document.documentElement, v = null;
    if (inViewer()) {      // the viewer: exactly the shell's resolved theme
      try { v = window.top.document.documentElement.getAttribute('data-theme'); } catch (e) { v = null; }
    }
    if (v !== 'light' && v !== 'dark' && isV2()) {
      v = String(lsGet('tara.v2.theme') || '').replace(/"/g, '');
      if (v !== 'light' && v !== 'dark') v = null;
    }
    if (v) { if (html.getAttribute('data-theme') !== v) html.setAttribute('data-theme', v); THEME_SET = true; }
    else if (THEME_SET) { html.removeAttribute('data-theme'); THEME_SET = false; }
  }
  theme();
  var topObs = null;
  if (inViewer()) {
    try {
      topObs = new window.top.MutationObserver(theme);
      topObs.observe(window.top.document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      window.addEventListener('pagehide', function () { if (topObs) { topObs.disconnect(); topObs = null; } });
    } catch (e) { /* */ }
  }
  /* the lamp (BRAND.md section 10), exactly as the shell's: it flips what you see, and a flip
     that lands on what the device already shows goes back to following the device */
  function osDark() { try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return false; } }
  function themePref() { var v = String(lsGet('tara.v2.theme') || '').replace(/"/g, ''); return v === 'light' || v === 'dark' ? v : 'auto'; }
  function resolvedTheme() {
    var a = document.documentElement.getAttribute('data-theme');
    return a === 'light' || a === 'dark' ? a : (osDark() ? 'dark' : 'light');
  }
  function toggleTheme() {
    var next = resolvedTheme() === 'dark' ? 'light' : 'dark';
    var pref = next === (osDark() ? 'dark' : 'light') ? 'auto' : next;
    try { if (pref === 'auto') window.localStorage.removeItem('tara.v2.theme'); else window.localStorage.setItem('tara.v2.theme', pref); } catch (e) { /* */ }
    var html = document.documentElement;
    if (pref === 'auto') { html.removeAttribute('data-theme'); THEME_SET = false; }
    else { html.setAttribute('data-theme', pref); THEME_SET = true; }
    paintLamps();
    try { window.dispatchEvent(new CustomEvent('tara:theme', { detail: { pref: pref, theme: resolvedTheme() } })); } catch (e) { /* */ }
    return pref;
  }
  var lamps = [];
  function paintLamps() {
    var dark = resolvedTheme() === 'dark', auto = themePref() === 'auto';
    for (var i = 0; i < lamps.length; i++) {
      lamps[i].setAttribute('aria-pressed', dark ? 'true' : 'false');
      lamps[i].setAttribute('aria-label', dark ? 'Lamp: lights on' : 'Lamp: lights off (dark mode)');
      lamps[i].title = (dark ? 'Lamp off (dark)' : 'Lamp on (light)') + (auto ? ', following your device' : '');
    }
  }
  try {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', paintLamps); else if (mq.addListener) mq.addListener(paintLamps);
  } catch (e) { /* */ }

  /* the brand's own stylesheet (fonts, tokens scoped to .fu-scope, components), placed before
     tara-bar.css so the bar's layout rules have the last word */
  var brandCSS = false;
  function ensureBrandCSS() {
    if (brandCSS || !document.head) return;
    brandCSS = true;
    if (document.querySelector('link[href*="shell/brand-scoped.css"]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = root() + 'shell/brand-scoped.css';
    l.setAttribute('data-tara-brand', '');
    var mine = document.querySelector('link[href*="shared/tara-bar.css"]');
    if (mine && mine.parentNode) mine.parentNode.insertBefore(l, mine);
    else document.head.appendChild(l);
  }
  if (!inViewer()) ensureBrandCSS();

  /* ---------------------------------------------------------------- tier */
  var NAMES = { 1: 'Plain', 2: 'Generalist', 3: 'Expert' };
  var HINTS = { 1: 'Plain words, no jargon', 2: 'The maths and the shapes', 3: 'The full vocabulary' };
  function readTier() {
    var v = lsGet('tara.tier');
    if (v !== '1' && v !== '2' && v !== '3') v = lsGet('tara.resolution');
    return v === '1' || v === '2' || v === '3' ? Number(v) : 2;
  }
  var TIER = readTier();
  var tierFns = [];
  var bars = [];
  document.documentElement.setAttribute('data-tara-tier', String(TIER));
  function setTier(n, o) {
    n = Number(n);
    if (n !== 1 && n !== 2 && n !== 3) return TIER;
    o = o || {};
    var changed = n !== TIER;
    TIER = n;
    if (o.write !== false) { lsSet('tara.tier', String(n)); lsSet('tara.resolution', String(n)); }
    document.documentElement.setAttribute('data-tara-tier', String(n));
    for (var b = 0; b < bars.length; b++) bars[b].paintTier();
    if (changed) for (var i = 0; i < tierFns.length; i++) { try { tierFns[i](n); } catch (e) { if (window.console) console.error(e); } }
    if (changed && inViewer()) {      // the shell's control follows at once (its storage listener would too)
      try { var A = window.top.APP; if (A && typeof A.setTier === 'function' && A.tier && A.tier() !== n) A.setTier(n); } catch (e) { /* */ }
    }
    return n;
  }
  function onTier(fn) {
    tierFns.push(fn);
    return function () { var k = tierFns.indexOf(fn); if (k >= 0) tierFns.splice(k, 1); };
  }
  window.addEventListener('storage', function (e) {
    if (!e) return;
    if (e.key === 'tara.tier' || e.key === 'tara.resolution') { var n = readTier(); if (n !== TIER) setTier(n, { write: false }); }
    else if (e.key === 'tara.v2.theme') { theme(); paintLamps(); }
  });
  /* the Lab's reading layer (and anything else that speaks its event) changed the tier */
  window.addEventListener('tara:tier', function (e) {
    var n = e && e.detail && Number(e.detail.tier);
    if (n === 1 || n === 2 || n === 3) setTier(n, { write: false });
  });

  /* keys 1/2/3, unless typing */
  var TEXTY = /^(?:text|search|email|number|password|url|tel|date|datetime-local|month|week|time)$/i;
  function typing(t) {
    for (var n = t; n && n.nodeType === 1; n = n.parentNode) {
      var tag = n.tagName;
      if (tag === 'TEXTAREA' || tag === 'SELECT' || n.isContentEditable) return true;
      if (tag === 'INPUT') return TEXTY.test(n.type || 'text');
    }
    return false;
  }
  var keysOn = false;
  function keys() {
    if (keysOn) return; keysOn = true;
    document.addEventListener('keydown', function (e) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== '1' && e.key !== '2' && e.key !== '3') return;
      if (typing(e.target)) return;
      setTier(Number(e.key));
    });
  }

  /* ---------------------------------------------------------------- links back to the shell */
  var clicksOn = false;
  function clicks() {
    if (clicksOn) return; clicksOn = true;
    document.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a || a.hasAttribute('download')) return;
      var tgt = (a.getAttribute('target') || '').toLowerCase();
      if (tgt && tgt !== '_self' && tgt !== '_top' && tgt !== '_parent') return;
      var u;
      try { u = new URL(a.getAttribute('href'), location.href); } catch (err) { return; }
      if (inViewer()) {
        if (isShellURL(u)) {
          e.preventDefault();
          var h = u.hash && u.hash.length > 1 ? u.hash : '#today';
          try { if (window.top.location.hash === h) window.top.dispatchEvent(new HashChangeEvent('hashchange')); else window.top.location.hash = h; }
          catch (err) { window.top.location.href = shellHref(h); }
        } else if (isLabURL(u)) {
          e.preventDefault();
          window.top.location.href = u.href;
        }
        return;
      }
      /* standalone: the pages' links name the front door (index.html); in a tab whose shell is
         another document, they go there */
      var r = new URL(root()).pathname;
      if (u.origin === location.origin && (u.pathname === r || u.pathname === r + FRONT_DOC) && shellDoc() !== FRONT_DOC) {
        e.preventDefault();
        location.href = shellHref(u.hash);
      }
    });
  }

  /* ---------------------------------------------------------------- the lockup (src/brand/lockup.html) */
  var MARK = '<svg class="fu-mark tb-mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><path d="M33 14c13 1 22 18 22 31 0 9-10 12-23 12S9 54 9 45c0-15 11-32 24-31z" fill="#9B8CFF" stroke="#141A24" stroke-width="3"/><ellipse cx="25" cy="37" rx="6" ry="7.5" fill="#fff" stroke="#141A24" stroke-width="1.6"/><ellipse cx="40" cy="39" rx="5" ry="6" fill="#fff" stroke="#141A24" stroke-width="1.6"/><circle cx="27" cy="36" r="3" fill="#141A24"/><circle cx="41.5" cy="38" r="2.5" fill="#141A24"/><path d="M29 50q4 3 8 0" fill="none" stroke="#141A24" stroke-width="2" stroke-linecap="round"/><ellipse cx="24" cy="24" rx="4" ry="2" transform="rotate(-24 24 24)" fill="#fff" opacity=".6"/></svg>';
  var WORDMARK = '<span class="fu-wordmark tb-wordmark" aria-hidden="true"><span class="fu-wordmark__lead">its okay to</span><span class="fu-wordmark__row"><span class="fu-wordmark__main"><span class="fu-l">f</span><span class="fu-l">u</span><span class="fu-l">m</span><span class="fu-l">b</span><span class="fu-l">l</span><span class="fu-l">e</span></span><span class="fu-wordmark__tail"><span class="fu-l">u</span><span class="fu-l">p</span><span class="fu-l">o</span><span class="fu-l">n</span></span><span class="fu-wordmark__sfx">tara</span></span></span>';
  var LAMP = '<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path class="fu-lamp__glow" d="M9 17h14l5 13H4z"/><path d="M16 1v5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M11.5 6h9l5 10h-19z" fill="#E6CDA0" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path class="fu-lamp__bulb" d="M12.5 16a3.5 3.5 0 0 0 7 0z" stroke="currentColor" stroke-width="2"/><g class="fu-lamp__chain"><path d="M23 16v7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="1.4 1.4"/><circle cx="23" cy="24.6" r="1.8" fill="currentColor"/></g></svg>';
  /* the bar's heights in px, before env(safe-area-inset-top); pages that hold the bar's room
     before this script arrives use the same numbers (see shared/tara-bar.css):
     narrow (< wideFrom): two rows; wide: one row; short (< wideFrom and at most shortTo tall, a
     phone on its side): one row without the tabs; slim: the row in V2's viewer */
  var HEIGHTS = { narrow: 99, wide: 67, short: 51, slim: 50, wideFrom: 1080, shortTo: 500 };
  function matches(q) { try { return window.matchMedia(q).matches; } catch (e) { return false; } }
  function fullHeight() {
    if (matches('(min-width: ' + HEIGHTS.wideFrom + 'px)')) return HEIGHTS.wide;
    return matches('(max-height: ' + HEIGHTS.shortTo + 'px)') ? HEIGHTS.short : HEIGHTS.narrow;
  }

  /* the tabs: [id, label, where]. V2 mode: V2's five tabs. V1 mode: what V1's own nav offers
     (its sections Now, Plan and Drill; the hooks' Films, 3D and Lab), so every tab lands where
     it says. A '#hash' goes to the shell, anything else is a page under the site root. */
  var TABS_V2 = [['today', 'Today', '#today'], ['weeks', 'Weeks', '#weeks'], ['practice', 'Practice', '#practice'],
    ['library', 'Library', '#library'], ['lab', 'Lab', '#lab']];
  var TABS_V1 = [['today', 'Now', '#today'], ['plan', 'Plan', '#plan'], ['drill', 'Drill', '#drill'],
    ['films', 'Films', 'intuition/index.html'], ['3d', '3D', 'objects/index.html'], ['lab', 'Lab', 'lab/index.html']];
  /* V1's current tab: opts.v1tab, else the page's folder (films, the 3D objects, the Lab) */
  function v1Tab(o) {
    if (o.v1tab) return o.v1tab;
    var p = location.pathname, r = new URL(root()).pathname;
    var m = p.indexOf(r) === 0 ? p.slice(r.length).match(/^(intuition|objects|lab)\//) : null;
    if (m) return { intuition: 'films', objects: '3d', lab: 'lab' }[m[1]];
    return o.tab === 'lab' || o.tab === 'today' ? o.tab : '';
  }

  /* ---------------------------------------------------------------- building */
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function dimEl(d) {
    var w = el('div', 'tb-dim fu-seg');
    w.setAttribute('role', 'group');
    w.setAttribute('aria-label', 'View in 2D or 3D');
    ['2d', '3d'].forEach(function (side) {
      var lab = side === '2d' ? '2D' : '3D', x;
      if (d.active === side) {
        x = el('span', 'tb-dimx fu-seg__opt is-on', lab);
        x.setAttribute('aria-current', 'page');
        x.title = side === '2d' ? 'You are in 2D' : 'You are in 3D';
      } else {
        x = el('a', 'tb-dimx fu-seg__opt', lab);
        x.href = d.href || '#';
        x.title = d.title || (side === '3d' ? 'Hold this idea in 3D' : 'Back to 2D');
        if (!d.href) x.setAttribute('aria-disabled', 'true');
      }
      w.appendChild(x);
    });
    return w;
  }

  function mount(o) {
    o = o || {};
    if (o.root) { try { ROOT = new URL(o.root, location.href).href; } catch (e) { /* */ } }
    if (o.keys !== false) keys();
    clicks();
    var viewer = inViewer();
    var mode = viewer ? (o.slim === false ? 'none' : 'slim') : 'full';
    var B = { el: null, mode: mode, viewer: viewer, paintTier: function () {} };
    var parts = {};
    if (typeof o.onTier === 'function') B.offTier = onTier(o.onTier);

    if (mode === 'slim' && !o.title && !(o.tools && o.tools.length) && !o.dim) mode = B.mode = 'none';
    if (mode === 'none') {
      B.setTitle = B.setUp = B.setDim = B.setTools = function () {};
      B.height = function () { return 0; };
      if (o.replace && o.replace.parentNode) o.replace.parentNode.removeChild(o.replace);
      document.documentElement.setAttribute('data-tb', 'none');
      return B;
    }

    if (mode !== 'none') ensureBrandCSS();
    var bar = el('header', 'tara-bar tb-' + mode + ' fu-scope fu-appbar');
    bar.setAttribute('data-tb-tab', o.tab || '');
    var row = el('div', 'tb-row');
    bar.appendChild(row);
    /* two rows on a phone (lockup + tabs + 2D|3D, then the page slot + tier); on a wide screen
       both rows dissolve (display: contents) into one grid row */
    var r1 = el('div', 'tb-r1'), r2 = el('div', 'tb-r2');
    if (mode === 'full') row.appendChild(r1);
    row.appendChild(r2);

    if (mode === 'full') {
      var brand = el('a', 'tb-brand fu-lockup fu-lockup--s');
      brand.href = shellHref('#today');
      brand.setAttribute('aria-label', 'its okay to fumble upon tara: today');
      brand.innerHTML = MARK + WORDMARK;
      r1.appendChild(brand);

      var v2 = isV2(), on = v2 ? o.tab : v1Tab(o);
      bar.classList.add(v2 ? 'tb-v2' : 'tb-v1');
      var nav = el('nav', 'tb-tabs');
      nav.setAttribute('aria-label', 'Main');
      (v2 ? TABS_V2 : TABS_V1).forEach(function (t) {
        var a = el('a', 'tb-tab', t[1]);
        a.href = t[2].charAt(0) === '#' ? shellHref(t[2]) : root() + t[2];
        a.setAttribute('data-tab', t[0]);
        if (t[0] === on) { a.setAttribute('aria-current', 'true'); a.className += ' is-on'; }
        nav.appendChild(a);
      });
      r1.appendChild(nav);
    }

    var page = el('div', 'tb-page');
    r2.appendChild(page);
    parts.page = page;

    if (mode === 'full') {
      var tier = el('div', 'tb-tier fu-seg');
      tier.setAttribute('role', 'group');
      tier.setAttribute('aria-label', 'Detail level: Plain, Generalist or Expert (keys 1, 2, 3)');
      [1, 2, 3].forEach(function (n) {
        var b = el('button', 'tb-t fu-seg__opt');
        b.type = 'button';
        b.setAttribute('data-t', String(n));
        b.setAttribute('aria-label', n + ', ' + NAMES[n]);
        b.title = NAMES[n] + ': ' + HINTS[n].toLowerCase() + ' (key ' + n + ')';
        b.appendChild(el('b', null, String(n)));
        b.appendChild(el('span', null, NAMES[n]));
        b.addEventListener('click', function () { setTier(n); });
        tier.appendChild(b);
      });
      r2.appendChild(tier);
      parts.tier = tier;
      B.paintTier = function () {
        var bs = tier.querySelectorAll('.tb-t');
        for (var k = 0; k < bs.length; k++) bs[k].setAttribute('aria-pressed', String(Number(bs[k].getAttribute('data-t')) === TIER));
      };
      B.paintTier();
    }

    var dimSlot = el('div', 'tb-dimslot');
    r2.appendChild(dimSlot);

    if (mode === 'full' && isV2()) {          /* the lamp, as in V2's bar (wide screens; V2 mode only) */
      var lamp = el('button', 'tb-lamp fu-lamp');
      lamp.type = 'button';
      lamp.innerHTML = LAMP;
      lamp.addEventListener('click', toggleTheme);
      r2.appendChild(lamp);
      lamps.push(lamp);
      paintLamps();
    }

    /* the page slot: up link, title, tools */
    var up = el('a', 'tb-up');
    up.hidden = true;
    up.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="tb-upt"></span>';
    page.appendChild(up);
    var title = el(o.titleTag === 'h1' ? 'h1' : 'div', 'tb-title');
    page.appendChild(title);
    var tools = el('div', 'tb-tools');
    page.appendChild(tools);

    B.setUp = function (u) {
      if (!u || !u.href || viewer) { up.hidden = true; return; }
      up.hidden = false;
      up.href = u.href;
      up.querySelector('.tb-upt').textContent = u.label || 'Back';
      up.setAttribute('aria-label', u.title || ('Back to ' + (u.label || 'the list')));
      up.title = u.title || ('Back to ' + (u.label || 'the list'));
    };
    B.setTitle = function (t) {
      title.textContent = '';
      if (t == null || t === '') { title.hidden = true; return; }
      title.hidden = false;
      if (typeof t === 'string' && o.titleHref) {
        var a = el('a', 'tb-titlea', t); a.href = o.titleHref; title.appendChild(a);
      } else if (typeof t === 'string') title.textContent = t;
      else title.appendChild(t);
    };
    B.setTools = function (list) {
      tools.textContent = '';
      (list || []).forEach(function (x) { if (x) tools.appendChild(x); });
      page.classList.toggle('tb-has-tools', !!(list && list.length));
    };
    B.setDim = function (d) {
      dimSlot.textContent = '';
      bar.classList.toggle('tb-has-dim', !!d);
      if (d) dimSlot.appendChild(dimEl(d));
    };
    B.height = function () { return bar.getBoundingClientRect().height; };

    B.setUp(o.up);
    B.setTitle(o.title);
    B.setTools(o.tools);
    B.setDim(o.dim || null);

    if (o.replace && o.replace.parentNode) o.replace.parentNode.replaceChild(bar, o.replace);
    else if (o.host) { o.host.textContent = ''; o.host.appendChild(bar); }
    else document.body.insertBefore(bar, document.body.firstChild);
    document.documentElement.setAttribute('data-tb', mode);

    B.el = bar;
    bars.push(B);
    return B;
  }

  window.TaraBar = {
    version: '2.1.0',
    mount: mount,
    tier: function () { return TIER; },
    setTier: function (n) { return setTier(n); },
    onTier: onTier,
    names: NAMES,
    inViewer: inViewer,
    isV2: isV2,
    docs: { v1: V1_DOC, v2: V2_DOC },
    shellDoc: shellDoc,
    shellHref: shellHref,
    isShellURL: isShellURL,
    root: root,
    theme: theme,
    toggleTheme: toggleTheme,
    heights: HEIGHTS,
    fullHeight: fullHeight
  };
})();
