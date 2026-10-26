"""Linear probes at every layer, with the controls that keep them honest.

For a labelled set of texts, read the residual stream at each layer and ask whether one straight line separates
the two labels on held-out examples. Two probes per layer: logistic regression (the best line) and the difference of
class means (the simplest line, and in practice usually the more causal one). The control is the same logistic
probe trained on shuffled labels, which shows how much a wide model can fit by chance. A probe only shows that the
information is there to be read; whether the model uses it is a job for the steering engine, which can take the
directions saved here."""
import numpy as np

from ..common import Progress, layer_list, say, seed_all
from ..data import labelled
from ..packs import claim
from ..stats import (auc, bootstrap_acc, choose_l2, diff_means, fit_logistic, pca2, probe_direction, probe_scores,
                     split)


def run(spec, ctx):
    lm = ctx.load(spec['model'])
    seed = spec.get('seed', 0)
    seed_all(seed)
    xs, ys = labelled(spec['dataset'], seed)
    ys = np.asarray(ys)
    fmt, pool = spec.get('format', 'raw'), spec.get('pool', 'last')
    layers = layer_list(spec.get('layers', 'all'), lm.n_layers)
    seqs = lm.encode(xs, fmt, spec.get('system'))
    say(f'{len(xs)} examples ({int(ys.sum())} positive), {len(layers)} layers, pool={pool}, format={fmt}')
    acts = lm.pooled(seqs, layers, pool, Progress('probe: reading activations', len(seqs)))
    tr, te = split(len(xs), spec.get('test_fraction', 0.3), seed, ys)
    n_shuffle = int((spec.get('controls') or {}).get('shuffle', 3))
    l2_spec = spec.get('l2', 'cv')
    rng = np.random.default_rng(seed + 1)
    rows, pcas, ratios = [], [], []
    dirs_dm = np.zeros((len(layers), lm.d_model), np.float32)
    dirs_lr = np.zeros((len(layers), lm.d_model), np.float32)
    prog = Progress('probe: fitting', len(layers))
    for li, L in enumerate(layers):
        X = acts[L].numpy().astype(np.float64)
        d, thr, raw = diff_means(X[tr], ys[tr])
        dm_correct = ((X[te] @ d > thr) == (ys[te] == 1))
        l2 = choose_l2(X[tr], ys[tr], seed=seed) if l2_spec == 'cv' else float(l2_spec)
        m = fit_logistic(X[tr], ys[tr], l2)
        s = probe_scores(m, X[te])
        lr_correct = ((s > 0) == (ys[te] == 1))
        shuf = []
        for _ in range(n_shuffle):
            yp = rng.permutation(ys[tr])
            ms = fit_logistic(X[tr], yp, l2, iters=100)
            shuf.append(float(((probe_scores(ms, X[te]) > 0) == (ys[te] == 1)).mean()))
        a_lr, lo_lr, hi_lr = bootstrap_acc(lr_correct, seed=seed)
        a_dm, lo_dm, hi_dm = bootstrap_acc(dm_correct, seed=seed)
        rows.append({'layer': L, 'logreg': a_lr, 'logreg_ci': [lo_lr, hi_lr], 'logreg_auc': auc(s, ys[te]),
                     'diffmeans': a_dm, 'diffmeans_ci': [lo_dm, hi_dm], 'diffmeans_auc': auc(X[te] @ d, ys[te]),
                     'shuffled': float(np.mean(shuf)) if shuf else None, 'shuffled_max': max(shuf) if shuf else None,
                     'l2': l2, 'mean_gap': raw})
        dirs_dm[li] = d
        dirs_lr[li] = probe_direction(m)
        c, r = pca2(X)
        pcas.append(c)
        ratios.append(r)
        prog(li + 1, f'layer {L}: logistic {a_lr:.2f}, means {a_dm:.2f}, shuffled {np.mean(shuf) if shuf else 0:.2f}')
    best = max(range(len(rows)), key=lambda i: (round(rows[i]['logreg'], 3), round(rows[i]['diffmeans'], 3), -i))
    br = rows[best]
    Xb = acts[layers[best]].numpy().astype(np.float64)
    scores_best = Xb @ dirs_dm[best]
    floor = max((r['shuffled_max'] or 0.5) for r in rows)
    status = 'supported' if br['logreg_ci'][0] > max(floor, 0.5) + 0.05 else 'weak' if br['logreg'] > floor else 'not-supported'
    claims = [claim(
        f"The label is linearly readable from the residual stream: at layer {br['layer']} a logistic probe gets "
        f"{br['logreg']:.0%} of held-out examples right (95% CI {br['logreg_ci'][0]:.0%} to {br['logreg_ci'][1]:.0%}), "
        f"against {floor:.0%} at best for probes trained on shuffled labels.",
        status, {'layer': br['layer'], 'acc': br['logreg'], 'ci': br['logreg_ci'], 'shuffled_best': floor},
        test='CI lower bound clears the best shuffled-label probe by 5 points')]
    first = next((r for r in rows if r['logreg_ci'][0] > max(floor, 0.5) + 0.05), None)
    if first:
        claims.append(claim(
            f"It becomes readable by layer {first['layer']} of {lm.n_layers}: earlier layers do not clear the control.",
            'supported', {'layer': first['layer']}, test='first layer whose CI lower bound clears the control'))
    claims.append(claim(
        f"The simple difference-of-means direction at layer {br['layer']} gets {br['diffmeans']:.0%} "
        f"(CI {br['diffmeans_ci'][0]:.0%} to {br['diffmeans_ci'][1]:.0%}); it is saved for steering, which tests "
        f"whether the model actually uses it.",
        'supported' if br['diffmeans_ci'][0] > max(floor, 0.5) + 0.05 else 'weak',
        {'acc': br['diffmeans'], 'ci': br['diffmeans_ci']}, test='same bar as above'))

    pack = ctx.pack('probe')
    pack.array('pca', np.stack(pcas), 'f16')
    pack.array('labels', ys, 'u8')
    is_test = np.zeros(len(xs), np.uint8)
    is_test[te] = 1
    pack.array('is_test', is_test, 'u8')
    pack.array('dirs_dm', dirs_dm, 'f16')
    pack.array('dirs_lr', dirs_lr, 'f16')
    pack.array('scores_best', scores_best, 'f32')
    data = {'layers': layers, 'rows': rows, 'best': best, 'pca_ratio': ratios, 'pool': pool, 'format': fmt,
            'texts': [x if len(x) <= 200 else x[:197] + '...' for x in xs], 'n': len(xs), 'n_test': int(len(te)),
            'directions_note': 'dirs_dm and dirs_lr are unit vectors, one row per entry of layers'}
    summary = {'headline': f"best layer {br['layer']}: {br['logreg']:.0%} held-out (shuffled-label control {floor:.0%})"}
    return pack.save(models=[lm.info()], summary=summary, claims=claims, data=data, provenance=ctx.provenance())
