/* IFilm: tiny paper-collage film engine for TARA intuition films.
   No assets, no external scripts. Declare a film with IFilm.play({...}). */
(function () {
  'use strict';

  /* ------------------------------------------------------------ maths */
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  var ease = {
    inOut: function (t) { t = clamp(t, 0, 1); return t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; },
    out: function (t) { t = clamp(t, 0, 1); return 1 - Math.pow(1 - t, 3); },
    in: function (t) { t = clamp(t, 0, 1); return t * t * t; },
    back: function (t) { t = clamp(t, 0, 1); var c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }
  };
  // smooth ramp: 0 before a, 1 after b
  var ramp = function (x, a, b) { return ease.inOut((x - a) / (b - a)); };
  function rng(seed) {
    var s = (typeof seed === 'string') ? hashStr(seed) : (seed >>> 0) || 1;
    return function () {
      s |= 0; s = s + 0x6D2B79F5 | 0;
      var t = Math.imul(s ^ s >>> 15, 1 | s);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function hashStr(str) { var h = 2166136261; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  var P = {
    night: '#1c2140', night2: '#2b3163', dusk: '#454a86', paper: '#f7f0e1', cream: '#fbf6ea',
    pink: '#f3b3c3', peach: '#f8c8a0', orange: '#f2995a', butter: '#f7e3a0', mint: '#b9e3cc',
    green: '#7db58a', sky: '#a9c9ef', lav: '#c8b8ea', ink: '#2a2934', chalk: '#fdfaf0', red: '#e8747c', teal: '#7cc6c0'
  };
  var HAND = "'Comic Neue','Segoe Print','Bradley Hand','Chalkboard SE','Comic Sans MS',cursive";
  var MONO = "ui-monospace,'SF Mono',Menlo,Consolas,monospace";

  /* ------------------------------------------------------------ paper */
  var grainPat = null;
  function grain(ctx) {
    if (grainPat) return grainPat;
    var c = document.createElement('canvas'); c.width = c.height = 192;
    var g = c.getContext('2d'), id = g.createImageData(192, 192), r = rng(7);
    for (var i = 0; i < id.data.length; i += 4) {
      var v = 128 + (r() - .5) * 90 + (r() < .02 ? -60 : 0);
      id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 40;
    }
    g.putImageData(id, 0, 0);
    // fibres
    g.strokeStyle = 'rgba(90,70,50,.10)'; g.lineWidth = .6;
    for (var k = 0; k < 40; k++) { var x = r() * 192, y = r() * 192, a = r() * 6.28; g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + 6 * Math.cos(a + 1), y + 6 * Math.sin(a + 1), x + 12 * Math.cos(a), y + 12 * Math.sin(a)); g.stroke(); }
    grainPat = ctx.createPattern(c, 'repeat');
    return grainPat;
  }
  var tornCache = {};
  // torn outline for a w x h rect centred at 0,0 (cached per seed/size)
  function tornRect(seed, w, h, jit) {
    jit = jit == null ? 1 : jit;
    var key = seed + '|' + Math.round(w) + '|' + Math.round(h) + '|' + jit;
    if (tornCache[key]) return tornCache[key];
    var r = rng(seed + 'r'), pts = [], step = 7, amp = 2.2 * jit;
    var corners = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
    for (var e = 0; e < 4; e++) {
      var a = corners[e], b = corners[(e + 1) % 4], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      var n = Math.max(2, Math.round(len / step)), nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
      for (var i = 0; i < n; i++) {
        var t = i / n, d = (r() - .5) * amp * 2 + (r() < .08 ? -amp * 1.4 : 0);
        pts.push([lerp(a[0], b[0], t) + nx * d, lerp(a[1], b[1], t) + ny * d]);
      }
    }
    tornCache[key] = pts; return pts;
  }
  function tornCircle(seed, r0, jit) {
    var key = 'c' + seed + '|' + Math.round(r0) + '|' + jit;
    if (tornCache[key]) return tornCache[key];
    var r = rng(seed + 'c'), n = Math.max(14, Math.round(r0 * 6.28 / 6)), pts = [];
    for (var i = 0; i < n; i++) { var a = i / n * 6.2832, rr = r0 + (r() - .5) * 2.4 * (jit == null ? 1 : jit); pts.push([Math.cos(a) * rr, Math.sin(a) * rr]); }
    tornCache[key] = pts; return pts;
  }
  function pathPts(ctx, pts) { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath(); }
  function fillPaper(ctx, pts, color, o) {
    o = o || {};
    if (o.shadow !== false) {
      ctx.save(); ctx.shadowColor = 'rgba(8,10,30,' + (o.shadowA || .35) + ')'; ctx.shadowBlur = o.blur || 8; ctx.shadowOffsetX = 2; ctx.shadowOffsetY = o.lift || 4;
      pathPts(ctx, pts); ctx.fillStyle = color; ctx.fill(); ctx.restore();
    } else { pathPts(ctx, pts); ctx.fillStyle = color; ctx.fill(); }
    ctx.save(); pathPts(ctx, pts); ctx.clip(); ctx.fillStyle = grain(ctx); ctx.globalAlpha = o.grainA || .55; ctx.fill();
    // lighter torn fibre rim
    ctx.globalAlpha = 1; ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1.4; pathPts(ctx, pts); ctx.stroke(); ctx.restore();
  }
  // paper rectangle centred at (x,y)
  function paper(ctx, x, y, w, h, color, o) {
    o = o || {}; ctx.save(); ctx.translate(x, y); if (o.rot) ctx.rotate(o.rot);
    fillPaper(ctx, tornRect(o.seed || 's', w, h, o.jit), color, o); ctx.restore();
  }
  function blob(ctx, x, y, r, color, o) {
    o = o || {}; ctx.save(); ctx.translate(x, y); if (o.rot) ctx.rotate(o.rot);
    fillPaper(ctx, tornCircle(o.seed || 'b', r, o.jit), color, o); ctx.restore();
  }
  function tape(ctx, x, y, w, rot) { paper(ctx, x, y, w, w * .32, 'rgba(250,240,200,.75)', { rot: rot || -.3, seed: 'tape' + Math.round(w), shadow: false, grainA: .3 }); }

  /* ------------------------------------------------------------ lettering */
  // hand-lettered text: per-letter seeded rotation and bob
  function hand(ctx, text, x, y, size, color, o) {
    o = o || {}; var r = rng((o.seed || 'h') + text), font = (o.bold === false ? '' : '700 ') + size + 'px ' + (o.font || HAND);
    ctx.save(); ctx.font = font; ctx.fillStyle = color; ctx.textBaseline = 'middle';
    var ws = [], total = 0, sp = o.spacing || 0;
    for (var i = 0; i < text.length; i++) { var w = ctx.measureText(text[i]).width + sp; ws.push(w); total += w; }
    var reveal = o.reveal == null ? 1 : o.reveal, n = Math.floor(text.length * reveal + 1e-6);
    var cx = o.align === 'left' ? x : o.align === 'right' ? x - total : x - total / 2;
    if (o.rot) { ctx.translate(x, y); ctx.rotate(o.rot); ctx.translate(-x, -y); }
    for (i = 0; i < n; i++) {
      var a = (r() - .5) * .12 * (o.wobble == null ? 1 : o.wobble), dy = (r() - .5) * size * .08;
      ctx.save(); ctx.translate(cx + ws[i] / 2, y + dy); ctx.rotate(a);
      if (o.outline) { ctx.lineWidth = o.outline; ctx.strokeStyle = o.outlineColor || 'rgba(0,0,0,.35)'; ctx.lineJoin = 'round'; ctx.strokeText(text[i], -ws[i] / 2 + sp / 2, 0); }
      ctx.fillText(text[i], -ws[i] / 2 + sp / 2, 0); ctx.restore(); cx += ws[i];
    }
    ctx.restore(); return total;
  }
  function textW(ctx, text, size, font) { ctx.save(); ctx.font = '700 ' + size + 'px ' + (font || HAND); var w = ctx.measureText(text).width; ctx.restore(); return w; }
  // a note on paper with lettering, auto-sized
  function note(ctx, text, x, y, size, o) {
    o = o || {}; var lines = text.split('\n'), w = 0;
    for (var i = 0; i < lines.length; i++) w = Math.max(w, textW(ctx, lines[i], size, o.font));
    var pw = w + size * 1.4, ph = lines.length * size * 1.3 + size * .9;
    paper(ctx, x, y, pw, ph, o.color || P.butter, { rot: o.rot || 0, seed: o.seed || text });
    ctx.save(); ctx.translate(x, y); ctx.rotate(o.rot || 0);
    for (i = 0; i < lines.length; i++) hand(ctx, lines[i], 0, (i - (lines.length - 1) / 2) * size * 1.3, size, o.ink || P.ink, { seed: o.seed, reveal: o.reveal, font: o.font, bold: o.font !== MONO });
    ctx.restore();
    if (o.tape !== false) tape(ctx, x - pw * .3, y - ph / 2, Math.min(40, pw * .3), -.4);
    return { w: pw, h: ph };
  }

  /* ------------------------------------------------------------ motifs */
  function sky(ctx, W, H, top, bot) {
    var g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, top || P.night); g.addColorStop(1, bot || P.dusk);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  function stars(ctx, W, H, t, seed, n) {
    var r = rng(seed || 'stars'); n = n || Math.round(W * H / 9000);
    ctx.save();
    for (var i = 0; i < n; i++) {
      var x = r() * W, y = r() * H, s = .6 + r() * 1.6, ph = r() * 6.28, tw = .55 + .45 * Math.sin(t * (1 + r() * 2) + ph);
      ctx.globalAlpha = tw; ctx.fillStyle = r() < .2 ? P.butter : P.chalk;
      if (s > 1.8) { ctx.beginPath(); for (var k = 0; k < 8; k++) { var rr = k % 2 ? s * .7 : s * 2.4, a = k / 8 * 6.283; ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } ctx.fill(); }
      else { ctx.fillRect(x, y, s, s); }
    }
    ctx.restore();
  }
  function moon(ctx, x, y, r) {
    ctx.save(); ctx.shadowColor = 'rgba(255,240,190,.6)'; ctx.shadowBlur = r;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.arc(x + r * .45, y - r * .2, r * .85, 0, 6.283, true); ctx.fillStyle = P.butter; ctx.fill('evenodd'); ctx.restore();
  }
  function glow(ctx, x, y, r, color, a) {
    var g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, color); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save(); ctx.globalAlpha = a == null ? 1 : a; ctx.fillStyle = g; ctx.fillRect(x - r, y - r, 2 * r, 2 * r); ctx.restore();
  }
  function lantern(ctx, x, y, s, lit, t) {
    lit = lit == null ? 1 : lit; t = t || 0;
    glow(ctx, x, y, s * 3.2, 'rgba(255,214,120,.55)', lit * (.8 + .2 * Math.sin(t * 5)));
    ctx.save(); ctx.strokeStyle = P.ink; ctx.lineWidth = Math.max(1, s * .08);
    ctx.beginPath(); ctx.moveTo(x, y - s * 1.1); ctx.lineTo(x, y - s * .7); ctx.stroke(); ctx.restore();
    ctx.save(); ctx.translate(x, y); ctx.scale(1, 1.15);
    fillPaper(ctx, tornCircle('lan', s * .7, .6), lit > .5 ? '#ffd27a' : P.peach, { blur: 4, lift: 2 });
    ctx.restore();
    ctx.save(); ctx.strokeStyle = 'rgba(150,80,40,.5)'; ctx.lineWidth = 1;
    for (var k = -1; k <= 1; k++) { ctx.beginPath(); ctx.ellipse(x, y, s * .7 * Math.abs(k * .5 + (k ? 0 : .02)), s * .78, 0, 0, 6.283); ctx.stroke(); }
    ctx.fillStyle = P.orange; ctx.fillRect(x - s * .35, y - s * .9, s * .7, s * .18); ctx.fillRect(x - s * .35, y + s * .72, s * .7, s * .18);
    ctx.restore();
  }
  /* ------------------------------------------------------------ stick figure
     IFilm.stick(ctx, x, y, s, t, o): an expressive ink stick figure (feet at y, s = height px).
     Personality lives in posture + timing: anticipation, damped-spring overshoot,
     follow-through (arms and head lag the torso), squash/stretch, arcs.
     o: pose ('walk' or {a:'walk', b:'point', k:.4}), t0 (pose start time: plays anticipation
     and overshoot from o.from, default 'idle'), color, face (1|-1), look {x,y}, walk (walking
     legs under any pose), hold(ctx,hx,hy,s,ang), lantern, lit, scarf (accent colour), squash. */
  var SK = { th: .235, sh: .235, ua: .165, fa: .16, torso: .30, hr: .118 };
  var SCH = ['lean', 'hx', 'lift', 'sq', 'hd', 'nT', 'nK', 'fT', 'fK', 'nS', 'nE', 'fS', 'fE', 'sh'];
  var SNC = SCH.length, SCI = {}; SCH.forEach(function (c, i) { SCI[c] = i; });
  // follow-through: arms and head start a beat after the torso and ring a little longer
  var DELAY = [0, 0, 0, 0, .05, 0, .02, 0, .02, .05, .09, .06, .1, .02];
  var ZETA = [.42, .45, .5, .4, .34, .45, .42, .45, .42, .33, .3, .33, .3, .4];
  var IDLE = { lean: .04, hx: 0, lift: 0, sq: 0, hd: .05, nT: .15, nK: -.08, fT: -.15, fK: -.04, nS: .2, nE: .2, fS: -.22, fE: .1, sh: 0 };
  function pv(p) { var v = new Array(SNC); for (var i = 0; i < SNC; i++) { var c = SCH[i]; v[i] = p && p[c] != null ? p[c] : IDLE[c]; } return v; }
  function spring(t, t0, freq, damp) {
    var u = t - (t0 || 0); if (u <= 0) return 0;
    var w = 6.2832 * (freq || 2.2), z = Math.min(.95, damp == null ? .38 : damp), wd = w * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w * u) * (Math.cos(wd * u) + z * w / wd * Math.sin(wd * u));
  }
  // 0 before t0; dips to -depth (wind-up) over dur, then springs past 1 and settles at 1
  function anticip(t, t0, dur, depth, freq, damp) {
    dur = dur || .25; depth = depth == null ? .15 : depth; var u = t - (t0 || 0);
    if (u <= 0) return 0;
    if (u < dur) return -depth * ease.inOut(u / dur);
    return -depth + (1 + depth) * spring(t, (t0 || 0) + dur, freq || 2.4, damp);
  }
  // spring whose first crossing of 1 lands at duration d
  function springD(u, d, z) {
    if (u <= 0) return 0; var q = Math.sqrt(1 - z * z), w = (Math.PI - Math.atan(q / z)) / q / d, wd = w * q;
    return 1 - Math.exp(-z * w * u) * (Math.cos(wd * u) + z * w / wd * Math.sin(wd * u));
  }
  function segE(kind, u, d, z) {
    if (u <= 0) return 0;
    if (kind === 'spring') return springD(u, d, z);
    var x = clamp(u / d, 0, 1);
    return kind === 'in' ? x * x : kind === 'out' ? 1 - (1 - x) * (1 - x) : kind === 'lin' ? x : kind === 'snap' ? 1 : ease.inOut(x);
  }
  var TAU = 6.2832, pos0 = function (v) { return v > 0 ? v : 0; };
  function walkLegs(t, v, w, amp) {
    var ph = t * TAU * .95, s1 = Math.sin(ph), c1 = Math.cos(ph); amp = amp || 1;
    v[5] += w * .42 * amp * s1; v[7] -= w * .42 * amp * s1;
    v[6] += w * (-.9 * amp * Math.pow(pos0(c1), 2)); v[8] += w * (-.9 * amp * Math.pow(pos0(-c1), 2));
    return ph;
  }
  function simple(antic, hit, ad, hd, extra) {
    var k = []; if (antic) k.push([ad || .2, antic, 'io']); k.push([(antic ? ad || .2 : 0) + (hd || .45), hit, 'spring']);
    var d = { keys: k }; for (var e in extra || {}) d[e] = extra[e]; return d;
  }
  function crouch(extra) { var c = { lean: .45, nT: 1.05, nK: -1.95, fT: .9, fK: -1.85, nS: -.9, nE: .35, fS: -.75, fE: .3, hd: -.15, sq: .12 }; for (var e in extra || {}) c[e] = extra[e]; return c; }
  var POSES = {
    idle: { keys: [[.4, {}, 'spring']], cyc: function (t, v, w) { var b = Math.sin(t * 2.3); v[0] += .016 * b * w; v[9] += .035 * b * w; v[11] -= .035 * b * w; v[4] += .03 * Math.sin(t * 1.1 + 1) * w; v[13] += .006 * b * w; } },
    walk: { keys: [[.3, { lean: .1, hd: .02, nT: 0, fT: 0, nK: -.1, fK: -.1, nS: .05, fS: .05, nE: .35, fE: .35 }, 'spring']], legs: 1,
      cyc: function (t, v, w) { var ph = walkLegs(t, v, w), sa = Math.sin(ph - .35); v[9] -= w * .5 * sa; v[11] += w * .5 * sa; v[10] += w * .3 * pos0(-sa); v[12] += w * .3 * pos0(sa); v[4] += w * .03 * Math.sin(2 * ph - .5); } },
    run: { keys: [[.3, { lean: .32, hd: -.18, nT: .2, fT: .2, nK: -.5, fK: -.5, nS: .3, fS: .3, nE: 1.5, fE: 1.5 }, 'spring']], legs: 1,
      cyc: function (t, v, w) {
        var ph = t * TAU * 1.45, s1 = Math.sin(ph), c1 = Math.cos(ph), sa = Math.sin(ph - .3);
        v[5] += w * .8 * s1; v[7] -= w * .8 * s1; v[6] -= w * 1.5 * Math.pow(pos0(c1), 1.5); v[8] -= w * 1.5 * Math.pow(pos0(-c1), 1.5);
        v[9] -= w * .95 * sa; v[11] += w * .95 * sa; v[2] += w * .05 * pos0(Math.sin(2 * ph - .6)); v[4] += w * .05 * Math.sin(2 * ph - 1);
      } },
    jump: { loop: 2.2, keys: [
      [.28, crouch(), 'io'],
      [.42, { lean: .05, nT: .05, nK: -.05, fT: -.12, fK: -.05, nS: 2.8, nE: .15, fS: 2.6, fE: .2, sq: -.22, lift: .12, hd: -.25 }, 'out'],
      [.7, { lean: .15, lift: .55, nT: .95, nK: -1.6, fT: .65, fK: -1.35, nS: 2.3, nE: .6, fS: 2.0, fE: .6, sq: 0, hd: .1 }, 'out'],
      [.96, { lean: .1, lift: .02, nT: .35, nK: -.2, fT: .1, fK: -.15, nS: 1.8, nE: .4, fS: 1.6, fE: .4, sq: -.1, hd: 0 }, 'in'],
      [1.06, crouch({ lean: .35, sq: .38, nS: 1.0, fS: .8, nE: .5, fE: .5, hd: .1, nT: .95, nK: -1.7, fT: .75, fK: -1.55 }), 'out'],
      [1.5, {}, 'spring']] },
    land: { loop: 1.8, start: { lift: .6, nT: .45, nK: -.7, fT: .2, fK: -.5, nS: 2.1, nE: .4, fS: 1.9, fE: .4, sq: -.1, lean: .1 }, keys: [
      [.26, { lift: .02, nT: .35, nK: -.2, fT: .1, fK: -.15, nS: 1.8, nE: .4, fS: 1.6, fE: .4, sq: -.12 }, 'in'],
      [.36, crouch({ lean: .35, sq: .4, nS: 1.0, fS: .8, nE: .5, fE: .5, hd: .15, nT: 1.0, nK: -1.8, fT: .8, fK: -1.6 }), 'out'],
      [.85, {}, 'spring']] },
    point: simple({ lean: -.08, nS: -.5, nE: 1.2, hd: -.12, sq: .05 }, { lean: .08, hd: .12, nS: 1.5, nE: .03, fS: -.25, fE: .45, nT: .2, fT: -.22 }, .18, .4, { aim: 1, busy: 1,
      cyc: function (t, v, w) { v[0] += .012 * Math.sin(t * 2.3) * w; v[9] += .02 * Math.sin(t * 2.3) * w; } }),
    reach: simple({ lean: -.06, nS: .3, nE: 1.3, fS: .2, fE: 1.2, sq: .08 }, { lean: .38, hd: .15, nS: 1.45, nE: 0, fS: 1.2, fE: .12, nT: -.02, nK: -.05, fT: -.55, fK: -.1 }, .2, .5, { aim: 1, busy: 1,
      cyc: function (t, v, w) { v[9] += .05 * Math.sin(t * 5) * w; v[0] += .02 * Math.sin(t * 2.5) * w; } }),
    think: simple({ hd: -.1, nS: .2, nE: .6 }, { lean: -.03, hd: .3, nS: .52, nE: 2.45, fS: .08, fE: 1.45, nT: .1, fT: -.1 }, .15, .5, { busy: 1,
      cyc: function (t, v, w) { v[4] += .06 * Math.sin(t * 1.3) * w; v[10] += .06 * pos0(Math.sin(t * 7)) * w * (Math.sin(t * .9) > 0 ? 1 : 0); } }),
    shrug: simple({ sq: .1, sh: -.01, nS: .1, fS: -.1, nE: .3, fE: -.3 }, { lean: -.05, hd: -.14, sq: -.05, sh: .045, nS: .78, nE: 1.25, fS: -.78, fE: -1.25 }, .15, .35),
    cheer: simple(crouch({ lean: .15, nT: .5, nK: -.9, fT: .35, fK: -.8, nS: .3, fS: -.3, nE: .8, fE: -.8, sq: .12 }), { lean: -.05, hd: -.2, nS: 2.3, nE: -.3, fS: -2.3, fE: .3 }, .2, .35, {
      cyc: function (t, v, w) { var b = Math.sin(t * 8); v[9] += .18 * b * w; v[11] -= .18 * b * w; v[2] += .05 * pos0(b) * w; v[3] += .12 * pos0(-b) * w; } }),
    recoil: simple({ sq: .12, hd: .05 }, { lean: -.36, hd: -.32, hx: -.06, nS: .9, nE: 1.35, fS: .72, fE: 1.4, nT: .5, nK: -.25, fT: -.3, fK: -.05, sq: -.08 }, .07, .3, {
      cyc: function (t, v, w) { v[4] += .015 * Math.sin(t * 23) * w; } }),
    'lean-in': simple({ lean: -.08, sq: .06, hd: -.05 }, { lean: .42, hd: .3, hx: .03, nS: -.35, nE: -.9, fS: -.5, fE: -.8, nT: .05, fT: -.38 }, .2, .5, {
      cyc: function (t, v, w) { v[4] += .05 * Math.sin(t * 1.7) * w; v[0] += .02 * Math.sin(t * 1.7 - .5) * w; } }),
    push: simple({ lean: -.1, nS: .4, nE: 1.9, fS: .35, fE: 1.95, sq: .1 }, { lean: .48, hd: -.12, nS: 1.45, nE: .15, fS: 1.35, fE: .2, nT: .32, nK: -.5, fT: -.62, fK: -.05 }, .22, .35, { busy: 1,
      cyc: function (t, v, w) { var e = Math.sin(t * 3.2); v[0] += .03 * e * w; v[5] += .03 * e * w; } }),
    pull: simple({ lean: .25, nS: 1.4, nE: .1, fS: 1.35, fE: .1, sq: .05 }, { lean: -.42, hd: .06, hx: -.02, nS: 1.4, nE: .25, fS: 1.32, fE: .3, nT: .58, nK: -.35, fT: -.05, fK: -.45 }, .2, .4, { busy: 1,
      cyc: function (t, v, w) { var e = pos0(Math.sin(t * 4)); v[0] -= .05 * e * w; v[9] += .04 * e * w; v[11] += .04 * e * w; } }),
    carry: simple({ sq: .1, lean: .15 }, { lean: -.08, hd: .05, nS: .45, nE: 1.15, fS: .4, fE: 1.2, nT: .1, fT: -.1 }, .15, .4, { busy: 1,
      cyc: function (t, v, w) { v[0] += .012 * Math.sin(t * 2.3) * w; } }),
    sit: simple({ lean: .35, nT: .6, nK: -.8, fT: .5, fK: -.7, nS: .5, fS: .45 }, { lean: .02, hd: .05, nT: 1.5, nK: -1.5, fT: 1.38, fK: -1.33, nS: .6, nE: .5, fS: .5, fE: .55 }, .3, .4, {
      cyc: function (t, v, w) { v[0] += .015 * Math.sin(t * 2.1) * w; } }),
    type: simple(null, { lean: .15, hd: .15, nT: 1.5, nK: -1.5, fT: 1.38, fK: -1.33, nS: 1.0, nE: .5, fS: .95, fE: .55 }, 0, .45, { busy: 1,
      cyc: function (t, v, w) { v[10] += .14 * pos0(Math.sin(t * 17)) * w; v[12] += .14 * pos0(Math.sin(t * 17 + 3.1)) * w; v[4] += .03 * Math.sin(t * 2.3) * w; } }),
    write: simple({ nS: .6, nE: .9 }, { lean: .1, hd: .22, nS: 1.7, nE: .3, fS: .2, fE: .6, nT: .1, fT: -.15 }, .15, .4, { busy: 1,
      cyc: function (t, v, w) { var p = t * 8; v[9] += .07 * Math.sin(p) * w; v[10] += .12 * Math.sin(p + 1.3) * w; v[4] += .03 * Math.sin(p * .25) * w; } }),
    wave: simple({ nS: .6, nE: 1.1, sq: .04 }, { lean: -.04, hd: .06, nS: 1.75, nE: .9, fS: -.15, fE: .25 }, .15, .35, { busy: 1,
      cyc: function (t, v, w) { v[10] += .45 * Math.sin(t * 10) * w; v[9] += .06 * Math.sin(t * 10 - .6) * w; v[0] += .03 * Math.sin(t * 5) * w; } }),
    fall: { loop: 2.6, keys: [
      [.15, { lean: .12, nT: 1.0, nK: -.3, fT: -.35, nS: 1.8, nE: .3, fS: -1.5, fE: -.3, lift: .04, sq: -.12, hd: -.3 }, 'out'],
      [.45, { lean: -1.15, nT: 1.95, nK: -.3, fT: 1.55, fK: -.6, nS: 2.4, nE: .3, fS: 2.0, fE: .4, lift: .12, hd: -.3 }, 'io'],
      [.6, { lean: -1.52, nT: 1.75, nK: -.5, fT: 1.35, fK: -.9, nS: -1.9, nE: -.3, fS: -2.3, fE: .3, lift: 0, sq: .28, hd: -.1 }, 'in'],
      [1.1, { lean: -1.5, nT: 1.5, nK: -.15, fT: 1.36, fK: -.5, nS: -1.85, nE: -.25, fS: -2.3, fE: .3, sq: 0, hd: -.05 }, 'spring']],
      cyc: function (t, v, w) { v[4] += .05 * Math.sin(t * 3) * w; } },
    celebrate: { keys: [[.35, { lean: -.02, hd: -.15, nS: 2.0, nE: .95, fS: -2.0, fE: .35 }, 'spring']],
      cyc: function (t, v, w) {
        var ph = t * TAU * 1.1, a = pos0(Math.sin(ph)), g = pos0(-Math.sin(ph));
        v[2] += .13 * a * w; v[3] += (.22 * Math.pow(g, 3) - .08 * a) * w; v[5] += .45 * a * w; v[6] -= .8 * a * w; v[7] += .25 * a * w; v[8] -= .8 * a * w;
        v[9] += .22 * Math.sin(ph * 2) * w; v[10] += .25 * Math.sin(ph * 2 + .6) * w; v[11] -= .15 * Math.sin(ph * 2 + .3) * w; v[4] += .08 * Math.sin(ph - .6) * w;
      } },
    slump: simple({ sq: -.04, hd: -.1 }, { lean: .35, hd: .5, sq: .07, sh: -.02, nT: .2, nK: -.35, fT: -.05, fK: -.28, nS: .06, nE: .1, fS: -.02, fE: .1 }, .25, .9, {
      cyc: function (t, v, w) { var b = Math.sin(t * 1.3); v[0] += .03 * b * w; v[4] += .05 * Math.sin(t * 1.3 - .6) * w; v[9] += .03 * Math.sin(t * 1.3 - .9) * w; } }),
    dance: { keys: [[.3, { lean: 0, hd: 0, nS: 1.4, nE: .6, fS: -1.0, fE: -.4, nT: .1, fT: -.1 }, 'spring']],
      cyc: function (t, v, w) {
        var ph = t * TAU * 1.0, s = Math.sin(ph), s2 = Math.abs(Math.sin(ph));
        v[1] += .05 * s * w; v[0] += .14 * s * w; v[4] += .15 * Math.sin(ph - .5) * w;
        v[9] += 1.0 * s * w; v[10] -= .45 * s * w; v[11] += .7 * Math.cos(ph) * w; v[12] += .4 * Math.sin(ph + 1) * w;
        v[5] += .3 * s * w; v[6] -= .35 * pos0(s) * w; v[7] -= .25 * s * w; v[8] -= .35 * pos0(-s) * w; v[3] += .07 * (1 - s2) * w;
      } }
  };
  var POSE_NAMES = Object.keys(POSES);
  function poseEnd(d) { return d.keys[d.keys.length - 1][0]; }
  // full channel vector for one pose at time t
  function poseVec(name, t, o, look) {
    var d = POSES[name] || POSES.idle, lt, S;
    if (d.start) S = pv(d.start);
    else if (o.from && o.from !== name && POSES[o.from]) S = poseVec(o.from, t, {}, null);
    else S = pv(IDLE);
    if (o.t0 != null) lt = t - o.t0; else lt = d.loop ? ((t % d.loop) + d.loop) % d.loop : 1e3;
    var ks = d.keys, K = [S], i, c;
    for (i = 0; i < ks.length; i++) K.push(pv(ks[i][1]));
    if (d.aim && look) K[K.length - 1][9] = clamp(Math.atan2(look.x - .03, (SK.th + SK.sh + SK.torso - .035) - look.y), -.3, 3.0);
    var v = new Array(SNC);
    for (c = 0; c < SNC; c++) {
      var u = lt - DELAY[c], val = K[0][c], prevT = 0;
      for (i = 0; i < ks.length; i++) {
        var dT = Math.max(.01, ks[i][0] - prevT);
        val += (K[i + 1][c] - K[i][c]) * segE(ks[i][2], u - prevT, dT, ZETA[c]);
        prevT = ks[i][0];
      }
      v[c] = val;
    }
    if (d.cyc) d.cyc(t, v, clamp((lt - poseEnd(d) * .6) / .5, 0, 1));
    return v;
  }
  function wob(i, t, amp) { var r = rng(i * 131 + Math.floor(t * 8) * 7919); return (r() - .5) * 2 * amp; }
  function stick(ctx, x, y, s, t, o) {
    o = o || {}; t = t || 0; var f = o.face || 1, pose = o.pose || 'idle', v;
    // look target in figure units (x forward, y up from feet)
    var look = o.look ? { x: (o.look.x - x) * f / s, y: (y - o.look.y) / s } : null;
    if (typeof pose === 'object') {
      var va = poseVec(pose.a || 'idle', t, o, look), vb = poseVec(pose.b || 'idle', t, o, look), k = clamp(pose.k == null ? .5 : pose.k, 0, 1.2);
      v = va.map(function (a, i) { return a + (vb[i] - a) * k; });
    } else v = poseVec(pose, t, o, look);
    var busy = POSES[typeof pose === 'object' ? (pose.k > .5 ? pose.b : pose.a) : pose]; busy = busy && busy.busy;
    if (o.walk && !(POSES[pose] && POSES[pose].legs)) { v[5] = v[7] = 0; v[6] = v[8] = -.1; walkLegs(t, v, 1); v[0] += .05; }
    if ((o.lantern || o.hold) && !busy) { var sw = Math.sin(t * TAU * .95 - .35) * (o.walk || pose === 'walk' ? .08 : .02); v[9] = .62 + sw; v[10] = .35; }
    if (look) { var el = Math.atan2(look.y - (SK.th + SK.sh + SK.torso + SK.hr), Math.abs(look.x) + .05); v[4] += clamp(-el * .45, -.35, .35) + (look.x < 0 ? -.08 : .04); }
    var sq = v[3] + (o.squash || 0), lean = v[0], hd = v[4];
    // skeleton in units (x forward, y down), hip at (hx, 0)
    var hip = [v[1], 0], up = [Math.sin(lean), -Math.cos(lean)];
    var neck = [hip[0] + up[0] * SK.torso, hip[1] + up[1] * SK.torso];
    var shl = [hip[0] + up[0] * (SK.torso - .035 + v[13]), hip[1] + up[1] * (SK.torso - .035 + v[13])];
    var hu = [Math.sin(lean + hd), -Math.cos(lean + hd)], hc = [neck[0] + hu[0] * (SK.hr + .012 - v[13] * .5), neck[1] + hu[1] * (SK.hr + .012 - v[13] * .5)];
    function bone(p, a, L) { return [p[0] + Math.sin(a) * L, p[1] + Math.cos(a) * L]; }
    var nk = bone(hip, v[5], SK.th), nf = bone(nk, v[5] + v[6], SK.sh), fk = bone(hip, v[7], SK.th), ff = bone(fk, v[7] + v[8], SK.sh);
    var ne = bone(shl, v[9], SK.ua), nh = bone(ne, v[9] + v[10], SK.fa), fe = bone(shl, v[11], SK.ua), fh = bone(fe, v[11] + v[12], SK.fa);
    var lw = Math.max(1.6, s * .07), lwU = lw / s, low = Math.max(nf[1], ff[1], nk[1], fk[1], nh[1], fh[1], ne[1], fe[1], hc[1] + SK.hr, hip[1]) + lwU * .5;
    var pts = [hip, neck, shl, hc, nk, nf, fk, ff, ne, nh, fe, fh], sx = 1 + .3 * sq, sy = 1 - .35 * sq, lift = v[2];
    var W = pts.map(function (p, i) {
      var px = hip[0] + (p[0] - hip[0]) * sx, py = (p[1] - low) * sy - lift;
      return [x + f * px * s + (i > 3 ? wob(i, t, s * .006) : 0), y + py * s + (i > 3 ? wob(i + 50, t, s * .006) : 0)];
    });
    var P_ = { hip: W[0], neck: W[1], sh: W[2], head: W[3], nk: W[4], nf: W[5], fk: W[6], ff: W[7], ne: W[8], nh: W[9], fe: W[10], fh: W[11] };
    var hr = SK.hr * s, col = o.color || P.ink, edge = Math.max(1, s * .022), EDGE = o.edge || P.cream;
    function chain(a, b, c, bi) {
      var bw = wob(bi, t, s * .01);
      ctx.moveTo(a[0], a[1]);
      ctx.quadraticCurveTo((a[0] + b[0]) / 2 + bw, (a[1] + b[1]) / 2 - bw, b[0], b[1]);
      if (c) ctx.quadraticCurveTo((b[0] + c[0]) / 2 - bw, (b[1] + c[1]) / 2 + bw, c[0], c[1]);
    }
    function back() { ctx.beginPath(); chain(P_.hip, P_.fk, P_.ff, 1); chain(P_.sh, P_.fe, P_.fh, 2); }
    function front() { ctx.beginPath(); chain(P_.hip, P_.neck, null, 3); chain(P_.hip, P_.nk, P_.nf, 4); chain(P_.sh, P_.ne, P_.nh, 5); }
    function headP(extra) { ctx.beginPath(); ctx.arc(P_.head[0], P_.head[1], hr + extra, 0, TAU); }
    ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // soft paper-cutout drop shadow (two passes fake a blur)
    var so = [s * .018 + 1, s * .03 + 1.2];
    ctx.save(); ctx.translate(so[0], so[1]); ctx.strokeStyle = ctx.fillStyle = 'rgba(12,10,30,.13)';
    [edge * 2 + 2.2, edge * 2].forEach(function (e2) { ctx.lineWidth = lw + e2; back(); ctx.stroke(); front(); ctx.stroke(); headP(e2 / 2); ctx.fill(); });
    ctx.restore();
    // back limbs: cream cut edge then ink
    ctx.strokeStyle = EDGE; ctx.lineWidth = lw + edge * 2; back(); ctx.stroke();
    ctx.strokeStyle = col; ctx.lineWidth = lw; back(); ctx.stroke();
    // torso, head, near limbs
    ctx.strokeStyle = ctx.fillStyle = EDGE; ctx.lineWidth = lw + edge * 2; front(); ctx.stroke(); headP(edge); ctx.fill();
    ctx.strokeStyle = ctx.fillStyle = col; ctx.lineWidth = lw; front(); ctx.stroke(); headP(0); ctx.fill();
    // soft highlight on head: paper sheen, not a face
    ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = Math.max(1, hr * .16); ctx.beginPath(); ctx.arc(P_.head[0], P_.head[1], hr * .74, Math.PI * 1.08, Math.PI * 1.55); ctx.stroke();  /* rim light, kept thin and on the edge so it never reads as an eye */
    if (o.scarf) {
      var nk2 = P_.neck, trail = -f, fl = Math.sin(t * 9) * s * .018, sp2 = (pose === 'run' ? 1.6 : pose === 'walk' || o.walk ? 1 : .4);
      ctx.strokeStyle = o.scarf; ctx.lineWidth = Math.max(1.4, s * .05);
      ctx.beginPath(); ctx.moveTo(nk2[0] - f * s * .035, nk2[1] + s * .012); ctx.lineTo(nk2[0] + f * s * .035, nk2[1] + s * .005); ctx.stroke();
      ctx.lineWidth = Math.max(1.2, s * .038); ctx.beginPath(); ctx.moveTo(nk2[0], nk2[1] + s * .01);
      ctx.quadraticCurveTo(nk2[0] + trail * s * .08 * sp2, nk2[1] + s * (.05 - .02 * sp2) + fl, nk2[0] + trail * s * .15 * sp2, nk2[1] + s * (.1 - .06 * sp2) - fl); ctx.stroke();
    }
    ctx.restore();
    var H = busy ? P_.fh : P_.nh, E = busy ? P_.fe : P_.ne, ang = Math.atan2(H[1] - E[1], H[0] - E[0]);
    if (o.lantern) { var ls = s * .14; lantern(ctx, H[0], H[1] + ls * 1.1, ls, o.lit == null ? 1 : o.lit, t); }
    if (o.hold) o.hold(ctx, H[0], H[1], s, ang);
    return { head: { x: P_.head[0], y: P_.head[1], r: hr }, hand: { x: P_.nh[0], y: P_.nh[1] }, hand2: { x: P_.fh[0], y: P_.fh[1] }, hip: { x: P_.hip[0], y: P_.hip[1] }, neck: { x: P_.neck[0], y: P_.neck[1] }, foot: { x: P_.nf[0], y: P_.nf[1] } };
  }
  // pass-1 walker, redrawn as the stick figure (feet at y, about 1.5*s tall as before)
  function person(ctx, x, y, s, t, o) {
    o = o || {};
    return stick(ctx, x, y, s * 1.5, t, { pose: o.pose || (o.walk ? 'walk' : 'idle'), face: o.face || 1, color: o.color, t0: o.t0, from: o.from, look: o.look, walk: o.pose ? o.walk : false, edge: o.edge,
      scarf: o.scarf || o.coat || P.red, lantern: o.lantern !== false, lit: o.lit, hold: o.hold, squash: o.squash });
  }
  function cat(ctx, x, y, s, t) {
    ctx.save(); ctx.translate(x, y); ctx.fillStyle = P.ink;
    ctx.beginPath(); ctx.ellipse(0, -s * .35, s * .38, s * .35, 0, 0, 6.283); ctx.fill();
    ctx.beginPath(); ctx.arc(s * .25, -s * .8, s * .24, 0, 6.283); ctx.fill();
    ctx.beginPath(); ctx.moveTo(s * .08, -s * .95); ctx.lineTo(s * .12, -s * 1.15); ctx.lineTo(s * .24, -s * 1.0); ctx.moveTo(s * .3, -s * 1.0); ctx.lineTo(s * .42, -s * 1.13); ctx.lineTo(s * .45, -s * .9); ctx.fill();
    ctx.strokeStyle = P.ink; ctx.lineWidth = s * .08; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(-s * .3, -s * .1);
    ctx.quadraticCurveTo(-s * .8, -s * .2 + Math.sin(t * 2) * s * .2, -s * .6, -s * .7); ctx.stroke();
    ctx.fillStyle = P.butter; ctx.fillRect(s * .17, -s * .84, s * .05, s * .05); ctx.fillRect(s * .32, -s * .84, s * .05, s * .05);
    ctx.restore();
  }
  function plane(ctx, x, y, s, ang, color) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang || 0);
    ctx.shadowColor = 'rgba(0,0,0,.3)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 3;
    ctx.fillStyle = color || P.cream; ctx.beginPath(); ctx.moveTo(s, 0); ctx.lineTo(-s * .8, -s * .6); ctx.lineTo(-s * .45, 0); ctx.lineTo(-s * .8, s * .55); ctx.closePath(); ctx.fill();
    ctx.shadowColor = 'transparent'; ctx.fillStyle = 'rgba(0,0,0,.12)'; ctx.beginPath(); ctx.moveTo(s, 0); ctx.lineTo(-s * .45, 0); ctx.lineTo(-s * .8, s * .55); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  // chalk arrow with a few jittered passes
  function arrow(ctx, x1, y1, x2, y2, color, width, seed) {
    var r = rng(seed || 'arw'), len = Math.hypot(x2 - x1, y2 - y1); if (len < 1) return;
    var a = Math.atan2(y2 - y1, x2 - x1), hs = Math.min(len * .4, 8 + width * 2.5);
    ctx.save(); ctx.strokeStyle = color || P.chalk; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (var p = 0; p < 3; p++) {
      ctx.globalAlpha = p ? .45 : .95; ctx.lineWidth = (width || 3) * (p ? .6 : 1);
      var j = function () { return (r() - .5) * width * .8; };
      ctx.beginPath(); ctx.moveTo(x1 + j(), y1 + j()); ctx.lineTo(x2 + j(), y2 + j());
      ctx.moveTo(x2 - hs * Math.cos(a - .5) + j(), y2 - hs * Math.sin(a - .5) + j()); ctx.lineTo(x2, y2); ctx.lineTo(x2 - hs * Math.cos(a + .5) + j(), y2 - hs * Math.sin(a + .5) + j());
      ctx.stroke();
    }
    ctx.restore();
  }
  // Tamagotchi-ish mind egg. o.clear 0..1 transparency, o.features [{x,y,c,on}] in -1..1 units
  function egg(ctx, x, y, s, t, o) {
    o = o || {}; var clear = o.clear || 0;
    ctx.save(); ctx.translate(x, y);
    var shell = function () { ctx.beginPath(); ctx.moveTo(0, -s * 1.2); ctx.bezierCurveTo(s * .95, -s * 1.15, s * 1.05, s * .9, 0, s); ctx.bezierCurveTo(-s * 1.05, s * .9, -s * .95, -s * 1.15, 0, -s * 1.2); };
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 6; shell();
    ctx.fillStyle = 'rgba(247,240,225,' + (1 - clear * .82) + ')'; ctx.fill(); ctx.restore();
    ctx.save(); shell(); ctx.clip();
    ctx.fillStyle = 'rgba(30,34,70,' + clear * .8 + ')'; ctx.fillRect(-s * 1.2, -s * 1.3, s * 2.4, s * 2.5);
    var feats = o.features || [];
    for (var i = 0; i < feats.length; i++) {
      var f = feats[i], on = (f.on == null ? 1 : f.on) * clear, fx = f.x * s * .7, fy = f.y * s * .8;
      if (on <= 0.01) continue;
      glow(ctx, fx, fy, s * .35, f.c || 'rgba(255,220,120,.9)', on * (.7 + .3 * Math.sin(t * 3 + i)));
      ctx.globalAlpha = on; ctx.fillStyle = f.core || '#fff6d0'; ctx.beginPath(); ctx.arc(fx, fy, s * .05, 0, 6.283); ctx.fill(); ctx.globalAlpha = 1;
    }
    if (o.inner) o.inner(ctx, s, clear);
    ctx.fillStyle = grain(ctx); ctx.globalAlpha = .6 * (1 - clear * .7); ctx.fillRect(-s * 1.2, -s * 1.3, s * 2.4, s * 2.5); ctx.globalAlpha = 1;
    // speckles
    var r = rng('egg'); ctx.fillStyle = 'rgba(200,150,120,' + (1 - clear) * .6 + ')';
    for (i = 0; i < 12; i++) { ctx.beginPath(); ctx.arc((r() - .5) * s * 1.4, (r() - .5) * s * 1.6, s * (.03 + r() * .05), 0, 6.283); ctx.fill(); }
    ctx.restore();
    ctx.lineWidth = Math.max(1.5, s * .05); ctx.strokeStyle = 'rgba(42,41,52,.8)'; shell(); ctx.stroke();
    // Tamagotchi buttons
    if (o.buttons !== false) for (i = -1; i <= 1; i++) { ctx.fillStyle = [P.pink, P.butter, P.mint][i + 1]; ctx.beginPath(); ctx.arc(i * s * .3, s * .72 + Math.abs(i) * -s * .04, s * .085, 0, 6.283); ctx.fill(); ctx.stroke(); }
    ctx.restore();
  }
  // Game Boy-ish screen frame; returns inner rect
  function gameboy(ctx, x, y, w, h, o) {
    o = o || {};
    paper(ctx, x + w / 2, y + h / 2, w, h, o.body || '#cfcbd8', { seed: 'gb' + Math.round(w), rot: o.rot || 0 });
    var ix = x + w * .08, iy = y + h * .1, iw = w * .84, ih = h * .7;
    ctx.fillStyle = '#5b5f73'; ctx.fillRect(ix - 4, iy - 4, iw + 8, ih + 8);
    ctx.fillStyle = '#b7c48a'; ctx.fillRect(ix, iy, iw, ih);
    ctx.fillStyle = P.red; ctx.beginPath(); ctx.arc(ix + 6, iy + ih + h * .1, 3, 0, 6.283); ctx.fill();
    hand(ctx, o.label || 'LOSS BOY', x + w - w * .08, y + h - h * .09, Math.max(9, h * .07), '#3d3f75', { align: 'right', seed: 'gbl' });
    return { x: ix, y: iy, w: iw, h: ih };
  }
  function vignette(ctx, W, H, a) {
    var g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * .3, W / 2, H / 2, Math.max(W, H) * .75);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(5,6,20,' + (a == null ? .5 : a) + ')'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  // torn corner flip: progress 0..1 reveals a card in the lower-right
  function cornerFlip(ctx, W, H, p, color) {
    if (p <= 0) return; var s = Math.min(W, H) * .9 * ease.out(p);
    ctx.save(); ctx.beginPath(); ctx.moveTo(W, H - s); ctx.lineTo(W, H); ctx.lineTo(W - s, H); ctx.closePath();
    ctx.fillStyle = color || P.cream; ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 16; ctx.fill(); ctx.restore();
  }
  function camera(ctx, W, H, cx, cy, z) { ctx.translate(W / 2, H / 2); ctx.scale(z, z); ctx.translate(-cx, -cy); }

  /* ------------------------------------------------------------ audio */
  function Audio() {
    this.ac = null; this.muted = false; this.on = false;
    try { this.muted = localStorage.getItem('tara.films.mute') === '1'; } catch (e) {}
  }
  Audio.prototype.start = function () {
    if (this.ac) { if (this.ac.state === 'suspended') this.ac.resume(); return; }
    var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    var ac = this.ac = new AC(); this.master = ac.createGain(); this.master.gain.value = this.muted ? 0 : .5;
    var lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400; this.master.connect(lp); lp.connect(ac.destination);
    // noise buffer
    var nb = ac.createBuffer(1, ac.sampleRate, ac.sampleRate), d = nb.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; this.noise = nb;
    this.beat = 0; this.next = ac.currentTime + .1; this.r = rng('tune'); this.on = true;
    var self = this; this.timer = setInterval(function () { self.sched(); }, 90);
  };
  var CH = [[48, 55, 59, 64], [45, 52, 55, 60], [41, 48, 52, 57], [43, 50, 55, 59]]; // Cmaj7 Am7 Fmaj7 G
  var PENT = [60, 62, 64, 67, 69, 72, 74, 76];
  var mtof = function (m) { return 440 * Math.pow(2, (m - 69) / 12); };
  Audio.prototype.sched = function () {
    if (!this.ac || this.ac.state !== 'running') return;
    var spb = 60 / 76 / 2; // eighth notes at 76bpm
    while (this.next < this.ac.currentTime + .35) {
      var b = this.beat, bar = Math.floor(b / 8), ch = CH[bar % 4];
      if (b % 8 === 0) for (var i = 0; i < ch.length; i++) this.pad(mtof(ch[i]), this.next, spb * 8);
      if (b % 2 === 0) this.tick(this.next, b % 4 === 0 ? .05 : .025);
      if (this.r() < (b % 2 ? .22 : .45)) {
        var n = PENT[Math.floor(this.r() * PENT.length)];
        if (ch.indexOf(n % 12 + 48) >= 0 || this.r() < .6) this.pluck(mtof(n), this.next);
      }
      this.beat++; this.next += spb;
    }
  };
  Audio.prototype.env = function (t, a, peak, rel) { var g = this.ac.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(.0001, t + a + rel); g.connect(this.master); return g; };
  Audio.prototype.pad = function (f, t, dur) {
    var g = this.env(t, .8, .035, dur), lp = this.ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.connect(g);
    for (var k = -1; k <= 1; k += 2) { var o = this.ac.createOscillator(); o.type = 'triangle'; o.frequency.value = f; o.detune.value = k * 7; o.connect(lp); o.start(t); o.stop(t + dur + 1); }
  };
  Audio.prototype.pluck = function (f, t) {
    var g = this.env(t, .005, .07, .6), o = this.ac.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.connect(g); o.start(t); o.stop(t + .8);
    var g2 = this.env(t, .002, .025, .15), o2 = this.ac.createOscillator(); o2.type = 'triangle'; o2.frequency.value = f * 2; o2.connect(g2); o2.start(t); o2.stop(t + .3);
  };
  Audio.prototype.noiseHit = function (t, freq, q, peak, rel, type) {
    var s = this.ac.createBufferSource(); s.buffer = this.noise; var bp = this.ac.createBiquadFilter(); bp.type = type || 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
    var g = this.env(t, .003, peak, rel); s.connect(bp); bp.connect(g); s.start(t, Math.random() * .5); s.stop(t + rel + .1);
  };
  Audio.prototype.tick = function (t, v) { this.noiseHit(t, 7000, 1, v * .6, .03, 'highpass'); };
  Audio.prototype.paper = function () { if (!this.ac || this.ac.state !== 'running') return; var t = this.ac.currentTime; this.noiseHit(t, 2200, .8, .12, .18); this.noiseHit(t + .05, 1200, .7, .07, .22); };
  Audio.prototype.blip = function (f) { if (!this.ac || this.ac.state !== 'running') return; this.pluck(f || 880, this.ac.currentTime); };
  Audio.prototype.setMute = function (m) { this.muted = m; try { localStorage.setItem('tara.films.mute', m ? '1' : '0'); } catch (e) {} if (this.master) this.master.gain.value = m ? 0 : .5; };
  Audio.prototype.pause = function (p) { if (this.ac) { if (p) this.ac.suspend(); else this.ac.resume(); } };

  /* ------------------------------------------------------------ tiers */
  function getTier() {
    try { var v = localStorage.getItem('tara.tier') || localStorage.getItem('tara.resolution'); if (v === '1' || v === '2' || v === '3') return v; } catch (e) {}
    return '2';
  }
  function setTier(v) { try { localStorage.setItem('tara.tier', v); localStorage.setItem('tara.resolution', v); } catch (e) {} }

  /* ------------------------------------------------------------ player */
  var CSS = "html,body{margin:0;height:100%;background:#1c2140;overflow:hidden;-webkit-tap-highlight-color:transparent}" +
    "#ifilm{position:fixed;inset:0;display:flex;flex-direction:column;font:15px/1.35 system-ui,-apple-system,'Segoe UI',sans-serif;color:#fbf6ea}" +
    "#ifilm .top{height:44px;flex:none;display:flex;align-items:center;gap:8px;padding:0 10px;background:#161a35}" +
    "#ifilm .top a.back{color:#f7e3a0;text-decoration:none;font-size:14px;white-space:nowrap}" +
    "#ifilm .top .ttl{flex:1;min-width:0;font:700 16px " + HAND + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center}" +
    "#ifilm button{font:inherit;color:#1c2140;background:#f7f0e1;border:0;border-radius:8px;min-height:32px;min-width:32px;padding:0 9px;cursor:pointer}" +
    "#ifilm button[aria-pressed=true]{background:#f7e3a0;font-weight:700}" +
    "#ifilm .tiers{display:flex;gap:3px}#ifilm .tiers button{min-width:30px;padding:0}" +
    "#ifilm .stage{flex:1;position:relative;min-height:0}#ifilm canvas{position:absolute;inset:0;width:100%;height:100%;touch-action:none;display:block}" +
    "#ifilm .bot{flex:none;background:#161a35;padding:8px 12px calc(8px + env(safe-area-inset-bottom))}" +
    "#ifilm .cap{height:84px;max-width:760px;margin:0 auto;overflow:auto;font-size:15px;line-height:1.4;color:#fbf6ea}" +
    "#ifilm .bot{position:relative}#ifilm .need{position:absolute;top:-11px;right:max(10px,calc(50% - 370px));z-index:3;pointer-events:none;white-space:nowrap;font:700 11px/1 system-ui,-apple-system,'Segoe UI',sans-serif;color:#2a2934;padding:4px 8px 4px;border-radius:2px;transform:rotate(-1.2deg);box-shadow:1px 2px 3px rgba(0,0,0,.35);display:none}" +
    "#ifilm .need.on{display:block}#ifilm .need.core{background:#f7e3a0}#ifilm .need.exercise{background:#b9e3cc}#ifilm .need.library{background:#a9c9ef}#ifilm .need.contested{background:#f3b3c3}#ifilm.in-coda .need{display:none}" +
    "#ifilm .cap b{color:#f7e3a0}#ifilm .cap code{font-family:" + MONO + ";font-size:.92em;color:#b9e3cc}" +
    "#ifilm .ctl{max-width:760px;margin:6px auto 0;display:flex;align-items:center;gap:8px}" +
    "#ifilm .dots{display:flex;gap:4px;align-items:center;flex:none}#ifilm .dots i{width:9px;height:9px;border-radius:50%;background:#454a86;display:block;cursor:pointer}" +
    "#ifilm .dots i.on{background:#f7e3a0}#ifilm .dots i.done{background:#b9e3cc}" +
    "#ifilm input[type=range]{flex:1;min-width:40px;accent-color:#f7e3a0}" +
    "#ifilm .coda{display:none;max-width:760px;margin:0 auto}#ifilm.in-coda .coda{display:block}#ifilm.in-coda .cap,#ifilm.in-coda .ctl .scr,#ifilm.in-coda .pp,#ifilm.in-coda .skip{display:none}#ifilm .skip{white-space:nowrap}" +
    "#ifilm .links{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}#ifilm .links a{color:#1c2140;background:#b9e3cc;text-decoration:none;border-radius:14px;padding:5px 10px;font-size:13px}" +
    "#ifilm .hint{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);background:rgba(22,26,53,.8);padding:4px 10px;border-radius:12px;font-size:13px;pointer-events:none;transition:opacity .4s}" +
    "@media (max-width:420px){#ifilm .skip .lg{display:none}#ifilm .dots{gap:3px}#ifilm .dots i{width:8px;height:8px}#ifilm .ctl{gap:6px}#ifilm .cap{height:92px;font-size:14px}#ifilm .top .ttl{font-size:14px}}";

  var NEED = { core: 'Core skill: for your whole career', exercise: "Needed for this week\u2019s exercise", library: 'Library call: know what it does, skip the internals', contested: 'Open research question' };
  var NEED_ALIAS = { context: 'library' };
  function el(tag, attrs, html) { var e = document.createElement(tag); for (var k in attrs || {}) e.setAttribute(k, attrs[k]); if (html != null) e.innerHTML = html; return e; }

  function play(cfg) {
    var st = el('style'); st.textContent = CSS; document.head.appendChild(st);
    var root = el('div', { id: 'ifilm' });
    root.innerHTML = '<div class="top"><a class="back" href="' + (cfg.back || '../index.html') + '">&larr; films</a><div class="ttl"></div>' +
      '<div class="tiers" role="group" aria-label="Caption depth"><button data-t="1" title="Plain">1</button><button data-t="2" title="Generalist">2</button><button data-t="3" title="Expert">3</button></div>' +
      '<button class="mute" aria-label="Mute">&#9835;</button></div>' +
      '<div class="stage"><canvas></canvas><div class="hint">tap to pause</div></div>' +
      '<div class="bot"><div class="need" aria-hidden="false"></div><div class="cap" aria-live="polite"></div><div class="coda"><div class="cpanel"></div><div class="links"></div></div>' +
      '<div class="ctl"><button class="pp" aria-label="Pause">&#10074;&#10074;</button><div class="dots scr"></div><input class="scr" type="range" min="0" step="0.01" aria-label="Scrub">' +
      '<button class="rep" aria-label="Replay" title="Replay">&#8634;</button><button class="skip">Skip<span class="lg"> to play</span> &#9654;</button></div></div>';
    document.body.appendChild(root);
    var $ = function (s) { return root.querySelector(s); };
    $('.ttl').textContent = cfg.title || '';
    var cv = $('canvas'), ctx = cv.getContext('2d'), stage = $('.stage'), cap = $('.cap'), scr = $('input[type=range]'), dots = $('.dots');
    var ch = cfg.chapters, total = 0; ch.forEach(function (c) { total = Math.max(total, c.start + c.dur); });
    scr.max = total;
    ch.forEach(function (c, i) { var d = el('i', { title: c.name }); d.onclick = function () { seek(c.start + .01); }; dots.appendChild(d); });
    var links = $('.links'); (cfg.links || []).forEach(function (l) { var a = el('a', { href: l.href }); a.textContent = l.label; links.appendChild(a); });
    var audio = new Audio(), W = 0, H = 0, dpr = 1, t = 0, playing = true, mode = 'film', last = 0, cur = -1, tier = getTier(), coda = cfg.coda, codaT = 0;
    var api = { audio: audio, P: P, get W() { return W; }, get H() { return H; }, seek: seek, root: root };

    function resize() {
      var r = stage.getBoundingClientRect(); dpr = Math.min(2.5, window.devicePixelRatio || 1);
      W = Math.max(1, r.width); H = Math.max(1, r.height); cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      if (mode === 'coda' && coda && coda.resize) coda.resize(W, H);
    }
    window.addEventListener('resize', resize); resize();
    /* The bottom bar grows when the coda opens; re-measure whenever the stage changes size. */
    if (window.ResizeObserver) new ResizeObserver(function () { resize(); }).observe(stage);
    function paintTier() {
      [].forEach.call(root.querySelectorAll('.tiers button'), function (b) { b.setAttribute('aria-pressed', b.dataset.t === tier ? 'true' : 'false'); });
      var c = ch[cur]; if (c && c.cap) cap.innerHTML = c.cap[tier] || c.cap['2'] || '';
      var nk = c && NEED_ALIAS[c.need] || (c && c.need), nd = $('.need');
      if (nk && NEED[nk]) { nd.className = 'need on ' + nk; nd.textContent = NEED[nk]; } else { nd.className = 'need'; nd.textContent = ''; }
      if (mode === 'coda' && coda && coda.caption) cap.innerHTML = coda.caption[tier] || '';
    }
    function setT(v) { tier = v; setTier(v); paintTier(); if (coda && coda.onTier && mode === 'coda') coda.onTier(v); }
    [].forEach.call(root.querySelectorAll('.tiers button'), function (b) { b.onclick = function (e) { e.stopPropagation(); setT(b.dataset.t); }; });
    function paintMute() { $('.mute').innerHTML = audio.muted ? '&#128263;' : '&#9835;'; $('.mute').setAttribute('aria-pressed', audio.muted ? 'false' : 'true'); }
    $('.mute').onclick = function () { audio.setMute(!audio.muted); paintMute(); }; paintMute();
    function setPlaying(p) { playing = p; $('.pp').innerHTML = p ? '&#10074;&#10074;' : '&#9654;'; $('.pp').setAttribute('aria-label', p ? 'Pause' : 'Play'); audio.pause(!p && mode === 'film'); }
    $('.pp').onclick = function () { if (mode === 'coda') { replay(); return; } setPlaying(!playing); };
    $('.rep').onclick = replay; $('.skip').onclick = function () { enterCoda(); };
    function replay() { root.classList.remove('in-coda'); mode = 'film'; seek(0); setPlaying(true); }
    function seek(v) { if (mode === 'coda') { root.classList.remove('in-coda'); mode = 'film'; } t = clamp(v, 0, total - .001); scr.value = t; }
    scr.oninput = function () { seek(+scr.value); };
    function enterCoda() {
      if (mode === 'coda') return; mode = 'coda'; codaT = 0; root.classList.add('in-coda'); audio.paper();
      $('.pp').innerHTML = '&#8634;'; playing = true; audio.pause(false);
      if (coda && coda.start) coda.start(api, $('.cpanel'));
      paintTier();
    }
    function gesture() { audio.start(); if (!playing && mode === 'film') audio.pause(true); }
    window.addEventListener('pointerdown', gesture, { once: false, passive: true });
    window.addEventListener('keydown', function (e) {
      gesture();
      if (e.target && e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
      if (e.key === ' ') { e.preventDefault(); if (mode === 'film') setPlaying(!playing); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); seek(t + 3); } else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(t - 3); }
      else if (e.key === '1' || e.key === '2' || e.key === '3') setT(e.key);
      else if (e.key === 'm' || e.key === 'M') { audio.setMute(!audio.muted); paintMute(); }
    });
    // pointer on canvas
    var hint = $('.hint'); setTimeout(function () { hint.style.opacity = 0; }, 3500);
    function pos(e) { var r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    cv.addEventListener('pointerdown', function (e) {
      if (mode === 'coda') { if (coda && coda.down) { cv.setPointerCapture && cv.setPointerCapture(e.pointerId); var p = pos(e); coda.down(p.x, p.y, api); } return; }
      setPlaying(!playing); hint.textContent = playing ? 'playing' : 'paused, tap to go on'; hint.style.opacity = 1; setTimeout(function () { hint.style.opacity = 0; }, 1200);
    });
    cv.addEventListener('pointermove', function (e) { if (mode === 'coda' && coda && coda.move) { var p = pos(e); coda.move(p.x, p.y, api, e.buttons > 0 || e.pointerType === 'touch'); } });
    cv.addEventListener('pointerup', function (e) { if (mode === 'coda' && coda && coda.up) { var p = pos(e); coda.up(p.x, p.y, api); } });

    function frame(now) {
      var dt = Math.min(.05, (now - (last || now)) / 1000); last = now;
      if (mode === 'film') {
        if (playing) t += dt;
        if (t >= total) { enterCoda(); }
        else {
          scr.value = t; var ci = 0; for (var i = 0; i < ch.length; i++) if (t >= ch[i].start) ci = i;
          if (ci !== cur) { if (cur >= 0 && playing) audio.paper(); cur = ci; paintTier(); [].forEach.call(dots.children, function (d, k) { d.className = k === ci ? 'on' : k < ci ? 'done' : ''; }); }
        }
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      try {
        if (mode === 'film') { var c = ch[cur] || ch[0]; ctx.save(); c.draw(ctx, t, t - c.start, W, H, api); ctx.restore(); }
        else { codaT += dt; ctx.save(); if (coda && coda.draw) coda.draw(ctx, codaT, W, H, api, dt); ctx.restore(); }
      } catch (err) { if (!frame.err) { frame.err = 1; console.error(err); } }
      requestAnimationFrame(frame);
    }
    paintTier(); requestAnimationFrame(frame);
    api.enterCoda = enterCoda; api.tier = function () { return tier; };
    window.__film = api; return api;
  }

  window.IFilm = {
    play: play, P: P, HAND: HAND, MONO: MONO, rng: rng, clamp: clamp, lerp: lerp, ease: ease, ramp: ramp,
    paper: paper, blob: blob, tape: tape, fillPaper: fillPaper, tornRect: tornRect, tornCircle: tornCircle, grain: grain,
    hand: hand, textW: textW, note: note, sky: sky, stars: stars, moon: moon, glow: glow, lantern: lantern, person: person, stick: stick, stickPoses: POSE_NAMES, spring: spring, anticip: anticip,
    cat: cat, plane: plane, arrow: arrow, egg: egg, gameboy: gameboy, vignette: vignette, cornerFlip: cornerFlip, camera: camera
  };
})();
