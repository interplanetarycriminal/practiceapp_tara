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
