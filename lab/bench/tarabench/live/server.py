"""The live lab's web server. It runs the lab's tools on a model held on this computer's graphics card, one request at
a time under the studio's GPU lock, and answers only the lab's own pages (the published site and local copies).

It is two processes. This one answers the web and never touches the graphics card: it tokenises, queues requests and
says what is loaded. The model lives in a second process, the card process, started by the first request that needs
it. After --idle seconds without requests the card process exits, which hands the whole card back: a process that has
used CUDA keeps a few hundred MB of the card until it ends, however much it frees.

    GET  /v1/info            the models on offer and their shapes, which is loaded, the card's free memory
    POST /v1/call            {op, model, args, channel}: load, release, tokenize, decode, pieces, vocab, find,
                             recipe, generate, saeLoad, saeCached, saeLayers. The answer streams back as frames
                             (u32 length, then a wire.py message): {job}, {stage} and {progress} ..., then
                             {ok, result} or {ok: false, error}
    POST /v1/cancel          {id} or {channel}: stop a request (a newer request on a channel stops the older one too)

Tokenising needs no GPU, so it is answered at once even while a model loads or another job holds the card."""
import contextlib
import glob
import importlib.util
import itertools
import json
import multiprocessing as mp
import os
import queue
import struct
import subprocess
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from .wire import pack, unpack

VERSION = 1

# The models the lab can pick. precision: how it is held on the 24 GB card beside ComfyUI. sae: the Qwen-Scope
# dictionaries that read it (trained on the Base model; the post-trained model borrows them). gb: memory on the card.
# load_s: seconds to load from the 4-bit copy (or the only copy); first_s: the first load, from the original weights.
LIVE = {
    'qwen3.5-9b': dict(label='Qwen 3.5 9B', precision='nf4', sae='qwen3.5-9b', gb=7.1, load_s=90, first_s=240,
                       note='Qwen 3.5 9B, post-trained, held in 4-bit on the 3090'),
    'qwen3.5-2b': dict(label='Qwen 3.5 2B', precision='bf16', sae='qwen3.5-2b', gb=4.6, load_s=30,
                       note='Qwen 3.5 2B, post-trained, in bf16: quicker'),
    'tiny-qwen3.5': dict(label='Tiny random Qwen 3.5 (test)', precision='fp32', sae='tiny', gb=0.01, load_s=2,
                         note="four layers of random weights in Qwen 3.5's shape, for testing the plumbing"),
}
DEFAULT = ('qwen3.5-9b',)        # the user's choice on 27 October 2026: Qwen 3.5 9B only

ORIGINS = ('https://interplanetarycriminal.github.io',)
LOCAL_HOSTS = ('localhost', '127.0.0.1', '[::1]')
MAX_BODY = 64 << 20
TEXT_OPS = ('tokenize', 'decode', 'pieces', 'vocab', 'find', 'saeCached', 'saeLayers')
GONE = ('The graphics card process stopped in the middle of this request (its log says why). Run it again: '
        'a fresh process starts by itself.')


def say(*parts):
    print(time.strftime('%H:%M:%S'), *parts, flush=True)


def lock_factory(path, label, timeout):
    """The studio's GPU lock (a .py file defining hold()), or no lock. hold() is entered and left in one thread."""
    if not path:
        return lambda: contextlib.nullcontext()
    spec = importlib.util.spec_from_file_location('gpulock_live', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    def hold():
        for kw in ({'label': label, 'timeout': timeout}, {'label': label}, {}):
            try:
                return mod.hold(**kw)
            except TypeError:
                continue
        return mod.hold()
    return hold


def shape_of(cfg, words=None):
    """A model's shape from its config alone (as LiveModel.describe() reports it once loaded), so the page can size
    its tools before the weights are anywhere near the card."""
    tc = cfg.get_text_config() if hasattr(cfg, 'get_text_config') else cfg
    n = int(tc.num_hidden_layers)
    types = list(getattr(tc, 'layer_types', None) or ['full_attention'] * n)
    kinds, heads, dh = [], [], []
    for t in types:
        if t == 'linear_attention':
            kinds.append('linear')
            heads.append(int(tc.linear_num_value_heads))
            dh.append(int(tc.linear_value_head_dim))
        else:
            kinds.append('attention')
            heads.append(int(tc.num_attention_heads))
            dh.append(int(getattr(tc, 'head_dim', None) or tc.hidden_size // tc.num_attention_heads))
    out = {'L': n, 'H': max(heads), 'D': int(tc.hidden_size), 'M': int(tc.intermediate_size), 'V': int(tc.vocab_size),
           'heads': heads, 'dh': dh, 'kinds': kinds, 'attnLayers': [i for i, k in enumerate(kinds) if k == 'attention'],
           'act': 'swiglu', 'norm': 'rms'}
    if words is not None:
        out['bos'] = words.bos
    return out


_GPU = {'t': 0.0, 'v': None}


def gpu_info():
    """The card's name and free memory, from nvidia-smi: asking CUDA would tie a few hundred MB to this process."""
    if time.time() - _GPU['t'] < 3:
        return _GPU['v']
    v = None
    try:
        out = subprocess.run(['nvidia-smi', '--query-gpu=name,memory.free,memory.total', '--format=csv,noheader,nounits'],
                             capture_output=True, text=True, timeout=4, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if out.returncode == 0 and out.stdout.strip():
            name, free, total = [s.strip() for s in out.stdout.strip().splitlines()[0].split(',')]
            v = {'name': name, 'free': int(float(free)) << 20, 'total': int(float(total)) << 20}
    except (OSError, ValueError, subprocess.SubprocessError):
        v = None
    _GPU.update(t=time.time(), v=v)
    return v


# ================================================================================================ the card process

class Job:
    """A request as the card process sees it."""

    def __init__(self, jid, op, args, model, send):
        self.id, self.op, self.args, self.model, self.send = jid, op, args or {}, model, send
        self.cancelled = False

    def progress(self, x):
        self.send(('frame', self.id, pack({'progress': x})))

    def stage(self, x):
        """Where the request is (waiting for the card, loading the model), kept apart from the recipe's progress."""
        self.send(('frame', self.id, pack({'stage': x})))

    def check(self):
        if self.cancelled:
            from .model import Cancelled
            raise Cancelled('cancelled')


class Card:
    """Holds at most one model on the graphics card and runs the web process's requests on it, one at a time."""

    def __init__(self, conn, offer, lock=None, lock_timeout=180, stats_dir=None, nf4_cache=None, device=None, local=None):
        import torch
        from .. import models
        models.LOCAL.update(local or {})
        self.conn, self.offer = conn, offer
        self.hold = lock_factory(lock, 'tara-lab live', lock_timeout)
        self.lock_timeout = lock_timeout
        self.stats_dir = Path(stats_dir) if stats_dir else None
        self.nf4_cache = Path(nf4_cache) if nf4_cache else None
        self.device = device or ('cuda' if torch.cuda.is_available() else 'cpu')
        self.m = self.mid = self.cfg = self.sae_key = self.sae_meta = None
        self.q, self.jobs, self.save_after = queue.Queue(), {}, None
        self.send_lock = threading.Lock()

    def send(self, msg):
        with self.send_lock:
            self.conn.send(msg)

    def say(self, *parts):
        self.send(('log', ' '.join(str(p) for p in parts)))

    def listen(self):
        """The web process's messages: requests to run, cancels, and quit."""
        while True:
            try:
                msg = self.conn.recv()
            except (EOFError, OSError):
                break
            if msg[0] == 'job':
                _, jid, op, args, model = msg
                job = Job(jid, op, args, model, self.send)
                self.jobs[jid] = job
                self.q.put(job)
            elif msg[0] == 'cancel':
                job = self.jobs.get(msg[1])
                if job is not None:
                    job.cancelled = True
            elif msg[0] == 'quit':
                break
        self.q.put(None)

    def serve(self):
        import torch
        from .model import Cancelled
        threading.Thread(target=self.listen, name='listen', daemon=True).start()
        self.send(('state', {'pid': os.getpid(), 'device': self.device}))
        while True:
            try:
                job = self.q.get(timeout=5)
            except queue.Empty:
                if self.save_after and self.m is not None and time.time() > self.save_after:
                    self.save_after = None
                    self.save_nf4()
                continue
            if job is None:
                break
            try:
                frame = pack({'ok': True, 'result': self.run(job)})
            except Cancelled:
                frame = pack({'ok': False, 'error': 'cancelled'})
            except torch.cuda.OutOfMemoryError:
                torch.cuda.empty_cache()
                frame = pack({'ok': False, 'error': 'The graphics card ran out of memory for this request. Try a shorter '
                                                    'text, or free memory on the card (ComfyUI holds its models there).'})
            except Exception as e:  # noqa: BLE001 - every failure goes back to the page
                self.say(f'{job.op} refused: {e}' if isinstance(e, ValueError) else traceback.format_exc())
                frame = pack({'ok': False, 'error': str(e) or e.__class__.__name__})
            self.jobs.pop(job.id, None)
            self.send(('frame', job.id, frame))
            self.send(('done', job.id))
            if self.device == 'cuda':
                self.send(('state', {'mem': torch.cuda.memory_allocated(), 'peak': torch.cuda.max_memory_allocated()}))
        if self.save_after and self.m is not None:
            self.save_nf4()                             # the copy is worth the wait: later loads take a third of the time
        self.unload()

    def gpu(self, job):
        """The studio's GPU lock for one request, telling the page when it has to wait for another job."""
        waiting = threading.Timer(0.6, lambda: job.stage({'stage': 'waiting', 'note': 'Waiting for the graphics card: another job is using it.'}))
        waiting.start()
        ctx = self.hold()
        try:
            ctx.__enter__()
        except Exception as e:  # noqa: BLE001 - a timeout, whatever the lock calls it
            raise RuntimeError(f'The graphics card stayed busy with another job for {self.lock_timeout:.0f} s; try again '
                               f'when it is free ({e.__class__.__name__}).') from None
        finally:
            waiting.cancel()
        job.stage({'stage': 'running'})
        return ctx

    def run(self, job):
        import torch
        from . import recipes as R
        op, a = job.op, job.args
        ctx = self.gpu(job)
        try:
            self.ensure(job.model, job)
            if op == 'load':
                return self.cfg
            if op == 'recipe':
                fn = R.RECIPES.get(a.get('name'))
                if fn is None:
                    raise ValueError(f'unknown recipe {a.get("name")!r}')
                with torch.no_grad():
                    return fn(self.m, a.get('args') or {}, job)
            if op == 'generate':
                with torch.no_grad():
                    return R.generate(self.m, a, job)
            if op == 'saeLoad':
                return self.sae_load(job, int(a.get('layer', 0)))
            raise ValueError(f'unknown request {op!r}')
        finally:
            ctx.__exit__(None, None, None)

    # ---- models ------------------------------------------------------------------------------------------------
    def cached_copy(self, mid):
        folder = self.nf4_cache / mid if self.nf4_cache else None
        return folder if folder and (folder / 'config.json').exists() else None

    def ensure(self, mid, job):
        import torch
        from .model import LiveModel
        if self.m is not None and self.mid == mid:
            return
        if self.m is not None:
            self.unload()
        spec = self.offer[mid]
        expect = spec['load_s'] if spec['precision'] != 'nf4' or self.cached_copy(mid) else spec.get('first_s', spec['load_s'])
        self.send(('state', {'loading': mid, 'expect': expect}))
        t0 = time.time()
        stop = threading.Event()

        def tick():
            while not stop.wait(1.0):
                job.stage({'stage': 'loading', 'model': mid, 'elapsed': round(time.time() - t0), 'expect': expect})
        threading.Thread(target=tick, daemon=True).start()
        try:
            if self.device == 'cuda':
                free = torch.cuda.mem_get_info()[0] / 2 ** 30
                need = spec['gb'] + 1.2
                if free < need:
                    raise RuntimeError(f'The 3090 has {free:.1f} GB free and {spec["label"]} needs about {need:.0f} GB. '
                                       f'Unload a model in ComfyUI, or pick a smaller model.')
            lm = self.load_lm(mid, spec)
            job.stage({'stage': 'measuring', 'model': mid, 'elapsed': round(time.time() - t0), 'expect': expect})
            m = LiveModel(lm, self.stats_dir)
            m.stats()
            self.m, self.mid, self.cfg = m, mid, {**m.describe(), 'label': spec['label'], 'loadS': round(time.time() - t0)}
            self.say(f'loaded {mid} in {time.time() - t0:.0f} s')
        finally:
            stop.set()
            self.send(('state', {'loading': None, 'loaded': self.mid, 'cfg': self.cfg}))

    def load_lm(self, mid, spec):
        from .. import models
        if mid.startswith('tiny'):
            return models.load(mid)
        cached = self.cached_copy(mid) if spec['precision'] == 'nf4' else None
        if cached:
            try:
                return self.load_cached(mid, cached)
            except Exception as e:  # noqa: BLE001 - a broken copy falls back to the original weights
                self.say(f'the 4-bit copy of {mid} did not load ({e}); reading the original weights')
        lm = models.load(mid, precision=spec['precision'], device=self.device)
        if spec['precision'] == 'nf4' and self.nf4_cache:
            self.save_after = time.time() + 20          # write the 4-bit copy once the page has had its first answers
        return lm

    def load_cached(self, mid, folder):
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        from ..models import LM, resolve
        info = json.loads((folder / 'tara-live.json').read_text())
        tok = AutoTokenizer.from_pretrained(folder)
        model = AutoModelForCausalLM.from_pretrained(folder, device_map={'': self.device}, dtype=torch.bfloat16)
        model.eval()
        model.requires_grad_(False)
        entry = {**resolve(mid), 'files': str(folder)}
        return LM(model, tok, entry, 'nf4', info.get('revision'), f'4-bit copy in {folder}')

    def save_nf4(self):
        """A 4-bit copy of the loaded model, which loads in a third of the time of the 19 GB original."""
        folder = self.nf4_cache / self.mid
        try:
            tmp = folder.with_name(folder.name + '.part')
            self.say(f'writing a 4-bit copy of {self.mid} to {folder}')
            self.m.model.save_pretrained(tmp)
            self.m.tok.save_pretrained(tmp)
            (tmp / 'tara-live.json').write_text(json.dumps({'id': self.mid, 'revision': self.m.lm.revision,
                                                            'made': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}))
            if folder.exists():
                import shutil
                shutil.rmtree(folder)
            tmp.rename(folder)
            self.say('4-bit copy written')
        except Exception as e:  # noqa: BLE001
            self.say(f'could not write the 4-bit copy: {e}')

    def unload(self):
        if self.m is None:
            return
        self.say(f'letting go of {self.mid}')
        self.m.sae = None
        self.m.unload()
        self.m, self.mid, self.cfg, self.sae_key = None, None, None, None
        self.send(('state', {'loaded': None, 'cfg': None}))

    # ---- dictionaries ------------------------------------------------------------------------------------------
    def sae_load(self, job, layer):
        import torch
        from ..sae import TopKSAE
        m = self.m
        if not 0 <= layer < m.L:
            raise ValueError(f'{self.mid} has layers 0 to {m.L - 1}')
        if self.mid.startswith('tiny'):
            import tempfile
            from ..tiny import write_dictionaries
            repo = write_dictionaries(Path(tempfile.gettempdir()) / 'tara-live-tiny-sae', d_model=m.D, layers=range(m.L))
        else:
            repo = sae_repo(self.offer, self.mid)
            if not repo:
                raise ValueError(f'No dictionary is published for {self.offer[self.mid]["label"]}.')
        key = (str(repo), layer)
        if self.sae_key == key and getattr(m, 'sae', None) is not None:
            return self.sae_meta
        m.sae = None
        if self.device == 'cuda':
            torch.cuda.empty_cache()
        cached = self.mid.startswith('tiny') or sae_cached(self.offer, self.mid, layer)
        if not cached:
            job.stage({'stage': 'downloading', 'note': f'Downloading the layer {layer} dictionary from Hugging Face '
                                                         f'(about 2 GB for the 9B), once'})
        S = TopKSAE.load(repo, layer, device='cpu', dtype=torch.float32)
        S.to(m.device, torch.bfloat16 if m.device.type == 'cuda' else torch.float32)
        S.layer, S.dec_norm = layer, None
        m.sae, self.sae_key = S, key
        self.sae_meta = {'layer': layer, 'F': S.F, 'k': S.k, 'hook': 'resid_post', 'repo': str(S.meta.get('repo')),
                         'cached': cached, 'bytes': S.nbytes(), 'kind': 'topk', 'centred': False,
                         'borrowed': not self.mid.startswith('tiny')}
        return self.sae_meta


def card_main(conn, opts):
    """The card process's entry point (started by Live with the spawn method, so it shares nothing by accident)."""
    log = opts.pop('log', None)
    if log:
        try:
            f = open(Path(log).with_suffix('.card.log'), 'a', buffering=1, encoding='utf-8')
            sys.stdout = sys.stderr = f
        except OSError:
            pass
    Card(conn, **opts).serve()


def sae_repo(offer, mid):
    from ..sae import qwen_scope_repo
    fam = offer[mid]['sae']
    return qwen_scope_repo(fam) if fam and fam != 'tiny' else None


def sae_cached(offer, mid, layer):
    if mid.startswith('tiny'):
        return True
    repo = sae_repo(offer, mid)
    if not repo:
        return False
    try:
        from huggingface_hub import try_to_load_from_cache
        p = try_to_load_from_cache(repo, f'layer{layer}.sae.pt')
        return isinstance(p, str) and os.path.exists(p)
    except Exception:  # noqa: BLE001
        return False


# ================================================================================================ the web process

class Request:
    ids = itertools.count(1)

    def __init__(self, op, args, model, channel=None, internal=False):
        self.id, self.op, self.args, self.model, self.channel = next(Request.ids), op, args or {}, model, channel
        self.internal, self.cancelled, self.t0 = internal, False, time.time()
        self.frames = queue.Queue()     # ('msg', dict) | ('raw', packed bytes from the card) | ('end', None)

    def put(self, msg):
        self.frames.put(('msg', msg))

    def end(self, ok, x):
        self.put({'ok': True, 'result': x} if ok else {'ok': False, 'error': x})
        self.frames.put(('end', None))


class Live:
    def __init__(self, models=None, lock=None, lock_timeout=180, idle=1200, stats_dir=None, nf4_cache=None,
                 device=None, local=None, log=None):
        self.offer = {k: v for k, v in LIVE.items() if k in (models or DEFAULT)}
        self.opts = dict(offer=self.offer, lock=lock, lock_timeout=lock_timeout, device=device, local=dict(local or {}),
                         stats_dir=str(stats_dir) if stats_dir else None, nf4_cache=str(nf4_cache) if nf4_cache else None,
                         log=log)
        self.locked = bool(lock)
        self.idle, self.stats_dir = idle, Path(stats_dir) if stats_dir else None
        self.q, self.jobs, self.channels, self.waits = queue.Queue(), {}, {}, {}
        self.proc = self.conn = None
        self.running, self.last = None, time.time()
        self.state = {'loaded': None, 'loading': None, 'cfg': None, 'pid': None}
        self.words, self.words_lock, self.shapes = {}, threading.Lock(), {}
        self.tell_lock = threading.Lock()
        threading.Thread(target=self.dispatch, name='dispatch', daemon=True).start()
        threading.Thread(target=self.reaper, name='idle', daemon=True).start()

    # ---- what the page sees ------------------------------------------------------------------------------------
    def info(self):
        return {'server': 'tara-live', 'version': VERSION,
                'models': [{'id': k, 'label': v['label'], 'note': v['note'], 'gb': v['gb'], 'loadS': v['load_s'],
                            'precision': v['precision'], 'sae': bool(v['sae']), 'cfg': self.shape(k)}
                           for k, v in self.offer.items()],
                'loaded': self.state['loaded'], 'loading': self.state['loading'], 'cfg': self.state['cfg'],
                'card': self.proc is not None and self.proc.is_alive(), 'busy': self.running is not None,
                'queued': self.q.qsize(), 'idleS': self.idle, 'idleFor': round(time.time() - self.last),
                'lock': self.locked, 'gpu': gpu_info(), 'mem': self.state.get('mem'), 'peak': self.state.get('peak')}

    def shape(self, mid):
        """The model's shape before it loads (None when its config is not on this computer), with the dose unit once
        a load has measured it."""
        if mid not in self.shapes:
            try:
                if mid.startswith('tiny'):
                    from ..models import load
                    s = shape_of(load(mid).model.config, self.words_for(mid))
                else:
                    from transformers import AutoConfig
                    s = shape_of(AutoConfig.from_pretrained(self.source(mid)), self.words_for(mid))
            except Exception as e:  # noqa: BLE001
                say(f'no shape for {mid} yet: {e}')
                return None
            self.shapes[mid] = {'id': mid, 'label': self.offer[mid]['label'], 'precision': self.offer[mid]['precision'], **s}
        s = self.shapes[mid]
        if 'residNorm' not in s and self.stats_dir:
            for f in sorted(glob.glob(str(self.stats_dir / f'{mid}-{s["precision"]}-*.json')), key=os.path.getmtime, reverse=True):
                try:
                    r = json.loads(Path(f).read_text())['residNorm']
                    if len(r) == s['L']:
                        s['residNorm'] = r
                        break
                except (OSError, ValueError, KeyError):
                    continue
        if self.state['cfg'] and self.state['loaded'] == mid:
            s['residNorm'] = self.state['cfg']['residNorm']
        return s

    def source(self, mid):
        from ..models import LOCAL, resolve
        LOCAL.update(self.opts['local'])
        e = resolve(mid)
        return LOCAL.get(e['id'], e['hf'])

    # ---- requests ----------------------------------------------------------------------------------------------
    def submit(self, op, args, model, channel=None):
        if model not in self.offer:
            raise ValueError(f'this server does not offer {model!r}')
        if channel:
            old = self.channels.get(channel)
            if old is not None:
                self.cancel_req(old)
        req = Request(op, args, model, channel)
        self.jobs[req.id] = req
        if channel:
            self.channels[channel] = req
        if op in TEXT_OPS:
            threading.Thread(target=self.run_text, args=(req,), daemon=True).start()
        else:
            self.q.put(req)
        return req

    def cancel(self, job_id=None, channel=None):
        req = self.jobs.get(job_id) if job_id is not None else self.channels.get(channel)
        if req is not None:
            self.cancel_req(req)
        return req is not None

    def cancel_req(self, req):
        req.cancelled = True
        if self.running is req:
            self.tell(('cancel', req.id))

    def forget(self, req):
        self.jobs.pop(req.id, None)
        if req.channel and self.channels.get(req.channel) is req:
            self.channels.pop(req.channel, None)

    # ---- text, without the GPU ---------------------------------------------------------------------------------
    def words_for(self, mid):
        from .model import Words
        with self.words_lock:
            if mid not in self.words:
                if mid.startswith('tiny'):
                    from ..tiny import tokenizer
                    self.words[mid] = Words(tokenizer())
                else:
                    from transformers import AutoTokenizer
                    self.words[mid] = Words(AutoTokenizer.from_pretrained(self.source(mid)))
            return self.words[mid]

    def run_text(self, req):
        try:
            a, op = req.args, req.op
            if op == 'saeCached':
                req.end(True, {'cached': sae_cached(self.offer, req.model, int(a.get('layer', 0)))})
                return
            if op == 'saeLayers':
                s = self.shape(req.model)
                L = s['L'] if s else 0
                req.end(True, {'layers': L, 'cached': [l for l in range(L) if sae_cached(self.offer, req.model, l)],
                               'repo': sae_repo(self.offer, req.model)})
                return
            w = self.words_for(req.model)
            if op == 'tokenize':
                ids = w.encode(a.get('text') or '', a.get('bos', True) is not False)
                out = {'ids': ids, 'pieces': w.pieces(ids)}
            elif op == 'decode':
                out = {'text': w.tok.decode([int(i) for i in a['ids']])}
            elif op == 'pieces':
                out = {'pieces': w.pieces([int(i) for i in a['ids']])}
            elif op == 'vocab':
                out = {'vocab': [w.piece(i) for i in a['ids']]}
            else:
                out = {'ids': w.find(a.get('query'), int(a.get('k', 20)))}
            req.end(True, out)
        except Exception as e:  # noqa: BLE001 - every failure goes back to the page
            req.end(False, str(e))

    # ---- the card process --------------------------------------------------------------------------------------
    def tell(self, msg):
        with self.tell_lock:
            if self.conn is not None:
                try:
                    self.conn.send(msg)
                except (OSError, ValueError):
                    pass

    def dispatch(self):
        """Hands requests to the card process one at a time, starting it when there is none."""
        while True:
            req = self.q.get()
            if req.cancelled:
                req.end(False, 'cancelled')
                continue
            if req.op == 'release':
                self.stop_card()
                req.end(True, {'released': True})
                continue
            self.running = req
            try:
                self.start_card(req)
                done = threading.Event()
                self.waits[req.id] = done
                self.tell(('job', req.id, req.op, req.args, req.model))
                if req.cancelled:
                    self.tell(('cancel', req.id))
                while not done.wait(2.0):
                    if self.proc is None or not self.proc.is_alive():
                        if self.waits.pop(req.id, None) is not None:
                            req.end(False, GONE)
                        break
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                req.end(False, f'The graphics card process did not start: {e}')
            finally:
                self.waits.pop(req.id, None)
                self.running = None
                if not req.internal:
                    self.last = time.time()

    def start_card(self, req):
        if self.proc is not None and self.proc.is_alive():
            return
        req.put({'stage': {'stage': 'starting', 'note': 'Starting the graphics card process'}})
        ctx = mp.get_context('spawn')
        here, there = ctx.Pipe()
        proc = ctx.Process(target=card_main, args=(there, dict(self.opts)), name='tara-live-card', daemon=True)
        proc.start()
        there.close()
        self.proc, self.conn = proc, here
        threading.Thread(target=self.hear, args=(here, proc), name='hear', daemon=True).start()
        say(f'card process {proc.pid} started')

    def hear(self, conn, proc):
        """The card process's messages: frames for the page, request ends, its state and its log."""
        while True:
            try:
                msg = conn.recv()
            except (EOFError, OSError):
                break
            kind = msg[0]
            if kind == 'frame':
                req = self.jobs.get(msg[1])
                if req is not None:
                    req.frames.put(('raw', msg[2]))
            elif kind == 'done':
                req = self.jobs.get(msg[1])
                if req is not None:
                    req.frames.put(('end', None))
                ev = self.waits.pop(msg[1], None)
                if ev is not None:
                    ev.set()
            elif kind == 'state':
                self.state.update(msg[1])
            elif kind == 'log':
                say(msg[1].rstrip())
        proc.join(5)
        say(f'card process {proc.pid} ended (exit code {proc.exitcode})')
        if self.proc is proc:
            self.proc = self.conn = None
            self.state.update(loaded=None, loading=None, cfg=None, pid=None, mem=None, peak=None)
            for jid in list(self.waits):
                ev = self.waits.pop(jid, None)
                req = self.jobs.get(jid)
                if req is not None:
                    req.end(False, GONE)
                if ev is not None:
                    ev.set()

    def stop_card(self):
        proc = self.proc
        if proc is None:
            return
        say('letting the card go')
        self.tell(('quit',))
        proc.join(900)                                  # it may first finish writing a 4-bit copy (7 GB)
        if proc.is_alive():
            proc.terminate()
            proc.join(5)
        if self.proc is proc:
            self.proc = self.conn = None
            self.state.update(loaded=None, loading=None, cfg=None, pid=None, mem=None, peak=None)

    def reaper(self):
        while True:
            time.sleep(15)
            if self.proc is not None and self.running is None and self.q.empty() and time.time() - self.last > self.idle:
                say(f'no requests for {self.idle:.0f} s')
                self.q.put(Request('release', {}, None, internal=True))
                self.last = time.time()


# ------------------------------------------------------------------------------------------------ HTTP

def allowed_origin(origin):
    if not origin:
        return True                      # not a browser page: curl or a script on this computer
    if origin in ORIGINS:
        return True
    u = urlparse(origin)
    return u.scheme in ('http', 'https') and u.hostname in ('localhost', '127.0.0.1', '::1')


class Handler(BaseHTTPRequestHandler):
    live = None
    server_version = 'tara-live/1'
    hosts = LOCAL_HOSTS

    def log_message(self, fmt, *args):
        pass

    def guard(self):
        """Only the lab's pages, and only addressed to this computer (a page that rebinds its own name to
        127.0.0.1 still sends its own Host and Origin)."""
        host = (self.headers.get('Host') or '').rsplit(':', 1)[0]
        if host not in self.hosts:
            self.send_error(403, 'unknown host')
            return False
        if not allowed_origin(self.headers.get('Origin')):
            self.send_error(403, 'this server answers only the TARA lab')
            return False
        return True

    def cors(self):
        o = self.headers.get('Origin')
        if o and allowed_origin(o):
            self.send_header('Access-Control-Allow-Origin', o)
            self.send_header('Vary', 'Origin')

    def do_OPTIONS(self):
        if not self.guard():
            return
        self.send_response(204)
        self.cors()
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Max-Age', '600')
        if self.headers.get('Access-Control-Request-Private-Network'):
            self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.end_headers()

    def reply_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass                         # the page stopped waiting

    def do_GET(self):
        if not self.guard():
            return
        if self.path.split('?')[0] in ('/v1/info', '/v1/health'):
            self.reply_json(self.live.info())
        else:
            self.send_error(404)

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > MAX_BODY:
            raise ValueError('request too large')
        return unpack(self.rfile.read(n)) if n else {}

    def do_POST(self):
        if not self.guard():
            return
        path = self.path.split('?')[0]
        try:
            req = self.body()
        except Exception as e:  # noqa: BLE001
            self.reply_json({'error': str(e)}, 400)
            return
        if path == '/v1/cancel':
            self.reply_json({'cancelled': self.live.cancel(req.get('id'), req.get('channel'))})
            return
        if path != '/v1/call':
            self.send_error(404)
            return
        try:
            job = self.live.submit(req.get('op'), req.get('args') or {}, req.get('model'), req.get('channel'))
        except Exception as e:  # noqa: BLE001
            self.reply_json({'error': str(e)}, 400)
            return
        self.send_response(200)
        self.cors()
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Job', str(job.id))
        self.send_header('Access-Control-Expose-Headers', 'X-Job')
        self.end_headers()
        try:
            self.frame(pack({'job': job.id}))
            while True:
                try:
                    kind, x = job.frames.get(timeout=10)
                except queue.Empty:
                    self.frame(pack({'beat': round(time.time() - job.t0)}))     # also notices a page that has gone
                    continue
                if kind == 'end':
                    break
                self.frame(x if kind == 'raw' else pack(x))
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            self.live.cancel_req(job)
        finally:
            self.live.forget(job)

    def frame(self, b):
        self.wfile.write(struct.pack('<I', len(b)) + b)
        self.wfile.flush()


def serve(live, host='127.0.0.1', port=8787, extra_hosts=()):
    Handler.live = live
    Handler.hosts = LOCAL_HOSTS + tuple(extra_hosts)
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    say(f'TARA live lab on http://{host}:{port} offering {", ".join(live.offer)}; GPU lock '
        f'{"on" if live.locked else "off"}; the card is let go after {live.idle:.0f} s without requests')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        live.stop_card()
        srv.server_close()
