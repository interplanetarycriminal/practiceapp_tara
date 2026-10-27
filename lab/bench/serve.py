"""Start the live lab: a small server on this computer that runs the lab's tools on Qwen 3.5 9B on the graphics
card, for the Lab page's model picker (lab/core/remote.js is its client).

    python serve.py --lock Z:/tara-lab/gpulock.py --nf4-cache Z:/tara-lab/live/nf4 --hf-home Z:/tara-lab/hf
    python serve.py --models tiny-qwen3.5          # the plumbing on a tiny random model, no GPU needed

It listens on http://127.0.0.1:8790 and answers only the lab's pages. Nothing goes onto the GPU until a page asks
for a model, every request takes the GPU lock, and after --idle seconds without requests the process holding the model
exits, so the card gets every byte back. To start it with Windows, run it with pythonw.exe and --log (no window).
lab/bench/live_check.py checks a running server end to end."""
import argparse
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8790, help='8790: wrangler dev already holds 8787 on the PC')
    ap.add_argument('--host', default='127.0.0.1', help='the address to listen on (keep it on this computer)')
    ap.add_argument('--lock', default='', help='a .py file defining hold(): take turns with other GPU users')
    ap.add_argument('--lock-timeout', type=float, default=1800,
                    help='seconds a request waits for the GPU before giving up (a render can hold it for many minutes)')
    ap.add_argument('--idle', type=float, default=1200, help='let the card go after this many seconds without requests')
    ap.add_argument('--models', nargs='*', default=None, help='models to offer (default: qwen3.5-9b)')
    ap.add_argument('--stats', default='', help="folder for each model's measured residual norms (default: work/live)")
    ap.add_argument('--nf4-cache', default='', help='folder for 4-bit copies of the 4-bit models, which load faster')
    ap.add_argument('--hf-home', default='', help='the Hugging Face cache to read models from (HF_HOME, for this server only)')
    ap.add_argument('--model-dir', action='append', default=[], metavar='NAME=PATH',
                    help='load a registry model from a local folder instead of the hub')
    ap.add_argument('--allow-host', action='append', default=[], help='another name this server may be reached by')
    ap.add_argument('--device', default=None)
    ap.add_argument('--log', default='', help='append what the server says to this file (for running it with pythonw)')
    a = ap.parse_args()
    if a.log:
        Path(a.log).parent.mkdir(parents=True, exist_ok=True)
        sys.stdout = sys.stderr = open(a.log, 'a', buffering=1, encoding='utf-8')
    if a.hf_home:
        os.environ['HF_HOME'] = a.hf_home              # before anything imports huggingface_hub; the card process inherits it
    from tarabench import models
    from tarabench.common import WORK
    from tarabench.live.server import LIVE, Live, serve
    for m in a.models or []:
        if m not in LIVE:
            ap.error(f'--models: {m} is not one of {", ".join(sorted(LIVE))}')
    for m in a.model_dir:
        name, _, path = m.partition('=')
        if not Path(path).is_dir():
            ap.error(f'--model-dir {m}: no folder at {path}')
        models.LOCAL[name] = path
    live = Live(models=a.models, lock=a.lock or None, lock_timeout=a.lock_timeout, idle=a.idle,
                stats_dir=a.stats or str(WORK / 'live'), nf4_cache=a.nf4_cache or None, device=a.device,
                local=models.LOCAL, log=a.log or None)
    serve(live, a.host, a.port, a.allow_host)


if __name__ == '__main__':
    main()
