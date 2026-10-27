"""SAE feature cards: what a dictionary feature responds to and what it does.

Streams a corpus through the model up to the dictionary's layer, encodes every token, and keeps for each tracked
feature its strongest examples (with the activation on every token around them), how often it fires, and how hard.
"What it does" is read off the decoder column through the final norm and unembedding (the tokens it pushes up and
down). The dictionary's reconstruction quality on this model is measured first, because a dictionary trained on a
base model and read on its tuned twin can fit less well. The card layout follows Anthropic's feature browsers and
Neuronpedia."""
import numpy as np
import torch

from ..common import Progress, say, seed_all
from ..data import corpus, texts
from ..packs import claim
from ..sae import TopKSAE, dictionary_spec


def contexts(lm, src, n_tokens, ctx_len, limit_docs=None):
    """Cuts documents into contexts of ctx_len tokens (the first token of each is skipped in every statistic)."""
    out, total = [], 0
    for doc in corpus(src, limit_docs):
        ids = lm.tok(doc, add_special_tokens=False)['input_ids']
        for s in range(0, max(1, len(ids) - ctx_len // 4), ctx_len):
            chunk = ids[s:s + ctx_len]
            if len(chunk) < 8:
                continue
            out.append(chunk)
            total += len(chunk)
            if total >= n_tokens:
                return out
    return out


@torch.no_grad()
def encode_batches(lm, sae, seqs, layer, bs):
    """Yields (batch, residual [B, T, D], vals [B, T, k], idx [B, T, k]) with the first position and padding zeroed
    in vals."""
    for b in lm.batches(seqs, bs):
        h = lm.capture(b, [layer])[layer]
        vals, idx = sae.encode(h.to(sae.W_enc.dtype))
        keep = b.mask.clone()
        keep[:, 0] = 0
        vals = vals * keep.unsqueeze(-1).to(vals.dtype)
        yield b, h, vals.float(), idx


def run(spec, ctx):
    lm = ctx.load(spec['model'])
    seed = spec.get('seed', 0)
    seed_all(seed)
    ds = dictionary_spec(spec['dictionary'])
    L = int(ds['layer'])
    dtype = torch.float32 if lm.device.type == 'cpu' or lm.dtype == torch.float32 else torch.bfloat16
    sae = TopKSAE.load(ds['repo'], L, ds.get('k'), ds.get('revision'), lm.device, dtype)
    F = sae.F
    cs = spec.get('corpus') or {}
    src = cs.get('source', 'builtin:neutral')
    ctx_len = int(cs.get('ctx', 64))
    seqs = contexts(lm, src, float(cs.get('tokens', 2e5)), ctx_len, cs.get('docs'))
    n_tok = sum(len(s) - 1 for s in seqs)
    say(f'corpus: {len(seqs)} contexts, {n_tok} tokens scored; dictionary layer {L}, width {F}, k {sae.k}')

    # Pass 1: how often every feature fires and how hard; reconstruction quality on a sample.
    counts = torch.zeros(F, dtype=torch.float64, device=lm.device)
    sums = torch.zeros(F, dtype=torch.float64, device=lm.device)
    maxes = torch.zeros(F, dtype=torch.float32, device=lm.device)
    sample = []
    prog = Progress('features: scan', len(seqs))
    done = 0
    for b, h, vals, idx in encode_batches(lm, sae, seqs, L, lm.batch_size):
        on = vals > 0
        counts.index_add_(0, idx[on], torch.ones_like(vals[on], dtype=torch.float64))
        sums.index_add_(0, idx[on], vals[on].double())
        maxes.scatter_reduce_(0, idx[on], vals[on], 'amax')
        if sum(x.shape[0] for x in sample) < 4096:
            m = b.mask.bool().clone()
            m[:, 0] = False
            sample.append(h[m].to(sae.W_enc.dtype))
        done += len(b.index)
        prog(done)
    quality = sae.quality(torch.cat(sample)[:4096])
    density = (counts / max(n_tok, 1)).float().cpu()
    mean_act = (sums / counts.clamp_min(1)).float().cpu()
    say(f"reconstruction on this model: {quality['fve']:.1%} of variance explained, cosine {quality['cos']:.3f}")

    want = spec.get('features', 'top_density:24')
    if isinstance(want, str) and want.startswith('top_density:'):
        tracked = density.topk(int(want.split(':')[1])).indices.tolist()
    elif isinstance(want, str) and want.startswith('random:'):
        alive = torch.nonzero(density > 0).flatten()
        g = torch.Generator().manual_seed(seed)
        tracked = alive[torch.randperm(len(alive), generator=g)[:int(want.split(':')[1])]].tolist()
    else:
        tracked = [int(f) for f in want]
    S, K = len(tracked), int(spec.get('top_examples', 12))
    lut = torch.full((F,), -1, dtype=torch.long, device=lm.device)
    lut[torch.tensor(tracked, device=lm.device)] = torch.arange(S, device=lm.device)

    # Pass 2: the strongest examples of each tracked feature.
    best_v = torch.full((S, K), -1.0, device=lm.device)
    best_c = torch.zeros((S, K), dtype=torch.long, device=lm.device)
    best_p = torch.zeros((S, K), dtype=torch.long, device=lm.device)
    prog = Progress('features: examples', len(seqs))
    done = 0
    for b, _, vals, idx in encode_batches(lm, sae, seqs, L, lm.batch_size):
        slot = lut[idx]
        hit = (slot >= 0) & (vals > 0)
        if hit.any():
            bi, ti, _ = torch.nonzero(hit, as_tuple=True)
            sv, vv = slot[hit], vals[hit]
            ci = torch.tensor(b.index, device=lm.device)[bi]
            order = torch.argsort(vv, descending=True)
            order = order[torch.argsort(sv[order], stable=True)]
            sv, vv, ci, ti = sv[order], vv[order], ci[order], ti[order]
            start = torch.searchsorted(sv, sv, right=False)
            rank = torch.arange(len(sv), device=lm.device) - start
            k = rank < K
            nv = torch.full((S, K), -1.0, device=lm.device)
            nc = torch.zeros((S, K), dtype=torch.long, device=lm.device)
            np_ = torch.zeros((S, K), dtype=torch.long, device=lm.device)
            nv[sv[k], rank[k]] = vv[k]
            nc[sv[k], rank[k]] = ci[k]
            np_[sv[k], rank[k]] = ti[k]
            allv, allc, allp = torch.cat([best_v, nv], 1), torch.cat([best_c, nc], 1), torch.cat([best_p, np_], 1)
            top = allv.topk(K, dim=1)
            best_v, best_c, best_p = top.values, allc.gather(1, top.indices), allp.gather(1, top.indices)
        done += len(b.index)
        prog(done)

    # Each tracked feature's activation on every token of its top contexts, for the highlighted snippets.
    need = sorted({int(c) for s in range(S) for c, v in zip(best_c[s].tolist(), best_v[s].tolist()) if v > 0})
    per_ctx = {}
    for b, _, vals, idx in encode_batches(lm, sae, [seqs[i] for i in need], L, lm.batch_size):
        dense = torch.zeros(*vals.shape[:2], S, device=lm.device)
        slot = lut[idx]
        hit = slot >= 0
        bi, ti, _ = torch.nonzero(hit, as_tuple=True)
        dense[bi, ti, slot[hit]] = vals[hit]
        for r, i in enumerate(b.index):
            per_ctx[need[i]] = dense[r, :b.lengths[r]].cpu()
    win_l, win_r = int(spec.get('window_before', 16)), int(spec.get('window_after', 6))
    cards = []
    for s, f in enumerate(tracked):
        ex = []
        for v, c, p in zip(best_v[s].tolist(), best_c[s].tolist(), best_p[s].tolist()):
            if v <= 0:
                continue
            a, z = max(1, p - win_l), min(len(seqs[c]), p + win_r + 1)
            ex.append({'tokens': lm.decode_tokens(seqs[c][a:z]), 'acts': per_ctx[c][a:z, s].tolist(), 'at': p - a,
                       'max': v, 'context': c})
        lens = lm.logit_lens(sae.direction(f).float(), top=10)
        cards.append({'feature': f, 'density': float(density[f]), 'mean_act': float(mean_act[f]),
                      'max_act': float(maxes[f]), 'examples': ex, 'logit_lens': lens, 'label': None})

    prompt_view = []
    if spec.get('prompts'):
        ps = texts(spec['prompts'])
        pseqs = lm.encode(ps, spec.get('format', 'raw'))
        for b, _, vals, idx in encode_batches(lm, sae, pseqs, L, lm.batch_size):
            for r, i in enumerate(b.index):
                n = b.lengths[r]
                prompt_view.append({'prompt': ps[i], 'tokens': lm.decode_tokens(pseqs[i]),
                                    'top': [top_of(vals[r, t], idx[r, t], 6) for t in range(n)]})

    hist_edges = np.arange(-7, 0.5, 0.5)
    logd = np.log10(density.numpy().clip(1e-12))
    hist = np.histogram(logd[density.numpy() > 0], bins=hist_edges)[0].tolist()
    dead = int((density == 0).sum())
    claims = [claim(
        f"The dictionary reconstructs this model's layer-{L} residual stream with {quality['fve']:.0%} of variance "
        f"explained (cosine {quality['cos']:.2f}) on {quality['rows']} corpus tokens; {dead} of {F} features never "
        f"fired on {n_tok} tokens.",
        'supported' if quality['fve'] > 0.6 else 'weak',
        {'quality': quality, 'dead': dead, 'tokens': n_tok},
        test='fraction of variance explained above 60%, the level at which feature readings are worth trusting')]

    pack = ctx.pack('features')
    pack.array('density', density, 'f32')
    pack.array('mean_act', mean_act, 'f16')
    data = {'layer': L, 'width': F, 'k': sae.k, 'cards': cards, 'prompts': prompt_view, 'quality': quality,
            'density_hist': {'edges_log10': hist_edges.tolist(), 'counts': hist, 'dead': dead},
            'corpus': {'source': src if isinstance(src, str) else {k: str(v) for k, v in src.items()},
                       'contexts': len(seqs), 'tokens': n_tok, 'ctx_len': ctx_len}}
    summary = {'headline': f"{S} feature cards at layer {L}; dictionary explains {quality['fve']:.0%} of variance here"}
    return pack.save(models=[lm.info()], summary=summary, claims=claims, data=data, provenance=ctx.provenance(),
                     dictionary=sae.meta)


def top_of(vals, idx, n):
    order = vals.argsort(descending=True)[:n]
    return [[int(idx[o]), round(float(vals[o]), 3)] for o in order if vals[o] > 0]
