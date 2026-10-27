/* lab/ui/engine.js: the model every tool runs on, and the picker in the header that chooses it.

   Two engines behind one facade:
     GPT-2 small, in this browser (core/client.js). The weights are 133 MB, so nothing downloads until the reader says
       so; then they live in the browser's cache storage and the lab works offline.
     Qwen 3.5 9B, on the PC's 3090 (core/remote.js), through the live lab server (lab/bench/serve.py) on this computer.
       The page asks the server only once the reader has picked it, so a phone never pings its own localhost.

   CFG is the chosen model's shape. Tools read it when they mount, and the page re-mounts the open tool on a switch
   ('lab:model'), so nothing ever mixes the two models' numbers. */

import { lab } from '../core/client.js';
import { RemoteClient, LIVE_URL } from '../core/remote.js';
import { h, mount, bytes, store } from './dom.js';

const range = (n) => [...Array(n).keys()];

export const GPT2 = {
  id: 'gpt2', name: 'GPT-2 small', short: 'GPT-2', where: 'browser', place: 'in this browser',
  blurb: '124 million parameters, 12 layers of 12 attention heads. One 133 MB download, then it works offline.',
  L: 12, H: 12, D: 768, M: 3072, V: 50257, heads: Array(12).fill(12), dh: Array(12).fill(64),
  kinds: Array(12).fill('attention'), attnLayers: range(12), act: 'gelu', norm: 'layer', bos: 50256,
};

const kinds9 = range(32).map((l) => (l % 4 === 3 ? 'attention' : 'linear'));
export const QWEN9 = {
  id: 'qwen3.5-9b', name: 'Qwen 3.5 9B', short: 'Qwen 9B', where: '3090', place: "on your PC's 3090",
  blurb: '9 billion parameters, 32 layers: 8 of attention, 24 of Gated DeltaNet. Held in 4-bit by the lab server on the PC.',
  L: 32, H: 32, D: 4096, M: 12288, V: 248320, heads: kinds9.map((k) => (k === 'attention' ? 16 : 32)),
  dh: kinds9.map((k) => (k === 'attention' ? 256 : 128)), kinds: kinds9, attnLayers: range(32).filter((l) => l % 4 === 3),
  act: 'swiglu', norm: 'rms', bos: null,
};

export const MODELS = [GPT2, QWEN9];
const byId = (id) => MODELS.find((m) => m.id === id);

/* the chosen model's shape, filled in from the server once it answers */
export const CFG = { ...GPT2 };

const remotes = new Map();
const listeners = new Set();
let active = lab, offActive = null, booted = null, loading = null;
const tokCache = new Map();

/* lab/checks point the 3090 entry at a test server: localStorage 'tara.lab.dev' = {"url": ..., "model": "tiny-qwen3.5"} */
const DEV = store.get('tara.lab.dev', null);

function remoteFor(id) {
  let c = remotes.get(id);
  if (!c) { c = new RemoteClient((DEV && DEV.model) || id, (DEV && DEV.url) || LIVE_URL); remotes.set(id, c); }
  return c;
}

/* fold the server's word on the shape into CFG (only fields it knows; the static ones stay otherwise) */
function absorbShape(s) {
  if (!s || CFG.where === 'browser') return;
  for (const k of ['L', 'H', 'D', 'M', 'V', 'heads', 'dh', 'kinds', 'attnLayers', 'bos', 'residNorm']) if (s[k] !== undefined && s[k] !== null) CFG[k] = s[k];
}

function attach(client) {
  if (offActive) offActive();
  offActive = client.on((s) => {
    if (s.cfg) absorbShape(s.cfg);
    for (const fn of listeners) { try { fn(s); } catch (e) { console.error(e); } }
  });
}

function choose(id) {
  const meta = byId(id) || GPT2;
  for (const k of Object.keys(CFG)) delete CFG[k];
  Object.assign(CFG, meta);
  active = meta.where === 'browser' ? lab : remoteFor(meta.id);
  tokCache.clear();
  attach(active);
}

export const engine = {
  get lab() { return active; },
  get status() { return active.status; },
  get model() { return CFG.id; },
  get remote() { return CFG.where !== 'browser'; },
  on(fn) { listeners.add(fn); fn(active.status); return () => listeners.delete(fn); },
  ready() { return active.status.state === 'ready'; },

  boot() {
    if (engine.remote) return active.boot();
    if (!booted) booted = lab.boot({ engine: store.get('tara.lab.engine', 'auto') }).catch((e) => { booted = null; throw e; });
    return booted;
  },

  /* GPT-2: load without downloading when the weights are already here. The 3090: ask the server what it holds. */
  async warm() {
    const p = await this.boot();
    if (!engine.remote && p.cached && !loading) loading = lab.load({ allowDownload: false }).catch((e) => { loading = null; throw e; });
    return p;
  },

  async load() {
    if (engine.remote) return active.load();
    await this.boot();
    if (!loading || lab.status.state === 'needs-download') loading = lab.load({ allowDownload: true }).catch((e) => { loading = null; throw e; });
    return loading;
  },

  /* text -> {ids, pieces}; ids start with <|endoftext|> like TransformerLens' prompts */
  async tok(text, bos = true) {
    const key = (bos ? '1' : '0') + text, client = active;
    if (tokCache.has(key)) return tokCache.get(key);
    const r = await client.call('tokenize', { text, bos });
    if (client !== active) throw new Error('cancelled');
    if (tokCache.size > 400) tokCache.clear();
    tokCache.set(key, r);
    return r;
  },

  /* the first token of a string such as " Mary" (no <|endoftext|>), with a warning when it is more than one token */
  async token(s) {
    const r = await this.tok(s, false);
    return { id: r.ids[0], piece: r.pieces[0], whole: r.ids.length === 1, n: r.ids.length, pieces: r.pieces };
  },

  async vocab(ids) { return (await active.call('vocab', { ids: Array.from(ids) })).vocab; },
  recipe(name, args, opts) { return active.recipe(name, args, opts); },
  generate(args, onTok, opts) { return active.generate(args, onTok, opts); },
  forget() { return engine.remote ? active.release() : lab.call('forget'); },

  /* switch the model every tool runs on; the open tool re-mounts */
  use(id) {
    if (id === CFG.id || !byId(id)) return;
    store.set('tara.lab.model', id);
    choose(id);
    if (engine.remote) active.boot().catch(() => {});
    dispatchEvent(new CustomEvent('lab:model', { detail: id }));
  },

  /* ask the server again (after starting it, or when the tab comes back) */
  recheck() { return engine.remote ? active.refresh() : Promise.resolve(null); },
};

choose(store.get('tara.lab.model', 'gpt2'));
if (engine.remote) active.boot().catch(() => {});

/* While Qwen is picked and the tab is open, a light look at the server every minute keeps the header honest when the
   server lets the model go after its idle time (and notices a server started after the page). */
setInterval(() => { if (engine.remote && document.visibilityState === 'visible' && !['loading', 'waiting'].includes(active.status.state)) active.refresh().catch(() => {}); }, 60000);
document.addEventListener('visibilitychange', () => { if (engine.remote && document.visibilityState === 'visible') active.refresh().catch(() => {}); });

export const isGPU = () => engine.remote || lab.status.engine === 'webgpu';

/* one line on where the engine is, for the header and for a run that waits */
export function statusLine(s = active.status) { return engine.remote ? remoteLine(s, CFG.short) : browserLine(s); }

function remoteLine(s, n) {
  return {
    connecting: `${n}: connecting…`, offline: `${n}: server not running`, idle: `${n}: asleep on the 3090`,
    loading: `${n}: loading ${s.elapsed ? s.elapsed + ' s' : '…'}`, waiting: `${n}: waiting for the card`,
    ready: `${n} ready · 3090`, error: `${n}: error`,
  }[s.state] || n;
}

function browserLine(s) {
  return {
    idle: 'GPT-2: not started', 'needs-download': 'GPT-2: not downloaded', downloading: `GPT-2: downloading ${s.total ? Math.round(100 * (s.loaded || 0) / s.total) : 0}%`,
    loading: 'GPT-2: loading', building: 'GPT-2: unpacking', gpu: 'GPT-2: starting GPU',
    ready: s.engine === 'webgpu' ? 'GPT-2 ready · GPU' : 'GPT-2 ready · CPU', error: 'GPT-2: error',
  }[s.state] || 'GPT-2';
}

/* what a run that is waiting for the model tells the reader */
export function waitLine(s = active.status) {
  if (engine.remote) {
    if (s.state === 'offline' || s.state === 'connecting') return `Waiting for the lab server on this computer; this run starts once ${CFG.name} answers.`;
    if (s.state === 'waiting') return s.note || 'Waiting for the graphics card: another job is using it. This run starts by itself.';
    if (s.state === 'loading') return `${CFG.name} is loading onto the 3090 (${s.elapsed || 0} s of about ${s.expect || 90} s); this run starts by itself.`;
    return `Waiting for ${CFG.name}; this run starts by itself.`;
  }
  return s.state === 'needs-download' || s.state === 'idle'
    ? 'Waiting for GPT-2: press Download and start above, and this run begins once it has loaded.'
    : 'Waiting for GPT-2 to finish loading; this run starts by itself.';
}

/* ---------------------------------------------------------------- the engine card */

const SERVER_HELP = () => h('details.more', null, h('summary', null, 'How the lab server works'),
  h('p.small', null, `${CFG.name} is too big for a browser, so a small server on the PC holds it on the 3090 and answers this page at ${LIVE_URL}. `,
    'It uses no graphics memory until a tool asks for the model, takes turns with ComfyUI through the studio\'s GPU lock, and hands the card back after 20 minutes without requests.'),
  h('p.small', null, 'To start it by hand, run ', h('code', null, 'lab\\bench\\serve.py'), ' from the practiceapp_tara folder with the lab\'s Python on Z: (the command is at the top of that file).'),
  h('p.small', null, 'If Chrome or Edge asks whether this site may connect to apps or devices on this computer, choose Allow: that is how the page reaches the server. It only works on the PC itself; on a phone, use GPT-2.'));

function remoteCard(el, s, compact, retry) {
  const n = CFG.name;
  const gpt2 = h('button.btn.ghost', { type: 'button', onclick: () => engine.use('gpt2') }, 'Use GPT-2 in this browser');
  if (s.state === 'connecting') {
    mount(el, h('div.engine-card', null, h('div.engine-title', null, `Connecting to ${n} on your PC…`), h('div.progress.indeterminate', null, h('span')),
      s.note ? h('div.muted.small', null, s.note) : null));
  } else if (s.state === 'offline') {
    mount(el, h('div.engine-card', null,
      h('div.engine-title', null, `${n} runs on your PC's 3090, and this page can't reach it`),
      compact ? null : h('p', null, 'The lab server on this computer is not answering. Open the Lab on the PC with the 3090, check the server is running there, then check again. Everything else in the Lab works on GPT-2 here.'),
      h('div.row', null, h('button.btn.primary', { type: 'button', onclick: retry }, 'Check again'), gpt2),
      compact ? null : SERVER_HELP()));
  } else if (s.state === 'loading') {
    const frac = s.expect ? Math.min(0.97, (s.elapsed || 0) / s.expect) : 0;
    const what = s.phase === 'starting' ? 'Starting the lab server\'s graphics card process' : s.phase === 'measuring' ? 'Measuring the stream\'s typical size (once)' : `Loading ${n} onto the 3090`;
    mount(el, h('div.engine-card', null,
      h('div.engine-title', null, what),
      h('div.progress', null, h('span', { style: { width: Math.round(frac * 100) + '%' } })),
      h('div.muted.small', null, `${s.elapsed || 0} s of about ${s.expect || 90} s. ${(s.elapsed || 0) > (s.expect || 90) ? 'Taking longer than usual; the first load after the PC starts reads 7 GB from Z:.' : 'It stays loaded while you work and leaves the card after 20 idle minutes.'}`)));
  } else if (s.state === 'waiting') {
    mount(el, h('div.engine-card', null, h('div.engine-title', null, 'Waiting for the graphics card'),
      h('p', null, s.note || 'Another job is using the 3090 (a ComfyUI render, say). This starts by itself once it is free.'),
      h('div.progress.indeterminate', null, h('span'))));
  } else if (s.state === 'error') {
    mount(el, h('div.engine-card.err', null, h('div.engine-title', null, `${n} did not start`),
      h('p', null, s.error || 'Unknown error'),
      h('div.row', null, h('button.btn', { type: 'button', onclick: retry }, 'Try again'), gpt2)));
  } else {
    mount(el, h('div.engine-card', null, h('div.engine-title', null, `Waking ${n} on your 3090…`),
      h('div.progress.indeterminate', null, h('span'))));
  }
}

/* Mounts a card into el that tracks the engine; resolves once the model is ready. Tools await it before running. */
export function needModel(el, { compact = false } = {}) {
  return new Promise((resolve) => {
    if (active.status.state === 'ready') { mount(el); el.hidden = true; resolve(active.status); return; }
    let off = null, done = false;
    const remote = engine.remote, client = active;
    const wake = () => { if (client === active) engine.load().catch(() => {}); };
    const retry = () => { client.boot().then(() => { if (client.status.state === 'idle') wake(); }, () => {}); };
    const render = (s) => {
      if (done || client !== active) return;
      if (s.state === 'ready') { done = true; if (off) off(); mount(el); el.hidden = true; resolve(s); return; }
      el.hidden = false;
      if (remote) { remoteCard(el, s, compact, retry); if (s.state === 'idle' && !client.loading) wake(); return; }
      if (s.state === 'needs-download' || s.state === 'idle') {
        const total = s.total || 132568128;
        mount(el, h('div.engine-card', null,
          h('div.engine-title', null, 'Run GPT-2 small on this device'),
          compact ? null : h('p', null, `This tool runs a real language model inside your browser: GPT-2 small, the model ARENA's interpretability chapter takes apart. It is a single download of ${bytes(total - (s.have || 0))}, kept on this device so the lab works offline afterwards.`),
          h('div.row', null,
            h('button.btn.primary', { type: 'button', onclick: () => { engine.load().catch(() => {}); } }, `Download and start (${bytes(total - (s.have || 0))})`),
            h('span.muted.small', null, 'On mobile data? Wi-Fi is kinder.'))));
      } else if (s.state === 'downloading' || s.state === 'loading') {
        const frac = s.total ? (s.loaded || 0) / s.total : 0;
        mount(el, h('div.engine-card', null,
          h('div.engine-title', null, s.state === 'downloading' ? 'Downloading GPT-2 small' : 'Loading GPT-2 small from this device'),
          h('div.progress', null, h('span', { style: { width: Math.round(frac * 100) + '%' } })),
          h('div.muted.small', null, `${bytes(s.loaded || 0)} of ${bytes(s.total || 0)}`)));
      } else if (s.state === 'building' || s.state === 'gpu') {
        mount(el, h('div.engine-card', null, h('div.engine-title', null, s.state === 'gpu' ? 'Starting the graphics card…' : 'Unpacking the weights…'),
          h('div.progress.indeterminate', null, h('span'))));
      } else if (s.state === 'error') {
        mount(el, h('div.engine-card.err', null, h('div.engine-title', null, 'GPT-2 did not start'),
          h('p', null, s.error || 'Unknown error'),
          h('button.btn', { type: 'button', onclick: () => { engine.load().catch(() => {}); } }, 'Try again')));
      }
    };
    off = engine.on(render);
    if (done) off();
    if (remote) { client.boot().then(() => { if (client.status.state === 'idle') wake(); }, () => {}); return; }
    engine.warm().then((p) => {
      if (!p.cached && lab.status.state === 'idle') render({ state: 'needs-download', total: p.total, have: p.have });
    }).catch((e) => render({ state: 'error', error: e.message }));
  });
}

/* After the first load, for the 3090: shows the model's card in el again whenever the model is not ready (loading
   after the server let it go, waiting for another job's turn on the card, the server gone) and hides it once it is.
   The listener drops itself when el leaves the page. */
export function trackModel(el) {
  if (!engine.remote) return;
  const client = active;
  let off = null, gone = false;
  const retry = () => { client.boot().catch(() => {}); };
  off = engine.on((s) => {
    if (gone) return;
    if (client !== active || !el.isConnected) { gone = true; if (off) off(); return; }
    if (s.state === 'ready' || s.state === 'idle') { mount(el); el.hidden = true; return; }
    el.hidden = false;
    remoteCard(el, s, true, retry);
  });
  if (gone) off();
}

/* ---------------------------------------------------------------- the model picker in the header */

export function engineChip(el) {
  const label = h('span.chip-text', null, 'GPT-2');
  const btn = h('button.chip-engine', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: 'Choose the model the tools run on' },
    label, h('span.chip-caret', { 'aria-hidden': 'true' }, '▾'));
  const menu = h('div.model-menu', { role: 'dialog', 'aria-label': 'Choose the model' });
  /* a popover sits in the top layer, above the reading-level control that floats over every page */
  const pop = typeof menu.showPopover === 'function';
  if (pop) menu.popover = 'manual'; else menu.hidden = true;
  const isOpen = () => (pop ? menu.matches(':popover-open') : !menu.hidden);
  mount(el, btn, menu);
  el.classList.add('model-pick');

  /* each model's own state: GPT-2's engine in this tab, and a 3090 model's once the page has asked the server */
  const line = (m) => {
    const s = m.where === 'browser' ? lab.status : remotes.has(m.id) ? remotes.get(m.id).status : null;
    if (!s) return '';
    const t = m.where === 'browser' ? browserLine(s) : remoteLine(s, m.short);
    return t.replace(new RegExp('^' + m.short + ':?\\s*'), '');
  };
  const draw = () => {
    mount(menu,
      h('div.menu-head', null, 'Which model the tools take apart'),
      h('div', { role: 'radiogroup', 'aria-label': 'Models' }, MODELS.map((m) => h('button.model-opt', {
        type: 'button', role: 'radio', 'aria-checked': String(m.id === CFG.id),
        onclick: () => { close(); engine.use(m.id); },
      },
      h('span.opt-dot', { 'aria-hidden': 'true' }),
      h('span.opt-body', null,
        h('span.opt-name', null, m.name, h('span.opt-where', null, ' · ' + m.place)),
        h('span.opt-blurb', null, m.blurb),
        line(m) ? h('span.opt-state', null, line(m)) : null)))),
      engine.remote && ['offline', 'error'].includes(active.status.state)
        ? h('div.menu-foot', null, h('button.btn.small', { type: 'button', onclick: () => { active.boot().catch(() => {}); } }, 'Check the lab server again'))
        : null,
      h('p.menu-note', null, 'The explanations in each tool are written about GPT-2. On Qwen, a note at the top of each tool says what is different.'));
  };
  const open = () => {
    draw();
    if (pop) {
      const r = btn.getBoundingClientRect();
      Object.assign(menu.style, { top: `${Math.round(r.bottom + 6)}px`, right: `${Math.max(8, Math.round(innerWidth - r.right))}px` });
      menu.showPopover();
    } else menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    const first = menu.querySelector('[aria-checked="true"]');
    if (first) first.focus();
  };
  const close = () => {
    if (pop) { if (isOpen()) menu.hidePopover(); } else menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };
  btn.addEventListener('click', () => (isOpen() ? close() : open()));
  document.addEventListener('pointerdown', (ev) => { if (isOpen() && !el.contains(ev.target)) close(); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && isOpen()) { close(); btn.focus(); } });
  addEventListener('resize', () => { if (isOpen()) close(); });

  const paint = (s) => {
    label.textContent = statusLine(s);
    btn.dataset.state = s.state;
    btn.dataset.where = CFG.where;
    btn.title = engine.remote
      ? (s.state === 'ready' ? `${CFG.name} on the PC's graphics card${s.gpuInfo ? ' (' + s.gpuInfo + ')' : ''}. Click to change the model.` : 'Click to change the model.')
      : (s.state === 'ready' ? (s.engine === 'webgpu' ? `Running on this device's graphics card${s.gpuInfo ? ' (' + s.gpuInfo + ')' : ''}. Click to change the model.` : `Running on this device's processor${s.gpuNote ? '. ' + s.gpuNote : ''}. Click to change the model.`) : 'Click to change the model.');
    if (isOpen()) draw();
  };
  engine.on(paint);
  addEventListener('lab:model', () => paint(active.status));
}
