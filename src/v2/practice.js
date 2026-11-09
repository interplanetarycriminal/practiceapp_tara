/* src/v2/practice.js — owner: recall.
 *
 * The Practice tab (contract §Routes): section id "practice".
 *   #practice            the Recall card on top, the drill's week banks below
 *   #practice/recall     a Recall session, one card at a time (recall.js)
 *   #practice/recall/warm  the same, as a warm-up from recent weeks
 *   #practice/mixed      a drill session interleaving the recent weeks' banks
 * The week tiles open the existing drill room at #drill/<slug>, which stays.
 *
 * No-reorder: every slot is built once and only its text changes. The tiles
 * sit in TARA week order and never move; "this week" / "just done" are marks
 * on a tile, not a new position.
 */
(function () {
  'use strict';

  var APP = window.APP;
  if (!APP || typeof APP.registerSection !== 'function') return;

  /* One tile per bank. Topics and counts as the drill room labels them; the
     TARA weeks come from the schedule (APP.weeksOfPack), this is the fallback. */
  var BANKS = [
    { slug: 'week-01', topic: 'Einops', count: 78, weeks: [0] },
    { slug: 'week-02', topic: 'ResNets', count: 88, weeks: [1] },
    { slug: 'week-03', topic: 'Optimisers', count: 72, weeks: [1] },
    { slug: 'week-04', topic: 'Autograd', count: 76, weeks: [1] },
    { slug: 'week-05', topic: 'Transformer', count: 81, weeks: [2] },
    { slug: 'week-06', topic: 'Hooks', count: 79, weeks: [3] },
    { slug: 'week-07', topic: 'Circuits', count: 91, weeks: [3, 4] },
    { slug: 'week-08', topic: 'SAEs', count: 96, weeks: [4] },
    { slug: 'week-09', topic: 'DQN', count: 70, weeks: [5] },
    { slug: 'week-10', topic: 'PPO & RLHF', count: 73, weeks: [6] },
    { slug: 'week-11', topic: 'Evals', count: 78, weeks: [7, 8, 9] },
    { slug: 'alignment-science', topic: 'Alignment', count: 68, weeks: [10, 11] },
    { slug: 'capstone-weeks-12-14', topic: 'Capstone', count: 233, weeks: [12, 13, 14] }
  ];
  BANKS.forEach(function (b, i) { b.order = i; });
  var BYSLUG = {};
  BANKS.forEach(function (b) { BYSLUG[b.slug] = b; });

  /* Chapter tints by TARA week (contract §Brand). */
  function chapterOf(n) {
    if (n == null) return 'found';
    if (n <= 1) return 'found';
    if (n <= 4) return 'interp';
    if (n <= 6) return 'rl';
    if (n <= 9) return 'evals';
    if (n <= 11) return 'align';
    return 'project';
  }
  var KIND_WORD = { question: ['question', 'questions'], concept: ['idea', 'ideas'], sentence: ['saved line', 'saved lines'] };
  var PREF_KEY = 'tara-drill-prefs-v1';     // the drill room's own: read, never written

  function lsJSON(k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function h(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    (kids || []).forEach(function (c) { if (c != null && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function go(hash) { if (typeof APP.navigate === 'function') APP.navigate(hash); else location.hash = hash; }
  /* A real link that still routes through the shell. */
  function link(cls, hash, kids, label) {
    var a = h('a', { class: cls, href: hash, 'aria-label': label || null }, kids);
    a.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      go(hash);
    });
    return a;
  }
  function recall() { return APP.recall && typeof APP.recall.summary === 'function' ? APP.recall : null; }
  function todayISO() {
    var r = recall();
    if (r && r.todayISO) return r.todayISO();
    try { var m = /[?&]today=(\d{4}-\d{2}-\d{2})(?:&|$)/.exec(location.search); if (m) return m[1]; } catch (e) {}
    return typeof APP.todayISO === 'function' ? APP.todayISO() : new Date().toISOString().slice(0, 10);
  }
  function scheduleWeeks() {
    try { return (APP.schedule && APP.schedule() && APP.schedule().weeks) || []; } catch (e) { return []; }
  }
  function weeksOf(slug) {
    var ns = [];
    try { if (typeof APP.weeksOfPack === 'function' && scheduleWeeks().length) ns = APP.weeksOfPack(slug) || []; } catch (e) { ns = []; }
    return ns.length ? ns : (BYSLUG[slug] ? BYSLUG[slug].weeks : []);
  }
  function span(ns) {
    if (!ns || !ns.length) return '';
    if (typeof APP.weekSpan === 'function') { try { return APP.weekSpan(ns, true); } catch (e) {} }
    return ns[0] === ns[ns.length - 1] ? 'W' + ns[0] : 'W' + ns[0] + '–' + ns[ns.length - 1];
  }
  /* "this week" = the next Saturday's week; "just done" = the one 1-6 days ago. */
  function nowWeeks() {
    var out = { target: null, justDone: null };
    try {
      if (typeof APP.v2now === 'function') {
        var v = APP.v2now() || {};
        out.target = v.target != null ? (typeof v.target === 'object' ? v.target.n : v.target) : null;
        out.justDone = v.justDone != null ? (typeof v.justDone === 'object' ? v.justDone.n : v.justDone) : null;
        if (out.target != null || out.justDone != null) return out;
      }
    } catch (e) {}
    var t = todayISO(), weeks = scheduleWeeks();
    for (var i = 0; i < weeks.length; i++) {
      var w = weeks[i];
      if (out.target == null && w.saturday >= t) out.target = w.n;
      var ago = (Date.parse(t + 'T00:00:00Z') - Date.parse(w.saturday + 'T00:00:00Z')) / 864e5;
      if (ago >= 1 && ago <= 6) out.justDone = w.n;
    }
    return out;
  }

  /* ------------------------------------------------------------ state ---- */
  var V = { built: false, root: null, els: {}, view: null, player: null, playerWarm: false, mixed: null };

  /* ------------------------------------------------------------- build ---- */
  function build(el) {
    var root = h('div', { class: 'pr-root' });

    /* --- home --- */
    var home = h('div', { class: 'pr-view pr-home', 'data-view': 'home' });
    home.appendChild(h('h1', { class: 'fu-sr', text: 'Practice' }));

    var card = h('section', { class: 'pr-recall fu-card', 'aria-labelledby': 'pr-recall-k' });
    var eyebrow = h('h2', { class: 'pr-eyebrow fu-label', id: 'pr-recall-k', text: 'Recall' });
    var big = h('p', { class: 'pr-recall-big', 'data-slot': 'big' });
    var sub = h('p', { class: 'pr-recall-sub fu-small', 'data-slot': 'sub' });
    var start = h('button', { type: 'button', class: 'pr-start fu-btn fu-btn--big', 'data-slot': 'start' });
    start.addEventListener('click', function () {
      go(start.getAttribute('data-warm') === '1' ? '#practice/recall/warm' : '#practice/recall');
    });
    var foot = h('p', { class: 'pr-recall-foot fu-small', 'data-slot': 'foot' });
    card.appendChild(eyebrow);
    card.appendChild(big);
    card.appendChild(sub);
    card.appendChild(h('div', { class: 'pr-recall-act' }, [start]));
    card.appendChild(foot);
    home.appendChild(card);

    var drill = h('section', { class: 'pr-drill', 'aria-labelledby': 'pr-drill-h' });
    drill.appendChild(h('div', { class: 'pr-head' }, [
      h('h2', { class: 'pr-h2 fu-h2', id: 'pr-drill-h', text: 'Drill' }),
      h('p', { class: 'pr-lede fu-voice', text: 'a week’s question bank, shuffled fresh every time.' })
    ]));
    var mixedLabel = h('span', { class: 'pr-tile-w' });
    var mixedSub = h('span', { class: 'pr-tile-t' });
    var mixed = link('pr-tile pr-tile--mixed fu-card fu-card--lift fu-tint-sky', '#practice/mixed', [
      h('span', { class: 'pr-tile-k fu-label', text: 'Mixed' }), mixedLabel, mixedSub
    ]);
    drill.appendChild(mixed);
    var grid = h('ol', { class: 'pr-tiles', 'aria-label': 'Week banks' });
    var sorted = BANKS.slice().sort(function (a, b) {
      var fa = weeksOf(a.slug)[0], fb = weeksOf(b.slug)[0];
      return (fa == null ? 99 : fa) - (fb == null ? 99 : fb) || a.order - b.order;
    });
    var tiles = {};
    sorted.forEach(function (b) {
      var ns = weeksOf(b.slug);
      var mark = h('span', { class: 'pr-tile-mark fu-badge', hidden: true });
      var a = link('pr-tile fu-card fu-card--lift fu-ch-' + chapterOf(ns[0]), '#drill/' + b.slug, [
        h('span', { class: 'pr-tile-w', text: span(ns) }),
        h('span', { class: 'pr-tile-t', text: b.topic }),
        h('span', { class: 'pr-tile-n', text: b.count + ' questions' }),
        mark
      ]);
      a.setAttribute('data-slug', b.slug);
      a.setAttribute('data-ch', chapterOf(ns[0]));
      tiles[b.slug] = { a: a, mark: mark, weeks: ns };
      grid.appendChild(h('li', { class: 'pr-tiles-i' }, [a]));
    });
    drill.appendChild(grid);
    drill.appendChild(h('p', { class: 'pr-more' }, [
      link('pr-link fu-btn fu-btn--link', '#drill', ['The full drill room, with what’s shaky'])
    ]));
    home.appendChild(drill);

    /* --- recall session --- */
    var sess = h('div', { class: 'pr-view pr-session', 'data-view': 'session', hidden: true });
    sess.appendChild(h('div', { class: 'pr-bar' }, [
      link('pr-back fu-btn fu-btn--ghost', '#practice', ['← Practice'], 'Back to practice'),
      h('h1', { class: 'pr-bar-t fu-h3', 'data-slot': 'sess-title', text: 'Recall' })
    ]));
    var host = h('div', { class: 'pr-player' });
    sess.appendChild(host);

    /* --- mixed drill --- */
    var mix = h('div', { class: 'pr-view pr-mix', 'data-view': 'mixed', hidden: true });
    var mixTitle = h('h1', { class: 'pr-bar-t fu-h3', text: 'Mixed' });
    var redraw = h('button', { type: 'button', class: 'pr-redraw fu-btn fu-btn--ghost', text: 'New draw' });
    redraw.addEventListener('click', function () { mountMixed(true); });
    mix.appendChild(h('div', { class: 'pr-bar' }, [
      link('pr-back fu-btn fu-btn--ghost', '#practice', ['← Practice'], 'Back to practice'), mixTitle, redraw
    ]));
    var mixLede = h('p', { class: 'pr-lede pr-mix-lede fu-voice' });
    mix.appendChild(mixLede);
    var mixStage = h('div', { class: 'pr-mix-stage' });
    mix.appendChild(mixStage);

    root.appendChild(home);
    root.appendChild(sess);
    root.appendChild(mix);
    el.appendChild(root);

    V.root = root;
    V.els = {
      home: home, sess: sess, mix: mix, host: host, big: big, sub: sub, start: start, foot: foot,
      mixedLabel: mixedLabel, mixedSub: mixedSub, mixedTile: mixed, tiles: tiles,
      mixTitle: mixTitle, mixLede: mixLede, mixStage: mixStage,
      sessTitle: sess.querySelector('[data-slot="sess-title"]')
    };
    V.built = true;

    window.addEventListener('tara:recall', paintRecall);
  }

  /* --------------------------------------------------- the Recall card --- */
  function plural(n, w) { return n + ' ' + (n === 1 ? w[0] : w[1]); }
  function paintRecall() {
    if (!V.built) return;
    var E = V.els, r = recall();
    var sum = r ? r.summary() : { due: 0, session: 0, minutes: 0, byKind: {}, total: 0, next: null };
    E.big.textContent = '';
    if (sum.due > 0) {
      E.big.className = 'pr-recall-big';
      E.big.appendChild(h('span', { class: 'pr-count fu-badge fu-badge--count', text: String(sum.due) }));
      E.big.appendChild(document.createTextNode(' due · about ' + sum.minutes + ' min'));
      var parts = [];
      ['concept', 'question', 'sentence'].forEach(function (k) { if (sum.byKind[k]) parts.push(plural(sum.byKind[k], KIND_WORD[k])); });
      E.sub.textContent = sum.due > sum.session
        ? 'the first ' + sum.session + ', then stop or keep going.'
        : parts.join(' · ');
      E.start.textContent = 'Start';
      E.start.removeAttribute('data-warm');
      E.start.className = 'pr-start fu-btn fu-btn--big';
      E.sub.hidden = !E.sub.textContent;
      E.foot.textContent = '';
      E.foot.hidden = true;
    } else {
      E.big.className = 'pr-recall-big pr-recall-big--calm fu-voice';
      E.big.textContent = sum.total ? 'nothing due. every bench starts like this.' : 'nothing to recall yet. misses and shaky cards land here.';
      E.sub.textContent = sum.next ? 'next: ' + sum.next.count + ' ' + sum.next.when + '.' : '';
      E.sub.hidden = !sum.next;
      E.start.textContent = 'Warm up anyway';
      E.start.setAttribute('data-warm', '1');
      E.start.className = 'pr-start fu-btn';
      E.foot.textContent = 'five quick ones from recent weeks.';
      E.foot.hidden = false;
    }
    V.root.setAttribute('data-due', String(sum.due));
  }

  /* --------------------------------------------------------- the tiles --- */
  function paintTiles() {
    if (!V.built) return;
    var nw = nowWeeks(), E = V.els;
    Object.keys(E.tiles).forEach(function (slug) {
      var t = E.tiles[slug], mark = '';
      if (nw.target != null && t.weeks.indexOf(nw.target) >= 0) mark = 'this week';
      else if (nw.justDone != null && t.weeks.indexOf(nw.justDone) >= 0) mark = 'just done';
      t.mark.textContent = mark;
      t.mark.hidden = !mark;
      t.mark.className = 'pr-tile-mark fu-badge' + (mark === 'this week' ? ' fu-badge--signal' : ' fu-badge--quiet');
      if (mark) t.a.setAttribute('data-mark', mark === 'this week' ? 'now' : 'done'); else t.a.removeAttribute('data-mark');
    });
    var rw = mixedWeeks();
    E.mixedLabel.textContent = span(rw.weeks);
    E.mixedSub.textContent = 'recent weeks, interleaved';
    E.mixedTile.setAttribute('aria-label', 'Mixed drill across ' + span(rw.weeks) + ', recent weeks interleaved');
  }
  function mixedWeeks() {
    var r = recall();
    var ns = r && r.recentWeeks ? r.recentWeeks(5) : [0];
    var slugs = r && r.banksOfWeeks ? r.banksOfWeeks(ns) : [];
    if (!slugs.length) slugs = ['week-01'];
    return { weeks: ns, slugs: slugs };
  }

  /* ------------------------------------------------------------- views --- */
  function show(name) {
    V.view = name;
    var E = V.els;
    E.home.hidden = name !== 'home';
    E.sess.hidden = name !== 'session';
    E.mix.hidden = name !== 'mixed';
    V.root.setAttribute('data-view', name);
  }

  function parseRest(route) {
    var rest = route && route.params && route.params.rest != null ? String(route.params.rest) : null;
    if (rest == null) {
      var raw = String((route && (route.raw || route.hash)) || location.hash || '').replace(/^#/, '');
      var m = /^practice(?:\/(.*))?$/.exec(raw);
      rest = m && m[1] ? m[1] : '';
    }
    try { rest = decodeURIComponent(rest); } catch (e) {}
    return rest.replace(/^\/+|\/+$/g, '').toLowerCase();
  }

  function openSession(warm) {
    var E = V.els, r = recall();
    show('session');
    E.sessTitle.textContent = warm ? 'Warm-up' : 'Recall';
    var st = V.player && V.player.state ? V.player.state() : null;
    var keep = st && !st.finished && st.phase !== 'load' && V.playerWarm === !!warm;
    if (keep) return;
    if (V.player && V.player.destroy) V.player.destroy();
    V.player = null;
    if (!r || typeof r.mountSession !== 'function') {
      E.host.textContent = '';
      E.host.appendChild(h('p', { class: 'pr-lede', text: 'recall is not in this build.' }));
      return;
    }
    V.playerWarm = !!warm;
    V.player = r.mountSession(E.host, {
      warm: !!warm,
      onExit: function () { go('#practice'); },
      onRestart: function (w) { V.playerWarm = !!w; E.sessTitle.textContent = w ? 'Warm-up' : 'Recall'; }
    });
  }

  /* ------------------------------------------------- the mixed drill ---- */
  var engineP = null;
  function loadEngine() {
    if (engineP) return engineP;
    if (window.TARA_QUIZ && window.TARA_QUIZ.__installed) { engineP = Promise.resolve(true); return engineP; }
    if (typeof APP.payload !== 'function') return Promise.resolve(false);
    engineP = APP.payload('engine').then(function (src) {
      if (window.TARA_QUIZ && window.TARA_QUIZ.__installed) return true;
      var s = document.createElement('script');
      s.textContent = src;                       /* inline, as the drill room does: no eval */
      (document.head || document.documentElement).appendChild(s);
      return !!(window.TARA_QUIZ && window.TARA_QUIZ.mount);
    }).catch(function () { engineP = null; return false; });
    return engineP;
  }
  function sessionSize() {
    var p = lsJSON(PREF_KEY);
    var n = p && Number(p.size);
    return n === 8 || n === 12 || n === 20 ? n : 12;
  }

  function mountMixed(force) {
    var E = V.els, rw = mixedWeeks();
    show('mixed');
    var label = span(rw.weeks);
    E.mixTitle.textContent = 'Mixed · ' + label;
    E.mixLede.textContent = 'questions from ' + rw.slugs.map(function (s) {
      var b = BYSLUG[s]; return (span(weeksOf(s)) + ' ' + (b ? b.topic : s)).trim();
    }).join(', ') + ', shuffled together.';
    var key = rw.slugs.join('|') + '|' + sessionSize();
    if (!force && V.mixed && V.mixed.key === key && V.mixed.inst && E.mixStage.contains(V.mixed.inst.el || E.mixStage.firstChild)) return Promise.resolve();
    E.mixStage.textContent = '';
    E.mixStage.appendChild(h('p', { class: 'pr-lede', text: 'shuffling…' }));
    return Promise.all([loadEngine(), Promise.all(rw.slugs.map(function (s) {
      return APP.payloadJSON('bank:' + s).then(function (b) { return { slug: s, bank: b }; }, function () { return null; });
    }))]).then(function (res) {
      var ok = res[0], banks = (res[1] || []).filter(function (x) { return x && x.bank && Array.isArray(x.bank.questions); });
      E.mixStage.textContent = '';
      if (!ok || !banks.length) {
        E.mixStage.appendChild(h('p', { class: 'pr-lede', text: ok ? 'those banks would not load. try a week tile instead.' : 'the quiz engine would not load, so there is nothing to drill right now.' }));
        return;
      }
      var concepts = [], seen = {}, home = {}, questions = [];
      banks.forEach(function (x) {
        (x.bank.concepts || []).forEach(function (c) { if (c && c.id && !seen[c.id]) { seen[c.id] = 1; concepts.push(c); } });
        x.bank.questions.forEach(function (q) { if (q && q.id) { questions.push(q); if (q.concept && !home[q.concept]) home[q.concept] = x.slug; } });
      });
      /* week: '' keeps the engine from writing a tara.quiz.<week> record for a
         bank that does not exist; per-question mastery is still recorded, so
         the drill room and Recall both see these answers. */
      var merged = { week: '', title: 'Mixed', arenaSections: [], concepts: concepts, questions: questions };
      var stage = h('div', { class: 'pr-mix-quiz' });
      E.mixStage.appendChild(stage);
      var inst = window.TARA_QUIZ.mount({
        el: stage, bank: merged, sessionSize: sessionSize(),
        onConcept: function (id) { if (home[id]) go('#drill/' + home[id] + '/' + encodeURIComponent(id)); }
      });
      V.mixed = { key: key, inst: inst };
      if (!inst) E.mixStage.appendChild(h('p', { class: 'pr-lede', text: 'that draw would not start. try a week tile instead.' }));
    });
  }

  /* -------------------------------------------------------------- mount --- */
  APP.registerSection({
    id: 'practice',
    title: 'Practice',
    navOrder: 20,

    mount: function (el, route) {
      if (!V.built) build(el);
      else if (!el.contains(V.root)) el.appendChild(V.root);
      var rest = parseRest(route || (APP.route && APP.route()));
      var head = rest.split('/')[0];
      if (head === 'recall') { openSession(rest.split('/')[1] === 'warm'); return; }
      if (head === 'warm') { openSession(true); return; }
      if (head === 'mixed') return mountMixed(false);
      show('home');
      paintRecall();
      paintTiles();
    },

    unmount: function () { /* the player and the mixed draw stay alive for a resume */ },

    /* Tiered text lives on the concept cards, and recall.js swaps it in place
       through APP.onTierChange; nothing here moves on a tier change. */
    onTier: function () {}
  });
})();
