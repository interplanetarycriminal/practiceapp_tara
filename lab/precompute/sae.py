"""Features from the GPT-2 small residual-stream SAEs that ARENA uses (Joseph Bloom's gpt2-small-res-jb: 24,576
features per layer, trained on hook_resid_pre), over the same corpus as the neurons.

For each chosen layer:
  - every feature's 12 top and 6 band examples, histogram, max, mean and density, in the same formats as neurons.py;
  - the tokens its decoder direction promotes and suppresses most (its logit lens);
  - a quantised copy of the SAE for the browser (int8 in groups of 64, fp16 scales), checked against the original;
  - a health check on this corpus: explained variance and L0, which also settles one subtle point: TransformerLens
    centres GPT-2's residual stream (it subtracts each position's mean across the 768 dimensions), and these SAEs were
    trained on that. Both versions are measured and the better one is used and recorded.

Outputs (in --out, normally lab/data): sae/L{ll}/stats.bin, ex{cc}.bin.gz (1024 features each), lens.bin, sae.bin,
and sae/L{ll}/info.json. Formats as in neurons.py; lens.bin is uint16 [F, 20] tokens (10 up, 10 down) then int16
[F, 20] values x 100; sae.bin is described in info.json.

    python sae.py --sae Z:/tara-lab/data/sae --work Z:/tara-lab/work --layers 7 --lock Z:/tara-lab/gpulock.py
"""
import argparse
import hashlib
import json
import time
from pathlib import Path

import numpy as np
import torch

from common import Status, gpu_lock, load_state, save_state, write_bin
from labgpt2 import BPE, L, LabGPT2, selftest
from neurons import BAND, K_MID, K_TOP, NB, WIN, batches, keep, track

HERE = Path(__file__).resolve().parent
CHUNK_F = 1024
G = 64


def load_sae(folder, dev):
    from safetensors.torch import load_file
    folder = Path(folder)
    cfg = json.loads((folder / 'cfg.json').read_text())
    w = load_file(str(folder / 'sae_weights.safetensors'), device=dev)
    return cfg, {k: v.float() for k, v in w.items()}


def quant_rows(Wt):
    """Wt [rows, 768] -> int8 [rows, 768], fp16 scales [rows, 12], and the dequantised matrix."""
    R, I = Wt.shape
    g = Wt.reshape(R, I // G, G)
    s = (g.abs().amax(2) / 127.0).clamp_min(1e-12).half().float()
    q = (g / s[:, :, None]).round().clamp(-127, 127)
    return q.to(torch.int8).reshape(R, I), s.half(), (q * s[:, :, None]).reshape(R, I)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default=str(HERE.parent / 'model'))
    ap.add_argument('--sae', required=True, help='folder holding blocks.N.hook_resid_pre/')
    ap.add_argument('--work', required=True)
    ap.add_argument('--out', default=str(HERE.parent / 'data'))
    ap.add_argument('--layers', default='7')
    ap.add_argument('--batch', type=int, default=16)
    ap.add_argument('--chunk', type=int, default=8192, help='contexts per lock hold and state save')
    ap.add_argument('--phase-a', type=int, default=4096)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--lock', default=None)
    ap.add_argument('--device', default='cuda')
    a = ap.parse_args(argv)
    dev, work, out = a.device, Path(a.work), Path(a.out)
    hold = gpu_lock(a.lock)
    model = LabGPT2(a.model, dev)
    print('selftest: largest difference', selftest(model, BPE(Path(a.model) / 'bpe.json'), HERE / 'selftest.json'))
    ctx = np.load(work / 'contexts.npy', mmap_mode='r')
    N = min(a.limit, len(ctx)) if a.limit else len(ctx)
    WU = model.W['wte']
    gf = model.W['lnfg']
    for l in [int(x) for x in a.layers.split(',')]:
        od = out / 'sae' / f'L{l:02d}'
        if (od / 'info.json').exists():
            continue
        od.mkdir(parents=True, exist_ok=True)
        cfg, w = load_sae(Path(a.sae) / f'blocks.{l}.hook_resid_pre', dev)
        We, be, Wd, bd = w['W_enc'], w['b_enc'], w['W_dec'], w['b_dec']
        F = We.shape[1]
        sub_dec = cfg.get('apply_b_dec_to_input', True)

        def resid(ids):
            return model.forward(ids, stop=l, logits='none')                # resid_pre of layer l

        def encode(x, centre):
            if centre:
                x = x - x.mean(-1, keepdim=True)
            return torch.relu(((x - bd) if sub_dec else x) @ We + be), x

        # health check: raw vs centred residual stream
        check = {}
        with hold(), torch.no_grad():
            ids = torch.from_numpy(np.asarray(ctx[:min(256, N)], dtype=np.int64)).to(dev)
            for centre in (False, True):
                ev_num = ev_den = l0 = cnt = 0.0
                for b0 in range(0, len(ids), a.batch):
                    x = resid(ids[b0:b0 + a.batch])[:, 1:].reshape(-1, 768)
                    f, xx = encode(x, centre)
                    rec = f @ Wd + bd
                    ev_num += float(((xx - rec) ** 2).sum())
                    ev_den += float(((xx - xx.mean(0)) ** 2).sum())
                    l0 += float((f > 0).sum())
                    cnt += x.shape[0]
                check['centred' if centre else 'raw'] = {'explained_variance': round(1 - ev_num / ev_den, 4), 'l0': round(l0 / cnt, 2)}
        centre = check['centred']['explained_variance'] >= check['raw']['explained_variance']
        print(f'L{l} SAE check', check, 'using', 'centred' if centre else 'raw', flush=True)

        # quantised copy for the browser, and how close it stays
        with hold(), torch.no_grad():
            qe, se, de = quant_rows(We.T.contiguous())                          # encoder rows: one per feature
            qd, sd, dd = quant_rows(Wd)
            x = resid(ids[:a.batch])[:, 1:].reshape(-1, 768)
            f, xx = encode(x, centre)
            fq = torch.relu(((xx - bd) if sub_dec else xx) @ de.T + be)
            on, onq = f > 0, fq > 0
            qcheck = {'act_corr': round(float(torch.corrcoef(torch.stack([f.flatten(), fq.flatten()]))[0, 1]), 5),
                      'l0': round(float(on.sum(1).float().mean()), 2), 'l0_int8': round(float(onq.sum(1).float().mean()), 2),
                      'same_on_off': round(float((on == onq).float().mean()), 6),
                      'top1_feature_agree': round(float((f.argmax(1) == fq.argmax(1)).float().mean()), 4)}
        print(f'L{l} int8 check', qcheck, flush=True)
        parts, layout, off = [], {}, 0
        for name, arr in (('enc_q', qe), ('enc_s', se), ('b_enc', be), ('dec_q', qd), ('dec_s', sd), ('b_dec', bd)):
            npa = arr.cpu().numpy()
            if npa.dtype == np.float64:
                npa = npa.astype(np.float32)
            while off % 16:
                parts.append(np.zeros(1, np.uint8))
                off += 1
            layout[name] = {'offset': off, 'dtype': str(npa.dtype), 'shape': list(npa.shape)}
            parts.append(npa)
            off += npa.nbytes
        write_bin(od / 'sae.bin', *parts)

        # decoder logit lens: what each feature's direction promotes and suppresses, directly
        lens_t = np.zeros((F, 20), np.uint16)
        lens_v = np.zeros((F, 20), np.int16)
        with hold(), torch.no_grad():
            for f0 in range(0, F, 2048):
                dvec = Wd[f0:f0 + 2048]
                dvec = (dvec - dvec.mean(1, keepdim=True)) * gf
                lg = dvec @ WU.T
                up = lg.topk(10, dim=1)
                dn = lg.topk(10, dim=1, largest=False)
                lens_t[f0:f0 + 2048] = torch.cat([up.indices, dn.indices], 1).cpu().numpy()
                lens_v[f0:f0 + 2048] = np.clip(np.round(torch.cat([up.values, dn.values], 1).cpu().numpy() * 100), -32767, 32767)
        write_bin(od / 'lens.bin', lens_t, lens_v)

        # examples, histogram, density over the corpus (resumable)
        state_path = work / f'sae{l:02d}.state.pt'
        status = Status(work, f'sae L{l}')
        st = load_state(state_path, dev)
        if st is None:
            mx = torch.full((F,), -1e9, device=dev)
            with hold(), torch.no_grad():
                for ids in batches(ctx, 0, min(a.phase_a, N), a.batch, dev):
                    f, _ = encode(resid(ids), centre)
                    mx = torch.maximum(mx, f[:, 1:].amax((0, 1)))
            z = lambda *s, dt=torch.float32, v=0: torch.full(s, v, dtype=dt, device=dev)
            st = {'next': 0, 'ntok': 0, 'maxA': mx[None],
                  'top_v': z(1, K_TOP, F, v=-1e9), 'top_tok': z(1, K_TOP, F, WIN, dt=torch.int32),
                  'top_act': z(1, K_TOP, F, WIN, dt=torch.float16), 'top_pk': z(1, K_TOP, F, dt=torch.uint8),
                  'mid_k': z(1, K_MID, F, v=2.0), 'mid_v': z(1, K_MID, F), 'mid_tok': z(1, K_MID, F, WIN, dt=torch.int32),
                  'mid_act': z(1, K_MID, F, WIN, dt=torch.float16), 'mid_pk': z(1, K_MID, F, dt=torch.uint8),
                  'hist': z(1, F, NB + 1, dt=torch.int64), 'sum': z(1, F, dt=torch.float64), 'max': z(1, F, v=-1e9)}
            save_state(state_path, st)
        gen = torch.Generator(device=dev)
        while st['next'] < N:
            lo, hi = st['next'], min(N, st['next'] + a.chunk)
            gen.manual_seed(5000 + lo)
            with hold(), torch.no_grad():
                for ids in batches(ctx, lo, hi, a.batch, dev):
                    f, _ = encode(resid(ids), centre)
                    track(st, 0, f, ids, gen, st['maxA'][0])
                    st['ntok'] += ids.shape[0] * (ids.shape[1] - 1)
                if dev == 'cuda':
                    torch.cuda.synchronize()
            st['next'] = hi
            save_state(state_path, st)
            status(hi, N, f'{st["ntok"] / 1e6:.1f}M tokens')
        ntok = st['ntok']
        hist = st['hist'][0]
        fstats = torch.stack([st['max'][0].double(), st['sum'][0] / ntok, 1.0 - hist[:, NB].double() / ntok,
                              st['maxA'][0].double()], 1).float().cpu().numpy()
        write_bin(od / 'stats.bin', fstats, hist.cpu().numpy().astype(np.uint32))
        empty = st['mid_k'][0] > 1.0
        vals = torch.cat([st['top_v'][0], torch.where(empty, torch.zeros_like(st['mid_v'][0]), st['mid_v'][0])])
        toks = torch.cat([st['top_tok'][0], torch.where(empty[..., None], 0, st['mid_tok'][0])])
        acts = torch.cat([st['top_act'][0], torch.where(empty[..., None], torch.zeros((), dtype=torch.float16, device=dev), st['mid_act'][0])])
        pks = torch.cat([st['top_pk'][0], torch.where(empty, torch.zeros((), dtype=torch.uint8, device=dev), st['mid_pk'][0])])
        scale = st['top_v'][0][0].clamp_min(1e-6)
        a8 = (acts.float() / scale[None, :, None] * 255).round().clamp(0, 255).to(torch.uint8).permute(1, 0, 2).cpu().numpy()
        toks = toks.permute(1, 0, 2).cpu().numpy().astype(np.uint16)
        pks = pks.permute(1, 0).cpu().numpy()
        vals = vals.clamp_min(0).permute(1, 0).cpu().numpy().astype(np.float16)
        for c in range((F + CHUNK_F - 1) // CHUNK_F):
            s = slice(c * CHUNK_F, (c + 1) * CHUNK_F)
            write_bin(od / f'ex{c:02d}.bin.gz', toks[s], a8[s], pks[s], vals[s], gz=True)
        info = {'source': 'jbloom/GPT2-Small-SAEs-Reformatted (SAELens release gpt2-small-res-jb)',
                'hook': f'blocks.{l}.hook_resid_pre', 'd_sae': F, 'cfg': {k: cfg[k] for k in cfg if isinstance(cfg[k], (int, float, str, bool))},
                'centred_input': bool(centre), 'apply_b_dec_to_input': bool(sub_dec), 'check': check, 'int8_check': qcheck,
                'sae_bin': layout, 'sae_sha256': hashlib.sha256((od / 'sae.bin').read_bytes()).hexdigest(), 'group': G, 'corpus_contexts': N, 'tokens': ntok,
                'examples': {'k_top': K_TOP, 'k_mid': K_MID, 'window': WIN, 'band': list(BAND), 'bins': NB, 'chunk': CHUNK_F},
                'neuronpedia': f'https://www.neuronpedia.org/gpt2-small/{l}-res-jb/'}
        (od / 'info.json').write_text(json.dumps(info, indent=1))
        status(N, N, f'layer {l} written')


if __name__ == '__main__':
    main()
