/* ==========================================================================
   sections/demos.js — the 13 interactive demos.
   Routes: #demos, #demo/<slug>, #demo-week-NN  (SPEC §7)
   ========================================================================== */
/* global APP */
(function () {
  'use strict';
  var SEC = 'demos';

  function fk() { return window.__TARA_FK; }

  /* Which demos belong to a week: the schedule when the shell has one,
     otherwise the static table in the kit (both come from calendar.md). */
  function demosForWeek(n) {
    try {
      var s = APP.schedule && APP.schedule();
      if (s && s.weeks) {
        for (var i = 0; i < s.weeks.length; i++) {
          if (s.weeks[i].n === n && Array.isArray(s.weeks[i].demoSlugs) && s.weeks[i].demoSlugs.length) {
            return s.weeks[i].demoSlugs.slice();
          }
        }
      }
    } catch (e) { /* fall back */ }
    return fk().DEMOS.filter(function (d) {
      return d.weeks.indexOf(n) !== -1;
    }).map(function (d) { return d.slug; });
  }

  function parse(route) {
    var h = fk().hashOf(route);
    var m = /^demo\/([^/]+)(?:\/(.*))?$/.exec(h);
    if (m) return { slug: m[1], anchor: m[2] || null, week: null };
    m = /^demo-week-(\d+)$/.exec(h);
    if (m) {
      var wk = parseInt(m[1], 10);
      var list = demosForWeek(wk);
      return { slug: list.length === 1 ? list[0] : null, anchor: null, week: wk };
    }
    return { slug: null, anchor: null, week: null };
  }

  function buildIndex(idx) {
    if (idx.__filled) return;
    idx.__filled = 1;
    var head = document.createElement('div');
    head.className = 'app-idx-head';
    head.innerHTML = '<h2 class="app-idx-h">Demos</h2>' +
      '<p class="app-idx-note">Thirteen benches, in TARA&rsquo;s week order. Labels show the weeks each one serves.</p>';
    idx.appendChild(head);
    var grid = document.createElement('div');
    grid.className = 'app-idx-grid';
    fk().DEMOS.forEach(function (d) {
      var a = document.createElement('a');
      a.className = 'app-idx-card';
      a.href = '#demo/' + d.slug;
      a.setAttribute('data-demo', d.slug);
      var ws = fk().demoWeeks(d.slug);
      a.setAttribute('data-weeks', ws.join(','));
      a.innerHTML =
        '<span class="app-idx-k">' + APP.esc(ws.map(function (w) { return 'W' + w; }).join(' · ')) + '</span>' +
        '<span class="app-idx-t">' + APP.esc(d.title) + '</span>' +
        '<span class="app-idx-s">' + APP.esc(d.slug) + '</span>';
      grid.appendChild(a);
    });
    idx.appendChild(grid);
    APP._order = APP._order || {};
    APP._order[SEC] = fk().DEMOS.map(function (d) { return d.slug; });
  }

  /* #demo-week-NN with more than one demo: mark that week's cards. Marking sets
     an attribute in place — nothing is reordered, hidden or re-packed. */
  function markWeek(idx, week) {
    var cards = idx.querySelectorAll('.app-idx-card');
    for (var i = 0; i < cards.length; i++) {
      var ws = (cards[i].getAttribute('data-weeks') || '').split(',');
      var on = week != null && ws.indexOf(String(week)) !== -1;
      if (on) cards[i].setAttribute('data-now', '1');
      else cards[i].removeAttribute('data-now');
    }
    var head = idx.querySelector('.app-idx-note');
    if (head) {
      head.textContent = week == null
        ? 'Thirteen benches, in TARA’s week order. Labels show the weeks each one serves.'
        : 'Week ' + week + ' has more than one demo. They are marked below.';
    }
  }

  var openSlug = null, openFrame = null;

  function mount(el, route) {
    var K = fk();
    var parts = K.scaffold(el, { backHash: '#demos', backLabel: '← All demos' });
    buildIndex(parts.idx);
    var r = parse(route);

    if (!r.slug || !K.DEMO_BY[r.slug]) {
      markWeek(parts.idx, r.week);
      K.showIndex(parts, true);
      openSlug = null; openFrame = null;
      return Promise.resolve();
    }
    var d = K.DEMO_BY[r.slug];
    K.showIndex(parts, false);
    parts.name.textContent = d.title;
    openSlug = r.slug;
    return K.show(parts.host, 'demo:' + r.slug, function () {
      return K.composeDemo(r.slug);
    }).then(function (f) {
      openFrame = f;
      if (r.anchor) K.scrollTo(f, r.anchor);
      return f;
    });
  }

  function search(q) {
    var K = fk(), rows = [];
    K.DEMOS.forEach(function (d) {
      var ws = K.demoWeeks(d.slug);
      var s = K.score(q, {
        id: d.slug, slug: d.slug, title: d.title,
        body: ws.map(function (w) { return 'week ' + w + ' w' + w; }).join(' ')
      });
      if (s) rows.push({ title: d.title, sub: 'Demo · ' + ws.map(function (w) { return 'W' + w; }).join(' · '),
        hash: '#demo/' + d.slug, score: s, _o: d.order });
    });
    return K.cap(rows, 8);
  }

  function onTier(n) { fk().tierToFrame(openFrame, n); }

  APP.registerSection({
    id: SEC,
    title: 'Demos',
    navOrder: 40,
    mount: mount,
    search: search,
    onTier: onTier
  });
})();
