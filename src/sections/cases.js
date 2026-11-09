/* app/sections/cases.js — Worker C
 * The applied case-study library (104 cards), rebuilt natively in the shell DOM
 * from case-studies/*.json + concepts-index.json. Ported from the published
 * library (artifact f40cee0d) with three deliberate changes:
 *   1. the shell owns the ONE tier control — this section renders none;
 *   2. all three story tiers live in the DOM at once, stacked in one grid cell,
 *      so a tier change is a visibility flip and nothing moves (SPEC rule 1);
 *   3. filtering DIMS cards in place instead of display:none, so the grid never
 *      re-flows and a remembered position stays a valid position.
 *
 * The index `title` is the concept's human label; the card `title` is the
 * applied-use headline. They are different on purpose. Neither is ever written
 * from the other. (case-studies/README.md, "Settled".)
 */
(function () {
  'use strict';

  var APP = window.APP;
  if (!APP || !APP.registerSection) return;

  var TIER_NAME = { 1: 'plain', 2: 'generalist', 3: 'expert' };
  /* TARA's Saturdays (the schedule payload's dates win when it is loaded) */
  var WEEK_DATE = {
    0: 'Sat 5 Sep', 1: 'Sat 12 Sep', 2: 'Sat 19 Sep', 3: 'Sat 26 Sep', 4: 'Sat 3 Oct', 5: 'Sat 10 Oct',
    6: 'Sat 17 Oct', 7: 'Sat 24 Oct', 8: 'Sat 31 Oct', 9: 'Sat 7 Nov', 10: 'Sat 14 Nov', 11: 'Sat 21 Nov',
    12: 'Sat 28 Nov', 13: 'Sat 5 Dec', 14: 'Sat 12 Dec'
  };
  /* TARA's chapters (the brand's chapter keys) and their names */
  var TARA_CH = [
    { key: 'found', head: 'Prerequisites and foundations', chip: 'Foundations', from: 0, to: 1 },
    { key: 'interp', head: 'Mech interp', chip: 'Mech interp', from: 2, to: 4 },
    { key: 'rl', head: 'Reinforcement learning', chip: 'RL', from: 5, to: 6 },
    { key: 'evals', head: 'Model evaluations', chip: 'Evals', from: 7, to: 9 },
    { key: 'align', head: 'Alignment science', chip: 'Alignment', from: 10, to: 11 }
  ];
  function chOfWeek(n) {
    for (var i = 0; i < TARA_CH.length; i++) if (n != null && n >= TARA_CH[i].from && n <= TARA_CH[i].to) return TARA_CH[i];
    return null;
  }
  /* The TARA Saturday a case belongs to, from the ARENA section it comes from.
     (The payload's own `week` is ARENA's numbering, which is not TARA's.)
     W0 [0.0] [0.1] · W1 [0.2]-[0.5] · W2 [1.1] · W3 [1.2] · W4 [1.3]-[1.5] ·
     W5 [2.1] [2.2.1] · W6 [2.2.2] [2.3]-[2.5] · W7 [3.1] [3.2] · W8 [3.3] ·
     W9 [3.4] [3.5] · W10 [4.1] [4.2] · W11 [4.3]-[4.5]; the same weeks
     intuition/nodes/index.json gives each section. */
  function taraWeek(sec) {
    var m = /^\[(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(sec || '').trim());
    if (!m) return null;
    var a = +m[1], b = +m[2], c = m[3] == null ? null : +m[3];
    if (a === 0) return b <= 1 ? 0 : 1;
    if (a === 1) return b <= 1 ? 2 : b === 2 ? 3 : 4;
    if (a === 2) return b === 1 || (b === 2 && c === 1) ? 5 : 6;
    if (a === 3) return b <= 2 ? 7 : b === 3 ? 8 : 9;
    if (a === 4) return b <= 2 ? 10 : 11;
    return null;
  }
  function weekDate(n) {
    try {
      var sch = APP.schedule && APP.schedule();
      var ws = sch && sch.weeks;
      for (var i = 0; ws && i < ws.length; i++) {
        if (ws[i].n === n && ws[i].saturday && APP.prettyDate) return APP.prettyDate(ws[i].saturday);
      }
    } catch (e) {}
    return WEEK_DATE[n] || '';
  }
  function chHead(ch) {
    /* the schedule's own chapter names for the chapter's weeks, e.g. "Prerequisites and foundations" */
    try {
      var sch = APP.schedule && APP.schedule();
      var ws = (sch && sch.weeks) || [], names = [];
      for (var i = 0; i < ws.length; i++) {
        if (ws[i].n >= ch.from && ws[i].n <= ch.to && ws[i].chapter && names.indexOf(ws[i].chapter) < 0) names.push(ws[i].chapter);
      }
      if (names.length) {
        return names.map(function (x, j) { return j ? x.charAt(0).toLowerCase() + x.slice(1) : x; }).join(' and ');
      }
    } catch (e) {}
    return ch.head;
  }
  function wkKey(c) { return c._tw == null ? 'none' : String(c._tw); }
  var KINDS = ['workflow', 'debugging', 'breakthrough'];

  /* ------------------------------------------------------------- helpers */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function attr(s) { return esc(s).replace(/"/g, '&quot;'); }
  function rxesc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function trunc(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n - 1).replace(/[\s\-]+$/, '') + '…' : s;
  }
  function isField(el) { return !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''); }

  /* The shell owns the SPEC §8 weights; fall back only if it is not up yet. */
  function score1(q, rec) {
    if (typeof APP.score === 'function') return APP.score(q, rec);
    var id = String(rec.id || '').toLowerCase(), t = String(rec.title || '').toLowerCase();
    if (id === q) return 100;
    if (t.indexOf(q) === 0) return 60;
    if (t.indexOf(q) >= 0 || id.indexOf(q) >= 0) return 40;
    return String(rec.body || '').toLowerCase().indexOf(q) >= 0 ? 15 : 0;
  }

  function scroller(node) {
    var n = node && node.parentNode;
    while (n && n.nodeType === 1) {
      var st = getComputedStyle(n);
      if (/(auto|scroll|overlay)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 4) return n;
      n = n.parentNode;
    }
    return window;
  }
  function scrollTopOf(sc) { return sc === window ? window.pageYOffset : sc.scrollTop; }
  function scrollBy(sc, dy) {
    if (!dy) return;
    if (sc === window) window.scrollBy(0, dy);
    else sc.scrollTop += dy;
  }

  /* --------------------------------------------------------------- state */
  var S = {
    built: false,
    root: null,
    cards: [],          // card objects, in the fixed order established once
    index: {},          // id -> index row (human label + aliases)
    els: [],            // .cases-card elements, parallel to S.cards — never re-ordered
    hay: [],            // lowercase search haystack, parallel
    gids: [],           // week-group id per card, parallel
    groups: {},         // gid -> {sec, out, rail, railN}
    filter: { kind: null, chapter: null, week: null },
    matches: [],        // indices currently matching the filter
    matchAt: -1,
    pop: null,
    popFor: null,
    back: null,
    backTo: null,
    backTimer: 0,
    hitTimer: 0,
    lastHit: null,
    sc: window,
    keyHandler: null
  };

  function label(id) {
    var r = S.index[id];
    return r ? r.title : id;
  }

  /* --------------------------------------------------- glossary marking */
  function gBtn(g, text) {
    return '<button type="button" class="cases-g" data-t="' + attr(g.term) +
      '" data-e="' + attr(g.expansion || '') + '" data-g="' + attr(g.gloss) + '">' + text + '</button>';
  }
  function markGlossary(paras, gloss) {
    var used = {};
    var terms = gloss.slice().sort(function (a, b) { return b.term.length - a.term.length; });
    var out = paras.map(function (p) {
      var html = esc(p);
      for (var i = 0; i < terms.length; i++) {
        var g = terms[i];
        if (used[g.term]) continue;
        var re;
        try { re = new RegExp('(^|[^\\w\\-])(' + rxesc(esc(g.term)) + ')(?![\\w\\-])', 'i'); }
        catch (err) { continue; }
        if (!re.test(html)) continue;
        html = html.replace(re, function (m0, p1, p2) { return p1 + gBtn(g, p2); });
        used[g.term] = 1;
      }
      return '<p>' + html + '</p>';
    }).join('');
    var left = gloss.filter(function (g) { return !used[g.term]; });
    if (left.length) {
      out += '<div class="cases-terms"><span class="cases-lab">also</span>' +
        left.map(function (g) { return gBtn(g, esc(g.term)); }).join('') + '</div>';
    }
    return out;
  }
  function storyBlocks(c) {
    var out = '', n, name;
    for (n = 1; n <= 3; n++) {
      name = TIER_NAME[n];
      var paras = (c.story && c.story[name]) || [];
      var html;
      if (n === 3 && c.glossary && c.glossary.length) html = markGlossary(paras, c.glossary);
      else html = paras.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('');
      out += '<div class="cases-tier" data-t="' + n + '" aria-hidden="' + (n === 2 ? 'false' : 'true') +
        '">' + html + '</div>';
    }
    return out;
  }

  /* -------------------------------------------- where-this-fits diagram */
  var VW = 680, COL = 196, LX1 = 196, MX0 = 232, MX1 = 448, RX0 = 484;
  var ROW_TOP = 24, ROW_H = 28, CHIP_H = 22, CW = 6.05;

  function chip(x, y, w, h, id, text, full, stroke, fill, cls, tfill) {
    return '<g class="cases-fchip" data-go="' + attr(id) + '" tabindex="0" role="link" aria-label="Go to ' +
      attr(full) + '"><title>' + esc(full) + ' — ' + esc(id) + '</title>' +
      '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="3" fill="' + fill +
      '" stroke="' + stroke + '" stroke-width="1"></rect>' +
      '<text class="' + cls + '" x="' + (x + 9) + '" y="' + (y + h / 2 + 4) + '" fill="' + tfill + '">' +
      esc(text) + '</text></g>';
  }

  /* V2: the diagram's links as 44px buttons, shown instead of it below 720px
     (cases.css), where its chips are 17px tall. Same data-go, same handlers. */
  function fitsList(c) {
    var rows = [
      ['depends on', c.depends_on || [], 'nothing upstream', ' is-up'],
      ['builds into', c.builds_into || [], 'nothing builds on it yet', ' is-down'],
      ['alongside', c.neighbours || [], null, '']
    ];
    var h = ['<div class="cases-fits-list">'];
    rows.forEach(function (r) {
      if (!r[1].length && !r[2]) return;
      h.push('<div class="cases-frow"><span class="cases-frow-lab">' + r[0] + '</span>');
      if (!r[1].length) h.push('<span class="cases-frow-none">' + r[2] + '</span>');
      r[1].forEach(function (id) {
        h.push('<button type="button" class="cases-fchip cases-fbtn' + r[3] + '" data-go="' + attr(id) +
          '" aria-label="Go to ' + attr(label(id)) + '">' + esc(label(id)) + '</button>');
      });
      h.push('</div>');
    });
    h.push('</div>');
    return h.join('');
  }

  function fitsSVG(c) {
    var L = c.depends_on || [], R = c.builds_into || [], N = c.neighbours || [];
    var rows = Math.max(L.length, R.length, 1);
    var bandH = rows * ROW_H;
    var p = [], i, y, t, w;

    p.push('<text class="cases-fcap" x="' + LX1 + '" y="12" text-anchor="end">DEPENDS ON</text>');
    p.push('<text class="cases-fcap" x="' + RX0 + '" y="12">BUILDS INTO</text>');

    var ccy = ROW_TOP + bandH / 2 - 2, chH = 32, chY = ccy - chH / 2, ccx = (MX0 + MX1) / 2;

    for (i = 0; i < L.length; i++) {
      y = ROW_TOP + i * ROW_H + CHIP_H / 2;
      p.push('<path d="M' + LX1 + ',' + y + ' C' + (LX1 + 20) + ',' + y + ' ' + (MX0 - 20) + ',' + ccy +
        ' ' + MX0 + ',' + ccy + '" fill="none" stroke="var(--cs-up)" stroke-width="1" opacity=".55"></path>');
    }
    if (L.length) {
      p.push('<path d="M' + (MX0 - 6.5) + ',' + (ccy - 3.6) + ' L' + MX0 + ',' + ccy + ' L' +
        (MX0 - 6.5) + ',' + (ccy + 3.6) + ' Z" fill="var(--cs-up)"></path>');
    }
    for (i = 0; i < R.length; i++) {
      y = ROW_TOP + i * ROW_H + CHIP_H / 2;
      p.push('<path d="M' + MX1 + ',' + ccy + ' C' + (MX1 + 20) + ',' + ccy + ' ' + (RX0 - 20) + ',' + y +
        ' ' + (RX0 - 7) + ',' + y + '" fill="none" stroke="var(--accent)" stroke-width="1" opacity=".55"></path>');
      p.push('<path d="M' + (RX0 - 7) + ',' + (y - 3.6) + ' L' + RX0 + ',' + y + ' L' + (RX0 - 7) + ',' +
        (y + 3.6) + ' Z" fill="var(--accent)"></path>');
    }

    if (!L.length) {
      p.push('<text class="cases-fnone" x="' + LX1 + '" y="' + (ROW_TOP + 15) + '" text-anchor="end">nothing upstream</text>');
    } else {
      for (i = 0; i < L.length; i++) {
        t = trunc(label(L[i]), 28); w = Math.min(COL, Math.ceil(t.length * CW) + 20);
        p.push(chip(LX1 - w, ROW_TOP + i * ROW_H, w, CHIP_H, L[i], t, label(L[i]),
          'var(--cs-up)', 'var(--cs-up-soft)', 'cases-fct', 'var(--ink)'));
      }
    }
    if (!R.length) {
      p.push('<text class="cases-fnone" x="' + RX0 + '" y="' + (ROW_TOP + 15) + '">nothing builds on it yet</text>');
    } else {
      for (i = 0; i < R.length; i++) {
        t = trunc(label(R[i]), 28); w = Math.min(COL, Math.ceil(t.length * CW) + 20);
        p.push(chip(RX0, ROW_TOP + i * ROW_H, w, CHIP_H, R[i], t, label(R[i]),
          'var(--accent)', 'var(--cs-accent-soft)', 'cases-fct', 'var(--ink)'));
      }
    }

    p.push('<rect x="' + MX0 + '" y="' + chY + '" width="' + (MX1 - MX0) + '" height="' + chH +
      '" rx="3" fill="var(--ink)"></rect>');
    p.push('<text class="cases-fcc" x="' + ccx + '" y="' + (chY + chH / 2 + 4.5) +
      '" text-anchor="middle" fill="var(--paper)">' + esc(trunc(label(c.id), 30)) + '</text>');

    var H = ROW_TOP + bandH + 6;

    if (N.length) {
      var sepY = H + 4, capW = 78, x = capW, ny = sepY + 10;
      p.push('<line x1="0" y1="' + sepY + '" x2="' + VW + '" y2="' + sepY +
        '" stroke="var(--cs-rule-2)" stroke-width="1" stroke-dasharray="2 3"></line>');
      p.push('<path d="M' + ccx + ',' + (chY + chH) + ' L' + ccx + ',' + sepY +
        '" stroke="var(--cs-rule-2)" stroke-width="1" stroke-dasharray="2 3" fill="none"></path>');
      p.push('<text class="cases-fcap" x="0" y="' + (ny + 15) + '">ALONGSIDE</text>');
      for (i = 0; i < N.length; i++) {
        t = trunc(label(N[i]), 26); w = Math.min(190, Math.ceil(t.length * CW) + 20);
        if (x + w > VW && x > capW) { x = capW; ny += 26; }
        p.push(chip(x, ny, w, CHIP_H, N[i], t, label(N[i]), 'var(--cs-rule-2)', 'var(--surface)',
          'cases-fct', 'var(--cs-ink-2)'));
        x += w + 7;
      }
      H = ny + CHIP_H + 6;
    }

    return '<svg viewBox="0 0 ' + VW + ' ' + H + '" role="group" aria-label="Where ' +
      attr(label(c.id)) + ' sits among its prerequisites, dependents and neighbours">' +
      p.join('') + '</svg>';
  }

  /* ---------------------------------------------------------------- card */
  function cardHTML(c) {
    var b = c.breakthrough || {}, real = !!b.has_real_story, t = c.troubleshooting || {}, h = [];
    h.push('<article class="cases-card" id="cases-' + attr(c.id) + '" data-id="' + attr(c.id) + '">');
    h.push('<div class="cases-c-head"><div class="cases-tags">');
    h.push('<span class="cases-tag is-' + attr(c.kind) + '">' + esc(c.kind) + '</span>');
    if (c._tw != null) h.push('<span class="cases-tag is-week">W' + c._tw + '</span>');
    h.push('<span class="cases-tag">ARENA ' + esc(c.arena_section) + '</span>');
    if (!real) h.push('<span class="cases-tag">no origin paper</span>');
    h.push('</div><a class="cases-permalink" href="#cases/' + attr(c.id) + '">' + esc(c.id) + '</a></div>');
    h.push('<h3 class="cases-title">' + esc(c.title) + '</h3>');
    h.push('<p class="cases-lede">' + esc(c.applied_use_summary) + '</p>');
    h.push('<p class="cases-def"><b>plainly</b>' + esc(c.plain_statement) + '</p>');
    h.push('<div class="cases-story">' + storyBlocks(c) + '</div>');

    h.push('<div class="cases-block">');
    if (real) {
      h.push('<span class="cases-block-lab">the paper</span>');
      h.push('<p class="cases-paper-t"><a href="' + attr(b.url) + '" target="_blank" rel="noopener">' +
        esc(b.title) + '</a></p>');
      h.push('<p class="cases-paper-m">' + esc(b.authors) + ' · ' + esc(b.venue) + ' · ' + esc(b.year) + '</p>');
      h.push('<p class="cases-paper-w">' + esc(b.why_it_mattered) + '</p>');
    } else {
      /* has_real_story:false is honest, not a hole to fill. Show the gap. */
      h.push('<div class="cases-nostory"><span class="cases-nlab">No clean real-world story — here’s the failure mode instead.</span><p>' +
        esc(b.why_it_mattered) + '</p></div>');
    }
    h.push('</div>');

    h.push('<div class="cases-block' + (real ? '' : ' is-promoted') + '">');
    h.push('<span class="cases-block-lab">' + (real ? 'when it goes wrong' : 'the failure mode') + '</span>');
    h.push('<p class="cases-sym">' + esc(t.symptom) + '</p>');
    h.push('<details' + (real ? '' : ' open') + '><summary>why this happens, and the fix</summary>' +
      '<dl class="cases-dl"><dt>why</dt><dd>' + esc(t.why) + '</dd><dt>fix</dt><dd>' + esc(t.fix) +
      '</dd></dl></details></div>');

    if (c.steps && c.steps.length) {
      h.push('<div class="cases-block"><span class="cases-block-lab">how it was done</span><details><summary>' +
        c.steps.length + ' steps</summary><ol class="cases-steps">' +
        c.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol></details></div>');
    }

    h.push('<div class="cases-fits"><span class="cases-block-lab">where this fits</span>');
    h.push('<div class="cases-fits-wrap">' + fitsSVG(c) + '</div>');
    if (window.TARA_SHELL === 'v2') h.push(fitsList(c));
    h.push('<ul class="cases-fits-lines">' +
      (c.where_this_fits || []).map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') +
      '</ul></div>');

    h.push('<p class="cases-src">' + esc(c.source) +
      (c.citations_verified ? ' <span class="cases-vf">· citations verified ' + esc(c.verified_at) + '</span>' : '') +
      '</p></article>');
    return h.join('');
  }

  /* --------------------------------------------------------------- build */
  function chipHTML(group, value, text, count) {
    return '<button type="button" class="cases-chip" data-f="' + group + '" data-v="' + attr(value) +
      '" aria-pressed="false">' + esc(text) +
      (count == null ? '' : '<span class="cases-n">' + count + '</span>') + '</button>';
  }

  function build(el) {
    var cards = S.cards, i, c;
    var mh = [], rh = [];
    var curCh, curWk, wkOpen = false, chOpen = false;
    var chapters = [], weeks = [], kindCount = {}, chCount = {}, wkCount = {};

    for (i = 0; i < cards.length; i++) {
      c = cards[i];
      var chKey = c._ch || 'none';
      kindCount[c.kind] = (kindCount[c.kind] || 0) + 1;
      chCount[chKey] = (chCount[chKey] || 0) + 1;
      var wkey = wkKey(c);
      wkCount[wkey] = (wkCount[wkey] || 0) + 1;

      if (chKey !== curCh) {
        if (wkOpen) { mh.push('</div></section>'); wkOpen = false; }
        if (chOpen) { mh.push('</section>'); chOpen = false; }
        curCh = chKey; curWk = undefined;
        var ch = chOfWeek(c._tw);
        var head = ch ? chHead(ch) : 'Without a Saturday';
        var eyebrow = ch ? (ch.from === ch.to ? 'W' + ch.from : 'W' + ch.from + '–' + ch.to) : '—';
        var chId = 'cases-ch-' + chKey;
        chapters.push({ key: chKey, head: head, chip: ch ? ch.chip : '—', eyebrow: eyebrow, id: chId });
        mh.push('<section class="cases-chapter fu-ch-' + attr(chKey) + '" id="' + chId + '"><div class="cases-ch-head">' +
          '<span class="cases-ch-eyebrow">' + esc(eyebrow) + '</span>' +
          '<h2 class="cases-ch-title">' + esc(head) + '</h2></div>');
        rh.push('<button type="button" class="cases-rail-ch" data-go="' + chId + '">' + esc(head) + '</button>');
        chOpen = true;
      }
      if (c._tw !== curWk) {
        if (wkOpen) { mh.push('</div></section>'); wkOpen = false; }
        curWk = c._tw;
        var gid = 'cases-g-' + chKey + '-' + (curWk == null ? 'none' : curWk);
        var wh;
        if (curWk == null) {
          wh = '<span class="cases-wk-n">—</span><span class="cases-wk-date">No Saturday</span>';
          rh.push('<button type="button" class="cases-rail-wk" data-go="' + gid + '" data-g="' + gid +
            '"><b>—</b><span>no Saturday</span><span class="cases-n"></span></button>');
        } else {
          var wd = weekDate(curWk);
          wh = '<span class="cases-wk-n">W' + curWk + '</span><span class="cases-wk-date">' + esc(wd) + '</span>';
          rh.push('<button type="button" class="cases-rail-wk" data-go="' + gid + '" data-g="' + gid +
            '"><b>W' + curWk + '</b><span>' + esc(wd.replace(/^Sat\s+/, '')) + '</span>' +
            '<span class="cases-n"></span></button>');
        }
        mh.push('<section class="cases-week' + (curWk == null ? ' is-capstone' : '') + '" id="' + gid +
          '" data-g="' + gid + '"><div class="cases-wk-head">' + wh +
          '<span class="cases-wk-count" data-c="' + gid + '"></span></div><div class="cases-cards">');
        weeks.push({ key: wkKey(c), gid: gid });
        wkOpen = true;
      }
      S.gids.push('cases-g-' + chKey + '-' + (c._tw == null ? 'none' : c._tw));
      mh.push(cardHTML(c));
    }
    if (wkOpen) mh.push('</div></section>');
    if (chOpen) mh.push('</section>');

    /* ---- chrome ---- */
    var hud = [];
    hud.push('<div class="cases-hud">');
    hud.push('<div class="cases-hud-row"><span class="cases-lab">kind</span>');
    KINDS.forEach(function (k) { hud.push(chipHTML('kind', k, k, kindCount[k] || 0)); });
    hud.push('<span class="cases-count" data-count>104 cases</span></div>');
    hud.push('<div class="cases-hud-row"><span class="cases-lab">chapter</span>');
    chapters.forEach(function (ch) {
      hud.push(chipHTML('chapter', ch.key, ch.chip, chCount[ch.key] || 0));
    });
    hud.push('</div>');
    hud.push('<div class="cases-hud-row"><span class="cases-lab">week</span>');
    weeks.forEach(function (w) {
      hud.push(chipHTML('week', w.key, w.key === 'none' ? '—' : 'W' + w.key, wkCount[w.key] || 0));
    });
    hud.push('<span class="cases-nav"><button type="button" data-jump="-1" title="previous match" disabled>↑</button>' +
      '<button type="button" data-jump="1" title="next match" disabled>↓</button>' +
      '<button type="button" data-clear title="clear filters" disabled>clear</button></span>');
    hud.push('</div></div>');

    el.innerHTML =
      '<div class="cases-root" data-tier="2">' +
      '<aside class="cases-rail" aria-label="Chapters and weeks">' +
      '<div class="cases-rail-top">' + cards.length + ' applied cases</div>' + rh.join('') + '</aside>' +
      '<div class="cases-lib">' + hud.join('') + '<div class="cases-flow">' + mh.join('') + '</div></div>' +
      '</div>';

    S.root = el.querySelector('.cases-root');
    S.els = [].slice.call(S.root.querySelectorAll('.cases-card'));
    S.sc = scroller(S.root);

    var railEl = S.root.querySelector('.cases-rail');
    for (i = 0; i < S.els.length; i++) {
      var cc = cards[i], ix = S.index[cc.id] || {};
      S.els[i]._c = cc;
      S.hay.push([
        cc.title, cc.plain_statement, cc.applied_use_summary, cc.summary,
        (cc.breakthrough && cc.breakthrough.title) || '',
        (cc.breakthrough && cc.breakthrough.authors) || '',
        (ix.aliases || []).join(' '), ix.title || '', cc.id
      ].join(' · ').toLowerCase());
    }
    var wkEls = S.root.querySelectorAll('.cases-week');
    for (i = 0; i < wkEls.length; i++) {
      var k = wkEls[i].getAttribute('data-g');
      var rail = railEl.querySelector('.cases-rail-wk[data-g="' + k + '"]');
      S.groups[k] = {
        sec: wkEls[i],
        out: wkEls[i].querySelector('[data-c]'),
        rail: rail,
        railN: rail ? rail.querySelector('.cases-n') : null
      };
    }

    /* the way back sits in the card you landed on, in flow, never over content */
    S.back = document.createElement('button');
    S.back.type = 'button';
    S.back.className = 'cases-back fu-chip';
    S.back.innerHTML = '<span class="cases-bx" aria-hidden="true">←</span><span class="cases-bt"></span>';
    S.back.addEventListener('click', function () {
      if (!S.backTo) return;
      var t = S.backTo;
      S.back.classList.remove('is-on');
      S.backTo = null;
      go(t.getAttribute('data-id'));
      APP.navigate('#cases/' + t.getAttribute('data-id'), { replace: true });
    });

    wire();
    S.built = true;
  }

  /* -------------------------------------------------------------- filter */
  function matchesFilter(i) {
    var c = S.cards[i], f = S.filter;
    if (f.kind && c.kind !== f.kind) return false;
    if (f.chapter && (c._ch || 'none') !== f.chapter) return false;
    if (f.week && wkKey(c) !== f.week) return false;
    return true;
  }

  function applyFilter() {
    var f = S.filter, any = !!(f.kind || f.chapter || f.week);
    var per = {}, shown = 0, i, g;
    S.matches = [];
    for (i = 0; i < S.els.length; i++) {
      var ok = matchesFilter(i);
      /* dim, never hide: the card keeps its box and its coordinates */
      S.els[i].classList.toggle('is-off', any && !ok);
      if (ok) {
        shown++;
        S.matches.push(i);
        per[S.gids[i]] = (per[S.gids[i]] || 0) + 1;
      }
    }
    for (g in S.groups) {
      if (!Object.prototype.hasOwnProperty.call(S.groups, g)) continue;
      var n = per[g] || 0, m = S.groups[g];
      if (m.out) m.out.textContent = n + (n === 1 ? ' case' : ' cases');
      if (m.railN) m.railN.textContent = n;
      if (m.rail) m.rail.classList.toggle('is-zero', n === 0);
    }
    var countEl = S.root.querySelector('[data-count]');
    countEl.textContent = any ? shown + ' of ' + S.els.length + ' · dimmed in place'
      : S.els.length + ' cases';
    countEl.classList.toggle('is-filtered', any);

    [].slice.call(S.root.querySelectorAll('.cases-chip')).forEach(function (b) {
      var grp = b.getAttribute('data-f'), v = b.getAttribute('data-v');
      b.setAttribute('aria-pressed', String(f[grp] === v));
    });
    S.root.querySelector('[data-clear]').disabled = !any;
    var canJump = any && S.matches.length > 0;
    S.root.querySelector('[data-jump="-1"]').disabled = !canJump;
    S.root.querySelector('[data-jump="1"]').disabled = !canJump;
    S.matchAt = -1;
  }

  function toggleFilter(group, value) {
    S.filter[group] = S.filter[group] === value ? null : value;
    applyFilter();
  }

  function jump(dir) {
    if (!S.matches.length) return;
    if (S.matchAt < 0) {
      /* start from whatever is on screen, so the jump feels local */
      var top = 0, i;
      for (i = 0; i < S.matches.length; i++) {
        var r = S.els[S.matches[i]].getBoundingClientRect();
        if (r.bottom > 0) { S.matchAt = i - (dir > 0 ? 1 : 0); break; }
      }
      if (S.matchAt < -1) S.matchAt = -1;
      void top;
    }
    S.matchAt = (S.matchAt + dir + S.matches.length) % S.matches.length;
    var el = S.els[S.matches[S.matchAt]];
    scrollToEl(el);
    hit(el);
  }

  /* ---------------------------------------------------------- navigation */
  function scrollToEl(el) {
    try { el.scrollIntoView({ block: 'start', behavior: 'auto' }); }
    catch (e) { el.scrollIntoView(); }
  }
  function hit(el) {
    if (S.lastHit) S.lastHit.classList.remove('is-hit');
    el.classList.remove('is-hit');
    void el.offsetWidth;
    el.classList.add('is-hit');
    S.lastHit = el;
    clearTimeout(S.hitTimer);
    S.hitTimer = setTimeout(function () { el.classList.remove('is-hit'); }, 2600);
  }
  /* A deep link has to out-live the shell's scroll restore: showSection()
     calls restoreScroll() *after* mount resolves, and it falls back to the
     section's last remembered scrollTop when the exact route is new. So the
     target is re-asserted on the next frame and once more past the shell's
     own 140 ms retry. Cheap, idempotent, and invisible when it is not needed. */
  function goDeep(id) {
    if (!go(id)) return false;
    var el = S.root.querySelector('.cases-card[data-id="' + String(id).replace(/"/g, '') + '"]');
    if (!el) return true;
    requestAnimationFrame(function () { scrollToEl(el); });
    setTimeout(function () { scrollToEl(el); }, 220);
    return true;
  }

  function go(id, fromEl) {
    var el = S.root && S.root.querySelector('#cases-' + (window.CSS && CSS.escape ? CSS.escape(id) : id));
    if (!el) el = S.root && S.root.querySelector('.cases-card[data-id="' + String(id).replace(/"/g, '') + '"]');
    if (!el) return false;
    if (fromEl && fromEl !== el) {
      S.backTo = fromEl;
      S.back.querySelector('.cases-bt').textContent = 'back to ' + label(fromEl.getAttribute('data-id'));
      var head = el.querySelector('.cases-c-head');
      if (head && head.nextSibling !== S.back) el.insertBefore(S.back, head.nextSibling);
      S.back.classList.add('is-on');
    }
    scrollToEl(el);
    hit(el);
    return true;
  }

  /* ------------------------------------------------------------ glossary */
  function showPop(el) {
    if (!S.pop) {
      S.pop = document.createElement('div');
      S.pop.className = 'cases-pop';
      S.pop.style.display = 'none';
      document.body.appendChild(S.pop);
    }
    if (S.popFor === el && S.pop.style.display !== 'none') { hidePop(); return; }
    S.popFor = el;
    var ex = el.getAttribute('data-e');
    S.pop.innerHTML = '<span class="cases-pt">' + esc(el.getAttribute('data-t')) + '</span>' +
      (ex ? '<span class="cases-pe">' + esc(ex) + '</span>' : '') + esc(el.getAttribute('data-g'));
    S.pop.style.display = 'block';
    S.pop.style.left = '-9999px';
    S.pop.style.top = '0px';
    var r = el.getBoundingClientRect(), pr = S.pop.getBoundingClientRect();
    var left = Math.min(Math.max(8, r.left - 8), Math.max(8, window.innerWidth - pr.width - 8));
    var top = r.bottom + 8;
    if (top + pr.height > window.innerHeight - 8) top = Math.max(8, r.top - pr.height - 8);
    S.pop.style.left = left + 'px';
    S.pop.style.top = top + 'px';
  }
  function hidePop() { if (S.pop) S.pop.style.display = 'none'; S.popFor = null; }

  /* ---------------------------------------------------------------- wire */
  function wire() {
    var root = S.root;

    root.addEventListener('click', function (e) {
      var t = e.target;

      var f = t.closest && t.closest('.cases-chip');
      if (f) { toggleFilter(f.getAttribute('data-f'), f.getAttribute('data-v')); return; }

      var j = t.closest && t.closest('[data-jump]');
      if (j) { jump(parseInt(j.getAttribute('data-jump'), 10)); return; }

      if (t.closest && t.closest('[data-clear]')) {
        S.filter = { kind: null, chapter: null, week: null };
        applyFilter();
        return;
      }

      var rail = t.closest && t.closest('[data-go]');
      if (rail && rail.classList.contains('cases-fchip')) {
        e.preventDefault();
        var gid = rail.getAttribute('data-go');
        if (go(gid, rail.closest('.cases-card'))) APP.navigate('#cases/' + gid, { replace: true });
        return;
      }
      if (rail) {
        var target = root.querySelector('#' + rail.getAttribute('data-go'));
        if (target) { e.preventDefault(); scrollToEl(target); }
        return;
      }

      var pl = t.closest && t.closest('.cases-permalink');
      if (pl) {
        e.preventDefault();
        APP.navigate(pl.getAttribute('href'));
        return;
      }

      var gl = t.closest && t.closest('.cases-g');
      if (gl) { e.preventDefault(); showPop(gl); }
    });

    root.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var ch = e.target.closest && e.target.closest('.cases-fchip');
      if (!ch) return;
      e.preventDefault();
      var id = ch.getAttribute('data-go');
      if (go(id, ch.closest('.cases-card'))) APP.navigate('#cases/' + id, { replace: true });
    });

    root.addEventListener('mouseover', function (e) {
      var t = e.target.closest && e.target.closest('.cases-g');
      if (t && t !== S.popFor) showPop(t);
    });
    root.addEventListener('mouseout', function (e) {
      var t = e.target.closest && e.target.closest('.cases-g');
      if (t && t === S.popFor && !(S.pop && e.relatedTarget && S.pop.contains(e.relatedTarget))) hidePop();
    });
    root.addEventListener('focusin', function (e) {
      var t = e.target.closest && e.target.closest('.cases-g');
      if (t) showPop(t);
    });
    (S.sc === window ? window : S.sc).addEventListener('scroll', function () {
      if (S.popFor) hidePop();
    }, { passive: true });
    window.addEventListener('resize', hidePop, { passive: true });

    S.keyHandler = function (e) {
      if (!S.root || !S.root.isConnected || S.root.offsetParent === null) return;
      if (e.key === 'Escape') { hidePop(); return; }
      if (isField(document.activeElement) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'n') { e.preventDefault(); jump(1); }
      else if (e.key === 'p') { e.preventDefault(); jump(-1); }
    };
    document.addEventListener('keydown', S.keyHandler);
  }

  /* ---------------------------------------------------------------- tier */
  function anchored(fn) {
    var keep = null, top = 0, j;
    for (j = 0; j < S.els.length; j++) {
      var r = S.els[j].getBoundingClientRect();
      if (r.bottom > 0) { keep = S.els[j]; top = r.top; break; }
    }
    fn();
    if (keep) {
      var d = keep.getBoundingClientRect().top - top;
      if (d) scrollBy(S.sc, d);
    }
  }
  function paintTier(n) {
    if (!S.root) return;
    n = (n === 1 || n === 2 || n === 3) ? n : 2;
    if (S.root.getAttribute('data-tier') === String(n)) return;
    hidePop();
    /* The slot already reserves the tallest tier's height, so this cannot
       move anything. anchored() is belt-and-braces for sub-pixel drift. */
    anchored(function () {
      S.root.setAttribute('data-tier', String(n));
      [].slice.call(S.root.querySelectorAll('.cases-tier')).forEach(function (t) {
        t.setAttribute('aria-hidden', String(t.getAttribute('data-t') !== String(n)));
      });
    });
  }

  /* --------------------------------------------------------------- route */
  function idFromRoute(route) {
    var raw = (route && (route.raw || route.hash)) || '';
    raw = String(raw).replace(/^#/, '');
    if (route && route.params && route.params.id) return route.params.id;
    var m = /^cases\/(.+)$/.exec(raw);
    if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
    return null;
  }

  /* -------------------------------------------------- bare-hash resolving
   * SPEC §7 asks a bare `#<case-id>` to redirect to `#cases/<id>`. The shell
   * owns normalizeHash() but cannot know the 104 stems, so the roster is
   * published on APP for it (APP.casesHasId) and, if the shell has not been
   * taught the rule, this section self-heals the route. concepts-index is
   * ~6 KB encoded, so it is fetched eagerly rather than on first mount.
   */
  var rosterReady = null;
  function roster() {
    if (rosterReady) return rosterReady;
    rosterReady = APP.payloadJSON('concepts-index').then(function (ix) {
      (((ix || {}).concepts) || []).forEach(function (row) {
        if (!S.index[row.id]) S.index[row.id] = row;
      });
      return S.index;
    }).catch(function () {
      rosterReady = null;          /* do not cache a failure */
      return S.index;
    });
    return rosterReady;
  }
  APP.casesHasId = function (id) { return !!(id && S.index[id]); };

  /* the payload tags may be emitted after this script; wait for the document */
  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else setTimeout(fn, 0);
  }
  whenReady(function () { roster().then(function () {
    if (typeof APP.onRoute !== 'function') return;
    /* a card-to-card hop while cases is already mounted needs no re-mount */
    APP.onRoute(function (r) {
      if (!r || r.section !== 'cases' || !S.built) return;
      var id = idFromRoute(r);
      if (id) goDeep(id);
    });
  }); });

  /* --------------------------------------------------------------- mount */
  var loading = null;
  function load() {
    if (loading) return loading;
    loading = Promise.all([APP.payloadJSON('cases'), roster()])
      .then(function (r) {
        var list = (r[0] || []).map(function (c, i) {
          c._tw = taraWeek(c.arena_section);
          var ch = chOfWeek(c._tw);
          c._ch = ch ? ch.key : null;
          c._i = i;
          return c;
        });
        /* TARA's week order, set once; filters only dim, so nothing moves after this */
        list.sort(function (a, b) {
          var wa = a._tw == null ? 99 : a._tw, wb = b._tw == null ? 99 : b._tw;
          return wa - wb || a._i - b._i;
        });
        S.cards = list;
      })
      .catch(function (e) {
        loading = null;            /* a failure (offline, say) is not kept: Try again loads afresh */
        throw e;
      });
    return loading;
  }

  APP.registerSection({
    id: 'cases',
    title: 'Cases',
    navOrder: 60,

    mount: function (el, route) {
      var self = this;
      return load().then(function () {
        if (!S.built) build(el);
        else if (!el.contains(S.root)) el.appendChild(S.root);
        paintTier(APP.tier());
        if (!S.matches.length && !S.filter.kind && !S.filter.chapter && !S.filter.week) applyFilter();
        var id = idFromRoute(route || APP.route());
        if (id) goDeep(id);
        void self;
      });
    },

    unmount: function () {
      hidePop();
      if (S.back) S.back.classList.remove('is-on');
      S.backTo = null;
    },

    onTier: function (n) { paintTier(n); },

    /* SPEC §7: a bare `#<token>` that is a case-card stem becomes #cases/<id>.
       The shell asks each section in navOrder; only Cases owns these stems. */
    resolveToken: function (tok) {
      return roster().then(function (index) {
        return index[tok] ? 'cases/' + tok : null;
      });
    },

    /* SPEC §8: title / summary / plain_statement / id, hash #cases/<id> */
    search: function (q) {
      return load().then(function () {
        var raw = String(q || '').trim().toLowerCase();
        if (!raw) return [];
        var toks = raw.split(/\s+/), out = [];
        for (var i = 0; i < S.cards.length; i++) {
          var c = S.cards[i];
          var hay = S.hay[i] || [
            c.title, c.plain_statement, c.applied_use_summary, c.summary, c.id
          ].join(' · ').toLowerCase();
          var ok = true, k;
          for (k = 0; k < toks.length; k++) { if (hay.indexOf(toks[k]) < 0) { ok = false; break; } }
          if (!ok) continue;
          /* SPEC §8 weights live in the shell so every section ranks alike.
             The concept's human label and the applied-use headline are both
             legitimate titles here, so score against each and keep the best. */
          var human = (S.index[c.id] || {}).title || '';
          var body = [c.plain_statement, c.applied_use_summary, c.summary].join(' ');
          var score = Math.max(
            score1(raw, { id: c.id, title: c.title, body: body }),
            score1(raw, { id: c.id, title: human, body: body })
          );
          if (!score) score = 15;
          out.push({
            title: c.title,
            sub: (S.index[c.id] || {}).title || c.id,
            hash: '#cases/' + c.id,
            score: score
          });
        }
        out.sort(function (a, b) { return b.score - a.score || a.title.localeCompare(b.title); });
        return out.slice(0, 8);
      });
    }
  });
})();
