/* lab/core/remote.js: the page's handle on a model held by the live lab server on this computer (lab/bench/serve.py,
   Qwen 3.5 9B on the 3090). It has LabClient's API (client.js), so a tool cannot tell which engine answers:

     const q = new RemoteClient('qwen3.5-9b');
     q.on((status) => ...)        status.state: connecting | offline | idle | loading | waiting | ready | error
     await q.boot()               -> the server's /v1/info, with this model's shape as .shape
     await q.load()               -> the loaded model's shape and dose unit
     await q.call('recipe', { name, args }, { onProgress, channel })
     q.generate(args, onToken, { channel })

   Requests go as wire.js messages; each answer streams back as frames (u32 length + message): {job}, {stage} and
   {progress} ..., then {ok, result}. A {stage} frame says where the request is (starting the card process, loading the
   model, waiting for another job to free the card) and becomes the client's status, so every tool shows it.
   A call on a channel cancels the previous unfinished call on that channel, here and on the server. */

import { pack, unpack } from './wire.js';

export const LIVE_URL = 'http://127.0.0.1:8790';

/* the server's /v1/info, or null when nothing answers (not running, another device, or the browser said no) */
export async function probeLive(url = LIVE_URL, timeout = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url + '/v1/info', { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.server === 'tara-live' ? j : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* bytes arriving in pieces, taken out in whole frames without re-copying everything that came before */
class Bytes {
  constructor() { this.parts = []; this.len = 0; }
  push(u8) { if (u8.length) { this.parts.push(u8); this.len += u8.length; } }
  peekU32() {
    const b = new Uint8Array(4);
    let o = 0;
    for (const p of this.parts) { const k = Math.min(p.length, 4 - o); b.set(p.subarray(0, k), o); o += k; if (o === 4) break; }
    return new DataView(b.buffer).getUint32(0, true);
  }
  take(n) {
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      const p = this.parts[0], k = Math.min(p.length, n - o);
      out.set(p.subarray(0, k), o);
      o += k;
      if (k === p.length) this.parts.shift(); else this.parts[0] = p.subarray(k);
    }
    this.len -= n;
    return out;
  }
}

const OFFLINE = 'The lab server on this computer is not answering.';
const GPU_OPS = new Set(['load', 'recipe', 'generate', 'saeLoad']);     // requests that need the model on the card

export class RemoteClient {
  constructor(model, url = LIVE_URL) {
    this.model = model;
    this.url = url;
    this.listeners = new Set();
    this.status = { state: 'connecting', engine: 'remote', model };
    this.seq = 0;
    this.calls = new Map();       // id -> {ctl, job, reject, cancelled}
    this.channels = new Map();
    this.mode = 'remote';
    this.info = null;
    this.before = 'idle';         // the state to go back to when a wait for the card ends
  }

  on(fn) { this.listeners.add(fn); fn(this.status); return () => this.listeners.delete(fn); }

  setStatus(s) {
    this.status = { ...this.status, ...s };
    for (const fn of this.listeners) { try { fn(this.status); } catch (e) { console.error(e); } }
  }

  /* What the server says about this model. Resolves with the info (its .shape is this model's shape); rejects when
     the server does not answer, leaving the status 'offline'. */
  async boot() {
    if (this.status.state === 'offline' || this.status.state === 'error') { this.booting = null; this.setStatus({ state: 'connecting', error: null }); }
    if (this.booting) return this.booting;
    this.booting = (async () => {
      let info = await probeLive(this.url);
      const t0 = Date.now();
      while (info && info.warming && Date.now() - t0 < 300000) {       // just started: reading the models' files
        this.setStatus({ state: 'connecting', note: `The lab server is starting up (${Math.round(info.warmS || 0)} s so far; about a minute after the PC starts).` });
        await new Promise((r) => setTimeout(r, 2000));
        info = await probeLive(this.url);
      }
      if (!info) { this.setStatus({ state: 'offline', error: OFFLINE, note: null }); throw new Error(OFFLINE); }
      this.absorb(info);
      return this.info;
    })();
    this.booting.catch(() => { this.booting = null; });
    return this.booting;
  }

  /* /v1/info again (the reaper may have let the model go, or another tab loaded it) */
  async refresh() {
    if (this.booting && this.status.state === 'connecting') return this.booting;
    const info = await probeLive(this.url);
    if (!info) { if (this.status.state !== 'offline') this.setStatus({ state: 'offline', error: OFFLINE, note: null }); return null; }   // no redraw while it stays away
    if (info.warming) { this.booting = null; return this.boot(); }
    this.absorb(info);
    return info;
  }

  absorb(info) {
    const m = (info.models || []).find((x) => x.id === this.model);
    this.info = { ...info, offered: !!m, shape: info.loaded === this.model && info.cfg ? info.cfg : (m && m.cfg) || null, entry: m || null };
    const s = { gpuInfo: info.gpu ? info.gpu.name : null, gpuFree: info.gpu ? info.gpu.free : null, entry: m || null };
    if (this.info.shape) Object.assign(s, { cfg: this.info.shape, residNorm: this.info.shape.residNorm || null });
    if (!m) { this.setStatus({ ...s, state: 'error', error: `The lab server on this computer does not offer ${this.model}.` }); return; }
    if (this.status.state === 'loading' || this.status.state === 'waiting') { this.setStatus(s); return; }
    if (info.loading === this.model) this.setStatus({ ...s, state: 'loading', elapsed: 0, expect: m.loadS, note: null });
    else this.setStatus({ ...s, state: info.loaded === this.model ? 'ready' : 'idle', error: null, note: null });
  }

  /* put the model on the card (the first request of any kind does this too) */
  async load() {
    await this.boot();
    if (!this.loading) {
      this.loading = this.call('load', {}).then((cfg) => {
        this.info = { ...this.info, shape: cfg };
        this.setStatus({ state: 'ready', cfg, residNorm: cfg.residNorm, loadS: cfg.loadS, error: null });
        return cfg;
      }, (e) => {
        if (!/cancelled/.test(String(e && e.message))) this.setStatus({ state: this.status.state === 'offline' ? 'offline' : 'error', error: String(e && e.message || e) });
        throw e;
      }).finally(() => { this.loading = null; });
    }
    return this.loading;
  }

  /* a frame's {stage} as the client's status */
  stage(x, call) {
    const st = this.status.state;
    if (x.stage === 'starting') this.setStatus({ state: 'loading', phase: 'starting', elapsed: 0, expect: (this.status.entry || {}).loadS || 330, note: null });
    else if (x.stage === 'loading' || x.stage === 'measuring') this.setStatus({ state: 'loading', phase: x.stage, elapsed: x.elapsed || 0, expect: x.expect || this.status.expect, note: null });
    else if (x.stage === 'waiting') { if (st !== 'waiting') this.before = st; this.setStatus({ state: 'waiting', note: x.note || null }); }
    else if (x.stage === 'running') { if (st === 'waiting') this.setStatus({ state: this.before === 'ready' ? 'ready' : this.before, note: null }); }
    else if (x.stage === 'downloading') this.setStatus({ note: x.note || null });
    if (call && call.onStage) call.onStage(x);
  }

  call(op, args = {}, { onProgress, onStage, channel } = {}) {
    if (channel) {
      const prev = this.channels.get(channel);
      if (prev) this.cancel(prev, false);
    }
    const id = ++this.seq;
    if (channel) this.channels.set(channel, id);
    const ctl = new AbortController();
    const c = { ctl, job: null, cancelled: false, onStage };
    this.calls.set(id, c);
    const p = (async () => {
      let r;
      try {
        r = await fetch(this.url + '/v1/call', {
          method: 'POST', body: pack({ op, args, model: this.model, channel: channel || null }),
          headers: { 'Content-Type': 'application/octet-stream' }, signal: ctl.signal, cache: 'no-store',
        });
      } catch (e) {
        if (c.cancelled) throw new Error('cancelled');
        this.setStatus({ state: 'offline', error: OFFLINE });
        throw new Error(OFFLINE + ' Start it on the PC with the 3090, or pick GPT-2.');
      }
      if (!r.ok) {
        let msg = r.status === 403 ? 'The lab server on this computer refused this page.' : `The lab server answered ${r.status}.`;
        try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (e) { /* not JSON */ }
        throw new Error(msg);
      }
      const reader = r.body.getReader(), buf = new Bytes();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf.push(value);
          while (buf.len >= 4) {
            const n = buf.peekU32();
            if (buf.len < 4 + n) break;
            buf.take(4);
            const msg = unpack(buf.take(n));
            if (msg.job !== undefined) c.job = msg.job;
            else if (msg.stage !== undefined) this.stage(msg.stage, c);
            else if (msg.progress !== undefined) { if (onProgress) onProgress(msg.progress); }
            else if (msg.ok !== undefined) {
              if (msg.ok) {
                if (op === 'release') this.setStatus({ state: 'idle', note: null });
                else if (GPU_OPS.has(op) && this.status.state !== 'ready') this.setStatus({ state: 'ready', note: null, error: null });
                return msg.result;
              }
              if (this.status.state === 'loading' || this.status.state === 'waiting') {
                this.setStatus(/cancelled/.test(String(msg.error)) ? { state: 'idle' } : { state: 'error', error: msg.error });
              }
              throw new Error(msg.error);
            }
          }
        }
      } catch (e) {
        if (c.cancelled || (e && e.name === 'AbortError')) throw new Error('cancelled');
        throw e;
      } finally {
        if (this.status.note && this.status.state === 'ready') this.setStatus({ note: null });
      }
      if (c.cancelled) throw new Error('cancelled');
      this.refresh().catch(() => {});
      throw new Error('The lab server stopped answering in the middle of this request.');
    })().finally(() => {
      this.calls.delete(id);
      if (channel && this.channels.get(channel) === id) this.channels.delete(channel);
    });
    p.id = id;
    p.catch(() => {});
    return p;
  }

  /* stop a call: the page stops reading at once and the server drops it at its next checkpoint */
  cancel(id, tell = true) {
    const c = this.calls.get(id);
    if (!c || c.cancelled) return;
    c.cancelled = true;
    if (tell && c.job != null) {
      fetch(this.url + '/v1/cancel', { method: 'POST', body: pack({ id: c.job }), headers: { 'Content-Type': 'application/octet-stream' } }).catch(() => {});
    }
    c.ctl.abort();
  }

  recipe(name, args, opts) { return this.call('recipe', { name, args }, opts); }

  generate(args, onToken, opts = {}) { return this.call('generate', args, { ...opts, onProgress: onToken }); }

  /* let the model go now instead of after the server's idle time */
  release() { return this.call('release', {}); }
}
