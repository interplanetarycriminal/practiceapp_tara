"""One model held on the GPU with the hook points of the browser's GPT-2 (lab/core/gpt2.js), so the lab's recipes run
on it unchanged in meaning. Per layer l, in TransformerLens' names:

    resid_pre     the residual stream entering layer l               pre-hook on the decoder layer
    attn_z        each head's output, before the output matrix        pre-hook on o_proj (attention) or out_proj (DeltaNet)
    attn_pattern  attention weights, attention layers only            the mixer's second output, under eager attention
    attn_out      what the token mixer adds to the stream             hook on self_attn or linear_attn
    resid_mid     the stream after the mixer's write                  pre-hook on post_attention_layernorm, edited in place
    mlp_post      the neurons, silu(gate) * up                        pre-hook on mlp.down_proj
    mlp_out       what the MLP adds                                   hook on mlp
    resid_post    the stream leaving layer l                          hook on the decoder layer
    resid_final   the stream entering the final norm                  pre-hook on the final norm, which then ends the pass

Qwen 3.5 is a hybrid: three layers in four mix tokens with a Gated DeltaNet instead of attention. Its value heads
(32 of 128 dimensions in the 9B) act as heads here: each keeps its own running memory and writes through its own
columns of out_proj, so a head's write, its ablation and its patching mean the same as an attention head's. Only
attention layers have a pattern to draw.

Logits never come from the model's own head: they are read off resid_final in float32 (the final norm, then the
unembedding in slices of the vocabulary), so a 4-bit model's scores carry no bf16 output rounding and only the rows a
recipe asks for are ever computed."""
import gc
import json
import math
import time
from pathlib import Path

import numpy as np
import torch

from ..hooks import StopForward, hidden

SLICE = 16384          # vocabulary rows per float32 unembedding slice
LOGIT_ROWS = 48        # stream rows per batch of full-vocabulary logits


class Cancelled(Exception):
    """The page gave up on this request (a newer one on the same channel, or a cancel)."""


def dequant(lin):
    """A Linear's weight [out, in] in its compute dtype, unpacked when bitsandbytes keeps it in 4 bits."""
    W = lin.weight
    if getattr(W, 'quant_state', None) is not None:
        import bitsandbytes.functional as bnbf
        return bnbf.dequantize_4bit(W.data, W.quant_state)
    return W.data


def norm_gain(norm, D, device):
    """An RMSNorm's per-dimension gain, read by normalising a vector of ones: covers both the w and the 1 + w
    parameterisations (Qwen 3.5 uses 1 + w). The norm divides ones by sqrt(1 + eps); that is put back."""
    eps = getattr(norm, 'eps', None) or getattr(norm, 'variance_epsilon', 1e-6)
    p = next(norm.parameters())
    ones = torch.ones(1, D, device=device, dtype=torch.float32)
    return (norm(ones).float().reshape(-1) * math.sqrt(1 + eps)).to(p.device)


class Words:
    """A model's tokenizer as the lab uses it: prompts start with <|endoftext|> (position 0, as TransformerLens and the
    browser's GPT-2 do), and tokens are shown as display strings. Needs no GPU, so the page can tokenise while the
    model loads or while another job holds the card."""

    def __init__(self, tok, V=None):
        self.tok = tok
        self.V = int(V or len(tok))
        self.bos = self._bos()
        self._pieces = None
        self._specials = None

    def _bos(self):
        tid = self.tok.convert_tokens_to_ids('<|endoftext|>')
        if isinstance(tid, int) and tid >= 0 and tid != self.tok.unk_token_id:
            return tid
        for t in (self.tok.bos_token_id, self.tok.eos_token_id, self.tok.pad_token_id):
            if t is not None:
                return int(t)
        return 0

    # ---- text --------------------------------------------------------------------------------------------------
    def encode(self, text, bos=True):
        ids = self.tok(text or '', add_special_tokens=False)['input_ids']
        return ([self.bos] if bos else []) + list(ids)

    def piece(self, i):
        return self.tok.decode([int(i)])

    def pieces(self, ids):
        """One display string per token. A token that is only part of a multi-byte character shows as the joined
        character on the token that completes it and as '' before, as lab/core/bpe.js does."""
        out, pend = [], []
        for j, i in enumerate(ids):
            pend.append(int(i))
            s = self.tok.decode(pend)
            if '\ufffd' in s and j < len(ids) - 1 and len(pend) < 4:
                out.append('')
                continue
            out.append(s)
            pend = []
        return out

    def specials(self):
        if self._specials is None:
            self._specials = set(int(i) for i in self.tok.all_special_ids)
            self._specials.update(int(i) for i in getattr(self.tok, 'added_tokens_decoder', {}) or {})
        return self._specials

    def vocab_pieces(self):
        """Every token's display string, made once (about two seconds for 248,000 tokens)."""
        if self._pieces is None:
            n = min(self.V, len(self.tok))
            self._pieces = [self.tok.decode([i]) for i in range(n)] + [''] * (self.V - n)
        return self._pieces

    def find(self, q, k=20):
        qq = str(q or '')
        if not qq:
            return []
        P = self.vocab_pieces()
        exact, starts, has = [], [], []
        ql = qq.strip().lower()
        for i, s in enumerate(P):
            if s == qq or s == ' ' + qq:
                exact.append(i)
            elif s.strip().lower() == ql:
                starts.append(i)
            elif len(has) < k and qq.lower() in s.lower():
                has.append(i)
        return (exact + starts + has)[:k]

    def regular_ids(self):
        """How many ordinary tokens come before the special ones, for random-token prompts."""
        sp = [i for i in self.specials() if i >= 1000]
        return min(sp) if sp else min(self.V, len(self.tok))

    def stop_ids(self):
        """Tokens that end a text: the end of a document or of a chat turn."""
        out = {int(t) for t in (self.tok.eos_token_id, self.bos) if t is not None}
        for s in ('<|im_end|>', '<|endoftext|>'):
            t = self.tok.convert_tokens_to_ids(s)
            if isinstance(t, int) and t >= 0 and t != self.tok.unk_token_id:
                out.add(t)
        return out


class Pieces:
    """Display strings for a stream of tokens, one at a time: a token that ends inside a multi-byte character waits
    (shown as '') until the character is complete."""

    def __init__(self, words):
        self.words, self.pend = words, []

    def push(self, t):
        self.pend.append(int(t))
        s = self.words.tok.decode(self.pend)
        if '\ufffd' in s and len(self.pend) < 4:
            return ''
        self.pend = []
        return s


class KV:
    """A cache for generation: the model's own (attention keys and values, DeltaNet states) and the positions so far."""

    def __init__(self, cfg):
        from transformers import DynamicCache
        self.kv, self.T = DynamicCache(config=cfg), 0


class LiveModel:
    def __init__(self, lm, stats_dir=None, words=None):
        self.lm, self.model, self.tok = lm, lm.model, lm.tok
        self.id, self.layers, self.final_norm = lm.id, lm.layers, lm.final_norm
        self.device, self.dtype, self.precision = lm.device, lm.dtype, lm.precision
        parent = lm.model
        for part in lm.layers_path.split('.')[:-1]:
            parent = getattr(parent, part)
        self.text_model, self.cfg = parent, parent.config
        self.L, self.D = len(self.layers), lm.d_model
        self.kind, self.mixer, self.wo, self.heads, self.dh = [], [], [], [], []
        for i, layer in enumerate(self.layers):
            if hasattr(layer, 'self_attn'):
                mx = layer.self_attn
                self.kind.append('attention')
                self.mixer.append(mx)
                self.wo.append(mx.o_proj)
                self.dh.append(int(mx.head_dim))
                self.heads.append(int(mx.o_proj.in_features) // int(mx.head_dim))
            elif hasattr(layer, 'linear_attn'):
                mx = layer.linear_attn
                self.kind.append('linear')
                self.mixer.append(mx)
                self.wo.append(mx.out_proj)
                self.dh.append(int(mx.head_v_dim))
                self.heads.append(int(mx.num_v_heads))
            else:
                raise RuntimeError(f'layer {i} has neither self_attn nor linear_attn: the live lab cannot hook this model')
            mlp = getattr(layer, 'mlp', None)
            if not (mlp is not None and all(hasattr(mlp, n) for n in ('gate_proj', 'up_proj', 'down_proj'))
                    and hasattr(layer, 'post_attention_layernorm') and not hasattr(layer, 'pre_feedforward_layernorm')):
                raise RuntimeError(f'layer {i} is not a pre-norm SwiGLU block: the live lab cannot hook this model')
        self.H = max(self.heads)
        self.M = int(self.layers[0].mlp.down_proj.in_features)
        self.W_U = lm.unembed()
        self.V = int(self.W_U.shape[0])
        self.E = self.model.get_input_embeddings().weight
        self.words = words if words is not None and words.tok is self.tok else Words(self.tok, self.V)
        self.bos = self.words.bos
        self.eps = float(getattr(self.final_norm, 'eps', None) or getattr(self.final_norm, 'variance_epsilon', 1e-6))
        self.gF = norm_gain(self.final_norm, self.D, self.device)
        self._g2 = {}
        self._attn_impl = getattr(self.model.config, '_attn_implementation', None) or 'sdpa'
        self.stats_dir = Path(stats_dir) if stats_dir else None
        self.woutNorm = self._wout_norms()
        self.residNorm = None
        self._links = None
        self._mean_unembed = None

    # ---- description -------------------------------------------------------------------------------------------
    def describe(self):
        """What the page needs to size its tools: the browser engine's CFG, per-layer heads and kinds."""
        attn = [i for i, k in enumerate(self.kind) if k == 'attention']
        return {'id': self.id, 'L': self.L, 'H': self.H, 'D': self.D, 'M': self.M, 'V': self.V, 'bos': self.bos,
                'heads': self.heads, 'dh': self.dh, 'kinds': self.kind, 'attnLayers': attn,
                'residNorm': [float(x) for x in self.stats()], 'precision': self.precision, 'act': 'swiglu',
                'norm': 'rms', 'tied': bool(self.W_U.data_ptr() == self.E.data_ptr()),
                'hf': self.lm.entry.get('hf'), 'revision': self.lm.revision}

    def encode(self, text, bos=True):
        return self.words.encode(text, bos)

    def regular_ids(self):
        return self.words.regular_ids()

    # ---- weights -----------------------------------------------------------------------------------------------
    def g2(self, l):
        """Layer l's MLP norm gain (post_attention_layernorm), float32."""
        if l not in self._g2:
            self._g2[l] = norm_gain(self.layers[l].post_attention_layernorm, self.D, self.device)
        return self._g2[l]

    def w_down(self, l):
        return dequant(self.layers[l].mlp.down_proj)          # [D, M]

    def w_gate(self, l):
        return dequant(self.layers[l].mlp.gate_proj)          # [M, D]

    def w_up(self, l):
        return dequant(self.layers[l].mlp.up_proj)            # [M, D]

    def w_out(self, l):
        return dequant(self.wo[l])                            # [D, heads * dh]

    @torch.no_grad()
    def _wout_norms(self):
        """Each neuron's write length |W_down[:, n]|, per layer: [L, M] float32."""
        out = torch.empty(self.L, self.M, device=self.device, dtype=torch.float32)
        for l in range(self.L):
            out[l] = self.w_down(l).float().norm(dim=0)
        return out

    @torch.no_grad()
    def link_norms(self):
        """Per layer, the length of what each neuron reads: (W_gate[n] * g2), for neuronLinks' cosines."""
        if self._links is None:
            self._links = torch.stack([(self.w_gate(l).float() * self.g2(l)).norm(dim=1) for l in range(self.L)])
        return self._links

    @torch.no_grad()
    def mean_unembed(self):
        if self._mean_unembed is None:
            acc = torch.zeros(self.D, device=self.device, dtype=torch.float32)
            for a in range(0, self.V, SLICE):
                acc += self.W_U[a:a + SLICE].float().sum(0)
            self._mean_unembed = acc / self.V
        return self._mean_unembed

    # ---- statistics --------------------------------------------------------------------------------------------
    def _stats_file(self):
        if not self.stats_dir:
            return None
        key = f'{self.id}-{self.precision}-{(self.lm.revision or "local")[:12]}'.replace('/', '_')
        return self.stats_dir / f'{key}.json'

    @torch.no_grad()
    def stats(self):
        """The median norm of the stream leaving each layer over neutral text (first token skipped): the unit the
        lab's doses are measured in. Computed once per model and kept on disk."""
        if self.residNorm is not None:
            return self.residNorm
        f = self._stats_file()
        if f and f.exists():
            try:
                rec = json.loads(f.read_text())
                if len(rec['residNorm']) == self.L:
                    self.residNorm = rec['residNorm']
                    return self.residNorm
            except (OSError, ValueError, KeyError):
                pass
        from ..data import NEUTRAL
        rows = [[] for _ in range(self.L)]
        for text in NEUTRAL:
            r = self.forward([self.encode(text)], capture={'resid_post': True}, logits='none')
            for l in range(self.L):
                rows[l].append(r['cap']['resid_post'][l][0, 1:].float().norm(dim=-1).cpu())
        self.residNorm = [float(torch.cat(x).median()) for x in rows]
        if f:
            try:
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_text(json.dumps({'id': self.id, 'residNorm': self.residNorm, 'made': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}))
            except OSError:
                pass
        return self.residNorm

    # ---- the forward pass --------------------------------------------------------------------------------------
    def _ids(self, ids):
        if isinstance(ids, torch.Tensor):
            t = ids
        else:
            rows = list(ids)
            if rows and not isinstance(rows[0], (list, tuple, np.ndarray)):
                rows = [rows]
            n = {len(r) for r in rows}
            if len(n) != 1:
                raise ValueError('every row must have the same number of tokens')
            t = torch.tensor(np.asarray(rows, dtype=np.int64))
        if t.dim() == 1:
            t = t.unsqueeze(0)
        if int(t.max()) >= self.V or int(t.min()) < 0:
            raise ValueError('a token id is outside the vocabulary')
        return t.to(self.device)

    def _prep(self, iv, R):
        """Interventions grouped by (hook, layer), with their arrays on the device."""
        by = {}
        for x in iv or ():
            p = dict(x)
            rows = x.get('rows')
            p['rows'] = list(range(R)) if rows in (None, 'all') else [int(r) for r in rows if 0 <= int(r) < R]
            for key in ('vec', 'src', 'mean'):
                if isinstance(x.get(key), torch.Tensor):           # a recipe's own capture, already on the device
                    p[key] = x[key].to(self.device)
                elif x.get(key) is not None:
                    p[key] = torch.as_tensor(np.asarray(x[key], dtype=np.float32), device=self.device)
            layer = x.get('layer')
            for l in (range(self.L) if layer in (None, 'all') else [int(layer)]):
                if 0 <= l < self.L:
                    by.setdefault((x['hook'], l), []).append(p)
        return by

    @staticmethod
    def _val(x, r):
        v = x.get('value', 1)
        return float(v[r]) if isinstance(v, (list, tuple, np.ndarray)) else float(1 if v is None else v)

    @staticmethod
    def _local(x, T0, Tn):
        """The intervention's positions inside this pass, as local indices."""
        pos = x.get('pos')
        if pos in (None, 'all'):
            return list(range(Tn))
        ps = pos if isinstance(pos, (list, tuple, np.ndarray)) else [pos]
        return [int(p) - T0 for p in ps if T0 <= int(p) < T0 + Tn]

    def _resid_iv(self, items, X, T0):
        Tn, W = X.shape[1], X.shape[2]
        for x in items:
            ts = self._local(x, T0, Tn)
            if not ts:
                continue
            tt = torch.tensor(ts, device=X.device)
            op = x['op']
            for r in x['rows']:
                v = self._val(x, r)
                if op == 'add':
                    X[r, tt] += (v * x['vec'].reshape(-1)).to(X.dtype)
                elif op == 'mul':
                    X[r, tt] *= v
                elif op == 'set':
                    X[r, tt] = x['src'].reshape(-1, W)[tt + T0].to(X.dtype)
                elif op == 'project_out':
                    u = x['vec'].reshape(-1)
                    seg = X[r, tt].float()
                    X[r, tt] = (seg - (seg @ u / (u @ u).clamp_min(1e-12)).unsqueeze(-1) * u).to(X.dtype)
                else:
                    raise ValueError(f'unknown intervention {op!r}')

    def _neuron_iv(self, items, X, T0, l):
        Tn = X.shape[1]
        for x in items:
            ts = self._local(x, T0, Tn)
            if not ts:
                continue
            tt = torch.tensor(ts, device=X.device)
            n = x.get('neuron')
            ns = torch.arange(self.M, device=X.device) if n in (None, 'all') else \
                torch.tensor([int(a) for a in (n if isinstance(n, (list, tuple, np.ndarray)) else [n])], device=X.device)
            op = x['op']
            for r in x['rows']:
                v = self._val(x, r)
                idx = (r, tt.unsqueeze(1), ns.unsqueeze(0))
                if op == 'add':
                    X[idx] += v
                elif op == 'addr':
                    unit = float(self.stats()[l]) / self.woutNorm[l, ns].clamp_min(1e-6)
                    X[idx] += (v * unit).to(X.dtype).unsqueeze(0)
                elif op == 'mul':
                    X[idx] *= v
                elif op == 'set':
                    X[idx] = v
                elif op == 'setsrc':
                    X[idx] = x['src'].reshape(-1, self.M)[(tt + T0).unsqueeze(1), ns.unsqueeze(0)].to(X.dtype)
                else:
                    raise ValueError(f'unknown neuron intervention {op!r}')

    def _head_iv(self, items, X, T0, l):
        Tn, dh, nh = X.shape[1], self.dh[l], self.heads[l]
        for x in items:
            ts = self._local(x, T0, Tn)
            if not ts:
                continue
            tt = torch.tensor(ts, device=X.device)
            hd = x.get('head')
            hs = range(nh) if hd in (None, 'all') else [int(a) for a in (hd if isinstance(hd, (list, tuple)) else [hd])]
            op = x['op']
            for r in x['rows']:
                v = self._val(x, r)
                for hh in hs:
                    if not 0 <= hh < nh:
                        continue
                    sl = slice(hh * dh, (hh + 1) * dh)
                    if op == 'mul':
                        X[r, tt, sl] *= v
                    elif op == 'set':
                        X[r, tt, sl] = x['src'].reshape(-1, nh * dh)[tt + T0, sl].to(X.dtype)
                    elif op == 'mean':
                        X[r, tt, sl] = x['mean'].reshape(-1)[sl].to(X.dtype)
                    else:
                        raise ValueError(f'unknown head intervention {op!r}')

    def set_eager(self, on):
        want = 'eager' if on else self._attn_impl
        if getattr(self.model.config, '_attn_implementation', None) != want:
            self.model.set_attn_implementation(want)

    @torch.no_grad()
    def forward(self, ids, capture=None, iv=None, logits='last', cache=None, check=None):
        """Mirrors lab/core/gpt2.js forward(). ids: R rows of equal length (or one row). capture: {name: True |
        [layers]}. iv: interventions (see gpt2.js applyIv). logits: 'last' | 'all' | 'none' | [absolute positions].
        cache: a KV for generation (the ids follow its positions). Returns {R, T, T0, logits [R, P, V] float32 on the
        device or None, lpos, cap: {name: {layer: tensor [R, T, ...]}, 'resid_final': [R, T, D]}}."""
        ids = self._ids(ids)
        R, Tn = ids.shape
        T0 = cache.T if cache is not None else 0
        want = capture or {}

        def wants(name, l):
            w = want.get(name)
            return w is True or (isinstance(w, (list, tuple)) and l in w)

        cap = {}

        def record(name, l, x):
            cap.setdefault(name, {})[l] = x.detach().clone()

        ivs = self._prep(iv, R)
        has = lambda hook, l: (hook, l) in ivs
        hs = []
        patterns = any(wants('attn_pattern', l) for l in range(self.L) if self.kind[l] == 'attention')
        for l, layer in enumerate(self.layers):
            if wants('resid_pre', l) or has('resid_pre', l):
                def pre(mod, args, kwargs, l=l):
                    x = args[0] if args else kwargs['hidden_states']
                    if has('resid_pre', l):
                        self._resid_iv(ivs[('resid_pre', l)], x, T0)
                    if wants('resid_pre', l):
                        record('resid_pre', l, x)
                hs.append(layer.register_forward_pre_hook(pre, with_kwargs=True))
            if wants('attn_z', l) or has('head', l):
                def zh(mod, args, l=l):
                    z = args[0]
                    if has('head', l):
                        self._head_iv(ivs[('head', l)], z, T0, l)
                    if wants('attn_z', l):
                        record('attn_z', l, z)
                hs.append(self.wo[l].register_forward_pre_hook(zh))
            if wants('attn_out', l) or has('attn_out', l) or (patterns and wants('attn_pattern', l)):
                def ao(mod, args, out, l=l):
                    y = hidden(out)
                    if has('attn_out', l):
                        self._resid_iv(ivs[('attn_out', l)], y, T0)
                    if wants('attn_out', l):
                        record('attn_out', l, y)
                    if wants('attn_pattern', l) and isinstance(out, tuple) and len(out) > 1 and out[1] is not None:
                        cap.setdefault('attn_pattern', {})[l] = out[1].detach().float()
                hs.append(self.mixer[l].register_forward_hook(ao))
            if wants('resid_mid', l) or has('resid_mid', l):
                def mid(mod, args, l=l):
                    x = args[0]                                   # the same tensor the block adds the MLP's write to
                    if has('resid_mid', l):
                        self._resid_iv(ivs[('resid_mid', l)], x, T0)
                    if wants('resid_mid', l):
                        record('resid_mid', l, x)
                hs.append(layer.post_attention_layernorm.register_forward_pre_hook(mid))
            if wants('mlp_post', l) or has('mlp_post', l):
                def post(mod, args, l=l):
                    a = args[0]
                    if has('mlp_post', l):
                        self._neuron_iv(ivs[('mlp_post', l)], a, T0, l)
                    if wants('mlp_post', l):
                        record('mlp_post', l, a)
                hs.append(layer.mlp.down_proj.register_forward_pre_hook(post))
            if wants('mlp_out', l) or has('mlp_out', l):
                def mo(mod, args, out, l=l):
                    if has('mlp_out', l):
                        self._resid_iv(ivs[('mlp_out', l)], out, T0)
                    if wants('mlp_out', l):
                        record('mlp_out', l, out)
                hs.append(layer.mlp.register_forward_hook(mo))
            if wants('resid_post', l) or has('resid_post', l):
                def rp(mod, args, out, l=l):
                    y = hidden(out)
                    if has('resid_post', l):
                        self._resid_iv(ivs[('resid_post', l)], y, T0)
                    if wants('resid_post', l):
                        record('resid_post', l, y)
                hs.append(layer.register_forward_hook(rp))

        def final(mod, args):
            cap['resid_final'] = args[0].detach()
            raise StopForward()
        hs.append(self.final_norm.register_forward_pre_hook(final))
        pos = torch.arange(T0, T0 + Tn, device=self.device).unsqueeze(0).expand(R, Tn)
        if patterns:
            self.set_eager(True)
        try:
            self.text_model(input_ids=ids, position_ids=pos, past_key_values=cache.kv if cache is not None else None,
                            use_cache=cache is not None)
        except StopForward:
            pass
        finally:
            for h in hs:
                h.remove()
            if patterns:
                self.set_eager(False)
        if cache is not None:
            cache.T = T0 + Tn
        if logits == 'all':
            lpos = list(range(Tn))
        elif logits == 'none' or logits is None:
            lpos = []
        elif isinstance(logits, (list, tuple)):
            lpos = [int(p) - T0 for p in logits]
            if any(not 0 <= p < Tn for p in lpos):
                raise ValueError('a logit position is outside the text')
        else:
            lpos = [Tn - 1]
        lg = None
        if lpos:
            rows = cap['resid_final'][:, lpos]                     # [R, P, D]
            lg = self.logits32(rows.reshape(-1, self.D), check).reshape(R, len(lpos), self.V)
        return {'R': R, 'T': Tn, 'T0': T0, 'logits': lg, 'lpos': [p + T0 for p in lpos], 'cap': cap}

    # ---- logits ------------------------------------------------------------------------------------------------
    @torch.no_grad()
    def normed(self, x):
        """The final norm applied in float32 to rows of the stream (it keeps a float32 input's dtype)."""
        return self.final_norm(x.float())

    @torch.no_grad()
    def unembed(self, xn, check=None):
        """Float32 logits [N, V] for rows already through the final norm (or any vectors), in vocabulary slices."""
        xn = xn.float()
        out = torch.empty(xn.shape[0], self.V, device=xn.device, dtype=torch.float32)
        for a in range(0, self.V, SLICE):
            if check:
                check()
            out[:, a:a + SLICE] = xn @ self.W_U[a:a + SLICE].float().T
        return out

    def logits32(self, x, check=None):
        rows = []
        for a in range(0, x.shape[0], LOGIT_ROWS):
            rows.append(self.unembed(self.normed(x[a:a + LOGIT_ROWS]), check))
        return torch.cat(rows) if len(rows) > 1 else rows[0]

    def rms(self, x):
        """1 / the factor an RMSNorm divides by, for rows x [..., D] (float32)."""
        x = x.float()
        return torch.rsqrt(x.pow(2).mean(-1) + self.eps)

    # ---- memory ------------------------------------------------------------------------------------------------
    def unload(self):
        self.lm.unload()
        self.model = self.layers = self.final_norm = self.text_model = None
        self.mixer, self.wo = [], []
        self.W_U = self.E = self.gF = self.woutNorm = self._links = self._mean_unembed = None
        self._g2 = {}
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
