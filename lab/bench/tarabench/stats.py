"""The statistics every engine leans on: bootstrap and exact binomial intervals, train/test splits that keep matched
pairs together, linear probes, difference-of-means directions, PCA.

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


def choose_l2(X, y, grid=(1e-3, 1e-2, 1e-1, 1.0, 10.0), folds=3, seed=0, groups=None):
    """The L2 strength with the best cross-validated accuracy; with groups, each fold holds whole groups."""
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
    return best


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
