"""Proves the bench's plumbing on a tiny random Qwen 3.5 and a tiny GPT-2 (no downloads, CPU, about a minute).

Checks the invariants every engine relies on, then runs every engine end to end into a scratch findings folder and
reads each pack back. The numbers mean nothing; a pass means the machinery is sound.

    python selftest.py            # exit code 0 when everything passes
"""
import copy
import json
import sys
import tempfile
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import numpy as np  # noqa: E402
import torch  # noqa: E402

from tarabench import data, tiny  # noqa: E402
from tarabench.common import say  # noqa: E402
from tarabench.models import LM, load  # noqa: E402
from tarabench.packs import DTYPES  # noqa: E402
from tarabench.runner import run_spec  # noqa: E402
from tarabench.sae import TopKSAE  # noqa: E402
from tarabench.stats import binom_ci, null_labels, split  # noqa: E402

RESULTS = []


def check(name, ok, detail=''):
    RESULTS.append((name, bool(ok), detail))
    say(f"{'PASS' if ok else 'FAIL'} {name} {detail}")


def statistics():
    # exact binomial intervals against published Clopper-Pearson values; a perfect score must not collapse
    got = [binom_ci(42, 42), binom_ci(5, 10), binom_ci(0, 10)]
    want = [(0.91592, 1.0), (0.18709, 0.81291), (0.0, 0.30850)]
    check('exact intervals match Clopper-Pearson', all(abs(a - b) < 1e-4 for g, w in zip(got, want) for a, b in zip(g, w)),
          f'42 of 42: {got[0][0]:.4f} to {got[0][1]:.4f}; 5 of 10: {got[1][0]:.4f} to {got[1][1]:.4f}')
    # matched pairs are held out whole, the test set stays balanced, and the paired null keeps one of each label
    xs, ys, g = data.labelled('builtin:cities', 0, groups=True)
    ys, g = np.asarray(ys), np.asarray(g)
    tr, te = split(len(xs), 0.3, 0, ys, g)
    check('matched pairs are held out whole', not set(g[tr]) & set(g[te]) and 2 * int(ys[te].sum()) == len(te),
          f'{len(te)} held out of {len(xs)}')
    yp = null_labels(ys, np.random.default_rng(1), g)
    check('the paired null swaps labels within pairs', all(sorted(yp[g == v]) == [0, 1] for v in np.unique(g)) and
          (yp != ys).any())


def invariants(lm, dict_dir):
    seqs = lm.encode(['The city of Paris is in France .', 'hey quick one , what is the capital of Australia ?',
                      'Bees visit thousands of flowers in a single day .'])
    # 1. a hook on layer L reads exactly what output_hidden_states calls hidden_states[L + 1]
    b = next(lm.batches(seqs[:1]))
    with torch.no_grad():
        ref = lm.model(input_ids=b.ids, attention_mask=b.mask, output_hidden_states=True, use_cache=False).hidden_states
    hs = lm.capture(b, [0, 2])
    check('capture matches output_hidden_states', max(float((hs[L] - ref[L + 1]).abs().max()) for L in (0, 2)) < 1e-5)
    # 2. right padding changes nothing at real positions
    lp_batch = lm.last_logprobs(seqs)
    lp_single = torch.cat([lm.last_logprobs([s]) for s in seqs])
    check('right padding is exact', float((lp_batch - lp_single).abs().max()) < 1e-4,
          f'max diff {float((lp_batch - lp_single).abs().max()):.2e}')
    # 2b. the float32 head rebuilds the model's own logits from the final norm's input, and in bf16 it switches on
    fin = {}
    with torch.no_grad():
        ref32 = lm.call(b, None, fin)[0].float()
    got = lm.head32(fin['h'][0], ref32)
    check('float32 head matches the model\'s logits', lm._head32 is True and float((got - ref32).abs().max()) < 1e-4,
          f'max diff {float((got - ref32).abs().max()):.2e}')
    # a bf16 copy, so the shared model keeps its float32 buffers (a round trip would round the rotary tables)
    lm16 = LM(copy.deepcopy(lm.model).to(torch.bfloat16), lm.tok, lm.entry, 'bf16', 'tiny')
    lm16.batch_size = lm.batch_size
    lp16 = lm16.last_logprobs(seqs)
    on = lm16._head32
    lm16._head32 = False
    lp16raw = lm16.last_logprobs(seqs)
    del lm16
    e32, e16 = float((lp16 - lp_batch).abs().max()), float((lp16raw - lp_batch).abs().max())
    check('in bf16 the float32 head switches on and scores stay near float32', on is True and e32 < 0.1,
          f'largest error against float32: {e32:.3g} through the float32 head, {e16:.3g} from the bf16 logits')
    pooled = lm.pooled(seqs, [1], 'last')[1]
    single = torch.cat([lm.pooled([s], [1], 'last')[1] for s in seqs])
    check('pooled activations are batch-independent', float((pooled - single).abs().max()) < 1e-4)
    # 3. a zero push is no push; projecting out a direction leaves nothing along it
    v = torch.randn(lm.d_model)
    lp0 = lm.last_logprobs(seqs, lambda hk, bb: hk.add(1, v, 0.0))
    check('zero-dose steering is a no-op', float((lp0 - lp_batch).abs().max()) < 1e-6)
    u = v / v.norm()
    store = {}

    def s(hk, bb):
        hk.project_out(1, u)
        hk.capture(1, store)
    lm.call(next(lm.batches(seqs[:1])), s)
    check('directional ablation removes the component', float((store[1][0] @ u).abs().max()) < 1e-4)
    # 4. the final-norm gain matches the module (Qwen 3.5 uses 1 + w)
    w = lm.final_norm.weight.float()
    check('final norm gain read correctly', float((lm.gain() - (1 + w)).abs().max()) < 1e-5)
    # 5. dictionaries load in Qwen-Scope layout and splicing them in changes nothing
    from tarabench.engines.circuit import codes, metric, spliced_pass
    saes = {L: TopKSAE.load(dict_dir, L, 8) for L in (1, 2)}
    q = saes[1].quality(lm.pooled(seqs, [1], 'mean')[1])
    check('dictionary loads and encodes', q['l0'] <= 8 and np.isfinite(q['fve']), str(q))
    pair = [p for p in __import__('tarabench.data', fromlist=['x']).ioi_pairs(8)]
    c = lm.encode([pair[0]['clean']])[0]
    k = lm.encode([pair[0]['corrupt']])[0]
    a, f = lm.token_id(pair[0]['answer']), lm.token_id(pair[0]['foil'])
    ids_c, ids_k = torch.tensor([c]), torch.tensor([k])
    cc, lc = codes(lm, saes, ids_c)
    ck, lk = codes(lm, saes, ids_k)
    logits, lv_all = spliced_pass(lm, saes, ids_c)
    diff = float((logits.detach() - lc).abs().max())
    check('splicing dictionaries in leaves the output unchanged', diff < 1e-4, f'max diff {diff:.2e}')
    g_all = torch.autograd.grad(metric(logits, a, f), [lv_all[1]['f'], lv_all[2]['f']])
    dense = lambda sae, x: sae.dense(x[0], x[1]).float()
    for alpha, target in ((0.0, lk), (1.0, lc)):
        lg, _ = spliced_pass(lm, saes, ids_c, interp=(2, alpha, (dense(saes[2], cc[2]), cc[2][2]),
                                                     (dense(saes[2], ck[2]), ck[2][2])))
        check(f'splicing layer 2 at alpha={alpha:g} reproduces the {"corrupt" if alpha == 0 else "clean"} run',
              abs(float((metric(lg, a, f) - metric(target, a, f)).detach())) < 1e-4)
    # 6. one backward pass through every spliced layer gives each layer the same gradient as splicing it alone
    for i, L in enumerate((1, 2)):
        fc = dense(saes[L], cc[L])
        lg, lv = spliced_pass(lm, saes, ids_c, interp=(L, 1.0, (fc, cc[L][2]), (fc, cc[L][2])))
        g_one = torch.autograd.grad(metric(lg, a, f), [lv[L]['f']])[0]
        err = float((g_all[i] - g_one).abs().max() / g_one.abs().max().clamp_min(1e-12))
        check(f'layer {L} node gradients agree between joint and single splicing', err < 1e-4, f'relative {err:.1e}')


def vlm_checkpoint(tmp):
    """Qwen 3.5 checkpoints are saved as the vision-language model; the loader must read them as a plain causal LM
    with the decoder layers at model.layers, where Qwen-Scope hooks, and give identical outputs."""
    from transformers.models.qwen3_5.configuration_qwen3_5 import Qwen3_5Config
    from transformers.models.qwen3_5.modeling_qwen3_5 import Qwen3_5ForConditionalGeneration
    tok = tiny.tokenizer()
    text = dict(vocab_size=len(tok), hidden_size=64, intermediate_size=128, num_hidden_layers=4, num_attention_heads=4,
                num_key_value_heads=2, head_dim=16, linear_key_head_dim=16, linear_value_head_dim=16,
                linear_num_key_heads=2, linear_num_value_heads=4, max_position_embeddings=512, pad_token_id=0,
                eos_token_id=2, tie_word_embeddings=False)
    vision = dict(depth=1, hidden_size=32, intermediate_size=64, num_heads=2, out_hidden_size=64, patch_size=4)
    torch.manual_seed(0)
    vlm = Qwen3_5ForConditionalGeneration(Qwen3_5Config(text_config=text, vision_config=vision)).eval()
    d = Path(tmp) / 'qwen3.5-vlm-tiny'
    vlm.save_pretrained(d)
    tok.save_pretrained(d)
    lm = load(str(d), precision='fp32', device='cpu')
    seqs = lm.encode(['The city of Paris is in France .'])
    with torch.no_grad():
        ref = vlm(input_ids=torch.tensor(seqs)).logits[0, -1].log_softmax(-1)
    got = lm.last_logprobs(seqs)[0]
    check('a saved Qwen 3.5 checkpoint loads as a causal LM', lm.layers_path == 'model.layers' and
          float((ref - got).abs().max()) < 1e-5, f'{type(lm.model).__name__}, layers at {lm.layers_path}')
    lm.unload()


def layernorm_checkpoint(tmp):
    """GPT-2 keeps its blocks at transformer.h and ends in a LayerNorm, which subtracts the mean: the gain must come
    from the weight (normalising a vector of ones would give zeros), and the logit lens must centre the vector."""
    from transformers import GPT2Config, GPT2LMHeadModel
    tok = tiny.tokenizer()
    torch.manual_seed(0)
    gpt = GPT2LMHeadModel(GPT2Config(vocab_size=len(tok), n_embd=64, n_layer=2, n_head=4, n_positions=128,
                                     pad_token_id=0, eos_token_id=2)).eval()
    with torch.no_grad():
        gpt.transformer.ln_f.weight.uniform_(0.5, 1.5)
    d = Path(tmp) / 'gpt2-tiny'
    gpt.save_pretrained(d)
    tok.save_pretrained(d)
    lm = load(str(d), precision='fp32', device='cpu')
    w = gpt.transformer.ln_f.weight.float()
    v = torch.randn(lm.d_model)
    lens = lm.logit_lens(v + 3.0, top=3)          # a shift along all-ones is invisible to a LayerNorm
    ref = (lm.unembed().float() @ ((v - v.mean()) * w)).topk(3).values
    got = torch.tensor([x for _, x in lens['up']])
    check('a LayerNorm model (GPT-2 layout) reads its gain and centres the logit lens',
          lm.layers_path == 'transformer.h' and float((lm.gain() - w).abs().max()) < 1e-6 and
          float((got - ref).abs().max()) < 1e-4, f'layers at {lm.layers_path}')
    fin, b = {}, next(lm.batches(lm.encode(['The city of Paris is in France .'])))
    with torch.no_grad():
        ref32 = lm.call(b, None, fin)[0].float()
    got = lm.head32(fin['h'][0], ref32)
    check('float32 head matches a LayerNorm model\'s logits', lm._head32 is True and float((got - ref32).abs().max()) < 1e-4,
          f'max diff {float((got - ref32).abs().max()):.2e}')
    lm.unload()


def engines(out, dict_dir):
    common = {'seed': 0, 'precision': 'fp32'}
    specs = [
        {'engine': 'steer', 'id': 'selftest-steer', 'model': 'tiny-qwen3.5',
         'direction': {'from': 'contrast', 'dataset': 'builtin:formal_casual', 'layer': 1},
         'doses': [-0.5, 0, 0.5], 'metric': {'kind': 'logit_diff', 'prompts': 'builtin:diff_prompts', 'target': 'Dear',
                                             'foil': 'hey'},
         'controls': {'random': 3}, 'samples': {'prompts': ['Dear diary , today I'], 'doses': [0, 0.5], 'new_tokens': 5}},
        {'engine': 'steer', 'id': 'selftest-steer-seq', 'model': 'tiny-qwen3.5',
         'direction': {'from': 'sae', 'dictionary': dict_dir, 'layer': 2, 'feature': 3},
         'doses': [0, 0.3], 'metric': {'kind': 'seq_logprob', 'prompts': ['The capital of France is'],
                                       'positive': ' Paris .', 'negative': ' Rome .', 'format': 'chat'},
         'controls': {'random': 2}},
        {'engine': 'probe', 'id': 'selftest-probe', 'model': 'tiny-qwen3.5', 'dataset': 'builtin:cities',
         'layers': 'all', 'controls': {'shuffle': 2}},
        {'engine': 'steer', 'id': 'selftest-steer-pack', 'model': 'tiny-qwen3.5',
         'direction': {'from': 'pack', 'pack': 'selftest-probe', 'layer': 2}, 'doses': [0, 0.2],
         'metric': {'kind': 'prob', 'prompts': ['The city of Paris is in'], 'target': ['France', 'Spain']},
         'controls': {'random': 2}},
        {'engine': 'features', 'id': 'selftest-features', 'model': 'tiny-qwen3.5',
         'dictionary': {'repo': dict_dir, 'layer': 2, 'k': 8}, 'corpus': {'source': 'builtin:neutral', 'tokens': 4000,
                                                                          'ctx': 24},
         'features': 'top_density:5', 'top_examples': 4, 'prompts': ['The city of Paris is in France .']},
        {'engine': 'diff', 'id': 'selftest-diff', 'a': 'tiny-qwen3.5', 'b': 'tiny-qwen3.5-tuned',
         'prompts': 'builtin:diff_prompts', 'dictionary': {'repo': dict_dir, 'layers': [1, 3], 'k': 8},
         'steer_check': {'layers': [1, 2], 'doses': [1.0]}, 'showcase': 2},
        {'engine': 'circuit', 'id': 'selftest-circuit', 'model': 'tiny-qwen3.5', 'pairs': 'builtin:ioi:12',
         'dictionary': {'repo': dict_dir, 'layers': [1, 2, 3], 'k': 8}, 'top_nodes': 12, 'edge_items': 3,
         'validate': {'k': [1, 4], 'random': 2, 'items': 6}},
        {'engine': 'circuit', 'id': 'selftest-circuit-ig', 'model': 'tiny-qwen3.5', 'pairs': 'builtin:ioi:6',
         'dictionary': {'repo': dict_dir, 'layers': [2], 'k': 8}, 'method': 'ig', 'ig_steps': 24, 'top_nodes': 6,
         'edges': False, 'validate': {'k': [2], 'random': 1, 'items': 3}},
    ]
    for spec in specs:
        t0 = time.time()
        try:
            d = run_spec({**common, **spec}, out=out)
            meta = json.loads((Path(d) / 'pack.json').read_text(encoding='utf-8'))
            sizes_ok = all((Path(d) / a['file']).stat().st_size ==
                           int(np.prod(a['shape'])) * np.dtype(DTYPES[a['dtype']]).itemsize for a in meta['arrays'].values())
            check(f"engine {spec['engine']} ({spec['id']})", meta['format'] == 'tara-pack/1' and sizes_ok,
                  f"{time.time() - t0:.1f}s, {len(meta['claims'])} claims")
            if spec['id'] == 'selftest-circuit-ig':
                comp = meta['data']['completeness']['2']
                check('integrated gradients add up to the real gap', comp is not None and abs(comp - 1) < 0.1,
                      f'ratio {comp}')
            if spec['id'] == 'selftest-probe':
                pd = meta['data']
                check('the probe holds matched pairs out whole, with exact intervals',
                      pd.get('paired') is True and pd['n_test'] % 2 == 0 and 'exact' in pd.get('interval', '') and
                      all(0 <= r['logreg_ci'][0] <= r['logreg'] <= r['logreg_ci'][1] <= 1 for r in pd['rows']),
                      f"{pd['n_test']} of {pd['n']} held out")
            if spec['engine'] == 'circuit':
                g = json.loads((Path(d) / meta['data']['graph']).read_text(encoding='utf-8'))
                ids = {n['node_id'] for n in g['nodes']}
                check(f"graph links point at real nodes ({spec['id']})",
                      all(l['source'] in ids and l['target'] in ids for l in g['links']), f"{len(g['links'])} links")
        except Exception:
            traceback.print_exc()
            check(f"engine {spec['engine']} ({spec['id']})", False, 'raised')
    index = json.loads((Path(out) / 'index.json').read_text(encoding='utf-8'))
    check('index lists every pack', len(index['packs']) == len(specs), f"{len(index['packs'])} packs")
    try:
        run_spec({**common, 'engine': 'graph', 'id': 'selftest-graph', 'hf_model': 'x', 'transcoders': 'x',
                  'prompts': ['x']}, out=out)
        check('graph engine', False, 'ran without circuit-tracer?')
    except RuntimeError as e:
        check('graph engine explains a missing circuit-tracer', 'circuit-tracer' in str(e) or 'circuit_tracer' in str(e))
    except Exception as e:
        check('graph engine reached circuit-tracer', True, f'{type(e).__name__} past the import (installed here)')


def main():
    torch.set_num_threads(max(1, min(4, torch.get_num_threads())))
    try:
        statistics()
    except Exception:
        traceback.print_exc()
        check('statistics', False, 'raised')
    with tempfile.TemporaryDirectory() as tmp:
        dict_dir = tiny.write_dictionaries(Path(tmp) / 'dict')
        lm = load('tiny-qwen3.5', device='cpu')
        try:
            invariants(lm, dict_dir)
        except Exception:
            traceback.print_exc()
            check('invariants', False, 'raised')
        lm.unload()
        try:
            vlm_checkpoint(tmp)
        except Exception:
            traceback.print_exc()
            check('a saved Qwen 3.5 checkpoint loads as a causal LM', False, 'raised')
        try:
            layernorm_checkpoint(tmp)
        except Exception:
            traceback.print_exc()
            check('a LayerNorm model (GPT-2 layout) loads', False, 'raised')
        engines(Path(tmp) / 'findings', dict_dir)
    bad = [r for r in RESULTS if not r[1]]
    say(f'\n{len(RESULTS) - len(bad)} of {len(RESULTS)} checks passed')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
