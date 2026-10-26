"""Runs one spec: loads what it needs, hands the engine a context, and makes sure every pack carries its provenance."""
import json
import time
from pathlib import Path

from .common import FINDINGS, gpu_lock, provenance, say, seed_all
from .models import load
from .packs import Pack


class Ctx:
    def __init__(self, spec, out=None, lock=None, device=None, smoke=False):
        self.spec = spec
        self.root = Path(out) if out else FINDINGS
        self.hold = gpu_lock(lock)
        self.device = device
        self.smoke = smoke
        self.started = time.time()
        self._lms = {}

    def load(self, name, keep_others=False, precision=None):
        if name in self._lms:
            return self._lms[name]
        if not keep_others:
            for k in list(self._lms):
                self._lms.pop(k).unload()
        rev = (self.spec.get('revisions') or {}).get(name)
        lm = load(name, precision or self.spec.get('precision', 'auto'), self.device, rev,
                  self.spec.get('vram_headroom_gb', 2.5))
        lm.hold = self.hold
        if self.spec.get('batch_size'):
            lm.batch_size = int(self.spec['batch_size'])
        self._lms[name] = lm
        return lm

    def drop(self, name):
        if name in self._lms:
            self._lms.pop(name).unload()

    def pack(self, kind):
        return Pack(self.spec, kind, self.root)

    def provenance(self, extra=None):
        return provenance(self.spec, self.started, extra)

    def close(self):
        for k in list(self._lms):
            self._lms.pop(k).unload()


def read_spec(path):
    spec = json.loads(Path(path).read_text(encoding='utf-8'))
    spec.setdefault('id', Path(path).stem)
    return spec


def run_spec(spec, out=None, lock=None, device=None, smoke=False):
    from .engines import ENGINES
    if spec.get('engine') not in ENGINES:
        raise ValueError(f"unknown engine {spec.get('engine')!r}; one of {sorted(ENGINES)}")
    if smoke and spec.get('smoke'):
        spec = {**spec, **spec['smoke'], 'id': spec['id'] + '-smoke'}
    seed_all(spec.get('seed', 0))
    ctx = Ctx(spec, out, lock, device, smoke)
    say(f"== {spec['engine']}: {spec['id']}")
    try:
        return ENGINES[spec['engine']](spec, ctx)
    finally:
        ctx.close()
