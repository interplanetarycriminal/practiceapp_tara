/* lab/ui/results.js: the bench's results. A list of every pack (lab/findings/index.json), the experiments still
   waiting for the 3090 (lab/bench/specs/index.json), and one page per result, drawn by the viewer for its kind. */

import { h, mount, rescan } from './dom.js';
import { KINDS, kindOf, loadPack, header, ledger, howMade, stamp, when } from './viewers/common.js';
import { MISSIONS } from './missions.js';

let INDEX = null, QUEUE = null;

export async function loadIndex() {
  if (INDEX) return INDEX;
  try {
    const r = await fetch('findings/index.json', { cache: 'no-cache' });
    INDEX = r.ok ? await r.json() : { packs: [] };
  } catch (e) { INDEX = { packs: [] }; }
  if (!Array.isArray(INDEX.packs)) INDEX.packs = [];
  return INDEX;
}

async function loadQueue() {
  if (QUEUE) return QUEUE;
  try {
    const r = await fetch('bench/specs/index.json', { cache: 'no-cache' });
    QUEUE = r.ok ? (await r.json()).specs || [] : [];
  } catch (e) { QUEUE = []; }
  return QUEUE;
}

/* a result in a list: its kind, title, question, headline and the stamps of its claims */
export function resultCard(p) {
  const k = kindOf(p.kind);
  const counts = {};
  for (const c of p.claims || []) counts[c.status] = (counts[c.status] || 0) + 1;
  return h(`a.card.res-card.band-${p.kind}`, { href: `#results/${encodeURIComponent(p.id)}` },
    h('span.label', null, k.name),
    h('h3', null, p.title || p.id),
    h('p.q', null, p.question),
    p.headline ? h('div.head', null, p.headline) : null,
    h('div.stamps', null, ['supported', 'weak', 'not-supported'].filter((s) => counts[s]).map((s) => stamp(s, counts[s] > 1 ? ` ×${counts[s]}` : ''))),
    h('div.small.muted', { style: { marginTop: '8px' } }, [(p.models || []).join(' versus '), when(p.created)].filter(Boolean).join(' · ')));
}

function queuedCard(s) {
  const k = kindOf(s.engine);
  return h(`a.card.flat.res-card.pending.band-${s.engine}`, { href: `#results/${encodeURIComponent(s.id)}` },
    h('span.label', null, k.name),
    h('h3', null, s.title || s.id),
    h('p.q', null, s.question),
    h('div.small.muted', null, ['not run yet', (s.models || []).join(' versus ')].filter(Boolean).join(' · ')));
}

export async function resultsView(view) {
  const [idx, queue] = await Promise.all([loadIndex(), loadQueue()]);
  const have = new Set(idx.packs.map((p) => p.id));
  const waiting = queue.filter((s) => !have.has(s.id));
  const kinds = [...new Set(idx.packs.map((p) => p.kind))];
  const grid = h('div.grid3');
  const chips = h('div.chips', { role: 'group', 'aria-label': 'Kind of result' });
  let only = null;
  const draw = () => {
    const list = idx.packs.filter((p) => !only || p.kind === only);
    mount(grid, list.length ? list.map(resultCard) : h('p.muted', null, 'No results of this kind yet.'));
    rescan(grid);
  };
  for (const k of [null, ...kinds]) {
    const b = h('button.chip', { type: 'button', 'aria-pressed': String(k === only) }, k ? kindOf(k).name : 'All');
    b.addEventListener('click', () => { only = k; for (const x of chips.children) x.setAttribute('aria-pressed', String(x === b)); draw(); });
    chips.appendChild(b);
  }
  view.appendChild(h('div.wrap', null,
    h('h1', null, 'Results'),
    h('p.lede', null, 'Experiments run by the research bench, each with its question, its control and a claim ledger. The GPT-2 results were computed for real before this page was written; the Qwen 3.5 ones land here after a run on the 3090.'),
    kinds.length > 1 ? chips : null,
    grid,
    waiting.length ? h('div', null,
      h('h2', null, `Waiting for the 3090 (${waiting.length})`),
      h('p.muted', null, 'Written, checked on a tiny model, and ready to run. Each page says what it will measure and how to start it.'),
      h('div.grid3', null, waiting.map(queuedCard))) : null,
    h('h2', null, 'What each kind of result asks'),
    h('div.grid2', null, Object.entries(KINDS).map(([id, k]) => h('div.card.flat', null,
      h('h3', null, k.name), h('p', null, k.asks), h('p.small.muted', null, 'Control: ' + k.control))))));
  draw();
}

/* one result; when it has not been run yet, its spec instead */
export async function resultView(view, id) {
  const idx = await loadIndex();
  const p = idx.packs.some((x) => x.id === id) ? await loadPack(id) : null;
  if (!p) { await pendingView(view, id); return null; }
  const wrap = h('div.wrap.result-page');
  view.appendChild(wrap);
  const body = h('div.res-body', null, h('p.muted', null, 'Drawing…'));
  wrap.appendChild(header(p));
  wrap.appendChild(ledger(p));
  wrap.appendChild(body);
  wrap.appendChild(related(id));
  wrap.appendChild(howMade(p));
  if (!KINDS[p.kind]) { mount(body, h('p.muted', null, `No viewer for "${p.kind}" results yet; the claims and settings above are complete.`)); return null; }
  try {
    const mod = await import(`./viewers/${p.kind}.js`);
    await mod.render(body, p);
  } catch (e) {
    console.error(e);
    mount(body, h('p.err', null, `The charts did not draw: ${e.message || e}`));
  }
  rescan(wrap);
  return null;
}

const usesResult = (id) => (m) => m.result === id || (m.more || []).some(([r]) => r === id);

function related(id) {
  const ms = MISSIONS.filter(usesResult(id));
  if (!ms.length) return h('div');
  return h('section', null, h('h2', null, 'Missions that use this result'),
    h('ul', null, ms.map((m) => h('li', null, h('a', { href: `#missions/week-${m.week}` }, `Week ${m.week}: ${m.title}`)))));
}

async function pendingView(view, id) {
  let spec = null;
  try { const r = await fetch(`bench/specs/${encodeURIComponent(id)}.json`, { cache: 'no-cache' }); if (r.ok) spec = await r.json(); } catch (e) { /* */ }
  const wrap = h('div.wrap.result-page');
  view.appendChild(wrap);
  if (!spec) {
    mount(wrap, h('h1', null, 'No such result'), h('p', null, `There is no result or experiment called "${id}".`), h('a.btn', { href: '#results' }, 'All results'));
    return;
  }
  const k = kindOf(spec.engine);
  const kv = [];
  const add = (a, b) => { if (b !== undefined && b !== null && b !== '') kv.push(h('dt', null, a), h('dd', null, typeof b === 'object' ? JSON.stringify(b) : String(b))); };
  add('Kind', `${k.name}: ${k.asks}`);
  add('Model', spec.model || spec.hf_model || (spec.a && `${spec.a} versus ${spec.b}`));
  add('Control', k.control);
  add('Layers', spec.layers || (spec.direction && spec.direction.layer));
  add('Doses', spec.doses && spec.doses.join(', '));
  add('Data', spec.dataset || spec.pairs || spec.prompts && (Array.isArray(spec.prompts) ? `${spec.prompts.length} prompts` : spec.prompts) || spec.corpus && spec.corpus.source);
  add('Dictionary', spec.dictionary && (spec.dictionary.repo || spec.dictionary));
  add('Transcoders', spec.transcoders);
  const ms = MISSIONS.filter(usesResult(id));
  mount(wrap,
    h('div.row', null, h('a.small.muted', { href: '#results' }, '← All results'), h('span.pill', null, k.name), h('span.pill', null, 'not run yet')),
    h('h1', null, spec.title || id),
    h('p.lede', null, spec.question),
    h('div.callout', null, h('b.k', null, 'Waiting for the 3090'),
      h('p', null, 'This experiment is written and was checked end to end on a tiny model. It needs a real GPU to run; when the bench runs it and the result is committed, this page turns into the result, with its charts and claim ledger.')),
    h('h2', null, 'What it will do'),
    h('dl.kv', null, kv),
    ms.length ? h('div', null, h('h2', null, 'Missions waiting on it'), h('ul', null, ms.map((m) => h('li', null, h('a', { href: `#missions/week-${m.week}` }, `Week ${m.week}: ${m.title}`))))) : null,
    h('h2', null, 'How to run it'),
    h('p', null, 'On the PC, from the bench folder (smoke version first, minutes; then the real run):'),
    h('pre.spec', null, `python run.py specs/${id}.json --smoke --lock Z:\\tara-lab\\gpulock.py\npython run.py specs/${id}.json --lock Z:\\tara-lab\\gpulock.py`),
    h('details.more', null, h('summary', null, 'The spec'), h('pre.spec', null, JSON.stringify(spec, null, 2))));
}
