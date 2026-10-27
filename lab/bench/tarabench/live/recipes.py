"""The lab's tools on a model held by the live server: the same recipes as lab/core/recipes.js, with the same
arguments and the same result shapes, so a tool page cannot tell which engine answered. The differences are the
model's: an RMS norm instead of a layer norm (nothing to centre), SwiGLU neurons (silu(gate) * up, which can be
negative), no positional embedding, attention patterns only in attention layers, and heads per layer that differ
between attention and DeltaNet layers. Head arrays are L x H with NaN where a layer has fewer than H heads.

Each recipe is fn(m, args, ctx) -> result, with m a LiveModel and ctx.progress(x), ctx.check() (raises Cancelled
when the page gave up). Results hold numpy arrays where the browser's hold typed arrays; wire.py sends them as raw
bytes, and half() marks the big ones to travel as float16."""
import math

import numpy as np
import torch

from .wire import half

NAN = float('nan')


# ---------------------------------------------------------------- helpers

def lcg(seed):
    """The browser's generator (lab/core/recipes.js rngFrom), so a seed draws the same numbers on either engine."""
    s = [(int(seed) & 0xffffffff) or 1]

    def rand():
        s[0] = (s[0] * 1664525 + 1013904223) & 0xffffffff
        return s[0] / 4294967296
    return rand


def random_unit(rand, n):
    """A random direction of length 1, uniform on the sphere, drawn as lab/core/recipes.js randomUnit draws it."""
    v = np.zeros(n, dtype=np.float64)
    for i in range(0, n, 2):
        u, w = max(1e-12, rand()), rand()
        r = math.sqrt(-2 * math.log(u))
        v[i] = r * math.cos(2 * math.pi * w)
        if i + 1 < n:
            v[i + 1] = r * math.sin(2 * math.pi * w)
    return (v / np.sqrt((v * v).sum())).astype(np.float32)


def last_pos(ids, pos):
    if pos is None:
        return len(ids) - 1
    return len(ids) + pos if pos < 0 else pos


def topk_ids(x, k, sign=1):
    k = min(int(k), x.numel())
    return (x if sign > 0 else -x).topk(k).indices.tolist()


def entropy(lp):
    """Entropy in nats of each row of log-probabilities [..., V]."""
    return -(lp.exp() * lp).nan_to_num(0.0).sum(-1)


def rank_of(lg, t):
    return int((lg > lg[t]).sum())


def metric_rows(res, metric):
    j = res['lpos'].index(int(metric['pos']))
    lg = res['logits'][:, j]
    kind = metric.get('kind', 'logitdiff')
    if kind == 'logitdiff':
        out = lg[:, int(metric['a'])] - lg[:, int(metric['b'])]
    else:
        lp = torch.log_softmax(lg, -1)[:, int(metric['t'])]
        out = lp.exp() if kind == 'prob' else lp
    return out.double().cpu().numpy()


def z_abs(x):
    """|x| z-scored over its own entries."""
    a = x.abs()
    return (a - a.mean()) / (a.std(unbiased=False) + 1e-8)


def as_t(x, m):
    return torch.as_tensor(np.asarray(x, dtype=np.float32), device=m.device)


def chunk_of(m, args, T):
    """Rows per batched pass: the page's choice, else as many as keep one pass's MLP activations near 400 MB."""
    if args.get('chunk'):
        return max(1, int(args['chunk']))
    per_row = max(1, T) * m.M * 2 * 4
    return int(max(4, min(48, 400e6 // per_row)))


def hstack(m, rows, cols):
    return np.full(rows * cols, NAN, dtype=np.float32)


# ---------------------------------------------------------------- recipes

def predict(m, a, ctx):
    ids, k, targets = a['ids'], int(a.get('k', 10)), [int(t) for t in a.get('targets') or []]
    r = m.forward([ids], logits='last', check=ctx.check)
    lg = r['logits'][0, 0]
    lp = torch.log_softmax(lg, -1)
    top = topk_ids(lg, k)
    return {'top': top, 'probs': lp[top].exp().tolist(), 'logits': lg[top].tolist(), 'entropy': float(entropy(lp)),
            'targets': [{'id': t, 'prob': float(lp[t].exp()), 'logit': float(lg[t]), 'rank': rank_of(lg, t)} for t in targets],
            'all': lg.cpu().numpy() if a.get('full') else None}


def per_token(m, a, ctx):
    ids, k = a['ids'], int(a.get('k', 5))
    T = len(ids)
    r = m.forward([ids], logits='none', check=ctx.check)
    rf = r['cap']['resid_final'][0]
    top = np.zeros(T * k, dtype=np.int32)
    prob = np.zeros(T * k, dtype=np.float32)
    next_lp = np.full(T, NAN, dtype=np.float32)
    next_rank = np.full(T, -1, dtype=np.int32)
    ent = np.zeros(T, dtype=np.float32)
    nxt = torch.tensor(ids[1:] + [0], device=m.device)
    for a0 in range(0, T, 32):
        ctx.check()
        lg = m.unembed(m.normed(rf[a0:a0 + 32]))
        lp = torch.log_softmax(lg, -1)
        n = lg.shape[0]
        tv = lg.topk(k, -1).indices
        top[a0 * k:(a0 + n) * k] = tv.reshape(-1).cpu().numpy()
        prob[a0 * k:(a0 + n) * k] = lp.gather(-1, tv).exp().reshape(-1).cpu().numpy()
        ent[a0:a0 + n] = entropy(lp).cpu().numpy()
        nt = nxt[a0:a0 + n]
        got = lg.gather(-1, nt.unsqueeze(-1))
        lpn = lp.gather(-1, nt.unsqueeze(-1)).squeeze(-1).cpu().numpy()
        rk = (lg > got).sum(-1).cpu().numpy()
        for j in range(n):
            p = a0 + j
            if p + 1 < T:
                next_lp[p], next_rank[p] = lpn[j], rk[j]
    return {'k': k, 'top': top, 'prob': prob, 'nextLp': next_lp, 'nextRank': next_rank, 'entropy': ent}


def logit_lens(m, a, ctx):
    ids, k, target = a['ids'], int(a.get('k', 3)), a.get('target')
    T, S = len(ids), m.L + 1
    pos = [int(p) for p in (a.get('positions') or range(T))]
    P = len(pos)
    r = m.forward([ids], capture={'resid_pre': [0], 'resid_post': True}, logits='none', check=ctx.check)
    cap = r['cap']
    pt = torch.tensor(pos, device=m.device)
    streams = [cap['resid_pre'][0][0]] + [cap['resid_post'][l][0] for l in range(m.L)]
    top = np.zeros(S * P * k, dtype=np.int32)
    prob = np.zeros(S * P * k, dtype=np.float32)
    t_prob = np.full(S * P, NAN, dtype=np.float32)
    t_rank = np.full(S * P, -1, dtype=np.int32)
    ent = np.zeros(S * P, dtype=np.float32)
    rows = torch.cat([s[pt] for s in streams])               # [S * P, D], row q = s * P + j
    CH = 48
    for q0 in range(0, S * P, CH):
        ctx.check()
        lg = m.unembed(m.normed(rows[q0:q0 + CH]))
        lp = torch.log_softmax(lg, -1)
        n = lg.shape[0]
        tv = lg.topk(k, -1).indices
        top[q0 * k:(q0 + n) * k] = tv.reshape(-1).cpu().numpy()
        prob[q0 * k:(q0 + n) * k] = lp.gather(-1, tv).exp().reshape(-1).cpu().numpy()
        ent[q0:q0 + n] = entropy(lp).cpu().numpy()
        if target is not None:
            t = int(target)
            t_prob[q0:q0 + n] = lp[:, t].exp().cpu().numpy()
            t_rank[q0:q0 + n] = (lg > lg[:, t:t + 1]).sum(-1).cpu().numpy()
        ctx.progress({'done': min(S * P, q0 + CH), 'total': S * P})
    return {'S': S, 'P': P, 'k': k, 'positions': pos, 'top': top, 'prob': prob, 'tProb': t_prob, 'tRank': t_rank,
            'entropy': ent}


def _pattern_stats(m, A, T, l, out):
    """bos, previous-token, self and entropy averages for each head of one attention layer's pattern [H, T, T]."""
    nh = m.heads[l]
    t = torch.arange(1, T, device=A.device)
    rows = A[:, 1:]                                           # [H, T-1, T]
    prev, selfw = A[:, t, t - 1], A[:, t, t]                  # [H, T-1]
    ent = -(rows * rows.clamp_min(1e-30).log()).sum(-1)       # [H, T-1]
    bos = A[:, 2:, 0].mean(-1) if T > 2 else torch.zeros(nh, device=A.device)
    for hh in range(nh):
        q = l * m.H + hh
        out['bos'][q] = float(bos[hh])
        out['prev'][q] = float(prev[hh].mean()) if T > 1 else 0.0
        out['self'][q] = float(selfw[hh].mean()) if T > 1 else 0.0
        out['entropy'][q] = float(ent[hh].mean()) if T > 1 else 0.0


def attention(m, a, ctx):
    ids = a['ids']
    T = len(ids)
    r = m.forward([ids], capture={'attn_pattern': True}, logits='none', check=ctx.check)
    out = {key: np.full(m.L * m.H, NAN, dtype=np.float32) for key in ('bos', 'prev', 'self', 'entropy')}
    patterns = [None] * m.L
    for l, A in r['cap'].get('attn_pattern', {}).items():
        A = A[0].float()                                      # [H, T, T]
        _pattern_stats(m, A, T, l, out)
        flat = A.reshape(-1).cpu().numpy()
        patterns[l] = half(flat) if flat.size > 2_000_000 else flat
    return {'T': T, 'patterns': patterns, **out}


def head_scores(m, a, ctx):
    seq, batch, seed = int(a.get('seqLen', 50)), int(a.get('batch', 4)), int(a.get('seed', 7))
    rand, n = lcg(seed), m.regular_ids()
    ids = []
    for _ in range(batch):
        hf = [int(rand() * n) for _ in range(seq)]
        ids.append([m.bos] + hf + hf)
    r = m.forward(ids, capture={'attn_pattern': True}, logits='none', check=ctx.check)
    T = 2 * seq + 1
    out = {key: np.full(m.L * m.H, NAN, dtype=np.float32) for key in ('prev', 'dup', 'induction', 'bos')}
    t = torch.arange(1, T, device=m.device)
    i = torch.arange(seq, device=m.device)
    tt, first = seq + 1 + i, 1 + i
    for l, A in r['cap'].get('attn_pattern', {}).items():
        A = A.float()                                         # [B, H, T, T]
        prev = A[:, :, t, t - 1].mean((0, 2))
        bos = A[:, :, t, 0].mean((0, 2))
        dup = A[:, :, tt, first].mean((0, 2))
        ok = first + 1 < tt
        ind = (A[:, :, tt, (first + 1).clamp_max(T - 1)] * ok).sum(2).sum(0) / (batch * seq)
        for hh in range(m.heads[l]):
            q = l * m.H + hh
            out['prev'][q], out['bos'][q], out['dup'][q], out['induction'][q] = float(prev[hh]), float(bos[hh]), float(dup[hh]), float(ind[hh])
    return {**out, 'seqLen': seq, 'batch': batch}


def _logit_dir(m, a, b):
    d = m.W_U[int(a)].float()
    if b is not None:
        d = d - m.W_U[int(b)].float()
    return d * m.gF


def dla(m, a, ctx):
    ids, ta, tb = a['ids'], int(a['a']), a.get('b')
    tb = None if tb is None else int(tb)
    p = last_pos(ids, a.get('pos'))
    r = m.forward([ids], capture={'attn_z': True, 'mlp_out': True, 'mlp_post': True}, logits=[p], check=ctx.check)
    cap = r['cap']
    d = _logit_dir(m, ta, tb)
    inv = float(m.rms(cap['resid_final'][0, p]))
    embed = inv * float(m.E[int(ids[p])].float() @ d)
    heads = np.full(m.L * m.H, NAN, dtype=np.float32)
    mlp = np.zeros(m.L, dtype=np.float32)
    nscore = torch.empty(m.L, m.M, device=m.device, dtype=torch.float32)
    for l in range(m.L):
        ctx.check()
        z = cap['attn_z'][l][0, p].float()
        u = m.w_out(l).float().T @ d                          # what a unit of each z coordinate adds to the direction
        heads[l * m.H:l * m.H + m.heads[l]] = (inv * (z * u).view(m.heads[l], m.dh[l]).sum(-1)).cpu().numpy()
        mlp[l] = inv * float(cap['mlp_out'][l][0, p].float() @ d)
        nscore[l] = cap['mlp_post'][l][0, p].float() * inv * (m.w_down(l).float().T @ d)
    total = embed + float(np.nansum(heads)) + float(mlp.sum())
    lg = r['logits'][0, 0]
    lp = torch.log_softmax(lg, -1)
    actual = float(lg[ta] - (lg[tb] if tb is not None else 0))
    flat = nscore.reshape(-1)
    k = int(a.get('neurons', 30))
    up, down = topk_ids(flat, k), topk_ids(flat, k, -1)
    return {'pos': p, 'embed': embed, 'posEmbed': 0.0, 'constant': 0.0, 'heads': heads,
            'attnBias': np.zeros(m.L, dtype=np.float32), 'mlp': mlp, 'sum': total, 'actual': actual, 'inv': inv,
            'probs': [float(lp[ta].exp()), None if tb is None else float(lp[tb].exp())],
            'ranks': [rank_of(lg, ta), None if tb is None else rank_of(lg, tb)],
            'neuronsUp': [[g, float(flat[g])] for g in up], 'neuronsDown': [[g, float(flat[g])] for g in down]}


def metric(m, a, ctx):
    ids, met, ivs = a['ids'], a['metric'], a.get('ivs') or [[]]
    R, CH, vals = len(ivs), chunk_of(m, a, len(ids)), []
    for c0 in range(0, R, CH):
        ctx.check()
        part = ivs[c0:c0 + CH]
        iv = [{**x, 'rows': [r]} for r, lst in enumerate(part) for x in lst]
        res = m.forward([ids] * len(part), iv=iv, logits=[int(met['pos'])], check=ctx.check)
        vals.extend(metric_rows(res, met).tolist())
    return {'values': vals}


def head_sweep(m, a, ctx):
    ids, met, mode = a['ids'], a['metric'], a.get('mode', 'zero')
    T = len(ids)
    mean = None
    if mode == 'mean':
        c = m.forward([ids], capture={'attn_z': True}, logits='none', check=ctx.check)
        mean = {l: z[0, 1:].float().mean(0) if T > 1 else z[0, 0].float() for l, z in c['cap']['attn_z'].items()}
    jobs = [(l, hh) for l in range(m.L) for hh in range(m.heads[l])]
    CH = chunk_of(m, a, T)
    base = m.forward([ids], logits=[int(met['pos'])], check=ctx.check)
    clean = float(metric_rows(base, met)[0])
    delta = hstack(m, m.L, m.H)
    for c0 in range(0, len(jobs), CH):
        ctx.check()
        part = jobs[c0:c0 + CH]
        iv = [{'hook': 'head', 'layer': l, 'head': hh, 'op': 'mean', 'mean': mean[l], 'rows': [r]} if mode == 'mean'
              else {'hook': 'head', 'layer': l, 'head': hh, 'op': 'mul', 'value': 0, 'rows': [r]}
              for r, (l, hh) in enumerate(part)]
        res = m.forward([ids] * len(part), iv=iv, logits=[int(met['pos'])], check=ctx.check)
        vals = metric_rows(res, met)
        for r, (l, hh) in enumerate(part):
            delta[l * m.H + hh] = vals[r] - clean
        ctx.progress({'done': c0 + len(part), 'total': len(jobs)})
    return {'clean': clean, 'delta': delta, 'mode': mode}


RESID_HOOKS = ('resid_pre', 'resid_mid', 'resid_post', 'attn_out', 'mlp_out')


def patch(m, a, ctx):
    clean, corrupt, met = a['clean'], a['corrupt'], a['metric']
    hook, direction = a.get('hook', 'resid_pre'), a.get('direction', 'denoise')
    if len(clean) != len(corrupt):
        raise ValueError('The two prompts must have the same number of tokens')
    if hook != 'head' and hook not in RESID_HOOKS:
        raise ValueError(f'cannot patch {hook!r}')
    T = len(clean)
    src, dst = (clean, corrupt) if direction == 'denoise' else (corrupt, clean)
    cap_name = 'attn_z' if hook == 'head' else hook
    pos = int(met['pos'])
    s = m.forward([src], capture={cap_name: True}, logits=[pos], check=ctx.check)
    d = m.forward([dst], logits=[pos], check=ctx.check)
    mc = float(metric_rows(s if direction == 'denoise' else d, met)[0])
    mx = float(metric_rows(d if direction == 'denoise' else s, met)[0])
    cols = m.H if hook == 'head' else T
    jobs = [(l, hh) for l in range(m.L) for hh in range(m.heads[l])] if hook == 'head' else \
        [(l, p) for l in range(m.L) for p in range(T)]
    CH = chunk_of(m, a, T)
    raw = hstack(m, m.L, cols)
    for c0 in range(0, len(jobs), CH):
        ctx.check()
        part = jobs[c0:c0 + CH]
        iv = [{'hook': 'head', 'layer': l, 'head': x, 'op': 'set', 'src': s['cap']['attn_z'][l], 'rows': [r]} if hook == 'head'
              else {'hook': hook, 'layer': l, 'op': 'set', 'src': s['cap'][hook][l], 'pos': x, 'rows': [r]}
              for r, (l, x) in enumerate(part)]
        res = m.forward([dst] * len(part), iv=iv, logits=[pos], check=ctx.check)
        vals = metric_rows(res, met)
        for r, (l, x) in enumerate(part):
            raw[l * cols + x] = vals[r]
        ctx.progress({'done': c0 + len(part), 'total': len(jobs)})
    span = mc - mx
    score = ((raw - mx) / (span or 1)).astype(np.float32)
    return {'rows': m.L, 'cols': cols, 'raw': raw, 'score': score, 'clean': mc, 'corrupt': mx, 'hook': hook,
            'direction': direction}


def fires(m, a, ctx):
    ids = a['ids']
    T = len(ids)
    r = m.forward([ids], capture={'mlp_post': True, 'resid_mid': True}, logits='none', check=ctx.check)
    cap = r['cap']
    acts = torch.stack([cap['mlp_post'][l][0] for l in range(m.L)])          # [L, T, M]
    sigma = torch.stack([1 / m.rms(cap['resid_mid'][l][0]) for l in range(m.L)])
    if T > 1:
        mx, arg = acts[:, 1:].float().max(1)
        arg = arg + 1
    else:
        mx, arg = torch.full((m.L, m.M), -1.0, device=m.device), torch.zeros(m.L, m.M, dtype=torch.long, device=m.device)
    return {'T': T, 'acts': half(acts.reshape(-1).float().clamp(-65000, 65000).cpu().numpy()),
            'max': mx.reshape(-1).float().cpu().numpy(), 'argmax': arg.reshape(-1).to(torch.int16).cpu().numpy(),
            'sigma': sigma.reshape(-1).float().cpu().numpy()}


def neuron_trace(m, a, ctx):
    l, n = int(a['layer']), int(a['neuron'])
    r = m.forward([a['ids']], capture={'mlp_post': [l]}, logits='none', check=ctx.check)
    return {'acts': r['cap']['mlp_post'][l][0, :, n].float().cpu().numpy()}


def vector(m, a, ctx):
    pos, neg, l = a['pos'], a['neg'], int(a['layer'])
    hook, mode = a.get('hook', 'resid_pre'), a.get('mode', 'last')
    A = m.forward([pos], capture={hook: [l]}, logits='none', check=ctx.check)['cap'][hook][l][0].float()
    B = m.forward([neg], capture={hook: [l]}, logits='none', check=ctx.check)['cap'][hook][l][0].float()
    if mode == 'last':
        v = A[-1] - B[-1]
    else:
        v = (A[1:].mean(0) if A.shape[0] > 1 else A[0]) - (B[1:].mean(0) if B.shape[0] > 1 else B[0])
    return {'vec': v.cpu().numpy(), 'norm': float(v.norm())}


def _lens(m, X, k):
    """Top and bottom tokens of rows X [n, D] read through the unembedding, measured from each row's vocabulary
    mean (adding the same amount to every logit changes no probability)."""
    lg = m.unembed(X)
    lg = lg - lg.mean(-1, keepdim=True)
    out = []
    for row in lg:
        up, down = topk_ids(row, k), topk_ids(row, k, -1)
        out.append({'up': [[t, float(row[t])] for t in up], 'down': [[t, float(row[t])] for t in down]})
    return out


def unembed_vec(m, a, ctx):
    v = as_t(a['vec'], m).reshape(1, -1)
    return _lens(m, v * m.gF, int(a.get('k', 12)))[0]


def residuals(m, a, ctx):
    texts, hook, pool = a['texts'], a.get('hook', 'resid_post'), a.get('pos', 'last')
    n = len(texts)
    out = torch.zeros(n, m.L, m.D, dtype=torch.float32)
    for j, ids in enumerate(texts):
        ctx.check()
        r = m.forward([ids], capture={hook: True}, logits='none', check=ctx.check)
        for l in range(m.L):
            X = r['cap'][hook][l][0].float()
            out[j, l] = (X[-1] if pool == 'last' else (X[1:].mean(0) if X.shape[0] > 1 else X[0])).cpu()
        ctx.progress({'done': j + 1, 'total': n})
    flat = out.reshape(-1).numpy()
    return {'n': n, 'vecs': half(flat) if flat.size > 4_000_000 else flat}


def neuron_weights(m, a, ctx):
    l, n, k = int(a['layer']), int(a['neuron']), int(a.get('k', 12))
    wout = m.w_down(l)[:, n].float()
    win = m.w_gate(l)[n].float()
    up = m.w_up(l)[n].float()
    lens = _lens(m, (wout * m.gF).reshape(1, -1), k)[0]
    return {'wout': wout.cpu().numpy(), 'win': win.cpu().numpy(), 'winUp': up.cpu().numpy(),
            'read': (win * m.g2(l)).cpu().numpy(), 'lens': lens, 'woutNorm': float(m.woutNorm[l, n]),
            'residNorm': float(m.stats()[l])}


def ov_circuit(m, a, ctx):
    l, hh, tokens = int(a['layer']), int(a['head']), [int(t) for t in a['tokens']]
    embed, k = a.get('embed', 'block0'), int(a.get('k', 8))
    if m.kind[l] != 'attention':
        attn = ', '.join(str(i) for i, x in enumerate(m.kind) if x == 'attention')
        raise ValueError(f'Layer {l} mixes tokens with a DeltaNet, which has no attention pattern to read; the attention layers are {attn}.')
    if not 0 <= hh < m.heads[l]:
        raise ValueError(f'Layer {l} has {m.heads[l]} heads')
    n, layer, dh = len(tokens), m.layers[l], m.dh[l]
    if embed == 'raw':
        X = m.E[torch.tensor(tokens, device=m.device)].float()
    else:
        # what the head reads at a token with nothing before it but <|endoftext|>: the stream entering its layer
        r = m.forward([[m.bos, t] for t in tokens], capture={'resid_pre': [l]}, logits='none', check=ctx.check)
        X = r['cap']['resid_pre'][l][:, 1].float()
    xn = layer.input_layernorm(X)                              # float32 in, float32 out
    mx = layer.self_attn
    groups = m.heads[l] // max(1, int(mx.k_proj.out_features) // dh)
    g = hh // max(1, groups)
    Wv = dequant(mx.v_proj).float()[g * dh:(g + 1) * dh]       # [dh, D]
    v = xn @ Wv.T
    bias = getattr(mx.v_proj, 'bias', None)
    if bias is not None:
        v = v + bias.float()[g * dh:(g + 1) * dh]
    Wo = m.w_out(l).float()[:, hh * dh:(hh + 1) * dh]          # [D, dh]
    outs = v @ Wo.T                                            # [n, D], the head's gate taken as fully open
    scale = math.sqrt(m.D) / (m.stats()[m.L - 1] or 100)
    lg = m.unembed(outs * m.gF * scale)
    tok = torch.tensor(tokens, device=m.device)
    raw = lg[:, tok]
    mat = raw - raw.mean(0, keepdim=True)
    self_rank = [rank_of(lg[j], tokens[j]) for j in range(n)]
    top = [[[t, float(lg[j, t])] for t in topk_ids(lg[j], k)] for j in range(n)]
    return {'n': n, 'mat': mat.reshape(-1).cpu().numpy(), 'raw': raw.reshape(-1).cpu().numpy(),
            'selfRank': np.array(self_rank, dtype=np.int32), 'top': top, 'embed': embed, 'scale': scale}


def neuron_lens(m, a, ctx):
    gids, k = [int(g) for g in a['neurons']], int(a.get('k', 6))
    scale = math.sqrt(m.D) / (m.stats()[m.L - 1] or 100)
    X = torch.empty(len(gids), m.D, device=m.device, dtype=torch.float32)
    by = {}
    for j, g in enumerate(gids):
        by.setdefault(g // m.M, []).append((j, g % m.M))
    for l, items in by.items():
        W = m.w_down(l)
        for j, nn in items:
            X[j] = W[:, nn].float()
    lens = _lens(m, X * m.gF * scale, k) if gids else []
    return {'lens': lens, 'scale': scale}


def neuron_links(m, a, ctx):
    l, n, k = int(a['layer']), int(a['neuron']), int(a.get('k', 8))
    acts, sigma = a.get('acts'), a.get('sigma')
    rn = m.link_norms()                                        # [L, M]: |W_gate[b] * g2|
    take = lambda rows: sorted(rows, key=lambda r: -r[1])[:k]
    dA = m.w_down(l)[:, n].float()
    nA = float(m.woutNorm[l, n])
    feeds = []
    for j in range(l + 1, m.L):
        ctx.check()
        S = m.w_gate(j).float() @ (dA * m.g2(j))
        cos = S / (nA * rn[j]).clamp_min(1e-12)
        z = z_abs(cos)
        for b in topk_ids(z, k):
            feeds.append([j * m.M + b, float(z[b]), float(cos[b]), float(S[b])])
    u = m.w_gate(l)[n].float() * m.g2(l)
    nB = float(rn[l, n])
    fed, pushed, total = [], [], 0.0
    A = as_t(acts, m) if acts is not None else None
    for i in range(l):
        ctx.check()
        Z = m.w_down(i).float().T @ u                          # [M]
        cos = Z / (m.woutNorm[i] * nB).clamp_min(1e-12)
        z = z_abs(cos)
        for b in topk_ids(z, k):
            fed.append([i * m.M + b, float(z[b]), float(cos[b]), float(Z[b])])
        if A is not None:
            c = A[i * m.M:(i + 1) * m.M] * Z / float(sigma or 1)
            total += float(c.sum())
            mag = c.abs()
            for b in topk_ids(mag, k):
                if float(mag[b]) > 1e-4:
                    pushed.append([i * m.M + b, float(mag[b]), float(c[b])])
    return {'feeds': take(feeds), 'fedBy': take(fed),
            'pushed': [[g, c] for g, _, c in take(pushed)] if A is not None else None, 'pushedTotal': total}


def neuron_push(m, a, ctx):
    ids, l, n = a['ids'], int(a['layer']), int(a['neuron'])
    dose, controls = float(a.get('dose', 0.8)), int(a.get('controls', 4))
    seed, k, floor = int(a.get('seed', 11)), int(a.get('k', 10)), float(a.get('floor', 1e-4))
    R, rn = 2 + controls, float(m.stats()[l])
    rand = lcg(seed + 7919 * l + n)
    iv = [{'hook': 'mlp_post', 'layer': l, 'neuron': n, 'op': 'addr', 'rows': [1], 'value': dose}]
    for c in range(controls):
        iv.append({'hook': 'mlp_out', 'layer': l, 'op': 'add', 'rows': [2 + c], 'vec': random_unit(rand, m.D) * rn, 'value': dose})
    res = m.forward([ids] * R, iv=iv, logits='last', check=ctx.check)
    lp = torch.log_softmax(res['logits'][:, 0], -1)            # [R, V]
    kl = lambda r: float((lp[r].exp() * (lp[r] - lp[0])).sum())
    lf = math.log(floor)
    dlt = lp[1] - lp[0]
    rise = torch.where(lp[1] >= lf, dlt, torch.full_like(dlt, -math.inf))
    fall = torch.where(lp[0] >= lf, dlt, torch.full_like(dlt, math.inf))
    row = lambda t: [t, float(dlt[t]), float(lp[0, t].exp()), float(lp[1, t].exp())]
    return {'up': [row(t) for t in topk_ids(rise, k) if float(rise[t]) > 0],
            'down': [row(t) for t in topk_ids(fall, k, -1) if float(fall[t]) < 0],
            'before': [[t, float(lp[0, t].exp())] for t in topk_ids(lp[0], 5)],
            'after': [[t, float(lp[1, t].exp())] for t in topk_ids(lp[1], 5)],
            'kl': kl(1), 'klCtrl': [kl(2 + c) for c in range(controls)], 'unit': rn, 'dose': dose}


def lens_search(m, a, ctx):
    t, k = int(a['token']), int(a.get('k', 40))
    scale = math.sqrt(m.D) / (m.stats()[m.L - 1] or 100)
    u = (m.W_U[t].float() - m.mean_unembed()) * m.gF * scale
    val = torch.empty(m.L, m.M, device=m.device, dtype=torch.float32)
    for l in range(m.L):
        ctx.check()
        val[l] = m.w_down(l).float().T @ u
    flat = val.reshape(-1)
    return {'up': [[g, float(flat[g])] for g in topk_ids(flat, k)], 'down': [[g, float(flat[g])] for g in topk_ids(flat, k, -1)]}


# ---------------------------------------------------------------- dictionaries (Qwen-Scope TopK SAEs)

def _sae(m):
    S = getattr(m, 'sae', None)
    if S is None:
        raise ValueError('The dictionary is not loaded yet')
    return S


def _codes(m, S, ids, check):
    """The stream the dictionary reads (the output of its layer) at every token, and its TopK codes there."""
    r = m.forward([ids], capture={'resid_post': [S.layer]}, logits='none', check=check)
    X = r['cap']['resid_post'][S.layer][0].to(S.W_enc.dtype)
    pre = X @ S.W_enc.T + S.b_enc                              # [T, F]
    vals, idx = pre.topk(S.k, -1)
    return X, pre, vals.clamp_min(0), idx


def sae_encode(m, a, ctx):
    S = _sae(m)
    ids, k, top = a['ids'], int(a.get('k', 6)), int(a.get('top', 40))
    T = len(ids)
    X, _, vals, idx = _codes(m, S, ids, ctx.check)
    topF = np.full(T * k, -1, dtype=np.int32)
    topV = np.zeros(T * k, dtype=np.float32)
    l0 = np.zeros(T, dtype=np.int16)
    miss = np.zeros(T, dtype=np.float32)
    if T > 1:
        v, i = vals[1:].float(), idx[1:]
        rec = torch.zeros(T - 1, S.F, device=v.device, dtype=S.W_dec.dtype).scatter(-1, i, v.to(S.W_dec.dtype))
        xh = (rec @ S.W_dec.T + S.b_dec).float()
        x = X[1:].float()
        err = (x - xh).pow(2).sum(-1)
        miss[1:] = (err / x.pow(2).sum(-1).clamp_min(1e-9)).cpu().numpy()
        l0[1:] = (v > 0).sum(-1).cpu().numpy()
        kk = min(k, S.k)
        tv, tj = v.topk(kk, -1)                                # vals are sorted already; this keeps the k strongest
        TV, TJ = tv.cpu().numpy(), i.gather(-1, tj).cpu().numpy()
        for t in range(1, T):
            for q in range(kk):
                if TV[t - 1, q] > 0:
                    topF[t * k + q], topV[t * k + q] = TJ[t - 1, q], TV[t - 1, q]
        ev = 1 - float(err.sum()) / max(1e-9, float((x - x.mean(0)).pow(2).sum())) if T > 2 else NAN
        dense = torch.zeros(T - 1, S.F, device=v.device, dtype=torch.float32).scatter(-1, i, v)
        fmax, farg = dense.max(0)
        best = topk_ids(fmax, top)
        strongest = [[j, float(fmax[j]), int(farg[j]) + 1] for j in best if float(fmax[j]) > 0]
    else:
        ev, strongest = NAN, []
    return {'T': T, 'k': k, 'topF': topF, 'topV': topV, 'l0': l0, 'miss': miss, 'ev': ev, 'strongest': strongest}


def sae_trace(m, a, ctx):
    S = _sae(m)
    ids, j = a['ids'], int(a['feature'])
    _, _, vals, idx = _codes(m, S, ids, ctx.check)
    hit = (idx == j)
    out = (vals.float() * hit).sum(-1)
    out[0] = 0
    return {'acts': out.cpu().numpy()}


def sae_row(m, a, ctx):
    S = _sae(m)
    return {'dec': S.W_dec[:, int(a['feature'])].float().cpu().numpy()}


def sae_neighbors(m, a, ctx):
    S = _sae(m)
    j, k = int(a['feature']), int(a.get('k', 8))
    if getattr(S, 'dec_norm', None) is None:
        S.dec_norm = S.W_dec.float().norm(dim=0).clamp_min(1e-9)
    q = S.W_dec[:, j].float()
    cos = (q @ S.W_dec.float()) / (S.dec_norm * S.dec_norm[j])
    cos[j] = -2
    return {'near': [[f, float(cos[f])] for f in topk_ids(cos, k)]}


def dequant(lin):
    from .model import dequant as dq
    return dq(lin)


# ---------------------------------------------------------------- writing

def sample(lg, temperature, top_k, top_p, rand):
    """Draw one token as lab/core/host.js sample() does: divide the logits by the temperature, keep the top k,
    renormalise, keep the smallest set of the likeliest tokens whose probability reaches top-p, renormalise again.
    temperature 0 is greedy. Returns the token and its probability under the final distribution."""
    if not temperature:
        return int(lg.argmax()), 1.0
    p = torch.softmax(lg.double() / temperature, -1)
    if top_k:
        vals, idx = p.topk(min(int(top_k), p.numel()))
        vals = vals / vals.sum()
    elif top_p < 1:
        vals, idx = p.sort(descending=True)
    else:
        vals, idx = p, None
    if top_p < 1:
        cut = min(int((vals.cumsum(0) < top_p).sum()) + 1, vals.numel())
        vals = vals[:cut] / vals[:cut].sum()
        idx = idx[:cut]
    j = min(int(torch.searchsorted(vals.cumsum(0), torch.tensor([rand()], dtype=vals.dtype, device=vals.device))[0]),
            vals.numel() - 1)
    return (int(idx[j]) if idx is not None else j), float(vals[j])


def generate(m, a, ctx):
    """Rows that share a prompt and differ by their interventions, written together and streamed token by token, as
    lab/core/host.js generate() does. A row that writes an end token (<|endoftext|>, <|im_end|>) stops showing text;
    the writing stops when every row has."""
    from .model import KV, Pieces
    prompt, R = [int(t) for t in a['prompt']], int(a.get('R', 1))
    n_new = max(1, min(int(a.get('maxNew', 40)), 400))
    temperature, top_k, top_p = float(a.get('temperature', 0) or 0), int(a.get('topK', 0) or 0), float(a.get('topP', 1) or 1)
    iv, alts, rand = a.get('iv') or [], int(a.get('alts', 0) or 0), lcg(int(a.get('seed', 1)))
    stops = m.words.stop_ids()
    kv = KV(m.cfg)
    out, lps, ended = [[] for _ in range(R)], [[] for _ in range(R)], [False] * R
    shown = [Pieces(m.words) for _ in range(R)]
    res = m.forward([prompt] * R, iv=iv, logits='last', cache=kv, check=ctx.check)
    for s in range(n_new):
        ctx.check()
        lg = res['logits'][:, 0]
        lp = torch.log_softmax(lg, -1)
        nxt, qs, pieces, alt = [], [], [], []
        for r in range(R):
            t, q = sample(lg[r], temperature, top_k, top_p, rand)
            nxt.append(t)
            qs.append(q)
            out[r].append(t)
            lps[r].append(float(lp[r, t]))
            pieces.append('' if ended[r] else shown[r].push(t))
            ended[r] = ended[r] or t in stops
            if alts:
                alt.append([[m.words.piece(i), float(lp[r, i].exp()), i] for i in topk_ids(lg[r], alts)])
        ctx.progress({'step': s, 'tokens': nxt, 'pieces': pieces, 'logprobs': [x[-1] for x in lps], 'q': qs,
                      'alts': alt if alts else None})
        if all(ended) or s == n_new - 1:
            break
        res = m.forward([[t] for t in nxt], iv=iv, logits='last', cache=kv, check=ctx.check)

    def text(ids):
        cut = next((j for j, t in enumerate(ids) if t in stops), len(ids))
        return m.words.tok.decode(ids[:cut])
    return {'tokens': out, 'logprobs': lps, 'texts': [text(o) for o in out]}


RECIPES = {
    'predict': predict, 'perToken': per_token, 'logitLens': logit_lens, 'attention': attention,
    'headScores': head_scores, 'dla': dla, 'metric': metric, 'headSweep': head_sweep, 'patch': patch,
    'fires': fires, 'neuronTrace': neuron_trace, 'vector': vector, 'unembedVec': unembed_vec,
    'residuals': residuals, 'neuronWeights': neuron_weights, 'ovCircuit': ov_circuit, 'neuronLens': neuron_lens,
    'neuronLinks': neuron_links, 'neuronPush': neuron_push, 'lensSearch': lens_search,
    'saeEncode': sae_encode, 'saeTrace': sae_trace, 'saeRow': sae_row, 'saeNeighbors': sae_neighbors,
}
