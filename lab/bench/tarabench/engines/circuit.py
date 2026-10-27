"""Sparse feature circuits: which dictionary features carry a behaviour, and how they feed each other.

The task is a set of prompt pairs: a clean prompt where the model should prefer an answer over a foil, and a
corrupt prompt of the same length where it should not. A dictionary is spliced into the residual stream at each
chosen layer as  h = decode(f) + error, which changes nothing in the forward pass but gives every feature at every
position (and the leftover error) a handle for gradients. Each node's effect is attribution patching: the change in
the answer-minus-foil logit if that node alone moved from its clean to its corrupt value, to first order
((clean - corrupt) x gradient), or with integrated gradients for more accuracy. Edges between adjacent dictionary
layers are the same quantity taken through a downstream node instead of the logit. This is the method of Marks et
al., Sparse Feature Circuits (2024), with Qwen-Scope's residual dictionaries in place of their per-module ones.

The check that keeps it honest: patch the top-k features to their corrupt values for real (no approximation) and
measure how much of the clean-corrupt gap disappears, against sets of k random features that were active on the same
prompts. The features are ranked on one half of the pairs and patched on the other half, so the check is not scored
on the pairs that picked them. The graph is written in the same JSON layout circuit-tracer produces, so one viewer
draws both."""
import numpy as np
import torch

from ..common import Progress, layer_list, say, seed_all
from ..data import pairs as read_pairs
from ..hooks import Hooks
from ..packs import claim
from ..sae import dictionary_spec, load_many
from ..stats import mean_ci, ratio_ci


def metric(logits, ans, foil):
    return logits[0, -1, ans].float() - logits[0, -1, foil].float()


@torch.no_grad()
def codes(lm, saes, ids):
    """Dictionary codes at every dictionary layer for one prompt, kept sparse: {L: (vals [T, k], idx [T, k],
    err [T, D])}, all on the dictionary's device, plus the logits. A plain pass: splicing the dictionary in changes
    no values."""
    store = {}
    with lm.hold():
        with Hooks(lm.layers) as hk:
            for L in saes:
                hk.capture(L, store)
            logits = lm.model(input_ids=ids, use_cache=False).logits
    out = {}
    for L, sae in saes.items():
        x = store[L][0][0].to(sae.device).float()
        v, i = sae.encode(x)
        out[L] = (v.float(), i, x - sae.decode(sae.dense(v, i)).float())
    return out, logits


def dense(sae, c):
    return sae.dense(c[0], c[1]).float()


def spliced_pass(lm, saes, ids, keep_raw=False, interp=None):
    """A forward pass with each dictionary spliced in. Every feature and every error vector becomes a leaf that
    collects its own gradient, while the residual stream itself passes straight through (the output is
    x + (recon - recon.detached), equal to x in value), so one backward pass gives every layer's node gradients and
    downstream layers respond to a change as the model would. This is the gradient routing of Marks et al.'s
    implementation. interp=(layer, alpha, (f_clean, e_clean), (f_corrupt, e_corrupt)) instead sets that one layer to
    corrupt + alpha * (clean - corrupt), for integrated gradients. Returns (logits, leaves)."""
    leaves = {}

    def make(L, sae):
        def fn(h):
            x = h[0].to(sae.device).float()
            f_raw = None
            if interp is None:
                f_raw = sae.encode_dense(x).float()
                f = f_raw.detach().requires_grad_(True)
                e = (x - sae.decode(f_raw).float()).detach().requires_grad_(True)
                recon = sae.decode(f).float() + e
                out = x + (recon - recon.detach())
            else:
                _, a, (fc, ec), (fk, ek) = interp
                f = (fk + a * (fc - fk)).detach().requires_grad_(True)
                e = (ek + a * (ec - ek)).detach().requires_grad_(True)
                out = sae.decode(f).float() + e
            leaves[L] = {'f': f, 'e': e, 'f_raw': f_raw if keep_raw else None}
            return out.to(h.device, h.dtype).unsqueeze(0)
        return fn

    with torch.enable_grad():
        with Hooks(lm.layers) as hk:
            for L, sae in saes.items():
                if interp is None or interp[0] == L:
                    hk.on(L, make(L, sae))
            logits = lm.model(input_ids=ids, use_cache=False).logits
    return logits, leaves


@torch.no_grad()
def patched_metric(lm, saes, ids, ans, foil, patch):
    """The metric on the clean prompt with chosen features set to other values: patch = {L: (mask [T, F] bool,
    values [T, F])}. The error term keeps its clean value."""
    def make(L, sae):
        def fn(h):
            x = h[0].to(sae.device).float()
            f = sae.encode_dense(x).float()
            e = x - sae.decode(f).float()
            m, v = patch[L]
            f = torch.where(m, v, f)
            return (sae.decode(f).float() + e).to(h.device, h.dtype).unsqueeze(0)
        return fn
    with lm.hold():
        with Hooks(lm.layers) as hk:
            for L, sae in saes.items():
                if L in patch:
                    hk.on(L, make(L, sae))
            logits = lm.model(input_ids=ids, use_cache=False).logits
    return float(metric(logits, ans, foil))


def run(spec, ctx):
    lm = ctx.load(spec['model'])
    seed = spec.get('seed', 0)
    seed_all(seed)
    fmt = spec.get('format', 'raw')
    raw_pairs = read_pairs(spec.get('pairs', 'builtin:ioi'), seed)
    items, skipped = [], {'length': 0, 'same_first_token': 0}
    for p in raw_pairs:
        c, k = lm.encode([p['clean']], fmt)[0], lm.encode([p['corrupt']], fmt)[0]
        a, f = lm.token_id(p['answer']), lm.token_id(p['foil'])
        if len(c) != len(k):
            skipped['length'] += 1
            continue
        if a == f:
            skipped['same_first_token'] += 1
            continue
        items.append({'clean': c, 'corrupt': k, 'ans': a, 'foil': f, 'text': p['clean'], 'answer': p['answer'],
                      'foil_text': p['foil']})
    if not items:
        raise RuntimeError(f'no usable pairs (skipped {skipped}); clean and corrupt must tokenise to the same length')
    say(f'{len(items)} pairs usable, skipped {skipped}')
    aligned = spec.get('positions', 'auto') != 'sum' and len({len(it['clean']) for it in items}) == 1
    T = len(items[0]['clean'])
    # pairs for the real-patching check are held out of the ranking that picks the features to patch
    vs = spec.get('validate') or {}
    n_val = min(int(vs.get('items', 24)), len(items) // 2)
    held_out = n_val > 0
    val_idx = sorted(np.random.default_rng(seed + 5).permutation(len(items))[:n_val].tolist()) if held_out \
        else list(range(len(items)))
    rank_idx = set(range(len(items))) - set(val_idx) if held_out else set(range(len(items)))

    ds = dictionary_spec(spec['dictionary'])
    layers = sorted(layer_list(ds.get('layers', ds.get('layer')), lm.n_layers))
    saes, sdev = load_many(lm, ds['repo'], layers, ds.get('k'), ds.get('revision'))
    say(f'dictionaries at layers {layers} on {sdev}')
    F = next(iter(saes.values())).F
    method = spec.get('method', 'attrib')
    steps = int(spec.get('ig_steps', 6))

    # ---- node effects, averaged over items ------------------------------------------------------------------
    shape = (T, F) if aligned else (F,)
    zeros = lambda shp: torch.zeros(shp, dtype=torch.float64, device=sdev)
    eff = {L: zeros(shape) for L in layers}
    eff_rank = {L: zeros(shape) for L in layers}
    eff_err = {L: zeros(T if aligned else 1) for L in layers}
    act = {L: zeros(shape) for L in layers}
    layer_sum = {L: [] for L in layers}
    m_clean, m_corrupt = [], []
    store_codes = []
    prog = Progress('circuit: attribution', len(items))
    for n, it in enumerate(items):
        ids_c = torch.tensor([it['clean']], device=lm.device)
        ids_k = torch.tensor([it['corrupt']], device=lm.device)
        ck, logits_k = codes(lm, saes, ids_k)
        cc, logits_c = codes(lm, saes, ids_c)
        m_corrupt.append(float(metric(logits_k, it['ans'], it['foil'])))
        m_clean.append(float(metric(logits_c, it['ans'], it['foil'])))
        with lm.hold():
            if method == 'ig':
                for L in layers:
                    fc, fk, ec, ek = dense(saes[L], cc[L]), dense(saes[L], ck[L]), cc[L][2], ck[L][2]
                    gf, ge = torch.zeros_like(fc), torch.zeros_like(ec)
                    for j in range(steps):
                        alpha = (j + 0.5) / steps
                        logits, lv = spliced_pass(lm, saes, ids_c, interp=(L, alpha, (fc, ec), (fk, ek)))
                        g = torch.autograd.grad(metric(logits, it['ans'], it['foil']), [lv[L]['f'], lv[L]['e']])
                        gf += g[0] / steps
                        ge += g[1] / steps
                    e_f, e_e = (fc - fk) * gf, ((ec - ek) * ge).sum(-1)
                    eff[L] += (e_f if aligned else e_f.sum(0)).double()
                    if n in rank_idx:
                        eff_rank[L] += (e_f if aligned else e_f.sum(0)).double()
                    eff_err[L] += (e_e if aligned else e_e.sum(0, keepdim=True)).double()
                    layer_sum[L].append(float(e_f.sum() + e_e.sum()))
            else:
                logits, lv = spliced_pass(lm, saes, ids_c)
                grads = torch.autograd.grad(metric(logits, it['ans'], it['foil']),
                                            [lv[L]['f'] for L in layers] + [lv[L]['e'] for L in layers])
                for i, L in enumerate(layers):
                    e_f = (dense(saes[L], cc[L]) - dense(saes[L], ck[L])) * grads[i]
                    e_e = ((cc[L][2] - ck[L][2]) * grads[len(layers) + i]).sum(-1)
                    eff[L] += (e_f if aligned else e_f.sum(0)).double()
                    if n in rank_idx:
                        eff_rank[L] += (e_f if aligned else e_f.sum(0)).double()
                    eff_err[L] += (e_e if aligned else e_e.sum(0, keepdim=True)).double()
                    layer_sum[L].append(float(e_f.sum() + e_e.sum()))
        for L in layers:
            fc = dense(saes[L], cc[L])
            act[L] += (fc if aligned else fc.sum(0)).double()
        store_codes.append((cc, ck))
        prog(n + 1)
    N = len(items)
    for L in layers:
        eff[L] /= N
        eff_rank[L] /= len(rank_idx)
        eff_err[L] /= N
        act[L] /= N

    # ---- the top nodes ----------------------------------------------------------------------------------------
    top_n = int(spec.get('top_nodes', 40))
    cand = []
    for L in layers:
        flat = eff[L].reshape(-1)
        k = min(top_n, flat.numel())
        vals, ix = flat.abs().topk(k)
        for v, i in zip(vals.tolist(), ix.tolist()):
            t, f = (i // F, i % F) if aligned else (-1, i)
            cand.append((v, L, t, f))
    cand.sort(reverse=True)
    top = cand[:top_n]
    nodes = []
    for v, L, t, f in top:
        e = float(eff[L][t, f] if aligned else eff[L][f])
        a = float(act[L][t, f] if aligned else act[L][f])
        lens = lm.logit_lens(saes[L].direction(f).float(), top=3)
        nodes.append({'node_id': f'{L}_{f}_{t}', 'feature': f, 'layer': str(L), 'ctx_idx': t,
                      'feature_type': 'sae feature', 'jsNodeId': f'{L}_{f}_{t}', 'influence': e, 'activation': a,
                      'clerp': ' / '.join(x[0].strip() or repr(x[0]) for x in lens['up']), 'token_prob': 0.0,
                      'is_target_logit': False, 'run_idx': 0, 'reverse_ctx_idx': 0})
    for L in layers:
        for t in (range(T) if aligned else [-1]):
            e = float(eff_err[L][t] if aligned else eff_err[L][0])
            if aligned and abs(e) < 0.02 * max(abs(n['influence']) for n in nodes):
                continue
            nodes.append({'node_id': f'err_{L}_{t}', 'feature': -1, 'layer': str(L), 'ctx_idx': t,
                          'feature_type': 'residual error', 'jsNodeId': f'err_{L}_{t}', 'influence': e,
                          'activation': None, 'clerp': f'what the dictionary misses at layer {L}', 'token_prob': 0.0,
                          'is_target_logit': False, 'run_idx': 0, 'reverse_ctx_idx': 0})
    gap = float(np.mean(m_clean) - np.mean(m_corrupt))
    nodes.append({'node_id': 'logit', 'feature': -1, 'layer': str(lm.n_layers), 'ctx_idx': T - 1 if aligned else -1,
                  'feature_type': 'logit', 'jsNodeId': 'logit', 'influence': gap, 'activation': None,
                  'clerp': f"{items[0]['answer']} minus {items[0]['foil_text']}", 'token_prob': 0.0,
                  'is_target_logit': True, 'run_idx': 0, 'reverse_ctx_idx': 0})

    # ---- edges between adjacent dictionary layers (through each downstream node), and into the logit ------------
    links = []
    for n in nodes:
        if n['feature_type'] in ('sae feature', 'residual error') and int(n['layer']) == layers[-1]:
            links.append({'source': n['node_id'], 'target': 'logit', 'weight': n['influence']})
    if spec.get('edges', True) and len(layers) > 1:
        n_edge_items = min(N, int(spec.get('edge_items', 12)))
        feat_nodes = [n for n in nodes if n['feature_type'] == 'sae feature']
        by_layer = {L: [n for n in feat_nodes if int(n['layer']) == L] for L in layers}
        acc = {}
        prog = Progress('circuit: edges', n_edge_items)
        for it_i in range(n_edge_items):
            it = items[it_i]
            cc, ck = store_codes[it_i]
            ids_c = torch.tensor([it['clean']], device=lm.device)
            with lm.hold():
                logits, lv = spliced_pass(lm, saes, ids_c, keep_raw=True)
                gm = torch.autograd.grad(metric(logits, it['ans'], it['foil']), [lv[L]['f'] for L in layers],
                                         retain_graph=True)
                gm = dict(zip(layers, gm))
                for li in range(1, len(layers)):
                    L2, L1 = layers[li], layers[li - 1]
                    ups = by_layer[L1]
                    for dn in by_layer[L2]:
                        f2, t2 = dn['feature'], dn['ctx_idx']
                        w = gm[L2][:, f2] if t2 < 0 else gm[L2][t2:t2 + 1, f2]
                        raw = lv[L2]['f_raw'][:, f2] if t2 < 0 else lv[L2]['f_raw'][t2:t2 + 1, f2]
                        s = (w.detach() * raw).sum()
                        if not s.requires_grad:
                            continue
                        gf, ge = torch.autograd.grad(s, [lv[L1]['f'], lv[L1]['e']], retain_graph=True,
                                                     allow_unused=True)
                        if gf is None:
                            continue
                        dfe = (dense(saes[L1], cc[L1]) - dense(saes[L1], ck[L1])) * gf
                        for up in ups:
                            f1, t1 = up['feature'], up['ctx_idx']
                            v = float(dfe[:, f1].sum() if t1 < 0 else dfe[t1, f1])
                            key = (up['node_id'], dn['node_id'])
                            acc[key] = acc.get(key, 0.0) + v
                        if ge is not None:
                            de = ((cc[L1][2] - ck[L1][2]) * ge).sum(-1)
                            for t1 in (range(T) if aligned else [-1]):
                                key = (f'err_{L1}_{t1}', dn['node_id'])
                                acc[key] = acc.get(key, 0.0) + float(de.sum() if t1 < 0 else de[t1])
            prog(it_i + 1)
        ids_present = {n['node_id'] for n in nodes}
        for (src, dst), v in acc.items():
            if src in ids_present and abs(v) > 0:
                links.append({'source': src, 'target': dst, 'weight': v / n_edge_items})
        keep_links = int(spec.get('max_links', 400))
        links.sort(key=lambda l: -abs(l['weight']))
        links = links[:keep_links]

    # ---- validation: patch the top-k features for real, against random active features ------------------------
    # ranked on the ranking pairs only, patched on the held-out ones
    ks = [int(k) for k in vs.get('k', [1, 3, 10, 30])]
    n_rand = int(vs.get('random', 10))
    ranked = []
    for L in layers:
        flat = eff_rank[L].reshape(-1)
        vals, ix = flat.abs().topk(min(max(top_n, max(ks)), flat.numel()))
        for v, i in zip(vals.tolist(), ix.tolist()):
            ranked.append((v, L, *((i // F, i % F) if aligned else (-1, i))))
    ranked.sort(reverse=True)
    feat_rank = [(L, t, f) for _, L, t, f in ranked]
    rng = np.random.default_rng(seed + 3)
    curves = []
    for k in ks:
        chosen = feat_rank[:k]
        rand_sets = []
        for _ in range(n_rand):
            rs = []
            for L, t, f in chosen:
                pool = torch.nonzero(act[L] > 0).cpu().numpy()
                if len(pool) == 0:
                    continue
                pick = pool[rng.integers(len(pool))]
                rs.append((L, int(pick[0]), int(pick[1])) if aligned else (L, -1, int(pick[0])))
            rand_sets.append(rs)
        top_frac, rand_frac = [], [[] for _ in range(n_rand)]
        for it_i in val_idx:
            it = items[it_i]
            cc, ck = store_codes[it_i]
            ids_c = torch.tensor([it['clean']], device=lm.device)
            g_it = m_clean[it_i] - m_corrupt[it_i]

            def patch_for(sel):
                patch = {}
                for L, t, f in sel:
                    if L not in patch:
                        patch[L] = (torch.zeros((T if aligned else len(it['clean']), F), dtype=torch.bool,
                                                device=sdev), dense(saes[L], ck[L]))
                    m = patch[L][0]
                    if t < 0:
                        m[:, f] = True
                    else:
                        m[t, f] = True
                return patch
            mt = patched_metric(lm, saes, ids_c, it['ans'], it['foil'], patch_for(chosen))
            top_frac.append((m_clean[it_i] - mt, g_it))
            for r, rs in enumerate(rand_sets):
                mr = patched_metric(lm, saes, ids_c, it['ans'], it['foil'], patch_for(rs))
                rand_frac[r].append((m_clean[it_i] - mr, g_it))

        def ratio(rows):
            rows = np.asarray(rows)
            return float(rows[:, 0].mean() / rows[:, 1].mean()) if abs(rows[:, 1].mean()) > 1e-9 else float('nan')

        tf = np.asarray(top_frac)
        est, lo, hi = ratio_ci(tf[:, 0], tf[:, 1], seed=seed)
        curves.append({'k': k, 'top': est, 'top_ci': [lo, hi], 'random': [ratio(r) for r in rand_frac]})
        say(f"k={k}: top features remove {curves[-1]['top']:.0%} of the gap, random {np.nanmean(curves[-1]['random']):.0%}")

    gap_ci = mean_ci(np.asarray(m_clean) - np.asarray(m_corrupt))
    claims = [claim(
        f"The task works: the model prefers the answer over the foil by {np.mean(m_clean):+.2f} on clean prompts and "
        f"{np.mean(m_corrupt):+.2f} on corrupt ones (gap {gap_ci[0]:.2f}, 95% CI {gap_ci[1]:.2f} to {gap_ci[2]:.2f}).",
        'supported' if gap_ci[1] > 0 else 'not-supported', {'clean': float(np.mean(m_clean)),
                                                            'corrupt': float(np.mean(m_corrupt)), 'gap_ci': gap_ci[1:]},
        test='gap CI excludes zero; without a gap there is nothing to explain')]
    for c in curves:
        if c['k'] == max(ks):
            rmax = np.nanmax(c['random']) if c['random'] else float('nan')
            ok = c['top_ci'][0] > (rmax if rmax == rmax else 0) + 0.1
            where = (f"ranked on {len(rank_idx)} pairs and patched on {len(val_idx)} others" if held_out else
                     f"ranked and patched on the same {len(val_idx)} pair{'s' if len(val_idx) != 1 else ''}, too few "
                     f"to hold any out")
            claims.append(claim(
                f"Patching just the top {c['k']} features (of {F} at each of {len(layers)} layers; {where}) to their "
                f"corrupt values removes {c['top']:.0%} of the clean-corrupt gap (95% CI {c['top_ci'][0]:.0%} to "
                f"{c['top_ci'][1]:.0%}); {len(c['random'])} sets of {c['k']} random active features remove at most "
                f"{rmax:.0%}.",
                'supported' if ok and held_out else 'weak' if c['top'] > rmax else 'not-supported',
                {'k': c['k'], 'top': c['top'], 'ci': c['top_ci'], 'random': c['random'], 'held_out': held_out},
                test='CI lower bound beats the best random set by 10 points, on pairs that played no part in '
                     'ranking the features; real patching, not the approximation'))
    approx = {L: (float(np.mean(layer_sum[L])) / gap if abs(gap) > 1e-9 else None) for L in layers}

    pack = ctx.pack('circuit')
    pack.array('m_clean', m_clean, 'f32')
    pack.array('m_corrupt', m_corrupt, 'f32')
    meta = {'slug': spec['id'], 'scan': ds['repo'], 'transcoder_list': [], 'prompt': items[0]['text'],
            'prompt_tokens': lm.decode_tokens(items[0]['clean']) if aligned else [], 'node_threshold': None,
            'schema_version': 1, 'source': 'tara-bench circuit (sparse feature circuits)'}
    graph_file = pack.file('graph.json', {'metadata': meta, 'qParams': {'pinnedIds': [], 'supernodes': [],
                                                                        'linkType': 'both', 'clickedId': '',
                                                                        'sg_pos': ''},
                                          'nodes': nodes, 'links': links})
    data = {'layers': layers, 'aligned': aligned, 'positions': T, 'method': method, 'graph': graph_file,
            'n_items': N, 'skipped': skipped, 'validation': curves, 'completeness': approx,
            'validation_split': {'held_out': held_out, 'ranked_on': len(rank_idx), 'patched_on': len(val_idx),
                                 'random_sets': n_rand},
            'interval': 'gap: Student t over pairs; shares: bootstrap over pairs, 95%',
            'completeness_note': 'per layer: summed node effects divided by the real clean-corrupt gap; near 1 means the first-order estimate is trustworthy',
            'tokens': lm.decode_tokens(items[0]['clean']), 'examples': [
                {'clean': it['text'], 'answer': it['answer'], 'foil': it['foil_text'], 'm_clean': m_clean[i],
                 'm_corrupt': m_corrupt[i]} for i, it in enumerate(items[:12])]}
    summary = {'headline': (f"top {max(ks)} features carry {curves[-1]['top']:.0%} of the gap"
                            + (' on held-out pairs' if held_out else '')) if curves else ''}
    return pack.save(models=[lm.info()], summary=summary, claims=claims, data=data, provenance=ctx.provenance(),
                     dictionary={**next(iter(saes.values())).meta, 'layers': layers})
