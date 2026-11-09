/* app/src/shell/today.js — SPEC §9. The default view: what to do right now.
   Fixed row slots, built once, then text-swapped in place. Owner: Worker A.
   A strip of the weeks sits above the rows: #today is the current week,
   #today/week-NN shows the same rows for any other week, earlier or later.
   Weeks follow TARA's own order (26 Oct 2026): W0 prerequisites, W1 foundations,
   W2-4 mech interp, W5-6 RL, W7-9 evals, W10-11 alignment science, W12-14 project.
   A week can carry several packs (calendar.md lists them); pack slugs are content
   ids, so week-11 is the evals pack that serves W7-W9. */

'use strict';

var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
var DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function pretty(iso) {
  if (!iso) return '';
  var d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return iso;
  return DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MON[d.getMonth()];
}
function dayMonth(iso) {
  var d = new Date(iso + 'T00:00:00');
  return isNaN(d) ? '' : d.getDate() + ' ' + MON[d.getMonth()];
}
function pad2(n) { return String(n).padStart(2, '0'); }

function titleCaseSlug(slug) {
  return String(slug || '').replace(/-/g, ' ').replace(/\b([a-z])/g, function (m, c) { return c.toUpperCase(); });
}

/* The slots. The order is the order; nothing is ever inserted or moved.
   Plan came last (27 Sep 2026) so the first six kept their places. */
var SLOTS = [
  { key: 'now',    label: 'Right now' },
  { key: 'pack',   label: 'Pack' },
  { key: 'demo',   label: 'Demo' },
  { key: 'drill',  label: 'Drill' },
  { key: 'review', label: 'Review' },
  { key: 'sprint', label: 'Sprint' },
  { key: 'plan',   label: 'Plan' }
];

function buildOnce(el) {
  if (el.getAttribute('data-built') === '1') return;
  el.setAttribute('data-built', '1');
  el.textContent = '';

  var pad = APP.el('div', { 'class': 'app-sec-pad app-today' });
  var bar = APP.el('nav', { 'class': 'app-wkbar', id: 'app-wkbar', 'aria-label': 'Any week, earlier or later' });
  var s = APP.schedule();
  ((s && s.weeks) || []).forEach(function (w) {
    var a = APP.el('a', {
      'class': 'app-wk', href: '#today/week-' + pad2(w.n), 'data-wk': String(w.n),
      title: 'Week ' + w.n + ' · ' + pretty(w.saturday) + ' · ' + w.chapter + (w.n === 0 ? ' (no Saturday session)' : '')
    });
    a.appendChild(APP.el('b', { text: 'W' + w.n }));
    a.appendChild(APP.el('span', { text: dayMonth(w.saturday) }));
    bar.appendChild(a);
  });
  var line = APP.el('p', { 'class': 'app-todayline' });
  line.appendChild(APP.el('span', { id: 'app-todayline' }));
  line.appendChild(APP.el('a', { 'class': 'app-wkback', id: 'app-wkback', href: '#today', hidden: 'hidden' }));
  var rows = APP.el('div', { 'class': 'app-rows', id: 'app-todayrows' });

  SLOTS.forEach(function (s) {
    var a = APP.el('a', { 'class': 'app-row', href: '#today', 'data-slot': s.key });
    a.appendChild(APP.el('span', { 'class': 'app-row-k', text: s.label }));
    var body = APP.el('span', { 'class': 'app-row-t' });
    body.appendChild(APP.el('span', { 'class': 'app-row-title' }));
    body.appendChild(APP.el('span', { 'class': 'app-row-s' }));
    a.appendChild(body);
    a.appendChild(APP.el('span', { 'class': 'app-row-go', text: '→', 'aria-hidden': 'true' }));
    rows.appendChild(a);
  });

  if (bar.firstChild) pad.appendChild(bar);
  pad.appendChild(line);
  pad.appendChild(rows);
  el.appendChild(pad);
}

/* Mark the current week and the one on show. The strip scrolls sideways on a
   phone; bring the shown week into view there without moving the page. */
function paintWeeks(el, shown, current, upcoming) {
  var bar = el.querySelector('#app-wkbar');
  if (!bar) return;
  var links = bar.querySelectorAll('.app-wk');
  for (var i = 0; i < links.length; i++) {
    var a = links[i], n = Number(a.getAttribute('data-wk'));
    if (n === current) {
      a.setAttribute('data-now', '1');
      a.setAttribute('href', '#today');
      a.querySelector('span').textContent = upcoming ? 'next' : 'now';
    } else if (a.hasAttribute('data-now')) {        /* the calendar moved on while open */
      var w = weekByN(n);
      a.removeAttribute('data-now');
      a.setAttribute('href', '#today/week-' + pad2(n));
      a.querySelector('span').textContent = w ? dayMonth(w.saturday) : '';
    }
    if (n === shown) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
    if (n === shown) {
      var l = a.offsetLeft - bar.offsetLeft, r = l + a.offsetWidth;
      if (l < bar.scrollLeft || r > bar.scrollLeft + bar.clientWidth) {
        bar.scrollLeft = Math.max(0, l - (bar.clientWidth - a.offsetWidth) / 2);
      }
    }
  }
}

function weekByN(n) {
  var s = APP.schedule();
  var weeks = (s && s.weeks) || [];
  for (var i = 0; i < weeks.length; i++) if (weeks[i].n === n) return weeks[i];
  return null;
}

/* #today/week-03 (also week-3, w3) -> 3; #today/week-00 -> 0; plain #today -> null */
function shownWeek(route) {
  var raw = route && route.raw ? String(route.raw) : '';
  var m = /^today\/w(?:eek)?-?(\d{1,2})$/i.exec(raw);
  return m ? Number(m[1]) : null;
}

function packTitle(slug) {
  var K = window.__TARA_FK;
  var p = K && K.PACK_BY ? K.PACK_BY[slug] : null;
  return p ? p.title : titleCaseSlug(slug);
}
function packSlugsOf(w) { return (w && (w.packSlugs || (w.packSlug ? [w.packSlug] : []))) || []; }

/* Ticks the plan keeps for a week (tara.fourteen.v1: w<N>p<k>, w<N>e<k>). Older
   ticks used ARENA's week numbers; the plan moves them to TARA's order the first
   time it opens and marks the store __order:"tara". Until then, count nothing. */
function planTicks(n) {
  var st = {};
  try { st = JSON.parse(localStorage.getItem('tara.fourteen.v1') || '{}') || {}; } catch (e) { st = {}; }
  if (st.__order !== 'tara') return 0;
  var rx = new RegExp('^w' + n + '[pe]\\d+$'), c = 0;
  for (var k in st) if (Object.prototype.hasOwnProperty.call(st, k) && rx.test(k) && st[k]) c++;
  return c;
}

/* Pack, drill, demo and plan rows for one week. `mine` is true for the week the
   calendar says you are in, which keeps the wording the page always had. */
function weekRows(w, mine) {
  var rows = {};
  if (!w) return rows;
  var packs = packSlugsOf(w);
  if (packs.length === 1) {
    rows.pack = {
      title: 'Study pack — ' + packTitle(packs[0]),
      sub: w.arena || w.chapter, hash: APP.packHash(w, 0)
    };
  } else if (packs.length > 1) {
    rows.pack = {
      title: packs.length + (mine ? ' study packs this week' : ' study packs for week ' + w.n),
      sub: packs.map(packTitle).join(' · '),
      hash: 'packs/week-' + pad2(w.n)
    };
  }
  if (packs.length) {
    rows.drill = {
      title: 'Drill week ' + w.n,
      sub: 'Eight questions from ' + (mine ? 'this week’s' : 'week ' + w.n + '’s') + ' bank' +
        (packs.length > 1 ? ' · ' + packs.length + ' banks, one per pack' : ''),
      hash: 'drill/' + packs[0]
    };
  }
  var demos = w.demoSlugs || [];
  if (demos.length === 1) {
    rows.demo = { title: 'Demo — ' + titleCaseSlug(demos[0]), sub: 'Interactive, one idea', hash: 'demo/' + demos[0] };
  } else if (demos.length > 1) {
    rows.demo = {
      title: demos.length + (mine ? ' demos this week' : ' demos for week ' + w.n),
      sub: demos.map(titleCaseSlug).join(' · '),
      hash: 'demo-week-' + pad2(w.n)
    };
  }
  var ticks = planTicks(w.n);
  rows.plan = {
    title: 'Week ' + w.n + ' checklist in the plan',
    sub: 'Pre-read and exercises' + (ticks ? ' · ' + ticks + ' ticked so far' : ' to tick off'),
    hash: 'plan/week-' + w.n
  };
  return rows;
}

/* Any week other than the current one: the same rows, pointed at that week. */
function describeWeek(t, w) {
  var s = APP.schedule();
  var cur = t.week ? t.week.n : null;
  var past = cur == null || w.n < cur;
  var rows = weekRows(w, false);
  rows.now = {
    title: (past ? 'Back to week ' : 'Get ahead on week ') + w.n + ' — ' + (w.packSlug ? packTitle(w.packSlug) : w.chapter),
    sub: w.arena || w.chapter, hash: APP.packHash(w, 0) || 'packs', primary: true
  };
  rows.sprint = { title: 'Crash sprint', sub: 'Seven prerequisite evenings · ' + pretty(s.sprint.start) + ' – ' + pretty(s.sprint.end), hash: 'sprint' };
  return {
    line: 'Week ' + w.n + ' · ' + w.chapter + ' · ' + pretty(w.saturday) + (past ? ' · an earlier week' : ' · a later week'),
    rows: rows
  };
}

function setRow(el, key, spec) {
  var a = el.querySelector('.app-row[data-slot="' + key + '"]');
  if (!a) return;
  if (!spec) { a.hidden = true; return; }
  a.hidden = false;
  a.setAttribute('href', '#' + String(spec.hash).replace(/^#/, ''));
  a.querySelector('.app-row-title').textContent = spec.title;
  a.querySelector('.app-row-s').textContent = spec.sub || '';
  if (spec.primary) a.setAttribute('data-primary', '1'); else a.removeAttribute('data-primary');
}

function describe(t) {
  var s = APP.schedule();
  if (!s) return { line: 'The schedule did not load.', rows: {} };

  var w = t.week;
  var rows = {};
  var line;

  if (t.phase === 'sprint') {
    var first = w && w.n === 0 ? weekByN(1) : w;     /* the sprint is week 0; say when Saturdays start */
    line = 'Week 0 · crash sprint, day ' + t.dayIndex + ' of ' + s.sprint.days +
           (first ? ' · week ' + first.n + ' (' + first.chapter + ') starts ' + pretty(first.saturday) : '');
    rows.now = {
      title: 'Sprint day ' + t.dayIndex,
      sub: 'One page a day, exercises run in the browser · ends ' + pretty(s.sprint.end),
      hash: 'sprint/day-' + t.dayIndex, primary: true
    };
    rows.sprint = { title: 'All seven sprint days', sub: pretty(s.sprint.start) + ' – ' + pretty(s.sprint.end), hash: 'sprint' };
  } else if (t.phase === 'week' && w) {
    line = 'Week ' + w.n + ' · ' + w.chapter + ' · Saturday ' + dayMonth(w.saturday);
    rows.now = {
      title: 'Week ' + w.n + ' pack — ' + (w.packSlug ? packTitle(w.packSlug) : w.chapter),
      sub: w.arena || '', hash: APP.packHash(w, 0) || 'packs', primary: true
    };
    rows.sprint = { title: 'Crash sprint', sub: 'Seven prerequisite evenings · ' + pretty(s.sprint.start) + ' – ' + pretty(s.sprint.end), hash: 'sprint' };
  } else {
    line = w
      ? 'Between Saturdays · week ' + w.n + ' (' + w.chapter + ') starts ' + pretty(t.nextSaturday)
      : 'The course calendar has run out.';
    rows.now = w
      ? { title: 'Get ahead on week ' + w.n, sub: w.arena || w.chapter, hash: APP.packHash(w, 0) || 'packs', primary: true }
      : { title: 'The plan', sub: 'Fourteen Saturdays', hash: 'plan', primary: true };
    rows.sprint = { title: 'Crash sprint', sub: pretty(s.sprint.start) + ' – ' + pretty(s.sprint.end), hash: 'sprint' };
  }

  var own = weekRows(w, true);
  for (var k in own) rows[k] = own[k];

  return { line: line, rows: rows };
}

function reviewRow() {
  var items = [];
  try { items = APP.review.list() || []; } catch (e) { items = []; }
  if (!items.length) return { title: 'Review queue is empty', sub: 'Select a sentence in any page and save it', hash: 'today' };
  var today = APP.todayISO();
  var due = items.filter(function (i) { return i && i.due && String(i.due).slice(0, 10) <= today; });
  return {
    title: (due.length ? due.length + ' due' : items.length + ' saved') + ' in the review queue',
    sub: due.length ? 'Oldest: ' + (due[0].text || '').slice(0, 90) : (items[0].text || '').slice(0, 90),
    hash: 'today'
  };
}

function render(el, route) {
  buildOnce(el);
  var t = APP.today();
  var cur = t.week ? t.week.n : null;
  var sw = shownWeek(route || APP.route());
  var w = sw == null ? null : weekByN(sw);
  if (w && w.n === cur) w = null;          /* the current week is plain #today */
  var d = w ? describeWeek(t, w) : describe(t);
  var line = el.querySelector('#app-todayline');
  if (line) line.textContent = d.line;
  var back = el.querySelector('#app-wkback');
  if (back) {
    back.hidden = !(w && cur != null);
    back.textContent = 'Back to this week (W' + cur + ')';
  }
  paintWeeks(el, w ? w.n : cur, cur, !!t.upcoming);
  SLOTS.forEach(function (s) {
    setRow(el, s.key, s.key === 'review' ? reviewRow() : d.rows[s.key]);
  });
}

APP.registerSection({
  id: 'today',
  title: 'Now',
  navOrder: 0,
  mount: async function (el, route) { render(el, route); },
  onTier: function () { /* the today panel has no tiered prose */ }
});

/* Review row must follow the queue without re-rendering the whole panel. */
window.addEventListener('tara:review', function () {
  var el = document.getElementById('app-sec-today');
  if (el && el.getAttribute('data-built') === '1') setRow(el, 'review', reviewRow());
});

/* The one short line, repeated in the chrome so it is visible from any section. */
APP._initNowLine = function () {
  var box = document.getElementById('app-now');
  if (!box) return;
  var t = APP.today();
  var s = APP.schedule();
  if (!s) { box.textContent = ''; return; }
  if (t.phase === 'sprint') {
    var first = t.week && t.week.n === 0 ? weekByN(1) : t.week;
    box.textContent = 'Week 0 · sprint day ' + t.dayIndex + ' of ' + s.sprint.days + (first ? ' · week ' + first.n + ' ' + pretty(first.saturday) : '');
  }
  else if (t.phase === 'week' && t.week) box.textContent = 'Week ' + t.week.n + ' · ' + t.week.chapter;
  else if (t.week) box.textContent = 'Week ' + t.week.n + ' starts ' + pretty(t.nextSaturday);
  else box.textContent = '';
};

/* Escape hatch used by the sections that need a friendly slug label. */
APP.titleCaseSlug = titleCaseSlug;
APP.prettyDate = pretty;
