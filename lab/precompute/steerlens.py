"""Steer lens: what pushing each neuron does to the next-token prediction, through every layer after it.

For each neuron and sign, adds +-0.8 x (the median residual norm after its layer) along the neuron's write direction
at every position of four short prompts, runs the rest of the model, and compares the last position's
log-probabilities with the unsteered run. Keeps, per neuron and sign, the 12 tokens whose log-probability rises most
(averaged over the prompts) and the KL divergence of the pushed prediction from the unpushed one. This is
neuron-explorer's steer lens, done again on GPT-2 small; unlike the logit lens (weights only, direct path) it includes
everything the later layers do with the push.

Output (in --out, normally lab/data): steer/L{ll}.bin = uint16 tokens [3072, 2, 12] (sign 0 = pushed up, 1 = pushed
down), float16 rise in log-probability [3072, 2, 12], float16 KL [3072, 2]. Settings go into stats.json under "steer".

    python steerlens.py --lock Z:/tara-lab/gpulock.py
"""
import argparse
import json
from pathlib import Path

import numpy as np
import torch

from common import Status, gpu_lock, write_bin
from labgpt2 import BOS, BPE, L, M, LabGPT2

HERE = Path(__file__).resolve().parent
PROMPTS = ['I think the most important thing to remember is', 'Today we are going to talk about',
           'Once upon a time,', 'The best thing about']
DOSE = 0.8
K = 12


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default=str(HERE.parent / 'model'))
    ap.add_argument('--out', default=str(HERE.parent / 'data'))
    ap.add_argument('--work', default='.', help='status.json goes here')
    ap.add_argument('--chunk', type=int, default=256, help='neurons per forward pass (x2 signs)')
    ap.add_argument('--layers', default='0-11')
    ap.add_argument('--neurons', type=int, default=M, help='only the first N neurons (smoke tests)')
    ap.add_argument('--lock', default=None)
    ap.add_argument('--device', default='cuda')
    a = ap.parse_args(argv)
    dev, out = a.device, Path(a.out)
    lo, _, hi = a.layers.partition('-')
    layers = list(range(int(lo), int(hi or lo) + 1))
    stats = json.loads((out / 'stats.json').read_text())
    rnorm = stats['resid_norm']['resid_post']['p50']
    model = LabGPT2(a.model, dev)
    tok = BPE(Path(a.model) / 'bpe.json')
    hold = gpu_lock(a.lock)
    status = Status(a.work, 'steerlens')
    prompts = [torch.tensor([[BOS] + tok.encode(p)], device=dev) for p in PROMPTS]
    sign = torch.tensor([1.0, -1.0], device=dev)
    for l in layers:
        path = out / 'steer' / f'L{l:02d}.bin'
        if path.exists():
            continue
        NN = a.neurons
        U = model.wout_unit(l)[:NN]                                         # [NN, D]
        push = DOSE * rnorm[l]
        toks = np.zeros((NN, 2, K), np.uint16)
        rise = np.zeros((NN, 2, K), np.float16)
        kls = np.zeros((NN, 2), np.float16)
        with hold(), torch.no_grad():
            base = []
            for ids in prompts:
                x = model.forward(ids, stop=l + 1, logits='none')               # resid_post of layer l
                lp = torch.log_softmax(model.forward(None, x=x, start=l + 1), -1)
                base.append((x, lp))
            for n0 in range(0, NN, a.chunk):
                C = min(a.chunk, NN - n0)
                vec = (sign[:, None, None] * push * U[n0:n0 + C][None]).reshape(2 * C, -1)   # [2C, D], sign-major
                acc = None
                kl = 0
                for x, lp0 in base:
                    X = x.expand(2 * C, -1, -1) + vec[:, None, :]
                    lp = torch.log_softmax(model.forward(None, x=X, start=l + 1), -1)   # [2C, V]
                    d = lp - lp0
                    acc = d if acc is None else acc + d
                    kl = kl + (lp.exp() * d).sum(-1)
                acc /= len(base)
                kl = kl / len(base)
                v, i = acc.topk(K, dim=-1)
                i = i.view(2, C, K).permute(1, 0, 2).cpu().numpy()
                v = v.view(2, C, K).permute(1, 0, 2).cpu().numpy()
                toks[n0:n0 + C] = i
                rise[n0:n0 + C] = v
                kls[n0:n0 + C] = kl.view(2, C).T.cpu().numpy()
        write_bin(path, toks, rise, kls)
        status(layers.index(l) + 1, len(layers), f'layer {l}')
    stats = json.loads((out / 'stats.json').read_text())
    stats['steer'] = {'prompts': PROMPTS, 'dose': DOSE, 'unit': 'median resid_post norm of the layer', 'k': K,
                      'positions': 'all, including <|endoftext|>'}
    (out / 'stats.json').write_text(json.dumps(stats, indent=1))


if __name__ == '__main__':
    main()
