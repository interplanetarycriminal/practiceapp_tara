/* lab/ui/tools/ov.js: a head's OV circuit. If head (l, h) attends to a token, what does it write, read through the
   unembedding? Copying heads raise the very token they look at (a bright diagonal); anti-copying heads lower it.
   Uses the stream after block 0 as each token's input, as the IOI paper and ARENA do (lab/core/recipes.js). */

import { h, mount as put, tokText, debounce } from '../dom.js';
import { toolPage, field, textInput, select, presets, runner, whenReady, intParam, ordinal, tk, toolLink, CFG, layerOpts, headOpts, nHeads, nearestAttn, onGPT2, whereRun, memo } from './kit.js';
import { engine } from '../engine.js';
import { grid, stat, tipRow, bars } from '../charts.js';

const TEACH = {
  what: {
    1: `<p>An attention head does two separate jobs. Where to look is one (the attention pattern). <b>What to write about
what it saw</b> is the other, and it can be studied on its own: pretend the head looks at one word, and see which
words its output makes more likely.</p>
<p>A <b>copying</b> head writes the word it looked at: look at "Mary", push "Mary". That is how GPT-2 says the right
name in "…John gave a drink to": a head looks back at Mary and copies her. Some heads do the opposite and push down
whatever they look at.</p>`,
    2: `<p>A head's output is (attention weights) × (values) × W<sub>O</sub>. Fix the attention on a single token and the
rest is a fixed linear map, the <b>OV circuit</b> W<sub>V</sub>W<sub>O</sub>, from what the head reads to what it writes. Reading
that output through the unembedding gives a score for every token. Rows here are the token the head looks at; columns
are the token whose score it changes. A bright diagonal means copying.</p>
<div data-angle="analogy"><p>A courier who carries a note from an earlier desk to the last one. The pattern says
which desk they visit; the OV circuit says what they write on the note. A copying courier writes down the name on the
desk they visited; an anti-copying courier writes "not this one".</p></div>`,
    3: `<p>Score(s → t) = u<sub>t</sub> · γ<sub>f</sub> ⊙ centre(W<sub>O</sub><sup>h</sup> W<sub>V</sub><sup>h</sup> LN<sub>1</sub>(x̃<sub>s</sub>)), where x̃<sub>s</sub> is the
"extended embedding" (the stream after block 0 for [⟨bos⟩, s]: in GPT-2 the first MLP does much of the embedding's work,
so raw W<sub>E</sub> rows are not what later heads read) and γ<sub>f</sub> is the final LayerNorm gain, divided by the σ of a
final stream of median norm (the real σ depends on the context). Columns are centred across rows, since each token has
its own baseline. The whole-vocabulary rank asks the stricter question ARENA
asks of name movers: among all 50,257 tokens, where does the attended token itself land?</p>`,
  },
  read: {
    1: `<p>Each row is a word the head looks at; each column a word it might push. Blue: pushed up. Red: pushed down. A
copying head lights up the diagonal in blue; an anti-copying head turns it red. Below, the same question for the
whole vocabulary: when the head looks at a word, which of all 50,257 tokens does it push most?</p>`,
    2: `<p>Values are in logits: roughly how far the head would move each column's token if it put all of its attention
on the row's token (real heads split their attention, so real effects are smaller). Outlined cells are the diagonal.
"Copies" counts rows whose diagonal is the largest in the row; "anti-copies" counts rows whose diagonal is the
smallest.</p>`,
    3: `<p>Switch the input to the raw embedding to see why the extended embedding is used: for the name movers the copying
pattern is much weaker on raw W<sub>E</sub> rows. Multi-token entries are scored on their first token.</p>`,
  },
  qwen: `<p>Only Qwen's 8 attention layers (3, 7, …, 31) have an OV circuit to read. A Gated DeltaNet layer has no
attention pattern, so "if it looks at this token, what does it write?" has no single answer there. Qwen's attention
also has an output gate (a sigmoid per head, set by the token doing the looking); this page takes the gate as fully
open, so read the sizes as upper bounds and the pattern, which tokens go up, as the head's tendency. Several query
heads share one value head, so heads in the same group read the same values and differ only in what they write. No
list of named heads exists for this model: scan every head below to find the copiers.</p>`,
  why: {
    1: `<p>Splitting a head into "where it looks" and "what it writes" is one of the ideas that made circuits readable at
all. It lets you say what a head does without running any text through it.</p>`,
    2: `<p>The same factorisation explains induction heads (their OV circuit copies; their QK circuit finds the right
place), negative name movers in IOI, and copy suppression (McDougall et al., 2023), where a late head pushes down
tokens that the model is about to repeat wrongly.</p>`,
    3: `<p>W<sub>OV</sub> = W<sub>V</sub>W<sub>O</sub> is rank 64 out of 768, a <code>FactoredMatrix</code> in TransformerLens; its eigenvalues
summarise copying for a whole head (positive real eigenvalues = copying), a cheaper global test than this table.
Composition scores between heads (Q-, K-, V-composition) reuse the same factorisation.</p>`,
  },
};

const HEADS_OF_NOTE = [
  { label: 'L9H9 name mover', layer: 9, head: 9 }, { label: 'L9H6 name mover', layer: 9, head: 6 }, { label: 'L10H0', layer: 10, head: 0 },
  { label: 'L10H7 negative name mover', layer: 10, head: 7 }, { label: 'L11H10 negative', layer: 11, head: 10 },
  { label: 'L5H5 induction head', layer: 5, head: 5 }, { label: 'L4H11 previous-token head', layer: 4, head: 11 },
];
const TOKEN_SETS = [
  { label: 'Names and cities', tokens: ' Mary, John, Alice, Bob, Paris, London' },
  { label: 'Animals', tokens: ' cat, dog, horse, bird, fish, cow' },
  { label: 'Numbers', tokens: ' one, two, three, four, five, six' },
  { label: 'Mixed', tokens: ' Mary, apple, Tuesday, red, London, run' },
];

export function mount(el, meta, api) {
  const P = api.params, life = { dead: false };
  const gpt2 = onGPT2(), AL = CFG.attnLayers, HC = Math.max(...AL.map((l) => nHeads(l)));
  const l0 = P.layer !== undefined ? nearestAttn(intParam(P.layer, 0, CFG.L - 1, 0)) : gpt2 ? 9 : AL[AL.length - 1];
  const st = { layer: l0, head: intParam(P.head, 0, nHeads(l0) - 1, gpt2 ? 9 : 0), tokens: P.tokens ?? TOKEN_SETS[0].tokens, embed: P.embed === 'raw' ? 'raw' : 'block0' };
  const page = toolPage(el, meta, TEACH);
  const save = debounce(() => api.setParams({ layer: st.layer, head: st.head, tokens: st.tokens, embed: st.embed === 'raw' ? 'raw' : null }), 300);
  const lSel = select(layerOpts(AL), st.layer, (v) => { st.layer = Number(v); save(); go(); });
  const hSel = select(headOpts(st.layer), st.head, (v) => { st.head = Number(v); save(); go(); });
  const pick = (l, hh) => { st.layer = l; st.head = hh; lSel.value = String(l); hSel.value = String(hh); save(); go.now(); };
  const eSel = select([['block0', 'the stream after block 0 (recommended)'], ['raw', 'the raw token embedding']], st.embed, (v) => { st.embed = v; save(); go(); });
  const tIn = textInput(st.tokens, { oninput: (e) => { st.tokens = e.target.value; save(); go(); } });
  const warn = h('span');
  put(page.controls,
    h('div.fields.three', null, field(gpt2 ? 'Layer' : 'Layer (attention layers only)', lSel), field('Head', hSel), field('Each token enters as', eSel)),
    gpt2 ? h('div.chips', { style: { marginTop: '8px' } }, h('span.muted.small', { style: { alignSelf: 'center' } }, 'Heads:'),
      HEADS_OF_NOTE.map((x) => h('button.chip', { type: 'button', onclick: () => pick(x.layer, x.head) }, x.label))) : null,
    h('div', { style: { marginTop: '10px' } }, field('Tokens, separated by commas (each is read as a word with a space before it)', tIn, warn)),
    presets(TOKEN_SETS, (x) => { tIn.value = st.tokens = x.tokens; save(); go.now(); }));

  const tiles = h('div.stats'), gridBox = h('div'), vocab = h('div');
  const scanSlot = h('div'), scanBox = h('div'), scanList = h('div');
  const scan = runner('Scan every head', scanSlot, (onP, ctl) => scanAll(onP, ctl));
  put(page.result, tiles, gridBox, h('div.subhead', null, h('h3', null, 'Across the whole vocabulary')), vocab,
    h('div.subhead', null, h('h3', null, 'Which heads copy?'), h('span.small.muted', null, `the same test on these tokens for all ${AL.reduce((a, l) => a + nHeads(l), 0)} attention heads`)),
    h('div.row', null, scan.btn, h('span.small.muted', null, gpt2 ? 'Half a minute on a processor; seconds on a graphics card.' : `Seconds ${whereRun()}.`)), scanSlot,
    h('div.res-cols', null, scanBox, scanList));

  const go = debounce(async () => {
    const words = parse(st.tokens);
    if (words.length < 2) { put(gridBox, h('p.muted', null, 'Give at least two tokens, separated by commas.')); return; }
    try {
      const toks = [];
      const multi = [];
      for (const w of words.slice(0, 16)) {
        const t = await engine.token(w);
        if (t.id === undefined) continue;
        toks.push(t);
        if (t.n > 1) multi.push(`"${w}" is ${t.n} tokens, so its first, ${JSON.stringify(t.pieces[0])}, is used`);
      }
      put(warn, multi.length ? multi.join('; ') + '.' : words.length > 16 ? 'Only the first 16 are used.' : '');
      page.result.classList.add('busy');
      const L = st.layer, Hh = st.head;
      const r = await engine.recipe('ovCircuit', { layer: L, head: Hh, tokens: toks.map((t) => t.id), embed: st.embed, k: 8 }, { channel: 'ov' });
      if (life.dead) return;
      const uniq = [...new Set(r.top.flatMap((row) => row.map(([id]) => id)))];
      const names = await engine.vocab(uniq);
      const piece = new Map(uniq.map((id, i) => [id, names[i]]));
      draw(r, toks, piece, L, Hh);
    } catch (e) {
      if (!/cancelled/.test(String(e && e.message))) put(gridBox, h('p.err', null, String(e.message || e)));
    } finally { page.result.classList.remove('busy'); }
  }, 300);

  function draw(r, toks, piece, L, Hh) {
    const n = r.n, M = r.mat;
    let max = 1e-9, copies = 0, anti = 0;
    for (let i = 0; i < n * n; i++) max = Math.max(max, Math.abs(M[i]));
    for (let j = 0; j < n; j++) {
      let hi = -Infinity, lo = Infinity;
      for (let c = 0; c < n; c++) { hi = Math.max(hi, M[j * n + c]); lo = Math.min(lo, M[j * n + c]); }
      if (M[j * n + j] === hi) copies++;
      if (M[j * n + j] === lo) anti++;
    }
    const top1 = Array.from(r.selfRank).filter((x) => x === 0).length, top10 = Array.from(r.selfRank).filter((x) => x < 10).length;
    const labels = toks.map((t) => t.piece);
    put(tiles,
      stat('Copies', `${copies} of ${n}`, 'rows whose own token is pushed most'),
      stat('Anti-copies', `${anti} of ${n}`, 'rows whose own token is pushed least'),
      stat('Own token in the top 10', `${top10} of ${n}`, `of all ${CFG.V.toLocaleString('en')} tokens (top 1 for ${top1})`));
    grid(gridBox, {
      rows: n, cols: n, cell: 76, minCell: 26, aspect: 0.6, scale: 'div', max, fmt: f1,
      value: (a, b) => M[a * n + b], text: (a, b) => f1(M[a * n + b]),
      rowLabels: labels, colLabels: labels, marks: labels.map((_, j) => [j, j]),
      loLabel: 'pushed down', hiLabel: 'pushed up',
      tip: (a, b) => [h('div.tip-head', null, `L${L}H${Hh} looking at `, h('span.tok-inline', null, tokText(labels[a]))),
        tipRow(f2(M[a * n + b]), `on ${tokText(labels[b])}, against that token's average`),
        h('div.tip-sub', null, `before centring: ${f2(r.raw[a * n + b])}`)],
      caption: `Rows: the token L${L}H${Hh} looks at. Columns: the token whose score its output changes. Outlined: the diagonal (looking at a token and pushing that same token).`,
    });
    put(vocab,
      h('p.small.muted', null, `For each looked-at token: its own place among all ${CFG.V.toLocaleString('en')} tokens, and the tokens the head pushes up most.`),
      h('div.picklist', null, labels.map((lab, j) => h('div.bar-row', null,
        h('span.bar-label', null, tokText(lab)),
        h('span', { style: { flex: '0 0 auto', minWidth: '96px' } }, r.selfRank[j] === 0 ? h('b', null, '1st') : ordinal(r.selfRank[j] + 1)),
        h('span.small', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.top[j].map(([id]) => tokText(piece.get(id))).join('  '))))),
      h('p.small.muted', null, 'To see where it looks on a real sentence, ', toolLink('attention', { text: 'When Mary and John went to the store, John gave a drink to', layer: L, head: Hh }, `open L${L}H${Hh} in Attention patterns`), '.'));
  }

  /* ---------------- every head at once: how often each one pushes the very token it looks at */
  async function tokenIds() {
    const out = [];
    for (const w of parse(st.tokens).slice(0, 16)) { const t = await engine.token(w); if (t.id !== undefined) out.push(t); }
    return out;
  }

  async function scanAll(onP, ctl) {
    const toks = await tokenIds();
    if (toks.length < 2) throw new Error('Give at least two tokens, separated by commas.');
    const ids = toks.map((t) => t.id), key = ['ov-scan', st.embed, ids.join(',')].join('|');
    let res = memo.get(key);
    if (!res) {
      const heads = AL.flatMap((l) => [...Array(nHeads(l)).keys()].map((hh) => [l, hh]));
      const rows = [];
      for (let q = 0; q < heads.length; q++) {
        const [l, hh] = heads[q];
        onP(q, heads.length, `L${l}H${hh}: ${q + 1} of ${heads.length} heads`);
        const r = await ctl.track(engine.recipe('ovCircuit', { layer: l, head: hh, tokens: ids, embed: st.embed, k: 1 }));
        if (life.dead || ctl.cancelled) return;
        rows.push({ l, hh, ...copyScore(r) });
      }
      res = { rows, n: ids.length };
      memo.set(key, res);
    }
    drawScan(res);
  }

  function drawScan({ rows, n }) {
    const at = new Map(rows.map((x) => [`${x.l}/${x.hh}`, x]));
    grid(scanBox, {
      rows: AL.length, cols: HC, cell: 40, minCell: 22, aspect: 0.75, scale: 'div', max: 1, fmt: (v) => fmt1(v),
      value: (r, hh) => { const x = at.get(`${AL[r]}/${hh}`); return x ? x.score : NaN; },
      text: (r, hh) => { const x = at.get(`${AL[r]}/${hh}`); return x && Math.abs(x.score) >= 0.5 ? String(Math.round(100 * x.score)) : ''; },
      rowLabels: AL.map((l) => 'L' + l), colLabels: [...Array(HC).keys()].map((x) => 'H' + x),
      loLabel: 'pushes it down', hiLabel: 'copies', midLabel: '(gray = neither)',
      tip: (r, hh) => { const x = at.get(`${AL[r]}/${hh}`); return x ? [h('div.tip-head', null, `L${AL[r]}H${hh}`), tipRow(`${x.copies} of ${n}`, 'rows it copies'), tipRow(`${x.anti} of ${n}`, 'rows it pushes down'), tipRow(`${x.top10} of ${n}`, 'own token in its top 10 of the vocabulary')] : null; },
      onPick: (r, hh) => pick(AL[r], hh),
      caption: 'Each cell: (rows it copies − rows it pushes down) ÷ rows, on the tokens above. Blue heads copy what they look at; red heads push it down. Tap one to open it.',
    });
    const order = rows.slice().sort((u, v) => v.score - u.score || v.top10 - u.top10);
    bars(scanList, { items: order.slice(0, 8).map((x) => ({ label: `L${x.l}H${x.hh}`, value: x.score, note: `own token in its top 10 for ${x.top10} of ${n}`, onClick: () => pick(x.l, x.hh) })),
      signed: true, max: 1, fmtv: (v) => fmt1(v), caption: 'The strongest copiers. A head that copies here is a candidate name mover or induction head: check where it looks before calling it one.' });
  }

  whenReady(page, life, () => go.now());
  return { destroy() { life.dead = true; } };
}

/* a head's copying on a token set: rows whose own token is pushed most (copies) or least (anti), and how many keep
   their own token in the head's top 10 of the whole vocabulary */
function copyScore(r) {
  const n = r.n, M = r.mat;
  let copies = 0, anti = 0;
  for (let j = 0; j < n; j++) {
    let hi = -Infinity, lo = Infinity;
    for (let c = 0; c < n; c++) { hi = Math.max(hi, M[j * n + c]); lo = Math.min(lo, M[j * n + c]); }
    if (M[j * n + j] === hi) copies++;
    if (M[j * n + j] === lo) anti++;
  }
  const top10 = Array.from(r.selfRank).filter((x) => x < 10).length;
  return { copies, anti, top10, score: (copies - anti) / n };
}

const fmt1 = (v) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(2);

const f1 = (v) => (Math.abs(v) < 0.05 ? '0.0' : (v < 0 ? '−' : '') + Math.abs(v).toFixed(1));
const f2 = (v) => (v < 0 ? '−' : '+') + Math.abs(v).toFixed(2);

/* " Mary, John,Alice" -> [" Mary", " John", " Alice"]: entries keep one leading space (added when missing) */
function parse(s) {
  return String(s || '').split(',').map((x) => x.replace(/^\s+/, '')).filter(Boolean).map((x) => ' ' + x.replace(/\s+$/, ''));
}
