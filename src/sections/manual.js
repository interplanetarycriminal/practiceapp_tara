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
