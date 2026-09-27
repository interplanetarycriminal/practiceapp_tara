/* Node films: one paper-collage film per concept-map node, drawn by IFilm from
   intuition/nodes/<id>.json. Spec format: /mnt/project-files/node-films/SPEC.md.
   Page: intuition/node.html?id=<concept id>. */
(function () {
  'use strict';
  var F = window.IFilm, P = F.P, HAND = F.HAND, MONO = F.MONO, clamp = F.clamp, lerp = F.lerp, ease = F.ease, ramp = F.ramp;
  var id = new URLSearchParams(location.search).get('id') || '';

  /* ------------------------------------------------------------ expressions */
  var HX = {
    relu: function (v) { return v > 0 ? v : 0; }, sigmoid: function (v) { return 1 / (1 + Math.exp(-v)); }, tanh: Math.tanh,
    exp: Math.exp, log: Math.log, sqrt: Math.sqrt, abs: Math.abs, pow: Math.pow, max: Math.max, min: Math.min,
    floor: Math.floor, round: Math.round, sin: Math.sin, cos: Math.cos,
    clamp: function (v, a, b) { return v < a ? a : v > b ? b : v; },
    softmax: function (a) { var m = Math.max.apply(null, a), e = a.map(function (v) { return Math.exp(v - m); }), s = e.reduce(function (p, q) { return p + q; }, 0); return e.map(function (v) { return v / s; }); },
    sum: function (a) { return a.reduce(function (p, q) { return p + (+q || 0); }, 0); },
    mean: function (a) { return a.length ? HX.sum(a) / a.length : 0; },
    dot: function (a, b) { var s = 0; for (var i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i]; return s; },
    norm: function (a) { return Math.sqrt(HX.dot(a, a)); },
    range: function (n) { var r = []; for (var i = 0; i < n; i++) r.push(i); return r; },
    PI: Math.PI, E: Math.E
  };
  var HK = Object.keys(HX);
  function compile(expr, vars) {
    var fn = null;
    try { fn = new Function(HK.concat(vars).join(','), '"use strict";return (' + expr + ');'); } catch (e) { console.warn('bad expression', expr, e); }
    return function (vals) {
      if (!fn) return NaN;
      var args = HK.map(function (k) { return HX[k]; }).concat(vars.map(function (v) { return vals[v]; }));
      try { return fn.apply(null, args); } catch (e) { return NaN; }
    };
  }
  function fmt(v) {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(fmt).join(', ');
    if (typeof v !== 'number' || !isFinite(v)) return String(v);
    var a = Math.abs(v); return a >= 1000 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= .01 || a === 0 ? v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') : v.toExponential(1);
  }
  function col(n, fb) { return (n && P[n]) || (n && n.charAt && n.charAt(0) === '#' ? n : fb || P.butter); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ------------------------------------------------------------ drawing helpers */
  function unit(W, H) { return Math.min(W, H * 1.55) / 10; }
  function wrap(ctx, text, maxW, size, font) {
    ctx.save(); ctx.font = '700 ' + size + 'px ' + (font || HAND);
    var words = String(text).split(/\s+/), lines = [], cur = '';
    words.forEach(function (w) { var t = cur ? cur + ' ' + w : w; if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; });
    if (cur) lines.push(cur); ctx.restore(); return lines;
  }
  // fit text into a box: returns {lines,size}
  function fit(ctx, text, maxW, maxH, size, font) {
    size = size || 20;
    for (var s = size; s >= 9; s -= 1) {
      var L = wrap(ctx, text, maxW, s, font), wmax = 0;
      ctx.save(); ctx.font = '700 ' + s + 'px ' + (font || HAND); L.forEach(function (l) { wmax = Math.max(wmax, ctx.measureText(l).width); }); ctx.restore();
      if (L.length * s * 1.2 <= maxH && wmax <= maxW * 1.02) return { lines: L, size: s };
    }
    return { lines: wrap(ctx, text, maxW, 9, font), size: 9 };
  }
  function textBlock(ctx, text, x, y, maxW, maxH, size, color, o) {
    o = o || {}; var f = fit(ctx, text, maxW, maxH, size, o.font);
    var n = f.lines.length, rev = o.reveal == null ? 1 : o.reveal;
    f.lines.forEach(function (l, i) {
      var r = clamp(rev * n - i, 0, 1); if (r <= 0) return;
      F.hand(ctx, l, x, y + (i - (n - 1) / 2) * f.size * 1.2, f.size, color, { reveal: r, seed: o.seed || l, align: o.align, font: o.font, bold: o.font !== MONO, wobble: o.font === MONO ? 0 : 1 });
    });
    return f;
  }
  function backdrop(ctx, W, H, t, setting) {
    setting = setting || 'night';
    if (setting === 'day') { F.sky(ctx, W, H, '#8fb6e6', '#f3dcc0'); F.blob(ctx, W * .85, H * .16, unit(W, H) * .55, P.butter, { seed: 'sun', shadow: false }); }
    else if (setting === 'dusk') { F.sky(ctx, W, H, P.dusk, '#e79a7c'); F.stars(ctx, W, H * .5, t, 'dusk', 14); }
    else if (setting === 'room') {
      F.sky(ctx, W, H, '#3a3566', '#2b3163');
      F.paper(ctx, W * .5, H * .36, W * 1.1, H * .82, '#3f3a6e', { seed: 'wall', shadow: false, grainA: .35 });
      F.lantern(ctx, W * .92, H * .08, unit(W, H) * .22, 1, t);
    } else { F.sky(ctx, W, H); F.stars(ctx, W, H * .6, t, 'nf' + id, 0); F.moon(ctx, W * .88, H * .14, unit(W, H) * .32); }
    // ground strip
    F.paper(ctx, W * .5, H * .93, W * 1.08, H * .2, setting === 'day' ? P.green : setting === 'room' ? '#6c5a7e' : P.night2, { seed: 'ground' + setting, shadow: false });
  }
  function board(ctx, W, H, color) { F.paper(ctx, W * .5, H * .47, W * .94, H * .8, color || P.cream, { seed: 'board' + id, rot: -.004 }); }
  function narrator(ctx, a, W, H, t, lt, dur, ground) {
    if (!a) return;
    var u = unit(W, H), x0 = (a.x == null ? .12 : a.x) * W, x1 = a.to != null ? a.to * W : x0;
    var k = a.to != null ? ease.inOut(clamp(lt / (dur * .55), 0, 1)) : 1, x = lerp(x0, x1, k);
    var walking = a.to != null && k < 1, face = a.to != null && x1 < x0 ? -1 : (a.face || (x0 > W * .6 ? -1 : 1));
    var s = Math.min(H * .3, u * 2.1), gy = ground || H * .86;
    F.stick(ctx, x, gy, s, t, { pose: walking ? 'walk' : (a.pose || 'idle'), face: face, t0: walking ? null : (a.to != null ? dur * .55 : .15), color: P.chalk });
    if (a.label) F.hand(ctx, a.label, x, gy + u * .32, Math.max(12, u * .26), P.butter, { seed: 'lab' + a.label });
  }
  function topNote(ctx, text, W, H, lt, color) {
    if (!text) return; var u = unit(W, H), f = fit(ctx, text, W * .8, u * .9, Math.max(13, u * .34));
    var r = clamp(lt / 1.4, 0, 1);
    F.note(ctx, f.lines.join('\n'), W * .5, u * .75, f.size, { color: col(color, P.butter), rot: -.015, seed: 'tn' + text, reveal: r });
  }
  function pop(lt, i, gap) { return ease.back(clamp((lt - .2 - i * (gap || .25)) / .55, 0, 1)); }

  /* ------------------------------------------------------------ props */
  function prop(ctx, p, W, H, t, k, i) {
    if (k <= 0) return;
    var u = unit(W, H), x = (p.x == null ? .5 : p.x) * W, y = (p.y == null ? .55 : p.y) * H;
    var w = (p.w || .14) * W, h = (p.h || .14) * H, c = col(p.color, P.peach), seed = 'p' + i + (p.label || '');
    w = Math.min(w, W * .9); h = Math.min(h, H * .7);
    ctx.save(); ctx.translate(x, y); ctx.scale(k, k); ctx.translate(-x, -y);
    var lbl = p.label || '', ls = Math.max(11, Math.min(u * .3, 22));
    switch (p.kind) {
      case 'circle': F.blob(ctx, x, y, Math.min(w, h) / 2, c, { seed: seed }); if (lbl) textBlock(ctx, lbl, x, y, Math.min(w, h) * .85, Math.min(w, h) * .7, ls, P.ink); break;
      case 'lamp': F.lantern(ctx, x, y, u * .35, 1, t); if (lbl) F.hand(ctx, lbl, x, y + u * .75, ls, P.butter, { seed: seed }); break;
      case 'egg': F.egg(ctx, x, y, Math.min(w, h) * .45, t, { clear: .3 }); if (lbl) F.hand(ctx, lbl, x, y + h * .62, ls, P.butter, { seed: seed }); break;
      case 'cat': F.cat(ctx, x, y + h * .4, Math.min(w, h) * .7, t); if (lbl) F.hand(ctx, lbl, x, y + h * .62, ls, P.butter, { seed: seed }); break;
      case 'flag':
        ctx.strokeStyle = P.chalk; ctx.lineWidth = Math.max(2, u * .05); ctx.beginPath(); ctx.moveTo(x - w * .3, y + h * .5); ctx.lineTo(x - w * .3, y - h * .5); ctx.stroke();
        F.paper(ctx, x + w * .1, y - h * .3, w * .8, h * .38, c, { seed: seed, rot: .04 * Math.sin(t * 3) });
        if (lbl) textBlock(ctx, lbl, x + w * .1, y - h * .3, w * .72, h * .32, ls, P.ink); break;
      case 'door':
        F.paper(ctx, x, y, w, h, c, { seed: seed }); ctx.fillStyle = P.ink; ctx.beginPath(); ctx.arc(x + w * .32, y + h * .05, Math.max(2, u * .06), 0, 6.283); ctx.fill();
        if (lbl) textBlock(ctx, lbl, x, y - h * .22, w * .86, h * .4, ls, P.ink); break;
      case 'crate':
        F.paper(ctx, x, y, w, h, c, { seed: seed }); ctx.strokeStyle = 'rgba(42,41,52,.35)'; ctx.lineWidth = 2;
        for (var s = 1; s < 4; s++) { ctx.beginPath(); ctx.moveTo(x - w / 2 + 4, y - h / 2 + h * s / 4); ctx.lineTo(x + w / 2 - 4, y - h / 2 + h * s / 4); ctx.stroke(); }
        if (lbl) textBlock(ctx, lbl, x, y, w * .86, h * .5, ls, P.ink); break;
      case 'scale':
        var tilt = .12 * Math.sin(t * 1.2); ctx.strokeStyle = P.chalk; ctx.lineWidth = Math.max(2, u * .05);
        ctx.beginPath(); ctx.moveTo(x, y + h * .45); ctx.lineTo(x, y - h * .3); ctx.moveTo(x - w * .45 * Math.cos(tilt), y - h * .3 - w * .45 * Math.sin(tilt)); ctx.lineTo(x + w * .45 * Math.cos(tilt), y - h * .3 + w * .45 * Math.sin(tilt)); ctx.stroke();
        F.paper(ctx, x - w * .45, y - h * .1 - w * .45 * Math.sin(tilt), w * .34, h * .12, c, { seed: seed + 'l' }); F.paper(ctx, x + w * .45, y - h * .1 + w * .45 * Math.sin(tilt), w * .34, h * .12, c, { seed: seed + 'r' });
        if (lbl) F.hand(ctx, lbl, x, y + h * .62, ls, P.butter, { seed: seed }); break;
      case 'stack':
        for (var r = 0; r < 3; r++) {
          var yy = y - h / 2 + h * (r + .5) / 3;
          F.paper(ctx, x, yy + h / 7, w, h * .06, '#8a6f5a', { seed: seed + 's' + r, shadow: false });
          for (var j = 0; j < 4; j++) F.blob(ctx, x - w * .36 + j * w * .24, yy - h * .02, Math.min(w * .09, h * .1), [P.mint, P.peach, P.sky, P.pink][(r + j) % 4], { seed: seed + r + j });
        }
        if (lbl) F.hand(ctx, lbl, x, y + h * .66, ls, P.butter, { seed: seed }); break;
      case 'bridge':
        ctx.strokeStyle = c; ctx.lineWidth = Math.max(4, u * .14); ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(x - w / 2, y + h * .3); ctx.quadraticCurveTo(x, y - h * .5, x + w / 2, y + h * .3); ctx.stroke();
        if (lbl) F.hand(ctx, lbl, x, y - h * .38, ls, P.butter, { seed: seed }); break;
      case 'cloud':
        for (var b = 0; b < 4; b++) F.blob(ctx, x - w * .3 + b * w * .2, y + (b % 2 ? -h * .1 : h * .05), Math.min(w, h) * .28, P.cream, { seed: seed + b, shadow: b === 0 });
        if (lbl) textBlock(ctx, lbl, x, y, w * .8, h * .5, ls, P.ink); break;
      case 'card':
        F.paper(ctx, x, y, w, h, c === P.peach ? P.butter : c, { seed: seed, rot: -.02 }); F.tape(ctx, x - w * .3, y - h / 2, Math.min(36, w * .3), -.4);
        if (lbl) textBlock(ctx, lbl, x, y, w * .88, h * .8, ls, P.ink, { font: /[()_\[\]=.]/.test(lbl) ? MONO : null }); break;
      default:
        F.paper(ctx, x, y, w, h, c, { seed: seed }); if (lbl) textBlock(ctx, lbl, x, y, w * .86, h * .8, ls, P.ink, { font: /[()_\[\]=]/.test(lbl) ? MONO : null });
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------ scene types */
  var S = {};
  S.story = function (c, ctx, t, lt, W, H) {
    backdrop(ctx, W, H, t, c.setting);
    (c.props || []).forEach(function (p, i) { prop(ctx, p, W, H, t, pop(lt, i), i); });
    var u = unit(W, H);
    (c.arrows || []).forEach(function (a, i) {
      var k = ease.out(clamp((lt - 1.2 - i * .5) / .8, 0, 1)); if (k <= 0) return;
      var x1 = a[0] * W, y1 = a[1] * H, x2 = lerp(x1, a[2] * W, k), y2 = lerp(y1, a[3] * H, k);
      F.arrow(ctx, x1, y1, x2, y2, P.butter, Math.max(2.5, u * .06), 'a' + i);
      if (a[4] && k > .9) F.hand(ctx, a[4], (x1 + x2) / 2, (y1 + y2) / 2 - u * .3, Math.max(12, u * .26), P.butter, { seed: 'al' + i });
    });
    (c.actors || []).forEach(function (a) { narrator(ctx, a, W, H, t, lt, c.dur); });
    topNote(ctx, c.note, W, H, lt);
  };
  S.equation = function (c, ctx, t, lt, W, H) {
    F.sky(ctx, W, H, P.night, P.night2);
    F.paper(ctx, W * .5, H * .44, W * .92, H * .64, '#2f4a3e', { seed: 'chalk' + id, rot: -.006 });
    var u = unit(W, H), parts = c.parts || [], full = parts.map(function (p) { return p.t; }).join('');
    var size = Math.min(u * .75, 54); ctx.save(); ctx.font = '700 ' + size + 'px ' + HAND;
    var tw = ctx.measureText(full).width; ctx.restore();
    if (tw > W * .84) size *= W * .84 / tw; size = Math.max(12, size);
    var widths = parts.map(function (p) { return F.textW(ctx, p.t, size); }), total = widths.reduce(function (a, b) { return a + b; }, 0);
    var x = W / 2 - total / 2, y = H * .36, per = Math.max(.6, (c.dur * .6) / Math.max(1, parts.length));
    parts.forEach(function (p, i) {
      var r = clamp((lt - .3 - i * per) / (per * .8), 0, 1);
      if (r > 0) F.hand(ctx, p.t, x, y, size, col(p.c === 'ink' ? 'chalk' : p.c, P.chalk), { align: 'left', reveal: r, seed: 'eq' + i });
      if (p.note && r >= 1) {
        var cx = x + widths[i] / 2, ny = y + size * (1.15 + (i % 2) * .7), k = clamp((lt - .3 - (i + 1) * per) / .5, 0, 1);
        ctx.save(); ctx.globalAlpha = k; ctx.strokeStyle = col(p.c === 'ink' ? 'chalk' : p.c, P.chalk); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(cx, y + size * .55); ctx.lineTo(cx, ny - size * .35); ctx.stroke(); ctx.restore();
        textBlock(ctx, p.note, cx, ny, Math.max(70, widths[i] * 1.6), size * 1.1, Math.max(11, size * .36), P.butter, { reveal: k });
      }
      x += widths[i];
    });
    if (c.actor) narrator(ctx, c.actor, W, H, t, lt, c.dur, H * .95);
    topNote(ctx, c.note, W, H, lt);
  };
  function axes(ctx, box, xr, yr) {
    var X = function (v) { return box.x + (v - xr[0]) / (xr[1] - xr[0]) * box.w; }, Y = function (v) { return box.y + box.h - (v - yr[0]) / (yr[1] - yr[0]) * box.h; };
    ctx.save(); ctx.strokeStyle = 'rgba(42,41,52,.12)'; ctx.lineWidth = 1;
    for (var i = 0; i <= 10; i++) { ctx.beginPath(); ctx.moveTo(box.x + box.w * i / 10, box.y); ctx.lineTo(box.x + box.w * i / 10, box.y + box.h); ctx.moveTo(box.x, box.y + box.h * i / 10); ctx.lineTo(box.x + box.w, box.y + box.h * i / 10); ctx.stroke(); }
    ctx.strokeStyle = P.ink; ctx.lineWidth = 2; ctx.globalAlpha = .75;
    var zx = clamp(X(0), box.x, box.x + box.w), zy = clamp(Y(0), box.y, box.y + box.h);
    ctx.beginPath(); ctx.moveTo(box.x, zy); ctx.lineTo(box.x + box.w, zy); ctx.moveTo(zx, box.y); ctx.lineTo(zx, box.y + box.h); ctx.stroke();
    ctx.globalAlpha = .7; ctx.fillStyle = P.ink; ctx.font = '12px ' + MONO; ctx.textAlign = 'center';
    ctx.fillText(fmt(xr[0]), box.x + 10, zy + 14); ctx.fillText(fmt(xr[1]), box.x + box.w - 12, zy + 14);
    ctx.textAlign = 'left'; ctx.fillText(fmt(yr[1]), zx + 4, box.y + 12); ctx.fillText(fmt(yr[0]), zx + 4, box.y + box.h - 4);
    ctx.restore(); return { X: X, Y: Y };
  }
  function curve(ctx, f, vals, xr, yr, A, box, color, upto, width) {
    ctx.save(); ctx.beginPath(); ctx.rect(box.x, box.y - 4, box.w, box.h + 8); ctx.clip();
    ctx.strokeStyle = color; ctx.lineWidth = width || 3.2; ctx.lineJoin = ctx.lineCap = 'round'; ctx.beginPath();
    var n = 160, pen = false, last = null;
    for (var i = 0; i <= n * upto; i++) {
      var xv = lerp(xr[0], xr[1], i / n); vals.x = xv; var yv = f(vals);
      if (typeof yv !== 'number' || !isFinite(yv)) { pen = false; continue; }
      var py = A.Y(clamp(yv, yr[0] - (yr[1] - yr[0]), yr[1] + (yr[1] - yr[0])));
      if (!pen) { ctx.moveTo(A.X(xv), py); pen = true; } else ctx.lineTo(A.X(xv), py); last = [A.X(xv), py];
    }
    ctx.stroke(); ctx.restore(); return last;
  }
  S.plot = function (c, ctx, t, lt, W, H) {
    F.sky(ctx, W, H, P.night, P.night2); board(ctx, W, H, P.cream);
    var u = unit(W, H), box = { x: W * .12, y: H * .16, w: W * .76, h: H * .6 };
    var xr = c.x || [-3, 3], yr = c.y || [-1, 3], A = axes(ctx, box, xr, yr), upto = clamp((lt - .4) / (c.dur * .5), 0, 1);
    (c.curves || []).forEach(function (cv, i) {
      var f = cv._f || (cv._f = compile(cv.f || '0', ['x'])), color = col(cv.c, [P.orange, P.teal, P.red, P.lav][i % 4]);
      var up = clamp(upto * 1.15 - i * .15, 0, 1), end = curve(ctx, f, {}, xr, yr, A, box, color, up);
      if (cv.label && up > .98 && end) textBlock(ctx, cv.label, clamp(end[0] - u * .5, box.x + u * .8, box.x + box.w - u * .8), clamp(end[1] - u * .35 - i * u * .45, box.y + u * .3, box.y + box.h - u * .3), u * 2.6, u * .5, Math.max(12, u * .3), color);
    });
    if (c.dot && c.curves && c.curves[0]) {
      var f0 = c.curves[0]._f, k = (Math.sin(lt * .9 - 1.5) + 1) / 2, xv = lerp(xr[0], xr[1], k), yv = f0({ x: xv });
      if (isFinite(yv)) { var px = A.X(xv), py = A.Y(clamp(yv, yr[0], yr[1])); F.glow(ctx, px, py, u * .5, 'rgba(242,153,90,.6)'); F.blob(ctx, px, py, Math.max(6, u * .14), P.red, { seed: 'dot' }); }
    }
    (c.marks || []).forEach(function (m, i) {
      var k2 = clamp((lt - 2 - i * .6) / .6, 0, 1); if (k2 <= 0) return;
      var mx = A.X(m.x); ctx.save(); ctx.globalAlpha = k2; ctx.setLineDash([5, 5]); ctx.strokeStyle = P.ink; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(mx, box.y); ctx.lineTo(mx, box.y + box.h); ctx.stroke(); ctx.restore();
      if (m.label) F.note(ctx, m.label, clamp(mx, box.x + u, box.x + box.w - u), box.y + box.h + u * .45 + (i % 2) * u * .5, Math.max(11, u * .24), { color: P.butter, reveal: k2, seed: 'mk' + i, tape: false });
    });
    if (c.actor) narrator(ctx, c.actor, W, H, t, lt, c.dur, H * .95);
    topNote(ctx, c.note, W, H, lt);
  };
  S.grid = function (c, ctx, t, lt, W, H) {
    F.sky(ctx, W, H, P.night, P.night2);
    var u = unit(W, H), R = Math.max(1, c.rows || 2), C = Math.max(1, c.cols || 3), to = c.to && c.to.rows * c.to.cols === R * C ? c.to : null;
    var R2 = to ? to.rows : R, C2 = to ? to.cols : C, maxR = Math.max(R, R2), maxC = Math.max(C, C2);
    var cell = Math.min(W * .78 / maxC, H * .56 / maxR, u * 1.3), vals = c.values || [], hl = c.highlight || [];
    var longest = 0; vals.forEach(function (row) { (row || []).forEach(function (v) { longest = Math.max(longest, String(v == null ? '' : typeof v === 'number' ? fmt(v) : v).length); }); });
    var cw = !to && longest > 3 ? Math.max(cell, Math.min(W * .84 / maxC, u * 3)) : cell;
    var move = to ? ease.inOut(clamp((lt - c.dur * .55) / (c.dur * .3), 0, 1)) : 0, per = Math.max(.25, c.dur * .45 / Math.max(1, hl.length));
    if (c.title) F.hand(ctx, c.title, W / 2, H * .1, Math.max(14, u * .42), P.butter, { seed: 'gt', font: /[(),]/.test(c.title) ? MONO : null, bold: true, wobble: .4 });
    var cy = H * .5;
    for (var i = 0; i < R * C; i++) {
      var r1 = Math.floor(i / C), c1 = i % C, r2 = Math.floor(i / C2), c2 = i % C2;
      var x1 = W / 2 + (c1 - (C - 1) / 2) * cw, y1 = cy + (r1 - (R - 1) / 2) * cell, x2 = W / 2 + (c2 - (C2 - 1) / 2) * cw, y2 = cy + (r2 - (R2 - 1) / 2) * cell;
      var x = lerp(x1, x2, move), y = lerp(y1, y2, move) - Math.sin(move * Math.PI) * cell * .35;
      var hi = -1; hl.forEach(function (h, k) { if (h[0] === r1 && h[1] === c1) hi = k; });
      var lit = hi >= 0 ? clamp((lt - .4 - hi * per) / .3, 0, 1) : 0, k = pop(lt, 0, 0);
      var colr = lit > 0 ? P.butter : [P.mint, P.sky, P.peach, P.lav][(r1 + c1) % 4];
      ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
      F.paper(ctx, 0, 0, cw * .92, cell * .9, colr, { seed: 'c' + i, lift: 2 + lit * 5 });
      var v = vals[r1] && vals[r1][c1]; if (v != null) textBlock(ctx, String(typeof v === 'number' ? fmt(v) : v), 0, 0, cw * .82, cell * .78, Math.max(11, Math.min(cell * .36, 28)), P.ink, { seed: 'v' + i });
      ctx.restore();
    }
    var lab = c.labels || {}, ls = Math.max(10, Math.min(u * .26, cell * .28)), la = 1 - move;
    if (la > .02) {
      ctx.save(); ctx.globalAlpha = la;
      (lab.rows || []).forEach(function (s, r) { if (r < R) F.hand(ctx, s, W / 2 - (C / 2) * cw - ls * .4, cy + (r - (R - 1) / 2) * cell, ls, P.butter, { seed: 'lr' + r, align: 'right' }); });
      (lab.cols || []).forEach(function (s, q) { if (q < C) F.hand(ctx, s, W / 2 + (q - (C - 1) / 2) * cw, cy - (R / 2) * cell - ls * 1.2, ls, P.butter, { seed: 'lc' + q }); });
      ctx.restore();
    }
    if (c.actor) narrator(ctx, c.actor, W, H, t, lt, c.dur, H * .97);
    topNote(ctx, c.note, W, H, lt);
  };
  S.graph = function (c, ctx, t, lt, W, H) {
    backdrop(ctx, W, H, t, c.setting || 'night');
    var u = unit(W, H), nodes = c.nodes || [], byId = {}, r = Math.max(14, Math.min(u * .5, 40));
    nodes.forEach(function (n) { byId[n.id] = n; });
    var P2 = function (n) { return [clamp(n.x == null ? .5 : n.x, .06, .94) * W, clamp(n.y == null ? .5 : n.y, .12, .8) * H]; };
    (c.edges || []).forEach(function (e, i) {
      var a = byId[e[0]], b = byId[e[1]]; if (!a || !b) return;
      var pa = P2(a), pb = P2(b), k = ease.out(clamp((lt - .6 - i * .3) / .7, 0, 1)); if (k <= 0) return;
      var d = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) || 1, ux = (pb[0] - pa[0]) / d, uy = (pb[1] - pa[1]) / d;
      var sx = pa[0] + ux * r, sy = pa[1] + uy * r, ex = pb[0] - ux * r * 1.1, ey = pb[1] - uy * r * 1.1;
      F.arrow(ctx, sx, sy, lerp(sx, ex, k), lerp(sy, ey, k), 'rgba(253,250,240,.85)', Math.max(2, u * .05), 'e' + i);
      if (e[2] && k >= 1) F.hand(ctx, e[2], (sx + ex) / 2 - uy * u * .3, (sy + ey) / 2 + ux * u * .3, Math.max(11, u * .24), P.butter, { seed: 'el' + i });
      if (c.flow && c.flow !== 'none' && k >= 1) {
        var ph = ((lt * .7 + i * .37) % 1), q = c.flow === 'backward' ? 1 - ph : ph;
        F.glow(ctx, lerp(sx, ex, q), lerp(sy, ey, q), u * .35, c.flow === 'backward' ? 'rgba(232,116,124,.9)' : 'rgba(247,227,160,.9)');
      }
    });
    nodes.forEach(function (n, i) {
      var p = P2(n), k = pop(lt, i, .18); if (k <= 0) return;
      ctx.save(); ctx.translate(p[0], p[1]); ctx.scale(k, k);
      F.blob(ctx, 0, 0, r, col(n.c, [P.mint, P.sky, P.peach, P.lav, P.pink][i % 5]), { seed: 'n' + n.id });
      textBlock(ctx, n.label || n.id, 0, 0, r * 1.7, r * 1.3, Math.max(10, r * .5), P.ink, { font: /[_()\[\]]/.test(n.label || '') ? MONO : null });
      ctx.restore();
    });
    if (c.actor) narrator(ctx, c.actor, W, H, t, lt, c.dur);
    topNote(ctx, c.note, W, H, lt);
  };
  S.bars = function (c, ctx, t, lt, W, H) {
    F.sky(ctx, W, H, P.night, P.night2); board(ctx, W, H, P.cream);
    var u = unit(W, H), L = c.labels || [], a = c.from || L.map(function () { return 0; }), b = c.to || a, n = Math.max(1, L.length || b.length);
    var mx = Math.max.apply(null, a.concat(b).map(function (v) { return Math.abs(+v || 0); }).concat([1e-9]));
    var k = ease.inOut(clamp((lt - c.dur * .3) / (c.dur * .35), 0, 1)), base = H * .74, top = H * .2, bw = Math.min(W * .7 / n, u * 1.4);
    if (c.title) F.hand(ctx, c.title, W / 2, H * .14, Math.max(14, u * .38), P.ink, { seed: 'bt' });
    ctx.strokeStyle = P.ink; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(W * .12, base); ctx.lineTo(W * .88, base); ctx.stroke();
    for (var i = 0; i < n; i++) {
      var v = lerp(+a[i] || 0, +b[i] || 0, k), h = Math.abs(v) / mx * (base - top) * .92, x = W / 2 + (i - (n - 1) / 2) * bw * 1.15, g = pop(lt, i, .1);
      if (h > 1) F.paper(ctx, x, base - (v >= 0 ? h / 2 : -h / 2), bw * .8, h * g, [P.orange, P.teal, P.lav, P.pink, P.green, P.sky][i % 6], { seed: 'b' + i, shadow: true });
      F.hand(ctx, fmt(v), x, base - (v >= 0 ? h : 0) - u * .22, Math.max(10, Math.min(u * .26, bw * .3)), P.ink, { seed: 'bv' + i, bold: false, font: MONO, wobble: 0 });
      if (L[i] != null) textBlock(ctx, String(L[i]), x, base + u * .4, bw * 1.05, u * .6, Math.max(10, Math.min(u * .26, bw * .3)), P.ink);
    }
    if (c.note) topNote(ctx, c.note, W, H, lt);
    if (c.actor) narrator(ctx, c.actor, W, H, t, lt, c.dur, H * .97);
  };
  S.compare = function (c, ctx, t, lt, W, H) {
    backdrop(ctx, W, H, t, c.setting || 'room');
    var u = unit(W, H), pw = W * .42, ph = H * .58, sides = [c.left || {}, c.right || {}];
    sides.forEach(function (s, i) {
      var x = W * (i ? .73 : .27), y = H * .42, k = pop(lt, i, .5); if (k <= 0) return;
      ctx.save(); ctx.translate(x, y); ctx.scale(k, k); ctx.rotate(i ? .012 : -.012);
      F.paper(ctx, 0, 0, pw, ph, col(s.c, i ? P.pink : P.mint), { seed: 'cmp' + i });
      if (s.title) textBlock(ctx, s.title, 0, -ph * .38, pw * .86, ph * .16, Math.max(14, u * .42), P.ink, { font: /[()_\[\]]/.test(s.title) ? MONO : null });
      var lines = s.lines || [], rv = clamp((lt - .8 - i * .8) / (c.dur * .4), 0, 1);
      lines.forEach(function (l, j) { var rr = clamp(rv * lines.length - j, 0, 1); if (rr > 0) textBlock(ctx, l, 0, -ph * .2 + (j + .5) * (ph * .64 / Math.max(1, lines.length)), pw * .86, ph * .64 / Math.max(1, lines.length), Math.max(11, u * .3), P.ink, { reveal: rr }); });
      ctx.restore();
    });
    if (c.verdict) {
      var kv = clamp((lt - c.dur * .62) / 1, 0, 1);
      if (kv > 0) { var f = fit(ctx, c.verdict, W * .8, u * 1.1, Math.max(13, u * .34)); F.note(ctx, f.lines.join('\n'), W / 2, H * .84, f.size, { color: P.butter, reveal: kv, seed: 'verd', rot: -.01 }); }
    }
    if (c.actor) narrator(ctx, c.actor, W, H, t, lt, c.dur);
    topNote(ctx, c.note, W, H, lt);
  };
  S.cards = function (c, ctx, t, lt, W, H) {
    backdrop(ctx, W, H, t, c.setting || 'dusk');
    var u = unit(W, H), items = c.items || [], n = Math.max(1, items.length), cw = Math.min(W * .86 / n, u * 3.4), ch = Math.min(H * .42, cw * 1.05);
    items.forEach(function (s, i) {
      var k = ease.back(clamp((lt - .3 - i * .7) / .7, 0, 1)); if (k <= 0) return;
      var x = W / 2 + (i - (n - 1) / 2) * cw * 1.06, y = lerp(H * 1.2, H * .44, k), rot = (i - (n - 1) / 2) * .05;
      ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
      F.paper(ctx, 0, 0, cw * .94, ch, [P.butter, P.mint, P.sky, P.pink][i % 4], { seed: 'card' + i });
      F.tape(ctx, 0, -ch / 2, Math.min(40, cw * .3), -.2);
      textBlock(ctx, s, 0, 0, cw * .8, ch * .8, Math.max(12, Math.min(u * .34, 22)), P.ink);
      ctx.restore();
    });
    if (c.actor) narrator(ctx, c.actor, W, H, t, lt, c.dur);
    topNote(ctx, c.note, W, H, lt);
  };
  // auto chapters
  S._title = function (c, ctx, t, lt, W, H) {
    backdrop(ctx, W, H, t, 'night');
    var u = unit(W, H), k = ease.back(clamp(lt / .8, 0, 1));
    ctx.save(); ctx.translate(W / 2, H * .38); ctx.scale(k, k); ctx.rotate(-.02);
    F.paper(ctx, 0, 0, Math.min(W * .86, u * 8), u * 2.3, P.cream, { seed: 'title' + id });
    textBlock(ctx, c.spec.title || c.node.label, 0, -u * .25, Math.min(W * .78, u * 7.4), u * 1.2, Math.min(u * .62, 40), P.ink);
    F.hand(ctx, (c.node.label || id) + (c.node.week_label ? '  ·  ' + c.node.week_label : ''), 0, u * .72, Math.max(12, u * .28), P.dusk, { seed: 'sub', font: MONO, bold: false, wobble: 0 });
    ctx.restore();
    F.tape(ctx, W / 2 - Math.min(W * .86, u * 8) * .38, H * .38 - u * 1.15, 44, -.35);
    F.stick(ctx, lerp(-u, W * .22, ease.out(clamp(lt / 2.2, 0, 1))), H * .86, Math.min(H * .28, u * 2), t, { pose: lt < 2.2 ? 'walk' : 'wave', t0: 2.2, color: P.chalk });
    if (c.spec.credit) F.hand(ctx, c.spec.credit, W / 2, H * .64, Math.max(11, u * .22), P.butter, { seed: 'cr', bold: false, reveal: clamp((lt - 1) / 1.5, 0, 1) });
  };
  S._map = function (c, ctx, t, lt, W, H) {
    backdrop(ctx, W, H, t, 'room');
    var u = unit(W, H), pairs = c.spec.map || [], n = Math.max(1, pairs.length), rowH = Math.min(H * .7 / n, u * 1.2);
    F.hand(ctx, 'story', W * .27, H * .1, Math.max(13, u * .34), P.butter, { seed: 'ms' }); F.hand(ctx, 'maths', W * .73, H * .1, Math.max(13, u * .34), P.butter, { seed: 'mm' });
    pairs.forEach(function (p, i) {
      var y = H * .2 + (i + .5) * rowH, k = pop(lt, i, .6), k2 = clamp((lt - .9 - i * .6) / .5, 0, 1); if (k <= 0) return;
      ctx.save(); ctx.translate(W * .27, y); ctx.scale(k, k); F.paper(ctx, 0, 0, W * .4, rowH * .8, P.mint, { seed: 'ml' + i, rot: -.01 }); textBlock(ctx, p[0], 0, 0, W * .36, rowH * .7, Math.max(10, u * .28), P.ink); ctx.restore();
      if (k2 > 0) {
        F.arrow(ctx, W * .48, y, lerp(W * .48, W * .52, k2), y, P.butter, 2.5, 'ma' + i);
        ctx.save(); ctx.globalAlpha = k2; F.paper(ctx, W * .73, y, W * .4, rowH * .8, P.peach, { seed: 'mr' + i, rot: .01 });
        textBlock(ctx, p[1], W * .73, y, W * .36, rowH * .7, Math.max(10, u * .28), P.ink, { font: /[_()=\[\]]/.test(p[1]) && p[1].length < 40 ? MONO : null }); ctx.restore();
      }
    });
  };

  /* ------------------------------------------------------------ codas */
  function panelHTML(cd) { return '<div class="nf-panel"><div class="nf-ttl">' + esc(cd.title || 'Your turn') + '</div><div class="nf-ctl"></div><div class="nf-read"></div></div>'; }
  function sliderRows(host, params, vals, onChange) {
    (params || []).forEach(function (p) {
      vals[p.id] = +p.value; var row = document.createElement('label'); row.className = 'nf-sl';
      row.innerHTML = '<span>' + esc(p.label || p.id) + '</span><input type="range" min="' + p.min + '" max="' + p.max + '" step="' + (p.step || (p.max - p.min) / 100) + '" value="' + p.value + '"><b></b>';
      var inp = row.querySelector('input'), out = row.querySelector('b'); out.textContent = fmt(+p.value);
      inp.oninput = function () { vals[p.id] = +inp.value; out.textContent = fmt(+inp.value); onChange(); };
      inp.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      host.appendChild(row);
    });
  }
  function readouts(host, list, vals, vars) {
    var fs = (list || []).map(function (r) { return { label: r.label, f: compile(r.f || '0', vars) }; });
    return function () { host.innerHTML = fs.map(function (r) { return '<span><i>' + esc(r.label) + '</i> ' + esc(fmt(r.f(vals))) + '</span>'; }).join(''); };
  }
  var CODA = {};
  CODA.sliders = function (cd) {
    var vals = {}, pids = (cd.params || []).map(function (p) { return p.id; }), fs, paint = function () {};
    return {
      caption: cd.caption,
      start: function (api, panel) {
        panel.innerHTML = panelHTML(cd); fs = (cd.curves || []).map(function (c, i) { return { f: compile(c.f || '0', ['x'].concat(pids)), c: col(c.c, [P.orange, P.teal, P.red, P.lav][i % 4]), label: c.label }; });
        paint = readouts(panel.querySelector('.nf-read'), cd.readouts, vals, pids);
        sliderRows(panel.querySelector('.nf-ctl'), cd.params, vals, function () { paint(); api.audio.blip(660); }); paint();
      },
      draw: function (ctx, t, W, H) {
        F.sky(ctx, W, H, P.night, P.night2); F.paper(ctx, W / 2, H / 2, W * .94, H * .9, P.cream, { seed: 'codab', rot: -.003 });
        var u = unit(W, H), box = { x: W * .1, y: H * .1, w: W * .8, h: H * .76 }, xr = cd.x || [-3, 3], yr = cd.y || [-1, 3], A = axes(ctx, box, xr, yr);
        (fs || []).forEach(function (c, i) {
          var v = {}; for (var k in vals) v[k] = vals[k]; var end = curve(ctx, c.f, v, xr, yr, A, box, c.c, 1, 3.4);
          if (c.label && end) F.hand(ctx, c.label, clamp(end[0] - u * .6, box.x + u, box.x + box.w - u), clamp(end[1] - u * .3 - i * u * .4, box.y + u * .3, box.y + box.h - u * .2), Math.max(12, u * .28), c.c, { seed: 'cl' + i });
        });
      }
    };
  };
  CODA.bars = function (cd) {
    var vals = {}, pids = (cd.params || []).map(function (p) { return p.id; }), f, paint = function () {}, shown = null;
    return {
      caption: cd.caption,
      start: function (api, panel) {
        panel.innerHTML = panelHTML(cd); f = compile(cd.f || '[]', pids);
        paint = readouts(panel.querySelector('.nf-read'), cd.readouts, vals, pids);
        sliderRows(panel.querySelector('.nf-ctl'), cd.params, vals, function () { paint(); api.audio.blip(520); }); paint();
      },
      draw: function (ctx, t, W, H, api, dt) {
        F.sky(ctx, W, H, P.night, P.night2); F.paper(ctx, W / 2, H / 2, W * .94, H * .9, P.cream, { seed: 'codab', rot: -.003 });
        var u = unit(W, H), L = cd.labels || [], arr = f ? f(vals) : []; if (!Array.isArray(arr)) arr = [];
        if (!shown || shown.length !== arr.length) shown = arr.map(function () { return 0; });
        shown = shown.map(function (s, i) { var v = +arr[i]; return isFinite(v) ? lerp(s, v, Math.min(1, (dt || .016) * 10)) : s; });
        var yr = cd.y || [0, Math.max(1e-9, Math.max.apply(null, arr.map(Number).filter(isFinite).concat([1])))], n = Math.max(1, arr.length), base = H * .8, top = H * .14, bw = Math.min(W * .76 / n, u * 1.5);
        var Y = function (v) { return base - (clamp(v, yr[0], yr[1]) - Math.max(0, yr[0])) / (yr[1] - yr[0]) * (base - top); };
        ctx.strokeStyle = P.ink; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(W * .08, Y(Math.max(yr[0], 0))); ctx.lineTo(W * .92, Y(Math.max(yr[0], 0))); ctx.stroke();
        shown.forEach(function (v, i) {
          var x = W / 2 + (i - (n - 1) / 2) * bw * 1.12, y0 = Y(Math.max(yr[0], 0)), y1 = Y(v), h = Math.abs(y0 - y1);
          if (h > 1) F.paper(ctx, x, (y0 + y1) / 2, bw * .82, h, [P.orange, P.teal, P.lav, P.pink, P.green, P.sky][i % 6], { seed: 'cb' + i, jit: .6 });
          F.hand(ctx, fmt(+arr[i]), x, Math.min(y0, y1) - u * .22, Math.max(10, Math.min(u * .26, bw * .32)), P.ink, { seed: 'cbv' + i, font: MONO, bold: false, wobble: 0 });
          if (L[i] != null) textBlock(ctx, String(L[i]), x, base + u * .38, bw * 1.08, u * .6, Math.max(10, Math.min(u * .26, bw * .3)), P.ink);
        });
      }
    };
  };
  CODA.grid = function (cd) {
    var R = clamp(cd.rows || 4, 1, 8), C = clamp(cd.cols || 4, 1, 8), G = [], paint = function () {}, geo = null, init = compile(String(cd.init == null ? '0' : cd.init), ['r', 'c']), aud = null;
    function reset() { G = []; for (var r = 0; r < R; r++) { var row = []; for (var c = 0; c < C; c++) { var v = +init({ r: r, c: c }); row.push(isFinite(v) ? v : 0); } G.push(row); } }
    return {
      caption: cd.caption,
      start: function (api, panel) {
        aud = api.audio; reset(); panel.innerHTML = panelHTML(cd);
        var vals = { G: G }, fs = (cd.readouts || []).map(function (r) { return { label: r.label, f: compile(r.f || '0', ['G']) }; }), host = panel.querySelector('.nf-read');
        paint = function () { host.innerHTML = fs.map(function (r) { return '<span><i>' + esc(r.label) + '</i> ' + esc(fmt(r.f({ G: G }))) + '</span>'; }).join(''); };
        var b = document.createElement('button'); b.textContent = 'Reset'; b.onclick = function (e) { e.stopPropagation(); reset(); paint(); }; panel.querySelector('.nf-ctl').appendChild(b); paint();
      },
      draw: function (ctx, t, W, H) {
        F.sky(ctx, W, H, P.night, P.night2);
        var u = unit(W, H), cell = Math.min(W * .86 / C, H * .84 / R), x0 = W / 2 - C * cell / 2, y0 = H / 2 - R * cell / 2; geo = { x0: x0, y0: y0, cell: cell };
        var mx = 1; G.forEach(function (row) { row.forEach(function (v) { mx = Math.max(mx, Math.abs(v)); }); });
        for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) {
          var v = G[r][c], on = v !== 0, cc = on ? (v < 0 ? P.pink : (cd.click === 'inc' && mx > 1 ? (v / mx > .6 ? P.orange : P.butter) : P.butter)) : [P.mint, P.sky][(r + c) % 2];
          F.paper(ctx, x0 + (c + .5) * cell, y0 + (r + .5) * cell, cell * .88, cell * .88, cc, { seed: 'g' + r + '_' + c, lift: on ? 6 : 2 });
          if (cd.click === 'inc' || (v !== 0 && v !== 1)) F.hand(ctx, fmt(v), x0 + (c + .5) * cell, y0 + (r + .5) * cell, Math.max(11, cell * .32), P.ink, { seed: 'gv', wobble: 0, font: MONO, bold: false });
        }
      },
      down: function (x, y) {
        if (!geo) return; var c = Math.floor((x - geo.x0) / geo.cell), r = Math.floor((y - geo.y0) / geo.cell);
        if (r < 0 || c < 0 || r >= R || c >= C) return;
        if (cd.click === 'inc') G[r][c] = (G[r][c] + 1) % 4; else G[r][c] = G[r][c] ? 0 : 1;
        if (aud) aud.blip(440 + 60 * (r + c)); paint();
      }
    };
  };
  CODA.match = function (cd) {
    var pairs = (cd.pairs || []).slice(0, 6), L = [], Rt = [], sel = -1, done = {}, boxes = [], aud = null, flash = null, status = null;
    function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
    function reset() { L = shuffle(pairs.map(function (p, i) { return i; })); Rt = shuffle(pairs.map(function (p, i) { return i; })); sel = -1; done = {}; if (status) status(); }
    return {
      caption: cd.caption,
      start: function (api, panel) {
        aud = api.audio; panel.innerHTML = panelHTML(cd); var host = panel.querySelector('.nf-read');
        status = function () { var n = Object.keys(done).length; host.innerHTML = '<span><i>matched</i> ' + n + ' / ' + pairs.length + (n === pairs.length ? ' · all joined' : '') + '</span>'; };
        var b = document.createElement('button'); b.textContent = 'Shuffle again'; b.onclick = function (e) { e.stopPropagation(); reset(); }; panel.querySelector('.nf-ctl').appendChild(b);
        reset();
      },
      draw: function (ctx, t, W, H) {
        backdrop(ctx, W, H, t, 'room');
        var u = unit(W, H), n = Math.max(1, pairs.length), rh = Math.min(H * .9 / n, u * 1.5), cw = W * .44; boxes = [];
        [L, Rt].forEach(function (col_, side) {
          col_.forEach(function (pi, row) {
            var x = W * (side ? .745 : .255), y = H * .06 + (row + .5) * rh, isSel = side === 0 && sel === pi, ok = done[pi];
            boxes.push({ side: side, pi: pi, x: x - cw / 2, y: y - rh * .42, w: cw, h: rh * .84 });
            var c = ok ? P.green : isSel ? P.butter : side ? P.peach : P.mint;
            if (flash && flash.pi === pi && flash.side === side && t - flash.t < .4) { ctx.save(); ctx.translate(Math.sin((t - flash.t) * 60) * 5, 0); }
            F.paper(ctx, x, y, cw * .96, rh * .84, c, { seed: 'm' + side + pi, lift: isSel ? 8 : 3 });
            textBlock(ctx, pairs[pi][side], x, y, cw * .86, rh * .74, Math.max(10, Math.min(u * .3, 20)), P.ink);
            if (flash && flash.pi === pi && flash.side === side && t - flash.t < .4) ctx.restore();
          });
        });
        this._t = t;
      },
      down: function (x, y) {
        var hit = null; boxes.forEach(function (b) { if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) hit = b; });
        if (!hit || done[hit.pi]) return;
        if (hit.side === 0) { sel = hit.pi; if (aud) aud.blip(700); return; }
        if (sel < 0) { flash = { pi: hit.pi, side: 1, t: this._t || 0 }; return; }
        if (hit.pi === sel) { done[sel] = 1; sel = -1; if (aud) aud.blip(990); status(); }
        else { flash = { pi: hit.pi, side: 1, t: this._t || 0 }; if (aud) aud.blip(220); }
      }
    };
  };

  /* ------------------------------------------------------------ page */
  var CSS = '#ifilm .nf-panel{display:flex;flex-direction:column;gap:6px;padding:4px 10px 2px}' +
    '#ifilm .nf-ttl{font:700 15px ' + HAND + ';color:#f7e3a0}' +
    '#ifilm .nf-ctl{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center}' +
    '#ifilm .nf-sl{display:flex;align-items:center;gap:8px;flex:1 1 220px;min-width:0;font-size:13px}#ifilm .nf-sl span{flex:none;max-width:40%;color:#fbf6ea}#ifilm .nf-sl input{flex:1;min-width:80px}#ifilm .nf-sl b{font:600 12px ' + MONO + ';color:#f7e3a0;min-width:44px;text-align:right}' +
    '#ifilm .nf-read{display:flex;flex-wrap:wrap;gap:4px 12px;font:600 12.5px ' + MONO + ';color:#b9e3cc}#ifilm .nf-read i{font-style:normal;color:#b8bcd8;font-family:system-ui,sans-serif;font-weight:400}' +
    '#ifilm details.nf-ham{margin:4px 10px 0;font-size:13px;color:#e6e2d6}#ifilm details.nf-ham summary{cursor:pointer;color:#f7e3a0;font-weight:600}#ifilm details.nf-ham p{margin:4px 0}' +
    '#ifilm .dimp{display:inline-flex;gap:2px;padding:2px;background:#1b1e25;border:1px solid #2f343e;border-radius:999px;flex:none}' +
    '#ifilm .dimp span,#ifilm .dimp a{font:600 12.5px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:7px 10px;border-radius:999px;color:#9aa2b1;text-decoration:none}' +
    '#ifilm .dimp [aria-current]{background:#8fa8ff;color:#1b1e25}@media (max-width:420px){#ifilm .dimp span,#ifilm .dimp a{padding:7px 7px}#ifilm .nf-sl span{max-width:46%}}';

  function missing(msg) {
    document.body.innerHTML = '<div style="font:16px system-ui;color:#fbf6ea;background:#1c2140;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px">' +
      '<div><p>' + esc(msg) + '</p><p><a style="color:#f7e3a0" href="index.html#concepts">Every concept film</a> · <a style="color:#f7e3a0" href="../index.html#map">Concept map</a></p></div></div>';
  }
  function go(spec, node) {
    if (spec.linked_film && !(spec.chapters && spec.chapters.length)) { location.replace(spec.linked_film + (location.hash || '')); return; }
    document.title = (spec.title || node.label || id) + ' · TARA films';
    var chapters = [], t0 = 0;
    function add(c, draw) { var d = clamp(+c.dur || 9, 4, 16); chapters.push({ name: c.name || '', need: c.need || spec.need, start: t0, dur: d, cap: c.cap || {}, draw: draw }); t0 += d; }
    var tc = { spec: spec, node: node, dur: 4.5 };
    add({ name: 'Title', dur: 4.5, need: spec.need, cap: { 1: esc(node.plain || spec.allegory || ''), 2: esc(spec.allegory || node.plain || ''), 3: esc(spec.allegory || '') + (spec.credit ? ' <i>' + esc(spec.credit) + '</i>' : '') } }, function (ctx, t, lt, W, H) { S._title(tc, ctx, t, lt, W, H); });
    var list = (spec.chapters || []).slice(0, 9), mapAt = Math.max(1, list.length - 1);
    list.forEach(function (c, i) {
      if (i === mapAt && spec.map && spec.map.length) {
        var mc = { spec: spec };
        add({ name: 'The mapping', dur: Math.min(12, 4 + spec.map.length * 1.3), need: 'core', cap: { 1: 'Every part of the story stands for one part of the maths.', 2: esc(spec.allegory || ''), 3: 'Story on the left, the maths it stands for on the right. ' + esc(spec.allegory || '') } }, function (ctx, t, lt, W, H) { S._map(mc, ctx, t, lt, W, H); });
      }
      var fn = S[c.type] || S.story;
      c.dur = clamp(+c.dur || 9, 4, 16);
      add(c, function (ctx, t, lt, W, H) { fn(c, ctx, t, lt, W, H); });
    });
    var cd = spec.coda || {}, maker = CODA[cd.type] || null, coda = maker ? maker(cd) : null;
    var links = [];
    var objHref = spec.linked_object ? '../objects/' + spec.linked_object : (spec.object ? '../objects/node.html?id=' + encodeURIComponent(id) : null);
    if (objHref) links.push({ label: 'Hold it in 3D', href: objHref });
    links.push({ label: 'On the concept map', href: '../index.html#map/node=' + encodeURIComponent(id) });
    if (spec.linked_film) links.push({ label: 'The long film', href: spec.linked_film });
    if (node.week) links.push({ label: 'Week ' + node.week + ' pack', href: '../index.html#week-' + (node.week < 10 ? '0' : '') + node.week });
    if (spec._case) links.push({ label: 'Case study', href: '../index.html#cases/' + spec._case });
    var film = F.play({ title: spec.title || node.label, back: 'index.html#concepts', chapters: chapters, coda: coda, links: links });
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    // opened from the app (the concept map's node panel): the back link returns to that node on the map
    try {
      var ref = document.referrer ? new URL(document.referrer) : null, bk = film.root.querySelector('.top a.back');
      if (bk && ref && ref.origin === location.origin && !/\/(intuition|objects)\//.test(ref.pathname)) { bk.href = '../index.html#map/node=' + encodeURIComponent(id); bk.innerHTML = '&larr; map'; }
    } catch (e) {}
    // 2D | 3D pill
    if (objHref) {
      var top = film.root.querySelector('.top'), pill = document.createElement('div'); pill.className = 'dimp'; pill.setAttribute('role', 'group'); pill.setAttribute('aria-label', 'View in 2D or 3D');
      pill.innerHTML = '<span aria-current="page">2D</span><a href="' + esc(objHref) + '" title="Hold this idea in 3D">3D</a>'; top.appendChild(pill);
    }
    // Hamming card + where else, in the coda panel
    var ham = spec.hamming || {}, we = spec.where_else || [];
    if (ham.what || we.length) {
      var d = document.createElement('details'); d.className = 'nf-ham';
      d.innerHTML = '<summary>What, when, why, and where else</summary>' + (ham.what ? '<p><b>What:</b> ' + esc(ham.what) + '</p>' : '') + (ham.when ? '<p><b>When:</b> ' + esc(ham.when) + '</p>' : '') + (ham.why ? '<p><b>Why:</b> ' + esc(ham.why) + '</p>' : '') +
        (we.length ? '<p><b>Where else:</b> ' + we.map(esc).join(' · ') + '</p>' : '') + (spec.credit ? '<p><i>' + esc(spec.credit) + '</i></p>' : '');
      var codaBox = film.root.querySelector('.coda'); codaBox.insertBefore(d, codaBox.querySelector('.links'));
    }
    try { var seen = JSON.parse(localStorage.getItem('tara.films.nodes') || '{}'); seen[id] = Date.now(); localStorage.setItem('tara.films.nodes', JSON.stringify(seen)); } catch (e) {}
  }
  if (!/^[a-z0-9-]+$/.test(id)) { missing('No concept named.'); return; }
  Promise.all([
    fetch('nodes/' + id + '.json').then(function (r) { if (!r.ok) throw new Error('missing'); return r.json(); }),
    fetch('nodes/index.json').then(function (r) { return r.ok ? r.json() : { nodes: [] }; }).catch(function () { return { nodes: [] }; })
  ]).then(function (res) {
    var spec = res[0], idx = res[1], node = ((idx && idx.nodes) || []).filter(function (n) { return n.id === id; })[0] || { id: id, label: spec.title };
    if (node.case) spec._case = node.case;
    go(spec, node);
  }).catch(function () { missing('This concept’s film is still being written. It will appear here soon.'); });
})();
