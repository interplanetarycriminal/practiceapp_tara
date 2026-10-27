"""The live lab's message format, shared with lab/core/remote.js. A message is a JSON value whose arrays travel as raw
little-endian bytes after it, so a recipe's 400,000 activations cost 800 KB instead of several megabytes of text:

    b'TLB1' | u32 header length | header JSON, space-padded to 8 bytes | blob, blob, ... (each 8-byte aligned)

The header is {"v": value, "b": [[offset, bytes, dtype], ...]}. Inside value, {"$b": i} stands for blob i, and
{"$f": "nan" | "inf" | "-inf"} for a float JSON cannot hold. dtypes: f32 f64 f16 i32 i16 i8 u8 u16. Plain JSON
(no arrays) is accepted too."""
import json
import math
import struct
import sys

import numpy as np

MAGIC = b'TLB1'
DT = {'f32': np.float32, 'f64': np.float64, 'f16': np.float16, 'i32': np.int32, 'i16': np.int16, 'i8': np.int8,
      'u8': np.uint8, 'u16': np.uint16}
NAME = {np.dtype(v).str[1:]: k for k, v in DT.items()}


class F16(np.ndarray):
    """Marks an array to be sent as float16 (half the bytes; the browser turns it back into float32)."""


def half(a):
    return np.asarray(a, dtype=np.float16).view(F16)


def _array(x):
    torch = sys.modules.get('torch')            # no tensors can exist before torch is imported, so never import it here
    if torch is not None and isinstance(x, torch.Tensor):
        t = x.detach()
        if t.dtype in (torch.bfloat16, torch.float16):
            t = t.float()
        return t.cpu().numpy()
    return x


def pack(value):
    blobs = []

    def walk(x):
        x = _array(x)
        if isinstance(x, F16):
            a = np.ascontiguousarray(x.view(np.ndarray), dtype=np.float16)
            blobs.append((a.tobytes(), 'f16'))
            return {'$b': len(blobs) - 1}
        if isinstance(x, np.ndarray):
            a = x
            if a.dtype == np.bool_:
                a = a.astype(np.uint8)
            elif a.dtype == np.int64 or a.dtype == np.uint32:
                a = a.astype(np.int32)
            elif a.dtype not in [np.dtype(v) for v in DT.values()]:
                a = a.astype(np.float32)
            a = np.ascontiguousarray(a.astype(a.dtype.newbyteorder('<'), copy=False))
            blobs.append((a.tobytes(), NAME[a.dtype.str[1:]]))
            return {'$b': len(blobs) - 1}
        if isinstance(x, dict):
            return {str(k): walk(v) for k, v in x.items()}
        if isinstance(x, (list, tuple)):
            return [walk(v) for v in x]
        if isinstance(x, (np.floating, float)):
            f = float(x)
            if math.isnan(f):
                return {'$f': 'nan'}
            if math.isinf(f):
                return {'$f': 'inf' if f > 0 else '-inf'}
            return f
        if isinstance(x, (np.integer,)):
            return int(x)
        if isinstance(x, np.bool_):
            return bool(x)
        return x

    v = walk(value)
    table, off = [], 0
    for b, dt in blobs:
        table.append([off, len(b), dt])
        off += len(b) + (-len(b)) % 8
    head = json.dumps({'v': v, 'b': table}, ensure_ascii=False, allow_nan=False).encode('utf-8')
    head += b' ' * ((-len(head)) % 8)
    out = bytearray(MAGIC + struct.pack('<I', len(head)) + head)
    for b, _ in blobs:
        out += b + b'\0' * ((-len(b)) % 8)
    return bytes(out)


def unpack(data):
    if not data:
        return {}
    if data[:4] != MAGIC:
        return revive(json.loads(data.decode('utf-8')), [])
    n = struct.unpack('<I', data[4:8])[0]
    head = json.loads(data[8:8 + n].decode('utf-8'))
    base = 8 + n
    arrays = [np.frombuffer(data, dtype=np.dtype(DT[dt]).newbyteorder('<'), count=nb // np.dtype(DT[dt]).itemsize,
                            offset=base + off).astype(DT[dt]) for off, nb, dt in head['b']]
    return revive(head['v'], arrays)


def revive(x, arrays):
    if isinstance(x, dict):
        if '$b' in x and len(x) == 1:
            return arrays[x['$b']]
        if '$f' in x and len(x) == 1:
            return float(x['$f'])
        return {k: revive(v, arrays) for k, v in x.items()}
    if isinstance(x, list):
        return [revive(v, arrays) for v in x]
    return x
