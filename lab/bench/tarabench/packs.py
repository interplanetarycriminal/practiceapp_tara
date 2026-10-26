"""Result packs: the one format every engine writes and every viewer in the lab reads (see PACKS.md).

A pack is a folder lab/findings/packs/<id>/ holding pack.json and small little-endian binary arrays. The index
lab/findings/index.json lists every pack, newest first."""
import json
import os
import re
import time
from pathlib import Path

import numpy as np

from .common import FINDINGS, say

FORMAT = 'tara-pack/1'
DTYPES = {'f32': np.float32, 'f16': np.float16, 'i32': np.int32, 'i16': np.int16, 'u16': np.uint16, 'u8': np.uint8,
          'i8': np.int8}
SLUG = re.compile(r'^[a-z0-9][a-z0-9._-]{1,80}$')


def _atomic_write(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(text, encoding='utf-8')
    os.replace(tmp, path)


def _clean(x):
    """Makes numpy and torch values JSON-safe; NaN and infinities become null."""
    if isinstance(x, dict):
        return {str(k): _clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_clean(v) for v in x]
    if hasattr(x, 'detach'):
        x = x.detach().cpu().numpy()
    if isinstance(x, np.ndarray):
        return _clean(x.tolist())
    if isinstance(x, (np.floating, float)):
        x = float(x)
        return None if x != x or x in (float('inf'), float('-inf')) else round(x, 6)
    if isinstance(x, np.integer):
        return int(x)
    if isinstance(x, np.bool_):
        return bool(x)
    return x


class Pack:
    def __init__(self, spec, kind, root=None):
        pid = spec['id']
        if not SLUG.match(pid):
            raise ValueError(f'pack id {pid!r} must be lower-case letters, digits, dots, dashes or underscores')
        self.root = Path(root) if root else FINDINGS
        self.dir = self.root / 'packs' / pid
        self.dir.mkdir(parents=True, exist_ok=True)
        for old in self.dir.glob('*.bin'):
            old.unlink()
        self.id, self.kind, self.spec = pid, kind, spec
        self.arrays = {}

    def array(self, name, values, dtype='f32'):
        a = np.ascontiguousarray(np.asarray(values.detach().cpu() if hasattr(values, 'detach') else values,
                                            dtype=DTYPES[dtype]))
        a = a.astype(a.dtype.newbyteorder('<'), copy=False)
        f = f'{name}.bin'
        (self.dir / f).write_bytes(a.tobytes())
        self.arrays[name] = {'file': f, 'dtype': dtype, 'shape': list(a.shape)}
        return self.arrays[name]

    def file(self, name, obj):
        """A side JSON file for data too large to sit in pack.json, such as an attribution graph."""
        _atomic_write(self.dir / name, json.dumps(_clean(obj), ensure_ascii=False, separators=(',', ':')))
        return name

    def save(self, *, models, summary, claims, data, provenance, dictionary=None, notes=None):
        spec = self.spec
        meta = {
            'format': FORMAT, 'id': self.id, 'kind': self.kind,
            'title': spec.get('title', self.id), 'question': spec.get('question', ''),
            'created': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'models': models, 'dictionary': dictionary, 'summary': summary, 'claims': claims,
            'notes': notes or [], 'data': data, 'arrays': self.arrays, 'spec': spec, 'provenance': provenance,
        }
        _atomic_write(self.dir / 'pack.json', json.dumps(_clean(meta), ensure_ascii=False, indent=1))
        self._index(meta)
        size = sum(p.stat().st_size for p in self.dir.iterdir())
        say(f'pack written: {self.dir} ({size / 1e6:.2f} MB)')
        return self.dir

    def _index(self, meta):
        path = self.root / 'index.json'
        try:
            index = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            index = {'format': FORMAT, 'packs': []}
        entry = {'id': meta['id'], 'kind': meta['kind'], 'title': meta['title'], 'question': meta['question'],
                 'created': meta['created'], 'models': [m.get('id') for m in meta['models']],
                 'headline': meta['summary'].get('headline', '') if isinstance(meta['summary'], dict) else '',
                 'claims': [{'status': c.get('status'), 'text': c.get('text')} for c in meta['claims']]}
        index['packs'] = [p for p in index.get('packs', []) if p.get('id') != meta['id']] + [entry]
        index['packs'].sort(key=lambda p: p.get('created', ''), reverse=True)
        _atomic_write(path, json.dumps(_clean(index), ensure_ascii=False, indent=1))


def claim(text, status, evidence, test=None):
    """One line for the claim ledger. status: 'supported' (passes its control), 'weak' (direction right, control not
    cleared) or 'not-supported' (fails). evidence carries the numbers the viewer shows beside it."""
    assert status in ('supported', 'weak', 'not-supported')
    return {'text': text, 'status': status, 'evidence': evidence, 'test': test}
