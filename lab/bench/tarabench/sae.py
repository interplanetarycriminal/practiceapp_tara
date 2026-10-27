"""Sparse autoencoders ("dictionaries") over the residual stream.

Qwen-Scope (Qwen team, May 2026, arXiv:2605.11887) publishes TopK SAEs for every layer of Qwen 3.5 2B and 9B (trained
on the Base models) as Qwen/SAE-Res-<model>-W<width>-L0_<k>, one file per layer, layer<n>.sae.pt, holding
W_enc [F, D], W_dec [D, F], b_enc [F] and b_dec [D]. They read the output of model.model.layers[n]. Encoding, as the
model card shows it: pre = x @ W_enc.T + b_enc, keep the k largest, zero the rest; the paper adds a ReLU inside the
encoder, which only matters in the rare case that fewer than k pre-activations are positive. Decoding: f @ W_dec.T + b_dec.
Training filtered out first-token outliers, so analyses here skip the first position."""
import re

import torch


class TopKSAE:
    def __init__(self, W_enc, W_dec, b_enc, b_dec, k, relu=True, meta=None):
        F, D = W_enc.shape
        assert W_dec.shape == (D, F), f'W_dec should be [{D}, {F}], got {list(W_dec.shape)}'
        self.W_enc, self.W_dec, self.b_enc, self.b_dec = W_enc, W_dec, b_enc, b_dec
        self.k, self.relu, self.F, self.D = int(k), relu, F, D
        self.meta = meta or {}

    @classmethod
    def load(cls, repo, layer, k=None, revision=None, device='cpu', dtype=torch.float32, local=None):
        """repo: a Hugging Face repo id in Qwen-Scope layout, or a local folder (local=True or an existing path)."""
        from pathlib import Path
        p = Path(repo)
        if local or p.exists():
            path, rev = p / f'layer{layer}.sae.pt', 'local'
        else:
            from huggingface_hub import hf_hub_download
            path = hf_hub_download(repo, f'layer{layer}.sae.pt', revision=revision)
            rev = _snapshot_revision(path) or revision
        sd = torch.load(path, map_location='cpu', weights_only=True)
        if k is None:
            m = re.search(r'L0_(\d+)', str(repo))
            k = int(m.group(1)) if m else int(sd.get('k', 50))
        t = lambda name: sd[name].to(device=device, dtype=dtype)
        meta = {'repo': str(repo), 'layer': int(layer), 'k': int(k), 'revision': rev, 'width': int(sd['W_enc'].shape[0]),
                'kind': 'topk-sae', 'family': 'qwen-scope' if 'SAE-Res' in str(repo) else 'custom'}
        return cls(t('W_enc'), t('W_dec'), t('b_enc'), t('b_dec'), k, meta=meta)

    def to(self, device=None, dtype=None):
        for n in ('W_enc', 'W_dec', 'b_enc', 'b_dec'):
            setattr(self, n, getattr(self, n).to(device=device, dtype=dtype))
        return self

    @property
    def device(self):
        return self.W_enc.device

    def pre(self, x):
        return x.to(self.W_enc.device, self.W_enc.dtype) @ self.W_enc.T + self.b_enc

    def encode(self, x):
        """Sparse codes: (values [.., k], indices [.., k])."""
        vals, idx = self.pre(x).topk(self.k, dim=-1)
        if self.relu:
            vals = vals.clamp_min(0)
        return vals, idx

    def encode_dense(self, x):
        vals, idx = self.encode(x)
        return self.dense(vals, idx)

    def dense(self, vals, idx):
        out = torch.zeros(*vals.shape[:-1], self.F, device=vals.device, dtype=vals.dtype)
        return out.scatter(-1, idx, vals)

    def decode(self, f):
        return f.to(self.W_dec.device, self.W_dec.dtype) @ self.W_dec.T + self.b_dec

    def decode_sparse(self, vals, idx, chunk=512):
        flat_v, flat_i = vals.reshape(-1, vals.shape[-1]), idx.reshape(-1, idx.shape[-1])
        outs = []
        for s in range(0, flat_v.shape[0], chunk):
            outs.append(self.decode(self.dense(flat_v[s:s + chunk].to(self.W_dec.dtype), flat_i[s:s + chunk])))
        return torch.cat(outs).reshape(*vals.shape[:-1], self.D)

    def nbytes(self):
        return sum(t.numel() * t.element_size() for t in (self.W_enc, self.W_dec, self.b_enc, self.b_dec))

    def direction(self, feature):
        """The feature's decoder column: what it writes into the residual stream when it fires at strength 1."""
        return self.W_dec[:, feature]

    @torch.no_grad()
    def quality(self, x):
        """Reconstruction checks on rows of x: fraction of variance explained and mean L0."""
        x = x.to(self.W_enc.device, self.W_enc.dtype)
        vals, idx = self.encode(x)
        xh = self.decode_sparse(vals, idx)
        resid = (x - xh).float()
        var = (x.float() - x.float().mean(0, keepdim=True)).pow(2).sum()
        fve = 1 - resid.pow(2).sum() / var.clamp_min(1e-12)
        l0 = (vals > 0).float().sum(-1).mean()
        cos = torch.nn.functional.cosine_similarity(x.float(), xh.float(), dim=-1).mean()
        return {'fve': float(fve), 'l0': float(l0), 'cos': float(cos), 'rows': int(x.shape[0])}


def load_many(lm, repo, layers, k=None, revision=None, headroom_gb=1.5):
    """Dictionaries for several layers: on the GPU at the model's precision when they fit beside it with room to
    spare (so a float32 model's spliced runs stay exact), else on the GPU in bf16, else on the CPU in fp32 (slower,
    but a 9B model in 4-bit plus several 64K dictionaries does not fit a shared 24 GB card).
    Returns ({layer: dictionary}, device)."""
    saes = {L: TopKSAE.load(repo, L, k, revision, 'cpu', torch.float32) for L in layers}
    device, dtype = torch.device('cpu'), torch.float32
    if lm.device.type == 'cuda':
        free = torch.cuda.mem_get_info()[0] / 2 ** 30
        full = sum(s.nbytes() for s in saes.values()) / 2 ** 30          # as loaded, in float32
        if lm.dtype == torch.float32 and full + headroom_gb < free:
            device = lm.device
        elif full / 2 + headroom_gb < free:
            device, dtype = lm.device, torch.bfloat16
    for s in saes.values():
        s.to(device, dtype)
    return saes, device


def _snapshot_revision(path):
    parts = str(path).replace('\\', '/').split('/')
    if 'snapshots' in parts:
        i = parts.index('snapshots')
        if i + 1 < len(parts):
            return parts[i + 1]
    return None


def dictionary_spec(d, layer=None):
    """Normalises a spec's 'dictionary' entry: a repo string, or {'repo':.., 'layer'/'layers':.., 'k':.., 'revision':..}."""
    if isinstance(d, str):
        d = {'repo': d}
    d = dict(d)
    if layer is not None:
        d['layer'] = layer
    return d


def qwen_scope_repo(model_id, width=None, k=50):
    """The Qwen-Scope repo for a model in the registry, e.g. qwen3.5-2b -> Qwen/SAE-Res-Qwen3.5-2B-Base-W32K-L0_50."""
    table = {'qwen3.5-2b': ('Qwen3.5-2B-Base', 'W32K'), 'qwen3.5-9b': ('Qwen3.5-9B-Base', 'W64K'),
             'qwen3-1.7b': ('Qwen3-1.7B-Base', 'W32K'), 'qwen3-8b': ('Qwen3-8B-Base', 'W64K')}
    base = model_id.replace('-base', '')
    if base not in table:
        raise ValueError(f'no Qwen-Scope dictionary is known for {model_id}')
    name, w = table[base]
    return f'Qwen/SAE-Res-{name}-{width or w}-L0_{k}'
