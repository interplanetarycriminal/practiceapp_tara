/* ==========================================================================
   sections/plan.js — the master plan (tara-plan.current.html) in a frame.
   Routes: #plan, #plan/<anchor>  where anchor is one of
   now sprint loop calendar retention demos capstone risk failure  (SPEC §7)
   and #plan/week-N, which picks week N in the plan's week picker and opens
   its row, for any week, earlier or later than the current one.
   ========================================================================== */
/* global APP */
(function () {
  'use strict';
  var SEC = 'plan';
  var ANCHORS = ['now', 'sprint', 'loop', 'calendar', 'retention', 'demos', 'capstone', 'risk', 'failure'];

  function fk() { return window.__TARA_FK; }

  function parse(route) {
    var h = fk().hashOf(route);
    var m = /^plan(?:\/(.*))?$/.exec(h);
    return { anchor: (m && m[1]) ? m[1] : null };
  }

  var openFrame = null;
  var cache = {};

  /* week-3, week-03, w3, w-3 -> 3; week-0 -> 0 (TARA's online week); anything else -> null */
  function weekOf(anchor) {
    var m = /^w(?:eek)?-?(\d{1,2})$/i.exec(String(anchor || ''));
    var n = m ? Number(m[1]) : -1;
    return n >= 0 && n <= 14 ? n : null;
  }

  /* V2: the plan sits under the app's own bar. Below 720px its two sticky bars
     (135px and 38px) scroll away with the page instead of covering a third of
     the phone, and its "What to do right now" card is gone at every width: Today
     says what to do now, and on a rest day the card disagreed with it. V1 keeps
     the plan exactly as it was. */
  var V2 = window.TARA_SHELL === 'v2';
  var V2_CSS =
    '#now,nav.sections a[href="#now"]{display:none!important}' +
    '@media (max-width:719.98px){header.top,nav.sections{position:static!important}}';
  function narrowV2(w) {
    try { return V2 && w.innerWidth < 720; } catch (e) { return false; }
  }
  function rowTo(w, n) {
    try {
      var row = w.document.getElementById('wk-' + n);
      if (!row) return;
      row.open = true;
      var y = row.getBoundingClientRect().top + (w.pageYOffset || 0) - 12;
      w.scrollTo(0, Math.max(0, y));
    } catch (e) { /* the row is the plan's; nothing to do */ }
  }

  /* The plan defines window.__planWeek(n, opts) in its own script. Wait for it
     the way K.scrollTo waits for an anchor, then give it one more pass after
     layout settles (web fonts, the reading layer). */
  function pickWeek(f, n) {
    var K = fk();
    return K.ready(f).then(function () {
      return new Promise(function (res) {
        var tries = 0;
        (function tick() {
          var w = null;
          try { w = f.contentWindow; } catch (e) { return res(false); }
          if (w && typeof w.__planWeek === 'function') {
            /* V2 below 720px: the plan's bars do not stick (V2_CSS), but its own
               scroll still leaves room for them; open the row and land it here */
            var own = narrowV2(w);
            var go = function () { w.__planWeek(n, { scroll: !own }); if (own) rowTo(w, n); };
            go();
            try { w.requestAnimationFrame(go); } catch (e) {}
            return res(true);
          }
          if (++tries > 200) return res(false);
          setTimeout(tick, 20);
        })();
      });
    });
  }

  function mount(el, route) {
    var K = fk();
    var parts = K.scaffold(el, { backHash: '#today', backLabel: '← Today', opener: true });
    K.showIndex(parts, false);
    parts.name.textContent = 'Fourteen Saturdays — the plan';
    var r = parse(route);
    return K.show(parts.host, 'plan', function () {
      return K.composeSimple('plan', 'tier:plan', V2 ? { css: V2_CSS } : undefined);
    }).then(function (f) {
      openFrame = f;
      var wk = weekOf(r.anchor);
      if (wk != null) pickWeek(f, wk);
      else if (r.anchor) K.scrollTo(f, r.anchor);
      return f;
    });
  }

  function search(q) {
    var K = fk();
    var rows = [];
    ANCHORS.forEach(function (a, i) {
      if (V2 && a === 'now') return; /* hidden in V2 (V2_CSS) */
      var s = K.score(q, { id: a, title: a });
      if (s) rows.push({ title: a.charAt(0).toUpperCase() + a.slice(1), sub: 'Plan', hash: '#plan/' + a, score: s, _o: i });
    });
    for (var n = 0; n <= 14; n++) {
      var s = K.score(q, { id: 'week-' + n, title: 'Week ' + n });
      if (s) rows.push({ title: 'Week ' + n + ' in the plan', sub: 'Plan · its checklist, pack, demo, drill and film', hash: '#plan/week-' + n, score: s, _o: ANCHORS.length + n });
    }
    return K.docSearch('plan', q, '#plan/', 'Plan', cache).then(function (more) {
      return K.cap(rows.concat(more), 8);
    });
  }

  function onTier(n) { fk().tierToFrame(openFrame, n); }

  APP.registerSection({
    id: SEC,
    title: 'Plan',
    navOrder: 20,
    mount: mount,
    search: search,
    onTier: onTier
  });
})();
