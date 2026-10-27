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
perfect probe says more about the dataset than about the model; an exact McNemar test compares the two. A third reads
what the words mean: the same probe on each text's average input embedding, before any layer has combined the words.
Synonyms share an embedding direction, so it can carry a label across wordings that share no tokens; what the layers
add is the step from it to the probe. Last, random directions ("controls": {"random_directions": 32}) are pointed the
way each splits the training texts and cut like the probe: when two kinds of text differ in many ways at once, a
direction picked at random separates them too, and the probe's own direction is only as special as its lead over
them.

A transfer test ("test_dataset") trains on the whole of one set and scores on another that carries the same label in
other words: the question is whether the line the probe found is the property or the first set's wording. Part of the
new set ("dev_fraction", by pairs) re-centres each probe's cut (the direction is kept; the whole new set can sit to one
side of the old cut) and picks the layer; the rest is scored, and every control is scored the same way. An optional
third control ("controls": {"confound": ...}) trains a probe on a set for a rival property (formality, say) and scores
it on the same texts, pointed the way the rival runs in the training texts (a probe that merely read the rival would
inherit that sign) and re-centred like the probe: if it does as well, the probe may be reading the rival. Its best case
on the new set (pointed whichever way suits the dev texts) is reported too, as a check on the new set's design."""
import numpy as np

from ..common import Progress, layer_list, say, seed_all
from ..data import labelled
from ..packs import claim
from ..stats import (auc, choose_l2, diff_means, exact_acc, feature_probe, fit_logistic, mcnemar, midpoint,
                     null_labels, pca2, probe_direction, probe_scores, right_side, split, words_probe)


def _name(src):
    return src.split(':', 1)[1] if isinstance(src, str) and src.startswith('builtin:') else 'a custom set'


def run(spec, ctx):
    lm = ctx.load(spec['model'])
    seed = spec.get('seed', 0)
    seed_all(seed)
    xs, ys, groups = labelled(spec['dataset'], seed, groups=True)
    paired = len(set(groups)) < len(groups)
    n_train, transfer = len(xs), spec.get('test_dataset')
    if transfer:
        xt, yt, gt = labelled(transfer, seed, groups=True)
        t_paired = len(set(gt)) < len(gt)
        xs, ys, groups = xs + xt, list(ys) + list(yt), list(groups) + [g + max(groups) + 1 for g in gt]
    ys, groups = np.asarray(ys), np.asarray(groups)
    fmt, pool = spec.get('format', 'raw'), spec.get('pool', 'last')
    layers = layer_list(spec.get('layers', 'all'), lm.n_layers)
    seqs = lm.encode(xs, fmt, spec.get('system'))
    say(f'{len(xs)} examples ({int(ys.sum())} positive), {len(layers)} layers, pool={pool}, format={fmt}'
        + (f', trained on the first {n_train}' if transfer else ''))
    acts = lm.pooled(seqs, layers, pool, Progress('probe: reading activations', len(seqs)))
    tf = spec.get('test_fraction', 0.3)
    dev = None
    if transfer:
        # all of the first set trains; the second set's pairs split into dev (re-centres the cut, picks the layer)
        # and test (scored). The null shuffles within pairs, or else within each part, so every part stays balanced.
        tr, te = np.arange(n_train), np.arange(n_train, len(xs))
        df = float(spec.get('dev_fraction', 0.5))
        if df > 0:
            d_rel, t_rel = split(len(te), 1 - df, seed, ys[te], groups[te] if t_paired else None)
            dev, te = te[d_rel], te[t_rel]
        part = np.zeros(len(xs), np.int64)
        part[te] = 2
        if dev is not None:
            part[dev] = 1
        null_groups = groups if paired and t_paired else part
    else:
        tr, te = split(len(xs), tf, seed, ys, groups if paired else None)
        null_groups = groups if paired else None
    fixed = bool(transfer) or paired
    n_shuffle = int((spec.get('controls') or {}).get('shuffle', 3))
    l2_spec = spec.get('l2', 'cv')
    grid = (1e-3, 1e-2, 1e-1, 1.0, 10.0) if l2_spec == 'cv' else (float(l2_spec),)
    conf = (spec.get('controls') or {}).get('confound')
    if conf:
        c_src = conf['dataset'] if isinstance(conf, dict) else conf
        c_name = conf.get('name', _name(c_src)) if isinstance(conf, dict) else _name(c_src)
        xc, yc, gc = labelled(c_src, seed, groups=True)
        yc, gc = np.asarray(yc), (np.asarray(gc) if len(set(gc)) < len(gc) else None)
        acts_c = lm.pooled(lm.encode(xc, fmt, spec.get('system')), layers, pool,
                           Progress('probe: reading the confound set', len(xc)))
        c_calib = dev if dev is not None else tr        # its own cut means nothing on another set, so re-centre it
    rng = np.random.default_rng(seed + 1)
    n_rand = int((spec.get('controls') or {}).get('random_directions', 32))
    # random directions in the probe's standardised space (so the few huge residual dimensions do not decide them),
    # the same ones at every layer
    U = np.random.default_rng(seed + 2).standard_normal((lm.d_model, n_rand)) if n_rand else None
    rows, pcas, ratios, correct, conf_correct, cuts = [], [], [], [], [], []
    g_tr = groups[tr] if paired else None
    dirs_dm = np.zeros((len(layers), lm.d_model), np.float32)
    dirs_lr = np.zeros((len(layers), lm.d_model), np.float32)
    prog = Progress('probe: fitting', len(layers))
    for li, L in enumerate(layers):
        X = acts[L].numpy().astype(np.float64)
        d, thr, raw = diff_means(X[tr], ys[tr])
        s_dm = X @ d
        dm_correct = right_side(s_dm, ys, te, dev, thr)
        cuts.append(midpoint(s_dm[dev], ys[dev]) if dev is not None else thr)
        l2, cv = choose_l2(X[tr], ys[tr], grid=grid, seed=seed, groups=g_tr, with_acc=True)
        m = fit_logistic(X[tr], ys[tr], l2)
        s = probe_scores(m, X)
        lr_correct = right_side(s, ys, te, dev)
        correct.append(lr_correct)
        shuf = []
        for _ in range(n_shuffle):
            yp = null_labels(ys, rng, null_groups)
            trs, tes = (tr, te) if fixed else split(len(xs), tf, int(rng.integers(1 << 30)), yp)
            ms = fit_logistic(X[trs], yp[trs], l2, iters=100)
            shuf.append(float(right_side(probe_scores(ms, X), yp, tes, dev).mean()))
        a_lr, lo_lr, hi_lr = exact_acc(lr_correct)
        a_dm, lo_dm, hi_dm = exact_acc(dm_correct)
        row = {'layer': L, 'logreg': a_lr, 'logreg_ci': [lo_lr, hi_lr], 'logreg_auc': auc(s[te], ys[te]),
               'diffmeans': a_dm, 'diffmeans_ci': [lo_dm, hi_dm], 'diffmeans_auc': auc(s_dm[te], ys[te]),
               'shuffled': float(np.mean(shuf)) if shuf else None, 'shuffled_max': max(shuf) if shuf else None,
               'l2': l2, 'cv_acc': cv, 'mean_gap': raw}
        if dev is not None:
            row['dev_acc'] = float(right_side(s, ys, dev, dev).mean())
            row['dev_auc'] = auc(s[dev], ys[dev])
        if n_rand:
            S = ((X - X[tr].mean(0)) / (X[tr].std(0) + 1e-8)) @ U
            ra = []
            for k in range(n_rand):
                sgn = 1.0 if right_side(S[:, k], ys, tr, tr).mean() >= 0.5 else -1.0
                ra.append(float(right_side(sgn * S[:, k], ys, te, dev if dev is not None else tr).mean()))
            row['random_dir'], row['random_dir_max'] = float(np.mean(ra)), max(ra)
        if conf:
            Xc = acts_c[L].numpy().astype(np.float64)
            mc = fit_logistic(Xc, yc, choose_l2(Xc, yc, grid=grid, seed=seed, groups=gc))
            sc = probe_scores(mc, X)
            sign = 1.0 if right_side(sc, ys, tr, tr).mean() >= 0.5 else -1.0      # the way it runs in training
            cf = right_side(sign * sc, ys, te, c_calib)
            conf_correct.append(cf)
            a_c, lo_c, hi_c = exact_acc(cf)
            row['confound'], row['confound_ci'], row['confound_sign'] = a_c, [lo_c, hi_c], int(sign)
            if dev is not None:
                s_any = 1.0 if right_side(sc, ys, dev, dev).mean() >= 0.5 else -1.0
                a_any, lo_any, _ = exact_acc(right_side(s_any * sc, ys, te, dev))
                row['confound_any'], row['confound_any_lo'], row['confound_any_sign'] = a_any, lo_any, int(s_any)
        rows.append(row)
        dirs_dm[li] = d
        dirs_lr[li] = probe_direction(m)
        c, r = pca2(X)
        pcas.append(c)
        ratios.append(r)
        prog(li + 1, f'layer {L}: logistic {a_lr:.2f}, means {a_dm:.2f}, shuffled {np.mean(shuf) if shuf else 0:.2f}'
             + (f", {c_name} {row['confound']:.2f}" if conf else ''))
    # the best layer is picked without the scored examples: on the dev part of a transfer test, else by
    # cross-validation inside the training half
    if dev is not None:
        best = max(range(len(rows)), key=lambda i: (round(rows[i]['dev_acc'], 3), round(rows[i]['dev_auc'], 3), -i))
    else:
        best = max(range(len(rows)), key=lambda i: (round(rows[i]['cv_acc'], 3), -i))
    br = rows[best]

    # ---- the words-only control: which tokens each text contains, no model at all, on the same held-out examples ---
    bow_correct, n_vocab = words_probe(seqs, ys, tr, te, seed, g_tr, None if l2_spec == 'cv' else grid, dev)
    a_bow, lo_bow, hi_bow = exact_acc(bow_correct)
    only_probe, only_bow, p_bow = mcnemar(correct[best], bow_correct)
    # ---- the word-meaning control: each text's average input embedding (what its words mean to the model before any
    # layer combines them: no order, no context), probed and scored the same way
    M = lm.mean_embeddings(xs).numpy().astype(np.float64)
    mean_correct = feature_probe(M, ys, tr, te, seed, g_tr, None if l2_spec == 'cv' else grid, dev)
    a_mn, lo_mn, hi_mn = exact_acc(mean_correct)
    only_probe_m, only_mn, p_mn = mcnemar(correct[best], mean_correct)
    Xb = acts[layers[best]].numpy().astype(np.float64)
    scores_best = Xb @ dirs_dm[best]
    floor = max((r['shuffled_max'] or 0.5) for r in rows)
    bar = max(floor, 0.5) + 0.05
    status = 'supported' if br['logreg_ci'][0] > bar else 'weak' if br['logreg'] > floor else 'not-supported'
    recentred = ' and re-centred the same way' if dev is not None else ''
    if transfer:
        head = (f"It carries over to new wording: trained on the {n_train} texts of {_name(spec['dataset'])} and "
                f"scored on {len(te)} texts of {_name(transfer)} (other items, other cues), a logistic probe at layer "
                f"{br['layer']} gets {br['logreg']:.0%} right (exact 95% interval {br['logreg_ci'][0]:.1%} to "
                f"{br['logreg_ci'][1]:.1%}), against {floor:.0%} at best for probes trained and scored on shuffled "
                f"labels." + (f" Its cut is re-centred, and the layer picked, on {len(dev)} other texts of the new set."
                              if dev is not None else ''))
    else:
        head = (f"The label is linearly readable from the residual stream: at layer {br['layer']} a logistic probe gets "
                f"{br['logreg']:.0%} of {len(te)} held-out examples right (exact 95% interval {br['logreg_ci'][0]:.1%} "
                f"to {br['logreg_ci'][1]:.1%}), against {floor:.0%} at best for probes trained and scored on shuffled "
                f"labels.")
    claims = [claim(head, status, {'layer': br['layer'], 'acc': br['logreg'], 'ci': br['logreg_ci'],
                                   'shuffled_best': floor},
                    test='CI lower bound clears the best shuffled-label probe by 5 points')]
    first = next((r for r in rows if r['logreg_ci'][0] > bar), None)
    verb = 'carries over' if transfer else 'is readable'
    if first is rows[0]:
        claims.append(claim(
            f"It {verb} from the first layer probed (layer {first['layer']} of {lm.n_layers}).",
            'supported', {'layer': first['layer']}, test='first layer whose CI lower bound clears the control'))
    elif first:
        claims.append(claim(
            f"It {'carries over' if transfer else 'becomes readable'} by layer {first['layer']} of {lm.n_layers}: "
            f"earlier layers do not clear the control.",
            'supported', {'layer': first['layer']}, test='first layer whose CI lower bound clears the control'))
    beyond = br['logreg'] > a_bow
    claims.append(claim(
        f"It is more than {'shared ' if transfer else 'the '}words: a probe on which tokens each text contains, with no "
        f"model at all{', trained on the same texts' + recentred if transfer else ''}, gets {a_bow:.0%} of the same "
        f"held-out examples right ({lo_bow:.1%} to {hi_bow:.1%}), against {br['logreg']:.0%} at layer {br['layer']} "
        f"(exact McNemar test on the {only_probe + only_bow} examples where they disagree: p = {p_bow:.2g}).",
        'supported' if beyond and p_bow < 0.05 else 'weak' if beyond else 'not-supported',
        {'bow': a_bow, 'bow_ci': [lo_bow, hi_bow], 'probe': br['logreg'], 'right_only_probe': only_probe,
         'right_only_words': only_bow, 'p': p_bow, 'vocabulary': n_vocab},
        test='the best layer beats the words-only probe on the same held-out examples, exact McNemar p below 0.05'))
    beyond_m = br['logreg'] > a_mn
    claims.append(claim(
        f"It is more than word meanings: a probe on each text's average input embedding (what its words mean to the "
        f"model before any layer combines them){', trained on the same texts' + recentred if transfer else ''}, gets "
        f"{a_mn:.0%} of the same held-out examples right ({lo_mn:.1%} to {hi_mn:.1%}), against {br['logreg']:.0%} at "
        f"layer {br['layer']} (exact McNemar test on the {only_probe_m + only_mn} examples where they disagree: "
        f"p = {p_mn:.2g}).",
        'supported' if beyond_m and p_mn < 0.05 else 'weak' if beyond_m else 'not-supported',
        {'meanings': a_mn, 'meanings_ci': [lo_mn, hi_mn], 'probe': br['logreg'], 'right_only_probe': only_probe_m,
         'right_only_meanings': only_mn, 'p': p_mn},
        test='the best layer beats the word-meaning probe on the same held-out examples, exact McNemar p below 0.05'))
    if conf:
        a_c, (lo_c, hi_c) = br['confound'], br['confound_ci']
        only_p, only_c, p_c = mcnemar(correct[best], conf_correct[best])
        claims.append(claim(
            f"It is not just {c_name}: a probe trained to read {c_name} on its own set ({_name(c_src)}), pointed the way "
            f"{c_name} runs in the training texts and re-centred like the probe, gets {a_c:.0%} of the same held-out "
            f"examples right ({lo_c:.1%} to {hi_c:.1%}), against "
            f"{br['logreg']:.0%} at layer {br['layer']} (exact McNemar test on the {only_p + only_c} examples where "
            f"they disagree: p = {p_c:.2g}).",
            'supported' if br['logreg'] > a_c and p_c < 0.05 else 'weak' if br['logreg'] > a_c else 'not-supported',
            {'confound': a_c, 'confound_ci': [lo_c, hi_c], 'probe': br['logreg'], 'right_only_probe': only_p,
             'right_only_confound': only_c, 'p': p_c},
            test='the best layer beats the rival-property probe on the same held-out examples, exact McNemar p below 0.05'))
    if n_rand:
        r_mean, r_max = br['random_dir'], br['random_dir_max']
        cut_how = 're-centred like the probe' if dev is not None else "cut half-way between the training texts' classes"
        claims.append(claim(
            f"It is more than any direction: {n_rand} random directions at layer {br['layer']}, each pointed the way it "
            f"splits the training texts and {cut_how}, get {r_mean:.0%} of the same held-out examples right on average "
            f"and {r_max:.0%} at best, against {br['logreg']:.0%} (exact 95% interval {br['logreg_ci'][0]:.1%} to "
            f"{br['logreg_ci'][1]:.1%}).",
            'supported' if br['logreg_ci'][0] > max(r_max, 0.5) + 0.05 else 'weak' if br['logreg'] > r_max
            else 'not-supported',
            {'random_mean': r_mean, 'random_max': r_max, 'n': n_rand, 'probe': br['logreg'], 'ci': br['logreg_ci']},
            test='CI lower bound clears the best random direction by 5 points'))
    claims.append(claim(
        f"The simple difference-of-means direction at layer {br['layer']} gets {br['diffmeans']:.0%} "
        f"({br['diffmeans_ci'][0]:.1%} to {br['diffmeans_ci'][1]:.1%}); it is saved for steering, which tests "
        f"whether the model actually uses it.",
        'supported' if br['diffmeans_ci'][0] > bar else 'weak',
        {'acc': br['diffmeans'], 'ci': br['diffmeans_ci']}, test='same bar as above'))

    notes = []
    if transfer:
        notes.append(f"The probe trains on all {n_train} texts of {_name(spec['dataset'])}. The {len(xs) - n_train} texts "
                     f"of {_name(transfer)} are new to it: " +
                     (f"{len(dev)} re-centre each probe's cut and pick the layer, and the other {len(te)} are scored"
                      if dev is not None else f"all {len(te)} are scored with the cut from training") +
                     (', whole pairs on each side' if t_paired and dev is not None else '') +
                     '. Every control is trained and scored the same way on the same texts.')
    elif paired:
        notes.append(f'The {len(xs)} texts are {len(xs) // 2} matched pairs, each item once with each label. Whole pairs '
                     f'are held out ({len(te) // 2} of them), so the probe is scored only on items it never saw in any '
                     'version, and the shuffled-label control swaps labels within pairs.')
    if lo_bow > bar:
        notes.append(f'Words shared by the two sets carry the label: a probe on which tokens each text contains gets '
                     f'{a_bow:.0%} of the new texts with no model at all, so part of the transfer is lexical.' if transfer
                     else f'The words alone give the label away: a probe on which tokens each text contains gets '
                     f'{a_bow:.0%} with no model at all, so a high score here says more about the dataset than about '
                     'anything the model computes. Compare a property that the words do not settle (true against false '
                     'statements built from the same words), or test transfer to other wording.')
    elif lo_mn > bar:
        notes.append(f"What the words mean carries the label: a probe on each text's average input embedding gets "
                     f"{a_mn:.0%} {'of the new texts' if transfer else 'held out'} with no context and no word order, "
                     f"so what the layers add is the step from {a_mn:.0%} to {br['logreg']:.0%}.")
    elif not transfer and rows[0]['layer'] == 0 and rows[0]['logreg_ci'][0] > bar:
        notes.append('Readable already at layer 0, right after the first block, though probes on the words alone and '
                     'on what they mean do not get there: the first block already combines them.')
    if n_rand and br['random_dir_max'] > bar:
        notes.append(f"Random directions separate these texts too: at layer {br['layer']} the best of {n_rand} gets "
                     f"{br['random_dir_max']:.0%} (average {br['random_dir']:.0%}). The two kinds of text differ in so many "
                     "ways there that a direction picked at random reads the label, so the probe's direction is only as "
                     "special as its lead over them.")
    if conf and br['confound_ci'][0] > bar:
        notes.append(f"A probe for {c_name} alone reads this label at {br['confound']:.0%}: part of what the probe finds "
                     f"may be {c_name}.")
    elif conf and dev is not None and br['confound_any_sign'] != br['confound_sign'] and br['confound_any_lo'] > bar:
        notes.append(f"In the new set {c_name} runs the other way round from the training set: pointed the new set's way, "
                     f"a {c_name} probe reads its labels at {br['confound_any']:.0%}. A probe that merely read {c_name} "
                     f"would score below chance here, so {c_name} works against this probe, not for it; the new set's "
                     f"register is not balanced.")
    pack = ctx.pack('probe')
    pack.array('pca', np.stack(pcas), 'f16')
    pack.array('labels', ys, 'u8')
    is_test = np.zeros(len(xs), np.uint8)
    is_test[te] = 1
    pack.array('is_test', is_test, 'u8')
    if transfer:
        source = np.zeros(len(xs), np.uint8)
        source[n_train:] = 1
        pack.array('source', source, 'u8')
    pack.array('dirs_dm', dirs_dm, 'f16')
    pack.array('dirs_lr', dirs_lr, 'f16')
    pack.array('scores_best', scores_best, 'f32')
    data = {'layers': layers, 'rows': rows, 'best': best, 'pca_ratio': ratios, 'pool': pool, 'format': fmt,
            'texts': [x if len(x) <= 200 else x[:197] + '...' for x in xs], 'n': len(xs), 'n_test': int(len(te)),
            'paired': paired, 'interval': 'exact binomial (Clopper-Pearson), 95%',
            'best_by': ('accuracy on the dev texts of the new set' if dev is not None
                        else 'cross-validated accuracy inside the training half'),
            'cut': cuts[best],
            'words': {'acc': a_bow, 'ci': [lo_bow, hi_bow], 'vocabulary': n_vocab, 'p_vs_best': p_bow,
                      'right_only_probe': only_probe, 'right_only_words': only_bow},
            'random_directions': n_rand,
            'meanings': {'acc': a_mn, 'ci': [lo_mn, hi_mn], 'p_vs_best': p_mn, 'right_only_probe': only_probe_m,
                         'right_only_meanings': only_mn, 'of': "the average input embedding of each text's own tokens"},
            'directions_note': 'dirs_dm and dirs_lr are unit vectors, one row per entry of layers'}
    if transfer:
        data['transfer'] = {'train': spec['dataset'], 'test': transfer, 'n_train': n_train,
                            'n_dev': int(len(dev)) if dev is not None else 0, 'n_test': int(len(te)),
                            'cut': 'midpoint of the dev texts\' class means' if dev is not None else 'from training'}
    if conf:
        data['confound'] = {'dataset': c_src, 'name': c_name, 'n': len(xc), 'acc': br['confound'],
                            'ci': br['confound_ci'], 'sign': br['confound_sign'], 'p_vs_best': p_c,
                            'best_case': br.get('confound_any'), 'right_only_probe': only_p,
                            'right_only_confound': only_c}
    extra = (f", {c_name} {br['confound']:.0%}" if conf else '')
    summary = {'headline': f"best layer {br['layer']}: {br['logreg']:.0%} "
                           f"{'on new wording' if transfer else 'held-out'} (words alone {a_bow:.0%}, word meanings "
                           f"{a_mn:.0%}{extra}, "
                           f"shuffled labels at most {floor:.0%})"}
    return pack.save(models=[lm.info()], summary=summary, claims=claims, data=data, notes=notes,
                     provenance=ctx.provenance())
