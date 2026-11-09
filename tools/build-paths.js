#!/usr/bin/env node
'use strict';
/* tools/build-paths.js — data/paths.json: every TARA week as one short path.
 *
 *   node tools/build-paths.js            -> data/paths.json, plus a coverage table
 *   node tools/build-paths.js --check    -> build in memory, print coverage, write nothing
 *
 * Today a week's material sits in nine places (pack, demos, drill, film, 3D object,
 * concept films, cases, Lab missions, the plan's checklist). This strings them into
 * one ordered path per TARA week, W0-W14, with the steps always in the same order:
 *
 *   watch  the week's film(s), deep dives and related films as extras
 *   ideas  a deck of the week's core + contested concept nodes (allegory first),
 *          library nodes kept apart ("know what it does, skip the internals")
 *   play   demos, the week's 3D object(s), Lab missions
 *   do     the plan's checklist (same tick keys as the plan), the pack at this
 *          week's part, the week's exercise nodes as helpers
 *   check  question ids for a six-question check, filtered to this TARA week
 *   ready  the pack's Saturday anchors, the plan row, the three things to have solid
 *   runway (W12-W14 only) the Lab tab's capstone runway, #lab
 *
 * Inputs, all repo files, read-only (src/V2-CONTRACT.md "Never modify"):
 *   index.html (or classic.html after the switch) for window.__MANIFEST, which names
 *   the current assets/*.gz payloads: schedule, plan, pack:<slug>, bank:<slug>,
 *   demo:<slug>, concepts-index;
 *   intuition/nodes/index.json + intuition/nodes/<id>.json (215 concept nodes),
 *   intuition/films.json (28 films; `week` is a TARA week since 26 Oct),
 *   objects/objects.json (28 objects; `week` is the Model Room BAY, ARENA order),
 *   objects/index.html (the BAY -> TARA weeks table), lab/ui/missions.js.
 *
 * Node >= 18, no dependencies, no network. Deterministic: same inputs, same bytes
 * (no timestamps; `source` is a hash of the inputs). Fails loudly on a missing input.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'paths.json');
const CHECK_ONLY = process.argv.includes('--check');
const MAX_BYTES = 400 * 1024;

const inputHash = crypto.createHash('sha1');
function die(msg) { console.error('\nbuild-paths: FATAL: ' + msg + '\n'); process.exit(1); }
const warnings = [];
function warn(m) { warnings.push(m); }

function readRepo(rel, enc) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) die('missing input ' + rel);
  const buf = fs.readFileSync(p);
  inputHash.update(rel + '\0'); inputHash.update(buf);
  return enc === null ? buf : buf.toString('utf8');
}
function readJSON(rel) {
  try { return JSON.parse(readRepo(rel)); } catch (e) { die(rel + ' is not JSON: ' + e.message); }
}

/* ================================================================ payloads */

function manifest() {
  for (const doc of ['classic.html', 'index.html']) {
    const p = path.join(ROOT, doc);
    if (!fs.existsSync(p)) continue;
    const html = fs.readFileSync(p, 'utf8');
    const m = /window\.__MANIFEST\s*=\s*(\[[\s\S]*?\]);/.exec(html) || /__MANIFEST\s*=\s*(\[[\s\S]*?\]);/.exec(html);
    if (!m) continue;
    try {
      const list = JSON.parse(m[1]);
      const byKey = Object.create(null);
      for (const r of list) byKey[r.key] = r;
      return byKey;
    } catch (e) { warn(doc + ': __MANIFEST did not parse, falling back to assets/ prefixes'); }
  }
  return null;
}
const MANIFEST = manifest();

/* pack:week-10 -> assets/pack-week-10.<hash>.gz (the manifest's file, else the only prefix match) */
function payloadFile(key) {
  if (MANIFEST && MANIFEST[key] && MANIFEST[key].file) return MANIFEST[key].file;
  const stem = key.replace(':', '-');
  const hits = fs.readdirSync(path.join(ROOT, 'assets')).filter((f) => f.startsWith(stem + '.') && f.endsWith('.gz')).sort();
  if (!hits.length) return null;
  if (hits.length > 1) warn('several files for ' + key + ', using ' + hits[hits.length - 1]);
  return 'assets/' + hits[hits.length - 1];
}
function payload(key, optional) {
  const file = payloadFile(key);
  if (!file) { if (optional) return null; die('no payload for ' + key); }
  const buf = readRepo(file, null);
  return (buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8');
}
function payloadJSON(key, optional) {
  const s = payload(key, optional);
  if (s == null) return null;
  try { return JSON.parse(s); } catch (e) { die('payload ' + key + ' is not JSON: ' + e.message); }
}

/* ==================================================================== text */

const ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hairsp: ' ', thinsp: ' ',
  ensp: ' ', emsp: ' ', mdash: '—', ndash: '–', minus: '−', hellip: '…',
  middot: '·', bull: '•', times: '×', divide: '÷', plusmn: '±', deg: '°',
  sect: '§', para: '¶', copy: '©', reg: '®', trade: '™',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', lArr: '⇐', rArr: '⇒',
  hArr: '⇔', nRightarrow: '⇏', le: '≤', ge: '≥', ne: '≠', asymp: '≈', approx: '≈',
  equiv: '≡', infin: '∞', isin: '∈', notin: '∉', sum: '∑', prod: '∏', radic: '√',
  part: '∂', nabla: '∇', prop: '∝', and: '∧', or: '∨', cap: '∩', cup: '∪',
  sup1: '¹', sup2: '²', sup3: '³', frac12: '½', frac14: '¼', frac34: '¾',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ',
  eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν',
  xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ',
  phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ',
  Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  Acirc: 'Â', acirc: 'â', Wcirc: 'Ŵ', wcirc: 'ŵ', eacute: 'é', egrave: 'è',
  agrave: 'à', ouml: 'ö', uuml: 'ü', auml: 'ä', ccedil: 'ç', zwj: '‍', zwnj: '‌'
};
function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, function (all, e) {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch (x) { return all; }
    }
    return Object.prototype.hasOwnProperty.call(ENT, e) ? ENT[e] : all;
  });
}
function escText(s) { return s.replace(/&(?![a-z][a-z0-9]*;|#\d+;|#x[0-9a-f]+;)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function squash(s) { return s.replace(/\s+/g, ' ').trim(); }

/* Plain text (for textContent): tags dropped, entities decoded. */
function plain(s) {
  if (s == null) return '';
  return squash(decode(String(s).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '')));
}

/* Rich text (for innerHTML): only b, i, em, strong, code survive, without attributes;
   a shape span (<span class="sh">) becomes <code>. Text is decoded then re-escaped, so
   the result is well-formed and safe whatever the source did. */
const KEEP = { b: 1, i: 1, em: 1, strong: 1, code: 1 };
function rich(s) {
  if (s == null) return '';
  const src = String(s);
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|<!--[\s\S]*?-->/g;
  let out = '', last = 0, m;
  const stack = [];
  const spanStack = [];
  while ((m = re.exec(src))) {
    out += escText(decode(src.slice(last, m.index)));
    last = re.lastIndex;
    if (!m[1]) continue;                                   /* comment */
    const tag = m[1].toLowerCase(), close = m[0][1] === '/';
    let as = KEEP[tag] ? tag : null;
    if (tag === 'span') {
      if (close) { as = spanStack.pop() || null; }
      else { as = /class\s*=\s*"[^"]*\bsh\b/.test(m[2]) ? 'code' : null; spanStack.push(as); }
    }
    if (tag === 'br' || tag === 'p' || tag === 'li' || tag === 'div') { out += ' '; continue; }
    if (!as) continue;
    if (close) {
      const i = stack.lastIndexOf(as);
      if (i === -1) continue;
      while (stack.length > i) out += '</' + stack.pop() + '>';
    } else if (!/\/\s*$/.test(m[2])) {
      if (as === 'code' && stack.indexOf('code') !== -1) continue;   /* no nested code */
      stack.push(as); out += '<' + as + '>';
    }
  }
  out += escText(decode(src.slice(last)));
  while (stack.length) out += '</' + stack.pop() + '>';
  return squash(out.replace(/<(b|i|em|strong|code)>\s*<\/\1>/g, ''));
}

/* Cut rich text to whole sentences, at most `max` visible characters. */
function sentences(html, max, minKeep) {
  const s = String(html);
  const text = plain(s);
  if (text.length <= max) return s;
  /* sentence ends in the visible text: ". ", "? ", "! " not inside a tag */
  let vis = 0, cut = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '<') { const j = s.indexOf('>', i); if (j === -1) break; i = j; continue; }
    if (s[i] === '&') { const j = s.indexOf(';', i); if (j !== -1 && j - i < 10) { i = j; vis++; continue; } }
    vis++;
    if ((s[i] === '.' || s[i] === '?' || s[i] === '!') && (s[i + 1] === ' ' || i + 1 === s.length)) {
      if (vis <= max) cut = i + 1; else break;
    }
  }
  if (cut === -1 || plain(s.slice(0, cut)).length < (minKeep || 40)) {
    /* no sentence end early enough: cut at a word boundary */
    let v = 0, at = s.length;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '<') { const j = s.indexOf('>', i); if (j === -1) break; i = j; continue; }
      v++;
      if (v >= max) { at = s.lastIndexOf(' ', i); break; }
    }
    return rich(s.slice(0, at).replace(/[,;:\s]+$/, '') + '…');
  }
  return rich(s.slice(0, cut));
}

/* ================================================================== inputs */

const schedule = payloadJSON('schedule');
if (!schedule || !Array.isArray(schedule.weeks)) die('schedule payload has no weeks[]');
const SW = Object.create(null);
for (const w of schedule.weeks) SW[w.n] = w;
for (let n = 0; n <= 14; n++) if (!SW[n]) die('schedule has no week ' + n);

/* The plan's own checklist: var WEEKS=[...] in its script. pre/ex items tick as
   w<N>p<k> / w<N>e<k> in tara.fourteen.v1, N the TARA week (the plan renumbered its
   store to TARA's order on 26 Oct and marks it __order:"tara"). */
function planWeeks() {
  const html = payload('plan');
  const at = html.indexOf('var WEEKS');
  if (at === -1) die('plan payload: no var WEEKS');
  const start = html.indexOf('[', at);
  let depth = 0, q = null, k = start;
  for (; k < html.length; k++) {
    const c = html[k];
    if (q) { if (c === '\\') { k++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) break; }
  }
  const lit = html.slice(start, k + 1);
  const any = new Proxy({}, { get: (t, p) => (typeof p === 'string' ? '#' + p : undefined) });
  let weeks;
  try { weeks = vm.runInNewContext('(' + lit + ')', { D: any, P: any, A: '', U: any }, { timeout: 2000 }); }
  catch (e) { die('plan payload: WEEKS did not evaluate: ' + e.message); }
  const by = Object.create(null);
  for (const W of weeks) by[W.n] = W;
  for (let n = 0; n <= 14; n++) if (!by[n]) die('plan has no week ' + n);
  /* the tick keys the plan writes, confirmed from its own source */
  if (!/"w"\s*\+\s*W\.n\s*\+\s*"p"\s*\+\s*k/.test(html) || !/"w"\s*\+\s*W\.n\s*\+\s*"e"\s*\+\s*k/.test(html)) {
    warn('plan payload: the w<N>p<k> / w<N>e<k> key pattern was not found verbatim; check the tick keys');
  }
  if (html.indexOf('__order="tara"') === -1) warn('plan payload: __order="tara" not found');
  return by;
}
const PW = planWeeks();

const nodeIndex = readJSON('intuition/nodes/index.json');
const NODES = nodeIndex.nodes;
if (!Array.isArray(NODES) || NODES.length < 200) die('intuition/nodes/index.json: expected ~215 nodes');
const NODE = Object.create(null);
NODES.forEach((n, i) => { NODE[n.id] = n; n._i = i; });
const SCRIPT = Object.create(null);
for (const n of NODES) SCRIPT[n.id] = readJSON('intuition/nodes/' + n.id + '.json');

const films = readJSON('intuition/films.json');
const objects = readJSON('objects/objects.json');
const cidx = payloadJSON('concepts-index');
const CASE_IDS = new Set((cidx.concepts || []).map((c) => c.id));

function labMissions() {
  let src = readRepo('lab/ui/missions.js');
  if (/^\s*import\s/m.test(src)) die('lab/ui/missions.js now imports; teach build-paths to read it');
  src = src.replace(/^export\s+(const|function|let|var)\s/gm, '$1 ');
  const ctx = { window: {}, Date: Date };
  vm.createContext(ctx);
  try { vm.runInContext(src + '\n;globalThis.__out = { WEEKS: WEEKS, MISSIONS: MISSIONS };', ctx, { timeout: 2000 }); }
  catch (e) { die('lab/ui/missions.js did not evaluate: ' + e.message); }
  return ctx.__out;
}
const LAB = labMissions();

/* The Model Room keeps its bays in ARENA order and labels them with TARA weeks:
   bay b teaches TARA weeks BAY[b][0]..BAY[b][1] (objects/index.html). */
function bayTable() {
  const html = readRepo('objects/index.html');
  const m = /const BAY\s*=\s*(\{[^;]*\});/.exec(html);
  if (m) { try { return vm.runInNewContext('(' + m[1] + ')'); } catch (e) { /* fall through */ } }
  warn('objects/index.html: BAY table not found, using the 26 Oct table');
  return { 1: [0, 0], 2: [1, 1], 3: [1, 1], 4: [1, 1], 5: [2, 2], 6: [2, 3], 7: [3, 3], 8: [4, 4], 9: [5, 5], 10: [6, 6], 11: [7, 9], 12: [10, 10], 13: [11, 11], 14: [12, 14] };
}
const BAY = bayTable();

/* ============================================================ section map */

/* "[4.1] Emergent Misalignment · [4.2] Science of Misalignment" -> codes and names */
function sectionCodes(s) { return (String(s || '').match(/\[\d+(?:\.\d+)*\]/g) || []); }
const SEC_WEEK = Object.create(null);           /* "[4.1]" -> 10 (first TARA week naming it) */
const SEC_NAME = Object.create(null);           /* "[4.1]" -> "Emergent Misalignment" */
const SEC_BANKNAME = Object.create(null);
for (let n = 0; n <= 14; n++) {
  const arena = SW[n].arena || '';
  for (const code of sectionCodes(arena)) if (SEC_WEEK[code] == null) SEC_WEEK[code] = n;
  const re = /(\[\d+(?:\.\d+)*\])\s*([^·\[]*)/g; let m;
  while ((m = re.exec(arena))) {
    const name = m[2].replace(/[\s,]+$/, '').replace(/^stretch:\s*/i, '').trim();
    if (name && !SEC_NAME[m[1]]) SEC_NAME[m[1]] = name;
  }
}
/* the drill banks name every section cleanly ("[0.4] Build Your Own Backpropagation
   Framework"); their names win over the schedule's shorthand */
for (const key of Object.keys(MANIFEST || {}).filter((k) => k.indexOf('bank:') === 0).sort()) {
  const b = payloadJSON(key, true);
  for (const s of (b && b.arenaSections) || []) {
    const m = /^(\[\d+(?:\.\d+)*\])\s*(.+)$/.exec(s);
    if (m && !SEC_BANKNAME[m[1]]) SEC_BANKNAME[m[1]] = m[2].trim();
  }
}
for (const code in SEC_BANKNAME) SEC_NAME[code] = SEC_BANKNAME[code];
/* nodes fill sections the schedule never names (background chapter 1 material) */
const secVotes = Object.create(null);
for (const n of NODES) {
  if (!n.section || n.week == null) continue;
  (secVotes[n.section] = secVotes[n.section] || {})[n.week] = ((secVotes[n.section] || {})[n.week] || 0) + 1;
}
for (const code in secVotes) {
  if (SEC_WEEK[code] != null) continue;
  const v = secVotes[code];
  SEC_WEEK[code] = Number(Object.keys(v).sort((a, b) => v[b] - v[a] || a - b)[0]);
}

/* ================================================================ helpers */

function tintOf(n) { return n <= 1 ? 'found' : n <= 4 ? 'interp' : n <= 6 ? 'rl' : n <= 9 ? 'evals' : n <= 11 ? 'align' : 'project'; }
function packSlugs(w) { return (w.packSlugs && w.packSlugs.length ? w.packSlugs : (w.packSlug ? [w.packSlug] : [])); }
function packHash(w, slug) {
  const a = w.packAnchors && w.packAnchors[slug];
  return '#' + (a ? slug + '/' + a : slug);
}
const PACK_HTML = Object.create(null);
function packHTML(slug) {
  if (!(slug in PACK_HTML)) PACK_HTML[slug] = payload('pack:' + slug, true) || '';
  return PACK_HTML[slug];
}
function packTitle(slug) {
  const m = /<title>([\s\S]*?)<\/title>/i.exec(packHTML(slug));
  return m ? plain(m[1]).replace(/\s*[—–|-]\s*TARA.*$/i, '') : slug;
}
function hasId(slug, id) { return new RegExp('\\bid="' + id.replace(/[-]/g, '\\-') + '"').test(packHTML(slug)); }

function filmPath(rel) { return rel ? 'intuition/' + String(rel).replace(/^\.?\//, '') : null; }
function objectPath(rel) { return rel ? 'objects/' + String(rel).replace(/^\.?\//, '') : null; }
function round1(x) { return Math.round(x * 10) / 10; }

/* ===================================================================== watch */

function filmEntry(f, role) {
  const secs = f.seconds || Math.round((f.minutes || 1) * 60);
  return {
    id: f.id, title: plain(f.title), path: filmPath(f.path), seconds: secs,
    blurb: sentences(rich(f.blurb || ''), 190, 60), role: role
  };
}
function filmWeeks(f) { return f.weeks && f.weeks.length ? f.weeks : (f.week == null ? [] : [f.week]); }

function watchStep(n, weekNodeIds) {
  const main = [], extras = [];
  const used = new Set();
  for (const f of films) {
    if (filmWeeks(f).indexOf(n) === -1) continue;
    (f.format === 'deep' ? extras : main).push(f); used.add(f.id);
  }
  /* a week with only a deep dive watches the deep dive */
  if (!main.length && extras.length) main.push(extras.shift());
  const out = { main: main.map((f) => filmEntry(f, 'main')), extras: extras.map((f) => filmEntry(f, 'deep')) };
  /* related: another week's film whose concepts name two or more of this week's nodes */
  for (const f of films) {
    if (used.has(f.id) || f.week == null) continue;
    const hits = (f.concepts || []).filter((c) => weekNodeIds.has(c));
    if (hits.length >= 2) out.extras.push(filmEntry(f, 'related'));
  }
  if (n === 0) {
    const star = films.find((f) => f.week == null);
    if (star) out.extras.push(filmEntry(star, 'course'));
  }
  if (!out.main.length) return null;
  const secs = out.main.reduce((a, f) => a + f.seconds, 0);
  return {
    id: 'watch', kind: 'watch',
    title: out.main.length > 1 ? 'Watch the films' : 'Watch the film',
    sub: out.main.map((f) => f.title).join(' · '),
    minutes: Math.max(1, Math.ceil(secs / 60)),
    films: out.main, extras: out.extras
  };
}

/* ===================================================================== ideas */

function contestedJudgement(script) {
  const ch = (script.chapters || []).filter((c) => c.need === 'contested');
  if (!ch.length) return null;
  /* the line that says "current method X, emerging research Y"; a bare verdict
     ("Current evidence fits narrow.") brings its chapter's Generalist caption along */
  const RX = /current (method|habit|evidence|explanation|call)|emerging/i;
  for (const c of ch) {
    const cap = c.cap || {};
    for (const t of ['2', '3', '1']) if (cap[t] && RX.test(plain(cap[t]))) return sentences(rich(cap[t]), 420, 80);
    if (c.verdict && RX.test(plain(c.verdict))) return sentences(rich(c.verdict + (cap['2'] ? ' ' + cap['2'] : '')), 420, 80);
  }
  const c0 = ch[0], cap0 = c0.cap || {};
  const text = c0.verdict ? c0.verdict + (cap0['2'] ? ' ' + cap0['2'] : '') : cap0['2'];
  return text ? sentences(rich(text), 420, 80) : null;
}

function cardOf(node) {
  const s = SCRIPT[node.id] || {};
  const h = s.hamming || {};
  const where = (s.where_else || []).slice(0, 4).map((x) => sentences(rich(x), 150, 30));
  const judge = contestedJudgement(s);
  const card = {
    id: node.id, label: plain(node.label), title: plain(node.title || s.title || node.label),
    need: node.need, section: node.section || null, seconds: node.seconds || null,
    film: filmPath(node.film), object: objectPath(node.object), objectTitle: plain(node.object_title || '') || null,
    case: node.case && CASE_IDS.has(node.case) ? node.case : null,
    tiers: {
      1: { plain: rich(node.plain), pic: s.allegory ? sentences(rich(s.allegory), 300, 80) : null },
      2: { what: rich(h.what || ''), when: rich(h.when || ''), why: rich(h.why || '') },
      3: { where: where, judge: judge }
    }
  };
  if (node.case && !card.case) warn('node ' + node.id + ': case ' + node.case + ' is not in concepts-index');
  return card;
}
function slimOf(node, withPlain) {
  const o = { id: node.id, label: plain(node.label), title: plain(node.title || node.label), film: filmPath(node.film) };
  if (withPlain) o.plain = rich(node.plain);
  if (node.object) o.object = objectPath(node.object);
  if (node.section) o.section = node.section;
  return o;
}
function byOrder(a, b) { return (a.order || 0) - (b.order || 0) || a._i - b._i; }

/* W13 and W14 have no nodes of their own; each revisits the W12 card it is about. */
const AGAIN = { 13: ['capstone-project'], 14: ['final-presentation'] };

function ideasStep(n) {
  let deck = NODES.filter((x) => x.week === n && (x.need === 'core' || x.need === 'contested')).sort(byOrder);
  const again = (AGAIN[n] || []).map((id) => NODE[id]).filter(Boolean);
  const cards = deck.map(cardOf).concat(again.map((x) => Object.assign(cardOf(x), { again: x.week })));
  const library = NODES.filter((x) => x.week === n && x.need === 'library').sort(byOrder).map((x) => slimOf(x, true));
  /* ARENA chapter-1 sections TARA never schedules (function vectors, oracles, grokking,
     OthelloGPT ...): optional background, kept with the last mech interp week. */
  const background = n === 4 ? NODES.filter((x) => x.week == null).sort(byOrder).map((x) => Object.assign(slimOf(x, true), { need: x.need })) : [];
  if (!cards.length && !library.length) return null;
  const core = cards.filter((c) => c.need === 'core').length, cont = cards.filter((c) => c.need === 'contested').length;
  return {
    id: 'ideas', kind: 'ideas',
    title: cards.length ? 'Core ideas' : 'Library calls',
    sub: cards.length
      ? cards.length + ' card' + (cards.length === 1 ? '' : 's') + (cont ? ' · ' + cont + ' contested' : '') + (library.length ? ' · ' + library.length + ' to skim' : '')
      : library.length + ' to skim: know what each does, skip the internals',
    minutes: Math.max(2, Math.ceil(cards.length * 0.75 + library.length * 0.25)),
    cards: cards, library: library, background: background,
    counts: { core: core, contested: cont }
  };
}

/* ====================================================================== play */

const DEMO_INFO = Object.create(null);
function demoInfo(slug) {
  if (DEMO_INFO[slug]) return DEMO_INFO[slug];
  const html = payload('demo:' + slug, true) || '';
  const t = /<title>([\s\S]*?)<\/title>/i.exec(html);
  /* the plain-tier lede if it is tiered, else the first lede */
  const ledes = [...html.matchAll(/<p\b([^>]*\bclass="[^"]*\blede\b[^"]*"[^>]*)>([\s\S]*?)<\/p>/gi)];
  const pick = ledes.find((m) => /data-tier="1"/.test(m[1])) || ledes[0];
  DEMO_INFO[slug] = {
    slug: slug, title: t ? plain(t[1]) : slug.replace(/-/g, ' '),
    blurb: pick ? sentences(rich(pick[2]), 170, 50) : '', hash: '#demo/' + slug
  };
  if (!html) warn('demo:' + slug + ' payload missing');
  return DEMO_INFO[slug];
}

/* An object belongs to the TARA week most of its map nodes are taught in; a week left
   with none borrows its bay's weekly object (bay 11 serves W7-W9, bay 14 W12-W14). */
const OBJ_WEEK = Object.create(null);
for (const o of objects) {
  if (o.kind === 'north') { OBJ_WEEK[o.id] = 0; continue; }
  const votes = {};
  for (const id of o.map || []) {
    const w = NODE[id] && NODE[id].week;
    if (w != null) votes[w] = (votes[w] || 0) + 1;
  }
  const range = BAY[o.week] || [o.week, o.week];
  const ks = Object.keys(votes).map(Number);
  if (!ks.length) { OBJ_WEEK[o.id] = range[0]; continue; }
  ks.sort((a, b) => votes[b] - votes[a] || (Number(b >= range[0] && b <= range[1]) - Number(a >= range[0] && a <= range[1])) || a - b);
  OBJ_WEEK[o.id] = ks[0];
}
function objectsFor(n) {
  let list = objects.filter((o) => OBJ_WEEK[o.id] === n && o.kind !== 'north');
  if (!list.length) list = objects.filter((o) => o.kind === 'weekly' && BAY[o.week] && n >= BAY[o.week][0] && n <= BAY[o.week][1]);
  const out = list.map((o) => ({ id: o.id, title: plain(o.title), sub: plain(o.subtitle), path: objectPath(o.path), kind: o.kind }));
  if (n === 0) {
    const north = objects.find((o) => o.kind === 'north');
    if (north) out.push({ id: north.id, title: plain(north.title), sub: plain(north.subtitle), path: objectPath(north.path), kind: 'north' });
  }
  return out;
}

function hashFor(view, parts, params) {
  const p = [view].concat(parts || []).map(encodeURIComponent).join('/');
  const q = Object.keys(params || {}).filter((k) => params[k] != null && params[k] !== '')
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
  return '#' + p + (q ? '?' + q : '');
}
function missionsFor(n) {
  return LAB.MISSIONS.filter((m) => m.week === n).map((m) => ({
    id: m.id, title: plain(m.title), why: sentences(rich(m.why || ''), 200, 60),
    href: 'lab/index.html#missions/week-' + n,
    tool: m.tool ? 'lab/index.html' + hashFor('tool', [m.tool], m.params || {}) : (m.result ? 'lab/index.html#results/' + encodeURIComponent(m.result) : null),
    steps: (m.steps || []).length
  }));
}

function playStep(n, demos, objs, missions) {
  if (!demos.length && !objs.length && !missions.length) return null;
  const bits = [];
  if (demos.length) bits.push(demos.length + ' demo' + (demos.length === 1 ? '' : 's'));
  if (objs.length) bits.push(objs.length + ' 3D object' + (objs.length === 1 ? '' : 's'));
  if (missions.length) bits.push(missions.length + ' Lab mission' + (missions.length === 1 ? '' : 's'));
  return {
    id: 'play', kind: 'play', title: 'Play with it', sub: bits.join(' · '), minutes: 10,
    demos: demos, objects: objs, missions: missions.map((m) => m.id)
  };
}

/* ======================================================================== do */

/* W12-W14: the capstone pack's sections, by what each Saturday is for. */
const CAP_READY = {
  12: [['derisk', 'The de-risking checklist'], ['weeks', 'The three weeks, day by day']],
  13: [['weeks', 'The three weeks, day by day'], ['claims', 'Not overclaiming']],
  14: [['talk', 'The ten minutes you are graded on'], ['card', 'The one-page card']]
};
const CAP_PARTS = {
  12: [['weeks', 'The three weeks, day by day'], ['derisk', 'The de-risking checklist'], ['hygiene', 'Research hygiene'], ['scoping', 'Cutting a question until it fits']],
  13: [['weeks', 'The three weeks, day by day'], ['claims', 'Not overclaiming'], ['scoping', 'Cutting a question until it fits']],
  14: [['talk', 'The ten minutes you are graded on'], ['claims', 'Not overclaiming'], ['card', 'The one-page card']]
};

function doStep(n, w, pw) {
  const pre = (pw.pre || []).map((t, k) => ({ k: 'w' + n + 'p' + k, t: rich(t) }));
  const ex = (pw.ex || []).map((t, k) => ({ k: 'w' + n + 'e' + k, t: rich(t) }));
  const packs = packSlugs(w).map((slug, i) => ({
    slug: slug, title: packTitle(slug), hash: packHash(w, slug), anchor: (w.packAnchors || {})[slug] || null,
    stretch: /stretch/i.test(SW[n].arena || '') && i > 0
  }));
  const parts = (CAP_PARTS[n] || []).filter(([id]) => hasId('capstone-weeks-12-14', id))
    .map(([id, label]) => ({ label: label, hash: '#capstone-weeks-12-14/' + id }));
  const exercise = NODES.filter((x) => x.week === n && x.need === 'exercise').sort(byOrder).map((x) => slimOf(x, false));
  if (!pre.length && !ex.length && !packs.length) return null;
  return {
    id: 'do', kind: 'do', title: n >= 12 ? 'Do on the day' : 'Prep and exercises',
    sub: pre.length + ' pre-read' + (pre.length === 1 ? '' : 's') + ' · ' + ex.length + (n >= 12 ? ' on the day' : ' exercise' + (ex.length === 1 ? '' : 's')),
    minutes: 25,
    pre: pre, ex: ex, skip: rich(pw.skip || ''), packs: packs, parts: parts, exercise: exercise,
    lead: n >= 12 ? 'Do on the day' : 'Exercises to attempt'
  };
}

/* ===================================================================== check */

const BANK = Object.create(null);
function bank(slug) {
  if (!(slug in BANK)) BANK[slug] = payloadJSON('bank:' + slug, true);
  return BANK[slug];
}
const WEEKLY_BANKS = [];
for (let n = 0; n <= 11; n++) for (const s of packSlugs(SW[n])) if (WEEKLY_BANKS.indexOf(s) === -1) WEEKLY_BANKS.push(s);

function sourceSection(q) {
  const codes = sectionCodes(q.source);
  return codes.length ? codes[0] : null;
}
/* A question's TARA week: its ARENA section (the schedule names it), else the
   concept's node, else null. The two agree for all but a handful; the section wins
   because it is what the question was written from. */
function questionWeek(q) {
  const sec = sourceSection(q);
  if (sec && SEC_WEEK[sec] != null) return SEC_WEEK[sec];
  const node = NODE[q.concept];
  if (node && node.week != null) return node.week;
  return null;
}

/* The capstone playbook's concepts, by the Saturday they serve: W12 build and run,
   W13 finish and freeze, W14 the talk. ARENA review items in that bank stay out. */
const CAP_WEEK = {
  'baseline-control': 12, 'candidate-project': 12, 'capstone-project': 12, 'classifier-agreement': 12,
  'coherence-control': 12, 'compute-budget': 12, 'de-risk-checklist': 12, 'end-to-end-pilot': 12,
  'environment-validity': 12, 'eval-awareness': 12, 'eval-threat-model-and-spec': 12, 'factorial-grid': 12,
  'fallback-plan': 12, 'lab-notebook': 12, 'pass-condition': 12, 'positive-control': 12,
  'pre-registered-prediction': 12, 'project-gate': 12, 'project-selection': 12, 'prompt-sensitivity': 12,
  'raw-outputs': 12, 'reproducible-pipeline': 12, 'run-naming': 12, 'scope-cutting': 12, 'seed-discipline': 12,
  'seed-variance': 12, 'smallest-experiment': 12, 'teacher-time': 12, 'time-budget': 12, 'toy-model-transfer': 12,
  'results-freeze': 13, 'effect-size-interval': 13, 'figure-that-carries-a-claim': 13, 'negative-result': 13,
  'power-statement': 13, 'red-teaming-results': 13, 'showed-vs-suggests': 13, 'overclaiming': 13,
  'wilson-interval': 13, 'replication-novelty': 13,
  'backup-slides': 14, 'credibility-sentences': 14, 'delivery-logistics': 14, 'final-presentation': 14,
  'limitation-naming': 14, 'next-experiment': 14, 'null-result-talk': 14, 'one-claim': 14,
  'prediction-slide': 14, 'question-prep': 14, 'reading-a-figure': 14, 'rehearsal': 14, 'talk-structure': 14
};
function capstoneWeek(q) {
  if (sourceSection(q)) return null;
  if (CAP_WEEK[q.concept]) return CAP_WEEK[q.concept];
  const s = String(q.source || '');
  if (/ten minutes|rehearsal|questions you will be asked|§0?7/i.test(s)) return 14;
  if (/overclaim|honest claims|freeze|§0?8/i.test(s)) return 13;
  return 12;
}

/* Trivia never enters a check pool: the user's standing rule is conceptual first, with no
   code-constant and no schedule trivia. A number to remember is not an idea to hold, so out go
   - a numeric question in recall mode (STEERING_LAYER's 24, R1_3_3_3's nine adapters,
     the talk's ten minutes);
   - a number whose unit is a remembered setting (a layer index, an index offset, a
     threshold score, a fraction of depth, a paper's solve rate);
   - schedule and logistics arithmetic (minutes, hours, days, a clock hour, rehearsals,
     slides, words, questions to prepare, dollars);
   - a question of any type that asks for a setting's value ("by default", "set to what");
   - options or ordering items that are dates and times, and "as the playbook lists them";
   - and by name, the course logistics no rule above catches. */
const SETTING_UNITS = /^(layer index|index offset|fraction of .+|.+ score|percent solve rate|samples per variant|cosine similarity|dimensions)$/i;
const LOGISTIC_UNITS = /^(minutes?|hours?|days?|weeks?|hour \(24h clock\)|rehearsals?|slides?|words?|questions?|usd)$/i;
const ASKS_SETTING = /\b(by default|default (value|threshold)|set to what|what threshold|that threshold|which layer (does|do|is)|names a range|following the paper)\b/i;
const WHEN_TEXT = /\b\d{1,2}(:\d\d)?\s*(am|pm)\b|\b\d{1,2} (October|November|December)\b|^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?\s+\d|\b\d+(\.\d+)?\s+(total |working |Saturday )*(minutes|hours|days|weeks)\b/i;
const LOGISTICS_BY_ID = { 'cap00-q004': 'the pass condition' };
function trivia(q) {
  if (LOGISTICS_BY_ID[q.id]) return 'schedule or logistics';
  const asked = [q.stem].concat(Array.isArray(q.variants) ? q.variants : []).map(plain).join(' \n ');
  const unit = String(q.unit || '').trim();
  if (q.type === 'numeric') {
    if (q.mode === 'recall') return 'a number to recall';
    if (LOGISTIC_UNITS.test(unit)) return 'schedule or logistics';
    if (SETTING_UNITS.test(unit)) return 'a setting to recall';
  }
  if (ASKS_SETTING.test(asked)) return 'a setting to recall';
  if (/as the playbook lists them/i.test(asked)) return 'a list order to recall';
  const choices = (q.type === 'ordering' ? q.items : q.options) || [];
  const texts = choices.map((c) => plain(c && typeof c === 'object' ? c.text : c));
  if (texts.length && texts.filter((t) => WHEN_TEXT.test(t)).length >= Math.max(2, texts.length - 1)) return 'schedule or logistics';
  return null;
}
const TRIVIA = Object.create(null);             /* reason -> [ids], for the report */

const ALL_QIDS = Object.create(null);           /* id -> bank, to prove ids are unique */
function checkStep(n, w) {
  const own = packSlugs(w);
  const pool = Object.create(null);
  let count = 0;
  const add = (slug, q) => {
    const why = trivia(q);
    if (why) { const l = TRIVIA[why] = TRIVIA[why] || []; if (l.indexOf(q.id) === -1) l.push(q.id); return; }
    (pool[slug] = pool[slug] || []).push(q.id); count++;
  };
  if (n >= 12) {
    const b = bank('capstone-weeks-12-14');
    for (const q of (b && b.questions) || []) if (capstoneWeek(q) === n) add('capstone-weeks-12-14', q);
  } else {
    /* the week's own banks first, then any weekly bank with questions from this week's
       sections (VPG [2.2.2] sits in week-09's bank, but TARA teaches it in W6) */
    const order = own.concat(WEEKLY_BANKS.filter((s) => own.indexOf(s) === -1));
    for (const slug of order) {
      const b = bank(slug);
      if (!b) continue;
      for (const q of b.questions || []) if (questionWeek(q) === n) add(slug, q);
    }
    if (count < 6) {
      /* fall back to the whole of the week's first bank */
      const slug = own[0], b = bank(slug);
      for (const q of (b && b.questions) || []) if ((pool[slug] || []).indexOf(q.id) === -1) add(slug, q);
      warn('W' + n + ': fewer than six questions matched its sections; using the whole ' + slug + ' bank');
    }
  }
  const slugs = Object.keys(pool);
  if (!slugs.length) return null;
  /* the first six: multiple choice, easy first, one concept each, and at most one number or
     ordering among them (an ordering first: it is a process, not a sum). The runtime keeps
     the same one-in-six cap for every later round. */
  const flat = [];
  for (const slug of slugs) for (const id of pool[slug]) {
    const q = bank(slug).questions.find((x) => x.id === id);
    flat.push({ id: id, slug: slug, concept: q.concept, type: q.type, d: q.difficulty || 2 });
  }
  flat.sort((a, b) => a.d - b.d || (a.slug === b.slug ? 0 : (own.indexOf(a.slug) === -1) - (own.indexOf(b.slug) === -1)) || (a.id < b.id ? -1 : 1));
  const mcq = flat.filter((x) => x.type === 'mcq');
  const other = flat.filter((x) => x.type !== 'mcq' && x.d <= 2).sort((a, b) => (a.type === 'ordering' ? 0 : 1) - (b.type === 'ordering' ? 0 : 1));
  const six = [], seenC = new Set();
  const take = (x) => { six.push(x.id); seenC.add(x.concept); };
  for (const x of mcq) { if (six.length >= 5) break; if (!seenC.has(x.concept)) take(x); }
  const one = other.find((x) => !seenC.has(x.concept)) || other[0];
  if (one) take(one);
  for (const x of mcq) { if (six.length >= 6) break; if (!seenC.has(x.concept) && six.indexOf(x.id) === -1) take(x); }
  for (const x of mcq) { if (six.length >= 6) break; if (six.indexOf(x.id) === -1) take(x); }
  return {
    id: 'check', kind: 'check', title: 'Quick check',
    sub: 'Six questions, shuffled · ' + count + ' in the pool',
    minutes: 6, pool: pool, six: six, drill: '#drill/' + (own[0] || slugs[0])
  };
}

/* ===================================================================== ready */

function threeThings(slug) {
  const html = packHTML(slug);
  if (!html) return [];
  const pri = html.search(/id="primer"/);
  const start = pri !== -1 ? pri : html.search(/>\s*Saturday primer\s*</);
  const scope = start === -1 ? html : html.slice(start);
  const hm = /<(h[3-6])[^>]*>([^<]*(?:<[^>]+>[^<]*)*?)<\/\1>/g;
  let m, at = -1, level = null;
  while ((m = hm.exec(scope))) {
    if (/three things/i.test(plain(m[2]))) { at = hm.lastIndex; level = m[1]; break; }
  }
  if (at === -1) return [];
  /* up to the next heading that is not a numbered item ("1 · The head-axis swap") */
  const rest = scope.slice(at, at + 12000);
  const stop = /<h([2-6])[^>]*>([\s\S]*?)<\/h\1>/g;
  let end = rest.length, sm;
  while ((sm = stop.exec(rest))) { if (!/^\s*\d/.test(plain(sm[2]))) { end = sm.index; break; } }
  const seg = rest.slice(0, end);
  let items = [];
  const lis = [...seg.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((x) => x[1]);
  if (lis.length >= 3) items = lis;
  else {
    const trips = seg.split(/<div\b[^>]*class="[^"]*\btrip\b[^"]*"[^>]*>/i).slice(1);
    if (trips.length >= 3) {
      items = trips.map((t) => t.replace(/<h4[^>]*>\s*\d+\s*[·.]\s*([\s\S]*?)<\/h4>/i, '<b>$1.</b> ').replace(/<b>\s*\d+\.\s*/i, '<b>'));
    } else {
      /* one tiered paragraph: <strong>1.</strong> ... <strong>2.</strong> ... (Generalist tier) */
      const t2 = /data-tier="2"[^>]*>([\s\S]*?)<\/div>/i.exec(seg);
      const body = t2 ? t2[1] : seg;
      items = body.split(/<(?:strong|b)>\s*\d+\.\s*<\/(?:strong|b)>/i).slice(1);
    }
  }
  return items.slice(0, 3).map((x) => sentences(rich(x), 260, 60)).filter((x) => plain(x).length > 10);
}

/* Alignment science has no primer; its explain-it quiz (tagged by section) is the
   Saturday check: three prompts from this week's sections, said out loud. */
function explainIt(slug, sections) {
  const html = packHTML(slug);
  const boxes = [...html.matchAll(/<p class="qt">([\s\S]*?)<\/p>\s*<div class="qtag"[^>]*>([^<]*)</g)];
  const want = boxes.map((b) => ({ q: b[1], tag: plain(b[2]) }))
    .filter((b) => !/bonus/i.test(b.tag) && sections.some((s) => b.tag.indexOf(s) === 0));
  const out = [], used = new Set();
  for (const s of sections) { const hit = want.find((b) => b.tag.indexOf(s) === 0 && !used.has(b)); if (hit) { out.push(hit); used.add(hit); } }
  for (const b of want) { if (out.length >= 3) break; if (!used.has(b)) { out.push(b); used.add(b); } }
  return out.slice(0, 3).map((b) => sentences(rich(b.q), 220, 60));
}

function readyStep(n, w, pw) {
  const anchors = [];
  const slugs = packSlugs(w);
  for (const slug of slugs) {
    const title = packTitle(slug);
    if (slug === 'capstone-weeks-12-14') {
      for (const [id, label] of (CAP_READY[n] || [])) {
        if (hasId(slug, id) && !anchors.some((a) => a.hash === '#' + slug + '/' + id)) anchors.push({ label: label, hash: '#' + slug + '/' + id, found: true, pack: title });
      }
      continue;
    }
    if (hasId(slug, 'map') && /What has to be solid by Saturday/i.test(packHTML(slug))) {
      anchors.push({ label: 'What has to be solid by Saturday', hash: '#' + slug + '/map', found: true, pack: title });
    }
    if (/Saturday primer/i.test(packHTML(slug))) {
      anchors.push({ label: 'Saturday primer', hash: '#' + slug + '/primer', found: hasId(slug, 'primer'), pack: title });
    }
    if (hasId(slug, 'quiz') && slug === 'alignment-science') {
      anchors.push({ label: 'Explain-it quiz: say these out loud', hash: '#' + slug + '/quiz', found: true, pack: title });
      if (hasId(slug, 'ask')) anchors.push({ label: 'Questions worth asking your teacher', hash: '#' + slug + '/ask', found: true, pack: title });
    }
  }
  let three = [], threeLabel = null;
  if (slugs[0] === 'alignment-science') {
    three = explainIt('alignment-science', sectionCodes(SW[n].arena).filter((c) => /^\[4\./.test(c)));
    threeLabel = 'Three things to say out loud';
  } else if (n < 12) {
    /* one pack: its three; several (W1, W3, W4): take them in turn, first pack first */
    const lists = slugs.map(threeThings);
    for (let i = 0; three.length < 3 && i < 3; i++) for (const l of lists) if (l[i] && three.length < 3) three.push(l[i]);
    threeLabel = 'The three things most likely to trip you up';
  }
  /* the sub-line says what is actually inside, in the order the screen shows it */
  const subBits = [];
  if (three.length) subBits.push(/out loud/i.test(threeLabel || '') ? 'three things to say out loud' : 'three things to have solid');
  else if (pw.check) subBits.push('the day\'s checkpoint');
  if (anchors.some((a) => /primer/i.test(a.label))) subBits.push('the primer');
  else if (anchors.length) subBits.push(n >= 12 ? 'the pack\'s parts' : 'the pack');
  subBits.push('the plan row');
  const sub = subBits.join(', ').replace(/^./, (c) => c.toUpperCase());
  return {
    id: 'ready', kind: 'ready', title: 'Ready for Saturday',
    sub: sub,
    minutes: 5, anchors: anchors, plan: '#plan/week-' + n,
    checkpoint: rich(pw.check || ''), three: three, threeLabel: threeLabel
  };
}

/* ==================================================================== runway */

function runwayStep(n) {
  return {
    id: 'runway', kind: 'runway', title: 'Capstone runway',
    sub: n === 14 ? 'The talk, Sat 12 Dec' : 'Results freeze Sat 5 Dec 6pm · talk Sat 12 Dec',
    minutes: 10, link: '#lab'
  };
}

/* ===================================================================== build */

const weeks = [];
const missionsAll = Object.create(null);
for (let n = 0; n <= 14; n++) {
  const w = SW[n], pw = PW[n];
  const weekNodeIds = new Set(NODES.filter((x) => x.week === n).map((x) => x.id));
  const demos = (w.demoSlugs || []).map(demoInfo);
  const objs = objectsFor(n);
  const missions = missionsFor(n);
  missions.forEach((m) => { missionsAll[m.id] = m; });
  const steps = [
    watchStep(n, weekNodeIds),
    ideasStep(n),
    playStep(n, demos, objs, missions),
    doStep(n, w, pw),
    checkStep(n, w),
    readyStep(n, w, pw),
    n >= 12 ? runwayStep(n) : null
  ].filter(Boolean);
  steps.forEach((s) => { s.hash = '#weeks/' + n + '/' + s.id; });
  const lab = LAB.WEEKS.find((x) => x.n === n) || {};
  weeks.push({
    n: n, saturday: w.saturday, chapter: w.chapter, tint: tintOf(n), arena: w.arena,
    sections: sectionCodes(w.arena), title: plain(pw.title), short: plain(lab.title || ''),
    online: !!pw.online, risk: pw.risk || null,
    steps: steps, missions: missions
  });
}

/* every question id unique across banks, so the runtime can key on the id alone */
for (const slug of Object.keys(BANK).sort()) {
  const b = BANK[slug];
  for (const q of (b && b.questions) || []) {
    if (ALL_QIDS[q.id] && ALL_QIDS[q.id] !== slug) die('question id ' + q.id + ' is in both ' + ALL_QIDS[q.id] + ' and ' + slug);
    ALL_QIDS[q.id] = slug;
  }
}

/* a tile shows `short`; two weeks with the same one (W12, W13: "Project") take the
   part of the plan's title after the dash instead ("Scope freeze") */
const shortSeen = Object.create(null);
weeks.forEach((wk) => { shortSeen[wk.short] = (shortSeen[wk.short] || 0) + 1; });
weeks.forEach((wk) => {
  if (wk.short && shortSeen[wk.short] < 2) return;
  const tail = String(wk.title).split(/\s+[—–-]\s+/).slice(1).join(' — ').trim();
  if (tail) wk.short = tail.charAt(0).toUpperCase() + tail.slice(1);
  else if (!wk.short) wk.short = wk.title;
});

const sectionsUsed = Object.create(null);
for (const code of Object.keys(SEC_NAME).sort()) sectionsUsed[code] = SEC_NAME[code];

const out = {
  version: 1,
  source: inputHash.digest('hex').slice(0, 12),
  note: 'Built by tools/build-paths.js from repo files. Do not edit by hand.',
  tints: { found: [0, 1], interp: [2, 4], rl: [5, 6], evals: [7, 9], align: [10, 11], project: [12, 14] },
  sections: sectionsUsed,
  weeks: weeks
};
const json = JSON.stringify(out);
const bytes = Buffer.byteLength(json);

/* ================================================================== report */

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
const rows = [['week', 'steps', 'ideas', 'lib', 'exer', 'films', 'objects', 'demos', 'missions', 'ticks', 'check', 'ready']];
for (const wk of weeks) {
  const st = Object.create(null);
  wk.steps.forEach((s) => { st[s.kind] = s; });
  const id = st.ideas, wa = st.watch, pl = st.play, d = st.do, c = st.check, r = st.ready;
  const poolN = c ? Object.values(c.pool).reduce((a, l) => a + l.length, 0) : 0;
  rows.push([
    'W' + wk.n, wk.steps.map((s) => s.id[0]).join(''),
    id ? id.cards.length + (id.counts.contested ? ' (' + id.counts.contested + 'c)' : '') : '-',
    id ? id.library.length + (id.background.length ? '+' + id.background.length + 'bg' : '') : '-',
    d ? d.exercise.length : '-',
    wa ? wa.films.length + '+' + wa.extras.length : '-',
    pl ? pl.objects.map((o) => o.id).join(',') : '-',
    pl ? pl.demos.length : '-',
    wk.missions.length,
    d ? d.pre.length + 'p+' + d.ex.length + 'e' : '-',
    c ? c.six.length + '/' + poolN : '-',
    r ? r.anchors.filter((a) => a.found).length + '/' + r.anchors.length + 'a ' + r.three.length + 't' : '-'
  ]);
}
const widths = rows[0].map((_, i) => Math.max.apply(null, rows.map((r) => String(r[i]).length)));
console.log('\nbuild-paths: coverage per TARA week (steps: w=watch i=ideas p=play d=do c=check r=ready r=runway)');
for (const r of rows) console.log('  ' + r.map((c, i) => pad(c, widths[i])).join('  '));

/* the check's first six hold at most one question that is not multiple choice */
for (const wk of weeks) for (const s of wk.steps) if (s.kind === 'check') {
  const odd = s.six.filter((id) => { const q = bank(ALL_QIDS[id]).questions.find((x) => x.id === id); return q.type !== 'mcq'; });
  if (odd.length > 1) die('W' + wk.n + ': the first six hold ' + odd.length + ' questions that are not multiple choice (' + odd.join(', ') + ')');
}
const triv = Object.keys(TRIVIA).sort();
console.log('  check pools leave out ' + triv.reduce((a, k) => a + TRIVIA[k].length, 0) + ' trivia questions' + (triv.length ? ':' : ''));
for (const k of triv) console.log('   - ' + k + ' (' + TRIVIA[k].length + '): ' + TRIVIA[k].join(' '));

/* every node accounted for */
const placed = new Set();
for (const wk of weeks) for (const s of wk.steps) {
  if (s.kind === 'ideas') { s.cards.forEach((c) => placed.add(c.id)); s.library.forEach((c) => placed.add(c.id)); s.background.forEach((c) => placed.add(c.id)); }
  if (s.kind === 'do') s.exercise.forEach((c) => placed.add(c.id));
}
const unplaced = NODES.filter((x) => !placed.has(x.id)).map((x) => x.id);
console.log('  nodes placed: ' + placed.size + ' of ' + NODES.length + (unplaced.length ? ' (missing: ' + unplaced.join(', ') + ')' : ''));
const objPlaced = new Set();
weeks.forEach((wk) => wk.steps.forEach((s) => { if (s.kind === 'play') s.objects.forEach((o) => objPlaced.add(o.id)); }));
const filmPlaced = new Set();
weeks.forEach((wk) => wk.steps.forEach((s) => { if (s.kind === 'watch') s.films.concat(s.extras).forEach((f) => filmPlaced.add(f.id)); }));
console.log('  objects placed: ' + objPlaced.size + ' of ' + objects.length + '; films placed: ' + filmPlaced.size + ' of ' + films.length);
console.log('  missions: ' + Object.keys(missionsAll).length + ' of ' + LAB.MISSIONS.length + '; size ' + (bytes / 1024).toFixed(1) + ' KB' + (bytes > MAX_BYTES ? ' (OVER the ' + (MAX_BYTES / 1024) + ' KB budget)' : ''));
if (warnings.length) { console.log('  warnings:'); warnings.forEach((w) => console.log('   - ' + w)); }

if (bytes > MAX_BYTES) die('data/paths.json would be ' + bytes + ' bytes, over the ' + MAX_BYTES + ' byte budget');
if (!CHECK_ONLY) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  if (prev === json + '\n') console.log('  data/paths.json unchanged');
  else { fs.writeFileSync(OUT, json + '\n'); console.log('  wrote data/paths.json'); }
}
