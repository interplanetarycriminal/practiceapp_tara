/* =============================================================================
   Object Lessons kit  ·  objects/kit.js  (+ objects/kit.css)
   -----------------------------------------------------------------------------
   One import builds a whole object page: top bar with the 2D|3D toggle, a
   full-screen three.js stage (plinth, soft shadow, warm light, OrbitControls),
   the fixed-height label card (tag, beat counter, dots, prev/next, tier pill,
   caption, Knobs · Predict · More), the Knobs drawer, the Predict sheet, the
   More sheet (STL, remix prompt, links, credit), tiers, visits and test hooks.
   Contract: /mnt/project-files/objects/DESIGN.md. Ledger: LEDGER.md.

   ---------------------------------------------------------------- QUICK START
   <!doctype html><html lang="en"><head><meta charset="utf-8">
   <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
   <title>The ravine · Object Lessons</title>
   <link rel="stylesheet" href="../kit.css"></head><body>
   <script type="module">
   import { run, THREE, J, K, C } from '../kit.js';

   run({
     id: 'w03-ravine', num: '05', week: 3, kind: 'weekly',
     title: 'The ravine', subtitle: 'Four optimisers race down ARENA\'s own loss surfaces.',
     back2d: '#week-03',                       // "2D" returns to ../../index.html#week-03
     plinth: { r: 2.6 },                       // optional (default r 2.4, h 0.14); false = none
     knobs: [
       { id: 'lr', type: 'range', label: { 1: 'Step size', 2: 'Learning rate', 3: 'lr' },
         min: 1e-3, max: 1, log: true, value: 0.1, fmt: (v) => K.fmt(v, 3) },
       { id: 'shape', type: 'select', label: 'Surface', options: [['a', 'Bowl'], ['b', 'Saddle']], value: 'a' },
       { id: 'ghost', type: 'toggle', label: 'Show ghost', value: false },
       { id: 'again', type: 'button', label: 'Run again', onClick: (S) => S.state.restart() },
     ],
     setup(S) {                                // once, before the first rebuild
       S.state.ball = K.bead([0, 1, 0], C.data, 0.08);
       S.root.add(S.state.ball);
       S.state.note = K.label(S.state.ball, { 1: 'you', 2: 'the weights', 3: 'θ' }, { dy: -10 });
     },
     rebuild(S, changedId) {                   // after any knob change; '*' = several at once
       if (changedId === 'shape' || changedId === '*') { ... rebuild geometry ... }
     },
     frame(S, t, dt) { ...; return stillAnimating; },   // called every rendered frame
     solids(S) { return [J.primitives.sphere({ radius: 1 })]; },   // STL (JSCAD geom3[])
     beats: [ { tag: 'core', cap: { 1: '...', 2: '...', 3: '...' },
                cam: { pos: [4, 3, 6], target: [0, 0.6, 0] }, set: { lr: 0.1 }, enter(S) {} } ],
     predict: [ { q: { 1, 2, 3 }, options: [{ t: 'Yes', ok: true }, { t: 'No' }], why: { 1, 2, 3 },
                  show(S) { return promiseThatResolvesWhenTheRevealIsDone; } } ],
     where: { 1, 2, 3 }, links: [{ label: 'Film', href: '../../intuition/films/w3-optimisers.html' }],
     remix: 'one dense paragraph prompt', credit: 'Built with three.js and JSCAD.',
   });
   </script></body></html>

   ------------------------------------------------------------------- EXPORTS
   THREE  three r186 namespace (+ OrbitControls, RoundedBoxGeometry, mergeGeometries, mergeVertices)
   J      @jscad/modeling namespace: J.primitives, J.booleans, J.transforms, J.extrusions, ...
   C      semantic colours: grad red, data blue, dir violet, good green, prob amber, aux teal,
          brass, plaster, ink (hex strings; the same meaning on all 28 objects)
   K      helpers (below)
   run(spec)            the whole object page (spec as in DESIGN.md; additions marked +)
   stage(opts)          scene only, no page chrome (the Model Room hub uses this)
   dimToggle(active)    the 2D|3D pill element, 2D target computed from the page location

   ------------------------------------------------------------------ run(spec)
   spec: id, num, week, kind, title, subtitle, back2d, knobs, setup, rebuild, frame, solids,
         beats, predict, where, links, remix, credit
       + plinth {r, h} | false   + fit (number, >1 = object drawn bigger; default 1)
       + fov (deg, default 30)   + onTier(S, tier)   + film ('w3-optimisers', for the no-WebGL card)
   S = { scene, root, camera, controls, renderer, knobs, state, tier, beat, invalidate(),
       + shot (true under ?shot=1: no idle spin, every tween/fly/race finishes instantly)
       + changed (array of knob ids behind the current rebuild call)
       + setKnob(id, value, {silent})  change a knob from code (silent: no rebuild)
       + setKnobs({id: value, ...})     several at once, ONE rebuild(S, '*')
       + tr(text|{1,2,3}|fn)            resolve tiered text for the current tier
       + fly(view, ms) · tween(ms, fn, ease) · stage · spec }
   Beats: set{} is applied with ONE rebuild(S, '*') (S.changed lists the ids), then enter(S),
   then the camera flies to cam (authored for a square view; the kit zooms to fit the free area).
   rebuild(S, id): id is the single knob that changed, or '*' when several changed at once.
   On first load rebuild(S, '*') runs once with S.first === true (build everything) and
   S.changed = the ids the opening beat sets; setup(S) has already run.
   Captions accept `code` and **bold**. Tier 1 <= 200 chars, tiers 2-3 <= 320 chars.
   Predict: show(S) may return a Promise; `why` appears when it resolves (or after 2.6 s).
   URL: ?shot=1 (screenshots), ?beat=3 (open at beat 3, 1-based), ?nowebgl=1 (test fallback).
   Test hooks: window.__obj = { ready, beat(i 0-based), knob(id, v), predict(i), pick(j),
       sheet('knobs'|'predict'|'more'|null), tier(n), stats(), S }.

   --------------------------------------------------------------- K helpers
   K.mesh(geom3|geom3[], material?, {smooth})   JSCAD solid -> THREE.Mesh. JSCAD is z-up
        (print space); the kit maps JSCAD (x, y, z) to three (x, z, -y). Flat normals by default
        (faceted plaster); smooth: merged vertices + vertex normals.
   K.mat.plaster(hex?) · brass() · paint(hex) · glass(hex, opacity) · string(hex) · ink()
   K.arrow(from, to, hex, {r}) -> {group, set(from, to), show(bool)}
   K.tube(points, hex, r) -> {mesh, set(points)}          polyline tube, grows without realloc
   K.bead(pos, hex, r) -> THREE.Mesh                      painted sphere, casts shadow
   K.label(pos|Object3D, text|{1,2,3}|fn, {cls, dx, dy, anchor}) -> {el, set(text), show(bool),
        move(pos)}   crisp HTML label pinned to a 3D point. cls: 'note' | 'readout' | 'tag' | ''
   K.heightfield(fn(x,y), {x:[a,b], y:[a,b], n, zScale | height, base, size, clamp, contours,
        tint:[lo,mid,hi], trim}) -> {mesh, geom (lazy, watertight JSCAD solid), z(x,y),
        toWorld(x, y, lift), toJ(x, y, lift), fmin, fmax, s, dispose()}
        size = world length of the longer side (default 3.6); height = world height of the
        relief (default 1.2) unless zScale is given; base = solid thickness under the lowest point.
   K.pick(obj, onTap(hit)) · K.unpick(obj)                tap/click picking (raycast)
   K.fly({pos, target}, ms) -> Promise                     camera flight
   K.figure({color}) -> {group, pose(name, {at, ms}), place(pos, facing)}  faceless stick figure
        ~0.9 tall. Poses: stand, point (at: [x,y,z] world), think, cheer, shrug, lean.
   K.fmt(n, digits=3)   K.rng(seed) -> () => [0,1)   K.toast(msg)   K.onTier(fn) -> off()
   K.stl(geoms, filename, {scale=25})  binary STL download (1 world unit = 25 mm)
 + K.stlBytes(geoms, {scale}) -> ArrayBuffer   K.tr(text)   K.tween(ms, fn, ease)
 + K.ease.{inOut, out, back, antic}   K.legend(items [{id, label, color}], onPick) -> {set(id, text),
        active(id)}   chips in the HUD slot under the top bar (e.g. a series legend)
 + K.tubeSolid(points3J, r, sides) -> geom3   watertight tube for STL (points in JSCAD coords)

   ----------------------------------------------------------------- stage(opts)
   stage({ host, insets:{top,right,bottom,left}, plinth, fov, fit, view:{pos,target}, shot })
   -> { scene, root, camera, controls, renderer, canvas, invalidate(), onFrame(fn(t, dt) ->
        animating?) -> off(), onRender(fn), setViewInsets(insets, {animate}), fly(view, ms),
        setBaseView(view), resetView(ms), tween(ms, fn, ease), pick(obj, fn), label(...),
        onDoubleTap(fn), stats(), isDark() }   or null when WebGL is unavailable.
   The camera keeps the target centred in the rectangle left free by the insets
   (camera.setViewOffset) and zooms so the object fits it. Renders only on demand.
   Axis convention: y up, plinth top y = 0, objects fit roughly in a 4 x 3 x 4 box.
============================================================================= */

import * as THREE from './vendor/three.js';
import J from './vendor/jscad.js';

export { THREE, J };

/* ----------------------------------------------------------------- constants */

export const C = {
  grad: '#d64545', data: '#2f6fdb', dir: '#7b5cd6', good: '#2f9e6b', prob: '#e8a33d',
  aux: '#1c9aa0', brass: '#b58a3c', plaster: '#f2ede4', ink: '#2b2a33',
};

const Q = new URLSearchParams(location.search);
const SHOT = Q.get('shot') === '1';
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const TIER_NAME = { 1: 'Plain', 2: 'Generalist', 3: 'Expert' };
const TAGS = { core: 'core', exercise: 'exercise', library: 'library', contested: 'contested' };

/* a tiny inline icon, so no page ever asks the server for /favicon.ico (a console 404) */
if (!document.querySelector('link[rel~="icon"]')) {
  const ic = document.createElement('link');
  ic.rel = 'icon';
  ic.href = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='13' fill='%23b58a3c'/%3E%3C/svg%3E";
  document.head.appendChild(ic);
}

/* ------------------------------------------------------------------ helpers */

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
const v3 = (p) => (p && p.isVector3 ? p.clone() : new THREE.Vector3(p[0], p[1], p[2]));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
function lsJSON(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }

export const ease = {
  linear: (t) => t,
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  out: (t) => 1 - Math.pow(1 - t, 3),
  back: (t, s = 1.1) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2),
  // anticipation: dip 12% the other way, then swing through with a small overshoot
  antic: (t) => (t < 0.2 ? -0.12 * Math.sin((t / 0.2) * Math.PI / 2)
    : -0.12 + 1.12 * ease.back((t - 0.2) / 0.8, 1.1)),
};

/* Relative href from the current page to a URL (keeps every link relative). */
function relHref(url) {
  const from = new URL('./', location.href).pathname.split('/').filter(Boolean);
  const to = url.pathname.split('/');
  const file = to.pop();
  const toDir = to.filter(Boolean);
  let i = 0;
  while (i < from.length && i < toDir.length && from[i] === toDir[i]) i++;
  const up = '../'.repeat(from.length - i);
  const down = toDir.slice(i).map((s) => s + '/').join('');
  return (up + down + file) || './';
}
const KIT_URL = new URL(import.meta.url);
const appHref = (tail = '') => relHref(new URL('../index.html', KIT_URL)) + tail;   // app shell
const hubHref = (tail = '') => relHref(new URL('./index.html', KIT_URL)) + tail;    // Model Room

/* ---------------------------------------------------------------------- tier */

const tierFns = new Set();
function readTier() {
  let v = lsGet('tara.tier');
  if (v !== '1' && v !== '2' && v !== '3') v = lsGet('tara.resolution');
  if (v !== '1' && v !== '2' && v !== '3') v = '2';
  return Number(v);
}
let TIER = readTier();
function setTierGlobal(n, write = true) {
  n = Number(n);
  if (n !== 1 && n !== 2 && n !== 3) return;
  TIER = n;
  if (write) { lsSet('tara.tier', String(n)); lsSet('tara.resolution', String(n)); }
  document.documentElement.setAttribute('data-tara-tier', String(n));
  for (const fn of tierFns) { try { fn(n); } catch (e) { console.error(e); } }
}
document.documentElement.setAttribute('data-tara-tier', String(TIER));
addEventListener('storage', (e) => {
  if (e.key === 'tara.tier' || e.key === 'tara.resolution') {
    const n = readTier();
    if (n !== TIER) setTierGlobal(n, false);
  }
});
function tr(x, S) {
  if (x == null) return '';
  if (typeof x === 'function') return String(x(S || CUR_S));
  if (typeof x === 'object') return String(x[TIER] ?? x[2] ?? x[1] ?? x[3] ?? '');
  return String(x);
}

/* --------------------------------------------------------------- theme test */

function isDark() {
  const a = document.documentElement.getAttribute('data-theme');
  if (a === 'dark') return true;
  if (a === 'light') return false;
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

function webglOK() {
  if (Q.get('nowebgl') === '1') return false;
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (e) { return false; }
}

/* ======================================================= 2D | 3D toggle pill */

/**
 * dimToggle(active = '3d', {back2d}) -> HTMLElement
 * "2D" links to <app root>/index.html + (sessionStorage 'tara.dim.back' || back2d);
 * the app root is computed from kit.js's own location, so it works from objects/o/*.html
 * ('../../index.html') and from the hub objects/index.html ('../index.html').
 */
export function dimToggle(active = '3d', o = {}) {
  const wrap = el('div', 'dim-toggle');
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'View: 2D or 3D');
  const a2 = el('a');
  a2.textContent = '2D';
  const back = ssGet('tara.dim.back') || o.back2d || '';
  a2.href = appHref(back);
  a2.setAttribute('aria-pressed', String(active === '2d'));
  a2.title = 'Back to the course (2D)';
  const b3 = el('button');
  b3.type = 'button';
  b3.textContent = '3D';
  b3.setAttribute('aria-pressed', String(active === '3d'));
  b3.title = 'Object Lessons (3D)';
  b3.addEventListener('click', () => {
    if (active === '3d') { if (o.on3d) o.on3d(); return; }
    location.href = hubHref();
  });
  wrap.append(a2, b3);
  return wrap;
}

/* ================================================================== stage() */

let CUR = null;     // the most recent stage (K helpers act on it)
let CUR_S = null;   // the most recent run() state

export function stage(opts = {}) {
  const o = Object.assign({
    host: document.body, insets: { top: 0, right: 0, bottom: 0, left: 0 },
    plinth: {}, fov: 30, fit: 1, view: null, shot: SHOT, idle: !SHOT && !REDUCED,
  }, opts);
  if (!webglOK()) return null;

  const host = o.host;
  const canvas = el('canvas', 'k-canvas');
  canvas.setAttribute('aria-label', 'Interactive 3D object. Drag to turn, pinch or scroll to zoom, double-tap to reset.');
  canvas.setAttribute('role', 'img');
  const labelsEl = el('div', 'k-labels');
  labelsEl.setAttribute('aria-hidden', 'true');
  host.prepend(labelsEl);
  host.prepend(canvas);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    canvas.remove(); labelsEl.remove();
    return null;
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  // r186 removed PCFSoftShadowMap (it now warns and falls back); PCF + radius is its soft successor.
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(o.fov, 1, 0.05, 200);
  camera.position.set(5, 4, 7);
  const controls = new THREE.OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.enablePan = false;
  controls.rotateSpeed = 0.8;
  controls.zoomSpeed = 0.9;
  controls.minDistance = 2;
  controls.maxDistance = 40;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.autoRotateSpeed = 0.75;          // ~80 s per turn
  controls.target.set(0, 0.6, 0);

  /* lights: warm hemisphere + one soft shadow-casting key + a cool rim fill */
  const pr = (o.plinth === false ? 2.4 : (o.plinth.r || 2.4));
  const ph = (o.plinth === false ? 0 : (o.plinth.h ?? 0.14));
  const hemi = new THREE.HemisphereLight(0xfff1dc, 0xa89274, 0.6);
  const key = new THREE.DirectionalLight(0xffe2bf, 1.9);
  key.position.set(-5.5, 5.8, 4.2);        // fairly low: rakes across relief, so shape reads
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.radius = 4;
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.025;
  const sc = key.shadow.camera;
  const ext = pr + 1.0;
  sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 1; sc.far = 25;
  const fill = new THREE.DirectionalLight(0xdfe6ff, 0.3);
  fill.position.set(5, 2.5, -4);
  scene.add(hemi, key, key.target, fill);

  /* environment: a soft warm room, so brass and paint have something to reflect */
  const pmrem = new THREE.PMREMGenerator(renderer);
  function makeEnv(dark) {
    const sc2 = new THREE.Scene();
    const g = new THREE.SphereGeometry(10, 32, 16);
    const top = new THREE.Color(dark ? '#4a4a55' : '#fff4e2');
    const mid = new THREE.Color(dark ? '#24242b' : '#e2d4bf');
    const bot = new THREE.Color(dark ? '#101014' : '#7d6a53');
    const pos = g.attributes.position, cols = [];
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 10;
      const c = y > 0 ? mid.clone().lerp(top, Math.pow(y, 0.7)) : mid.clone().lerp(bot, -y);
      cols.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    sc2.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
    const win = new THREE.Mesh(new THREE.PlaneGeometry(7, 5),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(dark ? 1.4 : 2.6, dark ? 1.3 : 2.35, dark ? 1.2 : 2.0) }));
    win.position.set(-5, 6, 5); win.lookAt(0, 0, 0);
    sc2.add(win);
    const rt = pmrem.fromScene(sc2, 0.035);
    g.dispose();
    return rt;
  }
  let envRT = null;

  /* floor (shadow only) and plinth */
  const floorMat = new THREE.ShadowMaterial({ color: 0x5b4630, opacity: 0.24 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -ph - 0.001;
  floor.receiveShadow = true;
  scene.add(floor);

  let plinth = null;
  if (o.plinth !== false) {
    plinth = new THREE.Group();
    const pm = new THREE.MeshStandardMaterial({ color: '#dcd0bd', roughness: 0.94, metalness: 0 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(pr, pr * 1.012, ph, 128, 1), pm);
    body.position.y = -ph / 2;
    body.castShadow = true; body.receiveShadow = true;
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(pr * 1.03, pr * 1.04, 0.03, 128, 1),
      new THREE.MeshStandardMaterial({ color: '#cbbda6', roughness: 0.95 }));
    foot.position.y = -ph + 0.015;
    foot.receiveShadow = true;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(pr + 0.003, 0.02, 10, 192), MAT.brass());
    rim.rotation.x = Math.PI / 2;
    rim.position.y = -0.008;
    rim.castShadow = true;
    plinth.add(body, foot, rim);
    scene.add(plinth);
  }
  const root = new THREE.Group();
  scene.add(root);

  /* theme */
  const themeFns = new Set();
  function applyTheme() {
    const d = isDark();
    scene.background = new THREE.Color(d ? '#15161a' : '#efe9df');
    floorMat.color.set(d ? '#000000' : '#5b4630');
    floorMat.opacity = d ? 0.5 : 0.24;
    hemi.color.set(d ? 0xbfc0d0 : 0xfff1dc);
    hemi.groundColor.set(d ? 0x2a2622 : 0xa89274);
    hemi.intensity = d ? 0.5 : 0.6;
    key.intensity = d ? 1.9 : 1.9;
    fill.intensity = d ? 0.45 : 0.3;
    if (envRT) envRT.dispose();
    envRT = makeEnv(d);
    scene.environment = envRT.texture;
    scene.environmentIntensity = d ? 0.3 : 0.35;
    for (const fn of themeFns) { try { fn(d); } catch (e) { console.error(e); } }
    invalidate();
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  /* sizing + view offset (object centred in the free rectangle) */
  const size = { w: 1, h: 1 };
  let ins = Object.assign({ top: 0, right: 0, bottom: 0, left: 0 }, o.insets);
  let insTo = null;
  /* Framing. The free rectangle (viewport minus insets) gets the object:
     - fit 'auto' (default): a rotation-invariant fit volume (the plinth cylinder, grown to
       enclose S.root) is projected from the camera pose; zoom makes its box fill the free
       rectangle and the view offset centres that box there. Turntable-safe.
     - fit k (number): close-up; zoom = k * min(freeW, freeH) / H with the target centred. */
  let fitMode = 'auto';
  const fit = { z: 1, u: 0, v: 0 };
  const safe = () => {
    const W = size.w, H = size.h;
    const x0 = ins.left, x1 = W - ins.right, y0 = ins.top, y1 = H - ins.bottom;
    return { W, H, sw: Math.max(60, x1 - x0), sh: Math.max(60, y1 - y0), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  };
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _bb = new THREE.Box3();
  function fitVolume() {
    root.updateWorldMatrix(true, true);
    _bb.makeEmpty();
    root.traverseVisible((ob) => { if (ob.isMesh && !ob.userData.noFit && ob.geometry) {
      if (!ob.geometry.boundingBox) ob.geometry.computeBoundingBox();
      const b = ob.geometry.boundingBox.clone().applyMatrix4(ob.matrixWorld);
      if (Number.isFinite(b.min.x)) _bb.union(b);
    } });
    let r = plinth ? pr : 0.5, y0 = plinth ? -ph : 0, y1 = 0.2;
    if (!_bb.isEmpty()) {
      for (const [x, z] of [[_bb.min.x, _bb.min.z], [_bb.min.x, _bb.max.z], [_bb.max.x, _bb.min.z], [_bb.max.x, _bb.max.z]]) r = Math.max(r, Math.min(Math.hypot(x, z), pr * 1.35 + 0.5));
      y1 = Math.max(y1, _bb.max.y); y0 = Math.min(y0, _bb.min.y);
    }
    const pts = [];
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2, x = Math.cos(a) * r, z = Math.sin(a) * r;
      pts.push(new THREE.Vector3(x, y0, z), new THREE.Vector3(x, y1, z));
    }
    return pts;
  }
  function computeFit(pos, target, mode = fitMode) {
    const { H, sw, sh } = safe();
    if (typeof mode === 'number') return { z: mode * o.fit * Math.min(sw, sh) / H, u: 0, v: 0 };
    _m.lookAt(pos, target, camera.up);
    _q.setFromRotationMatrix(_m).invert();
    const t = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2), k = H / 2 / t;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of fitVolume()) {
      _p.copy(p).sub(pos).applyQuaternion(_q);
      const d = -_p.z;
      if (d < 0.05) continue;
      const u = (_p.x / d) * k, v = -(_p.y / d) * k;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    if (!Number.isFinite(u0)) return { z: Math.min(sw, sh) / H, u: 0, v: 0 };
    const z = 0.93 * o.fit * Math.min(sw / Math.max(1, u1 - u0), sh / Math.max(1, v1 - v0));
    return { z, u: (u0 + u1) / 2, v: (v0 + v1) / 2 };
  }
  function applyView() {
    const { W, H, cx, cy } = safe();
    camera.aspect = W / H;
    camera.zoom = fit.z;
    const ppx = cx - fit.z * fit.u, ppy = cy - fit.z * fit.v;   // principal point (target) on screen
    camera.setViewOffset(W, H, W / 2 - ppx, H / 2 - ppy, W, H);
    camera.updateProjectionMatrix();
  }
  function refit() { Object.assign(fit, computeFit(camera.position, controls.target)); applyView(); invalidate(); }
  function resize() {
    const W = Math.max(1, canvas.clientWidth || innerWidth), H = Math.max(1, canvas.clientHeight || innerHeight);
    if (W === size.w && H === size.h) return;
    size.w = W; size.h = H;
    renderer.setSize(W, H, false);
    if (!flying) refit(); else applyView();
    invalidate();
  }
  new ResizeObserver(resize).observe(canvas);
  addEventListener('resize', resize);

  function setViewInsets(next, { animate = true } = {}) {
    const to = Object.assign({}, ins, next);
    if (!animate || o.shot) { ins = to; insTo = null; if (!flying) refit(); else applyView(); invalidate(); return; }
    const from = Object.assign({}, ins);
    insTo = to;
    tween(260, (k) => {
      if (insTo !== to) return;
      for (const s of ['top', 'right', 'bottom', 'left']) ins[s] = from[s] + (to[s] - from[s]) * k;
      if (!flying) Object.assign(fit, computeFit(camera.position, controls.target));
      applyView();
    }, ease.inOut);
  }

  /* render on demand */
  let needs = true, raf = 0, last = 0, spinning = false, firstRender = null;
  const frameFns = new Set(), renderFns = new Set(), tweens = new Set();
  const perf = { frames: [], render: [] };
  function invalidate() { needs = true; schedule(); }
  function schedule() { if (!raf && !document.hidden) raf = requestAnimationFrame(tick); }
  function tick(now) {
    raf = 0;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
    if (last) { perf.frames.push(now - last); if (perf.frames.length > 60) perf.frames.shift(); }
    last = now;
    let active = false;
    for (const tw of tweens) {
      const p = Math.min(1, (now - tw.t0) / tw.ms);
      try { tw.fn(tw.ease(p)); } catch (e) { console.error(e); }
      if (p >= 1) { tweens.delete(tw); tw.res(); } else active = true;
    }
    for (const fn of frameFns) {
      try { if (fn(now / 1000, dt)) active = true; } catch (e) { console.error(e); }
    }
    const moved = controls.update(dt);
    if (spinning) active = true;
    if (needs || active || moved) {
      const r0 = performance.now();
      renderer.render(scene, camera);
      projectLabels();
      for (const fn of renderFns) fn();
      perf.render.push(performance.now() - r0);
      if (perf.render.length > 60) perf.render.shift();
      needs = false;
      if (firstRender) { const f = firstRender; firstRender = null; f(); }
    }
    if (active || moved) schedule(); else last = 0;
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { last = 0; invalidate(); } });
  controls.addEventListener('change', invalidate);

  function tween(ms, fn, ez = ease.inOut) {
    return new Promise((res) => {
      if (o.shot || !ms || ms <= 0) { fn(1); invalidate(); res(); return; }
      tweens.add({ t0: performance.now(), ms, fn, ease: ez, res });
      schedule();
    });
  }

  /* idle turntable */
  let idleT = 0;
  function markIdle() {
    clearTimeout(idleT);
    if (!o.idle) return;
    idleT = setTimeout(() => { spinning = true; controls.autoRotate = true; schedule(); }, 6000);
  }
  function stopSpin() { spinning = false; controls.autoRotate = false; clearTimeout(idleT); }
  controls.addEventListener('start', stopSpin);
  controls.addEventListener('end', markIdle);
  addEventListener('keydown', () => { stopSpin(); markIdle(); });
  canvas.addEventListener('wheel', () => { stopSpin(); markIdle(); }, { passive: true });

  /* camera flights */
  let baseView = o.view;
  let flight = 0, flying = false;
  function fly(view, ms = 950) {
    if (!view) return Promise.resolve();
    const my = ++flight;
    const p1 = v3(view.pos), t1 = v3(view.target);
    const p0 = camera.position.clone(), t0 = controls.target.clone();
    const o0 = p0.clone().sub(t0), o1 = p1.clone().sub(t1);
    const r0 = o0.length(), r1 = o1.length();
    const d0 = o0.clone().normalize(), d1 = o1.clone().normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(d0, d1), qi = new THREE.Quaternion();
    const modeFrom = fitMode, modeTo = view.fit ?? 'auto';
    fitMode = modeTo;
    stopSpin();
    controls.enableDamping = false;
    controls.update();
    flying = true;
    return tween(ms, (k) => {
      if (my !== flight) return;
      qi.identity().slerp(q, k);
      const dir = d0.clone().applyQuaternion(qi);
      controls.target.lerpVectors(t0, t1, k);
      camera.position.copy(controls.target).addScaledVector(dir, r0 + (r1 - r0) * k);
      camera.lookAt(controls.target);
      const fB = computeFit(camera.position, controls.target, modeTo);
      if (modeFrom !== modeTo && k < 1) {
        const fA = computeFit(camera.position, controls.target, modeFrom);
        fit.z = fA.z + (fB.z - fA.z) * k; fit.u = fA.u + (fB.u - fA.u) * k; fit.v = fA.v + (fB.v - fA.v) * k;
      } else Object.assign(fit, fB);
      applyView();
    }, ease.inOut).then(() => {
      if (my === flight) flying = false;
      if (my !== flight) return;
      controls.enableDamping = true;
      controls.update();
      markIdle();
    });
  }
  function setBaseView(v) { baseView = v; }
  function resetView(ms = 700) { return fly(baseView, ms); }

  /* picking + double-tap */
  const pickables = [];
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let down = null, lastTap = 0, lastXY = null, dblFn = () => resetView();
  canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
    stopSpin();
  }, { passive: true });
  canvas.addEventListener('pointerup', (e) => {
    markIdle();
    if (!down || e.pointerId !== down.id) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y, dt = performance.now() - down.t;
    down = null;
    if (dx * dx + dy * dy > 64 || dt > 450) return;
    const now = performance.now();
    if (now - lastTap < 330 && lastXY && Math.hypot(e.clientX - lastXY.x, e.clientY - lastXY.y) < 40) {
      lastTap = 0; dblFn(); return;
    }
    lastTap = now; lastXY = { x: e.clientX, y: e.clientY };
    if (!pickables.length) return;
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(pickables.map((p) => p.obj), true);
    for (const h of hits) {
      for (let ob = h.object; ob; ob = ob.parent) {
        const p = pickables.find((q) => q.obj === ob);
        if (p) { p.fn(h); return; }
      }
    }
  }, { passive: true });
  function pick(obj, fn) { pickables.push({ obj, fn }); }
  function unpick(obj) { const i = pickables.findIndex((p) => p.obj === obj); if (i >= 0) pickables.splice(i, 1); }

  /* HTML labels pinned to 3D points */
  const labels = new Set();
  const tv = new THREE.Vector3(), tc = new THREE.Vector3();
  const ANCH = { bottom: [-0.5, -1], top: [-0.5, 0], left: [0, -0.5], right: [-1, -0.5], center: [-0.5, -0.5] };
  /* Labels are clamped inside the free rectangle (never under the bar, card or a sheet),
     and overlaps are resolved by priority: readout 3 > note 2 > plain 1 > tag 0 (or opt.prio).
     A lower-priority label is nudged up to 56 px; if it still collides it hides this frame. */
  function projectLabels() {
    const W = size.w, H = size.h;
    const top0 = ins.top + 2, bot0 = H - ins.bottom - 2;
    const live = [];
    for (const L of labels) {
      if (!L.on) { if (L.shown) { L.el.style.display = 'none'; L.shown = false; } continue; }
      if (L.target.isObject3D) L.target.getWorldPosition(tv); else tv.copy(L.target);
      tc.copy(tv).applyMatrix4(camera.matrixWorldInverse);
      let ok = tc.z < -camera.near;
      let x = 0, y = 0;
      if (ok) {
        tv.project(camera);
        x = (tv.x + 1) / 2 * W + L.dx; y = (1 - tv.y) / 2 * H + L.dy;
        ok = x > -40 && x < W + 40 && y > top0 - 30 && y < bot0 + 30;
      }
      if (!ok) { if (L.shown) { L.el.style.display = 'none'; L.shown = false; } continue; }
      if (!L.shown) { L.el.style.display = ''; L.shown = true; }
      if (L.w == null) { L.w = L.el.offsetWidth; L.h = L.el.offsetHeight; }
      let l = x + L.anchor[0] * L.w, t = y + L.anchor[1] * L.h;
      l = Math.min(Math.max(6, l), W - 6 - L.w);
      t = Math.min(Math.max(top0, t), bot0 - L.h);
      live.push({ L, l, t });
    }
    live.sort((a, b) => b.L.prio - a.L.prio);
    const placed = [];
    const hit = (a, b) => a.l < b.l + b.L.w + 3 && a.l + a.L.w + 3 > b.l && a.t < b.t + b.L.h + 3 && a.t + a.L.h + 3 > b.t;
    for (const a of live) {
      let bad = placed.find((b) => hit(a, b));
      if (bad) {
        const t0 = a.t;
        for (const cand of [bad.t + bad.L.h + 4, bad.t - a.L.h - 4]) {
          if (Math.abs(cand - t0) > 56 || cand < top0 || cand + a.L.h > bot0) continue;
          a.t = cand;
          if (!placed.some((b) => hit(a, b))) { bad = null; break; }
        }
        if (bad) a.t = t0;
      }
      const hide = !!bad;
      if (a.L.hidden !== hide) { a.L.el.style.visibility = hide ? 'hidden' : ''; a.L.hidden = hide; }
      if (!hide) placed.push(a);
      a.L.el.style.transform = `translate3d(${a.l.toFixed(1)}px,${a.t.toFixed(1)}px,0)`;
    }
  }
  const PRIO = { readout: 3, note: 2, tag: 0 };
  function label(target, text, opt = {}) {
    const cls = opt.cls || '';
    const e = el('div', 'k-label' + (cls ? ' ' + cls.split(' ').map((c) => 'k-' + c).join(' ') : ''));
    labelsEl.appendChild(e);
    const L = { el: e, target: target.isObject3D ? target : v3(target), text, on: true, shown: true,
      dx: opt.dx || 0, dy: opt.dy ?? -8, anchor: ANCH[opt.anchor || 'bottom'] || ANCH.bottom,
      prio: opt.prio ?? (PRIO[cls.split(' ')[0]] ?? 1), w: null, h: null };
    const paint = () => { const s = tr(L.text); if (e._s !== s) { e._s = s; e.innerHTML = md(s); L.w = null; } };
    paint();
    labels.add(L);
    const off = K.onTier(paint);
    const api = {
      el: e,
      set(t) { L.text = t; paint(); invalidate(); return api; },
      show(b = true) { L.on = !!b; invalidate(); return api; },
      move(p) { L.target = p.isObject3D ? p : v3(p); invalidate(); return api; },
      remove() { labels.delete(L); e.remove(); off(); },
    };
    invalidate();
    return api;
  }

  applyTheme();
  resize();
  if (baseView) {
    camera.position.copy(v3(baseView.pos));
    controls.target.copy(v3(baseView.target));
    fitMode = baseView.fit ?? 'auto';
    controls.update();
  }
  refit();
  markIdle();

  const api = {
    scene, root, camera, controls, renderer, canvas, labelsEl, plinth, shot: o.shot,
    plinthR: pr, plinthH: ph,
    invalidate, tween, fly, setBaseView, resetView, setViewInsets, pick, unpick, label, refit,
    getInsets: () => Object.assign({}, ins),
    onFrame(fn) { frameFns.add(fn); schedule(); return () => frameFns.delete(fn); },
    onRender(fn) { renderFns.add(fn); return () => renderFns.delete(fn); },
    onTheme(fn) { themeFns.add(fn); return () => themeFns.delete(fn); },
    onDoubleTap(fn) { dblFn = fn; },
    whenRendered() { return new Promise((r) => { firstRender = r; invalidate(); }); },
    stopIdle: stopSpin, isDark,
    stats() {
      const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
      return { frameMs: +avg(perf.frames).toFixed(2), renderMs: +avg(perf.render).toFixed(2), samples: perf.frames.length };
    },
  };
  CUR = api;
  return api;
}

/* ================================================================ materials */

const MAT = {
  plaster: (hex = C.plaster) => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.92, metalness: 0 }),
  brass: () => new THREE.MeshStandardMaterial({ color: C.brass, roughness: 0.34, metalness: 0.9 }),
  paint: (hex) => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.42, metalness: 0.02 }),
  glass: (hex = '#ffffff', opacity = 0.35) => new THREE.MeshStandardMaterial({
    color: hex, roughness: 0.15, metalness: 0, transparent: true, opacity, depthWrite: false }),
  string: (hex) => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.7, metalness: 0, emissive: hex, emissiveIntensity: 0.12 }),
  ink: () => new THREE.MeshStandardMaterial({ color: C.ink, roughness: 0.6, metalness: 0.02 }),
};

/* ================================================================= K helpers */

export const K = {};
K.mat = MAT;
K.ease = ease;
K.tr = (t) => tr(t);
K.onTier = (fn) => { tierFns.add(fn); return () => tierFns.delete(fn); };
K.tween = (ms, fn, ez) => CUR.tween(ms, fn, ez);
K.fly = (view, ms) => CUR.fly(view, ms);
K.pick = (obj, fn) => CUR.pick(obj, fn);
K.unpick = (obj) => CUR.unpick(obj);
K.label = (pos, text, opt) => CUR.label(pos, text, opt);

K.fmt = function fmt(n, d = 3) {
  if (n == null || Number.isNaN(n)) return '—';
  if (!Number.isFinite(n)) return n > 0 ? '∞' : '−∞';
  const a = Math.abs(n);
  let s;
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) {
    const [m, e] = n.toExponential(Math.max(0, d - 1)).split('e');
    s = m + 'e' + (e[0] === '+' ? e.slice(1) : e);
  } else if (a === 0) {
    s = '0';
  } else {
    const dec = Math.min(6, Math.max(0, d - 1 - Math.floor(Math.log10(a))));
    s = n.toFixed(dec);
  }
  return s.replace(/-/g, '−');
};

K.rng = function rng(seed = 1) {
  let a = (seed >>> 0) || 1;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

let toastT = 0;
K.toast = function toast(msg, ms = 2200) {
  let t = document.querySelector('.k-toast');
  if (!t) { t = el('div', 'k-toast'); t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('on'), ms);
};

/* ---- JSCAD -> three (triangles shared with the STL writer) ---- */

function geomTris(geoms, fn) {
  const list = Array.isArray(geoms) ? geoms.flat(Infinity) : [geoms];
  for (const g of list) {
    if (!g) continue;
    const polys = J.geometries.geom3.toPolygons(g);
    for (const p of polys) {
      const v = p.vertices;
      for (let k = 1; k + 1 < v.length; k++) fn(v[0], v[k], v[k + 1]);
    }
  }
}

K.mesh = function mesh(geoms, material, o = {}) {
  const pos = [];
  // JSCAD (x, y, z) z-up  ->  three (x, z, -y) y-up
  geomTris(geoms, (a, b, c) => { pos.push(a[0], a[2], -a[1], b[0], b[2], -b[1], c[0], c[2], -c[1]); });
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (o.smooth) { g = THREE.mergeVertices(g, 1e-5); }
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, material || MAT.plaster());
  m.castShadow = true; m.receiveShadow = true;
  return m;
};

/* ---- binary STL ---- */

K.stlBytes = function stlBytes(geoms, o = {}) {
  const s = o.scale ?? 25;
  const tris = [];
  geomTris(geoms, (a, b, c) => tris.push(a, b, c));
  const n = tris.length / 3;
  const buf = new ArrayBuffer(84 + 50 * n);
  const dv = new DataView(buf);
  const head = 'Object Lessons (TARA) - binary STL, units mm';
  for (let i = 0; i < 80; i++) dv.setUint8(i, i < head.length ? head.charCodeAt(i) : 32);
  dv.setUint32(80, n, true);
  let off = 84;
  for (let t = 0; t < n; t++) {
    const a = tris[3 * t], b = tris[3 * t + 1], c = tris[3 * t + 2];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    dv.setFloat32(off, nx, true); dv.setFloat32(off + 4, ny, true); dv.setFloat32(off + 8, nz, true);
    off += 12;
    for (const p of [a, b, c]) {
      dv.setFloat32(off, p[0] * s, true); dv.setFloat32(off + 4, p[1] * s, true); dv.setFloat32(off + 8, p[2] * s, true);
      off += 12;
    }
    dv.setUint16(off, 0, true); off += 2;
  }
  return buf;
};

K.stl = function stl(geoms, filename = 'object.stl', o = {}) {
  const buf = K.stlBytes(geoms, o);
  const url = URL.createObjectURL(new Blob([buf], { type: 'model/stl' }));
  const a = el('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return buf.byteLength;
};

/* ---- watertight tube solid for STL (points in JSCAD coords) ---- */

K.tubeSolid = function tubeSolid(pts, r = 0.03, sides = 8) {
  const P = pts.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
  const clean = [P[0]];
  for (let i = 1; i < P.length; i++) if (P[i].distanceTo(clean[clean.length - 1]) > r * 0.5) clean.push(P[i]);
  if (clean.length < 2) return null;
  const rings = frames(clean);
  const points = [], faces = [];
  clean.forEach((p, i) => {
    const { n, b } = rings[i];
    for (let s = 0; s < sides; s++) {
      const an = (s / sides) * Math.PI * 2;
      const d = n.clone().multiplyScalar(Math.cos(an)).addScaledVector(b, Math.sin(an));
      const q = p.clone().addScaledVector(d, r);
      points.push([q.x, q.y, q.z]);
    }
  });
  const N = clean.length;
  for (let i = 0; i < N - 1; i++) {
    for (let s = 0; s < sides; s++) {
      const a = i * sides + s, b = i * sides + (s + 1) % sides, c = (i + 1) * sides + s, d = (i + 1) * sides + (s + 1) % sides;
      faces.push([a, b, d, c]);
    }
  }
  faces.push([...Array(sides).keys()].reverse());
  faces.push([...Array(sides).keys()].map((s) => (N - 1) * sides + s));
  return J.primitives.polyhedron({ points, faces, orientation: 'outward' });
};

/* parallel-transport frames along a polyline (Vector3[]) */
function frames(P) {
  const out = [];
  let prevN = null;
  for (let i = 0; i < P.length; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
    const t = b.clone().sub(a);
    if (t.lengthSq() < 1e-12) t.set(0, 0, 1);
    t.normalize();
    let n;
    if (prevN) { n = prevN.clone().addScaledVector(t, -prevN.dot(t)); }
    if (!n || n.lengthSq() < 1e-8) {
      const up = Math.abs(t.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      n = new THREE.Vector3().crossVectors(t, up);
    }
    n.normalize();
    const b2 = new THREE.Vector3().crossVectors(t, n).normalize();
    out.push({ t, n, b: b2 });
    prevN = n;
  }
  return out;
}

/* ---- tube (coloured string along a polyline; grows without realloc) ---- */

K.tube = function tube(points, hex = C.ink, r = 0.015, o = {}) {
  const sides = o.sides || 6;
  const geo = new THREE.BufferGeometry();
  let cap = 0, pos, nor;
  function alloc(n) {
    cap = n;
    pos = new Float32Array(cap * sides * 3);
    nor = new Float32Array(cap * sides * 3);
    const idx = new Uint32Array(Math.max(0, cap - 1) * sides * 6);
    let k = 0;
    for (let i = 0; i < cap - 1; i++) {
      for (let s = 0; s < sides; s++) {
        const a = i * sides + s, b = i * sides + (s + 1) % sides, c = (i + 1) * sides + s, d = (i + 1) * sides + (s + 1) % sides;
        idx[k++] = a; idx[k++] = b; idx[k++] = c;
        idx[k++] = b; idx[k++] = d; idx[k++] = c;
      }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  const mat = o.material || MAT.string(hex);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = o.shadow ?? true;
  mesh.frustumCulled = false;
  function set(pts) {
    const P = pts.map((p) => (p.isVector3 ? p : new THREE.Vector3(p[0], p[1], p[2])));
    if (P.length > cap) alloc(Math.max(16, Math.ceil(P.length * 1.5)));
    if (P.length < 2) { geo.setDrawRange(0, 0); return; }
    const F = frames(P);
    for (let i = 0; i < P.length; i++) {
      const { n, b } = F[i];
      for (let s = 0; s < sides; s++) {
        const an = (s / sides) * Math.PI * 2, c = Math.cos(an), si = Math.sin(an);
        const dx = n.x * c + b.x * si, dy = n.y * c + b.y * si, dz = n.z * c + b.z * si;
        const j = (i * sides + s) * 3;
        pos[j] = P[i].x + dx * r; pos[j + 1] = P[i].y + dy * r; pos[j + 2] = P[i].z + dz * r;
        nor[j] = dx; nor[j + 1] = dy; nor[j + 2] = dz;
      }
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;
    geo.setDrawRange(0, (P.length - 1) * sides * 6);
  }
  alloc(Math.max(16, points.length));
  set(points);
  return { mesh, set };
};

/* ---- bead ---- */

const beadGeo = new THREE.SphereGeometry(1, 28, 18);
K.bead = function bead(pos = [0, 0, 0], hex = C.data, r = 0.06) {
  const m = new THREE.Mesh(beadGeo, MAT.paint(hex));
  m.scale.setScalar(r);
  m.position.copy(v3(pos));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
};

/* ---- arrow ---- */

const UP = new THREE.Vector3(0, 1, 0);
K.arrow = function arrow(from, to, hex = C.grad, o = {}) {
  const r = o.r || 0.022;
  const mat = MAT.paint(hex);
  const group = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 12, 1).translate(0, 0.5, 0), mat);
  const head = new THREE.Mesh(new THREE.ConeGeometry(r * 2.7, r * 7, 16, 1).translate(0, r * 3.5, 0), mat);
  shaft.castShadow = head.castShadow = true;
  group.add(shaft, head);
  const d = new THREE.Vector3();
  function set(a, b) {
    const A = v3(a), B = v3(b);
    d.copy(B).sub(A);
    const len = d.length();
    group.visible = len > 1e-6;
    if (!group.visible) return;
    const hl = Math.min(r * 7, len * 0.45);
    head.scale.setScalar(hl / (r * 7));
    shaft.scale.set(1, Math.max(1e-4, len - hl), 1);
    head.position.y = len - hl;
    group.position.copy(A);
    group.quaternion.setFromUnitVectors(UP, d.normalize());
  }
  set(from, to);
  return { group, set, show(b = true) { group.visible = !!b; } };
};

/* ---- HUD legend chips (API addition) ---- */

K.legend = function legend(items, onPick) {
  const hud = document.querySelector('.k-hud');
  if (!hud) return { set() {}, active() {} };
  hud.innerHTML = '';
  const chips = {};
  for (const it of items) {
    const b = el('button', 'k-chip');
    b.type = 'button';
    b.innerHTML = `<i style="background:${esc(it.color)}"></i><span class="k-chip-t"></span><span class="k-chip-v"></span>`;
    const t = b.querySelector('.k-chip-t');
    const paint = () => { t.textContent = tr(it.label); };
    paint(); K.onTier(paint);
    b.addEventListener('click', () => onPick && onPick(it.id));
    hud.appendChild(b);
    chips[it.id] = b;
  }
  hud.classList.toggle('on', items.length > 0);
  if (CUR_S && CUR_S._relayout) CUR_S._relayout(false);
  return {
    set(id, v) { const c = chips[id]; if (c) { const s = c.querySelector('.k-chip-v'); if (s.textContent !== v) s.textContent = v; } },
    active(id) { for (const k in chips) chips[k].setAttribute('aria-pressed', String(k === id)); },
  };
};

/* ================================================================= heightfield */

/*
 K.heightfield(fn, opts): plaster terrain for z = fn(x, y).
 - three mesh: smooth top with height-tinted vertex colours + contour lines (shader), flat skirts,
   optional brass trim; sits on y = 0.
 - geom (lazy getter): watertight JSCAD polyhedron (top grid + 4 skirts + bottom fan), z-up.
*/
K.heightfield = function heightfield(fn, o = {}) {
  const [x0, x1] = o.x || [-1, 1];
  const [y0, y1] = o.y || [-1, 1];
  const spanX = x1 - x0, spanY = y1 - y0, span = Math.max(spanX, spanY);
  const n = o.n || 96;
  const nx = o.nx || Math.max(8, Math.round(n * spanX / span));
  const ny = o.ny || Math.max(8, Math.round(n * spanY / span));
  const size = o.size || 3.6;
  const s = size / span;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const clampF = (v) => (o.clamp ? Math.min(o.clamp[1], Math.max(o.clamp[0], v)) : v);
  const W1 = nx + 1;
  const F = new Float64Array((nx + 1) * (ny + 1));
  let fmin = Infinity, fmax = -Infinity;
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const v = clampF(fn(x0 + spanX * i / nx, y0 + spanY * j / ny));
      F[j * W1 + i] = v;
      if (v < fmin) fmin = v;
      if (v > fmax) fmax = v;
    }
  }
  if (o.fmin != null) fmin = o.fmin;
  if (o.fmax != null) fmax = o.fmax;
  const range = (fmax - fmin) || 1;
  const height = o.height ?? 1.2;
  const zScale = o.zScale ?? height / range;
  const base = o.base ?? 0.12;
  const hOf = (v) => base + (v - fmin) * zScale;
  const X = (x) => (x - cx) * s, Z = (y) => -(y - cy) * s;

  /* top surface */
  const cnt = (nx + 1) * (ny + 1);
  const pos = new Float32Array(cnt * 3), col = new Float32Array(cnt * 3);
  const tint = (o.tint || ['#c3d8cf', '#f2ece2', '#e6ae94']).map((h) => new THREE.Color(h));
  const tc = new THREE.Color();
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const k = j * W1 + i, v = F[k];
      pos[3 * k] = X(x0 + spanX * i / nx);
      pos[3 * k + 1] = hOf(v);
      pos[3 * k + 2] = Z(y0 + spanY * j / ny);
      const t = Math.min(1, Math.max(0, (v - fmin) / range));
      if (t < 0.5) tc.copy(tint[0]).lerp(tint[1], t / 0.5); else tc.copy(tint[1]).lerp(tint[2], (t - 0.5) / 0.5);
      col[3 * k] = tc.r; col[3 * k + 1] = tc.g; col[3 * k + 2] = tc.b;
    }
  }
  const idx = new Uint32Array(nx * ny * 6);
  let q = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * W1 + i, b = a + 1, c = a + 1 + W1, d = a + W1;
      idx[q++] = a; idx[q++] = b; idx[q++] = c;
      idx[q++] = a; idx[q++] = c; idx[q++] = d;
    }
  }
  const topGeo = new THREE.BufferGeometry();
  topGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  topGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  topGeo.setIndex(new THREE.BufferAttribute(idx, 1));
  topGeo.computeVertexNormals();

  const topMat = new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.9, metalness: 0 });
  const levels = o.contours ?? 12;
  if (levels > 0) {
    const step = (range * zScale) / levels;
    topMat.onBeforeCompile = (sh) => {
      sh.uniforms.uStep = { value: step };
      sh.uniforms.uBase = { value: base };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vH;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvH = position.y;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vH;\nuniform float uStep;\nuniform float uBase;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          float kh = (vH - uBase) / uStep - 0.5;
          float kw = fwidth(kh);
          float kl = 1.0 - smoothstep(0.0, kw * 1.15, abs(fract(kh - 0.5) - 0.5));
          float k5 = (vH - uBase) / (uStep * 4.0) - 0.125;
          float kw5 = fwidth(k5);
          float kl5 = 1.0 - smoothstep(0.0, kw5 * 1.5, abs(fract(k5 - 0.5) - 0.5));
          diffuseColor.rgb *= 1.0 - 0.2 * max(kl * 0.75, kl5);`);
    };
    topMat.customProgramCacheKey = () => 'k-contour';
  }
  const top = new THREE.Mesh(topGeo, topMat);
  top.castShadow = true; top.receiveShadow = true;

  /* skirts (flat, plaster) */
  const per = [];   // perimeter grid coords, CCW seen from above in (x right, y forward)
  for (let i = 0; i < nx; i++) per.push([i, 0]);
  for (let j = 0; j < ny; j++) per.push([nx, j]);
  for (let i = nx; i > 0; i--) per.push([i, ny]);
  for (let j = ny; j > 0; j--) per.push([0, j]);
  const sk = [];
  for (let p = 0; p < per.length; p++) {
    const [ia, ja] = per[p], [ib, jb] = per[(p + 1) % per.length];
    const ka = ja * W1 + ia, kb = jb * W1 + ib;
    const ax = pos[3 * ka], ay = pos[3 * ka + 1], az = pos[3 * ka + 2];
    const bx = pos[3 * kb], by = pos[3 * kb + 1], bz = pos[3 * kb + 2];
    // outward quad: top a, bottom a, bottom b, top b (three coords; see note in the JSCAD block)
    sk.push(ax, ay, az, bx, 0, bz, ax, 0, az, ax, ay, az, bx, by, bz, bx, 0, bz);
  }
  const skGeo = new THREE.BufferGeometry();
  skGeo.setAttribute('position', new THREE.Float32BufferAttribute(sk, 3));
  skGeo.computeVertexNormals();
  const skirt = new THREE.Mesh(skGeo, MAT.plaster('#e9e2d6'));
  skirt.castShadow = true; skirt.receiveShadow = true;

  const mesh = new THREE.Group();
  mesh.add(top, skirt);
  if (o.trim !== false) {
    const bm = MAT.brass();
    const tw = 0.018, th = Math.min(0.07, base * 0.6);
    const hx = spanX * s / 2, hz = spanY * s / 2;
    const mk = (w, d, x, z) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, th, d), bm);
      b.position.set(x, th / 2, z); b.castShadow = true; b.receiveShadow = true; mesh.add(b);
    };
    mk(2 * hx + 2 * tw, tw, 0, hz + tw / 2); mk(2 * hx + 2 * tw, tw, 0, -hz - tw / 2);
    mk(tw, 2 * hz, hx + tw / 2, 0); mk(tw, 2 * hz, -hx - tw / 2, 0);
  }

  /* lazy watertight JSCAD solid: points (x*s, y*s, h) in JSCAD z-up; faces outward */
  let geomCache = null;
  function buildGeom() {
    const points = [], faces = [];
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const k = j * W1 + i;
        points.push([pos[3 * k], -pos[3 * k + 2], pos[3 * k + 1]]);
      }
    }
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * W1 + i, b = a + 1, c = a + 1 + W1, d = a + W1;
        faces.push([a, b, c], [a, c, d]);
      }
    }
    const bIdx = new Map();
    const bottom = (i, j) => {
      const key = j * W1 + i;
      if (!bIdx.has(key)) { const k = key; bIdx.set(key, points.length); points.push([pos[3 * k], -pos[3 * k + 2], 0]); }
      return bIdx.get(key);
    };
    for (let p = 0; p < per.length; p++) {
      const [ia, ja] = per[p], [ib, jb] = per[(p + 1) % per.length];
      const Ta = ja * W1 + ia, Tb = jb * W1 + ib;
      faces.push([Ta, bottom(ia, ja), bottom(ib, jb), Tb]);
    }
    const c0 = points.length;
    points.push([X(cx), -Z(cy), 0]);
    for (let p = 0; p < per.length; p++) {
      const [ia, ja] = per[p], [ib, jb] = per[(p + 1) % per.length];
      faces.push([c0, bottom(ib, jb), bottom(ia, ja)]);
    }
    return J.primitives.polyhedron({ points, faces, orientation: 'outward' });
  }

  const api = {
    mesh, top, skirt, fmin, fmax, s, base, zScale, nx, ny,
    get geom() { if (!geomCache) geomCache = buildGeom(); return geomCache; },
    z: (x, y) => hOf(clampF(fn(x, y))),
    toWorld: (x, y, lift = 0) => new THREE.Vector3(X(x), hOf(clampF(fn(x, y))) + lift, Z(y)),
    toJ: (x, y, lift = 0) => [X(x), -Z(y), hOf(clampF(fn(x, y))) + lift],
    dispose() {
      mesh.traverse((m) => { if (m.isMesh) { m.geometry.dispose(); m.material.dispose(); } });
    },
  };
  return api;
};

/* ================================================================== figure */

/*
 K.figure(): a small faceless stick figure (~0.9 tall), Alan Becker spirit.
 pose(name, {at: [x,y,z] world, ms}) tweens every joint with anticipation + a little overshoot.
 place(pos, facing) puts its feet at pos (in its parent's space); facing = angle (rad, 0 = +z)
 or a point [x,y,z] to face.
*/
K.figure = function figure(o = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: o.color || C.ink, roughness: 0.55, metalness: 0.05 });
  const R = 0.016;
  const limb = (len, r = R) => {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 10), mat);
    m.position.y = -len / 2; m.castShadow = true; return m;
  };
  const ball = (r) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 12), mat); m.castShadow = true; return m; };
  const group = new THREE.Group();
  const body = new THREE.Group(); group.add(body);
  const hips = new THREE.Group(); hips.position.y = 0.44; body.add(hips);
  const spine = new THREE.Group(); hips.add(spine);
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.02, 0.28, 4, 10), mat);
  torso.position.y = 0.15; torso.castShadow = true; spine.add(torso);
  const neck = new THREE.Group(); neck.position.y = 0.315; spine.add(neck);
  const head = ball(0.074); head.position.y = 0.085; neck.add(head);
  const arm = (side) => {
    const sh = new THREE.Group(); sh.position.set(side * 0.014, 0.275, 0); spine.add(sh);
    sh.add(limb(0.16));
    const elb = new THREE.Group(); elb.position.y = -0.16; sh.add(elb);
    elb.add(limb(0.15));
    const hand = ball(0.021); hand.position.y = -0.155; elb.add(hand);
    return { sh, elb };
  };
  const leg = (side) => {
    const hp = new THREE.Group(); hp.position.set(side * 0.036, 0, 0); hips.add(hp);
    hp.add(limb(0.21));
    const kn = new THREE.Group(); kn.position.y = -0.21; hp.add(kn);
    kn.add(limb(0.21));
    const foot = new THREE.Mesh(new THREE.CapsuleGeometry(R * 1.1, 0.045, 3, 8), mat);
    foot.rotation.x = Math.PI / 2; foot.position.set(0, -0.214, 0.022); foot.castShadow = true; kn.add(foot);
    return { hp, kn };
  };
  const aL = arm(1), aR = arm(-1), lL = leg(1), lR = leg(-1);
  const J_ = { hips, spine, neck, shL: aL.sh, elL: aL.elb, shR: aR.sh, elR: aR.elb, hpL: lL.hp, knL: lL.kn, hpR: lR.hp, knR: lR.kn };
  const E = (x, y, z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z));
  const POSES = {
    stand: { shL: [0, 0, 0.13], elL: [-0.15, 0, 0], shR: [0, 0, -0.13], elR: [-0.15, 0, 0], hpL: [0, 0, 0.04], hpR: [0, 0, -0.04] },
    think: { shR: [-1.15, 0, 0.5], elR: [-2.2, 0, 0], shL: [-0.5, 0, -0.62], elL: [-1.45, 0, 0], neck: [0.16, -0.12, 0.2],
      spine: [0.05, 0, 0.03], hpL: [0, 0, 0.05], hpR: [0.06, 0, -0.03], knR: [0.14, 0, 0] },
    cheer: { shL: [0, 0, 2.6], elL: [-0.3, 0, 0], shR: [0, 0, -2.6], elR: [-0.3, 0, 0], neck: [-0.28, 0, 0], spine: [-0.1, 0, 0],
      hpL: [0, 0, 0.1], hpR: [0, 0, -0.1], lift: 0.035 },
    shrug: { shL: [-0.2, 0, 0.62], elL: [-1.5, 0, 0], shR: [-0.2, 0, -0.62], elR: [-1.5, 0, 0], neck: [0.06, 0, 0.3],
      hpL: [0, 0, 0.04], hpR: [0, 0, -0.04], shrug: 0.02 },
    lean: { hips: [0, 0, 0.09], spine: [0.04, 0, -0.16], shL: [0, 0, 0.7], elL: [-1.9, 0, 0], shR: [-0.15, 0, -0.18], elR: [-0.35, 0, 0],
      hpR: [0, 0, 0.2], knR: [0.18, 0, 0], hpL: [0, 0, 0.02], neck: [0.05, 0.35, 0.12] },
  };
  const cur = {};
  for (const k in J_) cur[k] = J_[k].quaternion;
  let tw = 0;
  function target(name, at) {
    const P = POSES[name] || (name === 'point' ? {} : POSES.stand);
    const T = {};
    for (const k in J_) T[k] = E(...(P[k] || [0, 0, 0]));
    let lift = P.lift || 0, shrug = P.shrug || 0;
    if (name === 'point' && at) {
      group.updateWorldMatrix(true, false);
      const loc = group.worldToLocal(v3(at));
      const side = loc.x >= 0 ? 1 : -1;
      const shPos = new THREE.Vector3(side * 0.014, 0.44 + 0.275, 0);
      const dir = loc.clone().sub(shPos).normalize();
      if (dir.y < -0.5) dir.y = -0.5;
      dir.normalize();
      T[side > 0 ? 'shL' : 'shR'] = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
      T[side > 0 ? 'elL' : 'elR'] = E(-0.08, 0, 0);
      T[side > 0 ? 'shR' : 'shL'] = E(0, 0, -side * 0.16);
      T[side > 0 ? 'elR' : 'elL'] = E(-0.25, 0, 0);
      const yaw = Math.max(-0.9, Math.min(0.9, Math.atan2(dir.x, dir.z)));
      T.neck = E(Math.max(-0.4, Math.min(0.4, -dir.y * 0.6)), yaw, 0);
      T.spine = E(0.04, yaw * 0.25, 0);
      T.hpL = E(0, 0, 0.05); T.hpR = E(0, 0, -0.05);
    }
    return { T, lift, shrug };
  }
  function pose(name, opt = {}) {
    const { T, lift, shrug } = target(name, opt.at);
    const from = {};
    for (const k in J_) from[k] = J_[k].quaternion.clone();
    const l0 = body.position.y, s0 = aL.sh.position.y - 0.275;
    const my = ++tw;
    const qa = new THREE.Quaternion();
    const ms = opt.ms ?? 330;
    const stepFn = (e) => {
      if (my !== tw) return;
      for (const k in J_) J_[k].quaternion.copy(qa.copy(from[k]).slerp(T[k], e));
      body.position.y = l0 + (lift - l0) * e;
      const sy = s0 + (shrug - s0) * e;
      aL.sh.position.y = aR.sh.position.y = 0.275 + sy;
    };
    if (!CUR || CUR.shot) { stepFn(1); if (CUR) CUR.invalidate(); return Promise.resolve(); }
    return CUR.tween(ms, stepFn, ease.antic);
  }
  function place(p, facing) {
    group.position.copy(v3(p));
    if (typeof facing === 'number') group.rotation.y = facing;
    else if (facing) {
      const f = v3(facing);
      group.rotation.y = Math.atan2(f.x - group.position.x, f.z - group.position.z);
    }
    if (CUR) CUR.invalidate();
  }
  pose('stand', { ms: 0 });
  return { group, pose, place };
};

/* =================================================================== run() */

export function run(spec) {
  const S = {
    spec, knobs: {}, state: {}, tier: TIER, beat: 0, shot: SHOT, changed: [],
  };
  CUR_S = S;
  S.tr = (t) => tr(t, S);
  if (SHOT) document.documentElement.classList.add('k-shot');
  document.documentElement.setAttribute('data-kind', spec.kind || 'weekly');

  /* visits */
  try {
    const seen = lsJSON('tara.objects.seen') || {};
    seen[spec.id] = Date.now();
    lsSet('tara.objects.seen', JSON.stringify(seen));
  } catch (e) { /* ignore */ }

  const app = el('div', 'k-app');
  document.body.appendChild(app);

  /* ---- top bar ---- */
  const bar = el('header', 'k-bar');
  const back = el('a', 'k-back');
  back.href = hubHref('#' + spec.id);
  back.innerHTML = '<span aria-hidden="true">◀</span> Model Room';
  const title = el('div', 'k-title');
  title.innerHTML = `<span class="k-num">${esc(spec.num || '')}</span><span class="k-dot" aria-hidden="true">·</span><span class="k-name">${esc(spec.title || '')}</span>`;
  title.title = spec.subtitle || '';
  bar.append(back, title, dimToggle('3d', { back2d: spec.back2d }));
  app.appendChild(bar);
  const hud = el('div', 'k-hud');
  app.appendChild(hud);

  const beats = spec.beats || [];
  const startBeat = Math.max(0, Math.min(beats.length - 1, (parseInt(Q.get('beat'), 10) || 1) - 1));
  const st = stage({ host: app, plinth: spec.plinth ?? {}, fov: spec.fov || 30, fit: spec.fit || 1,
    view: beats[startBeat] && beats[startBeat].cam });
  if (!st) { fallback(app, spec); return null; }

  Object.assign(S, {
    scene: st.scene, root: st.root, camera: st.camera, controls: st.controls, renderer: st.renderer,
    stage: st, invalidate: st.invalidate, fly: st.fly, tween: st.tween,
  });

  /* ---- label card ---- */
  const card = el('section', 'k-card');
  card.setAttribute('aria-label', 'Guide');
  card.innerHTML = `
    <div class="k-head">
      <span class="k-tag"></span>
      <span class="k-count" aria-live="polite"></span>
      <span class="k-dots" role="tablist" aria-label="Beats"></span>
      <span class="k-nav">
        <button type="button" class="k-prev" aria-label="Previous beat (left arrow)">◀</button>
        <button type="button" class="k-next" aria-label="Next beat (right arrow)">▶</button>
      </span>
      <span class="k-tier" role="group" aria-label="Explanation depth">
        <button type="button" data-t="1" title="1 · Plain">1</button><button type="button" data-t="2" title="2 · Generalist">2</button><button type="button" data-t="3" title="3 · Expert">3</button>
      </span>
    </div>
    <div class="k-cap" aria-live="polite"></div>
    <div class="k-foot">
      <button type="button" class="k-fb" data-sheet="knobs" aria-expanded="false"><span class="k-ic" aria-hidden="true">⚙</span>Knobs</button>
      <button type="button" class="k-fb" data-sheet="predict" aria-expanded="false"><span class="k-ic" aria-hidden="true">?</span>Predict</button>
      <button type="button" class="k-fb" data-sheet="more" aria-expanded="false"><span class="k-ic" aria-hidden="true">⋯</span>More</button>
    </div>`;
  app.appendChild(card);
  const $ = (sel, root = card) => root.querySelector(sel);
  const dots = $('.k-dots');
  beats.forEach((b, i) => {
    const d = el('button', 'k-d');
    d.type = 'button';
    d.setAttribute('role', 'tab');
    d.setAttribute('aria-label', `Beat ${i + 1} of ${beats.length}`);
    d.addEventListener('click', () => goBeat(i));
    dots.appendChild(d);
  });
  $('.k-prev').addEventListener('click', () => goBeat(S.beat - 1));
  $('.k-next').addEventListener('click', () => goBeat(S.beat + 1));
  card.querySelectorAll('.k-tier button').forEach((b) => b.addEventListener('click', () => setTier(Number(b.dataset.t))));
  if (!spec.predict || !spec.predict.length) $('[data-sheet="predict"]').disabled = true;
  if (!spec.knobs || !spec.knobs.length) $('[data-sheet="knobs"]').disabled = true;

  /* ---- sheets ---- */
  const sheets = {};
  function mkSheet(name, heading) {
    const sh = el('aside', `k-sheet k-sheet-${name}`);
    sh.setAttribute('aria-label', heading);
    sh.hidden = true;
    sh.innerHTML = `<div class="k-sh-head"><h2>${esc(heading)}</h2><button type="button" class="k-x" aria-label="Close">✕</button></div><div class="k-sh-body"></div>`;
    sh.querySelector('.k-x').addEventListener('click', () => openSheet(null));
    app.appendChild(sh);
    sheets[name] = sh;
    return sh.querySelector('.k-sh-body');
  }
  const knobBody = mkSheet('knobs', 'Knobs');
  const predBody = mkSheet('predict', 'Predict');
  const moreBody = mkSheet('more', 'More');
  const pMeta = el('span', 'k-sh-meta');
  const pAnother = el('button', 'k-btn k-another', 'Another');
  pAnother.type = 'button';
  pAnother.title = 'Another question';
  pAnother.addEventListener('click', () => openPredict());
  {
    const h = sheets.predict.querySelector('.k-sh-head'), x = h.querySelector('.k-x');
    h.insertBefore(pMeta, x); h.insertBefore(pAnother, x);
  }
  let openName = null;
  function openSheet(name, force = false) {
    if (!force && name && openName === name) name = null;     // footer buttons toggle
    openName = name;
    for (const k in sheets) sheets[k].hidden = k !== name;
    card.querySelectorAll('.k-fb').forEach((b) => b.setAttribute('aria-expanded', String(b.dataset.sheet === name)));
    app.dataset.sheet = name || '';
    relayout(true);
  }
  card.querySelectorAll('.k-fb').forEach((b) => b.addEventListener('click', () => {
    const n = b.dataset.sheet;
    if (n === 'predict' && openName !== 'predict') { openPredict(); return; }
    openSheet(n);
  }));

  /* ---- layout -> view insets (object centred in the free area) ---- */
  const isPhone = () => innerWidth < 760;
  function relayout(animate = true) {
    const H = innerHeight;
    const barR = bar.getBoundingClientRect();
    const hudH = hud.classList.contains('on') ? hud.getBoundingClientRect().height + 6 : 0;
    const cardR = card.getBoundingClientRect();
    const top = barR.bottom + hudH + 10;
    let bottom, left = 0, right = 0;
    const sh = openName ? sheets[openName] : null;
    const shR = sh ? sh.getBoundingClientRect() : null;
    if (isPhone()) {
      bottom = H - (shR ? Math.min(shR.top, cardR.top) : cardR.top) + 12;
    } else {
      bottom = 28;
      left = shR && openName !== 'knobs' ? shR.right + 12 : Math.round(cardR.right * 0.62);
      if (openName === 'knobs' && shR) right = innerWidth - shR.left + 12;
    }
    st.setViewInsets({ top, bottom, left, right }, { animate });
  }
  S._relayout = relayout;
  addEventListener('resize', () => relayout(false));
  new ResizeObserver(() => relayout(false)).observe(card);
  Object.values(sheets).forEach((s) => new ResizeObserver(() => { if (!s.hidden) relayout(false); }).observe(s));

  /* ---- knobs ---- */
  const defs = {};
  const knobUI = {};
  for (const k of spec.knobs || []) {
    defs[k.id] = k;
    if (k.type !== 'button') S.knobs[k.id] = k.value;
    const row = el('div', `k-knob k-knob-${k.type}${k.wide ? ' k-wide' : ''}`);
    const lab = el('label', 'k-kl');
    const idAttr = `k-${k.id}`;
    lab.htmlFor = idAttr;
    const paintLabel = () => { lab.textContent = tr(k.label, S); };
    paintLabel(); K.onTier(paintLabel);
    if (k.type === 'range') {
      const out = el('output', 'k-out');
      const inp = el('input');
      inp.type = 'range'; inp.id = idAttr;
      const toPos = (v) => (k.log ? 1000 * Math.log(v / k.min) / Math.log(k.max / k.min) : v);
      const fromPos = (p) => (k.log ? k.min * Math.pow(k.max / k.min, p / 1000) : p);
      if (k.log) { inp.min = 0; inp.max = 1000; inp.step = 1; } else { inp.min = k.min; inp.max = k.max; inp.step = k.step ?? 'any'; }
      const show = (v) => { out.textContent = k.fmt ? k.fmt(v) : K.fmt(v, 3); };
      knobUI[k.id] = (v) => { inp.value = String(toPos(v)); show(v); };
      inp.addEventListener('input', () => {
        let v = fromPos(Number(inp.value));
        if (k.log) v = Number(v.toPrecision(3));
        S.knobs[k.id] = v; show(v); callRebuild([k.id]);
      });
      const top = el('div', 'k-kt'); top.append(lab, out);
      row.append(top, inp);
    } else if (k.type === 'select') {
      const sel = el('select'); sel.id = idAttr;
      for (const [v, t] of k.options) { const op = el('option'); op.value = String(v); op.textContent = tr(t, S); sel.appendChild(op); }
      K.onTier(() => { [...sel.options].forEach((op, i) => { op.textContent = tr(k.options[i][1], S); }); });
      knobUI[k.id] = (v) => { sel.value = String(v); };
      sel.addEventListener('change', () => {
        const opt = k.options.find(([v]) => String(v) === sel.value);
        S.knobs[k.id] = opt ? opt[0] : sel.value; callRebuild([k.id]);
      });
      row.append(lab, sel);
    } else if (k.type === 'toggle') {
      const b = el('button', 'k-switch'); b.type = 'button'; b.id = idAttr; b.setAttribute('role', 'switch');
      b.innerHTML = '<i aria-hidden="true"></i>';
      knobUI[k.id] = (v) => { b.setAttribute('aria-checked', String(!!v)); };
      b.addEventListener('click', () => { S.knobs[k.id] = !S.knobs[k.id]; knobUI[k.id](S.knobs[k.id]); callRebuild([k.id]); });
      lab.htmlFor = '';
      lab.addEventListener('click', () => b.click());
      row.append(lab, b);
    } else if (k.type === 'button') {
      const b = el('button', 'k-btn'); b.type = 'button';
      const paint = () => { b.textContent = tr(k.label, S); };
      paint(); K.onTier(paint);
      b.addEventListener('click', () => { try { k.onClick && k.onClick(S); } catch (e) { console.error(e); } S.invalidate(); });
      row.append(b);
      lab.remove();
    }
    knobBody.appendChild(row);
    if (knobUI[k.id]) knobUI[k.id](k.value);
  }
  function callRebuild(changed) {
    S.changed = changed.slice();
    try { if (spec.rebuild) spec.rebuild(S, changed.length === 1 ? changed[0] : '*'); } catch (e) { console.error(e); }
    S.invalidate();
  }
  S.setKnob = (id, v, o = {}) => {
    if (!(id in defs)) return;
    S.knobs[id] = v;
    if (knobUI[id]) knobUI[id](v);
    if (!o.silent) callRebuild([id]);
  };
  S.setKnobs = (obj, o = {}) => {
    const ch = [];
    for (const [id, v] of Object.entries(obj)) {
      if (!(id in defs)) continue;
      S.knobs[id] = v; if (knobUI[id]) knobUI[id](v); ch.push(id);
    }
    if (ch.length && !o.silent) callRebuild(ch);
    return ch;
  };

  /* ---- More sheet ---- */
  {
    const wrap = el('div', 'k-more');
    if (spec.subtitle) wrap.appendChild(el('p', 'k-sub', md(spec.subtitle)));
    if (spec.where) {
      const w = el('div', 'k-where');
      w.innerHTML = '<h3>Where else this shows up</h3><p></p>';
      const p = w.querySelector('p');
      const paint = () => { p.innerHTML = md(tr(spec.where, S)); };
      paint(); K.onTier(paint);
      wrap.appendChild(w);
    }
    if (spec.solids) {
      const b = el('button', 'k-btn k-stl');
      b.type = 'button';
      b.innerHTML = '<span aria-hidden="true">⤓</span> Download STL (3D print)';
      b.addEventListener('click', () => {
        try {
          const g = spec.solids(S);
          if (!g || !g.length) { K.toast('Nothing printable here yet'); return; }
          const bytes = K.stl(g, `${spec.id}.stl`);
          K.toast(`Saved ${spec.id}.stl (${(bytes / 1e6).toFixed(1)} MB, 1 unit = 25 mm)`);
        } catch (e) { console.error(e); K.toast('STL export failed'); }
      });
      wrap.appendChild(b);
    }
    if (spec.remix) {
      const r = el('div', 'k-remix');
      r.innerHTML = '<h3>Remix prompt</h3><textarea readonly rows="5" aria-label="Remix prompt"></textarea><button type="button" class="k-btn k-copy">Copy</button>';
      r.querySelector('textarea').value = spec.remix;
      r.querySelector('.k-copy').addEventListener('click', async () => {
        const ta = r.querySelector('textarea');
        try { await navigator.clipboard.writeText(spec.remix); K.toast('Prompt copied'); } catch (e) {
          ta.select(); try { document.execCommand('copy'); K.toast('Prompt copied'); } catch (e2) { K.toast('Select the text and copy'); }
        }
      });
      wrap.appendChild(r);
    }
    if (spec.links && spec.links.length) {
      const l = el('div', 'k-links');
      l.innerHTML = '<h3>Go deeper</h3>';
      const ul = el('ul');
      for (const lk of spec.links) {
        const li = el('li'); const a = el('a'); a.href = lk.href; a.textContent = tr(lk.label, S); li.appendChild(a); ul.appendChild(li);
      }
      l.appendChild(ul);
      wrap.appendChild(l);
    }
    if (spec.credit) wrap.appendChild(el('p', 'k-credit', md(spec.credit)));
    moreBody.appendChild(wrap);
  }

  /* ---- Predict sheet ---- */
  const PKEY = 'tara.objects.predict';
  const seenQ = () => ((lsJSON(PKEY) || {})[spec.id] || []);
  function markSeen(i) {
    const all = lsJSON(PKEY) || {};
    const s = new Set(all[spec.id] || []); s.add(i);
    all[spec.id] = [...s].sort((a, b) => a - b);
    lsSet(PKEY, JSON.stringify(all));
  }
  let curQ = -1, picked = null, order = [], qRand = SHOT ? K.rng(7) : Math.random;
  function openPredict(i) {
    const qs = spec.predict || [];
    if (!qs.length) return;
    if (i == null) {
      const seen = seenQ();
      const all = qs.map((_, k) => k).filter((k) => k !== curQ);
      const unseen = all.filter((k) => !seen.includes(k));
      const pool = unseen.length ? unseen : all.length ? all : [0];
      i = pool[Math.floor(qRand() * pool.length)];
    }
    curQ = i; picked = null;
    const q = qs[i];
    const r = SHOT ? K.rng(101 + i * 17) : Math.random;
    order = q.options.map((_, k) => k);
    for (let k = order.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [order[k], order[j]] = [order[j], order[k]]; }
    paintPredict();
    openSheet('predict', true);
    predBody.scrollTop = 0;
  }
  function paintPredict() {
    const qs = spec.predict || [];
    const q = qs[curQ];
    if (!q) return;
    predBody.innerHTML = '';
    pMeta.textContent = `${curQ + 1} of ${qs.length} · a hunch, no scores`;
    pAnother.hidden = qs.length < 2;
    const qq = el('p', 'k-q', md(tr(q.q, S)));
    const ol = el('div', 'k-opts');
    order.forEach((k, pos) => {
      const b = el('button', 'k-opt');
      b.type = 'button';
      b.dataset.k = k;
      b.innerHTML = `<span class="k-ol">${'ABCD'[pos] || pos + 1}</span><span>${md(tr(q.options[k].t, S))}</span>`;
      if (picked != null) {
        if (q.options[k].ok) b.classList.add('ok');
        if (k === picked && !q.options[k].ok) b.classList.add('no');
        if (k !== picked && !q.options[k].ok) b.classList.add('dim');
        b.disabled = true;
      }
      b.addEventListener('click', () => choose(k));
      ol.appendChild(b);
    });
    predBody.append(qq, ol);
    const why = el('div', 'k-why');
    why.hidden = !(picked != null && predBody.dataset.why === '1');
    if (picked != null) {
      const ok = q.options[picked].ok;
      why.innerHTML = `<p class="k-verdict ${ok ? 'ok' : 'no'}">${ok ? 'Yes, that\'s it.' : 'Not quite. Watch the object.'}</p><p>${md(tr(q.why, S))}</p>`;
    }
    predBody.append(why);
  }
  function choose(k) {
    if (picked != null) return;
    picked = k;
    predBody.dataset.why = '0';
    markSeen(curQ);
    paintPredict();
    const q = spec.predict[curQ];
    const my = curQ;
    let p;
    try { p = q.show ? q.show(S) : null; } catch (e) { console.error(e); }
    Promise.race([Promise.resolve(p), wait(SHOT ? 0 : 2600)]).then(() => wait(SHOT ? 0 : 250)).then(() => {
      if (curQ !== my || picked == null) return;
      predBody.dataset.why = '1';
      const w = predBody.querySelector('.k-why');
      if (w) { w.hidden = false; w.classList.add('in'); }
      relayout(true);
    });
  }

  /* ---- beats + card painting ---- */
  function paintCard() {
    const B = beats[S.beat] || {};
    const tag = TAGS[B.tag] || 'core';
    const chip = $('.k-tag');
    chip.textContent = tag;
    chip.dataset.tag = tag;
    $('.k-count').textContent = `${S.beat + 1} / ${beats.length}`;
    [...dots.children].forEach((d, i) => { d.setAttribute('aria-selected', String(i === S.beat)); d.tabIndex = i === S.beat ? 0 : -1; });
    $('.k-prev').disabled = S.beat <= 0;
    $('.k-next').disabled = S.beat >= beats.length - 1;
    $('.k-cap').innerHTML = md(tr(B.cap, S));
    card.querySelectorAll('.k-tier button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.t) === S.tier)));
  }
  function goBeat(i, how = {}) {
    if (i < 0 || i >= beats.length) return;
    S.beat = i;
    const B = beats[i];
    if (how.initial) {
      // first load: ONE rebuild(S, '*') with S.first = true; S.changed = the ids the opening beat sets
      const ids = [];
      if (B.set) for (const [id, v] of Object.entries(B.set)) if (id in defs) { S.knobs[id] = v; if (knobUI[id]) knobUI[id](v); ids.push(id); }
      S.first = true; S.changed = ids;
      try { if (spec.rebuild) spec.rebuild(S, '*'); } catch (e) { console.error(e); }
      S.first = false;
    } else if (B.set) {
      const ch = [];
      for (const [id, v] of Object.entries(B.set)) if (id in defs) { S.knobs[id] = v; if (knobUI[id]) knobUI[id](v); ch.push(id); }
      if (ch.length) { S.changed = ch; try { spec.rebuild && spec.rebuild(S, '*'); } catch (e) { console.error(e); } }
    }
    try { if (B.enter) B.enter(S); } catch (e) { console.error(e); }
    if (B.cam) { st.setBaseView(B.cam); st.fly(B.cam, how.initial ? 0 : 950); }
    paintCard();
    S.invalidate();
  }
  function setTier(n) {
    if (n === S.tier) return;
    setTierGlobal(n);
  }
  K.onTier((n) => {
    S.tier = n;
    paintCard();
    if (curQ >= 0 && !sheets.predict.hidden) paintPredict();
    try { if (spec.onTier) spec.onTier(S, n); } catch (e) { console.error(e); }
    S.invalidate();
  });

  /* ---- keys ---- */
  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    const typing = t && t.closest && t.closest('input, textarea, select');
    if (e.key === 'Escape') { if (openName) { openSheet(null); e.preventDefault(); } return; }
    if (typing) return;
    if (e.key === 'ArrowRight') { goBeat(S.beat + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { goBeat(S.beat - 1); e.preventDefault(); }
    else if (e.key === '1' || e.key === '2' || e.key === '3') setTier(Number(e.key));
  });

  /* ---- go ---- */
  try { if (spec.setup) spec.setup(S); } catch (e) { console.error(e); }
  if (spec.frame) st.onFrame((t, dt) => spec.frame(S, t, dt));
  st.onDoubleTap(() => st.resetView());
  paintCard();
  relayout(false);
  goBeat(startBeat, { initial: true });

  const hooks = {
    ready: false, S,
    beat: (i) => goBeat(i),
    knob: (id, v) => S.setKnob(id, v),
    predict: (i) => openPredict(i),
    pick: (j) => { const k = order[j]; if (k != null) choose(k); },
    sheet: (name) => (name === 'predict' ? openPredict() : openSheet(name || null, true)),
    tier: (n) => setTier(n),
    stats: () => st.stats(),
    beats: beats.length,
  };
  window.__obj = hooks;
  const fontsReady = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  fontsReady.then(() => { relayout(false); return st.whenRendered(); }).then(() => { hooks.ready = true; });
  return S;
}

/* ---- no-WebGL fallback: a friendly card that still teaches ---- */
function fallback(app, spec) {
  const film = spec.film || ((spec.links || []).find((l) => /intuition\/films\//.test(l.href)) || {}).href;
  const f = el('div', 'k-fallback');
  f.innerHTML = `
    <h1>${esc(spec.num || '')} · ${esc(spec.title || '')}</h1>
    <p class="k-sub">${md(spec.subtitle || '')}</p>
    <p>This one is a 3D object you turn in your hands, and this browser has 3D graphics (WebGL) switched off, so it can't be drawn here.</p>
    <p>Everything it teaches is also in these:</p>
    <p class="k-fl"><a class="k-btn" href="${esc(appHref(spec.back2d || ''))}">Week pack (2D)</a>
    ${film ? `<a class="k-btn" href="${esc(/^\.\.|^http/.test(film) ? film : appHref('') .replace(/index\.html$/, '') + 'intuition/films/' + film + '.html')}">Watch the film</a>` : ''}</p>
    <p class="k-credit">Tip: WebGL is usually back after enabling hardware acceleration or updating the browser.</p>`;
  app.appendChild(f);
  window.__obj = { ready: true, fallback: true };
}
