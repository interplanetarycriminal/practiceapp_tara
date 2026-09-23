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
  // paper person with scarf; facing 1 or -1; walk phase
  function person(ctx, x, y, s, t, o) {
    o = o || {}; var f = o.face || 1, w = o.walk ? Math.sin(t * 8) : 0;
    ctx.save(); ctx.translate(x, y); ctx.scale(f, 1);
    ctx.strokeStyle = P.ink; ctx.lineCap = 'round'; ctx.lineWidth = s * .09;
    ctx.beginPath(); ctx.moveTo(-s * .1, -s * .45); ctx.lineTo(-s * .15 - w * s * .15, 0); ctx.moveTo(s * .1, -s * .45); ctx.lineTo(s * .15 + w * s * .15, 0); ctx.stroke();
    ctx.save(); ctx.translate(0, -s * .75); fillPaper(ctx, tornRect('body', s * .5, s * .62, .5), o.coat || P.green, { blur: 4, lift: 2 }); ctx.restore();
    // arm holding lantern
    ctx.beginPath(); ctx.moveTo(s * .18, -s * .9); ctx.lineTo(s * .42, -s * .62 + w * s * .03); ctx.stroke();
    blob(ctx, 0, -s * 1.28, s * .26, P.peach, { seed: 'head', jit: .4, blur: 3, lift: 2 });
    ctx.fillStyle = P.ink; ctx.beginPath(); ctx.arc(s * .09, -s * 1.3, s * .03, 0, 6.283); ctx.fill();
    ctx.beginPath(); ctx.lineWidth = s * .03; ctx.arc(s * .06, -s * 1.22, s * .06, .2, 1.4); ctx.stroke();
    // hair + scarf
    ctx.fillStyle = '#5a3a2e'; ctx.beginPath(); ctx.arc(-s * .03, -s * 1.36, s * .24, 3.3, 5.9); ctx.fill();
    paper(ctx, 0, -s * 1.03, s * .46, s * .12, o.scarf || P.red, { seed: 'scarf', shadow: false });
    var sw = Math.sin(t * 3) * s * .05;
    ctx.save(); ctx.translate(-s * .18, -s * .95); ctx.rotate(.5 + sw / s); fillPaper(ctx, tornRect('scarf2', s * .1, s * .32, .4), o.scarf || P.red, { shadow: false }); ctx.restore();
    ctx.restore();
    if (o.lantern !== false) lantern(ctx, x + f * s * .45, y - s * .45, s * .22, o.lit == null ? 1 : o.lit, t);
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
    "#ifilm .cap b{color:#f7e3a0}#ifilm .cap code{font-family:" + MONO + ";font-size:.92em;color:#b9e3cc}" +
    "#ifilm .ctl{max-width:760px;margin:6px auto 0;display:flex;align-items:center;gap:8px}" +
    "#ifilm .dots{display:flex;gap:4px;align-items:center;flex:none}#ifilm .dots i{width:9px;height:9px;border-radius:50%;background:#454a86;display:block;cursor:pointer}" +
    "#ifilm .dots i.on{background:#f7e3a0}#ifilm .dots i.done{background:#b9e3cc}" +
    "#ifilm input[type=range]{flex:1;min-width:40px;accent-color:#f7e3a0}" +
    "#ifilm .coda{display:none;max-width:760px;margin:0 auto}#ifilm.in-coda .coda{display:block}#ifilm.in-coda .cap,#ifilm.in-coda .ctl .scr,#ifilm.in-coda .pp,#ifilm.in-coda .skip{display:none}#ifilm .skip{white-space:nowrap}" +
    "#ifilm .links{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}#ifilm .links a{color:#1c2140;background:#b9e3cc;text-decoration:none;border-radius:14px;padding:5px 10px;font-size:13px}" +
    "#ifilm .hint{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);background:rgba(22,26,53,.8);padding:4px 10px;border-radius:12px;font-size:13px;pointer-events:none;transition:opacity .4s}" +
    "@media (max-width:420px){#ifilm .skip .lg{display:none}#ifilm .dots{gap:3px}#ifilm .dots i{width:8px;height:8px}#ifilm .ctl{gap:6px}#ifilm .cap{height:92px;font-size:14px}#ifilm .top .ttl{font-size:14px}}";

  function el(tag, attrs, html) { var e = document.createElement(tag); for (var k in attrs || {}) e.setAttribute(k, attrs[k]); if (html != null) e.innerHTML = html; return e; }

  function play(cfg) {
    var st = el('style'); st.textContent = CSS; document.head.appendChild(st);
    var root = el('div', { id: 'ifilm' });
    root.innerHTML = '<div class="top"><a class="back" href="' + (cfg.back || '../index.html') + '">&larr; films</a><div class="ttl"></div>' +
      '<div class="tiers" role="group" aria-label="Caption depth"><button data-t="1" title="Plain">1</button><button data-t="2" title="Generalist">2</button><button data-t="3" title="Expert">3</button></div>' +
      '<button class="mute" aria-label="Mute">&#9835;</button></div>' +
      '<div class="stage"><canvas></canvas><div class="hint">tap to pause</div></div>' +
      '<div class="bot"><div class="cap" aria-live="polite"></div><div class="coda"><div class="cpanel"></div><div class="links"></div></div>' +
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
    function paintTier() {
      [].forEach.call(root.querySelectorAll('.tiers button'), function (b) { b.setAttribute('aria-pressed', b.dataset.t === tier ? 'true' : 'false'); });
      var c = ch[cur]; if (c && c.cap) cap.innerHTML = c.cap[tier] || c.cap['2'] || '';
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
    hand: hand, textW: textW, note: note, sky: sky, stars: stars, moon: moon, glow: glow, lantern: lantern, person: person,
    cat: cat, plane: plane, arrow: arrow, egg: egg, gameboy: gameboy, vignette: vignette, cornerFlip: cornerFlip, camera: camera
  };
})();
