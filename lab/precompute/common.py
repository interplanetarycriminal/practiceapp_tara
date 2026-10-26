"""Shared helpers for the precompute jobs: the GPU lock, resumable state, output files, a status file."""
import contextlib
import gzip
import importlib.util
import json
import os
import time
from pathlib import Path

import numpy as np
import torch


def gpu_lock(path):
    """A context manager factory. With --lock pointing at a .py file that defines hold(), every chunk of GPU work
    runs inside hold(), so it takes turns with other GPU users of the machine. Without it, a no-op."""
    if not path:
        return contextlib.nullcontext
    spec = importlib.util.spec_from_file_location('gpulock', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    def hold():
        try:
            return mod.hold(label='tara-lab precompute')
        except TypeError:
            return mod.hold()
    return hold


def save_state(path, state):
    path = Path(path)
    tmp = path.with_suffix('.tmp')
    torch.save(state, tmp)
    os.replace(tmp, path)


def load_state(path, device):
    path = Path(path)
    if not path.exists():
        return None
    return torch.load(path, map_location=device, weights_only=False)


def write_bin(path, *arrays, gz=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = b''.join(np.ascontiguousarray(a).tobytes() for a in arrays)
    if gz:
        data = gzip.compress(data, 9, mtime=0)
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_bytes(data)
    os.replace(tmp, path)
    return len(data)


class Status:
    """Writes status.json next to the work files, so progress can be read from outside while a job runs."""

    def __init__(self, work, job):
        self.path = Path(work) / 'status.json'
        self.job = job
        self.t0 = time.time()

    def __call__(self, done, total, note=''):
        el = time.time() - self.t0
        eta = el / done * (total - done) if done else None
        rec = {'job': self.job, 'done': done, 'total': total, 'elapsed_s': round(el), 'eta_s': eta and round(eta),
               'note': note, 'time': time.strftime('%Y-%m-%d %H:%M:%S')}
        try:
            self.path.write_text(json.dumps(rec))
        except OSError:
            pass
        print(f'[{self.job}] {done}/{total} {note} elapsed {el:.0f}s' + (f' eta {eta:.0f}s' if eta else ''), flush=True)
