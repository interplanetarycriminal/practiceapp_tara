/* lab/ui/engine.js: one shared GPT-2 for every tool, and the card that asks before downloading it.

   The weights are 133 MB, so nothing downloads until the reader says so. Once downloaded they live in the browser's
   cache storage and the lab works offline; later visits load them in about a second. */

import { lab } from '../core/client.js';
import { h, mount, bytes, store } from './dom.js';

const L = 12, H = 12, M = 3072, D = 768;
export const CFG = { L, H, M, D, V: 50257 };

let booted = null, loading = null;
const tokCache = new Map();

export const engine = {
  lab,
  get status() { return lab.status; },
  on(fn) { return lab.on(fn); },
  ready() { return lab.status.state === 'ready'; },

  boot() {
    if (!booted) booted = lab.boot({ engine: store.get('tara.lab.engine', 'auto') }).catch((e) => { booted = null; throw e; });
    return booted;
  },

  /* Load without downloading when the weights are already here; returns the probe result either way. */
  async warm() {
    const p = await this.boot();
    if (p.cached && !loading) loading = lab.load({ allowDownload: false }).catch((e) => { loading = null; throw e; });
    return p;
  },

  async load() {
    await this.boot();
    if (!loading || lab.status.state === 'needs-download') loading = lab.load({ allowDownload: true }).catch((e) => { loading = null; throw e; });
    return loading;
  },

  /* text -> {ids, pieces}; ids start with <|endoftext|> like TransformerLens' prompts */
  async tok(text, bos = true) {
    const key = (bos ? '1' : '0') + text;
    if (tokCache.has(key)) return tokCache.get(key);
    const r = await lab.call('tokenize', { text, bos });
    if (tokCache.size > 400) tokCache.clear();
    tokCache.set(key, r);
    return r;
  },

  /* the first token of a string such as " Mary" (no <|endoftext|>), with a warning when it is more than one token */
  async token(s) {
    const r = await this.tok(s, false);
    return { id: r.ids[0], piece: r.pieces[0], whole: r.ids.length === 1, n: r.ids.length, pieces: r.pieces };
  },

  async vocab(ids) { return (await lab.call('vocab', { ids: Array.from(ids) })).vocab; },
  recipe(name, args, opts) { return lab.recipe(name, args, opts); },
  generate(args, onTok, opts) { return lab.generate(args, onTok, opts); },
  forget() { return lab.call('forget'); },
};

/* ---------------------------------------------------------------- the engine card */

/* Mounts a card into el that tracks the engine; resolves once the model is ready. Tools await it before running. */
export function needModel(el, { compact = false } = {}) {
  return new Promise((resolve) => {
    if (lab.status.state === 'ready') { mount(el); el.hidden = true; resolve(lab.status); return; }
    let off = null, done = false;
    const render = (s) => {
      if (done) return;
      if (s.state === 'ready') { done = true; if (off) off(); mount(el); el.hidden = true; resolve(s); return; }
      el.hidden = false;
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
    engine.warm().then((p) => {
      if (!p.cached && lab.status.state === 'idle') render({ state: 'needs-download', total: p.total, have: p.have });
    }).catch((e) => render({ state: 'error', error: e.message }));
  });
}

/* the small status pill in the header */
export function engineChip(el) {
  engine.on((s) => {
    const label = {
      idle: 'GPT-2: not started', 'needs-download': 'GPT-2: not downloaded', downloading: `GPT-2: downloading ${s.total ? Math.round(100 * (s.loaded || 0) / s.total) : 0}%`,
      loading: 'GPT-2: loading', building: 'GPT-2: unpacking', gpu: 'GPT-2: starting GPU',
      ready: s.engine === 'webgpu' ? 'GPT-2 ready · GPU' : 'GPT-2 ready · CPU', error: 'GPT-2: error',
    }[s.state] || 'GPT-2';
    el.textContent = label;
    el.dataset.state = s.state;
    el.title = s.state === 'ready' ? (s.engine === 'webgpu' ? `Running on the graphics card${s.gpuInfo ? ' (' + s.gpuInfo + ')' : ''}` : `Running on the processor${s.gpuNote ? '. ' + s.gpuNote : ''}`) : '';
  });
}

export const isGPU = () => lab.status.engine === 'webgpu';
