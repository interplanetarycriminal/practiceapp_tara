/* lab/ui/tools/next.js: What comes next. GPT-2's bet on the next token, the sampling dials that turn bets into text,
   a look-up for any word's probability and surprise, and generation that shows, for every token drawn, what else
   the model could have said. The dials are redone on this page from all 50,257 logits, with the same rules the
   engine's sampler uses (lab/core/host.js sample()), so what the bars show is what Write draws from. */

import { h, mount as put, fmt, tokText, debounce } from '../dom.js';
import { toolPage, field, textArea, textInput, slider, select, presets, runner, whenReady, ordinal, tk, numParam, intParam, CFG } from './kit.js';
import { engine } from '../engine.js';
import { bars, stat, tip, tipRow, seqRGB, inkOn } from '../charts.js';

const TEACH = {
  what: {
    1: `<p>GPT-2 never writes words directly. Each time, it gives every one of its 50,257 tokens a probability: its bet on
what comes next. Writing is a separate step called <b>sampling</b>: draw one token from those bets, add it to the text,
and ask again.</p>
<p>The dials change only the drawing. <b>Temperature</b> makes the draw more cautious or more adventurous; <b>top-k</b>
and <b>top-p</b> take the long tail of unlikely tokens off the table before the draw.</p>`,
    2: `<p>At the last position the model outputs 50,257 <b>logits</b>, one score per token; softmax turns them into
probabilities. Sampling is a policy over those probabilities. <b>Temperature</b> T divides every logit by T before the
softmax: T near 0 becomes greedy (always the top token), T = 1 leaves the model's own distribution, T above 1 flattens
it. <b>Top-k</b> keeps the k most likely tokens; <b>top-p</b> (nucleus sampling) keeps the smallest set of most likely
tokens whose probabilities add up to p. Each cut renormalises what is left.</p>
<div data-angle="analogy"><p>A raffle where every token holds tickets in proportion to its probability. Temperature
reprints the tickets: below 1 the favourites get an even bigger share, above 1 the outsiders catch up. Top-k and top-p
tear up everyone's tickets outside the leading group before the draw.</p></div>`,
    3: `<p>p<sub>T</sub>(i) = e<sup>z<sub>i</sub>/T</sup> / Σ<sub>j</sub> e<sup>z<sub>j</sub>/T</sup> = p(i)<sup>1/T</sup> / Σ<sub>j</sub> p(j)<sup>1/T</sup>.
The order here is Hugging Face's: temperature, then top-k, renormalise, then top-p over the renormalised distribution,
renormalise. Greedy decoding maximises each step rather than the sequence and loops easily on small models; nucleus
sampling was introduced for exactly that degeneration (Holtzman et al., 2020).</p>
<p>A library call for your whole career: <code>model.generate()</code> and Inspect's <code>generate()</code> do all of this.
What is worth owning is which dial changes what, and that temperature 0 makes an eval reproducible but not
representative of how the model is used.</p>`,
  },
  read: {
    1: `<p>Left: the model's own bets for the next token (the top dozen of 50,257). Right: the same tokens after your dials;
a gray bar marked <i>cut</i> can no longer be drawn. Look up any word to see its probability, its place in the queue,
and how surprised GPT-2 would be to see it.</p>
<p>Press <b>Write</b>: each new token is coloured by how surprising GPT-2 found it (darker = more surprising), and
hovering one shows what else it could have said.</p>`,
    2: `<p>Bars are probabilities on one shared scale, so a flat distribution looks short everywhere. "Spread" is the
entropy H in nats; e<sup>H</sup> is the number of equally likely tokens that would be just as uncertain. "Can be
drawn" counts the tokens left after the cuts. A generated token's colour is its surprise, −ln p under the model's own
distribution (not the dial-adjusted one), the same colour scale as the Surprise meter.</p>`,
    3: `<p>Surprise of a look-up is −ln p(token) in nats (÷ ln 2 for bits): exactly the cross-entropy loss GPT-2 would take if
that token came next. Rank 0 is the argmax; ranks count tokens with strictly higher logits. Multi-token words are scored
on their first token only, so " Parisian" and " Paris" share a first piece and are not distinguished.</p>`,
  },
  qwen: `<p>Qwen 3.5 9B bets over 248,320 tokens instead of 50,257, so more words are a single token and the tail
holds far more options. It is post-trained to be an assistant, so plain text often continues the way a helpful reply
would rather than the way a web page would. Its distributions are usually sharper than GPT-2's, so the same
temperature spreads them less.</p>`,
  why: {
    1: `<p>Every chatbot reply you have read came out of this loop: bet, draw, append, repeat. It explains why the same
question gets different answers, and why evaluators often set temperature to 0: a fixed answer is easier to compare,
though it is not how people use the model.</p>
<p>The same pattern returns in week 5: a reinforcement-learning policy also gives probabilities over actions, and
exploring (sampling) versus exploiting (greedy) is this same dial.</p>`,
    2: `<p>Loss during training is the surprise of the true next token, averaged (week 1); generation is this loop run
forward; RLHF (week 6) adjusts the bets so that sampled text scores well, with a KL penalty that keeps the new bets
close to these. In evals (weeks 7 and 8) temperature and top-p are part of the experimental setup: report them.</p>`,
    3: `<p>Calibration, likelihood-based monitors and "is this text from the model?" detectors all read these same
probabilities. Watch for the difference between the model's distribution and the sampling distribution when you
compute log-probs of sampled text: an RL objective needs the policy's own log-probs, not the post-dial ones.</p>`,
  },
};

const EXAMPLES = [
  { label: 'Capital of France', text: 'The capital of France is' },
  { label: 'A robot story', text: 'Once upon a time, a small robot' },
  { label: 'Code', text: 'def add(a, b):\n    return' },
  { label: 'A list', text: 'Apples, bananas, cherries, and' },
  { label: 'Sunday', text: 'My favourite way to spend a Sunday is' },
];

const TOPK = [[0, 'off'], [1, '1'], [3, '3'], [5, '5'], [10, '10'], [40, '40'], [100, '100']];
const SHOW = 12;

/* the dial-adjusted distribution, by rank: the same rules as the engine's sampler */
function adjust(st, T, K, P) {
  const { lg, order } = st, n = order.length;
  if (!(T > 0)) return { cut: 1, q: (r) => (r === 0 ? 1 : 0), H: 0 };
  const kk = K > 0 ? Math.min(K, n) : n;
  const mx = lg[order[0]], w = new Float64Array(kk);
  let Z = 0;
  for (let r = 0; r < kk; r++) { w[r] = Math.exp((lg[order[r]] - mx) / T); Z += w[r]; }
  let cut = kk;
  if (P < 1) { let c = 0; for (let r = 0; r < kk; r++) { c += w[r] / Z; if (c >= P) { cut = r + 1; break; } } }
  let Zc = 0;
  for (let r = 0; r < cut; r++) Zc += w[r];
  let H = 0;
  for (let r = 0; r < cut; r++) { const q = w[r] / Zc; if (q > 0) H -= q * Math.log(q); }
  return { cut, q: (r) => (r < cut ? w[r] / Zc : 0), H };
}

const pc = (p) => (p >= 0.995 ? (100 * p).toFixed(0) : p >= 0.1 ? (100 * p).toFixed(1) : p >= 0.001 ? (100 * p).toFixed(2) : p > 0 ? (100 * p).toPrecision(1) : '0') + '%';

export function mount(el, meta, api) {
  const P = api.params, life = { dead: false };
  const st = { text: P.text ?? 'The capital of France is', T: numParam(P.temp, 0, 2, 1), K: intParam(P.topk, 0, CFG.V, 0),
    Pp: numParam(P.topp, 0.05, 1, 1), find: P.find ?? ' Paris', len: intParam(P.n, 5, 120, 40) };
  const page = toolPage(el, meta, TEACH);
  const save = debounce(() => api.setParams({ text: st.text, temp: st.T === 1 ? null : st.T, topk: st.K || null, topp: st.Pp < 1 ? st.Pp : null, find: st.find || null }), 400);

  /* ---------------- controls */
  const count = h('span');
  const ta = textArea(st.text, { rows: 2, oninput: (e) => { st.text = e.target.value; save(); go(); } });
  const tLabel = h('span'), pLabel = h('span');
  const tSlider = slider({ min: 0, max: 2, step: 0.05, value: st.T, oninput: (e) => { st.T = Number(e.target.value); dials(); save(); } });
  const pSlider = slider({ min: 0.05, max: 1, step: 0.05, value: st.Pp, oninput: (e) => { st.Pp = Number(e.target.value); dials(); save(); } });
  const kSel = select(TOPK, TOPK.some(([v]) => v === st.K) ? st.K : 0, (v) => { st.K = Number(v); dials(); save(); });
  put(page.controls,
    field('Your text', ta, count),
    presets(EXAMPLES, (x) => { ta.value = st.text = x.text; save(); go.now(); }),
    h('div.fields.three', { style: { marginTop: '10px' } },
      field(h('span', null, 'Temperature ', tLabel), tSlider),
      field('Top-k (keep the k most likely)', kSel),
      field(h('span', null, 'Top-p ', pLabel), pSlider)));

  /* ---------------- result */
  const tiles = h('div.stats'), left = h('div'), right = h('div'), rightHead = h('div.small-caps');
  const findIn = textInput(st.find, { placeholder: 'a word, with its leading space: " Paris"', oninput: (e) => { st.find = e.target.value; save(); lookUp(); } });
  const findOut = h('div.small', { style: { minHeight: '2.6em' } });
  const gens = h('div.samples');
  const genSlot = h('div');
  const lenSel = select([[20, '20 tokens'], [40, '40 tokens'], [80, '80 tokens']], [20, 40, 80].includes(st.len) ? st.len : 40, (v) => { st.len = Number(v); });
  const write = runner('Write', genSlot, (onP, ctl) => generate(onP, ctl));
  put(page.result,
    tiles,
    h('div.split', null,
      h('div', null, h('div.small-caps', null, `${CFG.short}'s bets`), left),
      h('div', null, rightHead, right)),
    h('h3', { style: { marginTop: '16px' } }, 'Look up any next word'),
    field('Word or token', findIn), findOut,
    h('h3', { style: { marginTop: '16px' } }, 'Let it write'),
    h('div.row', null, write.btn, lenSel, h('span.muted.small', null, 'Each press draws a new sample with the dials above.')),
    genSlot, gens);

  /* ---------------- the bets */
  let cur = null;   // {lg, order, rank, lse, H, ids, pieces}
  const go = debounce(async () => {
    const text = st.text;
    if (!text.trim()) { put(left, h('p.muted', null, `Type something to see what ${CFG.short} expects next.`)); put(right); put(tiles); count.textContent = ''; return; }
    try {
      const tk0 = await engine.tok(text);
      count.textContent = `${tk0.ids.length - 1} tokens`;
      page.result.classList.add('busy');
      const r = await engine.recipe('predict', { ids: tk0.ids, k: SHOW, full: true }, { channel: 'next-predict' });
      if (life.dead || text !== st.text) return;
      const lg = r.all, n = lg.length;
      const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => lg[b] - lg[a]);
      const rank = new Int32Array(n);
      order.forEach((t, j) => { rank[t] = j; });
      let mx = lg[order[0]], Z = 0;
      for (let i = 0; i < n; i++) Z += Math.exp(lg[i] - mx);
      const lse = mx + Math.log(Z);
      let H = 0;
      for (let i = 0; i < n; i++) { const lp = lg[i] - lse, p = Math.exp(lp); if (p > 1e-12) H -= p * lp; }
      const top = order.slice(0, SHOW);
      const pieces = await engine.vocab(top);
      cur = { lg, order, rank, lse, H, top, pieces };
      dials();
      lookUp();
    } catch (e) {
      if (!/cancelled/.test(String(e && e.message))) put(left, h('p.err', null, String(e.message || e)));
    } finally { page.result.classList.remove('busy'); }
  }, 350);

  function dials() {
    tLabel.textContent = st.T === 0 ? '0 (greedy)' : String(st.T);
    pLabel.textContent = st.Pp >= 1 ? '1 (off)' : String(st.Pp);
    if (!cur) return;
    const a = adjust(cur, st.T, st.K, st.Pp);
    const p = (r) => Math.exp(cur.lg[cur.order[r]] - cur.lse);
    const max = Math.max(p(0), a.q(0));
    bars(left, { items: cur.top.map((t, r) => ({ label: tokText(cur.pieces[r]), value: p(r), title: `${ordinal(r + 1)} choice` })), max, fmtv: pc });
    bars(right, { items: cur.top.map((t, r) => {
      const q = a.q(r);
      return { label: tokText(cur.pieces[r]), value: q, color: q > 0 ? null : 'var(--ctrl)', note: q > 0 ? null : 'cut' };
    }), max, fmtv: (v) => (v > 0 ? pc(v) : '–') });
    rightHead.textContent = 'After your dials';
    let restP = 0;
    for (let r = SHOW; r < a.cut; r++) restP += a.q(r);
    put(tiles,
      stat('Top bet', tokText(cur.pieces[0]), `${pc(p(0))} of ${CFG.short}'s belief`),
      stat('Spread', `${fmt(cur.H, 2)} nats`, `like choosing among ${Math.max(1, Math.round(Math.exp(cur.H))).toLocaleString('en')} equally likely tokens`),
      stat('Can be drawn', a.cut.toLocaleString('en'), a.cut > SHOW ? `the ${(a.cut - SHOW).toLocaleString('en')} not shown hold ${pc(restP)} after the dials` : 'tokens after the cuts'));
  }

  async function lookUp() {
    const s = st.find;
    if (!cur || !s) { put(findOut); return; }
    try {
      const t = await engine.token(s);
      if (life.dead || s !== st.find || t.id === undefined) return;
      const r = cur.rank[t.id], p = Math.exp(cur.lg[t.id] - cur.lse), nats = -Math.log(p);
      const a = adjust(cur, st.T, st.K, st.Pp), q = a.q(r);
      put(findOut,
        h('div', null, tk(t.piece), ` gets ${pc(p)}: ${CFG.short}'s ${ordinal(r + 1)} choice of ${CFG.V.toLocaleString('en')}. Seeing it next would cost a surprise of `,
          h('b', null, `${fmt(nats, 2)} nats`), ` (${fmt(nats / Math.LN2, 1)} bits), which is −ln of ${pc(p)}.`,
          q > 0 ? ` After your dials it is drawn ${pc(q)} of the time.` : ' After your dials it can never be drawn.'),
        t.n > 1 ? h('div.muted', null, `"${s}" is ${t.n} tokens (${t.pieces.map((x) => JSON.stringify(x)).join(' + ')}); only the first is scored.`) : null);
    } catch (e) { put(findOut, h('span.err', null, String(e.message || e))); }
  }

  /* ---------------- writing */
  async function generate(onP, ctl) {
    const tk0 = await engine.tok(st.text);
    const T = st.T, K = st.K, Pp = st.Pp, n = st.len, seed = 1 + Math.floor(Math.random() * 2147483646);
    const out = h('div.gen');
    const head = h('div.gen-h', null, [T === 0 ? 'greedy (temperature 0)' : `temperature ${T}`, K ? `top-k ${K}` : 'top-k off', Pp < 1 ? `top-p ${Pp}` : 'top-p off', T === 0 ? null : `seed ${seed}`].filter(Boolean).join(' · '));
    out.appendChild(h('span.prompt', null, st.text));
    gens.insertBefore(h('div.sample', null, head, out), gens.firstChild);
    while (gens.children.length > 4) gens.removeChild(gens.lastChild);
    let step = 0;
    await ctl.track(engine.generate({ prompt: tk0.ids, R: 1, maxNew: n, temperature: T, topK: K, topP: Pp, seed, alts: 5 }, (pr) => {
      if (life.dead) return;
      step = pr.step + 1;
      onP(step, n, `${step} of ${n} tokens`);
      const piece = pr.pieces[0], lp = pr.logprobs[0], q = pr.q[0], alts = pr.alts[0];
      const s = -lp, rgb = seqRGB(Math.min(1, s / 10));
      const sp = h('span.tok', { style: { background: `rgb(${rgb.map((v) => v | 0).join(',')})`, color: inkOn(rgb) }, tabindex: 0 }, piece === '\n' ? '⏎\n' : piece.replace(/\n/g, '⏎\n'));
      const rk = alts.findIndex((x) => x[2] === pr.tokens[0]);
      const show = (ev) => {
        const r0 = sp.getBoundingClientRect();
        tip.show([
          h('div.tip-head', null, 'Drew ', h('span.tok-inline', null, tokText(piece))),
          tipRow(pc(Math.exp(lp)), rk >= 0 ? `${CFG.short}'s belief (its ${ordinal(rk + 1)} choice)` : `${CFG.short}'s belief (outside its top 5)`),
          tipRow(pc(q), 'chance after the dials'),
          tipRow(`${fmt(s, 1)} nats`, 'surprise'),
          h('div.tip-sub', null, 'It could have said: ' + alts.map(([a, p]) => `${tokText(a)} ${pc(p)}`).join(', ')),
        ], ev.clientX || r0.left, ev.clientY || r0.bottom);
      };
      sp.addEventListener('pointermove', show); sp.addEventListener('focus', show);
      sp.addEventListener('pointerleave', () => tip.hide()); sp.addEventListener('blur', () => tip.hide());
      out.appendChild(sp);
    }));
  }

  whenReady(page, life, () => { dials(); go.now(); });
  dials();
  return { destroy() { life.dead = true; } };
}
