"""The statistics every engine leans on: Student-t, bootstrap and exact binomial intervals, train/test splits that
keep matched pairs together, linear probes, difference-of-means directions, PCA.

Everything runs on the CPU in float32 or float64; the arrays are small (examples x model width)."""
import math

import numpy as np
import torch


def bootstrap_ci(values, n=1000, seed=0, stat=np.mean, alpha=0.05):
    """Percentile bootstrap over items (prompts, examples). Returns (estimate, low, high)."""
    v = np.asarray(values, dtype=np.float64)
    if v.size == 0:
        return float('nan'), float('nan'), float('nan')
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(v), size=(n, len(v)))
    boots = np.array([stat(v[i]) for i in idx])
    return float(stat(v)), float(np.quantile(boots, alpha / 2)), float(np.quantile(boots, 1 - alpha / 2))


def bootstrap_acc(correct, n=1000, seed=0):
    return bootstrap_ci(np.asarray(correct, dtype=np.float64), n=n, seed=seed)


def ratio_ci(num, den, n=1000, seed=0, alpha=0.05):
    """A share such as "fraction of the gap removed": sum(num) / sum(den) over items, with a percentile bootstrap that
    resamples items whole, so the interval is for the same ratio of means as the estimate (a mean of per-item ratios
    is a different number, and blows up on items whose denominator is near zero). Returns (estimate, low, high)."""
    a, b = np.asarray(num, dtype=np.float64), np.asarray(den, dtype=np.float64)
    if a.size == 0 or abs(b.mean()) < 1e-12:
        return float('nan'), float('nan'), float('nan')
    idx = np.random.default_rng(seed).integers(0, a.size, size=(n, a.size))
    da = b[idx].mean(1)
    boots = np.where(np.abs(da) > 1e-12, a[idx].mean(1) / np.where(np.abs(da) > 1e-12, da, 1), np.nan)
    return (float(a.mean() / b.mean()), float(np.nanquantile(boots, alpha / 2)),
            float(np.nanquantile(boots, 1 - alpha / 2)))


def _betacf(a, b, x):
    """The continued fraction of the incomplete beta function (Lentz's method, as in Numerical Recipes 6.4)."""
    tiny = 1e-300
    c, d = 1.0, 1.0 - (a + b) * x / (a + 1)
    d = 1.0 / (d if abs(d) > tiny else tiny)
    h = d
    for m in range(1, 300):
        for aa in (m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m)),
                   -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1))):
            d = 1.0 + aa * d
            d = 1.0 / (d if abs(d) > tiny else tiny)
            c = 1.0 + aa / c
            c = c if abs(c) > tiny else tiny
            h *= d * c
        if abs(d * c - 1.0) < 1e-15:
            break
    return h


def _betainc(a, b, x):
    """The regularised incomplete beta function I_x(a, b)."""
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    front = math.exp(math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log1p(-x))
    if x < (a + 1) / (a + b + 2):
        return front * _betacf(a, b, x) / a
    return 1.0 - front * _betacf(b, a, 1 - x) / b


def t_quantile(p, df):
    """The p quantile of Student's t with df degrees of freedom, by bisection on its CDF (the bench has no scipy)."""
    def cdf(t):
        tail = 0.5 * _betainc(df / 2, 0.5, df / (df + t * t))
        return 1 - tail if t > 0 else tail
    lo, hi = -1e4, 1e4
    for _ in range(100):
        m = (lo + hi) / 2
        lo, hi = (m, hi) if cdf(m) < p else (lo, m)
    return (lo + hi) / 2


def mean_ci(values, alpha=0.05):
    """A mean over items (prompts, pairs) with its Student-t interval: (estimate, low, high). Engines average a
    handful of prompts, where the percentile bootstrap is too narrow (by about a fifth at 8 prompts, since it
    ignores that the spread itself is estimated); one item gives no interval at all (nan, nan)."""
    v = np.asarray(values, dtype=np.float64).ravel()
    if v.size == 0:
        return float('nan'), float('nan'), float('nan')
    m = float(v.mean())
    if v.size < 2:
        return m, float('nan'), float('nan')
    h = t_quantile(1 - alpha / 2, v.size - 1) * float(v.std(ddof=1)) / math.sqrt(v.size)
    return m, m - h, m + h


def _binom_cdf(k, n, p):
    """P(X <= k) for X ~ Binomial(n, p), summed in log space."""
    if k < 0:
        return 0.0
    if k >= n or p <= 0:
        return 1.0
    if p >= 1:
        return 0.0
    lp, lq, lc = math.log(p), math.log1p(-p), math.lgamma(n + 1)
    terms = [lc - math.lgamma(i + 1) - math.lgamma(n - i + 1) + i * lp + (n - i) * lq for i in range(k + 1)]
    m = max(terms)
    return min(1.0, math.exp(m) * sum(math.exp(t - m) for t in terms))


def binom_ci(k, n, alpha=0.05):
    """Exact (Clopper-Pearson) interval for k successes in n trials: the success rates at which k or more, and k or
    fewer, would each turn up with probability alpha / 2. A bootstrap of a perfect score resamples only successes and
    says 100% to 100%; this says 42 of 42 is 91.6% to 100%."""
    if n <= 0:
        return float('nan'), float('nan')

    def solve(f, want):            # f rises with p on [0, 1]
        a, b = 0.0, 1.0
        for _ in range(60):
            m = (a + b) / 2
            a, b = (m, b) if f(m) < want else (a, m)
        return (a + b) / 2
    lo = 0.0 if k <= 0 else solve(lambda p: 1 - _binom_cdf(k - 1, n, p), alpha / 2)     # P(X >= k) rises with p
    hi = 1.0 if k >= n else solve(lambda p: -_binom_cdf(k, n, p), -alpha / 2)           # P(X <= k) falls with p
    return lo, hi


def mcnemar(a_correct, b_correct):
    """Exact McNemar test for two classifiers scored on the same items: only the items where they disagree carry
    information, and if neither is better each of those is a coin flip. Returns (right only for a, right only for b,
    two-sided p)."""
    a, b = np.asarray(a_correct, dtype=bool), np.asarray(b_correct, dtype=bool)
    only_a, only_b = int((a & ~b).sum()), int((~a & b).sum())
    if only_a + only_b == 0:
        return only_a, only_b, 1.0
    return only_a, only_b, min(1.0, 2 * _binom_cdf(min(only_a, only_b), only_a + only_b, 0.5))


def exact_acc(correct, alpha=0.05):
    """Held-out accuracy with its exact binomial interval: (estimate, low, high)."""
    c = np.asarray(correct, dtype=bool)
    if c.size == 0:
        return float('nan'), float('nan'), float('nan')
    lo, hi = binom_ci(int(c.sum()), int(c.size), alpha)
    return float(c.mean()), lo, hi


def split(n, test_fraction, seed, labels=None, groups=None):
    """A seeded train/test split, stratified by label when labels are given. With groups (one id per example, shared
    by the two halves of a matched pair) whole groups are held out together, so every held-out item is one the probe
    never saw in any version; when each group holds one of each label the split is balanced as well."""
    rng = np.random.default_rng(seed)
    if groups is not None:
        g = np.asarray(groups)
        ids = rng.permutation(np.unique(g))
        k = max(1, int(round(len(ids) * test_fraction)))
        test = np.isin(g, ids[:k])
        return np.flatnonzero(~test), np.flatnonzero(test)
    if labels is None:
        perm = rng.permutation(n)
        k = max(1, int(round(n * test_fraction)))
        return np.sort(perm[k:]), np.sort(perm[:k])
    labels = np.asarray(labels)
    tr, te = [], []
    for c in np.unique(labels):
        idx = rng.permutation(np.flatnonzero(labels == c))
        k = max(1, int(round(len(idx) * test_fraction)))
        te.extend(idx[:k])
        tr.extend(idx[k:])
    return np.sort(np.array(tr)), np.sort(np.array(te))


def null_labels(ys, rng, groups=None):
    """Labels for a permutation control. With groups the labels are shuffled within each group (for a matched pair,
    a coin-flip swap), so every pair still holds one of each label and a pair-held-out split stays balanced; without
    groups, a plain permutation (split again on the result, so both halves stay balanced)."""
    ys = np.asarray(ys)
    if groups is None:
        return rng.permutation(ys)
    g, out = np.asarray(groups), ys.copy()
    for v in np.unique(g):
        idx = np.flatnonzero(g == v)
        out[idx] = ys[rng.permutation(idx)]
    return out


class Standardise:
    def __init__(self, X):
        self.mu = X.mean(0, keepdims=True)
        self.sd = X.std(0, keepdims=True) + 1e-6

    def __call__(self, X):
        return (X - self.mu) / self.sd


def fit_logistic(X, y, l2=1e-2, iters=200):
    """L2-regularised logistic regression by L-BFGS on standardised features. Returns (w, b, standardiser) with w in
    the standardised space; use probe_scores() to score new rows."""
    X = torch.as_tensor(X, dtype=torch.float64)
    y = torch.as_tensor(y, dtype=torch.float64)
    st = Standardise(X)
    Z = st(X)
    w = torch.zeros(Z.shape[1], dtype=torch.float64, requires_grad=True)
    b = torch.zeros((), dtype=torch.float64, requires_grad=True)
    opt = torch.optim.LBFGS([w, b], lr=1, max_iter=iters, line_search_fn='strong_wolfe')

    def closure():
        opt.zero_grad()
        loss = torch.nn.functional.binary_cross_entropy_with_logits(Z @ w + b, y) + l2 * (w @ w) / 2
        loss.backward()
        return loss
    opt.step(closure)
    return w.detach(), b.detach(), st


def probe_scores(model, X):
    w, b, st = model
    return (st(torch.as_tensor(X, dtype=torch.float64)) @ w + b).numpy()


def probe_direction(model):
    """The probe's direction in the model's own residual space (undoing the standardisation), as a unit vector."""
    w, _, st = model
    d = (w / st.sd[0]).numpy()
    return d / (np.linalg.norm(d) + 1e-12)


def choose_l2(X, y, grid=(1e-3, 1e-2, 1e-1, 1.0, 10.0), folds=3, seed=0, groups=None, with_acc=False):
    """The L2 strength with the best cross-validated accuracy; with groups, each fold holds whole groups. with_acc
    also returns that accuracy, which picks a probe's best layer without looking at the held-out set."""
    y = np.asarray(y)
    rng = np.random.default_rng(seed)
    fold = np.empty(len(y), dtype=np.int64)
    if groups is None:
        fold[rng.permutation(len(y))] = np.arange(len(y)) % folds
    else:
        g = np.asarray(groups)
        at = {v: i % folds for i, v in enumerate(rng.permutation(np.unique(g)))}
        fold[:] = [at[v] for v in g]
    best, best_acc = grid[0], -1
    for l2 in grid:
        accs = []
        for f in range(folds):
            te, tr = np.flatnonzero(fold == f), np.flatnonzero(fold != f)
            if len(np.unique(y[tr])) < 2:
                continue
            m = fit_logistic(X[tr], y[tr], l2=l2, iters=100)
            accs.append(((probe_scores(m, X[te]) > 0) == (y[te] > 0.5)).mean())
        acc = float(np.mean(accs)) if accs else 0
        if acc > best_acc + 1e-9:
            best, best_acc = l2, acc
    return (best, best_acc) if with_acc else best


def midpoint(scores, y):
    """The cut half-way between two classes' mean scores."""
    s, y = np.asarray(scores, dtype=np.float64), np.asarray(y) > 0.5
    return float((s[y].mean() + s[~y].mean()) / 2)


def right_side(scores, y, test, calib=None, thr=0.0):
    """Which test items a probe gets right: score above the cut means positive. The cut is the probe's own (thr)
    unless calib names examples to re-centre it on, half-way between their two class means. A probe carried to a new
    set keeps its direction but not its offset (the whole set can sit to one side), so a transfer test fits that one
    number on examples from the new set, never on the scored ones."""
    s, y = np.asarray(scores, dtype=np.float64), np.asarray(y)
    if calib is not None:
        thr = midpoint(s[calib], y[calib])
    return (s[test] > thr) == (y[test] == 1)


def feature_probe(F, y, train, test, seed=0, groups=None, grid=None, calib=None):
    """A control probe on fixed features of each text (which words it contains, what they mean), fit and scored the
    way the real probe is: logistic regression with the L2 strength cross-validated inside the training texts, and the
    cut re-centred on calib when given (as for the real probe in a transfer test). Returns which test items it gets
    right."""
    y = np.asarray(y)
    l2 = choose_l2(F[train], y[train], seed=seed, groups=groups, **({'grid': grid} if grid else {}))
    return right_side(probe_scores(fit_logistic(F[train], y[train], l2), F), y, test, calib)


def words_probe(seqs, y, train, test, seed=0, groups=None, grid=None, calib=None):
    """The words-only control for a probe: a feature_probe on which tokens each text contains (the training half's
    vocabulary, present or absent). Returns (correct on each test item, vocabulary size)."""
    vocab = {t: j for j, t in enumerate(sorted({t for i in train for t in seqs[i]}))}
    W = np.zeros((len(seqs), len(vocab)))
    for i, sq in enumerate(seqs):
        W[i, [vocab[t] for t in sq if t in vocab]] = 1.0
    return feature_probe(W, y, train, test, seed, groups, grid, calib), len(vocab)


def diff_means(X, y):
    """Difference of class means as a unit direction, with the threshold halfway between the projected means.
    Often the more causal of the two probes (Marks and Tegmark, The Geometry of Truth, 2023)."""
    X = np.asarray(X, dtype=np.float64)
    y = np.asarray(y)
    mu1, mu0 = X[y > 0.5].mean(0), X[y <= 0.5].mean(0)
    d = mu1 - mu0
    raw_norm = float(np.linalg.norm(d))
    d = d / (raw_norm + 1e-12)
    thr = float((mu1 @ d + mu0 @ d) / 2)
    return d, thr, raw_norm


def auc(scores, y):
    """Area under the ROC curve via the rank statistic (ties counted half)."""
    s = np.asarray(scores, dtype=np.float64)
    y = np.asarray(y) > 0.5
    pos, neg = s[y], s[~y]
    if len(pos) == 0 or len(neg) == 0:
        return float('nan')
    order = np.argsort(np.concatenate([pos, neg]), kind='mergesort')
    ranks = np.empty(len(order))
    allv = np.concatenate([pos, neg])[order]
    i = 0
    while i < len(allv):
        j = i
        while j + 1 < len(allv) and allv[j + 1] == allv[i]:
            j += 1
        ranks[order[i:j + 1]] = (i + j) / 2 + 1
        i = j + 1
    return float((ranks[:len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


def pca2(X):
    """The two directions of greatest spread, and every row's coordinates on them."""
    X = np.asarray(X, dtype=np.float64)
    Xc = X - X.mean(0, keepdims=True)
    if Xc.shape[0] < 3:
        return np.zeros((X.shape[0], 2)), [0.0, 0.0]
    u, s, vt = np.linalg.svd(Xc, full_matrices=False)
    var = s ** 2
    ratio = (var[:2] / var.sum()).tolist() if var.sum() > 0 else [0.0, 0.0]
    return Xc @ vt[:2].T, ratio


def zscore(x, ref):
    ref = np.asarray(ref, dtype=np.float64)
    sd = ref.std(ddof=1) if ref.size > 1 else float('nan')
    return float((x - ref.mean()) / sd) if sd and sd == sd and sd > 0 else float('nan')
