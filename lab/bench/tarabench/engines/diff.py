"""Model diffing: what post-training (or a fine-tune) changed inside the model.

Runs the tuned model B and its base A on the same tokens and compares them layer by layer: how far apart the residual
streams are (relative to the base's own size), the average shift (B minus A) and the words that shift pushes toward,
which dictionary features grow or fade, and how far apart the next-token predictions are (KL divergence). The
causal test: add the average shift at one layer to the base model and see how much of the KL gap to the tuned model
it closes, against a random vector of the same size. Reading the average shift through the unembedding follows the
activation-difference lens of Minder et al. (2025), who found that narrow fine-tunes leave readable traces this way.

Both models run at the same precision, one after the other, so only one is in GPU memory at a time. The base model's
unembedding reads the shifts (base and tuned unembeddings are close; the pack says which was used)."""
import numpy as np
import torch

from ..common import Progress, layer_list, say, seed_all
from ..data import texts
from ..packs import claim
from ..sae import dictionary_spec, load_many
from ..stats import bootstrap_ci


@torch.no_grad()
def run(spec, ctx):
    seed = spec.get('seed', 0)
    seed_all(seed)
    prompts = texts(spec.get('prompts', 'builtin:diff_prompts'))
    fmt = spec.get('format', 'raw')
    max_len = int(spec.get('max_len', 96))

    # ---- B, the tuned model: per-token residuals at every layer (CPU, fp16), next-token distributions ----------
    B = ctx.load(spec['b'])
    precision = B.precision
    layers = layer_list(spec.get('layers', 'all'), B.n_layers)
    seqs = [s[:max_len] for s in B.encode(prompts, fmt, spec.get('system'))]
    budget = int(spec.get('tokens', 8192))
    keep, total = [], 0
    for i, s in enumerate(seqs):
        if total + len(s) > budget and keep:
            break
        keep.append(i)
        total += len(s)
    if len(keep) < len(seqs):
        say(f'token budget: using the first {len(keep)} of {len(seqs)} prompts ({total} tokens)')
    prompts = [prompts[i] for i in keep]
    seqs = [seqs[i] for i in keep]
    actsB = {L: [None] * len(seqs) for L in layers}
    prog = Progress(f'diff: {B.id}', len(seqs))
    done = 0
    for b in B.batches(seqs):
        hs = B.capture(b, layers)
        for L in layers:
            for r, i in enumerate(b.index):
                actsB[L][i] = hs[L][r, :b.lengths[r]].to('cpu', torch.float16)
        done += len(b.index)
        prog(done)
    lpB = B.last_logprobs(seqs)
    B_info = B.info()
    ctx.drop(spec['b'])

    # ---- A, the base model, on the same tokens ---------------------------------------------------------------
    A = ctx.load(spec['a'], precision=precision)
    check = A.encode(prompts[:4], fmt, spec.get('system'))
    if [c[:max_len] for c in check] != seqs[:4]:
        raise RuntimeError('the two models tokenise these prompts differently; diffing needs a shared tokenizer')
    dict_layers, saes = [], {}
    if spec.get('dictionary'):
        ds = dictionary_spec(spec['dictionary'])
        dict_layers = layer_list(ds.get('layers', ds.get('layer')), A.n_layers)
        saes, sdev = load_many(A, ds['repo'], dict_layers, ds.get('k'), ds.get('revision'))
        say(f'dictionaries at layers {dict_layers} on {sdev}')
    rel = {L: [] for L in layers}
    cos = {L: [] for L in layers}
    sumA = {L: torch.zeros(A.d_model, dtype=torch.float64) for L in layers}
    sumB = {L: torch.zeros(A.d_model, dtype=torch.float64) for L in layers}
    normA = {L: [] for L in layers}
    feat = {L: {key: torch.zeros(saes[L].F, dtype=torch.float64, device=saes[L].device) for key in ('a', 'b', 'na', 'nb')}
            for L in dict_layers}
    n_show = int(spec.get('showcase', 6))
    show = {i: np.zeros((len(layers), len(seqs[i])), np.float32) for i in range(min(n_show, len(seqs)))}
    n_tok = 0
    prog = Progress(f'diff: {A.id}', len(seqs))
    done = 0
    for b in A.batches(seqs):
        hs = A.capture(b, layers)
        for li, L in enumerate(layers):
            for r, i in enumerate(b.index):
                n = b.lengths[r]
                ha = hs[L][r, :n].float()
                hb = actsB[L][i].to(A.device).float()
                d = (hb - ha).norm(dim=-1) / ha.norm(dim=-1).clamp_min(1e-6)
                c = torch.nn.functional.cosine_similarity(ha, hb, dim=-1)
                if i in show:
                    show[i][li] = d.cpu().numpy()
                rel[L].append(d[1:].cpu())
                cos[L].append(c[1:].cpu())
                normA[L].append(ha[1:].norm(dim=-1).cpu())
                sumA[L] += ha[1:].sum(0).double().cpu()
                sumB[L] += hb[1:].sum(0).double().cpu()
                if L in saes:
                    for key, h in (('a', ha[1:]), ('b', hb[1:])):
                        v, ix = saes[L].encode(h.to(saes[L].W_enc.dtype))
                        on = v > 0
                        feat[L][key].index_add_(0, ix[on], v[on].double())
                        feat[L]['n' + key].index_add_(0, ix[on], torch.ones_like(v[on], dtype=torch.float64))
        n_tok += sum(n - 1 for n in b.lengths)
        done += len(b.index)
        prog(done)
    lpA = A.last_logprobs(seqs)
    kl = (lpB.exp() * (lpB - lpA)).sum(-1).numpy()
    kl_est = bootstrap_ci(kl, seed=seed)

    rows, deltas = [], {}
    for L in layers:
        r_all = torch.cat(rel[L])
        med_norm = float(torch.cat(normA[L]).median())
        delta = ((sumB[L] - sumA[L]) / max(n_tok, 1)).float()
        deltas[L] = delta
        rows.append({'layer': L, 'rel_median': float(r_all.median()), 'rel_mean': float(r_all.mean()),
                     'rel_p90': float(r_all.quantile(0.9)), 'cos_mean': float(torch.cat(cos[L]).mean()),
                     'delta_norm': float(delta.norm()), 'delta_rel': float(delta.norm()) / max(med_norm, 1e-6),
                     'resid_median_norm': med_norm})
    lens = {L: A.logit_lens(deltas[L], top=8) for L in layers}
    peak = max(rows, key=lambda r: r['rel_median'])

    # ---- the causal test: add the mean shift to the base model, does it move toward the tuned model? -----------
    sc = spec.get('steer_check', {})
    s_layers = layer_list(sc.get('layers', sorted(layers, key=lambda L: -deltas[L].norm())[:3]), A.n_layers)
    s_doses = [float(x) for x in sc.get('doses', [0.5, 1.0, 2.0])]
    g = torch.Generator().manual_seed(seed + 99)
    steer_rows = []
    for L in s_layers:
        rnd = torch.randn(A.d_model, generator=g)
        rnd = rnd / rnd.norm() * deltas[L].norm()
        for d in s_doses:
            res = {}
            for name, vec in (('delta', deltas[L]), ('random', rnd)):
                lp = A.last_logprobs(seqs, lambda hk, bb, v=vec: hk.add(L, v, d))
                kl_after = (lpB.exp() * (lpB - lp)).sum(-1).numpy()
                closed = 1 - kl_after / np.maximum(kl, 1e-9)
                res[name] = {'kl': float(kl_after.mean()), 'closed': float(1 - kl_after.mean() / max(kl.mean(), 1e-9)),
                             'closed_ci': list(bootstrap_ci(closed, seed=seed)[1:])}
            steer_rows.append({'layer': L, 'dose': d, **res})
            say(f"layer {L} dose {d}: mean shift closes {res['delta']['closed']:.1%} of KL, random {res['random']['closed']:.1%}")

    feature_rows = {}
    for L in dict_layers:
        fa, fb = feat[L]['a'] / max(n_tok, 1), feat[L]['b'] / max(n_tok, 1)
        da, db = feat[L]['na'] / max(n_tok, 1), feat[L]['nb'] / max(n_tok, 1)
        diff = (fb - fa).float()
        up, down = diff.topk(25), (-diff).topk(25)
        mk = lambda ix: [{'feature': int(i), 'mean_a': float(fa[i]), 'mean_b': float(fb[i]), 'density_a': float(da[i]),
                          'density_b': float(db[i])} for i in ix]
        feature_rows[L] = {'grew': mk(up.indices.tolist()), 'faded': mk(down.indices.tolist()),
                           'dictionary': saes[L].meta}

    best = max(steer_rows, key=lambda r: r['delta']['closed']) if steer_rows else None
    claims = [claim(
        f"Post-training moves the residual stream most around layer {peak['layer']}: the median token's state "
        f"differs from the base model's by {peak['rel_median']:.0%} of its size there.",
        'supported', {'layer': peak['layer'], 'rel_median': peak['rel_median']},
        test='descriptive: measured on every token of these prompts')]
    if best:
        lo = best['delta']['closed_ci'][0]
        rnd_closed = best['random']['closed']
        status = 'supported' if lo > max(rnd_closed, 0) + 0.05 else 'weak' if best['delta']['closed'] > rnd_closed else 'not-supported'
        claims.append(claim(
            f"Adding one vector, the average tuned-minus-base shift at layer {best['layer']} (dose {best['dose']:g}), to "
            f"the base model closes {best['delta']['closed']:.0%} of the next-token KL gap to the tuned model "
            f"(95% CI {best['delta']['closed_ci'][0]:.0%} to {best['delta']['closed_ci'][1]:.0%}); a random vector of the "
            f"same size closes {rnd_closed:.0%}.",
            status, {'layer': best['layer'], 'dose': best['dose'], 'closed': best['delta']['closed'],
                     'ci': best['delta']['closed_ci'], 'random_closed': rnd_closed, 'kl_base': kl_est[0]},
            test='CI lower bound beats the random vector by 5 points; per-prompt KL ratios, bootstrapped'))

    pack = ctx.pack('diff')
    for i, m in show.items():
        pack.array(f'heat_{i}', m, 'f16')
    pack.array('kl', kl, 'f32')
    data = {'a': A.id, 'b': B_info['id'], 'precision': precision, 'format': fmt, 'layers': layers, 'rows': rows,
            'lens': lens, 'lens_note': f'shifts read through {A.id}\'s final norm and unembedding',
            'kl': {'mean': kl_est[0], 'ci': list(kl_est[1:]), 'per_prompt_array': 'kl'},
            'steer': steer_rows, 'features': feature_rows, 'n_prompts': len(seqs), 'n_tokens': n_tok,
            'showcase': [{'prompt': prompts[i], 'tokens': A.decode_tokens(seqs[i]), 'array': f'heat_{i}'}
                         for i in show],
            'prompts': prompts}
    summary = {'headline': (f"biggest change at layer {peak['layer']} ({peak['rel_median']:.0%}); "
                            + (f"one shift vector closes {best['delta']['closed']:.0%} of the KL gap" if best else ''))}
    return pack.save(models=[A.info(), B_info], summary=summary, claims=claims, data=data, provenance=ctx.provenance(),
                     dictionary=next(iter(feature_rows.values()))['dictionary'] if feature_rows else None)
