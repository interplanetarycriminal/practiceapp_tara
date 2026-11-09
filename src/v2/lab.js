/* src/v2/lab.js — V2's Lab tab: #lab and #lab/<rest>. Owner: capstone.

   One page in fixed slots, top to bottom (nothing ever moves; text swaps in place):
     1. runway    the Capstone runway: days to the results freeze and to the talk, five
                  milestones with today's place marked, "your pick" (one line, kept on
                  this device only) and two links that open in claude.ai
     2. weeks     weeks 12 to 14: the plan's checklist (ticks shared with the plan and the
                  Weeks tab through tara.fourteen.v1) and the capstone pack, section by section
     3. talk-card the talk builder's card; #lab/talk is the builder itself
     4. door      the Lab (lab/index.html) in this same window, never in the viewer: it needs
                  its own window for the local Qwen server
     5. missions  this week's Lab missions (APP.paths.week(n).missions, else the Lab's own list)
     6. results   the three newest results from the 3090 bench (lab/findings/index.json)
   #lab/<block> (runway, weeks, talk-card, door, missions, results) and #lab/week-12..14
   open the page at that block.

   Also APP.capstone.summary(iso?) for Today's capstone slot (dates only, synchronous).

   Storage. Written: tara.v2.capstone = { v, pick, talk: { question, why, did, result, means,
   next } } (only what the learner types); tara.fourteen.v1 ticks w<N>p<k> / w<N>e<k>,
   re-read before every write, written only when its __order is "tara" (or when it is empty,
   which is exactly what the plan's own first run writes). Read: tara.lab.done (the Lab's
   mission ticks). Every storage call is wrapped; nothing here throws on a locked-down browser.

   Styling: the brand's fu-* components (src/brand/BRAND.md); lab-* classes are layout only.
   Public site: no capstone idea, no names, nothing personal in this file. */
(function () {
  'use strict';

  var APP = (window.APP = window.APP || {});

  /* ================================================================ constants */

  var START = '2026-11-28';          // W12: the project phase starts
  var RUNS = '2026-12-04';           // the last day for experiments (Fri)
  var FREEZE = '2026-12-05';         // W13: results freeze at 6pm
  var REHEARSE = '2026-12-06';       // rehearsal week, Sun 6 to Fri 11 Dec
  var REHEARSE_END = '2026-12-11';
  var TALK = '2026-12-12';           // W14: the talk
  var FREEZE_AT = Date.parse('2026-12-05T18:00:00+10:00');   // 6pm AEST (UTC+10), the course's time zone

  var KEY = 'tara.v2.capstone';
  var TICKS = 'tara.fourteen.v1';
  var LAB_DONE = 'tara.lab.done';

  var LAB = 'lab/index.html';
  var IDEAS_URL = 'https://claude.ai/artifact/33LioUpULRJHo7QZTevQFU';
  var PLAN_URL = 'https://claude.ai/artifact/XJzMjRkV1JhbMA7LYYAKbc';
  var PACK = 'capstone-weeks-12-14';

  var WPM = 150;                     // spoken words a minute
  var TALK_LO = 8, TALK_HI = 10;     // the talk, in minutes: the one place its length is set (the capstone pack's ten-minute slot)
  var METER_MAX = TALK_HI + 1;       // the meter's right end, in minutes
  var NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
  var SPAN_W = (NUM[TALK_LO] || TALK_LO) + ' to ' + (NUM[TALK_HI] || TALK_HI);   // 'five to seven'
  var SPAN_D = TALK_LO + ' to ' + TALK_HI;                                       // '5 to 7'

  /* The talk: six fixed parts. w is each part's share; aim (seconds) is that share of the
     middle of the talk's length (8 to 10 minutes: 45, 70, 115, 180, 90 and 45 s, about nine minutes). */
  var PARTS = [
    { id: 'question', title: 'The question', w: 2,
      prompt: 'one sentence, ending in a question mark. smaller than feels impressive.' },
    { id: 'why', title: 'Why it matters for alignment', w: 3,
      prompt: 'the risk it touches, in plain words. one reason is plenty.' },
    { id: 'did', title: 'What I did', w: 5,
      prompt: 'model, data, and the one thing you changed. picture the diagram.' },
    { id: 'result', title: 'The result and its control', w: 8,
      prompt: 'the number, and the control it beat. the control is what makes it a result.' },
    { id: 'means', title: 'What it means, and its limits', w: 4,
      prompt: 'what you can now say, and the bigger claim you are careful not to make.' },
    { id: 'next', title: "What's next", w: 2,
      prompt: "the experiment you'd run with another month. one is enough." }
  ];
  (function () {
    var units = 0, mid = (TALK_LO + TALK_HI) / 2 * 60;
    PARTS.forEach(function (p) { units += p.w; });
    PARTS.forEach(function (p) { p.aim = Math.round(p.w * mid / units / 5) * 5; });
  })();

  /* The runway's milestones, in their fixed places along the track (pos, 0..1). */
  var MS = [
    { id: 'start', date: START, pos: 0.08, when: '28 Nov', short: 'Start', long: 'Project phase starts', day: 'Saturday 28 November', week: 12 },
    { id: 'runs', date: RUNS, pos: 0.29, when: '4 Dec', short: 'Last runs', long: 'Last experiment runs', day: 'Friday 4 December' },
    { id: 'freeze', date: FREEZE, pos: 0.5, when: '5 Dec', short: 'Freeze 6pm', long: 'Results freeze, 6pm', day: 'Saturday 5 December', week: 13 },
    { id: 'rehearse', date: REHEARSE, pos: 0.71, when: '6–11 Dec', short: 'Rehearse', long: 'Rehearse the talk', day: 'Sunday 6 to Friday 11 December' },
    { id: 'talk', date: TALK, pos: 0.92, when: '12 Dec', short: 'Talk', long: 'The talk', day: 'Saturday 12 December', week: 14 }
  ];
  var LEAD_IN = 21;                  // days before the start over which today's pin creeps in

  /* The capstone pack's sections as of this build, so the list has its height on first
     paint; the pack payload is read on first open and replaces it if it ever changes. */
  var PACK_FALLBACK = [
    ['budget', '00', 'What you actually have'], ['early', '01', 'Pick early, not at week 12'],
    ['projects', '02', 'The candidate list'], ['scoping', '03', 'Cutting a question until it fits'],
    ['derisk', '04', 'The de-risking checklist'], ['weeks', '05', 'The three weeks, day by day'],
    ['hygiene', '06', 'Research hygiene'], ['talk', '07', 'The ten minutes you are graded on'],
    ['claims', '08', 'Not overclaiming'], ['resources', '09', 'Resources'], ['card', '10', 'The one-page card']
  ];

  var KINDS = { steer: 'Steering', probe: 'Probe', features: 'Features', diff: 'Model diff',
    circuit: 'Circuit', graph: 'Attribution graph' };

  var BLOCKS = { runway: 1, weeks: 1, 'talk-card': 1, door: 1, missions: 1, results: 1 };

  /* ==================================================================== dates */

  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
    'October', 'November', 'December'];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var DOWL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function isISO(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
  function localISO(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function overrideISO() {
    try { if (typeof APP.dateOverride === 'function') return APP.dateOverride() || null; } catch (e) { /* */ }
    try {
      var m = /[?&]today=(\d{4}-\d{2}-\d{2})(?:&|$)/.exec(location.search || '');
      return m ? m[1] : null;
    } catch (e) { return null; }
  }
  /* The shell's today (it honours ?today=YYYY-MM-DD); the same rule when it is absent. */
  function todayISO() {
    try {
      if (typeof APP.todayISO === 'function') { var t = APP.todayISO(); if (isISO(t)) return t; }
    } catch (e) { /* */ }
    return overrideISO() || localISO(new Date());
  }
  function utc(iso) { var p = iso.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function days(a, b) { return Math.round((utc(b) - utc(a)) / 864e5); }
  function dateOf(iso) { var p = iso.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function isoAdd(iso, n) { var d = dateOf(iso); d.setDate(d.getDate() + n); return localISO(d); }
  function pretty(iso) { var d = dateOf(iso); return DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MON[d.getMonth()]; }
  function dayMonth(iso) { var d = dateOf(iso); return d.getDate() + ' ' + MON[d.getMonth()]; }
  function longDate(iso) { var d = dateOf(iso); return DOWL[d.getDay()] + ' ' + d.getDate() + ' ' + MONL[d.getMonth()]; }

  /* Frozen as of today t. On 5 Dec itself it is the clock that decides, unless a date is
     being tried out with ?today= (no clock then: the freeze is still ahead, at 6pm). */
  function isFrozen(t) {
    if (t > FREEZE) return true;
    if (t < FREEZE) return false;
    return !overrideISO() && Date.now() >= FREEZE_AT;
  }

  /* The week this is about: the shell's target (the next Saturday, today if it is one). */
  function targetWeek(t) {
    try {
      if (typeof APP.v2now === 'function') {
        var v = APP.v2now(t);
        if (v && v.target && typeof v.target === 'object' && v.target.n != null) return Number(v.target.n);
        if (v && typeof v.target === 'number') return v.target;
        if (v && !v.target && v.phase === 'after') return null;
      }
    } catch (e) { /* */ }
    var n = Math.ceil(days('2026-09-05', t) / 7);       // W0 is Sat 5 Sep; one Saturday a week
    return n > 14 ? null : Math.max(0, n);
  }
  function saturdayOf(n) {
    try { var w = typeof APP.weekByN === 'function' && APP.weekByN(n); if (w && isISO(w.saturday)) return w.saturday; } catch (e) { /* */ }
    return isoAdd('2026-09-05', 7 * n);
  }

  /* The next milestone, for Today's capstone slot. */
  function nextMilestone(t) {
    if (t <= START) return { title: 'Project phase starts', date: START, hash: '#lab/week-12' };
    if (t <= RUNS) return { title: 'Experiments wrap up', date: RUNS, hash: '#lab/week-12' };
    if (!isFrozen(t)) return { title: 'Results freeze at 6pm', date: FREEZE, hash: '#lab/week-13' };
    return { title: 'The talk', date: TALK, hash: '#lab/talk' };
  }

  APP.capstone = APP.capstone || {};
  APP.capstone.summary = function (iso) {
    var t = isISO(iso) ? iso : todayISO();
    return {
      freeze: FREEZE,
      talk: TALK,
      daysToFreeze: days(t, FREEZE),
      daysToTalk: days(t, TALK),
      next: nextMilestone(t)
    };
  };

  /* Today's place on the track (0..1), between the milestones' fixed places. */
  function pinPos(t) {
    if (t > TALK) return 0.98;
    if (t < START) return Math.max(0, MS[0].pos * (1 - days(t, START) / LEAD_IN));
    for (var i = MS.length - 1; i >= 0; i--) {
      if (t >= MS[i].date) {
        if (i === MS.length - 1) return MS[i].pos;
        var span = days(MS[i].date, MS[i + 1].date);
        var f = span > 0 ? days(MS[i].date, t) / span : 0;
        return MS[i].pos + f * (MS[i + 1].pos - MS[i].pos);
      }
    }
    return 0;
  }

  /* ================================================================== storage */

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function readJSON(k) {
    var raw = lsGet(k);
    if (raw == null) return { ok: true, absent: true, value: {} };
    try {
      var v = JSON.parse(raw);
      return v && typeof v === 'object' && !Array.isArray(v) ? { ok: true, value: v } : { ok: false, value: {} };
    } catch (e) { return { ok: false, value: {} }; }
  }

  /* --- the learner's own lines: tara.v2.capstone */
  function readCap() {
    var v = readJSON(KEY).value;
    var talk = v.talk && typeof v.talk === 'object' ? v.talk : {};
    var out = { v: 1, pick: typeof v.pick === 'string' ? v.pick : '', talk: {} };
    PARTS.forEach(function (p) { out.talk[p.id] = typeof talk[p.id] === 'string' ? talk[p.id] : ''; });
    return out;
  }
  /* re-read, change, write: two tabs typing into two different parts both keep their words */
  function writeCap(change) {
    var c = readCap();
    change(c);
    return lsSet(KEY, JSON.stringify(c));
  }

  /* --- the plan's ticks: tara.fourteen.v1, shared with the plan and the Weeks tab.
     Never held in memory between writes: every read and every write starts from storage. */
  function readTicks() { return readJSON(TICKS); }
  function setTick(k, on) {
    var r = readTicks();
    if (!r.ok) return false;
    var s = r.value;
    var empty = Object.keys(s).length === 0;
    if (s.__order !== 'tara' && !empty) return false;     // older ticks wait for the plan to move them
    s.__order = 'tara';
    if (on) s[k] = 1; else delete s[k];
    if (!lsSet(TICKS, JSON.stringify(s))) return false;
    /* a plan frame kept alive by the shell holds the old ticks in memory; it reloads fresh */
    try { if (APP.frames && typeof APP.frames.drop === 'function' && APP.frames.has && APP.frames.has('plan')) APP.frames.drop('plan'); } catch (e) { /* */ }
    try { window.dispatchEvent(new CustomEvent('tara:ticks', { detail: { key: k, on: !!on, source: 'lab' } })); } catch (e) { /* */ }
    return true;
  }

  function labDone() { var r = readJSON(LAB_DONE); return r.ok ? r.value : {}; }

  /* ================================================================== helpers */

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    if (kids) add(n, kids);
    return n;
  }
  function add(n, kids) {
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) add(n, c);
      else n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
  }
  function sr(text) { return el('span', { 'class': 'fu-sr', text: text }); }
  function toast(msg) { try { if (typeof APP.toast === 'function') APP.toast(msg); } catch (e) { /* */ } }
  function withTimeout(p, ms) {
    return Promise.race([Promise.resolve(p).catch(function () { return null; }),
      new Promise(function (res) { setTimeout(function () { res(null); }, ms); })]);
  }
  function capFirst(s) { s = String(s || '').trim(); return s.charAt(0).toUpperCase() + s.slice(1); }
  function plural(n, one, many) { return n === 1 ? one : many; }

  /* Authored HTML from a payload (the plan's checklist items) as safe nodes: text, plus b,
     strong, i, em and code. Everything else is flattened to its text. */
  var KEEP = { B: 1, STRONG: 1, I: 1, EM: 1, CODE: 1 };
  function richText(html) {
    var tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');           // inert: nothing in a template runs or loads
    var frag = document.createDocumentFragment();
    (function walk(src, dst) {
      for (var c = src.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) dst.appendChild(document.createTextNode(c.nodeValue));
        else if (c.nodeType === 1) {
          if (KEEP[c.tagName]) {
            var e = document.createElement(c.tagName.toLowerCase());
            if (c.tagName === 'CODE') e.className = 'fu-code';
            walk(c, e);
            dst.appendChild(e);
          } else walk(c, dst);
        }
      }
    })(tpl.content, frag);
    return frag;
  }

  /* A JavaScript literal (arrays, objects, strings, numbers; identifiers read as null),
     enough to read the plan's `var WEEKS = [...]` without running any of its code. */
  function readLiteral(src, at) {
    var i = at;
    function ws() {
      for (;;) {
        var c = src[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
        if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
        if (c === '/' && src[i + 1] === '*') { var e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
        return;
      }
    }
    function str() {
      var q = src[i++], out = '';
      while (i < src.length) {
        var c = src[i++];
        if (c === q) return out;
        if (c !== '\\') { out += c; continue; }
        var n = src[i++];
        if (n === 'n') out += '\n';
        else if (n === 't') out += '\t';
        else if (n === 'u') { out += String.fromCharCode(parseInt(src.substr(i, 4), 16)); i += 4; }
        else if (n !== '\n') out += n;
      }
      throw new Error('unterminated string');
    }
    function val() {
      ws();
      var c = src[i], m;
      if (c === '[') {
        i++;
        var arr = [];
        for (;;) {
          ws();
          if (src[i] === ']') { i++; return arr; }
          arr.push(val()); ws();
          if (src[i] === ',') i++;
          else if (src[i] !== ']') throw new Error('expected , or ] at ' + i);
        }
      }
      if (c === '{') {
        i++;
        var obj = {};
        for (;;) {
          ws();
          if (src[i] === '}') { i++; return obj; }
          var key;
          if (src[i] === '"' || src[i] === "'") key = str();
          else {
            m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 80));
            if (!m) throw new Error('bad key at ' + i);
            key = m[0]; i += key.length;
          }
          ws();
          if (src[i] !== ':') throw new Error('expected : at ' + i);
          i++;
          obj[key] = val(); ws();
          if (src[i] === ',') i++;
          else if (src[i] !== '}') throw new Error('expected , or } at ' + i);
        }
      }
      if (c === '"' || c === "'") {
        var s = str(); ws();
        while (src[i] === '+') { i++; s += String(val()); ws(); }
        return s;
      }
      if ((m = /^-?\d+(?:\.\d+)?/.exec(src.slice(i, i + 40)))) { i += m[0].length; return Number(m[0]); }
      if ((m = /^[A-Za-z_$][\w$.]*/.exec(src.slice(i, i + 200)))) {
        i += m[0].length;
        return m[0] === 'true' ? true : m[0] === 'false' ? false : null;
      }
      throw new Error('unexpected ' + JSON.stringify(c) + ' at ' + i);
    }
    return val();
  }

  /* =================================================================== loaders */
  /* Content only (never ticks): the plan's weeks 12-14, the pack's sections, the missions
     and the bench's index, each read once per page load. */

  var _plan = null, _pack = null, _results = null, _missions = {};

  function loadPlan() {
    if (_plan) return _plan;
    _plan = Promise.resolve().then(function () {
      if (typeof APP.payload !== 'function') return null;
      return APP.payload('plan');
    }).then(function (html) {
      if (!html) return null;
      var m = /var\s+WEEKS\s*=\s*\[/.exec(html);
      if (!m) return null;
      var weeks = readLiteral(html, m.index + m[0].length - 1);
      var out = {};
      (weeks || []).forEach(function (w) {
        if (!w || w.n < 12 || w.n > 14) return;
        out[w.n] = {
          n: w.n, date: w.d,
          title: capFirst(String(w.title || '').split(/\s+—\s+/).pop()),
          stage: String(w.chL || '').split('·').pop().trim(),
          pre: Array.isArray(w.pre) ? w.pre : [], ex: Array.isArray(w.ex) ? w.ex : [],
          check: w.check || '', skip: w.skip || ''
        };
      });
      return out[12] && out[13] && out[14] ? out : null;
    }).catch(function (e) { console.warn('lab: the plan checklist did not load', e); _plan = null; return null; });
    return _plan;
  }

  function loadPack() {
    if (_pack) return _pack;
    _pack = Promise.resolve().then(function () {
      if (typeof APP.payload !== 'function') return null;
      return APP.payload('pack:' + PACK);
    }).then(function (html) {
      if (!html || typeof DOMParser !== 'function') return null;
      var doc = new DOMParser().parseFromString(html, 'text/html');   // inert: nothing loads or runs
      var out = [];
      Array.prototype.forEach.call(doc.querySelectorAll('section[id]'), function (s) {
        var h2 = s.querySelector('h2');
        if (!h2 || !s.id) return;
        var num = h2.querySelector('.num');
        var kick = num ? num.textContent.trim() : '';
        var title = h2.textContent.replace(kick, '').replace(/\s+/g, ' ').trim();
        var m = /^(\d+)\s*\/\s*/.exec(kick);
        if (title) out.push([s.id, m ? m[1] : '', title]);
      });
      return out.length ? out : null;
    }).catch(function (e) { console.warn('lab: the capstone pack did not load', e); _pack = null; return null; });
    return _pack;
  }

  function loadResults() {
    if (_results) return _results;
    _results = fetch(new URL('lab/findings/index.json', document.baseURI).href, { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (idx) {
        var packs = idx && Array.isArray(idx.packs) ? idx.packs.slice() : [];
        packs = packs.filter(function (p) { return p && p.id; });
        packs.sort(function (a, b) { return String(b.created || '').localeCompare(String(a.created || '')); });
        return packs.slice(0, 3);
      })
      .catch(function () { _results = null; return null; });
    return _results;
  }

  /* This week's missions: the paths builder's list when it has one, else the Lab's own. */
  function loadMissions(n) {
    if (n == null) return Promise.resolve(null);
    if (_missions[n]) return _missions[n];
    _missions[n] = Promise.resolve().then(function () {
      var P = APP.paths;
      if (!P || typeof P.week !== 'function') return null;
      return withTimeout(P.ready, 2500).then(function () {
        var w = P.week(n);
        return w && Array.isArray(w.missions) && w.missions.length ? w.missions : null;
      });
    }).catch(function () { return null; }).then(function (list) {
      if (list) return list;
      return import(new URL('lab/ui/missions.js', document.baseURI).href).then(function (mod) {
        var fn = mod && mod.missionsFor;
        return typeof fn === 'function' ? fn(n) : null;
      }).catch(function () { return null; });
    }).then(function (list) {
      if (!list) _missions[n] = null;
      return list;
    });
    return _missions[n];
  }

  /* The Lab's own hash for a mission, built the way lab/ui/app.js builds it. */
  function labHash(view, parts, params) {
    var p = [view].concat(parts || []).map(encodeURIComponent).join('/');
    var q = Object.keys(params || {}).filter(function (k) {
      var v = params[k]; return v !== undefined && v !== null && v !== '';
    }).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    return '#' + p + (q ? '?' + q : '');
  }
  function labLink(h) {
    h = String(h || '');
    if (h.charAt(0) === '#') return LAB + h;
    var m = /^(?:\.\.\/|\.\/)?lab\/(?:index\.html)?(#.*)?$/.exec(h);
    if (m) return LAB + (m[1] || '');
    return h;
  }
  /* Straight into the tool or the result. paths.json gives `tool` as a ready link
     ("lab/index.html#tool/steer?preset=rude") and `href` as the week's missions page; the
     Lab's own list gives `tool` as an id with `params`, or a `result` id. */
  function missionHref(m) {
    var t = typeof m.tool === 'string' ? m.tool : '';
    if (t && /[#\/]/.test(t)) return labLink(t);
    if (t) return LAB + labHash('tool', [t], m.params || {});
    if (m.result) return LAB + '#results/' + encodeURIComponent(m.result);
    if (m.href) return labLink(m.href);
    return LAB + '#about';
  }

  function modelName(s) {
    s = String(s || '');
    if (s === 'gpt2') return 'GPT-2 small';
    var q = /^qwen(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)b(-base)?$/i.exec(s);
    return q ? 'Qwen ' + q[1] + ' ' + q[2] + 'B' + (q[3] ? ' base' : '') : s;
  }

  /* ==================================================================== build */

  function block(id, label, cls, kids) {
    return el('section', { 'class': 'lab-block lab-b-' + id + (cls ? ' ' + cls : ''), id: 'lab-' + id, 'aria-label': label, 'data-block': id }, kids);
  }
  function head(title, aside) {
    return el('div', { 'class': 'lab-head' }, [el('h2', { 'class': 'fu-h2', text: title }), aside || null]);
  }
  function more(href, text) {
    return el('a', { 'class': 'fu-btn fu-btn--link lab-more', href: href }, [text, el('span', { 'aria-hidden': 'true', text: ' →' })]);
  }

  function buildRunway(ui) {
    var tiles = el('div', { 'class': 'lab-tiles' });
    ui.tiles = {};
    ['freeze', 'talk'].forEach(function (id) {
      var big = el('span', { 'class': 'lab-tile-big', 'aria-hidden': 'true' });
      var lbl = el('span', { 'class': 'lab-tile-k', 'aria-hidden': 'true' });
      var sub = el('span', { 'class': 'lab-tile-s', 'aria-hidden': 'true' });
      var said = el('span', { 'class': 'fu-sr' });
      var t = el('div', { 'class': 'fu-card fu-card--flat lab-tile lab-tile-' + id }, [big, lbl, sub, said]);
      tiles.appendChild(t);
      ui.tiles[id] = { box: t, big: big, k: lbl, s: sub, said: said };
    });

    var track = el('div', { 'class': 'lab-track', 'aria-hidden': 'true' });
    var bar = el('span', { 'class': 'fu-progress fu-progress--thin lab-track-bar' }, [el('span', { 'class': 'fu-progress__fill lab-track-fill' })]);
    track.appendChild(bar);
    ui.fill = bar.firstChild;
    ui.ticks = [];
    MS.forEach(function (m) {
      var tick = el('span', { 'class': 'fu-tick lab-ms-tick' });
      var dot = el('span', { 'class': 'lab-ms', 'data-ms': m.id, style: 'left:' + (m.pos * 100) + '%' }, [
        tick,
        el('span', { 'class': 'lab-ms-t' }, [
          el('b', { 'class': 'lab-ms-date', text: m.when }),
          el('span', { 'class': 'lab-ms-short', text: m.short }),
          el('span', { 'class': 'lab-ms-long', text: m.long })
        ])
      ]);
      track.appendChild(dot);
      ui.ticks.push({ box: dot, tick: tick });
    });
    ui.pinT = el('span', { 'class': 'fu-badge fu-badge--signal lab-pin-t' });
    ui.pin = el('span', { 'class': 'lab-pin' }, [ui.pinT, el('span', { 'class': 'lab-pin-stem' })]);
    track.appendChild(ui.pin);

    /* the same five milestones as a list, for screen readers */
    ui.msList = el('ol', { 'class': 'fu-sr' });
    MS.forEach(function () { ui.msList.appendChild(el('li')); });

    ui.pick = el('input', {
      'class': 'fu-input lab-pick-in', id: 'lab-pick-in', type: 'text', maxlength: '160', autocomplete: 'off',
      spellcheck: 'true', enterkeyhint: 'done', placeholder: 'your question, in one line',
      'aria-describedby': 'lab-pick-note'
    });
    var pick = el('div', { 'class': 'lab-pick' }, [
      el('label', { 'class': 'fu-label lab-pick-k', 'for': 'lab-pick-in', text: 'Your pick' }),
      ui.pick,
      el('p', { 'class': 'fu-small fu-muted lab-fine', id: 'lab-pick-note', text: 'kept on this device only. never sent anywhere.' })
    ]);

    function ext(href, text) {
      return el('a', { 'class': 'fu-btn fu-btn--ghost lab-ext', href: href, target: '_blank', rel: 'noopener' },
        [text, el('span', { 'class': 'lab-ext-ico', 'aria-hidden': 'true', text: '↗' }), sr(' (opens claude.ai in a new tab)')]);
    }
    var links = el('div', { 'class': 'lab-links' }, [ext(IDEAS_URL, 'Your ideas form'), ext(PLAN_URL, 'The Lab research plan')]);

    ui.status = el('p', { 'class': 'fu-voice lab-status' });
    return block('runway', 'Capstone runway', 'fu-window', [
      el('header', { 'class': 'fu-titlebar' }, [el('span', { 'class': 'fu-titlebar__title', text: 'Capstone runway' })]),
      el('div', { 'class': 'fu-window__body lab-runway-body' }, [
        el('h1', { 'class': 'fu-h1 lab-h1', text: 'Three Saturdays and a talk' }),
        ui.status,
        tiles,
        track,
        ui.msList,
        pick,
        links
      ])
    ]);
  }

  function checkItem(n, kind, k, html) {
    var key = 'w' + n + kind + k;
    var box = el('input', { type: 'checkbox', 'class': 'fu-sr lab-check-box', 'data-k': key });
    var tick = el('span', { 'class': 'fu-tick lab-tick', 'aria-hidden': 'true' });
    var li = el('li', { 'class': 'lab-check' }, [el('label', { 'class': 'lab-check-l' }, [box, tick, el('span', { 'class': 'lab-check-t' }, [richText(html)])])]);
    return { li: li, box: box, tick: tick, key: key };
  }

  function buildWeeks(ui, plan, t) {
    ui.boxes = [];
    ui.weekBtns = {};
    ui.weekPanels = {};
    ui.weekDots = {};
    var seg = el('div', { 'class': 'fu-seg fu-seg--wide lab-wkpick', role: 'group', 'aria-label': 'Show one week' });
    var grid = el('div', { 'class': 'lab-wkgrid' });
    var titles = { 12: 'Get a number on the board', 13: 'Scope freeze', 14: 'Final project presentations' };
    [12, 13, 14].forEach(function (n) {
      var w = plan && plan[n];
      var sat = saturdayOf(n);
      var dots = el('span', { 'class': 'lab-dots', 'aria-hidden': 'true' });
      var btn = el('button', { type: 'button', 'class': 'fu-seg__opt lab-wkbtn', 'aria-pressed': 'false', 'aria-controls': 'lab-wk-' + n, 'data-n': String(n) }, [
        el('b', { text: 'W' + n }), el('span', { 'class': 'fu-seg__sub', text: dayMonth(sat) }), dots
      ]);
      btn.addEventListener('click', function () { selectWeek(ui, n); });
      seg.appendChild(btn);
      ui.weekBtns[n] = btn;
      ui.weekDots[n] = dots;

      var panel = el('article', { 'class': 'fu-card lab-wk', id: 'lab-wk-' + n, 'data-n': String(n), 'aria-labelledby': 'lab-wk-h-' + n });
      panel.appendChild(el('p', { 'class': 'fu-label lab-wk-k', text: 'W' + n + ' · ' + pretty(sat) + (w && w.stage ? ' · ' + w.stage : '') }));
      panel.appendChild(el('h3', { 'class': 'fu-h3 lab-wk-h', id: 'lab-wk-h-' + n, text: (w && w.title) || titles[n] }));
      if (!w) {
        panel.appendChild(el('p', { 'class': 'fu-small lab-fine', text: 'the checklist lives in the plan.' }));
      } else {
        [['p', w.pre, 'Before Saturday'], ['e', w.ex, 'On the day']].forEach(function (L) {
          if (!L[1].length) return;
          var ul = el('ul', { 'class': 'lab-checks', 'aria-label': 'W' + n + ', ' + L[2].toLowerCase() });
          L[1].forEach(function (html, k) {
            var c = checkItem(n, L[0], k, html);
            ui.boxes.push(c);
            ul.appendChild(c.li);
            dots.appendChild(el('i', { 'data-k': c.key }));
          });
          panel.appendChild(el('p', { 'class': 'fu-label lab-wk-sub', text: L[2] }));
          panel.appendChild(ul);
        });
        if (w.check) panel.appendChild(el('p', { 'class': 'fu-small lab-wk-note' }, [el('b', { text: 'Done when: ' }), richText(w.check)]));
        if (w.skip) panel.appendChild(el('p', { 'class': 'fu-small lab-wk-note' }, [el('b', { text: 'Skip: ' }), richText(w.skip)]));
      }
      panel.appendChild(more('#plan/week-' + n, 'W' + n + ' in the plan'));
      grid.appendChild(panel);
      ui.weekPanels[n] = panel;
    });

    ui.tickNote = el('p', { 'class': 'fu-small lab-ticknote', hidden: true }, [
      'some older ticks are waiting to move across. ', el('a', { href: '#plan/week-12', text: 'open the plan once' }), ', then tick here.'
    ]);

    /* the capstone pack, section by section (fixed rows; text swaps in when the pack loads) */
    ui.packList = el('nav', { 'class': 'lab-pack', 'aria-label': 'The capstone pack' });
    fillPack(ui, PACK_FALLBACK);
    ui.packCount = el('span', { 'class': 'fu-badge fu-badge--quiet lab-pack-count' });
    var packBox = el('details', { 'class': 'fu-card lab-packbox' }, [
      el('summary', { 'class': 'lab-pack-sum' }, [el('span', { 'class': 'fu-h3', text: 'The capstone pack' }), ui.packCount]),
      ui.packList
    ]);
    ui.packBox = packBox;
    try { if (window.matchMedia && window.matchMedia('(min-width: 720px)').matches) packBox.open = true; } catch (e) { /* */ }

    grid.addEventListener('change', function (e) {
      var b = e.target;
      if (!b || !b.matches || !b.matches('input.lab-check-box')) return;
      var k = b.getAttribute('data-k');
      if (setTick(k, b.checked)) { ui.tickNote.hidden = true; paintTicks(ui); }
      else {
        b.checked = !b.checked;
        ui.tickNote.hidden = false;
        toast('open the plan once so your older ticks move across.');
      }
    });

    selectWeek(ui, defaultWeek(t));
    var nowWeek = targetWeek(t);
    if (ui.weekPanels[nowWeek]) ui.weekPanels[nowWeek].setAttribute('data-now', '1');
    return block('weeks', 'Weeks 12 to 14', '', [
      head('Weeks 12 to 14', more('#plan/week-12', 'The plan')),
      seg,
      grid,
      ui.tickNote,
      packBox
    ]);
  }

  function fillPack(ui, rows) {
    var have = ui.packList.children;
    var same = have.length === rows.length;
    for (var i = 0; same && i < rows.length; i++) if (have[i].getAttribute('data-id') !== rows[i][0]) same = false;
    if (same) {
      for (var j = 0; j < rows.length; j++) {
        have[j].querySelector('.lab-pack-n').textContent = rows[j][1];
        have[j].querySelector('.lab-pack-t').textContent = rows[j][2];
      }
    } else {
      ui.packList.textContent = '';
      rows.forEach(function (r) {
        ui.packList.appendChild(el('a', { 'class': 'fu-item lab-pack-a', href: '#' + PACK + '/' + r[0], 'data-id': r[0] }, [
          el('span', { 'class': 'fu-badge fu-ch-project lab-pack-n', 'aria-hidden': 'true', text: r[1] }),
          el('span', { 'class': 'lab-pack-t', text: r[2] })
        ]));
      });
    }
    if (ui.packCount) ui.packCount.textContent = rows.length + ' sections';
  }

  function defaultWeek(t) {
    var n = targetWeek(t);
    if (n == null) return 14;
    return n < 12 ? 12 : n > 14 ? 14 : n;
  }
  /* On a phone one week shows at a time under the three week buttons (the buttons never
     move); on a wide screen all three stand side by side and the buttons are hidden. */
  function selectWeek(ui, n) {
    ui.week = n;
    [12, 13, 14].forEach(function (m) {
      ui.weekBtns[m].setAttribute('aria-pressed', m === n ? 'true' : 'false');
      ui.weekPanels[m].setAttribute('data-on', m === n ? '1' : '0');
    });
  }

  function paintTicks(ui) {
    var s = readTicks().value || {};
    ui.boxes.forEach(function (c) {
      var on = !!s[c.key];
      c.box.checked = on;
      c.tick.classList.toggle('is-on', on);
      c.li.setAttribute('data-done', on ? '1' : '0');
    });
    [12, 13, 14].forEach(function (n) {
      var dots = ui.weekDots[n].children, done = 0;
      for (var i = 0; i < dots.length; i++) {
        var on = !!s[dots[i].getAttribute('data-k')];
        dots[i].className = on ? 'on' : '';
        if (on) done++;
      }
      ui.weekBtns[n].setAttribute('aria-label', 'Week ' + n + ', ' + longDate(saturdayOf(n)) +
        (dots.length ? ': ' + done + ' of ' + dots.length + ' ticked' : ''));
    });
  }

  function buildTalkCard(ui) {
    ui.talkCardS = el('span', { 'class': 'fu-small lab-card-s' });
    return block('talk-card', 'Talk builder', '', [
      el('a', { 'class': 'fu-card fu-card--lift lab-card lab-talkcard', href: '#lab/talk' }, [
        el('span', { 'class': 'fu-label lab-card-k', text: 'Talk builder' }),
        el('span', { 'class': 'fu-h3 lab-card-t', text: 'Your talk, in six parts' }),
        ui.talkCardS,
        el('span', { 'class': 'lab-card-go', 'aria-hidden': 'true', text: '→' })
      ])
    ]);
  }

  function flask() {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 48 48'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
    s.setAttribute('class', 'lab-door-ico');
    s.innerHTML = '<path d="M18 5h12M20 5v14L8.6 38.4A4 4 0 0 0 12 44.5h24a4 4 0 0 0 3.4-6.1L28 19V5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M13.6 30.5h20.8l5 8A4 4 0 0 1 36 44.5H12a4 4 0 0 1-3.4-6.1z" fill="var(--signal)" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/>' +
      '<circle cx="21" cy="37" r="2" fill="#141A24"/><circle cx="28.5" cy="34.6" r="1.4" fill="#141A24"/>';
    return s;
  }

  function buildDoor() {
    return block('door', 'The Lab', '', [
      el('a', { 'class': 'fu-card fu-card--lift lab-door', href: LAB, 'data-v2-pass': '1' }, [
        el('span', { 'class': 'lab-door-top' }, [
          flask(),
          el('span', { 'class': 'lab-door-body' }, [
            el('span', { 'class': 'fu-label lab-card-k', text: 'The Lab' }),
            el('span', { 'class': 'fu-small lab-door-line', text: 'Twelve tools that take a real language model apart: GPT-2 in this browser, or Qwen 3.5 9B on your 3090.' })
          ])
        ]),
        el('span', { 'class': 'fu-btn fu-btn--big lab-door-btn' }, ['Open the Lab', el('span', { 'aria-hidden': 'true', text: ' →' })])
      ])
    ]);
  }

  function buildMissions(ui, n, list) {
    ui.missionCards = [];
    var grid = el('div', { 'class': 'lab-mgrid' });
    var wk = n == null ? 14 : n;
    if (list && list.length) {
      list.forEach(function (m) {
        if (!m || !m.title) return;
        var done = el('span', { 'class': 'fu-badge fu-badge--gold lab-done', hidden: true }, [el('span', { 'aria-hidden': 'true', text: '✓ ' }), 'done in the Lab']);
        var a = el('a', { 'class': 'fu-card fu-card--lift lab-card lab-mission', href: missionHref(m), 'data-v2-pass': '1', 'data-id': m.id || '' }, [
          el('span', { 'class': 'fu-label lab-card-k', text: 'W' + wk + ' mission' }),
          el('span', { 'class': 'fu-h3 lab-card-t', text: m.title }),
          (m.why || m.sub) ? el('span', { 'class': 'fu-small lab-card-s lab-clamp', text: m.why || m.sub }) : null,
          done,
          el('span', { 'class': 'lab-card-go', 'aria-hidden': 'true', text: '→' })
        ]);
        grid.appendChild(a);
        ui.missionCards.push({ a: a, id: m.id, done: done });
      });
    } else {
      grid.appendChild(el('div', { 'class': 'fu-empty lab-empty' }, [el('p', { 'class': 'fu-empty__line', text: 'this week\'s missions are waiting in the Lab.' })]));
    }
    return block('missions', "This week's missions", '', [
      head("This week's missions", el('span', { 'class': 'fu-label lab-head-k', text: 'W' + wk + ' · ' + pretty(saturdayOf(wk)) })),
      grid,
      el('a', { 'class': 'fu-btn fu-btn--link lab-more', href: LAB + '#missions/week-' + wk, 'data-v2-pass': '1' },
        ['All week ' + wk + ' missions in the Lab', el('span', { 'aria-hidden': 'true', text: ' →' })])
    ]);
  }

  function paintMissionsDone(ui) {
    var d = labDone();
    (ui.missionCards || []).forEach(function (c) {
      var on = !!(c.id && d[c.id]);
      c.done.hidden = !on;
      c.a.classList.toggle('fu-card--done', on);
    });
  }

  function buildResults(ui) {
    ui.resultCards = [];
    var grid = el('div', { 'class': 'lab-rgrid' });
    for (var i = 0; i < 3; i++) {
      var k = el('span', { 'class': 'fu-label lab-card-k' }, [el('span', { 'class': 'fu-skel lab-skel-k' })]);
      var t = el('span', { 'class': 'fu-h3 lab-card-t' }, [el('span', { 'class': 'fu-skel' })]);
      var s = el('span', { 'class': 'fu-small lab-card-s lab-clamp' }, [el('span', { 'class': 'fu-skel lab-skel-s' })]);
      var a = el('a', { 'class': 'fu-card fu-card--lift lab-card lab-result', href: LAB + '#results', 'data-v2-pass': '1' }, [k, t, s]);
      grid.appendChild(a);
      ui.resultCards.push({ a: a, k: k, t: t, s: s });
    }
    return block('results', 'Latest results', '', [
      head('Latest results', el('a', { 'class': 'fu-btn fu-btn--link lab-more', href: LAB + '#results', 'data-v2-pass': '1' },
        ['All results', el('span', { 'aria-hidden': 'true', text: ' →' })])),
      grid
    ]);
  }

  function fillResults(ui, packs) {
    ui.resultCards.forEach(function (c, i) {
      var p = packs && packs[i];
      if (!p) {
        c.a.classList.add('lab-result-empty');
        c.a.href = LAB + '#results';
        c.k.textContent = 'Result';
        c.t.textContent = packs ? 'room for the next one' : 'results open in the Lab';
        c.s.textContent = packs ? 'new results land here after a run on the 3090.' : '';
        return;
      }
      c.a.classList.remove('lab-result-empty');
      c.a.href = LAB + '#results/' + encodeURIComponent(p.id);
      c.k.textContent = [KINDS[p.kind] || capFirst(p.kind || 'Result'), (p.models || []).map(modelName).join(' vs '),
        p.created && isISO(String(p.created).slice(0, 10)) ? dayMonth(String(p.created).slice(0, 10)) : ''].filter(Boolean).join(' · ');
      c.t.textContent = p.title || p.id;
      c.s.textContent = p.headline || p.question || '';
    });
  }

  /* ---------------------------------------------------------------- the talk */

  function fmtTime(sec) {
    sec = Math.round(sec);
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }
  function words(s) { var m = String(s || '').trim().match(/\S+/g); return m ? m.length : 0; }
  function spoken(sec) {
    sec = Math.round(sec / 5) * 5;
    var m = Math.floor(sec / 60), s = sec % 60;
    if (!m) return s + ' seconds';
    return m + ' min' + (s ? ' ' + s + ' s' : '');
  }

  function buildTalk(ui) {
    ui.parts = {};
    var list = el('ol', { 'class': 'lab-parts' });
    PARTS.forEach(function (p, i) {
      var id = 'lab-t-' + p.id;
      var ta = el('textarea', { 'class': 'fu-input lab-part-in', id: id, rows: '3', 'aria-describedby': id + '-p ' + id + '-e', spellcheck: 'true' });
      var est = el('span', { 'class': 'fu-mono lab-part-est', id: id + '-e' });
      list.appendChild(el('li', { 'class': 'fu-card lab-part', 'data-part': p.id }, [
        el('div', { 'class': 'lab-part-h' }, [
          el('span', { 'class': 'lab-part-n', 'aria-hidden': 'true', text: String(i + 1) }),
          el('label', { 'class': 'fu-h3 lab-part-t', 'for': id, text: p.title }),
          est
        ]),
        el('p', { 'class': 'fu-voice lab-part-p', id: id + '-p', text: p.prompt }),
        ta
      ]));
      ui.parts[p.id] = { ta: ta, est: est, part: p };
      ta.addEventListener('input', function () { grow(ta); queueSave(p.id, ta.value); paintTalk(ui); });
      ta.addEventListener('blur', flush);
    });

    ui.meterFill = el('span', { 'class': 'fu-progress__fill lab-meter-fill' });
    var band = el('span', { 'class': 'lab-meter-band', style: 'left:' + (TALK_LO / METER_MAX * 100) + '%;width:' + ((TALK_HI - TALK_LO) / METER_MAX * 100) + '%' },
      [el('span', { 'class': 'fu-label lab-meter-band-k', text: SPAN_D + ' min' })]);
    var ticks = el('span', { 'class': 'lab-meter-ticks fu-mono', 'aria-hidden': 'true' });
    for (var m = 0; m <= METER_MAX; m++) ticks.appendChild(el('span', { style: 'left:' + (m / METER_MAX * 100) + '%', text: String(m) }));
    ui.meterLine = el('p', { 'class': 'fu-small lab-meter-line', 'aria-live': 'polite' });
    ui.talkTitle = el('p', { 'class': 'fu-small lab-talk-title' });

    var save = el('button', { type: 'button', 'class': 'fu-btn lab-save' }, ['Save as markdown']);
    save.addEventListener('click', function () { flush(); download(ui); });

    return el('div', { 'class': 'lab-talk-in' }, [
      el('a', { 'class': 'fu-btn fu-btn--link lab-back', href: '#lab' }, [el('span', { 'aria-hidden': 'true', text: '← ' }), 'Lab']),
      el('p', { 'class': 'fu-label lab-kicker', text: 'Talk builder' }),
      el('h1', { 'class': 'fu-h1 lab-h1', text: 'Your talk' }),
      ui.talkTitle,
      el('p', { 'class': 'fu-voice lab-lede', text: 'six parts, ' + SPAN_W + ' minutes out loud. a few lines each is plenty; it saves as you type, on this device.' }),
      el('div', { 'class': 'lab-meter' }, [
        el('div', { 'class': 'lab-meter-wrap', 'aria-hidden': 'true' }, [
          el('span', { 'class': 'fu-progress lab-meter-bar' }, [ui.meterFill]),
          band
        ]),
        ticks,
        ui.meterLine
      ]),
      list,
      el('div', { 'class': 'lab-talk-actions' }, [
        save,
        el('p', { 'class': 'fu-small fu-muted lab-fine', text: 'one .md file with all six parts, for your slides or your notes.' })
      ])
    ]);
  }

  function grow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(Math.max(ta.scrollHeight + 4, 88), 520) + 'px';
  }

  var pending = {}, saveT = 0;
  function queueSave(id, value) {
    pending[id] = value;
    clearTimeout(saveT);
    saveT = setTimeout(flush, 350);
  }
  function flush() {
    clearTimeout(saveT);
    var ids = Object.keys(pending);
    if (!ids.length) return;
    var vals = pending;
    pending = {};
    writeCap(function (c) {
      ids.forEach(function (id) {
        if (id === '__pick') c.pick = vals[id];
        else c.talk[id] = vals[id];
      });
    });
  }

  function talkTotals(talk) {
    var w = 0, started = 0;
    PARTS.forEach(function (p) { var n = words(talk[p.id]); w += n; if (n) started++; });
    return { words: w, sec: w / WPM * 60, started: started };
  }

  function paintTalk(ui) {
    var talk = {};
    PARTS.forEach(function (p) { talk[p.id] = ui.parts[p.id].ta.value; });
    PARTS.forEach(function (p) {
      var sec = words(talk[p.id]) / WPM * 60;
      var est = ui.parts[p.id].est;
      est.textContent = fmtTime(sec) + ' of ~' + fmtTime(p.aim);
      est.setAttribute('aria-label', 'about ' + spoken(sec) + ' spoken; aim for about ' + spoken(p.aim));
    });
    var tot = talkTotals(talk);
    var min = tot.sec / 60;
    ui.meterFill.style.width = (Math.min(min, METER_MAX) / METER_MAX * 100) + '%';
    var say;
    if (!tot.words) say = 'nothing written yet. start with the question; the rest leans on it.';
    else if (min < TALK_LO) say = 'about ' + spoken(tot.sec) + ' spoken (' + tot.words + ' words). the talk is ' + SPAN_W + ' minutes.';
    else if (min <= TALK_HI) say = 'about ' + spoken(tot.sec) + ' spoken (' + tot.words + ' words). right in the ' + SPAN_W + '.';
    else say = 'about ' + spoken(tot.sec) + ' spoken (' + tot.words + ' words). a touch long: trim the part furthest past its aim.';
    ui.meterLine.textContent = say;
    var pick = (ui.pick && ui.pick.value || '').trim();
    ui.talkTitle.textContent = pick ? 'Working title: ' + pick : '';
    ui.talkTitle.hidden = !pick;
  }

  function paintTalkCard(ui) {
    var tot = talkTotals(readCap().talk);
    ui.talkCardS.textContent = tot.started
      ? tot.started + ' of 6 parts started · about ' + spoken(tot.sec) + ' spoken · the talk is ' + SPAN_D + ' minutes'
      : 'six short boxes, ' + SPAN_W + ' minutes out loud. saved on this device as you type.';
  }

  function markdown(c) {
    var tot = talkTotals(c.talk);
    var out = ['# ' + (c.pick.trim() || 'My capstone talk'), '',
      'TARA capstone talk, Saturday 12 December 2026. About ' + spoken(tot.sec) + ' spoken (' + tot.words +
      ' words at ' + WPM + ' a minute); the talk is ' + SPAN_W + ' minutes.', ''];
    PARTS.forEach(function (p, i) {
      var txt = String(c.talk[p.id] || '').trim();
      out.push('## ' + (i + 1) + '. ' + p.title, '', txt || '_Not written yet._', '');
    });
    return out.join('\n');
  }

  function download(ui) {
    var c = readCap();
    PARTS.forEach(function (p) { c.talk[p.id] = ui.parts[p.id].ta.value; });   // what is on screen, saved or not
    if (ui.pick) c.pick = ui.pick.value;
    try {
      var blob = new Blob([markdown(c)], { type: 'text/markdown;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = el('a', { href: url, download: 'capstone-talk.md', hidden: true });
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 1500);
      toast('saved capstone-talk.md');
    } catch (e) {
      toast('that fumbled. nothing is lost; try again.');
    }
  }

  /* ================================================================== painting */

  function paintRunway(ui, t) {
    var F = days(t, FREEZE), T = days(t, TALK), S = days(t, START);
    var frozen = isFrozen(t);

    var st;
    if (S > 1) st = 'the project phase starts in ' + S + ' days. one small thing today is plenty.';
    else if (S === 1) st = 'the project phase starts tomorrow. bring the environment that already works.';
    else if (S === 0) st = 'project phase, day one. get a number on the board.';
    else if (t < RUNS) st = 'experiment days. results freeze on saturday at 6pm.';
    else if (t === RUNS) st = 'last day for experiments. results freeze tomorrow at 6pm.';
    else if (!frozen) st = 'results freeze today at 6pm. after that, it is all talk.';
    else if (T > 0) st = 'results are frozen. this week is for rehearsing, out loud.';
    else if (T === 0) st = 'talk day. you know this work better than anyone in the room.';
    else st = 'talk given. that is the capstone done.';
    ui.status.textContent = st;

    var fz = ui.tiles.freeze, tk = ui.tiles.talk;
    if (frozen) { fz.big.textContent = 'Frozen'; fz.k.textContent = 'results, since'; fz.s.textContent = 'Sat 5 Dec, 6pm'; }
    else if (F === 0) { fz.big.textContent = 'Today'; fz.k.textContent = 'the results freeze'; fz.s.textContent = 'at 6pm'; }
    else { fz.big.textContent = String(F); fz.k.textContent = plural(F, 'day', 'days') + ' to the results freeze'; fz.s.textContent = F === 1 ? 'tomorrow, 6pm' : 'Sat 5 Dec, 6pm'; }
    fz.said.textContent = frozen ? 'Results are frozen, since Saturday 5 December at 6pm.'
      : F === 0 ? 'Results freeze today at 6pm.' : F + ' ' + plural(F, 'day', 'days') + ' to the results freeze, Saturday 5 December at 6pm.';
    fz.box.setAttribute('data-state', frozen ? 'done' : F === 0 ? 'today' : 'ahead');

    if (T < 0) { tk.big.textContent = 'Done'; tk.k.textContent = 'talk given'; tk.s.textContent = 'Sat 12 Dec'; }
    else if (T === 0) { tk.big.textContent = 'Today'; tk.k.textContent = 'the talk'; tk.s.textContent = 'Sat 12 Dec'; }
    else { tk.big.textContent = String(T); tk.k.textContent = plural(T, 'day', 'days') + ' to the talk'; tk.s.textContent = T === 1 ? 'tomorrow' : 'Sat 12 Dec'; }
    tk.said.textContent = T < 0 ? 'The talk was given on Saturday 12 December.' : T === 0 ? 'The talk is today.'
      : T + ' ' + plural(T, 'day', 'days') + ' to the talk, Saturday 12 December.';
    tk.box.setAttribute('data-state', T < 0 ? 'done' : T === 0 ? 'today' : 'ahead');

    /* the track: milestones passed go gold, today's one shows the signal, the pin is today */
    var x = pinPos(t);
    ui.fill.style.width = (x * 100) + '%';
    ui.pin.style.left = (x * 100) + '%';
    ui.pin.setAttribute('data-edge', x < 0.12 ? 'start' : x > 0.88 ? 'end' : 'mid');
    ui.pinT.textContent = 'Today · ' + dayMonth(t);
    MS.forEach(function (m, i) {
      var passed = m.id === 'freeze' ? frozen : m.id === 'rehearse' ? t > REHEARSE_END : t > m.date;
      var now = !passed && (m.id === 'rehearse' ? (t >= REHEARSE && t <= REHEARSE_END) : t === m.date);
      var tk2 = ui.ticks[i];
      tk2.tick.classList.toggle('is-on', passed);
      tk2.tick.classList.toggle('is-doing', now);
      tk2.box.setAttribute('data-state', passed ? 'done' : now ? 'now' : 'ahead');
      ui.msList.children[i].textContent = m.long + ', ' + m.day + (m.week ? ' (week ' + m.week + ')' : '') + ': ' +
        (passed ? 'passed' : now ? 'today' : 'ahead') + '.';
    });
    ui.msList.setAttribute('aria-label', 'Milestones. Today is ' + longDate(t) + '.');
  }

  function paintPick(ui) {
    if (document.activeElement === ui.pick || pending.__pick != null) return;
    ui.pick.value = readCap().pick;
  }

  function paintTalkFields(ui) {
    var c = readCap();
    PARTS.forEach(function (p) {
      var ta = ui.parts[p.id].ta;
      if (document.activeElement === ta || pending[p.id] != null) return;
      if (ta.value !== c.talk[p.id]) ta.value = c.talk[p.id];
    });
    paintTalk(ui);
  }

  function paintAll(ui) {
    paintRunway(ui, todayISO());
    paintPick(ui);
    if (ui.boxes) paintTicks(ui);
    paintTalkCard(ui);
    paintMissionsDone(ui);
  }

  /* ============================================================== the section */

  function build(host, data) {
    var t = todayISO();
    var ui = { root: host, n: targetWeek(t) };
    var main = el('div', { 'class': 'lab-v2 lab-main', 'data-view': 'main' }, [
      buildRunway(ui),
      buildWeeks(ui, data.plan, t),
      buildTalkCard(ui),
      buildDoor(),
      buildMissions(ui, ui.n, data.missions),
      buildResults(ui)
    ]);
    var talk = el('div', { 'class': 'lab-v2 lab-talk', 'data-view': 'talk', hidden: true }, [buildTalk(ui)]);
    host.textContent = '';
    host.appendChild(main);
    host.appendChild(talk);
    ui.main = main;
    ui.talk = talk;

    ui.pick.addEventListener('input', function () { queueSave('__pick', ui.pick.value); });
    ui.pick.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); ui.pick.blur(); } });
    ui.pick.addEventListener('blur', flush);

    if (data.pack) { ui.packFilled = true; fillPack(ui, data.pack); }
    if (data.results) ui.resultsFilled = true;
    fillResults(ui, data.results);
    host.__lab = ui;
    return ui;
  }

  var building = null;
  function ensureBuilt(host) {
    if (host.__lab) return Promise.resolve(host.__lab);
    if (building) return building;
    var n = targetWeek(todayISO());
    /* everything arrives before the first paint, so nothing jumps; a slow piece gives up
       and its slot says where to find it instead */
    building = Promise.all([
      withTimeout(loadPlan(), 4000),
      withTimeout(loadPack(), 4000),
      withTimeout(loadMissions(n), 3000),
      withTimeout(loadResults(), 3000)
    ]).then(function (r) {
      building = null;
      if (host.__lab) return host.__lab;
      return build(host, { plan: r[0], pack: r[1], missions: r[2], results: r[3] });
    }, function (e) { building = null; throw e; });
    return building;
  }

  function mount(host, route) {
    var rest = String((route && route.params && route.params.rest) || '').replace(/^\/+|\/+$/g, '');
    return ensureBuilt(host).then(function (ui) {
      var view = /^talk(\/|$)/.test(rest) ? 'talk' : 'main';
      ui.main.hidden = view !== 'main';
      ui.talk.hidden = view !== 'talk';
      host.setAttribute('data-lab-view', view);
      paintAll(ui);
      if (view === 'talk') {
        paintTalkFields(ui);
        PARTS.forEach(function (p) { grow(ui.parts[p.id].ta); });
        return;
      }
      /* results and the pack: fill in later if they were slow the first time */
      if (!ui.resultsFilled) loadResults().then(function (p) { if (p) { ui.resultsFilled = true; fillResults(ui, p); } });
      if (!ui.packFilled) loadPack().then(function (p) { if (p) { ui.packFilled = true; fillPack(ui, p); } });
      var wk = /^week-(1[234])$/.exec(rest);
      if (wk) selectWeek(ui, Number(wk[1]));
      var target = wk ? 'weeks' : (BLOCKS[rest] ? rest : null);
      if (target) {
        var node = document.getElementById('lab-' + target);
        if (node) requestAnimationFrame(function () { try { node.scrollIntoView({ block: 'start' }); } catch (e) { node.scrollIntoView(); } });
      }
    });
  }

  function unmount() { flush(); }

  /* other tabs and frames (the plan, the Lab) write the same keys */
  window.addEventListener('storage', function (e) {
    var host = document.getElementById('app-sec-lab');
    var ui = host && host.__lab;
    if (!ui || !e) return;
    if (e.key === TICKS || e.key === null) { if (ui.boxes) paintTicks(ui); }
    if (e.key === KEY || e.key === null) { paintPick(ui); paintTalkFields(ui); paintTalkCard(ui); }
    if (e.key === LAB_DONE || e.key === null) paintMissionsDone(ui);
  });
  window.addEventListener('tara:path', function () {
    var host = document.getElementById('app-sec-lab');
    if (host && host.__lab && host.__lab.boxes) paintTicks(host.__lab);
  });
  window.addEventListener('pagehide', flush);

  /* a tab left open: the runway catches up when it is looked at again, and at 6pm on
     freeze day (Today repaints on 'tara:capstone', as the summary's next step changes) */
  function repaintIfShown() {
    var host = document.getElementById('app-sec-lab');
    if (host && host.__lab && !host.hidden) paintAll(host.__lab);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush(); else repaintIfShown();
  });
  (function () {
    var wait = FREEZE_AT - Date.now();
    if (overrideISO() || wait <= 0 || wait > 7 * 864e5) return;
    setTimeout(function () {
      repaintIfShown();
      try { window.dispatchEvent(new CustomEvent('tara:capstone', { detail: { frozen: true, source: 'lab' } })); } catch (e) { /* */ }
    }, wait + 1000);
  })();

  /* search: the runway's parts by name */
  var SEARCH = [
    { id: 'capstone', title: 'Capstone runway', sub: 'Lab · days to the freeze and the talk', hash: '#lab/runway', body: 'freeze talk countdown milestones pick' },
    { id: 'talk', title: 'Talk builder', sub: 'Lab · six parts, ' + SPAN_W + ' minutes', hash: '#lab/talk', body: 'capstone talk presentation slides markdown rehearse' },
    { id: 'weeks-12-14', title: 'Weeks 12 to 14', sub: 'Lab · the project checklist and the capstone pack', hash: '#lab/weeks', body: 'capstone project checklist freeze week 12 13 14' },
    { id: 'lab', title: 'The Lab', sub: 'Lab · tools, missions, results', hash: '#lab/door', body: 'gpt-2 qwen 3090 tools interpretability' },
    { id: 'missions', title: "This week's missions", sub: 'Lab', hash: '#lab/missions', body: 'mission lab' },
    { id: 'results', title: 'Latest results', sub: 'Lab · from the 3090 bench', hash: '#lab/results', body: 'bench findings results probe steering' }
  ];
  function search(q) {
    var score = typeof APP.score === 'function' ? APP.score : function (qq, r) {
      qq = String(qq || '').toLowerCase(); return String(r.title).toLowerCase().indexOf(qq) >= 0 ? 40 : 0;
    };
    var rows = [];
    SEARCH.forEach(function (r) { var s = score(q, r); if (s) rows.push({ title: r.title, sub: r.sub, hash: r.hash, score: s }); });
    return rows;
  }

  if (typeof APP.registerSection === 'function') {
    APP.registerSection({ id: 'lab', title: 'Lab', mount: mount, unmount: unmount, search: search });
  }

  /* for checks (tools and tests); not an interface */
  APP.capstone._test = { readLiteral: readLiteral, pinPos: pinPos, nextMilestone: nextMilestone, isFrozen: isFrozen, markdown: markdown };
})();
