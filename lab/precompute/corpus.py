"""Turn OpenWebText documents into the lab's corpus.

Every context is <|endoftext|> followed by 127 tokens of one document, so 128 tokens, the way TransformerLens feeds
GPT-2. Only full contexts are kept. The order is shuffled with a fixed seed, so any prefix of the corpus is a fair
sample of it. Writes contexts.npy (uint16 [N, 128]) and contexts.json (where it came from, counts).

    python corpus.py --src Z:/tara-lab/data/owt --out Z:/tara-lab/work --tokens 25e6
"""
import argparse
import json
import time
from pathlib import Path

import numpy as np

from labgpt2 import BOS, BPE

HERE = Path(__file__).resolve().parent


def docs(src):
    import pyarrow.parquet as pq
    for f in sorted(Path(src).rglob('*.parquet')):
        pf = pq.ParquetFile(f)
        for batch in pf.iter_batches(batch_size=256, columns=['text']):
            for text in batch.column('text').to_pylist():
                if text:
                    yield f.name, text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True, help='folder of parquet files with a text column (searched recursively)')
    ap.add_argument('--out', required=True)
    ap.add_argument('--bpe', default=str(HERE.parent / 'model' / 'bpe.json'))
    ap.add_argument('--tokens', type=float, default=25e6)
    ap.add_argument('--ctx', type=int, default=128)
    ap.add_argument('--seed', type=int, default=1234)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    tok = BPE(a.bpe)
    per = a.ctx - 1
    chunks, files, n_docs, n_ctx, t0 = [], set(), 0, 0, time.time()
    for fname, text in docs(a.src):
        ids = np.asarray(tok.encode(text), dtype=np.uint16)
        n_docs += 1
        files.add(fname)
        k = len(ids) // per
        if k:
            body = ids[:k * per].reshape(k, per)
            chunks.append(np.concatenate([np.full((k, 1), BOS, np.uint16), body], 1))
            n_ctx += k
        if n_docs % 2000 == 0:
            print(f'{n_docs} docs, {n_ctx} contexts, {n_ctx * per / 1e6:.1f}M tokens, {time.time() - t0:.0f}s', flush=True)
        if n_ctx * per >= a.tokens:
            break
    ctx = np.concatenate(chunks)
    ctx = ctx[np.random.default_rng(a.seed).permutation(len(ctx))]
    np.save(out / 'contexts.npy', ctx)
    info = {'source': 'OpenWebText (an open recreation of WebText, the text GPT-2 was trained on)',
            'files': sorted(files), 'documents': n_docs, 'contexts': int(len(ctx)), 'ctx_len': a.ctx,
            'tokens': int(len(ctx) * per), 'bos': BOS, 'seed': a.seed}
    (out / 'contexts.json').write_text(json.dumps(info, indent=1))
    print(json.dumps(info), f'{time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
