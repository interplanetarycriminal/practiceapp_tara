/* lab/core/worker.js: runs the Host off the page, so a long computation never freezes the lab. */

import { Host } from './host.js';

const live = new Map();
const host = new Host((msg) => self.postMessage(msg));

/* Hand back big results without copying: buffers that a typed array fully owns move to the page. */
function transferables(x, out = new Set()) {
  if (!x || typeof x !== 'object') return out;
  if (ArrayBuffer.isView(x)) {
    if (x.byteOffset === 0 && x.byteLength === x.buffer.byteLength) out.add(x.buffer);
    return out;
  }
  if (Array.isArray(x)) { for (const v of x) transferables(v, out); return out; }
  for (const k of Object.keys(x)) transferables(x[k], out);
  return out;
}

self.onmessage = async (ev) => {
  const { id, op, args, cancel } = ev.data || {};
  if (cancel) { const c = live.get(cancel); if (c) c.cancelled = true; return; }
  const c = { cancelled: false };
  live.set(id, c);
  const ctx = { cancelled: () => c.cancelled, progress: (p) => self.postMessage({ id, progress: p }) };
  try {
    const result = await host.handle(op, args, ctx);
    self.postMessage({ id, ok: true, result }, [...transferables(result)]);
  } catch (e) {
    self.postMessage({ id, ok: false, error: String((e && e.message) || e) });
  } finally { live.delete(id); }
};
