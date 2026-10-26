"""Steering with a dose curve and controls.

Push the residual stream along one direction at one or more layers, at a ladder of doses, and measure a behaviour
metric at each dose. Doses are in units of the layer's median residual norm (1.0 = a push as long as a typical
residual vector), the convention of Lyra's neuron-explorer sweeps. The same ladder is run for norm-matched random
directions, which is the bar a real direction has to clear, and the cost is read as the rise in loss on neutral
text. Directions come from a contrast (difference of means, as in Rimsky et al.'s contrastive activation addition),
an SAE feature's decoder column, or a direction saved by a probe pack."""
import json

import numpy as np
import torch

from ..common import layer_list, say, seed_all
from ..data import labelled, texts
from ..metrics import Metric
from ..packs import claim
from ..sae import TopKSAE, dictionary_spec
from ..stats import auc, bootstrap_ci


def get_direction(lm, d, ctx):
    src = d.get('from', 'contrast')
    L = layer_list(d.get('layer', lm.n_layers // 2), lm.n_layers)[0]
    if src == 'contrast':
        if 'dataset' in d:
            xs, ys = labelled(d['dataset'], d.get('seed', 0))
            pos = [x for x, y in zip(xs, ys) if y == 1]
            neg = [x for x, y in zip(xs, ys) if y == 0]
        else:
            pos, neg = texts(d['positive']), texts(d['negative'])
        fmt, pool = d.get('format', 'raw'), d.get('pool', 'last')
        P = lm.pooled(lm.encode(pos, fmt), [L], pool)[L]
        N = lm.pooled(lm.encode(neg, fmt), [L], pool)[L]
        raw = P.mean(0) - N.mean(0)
        unit = raw / raw.norm()
        sep = auc(np.concatenate([(P @ unit).numpy(), (N @ unit).numpy()]), [1] * len(P) + [0] * len(N))
        info = {'from': 'contrast', 'layer': L, 'pool': pool, 'format': fmt, 'n_positive': len(P), 'n_negative': len(N),
                'train_auc': sep, 'note': 'train_auc is measured on the same examples that built the direction'}
    elif src == 'sae':
        ds = dictionary_spec(d['dictionary'], L)
        sae = TopKSAE.load(ds['repo'], L, ds.get('k'), ds.get('revision'), 'cpu')
        raw = sae.direction(int(d['feature'])).float()
        info = {'from': 'sae', 'layer': L, 'feature': int(d['feature']), 'dictionary': sae.meta}
    elif src == 'pack':
        pdir = ctx.root / 'packs' / d['pack']
        meta = json.loads((pdir / 'pack.json').read_text(encoding='utf-8'))
        arr = meta['arrays'][d.get('array', 'dirs_dm')]
        a = np.fromfile(pdir / arr['file'], dtype={'f16': np.float16, 'f32': np.float32}[arr['dtype']])
        a = a.reshape(arr['shape'])
        row = meta['data']['layers'].index(L) if 'layers' in meta['data'] else L
        raw = torch.tensor(a[row], dtype=torch.float32)
        info = {'from': 'pack', 'pack': d['pack'], 'array': d.get('array', 'dirs_dm'), 'layer': L}
    elif src == 'random':
        g = torch.Generator().manual_seed(int(d.get('seed', 0)))
        raw = torch.randn(lm.d_model, generator=g)
        info = {'from': 'random', 'layer': L}
    else:
        raise ValueError(f'unknown direction source {src!r}')
    raw = raw.float().cpu()
    return raw / raw.norm(), float(raw.norm()), info


def run(spec, ctx):
    lm = ctx.load(spec['model'])
    seed = spec.get('seed', 0)
    seed_all(seed)
    unit, raw_norm, dinfo = get_direction(lm, spec['direction'], ctx)
    L0 = dinfo['layer']
    apply = layer_list(spec.get('layers', [L0]), lm.n_layers)
    doses = sorted(set(float(x) for x in spec.get('doses', [-0.5, -0.25, -0.1, 0, 0.1, 0.25, 0.5])) | {0.0})
    units = spec.get('units', 'resid')
    stats = {L: lm.resid_stats(L) for L in apply}
    norms = {L: stats[L][0] for L in apply}
    dinfo['raw_norm'] = raw_norm
    dinfo['raw_norm_in_resid_units'] = raw_norm / norms[apply[0]] if apply else None
    mean_dir = stats[apply[0]][1]
    dinfo['cos_with_mean_residual'] = float(unit @ (mean_dir / mean_dir.norm()))

    def setup_for(vec, dose):
        def setup(hk, b):
            for L in apply:
                hk.add(L, vec, dose * (norms[L] if units == 'resid' else raw_norm))
        return setup

    metric = Metric(lm, spec['metric'])
    if metric.warn:
        say(f'note: these strings are more than one token, only the first token counts: {metric.warn}')
    base = metric()
    per_prompt = []
    for d in doses:
        per_prompt.append(base if d == 0 else metric(setup_for(unit, d)))
        say(f'dose {d:+.3f}: metric {per_prompt[-1].mean():+.3f}')
    per_prompt = np.stack(per_prompt)
    curve = [bootstrap_ci(v, seed=seed) for v in per_prompt]

    R = int((spec.get('controls') or {}).get('random', 8))
    g = torch.Generator().manual_seed(seed + 7919)
    rand = torch.randn(R, lm.d_model, generator=g)
    rand = rand / rand.norm(dim=-1, keepdim=True)
    rand_curve = np.zeros((R, len(doses)))
    for r in range(R):
        for j, d in enumerate(doses):
            rand_curve[r, j] = base.mean() if d == 0 else metric(setup_for(rand[r], d)).mean()
        say(f'random direction {r + 1}/{R} done')

    se = spec.get('side_effects') or {}
    nseq = lm.encode(texts(se.get('texts', 'builtin:neutral')))
    nll0 = float(np.nanmean(lm.token_nll(nseq)))
    nll_v = [nll0 if d == 0 else float(np.nanmean(lm.token_nll(nseq, setup_for(unit, d)))) for d in doses]
    Rn = min(R, int(se.get('random', 3)))
    nll_r = [[nll0 if d == 0 else float(np.nanmean(lm.token_nll(nseq, setup_for(rand[r], d)))) for d in doses]
             for r in range(Rn)]

    samples = []
    sm = spec.get('samples')
    if sm:
        fmt = sm.get('format', spec['metric'].get('format', 'raw'))
        prompts = texts(sm['prompts'])
        seqs = lm.encode(prompts, fmt, sm.get('system'))
        for d in sm.get('doses', [doses[0], 0.0, doses[-1]]):
            outs = lm.generate(seqs, sm.get('new_tokens', 40), sm.get('greedy', True), seed=seed,
                               setup=None if d == 0 else setup_for(unit, float(d)))
            for p, o in zip(prompts, outs):
                samples.append({'dose': float(d), 'prompt': p, 'text': o})

    lens = lm.logit_lens(unit)
    claims = []
    j0 = doses.index(0.0)
    for j in ([len(doses) - 1] if doses[-1] > 0 else []) + ([0] if doses[0] < 0 else []):
        d = doses[j]
        delta = per_prompt[j] - per_prompt[j0]
        est, lo, hi = bootstrap_ci(delta, seed=seed)
        rd = rand_curve[:, j] - rand_curve[:, j0]
        sd = float(rd.std(ddof=1)) if R > 1 else float('nan')
        beats = R > 1 and abs(est) > 3 * sd and abs(est) > np.abs(rd).max()
        ci_clear = lo > 0 or hi < 0
        status = 'supported' if ci_clear and beats else 'weak' if ci_clear else 'not-supported'
        dn = nll_v[j] - nll0
        claims.append(claim(
            f"Pushing {'along' if d > 0 else 'against'} the direction at layer{'s' if len(apply) > 1 else ''} "
            f"{', '.join(map(str, apply))} (dose {d:+g}) shifts the metric by {est:+.3f} "
            f"(95% CI {lo:+.3f} to {hi:+.3f}); {R} random directions of the same size shift it by at most "
            f"{np.abs(rd).max():.3f}. Loss on neutral text changes by {dn:+.3f} nats.",
            status, {'dose': d, 'delta': est, 'ci': [lo, hi], 'random_sd': sd, 'random_max': float(np.abs(rd).max()),
                     'nll_delta': dn, 'random_nll_delta': [nr[j] - nll0 for nr in nll_r]},
            test='effect CI excludes zero and exceeds 3 sd and the maximum of the random-direction controls'))

    pack = ctx.pack('steer')
    pack.array('per_prompt', per_prompt, 'f32')
    pack.array('random_curve', rand_curve, 'f32')
    pack.array('direction', unit, 'f32')
    data = {'doses': doses, 'units': units, 'layers': apply, 'resid_norm': norms, 'direction': dinfo,
            'metric': {'kind': metric.kind, 'describe': metric.describe(), 'n_prompts': len(metric.prompts),
                       'prompts': metric.prompts, 'warn': metric.warn},
            'curve': [{'dose': d, 'mean': c[0], 'lo': c[1], 'hi': c[2]} for d, c in zip(doses, curve)],
            'random': {'n': R, 'mean': rand_curve.mean(0), 'sd': rand_curve.std(0, ddof=1) if R > 1 else None},
            'nll': {'base': nll0, 'direction': nll_v, 'random': nll_r, 'n_texts': len(nseq)},
            'samples': samples, 'logit_lens': lens}
    head = claims[0]['evidence'] if claims else {}
    summary = {'headline': (f"dose {head.get('dose', 0):+g} shifts the metric by {head.get('delta', 0):+.2f} "
                            f"against a random band of ±{3 * (head.get('random_sd') or 0):.2f}") if claims else ''}
    return pack.save(models=[lm.info()], summary=summary, claims=claims, data=data,
                     provenance=ctx.provenance(), dictionary=dinfo.get('dictionary'))
