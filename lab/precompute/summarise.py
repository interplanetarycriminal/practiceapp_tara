"""Small derived files for the lab's lists and cards. CPU only, a few seconds.

  - the peak token of each unit's three strongest passages, so a list of neurons or SAE features can say what each
    one fires on without loading its examples;
  - for each SAE feature, the average over the vocabulary of its decoder lens (the logit its direction adds to the
    average word), so the browser can show the lens relative to the average word, in the same units as a neuron's
    "What it writes" (the stored lens.bin keeps the raw values Neuronpedia lists).

Outputs (in --out, normally lab/data):
  neurons/peaks.bin       uint16 [12 * 3072, 3], layer-major (neuron l * 3072 + n)
  sae/L{ll}/peaks.bin     uint16 [F, 3]
  sae/L{ll}/lensmean.bin  float32 [F]
65535 marks an empty slot (a unit with fewer than three passages).

    python summarise.py
"""
import argparse
import gzip
import json
from pathlib import Path

import numpy as np

from common import write_bin
from labgpt2 import load_weights

HERE = Path(__file__).resolve().parent
TOPS, NONE = 3, 65535


def peaks(path, n, K, win):
    """The peak token of the first TOPS examples of each of n units in one example file (format in neurons.py)."""
    b = gzip.decompress(path.read_bytes())
    o = 0
    toks = np.frombuffer(b, np.uint16, n * K * win, o).reshape(n, K, win)
    o += toks.nbytes + n * K * win                                          # then the uint8 activations
    pk = np.frombuffer(b, np.uint8, n * K, o).reshape(n, K)
    o += pk.nbytes
    val = np.frombuffer(b, np.float16, n * K, o).reshape(n, K)
    out = np.full((n, TOPS), NONE, np.uint16)
    rows = np.arange(n)
    for j in range(TOPS):
        out[:, j] = np.where(val[:, j] > 0, toks[rows, j, np.minimum(pk[:, j], win - 1)], NONE)
    return out


def lens_mean(d, info, mu_u, gf):
    """Per feature: the mean over the vocabulary of W_U (gf * centre(dec)), from the int8 decoder in sae.bin."""
    lay, b = info['sae_bin'], (d / 'sae.bin').read_bytes()
    arr = lambda k: np.frombuffer(b, np.dtype(lay[k]['dtype']), int(np.prod(lay[k]['shape'])), lay[k]['offset']).reshape(lay[k]['shape'])
    q, sc = arr('dec_q').astype(np.float32), arr('dec_s').astype(np.float32)
    F, D = q.shape
    dec = (q.reshape(F, -1, info.get('group', 64)) * sc[:, :, None]).reshape(F, D)
    return (((dec - dec.mean(1, keepdims=True)) * gf) @ mu_u).astype(np.float32)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=str(HERE.parent / 'data'))
    ap.add_argument('--model', default=str(HERE.parent / 'model'))
    a = ap.parse_args(argv)
    out = Path(a.out)
    stats = json.loads((out / 'stats.json').read_text())
    if 'neurons' in stats:
        c = stats['neurons']
        K, win, chunk = c['k_top'] + c['k_mid'], c['window'], c['chunk_neurons']
        parts = [peaks(out / 'neurons' / f'L{l:02d}.ex{i}.bin.gz', chunk, K, win) for l in range(12) for i in range(3072 // chunk)]
        write_bin(out / 'neurons' / 'peaks.bin', np.concatenate(parts))
        print('neurons/peaks.bin written')
    saes = sorted((out / 'sae').glob('L*')) if (out / 'sae').exists() else []
    if saes:
        W = load_weights(a.model, 'cpu')
        mu_u, gf = W['wte'].mean(0).numpy(), W['lnfg'].numpy()
    for d in saes:
        info = json.loads((d / 'info.json').read_text())
        write_bin(d / 'lensmean.bin', lens_mean(d, info, mu_u, gf))
        ex, F = info['examples'], info['d_sae']
        K, win, chunk = ex['k_top'] + ex['k_mid'], ex['window'], ex['chunk']
        parts = [peaks(d / f'ex{i:02d}.bin.gz', min(chunk, F - i * chunk), K, win) for i in range((F + chunk - 1) // chunk)]
        write_bin(d / 'peaks.bin', np.concatenate(parts))
        print(f'{d.name}/peaks.bin written')


if __name__ == '__main__':
    main()
