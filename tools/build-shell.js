#!/usr/bin/env node
'use strict';
/* tools/build-shell.js — builds TARA V2's shell beside V1.
 *
 *   node tools/build-shell.js                 -> next.html (the preview)
 *   node tools/build-shell.js --out index.html -> index.html (only at the switch;
 *                                                 V1 must already be classic.html)
 *   --skip-broken   leave out (with a warning) a JS module that does not parse,
 *                   instead of failing. For use while other builders are mid-edit.
 *   node tools/build-shell.js --check          writes nothing; exit 1 when the built
 *                   V2 is out of step with V1's document (run it after build-site.js,
 *                   before a deploy): <out>'s payload manifest differs from V1's, or
 *                   sw.js does not precache <out>, or its payload list is stale.
 *
 * Emits (see src/V2-CONTRACT.md, "Build"):
 *   <out>                      the V2 document
 *   shell/app.<hash>.css       brand + V1 shell/section css + src/v2/*.css
 *   shell/app.<hash>.js        V1 shell/section modules + src/v2/*.js, one IIFE each
 *   shell/paths.<hash>.json    copy of data/paths.json, when it exists
 *   shell/manifest.<hash>.json the preview's web app manifest (next.html only)
 *   shell/fonts/*, shell/img/* copies of src/brand/fonts/ and src/brand/img/
 *   sw.js                      from tools/sw.tpl.js; precaches V1 and V2, and
 *                              carries the payload list its activate trims to
 *
 * window.__MANIFEST (the 76 payloads) is read out of V1's document: index.html,
 * or classic.html once V1 has moved there. The payload files themselves are
 * V1's assets/*.gz, shared, never rewritten.
 *
 * Node >= 18, no dependencies, no network. Deterministic: same inputs -> same
 * bytes (no timestamps in any output; file lists are sorted). Fails loudly: a
 * missing required input, an unparsable JS module or paths.json, a payload file
 * that is not on disk, a template marker that is gone -> exit 1 with a reason.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

function die(msg) {
  console.error('\nbuild-shell: FATAL: ' + msg + '\n');
  process.exit(1);
}
const warnings = [];
function warn(m) { warnings.push(m); }

function argVal(name, dflt) {
  const i = args.indexOf(name);
  if (i === -1) return dflt;
  const v = args[i + 1];
  if (!v || v.indexOf('--') === 0) die(name + ' needs a value');
  return v;
}
const KNOWN = new Set(['--out', '--skip-broken', '--quiet', '--check']);
for (let i = 0; i < args.length; i++) {
  if (args[i].indexOf('--') === 0 && !KNOWN.has(args[i])) die('unknown option ' + args[i]);
  if (args[i] === '--out') i++;
}
const OUT = argVal('--out', 'next.html');
const SKIP_BROKEN = args.indexOf('--skip-broken') >= 0;
const QUIET = args.indexOf('--quiet') >= 0;
const CHECK = args.indexOf('--check') >= 0;
if (!/^[A-Za-z0-9._-]+\.html$/.test(OUT)) die('--out must be a plain file name ending in .html, got ' + OUT);

const AT_SWITCH = OUT === 'index.html';
/* V1's document: where the payload manifest and V1's own css/js names live. */
const V1_DOC = AT_SWITCH ? 'classic.html' : 'index.html';

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const abs = (r) => path.join(ROOT, r);
const exists = (r) => fs.existsSync(abs(r));
const readText = (r) => fs.readFileSync(abs(r), 'utf8');
const sha = (buf, n) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, n || 10);
function rmrf(r) { fs.rmSync(abs(r), { recursive: true, force: true }); }
function writeOut(r, data) {
  fs.mkdirSync(path.dirname(abs(r)), { recursive: true });
  fs.writeFileSync(abs(r), data);
}
function listDir(r, test) {
  if (!exists(r)) return [];
  return fs.readdirSync(abs(r), { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith('.') && (!test || test(d.name)))
    .map((d) => d.name)
    .sort();
}

/* ------------------------------------------------------- 1. V1's document -- */

if (!exists(V1_DOC)) {
  die(AT_SWITCH
    ? 'building --out index.html needs V1 at classic.html (move it there first)'
    : 'V1\'s index.html is missing');
}
const v1html = readText(V1_DOC);
const mm = /<script>window\.__MANIFEST=(\[[\s\S]*?\]);<\/script>/.exec(v1html);
if (!mm) die(V1_DOC + ' carries no window.__MANIFEST');
let MANIFEST;
try { MANIFEST = JSON.parse(mm[1]); } catch (e) { die('window.__MANIFEST in ' + V1_DOC + ' is not JSON: ' + e.message); }
if (!Array.isArray(MANIFEST) || !MANIFEST.length) die('window.__MANIFEST in ' + V1_DOC + ' is empty');
for (const m of MANIFEST) {
  if (!m || !m.key || !m.file) die('a __MANIFEST entry has no key/file: ' + JSON.stringify(m));
  if (!exists(m.file)) die('payload ' + m.key + ' points at ' + m.file + ', which is not on disk');
}
if (MANIFEST.length !== 76) warn('expected 76 payloads in ' + V1_DOC + ', found ' + MANIFEST.length);

/* V1's own hashed css/js, for the worker's precache list (V1 keeps working offline). */
const v1Css = [...v1html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((x) => x[1]);
const v1Js = [...v1html.matchAll(/<script src="([^"]+)"/g)].map((x) => x[1])
  .filter((s) => /^js\//.test(s));
for (const f of v1Css.concat(v1Js)) if (!exists(f)) die(V1_DOC + ' names ' + f + ', which is not on disk');

/* The payload files the documents name: the worker keeps these in tara-assets and
   trims the rest on activate. */
const ASSET_LIST = [...new Set(MANIFEST.map((m) => m.file))].sort();

/* ----------------------------------------------------------- --check ---- */
/* V1's build-site.js rewrites index.html (payloads get new content-hashed names)
   and sw.js (V1's files only). Unless this build runs after it, the built V2 names
   payload files that are gone and the worker does not precache it. --check
   compares what is on disk and writes nothing. */

/* The JSON array or object that starts at text[start], as a string. */
function jsonAt(text, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { if (--depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}
/* The array right after `marker` in `text`: the array, null when something else
   follows (a template marker left as null), undefined when unreadable or absent. */
function arrayAfter(text, marker) {
  const i = text.indexOf(marker);
  if (i < 0) return undefined;
  let j = i + marker.length;
  while (j < text.length && /\s/.test(text[j])) j++;
  if (text[j] !== '[') return null;
  const s = jsonAt(text, j);
  try { return s ? JSON.parse(s) : undefined; } catch (e) { return undefined; }
}

if (CHECK) {
  const problems = [];
  if (!exists(OUT)) problems.push(OUT + ' does not exist');
  else {
    const doc = readText(OUT);
    const m2 = arrayAfter(doc, 'window.__MANIFEST=');
    if (!Array.isArray(m2)) problems.push(OUT + ' carries no readable window.__MANIFEST');
    else if (JSON.stringify(m2) !== JSON.stringify(MANIFEST)) {
      const a = new Map(MANIFEST.map((x) => [x.key, x.file])), b = new Map(m2.map((x) => x && [x.key, x.file]).filter(Boolean));
      const diff = [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));
      problems.push(OUT + '\'s payload manifest differs from ' + V1_DOC + '\'s' + (diff.length
        ? ': ' + diff.length + ' payload' + (diff.length === 1 ? '' : 's') + ' (' + diff.slice(0, 4).join(', ') + (diff.length > 4 ? ', ...' : '') + ')'
        : ' (same files, other fields)'));
    }
    for (const f of new Set([...doc.matchAll(/"(shell\/[^"\s]+)"/g)].map((x) => x[1]))) {
      if (!exists(f)) problems.push(OUT + ' names ' + f + ', which is not on disk');
    }
  }
  if (!exists('sw.js')) problems.push('sw.js does not exist');
  else {
    const sw = readText('sw.js');
    const files = arrayAfter(sw, 'const SHELL_FILES =');
    if (!Array.isArray(files)) problems.push('sw.js has no readable SHELL_FILES list');
    else {
      if (files.indexOf(OUT) < 0) problems.push('sw.js does not precache ' + OUT + ' (V1\'s build-site.js wrote it last)');
      for (const f of files) if (f !== './' && !exists(f)) problems.push('sw.js precaches ' + f + ', which is not on disk');
    }
    const assets = arrayAfter(sw, 'const ASSET_FILES =');
    if (assets === null) problems.push('sw.js carries no payload list (V1\'s build-site.js wrote it last)');
    else if (!Array.isArray(assets)) problems.push('sw.js has no readable ASSET_FILES list');
    else if (JSON.stringify(assets) !== JSON.stringify(ASSET_LIST)) problems.push('sw.js\'s payload list does not match ' + V1_DOC + '\'s manifest');
  }
  if (problems.length) {
    console.error('\nbuild-shell --check: FAILED');
    for (const p of problems) console.error('  - ' + p);
    console.error('\nTo fix: node tools/build-shell.js' + (AT_SWITCH ? ' --out index.html' : '') +
      '\n(after V1\'s build-site.js, every time), then check again and deploy what it wrote.\n');
    process.exit(1);
  }
  if (!QUIET) console.log('build-shell --check: ok. ' + OUT + ' and sw.js are in step with ' + V1_DOC + ' (' + MANIFEST.length + ' payloads).');
  process.exit(0);
}

/* ------------------------------------------------------------- 2. CSS ---- */

const V2_ORDER = ['chrome', 'viewer', 'session', 'today', 'weeks', 'recall', 'practice', 'library', 'lab'];

/* src/v2/*.<ext> in the contract's order, then the rest alphabetically.
   Files starting with "_" or "." and *.test.js are not bundled. */
function v2Files(ext) {
  const all = listDir('src/v2', (n) => n.endsWith('.' + ext) && !n.startsWith('_') && !/\.test\.js$/.test(n));
  const named = V2_ORDER.map((b) => b + '.' + ext).filter((n) => all.indexOf(n) >= 0);
  const rest = all.filter((n) => named.indexOf(n) < 0);
  return named.concat(rest).map((n) => 'src/v2/' + n);
}

const CSS_FILES = [
  'src/brand/fonts.css', 'src/brand/tokens.css', 'src/brand/components.css',
  'src/shell/shell.css', 'src/sections/frames.css', 'src/sections/cases.css', 'src/sections/drill.css'
].concat(v2Files('css'));

const BRAND_FONTS = 'src/brand/fonts/';
const BRAND_IMG = 'src/brand/img/';

/* Every relative url() is resolved against its own source file, then re-pointed
   from shell/app.<hash>.css: brand fonts -> fonts/<f>, brand images -> img/<f>,
   anything else in the repo -> ../<path>. data:, http(s): and #ids are left alone. */
function rewriteUrls(css, fromRel) {
  const dir = path.posix.dirname(fromRel);
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, q, u) => {
    const url = u.trim();
    if (/^(data:|https?:|\/\/|#|about:|blob:)/i.test(url)) return whole;
    if (url.charAt(0) === '/') die(fromRel + ' uses a root-absolute url(' + url + '); every URL must be relative');
    const m = /^([^?#]*)(.*)$/.exec(url);
    const target = path.posix.normalize(path.posix.join(dir, m[1]));
    if (target.indexOf('..') === 0) die(fromRel + ': url(' + url + ') points outside the repo');
    let out;
    if (target.indexOf(BRAND_FONTS) === 0) out = 'fonts/' + target.slice(BRAND_FONTS.length);
    else if (target.indexOf(BRAND_IMG) === 0) out = 'img/' + target.slice(BRAND_IMG.length);
    else out = '../' + target;
    if (!exists(target)) warn(fromRel + ': url(' + url + ') -> ' + target + ' is not on disk');
    return 'url("' + out + m[2] + '")';
  });
}

const cssParts = [];
const cssUsed = [];
for (const f of CSS_FILES) {
  if (!exists(f)) { warn('css: ' + f + ' is missing — skipped'); continue; }
  const t = rewriteUrls(readText(f), f);
  cssParts.push('/* ===== ' + f + ' ===== */\n' + t.replace(/\s+$/, '') + '\n');
  cssUsed.push(f);
}
if (!cssUsed.length) die('no CSS at all');
const CSS = cssParts.join('\n');

/* -------------------------------------------------------------- 3. JS ---- */

const JS_FILES = [
  ['src/shell/shell.js', true],
  ['src/shell/search.js', true],
  ['src/shell/review.js', true],
  ['src/sections/packs.js'], ['src/sections/demos.js'], ['src/sections/plan.js'],
  ['src/sections/sprint.js'], ['src/sections/manual.js'], ['src/sections/map.js'],
  ['src/sections/cases.js'], ['src/sections/drill.js']
].concat(v2Files('js').map((f) => [f]));

const jsParts = [];
const jsUsed = [];
for (const [f, required] of JS_FILES) {
  if (!exists(f)) {
    if (required) die('required module ' + f + ' is missing');
    warn('js: ' + f + ' is missing — skipped');
    continue;
  }
  const src = readText(f);
  const wrapped = '/* ===== ' + f + ' ===== */\n;(function(){\n' + src.replace(/\s+$/, '') + '\n})();\n';
  try {
    new vm.Script(wrapped, { filename: f });
  } catch (e) {
    const where = (e.stack || '').split('\n')[0];
    if (required || !SKIP_BROKEN) die('js: ' + f + ' does not parse: ' + e.message + '\n  ' + where +
      (required ? '' : '\n  (re-run with --skip-broken to build without it)'));
    warn('js: ' + f + ' does not parse (' + e.message + ') — LEFT OUT (--skip-broken)');
    continue;
  }
  jsParts.push(wrapped);
  jsUsed.push(f);
}
const JS = jsParts.join('\n');

/* ------------------------------------------------------- 4. shell/ files -- */

const cssFile = 'shell/app.' + sha(CSS) + '.css';
const jsFile = 'shell/app.' + sha(JS) + '.js';

let pathsFile = null, pathsBuf = null;
if (exists('data/paths.json')) {
  pathsBuf = fs.readFileSync(abs('data/paths.json'));
  try { JSON.parse(pathsBuf.toString('utf8')); } catch (e) { die('data/paths.json is not valid JSON: ' + e.message); }
  pathsFile = 'shell/paths.' + sha(pathsBuf) + '.json';
} else {
  warn('data/paths.json does not exist yet — window.__PATHS_URL is not set');
}

const fontFiles = listDir(BRAND_FONTS.slice(0, -1)).map((n) => [BRAND_FONTS + n, 'shell/fonts/' + n]);
const imgFiles = listDir(BRAND_IMG.slice(0, -1)).map((n) => [BRAND_IMG + n, 'shell/img/' + n]);
if (!fontFiles.length) warn('src/brand/fonts/ is empty — the shell falls back to system fonts');

/* shell/brand-scoped.css: the brand for pages that keep their own :root tokens
   (the Films, 3D and Lab pages define --paper/--ink/--accent/... themselves), so
   the brand's tokens apply only inside an element with class "fu-scope". A stable
   name with no hash: those pages link ../shell/brand-scoped.css.
   = fonts.css + tokens.css (its three root selectors moved onto .fu-scope) + components.css. */
const SCOPED_FILE = 'shell/brand-scoped.css';
const SCOPE_RULES = [
  [/:root\s*\{/g, '.fu-scope {', ':root {'],
  [/:root:not\(\[data-theme="light"\]\)\s*\{/g, ':root:not([data-theme="light"]) .fu-scope {', ':root:not([data-theme="light"]) {'],
  [/:root\[data-theme="dark"\]\s*\{/g, ':root[data-theme="dark"] .fu-scope {', ':root[data-theme="dark"] {']
];
let SCOPED = null;
(function () {
  const parts = ['src/brand/fonts.css', 'src/brand/tokens.css', 'src/brand/components.css'];
  const missing = parts.filter((f) => !exists(f));
  if (missing.length === parts.length) { warn('src/brand/ has no css — ' + SCOPED_FILE + ' not written'); return; }
  if (missing.length) die(SCOPED_FILE + ' needs ' + missing.join(', '));
  let tokens = readText('src/brand/tokens.css');
  for (const [re, to, name] of SCOPE_RULES) {
    const n = (tokens.match(re) || []).length;
    if (n !== 1) die('src/brand/tokens.css: expected one "' + name + '" rule to scope for ' + SCOPED_FILE + ', found ' + n);
    tokens = tokens.replace(re, to);
  }
  /* nothing may stay on :root itself, or the scoped file would repaint the host page */
  const re = /:root[^{};]*\{/g;
  let m;
  while ((m = re.exec(tokens))) {
    if (m[0].indexOf('.fu-scope') < 0) die('src/brand/tokens.css: "' + m[0] + '" would stay unscoped in ' + SCOPED_FILE);
  }
  const head = '/* ' + SCOPED_FILE + ' — generated by tools/build-shell.js from src/brand/. Do not edit.\n' +
    '   The brand for pages that keep their own :root tokens: put class="fu-scope" on the\n' +
    '   element that should use the brand (tokens apply inside it only). */\n';
  SCOPED = head + [
    ['src/brand/fonts.css', readText('src/brand/fonts.css')],
    ['src/brand/tokens.css (scoped to .fu-scope)', tokens],
    ['src/brand/components.css', readText('src/brand/components.css')]
  ].map(([f, t]) => '/* ===== ' + f + ' ===== */\n' +
    rewriteUrls(t, f.split(' ')[0]).replace(/\s+$/, '') + '\n').join('\n');
})();

/* Theme colour for the browser chrome: the brand's paper, else V1's. */
function token(name, css) {
  const m = new RegExp('--' + name + '\\s*:\\s*(#[0-9a-fA-F]{3,8})\\s*;').exec(css);
  return m ? m[1] : null;
}
const brandTokens = exists('src/brand/tokens.css') ? readText('src/brand/tokens.css') : '';
const THEME_COLOR = token('paper', brandTokens) || '#fbfaf7';
const THEME_COLOR_DARK = (function () {
  const i = brandTokens.search(/prefers-color-scheme:\s*dark|data-theme="?dark/);
  return i >= 0 ? token('paper', brandTokens.slice(i)) : null;
})();

/* The preview gets its own web app manifest so "Add to Home Screen" on
   next.html opens next.html; at the switch V1's manifest.json fits as it is. */
let pwaFile = 'manifest.json', pwaBuf = null;
if (!AT_SWITCH) {
  let base = {};
  try { base = JSON.parse(readText('manifest.json')); } catch (e) { warn('manifest.json unreadable: ' + e.message); }
  const pwa = {
    name: 'TARA (next)',
    short_name: 'TARA next',
    id: '../' + OUT,
    start_url: '../' + OUT + '#today',
    scope: '../',
    display: 'standalone',
    orientation: 'any',
    theme_color: THEME_COLOR,
    background_color: THEME_COLOR,
    description: base.description || 'TARA',
    categories: ['education'],
    lang: 'en',
    dir: 'ltr',
    icons: (base.icons || []).map((i) => Object.assign({}, i, { src: '../' + i.src }))
  };
  pwaBuf = Buffer.from(JSON.stringify(pwa, null, 2) + '\n', 'utf8');
  pwaFile = 'shell/manifest.' + sha(pwaBuf) + '.json';
}

/* --------------------------------------------------------------- 5. HTML -- */

const TPL = 'src/shell/next.tpl.html';
if (!exists(TPL)) die(TPL + ' is missing');
const tpl = readText(TPL);
const titleM = /<title>([\s\S]*?)<\/title>/.exec(tpl);
const TITLE = titleM ? titleM[1].trim() : 'TARA';
let body = tpl.replace(/<title>[\s\S]*?<\/title>\s*/, '');
if (body.indexOf('<!--@BOOT-->') === -1) die(TPL + ' lost its <!--@BOOT--> marker');

const descM = /"description":\s*"([^"]*)"/.exec(exists('manifest.json') ? readText('manifest.json') : '');
const DESC = descM ? descM[1] : 'TARA';
const scriptEsc = (s) => s.replace(/<\/(script)/gi, '<\\/$1');

/* Runs in <head>, before anything paints or any hook loads:
   - window.TARA_SHELL = 'v2' tells intuition/, objects/ and lab/hook.js which shell this is;
   - sessionStorage tara.shell = this document, so V1 can send links back here;
   - the saved theme lands on <html data-theme> before first paint (no flash):
     "light"/"dark" when chosen, no attribute to follow the OS (BRAND.md §10). */
const HEAD_BOOT = '<script>' + scriptEsc([
  'window.TARA_SHELL="v2";window.TARA_SHELL_DOC=' + JSON.stringify(OUT) + ';',
  '(function(){var d=document.documentElement;',
  'try{sessionStorage.setItem("tara.shell",' + JSON.stringify(OUT) + ')}catch(e){}',
  'var p=null;try{p=localStorage.getItem("tara.v2.theme")}catch(e){}',
  'if(p==="light"||p==="dark")d.setAttribute("data-theme",p);else p="auto";',
  'd.setAttribute("data-theme-pref",p);',
  '})();'
].join('')) + '</' + 'script>';

/* window.__MANIFEST_DOC: where a fresh manifest lives when a payload file named
   here has gone (a deploy renamed it); APP.payload re-reads it once and retries. */
const BODY_DATA = '<script>' + scriptEsc(
  'window.__MANIFEST=' + JSON.stringify(MANIFEST) + ';' +
  'window.__MANIFEST_DOC=' + JSON.stringify(V1_DOC) + ';' +
  (pathsFile ? 'window.__PATHS_URL=' + JSON.stringify(pathsFile) + ';' : '')
) + '</' + 'script>';

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

/* The same small reset V1's document carries, so the sections render as in V1. */
const RESET = 'html{color-scheme:light dark}body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,' +
  '-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}' +
  'img{max-width:100%}[hidden]{display:none!important}';

const preloads = fontFiles
  .filter(([, out]) => /nunito-latin-(700|800)-normal/.test(out))
  .map(([, out]) => '<link rel="preload" href="' + out + '" as="font" type="font/woff2" crossorigin>');

body = body.replace('<!--@BOOT-->', () => [
  BODY_DATA,
  '<script src="' + jsFile + '"></script>',
  SW_REG,
  '<script src="intuition/hook.js" defer></script>',
  '<script src="objects/hook.js" defer></script>',
  '<script src="lab/hook.js" defer></script>'
].join('\n'));

const HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
  '<title>' + TITLE + '</title>',
  '<meta name="description" content="' + DESC.replace(/"/g, '&quot;') + '">',
  '<meta name="theme-color" content="' + THEME_COLOR + '"' + (THEME_COLOR_DARK ? ' media="(prefers-color-scheme: light)"' : '') + '>',
  THEME_COLOR_DARK ? '<meta name="theme-color" content="' + THEME_COLOR_DARK + '" media="(prefers-color-scheme: dark)">' : null,
  '<link rel="manifest" href="' + pwaFile + '">',
  '<link rel="icon" href="icons/icon.svg" type="image/svg+xml">',
  '<link rel="icon" href="icons/icon-192.png" sizes="192x192" type="image/png">',
  '<link rel="apple-touch-icon" href="icons/icon-192.png">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-title" content="TARA">',
  HEAD_BOOT,
  '<style>' + RESET + '</style>',
  preloads.join('\n') || null,
  '<link rel="stylesheet" href="' + cssFile + '">',
  '</head>',
  '<body>',
  body.trim(),
  '</body>',
  '</html>',
  ''
].filter((x) => x != null).join('\n');

/* ------------------------------------------------------------ 6. write ---- */

rmrf('shell');
writeOut(cssFile, CSS);
writeOut(jsFile, JS);
if (pathsFile) writeOut(pathsFile, pathsBuf);
if (pwaBuf) writeOut(pwaFile, pwaBuf);
if (SCOPED) writeOut(SCOPED_FILE, SCOPED);
const fontBufs = fontFiles.map(([from, to]) => { const b = fs.readFileSync(abs(from)); writeOut(to, b); return b; });
const imgBufs = imgFiles.map(([from, to]) => { const b = fs.readFileSync(abs(from)); writeOut(to, b); return b; });
writeOut(OUT, HTML);

/* -------------------------------------------------------------- 7. sw.js -- */

const ICONS = listDir('icons').map((n) => 'icons/' + n);
/* shared/ (the bars' one top bar, linked by the Films, 3D and Lab pages): precached as the
   offline fallback; the worker still fetches it network-first so an update shows online. */
const SHARED = listDir('shared').map((n) => 'shared/' + n);
const sharedBufs = SHARED.map((f) => fs.readFileSync(abs(f)));
const HOOKS = ['intuition/hook.js', 'objects/hook.js', 'lab/hook.js'].filter(exists);
const hookBufs = HOOKS.map((f) => fs.readFileSync(abs(f)));
const PRECACHE = ['./', V1_DOC].concat(v1Css, v1Js)
  .concat(AT_SWITCH ? [] : ['index.html'].filter((x) => x !== V1_DOC))
  .concat([OUT, cssFile, jsFile], pathsFile ? [pathsFile] : [], pwaBuf ? [pwaFile] : [],
    SCOPED ? [SCOPED_FILE] : [],
    fontFiles.map(([, to]) => to), imgFiles.map(([, to]) => to),
    ['manifest.json'], ICONS, SHARED, HOOKS);
const SHELL_FILES = [...new Set(PRECACHE)];
for (const f of SHELL_FILES) if (f !== './' && !exists(f)) die('precache list names ' + f + ', which is not on disk');

if (!exists('tools/sw.tpl.js')) die('tools/sw.tpl.js is missing');
const swTpl = readText('tools/sw.tpl.js');
/* The first two markers are the ones V1's build-site.js fills too; the third only
   this build fills (left alone, it reads null: keep every payload). */
const ASSET_MARK = '/*@ASSET_FILES*/null';
for (const mark of ['__CACHE_VERSION__', '__SHELL_FILES__', ASSET_MARK]) {
  if (swTpl.split(mark).length !== 2) die('tools/sw.tpl.js must carry the ' + mark + ' marker exactly once');
}
/* One version over every byte the worker precaches, and the worker itself. */
const VERSION = sha(Buffer.concat([
  Buffer.from(swTpl + v1html + HTML + CSS + JS + (SCOPED || '') + JSON.stringify(SHELL_FILES), 'utf8'),
  pathsBuf || Buffer.alloc(0), pwaBuf || Buffer.alloc(0)
].concat(fontBufs, imgBufs, sharedBufs, hookBufs)), 12);
const SW = swTpl
  .replace('__CACHE_VERSION__', () => VERSION)
  .replace('__SHELL_FILES__', () => JSON.stringify(SHELL_FILES, null, 2))
  .replace(ASSET_MARK, () => JSON.stringify(ASSET_LIST, null, 2));
try { new vm.Script(SW, { filename: 'sw.js' }); } catch (e) { die('generated sw.js does not parse: ' + e.message); }
writeOut('sw.js', SW);

/* ----------------------------------------------------------- 8. report ---- */

if (!QUIET) {
  const kb = (n) => (n / 1024).toFixed(1) + ' KB';
  console.log('');
  console.log('build-shell -> ' + OUT + '  (payload manifest from ' + V1_DOC + ', ' + MANIFEST.length + ' payloads)');
  console.log('  ' + OUT.padEnd(34) + kb(Buffer.byteLength(HTML)));
  console.log('  ' + cssFile.padEnd(34) + kb(Buffer.byteLength(CSS)) + '  (' + cssUsed.length + ' files)');
  console.log('  ' + jsFile.padEnd(34) + kb(Buffer.byteLength(JS)) + '  (' + jsUsed.length + ' modules)');
  if (pathsFile) console.log('  ' + pathsFile.padEnd(34) + kb(pathsBuf.length));
  if (pwaBuf) console.log('  ' + pwaFile.padEnd(34) + kb(pwaBuf.length));
  if (SCOPED) console.log('  ' + SCOPED_FILE.padEnd(34) + kb(Buffer.byteLength(SCOPED)) + '  (brand, tokens on .fu-scope)');
  console.log('  shell/fonts/ ' + fontFiles.length + ' files, shell/img/ ' + imgFiles.length + ' files');
  console.log('  sw.js  cache ' + VERSION + ', ' + SHELL_FILES.length + ' precached, ' + ASSET_LIST.length + ' payloads kept');
  console.log('  css: ' + cssUsed.join(', '));
  console.log('  js:  ' + jsUsed.join(', '));
  if (warnings.length) {
    console.log('');
    console.log('warnings (' + warnings.length + '):');
    for (const w of warnings) console.log('  ! ' + w);
  }
  console.log('');
}
