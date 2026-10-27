"""Run every precompute job in order, skipping what is already done: corpus -> neurons -> steer lens -> sweep -> SAE,
then the list hints (summarise.py, CPU only).
Each job runs in its own process, so GPU memory is handed back between jobs. Every job is resumable.

    python run_all.py --data Z:/tara-lab/data --work Z:/tara-lab/work --lock Z:/tara-lab/gpulock.py --smoke
    python run_all.py --data Z:/tara-lab/data --work Z:/tara-lab/work --lock Z:/tara-lab/gpulock.py

--smoke runs everything on a sliver of the data into <work>/smoke-out, in a minute or two, to prove the pipeline.
The real run writes into lab/data of this checkout.
"""
import argparse
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def run(script, *args):
    cmd = [sys.executable, str(HERE / script), *map(str, args)]
    print('\n>>>', ' '.join(cmd), flush=True)
    t0 = time.time()
    subprocess.run(cmd, check=True, cwd=HERE)
    print(f'<<< {script} done in {time.time() - t0:.0f}s', flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True, help='holds owt/ (parquet) and sae/ (blocks.N.hook_resid_pre)')
    ap.add_argument('--work', required=True)
    ap.add_argument('--lock', default='')
    ap.add_argument('--tokens', default='25e6')
    ap.add_argument('--sae-layers', default='7')
    ap.add_argument('--smoke', action='store_true')
    ap.add_argument('--device', default='cuda')
    ap.add_argument('--only', default='', help='comma list of jobs to run: corpus,neurons,steer,sweep,sae')
    a = ap.parse_args()
    data, work = Path(a.data), Path(a.work)
    lock = ['--lock', a.lock] if a.lock else []
    dev = ['--device', a.device]
    only = set(a.only.split(',')) if a.only else {'corpus', 'neurons', 'steer', 'sweep', 'sae'}
    if a.smoke:
        w = work / 'smoke'
        out = w / 'out'
        w.mkdir(parents=True, exist_ok=True)
        if 'corpus' in only and not (w / 'contexts.npy').exists():
            run('corpus.py', '--src', data / 'owt', '--out', w, '--tokens', '2e5')
        if 'neurons' in only:
            run('neurons.py', '--work', w, '--out', out, '--limit', 512, '--phase-a', 256, '--chunk', 256,
                '--norm-contexts', 128, '--cofire', 256, *lock, *dev)
        if 'steer' in only:
            run('steerlens.py', '--out', out, '--work', w, '--layers', '0-1', '--neurons', 128, '--chunk', 64, *lock, *dev)
        if 'sweep' in only:
            run('sweep.py', '--out', out, '--work', w, '--layers', '5', '--neurons', 64, '--controls', 8, '--new', 12, *lock, *dev)
        if 'sae' in only:
            run('sae.py', '--sae', data / 'sae', '--work', w, '--out', out, '--layers', a.sae_layers, '--limit', 256,
                '--phase-a', 64, '--chunk', 128, *lock, *dev)
        print('\nsmoke run finished; outputs in', out)
        return
    work.mkdir(parents=True, exist_ok=True)
    if 'corpus' in only and not (work / 'contexts.npy').exists():
        run('corpus.py', '--src', data / 'owt', '--out', work, '--tokens', a.tokens)
    if 'neurons' in only:
        run('neurons.py', '--work', work, *lock, *dev)
    if 'steer' in only:
        run('steerlens.py', '--work', work, *lock, *dev)
    if 'sweep' in only:
        run('sweep.py', '--work', work, *lock, *dev)
    if 'sae' in only:
        run('sae.py', '--sae', data / 'sae', '--work', work, '--layers', a.sae_layers, *lock, *dev)
    run('summarise.py')
    print('\nall jobs finished; outputs in', HERE.parent / 'data')


if __name__ == '__main__':
    main()
