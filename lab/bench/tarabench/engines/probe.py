"""Linear probes at every layer, with the controls that keep them honest.

For a labelled set of texts, read the residual stream at each layer and ask whether one straight line separates
the two labels on held-out examples. Two probes per layer: logistic regression (the best line) and the difference of
class means (the simplest line, and in practice usually the more causal one). The control is a permutation test:
shuffle every label, train the same logistic probe on the shuffled training half and score it against the shuffled
held-out half, which shows how well a wide model can do when there is nothing to find. (Scoring a shuffled-label
probe against the true labels instead is not a fair null: a shuffle that happens to correlate a little with the truth
tilts the probe towards the real direction, and on an easy property that tilt can look like 80% accuracy.) A probe only shows that the
information is there to be read; whether the model uses it is a job for the steering engine, which can take the
directions saved here.

Matched pairs (every built-in contrast set: the same city, task or message once with each label) are held out whole,
so the probe is scored only on items it never saw in any version, and the control swaps labels within pairs. An
unpaired set is split again on each shuffle, stratified by the shuffled labels: a split stratified by the true labels
leaves the shuffled ones lopsided, the probe then scores below chance, and the control looks lower than it is.
Held-out accuracy carries an exact binomial interval, which does not collapse at a perfect score. The best layer is
picked by cross-validated accuracy inside the training half, so the held-out score is not the best of many tries on
the same examples. A second control needs no model at all: a logistic probe on which tokens each text contains,
scored on the same held-out examples. When the words alone give the label away (formal against casual wording), a
perfect probe says more about the dataset than about the model; an exact McNemar test compares the two."""
import numpy as np

from ..common import Progress, layer_list, say, seed_all
from ..data import labelled
from ..packs import claim
from ..stats import (auc, choose_l2, diff_means, exact_acc, fit_logistic, mcnemar, null_labels, pca2, probe_direction,
                     probe_scores, split, words_probe)


def run(spec, ctx):
    lm = ctx.load(spec['model'])
    seed = spec.get('seed', 0)
    seed_all(seed)
    xs, ys, groups = labelled(spec['dataset'], seed, groups=True)
    ys = np.asarray(ys)
    paired = len(set(groups)) < len(groups)
    fmt, pool = spec.get('format', 'raw'), spec.get('pool', 'last')
    layers = layer_list(spec.get('layers', 'all'), lm.n_layers)
    seqs = lm.encode(xs, fmt, spec.get('system'))
    say(f'{len(xs)} examples ({int(ys.sum())} positive), {len(layers)} layers, pool={pool}, format={fmt}')
    acts = lm.pooled(seqs, layers, pool, Progress('probe: reading activations', len(seqs)))
    tf = spec.get('test_fraction', 0.3)
    tr, te = split(len(xs), tf, seed, ys, groups if paired else None)
    n_shuffle = int((spec.get('controls') or {}).get('shuffle', 3))
    l2_spec = spec.get('l2', 'cv')
    rng = np.random.default_rng(seed + 1)
    rows, pcas, ratios, correct = [], [], [], []
    g_tr = np.asarray(groups)[tr] if paired else None
    dirs_dm = np.zeros((len(layers), lm.d_model), np.float32)
    dirs_lr = np.zeros((len(layers), lm.d_model), np.float32)
    prog = Progress('probe: fitting', len(layers))
    for li, L in enumerate(layers):
        X = acts[L].numpy().astype(np.float64)
        d, thr, raw = diff_means(X[tr], ys[tr])
        dm_correct = ((X[te] @ d > thr) == (ys[te] == 1))
        l2, cv = choose_l2(X[tr], ys[tr], grid=(1e-3, 1e-2, 1e-1, 1.0, 10.0) if l2_spec == 'cv' else (float(l2_spec),),
                           seed=seed, groups=g_tr, with_acc=True)
        m = fit_logistic(X[tr], ys[tr], l2)
        s = probe_scores(m, X[te])
        lr_correct = ((s > 0) == (ys[te] == 1))
        correct.append(lr_correct)
        shuf = []
        for _ in range(n_shuffle):
            yp = null_labels(ys, rng, groups if paired else None)
            trs, tes = (tr, te) if paired else split(len(xs), tf, int(rng.integers(1 << 30)), yp)
            ms = fit_logistic(X[trs], yp[trs], l2, iters=100)
            shuf.append(float(((probe_scores(ms, X[tes]) > 0) == (yp[tes] == 1)).mean()))
        a_lr, lo_lr, hi_lr = exact_acc(lr_correct)
        a_dm, lo_dm, hi_dm = exact_acc(dm_correct)
        rows.append({'layer': L, 'logreg': a_lr, 'logreg_ci': [lo_lr, hi_lr], 'logreg_auc': auc(s, ys[te]),
                     'diffmeans': a_dm, 'diffmeans_ci': [lo_dm, hi_dm], 'diffmeans_auc': auc(X[te] @ d, ys[te]),
                     'shuffled': float(np.mean(shuf)) if shuf else None, 'shuffled_max': max(shuf) if shuf else None,
                     'l2': l2, 'cv_acc': cv, 'mean_gap': raw})
        dirs_dm[li] = d
        dirs_lr[li] = probe_direction(m)
        c, r = pca2(X)
        pcas.append(c)
        ratios.append(r)
        prog(li + 1, f'layer {L}: logistic {a_lr:.2f}, means {a_dm:.2f}, shuffled {np.mean(shuf) if shuf else 0:.2f}')
    best = max(range(len(rows)), key=lambda i: (round(rows[i]['cv_acc'], 3), -i))    # picked inside the training half
    br = rows[best]

    # ---- the words-only control: which tokens each text contains, no model at all, on the same held-out examples ---
    bow_correct, n_vocab = words_probe(seqs, ys, tr, te, seed, g_tr,
                                       None if l2_spec == 'cv' else (float(l2_spec),))
    a_bow, lo_bow, hi_bow = exact_acc(bow_correct)
    only_probe, only_bow, p_bow = mcnemar(correct[best], bow_correct)
    Xb = acts[layers[best]].numpy().astype(np.float64)
    scores_best = Xb @ dirs_dm[best]
    floor = max((r['shuffled_max'] or 0.5) for r in rows)
    status = 'supported' if br['logreg_ci'][0] > max(floor, 0.5) + 0.05 else 'weak' if br['logreg'] > floor else 'not-supported'
    claims = [claim(
        f"The label is linearly readable from the residual stream: at layer {br['layer']} a logistic probe gets "
        f"{br['logreg']:.0%} of {len(te)} held-out examples right (exact 95% interval {br['logreg_ci'][0]:.1%} to "
        f"{br['logreg_ci'][1]:.1%}), against {floor:.0%} at best for probes trained and scored on shuffled labels.",
        status, {'layer': br['layer'], 'acc': br['logreg'], 'ci': br['logreg_ci'], 'shuffled_best': floor},
        test='CI lower bound clears the best shuffled-label probe by 5 points')]
    first = next((r for r in rows if r['logreg_ci'][0] > max(floor, 0.5) + 0.05), None)
    if first is rows[0]:
        claims.append(claim(
            f"It is readable from the first layer probed (layer {first['layer']} of {lm.n_layers}).",
            'supported', {'layer': first['layer']}, test='first layer whose CI lower bound clears the control'))
    elif first:
        claims.append(claim(
            f"It becomes readable by layer {first['layer']} of {lm.n_layers}: earlier layers do not clear the control.",
            'supported', {'layer': first['layer']}, test='first layer whose CI lower bound clears the control'))
    beyond = br['logreg'] > a_bow
    claims.append(claim(
        f"It is more than the words: a probe on which tokens each text contains, with no model at all, gets "
        f"{a_bow:.0%} of the same held-out examples right ({lo_bow:.1%} to {hi_bow:.1%}), against {br['logreg']:.0%} "
        f"at layer {br['layer']} (exact McNemar test on the {only_probe + only_bow} examples where they disagree: "
        f"p = {p_bow:.2g}).",
        'supported' if beyond and p_bow < 0.05 else 'weak' if beyond else 'not-supported',
        {'bow': a_bow, 'bow_ci': [lo_bow, hi_bow], 'probe': br['logreg'], 'right_only_probe': only_probe,
         'right_only_words': only_bow, 'p': p_bow, 'vocabulary': n_vocab},
        test='the best layer beats the words-only probe on the same held-out examples, exact McNemar p below 0.05'))
    claims.append(claim(
        f"The simple difference-of-means direction at layer {br['layer']} gets {br['diffmeans']:.0%} "
        f"({br['diffmeans_ci'][0]:.1%} to {br['diffmeans_ci'][1]:.1%}); it is saved for steering, which tests "
        f"whether the model actually uses it.",
        'supported' if br['diffmeans_ci'][0] > max(floor, 0.5) + 0.05 else 'weak',
        {'acc': br['diffmeans'], 'ci': br['diffmeans_ci']}, test='same bar as above'))

    notes = []
    if paired:
        notes.append(f'The {len(xs)} texts are {len(xs) // 2} matched pairs, each item once with each label. Whole pairs '
                     f'are held out ({len(te) // 2} of them), so the probe is scored only on items it never saw in any '
                     'version, and the shuffled-label control swaps labels within pairs.')
    if lo_bow > max(floor, 0.5) + 0.05:
        notes.append(f'The words alone give the label away: a probe on which tokens each text contains gets {a_bow:.0%} '
                     'with no model at all, so a high score here says more about the dataset than about anything the '
                     'model computes. Compare a property that the words do not settle (true against false statements '
                     'built from the same words).')
    elif rows[0]['layer'] == 0 and rows[0]['logreg_ci'][0] > max(floor, 0.5) + 0.05:
        notes.append('Readable already at layer 0, right after the first block, though a probe on the words alone does '
                     'not get there: the first block already combines them.')
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
            'paired': paired, 'interval': 'exact binomial (Clopper-Pearson), 95%',
            'best_by': 'cross-validated accuracy inside the training half',
            'words': {'acc': a_bow, 'ci': [lo_bow, hi_bow], 'vocabulary': n_vocab, 'p_vs_best': p_bow,
                      'right_only_probe': only_probe, 'right_only_words': only_bow},
            'directions_note': 'dirs_dm and dirs_lr are unit vectors, one row per entry of layers'}
    summary = {'headline': f"best layer {br['layer']}: {br['logreg']:.0%} held-out (words alone {a_bow:.0%}, "
                           f"shuffled labels at most {floor:.0%})"}
    return pack.save(models=[lm.info()], summary=summary, claims=claims, data=data, notes=notes,
                     provenance=ctx.provenance())
