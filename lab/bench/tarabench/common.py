"""Shared plumbing for the bench: paths, seeding, the GPU lock, provenance, progress lines and spec helpers."""
import contextlib
import hashlib
import importlib.util
import json
import os
import platform
import random
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import torch

BENCH = Path(__file__).resolve().parent.parent
LAB = BENCH.parent
REPO = LAB.parent
FINDINGS = LAB / 'findings'
WORK = Path(os.environ.get('TARA_BENCH_WORK', str(BENCH / 'work')))

# Windows consoles default to a code page that cannot print most tokens; never let a print kill a run.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors='replace')
    except (AttributeError, ValueError):
        pass


def say(*parts):
    print(*parts, flush=True)


def seed_all(seed):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def gpu_lock(path, label='tara-lab bench'):
    """Returns a factory of context managers. With a path to a .py file that defines hold(), every chunk of GPU work
    runs inside hold(), so the bench takes turns with the other GPU users of the machine. Without one, a no-op."""
    if not path:
        return contextlib.nullcontext
    spec = importlib.util.spec_from_file_location('gpulock', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    def hold():
        try:
            return mod.hold(label=label)
        except TypeError:
            return mod.hold()
    return hold


def git_state():
    try:
        sha = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=REPO, capture_output=True, text=True, timeout=10).stdout.strip()
        dirty = subprocess.run(['git', 'status', '--porcelain', '--', 'lab/bench'], cwd=REPO, capture_output=True,
                               text=True, timeout=10).stdout.strip()
        return {'commit': sha or None, 'bench_dirty': bool(dirty)}
    except (OSError, subprocess.SubprocessError):
        return {'commit': None, 'bench_dirty': None}


def spec_hash(spec):
    return hashlib.sha256(json.dumps(spec, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]


def environment():
    env = {'python': platform.python_version(), 'torch': torch.__version__, 'os': platform.platform(terse=True)}
    try:
        import transformers
        env['transformers'] = transformers.__version__
    except ImportError:
        pass
    if torch.cuda.is_available():
        env['gpu'] = torch.cuda.get_device_name(0)
        env['cuda'] = torch.version.cuda
    return env


def provenance(spec, started, extra=None):
    rec = {'spec_hash': spec_hash(spec), 'seed': spec.get('seed', 0), 'runtime_s': round(time.time() - started, 1),
           'finished': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), **git_state(), **environment()}
    if extra:
        rec.update(extra)
    return rec


class Progress:
    """Prints a progress line and keeps WORK/status.json current, so a run can be watched from outside."""

    def __init__(self, job, total):
        self.job, self.total, self.t0, self.last = job, total, time.time(), 0.0
        WORK.mkdir(parents=True, exist_ok=True)

    def __call__(self, done, note='', force=False):
        now = time.time()
        if not force and done < self.total and now - self.last < 5:
            return
        self.last = now
        el = now - self.t0
        eta = el / done * (self.total - done) if done else None
        rec = {'job': self.job, 'done': done, 'total': self.total, 'elapsed_s': round(el),
               'eta_s': eta and round(eta), 'note': note, 'time': time.strftime('%Y-%m-%d %H:%M:%S')}
        try:
            (WORK / 'status.json').write_text(json.dumps(rec))
        except OSError:
            pass
        say(f'[{self.job}] {done}/{self.total} {note} {el:.0f}s' + (f' (about {eta:.0f}s left)' if eta else ''))


def as_list(x):
    if x is None:
        return []
    return list(x) if isinstance(x, (list, tuple)) else [x]


def layer_list(spec_layers, n_layers):
    """'all', 'every:4', 'a-b', an int or a list of ints, with negative numbers counted from the end."""
    if spec_layers in (None, 'all'):
        return list(range(n_layers))
    if isinstance(spec_layers, str):
        if spec_layers.startswith('every:'):
            step = int(spec_layers.split(':')[1])
            return list(range(step - 1, n_layers, step)) or [n_layers - 1]
        if '-' in spec_layers[1:]:
            a, b = spec_layers.split('-', 1)
            return list(range(int(a), int(b) + 1))
        spec_layers = int(spec_layers)
    out = []
    for v in as_list(spec_layers):
        v = int(v)
        out.append(v + n_layers if v < 0 else v)
    for v in out:
        if not 0 <= v < n_layers:
            raise ValueError(f'layer {v} is outside 0..{n_layers - 1}')
    return out


def cpu32(t):
    return t.detach().to('cpu', torch.float32)
