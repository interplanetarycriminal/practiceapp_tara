/* lab/ui/app.js: the lab's shell. Hash routes:
     #today                      this week's mission, the newest results, the river map
     #tools  #tool/<id>?...      the live GPT-2 tools (parameters ride in the URL, so a mission is a link)
     #results  #results/<id>     result packs from the bench (lab/findings)
     #missions  #missions/week-N
     #about                      what the lab is, how the halves fit, credits */

import { h, mount, clear, parseHash, hashFor, rescan, store, tiers } from './dom.js';
import { engineChip, engine } from './engine.js';
import { TOOLS, toolById, nodeIndex } from './tools/index.js';
import { cancelAll } from './tools/kit.js';
import { MISSIONS, WEEKS, weekNow, missionsFor } from './missions.js';
import { riverMap } from './river.js';
import { loadIndex, resultCard, resultsView, resultView } from './results.js';
import { aboutView, RIVER_TEACH } from './about.js';

const view = document.getElementById('view');
let active = null;   // {destroy} of the mounted view
let lastKey = '';

function setTabs(name) {
  for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-current', t.dataset.view === name ? 'page' : 'false');
}

async function route() {
  const r = parseHash();
  const tab = { tool: 'tools', results: 'results' }[r.view] || r.view;
  setTabs(tab);
  const key = r.view + '/' + r.parts.join('/');
  if (key === lastKey && r.view === 'tool' && active && active.update) { active.update(r.params); return; }
  if (active && active.destroy) { try { active.destroy(); } catch (e) { /* */ } }
  cancelAll();
  active = null;
  if (key !== lastKey) window.scrollTo(0, 0);
  lastKey = key;
  clear(view);
  try {
    if (r.view === 'today') await today();
    else if (r.view === 'tools') toolsView();
    else if (r.view === 'tool') await toolView(r.parts[0], r.params);
    else if (r.view === 'results' && r.parts[0]) active = await resultView(view, r.parts[0]);
    else if (r.view === 'results') await resultsView(view);
    else if (r.view === 'missions') missionsView(r.parts[0]);
    else if (r.view === 'about') aboutView(view);
    else { location.hash = '#today'; return; }
  } catch (e) {
    console.error(e);
    mount(view, h('div.wrap', null, h('h2', null, 'Something went wrong'), h('p.err', null, String(e && e.message || e)),
      h('a.btn', { href: '#today' }, 'Back to the start')));
  }
  rescan(view);
  document.title = (document.querySelector('#view h1') || {}).textContent ? `${document.querySelector('#view h1').textContent} · The Lab` : 'The Lab · TARA';
  routed++;
  window.__lab = { routed, key, engine };
  dispatchEvent(new CustomEvent('lab:routed', { detail: key }));
}
let routed = 0;

/* ---------------------------------------------------------------- today */

async function today() {
  const w = weekNow();
  const wk = WEEKS[w];
  const ms = missionsFor(w);
  const res = h('div.grid3');
  const wrap = h('div.wrap', null,
    h('h1', null, h('span.tape', null, 'The Lab')),
    h('p.lede', null, 'A real language model you can take apart in your browser, and results from bigger models run on the 3090. Every number on these pages was computed; none was drawn by hand.'),
    h('div.spread', null, h('h2', null, `This week · W${w} · ${wk.title}`), h('a.small', { href: `#missions/week-${w}` }, `All week ${w} missions →`)),
    ms.length ? h('div.grid2', null, ms.slice(0, 2).map((m) => missionCard(m))) : h('p.muted', null, 'No mission this week.'),
    h('div.spread', null, h('h2', null, 'Latest results'), h('a.small', { href: '#results' }, 'All results →')),
    res,
    h('div.spread', null, h('h2', null, 'The river map'), h('a.small', { href: '#tools' }, 'All tools →')),
    riverBlock());
  view.appendChild(wrap);
  const idx = await loadIndex();
  if (!idx.packs.length) mount(res, h('p.muted', null, 'No results yet. They land here when the bench runs.'));
  else mount(res, ...idx.packs.slice(0, 3).map((p) => resultCard(p)));
}

function riverBlock() {
  return h('div.split', null,
    h('div.card', null, riverMap()),
    h('div', null, tiers('river', RIVER_TEACH),
      h('p.small.muted', null, 'Tap a pin to open that tool. Each one runs GPT-2 small on this device.')));
}

/* ---------------------------------------------------------------- tools */

function toolsView() {
  view.appendChild(h('div.wrap', null,
    h('h1', null, 'Tools'),
    h('p.lede', null, 'Twelve instruments for GPT-2 small, each pinned where it looks inside the model. They run on this device after one 133 MB download.'),
    riverBlock(),
    h('h2', null, 'Every tool'),
    h('div.grid3', null, TOOLS.map((t) => h('a.card.toolcard', { href: `#tool/${t.id}` },
      h('h3', null, t.name), h('p', null, t.blurb),
      h('div.meta', null, ...t.weeks.map((w) => h('span.week', null, 'W' + w)), h('span.muted.small', null, t.cost)))))));
}

async function toolView(id, params) {
  const t = toolById(id);
  if (!t) { location.hash = '#tools'; return; }
  const el = h('div.wrap');
  view.appendChild(el);
  const mod = await t.load();
  const api = {
    params,
    setParams(p) {
      const cur = parseHash();
      const next = { ...cur.params, ...p };
      for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === null || next[k] === '') delete next[k];
      history.replaceState(null, '', hashFor('tool', [id], next));
    },
  };
  active = (await mod.mount(el, t, api)) || null;
}

/* ---------------------------------------------------------------- missions */

function missionCard(m) {
  const done = store.get('tara.lab.done', {});
  const href = m.tool ? hashFor('tool', [m.tool], m.params || {}) : m.result ? `#results/${m.result}` : '#about';
  const box = h('input', { type: 'checkbox' });
  box.checked = !!done[m.id];
  const card = h('div.card.mission' + (box.checked ? '.is-done' : ''), null,
    h('span.label', null, `W${m.week} mission`),
    h('h3', null, m.title),
    h('p', null, m.why),
    h('ol', null, m.steps.map((s) => h('li', null, s))),
    h('details.reveal', null, h('summary', null, 'What you should see (guess first)'), h('p', null, m.look)),
    h('div.row', null,
      h('a.btn.accent', { href }, m.tool ? 'Open the tool' : m.result ? 'Open the result' : 'How to run the bench'),
      m.tool && m.result ? h('a.btn.ghost', { href: `#results/${m.result}` }, m.resultLabel || 'The bench result') : null,
      (m.more || []).map(([id, label]) => h('a.btn.ghost', { href: `#results/${id}` }, label)),
      h('label.done-box', null, box, 'Done')),
    m.nodes && m.nodes.length ? h('div.links', null) : null);
  box.addEventListener('change', () => {
    const d = store.get('tara.lab.done', {});
    if (box.checked) d[m.id] = true; else delete d[m.id];
    store.set('tara.lab.done', d);
    card.classList.toggle('is-done', box.checked);
  });
  if (m.nodes && m.nodes.length) nodeIndex().then((N) => {
    const links = card.querySelector('.links');
    for (const id of m.nodes) if (N[id]) links.appendChild(h('a', { href: `../index.html#map/node=${encodeURIComponent(id)}` }, N[id].label));
    const f = m.nodes.map((id) => N[id]).find((n) => n && n.film);
    if (f) links.appendChild(h('a', { href: '../intuition/' + f.film }, '▶ film'));
  });
  return card;
}

function missionsView(part) {
  const now = weekNow();
  const m = /^week-(\d{1,2})$/.exec(part || '');
  const w = m ? Math.max(0, Math.min(14, Number(m[1]))) : now;
  const done = store.get('tara.lab.done', {});
  const total = MISSIONS.length, doneN = MISSIONS.filter((x) => done[x.id]).length;
  view.appendChild(h('div.wrap', null,
    h('h1', null, 'Missions'),
    h('p.lede', null, `One question each, answered in a few minutes with a tool or a result. Guess first, then look. ${doneN} of ${total} done.`),
    h('nav.weekstrip', { 'aria-label': 'TARA weeks' }, WEEKS.map((wk) => h('a', {
      href: `#missions/week-${wk.n}`, 'aria-current': wk.n === w ? 'true' : 'false', class: wk.n === now ? 'now' : null,
      title: `Week ${wk.n}: ${wk.title}${wk.n === now ? ' (this week)' : ''}` }, 'W' + wk.n))),
    h('h2', null, `Week ${w} · ${WEEKS[w].title}`),
    h('p.muted', null, WEEKS[w].topic + (w === now ? ' · this week' : '')),
    h('div.grid2', null, missionsFor(w).map(missionCard))));
}

/* ---------------------------------------------------------------- start */

engineChip(document.getElementById('engine-chip'));
addEventListener('hashchange', route);
route();
