/* lab/core/client.js: the page's handle on the model.

   The engine runs in a worker when it can (so nothing freezes), and on the page itself when the browser offers
   WebGPU only there. Either way every tool sees the same API:

     const lab = new LabClient();
     lab.on((status) => ...)               status.state: idle | needs-download | downloading | loading | building | gpu | ready | error
     await lab.boot()                       -> { total, have, cached, ... }
     await lab.load({ allowDownload })
     await lab.call('recipe', { name, args }, { onProgress, channel })
     lab.generate(args, onToken, { channel })

   A call made on a channel cancels the previous unfinished call on the same channel, so a tool that re-runs on
   every keystroke never queues stale work. */

/* Some browsers (Safari, older Firefox) offer WebGPU on the page but not inside workers. Moving the engine onto the
   page only pays when that GPU is real hardware: an emulated one would just block the page. */
async function pageHasGpu() {
  try {
    if (typeof navigator === 'undefined' || !navigator.gpu) return false;
    const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!a) return false;
    const i = a.info || {};
    if (i.isFallbackAdapter || a.isFallbackAdapter) return false;
    return !/swiftshader|llvmpipe|software|microsoft basic render/i.test([i.vendor, i.architecture, i.device, i.description].join(' '));
  } catch (e) { return false; }
}

export class LabClient {
  constructor() {
    this.listeners = new Set();
    this.status = { state: 'idle' };
    this.seq = 0;
    this.calls = new Map();
    this.channels = new Map();
    this.mode = null;
  }

  on(fn) { this.listeners.add(fn); fn(this.status); return () => this.listeners.delete(fn); }

  setStatus(s) {
    this.status = { ...this.status, ...s };
    for (const fn of this.listeners) { try { fn(this.status); } catch (e) { console.error(e); } }
  }

  onMessage(msg) {
    if (msg.type === 'status') { const { type, ...s } = msg; this.setStatus(s); return; }
    const c = this.calls.get(msg.id);
    if (!c) return;
    if (msg.progress !== undefined) { if (c.onProgress) c.onProgress(msg.progress); return; }
    this.calls.delete(msg.id);
    if (msg.ok) c.resolve(msg.result); else c.reject(new Error(msg.error));
  }

  async boot(prefs = {}) {
    if (this.booting) return this.booting;
    this.prefs = prefs;
    this.booting = (async () => {
      try {
        this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = (ev) => this.onMessage(ev.data);
        this.worker.onerror = (ev) => this.setStatus({ state: 'error', error: 'The lab worker failed to start: ' + (ev.message || 'unknown error') });
        this.mode = 'worker';
        const p = await this.call('probe');
        if (!p.gpuInHere && prefs.engine !== 'cpu' && await pageHasGpu()) {
          this.worker.terminate();
          this.worker = null;
          await this.startHere();
          return this.call('probe');
        }
        return p;
      } catch (e) {
        if (this.worker) { this.worker.terminate(); this.worker = null; }
        await this.startHere();
        return this.call('probe');
      }
    })();
    return this.booting;
  }

  async startHere() {
    const { Host } = await import('./host.js');
    this.host = new Host((msg) => this.onMessage(msg));
    this.mode = 'page';
  }

  load(opts = {}) { return this.call('load', { engine: (this.prefs && this.prefs.engine) || 'auto', ...opts }); }

  call(op, args = {}, { onProgress, channel } = {}) {
    if (channel) {
      const prev = this.channels.get(channel);
      if (prev) this.cancel(prev);
    }
    const id = ++this.seq;
    if (channel) this.channels.set(channel, id);
    const p = new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject, onProgress, cancelled: false });
      if (this.worker) this.worker.postMessage({ id, op, args });
      else if (this.host) {
        const c = this.calls.get(id);
        const ctx = { cancelled: () => c.cancelled, progress: (x) => this.onMessage({ id, progress: x }) };
        this.host.handle(op, args, ctx).then(
          (result) => this.onMessage({ id, ok: true, result }),
          (e) => this.onMessage({ id, ok: false, error: String((e && e.message) || e) }));
      } else reject(new Error('The lab engine is not started'));
    });
    p.id = id;
    if (channel) p.finally(() => { if (this.channels.get(channel) === id) this.channels.delete(channel); }).catch(() => {});
    return p;
  }

  cancel(id) {
    const c = this.calls.get(id);
    if (!c) return;
    c.cancelled = true;
    if (this.worker) this.worker.postMessage({ cancel: id });
  }

  recipe(name, args, opts) { return this.call('recipe', { name, args }, opts); }

  generate(args, onToken, opts = {}) { return this.call('generate', args, { ...opts, onProgress: onToken }); }
}

export const lab = new LabClient();
