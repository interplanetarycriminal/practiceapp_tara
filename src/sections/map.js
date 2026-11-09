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
