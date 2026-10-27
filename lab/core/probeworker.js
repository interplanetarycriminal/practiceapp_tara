/* lab/core/probeworker.js: lab/core/probes.js off the page, so fitting probes at every layer of a big model (4,096
   numbers a token at each of 32 layers) never freezes it. Message in: {X, y, n, paired, shape}; out: {progress} ...,
   then {ok, res} or {ok: false, error}. */

import { probeAll } from './probes.js';

self.onmessage = (ev) => {
  const { X, y, n, paired, shape } = ev.data;
  try {
    const res = probeAll(X, y, n, paired, shape, (done, total) => self.postMessage({ progress: { done, total } }));
    self.postMessage({ ok: true, res });
  } catch (e) {
    self.postMessage({ ok: false, error: String((e && e.message) || e) });
  }
};
