/* =============================================================================
   Object Lessons · objects/minis.js · one miniature per object for the Model Room
   -----------------------------------------------------------------------------
   import J from './vendor/jscad.js';
   import { minis, MINI_BOX } from './minis.js';
   const { geoms, size } = minis['w03-ravine'](J);
   // geoms: [{ geom: JSCAD geom3, color: '#rrggbb', mat: 'plaster' | 'paint' | 'brass' }]
   //        one entry per colour (parts of the same colour are already merged: few draw calls)
   // size:  [w, h, d] after fitting, in world units

   Each miniature is a small iconic sculpture of its object: plaster body, brass trim and at most
   two semantic accent colours (C in DESIGN.md), so colour means the same thing in the hub as on
   the object pages. Size and axes: see MINI_BOX. Deterministic (seeded, no Math.random).
   Low poly: every mini is under 3,000 triangles (fan-triangulated JSCAD polygons).
   Every polygon is convex, so a fan triangulation (as kit.js and the STL writer do) is exact.
   Nothing is imported here; the caller passes the @jscad/modeling namespace J.
============================================================================= */

export const MINI_BOX = Object.freeze({
  // Axes are three.js world axes: y is UP, the visitor stands at +z.
  axes: 'y-up',
  front: '+z',
  // Every mini is scaled to FILL its box: the larger footprint side is 0.96 or the height is
  // 0.98 x box height (whichever binds first), centred on x = z = 0, standing on y = 0.
  box: [1, 1, 1],                          // w (x), h (y), d (z)
  x: [-0.5, 0.5], y: [0, 1], z: [-0.5, 0.5],
  tall: { 'north-machine': [1, 2.2, 1] },  // the Machine stands on a taller box
  maxTriangles: 3000,
  // mat names match kit.js K.mat: plaster (matte body), paint (matte accent), brass (metal trim).
  mats: ['plaster', 'paint', 'brass'],
  // kit.js K.mesh expects JSCAD print space (z up) and maps (x, y, z) -> three (x, z, -y).
  // To hand a mini to K.mesh (or K.stl) turn it upright first: J.transforms.rotateX(Math.PI / 2, geom).
  toKitRotateX: Math.PI / 2,
});

const C = {
  grad: '#d64545', data: '#2f6fdb', dir: '#7b5cd6', good: '#2f9e6b', prob: '#e8a33d',
  aux: '#1c9aa0', brass: '#b58a3c', plaster: '#f2ede4',
};

/* ------------------------------------------------------------------ vectors */

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => mul(a, 1 / (len(a) || 1));
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const bez = (p0, p1, p2, t) => lerp(lerp(p0, p1, t), lerp(p1, p2, t), t);
const range = (n) => Array.from({ length: n }, (_, i) => i);
const TAU = Math.PI * 2;

// tiny seeded generator (mulberry32) and a Gaussian from it
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(TAU * r());

// orthonormal u, v with u x v = n (so a ring u cos t + v sin t runs counter-clockwise about n)
function basis(n, spin = 0) {
  const w = norm(n);
  const h = Math.abs(w[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u0 = norm(cross(h, w));
  const v0 = cross(w, u0);
  const u = add(mul(u0, Math.cos(spin)), mul(v0, Math.sin(spin)));
  return [u, cross(w, u)];
}

/* ------------------------------------------------------------ solid helpers */

const KITS = new WeakMap();
function kit(J) {
  if (KITS.has(J)) return KITS.get(J);
  const { cuboid, sphere, polyhedron, geodesicSphere } = J.primitives;
  const { geom3, poly3 } = J.geometries;
  const poly = (points, faces) => polyhedron({ points, faces, orientation: 'outward' });

  const k = {
    C,
    merge: (list) => geom3.create([list].flat(Infinity).filter(Boolean).flatMap((g) => geom3.toPolygons(g))),
    box: (x0, y0, z0, x1, y1, z1) => cuboid({
      center: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2],
      size: [Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)],
    }),
    cube: (c, s) => cuboid({ center: c, size: Array.isArray(s) ? s : [s, s, s] }),
    ball: (c, r, seg = 10) => sphere({ center: c, radius: r, segments: seg }),
    // 20-face bead for small things
    bead: (c, r) => J.transforms.translate(c, geodesicSphere({ radius: r, frequency: 6 })),
    // convex hull of points (voussoirs, sector blocks)
    hull: (pts) => geom3.fromPointsConvex(pts),
    // swept tube along a polyline (parallel-transport frames); closed loops must be planar
    tube(pts, r, n = 6, closed = false) {
      const m = pts.length;
      const T = pts.map((p, i) => {
        const a = closed ? pts[(i - 1 + m) % m] : pts[Math.max(0, i - 1)];
        const b = closed ? pts[(i + 1) % m] : pts[Math.min(m - 1, i + 1)];
        return norm(sub(b, a));
      });
      let [u] = basis(T[0]);
      const P = [];
      for (let i = 0; i < m; i++) {
        if (i > 0) u = norm(sub(u, mul(T[i], dot(u, T[i]))));
        const v = cross(T[i], u);
        for (let q = 0; q < n; q++) {
          const t = (TAU * q) / n;
          P.push(add(pts[i], add(mul(u, r * Math.cos(t)), mul(v, r * Math.sin(t)))));
        }
      }
      const F = [];
      for (let i = 0; i < (closed ? m : m - 1); i++) {
        const i1 = (i + 1) % m;
        for (let q = 0; q < n; q++) {
          const q1 = (q + 1) % n;
          const a = i * n + q, b = i * n + q1, c = i1 * n + q1, d = i1 * n + q;
          F.push([a, b, c], [a, c, d]);
        }
      }
      if (!closed) {
        F.push(range(n).reverse());
        F.push(range(n).map((q) => (m - 1) * n + q));
      }
      return poly(P, F);
    },
    // cone: base disc at a, apex at b
    cone(a, b, r, n = 10) {
      const [u, v] = basis(sub(b, a));
      const P = range(n).map((q) => {
        const t = (TAU * q) / n;
        return add(a, add(mul(u, r * Math.cos(t)), mul(v, r * Math.sin(t))));
      });
      P.push(b);
      const F = [range(n).reverse()];
      for (let q = 0; q < n; q++) F.push([q, (q + 1) % n, n]);
      return poly(P, F);
    },
    arrow(a, b, r, o = {}) {
      const d = norm(sub(b, a));
      const hl = o.hl ?? r * 5, hr = o.hr ?? r * 2.6, n = o.n ?? 10;
      const m = sub(b, mul(d, hl));
      return k.merge([k.tube([a, m], r, n), k.cone(m, b, hr, n)]);
    },
    // polyline with sharp corners: straight rods plus a ball on every joint
    string(pts, r, n = 6) {
      const out = [];
      for (let i = 1; i < pts.length; i++) out.push(k.tube([pts[i - 1], pts[i]], r, n));
      for (let i = 1; i < pts.length - 1; i++) out.push(k.ball(pts[i], r, 8));
      return k.merge(out);
    },
    // 12 edges of an axis-aligned box, with a bead on each corner
    frame(a, b, r) {
      const [x0, y0, z0] = a, [x1, y1, z1] = b;
      const V = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
        [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
      const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
      return k.merge(E.map(([i, j]) => k.tube([V[i], V[j]], r, 6)).concat(V.map((p) => k.ball(p, r * 1.7, 6))));
    },
    // convex planar polygon (counter-clockwise about its normal) thickened to t, centred on its plane
    plate(pts, t) {
      let n = [0, 0, 0];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        n = add(n, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]);
      }
      n = norm(n);
      const m = pts.length;
      const P = pts.map((p) => add(p, mul(n, -t / 2))).concat(pts.map((p) => add(p, mul(n, t / 2))));
      const F = [range(m).reverse(), range(m).map((i) => m + i)];
      for (let i = 0; i < m; i++) { const i1 = (i + 1) % m; F.push([i, i1, m + i1, m + i]); }
      return poly(P, F);
    },
    // square (or sheared) quad centred at c in the plane with normal n
    quad(c, n, s, spin = 0, shear = 0) {
      const [u, v0] = basis(n, spin);
      const v = add(v0, mul(u, shear));
      return [add(c, add(mul(u, -s), mul(v, -s))), add(c, add(mul(u, s), mul(v, -s))),
        add(c, add(mul(u, s), mul(v, s))), add(c, add(mul(u, -s), mul(v, s)))];
    },
    // watertight heightfield over a rectangle: floor at y = floor, top at y = fn(x, z)
    hf(fn, x0, x1, z0, z1, nx, nz, floor = 0) {
      const X = (i) => x0 + ((x1 - x0) * i) / nx, Z = (j) => z0 + ((z1 - z0) * j) / nz;
      const T = (i, j) => i * (nz + 1) + j;
      const P = [];
      for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) P.push([X(i), Math.max(floor + 0.004, fn(X(i), Z(j))), Z(j)]);
      const B = new Map();
      const bot = (i, j) => {
        const key = T(i, j);
        if (!B.has(key)) { B.set(key, P.length); P.push([X(i), floor, Z(j)]); }
        return B.get(key);
      };
      const F = [];
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        const a = T(i, j), b = T(i, j + 1), c = T(i + 1, j + 1), d = T(i + 1, j);
        F.push([a, b, c], [a, c, d]);
      }
      for (let i = 0; i < nx; i++) {
        F.push([bot(i, 0), T(i, 0), T(i + 1, 0), bot(i + 1, 0)]);
        F.push([bot(i + 1, nz), T(i + 1, nz), T(i, nz), bot(i, nz)]);
      }
      for (let j = 0; j < nz; j++) {
        F.push([bot(0, j), bot(0, j + 1), T(0, j + 1), T(0, j)]);
        F.push([T(nx, j), T(nx, j + 1), bot(nx, j + 1), bot(nx, j)]);
      }
      F.push([bot(0, 0), bot(nx, 0), bot(nx, nz), bot(0, nz)]);
      return poly(P, F);
    },
    // watertight heightfield over a disc of radius R (polar grid); map(x, z) -> [x, z] may stretch
    // or turn the disc (determinant > 0), fn(x, z) is evaluated in disc coordinates
    // taper < 1 shrinks the bottom ring (a bowl's outer wall); facets stay planar when the rim is level
    hfDisc(fn, R, nr, ns, floor = 0, map = (x, z) => [x, z], taper = 1) {
      const pt = (x, z, y) => { const [X, Z] = map(x, z); return [X, y, Z]; };
      const P = [pt(0, 0, fn(0, 0))];
      const at = (ri, s) => 1 + (ri - 1) * ns + (s % ns);
      for (let ri = 1; ri <= nr; ri++) for (let s = 0; s < ns; s++) {
        const r = (R * ri) / nr, a = (TAU * s) / ns;
        const x = r * Math.cos(a), z = -r * Math.sin(a);
        P.push(pt(x, z, Math.max(floor + 0.004, fn(x, z))));
      }
      const b0 = P.length;
      for (let s = 0; s < ns; s++) { const a = (TAU * s) / ns; P.push(pt(taper * R * Math.cos(a), -taper * R * Math.sin(a), floor)); }
      const F = [];
      for (let s = 0; s < ns; s++) F.push([0, at(1, s), at(1, s + 1)]);
      for (let ri = 1; ri < nr; ri++) for (let s = 0; s < ns; s++) {
        const a = at(ri, s), b = at(ri + 1, s), c = at(ri + 1, s + 1), d = at(ri, s + 1);
        F.push([a, b, c], [a, c, d]);
      }
      for (let s = 0; s < ns; s++) {
        const s1 = (s + 1) % ns;
        F.push([b0 + s, b0 + s1, at(nr, s1), at(nr, s)]);
      }
      F.push(range(ns).map((s) => b0 + ns - 1 - s));
      return poly(P, F);
    },
    // a thin shell of thickness t following y = fn(x, z) over a rectangle (a sheet of paper)
    sheet(fn, x0, x1, z0, z1, nx, nz, t) {
      const X = (i) => x0 + ((x1 - x0) * i) / nx, Z = (j) => z0 + ((z1 - z0) * j) / nz;
      const n1 = (nx + 1) * (nz + 1), T = (i, j) => i * (nz + 1) + j, Bt = (i, j) => n1 + T(i, j);
      const P = [];
      for (const off of [t / 2, -t / 2]) for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) P.push([X(i), fn(X(i), Z(j)) + off, Z(j)]);
      const F = [];
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        F.push([T(i, j), T(i, j + 1), T(i + 1, j + 1)], [T(i, j), T(i + 1, j + 1), T(i + 1, j)]);
        F.push([Bt(i, j), Bt(i + 1, j + 1), Bt(i, j + 1)], [Bt(i, j), Bt(i + 1, j), Bt(i + 1, j + 1)]);
      }
      for (let i = 0; i < nx; i++) {
        F.push([Bt(i, 0), T(i, 0), T(i + 1, 0), Bt(i + 1, 0)]);
        F.push([Bt(i + 1, nz), T(i + 1, nz), T(i, nz), Bt(i, nz)]);
      }
      for (let j = 0; j < nz; j++) {
        F.push([Bt(0, j), Bt(0, j + 1), T(0, j + 1), T(0, j)]);
        F.push([T(nx, j), T(nx, j + 1), Bt(nx, j + 1), Bt(nx, j)]);
      }
      return poly(P, F);
    },
    // a profile y = fn(x) over [x0, x1], extruded between z0 and z1 (a fin / a hill)
    profile(fn, x0, x1, n, z0, z1, floor = 0) {
      const P = [];
      for (let i = 0; i <= n; i++) {
        const x = x0 + ((x1 - x0) * i) / n, y = Math.max(floor + 0.004, fn(x));
        P.push([x, y, z1], [x, floor, z1], [x, y, z0], [x, floor, z0]);   // F, Fb, K, Kb
      }
      const F = [];
      const Ft = (i) => 4 * i, Fb = (i) => 4 * i + 1, Kt = (i) => 4 * i + 2, Kb = (i) => 4 * i + 3;
      for (let i = 0; i < n; i++) {
        F.push([Fb(i), Fb(i + 1), Ft(i + 1), Ft(i)]);
        F.push([Kt(i), Kt(i + 1), Kb(i + 1), Kb(i)]);
        F.push([Ft(i), Ft(i + 1), Kt(i + 1), Kt(i)]);
        F.push([Fb(i), Kb(i), Kb(i + 1), Fb(i + 1)]);
      }
      F.push([Fb(0), Ft(0), Kt(0), Kb(0)]);
      F.push([Kb(n), Kt(n), Ft(n), Fb(n)]);
      return poly(P, F);
    },
    // polar point: angle a measured from -z towards +x around (cx, cz)
    polar: (cx, cz, r, a, y = 0) => [cx + r * Math.sin(a), y, cz - r * Math.cos(a)],
    // gather parts [geom, colour, mat?], merge per colour, scale to fill the box, stand on y = 0
    // turn (radians, about y) swings the whole mini so its best side faces the visitor at +z
    done(parts, H = 1, turn = 0) {
      const groups = new Map();
      for (const [g, color, mat] of parts) {
        if (!g) continue;
        const m = mat || (color === C.plaster ? 'plaster' : color === C.brass ? 'brass' : 'paint');
        const key = color + '|' + m;
        if (!groups.has(key)) groups.set(key, { color, mat: m, polys: [] });
        for (const x of [g].flat(Infinity)) if (x) groups.get(key).polys.push(...geom3.toPolygons(x));
      }
      const ct = Math.cos(turn), st = Math.sin(turn);
      const rot = (v) => [v[0] * ct + v[2] * st, v[1], -v[0] * st + v[2] * ct];
      if (turn) for (const gr of groups.values()) gr.polys = gr.polys.map((p) => poly3.create(p.vertices.map(rot)));
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const { polys } of groups.values()) for (const p of polys) for (const v of p.vertices) {
        for (let a = 0; a < 3; a++) { if (v[a] < lo[a]) lo[a] = v[a]; if (v[a] > hi[a]) hi[a] = v[a]; }
      }
      const w = hi[0] - lo[0], h = hi[1] - lo[1], d = hi[2] - lo[2];
      const s = Math.min(0.96 / w, 0.96 / d, (0.98 * H) / h);
      const cx = (lo[0] + hi[0]) / 2, cz = (lo[2] + hi[2]) / 2;
      const tf = (v) => [(v[0] - cx) * s, (v[1] - lo[1]) * s, (v[2] - cz) * s];
      const geoms = [...groups.values()].map(({ color, mat, polys }) => ({
        geom: geom3.create(polys.map((p) => poly3.create(p.vertices.map(tf)))), color, mat,
      }));
      return { geoms, size: [w * s, h * s, d * s] };
    },
  };
  KITS.set(J, k);
  return k;
}

/* ================================================================ the minis */

export const minis = {

  /* 00 · The Machine: an exploded transformer tower (1 x 2.2 x 1).
     Token tiles, one blue residual stream per position rising through every floor; on each floor
     the attention heads (behind) with amber arcs BETWEEN streams and one MLP per stream (in front);
     brass-rimmed floors; the unembedding slab and the amber probability skyline on top. */
  'north-machine': (J) => {
    const k = kit(J), P = [];
    const xs = [-0.36, -0.18, 0, 0.18, 0.36];
    const floors = [0.34, 0.68, 1.02, 1.36];
    const top = 1.7, fw = 0.47, fd = 0.3, ft = 0.024;
    const rim = (y, w, d) => {
      const c = [[-w, -d], [w, -d], [w, d], [-w, d]].map(([x, z]) => [x, y, z]);
      return k.tube(c, 0.008, 4, true);
    };
    for (const x of xs) P.push([k.box(x - 0.07, 0, -0.09, x + 0.07, 0.07, 0.09), C.data]);
    for (const x of xs) P.push([k.tube([[x, 0.07, 0], [x, top, 0]], 0.015, 8), C.data]);
    const arcs = [[0, 2], [1, 3], [0, 4], [2, 4], [1, 4], [3, 4], [0, 3], [2, 4]];
    floors.forEach((y, f) => {
      P.push([k.box(-fw, y, -fd, fw, y + ft, fd), C.plaster]);
      P.push([rim(y + ft / 2, fw, fd), C.brass]);
      for (const hx of [-0.27, 0, 0.27]) P.push([k.box(hx - 0.05, y + ft, -0.26, hx + 0.05, y + ft + 0.075, -0.16), C.plaster]);
      for (const x of xs) P.push([k.box(x - 0.055, y + ft, 0.13, x + 0.055, y + ft + 0.095, 0.24), C.plaster]);
      for (const [a, b] of arcs.slice(2 * f, 2 * f + 2)) {
        const x0 = xs[a], x1 = xs[b], hgt = 0.07 + 0.035 * (b - a);
        const pts = range(11).map((i) => {
          const t = i / 10;
          return [x0 + (x1 - x0) * t, y + 0.06 + hgt * Math.sin(Math.PI * t), -0.03];
        });
        P.push([k.tube(pts, 0.011, 6), C.prob]);
      }
    });
    P.push([k.box(-fw, top, -0.2, fw, top + 0.035, 0.2), C.plaster]);
    P.push([rim(top + 0.0175, fw, 0.2), C.brass]);
    const hs = [0.44, 0.27, 0.17, 0.11, 0.07, 0.045, 0.03];
    hs.forEach((h, i) => {
      const x = 0.36 - 0.12 * i;
      P.push([k.box(x - 0.045, top + 0.035, -0.05, x + 0.045, top + 0.035 + h, 0.05), C.prob]);
    });
    return k.done(P, 2.2);
  },

  /* 01 · The block: arange(24).reshape(2, 3, 4) as 24 cubes, the memory-order string (row-major,
     last axis fastest) across the front slab, brass axis rails b, h, w. */
  'w01-block': (J) => {
    const k = kit(J), P = [];
    const s = 0.16, xs = [-0.33, -0.11, 0.11, 0.33], ys = [0.56, 0.34, 0.12], zs = [0.11, -0.11];
    for (const z of zs) for (const y of ys) for (const x of xs) P.push([k.cube([x, y, z], s), C.plaster]);
    const zf = zs[0] + s / 2 + 0.016, pts = [];
    for (const y of ys) pts.push([xs[0], y, zf], [xs[3], y, zf]);
    P.push([k.string(pts, 0.011, 6), C.data]);
    P.push([k.ball(pts[0], 0.024, 10), C.data]);
    P.push([k.cone(pts[pts.length - 1], add(pts[pts.length - 1], [0.075, 0, 0]), 0.026, 10), C.data]);
    const o = [-0.46, 0.012, 0.25];
    P.push([k.tube([o, [0.46, 0.012, 0.25]], 0.009, 6), C.brass]);
    P.push([k.tube([o, [-0.46, 0.68, 0.25]], 0.009, 6), C.brass]);
    P.push([k.tube([o, [-0.46, 0.012, -0.22]], 0.009, 6), C.brass]);
    P.push([k.ball(o, 0.02, 8), C.brass]);
    return k.done(P);
  },

  /* 02 · The matmul cube: the i x k x j lattice of products A[i,k] * B[k,j] (cube size = value),
     A and B as blue walls, the C face on the floor, brass skewers along k (the squash axis). */
  'd01-cube': (J) => {
    const k = kit(J), P = [];
    const A = [[2, 1, 0, 3], [1, 3, 2, 0], [0, 2, 1, 1]];
    const B = [[1, 0, 2], [3, 1, 0], [0, 2, 1], [1, 1, 3]];
    const p = 0.19, X = (j) => p * (j - 1), Y = (kk) => 0.13 + p * kk, Z = (i) => p * (i - 1);
    for (let i = 0; i < 3; i++) for (let kk = 0; kk < 4; kk++) for (let j = 0; j < 3; j++) {
      const v = A[i][kk] * B[kk][j];
      if (v > 0) P.push([k.cube([X(j), Y(kk), Z(i)], 0.045 + 0.1 * Math.sqrt(v / 9)), C.plaster]);
    }
    const xw = X(0) - p / 2 - 0.035, zw = Z(0) - p / 2 - 0.035;
    for (let i = 0; i < 3; i++) for (let kk = 0; kk < 4; kk++) P.push([k.cube([xw, Y(kk), Z(i)], [0.022, 0.165, 0.165]), C.data]);
    for (let kk = 0; kk < 4; kk++) for (let j = 0; j < 3; j++) P.push([k.cube([X(j), Y(kk), zw], [0.165, 0.165, 0.022]), C.data]);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      P.push([k.cube([X(j), 0.012, Z(i)], [0.165, 0.024, 0.165]), C.plaster]);
      P.push([k.tube([[X(j), 0.024, Z(i)], [X(j), Y(3) + 0.08, Z(i)]], 0.006, 5), C.brass]);
    }
    return k.done(P, 1, -0.7);
  },

  /* 03 · The stencil: three input sheets (the colour channels), the 3 x 3 x 3 kernel window through
     all three (brass frame, blue receptive field), strings up to the one output pixel it makes. */
  'w02-stencil': (J) => {
    const k = kit(J), P = [];
    const n = 5, p = 0.15, X = (i) => (i - (n - 1) / 2) * p, ys = [0.02, 0.2, 0.38];
    const inWin = (i, j) => i <= 2 && j >= 2;
    for (const y of ys) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      P.push([k.cube([X(i), y, X(j)], [0.134, 0.02, 0.134]), inWin(i, j) ? C.data : C.plaster]);
    }
    const x0 = X(0) - p / 2, x1 = X(2) + p / 2, z0 = X(2) - p / 2, z1 = X(4) + p / 2, y0 = -0.01, y1 = 0.42;
    P.push([k.frame([x0, y0, z0], [x1, y1, z1], 0.009), C.brass]);
    const q = 0.12, O = (i) => (i - 1) * q, oy = 0.8;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      P.push([k.cube([O(i), oy, O(j)], [0.106, 0.02, 0.106]), i === 0 && j === 2 ? C.data : C.plaster]);
    }
    const ox = O(0), oz = O(2), hw = 0.053;
    for (const [cx, cz, sx, sz] of [[x0, z0, -1, -1], [x1, z0, 1, -1], [x1, z1, 1, 1], [x0, z1, -1, 1]]) {
      P.push([k.tube([[cx, y1, cz], [ox + sx * hw, oy - 0.01, oz + sz * hw]], 0.005, 5), C.brass]);
    }
    return k.done(P);
  },

  /* 04 · The highway: a tall stack of glass panes (drawn as their frames), the red gradient beam
     travelling down from the loss through every pane, and the teal bypass (x + f(x)) bulging round
     each pane: a path worth 1 all the way down. */
  'd02-highway': (J) => {
    const k = kit(J), P = [];
    const ys = [0.1, 0.26, 0.42, 0.58, 0.74, 0.9], hw = 0.27, bw = 0.06, t = 0.014;
    for (const y of ys) {
      P.push([k.box(-hw, y - t, -hw, hw, y + t, -hw + bw), C.plaster]);
      P.push([k.box(-hw, y - t, hw - bw, hw, y + t, hw), C.plaster]);
      P.push([k.box(-hw, y - t, -hw + bw, -hw + bw, y + t, hw - bw), C.plaster]);
      P.push([k.box(hw - bw, y - t, -hw + bw, hw, y + t, hw - bw), C.plaster]);
    }
    P.push([k.ball([0, 1.0, 0], 0.045, 14), C.grad]);
    P.push([k.arrow([0, 1.0, 0], [0, 0.0, 0], 0.021, { hr: 0.05, hl: 0.1, n: 12 }), C.grad]);
    const pts = [[hw - 0.03, 1.0, 0]];
    for (const y of ys.slice().reverse()) {
      for (let i = 0; i <= 8; i++) {
        const th = Math.PI / 2 - (Math.PI * i) / 8;
        pts.push([hw - 0.03 + 0.1 * Math.cos(th), y + 0.075 * Math.sin(th), 0]);
      }
    }
    pts.push([hw - 0.03, 0.0, 0]);
    P.push([k.tube(pts, 0.015, 6), C.aux]);
    return k.done(P);
  },

  /* 05 · The ravine: a long curving ravine with steep walls; plain SGD's zig-zag string bounces
     wall to wall on its way down the floor; the ball is the two weights. */
  'w03-ravine': (J) => {
    const k = kit(J), P = [];
    const c = (v) => 0.3 * Math.sin(1.5 * v + 0.3);
    const f = (x, z) => {
      const u = x / 0.5, v = z / 0.5;
      return 0.06 + 0.36 * Math.tanh(2.3 * (u - c(v))) ** 2 + 0.14 * (1 - v) / 2;
    };
    P.push([k.hf(f, -0.5, 0.5, -0.5, 0.5, 22, 22), C.plaster]);
    const pts = range(10).map((i) => {
      const v = -0.82 + 0.17 * i, a = 0.6 * 0.78 ** i * (i % 2 ? -1 : 1);
      const x = (c(v) + a) * 0.5, z = v * 0.5;
      return [x, f(x, z) + 0.014, z];
    });
    P.push([k.string(pts, 0.011, 6), C.grad]);
    const e = pts[pts.length - 1];
    P.push([k.ball([e[0], e[1] + 0.034, e[2]], 0.045, 12), C.brass]);
    return k.done(P);
  },

  /* 06 · Anatomy of one step: the tilted narrow bowl of a least-squares loss (its level rim is a
     contour), the ball on the steep far wall, the brass contour ring through the ball and the red
     step arrow: it points across the bowl at the other wall, not along it to the bottom. */
  'd03-step': (J) => {
    const k = kit(J), P = [];
    const am = 0.47, bm = 0.25, depth = 0.15, y0 = 0.16, tilt = 0.28, fl = 0.07;
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    const W = (a, b) => [a * ct - b * st, -a * st - b * ct];          // bowl axes -> world x, z (b > 0 = far side)
    const h = (a, b) => y0 + depth * ((a / am) ** 2 + (b / bm) ** 2);
    // (u, v) -> world must keep orientation (det > 0): v is flipped inside the map
    P.push([k.hfDisc((u, v) => y0 + depth * (u * u + v * v), 1, 12, 40, fl, (u, v) => W(am * u, -bm * v), 0.72), C.plaster]);
    const foot = [];
    for (let i = 0; i < 24; i++) {
      const t = (TAU * i) / 24;
      for (const [sc, y] of [[0.52, 0], [0.46, fl]]) { const [x, z] = W(sc * am * Math.cos(t), sc * bm * Math.sin(t)); foot.push([x, y, z]); }
    }
    P.push([k.hull(foot), C.plaster]);
    const rho = 0.66, phi = 1.2, a0 = am * rho * Math.cos(phi), b0 = bm * rho * Math.sin(phi);
    const ga = (2 * depth * a0) / am ** 2, gb = (2 * depth * b0) / bm ** 2;
    const [gx, gz] = W(ga, gb), [bx, bz] = W(a0, b0);
    const r = 0.05, ball = add([bx, h(a0, b0), bz], mul(norm([-gx, 1, -gz]), r));
    P.push([k.ball(ball, r, 14), C.brass]);
    P.push([k.tube(range(48).map((i) => {
      const t = (TAU * i) / 48, a = am * rho * Math.cos(t), b = bm * rho * Math.sin(t), [x, z] = W(a, b);
      return [x, h(a, b) + 0.008, z];
    }), 0.007, 5, true), C.brass]);
    const gl = Math.hypot(ga, gb), a1 = a0 - (0.24 * ga) / gl, b1 = b0 - (0.24 * gb) / gl, [ex, ez] = W(a1, b1);
    P.push([k.arrow(ball, [ex, h(a1, b1) + 0.035, ez], 0.016, { hr: 0.04, hl: 0.09 }), C.grad]);
    return k.done(P);
  },

  /* 07 · The blame web: inputs (blue) at the bottom, op beads, brass weights on the strings, the
     loss (red) on top, red arrowheads carrying blame back down every edge. */
  'w04-blame': (J) => {
    const k = kit(J), P = [];
    const X = [[-0.24, 0.08, 0.14], [0.26, 0.08, -0.1]];
    const Hn = [[-0.36, 0.42, -0.06], [0.02, 0.45, 0.2], [0.36, 0.41, -0.12]];
    const Y = [0.0, 0.68, 0.0], L = [0.0, 0.9, 0.0];
    const edges = [];
    for (const x of X) for (const h of Hn) edges.push([x, h, true]);
    for (const h of Hn) edges.push([h, Y, true]);
    edges.push([Y, L, false]);
    for (const [a, b, w] of edges) {
      P.push([k.tube([a, b], 0.007, 5), C.plaster]);
      if (w) P.push([k.ball(lerp(a, b, 0.52), 0.024, 8), C.brass]);
      const d = norm(sub(a, b)), m = lerp(b, a, 0.26);
      P.push([k.cone(m, add(m, mul(d, 0.058)), 0.024, 8), C.grad]);
    }
    X.forEach((x) => P.push([k.ball(x, 0.052, 12), C.data]));
    Hn.forEach((h) => P.push([k.ball(h, 0.058, 12), C.plaster]));
    P.push([k.ball(Y, 0.058, 12), C.plaster]);
    P.push([k.ball(L, 0.072, 14), C.grad]);
    return k.done(P);
  },

  /* 08 · One cube, three squashes: the product box with the incoming gradient dC as a red face;
     red arrows squash the box along j onto the dA face (dC @ B^T keeps A's shape). */
  'd04-squash': (J) => {
    const k = kit(J), P = [];
    const p = 0.2, s = 0.15, c = [-p, 0, p];
    for (const x of c) for (const y of c) for (const z of c) P.push([k.cube([x, y + 0.3, z], s), C.plaster]);
    for (const x of c) for (const y of c) P.push([k.cube([x, y + 0.3, p + s / 2 + 0.03], [s, s, 0.02]), C.grad]);
    const xa = -p - s / 2 - 0.05;
    for (const y of c) for (const z of c) P.push([k.cube([xa, y + 0.3, z], [0.02, s, s]), C.plaster]);
    for (const z of [-0.1, 0.1]) P.push([k.arrow([0.3, 0.64, z], [-0.26, 0.64, z], 0.012, { hr: 0.032, hl: 0.07 }), C.grad]);
    return k.done(P);
  },

  /* 09 · The searchlight: token pillars with amber sand (softmax weights, sum 1) in their cups;
     the last token's violet query leans back over them like a searchlight. */
  'w05-searchlight': (J) => {
    const k = kit(J), P = [];
    const xs = [-0.36, -0.18, 0, 0.18, 0.36], w = [0.06, 0.1, 0.46, 0.14, 0.24];
    xs.forEach((x, i) => {
      P.push([k.tube([[x, 0, 0], [x, 0.22, 0]], 0.06, 16), C.plaster]);
      P.push([k.tube([[x, 0.22, 0], [x, 0.23 + 0.62 * w[i], 0]], 0.049, 16), C.prob]);
    });
    const top = [0.36, 0.86, 0];
    P.push([k.tube([[0.36, 0.23 + 0.62 * w[4], 0], top], 0.011, 6), C.brass]);
    P.push([k.ball(top, 0.026, 10), C.brass]);
    P.push([k.arrow(top, [0.04, 0.6, 0], 0.02, { hr: 0.052, hl: 0.12, n: 12 }), C.dir]);
    return k.done(P);
  },

  /* 10 · Two machines in one head: the residual space as a brass cube; QK flattens it onto a
     violet plane (where to look), OV onto a teal sheared sheet (what to move). */
  'd05-circuits': (J) => {
    const k = kit(J), P = [];
    P.push([k.frame([-0.4, 0.02, -0.4], [0.4, 0.82, 0.4], 0.009), C.brass]);
    P.push([k.plate(k.quad([-0.17, 0.44, 0.02], [0.35, 1, 0.3], 0.19, 0.3), 0.014), C.dir]);
    P.push([k.plate(k.quad([0.19, 0.4, -0.02], [1, 0.25, 0.55], 0.17, 0.2, 0.45), 0.014), C.aux]);
    return k.done(P);
  },

  /* 11 · The skyline: 10 candidate words as towers on a curved plinth, sorted by probability
     (a real softmax); the top-k survivors (k = 4) amber, a brass fence after the k-th. */
  'w06-skyline': (J) => {
    const k = kit(J), P = [];
    const R = 1.0, zc = 0.8, N = 10, kk = 4, span = 0.5, tw = 0.038;
    const logits = [3.3, 2.7, 2.3, 2.0, 1.7, 1.4, 1.15, 0.9, 0.65, 0.4];
    const ex = logits.map(Math.exp), Z = ex.reduce((a, b) => a + b, 0), p = ex.map((e) => e / Z);
    const th = (i) => -span + (2 * span * i) / (N - 1);
    const seg = 14, a0 = th(0) - 0.06, a1 = th(N - 1) + 0.06;
    for (let s = 0; s < seg; s++) {
      const b0 = a0 + ((a1 - a0) * s) / seg, b1 = a0 + ((a1 - a0) * (s + 1)) / seg;
      const pts = [];
      for (const r of [R - 0.08, R + 0.08]) for (const b of [b0, b1]) for (const y of [0, 0.05]) pts.push(k.polar(0, zc, r, b, y));
      P.push([k.hull(pts), C.plaster]);
    }
    for (let i = 0; i < N; i++) {
      const h = 0.03 + (0.8 * p[i]) / p[0];
      const tower = J.transforms.rotateY(-th(i), k.box(-tw, 0.05, -tw, tw, 0.05 + h, tw));
      const [x, , z] = k.polar(0, zc, R, th(i));
      P.push([J.transforms.translate([x, 0, z], tower), i < kk ? C.prob : C.plaster]);
    }
    const fa = (th(kk - 1) + th(kk)) / 2, pts = [];
    for (const r of [R - 0.085, R + 0.085]) for (const b of [fa - 0.011, fa + 0.011]) for (const y of [0.05, 0.38]) pts.push(k.polar(0, zc, r, b, y));
    P.push([k.hull(pts), C.brass]);
    return k.done(P, 1, -0.35);
  },

  /* 12 · The activation shelf: a cabinet of drawers (rows = layers, drawers = hook points, sized
     like their tensors), brass knobs, one drawer pulled out with its cached activations (blue). */
  'd06-shelf': (J) => {
    const k = kit(J), P = [];
    const W = 0.44, y0 = 0.04, H = 0.86, zb = -0.17, zf = 0.1, t = 0.02;
    P.push([k.box(-W - 0.035, 0, zb - 0.045, W + 0.035, y0, zf + 0.03), C.plaster]);
    P.push([k.box(-W - t, y0, zb - t, W + t, y0 + H, zb), C.plaster]);
    P.push([k.box(-W - t, y0, zb, -W, y0 + H, zf), C.plaster]);
    P.push([k.box(W, y0, zb, W + t, y0 + H, zf), C.plaster]);
    P.push([k.box(-W - 0.04, y0 + H, zb - 0.05, W + 0.04, y0 + H + 0.035, zf + 0.035), C.plaster]);
    const rows = [[0.3, 0.2, 0.2, 0.3], [0.2, 0.2, 0.6], [0.14, 0.14, 0.14, 0.58], [0.4, 0.3, 0.3]];
    const dh = (H - t * (rows.length + 1)) / rows.length;
    rows.forEach((ws, r) => {
      const yb = y0 + t + r * (dh + t);
      P.push([k.box(-W, yb - t, zb, W, yb, zf), C.plaster]);
      let x = -W;
      ws.forEach((fw, i) => {
        const wd = 2 * W * fw, xa = x, xb = x + wd;
        if (i > 0) P.push([k.box(xa - t / 2, yb, zb, xa + t / 2, yb + dh, zf), C.plaster]);
        const pull = r === 2 && i === 3 ? 0.24 : 0;
        const fx0 = xa + (i > 0 ? t / 2 : 0) + 0.006, fx1 = xb - (i < ws.length - 1 ? t / 2 : 0) - 0.006;
        const fy0 = yb + 0.006, fy1 = yb + dh - 0.006;
        P.push([k.box(fx0, fy0, zf - 0.05 + pull, fx1, fy1, zf + 0.018 + pull), C.plaster]);
        P.push([k.ball([(fx0 + fx1) / 2, (fy0 + fy1) / 2, zf + 0.03 + pull], 0.017, 8), C.brass]);
        if (pull) {
          const zt = zf - 0.05 + pull, zt0 = zt - 0.22, g = 0.012;
          P.push([k.box(fx0 + g, fy0, zt0, fx1 - g, fy0 + 0.014, zt), C.plaster]);
          P.push([k.box(fx0 + g, fy0, zt0, fx0 + g + 0.012, fy1 - 0.03, zt), C.plaster]);
          P.push([k.box(fx1 - g - 0.012, fy0, zt0, fx1 - g, fy1 - 0.03, zt), C.plaster]);
          P.push([k.box(fx0 + g + 0.024, fy0 + 0.014, zt0 + 0.02, fx1 - g - 0.024, fy0 + 0.09, zt - 0.015), C.data]);
        }
        x = xb;
      });
    });
    return k.done(P);
  },

  /* 13 · The stripe: an induction head's attention field on random tokens repeated twice
     (causal triangle of tiles; idealised pattern): the first half parks on BOS, the second half
     lights the stripe key = query - (n - 1). */
  'w07-stripe': (J) => {
    const k = kit(J), P = [];
    const n = 5, N = 2 * n + 1, p = 0.085, X = (i) => (i - (N - 1) / 2) * p;
    for (let q = 0; q < N; q++) for (let kk = 0; kk <= q; kk++) {
      const stripe = q > n && kk === q - (n - 1);
      const bos = kk === 0 && q <= n;
      const h = stripe ? 0.5 : bos ? 0.24 : 0.02;
      P.push([k.cube([X(kk), h / 2, X(q)], [0.07, h, 0.07]), stripe ? C.prob : C.plaster]);
    }
    for (let kk = 0; kk < N; kk++) P.push([k.cube([X(kk), 0.012, X(N - 1) + 0.1], [0.07, 0.024, 0.05]), C.data]);
    return k.done(P);
  },

  /* 14 · The relay: the layer-0 head writes into a violet plane, the layer-1 head reads from a
     teal plane; the planes cross in the residual space, and how much they overlap is the
     composition score. The violet arrow hands the baton to the teal one. */
  'd07-relay': (J) => {
    const k = kit(J), P = [];
    const c = [0, 0.52, 0];
    const n1 = norm([-0.62, 0.3, 0.72]), n2 = norm([0.7, 0.32, 0.64]);
    P.push([k.plate(k.quad(c, n1, 0.29, 0.1), 0.016), C.dir]);
    P.push([k.plate(k.quad(c, n2, 0.29, -0.1), 0.016), C.aux]);
    const d = norm(cross(n1, n2));
    const e1 = norm(cross(d, n1)), e2 = norm(cross(n2, d));
    const lift = mul(d, d[1] > 0 ? 0.12 : -0.12);
    const s1 = add(add(c, lift), mul(e1, 0.26)), t1 = add(add(c, lift), mul(e1, 0.04));
    P.push([k.arrow(add(s1, mul(n1, 0.02)), add(t1, mul(n1, 0.02)), 0.013, { hr: 0.034, hl: 0.07 }), C.dir]);
    const s2 = add(add(c, lift), mul(e2, 0.04)), t2 = add(add(c, lift), mul(e2, 0.26));
    P.push([k.arrow(add(s2, mul(n2, 0.02)), add(t2, mul(n2, 0.02)), 0.013, { hr: 0.034, hl: 0.07 }), C.aux]);
    P.push([k.tube([[0, 0, 0], [0, 0.035, 0]], 0.17, 28), C.plaster]);
    P.push([k.tube([[0, 0.035, 0], c], 0.012, 6), C.brass]);
    P.push([k.ball(c, 0.026, 10), C.brass]);
    return k.done(P);
  },

  /* 15 · The twin towers: clean (green output) and corrupted (red output) runs as twin towers of
     cells (layers x positions); a brass patch cable carries one clean cell across. */
  'w08-twins': (J) => {
    const k = kit(J), P = [];
    const tower = (xc, out) => {
      P.push([k.box(xc - 0.17, 0, -0.09, xc + 0.17, 0.03, 0.09), C.plaster]);
      for (let f = 0; f < 5; f++) for (let c = 0; c < 3; c++) {
        const hot = f === 2 && ((xc < 0 && c === 2) || (xc > 0 && c === 0));
        P.push([k.cube([xc + (c - 1) * 0.1, 0.08 + f * 0.1, 0], [0.085, 0.085, 0.085]), hot ? C.good : C.plaster]);
      }
      P.push([k.cube([xc, 0.6, 0], [0.1, 0.1, 0.1]), out]);
    };
    tower(-0.23, C.good);
    tower(0.23, C.grad);
    const a = [-0.23 + 0.1, 0.28, 0.045], b = [0.23 - 0.1, 0.28, 0.045], ctl = [0, 0.1, 0.34];
    P.push([k.tube(range(15).map((i) => bez(a, ctl, b, i / 14)), 0.011, 6), C.brass]);
    return k.done(P);
  },

  /* 16 · The polytope: n = 4 features squeezed into 3 dimensions as a tetrahedron of violet
     arrows (columns of W) inside a brass armillary sphere. */
  'd08-polytope': (J) => {
    const k = kit(J), P = [];
    const O = [0, 0.52, 0], R = 0.37;
    const tilt = (v) => {
      const a = 0.35, b = 0.5;
      const x1 = v[0] * Math.cos(b) + v[2] * Math.sin(b), z1 = -v[0] * Math.sin(b) + v[2] * Math.cos(b);
      return [x1, v[1] * Math.cos(a) - z1 * Math.sin(a), v[1] * Math.sin(a) + z1 * Math.cos(a)];
    };
    const s8 = Math.sqrt(8) / 3;
    const dirs = [[0, 1, 0], ...[0, 1, 2].map((i) => [s8 * Math.sin((TAU * i) / 3), -1 / 3, s8 * Math.cos((TAU * i) / 3)])].map(tilt);
    const tips = dirs.map((d) => add(O, mul(d, 0.29)));
    tips.forEach((t) => P.push([k.arrow(O, t, 0.017, { hr: 0.042, hl: 0.09, n: 12 }), C.dir]));
    tips.forEach((t) => P.push([k.ball(add(t, mul(norm(sub(t, O)), 0.03)), 0.034, 12), C.plaster]));
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
      const a = add(tips[i], mul(norm(sub(tips[i], O)), 0.03)), b = add(tips[j], mul(norm(sub(tips[j], O)), 0.03));
      P.push([k.tube([a, b], 0.0045, 5), C.plaster]);
    }
    P.push([k.tube(range(40).map((i) => [R * Math.cos((TAU * i) / 40), O[1], R * Math.sin((TAU * i) / 40)]), 0.01, 6, true), C.brass]);
    const m = 0.5;
    P.push([k.tube(range(40).map((i) => {
      const t = (TAU * i) / 40;
      return [R * Math.cos(t) * Math.cos(m), O[1] + R * Math.sin(t), R * Math.cos(t) * Math.sin(m)];
    }), 0.01, 6, true), C.brass]);
    P.push([k.tube([[0, 0.035, 0], [0, O[1] - R, 0]], 0.013, 6), C.brass]);
    P.push([k.tube([[0, 0, 0], [0, 0.035, 0]], 0.15, 24), C.plaster]);
    return k.done(P);
  },

  /* 17 · The dictionary: sparse activations make a spiky star (one spike per feature, blue data
     beads along it); the SAE's violet decoder arrows swing onto the spikes. */
  'd08-dictionary': (J) => {
    const k = kit(J), P = [];
    const O = [0, 0.5, 0];
    const spikes = [[0.95, 0.28, 0.2], [-0.88, 0.4, 0.28], [0.1, 0.97, -0.22], [-0.28, -0.5, 0.82],
      [0.6, -0.42, -0.68], [-0.5, 0.2, -0.84]].map(norm);
    const Ls = [0.42, 0.4, 0.4, 0.37, 0.37, 0.4];
    const r = rng(17);
    spikes.forEach((d, i) => {
      const tip = add(O, mul(d, Ls[i]));
      P.push([k.cone(O, tip, 0.05, 10), C.plaster]);
      for (const f of [0.5, 0.74, 0.97]) P.push([k.bead(add(O, mul(d, Ls[i] * (f + 0.04 * (r() - 0.5)))), 0.032), C.data]);
      if (i < 4) {
        const off = norm(add(d, mul(norm(cross(d, [0.3, 1, 0.2])), 0.2)));
        P.push([k.arrow(O, add(O, mul(off, Ls[i] * 0.9)), 0.012, { hr: 0.032, hl: 0.075, n: 10 }), C.dir]);
      }
    });
    P.push([k.ball(O, 0.05, 12), C.plaster]);
    P.push([k.tube([[0, 0.035, 0], O], 0.014, 6), C.plaster]);
    P.push([k.tube([[0, 0, 0], [0, 0.035, 0]], 0.15, 24), C.plaster]);
    return k.done(P);
  },

  /* 18 · The value terrain: a cliff-walk gridworld whose tile heights are V(s) from real value
     iteration (step -1, cliff -100, gamma 0.9); red cliff, green goal, the brass greedy path. */
  'w09-terrain': (J) => {
    const k = kit(J), P = [];
    const R = 6, Cn = 8, start = [5, 0], goal = [5, 7], gamma = 0.9;
    const cliff = (r, c) => r === 5 && c >= 1 && c <= 6;
    const V = range(R).map(() => range(Cn).map(() => 0));
    const moves = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    const step = (r, c, [dr, dc]) => {
      const nr = Math.min(R - 1, Math.max(0, r + dr)), nc = Math.min(Cn - 1, Math.max(0, c + dc));
      if (cliff(nr, nc)) return [-100, start[0], start[1]];
      return [-1, nr, nc];
    };
    const term = (r, c) => r === goal[0] && c === goal[1];
    for (let sweep = 0; sweep < 200; sweep++) {
      for (let r = 0; r < R; r++) for (let c = 0; c < Cn; c++) {
        if (term(r, c) || cliff(r, c)) continue;
        V[r][c] = Math.max(...moves.map((m) => { const [rw, nr, nc] = step(r, c, m); return rw + (term(nr, nc) ? 0 : gamma * V[nr][nc]); }));
      }
    }
    const vals = [];
    for (let r = 0; r < R; r++) for (let c = 0; c < Cn; c++) if (!cliff(r, c) && !term(r, c)) vals.push(V[r][c]);
    const vmin = Math.min(...vals), vmax = Math.max(...vals);
    const p = 0.115, X = (c) => (c - (Cn - 1) / 2) * p, Zc = (r) => (r - (R - 1) / 2) * p;
    const ht = (r, c) => (cliff(r, c) ? 0.022 : term(r, c) ? 0.5 : 0.06 + (0.36 * (V[r][c] - vmin)) / (vmax - vmin));
    for (let r = 0; r < R; r++) for (let c = 0; c < Cn; c++) {
      const h = ht(r, c);
      P.push([k.cube([X(c), h / 2, Zc(r)], [0.104, h, 0.104]), cliff(r, c) ? C.grad : term(r, c) ? C.good : C.plaster]);
    }
    const path = [start];
    for (let guard = 0; guard < 30 && !term(...path[path.length - 1]); guard++) {
      const [r, c] = path[path.length - 1];
      let best = null, bv = -Infinity;
      for (const m of moves) {
        const [rw, nr, nc] = step(r, c, m);
        const q = rw + (term(nr, nc) ? 0 : gamma * V[nr][nc]);
        if (q > bv + 1e-9) { bv = q; best = [nr, nc]; }
      }
      path.push(best);
    }
    // the greedy path as a brass string over the tile tops; the last step becomes the arrowhead
    const pts = path.map(([r, c]) => [X(c), ht(r, c) + 0.03, Zc(r)]);
    const goalTop = pts.pop(), prev = pts[pts.length - 1];
    const neck = lerp(prev, [goalTop[0], prev[1], goalTop[2] - 0.052], 0.35);
    pts.push(neck);
    P.push([k.string(pts, 0.012, 6), C.brass]);
    P.push([k.cone(neck, [goalTop[0], prev[1], goalTop[2] - 0.052], 0.034, 10), C.brass]);
    return k.done(P);
  },

  /* 19 · The pole and the Q-surface: CartPole on its rails; the green fan is the +-12 degree zone
     where the episode (and the reward) keeps going. */
  'd09-cartpole': (J) => {
    const k = kit(J), P = [];
    P.push([k.box(-0.48, 0, -0.11, 0.48, 0.035, 0.11), C.plaster]);
    for (const z of [-0.065, 0.065]) P.push([k.tube([[-0.46, 0.047, z], [0.46, 0.047, z]], 0.012, 8), C.brass]);
    for (const x of [-0.46, 0.46]) P.push([k.box(x - 0.018, 0.035, -0.1, x + 0.018, 0.12, 0.1), C.brass]);
    const cx = 0.05, wy = 0.059 + 0.036;
    for (const x of [cx - 0.1, cx + 0.1]) for (const z of [-0.065, 0.065]) {
      P.push([k.tube([[x, wy, z - 0.016], [x, wy, z + 0.016]], 0.036, 14), C.brass]);
    }
    P.push([k.box(cx - 0.17, wy + 0.012, -0.1, cx + 0.17, wy + 0.11, 0.1), C.plaster]);
    const py = wy + 0.12, piv = [cx, py, 0.0], th = (10 * Math.PI) / 180, L = 0.56;
    const tip = [cx + L * Math.sin(th), py + L * Math.cos(th), 0];
    P.push([k.tube([piv, tip], 0.019, 10), C.plaster]);
    P.push([k.ball(tip, 0.03, 10), C.plaster]);
    P.push([k.tube([[cx, py, -0.045], [cx, py, 0.045]], 0.024, 12), C.brass]);
    const lim = (12 * Math.PI) / 180, fan = [[cx, py, -0.05]];
    for (let i = 0; i <= 6; i++) {
      const a = lim - (2 * lim * i) / 6;
      fan.push([cx + 0.36 * Math.sin(a), py + 0.36 * Math.cos(a), -0.05]);
    }
    P.push([k.plate(fan, 0.008), C.good]);
    return k.done(P);
  },

  /* 20 · The sanded saddle: PPO's clipped objective L = min(r A, clip(r, 1 - eps, 1 + eps) A) as a
     thin plaster sheet over r in [0, 2] (left to right) and A in [-2, 2] (front to back); the flat
     plateaus (zero gradient) in amber, the ghost of the unclipped saddle r A as brass wires rising
     above them, and the green ball that climbed the A = 1.2 slice and stopped at the plateau edge. */
  'w10-saddle': (J) => {
    const k = kit(J), P = [];
    const eps = 0.2, lo = 1 - eps, hi = 1 + eps;
    const L = (r, A) => Math.min(r * A, Math.min(hi, Math.max(lo, r)) * A);
    const sx = 0.47, sz = 0.235, Y = (v) => 0.2 + (v + 4) * 0.095;
    const f = (x, z) => Y(L(x / sx + 1, -z / sz));
    P.push([k.sheet(f, -sx, sx, -2 * sz, 2 * sz, 20, 20, 0.03), C.plaster]);
    const w = (r, A, lift = 0.02) => [(r - 1) * sx, Y(L(r, A)) + lift, -A * sz];
    P.push([k.plate([w(hi, 0), w(hi, 2), w(2, 2), w(2, 0)], 0.006), C.prob]);
    P.push([k.plate([w(0, -2), w(0, 0), w(lo, 0), w(lo, -2)], 0.006), C.prob]);
    const g = (r, A) => [(r - 1) * sx, Y(r * A) + 0.015, -A * sz];
    for (const A of [1, 2]) P.push([k.tube([g(hi, A), g(2, A)], 0.006, 5), C.brass]);
    for (const r of [1.6, 2]) P.push([k.tube([g(r, 0), g(r, 2)], 0.006, 5), C.brass]);
    for (const A of [-1, -2]) P.push([k.tube([g(0, A), g(lo, A)], 0.006, 5), C.brass]);
    for (const r of [0, 0.4]) P.push([k.tube([g(r, -2), g(r, 0)], 0.006, 5), C.brass]);
    P.push([k.ball(w(hi, 1.2, 0.06), 0.045, 14), C.good]);
    P.push([k.tube([[0, 0.035, 0], [0, Y(0) - 0.01, 0]], 0.03, 12), C.plaster]);
    P.push([k.tube([[0, 0, 0], [0, 0.035, 0]], 0.2, 28), C.plaster]);
    return k.done(P, 1, -1.2);
  },

  /* 21 · The leash: gold reward rises then falls (the Goodhart ridge, illustrative); the policy
     ball has run past the ridge, tied by its KL leash to the reference post at home. */
  'd10-leash': (J) => {
    const k = kit(J), P = [];
    const f = (x, z) => 0.05 + 0.3 * Math.exp(-((x - 0.02) ** 2) / 0.035 - (z * z) / 0.4) + 0.03 * Math.cos(3 * z);
    P.push([k.hf(f, -0.5, 0.5, -0.5, 0.5, 20, 20), C.plaster]);
    const home = [-0.3, 0, 0.08], hy = f(home[0], home[2]);
    const postTop = [home[0], hy + 0.24, home[2]];
    P.push([k.tube([[home[0], hy - 0.02, home[2]], postTop], 0.013, 8), C.brass]);
    P.push([k.ball(postTop, 0.026, 10), C.brass]);
    const r = 0.05, bxz = [0.34, -0.1], by = f(bxz[0], bxz[1]) + r;
    const ball = [bxz[0], by, bxz[1]];
    P.push([k.ball(ball, r, 14), C.good]);
    const end = add(ball, mul(norm(sub(postTop, ball)), r * 0.9));
    const rope = range(25).map((i) => {
      const t = i / 24, pnt = lerp(postTop, end, t);
      const sag = 0.1 * Math.sin(Math.PI * t);
      return [pnt[0], Math.max(pnt[1] - sag, f(pnt[0], pnt[2]) + 0.012), pnt[2]];
    });
    P.push([k.tube(rope, 0.007, 5), C.brass]);
    return k.done(P);
  },

  /* 22 · The bean machine: a Galton board; each bead is one run of the eval, going right (pass)
     at every peg with probability p; the bins fill with the binomial pile of scores. */
  'w11-beans': (J) => {
    const k = kit(J), P = [];
    P.push([k.box(-0.42, 0, -0.075, 0.42, 0.96, -0.035), C.plaster]);
    P.push([k.box(-0.46, 0, -0.1, 0.46, 0.045, 0.09), C.plaster]);
    const rows = 7, pitch = 0.09;
    for (let r = 0; r < rows; r++) for (let c = 0; c <= r; c++) {
      const x = (c - r / 2) * pitch, y = 0.86 - r * 0.064;
      P.push([k.tube([[x, y, -0.035], [x, y, 0.035]], 0.011, 6), C.brass]);
    }
    for (let c = 0; c <= 8; c++) P.push([k.box((c - 4) * pitch - 0.006, 0.045, -0.035, (c - 4) * pitch + 0.006, 0.36, 0.035), C.plaster]);
    const nCk = (n, kk) => { let v = 1; for (let i = 1; i <= kk; i++) v = (v * (n - i + 1)) / i; return v; };
    const counts = range(8).map((c) => Math.round((5 * nCk(7, c)) / nCk(7, 3)));
    counts.forEach((cnt, c) => {
      for (let i = 0; i < cnt; i++) P.push([k.bead([(c - 3.5) * pitch, 0.075 + i * 0.058, 0], 0.028), C.data]);
    });
    P.push([k.bead([0.045, 0.69, 0], 0.028), C.data]);
    P.push([k.tube([[-0.3, 0.96, 0], [-0.05, 0.9, 0]], 0.012, 6), C.plaster]);
    P.push([k.tube([[0.3, 0.96, 0], [0.05, 0.9, 0]], 0.012, 6), C.plaster]);
    return k.done(P);
  },

  /* 23 · The threshold wall: honest (green) and attack (red) suspicion scores as two overlapping
     hills on a track (toy); the brass audit wall stands at the honest 98th percentile. */
  'd11-threshold': (J) => {
    const k = kit(J), P = [];
    P.push([k.box(-0.5, 0, -0.2, 0.5, 0.04, 0.2), C.plaster]);
    const bell = (mu, s, H) => (x) => 0.04 + H * Math.exp(-((x - mu) ** 2) / (2 * s * s));
    P.push([k.profile(bell(-0.16, 0.13, 0.52), -0.48, 0.48, 32, -0.15, -0.03, 0.04), C.good]);
    P.push([k.profile(bell(0.18, 0.13, 0.42), -0.48, 0.48, 32, 0.02, 0.14, 0.04), C.grad]);
    const wx = -0.16 + 2.05 * 0.13;
    P.push([k.box(wx - 0.01, 0.04, -0.2, wx + 0.01, 0.66, 0.2), C.brass]);
    return k.done(P, 1, -0.5);
  },

  /* 24 · One thin sheet: the thick weight slab W, laid out like a multiplication table: the LoRA
     factors stand on two edges as violet fins (B down one side, A along the back) and their outer
     product B A floats on brass pins over the rest: one thin rank-1 sheet whose relief is exactly
     fin times fin. */
  'w12-sheet': (J) => {
    const k = kit(J), P = [];
    const S = 0.38, top = 0.25, x0 = -0.33, x1 = 0.19, z0 = -0.19, z1 = 0.33;
    const ux = (x) => (2 * (x - x0)) / (x1 - x0) - 1, uz = (z) => (2 * (z - z0)) / (z1 - z0) - 1;
    const a = (x) => 0.55 + 0.45 * Math.sin(2.1 * ux(x) - 0.3);
    const b = (z) => 0.55 + 0.45 * Math.cos(2.3 * uz(z) + 0.5);
    const sh = (x, z) => top + 0.1 + 0.15 * b(z) * a(x);
    P.push([k.box(-S, 0, -S, S, top, S), C.plaster]);
    P.push([k.sheet(sh, x0, x1, z0, z1, 14, 14, 0.016), C.dir]);
    for (const x of [x0 + 0.035, x1 - 0.035]) for (const z of [z0 + 0.035, z1 - 0.035]) {
      P.push([k.tube([[x, top, z], [x, sh(x, z) - 0.008, z]], 0.007, 6), C.brass]);
    }
    P.push([k.profile((x) => top + 0.04 + 0.2 * a(x), x0, x1, 16, -0.355, -0.315, top), C.dir]);
    P.push([J.transforms.rotateY(-Math.PI / 2, k.profile((z) => top + 0.04 + 0.2 * b(z), z0, z1, 16, -0.355, -0.315, top)), C.dir]);
    return k.done(P, 1, 0.5);
  },

  /* 25 · The dial: activations on contrasting prompts as two clouds (toy), the violet steering
     vector from one mean to the other, on a dial whose violet needle turns alpha. */
  'd12-dial': (J) => {
    const k = kit(J), P = [];
    const R = 0.42;
    P.push([k.tube([[0, 0, 0], [0, 0.045, 0]], R, 40), C.plaster]);
    P.push([k.tube(range(48).map((i) => [R * Math.cos((TAU * i) / 48), 0.045, R * Math.sin((TAU * i) / 48)]), 0.011, 6, true), C.brass]);
    for (let i = 0; i < 12; i++) {
      const a = (TAU * i) / 12, c = Math.cos(a), sn = Math.sin(a);
      P.push([J.transforms.translate([0.37 * c, 0, 0.37 * sn], J.transforms.rotateY(-a + Math.PI / 2, k.box(-0.006, 0.045, -0.03, 0.006, 0.053, 0.03))), C.brass]);
    }
    const r = rng(25);
    const cloud = (m, n) => range(n).map(() => add(m, [0.07 * gauss(r), 0.055 * gauss(r), 0.07 * gauss(r)]));
    const neg = cloud([-0.2, 0.44, 0.08], 12), pos = cloud([0.19, 0.66, -0.05], 12);
    const mean = (pts) => mul(pts.reduce(add, [0, 0, 0]), 1 / pts.length);
    neg.forEach((p) => P.push([k.bead(p, 0.036), C.plaster]));
    pos.forEach((p) => P.push([k.bead(p, 0.036), C.data]));
    const m0 = mean(neg), m1 = mean(pos), v = sub(m1, m0);
    P.push([k.arrow(m0, add(m1, mul(v, 0.18)), 0.017, { hr: 0.043, hl: 0.095, n: 12 }), C.dir]);
    const hv = norm([v[0], 0, v[2]]), side = [-hv[2], 0, hv[0]];
    const n0 = [0, 0.056, 0];
    P.push([k.plate([add(n0, mul(side, -0.028)), add(n0, mul(hv, 0.3)), add(n0, mul(side, 0.028))], 0.012), C.dir]);
    P.push([k.tube([[0, 0.045, 0], [0, 0.075, 0]], 0.032, 16), C.brass]);
    return k.done(P);
  },

  /* 26 · The fan: a chain of thought as a path of sentence beads (pillars = importance); from the
     anchor sentence a fan of resampled continuations (amber) lands on answer tiles in front
     (green = correct, plaster = other). */
  'w13-fan': (J) => {
    const k = kit(J), P = [];
    P.push([k.box(-0.48, 0, -0.3, 0.48, 0.03, 0.3), C.plaster]);
    const n = 8, imp = [0.2, 0.3, 0.95, 0.35, 0.25, 0.45, 0.2, 0.15], anchor = 2;
    const beads = range(n).map((i) => {
      const t = i / (n - 1);
      return [-0.42 + 0.84 * t, 0.44 + 0.07 * Math.sin(Math.PI * t), -0.17 + 0.05 * Math.sin(TAU * t)];
    });
    P.push([k.tube(beads, 0.011, 6), C.brass]);
    beads.forEach((b, i) => {
      P.push([k.ball(b, i === anchor ? 0.055 : 0.043, 12), C.plaster]);
      P.push([k.tube([[b[0], 0.03, b[2]], [b[0], 0.03 + 0.36 * imp[i], b[2]]], 0.026, 10), C.plaster]);
    });
    const src = beads[anchor];
    const ok = [true, true, false, true, true, false];
    ok.forEach((good, i) => {
      const x = -0.36 + 0.144 * i, z = 0.2;
      P.push([k.box(x - 0.058, 0.03, z - 0.05, x + 0.058, 0.058, z + 0.05), good ? C.good : C.plaster]);
      const end = [x, 0.062, z - 0.02], ctl = [(src[0] + x) / 2, 0.5, (src[2] + z) / 2 - 0.05];
      P.push([k.tube(range(13).map((j) => bez(src, ctl, end, j / 12)), 0.0065, 5), C.prob]);
    });
    return k.done(P);
  },

  /* 27 · The arch: voussoirs of the argument on two abutments (the question; what would change
     your mind); the brass keystone is the claim. */
  'w14-arch': (J) => {
    const k = kit(J), P = [];
    const cy = 0.36, ri = 0.27, ro = 0.41, dz = 0.12, n = 9, gap = 0.012;
    P.push([k.box(-0.5, 0, -0.17, 0.5, 0.04, 0.17), C.plaster]);
    for (const sgn of [-1, 1]) P.push([k.box(sgn > 0 ? 0.255 : -0.445, 0.04, -dz, sgn > 0 ? 0.445 : -0.255, cy, dz), C.plaster]);
    for (let i = 0; i < n; i++) {
      const a0 = Math.PI - (Math.PI * i) / n - gap, a1 = Math.PI - (Math.PI * (i + 1)) / n + gap;
      const key = i === (n - 1) / 2, rOut = key ? ro + 0.05 : ro, rIn = key ? ri - 0.012 : ri;
      const pts = [];
      for (const a of [i === 0 ? Math.PI : a0, i === n - 1 ? 0 : a1]) for (const r of [rIn, rOut]) for (const z of [-dz, dz]) {
        pts.push([r * Math.cos(a), cy + r * Math.sin(a), z]);
      }
      P.push([k.hull(pts), key ? C.brass : C.plaster]);
    }
    return k.done(P);
  },
};
