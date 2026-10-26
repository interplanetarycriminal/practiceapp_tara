"""Run one or more bench specs; each writes a result pack into lab/findings (or --out).

    python run.py specs/smoke-qwen35-2b-probe.json --lock Z:/tara-lab/gpulock.py
    python run.py specs/*.json --smoke          # each spec's small "smoke" variant, to prove the pipeline
    python run.py --list                         # what is in specs/

A failing spec does not stop the others; failures are listed at the end and the exit code is 1."""
import argparse
import glob
import json
import sys
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from tarabench.common import WORK, say  # noqa: E402
from tarabench.runner import read_spec, run_spec  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('specs', nargs='*')
    ap.add_argument('--lock', default='', help='a .py file defining hold(): take turns with other GPU users')
    ap.add_argument('--device', default=None)
    ap.add_argument('--out', default=None, help='findings folder (default: lab/findings of this checkout)')
    ap.add_argument('--smoke', action='store_true', help="use each spec's smoke settings, written as <id>-smoke")
    ap.add_argument('--list', action='store_true')
    a = ap.parse_args()
    if a.list:
        for p in sorted((HERE / 'specs').glob('*.json')):
            s = json.loads(p.read_text(encoding='utf-8'))
            say(f"{p.name:44s} {s.get('engine', '?'):9s} {s.get('title', '')}")
        return 0
    paths = [p for pat in a.specs for p in (sorted(glob.glob(pat)) or [pat])]
    if not paths:
        ap.error('give at least one spec')
    failures = []
    for p in paths:
        t0 = time.time()
        try:
            spec = read_spec(p)
            out = run_spec(spec, a.out, a.lock, a.device, a.smoke)
            say(f'== done {p} in {time.time() - t0:.0f}s -> {out}')
        except Exception as e:  # keep going; report at the end
            traceback.print_exc()
            failures.append({'spec': p, 'error': f'{type(e).__name__}: {e}'})
    if failures:
        WORK.mkdir(parents=True, exist_ok=True)
        (WORK / 'failures.json').write_text(json.dumps(failures, indent=1))
        say(f'\n{len(failures)} of {len(paths)} specs failed:')
        for f in failures:
            say(f"  {f['spec']}: {f['error']}")
        return 1
    say(f'\nall {len(paths)} specs finished')
    return 0


if __name__ == '__main__':
    sys.exit(main())
