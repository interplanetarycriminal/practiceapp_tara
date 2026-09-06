#!/usr/bin/env node
'use strict';
/* site/build-site.js — split /mnt/project-files/app into a deployable static site.
 *
 * The single-file build (app/build.js) inlines all 76 payloads as base64 in one
 * HTML document. This build emits the same payloads as individual gzip files
 * under assets/ and rewrites exactly one thing in the shell: APP.payload, which
 * now fetches assets/<name>.<hash>.gz and runs the *same*
 * DecompressionStream('gzip') decode path. Nothing else about the app changes —
 * same routes, same srcdoc frames with no sandbox attribute, same APP global,
 * same localStorage keys, same tier/scroll-anchor code.
 *
 * Node >= 18, no dependencies, no network. Deterministic: same inputs -> same
 * bytes (payload.encode is gzip -9, and the content hashes come from those bytes).
 *
 *   node site/build-site.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SITE = __dirname;
const APP = path.resolve(SITE, '..', 'app');
const R = path.resolve(APP, '..');                      // /mnt/project-files

const payload = require(path.join(APP, 'lib', 'payload.js'));
const publishlog = require(path.join(APP, 'lib', 'publishlog.js'));
const icons = require(path.join(SITE, 'tools', 'icons.js'));

const warnings = [];
const warn = (m) => warnings.push(m);

/* ------------------------------------------------------------------ ctx -- */
/* Identical to app/build.js so the collectors behave the same. */

const log = publishlog.load(R);
const ctx = {
  R,
  read(rel) { return fs.readFileSync(path.resolve(R, rel)); },
  readText(rel) { return fs.readFileSync(path.resolve(R, rel), 'utf8'); },
  exists(rel) { return fs.existsSync(path.resolve(R, rel)); },
  publishUrl(slug) { return log.urlFor(slug); },
  slugForUrl(u) { return log.slugFor(u); },
  warn
};

function appText(rel) {
  const p = path.join(APP, rel);
  if (!fs.existsSync(p)) { console.error('FATAL: missing ' + rel); process.exit(1); }
  return fs.readFileSync(p, 'utf8');
}
function optionalAppText(rel) {
  const p = path.join(APP, rel);
  if (!fs.existsSync(p)) { warn('missing ' + rel + ' — building without it'); return null; }
  return fs.readFileSync(p, 'utf8');
}

/* ---------------------------------------------------------- 1. collect -- */

const COLLECTORS = ['payloads/core.js', 'payloads/frames.js', 'payloads/data.js'];
let entries = [];
for (const rel of COLLECTORS) {
  const p = path.join(APP, rel);
  if (!fs.existsSync(p)) { warn('missing collector ' + rel); continue; }
  const mod = require(p);
  if (typeof mod !== 'function') { warn(rel + ' does not export collect(ctx)'); continue; }
  entries = entries.concat(mod(ctx));
}

const prepared = payload.prepare(entries, warn);   // gzip -9 + base64, same as the monolith

/* --------------------------------------------------- 2. payloads -> files -- */

const OUT_ASSETS = path.join(SITE, 'assets');
rmrf(OUT_ASSETS); fs.mkdirSync(OUT_ASSETS, { recursive: true });

function safeName(key) {
  return key.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}
function sha(buf, n) { return crypto.createHash('sha256').update(buf).digest('hex').slice(0, n); }

const seenFile = new Set();
const manifest = [];
let assetBytes = 0;

for (const p of prepared) {
  /* Buffer.from(b64,'base64') is exactly what app/build.js embeds, so a payload
     file here is byte-identical to `gzip -9 -c SOURCE`. */
  const gz = Buffer.from(p.b64, 'base64');
  const file = 'assets/' + safeName(p.key) + '.' + sha(gz, 10) + '.gz';
  if (seenFile.has(file)) { console.error('FATAL: asset filename collision: ' + file); process.exit(1); }
  seenFile.add(file);
  fs.writeFileSync(path.join(SITE, file), gz);
  assetBytes += gz.length;
  manifest.push({ key: p.key, section: p.section, kind: p.kind, raw: p.raw, enc: p.enc, gz: gz.length, file });
}

/* ------------------------------------------------------------- 3. CSS -- */

const CSS_ORDER = [
  ['src/shell/shell.css', true],
  ['sections/frames.css', false],
  ['sections/cases.css', false],
  ['sections/drill.css', false]
];
const cssParts = [];
for (const [rel, required] of CSS_ORDER) {
  const t = required ? appText(rel) : optionalAppText(rel);
  if (t != null) cssParts.push('/* ===== ' + rel + ' ===== */\n' + t);
}
const css = cssParts.join('\n\n');

/* -------------------------------------------------------------- 4. JS -- */

const JS_ORDER = [
  ['src/shell/shell.js', true],
  ['src/shell/today.js', true],
  ['src/shell/search.js', true],
  ['src/shell/review.js', true],
  ['sections/packs.js', false],
  ['sections/demos.js', false],
  ['sections/plan.js', false],
  ['sections/sprint.js', false],
  ['sections/manual.js', false],
  ['sections/map.js', false],
  ['sections/cases.js', false],
  ['sections/drill.js', false]
];

/* --- the one behavioural patch: payloads come over HTTP, not out of the DOM.
   Everything else in shell.js — tier, the scroll anchor, the router, frames —
   is copied through untouched. Anchored on exact source text so a change to
   shell.js fails this build loudly instead of silently shipping the old path. */

const PATCH_FROM = 'var _cache = new Map();';
const PATCH_TO = "APP.hasPayload = function (key) { return !!document.getElementById('P:' + key); };";

const NET_PAYLOAD = `var _cache = new Map();
var _inflight = new Map();
var _index = null;

/* window.__MANIFEST carries {key, section, kind, raw, enc, gz, file} for every
   payload; \`file\` is a content-hashed, immutable path relative to the document. */
function payloadIndex() {
  if (_index) return _index;
  _index = Object.create(null);
  var m = window.__MANIFEST || [];
  for (var i = 0; i < m.length; i++) _index[m[i].key] = m[i];
  return _index;
}

/* Relative to document.baseURI, never root-absolute: the site is served from a
   subpath on GitHub Pages (https://<owner>.github.io/<repo>/). */
function assetURL(file) {
  try { return new URL(file, document.baseURI).href; } catch (e) { return file; }
}

async function fetchPayload(key) {
  var bytes = null;
  var el = document.getElementById('P:' + key);
  if (el) {
    /* still supported, so a single-file build of the same sources works here */
    var bin = atob(el.textContent.trim());
    bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    var rec = payloadIndex()[key];
    if (!rec || !rec.file) throw new Error('no payload: ' + key);
    var res = await fetch(assetURL(rec.file), { credentials: 'same-origin' });
    if (!res.ok) throw new Error('payload ' + key + ': HTTP ' + res.status);
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  /* Same decode as the single-file build. A plain static host serves .gz with
     no Content-Encoding, so the gzip container arrives intact; a host that DOES
     set Content-Encoding: gzip has already inflated it, and the magic number
     says so. */
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  }
  return new TextDecoder('utf-8').decode(bytes);
}

APP.payload = function (key) {
  if (_cache.has(key)) return Promise.resolve(_cache.get(key));
  var p = _inflight.get(key);
  if (p) return p;
  p = fetchPayload(key).then(function (text) {
    _cache.set(key, text); _inflight.delete(key); return text;
  }, function (e) { _inflight.delete(key); throw e; });
  _inflight.set(key, p);
  return p;
};
APP.payloadJSON = async function (key) { return JSON.parse(await APP.payload(key)); };
APP.hasPayload = function (key) { return !!(payloadIndex()[key] || document.getElementById('P:' + key)); };`;

function patchShell(src) {
  const a = src.indexOf(PATCH_FROM);
  const b = src.indexOf(PATCH_TO);
  if (a === -1 || b === -1 || b < a) {
    console.error('FATAL: shell.js payload block not found — app/src/shell/shell.js changed shape.');
    console.error('       Update PATCH_FROM/PATCH_TO in build-site.js and re-check APP.payload.');
    process.exit(1);
  }
  return src.slice(0, a) + NET_PAYLOAD + src.slice(b + PATCH_TO.length);
}

const jsParts = [];
const jsFiles = [];
for (const [rel, required] of JS_ORDER) {
  let t = required ? appText(rel) : optionalAppText(rel);
  if (t == null) continue;
  if (rel === 'src/shell/shell.js') t = patchShell(t);
  jsFiles.push({ rel, bytes: Buffer.byteLength(t, 'utf8') });
  jsParts.push('/* ===== ' + rel + ' ===== */\n;(function(){\n' + t + '\n})();');
}
const js = jsParts.join('\n\n') + '\n';

/* ------------------------------------------------------- 5. shell files -- */

const cssHash = sha(Buffer.from(css, 'utf8'), 10);
const jsHash = sha(Buffer.from(js, 'utf8'), 10);
const cssFile = 'css/shell.' + cssHash + '.css';
const jsFile = 'js/app.' + jsHash + '.js';

rmrf(path.join(SITE, 'css')); rmrf(path.join(SITE, 'js'));
fs.mkdirSync(path.join(SITE, 'css'), { recursive: true });
fs.mkdirSync(path.join(SITE, 'js'), { recursive: true });
fs.writeFileSync(path.join(SITE, cssFile), css, 'utf8');
fs.writeFileSync(path.join(SITE, jsFile), js, 'utf8');

/* ---------------------------------------------------------- 6. tokens -- */
/* theme/background colours are read out of the app's own :root, not retyped. */

function token(name, fallback) {
  const m = new RegExp('--' + name + '\\s*:\\s*([^;]+);').exec(css);
  return m ? m[1].trim() : fallback;
}
const T = {
  accent: token('accent', '#1f3fb8'),
  paper: token('paper', '#fbfaf7'),
  surface: token('surface', '#ffffff'),
  ink: token('ink', '#16181d'),
  rule: token('rule', '#dcd8cf')
};

/* ----------------------------------------------------------- 7. icons -- */

const OUT_ICONS = path.join(SITE, 'icons');
rmrf(OUT_ICONS); fs.mkdirSync(OUT_ICONS, { recursive: true });
const iconFiles = [
  ['icons/icon-192.png', icons.mark(192, 'any', T.accent, T.paper)],
  ['icons/icon-512.png', icons.mark(512, 'any', T.accent, T.paper)],
  ['icons/icon-maskable-192.png', icons.mark(192, 'maskable', T.accent, T.paper)],
  ['icons/icon-maskable-512.png', icons.mark(512, 'maskable', T.accent, T.paper)],
  ['icons/icon.svg', Buffer.from(icons.svg(T.accent, T.paper), 'utf8')]
];
for (const [rel, buf] of iconFiles) fs.writeFileSync(path.join(SITE, rel), buf);

/* -------------------------------------------------------- 8. manifest -- */

const webmanifest = {
  name: 'TARA',
  short_name: 'TARA',
  id: './',
  start_url: './#today',
  scope: './',
  display: 'standalone',
  orientation: 'any',
  theme_color: T.accent,
  background_color: T.paper,
  description: 'The whole TARA learning system: the 14-Saturday plan, 13 study packs, ' +
    '13 interactive demos, the 215-node concept map, 104 case studies, a drill room ' +
    'over 1,183 questions, the 7-day crash sprint and the manual.',
  categories: ['education'],
  lang: 'en',
  dir: 'ltr',
  icons: [
    { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: 'icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }
  ]
};
fs.writeFileSync(path.join(SITE, 'manifest.json'), JSON.stringify(webmanifest, null, 2) + '\n', 'utf8');

/* ------------------------------------------------------------ 9. HTML -- */

const tpl = appText('src/shell/index.tpl.html');
const titleM = /<title>([\s\S]*?)<\/title>/.exec(tpl);
const title = titleM ? titleM[1] : 'TARA';

let body = tpl
  .replace(/<title>[\s\S]*?<\/title>\s*/, '')
  .replace(/<style><!--@CSS--><\/style>\s*/, '')
  .replace('<!--@PAYLOADS-->\n', '')
  .replace('<!--@PAYLOADS-->', '')
  .replace('<script><!--@JS--></script>', '<script src="' + jsFile + '"></script>');

/* the payload manifest is small (~8 KB) and every route needs it, so it is
   inlined rather than fetched — one less round trip before the first paint. */
const manifestTag = '<script>window.__MANIFEST=' + JSON.stringify(manifest) + ';</' + 'script>';
if (body.indexOf('<!--@MANIFEST-->') === -1) { console.error('FATAL: no <!--@MANIFEST--> marker'); process.exit(1); }
body = body.replace('<!--@MANIFEST-->', () => manifestTag);

/* The artifact runtime wrapped the shell in a <head> carrying exactly this
   reset. Reproducing it keeps rendering identical outside the artifact. */
const RESET = 'html{color-scheme:light dark}body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,' +
  '-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:#faf9f7}' +
  'img{max-width:100%}[hidden]{display:none!important}';

const SW_REG = [
  '<script>',
  '/* Registered only on https or localhost. Never from file:// or an artifact frame. */',
  '(function(){',
  '  if (!("serviceWorker" in navigator)) return;',
  '  var h = location.hostname;',
  '  var ok = location.protocol === "https:" || h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";',
  '  if (!ok) return;',
  '  window.addEventListener("load", function () {',
  '    navigator.serviceWorker.register("sw.js").catch(function (e) { console.warn("sw registration failed", e); });',
  '  });',
  '})();',
  '</' + 'script>'
].join('\n');

const html = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
  '<title>' + title + '</title>',
  '<meta name="description" content="' + webmanifest.description.replace(/"/g, '&quot;') + '">',
  '<meta name="theme-color" content="' + T.accent + '">',
  '<link rel="manifest" href="manifest.json">',
  '<link rel="icon" href="icons/icon.svg" type="image/svg+xml">',
  '<link rel="icon" href="icons/icon-192.png" sizes="192x192" type="image/png">',
  '<link rel="apple-touch-icon" href="icons/icon-192.png">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-title" content="TARA">',
  '<style>' + RESET + '</style>',
  '<link rel="stylesheet" href="' + cssFile + '">',
  '</head>',
  '<body>',
  body.trim(),
  SW_REG,
  '</body>',
  '</html>',
  ''
].join('\n');

fs.writeFileSync(path.join(SITE, 'index.html'), html, 'utf8');
fs.writeFileSync(path.join(SITE, '.nojekyll'), '', 'utf8');

/* ------------------------------------------------------------- 10. sw -- */

const SHELL_FILES = ['./', 'index.html', 'manifest.json', cssFile, jsFile]
  .concat(iconFiles.map(([rel]) => rel));

/* One version string over every shell byte — HTML, CSS, JS, the file list and
   the icons as the encoder produced them: change any of them and the old caches
   are dropped on the next activate. (The icons are hashed from the in-memory
   buffers rather than from disk so the version stays deterministic even where
   the filesystem rewrites image files, e.g. to attach provenance metadata.) */
const version = sha(Buffer.concat([
  Buffer.from(html + css + js + JSON.stringify(SHELL_FILES), 'utf8'),
  ...iconFiles.map(([, buf]) => buf)
]), 12);
const swSrc = fs.readFileSync(path.join(SITE, 'tools', 'sw.tpl.js'), 'utf8')
  .replace('__CACHE_VERSION__', version)
  .replace('__SHELL_FILES__', JSON.stringify(SHELL_FILES, null, 2));
fs.writeFileSync(path.join(SITE, 'sw.js'), swSrc, 'utf8');

/* ----------------------------------------------------------- 11. report -- */

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }
function kb(n) { return (n / 1024).toFixed(1).padStart(9) + ' KB'; }
function pad(s, n) { return String(s).padEnd(n); }

const shellSize = Buffer.byteLength(html, 'utf8') + Buffer.byteLength(css, 'utf8') + Buffer.byteLength(js, 'utf8');

const bySection = new Map();
for (const m of manifest) {
  const s = bySection.get(m.section) || { section: m.section, n: 0, raw: 0, gz: 0 };
  s.n++; s.raw += m.raw; s.gz += m.gz;
  bySection.set(m.section, s);
}

console.log('');
console.log('TARA static site build — ' + new Date().toISOString());
console.log('');
console.log(pad('section', 12) + pad('files', 7) + pad('raw', 14) + pad('gz on disk', 14));
console.log('-'.repeat(47));
let totRaw = 0, totGz = 0, totN = 0;
for (const s of [...bySection.values()].sort((a, b) => b.gz - a.gz)) {
  console.log(pad(s.section, 12) + pad(s.n, 7) + kb(s.raw) + '    ' + kb(s.gz));
  totRaw += s.raw; totGz += s.gz; totN += s.n;
}
console.log('-'.repeat(47));
console.log(pad('TOTAL', 12) + pad(totN, 7) + kb(totRaw) + '    ' + kb(totGz));
console.log('');
console.log('index.html      ' + kb(Buffer.byteLength(html, 'utf8')));
console.log(pad(cssFile, 16) + kb(Buffer.byteLength(css, 'utf8')));
console.log(pad(jsFile, 16) + kb(Buffer.byteLength(js, 'utf8')) + '   (' + jsFiles.length + ' files)');
console.log('SHELL TOTAL     ' + kb(shellSize) + '  uncompressed');
console.log('assets/         ' + kb(assetBytes) + '  in ' + manifest.length + ' files');
console.log('cache version   ' + version);
console.log('');

if (warnings.length) {
  console.log('warnings (' + warnings.length + '):');
  for (const w of warnings) console.log('  ! ' + w);
  console.log('');
}
if (manifest.length !== 76) warn('expected 76 payloads, got ' + manifest.length);
process.exit(0);
