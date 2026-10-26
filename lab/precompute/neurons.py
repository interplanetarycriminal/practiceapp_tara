"""Neuron statistics over the corpus, for all 36,864 MLP neurons of GPT-2 small (12 layers x 3072).

For every neuron:
  - its 12 top-activating contexts (at most one per context) and 6 random contexts whose peak falls in the 25-60%
    band of its maximum, each kept as a 24-token window around the peak with the neuron's activation on every token.
    The band examples show what the neuron does at ordinary strength, not only at its most extreme;
  - a histogram of its activation (16 bins from 0 to its scale, plus one bin for "off", <= 0), its mean and maximum;
  - its 16 strongest co-firing partners in the same layer (Pearson correlation over a subsample of tokens).
Also the residual stream's norm at every layer, which sets the lab's steering unit (neuron-explorer's "rel" unit).
The <|endoftext|> position at the start of every context is left out of all statistics.

Resumable: the state is saved after every chunk, and rerunning continues where it stopped.

Outputs (in --out, normally lab/data):
  neurons/L{ll}.stats.bin    float32 [3072, 4]: max, mean, share of tokens where it is on (> 0), histogram scale;
                             then uint32 [3072, 17]: bins i/16..(i+1)/16 of the scale (the last also holds anything
                             above), and bin 16 = tokens where it is off
  neurons/L{ll}.ex{c}.bin.gz neurons 768c..768c+767, 18 examples each (12 top, then 6 band; an empty slot has value 0):
                             uint16 tokens [768, 18, 24], uint8 activation per token [768, 18, 24] (255 = the
                             neuron's top value, <= 0 shows as 0), uint8 peak index [768, 18], float16 peak value [768, 18]
  neurons/L{ll}.cofire.bin   uint16 [3072, 16] partner in the same layer, int16 [3072, 16] correlation x 10000
  stats.json                 corpus, residual norms per layer, settings

    python neurons.py --work Z:/tara-lab/work --lock Z:/tara-lab/gpulock.py
"""
import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch

from common import Status, gpu_lock, load_state, save_state, write_bin
from labgpt2 import BPE, L, M, LabGPT2, selftest

HERE = Path(__file__).resolve().parent
K_TOP, K_MID, WIN, BEFORE = 12, 6, 24, 18
BAND = (0.25, 0.60)
NB = 16
K_CO = 16
CHUNK_NEURONS = 768
NORM_HOOKS = ('resid_pre', 'resid_mid', 'resid_post', 'attn_out', 'mlp_out')


def batches(ctx, lo, hi, bs, dev):
    for b0 in range(lo, hi, bs):
        yield torch.from_numpy(np.asarray(ctx[b0:min(hi, b0 + bs)], dtype=np.int64)).to(dev)


def phase_a(model, ctx, n, bs, dev, hold, n_norm):
    """Each neuron's maximum over the first n contexts (sets its band and histogram scale) and residual norms."""
    mx = torch.full((L, M), -1e9, device=dev)
    norms = {k: [[] for _ in range(L)] for k in NORM_HOOKS}
    seen = [0]

    def hook(name, l, t):
        if name == 'mlp_post':
            mx[l] = torch.maximum(mx[l], t[:, 1:].amax((0, 1)))
        elif name in norms and seen[0] < n_norm:
            norms[name][l].append(t[:, 1:].norm(dim=-1).flatten())
    with hold(), torch.no_grad():
        for ids in batches(ctx, 0, n, bs, dev):
            model.forward(ids, hook=hook, logits='none')
            seen[0] += len(ids)
    out = {}
    for k, per in norms.items():
        qs = [torch.quantile(torch.cat(v)[:1_000_000].float(), torch.tensor([0.1, 0.5, 0.9], device=dev)).tolist() for v in per]
        out[k] = {'p10': [round(q[0], 3) for q in qs], 'p50': [round(q[1], 3) for q in qs], 'p90': [round(q[2], 3) for q in qs]}
    return mx, out


def new_state(maxA, norms, dev):
    z = lambda *s, dt=torch.float32, v=0: torch.full(s, v, dtype=dt, device=dev)
    return {
        'next': 0, 'ntok': 0, 'maxA': maxA, 'norms': norms,
        'top_v': z(L, K_TOP, M, v=-1e9), 'top_tok': z(L, K_TOP, M, WIN, dt=torch.int32),
        'top_act': z(L, K_TOP, M, WIN, dt=torch.float16), 'top_pk': z(L, K_TOP, M, dt=torch.uint8),
        'mid_k': z(L, K_MID, M, v=2.0), 'mid_v': z(L, K_MID, M), 'mid_tok': z(L, K_MID, M, WIN, dt=torch.int32),
        'mid_act': z(L, K_MID, M, WIN, dt=torch.float16), 'mid_pk': z(L, K_MID, M, dt=torch.uint8),
        'hist': z(L, M, NB + 1, dt=torch.int64), 'sum': z(L, M, dt=torch.float64), 'max': z(L, M, v=-1e9),
    }


def keep(st, kind, l, key, largest, val, w_tok, w_act, pk):
    """Merge one batch of candidates into the running best K of one kind ('top' or 'mid') for layer l."""
    old_key = st['top_v'][l] if kind == 'top' else st['mid_k'][l]
    K = old_key.shape[0]
    cand = torch.cat([old_key, key])
    sel = cand.topk(K, dim=0, largest=largest).indices                      # [K, n]
    if kind == 'mid':
        st['mid_k'][l] = cand.gather(0, sel)
        st['mid_v'][l] = torch.cat([st['mid_v'][l], val]).gather(0, sel)
    else:
        st['top_v'][l] = cand.gather(0, sel)
    sel3 = sel[:, :, None].expand(-1, -1, WIN)
    st[kind + '_tok'][l] = torch.cat([st[kind + '_tok'][l], w_tok]).gather(0, sel3)
    st[kind + '_act'][l] = torch.cat([st[kind + '_act'][l], w_act]).gather(0, sel3)
    st[kind + '_pk'][l] = torch.cat([st[kind + '_pk'][l], pk]).gather(0, sel)


def track(st, l, t, ids, gen, scale):
    """Update every statistic with one layer's activations t [B, T, n] (position 0 is <|endoftext|>)."""
    B, T, n = t.shape
    dev = t.device
    a = t[:, 1:]
    flat = a.reshape(-1, n)
    bins = (flat / scale.clamp_min(1e-6) * NB).floor().clamp_(0, NB - 1)
    bins = torch.where(flat > 0, bins, torch.full_like(bins, NB)).long()
    bins += torch.arange(n, device=dev) * (NB + 1)
    st['hist'][l] += torch.bincount(bins.view(-1), minlength=n * (NB + 1)).view(n, NB + 1)
    st['sum'][l] += flat.sum(0, dtype=torch.float64)
    mx, arg = a.max(1)                                                     # [B, n] each context's peak
    st['max'][l] = torch.maximum(st['max'][l], mx.max(0).values)
    p = arg + 1
    start = (p - BEFORE).clamp(1, T - WIN)
    widx = start[..., None] + torch.arange(WIN, device=dev)               # [B, n, WIN]
    w_act = t.transpose(1, 2).gather(2, widx).half()
    w_tok = ids[:, None, :].expand(B, n, T).gather(2, widx).int()
    pk = (p - start).to(torch.uint8)
    keep(st, 'top', l, mx, True, mx, w_tok, w_act, pk)
    lo, hi = BAND[0] * scale, BAND[1] * scale
    key = torch.rand(B, n, device=dev, generator=gen)
    key = torch.where((mx >= lo) & (mx <= hi), key, torch.full_like(key, 2.0))
    keep(st, 'mid', l, key, False, mx, w_tok, w_act, pk)


def cofire(model, ctx, n, bs, dev, hold):
    S = torch.zeros(L, M, dtype=torch.float64, device=dev)
    SS = torch.zeros(L, M, M, dtype=torch.float64, device=dev)
    cnt = [0]

    def hook(name, l, t):
        if name == 'mlp_post':
            a = t[:, 1:].reshape(-1, M)
            S[l] += a.sum(0, dtype=torch.float64)
            SS[l] += (a.T @ a).double()
            if l == 0:
                cnt[0] += a.shape[0]
    with hold(), torch.no_grad():
        for ids in batches(ctx, 0, n, bs, dev):
            model.forward(ids, hook=hook, logits='none')
    idx, val = [], []
    for l in range(L):
        mu = S[l] / cnt[0]
        cov = SS[l] / cnt[0] - mu[:, None] * mu[None]
        sd = cov.diagonal().clamp_min(1e-12).sqrt()
        cor = (cov / sd[:, None] / sd[None]).float().nan_to_num_(0.0)
        cor.fill_diagonal_(-2.0)
        v, i = cor.topk(K_CO, dim=1)
        idx.append(i.cpu().numpy().astype(np.uint16))
        val.append(np.round(v.clamp(-1, 1).cpu().numpy() * 10000).astype(np.int16))
    return idx, val


def write_outputs(st, co, out, info):
    nd = Path(out) / 'neurons'
    nd.mkdir(parents=True, exist_ok=True)
    ntok = st['ntok']
    for l in range(L):
        hist = st['hist'][l]
        frac_on = 1.0 - hist[:, NB].double() / ntok
        mean = st['sum'][l] / ntok
        f = torch.stack([st['max'][l].double(), mean, frac_on, st['maxA'][l].double()], 1).float().cpu().numpy()
        write_bin(nd / f'L{l:02d}.stats.bin', f, hist.cpu().numpy().astype(np.uint32))
        empty = st['mid_k'][l] > 1.0                                        # band slots never filled
        vals = torch.cat([st['top_v'][l], torch.where(empty, torch.zeros_like(st['mid_v'][l]), st['mid_v'][l])])
        toks = torch.cat([st['top_tok'][l], torch.where(empty[..., None], 0, st['mid_tok'][l])])
        acts = torch.cat([st['top_act'][l], torch.where(empty[..., None], torch.zeros((), dtype=torch.float16, device=empty.device), st['mid_act'][l])])
        pks = torch.cat([st['top_pk'][l], torch.where(empty, torch.zeros((), dtype=torch.uint8, device=empty.device), st['mid_pk'][l])])
        scale = st['top_v'][l][0].clamp_min(1e-6)                             # [n] the neuron's top value
        a8 = (acts.float() / scale[None, :, None] * 255).round().clamp(0, 255).to(torch.uint8)
        # [18, n, ...] -> [n, 18, ...]
        toks = toks.permute(1, 0, 2).cpu().numpy().astype(np.uint16)
        a8 = a8.permute(1, 0, 2).cpu().numpy()
        pks = pks.permute(1, 0).cpu().numpy()
        vals = vals.clamp_min(0).permute(1, 0).cpu().numpy().astype(np.float16)
        for c in range(M // CHUNK_NEURONS):
            s = slice(c * CHUNK_NEURONS, (c + 1) * CHUNK_NEURONS)
            write_bin(nd / f'L{l:02d}.ex{c}.bin.gz', toks[s], a8[s], pks[s], vals[s], gz=True)
        write_bin(nd / f'L{l:02d}.cofire.bin', co[0][l], co[1][l])
    stats_path = Path(out) / 'stats.json'
    stats = json.loads(stats_path.read_text()) if stats_path.exists() else {}
    stats.update(info)
    stats_path.write_text(json.dumps(stats, indent=1))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default=str(HERE.parent / 'model'))
    ap.add_argument('--work', required=True, help='folder with contexts.npy; state and status go here too')
    ap.add_argument('--out', default=str(HERE.parent / 'data'))
    ap.add_argument('--batch', type=int, default=64)
    ap.add_argument('--chunk', type=int, default=8192, help='contexts per lock hold and state save')
    ap.add_argument('--phase-a', type=int, default=12288, help='contexts used to set each neuron scale')
    ap.add_argument('--norm-contexts', type=int, default=2048)
    ap.add_argument('--cofire', type=int, default=4096, help='contexts used for co-firing')
    ap.add_argument('--limit', type=int, default=0, help='use only the first N contexts (smoke tests)')
    ap.add_argument('--lock', default=None)
    ap.add_argument('--device', default='cuda')
    a = ap.parse_args(argv)
    dev, work = a.device, Path(a.work)
    hold = gpu_lock(a.lock)
    model = LabGPT2(a.model, dev)
    print('selftest: largest difference', selftest(model, BPE(Path(a.model) / 'bpe.json'), HERE / 'selftest.json'))
    ctx = np.load(work / 'contexts.npy', mmap_mode='r')
    N = min(a.limit, len(ctx)) if a.limit else len(ctx)
    state_path = work / 'neurons.state.pt'
    status = Status(work, 'neurons')
    st = load_state(state_path, dev)
    if st is None:
        t0 = time.time()
        maxA, norms = phase_a(model, ctx, min(a.phase_a, N), a.batch, dev, hold, a.norm_contexts)
        st = new_state(maxA, norms, dev)
        save_state(state_path, st)
        print(f'phase A done in {time.time() - t0:.0f}s')
    gen = torch.Generator(device=dev)
    while st['next'] < N:
        lo, hi = st['next'], min(N, st['next'] + a.chunk)
        gen.manual_seed(1000 + lo)
        with hold(), torch.no_grad():
            for ids in batches(ctx, lo, hi, a.batch, dev):
                model.forward(ids, hook=lambda name, l, t: track(st, l, t, ids, gen, st['maxA'][l]) if name == 'mlp_post' else None,
                              logits='none')
                st['ntok'] += ids.shape[0] * (ids.shape[1] - 1)
            if dev == 'cuda':
                torch.cuda.synchronize()
        st['next'] = hi
        save_state(state_path, st)
        status(hi, N, f'{st["ntok"] / 1e6:.1f}M tokens')
    co = cofire(model, ctx, min(a.cofire, N), a.batch, dev, hold)
    cinfo = json.loads((work / 'contexts.json').read_text()) if (work / 'contexts.json').exists() else {}
    info = {'corpus': cinfo, 'resid_norm': st['norms'],
            'neurons': {'contexts': N, 'tokens': st['ntok'], 'k_top': K_TOP, 'k_mid': K_MID, 'window': WIN, 'before': BEFORE,
                        'band': list(BAND), 'bins': NB, 'cofire_contexts': min(a.cofire, N), 'k_cofire': K_CO,
                        'chunk_neurons': CHUNK_NEURONS}}
    write_outputs(st, co, a.out, info)
    status(N, N, 'written')


if __name__ == '__main__':
    main()
