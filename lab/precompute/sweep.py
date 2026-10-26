"""Steering sweep: push every neuron and keep what the model then writes.

neuron-explorer's design "main_rel", adapted to a base model: three prompts x pushes of -0.7, +0.5 and +0.8, and a
free run (just <|endoftext|>) at +3, in units of the median residual norm after the neuron's layer, along the
neuron's write direction, at every position. Greedy decoding, 40 new tokens. Plus one unsteered baseline per prompt,
and 256 random-direction controls per layer that get the same ten rollouts: the null for "how often does a theme
appear when the pushed direction means nothing".

Outputs (in --out, normally lab/data):
  sweep/L{ll}.bin.gz  uint16 tokens [3072 + 256, 10, 40] (the layer's neurons, then its controls),
                      float16 mean log-probability of the chosen tokens [3328, 10]
  sweep/base.json     the baselines; settings go into stats.json under "sweep"

    python sweep.py --lock Z:/tara-lab/gpulock.py
"""
import argparse
import json
from pathlib import Path

import numpy as np
import torch

from common import Status, gpu_lock, write_bin
from labgpt2 import BOS, BPE, L, M, LabGPT2

HERE = Path(__file__).resolve().parent
PROMPTS = {'who': 'Hello, my name is', 'code': 'Here is a simple Python program:\n\n', 'orange': 'The color orange is',
           'free': ''}
DESIGN = [(p, d) for p in ('who', 'code', 'orange') for d in (-0.7, 0.5, 0.8)] + [('free', 3.0)]
NEW = 40
CONTROLS = 256


def rollouts(model, prompt_ids, vecs, layer, new, dev):
    """Greedy continuations of one prompt, one row per push vector (vecs [R, D], added to the residual stream after
    `layer` at every position). Returns tokens [R, new] and the mean log-probability of the chosen tokens [R]."""
    R = vecs.shape[0]
    T0 = len(prompt_ids)
    cache = model.new_cache(R, T0 + new)

    def hook(name, l, t):
        if name == 'resid_post' and l == layer:
            return t + vecs[:, None, :]
    ids = torch.tensor(prompt_ids, device=dev)[None].expand(R, -1)
    out = torch.zeros(R, new, dtype=torch.int64, device=dev)
    lps = torch.zeros(R, device=dev)
    lg = model.forward(ids, hook=hook, cache=cache, pos0=0)
    for s in range(new):
        lp = torch.log_softmax(lg, -1)
        nxt = lp.argmax(-1)
        out[:, s] = nxt
        lps += lp.gather(1, nxt[:, None])[:, 0]
        if s == new - 1:
            break
        lg = model.forward(nxt[:, None], hook=hook, cache=cache, pos0=T0 + s)
    return out, lps / new


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default=str(HERE.parent / 'model'))
    ap.add_argument('--out', default=str(HERE.parent / 'data'))
    ap.add_argument('--work', default='.', help='status.json goes here')
    ap.add_argument('--batch', type=int, default=512, help='rows per generation batch')
    ap.add_argument('--layers', default='0-11')
    ap.add_argument('--neurons', type=int, default=M, help='only the first N neurons (smoke tests)')
    ap.add_argument('--controls', type=int, default=CONTROLS)
    ap.add_argument('--new', type=int, default=NEW)
    ap.add_argument('--lock', default=None)
    ap.add_argument('--device', default='cuda')
    a = ap.parse_args(argv)
    dev, out = a.device, Path(a.out)
    lo, _, hi = a.layers.partition('-')
    layers = list(range(int(lo), int(hi or lo) + 1))
    rnorm = json.loads((out / 'stats.json').read_text())['resid_norm']['resid_post']['p50']
    model = LabGPT2(a.model, dev)
    tok = BPE(Path(a.model) / 'bpe.json')
    hold = gpu_lock(a.lock)
    status = Status(a.work, 'sweep')
    pids = {k: [BOS] + tok.encode(v) for k, v in PROMPTS.items()}
    (out / 'sweep').mkdir(parents=True, exist_ok=True)
    base_path = out / 'sweep' / 'base.json'
    if not base_path.exists():
        with hold(), torch.no_grad():
            base = {}
            for k, ids in pids.items():
                t, lp = rollouts(model, ids, torch.zeros(1, 768, device=dev), 0, a.new, dev)
                base[k] = {'prompt': PROMPTS[k], 'ids': ids, 'tokens': t[0].tolist(), 'text': tok.decode(t[0].tolist()),
                           'mean_logprob': round(float(lp[0]), 4)}
        base_path.write_text(json.dumps(base, indent=1))
    for l in layers:
        path = out / 'sweep' / f'L{l:02d}.bin.gz'
        if path.exists():
            continue
        U = model.wout_unit(l)[:a.neurons]                                  # [N, D]
        g = np.random.default_rng(7000 + l).standard_normal((a.controls, U.shape[1])).astype(np.float32)
        Cv = torch.from_numpy(g / np.linalg.norm(g, axis=1, keepdims=True)).to(dev)
        units = torch.cat([U, Cv])                                          # [N + controls, D]
        NU = units.shape[0]
        toks = np.zeros((NU, len(DESIGN), a.new), np.uint16)
        lps = np.zeros((NU, len(DESIGN)), np.float16)
        for p in PROMPTS:
            cols = [j for j, (pp, _) in enumerate(DESIGN) if pp == p]
            rows = [(u, j) for j in cols for u in range(NU)]
            for b0 in range(0, len(rows), a.batch):
                part = rows[b0:b0 + a.batch]
                ui = torch.tensor([u for u, _ in part], device=dev)
                dose = torch.tensor([DESIGN[j][1] for _, j in part], device=dev)
                vecs = units[ui] * (dose * rnorm[l])[:, None]
                with hold(), torch.no_grad():
                    t, lp = rollouts(model, pids[p], vecs, l, a.new, dev)
                t, lp = t.cpu().numpy(), lp.cpu().numpy()
                for r, (u, j) in enumerate(part):
                    toks[u, j] = t[r]
                    lps[u, j] = lp[r]
            status(layers.index(l) + 1, len(layers), f'layer {l} prompt {p}')
        write_bin(path, toks, lps, gz=True)
    stats = json.loads((out / 'stats.json').read_text())
    stats['sweep'] = {'prompts': PROMPTS, 'design': DESIGN, 'new_tokens': a.new, 'decoding': 'greedy',
                      'unit': 'median resid_post norm of the layer, along the unit write direction', 'controls': a.controls,
                      'neurons': a.neurons, 'positions': 'all, prompt and generated, including <|endoftext|>'}
    (out / 'stats.json').write_text(json.dumps(stats, indent=1))


if __name__ == '__main__':
    main()
