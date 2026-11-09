/* src/v2/today.js — V2's Today, #today (owner: shell).
   Opens on the next Saturday (APP.v2now().target: W10 on Mon 9 Nov) with one
   Start button that picks up where the learner stopped, and a 10 / 30 / 60
   minute box that sizes the session. Below it, fixed slots that never move:
   the week just done, Recall, the Capstone, and the strip of every Saturday.
   Built once; afterwards only text and attributes are swapped in place.

   Fixed places: every part of the hero keeps its height in every state (the
   title has two lines on a phone, one from 700px; the plan has its rows
   reserved and folds what does not fit into "+N"; a calm line takes the plan's
   place when there is nothing to list), and every slot keeps one height, so
   progress, the box and the date never move Start, the slots or the strip.

   What Start does is decided in one place, heroState(), for the hero's words
   and for the click alike:
   - a week with open steps: the step to resume (P.next), sized by the box;
   - a session Saturday (W1+): that week's checklist first, then its ready step;
   - Sat 5 Dec before the freeze: the Lab's W13 block (capstone summary's next);
   - after the freeze up to the talk (6-12 Dec): the talk builder, #lab/talk;
   - a finished week: a recall round if anything is due, else the warm-up
     (checked for cards before any clock starts);
   - after 12 Dec: the course is done; recall or the warm-up, and no clock.

   Reads (all optional, feature-tested): APP.paths (week, next, progress, plan,
   ready), APP.recall (summary, dueCount, session), APP.capstone.summary,
   APP.session, localStorage tara.v2.capstone (only whether the talk has words).
   Repaints on 'tara:path', 'tara:recall', 'tara:session', 'tara:review',
   'tara:capstone'. */

'use strict';

var BOX_KEY = 'tara.v2.box';
var BOXES = [10, 30, 60];
var BOX_SAY = { 10: 'a quick look', 30: 'a proper go', 60: 'the full week' };
var FREEZE = '2026-12-05';      /* fallbacks when the capstone module is absent */
var TALK = '2026-12-12';
var CAP_KEY = 'tara.v2.capstone';

/* step kinds as the plan chips name them (short, so a full plan fits its rows) */
var CHIP = {
  film: 'film', films: 'film', video: 'film', watch: 'film',
  idea: 'idea card', ideas: 'idea cards', card: 'idea card', cards: 'idea cards', concept: 'idea card', concepts: 'idea cards',
  demo: 'demo', play: 'demo', lab: 'Lab mission', mission: 'Lab mission',
  check: 'check', checks: 'check', quiz: 'check', questions: 'check', drill: 'check',
  checklist: 'checklist', saturday: 'checklist', 'do': 'checklist',
  ready: 'ready', runway: 'runway',
  pack: 'pack', read: 'reading', reading: 'reading', recall: 'recall', skip: 'skippable',
  freeze: 'freeze', talk: 'talk builder', warm: 'warm-up'
};
function chipLabel(k) { return CHIP[String(k || '').toLowerCase()] || String(k || 'step'); }

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

function box() {
  var v = Number(lsGet(BOX_KEY));
  return BOXES.indexOf(v) >= 0 ? v : 30;
}

function paths() {
  var P = window.APP && APP.paths;
  return P && typeof P.week === 'function' ? P : null;
}
function safe(fn, dflt) { try { var v = fn(); return v == null ? dflt : v; } catch (e) { return dflt; } }

function countdown(d) {
  if (d == null) return '';
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  return 'in ' + d + ' days';
}
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

/* the voice line's short form, for a phone too narrow for the whole line:
   "done. see you tomorrow." -> "see you tomorrow." */
function shortVoice(v) {
  v = String(v || '');
  var i = v.indexOf('. ');
  return i > 0 ? v.slice(i + 2) : v;
}

/* "Alignment science" -> "alignment science" after "Week 10, " (BRAND voice: names
   are sentence case); an acronym at the front (RL, RLHF) keeps its capitals. */
function afterComma(t) {
  t = String(t || '');
  if (/^[A-Z0-9]{2,}\b/.test(t)) return t;
  return t.charAt(0).toLowerCase() + t.slice(1);
}

/* the week's name, as the Weeks tab shows it: the path's short title */
function weekName(w, pw) {
  return (pw && (pw.short || pw.title)) || (w && w.chapter) || '';
}

/* a date said the calm way: today, tomorrow, else "Sat 28 Nov" */
function whenDate(iso, today) {
  var d = APP.dayDiff(today, iso);
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  return APP.prettyDate(iso);
}

function fallbackHash(w) {
  if (!w) return 'library';
  return APP.packHash(w, 0) || ('weeks/' + w.n);
}

/* ------------------------------------------------------------- the world */

function recallInfo() {
  var R = window.APP && APP.recall;
  if (!R) return null;
  var s = typeof R.summary === 'function' ? safe(function () { return R.summary(); }, null) : null;
  if (s) {
    return {
      due: Number(s.due) || 0, total: Number(s.total) || 0, session: Number(s.session) || 0,
      minutes: Number(s.minutes) || 0, next: s.next && s.next.count ? s.next : null
    };
  }
  if (typeof R.dueCount === 'function') {
    var d = safe(function () { return R.dueCount(); }, 0);
    return { due: d, total: d, session: Math.min(d, 7), minutes: 0, next: null };
  }
  return null;
}

function capInfo(today) {
  var C = window.APP && APP.capstone;
  var cs = C && typeof C.summary === 'function' ? safe(function () { return C.summary(); }, null) : null;
  var dF = cs && cs.daysToFreeze != null ? cs.daysToFreeze : APP.dayDiff(today, FREEZE);
  var dT = cs && cs.daysToTalk != null ? cs.daysToTalk : APP.dayDiff(today, TALK);
  /* past the freeze? The capstone module knows the clock (6pm on the day), so
     its next milestone decides; without it, the day after the freeze does. */
  var next = cs && cs.next && cs.next.date ? cs.next : null;
  var frozen = next ? next.date === (cs.talk || TALK) : dF < 0;
  return { cs: cs, dF: dF, dT: dT, next: next, frozen: frozen };
}

/* has the learner written anything in the talk builder yet? (read only) */
function talkStarted() {
  var raw = lsGet(CAP_KEY);
  if (!raw) return false;
  try {
    var t = (JSON.parse(raw) || {}).talk || {};
    for (var k in t) if (Object.prototype.hasOwnProperty.call(t, k) && typeof t[k] === 'string' && t[k].trim()) return true;
  } catch (e) {}
  return false;
}

/* a session Saturday: the checklist first, then the ready step, then the rest
   of the open steps (sized as the paths module sizes them) while they fit */
function sessionDayPlan(n, left) {
  var P = paths();
  var all = P && typeof P.plan === 'function' ? safe(function () { return P.plan(n, 600); }, []) : [];
  var lead = [], rest = [];
  all.forEach(function (st) { (st.id === 'do' || st.id === 'ready' ? lead : rest).push(st); });
  lead.sort(function (a, b) { return (a.id === 'do' ? 0 : 1) - (b.id === 'do' ? 0 : 1); });
  var out = [];
  lead.concat(rest).forEach(function (st) {
    if (left <= 0) return;
    var m = Number(st.minutes) || 0;
    if (m <= left) { out.push(st); left -= m; return; }
    if (!out.length) {             /* the first thing is bigger than the box: cut it to the box */
      var c = {};
      for (var k in st) if (Object.prototype.hasOwnProperty.call(st, k)) c[k] = st[k];
      c.minutes = left; c.partial = true;
      out.push(c); left = 0;
    }
  });
  return out;
}
function firstOpen(pw, ids) {
  var steps = (pw && pw.steps) || [];
  for (var i = 0; i < ids.length; i++) {
    for (var j = 0; j < steps.length; j++) if (steps[j].id === ids[i] && steps[j].state !== 'done') return steps[j];
  }
  return null;
}

/* the one "next:" line for a path step: its title and the minutes it has left,
   as the plan sizes it (idea cards by the cards still to read), so the line and
   its chip say the same number */
function stepLine(st, n) {
  var m = Number(st.minutes) || 0;
  var P = paths();
  var all = P && typeof P.plan === 'function' ? safe(function () { return P.plan(n, 600); }, []) : [];
  for (var i = 0; i < all.length; i++) if (all[i].id === st.id && all[i].minutes) { m = all[i].minutes; break; }
  return (st.title || chipLabel(st.kind)) + (m ? ' · ' + m + ' min' : '');
}

/* After the path (or the course): a recall round when something is due, else a
   warm-up. Both have cards; the warm-up is checked on the click (see onStart). */
function restMode(S) {
  var rc = S.rc;
  if (rc && rc.due > 0) {
    var n = rc.session || Math.min(rc.due, 7);
    S.mode = 'recall';
    S.hash = '#practice/recall';
    S.label = 'Start a recall round';
    S.next = 'Recall · ' + plural(n, 'card') + (rc.minutes ? ' · ' + rc.minutes + ' min' : '');
  } else {
    S.mode = 'warm';
    S.hash = '#practice/warm';
    S.label = 'Warm up';
    S.next = 'Warm-up · five cards · 4 min';
    S.checkWarm = true;
  }
}
function comeBack(rc) {
  return rc && rc.next ? rc.next.count + ' come back ' + rc.next.when + '.' : '';
}

/* Everything the hero says and where Start goes, for one moment. */
function heroState(now) {
  var today = now.today || APP.todayISO();
  var w = now.target || null;
  var P = paths();
  var bx = box();
  var S = {
    w: w, today: today, box: bx, rc: recallInfo(), cap: capInfo(today),
    mode: 'path', title: '', date: '', voice: '', label: 'Start', hash: null, timer: true,
    next: '', lead: null, sessionDay: false, note: '', noBox: false, pr: null, allDone: false, long: '',
    voiceShort: ''
  };

  /* after the last Saturday: the course is done; no clock */
  if (!w) {
    S.title = 'The course is done';
    S.date = 'after 12 Dec';
    S.voice = 'well done. it all keeps.';
    S.voiceShort = 'well done.';
    restMode(S);
    S.mode = 'after';
    S.timer = false;
    S.noBox = true;
    S.note = (S.rc && S.rc.due ? 'every week stays open. recall keeps it fresh.'
      : (comeBack(S.rc) ? 'nothing due; ' + comeBack(S.rc) : 'every week stays open in Weeks.'));
    return S;
  }

  var pw = P ? safe(function () { return P.week(w.n); }, null) : null;
  var step = P ? safe(function () { return P.next(w.n); }, null) : null;
  var pr = P ? safe(function () { return P.progress(w.n); }, null) : null;
  var allDone = !!(pr && pr.total && pr.done >= pr.total);
  S.pr = pr && pr.total ? pr : null;
  S.allDone = allDone;
  S.title = 'Week ' + w.n + ', ' + afterComma(weekName(w, pw));
  S.long = (pw && pw.title) || w.chapter || '';
  S.date = now.isSaturday ? 'today' : APP.prettyDate(w.saturday);
  var sessionDay = !!(now.isSaturday && w.n >= 1);
  var cap = S.cap;

  if (!cap.frozen && cap.dF === 0) {
    /* Sat 5 Dec, before 6pm: the freeze comes first */
    S.mode = 'freeze';
    S.voice = 'results freeze at 6pm.';
    S.hash = (cap.next && cap.next.hash) || '#lab/week-13';
    S.next = 'Freeze at 6pm · the W' + w.n + ' list';
    S.lead = { kind: 'freeze', text: 'freeze', meta: '6pm', minutes: 0, title: 'Results freeze at 6pm: the week ' + w.n + ' list in the Lab' };
    S.sessionDay = sessionDay;
    return S;
  }
  if (cap.frozen && cap.dT >= 0) {
    /* from the freeze to the talk: the talk builder comes first */
    S.mode = 'talk';
    if (cap.dT === 0) S.voice = 'talk day. you know this.';
    else if (cap.dF === 0) S.voice = 'results are in. rest tonight.';
    else S.voice = cap.dT === 1 ? 'the talk is tomorrow.' : 'the talk is in ' + cap.dT + ' days.';
    S.hash = '#lab/talk';
    S.label = talkStarted() ? 'Pick up where you stopped' : 'Start';
    S.next = cap.dT === 0 ? 'Talk builder · one last read' : 'Talk builder · six parts';
    S.lead = { kind: 'talk', text: 'talk builder', minutes: bx <= 10 ? bx : bx - 10, title: 'The talk builder, in the Lab' };
    S.sessionDay = sessionDay;
    return S;
  }

  if (!allDone) {
    var first = step;
    if (sessionDay) {
      S.sessionDay = true;
      var lead = firstOpen(pw, ['do', 'ready']);
      if (lead) first = lead;
      S.voice = lead ? 'session day. go well.' : 'session day. all set.';
    } else if (now.isSaturday) S.voice = 'online week. your own pace.';
    else if (now.phase === 'before') S.voice = 'starts ' + countdown(now.daysTo) + '.';
    else S.voice = countdown(now.daysTo) + '.';
    S.hash = first && first.hash ? first.hash : '#' + fallbackHash(w);
    var started = first && (first.state === 'doing' || (first === step && pr && pr.done > 0));
    S.label = started ? 'Pick up where you stopped' : 'Start';
    if (first) S.next = stepLine(first, w.n);
    else {
      var slug = (w.packSlugs || [w.packSlug])[0];
      S.next = 'The pack · ' + (slug ? APP.titleCaseSlug(slug) : weekName(w, pw));
    }
    return S;
  }

  /* the week's path is done */
  S.voice = sessionDay ? 'session day. all set.' : (now.isSaturday ? 'done. enjoy the day.'
    : (now.daysTo === 1 ? 'done. see you tomorrow.' : 'done. see you saturday.'));
  restMode(S);
  S.note = S.rc && S.rc.due ? 'a recall round keeps week ' + w.n + ' fresh.'
    : 'anything now is extra. a warm-up is five cards, no score.';
  return S;
}

/* what fits in the box, as chips: a lead (the freeze, the talk) first */
function chipsFor(S) {
  var out = [];
  var left = S.box;
  if (S.lead) { out.push(S.lead); left -= S.lead.minutes || 0; }
  var P = paths();
  if (!S.w || S.allDone || left <= 0 || !P || typeof P.plan !== 'function') return out;
  var steps = S.sessionDay ? sessionDayPlan(S.w.n, left) : safe(function () { return P.plan(S.w.n, left); }, []);
  (steps || []).forEach(function (st) {
    out.push({ kind: st.kind, text: chipLabel(st.kind), minutes: st.minutes, title: st.title });
  });
  return out;
}

/* ----------------------------------------------------------------- build */

function build(el) {
  if (el.getAttribute('data-built') === '1') return;
  el.setAttribute('data-built', '1');
  el.textContent = '';
  var E = APP.el;

  var pad = E('div', { 'class': 'app-sec-pad v2-today' });

  /* the hero: two short lines, then Start */
  var hero = E('section', { 'class': 'v2-hero fu-card', id: 'v2-hero', 'aria-labelledby': 'v2-hero-h' });
  /* the name sits at the foot of its two reserved lines, next to the date */
  hero.appendChild(E('h1', { 'class': 'v2-hero-h fu-display', id: 'v2-hero-h' }, [E('span', { 'class': 'v2-hero-ht', id: 'v2-hero-ht' })]));
  var line2 = E('p', { 'class': 'v2-hero-s', id: 'v2-hero-s' });
  line2.appendChild(E('span', { 'class': 'fu-plate v2-hero-date', id: 'v2-hero-date' }));
  line2.appendChild(E('span', { 'class': 'fu-voice v2-hero-voice', id: 'v2-hero-voice' }));
  hero.appendChild(line2);

  var go = E('div', { 'class': 'v2-hero-go' });
  var start = E('button', { 'class': 'v2-start fu-btn fu-btn--big', type: 'button', id: 'v2-start', 'aria-describedby': 'v2-next-t' });
  start.appendChild(E('span', { 'class': 'v2-start-t', id: 'v2-start-t', text: 'Start' }));
  start.addEventListener('click', onStart);
  go.appendChild(start);

  /* the box, or (after the course, when there is no clock) a calm line in its place */
  var boxSlot = E('div', { 'class': 'v2-boxslot' });
  var bx = E('div', { 'class': 'v2-box fu-seg', role: 'radiogroup', 'aria-label': 'How long you have', id: 'v2-box' });
  BOXES.forEach(function (m) {
    var b = E('button', { 'class': 'v2-boxbtn fu-seg__opt', type: 'button', role: 'radio', 'data-min': String(m), 'aria-label': m + ' minutes, ' + BOX_SAY[m] });
    var inner = E('span', { 'class': 'v2-boxbtn-in' });
    inner.appendChild(E('b', { text: m + ' min' }));
    inner.appendChild(E('span', { 'class': 'fu-seg__sub', text: BOX_SAY[m] }));
    b.appendChild(inner);
    bx.appendChild(b);
  });
  bx.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.v2-boxbtn');
    if (!b) return;
    lsSet(BOX_KEY, b.getAttribute('data-min'));
    paint();
  });
  bx.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    var i = BOXES.indexOf(box()) + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1);
    if (i < 0 || i >= BOXES.length) return;
    e.preventDefault();
    lsSet(BOX_KEY, String(BOXES[i]));
    paint();
    var nb = bx.querySelector('[data-min="' + BOXES[i] + '"]');
    if (nb) nb.focus();
  });
  boxSlot.appendChild(bx);
  boxSlot.appendChild(E('p', { 'class': 'v2-box-note fu-voice', id: 'v2-box-note', hidden: 'hidden', text: 'no clock now. come back whenever.' }));
  go.appendChild(boxSlot);
  hero.appendChild(go);

  var next = E('p', { 'class': 'v2-next', id: 'v2-next' });
  next.appendChild(E('span', { 'class': 'fu-label v2-next-k', text: 'next' }));
  next.appendChild(E('span', { 'class': 'v2-next-t', id: 'v2-next-t' }));
  hero.appendChild(next);

  /* the plan: its rows are reserved; a calm line stands in when there is nothing to list */
  var planSlot = E('div', { 'class': 'v2-planslot', id: 'v2-planslot' });
  var plan = E('ol', { 'class': 'v2-plan', id: 'v2-plan', 'aria-label': 'What fits in this box' });
  planSlot.appendChild(plan);
  planSlot.appendChild(E('p', { 'class': 'v2-plan-note fu-voice', id: 'v2-plan-note', hidden: 'hidden' }));
  hero.appendChild(planSlot);
  if (typeof ResizeObserver === 'function') {
    var lastW = -1;
    new ResizeObserver(function () {
      if (hero.clientWidth !== lastW) { lastW = hero.clientWidth; fitVoice(); fitChips(); }
    }).observe(hero);
  }

  var prog = E('div', { 'class': 'v2-prog', id: 'v2-prog' });
  prog.appendChild(E('span', { 'class': 'fu-progress v2-prog-bar', id: 'v2-prog-bar', role: 'progressbar', 'aria-valuemin': '0' },
    [E('span', { 'class': 'fu-progress__fill', id: 'v2-prog-fill' })]));
  prog.appendChild(E('span', { 'class': 'v2-prog-t', id: 'v2-prog-t' }));
  hero.appendChild(prog);
  pad.appendChild(hero);

  /* fixed slots: never reordered, never removed; text swaps in place */
  var slots = E('div', { 'class': 'v2-slots' });
  [['done', 'Just done'], ['recall', 'Recall'], ['capstone', 'Capstone']].forEach(function (s) {
    var a = E('a', { 'class': 'v2-slot fu-card fu-card--lift', href: '#today', 'data-slot': s[0] });
    a.appendChild(E('span', { 'class': 'v2-slot-k fu-label', text: s[1] }));
    a.appendChild(E('span', { 'class': 'v2-slot-t fu-h3' }));
    a.appendChild(E('span', { 'class': 'v2-slot-s' }));
    a.appendChild(E('span', { 'class': 'v2-slot-go', 'aria-hidden': 'true', text: '→' }));
    slots.appendChild(a);
  });
  pad.appendChild(slots);

  /* every Saturday, in date order; any of them opens its Weeks page */
  var stripWrap = E('section', { 'class': 'v2-wkwrap', 'aria-labelledby': 'v2-wk-h' });
  stripWrap.appendChild(E('h2', { 'class': 'v2-wk-h fu-label', id: 'v2-wk-h', text: 'Every Saturday' }));
  var strip = E('nav', { 'class': 'v2-wkstrip', id: 'v2-wkstrip', 'aria-label': 'Any week, earlier or later' });
  var sch = APP.schedule();
  ((sch && sch.weeks) || []).forEach(function (w) {
    var a = E('a', {
      'class': 'v2-wk fu-chip fu-ch-' + APP.chapterKey(w.n), href: '#weeks/' + w.n, 'data-wk': String(w.n),
      title: 'Week ' + w.n + ' · ' + APP.prettyDate(w.saturday) + ' · ' + w.chapter + (w.n === 0 ? ' (no Saturday session)' : '')
    });
    a.appendChild(E('b', { text: 'W' + w.n }));
    a.appendChild(E('span', { 'class': 'v2-wk-d', text: APP.dayMonth(w.saturday) }));
    a.appendChild(E('i', { 'class': 'v2-wk-p', 'aria-hidden': 'true' }));
    strip.appendChild(a);
  });
  stripWrap.appendChild(strip);
  pad.appendChild(stripWrap);

  el.appendChild(pad);
  if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') document.fonts.ready.then(function () { fitVoice(); fitChips(); }, function () {});
}

/* ----------------------------------------------------------------- paint */

function setSlot(key, spec) {
  var el = document.getElementById('app-sec-today');
  var a = el && el.querySelector('.v2-slot[data-slot="' + key + '"]');
  if (!a || !spec) return;
  a.setAttribute('href', '#' + String(spec.hash || 'today').replace(/^#/, ''));
  if (spec.label) a.querySelector('.v2-slot-k').textContent = spec.label;
  a.querySelector('.v2-slot-t').textContent = spec.title || '';
  var sub = a.querySelector('.v2-slot-s');
  sub.textContent = spec.sub || '';
  sub.className = 'v2-slot-s ' + (spec.voice ? 'fu-voice' : 'fu-small');
  a.classList.toggle('fu-card--done', spec.state === 'done');
  if (spec.state) a.setAttribute('data-state', spec.state); else a.removeAttribute('data-state');
  setCh(a, spec.ch || null);
}

/* one chapter tint class at a time (fu-ch-* sets --fu-bg for .fu-card) */
var CHS = ['found', 'interp', 'rl', 'evals', 'align', 'project'];
function setCh(el, key) {
  for (var i = 0; i < CHS.length; i++) el.classList.toggle('fu-ch-' + CHS[i], CHS[i] === key);
}

var startBusy = false;
function onStart() {
  if (startBusy) return;
  var S = heroState(APP.v2now());
  var running = !!(APP.session && APP.session.state && APP.session.state());
  function go(timer) {
    if (timer && !running && APP.session && APP.session.start) APP.session.start(box(), { week: S.w ? S.w.n : null });
    APP.navigate(String(S.hash || 'today').replace(/^#/, ''));
  }
  /* never a clock on an empty screen: a warm-up starts one only once it has cards
     (the recall module caches the banks it loads, so the warm-up opens at once) */
  var R = window.APP && APP.recall;
  if (S.checkWarm && S.timer && !running && R && typeof R.session === 'function') {
    var btn = document.getElementById('v2-start');
    var settled = false;
    startBusy = true;
    if (btn) btn.setAttribute('aria-busy', 'true');
    var finish = function (items, ok) {
      if (settled) return;
      settled = true;
      startBusy = false;
      if (btn) btn.removeAttribute('aria-busy');
      if (!ok) { go(false); return; }
      if (items && items.length) go(true);
      else if (APP.toast) APP.toast('nothing to warm up with yet. rest counts too.');
    };
    setTimeout(function () { finish(null, false); }, 2500);
    Promise.resolve().then(function () { return R.session({ warm: true }); })
      .then(function (items) { finish(items, true); }, function () { finish(null, false); });
    return;
  }
  go(S.timer);
}

/* the voice line in its one row: the whole line, or its short form where the
   whole line would be cut (a narrow phone) */
function fitVoice() {
  var v = document.getElementById('v2-hero-voice');
  if (!v || !v.offsetParent) return;
  var whole = v.getAttribute('data-whole') || '';
  var short = v.getAttribute('data-short') || '';
  if (v.textContent !== whole) v.textContent = whole;
  if (short && short !== whole && v.scrollWidth > v.clientWidth + 1) v.textContent = short;
}

/* the plan's chips into their reserved rows; what does not fit folds into "+N" */
function fitChips() {
  var ol = document.getElementById('v2-plan');
  if (!ol || ol.hidden || !ol.offsetParent) return;
  var items = [].slice.call(ol.querySelectorAll('.v2-plan-i:not(.v2-plan-more)'));
  var more = ol.querySelector('.v2-plan-more');
  items.forEach(function (li) { li.hidden = false; });
  if (more) more.hidden = true;
  if (!items.length || !more) return;
  var limit = ol.clientHeight + 1;
  function over(el) { return el.offsetTop + el.offsetHeight > limit; }
  var cut = -1;
  for (var i = 0; i < items.length; i++) if (over(items[i])) { cut = i; break; }
  if (cut < 0) return;
  for (var j = cut; j < items.length; j++) items[j].hidden = true;
  more.hidden = false;
  function say(k) {
    var n = items.length - k;
    more.textContent = '+' + n;
    more.setAttribute('aria-label', 'and ' + n + ' more');
  }
  say(cut);
  while (over(more) && cut > 0) { cut--; items[cut].hidden = true; say(cut); }
}

function paintHero(now) {
  var S = heroState(now);
  var h = document.getElementById('v2-hero-h');
  var ht = document.getElementById('v2-hero-ht');
  var date = document.getElementById('v2-hero-date');
  var voice = document.getElementById('v2-hero-voice');
  var hero = document.getElementById('v2-hero');
  if (!h || !ht || !date || !voice || !hero) return;
  var running = !!(APP.session && APP.session.state && APP.session.state());

  setCh(hero, S.w ? APP.chapterKey(S.w.n) : 'project');
  hero.setAttribute('data-mode', S.mode);

  /* two short lines, then Start */
  ht.textContent = S.title;
  if (S.long && S.long !== S.title) h.setAttribute('title', S.long); else h.removeAttribute('title');
  date.textContent = S.date;
  voice.textContent = S.voice;
  voice.setAttribute('title', S.voice);
  voice.setAttribute('data-whole', S.voice);
  voice.setAttribute('data-short', S.voiceShort || shortVoice(S.voice));
  fitVoice();

  var startT = document.getElementById('v2-start-t');
  if (startT) startT.textContent = running ? 'Keep going' : S.label;

  /* the box, or the calm line in its place when there is no clock */
  var bx = document.getElementById('v2-box');
  var bnote = document.getElementById('v2-box-note');
  if (bx && bnote) {
    if (S.noBox) { bx.setAttribute('data-off', '1'); bx.setAttribute('aria-hidden', 'true'); bnote.hidden = false; }
    else { bx.removeAttribute('data-off'); bx.removeAttribute('aria-hidden'); bnote.hidden = true; }
    var bxv = box();
    var btns = bx.querySelectorAll('.v2-boxbtn');
    for (var k = 0; k < btns.length; k++) {
      var on2 = Number(btns[k].getAttribute('data-min')) === bxv;
      btns[k].setAttribute('aria-checked', on2 ? 'true' : 'false');
      btns[k].setAttribute('tabindex', on2 && !S.noBox ? '0' : '-1');
    }
  }

  /* the one "next:" line */
  var nextT = document.getElementById('v2-next-t');
  if (nextT) { nextT.textContent = S.next; nextT.setAttribute('title', S.next); }

  /* what fits in the box, or a calm line in the same rows */
  var plan = document.getElementById('v2-plan');
  var note = document.getElementById('v2-plan-note');
  if (plan && note) {
    var chips = S.note ? [] : chipsFor(S);
    plan.textContent = '';
    if (chips.length) {
      chips.forEach(function (c) {
        var li = APP.el('li', { 'class': 'v2-plan-i fu-chip', 'data-kind': String(c.kind || '') });
        li.appendChild(APP.el('span', { text: c.text }));
        if (c.minutes) li.appendChild(APP.el('b', { 'class': 'fu-mono', text: c.minutes + "'" }));
        else if (c.meta) li.appendChild(APP.el('b', { 'class': 'fu-mono', text: c.meta }));
        if (c.title) li.setAttribute('title', c.title + (c.minutes ? ' · ' + c.minutes + ' min' : (c.meta ? ' · ' + c.meta : '')));
        plan.appendChild(li);
      });
      plan.appendChild(APP.el('li', { 'class': 'v2-plan-i fu-chip v2-plan-more', hidden: 'hidden' }));
      plan.hidden = false;
      plan.setAttribute('aria-label', 'What fits in ' + S.box + ' minutes');
      note.hidden = true;
      fitChips();
    } else {
      plan.hidden = true;
      note.textContent = S.note || '';
      note.hidden = !S.note;
    }
  }

  /* the week's path: steps done, never a percentage in words. No week: the row
     keeps its place, empty. */
  var bar = document.getElementById('v2-prog-bar');
  var fill = document.getElementById('v2-prog-fill');
  var pt = document.getElementById('v2-prog-t');
  var progBox = document.getElementById('v2-prog');
  if (bar && fill && pt && progBox) {
    var pr = S.pr;
    if (pr && S.w) {
      var d = Math.min(pr.done, pr.total);
      fill.style.width = (100 * d / pr.total).toFixed(2) + '%';
      bar.setAttribute('aria-valuemax', String(pr.total));
      bar.setAttribute('aria-valuenow', String(d));
      bar.setAttribute('aria-label', 'Week ' + S.w.n + ' path');
      pt.textContent = S.allDone ? 'all ' + pr.total + ' steps done' : d + ' of ' + plural(pr.total, 'step') + ' done';
      progBox.removeAttribute('data-off');
      progBox.removeAttribute('aria-hidden');
    } else {
      pt.textContent = '';
      fill.style.width = '0%';
      progBox.setAttribute('data-off', '1');
      progBox.setAttribute('aria-hidden', 'true');
    }
  }
}

function paintSlots(now) {
  var P = paths();
  var weeks = (APP.schedule() && APP.schedule().weeks) || [];
  var today = now.today || APP.todayISO();

  /* 1. the week just done (or the one before the target, so the slot never empties).
     Named as Weeks names it; no counts: a calm line and an optional way back in. */
  var jd = now.justDone;
  var label = 'Just done';
  if (!jd) {
    var tn = now.target ? now.target.n - 1 : (weeks.length ? weeks[weeks.length - 1].n : null);
    jd = tn != null && tn >= 0 ? APP.weekByN(tn) : null;
    label = now.target ? 'Last week' : 'Last Saturday';
  }
  if (jd) {
    var pw = P ? safe(function () { return P.week(jd.n); }, null) : null;
    var pr = P ? safe(function () { return P.progress(jd.n); }, null) : null;
    var spec = {
      label: label + ' · W' + jd.n, title: weekName(jd, pw), voice: true,
      hash: 'weeks/' + jd.n, ch: APP.chapterKey(jd.n)
    };
    if (now.phase === 'after') {
      spec.sub = 'every week stays open.';
      spec.state = 'done'; spec.ch = null;
    } else if (!pr || !pr.total) {
      spec.sub = APP.prettyDate(jd.saturday) + ' · open the week';
      spec.voice = false;
    } else if (pr.done >= pr.total) {
      spec.sub = 'week ' + jd.n + ', done. it keeps.';
      spec.state = 'done'; spec.ch = null;
    } else if (pr.done > 0) {
      spec.sub = 'pick up where you stopped, if you like.';
      var nx = safe(function () { return P.next(jd.n); }, null);
      if (nx && nx.hash) spec.hash = nx.hash;
    } else {
      spec.sub = 'there whenever you want it.';
    }
    setSlot('done', spec);
  } else {
    setSlot('done', { label: 'Just done', title: 'No Saturday yet', sub: 'the first one is on its way.', voice: true, hash: 'weeks' });
  }

  /* 2. recall: what is due today, else when the next ones come back */
  var rc = recallInfo();
  if (rc) {
    if (rc.due) setSlot('recall', { title: plural(rc.due, 'thing') + ' to look at again', sub: 'five minutes at a time.', voice: true, hash: 'practice/recall' });
    else if (rc.next) setSlot('recall', { title: 'Nothing due today', sub: comeBack(rc), voice: true, hash: 'practice/recall' });
    else if (rc.total) setSlot('recall', { title: 'Nothing due today', sub: 'all quiet for now.', voice: true, hash: 'practice/recall' });
    else setSlot('recall', { title: 'Nothing to recall yet', sub: 'misses and shaky cards land here.', voice: true, hash: 'practice/recall' });
  } else {
    var saved = safe(function () { return APP.review.list().length; }, 0);
    setSlot('recall', {
      title: saved ? plural(saved, 'saved sentence') : 'Nothing saved yet',
      sub: saved ? 'from the packs and demos' : 'select a sentence in any pack and save it.',
      voice: !saved, hash: 'practice'
    });
  }

  /* 3. capstone: freeze Sat 5 Dec 6pm, talk Sat 12 Dec */
  var cap = capInfo(today);
  var dF = cap.dF, dT = cap.dT, next = cap.next;
  var cspec;
  if (dT < 0) cspec = { title: 'Talk given', sub: 'sat 12 dec. well done.', voice: true, state: 'done' };
  else if (cap.frozen) cspec = {
    title: dT === 0 ? 'The talk is today' : plural(dT, 'day') + ' to the talk',
    sub: dT === 0 ? 'you know this. say it like you would to a friend.'
      : (dF === 0 ? 'results froze at 6pm. rest tonight; the talk can wait a day.' : 'results froze sat 5 dec. one run-through today is plenty.'),
    voice: true
  };
  else if (dF === 0) cspec = { title: 'Freeze today, 6pm', sub: 'save what you have before six. that is the whole job today.', voice: true };
  else cspec = {
    title: plural(dF, 'day') + ' to the freeze',
    sub: next && next.title ? 'next: ' + next.title + (next.date ? ' · ' + whenDate(next.date, today) : '') : 'one small thing today is plenty.',
    voice: !(next && next.title)
  };
  cspec.hash = (next && next.hash) || 'lab';
  cspec.ch = cspec.state === 'done' ? null : 'project';
  setSlot('capstone', cspec);
}

function paintStrip(now) {
  var strip = document.getElementById('v2-wkstrip');
  if (!strip) return;
  var P = paths();
  var t = now.target ? now.target.n : null;
  var jd = now.justDone ? now.justDone.n : null;
  var links = strip.querySelectorAll('.v2-wk');
  for (var i = 0; i < links.length; i++) {
    var a = links[i], n = Number(a.getAttribute('data-wk'));
    var w = APP.weekByN(n);
    var d = a.querySelector('.v2-wk-d');
    if (n === t) { a.setAttribute('data-now', '1'); a.setAttribute('aria-current', 'date'); if (d) d.textContent = now.isSaturday ? 'today' : 'next'; }
    else { a.removeAttribute('data-now'); a.removeAttribute('aria-current'); if (d && w) d.textContent = APP.dayMonth(w.saturday); }
    if (n === jd) a.setAttribute('data-just', '1'); else a.removeAttribute('data-just');
    if (w) a.setAttribute('data-past', w.saturday < now.today ? '1' : '0');
    var pw = P ? safe(function () { return P.week(n); }, null) : null;
    if (w) a.setAttribute('title', 'Week ' + n + ' · ' + APP.prettyDate(w.saturday) + ' · ' + weekName(w, pw) + (n === 0 ? ' (no Saturday session)' : ''));
    var pr = P ? safe(function () { return P.progress(n); }, null) : null;
    var p = a.querySelector('.v2-wk-p');
    if (p) {
      if (pr && pr.total) {
        var f = Math.min(1, pr.done / pr.total);
        p.style.width = (Math.round(f * 1000) / 10) + '%';
        a.setAttribute('data-prog', f >= 1 ? 'done' : (f > 0 ? 'some' : 'none'));
      } else { p.style.removeProperty('width'); a.removeAttribute('data-prog'); }
    }
  }
  /* bring the target into view in the sideways strip without moving the page */
  var cur = strip.querySelector('.v2-wk[data-now="1"]');
  if (cur && strip.scrollWidth > strip.clientWidth + 2 && !strip.__centred) {
    strip.__centred = 1;
    strip.scrollLeft = Math.max(0, cur.offsetLeft - (strip.clientWidth - cur.offsetWidth) / 2);
  }
}

function paint() {
  var el = document.getElementById('app-sec-today');
  if (!el || el.getAttribute('data-built') !== '1') return;
  var now = APP.v2now();
  paintHero(now);
  paintSlots(now);
  paintStrip(now);
}
APP._paintToday = paint;

APP.registerSection({
  id: 'today',
  title: 'Today',
  mount: function (el) {
    build(el);
    paint();
    var P = paths();
    if (P && P.ready && typeof P.ready.then === 'function' && !P.__todayHooked) {
      P.__todayHooked = 1;
      P.ready.then(paint, function () {});
    }
  },
  onTier: function () { /* Today has no tiered prose */ }
});

['tara:path', 'tara:recall', 'tara:session', 'tara:review', 'tara:capstone'].forEach(function (ev) {
  window.addEventListener(ev, function () { paint(); });
});
document.addEventListener('visibilitychange', function () { if (!document.hidden) paint(); });
/* paths.json may arrive after Today's first paint */
APP.onBoot(function () {
  var P = paths();
  if (P && P.ready && typeof P.ready.then === 'function') P.ready.then(paint, function () {});
});
