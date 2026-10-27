"""Is this PC ready for the bench? Checks step by step, says what to fix, and writes work/setup_check.json.

    python setup_check.py                                   # packages, GPU, Hugging Face access, the tiny self-test
    python setup_check.py --model qwen3.5-2b-base --dict-layer 12 --lock Z:/tara-lab/gpulock.py
                                                            # also a real model and its Qwen-Scope dictionary

The model check downloads what it needs into the Hugging Face cache (set HF_HOME to keep it off C:). It never prints
or stores a Hugging Face token; it only says whether one is configured."""
import argparse
import importlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

REPORT = {'checks': []}


def note(name, ok, detail='', fix=''):
    REPORT['checks'].append({'check': name, 'ok': ok, 'detail': detail, 'fix': fix})
    mark = 'ok ' if ok is True else 'WARN' if ok is None else 'FAIL'
    print(f'[{mark}] {name}: {detail}' + (f'\n       fix: {fix}' if fix and ok is not True else ''), flush=True)


def version(mod):
    try:
        m = importlib.import_module(mod)
        return getattr(m, '__version__', 'installed')
    except Exception:
        return None


def packages():
    note('python', sys.version_info >= (3, 10), sys.version.split()[0], 'use Python 3.10 or newer')
    tv = version('torch')
    note('torch', tv is not None, tv or 'missing', 'install PyTorch with CUDA into the venv')
    trv = version('transformers')
    ok = trv is not None and tuple(int(x) for x in trv.split('.')[:2]) >= (5, 2)
    note('transformers', ok, trv or 'missing', 'pip install -r requirements.txt (Qwen 3.5 needs transformers 5)')
    for mod, why in (('accelerate', 'loads models straight onto the GPU'), ('huggingface_hub', 'downloads'),
                     ('safetensors', 'reads weights')):
        v = version(mod)
        note(mod, v is not None, v or 'missing', 'pip install -r requirements.txt')
    v = version('bitsandbytes')
    note('bitsandbytes (4-bit loading)', True if v else None, v or 'missing: 9B models will only load in bf16, '
         'which needs about 20 GB free', 'pip install bitsandbytes')
    v = version('fla')
    note('flash-linear-attention (optional)', True if v else None,
         v or "not installed: Qwen 3.5's linear-attention layers use the slower plain-PyTorch path, which is fine "
              'for these prompt sizes')
    v = version('pyarrow')
    note('pyarrow (parquet corpora)', True if v else None, v or 'missing: feature scans need a corpus in parquet',
         'pip install pyarrow')


def gpu():
    import torch
    if not torch.cuda.is_available():
        note('CUDA GPU', False, 'torch sees no GPU', 'install a CUDA build of torch')
        return
    free, total = torch.cuda.mem_get_info()
    REPORT['gpu'] = {'name': torch.cuda.get_device_name(0), 'free_gb': free / 2 ** 30, 'total_gb': total / 2 ** 30}
    note('CUDA GPU', True, f"{REPORT['gpu']['name']}, {free / 2 ** 30:.1f} of {total / 2 ** 30:.1f} GB free")
    if free / 2 ** 30 < 8:
        note('free GPU memory', None, f'{free / 2 ** 30:.1f} GB: the 2B models fit; 9B models need about 9 GB in 4-bit',
             'unload models in ComfyUI before a 9B run')


def hub():
    try:
        from huggingface_hub import HfApi, constants, get_token
    except ImportError:
        return
    note('Hugging Face cache', True, str(constants.HF_HUB_CACHE))
    if str(constants.HF_HUB_CACHE).upper().startswith('C:'):
        note('cache location', None, 'the cache is on C:', 'set HF_HOME=Z:\\tara-lab\\hf before running')
    note('Hugging Face token', True if get_token() else None,
         'configured' if get_token() else 'none: public Qwen models work; Gemma needs a read token and its licence',
         'run "hf auth login" on this PC (never paste the token into chat)')
    api = HfApi()
    try:
        info = api.model_info('Qwen/Qwen3.5-2B-Base')
        note('hub reachable', True, f'Qwen/Qwen3.5-2B-Base at {info.sha[:8]}')
    except Exception as e:
        note('hub reachable', False, f'{type(e).__name__}: {e}', 'check the network or HF_HUB_OFFLINE')
        return
    try:
        if hasattr(api, 'auth_check'):
            api.auth_check('google/gemma-3-1b-it')
        else:
            api.model_info('google/gemma-3-1b-it')
        note('Gemma licence', True, 'google/gemma-3-1b-it is accessible')
    except Exception as e:
        note('Gemma licence', None, f'not accessible yet ({type(e).__name__})',
             'accept the licence at https://huggingface.co/google/gemma-3-1b-it with the account whose token is on this PC')


def selftest():
    t0 = time.time()
    r = subprocess.run([sys.executable, str(HERE / 'selftest.py')], capture_output=True, text=True, cwd=HERE)
    last = [l for l in r.stdout.splitlines() if 'checks passed' in l]
    fails = [l for l in r.stdout.splitlines() if l.startswith('FAIL')]
    note('self-test on a tiny Qwen 3.5', r.returncode == 0,
         (last[0] if last else 'no summary') + f' in {time.time() - t0:.0f}s' + (f'; {fails}' if fails else ''),
         'see the output of python selftest.py')
    if r.returncode != 0:
        (HERE / 'work').mkdir(exist_ok=True)
        (HERE / 'work' / 'selftest.log').write_text(r.stdout + '\n' + r.stderr, encoding='utf-8')


def real_model(name, dict_layer, lock, precision='auto'):
    import torch
    from tarabench.common import gpu_lock
    from tarabench.data import NEUTRAL
    from tarabench.models import load
    t0 = time.time()
    lm = load(name, precision=precision)
    lm.hold = gpu_lock(lock)
    note(f'load {name}', True, f'{lm.precision}, {lm.n_layers} layers, width {lm.d_model}, {time.time() - t0:.0f}s')
    seqs = lm.encode(['The capital of France is', 'Here is a short story about a lighthouse keeper:',
                      'def fibonacci(n):'])
    t0 = time.time()
    lp = lm.last_logprobs(seqs)
    top = [[lm.tok.decode([int(i)]) for i in row.topk(5).indices] for row in lp]
    note('forward pass', True, f'next tokens {top[0]} after "The capital of France is" ({time.time() - t0:.1f}s)')
    single = torch.cat([lm.last_logprobs([s]) for s in seqs])
    gap = (single - lp).abs()
    d, dm, same = float(gap.max()), float(gap.mean()), bool((single.argmax(-1) == lp.argmax(-1)).all())
    # float32 is exact. In bf16 (or 4-bit) a batch takes different matrix kernels through the whole network, so scores
    # differ by rounding (about 0.02 nats on average for Qwen 3.5 2B in bf16); a padding bug changes the top token or
    # moves a score by whole nats, which is what this looks for there, and the rounding is reported as the resolution
    gap_s = f'log-prob difference, batched against single: max {d:.3g}, mean {dm:.2g}, same top token: {same}'
    if lm.dtype == torch.float32:
        note('batching is exact on this model', d < 1e-3, f'{gap_s} (fp32)',
             'report this: batched runs disagree with single runs by more than rounding')
    else:
        bug = not same or d >= 0.5
        note(f'batching agrees up to {lm.precision} rounding', False if bug else None if dm > 0.01 else True,
             f'{gap_s} ({lm.precision}; float32 head {"on" if lm._head32 else "off"})' +
             ('' if bug else f'; effects smaller than about {3 * dm:.2g} nats are below {lm.precision} rounding here'),
             'report this: batched runs disagree with single runs by more than rounding' if bug else
             'set "precision": "fp32" in a spec when the model fits in float32 (Qwen 3.5 2B does)')
    REPORT['model'] = lm.info()
    if dict_layer is not None and lm.entry.get('sae'):
        from tarabench.sae import TopKSAE, qwen_scope_repo
        repo = qwen_scope_repo(lm.id)
        t0 = time.time()
        sae = TopKSAE.load(repo, dict_layer, device=lm.device, dtype=lm.dtype if lm.device.type == 'cuda' else torch.float32)
        acts = []
        for b in lm.batches(lm.encode(NEUTRAL)):
            h = lm.capture(b, [dict_layer])[dict_layer]
            for r, n in enumerate(b.lengths):
                acts.append(h[r, 1:n])
        q = sae.quality(torch.cat(acts))
        note(f'Qwen-Scope dictionary, layer {dict_layer}', q['fve'] > 0.5,
             f"{repo}: {q['fve']:.1%} of variance explained, cosine {q['cos']:.3f}, L0 {q['l0']:.0f} on {q['rows']} "
             f'tokens ({time.time() - t0:.0f}s)', 'a dictionary that explains little does not match this model')
        REPORT['dictionary'] = {**sae.meta, **q}
    lm.unload()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default=None)
    ap.add_argument('--dict-layer', type=int, default=None)
    ap.add_argument('--precision', default='auto', help='auto, fp32, bf16 or nf4, as in a spec')
    ap.add_argument('--lock', default='')
    ap.add_argument('--skip-selftest', action='store_true')
    a = ap.parse_args()
    REPORT['time'] = time.strftime('%Y-%m-%d %H:%M:%S')
    packages()
    try:
        gpu()
    except Exception as e:
        note('CUDA GPU', False, f'{type(e).__name__}: {e}')
    hub()
    if not a.skip_selftest:
        selftest()
    if a.model:
        try:
            real_model(a.model, a.dict_layer, a.lock, a.precision)
        except Exception as e:
            note(f'real model {a.model}', False, f'{type(e).__name__}: {e}')
    out = HERE / 'work'
    out.mkdir(exist_ok=True)
    (out / 'setup_check.json').write_text(json.dumps(REPORT, indent=1, default=str), encoding='utf-8')
    bad = [c for c in REPORT['checks'] if c['ok'] is False]
    print(f"\n{len(REPORT['checks']) - len(bad)} of {len(REPORT['checks'])} checks fine; report in {out / 'setup_check.json'}")
    return 1 if bad else 0


if __name__ == '__main__':
    os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')
    sys.exit(main())
