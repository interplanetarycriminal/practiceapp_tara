"""GPT-2 small for the TARA lab's precompute, in PyTorch.

It loads the lab's own int8 shards (lab/model) and dequantises them exactly as the browser does, so every number
computed here is a number the lab itself would compute on a phone. Hook names follow TransformerLens:
resid_pre, attn_pattern, attn_z, attn_out, resid_mid, mlp_pre, mlp_post (the neurons), mlp_out, resid_post.

Also holds the tokenizer: GPT-2's byte-pair encoding written from OpenAI's published algorithm, reading
lab/model/bpe.json, the same file and the same algorithm as lab/core/bpe.js. Needs the `regex` package.
"""
import json
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

L, H, D, DH, M, V = 12, 12, 768, 64, 3072, 50257
BOS = 50256  # <|endoftext|>, which TransformerLens puts in front of every prompt by default


# ---------------------------------------------------------------- tokenizer

def _bytes_to_unicode():
    bs = list(range(33, 127)) + list(range(161, 173)) + list(range(174, 256))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return dict(zip(bs, map(chr, cs)))


class BPE:
    def __init__(self, path):
        import regex
        data = json.loads(Path(path).read_text(encoding='utf-8'))
        self.vocab = data['vocab']
        self.enc = {t: i for i, t in enumerate(self.vocab)}
        self.ranks = {tuple(m.split(' ')): i for i, m in enumerate(data['merges'])}
        self.b2u = _bytes_to_unicode()
        self.u2b = {v: k for k, v in self.b2u.items()}
        self.pat = regex.compile(r"""'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+""")
        self.cache = {}

    def _bpe(self, token):
        hit = self.cache.get(token)
        if hit is not None:
            return hit
        word = list(token)
        while len(word) > 1:
            best, best_rank = -1, None
            for i in range(len(word) - 1):
                r = self.ranks.get((word[i], word[i + 1]))
                if r is not None and (best_rank is None or r < best_rank):
                    best, best_rank = i, r
            if best < 0:
                break
            a, b = word[best], word[best + 1]
            out, i = [], 0
            while i < len(word):
                if i < len(word) - 1 and word[i] == a and word[i + 1] == b:
                    out.append(a + b)
                    i += 2
                else:
                    out.append(word[i])
                    i += 1
            word = out
        if len(self.cache) > 200000:
            self.cache.clear()
        self.cache[token] = word
        return word

    def encode(self, text):
        ids = []
        for m in self.pat.findall(text):
            u = ''.join(self.b2u[b] for b in m.encode('utf-8'))
            ids.extend(self.enc[p] for p in self._bpe(u))
        return ids

    def decode(self, ids):
        bs = bytearray()
        for i in ids:
            bs.extend(self.u2b[c] for c in self.vocab[i])
        return bs.decode('utf-8', errors='replace')


# ---------------------------------------------------------------- weights

def load_weights(model_dir, device):
    """Dequantised weights as torch tensors. Matrices are [out, in], as stored."""
    model_dir = Path(model_dir)
    man = json.loads((model_dir / 'manifest.json').read_text())
    bufs = [np.fromfile(model_dir / f['name'], dtype=np.uint8) for f in man['files']]

    def get(name):
        t = man['tensors'][name]
        dt = {'i8': np.int8, 'f32': np.float32, 'u16': np.uint16, 'f16': np.float16}[t['dtype']]
        n = int(np.prod(t['shape']))
        return np.frombuffer(bufs[t['file']], dtype=dt, count=n, offset=t['offset']).reshape(t['shape'])

    def deq(prefix):
        q = get(prefix + '.q').astype(np.float32)
        s = get(prefix + '.s').astype(np.float32)
        O, K = q.shape
        return (q.reshape(O, K // 64, 64) * s[:, :, None]).reshape(O, K)

    W = {}
    for l in range(L):
        for nm, short in (('ln_1', 'ln1'), ('ln_2', 'ln2')):
            W[f'{l}.{short}g'] = get(f'{l}.{nm}.g')
            W[f'{l}.{short}b'] = get(f'{l}.{nm}.b')
        for k in ('qkv', 'o', 'fc', 'proj'):
            W[f'{l}.{k}'] = deq(f'{l}.{k}')
            W[f'{l}.{k}.b'] = get(f'{l}.{k}.b')
    q = np.concatenate([get('wte.q0'), get('wte.q1')]).astype(np.float32)   # [V, 704]
    s = get('wte.s').astype(np.float32)                                       # [V, 11]
    rest = get('wte.rest_idx').astype(np.int64)
    keep = get('wte.keep_idx').astype(np.int64)
    wte = np.zeros((V, D), np.float32)
    wte[:, rest] = (q.reshape(V, -1, 64) * s[:, :, None]).reshape(V, -1)
    wte[:, keep] = get('wte.keep').astype(np.float32)
    W['wte'] = wte
    W['wpe'] = get('wpe').astype(np.float32)
    W['lnfg'] = get('ln_f.g')
    W['lnfb'] = get('ln_f.b')
    return {k: torch.from_numpy(np.ascontiguousarray(v, dtype=np.float32)).to(device) for k, v in W.items()}


# ---------------------------------------------------------------- model

class LabGPT2:
    def __init__(self, model_dir, device='cuda'):
        torch.backends.cuda.matmul.allow_tf32 = False   # full fp32, so the numbers match the browser's
        torch.backends.cudnn.allow_tf32 = False
        self.device = device
        self.W = load_weights(model_dir, device)
        # neuron n of layer l writes W[f'{l}.proj'][:, n] into the residual stream
        self.wout_norm = [self.W[f'{l}.proj'].norm(dim=0) for l in range(L)]

    def wout_unit(self, l):
        """[M, D]: every neuron's write direction, unit length."""
        P = self.W[f'{l}.proj']
        return (P / P.norm(dim=0, keepdim=True)).T.contiguous()

    @staticmethod
    def _hook(hook, name, l, t):
        if hook is None:
            return t
        r = hook(name, l, t)
        return t if r is None else r

    def block(self, l, x, hook=None, cache=None, pos0=0):
        """One transformer block. x: [B, T, D]. With cache (dict with 'k', 'v' lists of [B, H, Tmax, DH]) the new
        keys and values are written at positions pos0.. and attention covers everything up to each position."""
        W = self.W
        B, T, _ = x.shape
        x = self._hook(hook, 'resid_pre', l, x)
        h = F.layer_norm(x, (D,), W[f'{l}.ln1g'], W[f'{l}.ln1b'], 1e-5)
        qkv = h @ W[f'{l}.qkv'].T + W[f'{l}.qkv.b']
        q, k, v = qkv.split(D, -1)
        q = q.view(B, T, H, DH).transpose(1, 2)
        k = k.view(B, T, H, DH).transpose(1, 2)
        v = v.view(B, T, H, DH).transpose(1, 2)
        if cache is not None:
            cache['k'][l][:, :, pos0:pos0 + T] = k
            cache['v'][l][:, :, pos0:pos0 + T] = v
            k = cache['k'][l][:, :, :pos0 + T]
            v = cache['v'][l][:, :, :pos0 + T]
        Tk = k.shape[2]
        att = (q @ k.transpose(-1, -2)) * 0.125
        qpos = torch.arange(pos0, pos0 + T, device=x.device)[:, None]
        kpos = torch.arange(Tk, device=x.device)[None, :]
        att = att.masked_fill(kpos > qpos, float('-inf')).softmax(-1)
        att = self._hook(hook, 'attn_pattern', l, att)
        z = (att @ v).transpose(1, 2).reshape(B, T, D)
        z = self._hook(hook, 'attn_z', l, z)
        ao = z @ W[f'{l}.o'].T + W[f'{l}.o.b']
        ao = self._hook(hook, 'attn_out', l, ao)
        x = x + ao
        x = self._hook(hook, 'resid_mid', l, x)
        h2 = F.layer_norm(x, (D,), W[f'{l}.ln2g'], W[f'{l}.ln2b'], 1e-5)
        pre = h2 @ W[f'{l}.fc'].T + W[f'{l}.fc.b']
        pre = self._hook(hook, 'mlp_pre', l, pre)
        post = F.gelu(pre, approximate='tanh')
        post = self._hook(hook, 'mlp_post', l, post)
        mo = post @ W[f'{l}.proj'].T + W[f'{l}.proj.b']
        mo = self._hook(hook, 'mlp_out', l, mo)
        x = x + mo
        x = self._hook(hook, 'resid_post', l, x)
        return x

    def embed(self, ids, pos0=0):
        T = ids.shape[1]
        return self.W['wte'][ids] + self.W['wpe'][pos0:pos0 + T][None]

    def unembed(self, x):
        xf = F.layer_norm(x, (D,), self.W['lnfg'], self.W['lnfb'], 1e-5)
        return xf @ self.W['wte'].T

    def forward(self, ids, hook=None, logits='last', start=0, x=None, stop=L, cache=None, pos0=0):
        """ids: LongTensor [B, T]. Runs blocks start..stop-1 (from the embedding, or from x when given).
        logits: 'last' -> [B, V], 'all' -> [B, T, V], 'none' -> returns the residual stream instead."""
        if x is None:
            x = self.embed(ids, pos0)
        for l in range(start, stop):
            x = self.block(l, x, hook, cache, pos0)
        if logits == 'none' or stop < L:
            return x
        if logits == 'last':
            return self.unembed(x[:, -1])
        return self.unembed(x)

    def new_cache(self, B, Tmax):
        z = lambda: torch.zeros(B, H, Tmax, DH, device=self.device)
        return {'k': [z() for _ in range(L)], 'v': [z() for _ in range(L)]}


def selftest(model, tok, ref_path):
    """Compare against reference numbers computed by the lab's own engine. Raises if anything is off."""
    ref = json.loads(Path(ref_path).read_text())
    worst = 0.0
    for case in ref['cases']:
        ids = torch.tensor([case['ids']], device=model.device)
        assert tok.encode(case['text']) == case['ids'][1:], 'tokenizer mismatch on ' + repr(case['text'])
        got = {}

        def hook(name, l, t):
            if name == 'mlp_post' and l == case['neuron'][0]:
                got['act'] = t[0, :, case['neuron'][1]].double().cpu().numpy()
        lg = model.forward(ids, hook=hook)[0].double().cpu().numpy()
        top = np.argsort(-lg)[:5].tolist()
        assert top == case['top5'], f'top-5 differs: {top} vs {case["top5"]}'
        worst = max(worst, float(np.abs(lg[top] - np.array(case['top5_logits'])).max()))
        worst = max(worst, float(np.abs(got['act'] - np.array(case['acts'])).max()))
    assert worst < 2e-3, f'largest difference {worst}'
    return worst
