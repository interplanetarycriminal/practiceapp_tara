/* Node objects: the 3D twin of every concept-map node, drawn with the Object Lessons
   kit from the "object" block of intuition/nodes/<id>.json.
   Spec format: /mnt/project-files/node-films/SPEC.md. Page: objects/node.html?id=<concept id>. */
import { run, THREE, K, C } from './kit.js';

const id = new URLSearchParams(location.search).get('id') || '';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const HX = {
  relu: (v) => (v > 0 ? v : 0), sigmoid: (v) => 1 / (1 + Math.exp(-v)), tanh: Math.tanh, exp: Math.exp, log: Math.log,
  sqrt: Math.sqrt, abs: Math.abs, pow: Math.pow, max: Math.max, min: Math.min, floor: Math.floor, round: Math.round,
  sin: Math.sin, cos: Math.cos, clamp: (v, a, b) => (v < a ? a : v > b ? b : v),
  softmax: (a) => { const m = Math.max(...a), e = a.map((v) => Math.exp(v - m)), s = e.reduce((p, q) => p + q, 0); return e.map((v) => v / s); },
  sum: (a) => a.reduce((p, q) => p + (+q || 0), 0), mean: (a) => (a.length ? HX.sum(a) / a.length : 0),
  dot: (a, b) => a.reduce((s, v, i) => s + v * (b[i] || 0), 0), norm: (a) => Math.sqrt(HX.dot(a, a)),
  range: (n) => Array.from({ length: n }, (_, i) => i), PI: Math.PI, E: Math.E,
};
const HK = Object.keys(HX);
function compile(expr, vars) {
  let fn = null;
  try { fn = new Function(...HK, ...vars, `"use strict";return (${expr});`); } catch (e) { console.warn('bad expression', expr, e); }
  return (vals) => {
    if (!fn) return NaN;
    try { return fn(...HK.map((k) => HX[k]), ...vars.map((v) => vals[v])); } catch (e) { return NaN; }
  };
}
const colour = (n, fb = C.data) => C[n] || (typeof n === 'string' && n[0] === '#' ? n : fb);
const V3 = (p) => (Array.isArray(p) ? new THREE.Vector3(p[0], p[1], p[2]) : p);
const VIEWS = {
  iso: { pos: [4.2, 3.2, 5.2], target: [0, 0.7, 0] },
  front: { pos: [0, 1.4, 7], target: [0, 0.7, 0] },
  top: { pos: [0.01, 8, 0.6], target: [0, 0, 0] },
  side: { pos: [7, 1.4, 0.01], target: [0, 0.7, 0] },
  close: { pos: [2.4, 2.4, 3], target: [0, 0.8, 0], fit: 0.7 },
};
const LIFT = 1.35;   // points and graphs float above the plinth
const toW = (p) => new THREE.Vector3(+p[0] || 0, (+p[1] || 0) + LIFT, +p[2] || 0);

function missing(msg) {
  document.body.innerHTML = `<div style="font:16px system-ui;color:#2b2a33;background:#f2ede4;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px"><div><p>${esc(msg)}</p><p><a href="index.html#concepts">Every concept object</a> · <a href="../index.html#map">Concept map</a></p></div></div>`;
}
function clearGroup(g) {
  while (g.children.length) {
    const c = g.children.pop();
    c.traverse?.((m) => { m.geometry?.dispose?.(); });
  }
}

/* ---------------------------------------------------------------- kinds */
const KINDS = {};

KINDS.surface = (o, kid) => {
  const f = compile(o.f || '0', ['x', 'y', ...kid]);
  const xr = o.x || [-2, 2], yr = o.y || [-2, 2];
  return {
    rebuild(S) {
      const st = S.state; const vals = { ...S.knobs };
      if (st.hf) { S.root.remove(st.hf.mesh); st.hf.dispose?.(); }
      const fn = (x, y) => { vals.x = x; vals.y = y; const v = f(vals); return Number.isFinite(v) ? v : 0; };
      st.hf = K.heightfield(fn, { x: xr, y: yr, n: 64, height: 1.3, contours: true });
      S.root.add(st.hf.mesh);
      (st.marks || []).forEach((l) => l.remove()); st.marks = [];
      for (const m of o.marks || []) st.marks.push(K.label(V3(st.hf.toWorld(m.x, m.y, 0.08)), m.label || '', { cls: 'note' }));
      if (o.ball) {
        const lr = typeof o.ball.lr === 'string' ? +S.knobs[o.ball.lr] : +o.ball.lr || 0.1;
        const steps = Math.min(400, o.ball.steps || 60), h = 1e-3, path = [];
        let x = +o.ball.x || 0, y = +o.ball.y || 0;
        for (let i = 0; i <= steps; i++) {
          path.push([x, y]);
          const gx = (fn(x + h, y) - fn(x - h, y)) / (2 * h), gy = (fn(x, y + h) - fn(x, y - h)) / (2 * h);
          x = Math.min(xr[1], Math.max(xr[0], x - lr * gx)); y = Math.min(yr[1], Math.max(yr[0], y - lr * gy));
        }
        st.path = path.map(([a, b]) => V3(st.hf.toWorld(a, b, 0.06)));
        if (!st.ball) { st.ball = K.bead([0, 0, 0], C.grad, 0.075); S.root.add(st.ball); }
        else S.root.add(st.ball);
        if (st.trail) S.root.remove(st.trail.mesh);
        st.trail = K.tube(st.path.slice(0, 2), C.grad, 0.018); S.root.add(st.trail.mesh);
        st.t = 0;
        if (st.ballLabel) st.ballLabel.remove();
        st.ballLabel = K.label(st.ball, { 1: 'you, rolling downhill', 2: 'the parameters', 3: 'θ_t' }, { cls: 'readout', dy: -8 });
      }
    },
    frame(S, t, dt) {
      const st = S.state; if (!st.path) return false;
      st.t = Math.min(st.path.length - 1, (st.t || 0) + dt * 14 * (S.shot ? 100 : 1));
      const i = Math.floor(st.t), k = st.t - i, a = st.path[i], b = st.path[Math.min(i + 1, st.path.length - 1)];
      st.ball.position.lerpVectors(a, b, k);
      st.trail.set(st.path.slice(0, i + 1).concat([st.ball.position.clone()]));
      return st.t < st.path.length - 1;
    },
  };
};

KINDS.bars = (o, kid) => {
  const R = Math.max(1, Math.min(12, o.rows || 3)), Cc = Math.max(1, Math.min(12, o.cols || 3));
  const f = o.f ? compile(o.f, ['r', 'c', 'rows', 'cols', ...kid]) : null;
  const size = Math.min(3.2 / Cc, 3.2 / R), g = new THREE.Group();
  return {
    rebuild(S) {
      const st = S.state; if (!st.bars) {
        S.root.add(g); st.bars = [];
        for (let r = 0; r < R; r++) for (let c = 0; c < Cc; c++) {
          const m = new THREE.Mesh(new THREE.BoxGeometry(size * 0.78, 1, size * 0.78), K.mat.paint(colour(o.c)));
          m.castShadow = true; m.receiveShadow = true;
          m.position.set((c - (Cc - 1) / 2) * size, 0.5, (r - (R - 1) / 2) * size); g.add(m); st.bars.push({ m, r, c });
        }
        st.labels = [];
        (o.labels?.rows || []).slice(0, R).forEach((s, r) => st.labels.push(K.label([-(Cc / 2) * size - 0.25, 0.05, (r - (R - 1) / 2) * size], s, { cls: 'tag', anchor: 'right' })));
        (o.labels?.cols || []).slice(0, Cc).forEach((s, c) => st.labels.push(K.label([(c - (Cc - 1) / 2) * size, 0.05, (R / 2) * size + 0.25], s, { cls: 'tag', anchor: 'top' })));
      }
      const vals = { ...S.knobs, rows: R, cols: Cc };
      const hs = st.bars.map(({ r, c }) => { vals.r = r; vals.c = c; const v = f ? f(vals) : +(o.values?.[r]?.[c] ?? 0); return Number.isFinite(v) ? v : 0; });
      const mx = Math.max(1e-9, ...hs.map(Math.abs));
      st.bars.forEach((b, i) => {
        const h = Math.max(0.02, (Math.abs(hs[i]) / mx) * 1.7);
        b.target = h; b.neg = hs[i] < 0;
        // taller bars are painted deeper, so the pattern reads from any angle
        const base = new THREE.Color(b.neg ? C.grad : colour(o.c)), pale = new THREE.Color('#e9e1d2');
        b.m.material.dispose?.();
        b.m.material = K.mat.paint('#' + pale.lerp(base, 0.35 + 0.65 * (h / 1.7)).getHexString());
        if (S.first || S.shot) { b.m.scale.y = h; b.m.position.y = h / 2; }
      });
    },
    frame(S) {
      let moving = false;
      for (const b of S.state.bars || []) {
        const d = b.target - b.m.scale.y; if (Math.abs(d) > 1e-3) { moving = true; b.m.scale.y += d * 0.2; b.m.position.y = b.m.scale.y / 2; }
      }
      return moving;
    },
  };
};

KINDS.blocks = (o, kid) => {
  const items = (o.items || []).slice(0, 10), n = Math.max(1, items.length), gap = Math.min(0.6, Math.max(0.1, o.gap ?? 0.25));
  const w = Math.min(0.7, (3.6 - gap * (n - 1)) / n), axisY = o.axis === 'y';
  return {
    rebuild(S) {
      const st = S.state; if (st.built) return; st.built = true; st.blocks = [];
      let yAcc = 0; const centres = [];
      items.forEach((it, i) => {
        const h = Math.max(0.15, Math.min(2, +it.h || 0.6));
        const m = new THREE.Mesh(new THREE.BoxGeometry(axisY ? 1.6 : w, axisY ? Math.min(h, 0.45) : h, axisY ? 1.2 : 1.0), K.mat.paint(colour(it.c, C.plaster)));
        m.castShadow = true; m.receiveShadow = true;
        if (axisY) { const hh = Math.min(h, 0.45); m.position.set(0, yAcc + hh / 2, 0); centres.push([0, yAcc + hh / 2, 0.65]); st.blocks.push(m); yAcc += hh + gap * 0.5; }
        else { const x = (i - (n - 1) / 2) * (w + gap); m.position.set(x, h / 2, 0); centres.push([x, 0.35, 0.55]); st.blocks.push(m); }
        S.root.add(m);
        const top = axisY ? [0.95, m.position.y, 0] : [m.position.x, h + 0.05, 0];
        K.label(top, it.label || '', { cls: 'note', anchor: axisY ? 'left' : 'bottom', prio: 2 });
      });
      if (o.stream && centres.length > 1) {
        const pts = axisY ? [[0, -0.05, 0.7], ...centres.map((c) => [c[0], c[1], 0.7]), [0, yAcc + 0.2, 0.7]]
          : [[centres[0][0] - 0.6, 0.35, 0.55], ...centres, [centres[centres.length - 1][0] + 0.6, 0.35, 0.55]];
        st.stream = pts.map(V3);
        const tube = K.tube(st.stream, C.data, 0.035); S.root.add(tube.mesh);
        st.pulse = K.bead(pts[0], C.prob, 0.07); S.root.add(st.pulse);
      }
    },
    frame(S, t) {
      const st = S.state; if (!st.stream) return false;
      const L = st.stream.length - 1, u = ((t * 0.25) % 1) * L, i = Math.floor(u);
      st.pulse.position.lerpVectors(st.stream[i], st.stream[Math.min(i + 1, L)], u - i);
      return !S.shot;
    },
  };
};

KINDS.points = (o) => {
  return {
    rebuild(S) {
      const st = S.state; if (st.built) return; st.built = true;
      const rnd = K.rng(7);
      const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
      const at = {};   // arrows may name a cluster by its label instead of giving coordinates
      for (const cl of (o.clusters || []).slice(0, 6)) {
        if (cl.label) at[cl.label] = cl.center || [0, 0, 0];
        const n = Math.max(1, Math.min(60, cl.n || 24)), sp = Math.min(1, Math.max(0.02, cl.spread ?? 0.25)), c0 = cl.center || [0, 0, 0];
        for (let i = 0; i < n; i++) {
          const b = K.bead(toW([c0[0] + gauss() * sp, c0[1] + gauss() * sp, c0[2] + gauss() * sp]), colour(cl.c), 0.05); S.root.add(b);
        }
        if (cl.label) K.label(toW([c0[0], c0[1] + sp * 2 + 0.15, c0[2]]), cl.label, { cls: 'note', prio: 2 });
      }
      const pt = (v, fb) => (typeof v === 'string' ? at[v] || fb : Array.isArray(v) ? v : fb);
      for (const a of (o.arrows || []).slice(0, 6)) {
        const A = pt(a.from, [0, 0, 0]), B = pt(a.to, [1, 0, 0]);
        const ar = K.arrow(toW(A), toW(B), colour(a.c, C.dir), { r: 0.03 }); S.root.add(ar.group);
        if (a.label) K.label(toW([(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2]), a.label, { cls: 'readout', dy: -6 });
      }
      if (o.plane) {
        const nrm = new THREE.Vector3(...(o.plane.normal || [0, 1, 0])).normalize();
        const m = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 2.8), K.mat.glass(C.aux, 0.14));
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), nrm); m.position.set(0, LIFT, 0); S.root.add(m);
        if (o.plane.label) K.label(new THREE.Vector3(1.3, LIFT, 0), o.plane.label, { cls: 'tag' });
      }
      // a floor post so the cloud reads as sitting on the plinth
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, LIFT - 0.3, 8), K.mat.brass()); post.position.set(0, (LIFT - 0.3) / 2, 0); S.root.add(post);
    },
  };
};

KINDS.graph = (o) => {
  return {
    rebuild(S) {
      const st = S.state; if (st.built) return; st.built = true;
      const byId = {}; st.edges = [];
      (o.nodes || []).slice(0, 16).forEach((n, i) => {
        const p = toW(n.pos || [0, 0, 0]); byId[n.id] = p;
        const b = K.bead(p, colour(n.c, [C.data, C.good, C.prob, C.dir, C.aux][i % 5]), 0.13); S.root.add(b);
        K.label(p, n.label || n.id, { cls: 'note', dy: -12, prio: 2 });
      });
      for (const e of (o.edges || []).slice(0, 30)) {
        const a = byId[e[0]], b = byId[e[1]]; if (!a || !b) continue;
        const tube = K.tube([a, b], C.ink, 0.014); S.root.add(tube.mesh); st.edges.push([a, b]);
      }
      if (o.flow && st.edges.length) {
        st.pulses = st.edges.map(() => { const p = K.bead([0, 0, 0], C.prob, 0.045); S.root.add(p); return p; });
      }
    },
    frame(S, t) {
      const st = S.state; if (!st.pulses) return false;
      st.pulses.forEach((p, i) => { const [a, b] = st.edges[i]; p.position.lerpVectors(a, b, (t * 0.5 + i * 0.37) % 1); });
      return !S.shot;
    },
  };
};

/* ---------------------------------------------------------------- page */
async function main() {
  if (!/^[a-z0-9-]+$/.test(id)) return missing('No concept named.');
  let spec, idx;
  try { spec = await (await fetch(`../intuition/nodes/${id}.json`)).json(); } catch (e) { return missing('This concept’s 3D twin is still being made. It will appear here soon.'); }
  try { idx = await (await fetch('../intuition/nodes/index.json')).json(); } catch (e) { idx = { nodes: [] }; }
  const node = (idx.nodes || []).find((n) => n.id === id) || { id, label: spec.title };
  const o = spec.object;
  if (!o) { if (spec.linked_object) { location.replace(spec.linked_object); return; } return missing('This concept has no 3D twin yet.'); }
  const knobs = (o.knobs || []).slice(0, 3).map((k) => ({ id: k.id, type: 'range', label: k.label || k.id, min: +k.min, max: +k.max, step: k.step ?? 'any', value: +k.value }));
  const kid = knobs.map((k) => k.id);
  const impl = (KINDS[o.kind] || KINDS.blocks)(o, kid);
  const filmHref = spec.linked_film && !(spec.chapters && spec.chapters.length) ? `../intuition/${spec.linked_film}` : `../intuition/node.html?id=${id}`;
  const links = [{ label: 'Watch the film (2D)', href: filmHref }, { label: 'On the concept map', href: `../index.html#map/node=${id}` }];
  if (node.week) links.push({ label: `Week ${node.week} pack`, href: `../index.html#week-${String(node.week).padStart(2, '0')}` });
  if (node.case) links.push({ label: 'Case study', href: `../index.html#cases/${node.case}` });
  document.title = `${o.title || spec.title} · Object Lessons`;
  const beats = (o.beats || []).slice(0, 8).map((b) => ({
    tag: spec.need || 'core', cap: b.cap || '', cam: VIEWS[b.view] || VIEWS.iso,
    set: Object.fromEntries(Object.entries(b.set || {}).filter(([k]) => kid.includes(k))),
  }));
  if (!beats.length) beats.push({ tag: spec.need || 'core', cap: spec.allegory || '', cam: VIEWS.iso });
  run({
    id: `node-${id}`, num: node.week_label || (node.section || '').replace(/[\[\]]/g, '') || '·', week: node.week || 0, kind: 'deep',
    title: o.title || spec.title, subtitle: o.subtitle || spec.allegory || '',
    back2d: `#map/node=${id}`, film: filmHref,
    knobs, beats,
    predict: (o.predict || []).slice(0, 4).map((p) => ({ q: p.q, options: (p.options || []).map((x) => ({ t: x.t, ok: !!x.ok })), why: p.why || '' })),
    where: o.where || (spec.where_else || []).join(' · '),
    links, credit: spec.credit ? `${spec.credit} · Built with three.js and JSCAD.` : 'Built with three.js and JSCAD.',
    remix: `A 3D object for "${node.label}": ${o.title}. ${o.subtitle || ''} Story: ${spec.allegory || ''}`,
    setup(S) { S.state = S.state || {}; },
    rebuild(S) { try { impl.rebuild(S); } catch (e) { console.error(e); } },
    frame(S, t, dt) { try { return impl.frame ? impl.frame(S, t, dt) : false; } catch (e) { console.error(e); return false; } },
  });
  // the 2D side of this object is its film, not a week page
  requestAnimationFrame(() => { const a = document.querySelector('.dim-toggle a'); if (a) { a.href = filmHref; a.title = 'Watch this idea as a film (2D)'; } });
  try { const seen = JSON.parse(localStorage.getItem('tara.objects.nodes') || '{}'); seen[id] = Date.now(); localStorage.setItem('tara.objects.nodes', JSON.stringify(seen)); } catch (e) { /* private mode */ }
}
main();
