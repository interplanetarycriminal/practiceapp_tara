/* src/v2/recall.js — owner: recall.
 *
 * One spaced-repetition queue for the whole app (contract §Shared APIs).
 * It holds three kinds of item:
 *   question  a real drill question, rendered from its bank payload
 *   concept   "say it in one line" for a node of the intuition map
 *   sentence  a line saved from a page (V1's review queue)
 * and fills itself from V1's stores without ever writing them:
 *   tara.review             saved sentences            -> sentence items
 *   tara-quiz-mastery-v1    the drill's per-question record
 *                           (missed questions)          -> question items
 *                           (the drill's "what's shaky") -> concept items
 * plus whatever the week paths send through APP.recall.add().
 *
 * Schedule: rungs 1 -> 3 -> 7 -> 16 -> 35 -> 75 days. "solid" climbs a rung,
 * "shaky" holds the rung (due again after the same interval, at least
 * tomorrow), "blank" drops to the 1-day rung. Store: localStorage
 * "tara.v2.recall". Event: window "tara:recall" after every change.
 */
(function () {
  'use strict';

  var APP = (window.APP = window.APP || {});
  if (APP.recall && APP.recall.__v2) return;

  var KEY = 'tara.v2.recall';
  var K_REVIEW = 'tara.review';
  var K_MASTERY = 'tara-quiz-mastery-v1';
  var RUNGS = [1, 3, 7, 16, 35, 75];
  var SESSION_MAX = 7;
  var WARM_SIZE = 5;
  var IMPORT_PER_DAY = 7;          // a first import never floods one day
  var SHAKY_CONCEPTS = 6;          // the drill's "what's shaky" shows six
  var SECS = { question: 45, concept: 40, sentence: 20 };
  var GRADES = ['solid', 'shaky', 'blank'];
  var GRADE_WORD = { solid: 'Got it', shaky: 'Shaky', blank: 'Blank' };
  var TIER_NAME = { 1: 'Plain', 2: 'Generalist', 3: 'Expert' };

  /* Banks are content ids; the TARA weeks each serves come from the schedule.
     This table is only the fallback for before the schedule payload lands. */
  var BANK_WEEKS = {
    'week-01': [0], 'week-02': [1], 'week-03': [1], 'week-04': [1], 'week-05': [2],
    'week-06': [3], 'week-07': [3, 4], 'week-08': [4], 'week-09': [5], 'week-10': [6],
    'week-11': [7, 8, 9], 'alignment-science': [10, 11], 'capstone-weeks-12-14': [12, 13, 14]
  };
  var BANKS = Object.keys(BANK_WEEKS);
  var BANK_TOPIC = {
    'week-01': 'einops', 'week-02': 'resnets', 'week-03': 'optimisers', 'week-04': 'autograd',
    'week-05': 'transformer', 'week-06': 'hooks', 'week-07': 'circuits', 'week-08': 'saes',
    'week-09': 'dqn', 'week-10': 'ppo & rlhf', 'week-11': 'evals', 'alignment-science': 'alignment',
    'capstone-weeks-12-14': 'capstone'
  };
  /* Question ids carry their bank: w01-q001 ... w11-q078, ch4-q01, cap12-q01. */
  function bankOf(qid) {
    var p = String(qid || '').split('-')[0].toLowerCase(), m;
    if ((m = /^w(\d\d)$/.exec(p)) && BANK_WEEKS['week-' + m[1]]) return 'week-' + m[1];
    if (p === 'ch4') return 'alignment-science';
    if (/^cap\d+$/.test(p)) return 'capstone-weeks-12-14';
    return bankFromHistory(qid);
  }
  /* The engine's own per-bank history (tara.quiz.<slug>) is the second witness. */
  function bankFromHistory(qid) {
    for (var i = 0; i < BANKS.length; i++) {
      var h = readJSON('tara.quiz.' + BANKS[i], null);
      if (h && h.history && Object.prototype.hasOwnProperty.call(h.history, qid)) return BANKS[i];
    }
    return null;
  }
  function weeksOfBank(slug) {
    var ns = [];
    try { if (typeof APP.weeksOfPack === 'function' && APP.schedule && APP.schedule()) ns = APP.weeksOfPack(slug) || []; }
    catch (e) { ns = []; }
    return ns.length ? ns : (BANK_WEEKS[slug] || []);
  }
  function weekOfQuestion(slug, qid) {
    var m = /^cap(\d+)-/.exec(String(qid || ''));
    if (m && Number(m[1]) >= 12) return Number(m[1]);
    var ns = weeksOfBank(slug);
    return ns.length ? ns[ns.length - 1] : null;
  }

  /* ------------------------------------------------------------ storage -- */

  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function readJSON(k, fb) {
    var raw = lsGet(k);
    if (!raw) return fb;
    try { var v = JSON.parse(raw); return v == null ? fb : v; } catch (e) { return fb; }
  }

  /* ---------------------------------------------------------------- dates -- */

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function localISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function isISO(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  /* ?today=YYYY-MM-DD before the hash overrides the date everywhere (contract). */
  function todayISO() {
    try { var m = /[?&]today=(\d{4}-\d{2}-\d{2})(?:&|$)/.exec(location.search); if (m) return m[1]; } catch (e) {}
    try { if (typeof APP.todayISO === 'function') { var t = APP.todayISO(); if (isISO(t)) return t; } } catch (e) {}
    return localISO(new Date());
  }
  function utc(iso) { var p = iso.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function addDays(iso, n) {
    var d = new Date(utc(iso) + n * 864e5);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  function daysBetween(a, b) { return Math.round((utc(b) - utc(a)) / 864e5); }
  function isoOfMs(ms) { return ms ? localISO(new Date(Number(ms))) : null; }
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /* "today", "tomorrow", "Thu", "Thu 26 Nov" */
  function whenWord(iso, from) {
    var d = daysBetween(from || todayISO(), iso);
    if (d <= 0) return 'today';
    if (d === 1) return 'tomorrow';
    var dt = new Date(utc(iso));
    if (d < 7) return 'on ' + DOW[dt.getUTCDay()];
    return 'on ' + DOW[dt.getUTCDay()] + ' ' + dt.getUTCDate() + ' ' + MON[dt.getUTCMonth()];
  }
  function inDays(n) {
    if (n <= 1) return 'tomorrow';
    if (n < 14) return 'in ' + n + ' days';
    if (n < 60) return 'in ' + Math.round(n / 7) + ' weeks';
    return 'in ' + Math.round(n / 30) + ' months';
  }

  /* ---------------------------------------------------------------- store -- */

  var S = null, mem = null;

  function blank() {
    return { v: 1, items: {}, cursor: { review: 0, drill: 0, drillInit: 0, concepts: {} }, log: [] };
  }
  function store() {
    if (S) return S;
    var v = readJSON(KEY, null);
    if (!v || typeof v !== 'object' || !v.items || typeof v.items !== 'object') v = mem || blank();
    if (!v.cursor || typeof v.cursor !== 'object') v.cursor = blank().cursor;
    if (!v.cursor.concepts || typeof v.cursor.concepts !== 'object') v.cursor.concepts = {};
    if (!Array.isArray(v.log)) v.log = [];
    v.v = 1;
    S = v;
    return S;
  }
  function save(quiet) {
    mem = S;
    lsSet(KEY, JSON.stringify(S));
    if (!quiet) emit();
  }

  var emitT = 0;
  function emit() {
    if (emitT) return;
    emitT = setTimeout(function () {
      emitT = 0;
      var detail = { due: 0, total: 0 };
      try { detail.due = dueCount(); detail.total = activeCount(); } catch (e) {}
      try { window.dispatchEvent(new CustomEvent('tara:recall', { detail: detail })); } catch (e) {}
    }, 0);
  }

  function copy(it) {
    if (!it) return null;
    var o = {};
    for (var k in it) if (Object.prototype.hasOwnProperty.call(it, k)) o[k] = it[k];
    return o;
  }
  function active(it) { return !!it && !it.off && !it.gone; }
  function normText(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }

  var PFX = { question: 'q:', concept: 'c:', sentence: 's:' };
  function normKind(k) {
    k = String(k || '').toLowerCase();
    if (k === 'question' || k === 'check' || k === 'miss' || k === 'q') return 'question';
    if (k === 'concept' || k === 'idea' || k === 'card' || k === 'c') return 'concept';
    if (k === 'sentence' || k === 'line' || k === 'review' || k === 's') return 'sentence';
    return null;
  }
  function keyOf(kind, id) {
    id = String(id == null ? '' : id).trim();
    if (!id) return null;
    var p = PFX[kind];
    return id.indexOf(p) === 0 ? id : p + id;
  }
  function find(id) {
    var s = store();
    id = String(id == null ? '' : id);
    if (!id) return null;
    if (s.items[id]) return s.items[id];
    for (var k in PFX) if (s.items[PFX[k] + id]) return s.items[PFX[k] + id];
    return null;
  }
  function normGrade(g) {
    g = String(g || '').toLowerCase();
    if (g === 'solid' || g === 'got it' || g === 'got' || g === 'good') return 'solid';
    if (g === 'shaky' || g === 'hard') return 'shaky';
    if (g === 'blank' || g === 'again') return 'blank';
    return null;
  }
  function normWeek(w) {
    if (w == null || w === '') return null;
    var m = /(\d{1,2})/.exec(String(w));
    return m ? Number(m[1]) : null;
  }

  /* ------------------------------------------------------------- schedule -- */

  /* Days until the item is due again after grade g, from today. */
  function intervalFor(it, g) {
    var r = (it && it.rung) || 0;
    if (g === 'solid') return RUNGS[Math.min(r + 1, RUNGS.length - 1)];
    if (g === 'shaky') return Math.max(1, RUNGS[Math.min(r, RUNGS.length - 1)]);
    return RUNGS[0];
  }

  function gradeItem(id, g) {
    g = normGrade(g);
    var it = find(id);
    if (!g || !it) return null;
    var t = todayISO(), r = it.rung || 0;
    var days = intervalFor(it, g);
    if (g === 'solid') r = Math.min(r + 1, RUNGS.length - 1);
    else if (g === 'blank') { r = 0; it.lapses = (it.lapses || 0) + 1; }
    it.rung = r;
    it.due = addDays(t, days);
    it.last = t;
    it.grade = g;
    it.reps = (it.reps || 0) + 1;
    var s = store();
    s.log.push([t, it.id, g]);
    if (s.log.length > 400) s.log = s.log.slice(s.log.length - 400);
    save();
    return copy(it);
  }

  /* add(): new items start on the 1-day rung. Adding one that is already there
     means "this came up shaky again": back to the first rung, due no later
     than tomorrow. */
  function addItem(spec, opts) {
    if (!spec || typeof spec !== 'object') return null;
    opts = opts || {};
    var kind = normKind(spec.kind);
    if (!kind) return null;
    var ref = spec.id != null && spec.id !== '' ? String(spec.id) : '';
    if (!ref && kind === 'concept' && spec.concept) ref = String(spec.concept);
    if (!ref && kind === 'sentence' && spec.text) ref = 'h' + hashStr(normText(spec.text));
    var id = keyOf(kind, ref);
    if (!id) return null;
    var s = store(), t = todayISO();
    var due = opts.due || addDays(t, RUNGS[0]);
    var it = s.items[id];
    if (!it) {
      it = { id: id, ref: id.slice(2), kind: kind, src: spec.src || opts.src || 'app', added: t, due: due, rung: 0, reps: 0, lapses: 0 };
      s.items[id] = it;
    } else if (!opts.keep) {
      it.rung = 0;
      if (!it.due || it.due > due) it.due = due;
      if (!opts.import) it.off = false;
    }
    ['title', 'text', 'hash', 'concept', 'bank', 'url', 'ts', 'label'].forEach(function (f) {
      if (spec[f] != null && spec[f] !== '') it[f] = spec[f];
    });
    var wk = normWeek(spec.week);
    if (wk != null) it.week = wk;
    if (kind === 'question') {
      if (!it.bank) it.bank = bankOf(it.ref);
      if (it.week == null && it.bank) it.week = weekOfQuestion(it.bank, it.ref);
    }
    if (kind === 'concept' && !it.concept) it.concept = it.ref;
    if (!opts.batch) save(opts.quiet);
    return it;
  }

  /* --------------------------------------------------------------- import -- */

  /* Spread a batch over days: nothing before its natural day, at most
     IMPORT_PER_DAY on any day (counting what is already due there). */
  function placeBatch(batch) {
    if (!batch.length) return;
    var s = store(), t = todayISO(), load = {};
    for (var id in s.items) {
      var it = s.items[id];
      if (active(it) && it.due) { var d = it.due < t ? t : it.due; load[d] = (load[d] || 0) + 1; }
    }
    batch.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });   // freshest first
    batch.forEach(function (b) {
      var d = b.natural && b.natural > t ? b.natural : t;
      var guard = 0;
      while ((load[d] || 0) >= IMPORT_PER_DAY && guard++ < 400) d = addDays(d, 1);
      load[d] = (load[d] || 0) + 1;
      addItem(b.spec, { due: d, batch: true, import: true, src: b.spec.src });
    });
  }
  function naturalDay(ms) {
    var d = isoOfMs(ms);
    return d ? addDays(d, RUNGS[0]) : null;
  }

  /* V1's saved sentences. Cursor = the newest ts imported, so a re-import
     takes only what was saved since. Removing a line in V1 hides it here too
     (unless V1's 300-line cap could have trimmed it). */
  var PAGE_TITLES = [
    ['Einops and Ray Tracing', '#week-01'], ['Modules and ResNets', '#week-02'],
    ['Optimizers and Sweeps', '#week-03'], ['Your Own Autograd', '#week-04'],
    ['Transformer From Scratch', '#week-05'], ['Hooks and the Cache', '#week-06'],
    ['Induction Circuits and Patching', '#week-07'], ['Superposition and Sparse Autoencoders', '#week-08'],
    ['Value Functions and DQN', '#week-09'], ['Policy Gradients, PPO and RLHF', '#week-10'],
    ['Eval Design and Inspect', '#week-11'], ['Model Organisms and Open Problems', '#alignment-science'],
    ['Three Saturdays and a Talk', '#capstone-weeks-12-14'],
    ['Backprop Bench', '#demo/backprop-training'], ['Sliding Window Lab', '#demo/convolutions-cnn'],
    ['The Measurement Is Not the Property', '#demo/evals-pipeline'],
    ['Induction Circuit Workbench', '#demo/induction-heads-patching'],
    ['Reading the PPO Objective', '#demo/policy-gradients-ppo'], ['Residual Stream Bus', '#demo/residual-stream-bus'],
    ['Bellman to DQN', '#demo/rl-foundations-dqn'], ['The Overoptimisation Curve', '#demo/rlhf-overoptimisation'],
    ["Decoder's Bench", '#demo/sampling-decoding'], ['Persona Vector Bench', '#demo/steering-persona-vectors'],
    ['Superposition Bench', '#demo/superposition-sae'], ['Einops Bench', '#demo/tensors-einops'],
    ['Residual Stream Anatomy', '#demo/transformer-block']
  ];
  function viewHref(path) {
    try { if (typeof APP.viewHref === 'function') return APP.viewHref(path); } catch (e) {}
    return '#view/' + path;
  }
  /* Where a saved line came from, as something the shell can open. */
  function sourceOf(r) {
    var title = String((r && r.title) || '').trim();
    var url = String((r && r.url) || '');
    var out = { hash: null, href: null, label: title };
    try {
      if (url && !/^about:/i.test(url)) {
        var u = new URL(url, location.href);
        if (u.origin === location.origin) {
          var base = new URL('.', location.href).pathname;
          var p = u.pathname;
          var rel = p.indexOf(base) === 0 ? p.slice(base.length) : p.replace(/^\/+/, '');
          if (!rel || /^(index|next|classic)\.html$/.test(rel)) {
            if (u.hash && u.hash.length > 1) out.hash = u.hash;
          } else if (/^lab\//.test(rel)) {
            out.href = rel + u.search + u.hash;           // the Lab is never in the viewer
          } else if (/\.html$/.test(rel)) {
            out.hash = viewHref(rel + u.search + u.hash);
          }
        }
      }
    } catch (e) {}
    if (!out.hash && !out.href && title) {
      for (var i = 0; i < PAGE_TITLES.length; i++) {
        if (title.indexOf(PAGE_TITLES[i][0]) >= 0) { out.hash = PAGE_TITLES[i][1]; out.label = PAGE_TITLES[i][0]; break; }
      }
    }
    if (/^TARA\b/.test(out.label || '')) out.label = '';
    return out;
  }

  /* A saved line's week, read off its source: a pack or a demo hash. */
  function weekOfHash(hash) {
    var m = /^#([a-z0-9-]+)/.exec(String(hash || '')), slug = m && m[1];
    if (!slug) return null;
    if (BANK_WEEKS[slug]) { var ns = weeksOfBank(slug); return ns.length ? ns[ns.length - 1] : null; }
    var d = /^#demo\/([a-z0-9-]+)/.exec(hash);
    if (d) {
      try { if (typeof APP.weeksOfDemo === 'function') { var ws = APP.weeksOfDemo(d[1]) || []; if (ws.length) return ws[ws.length - 1]; } } catch (e) {}
    }
    return null;
  }

  function importReview() {
    var list = readJSON(K_REVIEW, []);
    if (!Array.isArray(list)) return [];
    var s = store(), c = s.cursor, cur = Number(c.review) || 0, max = cur, batch = [], live = {};
    var byText = {}, changed = false;
    for (var id in s.items) if (s.items[id].kind === 'sentence') byText[normText(s.items[id].text)] = true;
    list.forEach(function (r) {
      if (!r || typeof r.text !== 'string' || !r.text.trim()) return;
      var ts = Number(r.ts) || 0;
      if (ts) { live[ts] = true; if (ts > max) max = ts; }
      if (ts && ts <= cur) return;
      var nt = normText(r.text);
      var key = 's:' + (ts || 'h' + hashStr(nt));
      if (s.items[key] || byText[nt]) return;
      byText[nt] = true;
      var src = sourceOf(r);
      batch.push({
        at: ts, natural: naturalDay(ts),
        spec: { kind: 'sentence', id: key, text: r.text.replace(/\s+/g, ' ').trim(), title: src.label || '',
                hash: src.hash || src.href || '', url: r.url || '', ts: ts || undefined, src: 'review',
                week: weekOfHash(src.hash) }
      });
    });
    if (list.length < 300) {
      for (var k in s.items) {
        var it = s.items[k];
        if (it.kind !== 'sentence' || it.src !== 'review' || !it.ts) continue;
        var gone = !live[it.ts];
        if (!!it.gone !== gone) { it.gone = gone; changed = true; }
      }
    }
    if (max !== cur) { c.review = max; changed = true; }
    if (changed && !batch.length) save(true);
    return batch;
  }

  /* The drill's per-question record (quiz engine, tara-quiz-mastery-v1):
     { [qid]: { seen, correct, wrong, lastSeen, lastWrong, streak, ease } }.
     First import: every question whose latest answer was a miss (streak 0).
     After that: every question missed since the cursor (newest lastWrong). */
  function importDrill() {
    var m = readJSON(K_MASTERY, {});
    if (!m || typeof m !== 'object') return [];
    var s = store(), c = s.cursor, cur = Number(c.drill) || 0, first = !c.drillInit, max = cur, batch = [];
    Object.keys(m).forEach(function (qid) {
      var r = m[qid];
      if (!r || !(Number(r.wrong) > 0)) return;
      var lw = Number(r.lastWrong) || 0;
      if (lw > max) max = lw;
      var take = first ? (Number(r.streak) || 0) === 0 : lw > cur;
      if (!take) return;
      var bank = bankOf(qid);
      if (!bank) return;
      var key = 'q:' + qid;
      if (!first && s.items[key]) {
        /* missed again since we last looked: back to the first rung */
        addItem({ kind: 'question', id: key }, { due: maxISO(naturalDay(lw), todayISO()), batch: true, import: true });
        return;
      }
      if (s.items[key]) return;
      batch.push({ at: lw, natural: naturalDay(lw),
                   spec: { kind: 'question', id: key, bank: bank, week: weekOfQuestion(bank, qid), src: 'drill' } });
    });
    var changed = max !== cur || first;
    c.drill = max; c.drillInit = 1;
    if (changed && !batch.length) save(true);
    return batch;
  }
  function maxISO(a, b) { return !a ? b : !b ? a : (a > b ? a : b); }

  var synced = false;
  function syncNow() {
    var batch = importReview().concat(importDrill());
    if (batch.length) { placeBatch(batch); save(); }
    return batch.length;
  }
  function ensure() {
    if (synced) return;
    synced = true;
    try { syncNow(); } catch (e) { if (window.console) console.warn('recall import failed', e); }
  }

  /* ----------------------------------------------- payloads (banks, nodes) -- */

  var bankCache = {}, bankP = {}, QIDX = {}, CLABEL = {};
  function loadBank(slug) {
    if (bankCache[slug]) return Promise.resolve(bankCache[slug]);
    if (bankP[slug]) return bankP[slug];
    if (typeof APP.payloadJSON !== 'function') return Promise.resolve(null);
    bankP[slug] = Promise.resolve().then(function () { return APP.payloadJSON('bank:' + slug); }).then(function (b) {
      if (!b || !Array.isArray(b.questions)) return null;
      b.__byId = {};
      (b.concepts || []).forEach(function (c) { if (c && c.id && !CLABEL[c.id]) CLABEL[c.id] = c.label || c.id; });
      b.questions.forEach(function (q) { if (q && q.id) { b.__byId[q.id] = q; QIDX[q.id] = { c: q.concept, w: slug }; } });
      bankCache[slug] = b;
      return b;
    }).catch(function () { delete bankP[slug]; return null; });
    return bankP[slug];
  }
  function questionOf(it) {
    var slug = it.bank || bankOf(it.ref);
    if (!slug) return Promise.resolve(null);
    return loadBank(slug).then(function (b) { return b && b.__byId[it.ref] ? { q: b.__byId[it.ref], bank: b, slug: slug } : null; });
  }

  var nodesP = null, NODES = null;
  function siteURL(path) { try { return new URL(path, document.baseURI).href; } catch (e) { return path; } }
  function nodesIndex() {
    if (nodesP) return nodesP;
    nodesP = fetch(siteURL('intuition/nodes/index.json'), { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (ix) {
        NODES = {};
        ((ix && ix.nodes) || []).forEach(function (n) { if (n && n.id) NODES[n.id] = n; });
        return NODES;
      }).catch(function () { nodesP = null; return {}; });
    return nodesP;
  }
  var nodeP = {};
  function nodeFull(id) {
    if (!id) return Promise.resolve(null);
    if (nodeP[id]) return nodeP[id];
    nodeP[id] = fetch(siteURL('intuition/nodes/' + encodeURIComponent(id) + '.json'), { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(function () { delete nodeP[id]; return null; });
    return nodeP[id];
  }

  /* The drill's "what's shaky": concepts ranked by misses over answers across
     every bank touched, top six. Those that are nodes of the intuition map
     become concept items (a concept that is not a node has nothing to show
     but its questions, and those are already in as question items). */
  var conceptsP = null;
  function importConcepts() {
    if (conceptsP) return conceptsP;
    var m = readJSON(K_MASTERY, {});
    var slugs = {};
    Object.keys(m || {}).forEach(function (qid) {
      if (m[qid] && Number(m[qid].wrong) > 0) { var b = bankOf(qid); if (b) slugs[b] = true; }
    });
    var s = store();
    for (var id in s.items) { var it = s.items[id]; if (it.kind === 'question' && it.bank && !it.concept) slugs[it.bank] = true; }
    var list = Object.keys(slugs);
    conceptsP = Promise.all([nodesIndex(), Promise.all(list.map(loadBank))]).then(function (r) {
      var nodes = r[0] || {}, s2 = store(), changed = false, t = todayISO();
      for (var k in s2.items) {
        var q = s2.items[k];
        if (q.kind !== 'question' || q.concept) continue;
        var ix = QIDX[q.ref];
        if (ix && ix.c) { q.concept = ix.c; q.label = CLABEL[ix.c] || ix.c; changed = true; }
      }
      var agg = {};
      Object.keys(m || {}).forEach(function (qid) {
        var rec = m[qid], ix = QIDX[qid];
        if (!rec || !rec.seen || !ix || !ix.c) return;
        var a = agg[ix.c] || (agg[ix.c] = { id: ix.c, seen: 0, wrong: 0, bank: ix.w, at: 0 });
        a.seen += Number(rec.seen) || 0; a.wrong += Number(rec.wrong) || 0;
        a.at = Math.max(a.at, Number(rec.lastWrong) || 0);
      });
      var rows = Object.keys(agg).map(function (k2) { return agg[k2]; })
        .filter(function (a) { return a.wrong > 0; })
        .sort(function (a, b) { return (b.wrong / b.seen) - (a.wrong / a.seen) || b.wrong - a.wrong; })
        .slice(0, SHAKY_CONCEPTS);
      var batch = [];
      rows.forEach(function (a) {
        if (!nodes[a.id] || s2.cursor.concepts[a.id]) return;
        s2.cursor.concepts[a.id] = t;
        changed = true;
        if (s2.items['c:' + a.id]) return;
        var n = nodes[a.id];
        batch.push({ at: a.at, natural: naturalDay(a.at),
                     spec: { kind: 'concept', id: 'c:' + a.id, concept: a.id, label: n.label || CLABEL[a.id] || a.id,
                             title: n.label || CLABEL[a.id] || a.id, week: weekOfQuestion(a.bank, ''), bank: a.bank, src: 'drill' } });
      });
      if (batch.length) placeBatch(batch);
      if (changed || batch.length) save();
      return batch.length;
    }).catch(function (e) { if (window.console) console.warn('recall concept import failed', e); return 0; })
      .then(function (n) { conceptsP = null; return n; });
    return conceptsP;
  }

  /* -------------------------------------------------------------- queries -- */

  function sortDue(a, b) {
    if (a.due !== b.due) return a.due < b.due ? -1 : 1;
    if ((a.rung || 0) !== (b.rung || 0)) return (a.rung || 0) - (b.rung || 0);
    if (a.added !== b.added) return a.added < b.added ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  }
  function dueRaw(iso) {
    var t = isISO(iso) ? iso : todayISO(), s = store(), out = [];
    for (var id in s.items) { var it = s.items[id]; if (active(it) && it.due && it.due <= t) out.push(it); }
    return out.sort(sortDue);
  }
  function dueCount(iso) { ensure(); return dueRaw(iso).length; }
  function activeCount() { var s = store(), n = 0; for (var id in s.items) if (active(s.items[id])) n++; return n; }
  function nextAfter(iso) {
    ensure();
    var t = isISO(iso) ? iso : todayISO(), s = store(), best = null, n = 0;
    for (var id in s.items) {
      var it = s.items[id];
      if (!active(it) || !it.due || it.due <= t) continue;
      if (!best || it.due < best) { best = it.due; n = 1; } else if (it.due === best) n++;
    }
    return best ? { date: best, count: n, when: whenWord(best, t) } : null;
  }
  function minutesFor(items) {
    var secs = 0;
    (items || []).forEach(function (it) { secs += SECS[it.kind] || 40; });
    return Math.max(1, Math.round(secs / 60));
  }
  function shuffle(a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  /* Recent TARA weeks: up to five whose Saturday has come (the warm-up and the
     mixed drill draw from them). Before the course: the first week. */
  function recentWeeks(n) {
    n = n || 5;
    var t = todayISO(), weeks = [];
    try { weeks = (APP.schedule && APP.schedule() && APP.schedule().weeks) || []; } catch (e) { weeks = []; }
    var past = weeks.filter(function (w) { return w && w.saturday && w.saturday <= t; }).map(function (w) { return w.n; });
    if (!past.length) {
      var nxt = weeks.filter(function (w) { return w && w.saturday > t; })[0];
      return nxt ? [nxt.n] : [0];
    }
    return past.slice(-n);
  }
  function banksOfWeeks(ns) {
    var out = [];
    var weeks = [];
    try { weeks = (APP.schedule && APP.schedule() && APP.schedule().weeks) || []; } catch (e) { weeks = []; }
    ns.forEach(function (n) {
      var w = null;
      for (var i = 0; i < weeks.length; i++) if (weeks[i].n === n) w = weeks[i];
      var slugs = w ? (w.packSlugs || [w.packSlug]) : BANKS.filter(function (b) { return BANK_WEEKS[b].indexOf(n) >= 0; });
      slugs.forEach(function (sl) { if (sl && BANK_WEEKS[sl] && out.indexOf(sl) < 0) out.push(sl); });
    });
    return out;
  }

  /* A warm-up: items from recent weeks that are not due yet (soonest first),
     then fresh questions from those weeks' banks. A fresh question joins the
     queue only if it comes back shaky or blank. */
  function warmList(size) {
    size = size || WARM_SIZE;
    ensure();
    var t = todayISO(), recent = recentWeeks(5), lo = Math.min.apply(null, recent), s = store();
    var mine = [];
    for (var id in s.items) {
      var it = s.items[id];
      if (!active(it)) continue;
      if (it.week != null && it.week >= lo) mine.push(it);
    }
    mine.sort(sortDue);
    var out = mine.slice(0, Math.min(3, size)).map(copy);
    var have = {};
    out.forEach(function (x) { have[x.id] = true; });
    out.forEach(function (x) { if (x.kind === 'question') have['q:' + x.ref] = true; });
    var slugs = banksOfWeeks(recent);
    return Promise.all(slugs.map(loadBank)).then(function (banks) {
      var mastery = readJSON(K_MASTERY, {}) || {};
      var pool = [];
      banks.forEach(function (b, i) {
        if (!b) return;
        b.questions.forEach(function (q) {
          if (!q || !q.id || s.items['q:' + q.id] || have['q:' + q.id]) return;
          var rec = mastery[q.id];
          var w = !rec || !rec.seen ? 3 : (rec.streak || 0) >= 3 ? 0.5 : 1 + (rec.wrong || 0);
          pool.push({ q: q, slug: slugs[i], k: Math.random() * w });
        });
      });
      pool.sort(function (a, b) { return b.k - a.k; });
      for (var j = 0; j < pool.length && out.length < size; j++) {
        var p = pool[j];
        out.push({ id: 'q:' + p.q.id, ref: p.q.id, kind: 'question', bank: p.slug, week: weekOfQuestion(p.slug, p.q.id),
                   concept: p.q.concept, transient: true, rung: 0 });
      }
      /* not enough fresh questions (offline, or every one is queued): any
         queued item, soonest first */
      if (out.length < size) {
        var any = [];
        for (var k in s.items) if (active(s.items[k])) any.push(s.items[k]);
        mine.concat(any.sort(sortDue)).forEach(function (x) {
          if (out.length < size && !have[x.id]) { have[x.id] = true; out.push(copy(x)); }
        });
      }
      return shuffle(out);
    });
  }

  function sessionList(opts) {
    opts = opts || {};
    ensure();
    var size = opts.size || SESSION_MAX;
    if (opts.warm) return warmList(opts.size || WARM_SIZE);
    return Promise.resolve(shuffle(dueRaw(todayISO()).slice(0, size)).map(copy));
  }

  /* ================================================================== UI === */

  function h(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'class') n.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    (kids || []).forEach(function (c) {
      if (c == null || c === false) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }
  function tierNow() {
    try { if (typeof APP.tier === 'function') { var n = Number(APP.tier()); if (n >= 1 && n <= 3) return n; } } catch (e) {}
    return 2;
  }
  function reduced() {
    try { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  function go(hash) {
    if (!hash) return;
    if (typeof APP.navigate === 'function') APP.navigate(hash); else location.hash = hash;
  }
  function weekLabel(it) { return it.week != null ? 'W' + it.week : ''; }
  var LETTERS = 'ABCDEFGH';   // shown A-H like the week check; keys a-h and A-H both work
  function letterIndex(k) { return typeof k === 'string' && k.length === 1 ? LETTERS.indexOf(k.toUpperCase()) : -1; }
  function pickKeys(n) { return n <= 4 ? LETTERS.slice(0, n).split('').join(' ') : 'A–' + LETTERS.charAt(n - 1); }

  /* bank explanations name options by their bank letter ("Option (c) is tempting"); options are
     shown shuffled, so point those references at the letters on screen (same rule as weeks.js:
     only "Option(s) x" and a free-standing "(x)", never f(a) or T(s,a)). */
  function relabel(html, map) {
    if (!html || !map) return html;
    return String(html)
      .replace(/\b(Options?|options?)(\s+)([a-h])\b/g, function (m, w, sp, x) { return map[x] ? w + sp + map[x] : m; })
      .replace(/(^|[^\w)\]`'’])\(([a-h])\)/g, function (m, pre, x) { return map[x] ? pre + '(' + map[x] + ')' : m; });
  }

  /* A link that stays in the shell: #hash goes through APP.navigate. A Lab
     path is linked directly (this window, never the viewer), as lab.js does. */
  function doorLink(text, target, cls) {
    if (!target) return null;
    var isHash = target.charAt(0) === '#';
    var a = h('a', { class: cls || 'rc-link', href: isHash ? target : siteURL(target), text: text });
    if (isHash) a.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault(); go(target);
    });
    return a;
  }

  /* --------------------------------------------------------- the player -- */

  var players = [];

  function mountSession(host, opts) {
    opts = opts || {};
    var P = {
      host: host, opts: opts, items: [], i: 0, done: 0, results: [], card: null, phase: 'load',
      suggest: null, keyOff: null, destroyed: false, onTierCard: null
    };
    host.textContent = '';
    var root = h('div', { class: 'rc-player', 'data-phase': 'load' });
    var top = h('div', { class: 'rc-top' });
    var fill = h('span', { class: 'fu-progress__fill' });
    var track = h('div', { class: 'rc-track fu-progress fu-progress--thin', role: 'progressbar', 'aria-label': 'Recall session', 'aria-valuemin': '0' }, [fill]);
    var stop = h('button', { type: 'button', class: 'rc-stop fu-btn fu-btn--link', text: 'Stop here' });
    top.appendChild(track);
    top.appendChild(stop);
    var stage = h('div', { class: 'rc-stage', 'aria-live': 'polite' });
    root.appendChild(top);
    root.appendChild(stage);
    host.appendChild(root);
    P.root = root; P.track = track; P.fill = fill; P.stage = stage; P.stopBtn = stop;
    stop.addEventListener('click', function () { finish(P, true); });

    stage.appendChild(loadingEl());
    sessionList({ warm: !!opts.warm, size: opts.size }).then(function (items) {
      if (P.destroyed) return;
      P.items = items || [];
      paintTrack(P);
      if (!P.items.length) { finish(P, false); return; }
      showCard(P);
    }, function () { if (!P.destroyed) { P.items = []; finish(P, false); } });

    P.keyOff = bindKeys(P);
    players.push(P);
    return {
      destroy: function () { destroyPlayer(P); },
      state: function () { return { total: P.items.length, done: P.done, phase: P.phase, finished: P.phase === 'end' }; },
      el: root
    };
  }

  function destroyPlayer(P) {
    P.destroyed = true;
    if (P.keyOff) P.keyOff();
    var i = players.indexOf(P);
    if (i >= 0) players.splice(i, 1);
  }

  function loadingEl() {
    return h('div', { class: 'rc-loading fu-loading', role: 'status' }, [
      h('span', { class: 'fu-loading__lamp', 'aria-hidden': 'true' }),
      h('p', { class: 'fu-loading__line', text: 'setting out the cards…' })
    ]);
  }

  /* The slim line: how far through this round, never a score. */
  function paintTrack(P) {
    var n = P.items.length, d = Math.min(P.done, n);
    P.track.setAttribute('aria-valuemax', String(n));
    P.track.setAttribute('aria-valuenow', String(d));
    P.track.setAttribute('aria-valuetext', n ? (d + ' of ' + n) : 'nothing to do');
    P.fill.style.width = n ? (100 * d / n).toFixed(1) + '%' : '0%';
    P.track.hidden = !n;
  }

  function setPhase(P, ph) {
    P.phase = ph;
    P.root.setAttribute('data-phase', ph);
  }

  function showCard(P) {
    var it = P.items[P.i];
    if (!it) { finish(P, false); return; }
    P.suggest = null;
    P.stage.textContent = '';
    paintTrack(P);
    setPhase(P, 'ask');
    var card = h('article', { class: 'rc-card fu-card', 'data-kind': it.kind, 'aria-label': KIND_LABEL[it.kind] || 'Card' });
    P.card = card;
    P.stage.appendChild(card);
    var C = { it: it, card: card };
    P.cur = C;
    if (it.kind === 'question') renderQuestion(P, C);
    else if (it.kind === 'concept') renderConcept(P, C);
    else renderSentence(P, C);
  }

  /* The bottom slot: before the reveal it holds the one action ("show me",
     "check"); after, the three grades, in the same place. */
  function actionSlot(C) {
    var slot = h('div', { class: 'rc-actions' });
    C.card.appendChild(slot);
    C.slot = slot;
    return slot;
  }
  var KIND_LABEL = { question: 'Question', concept: 'Idea', sentence: 'Saved line' };
  function kicker(C, bits) {
    C.card.appendChild(h('p', { class: 'rc-kicker fu-label', text: bits.filter(Boolean).join(' · ') }));
  }
  /* Desktop key hints: [['space', 'shows'], ['G S B', 'grade']]. Letters show as
     capitals (keycaps, and the week check's A-D); either case works. */
  function keysHint(C, pairs) {
    var p = h('p', { class: 'rc-keys', 'aria-hidden': 'true' });
    pairs.forEach(function (pr, i) {
      if (i) p.appendChild(document.createTextNode(' · '));
      pr[0].split(' ').forEach(function (k) { p.appendChild(h('kbd', { class: 'fu-kbd', text: k })); p.appendChild(document.createTextNode(' ')); });
      p.appendChild(document.createTextNode(pr[1]));
    });
    C.card.appendChild(p);
  }

  function showGrades(P, C, suggest) {
    P.suggest = suggest || null;
    setPhase(P, 'grade');
    var it = C.it;
    var slot = C.slot;
    slot.textContent = '';
    slot.className = 'rc-actions rc-grades';
    slot.setAttribute('role', 'group');
    slot.setAttribute('aria-label', 'How did that feel?');
    GRADES.forEach(function (g) {
      var days = intervalFor(it.transient ? { rung: 0 } : it, g);
      var b = h('button', { type: 'button', class: 'rc-grade fu-btn fu-btn--ghost', 'data-g': g,
                            'aria-label': GRADE_WORD[g] + ', back ' + inDays(days) + (g === suggest ? ' (suggested)' : '') },
                [h('span', { class: 'rc-grade-w', text: GRADE_WORD[g] }), h('span', { class: 'rc-grade-d', text: inDays(days) })]);
      if (g === suggest) b.setAttribute('data-suggest', '1');
      b.addEventListener('click', function () { commit(P, C, g); });
      slot.appendChild(b);
    });
    /* Focus goes to what was revealed, never to a grade: a second press of
       space must not grade by accident. g / s / b or a tap does that. */
    focusSoft(C.after && !C.after.hidden ? C.after : C.card.querySelector('.rc-prompt'));
    bringIntoView(slot);
  }

  function focusSoft(el) {
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
  }
  function scrollBox(el) {
    for (var p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      var oy = '';
      try { oy = getComputedStyle(p).overflowY; } catch (e) {}
      if (oy === 'auto' || oy === 'scroll') return p;
    }
    return null;
  }
  function bringIntoView(el) {
    if (!el || !el.getBoundingClientRect) return;
    requestAnimationFrame(function () {
      if (!el.isConnected) return;
      var r = el.getBoundingClientRect();
      var top = 0, bottom = window.innerHeight || document.documentElement.clientHeight;
      var box = scrollBox(el);
      if (box) { var b = box.getBoundingClientRect(); top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom); }
      if (r.bottom > bottom - 8 || r.top < top) {
        try { el.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' }); } catch (e) { el.scrollIntoView(false); }
      }
    });
  }

  function commit(P, C, g) {
    if (P.phase !== 'grade') return;
    setPhase(P, 'commit');
    var it = C.it;
    if (it.transient) {
      if (g !== 'solid') {
        addItem({ kind: 'question', id: it.id, bank: it.bank, week: it.week, concept: it.concept, src: 'warm' });
        gradeItem(it.id, g);
      }
    } else {
      gradeItem(it.id, g);
    }
    P.results.push({ id: it.id, kind: it.kind, g: g });
    P.done++;
    P.i++;
    if (P.i >= P.items.length) finish(P, false);
    else showCard(P);
  }

  function skip(P, why) {
    var it = P.items[P.i];
    if (it && why === 'missing' && !it.transient) {
      var x = find(it.id);
      if (x) { x.off = true; x.offWhy = 'missing'; save(); }
    }
    P.items.splice(P.i, 1);
    if (P.i >= P.items.length) finish(P, false); else showCard(P);
  }

  function finish(P, early) {
    setPhase(P, 'end');
    P.stage.textContent = '';
    paintTrack(P);
    P.stopBtn.hidden = true;
    var t = todayISO();
    var left = dueRaw(t).length;
    var nx = nextAfter(t);
    var box = h('div', { class: 'rc-end fu-card' + (!P.items.length && !P.done ? ' rc-end--empty' : '') });
    var big, sub = [];
    if (!P.items.length && !P.done) {
      big = activeCount() || P.opts.warm ? 'nothing due. every bench starts like this.' : 'nothing to recall yet. misses and shaky cards land here.';
    } else if (early) {
      big = 'stopped. the rest keep.';
    } else {
      big = left ? 'that’s this round.' : 'that’s the lot.';
    }
    if (P.done) sub.push(P.done + (P.done === 1 ? ' card' : ' cards') + ' looked at');
    if (left) sub.push(left + ' still due, whenever you like');
    else if (nx) sub.push('next: ' + nx.count + ' ' + nx.when);
    box.appendChild(h('p', { class: 'rc-end-big fu-voice', tabindex: '-1', text: big }));
    if (sub.length) box.appendChild(h('p', { class: 'rc-end-sub fu-small', text: sub.join('. ') + '.' }));
    var acts = h('div', { class: 'rc-end-actions' });
    var back = h('button', { type: 'button', class: 'rc-btn fu-btn fu-btn--ghost', 'data-act': 'back', text: 'Back to practice' });
    back.addEventListener('click', function () {
      if (typeof P.opts.onExit === 'function') P.opts.onExit(); else go('#practice');
    });
    acts.appendChild(back);
    if (left) {
      var more = h('button', { type: 'button', class: 'rc-btn fu-btn fu-btn--big', 'data-act': 'more', text: 'Five more minutes' });
      more.addEventListener('click', function () { restart(P, false); });
      acts.appendChild(more);
    } else if (!P.opts.warm) {
      var warm = h('button', { type: 'button', class: 'rc-btn fu-btn', 'data-act': 'warm', text: 'Warm up anyway' });
      warm.addEventListener('click', function () { restart(P, true); });
      acts.appendChild(warm);
    }
    box.appendChild(acts);
    P.stage.appendChild(box);
    focusSoft(box.querySelector('.rc-end-big'));
    if (typeof P.opts.onDone === 'function') { try { P.opts.onDone({ done: P.done, results: P.results.slice() }); } catch (e) {} }
  }

  function restart(P, warm) {
    P.opts.warm = !!warm;
    P.items = []; P.i = 0; P.done = 0; P.results = [];
    P.stopBtn.hidden = false;
    setPhase(P, 'load');
    P.stage.textContent = '';
    P.stage.appendChild(loadingEl());
    if (typeof P.opts.onRestart === 'function') { try { P.opts.onRestart(!!warm); } catch (e) {} }
    sessionList({ warm: !!warm, size: P.opts.size }).then(function (items) {
      if (P.destroyed) return;
      P.items = items || [];
      paintTrack(P);
      if (!P.items.length) finish(P, false); else showCard(P);
    });
  }

  /* ------------------------------------------------------------ question -- */

  function renderQuestion(P, C) {
    var it = C.it;
    kicker(C, ['Question', weekLabel(it), BANK_TOPIC[it.bank] || '']);
    var stem = h('h2', { class: 'rc-prompt rc-stem', tabindex: '-1' });
    stem.textContent = '…';
    C.card.appendChild(stem);
    var body = h('div', { class: 'rc-body' });
    C.card.appendChild(body);
    var after = h('div', { class: 'rc-after', tabindex: '-1', hidden: true });
    C.card.appendChild(after);
    actionSlot(C);
    C.after = after;

    questionOf(it).then(function (hit) {
      if (P.destroyed || P.cur !== C) return;
      if (!hit) {
        stem.textContent = 'this question has moved on.';
        body.appendChild(h('p', { class: 'rc-note fu-small', text: 'it is no longer in its bank, so it leaves the queue. nothing is lost.' }));
        var nb = h('button', { type: 'button', class: 'rc-btn fu-btn', text: 'Next card' });
        nb.addEventListener('click', function () { skip(P, 'missing'); });
        C.slot.appendChild(nb);
        return;
      }
      var q = hit.q;
      C.q = q;
      if (!it.concept && q.concept) it.concept = q.concept;
      var stems = [q.stem].concat(Array.isArray(q.variants) ? q.variants.filter(Boolean) : []);
      stem.innerHTML = stems[Math.floor(Math.random() * stems.length)] || q.stem || '';
      var type = String(q.type || 'mcq').toLowerCase();
      if (type === 'scenario') type = 'mcq';
      if (type === 'mcq') askMCQ(P, C, q, body);
      else if (type === 'numeric') askNumeric(P, C, q, body);
      else if (type === 'ordering') askOrdering(P, C, q, body);
      else askShort(P, C, q, body);
    });
  }

  function verdict(P, C, ok, extra) {
    var q = C.q, it = C.it, after = C.after;
    after.hidden = false;
    after.textContent = '';
    after.appendChild(h('p', { class: 'rc-verdict fu-voice', 'data-ok': ok ? '1' : '0',
                              text: ok ? 'got it.' : 'almost. here’s the why.' }));
    if (extra) after.appendChild(extra);
    if (q.explanation || q.why) after.appendChild(h('div', { class: 'rc-explain', html: relabel(q.explanation || q.why, C.map) }));
    var links = h('p', { class: 'rc-links' });
    var cid = q.concept || it.concept;
    if (NODES && cid && NODES[cid]) {
      links.appendChild(doorLink('▶ 1-minute film', viewHref('intuition/' + (NODES[cid].film || 'node.html?id=' + cid)), 'rc-door rc-film fu-btn fu-btn--ghost'));
    }
    if (it.bank) {
      links.appendChild(doorLink(CLABEL[cid] ? 'Drill ' + CLABEL[cid].toLowerCase() : 'More from this bank',
        '#drill/' + it.bank + (cid ? '/' + encodeURIComponent(cid) : ''), 'rc-door fu-btn fu-btn--ghost'));
    }
    if (links.childNodes.length) after.appendChild(links);
    showGrades(P, C, ok ? 'solid' : 'shaky');
  }

  function askMCQ(P, C, q, body) {
    var opts = shuffle((q.options || []).map(function (o, i) {
      return { id: o && o.id != null ? String(o.id) : 'o' + i, text: o && o.text != null ? String(o.text) : String(o), correct: !!(o && o.correct) };
    }));
    C.map = {};
    opts.forEach(function (o, i) { if (/^[a-h]$/i.test(o.id)) C.map[o.id.toLowerCase()] = LETTERS.charAt(i); });
    var multi = opts.filter(function (o) { return o.correct; }).length > 1;
    var picked = [];
    var ul = h('ul', { class: 'rc-options', role: 'list' });
    var btns = [];
    opts.forEach(function (o, i) {
      var b = h('button', { type: 'button', class: 'rc-opt', 'data-oid': o.id, 'aria-pressed': 'false' },
                [h('kbd', { class: 'rc-opt-k fu-kbd', 'aria-hidden': 'true', text: LETTERS.charAt(i) }), h('span', { class: 'rc-opt-t', html: o.text })]);
      b.addEventListener('click', function () { pick(i); });
      btns.push(b);
      ul.appendChild(h('li', null, [b]));
    });
    body.appendChild(ul);
    var check = null;
    if (multi) {
      body.appendChild(h('p', { class: 'rc-note fu-small', text: 'more than one fits. pick them all, then check.' }));
      check = h('button', { type: 'button', class: 'rc-btn fu-btn fu-btn--big fu-btn--wide', text: 'Check', disabled: true });
      check.addEventListener('click', grade);
      C.slot.appendChild(check);
    }
    function pick(i) {
      if (P.phase !== 'ask') return;
      var id = opts[i] && opts[i].id;
      if (id == null) return;
      if (multi) {
        var k = picked.indexOf(id);
        if (k >= 0) picked.splice(k, 1); else picked.push(id);
        btns.forEach(function (b) { b.setAttribute('aria-pressed', String(picked.indexOf(b.getAttribute('data-oid')) >= 0)); });
        check.disabled = !picked.length;
      } else {
        picked = [id];
        grade();
      }
    }
    function grade() {
      if (P.phase !== 'ask' || !picked.length) return;
      var right = opts.filter(function (o) { return o.correct; }).map(function (o) { return o.id; });
      var ok = right.length === picked.length && right.every(function (id) { return picked.indexOf(id) >= 0; });
      btns.forEach(function (b) {
        var id = b.getAttribute('data-oid');
        b.disabled = true;
        if (right.indexOf(id) >= 0) { b.classList.add('is-right'); b.appendChild(h('span', { class: 'rc-tag fu-badge fu-badge--gold', text: 'this one' })); }
        else if (picked.indexOf(id) >= 0) { b.classList.add('is-picked'); b.appendChild(h('span', { class: 'rc-tag fu-badge fu-badge--quiet', text: 'your pick' })); }
      });
      if (check) check.remove();
      verdict(P, C, ok);
    }
    C.key = function (k) {
      var i = letterIndex(k);
      if (i >= 0 && i < opts.length) { pick(i); return true; }
      if (k === 'enter' && check && !check.disabled) { grade(); return true; }
      return false;
    };
    keysHint(C, [[pickKeys(opts.length), 'pick'], ['enter', 'takes the marked grade'], ['G S B', 'grade']]);
    focusSoft(C.card.querySelector('.rc-prompt'));
  }

  function parseNumber(str) {
    var s = String(str == null ? '' : str).trim().replace(/,/g, '').replace(/−/g, '-').replace(/\s+/g, '');
    if (!s) return NaN;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
      var m = s.match(/^([+-]?(?:\d+\.?\d*|\.\d+))(?:[x*]10\^([+-]?\d+))$/i);
      return m ? Number(m[1]) * Math.pow(10, Number(m[2])) : NaN;
    }
    return Number(s);
  }

  function askNumeric(P, C, q, body) {
    var id = 'rc-num-' + Math.random().toString(36).slice(2, 8);
    var input = h('input', { id: id, class: 'rc-input fu-input', type: 'text', inputmode: 'decimal', autocomplete: 'off',
                             spellcheck: 'false', placeholder: 'a number (1.5e-3 works)' });
    var row = h('div', { class: 'rc-numrow' }, [
      h('label', { class: 'fu-sr', for: id, text: 'Your answer' }), input,
      q.unit ? h('span', { class: 'rc-unit fu-small', text: q.unit }) : null
    ]);
    body.appendChild(row);
    var check = h('button', { type: 'button', class: 'rc-btn fu-btn fu-btn--big fu-btn--wide', text: 'Check' });
    C.slot.appendChild(check);
    keysHint(C, [['enter', 'checks'], ['G S B', 'grade']]);
    function grade() {
      if (P.phase !== 'ask') return;
      var val = parseNumber(input.value);
      if (isNaN(val)) { input.setAttribute('aria-invalid', 'true'); focusSoft(input); return; }
      var tol = q.tolerance == null ? 1e-9 : Math.abs(Number(q.tolerance));
      var ok = Math.abs(val - Number(q.answer)) <= tol;
      input.disabled = true;
      input.classList.add(ok ? 'is-right' : 'is-picked');
      check.remove();
      var extra = ok ? null : h('p', { class: 'rc-note fu-small', text: 'it was ' + q.answer + (q.unit ? ' ' + q.unit : '') + ' (anything within ±' + tol + ' counts).' });
      verdict(P, C, ok, extra);
    }
    check.addEventListener('click', grade);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); grade(); }
    });
    C.key = function (k) { if (k === 'enter') { grade(); return true; } return false; };
    focusSoft(input);
  }

  function askOrdering(P, C, q, body) {
    var truth = (q.items || []).map(String);
    var remaining = shuffle(truth), placed = [];
    body.appendChild(h('p', { class: 'rc-note fu-small', text: 'tap them in order. tap a placed one to take it back.' }));
    var seq = h('ol', { class: 'rc-seq', 'aria-label': 'Your order' });
    var pool = h('ul', { class: 'rc-pool', 'aria-label': 'Still to place' });
    body.appendChild(seq);
    body.appendChild(pool);
    var check = h('button', { type: 'button', class: 'rc-btn fu-btn fu-btn--big fu-btn--wide', text: 'Check', disabled: true });
    C.slot.appendChild(check);
    function paint() {
      seq.textContent = ''; pool.textContent = '';
      placed.forEach(function (t, i) {
        var b = h('button', { type: 'button', class: 'rc-item is-placed', 'data-i': String(i) },
                  [h('span', { class: 'rc-item-n fu-mono', text: String(i + 1) }), h('span', { class: 'rc-opt-t', html: t })]);
        b.addEventListener('click', function () {
          if (P.phase !== 'ask') return;
          placed.splice(i, 1); remaining.push(t); paint();
        });
        seq.appendChild(h('li', null, [b]));
      });
      remaining.forEach(function (t, i) {
        var b = h('button', { type: 'button', class: 'rc-item' },
                  [h('kbd', { class: 'rc-opt-k fu-kbd', 'aria-hidden': 'true', text: LETTERS.charAt(i) }), h('span', { class: 'rc-opt-t', html: t })]);
        b.addEventListener('click', function () { place(i); });
        pool.appendChild(h('li', null, [b]));
      });
      check.disabled = remaining.length !== 0;
      seq.hidden = !placed.length;
    }
    function place(i) {
      if (P.phase !== 'ask' || remaining[i] == null) return;
      placed.push(remaining[i]); remaining.splice(i, 1); paint();
      if (!remaining.length) focusSoft(check);
    }
    function grade() {
      if (P.phase !== 'ask' || remaining.length) return;
      var ok = placed.length === truth.length && placed.every(function (x, i) { return x === truth[i]; });
      Array.prototype.forEach.call(seq.querySelectorAll('.rc-item'), function (b, i) {
        b.disabled = true;
        b.classList.add(placed[i] === truth[i] ? 'is-right' : 'is-picked');
      });
      check.remove();
      var extra = null;
      if (!ok) {
        extra = h('div', { class: 'rc-note fu-small' }, [h('span', { text: 'the order runs:' })]);
        var ol = h('ol', { class: 'rc-truth' });
        truth.forEach(function (t) { ol.appendChild(h('li', { html: t })); });
        extra.appendChild(ol);
      }
      verdict(P, C, ok, extra);
    }
    check.addEventListener('click', grade);
    C.key = function (k) {
      var i = letterIndex(k);
      if (i >= 0 && i < remaining.length) { place(i); return true; }
      if (k === 'enter') { grade(); return true; }
      return false;
    };
    keysHint(C, [[pickKeys(truth.length), 'place'], ['enter', 'checks'], ['G S B', 'grade']]);
    paint();
    focusSoft(C.card.querySelector('.rc-prompt'));
  }

  function askShort(P, C, q, body) {
    var reveal = h('button', { type: 'button', class: 'rc-btn rc-reveal fu-btn fu-btn--big fu-btn--wide', text: 'Show me' });
    C.slot.appendChild(reveal);
    function show() {
      if (P.phase !== 'ask') return;
      reveal.remove();
      C.after.hidden = false;
      C.after.appendChild(h('p', { class: 'rc-plain', html: String(q.answer || '') }));
      if (q.explanation) C.after.appendChild(h('div', { class: 'rc-explain', html: q.explanation }));
      showGrades(P, C, null);
    }
    reveal.addEventListener('click', show);
    C.reveal = show;
    keysHint(C, [['space', 'shows'], ['G S B', 'grade']]);
    void body;
  }

  /* ------------------------------------------------------------- concept -- */

  /* Each tier adds one thing the plain line above it does not say: the picture
     (Plain), when to reach for it (Generalist), why it matters (Expert). The
     node's "what" mostly restates the plain line, so it is only a fallback.
     One short paragraph each keeps the answer and the grades on one phone screen. */
  var PART_SUB = { allegory: 'picture it', what: 'what it is', when: 'when to use it', why: 'why it matters' };
  function tierPart(node, n) {
    if (!node) return null;
    var hm = node.hamming || {};
    var order = n === 1 ? [['allegory', node.allegory], ['what', hm.what]]
      : n === 3 ? [['why', hm.why], ['what', hm.what], ['allegory', node.allegory]]
      : [['when', hm.when], ['what', hm.what], ['allegory', node.allegory]];
    for (var i = 0; i < order.length; i++) {
      if (order[i][1] && typeof order[i][1] === 'string') return { key: order[i][0], text: order[i][1] };
    }
    return null;
  }
  /* The week path's card (APP.paths.card): its plain line, and its tier text
     when the node file has none. */
  function pathsCard(it) {
    try {
      if (APP.paths && typeof APP.paths.card === 'function') return APP.paths.card(it.concept || it.ref, it.week) || null;
    } catch (e) {}
    return null;
  }

  function renderConcept(P, C) {
    var it = C.it, cid = it.concept || it.ref;
    kicker(C, ['Idea', weekLabel(it)]);
    C.card.appendChild(h('p', { class: 'rc-ask fu-voice', text: 'say it in one line:' }));
    var label = h('h2', { class: 'rc-prompt rc-label', tabindex: '-1', text: it.label || it.title || cid });
    C.card.appendChild(label);
    var hint = h('p', { class: 'rc-hint fu-small' });
    C.card.appendChild(hint);
    var after = h('div', { class: 'rc-after', tabindex: '-1', hidden: true });
    var plain = h('p', { class: 'rc-plain' });
    /* all three tiers share one grid cell, so the tallest sets the height and a
       tier change only swaps which one is visible: nothing moves (the week
       path's ideas deck does the same) */
    var tiers = h('div', { class: 'rc-tiers', 'data-tier': String(tierNow()), hidden: true });
    var layers = {};
    [1, 2, 3].forEach(function (n) {
      layers[n] = h('div', { class: 'rc-tier', 'data-t': String(n) }, [h('p', { class: 'rc-tier-k fu-label' }), h('p', { class: 'rc-tier-t' })]);
      tiers.appendChild(layers[n]);
    });
    var links = h('p', { class: 'rc-links' });
    after.appendChild(plain);
    after.appendChild(tiers);
    after.appendChild(links);
    C.card.appendChild(after);
    C.after = after;
    actionSlot(C);
    var reveal = h('button', { type: 'button', class: 'rc-btn rc-reveal fu-btn fu-btn--big fu-btn--wide', text: 'Show me' });
    C.slot.appendChild(reveal);
    keysHint(C, [['space', 'shows'], ['G S B', 'grade']]);

    var data = { node: null, full: null, card: pathsCard(it) };
    function fillTiers() {
      var any = false;
      [1, 2, 3].forEach(function (n) {
        /* the node's one short thought first; the week path's card text (whole
           what / when / why, where else) is the fallback, being a page long */
        var part = tierPart(data.full, n);
        if (!part) {
          var ct = data.card && data.card.tiers ? (data.card.tiers[n] || data.card.tiers[String(n)]) : '';
          if (typeof ct === 'string' && ct) part = { key: '', text: ct };
        }
        layers[n].firstChild.textContent = part ? TIER_NAME[n] + (part.key ? ' · ' + PART_SUB[part.key] : '') : '';
        layers[n].lastChild.textContent = part ? part.text : '';
        if (part) any = true;
      });
      tiers.hidden = !any;
      applyTier();
    }
    function applyTier() {
      var t = String(tierNow());
      tiers.setAttribute('data-tier', t);
      [1, 2, 3].forEach(function (n) {
        if (String(n) === t) layers[n].removeAttribute('aria-hidden'); else layers[n].setAttribute('aria-hidden', 'true');
      });
    }
    C.onTier = applyTier;

    nodesIndex().then(function (nodes) {
      if (P.destroyed || P.cur !== C) return;
      var n = nodes && nodes[cid];
      data.node = n || null;
      if (n) {
        if (!it.label && !it.title) label.textContent = n.label || cid;
        hint.textContent = '';
        if (n.title) { hint.appendChild(document.createTextNode('hint: ')); hint.appendChild(h('span', { class: 'rc-hint-t', text: n.title })); }
        hint.hidden = !n.title;
      } else {
        hint.hidden = true;
      }
      plain.textContent = (data.card && typeof data.card.plain === 'string' && data.card.plain) || (n && n.plain) || it.text || '';
      links.textContent = '';
      var film = n ? viewHref('intuition/' + (n.film || 'node.html?id=' + cid)) : null;
      if (film) links.appendChild(doorLink('▶ 1-minute film', film, 'rc-door rc-film fu-btn fu-btn--ghost'));
      if (it.hash) links.appendChild(doorLink('Open the card', it.hash, 'rc-door fu-btn fu-btn--ghost'));
      else if (it.bank) links.appendChild(doorLink('Drill it', '#drill/' + it.bank + '/' + encodeURIComponent(cid), 'rc-door fu-btn fu-btn--ghost'));
      return n ? nodeFull(cid) : null;
    }).then(function (full) {
      if (P.destroyed || P.cur !== C) return;
      data.full = full || null;
      fillTiers();
      if (P.phase === 'grade') bringIntoView(C.slot);   // the text came after the reveal
    });

    function show() {
      if (P.phase !== 'ask') return;
      after.hidden = false;
      reveal.remove();
      applyTier();
      showGrades(P, C, null);
    }
    reveal.addEventListener('click', show);
    C.reveal = show;
    focusSoft(reveal);
  }

  /* ------------------------------------------------------------ sentence -- */

  function renderSentence(P, C) {
    var it = C.it;
    kicker(C, ['Saved line', weekLabel(it)]);
    if (it.title) C.card.appendChild(h('p', { class: 'rc-from fu-small', text: 'from ' + it.title }));
    C.card.appendChild(h('blockquote', { class: 'rc-quote rc-prompt', tabindex: '-1', text: it.text || '' }));
    C.card.appendChild(h('p', { class: 'rc-ask fu-voice', text: 'still clear?' }));
    var links = h('p', { class: 'rc-links' });
    if (it.hash) links.appendChild(doorLink('Open where it came from', it.hash, 'rc-door fu-btn fu-btn--ghost'));
    var letGo = h('button', { type: 'button', class: 'rc-quiet fu-btn fu-btn--link', text: 'Let it go' });
    letGo.addEventListener('click', function () {
      var x = find(it.id);
      if (x) { x.off = true; x.offWhy = 'let go'; x.offOn = todayISO(); save(); }
      P.results.push({ id: it.id, kind: it.kind, g: 'off' });
      P.done++;
      P.i++;
      if (P.i >= P.items.length) finish(P, false); else showCard(P);
    });
    links.appendChild(letGo);
    C.card.appendChild(links);
    actionSlot(C);
    keysHint(C, [['G S B', 'grade']]);
    showGrades(P, C, null);
  }

  /* ---------------------------------------------------------------- keys -- */

  function editable(t) {
    if (!t) return false;
    var tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable === true;
  }
  /* Digits are the app-wide tier keys, so the player never reads them:
     space reveals, letters pick and grade, enter accepts the suggestion. */
  function bindKeys(P) {
    function onKey(e) {
      if (P.destroyed || e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!P.root.isConnected || (!P.root.offsetParent && P.root.getClientRects().length === 0)) return;
      if (editable(e.target)) return;
      var k = e.key === ' ' || e.key === 'Spacebar' ? 'space' : String(e.key || '').toLowerCase();
      if (/^[0-9]$/.test(k)) return;
      var C = P.cur;
      var used = false;
      if (P.phase === 'grade') {
        if (k === 'g') { commit(P, C, 'solid'); used = true; }
        else if (k === 's') { commit(P, C, 'shaky'); used = true; }
        else if (k === 'b') { commit(P, C, 'blank'); used = true; }
        else if (k === 'enter' && P.suggest && !(e.target && e.target.closest && e.target.closest('button, a'))) {
          commit(P, C, P.suggest); used = true;
        }
      } else if (P.phase === 'ask' && C) {
        if (k === 'space' && C.reveal && !(e.target && e.target.closest && e.target.closest('button, a'))) { C.reveal(); used = true; }
        else if (C.key && k !== 'space') used = !!C.key(k);
      }
      if (used) e.preventDefault();
    }
    document.addEventListener('keydown', onKey);
    return function () { document.removeEventListener('keydown', onKey); };
  }

  function onTierAll() {
    players.forEach(function (P) { if (P.cur && typeof P.cur.onTier === 'function') { try { P.cur.onTier(); } catch (e) {} } });
  }
  try { if (typeof APP.onTierChange === 'function') APP.onTierChange(onTierAll); else window.addEventListener('tara:tier', onTierAll); }
  catch (e) { window.addEventListener('tara:tier', onTierAll); }

  /* ---------------------------------------------------------------- sync -- */

  var resyncT = 0;
  function resync() {
    clearTimeout(resyncT);
    resyncT = setTimeout(function () {
      ensure();
      try { if (syncNow()) importConcepts(); } catch (e) {}
    }, 60);
  }
  window.addEventListener('storage', function (e) {
    if (!e) return;
    if (e.key === KEY || e.key === null) { S = null; emit(); }
    if (e.key === K_REVIEW || e.key === K_MASTERY || e.key === null) resync();
  });
  window.addEventListener('tara:review', resync);
  document.addEventListener('tara:quiz-answered', function (e) {
    if (e && e.detail && e.detail.ok === false) resync();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { S = null; resync(); emit(); }
  });

  var readyResolve;
  var ready = new Promise(function (res) { readyResolve = res; });
  setTimeout(function () {
    ensure();
    emit();
    /* concepts need the bank payloads and the node index: after the first paint */
    setTimeout(function () {
      importConcepts().then(function () { readyResolve(true); }, function () { readyResolve(false); });
    }, 400);
  }, 0);

  /* ----------------------------------------------------------------- API -- */

  APP.recall = {
    __v2: true,
    RUNGS: RUNGS.slice(),
    SESSION_MAX: SESSION_MAX,
    ready: ready,
    add: function (spec) { ensure(); var it = addItem(spec); return copy(it); },
    get: function (id) { ensure(); return copy(find(id)); },
    list: function () { ensure(); var s = store(), out = []; for (var id in s.items) out.push(copy(s.items[id])); return out.sort(sortDue); },
    dueCount: function (iso) { return dueCount(iso); },
    due: function (iso) { ensure(); return dueRaw(iso).map(copy); },
    grade: function (id, g) { ensure(); return gradeItem(id, g); },
    /* when the item would come back after grade g: { days, date, word } */
    preview: function (id, g) {
      ensure();
      var it = find(id); g = normGrade(g);
      if (!it || !g) return null;
      var d = intervalFor(it, g);
      return { days: d, date: addDays(todayISO(), d), word: inDays(d) };
    },
    letGo: function (id) { ensure(); var it = find(id); if (!it) return null; it.off = true; it.offWhy = 'let go'; it.offOn = todayISO(); save(); return copy(it); },
    restore: function (id) { ensure(); var it = find(id); if (!it) return null; it.off = false; save(); return copy(it); },
    next: function (iso) { return nextAfter(iso); },
    minutes: function (items) { return minutesFor(items || dueRaw(todayISO()).slice(0, SESSION_MAX)); },
    summary: function (iso) {
      ensure();
      var t = isISO(iso) ? iso : todayISO(), list = dueRaw(t), byKind = { question: 0, concept: 0, sentence: 0 };
      list.forEach(function (it) { byKind[it.kind] = (byKind[it.kind] || 0) + 1; });
      var take = list.slice(0, SESSION_MAX);
      return { today: t, due: list.length, session: take.length, minutes: minutesFor(take), byKind: byKind,
               total: activeCount(), next: nextAfter(t) };
    },
    session: function (opts) { return sessionList(opts); },
    mountSession: mountSession,
    recentWeeks: recentWeeks,
    banksOfWeeks: banksOfWeeks,
    sync: function () { ensure(); syncNow(); return importConcepts(); },
    todayISO: todayISO,
    whenWord: whenWord,
    _store: function () { return store(); },
    _reload: function () { S = null; synced = false; ensure(); emit(); return store(); }
  };
})();
