/* src/v2/session.js — the study session (owner: shell).
   Started only from Today's Start button. While it runs, a slim bar sits in
   normal flow under the top bar (never over content): "12 of 30 min" and End.
   When the box is up it says so, calmly, in the same row and at the same
   height ("time's up." with Stop here / Keep going in place of the time), so
   nothing under it moves mid-read. State lives in localStorage tara.v2.session
   and closes on its own once the box plus an hour has passed; when that
   happens while the app is open (or not long before it is opened again) a
   short toast says so, and a session forgotten for longer goes quietly, so it
   never nags the next day. Landscape phones (max-height 500px) get one thin row.

   APP.session.start(minutes, extra?) -> state
   APP.session.end(quiet?)
   APP.session.state() -> { startedAt, minutes, week?, over? } | null
   APP.session.elapsed() -> minutes | null
   APP.session.keepGoing()
   window event 'tara:session' { state } on every change. */

'use strict';

var SKEY = 'tara.v2.session';
var GRACE_MIN = 60;            /* after the box, how long a session waits before it closes itself */
var NOTE_WITHIN_MIN = 180;     /* closed longer ago than this when we notice: no toast, it just goes */
var tick = 0;
var wasAsking = false;
var noted = 0;                 /* startedAt of the last session whose closing was noted */

function now() { return Date.now(); }

function expiresAt(s) { return Number(s.startedAt) + (Number(s.minutes) + GRACE_MIN) * 60000; }

function readState() {
  var s = null;
  try { s = JSON.parse(localStorage.getItem(SKEY) || 'null'); } catch (e) { s = null; }
  if (!s || typeof s !== 'object' || !s.startedAt || !s.minutes) return null;
  if (now() > expiresAt(s)) {             /* the box and the grace are over: close it, and say so once */
    try { localStorage.removeItem(SKEY); } catch (e) {}
    closedOnItsOwn(s);
    return null;
  }
  return s;
}
function writeState(s) {
  try {
    if (s) localStorage.setItem(SKEY, JSON.stringify(s));
    else localStorage.removeItem(SKEY);
  } catch (e) {}
}
function emit() {
  try { window.dispatchEvent(new CustomEvent('tara:session', { detail: { state: readState() } })); } catch (e) {}
}

/* A session that ran out of grace: the bar goes, Today repaints, and if this is
   close to when it happened, one calm line says so (never the next day). */
function closedOnItsOwn(s) {
  if (noted === s.startedAt) return;
  noted = s.startedAt;
  var late = now() - expiresAt(s);
  setTimeout(function () {
    paint(); emit();
    if (late <= NOTE_WITHIN_MIN * 60000 && typeof APP.toast === 'function') APP.toast('the session closed on its own. it still counts.');
  }, 0);
}

function elapsedMin(s) { return Math.max(0, Math.floor((now() - s.startedAt) / 60000)); }

APP.session = {
  start: function (minutes, extra) {
    var m = Number(minutes);
    if (!(m > 0)) m = 30;
    var s = { startedAt: now(), minutes: m };
    if (extra && typeof extra === 'object') for (var k in extra) if (!(k in s)) s[k] = extra[k];
    writeState(s);
    paint(); emit();
    return s;
  },
  end: function (quiet) {
    var had = readState();
    writeState(null);
    paint(); emit();
    if (had && !quiet) APP.toast('session done. that counts.');
  },
  state: function () {
    var s = readState();
    return s ? { startedAt: s.startedAt, minutes: s.minutes, week: s.week, over: !!s.over } : null;
  },
  /* minutes since start, or null without a session */
  elapsed: function () { var s = readState(); return s ? elapsedMin(s) : null; },
  keepGoing: function () {
    var s = readState();
    if (!s) return;
    s.over = true;
    writeState(s);
    paint(); emit();
  }
};

/* ------------------------------------------------------------------- bar */

function bar() { return document.getElementById('v2-session'); }

function build(el) {
  if (el.getAttribute('data-built') === '1') return;
  el.setAttribute('data-built', '1');
  el.textContent = '';
  var E = APP.el;
  var row = E('div', { 'class': 'v2-sess-row' });
  var dot = E('span', { 'class': 'v2-sess-dot', 'aria-hidden': 'true' });
  var txt = E('span', { 'class': 'v2-sess-t', id: 'v2-sess-t' });
  var prog = E('span', { 'class': 'v2-sess-track fu-progress fu-progress--thin', 'aria-hidden': 'true' }, [E('span', { 'class': 'v2-sess-fill fu-progress__fill', id: 'v2-sess-fill' })]);
  /* time's up: the same row, the same height; the line and two ways on take the time's place */
  var ask = E('span', { 'class': 'v2-sess-ask', id: 'v2-sess-ask', hidden: 'hidden' });
  ask.appendChild(E('span', { 'class': 'v2-sess-q fu-voice' }, [
    document.createTextNode('time’s up.'),
    E('span', { 'class': 'v2-sess-q2', text: ' a good place to stop; it will be here next time.' })
  ]));
  var stop = E('button', { 'class': 'v2-sess-btn fu-btn fu-btn--small', type: 'button', 'data-act': 'stop', text: 'Stop here' });
  var more = E('button', { 'class': 'v2-sess-btn fu-btn fu-btn--small fu-btn--ghost', type: 'button', 'data-act': 'more', text: 'Keep going' });
  ask.appendChild(stop); ask.appendChild(more);
  var end = E('button', { 'class': 'v2-sess-btn v2-sess-end fu-btn fu-btn--small fu-btn--ghost', type: 'button', 'data-act': 'end', id: 'v2-sess-end', text: 'End', 'aria-label': 'End the session' });
  /* for screen readers: said once, when the box is up */
  var live = E('span', { 'class': 'v2-sess-live', id: 'v2-sess-live', 'aria-live': 'polite' });
  row.appendChild(dot); row.appendChild(txt); row.appendChild(prog); row.appendChild(ask); row.appendChild(end); row.appendChild(live);
  el.appendChild(row);
  el.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    if (act === 'end' || act === 'stop') APP.session.end();
    else if (act === 'more') { APP.session.keepGoing(); APP.toast('carry on. end it whenever you like.'); }
  });
}

function paint() {
  var el = bar();
  if (!el) return;
  var s = readState();
  var on = !!s;
  if (el.hidden === on) el.hidden = !on;
  document.documentElement.toggleAttribute('data-session', on);
  if (!on) { wasAsking = false; stopTick(); return; }
  build(el);
  var m = elapsedMin(s), box = Number(s.minutes);
  var up = m >= box;
  var t = document.getElementById('v2-sess-t');
  if (t) t.textContent = m + ' of ' + box + ' min';
  var fill = document.getElementById('v2-sess-fill');
  if (fill) fill.style.width = Math.min(100, Math.round(100 * m / box)) + '%';
  var ask = document.getElementById('v2-sess-ask');
  var asking = up && !s.over;
  if (ask && ask.hidden === asking) ask.hidden = !asking;
  var end = document.getElementById('v2-sess-end');
  if (end && end.hidden === !asking) end.hidden = asking;
  el.setAttribute('data-state', asking ? 'ask' : (up ? 'over' : 'run'));
  var live = document.getElementById('v2-sess-live');
  if (live) {
    if (asking && !wasAsking) live.textContent = 'time’s up. stop here, or keep going?';
    else if (!asking && live.textContent) live.textContent = '';
  }
  wasAsking = asking;
  startTick();
}

function startTick() {
  if (tick) return;
  tick = setInterval(function () {
    if (document.hidden) return;
    paint();
  }, 15000);
}
function stopTick() { if (tick) { clearInterval(tick); tick = 0; } }

document.addEventListener('visibilitychange', function () { if (!document.hidden) paint(); });
window.addEventListener('storage', function (e) { if (e && e.key === SKEY) { paint(); emit(); } });
APP.onBoot(paint);
