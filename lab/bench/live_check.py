"""Check a running live lab server end to end: every request the Lab's tools make, with the identities that must hold
whatever the model (a patch that restores the clean run scores 1, direct logit attribution adds up to the logit
difference, a neuron's trace equals its column of the firing table, greedy writing starts with predict's top token).

    python live_check.py                                   # the server on this computer, its first model
    python live_check.py --model qwen3.5-9b --out check.json
    python live_check.py --tiny                            # starts its own server on a tiny random model (no GPU)

Exit code 0 when every check passes."""
import argparse
import json
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from tarabench.live.wire import pack, unpack  # noqa: E402

FACT = 'The capital of France is'
CLEAN = 'When Mary and John went to the store, John gave a drink to'
CORRUPT = 'When Mary and John went to the store, Mary gave a drink to'


class Server:
    def __init__(self, base, model=None):
        self.base, self.model = base.rstrip('/'), model

    def info(self, timeout=120):
        with urllib.request.urlopen(self.base + '/v1/info', timeout=timeout) as r:
            return json.loads(r.read())

    def ready(self, wait=600):
        """/v1/info once the server has finished starting (it reads each model's config and tokeniser first)."""
        t = time.time()
        info = self.info()
        while info.get('warming') and time.time() - t < wait:
            time.sleep(2)
            info = self.info()
        return info

    def call(self, op, args=None, channel=None, on=None, origin=None, stages=None):
        body = pack({'op': op, 'args': args or {}, 'model': self.model, 'channel': channel})
        headers = {'Content-Type': 'application/octet-stream', **({'Origin': origin} if origin else {})}
        req = urllib.request.Request(self.base + '/v1/call', data=body, method='POST', headers=headers)
        with urllib.request.urlopen(req, timeout=1800) as r:
            while True:
                n = r.read(4)
                if len(n) < 4:
                    raise RuntimeError('the answer ended early')
                msg = unpack(r.read(struct.unpack('<I', n)[0]))
                if 'progress' in msg:
                    if on:
                        on(msg['progress'])
                elif 'stage' in msg:
                    if stages is not None:
                        stages.append(msg['stage'])
                elif 'ok' in msg:
                    if msg['ok']:
                        return msg['result']
                    raise RuntimeError(msg.get('error'))

    def recipe(self, name, args, **kw):
        return self.call('recipe', {'name': name, 'args': args}, **kw)


class Report:
    def __init__(self):
        self.rows, self.times, self.failed = [], {}, 0

    def check(self, name, ok, detail=''):
        self.rows.append({'check': name, 'ok': bool(ok), 'detail': str(detail)})
        if not ok:
            self.failed += 1
        print(f'  {"ok  " if ok else "FAIL"} {name}{": " + str(detail) if detail else ""}', flush=True)
        return ok

    def timed(self, name, fn):
        t = time.time()
        out = fn()
        self.times[name] = round(time.time() - t, 2)
        return out


def run(s, rep, quick=False):
    t = time.time()
    info = s.ready()
    rep.check('the server answers /v1/info at once, and is ready to work', not info.get('warming') and time.time() - t < 600,
              f'started in {info.get("warmS")} s')
    offered = [m['id'] for m in info['models']]
    s.model = s.model or offered[0]
    real = not s.model.startswith('tiny')
    shape = next(m['cfg'] for m in info['models'] if m['id'] == s.model)
    print(f'server {info["server"]} v{info["version"]}, model {s.model}, card {info.get("gpu")}', flush=True)
    rep.check('the model is offered with its shape before loading', shape is not None and shape.get('L'), shape and {k: shape[k] for k in ('L', 'H', 'D', 'M', 'V')})
    free0 = (info.get('gpu') or {}).get('free')

    stages = []
    cfg = rep.timed('load', lambda: s.call('load', stages=stages))
    L, H, D, M = cfg['L'], cfg['H'], cfg['D'], cfg['M']
    print(f'loaded in {rep.times["load"]} s: L {L} H {H} D {D} M {M} V {cfg["V"]}, attention layers {cfg["attnLayers"]}', flush=True)
    rep.check('the shape before loading matches the loaded model', all(shape[k] == cfg[k] for k in ('L', 'H', 'D', 'M', 'V', 'heads', 'kinds', 'attnLayers')))
    rep.check('the dose unit is measured for every layer', len(cfg['residNorm']) == L and all(x > 0 for x in cfg['residNorm']))
    rep.check('loading reported its progress', any(x.get('stage') in ('loading', 'running') for x in stages) or not stages, len(stages))

    tk = s.call('tokenize', {'text': FACT})
    ids = tk['ids']
    back = s.call('decode', {'ids': ids[1:]})['text']
    rep.check('tokenising and decoding round-trip', back == FACT, repr(back))
    rep.check('prompts start with <|endoftext|>', ids[0] == cfg['bos'], ids[:3])

    P = rep.timed('predict', lambda: s.recipe('predict', {'ids': ids, 'k': 5, 'full': True}))
    top = s.call('vocab', {'ids': P['top']})['vocab']
    print('  top 5 after the fact prompt:', list(zip(top, [round(p, 3) for p in P['probs']])), flush=True)
    if real:
        rep.check('the model knows the capital of France', top[0].strip() == 'Paris', top[0])
    rep.check('the full logits match the top list', int(np.argmax(P['all'])) == P['top'][0] and len(P['all']) == cfg['V'])

    LL = rep.timed('logitLens', lambda: s.recipe('logitLens', {'ids': ids, 'k': 3, 'target': P['top'][0]}))
    S_, Pn, k = LL['S'], LL['P'], LL['k']
    last = LL['top'][((S_ - 1) * Pn + Pn - 1) * k]
    rep.check('the lens after the last layer reads predict\'s answer', last == P['top'][0], last)

    rep.timed('perToken', lambda: s.recipe('perToken', {'ids': ids, 'k': 3}))

    A = rep.timed('attention', lambda: s.recipe('attention', {'ids': ids}))
    T = len(ids)
    al = cfg['attnLayers'][0]
    pat = A['patterns'][al]
    rows = np.asarray(pat, dtype=np.float64).reshape(cfg['heads'][al], T, T).sum(-1)
    rep.check('attention rows sum to 1', np.allclose(rows, 1, atol=2e-3), float(np.abs(rows - 1).max()))
    rep.check('DeltaNet layers draw no pattern', all((A['patterns'][l] is None) == (cfg['kinds'][l] != 'attention') for l in range(L)))

    HS = rep.timed('headScores', lambda: s.recipe('headScores', {'seqLen': 20, 'batch': 2, 'seed': 7}))
    n_attn = sum(cfg['heads'][l] for l in cfg['attnLayers'])
    rep.check('head scores fill the attention heads', int(np.isfinite(HS['prev']).sum()) == n_attn, f'{int(np.isfinite(HS["prev"]).sum())} of {n_attn}')
    j = int(np.nanargmax(HS['induction']))
    print(f'  strongest induction head: L{j // H}.H{j % H} ({HS["induction"][j]:.2f})', flush=True)

    tc, tx = s.call('tokenize', {'text': CLEAN})['ids'], s.call('tokenize', {'text': CORRUPT})['ids']
    if len(tc) == len(tx):
        a_id, b_id = s.call('tokenize', {'text': ' Mary', 'bos': False})['ids'][0], s.call('tokenize', {'text': ' John', 'bos': False})['ids'][0]
        met = {'kind': 'logitdiff', 'a': a_id, 'b': b_id, 'pos': len(tc) - 1}
        Dd = rep.timed('dla', lambda: s.recipe('dla', {'ids': tc, 'a': a_id, 'b': b_id, 'neurons': 10}))
        gap = abs(Dd['sum'] - Dd['actual'])
        rep.check('direct attribution adds up to the logit difference', gap <= 0.03 * max(1.0, abs(Dd['actual'])), f'pieces {Dd["sum"]:.3f}, actual {Dd["actual"]:.3f}')
        if real:
            rep.check('the clean prompt prefers " Mary"', Dd['actual'] > 0, round(Dd['actual'], 2))
        diff = [p for p in range(len(tc)) if tc[p] != tx[p]]
        Pa = rep.timed('patch resid_pre', lambda: s.recipe('patch', {'clean': tc, 'corrupt': tx, 'metric': met, 'hook': 'resid_pre'}))
        sc = np.asarray(Pa['score']).reshape(L, len(tc))
        rep.check('patching the changed token at layer 0 restores the clean run', all(abs(sc[0, p] - 1) < 0.05 for p in diff), [round(float(sc[0, p]), 3) for p in diff])
        same = [p for p in range(len(tc)) if p not in diff]
        rep.check('patching an unchanged token at layer 0 changes nothing', float(np.abs(sc[0, same]).max()) < 0.05, round(float(np.abs(sc[0, same]).max()), 4))
        if not quick:
            Pb = rep.timed('patch resid_post', lambda: s.recipe('patch', {'clean': tc, 'corrupt': tx, 'metric': met, 'hook': 'resid_post'}))
            sb = np.asarray(Pb['score']).reshape(L, len(tc))
            rep.check('patching the last layer\'s output at the answer restores it', abs(sb[L - 1, -1] - 1) < 0.05, round(float(sb[L - 1, -1]), 4))
            Ph = rep.timed('patch heads', lambda: s.recipe('patch', {'clean': tc, 'corrupt': tx, 'metric': met, 'hook': 'head'}))
            rep.check('head patching fills one cell per head', int(np.isfinite(Ph['score']).sum()) == sum(cfg['heads']))
        HSw = rep.timed('headSweep zero', lambda: s.recipe('headSweep', {'ids': tc, 'metric': met, 'mode': 'zero'}))
        rep.check('ablating each head gives one number per head', int(np.isfinite(HSw['delta']).sum()) == sum(cfg['heads']))
        if not quick:
            rep.timed('headSweep mean', lambda: s.recipe('headSweep', {'ids': tc, 'metric': met, 'mode': 'mean'}))
        v0 = s.recipe('metric', {'ids': tc, 'metric': met, 'ivs': [[], [{'hook': 'resid_post', 'layer': L // 2, 'op': 'mul', 'value': 1.0}]]})['values']
        rep.check('an intervention that multiplies by 1 changes nothing', abs(v0[0] - v0[1]) < 0.02 * max(1.0, abs(v0[0])), [round(x, 4) for x in v0])
    else:
        rep.check('the patching prompts have the same length', False, f'{len(tc)} and {len(tx)} tokens')

    F = rep.timed('fires', lambda: s.recipe('fires', {'ids': ids}))
    acts = np.asarray(F['acts'], dtype=np.float32).reshape(L, T, M)
    l1, n1 = L // 2, int(np.argmax(np.abs(acts[L // 2, -1])))
    tr = rep.timed('neuronTrace', lambda: s.recipe('neuronTrace', {'ids': ids, 'layer': l1, 'neuron': n1}))['acts']
    rep.check('a neuron\'s trace equals its column of the firing table', np.allclose(tr, acts[l1, :, n1], rtol=2e-2, atol=2e-2), f'L{l1}.N{n1} {float(np.abs(tr - acts[l1, :, n1]).max()):.4f}')

    V = rep.timed('vector', lambda: s.recipe('vector', {'pos': s.call('tokenize', {'text': 'I love this, it is wonderful'})['ids'], 'neg': s.call('tokenize', {'text': 'I hate this, it is terrible'})['ids'], 'layer': L // 2}))
    U = rep.timed('unembedVec', lambda: s.recipe('unembedVec', {'vec': np.asarray(V['vec'], dtype=np.float32), 'k': 8}))
    print('  love minus hate, read out:', s.call('vocab', {'ids': [t for t, _ in U['up'][:6]]})['vocab'], flush=True)
    Rz = rep.timed('residuals', lambda: s.recipe('residuals', {'texts': [ids, tc], 'hook': 'resid_post', 'pos': 'mean'}))
    rep.check('residuals hold n x L x D numbers', len(Rz['vecs']) == 2 * L * D)
    NW = rep.timed('neuronWeights', lambda: s.recipe('neuronWeights', {'layer': l1, 'neuron': n1, 'k': 6}))
    rep.check('a neuron\'s weights have the model\'s width', len(NW['wout']) == D and len(NW['win']) == D and len(NW['winUp']) == D)
    words = [t for t in s.call('tokenize', {'text': ' cat dog red blue', 'bos': False})['ids']]
    OV = rep.timed('ovCircuit', lambda: s.recipe('ovCircuit', {'layer': cfg['attnLayers'][-1], 'head': 0, 'tokens': words, 'k': 4}))
    rep.check('the OV circuit reads every token', len(OV['selfRank']) == len(words), [int(x) for x in OV['selfRank']])
    lin = next((l for l in range(L) if cfg['kinds'][l] != 'attention'), None)
    if lin is not None:
        try:
            s.recipe('ovCircuit', {'layer': lin, 'head': 0, 'tokens': words})
            rep.check('the OV circuit refuses a DeltaNet layer', False)
        except RuntimeError as e:
            rep.check('the OV circuit refuses a DeltaNet layer', 'DeltaNet' in str(e))
    rep.timed('neuronLens', lambda: s.recipe('neuronLens', {'neurons': [0, l1 * M + n1, (L - 1) * M + 7], 'k': 4}))
    lp = max(1, l1)
    prev = acts[:lp, -1].reshape(-1)
    NL = rep.timed('neuronLinks', lambda: s.recipe('neuronLinks', {'layer': lp, 'neuron': n1, 'k': 4, 'acts': prev, 'sigma': float(F['sigma'][lp * T + T - 1])}))
    rep.check('neuron links list what feeds a neuron', len(NL['fedBy']) > 0 and NL['pushed'] is not None)
    NP = rep.timed('neuronPush', lambda: s.recipe('neuronPush', {'ids': ids, 'layer': l1, 'neuron': n1, 'dose': 0.8, 'controls': 2}))
    rep.check('pushing a neuron reports its effect and its controls', len(NP['klCtrl']) == 2, round(NP['kl'], 4))
    rep.timed('lensSearch', lambda: s.recipe('lensSearch', {'token': P['top'][0], 'k': 5}))

    if not quick:
        SL = s.call('saeLayers')
        layer = (16 if 16 in SL['cached'] else SL['cached'][len(SL['cached']) // 2]) if SL['cached'] else None
        print(f'  dictionaries on this computer: layers {SL["cached"]} of {SL["layers"]} ({SL.get("repo")})', flush=True)
        if layer is None:
            rep.check('a dictionary is on this computer', False)
        else:
            meta = rep.timed('saeLoad', lambda: s.call('saeLoad', {'layer': layer}))
            long_ids = s.call('tokenize', {'text': 'The river runs for about three hundred kilometres before it reaches the sea, '
                                                   'and the town at its mouth has been a port since Roman times.'})['ids']
            E = rep.timed('saeEncode', lambda: s.recipe('saeEncode', {'ids': long_ids, 'k': 4, 'top': 10}))
            rep.check('the dictionary keeps at most k features per token', int(np.max(E['l0'])) <= meta['k'], f'max {int(np.max(E["l0"]))}, k {meta["k"]}')
            if real:
                rep.check('the dictionary explains most of the stream', E['ev'] > 0.3, round(E['ev'], 3))
            f0, v0, p0 = E['strongest'][0]
            St = rep.timed('saeTrace', lambda: s.recipe('saeTrace', {'ids': long_ids, 'feature': int(f0)}))
            rep.check('a feature\'s trace peaks where the encoder said', abs(float(St['acts'][p0]) - v0) < 0.02 * max(1.0, abs(v0)), f'{float(St["acts"][p0]):.3f} vs {v0:.3f}')
            rep.check('a feature\'s decoder row has the model\'s width', len(s.recipe('saeRow', {'feature': int(f0)})['dec']) == D)
            rep.timed('saeNeighbors', lambda: s.recipe('saeNeighbors', {'feature': int(f0), 'k': 4}))
            SS = rep.timed('saeSearch', lambda: s.recipe('saeSearch', {'token': P['top'][0], 'k': 8}))
            sv = [v for _, v in SS['up']]
            rep.check('the feature search lists the strongest first', len(sv) == 8 and all(a >= b for a, b in zip(sv, sv[1:])), [round(v, 3) for v in sv[:3]])
            fs = [int(f) for f, _ in SS['up'][:3]] + [int(f0)]
            SLn = rep.timed('saeLens', lambda: s.recipe('saeLens', {'features': fs, 'k': 6}))
            rep.check('the feature lens reads every feature asked for', len(SLn['lens']) == len(fs) and all(len(x['up']) == 6 for x in SLn['lens']))
            best = SLn['lens'][0]['up'][0][1]
            rep.check('the strongest feature for a token writes some token at least that much', best >= sv[0] - 0.02 * max(1.0, abs(sv[0])), f'{best:.3f} vs {sv[0]:.3f}')

    steps = []
    G = rep.timed('generate', lambda: s.call('generate', {'prompt': ids, 'R': 1, 'maxNew': 8, 'temperature': 0, 'alts': 3}, on=steps.append))
    rep.check('greedy writing starts with predict\'s top token', G['tokens'][0][0] == P['top'][0], repr(G['texts'][0]))
    rep.check('writing streams one step per token', len(steps) == len(G['tokens'][0]))
    G2 = s.call('generate', {'prompt': ids, 'R': 2, 'maxNew': 8, 'temperature': 0,
                             'iv': [{'hook': 'resid_post', 'layer': L // 2, 'op': 'add', 'rows': [1], 'vec': np.asarray(V['vec'], dtype=np.float32), 'value': 4.0}]})
    rep.check('a row without the steering writes the same text', G2['tokens'][0] == G['tokens'][0], f'{G2["texts"][0]!r} | steered: {G2["texts"][1]!r}')
    G3 = s.call('generate', {'prompt': ids, 'R': 1, 'maxNew': 8, 'temperature': 0.8, 'topK': 40, 'topP': 0.95, 'seed': 3})
    print('  sampled:', repr(G3['texts'][0]), flush=True)

    out = {}

    def slow():
        try:
            out['a'] = s.recipe('residuals', {'texts': [ids] * 400, 'hook': 'resid_post', 'pos': 'last'}, channel='x')
        except RuntimeError as e:
            out['a'] = 'error: ' + str(e)
    th = threading.Thread(target=slow)
    th.start()
    time.sleep(0.4)
    s.recipe('predict', {'ids': ids, 'k': 2}, channel='x')
    th.join()
    rep.check('a newer request on a channel cancels the older one', out.get('a') == 'error: cancelled', out.get('a') if isinstance(out.get('a'), str) else 'it finished')
    try:
        s.call('tokenize', {'text': 'x'}, origin='https://evil.example')
        rep.check('pages from other sites are refused', False)
    except urllib.error.HTTPError as e:
        rep.check('pages from other sites are refused', e.code == 403, e.code)

    i1 = s.info()
    print(f'  card memory: {(i1.get("mem") or 0) / 2**30:.2f} GB held, {(i1.get("peak") or 0) / 2**30:.2f} GB at the peak', flush=True)
    s.call('release')
    t0 = time.time()
    while time.time() - t0 < 90 and s.info().get('card'):
        time.sleep(1)
    i2 = s.info()
    rep.check('release ends the card process', not i2.get('card'))
    if free0 is not None and i2.get('gpu'):
        rep.check('the card gets its memory back', i2['gpu']['free'] >= free0 - (300 << 20), f'{free0 / 2**30:.2f} GB free before, {i2["gpu"]["free"] / 2**30:.2f} GB after')
    return {'model': s.model, 'cfg': {k: cfg[k] for k in ('L', 'H', 'D', 'M', 'V', 'heads', 'kinds', 'attnLayers', 'residNorm', 'loadS')},
            'peakGB': round((i1.get('peak') or 0) / 2**30, 2), 'memGB': round((i1.get('mem') or 0) / 2**30, 2)}


def free_port():
    with socket.socket() as so:
        so.bind(('127.0.0.1', 0))
        return so.getsockname()[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default='http://127.0.0.1:8790')
    ap.add_argument('--model', default=None)
    ap.add_argument('--tiny', action='store_true', help='start a server on the tiny random model and check that')
    ap.add_argument('--quick', action='store_true', help='skip the slower checks')
    ap.add_argument('--out', default='', help='write the results to this JSON file')
    a = ap.parse_args()
    proc = None
    if a.tiny:
        port = free_port()
        a.url, a.model = f'http://127.0.0.1:{port}', 'tiny-qwen3.5'
        proc = subprocess.Popen([sys.executable, str(HERE / 'serve.py'), '--models', 'tiny-qwen3.5', '--port', str(port), '--idle', '600'])
        for _ in range(120):
            try:
                urllib.request.urlopen(a.url + '/v1/info', timeout=2).read()
                break
            except (urllib.error.URLError, ConnectionError, OSError):
                time.sleep(0.5)
    rep = Report()
    t0 = time.time()
    try:
        res = run(Server(a.url, a.model), rep, a.quick)
    finally:
        if proc is not None:
            proc.terminate()
            proc.wait(10)
    total = round(time.time() - t0, 1)
    n = len(rep.rows)
    print(f'\n{n - rep.failed} of {n} checks passed in {total} s.', flush=True)
    print('seconds per request:', ', '.join(f'{k} {v}' for k, v in rep.times.items()), flush=True)
    if a.out:
        Path(a.out).write_text(json.dumps({**res, 'checks': rep.rows, 'seconds': rep.times, 'total': total,
                                           'when': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}, indent=1))
    sys.exit(1 if rep.failed else 0)


if __name__ == '__main__':
    main()
