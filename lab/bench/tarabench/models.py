"""The models the bench knows, how to load them onto a 24 GB card that is shared with other work, and the small API
every engine uses: tokenise (raw or chat), run batches while reading the residual stream, take next-token
log-probabilities, generate.

Precision 'auto' measures free GPU memory at load time: bf16 when the weights fit with room to spare, otherwise
4-bit NF4 through bitsandbytes (about a quarter of the memory; activations stay bf16)."""
import contextlib
import gc
import math
from dataclasses import dataclass
from pathlib import Path

import torch

from .common import say
from .hooks import Hooks

# hf: Hugging Face repo. params_b: rough size for the memory estimate when the hub cannot be asked.
# base: the pre-post-training twin, for model diffing. sae: a Qwen-Scope dictionary exists for this family.
MODELS = {
    'qwen3.5-0.8b': dict(hf='Qwen/Qwen3.5-0.8B', params_b=0.9, base='qwen3.5-0.8b-base'),
    'qwen3.5-0.8b-base': dict(hf='Qwen/Qwen3.5-0.8B-Base', params_b=0.9),
    'qwen3.5-2b': dict(hf='Qwen/Qwen3.5-2B', params_b=2.3, base='qwen3.5-2b-base', sae=True),
    'qwen3.5-2b-base': dict(hf='Qwen/Qwen3.5-2B-Base', params_b=2.3, sae=True),
    'qwen3.5-4b': dict(hf='Qwen/Qwen3.5-4B', params_b=4.7, base='qwen3.5-4b-base'),
    'qwen3.5-4b-base': dict(hf='Qwen/Qwen3.5-4B-Base', params_b=4.7),
    'qwen3.5-9b': dict(hf='Qwen/Qwen3.5-9B', params_b=9.7, base='qwen3.5-9b-base', sae=True),
    'qwen3.5-9b-base': dict(hf='Qwen/Qwen3.5-9B-Base', params_b=9.7, sae=True),
    'qwen3-0.6b': dict(hf='Qwen/Qwen3-0.6B', params_b=0.8),
    'qwen3-1.7b': dict(hf='Qwen/Qwen3-1.7B', params_b=2.0, base='qwen3-1.7b-base', sae=True),
    'qwen3-1.7b-base': dict(hf='Qwen/Qwen3-1.7B-Base', params_b=2.0, sae=True),
    'qwen3-4b': dict(hf='Qwen/Qwen3-4B', params_b=4.0),
    'qwen3-8b': dict(hf='Qwen/Qwen3-8B', params_b=8.2, base='qwen3-8b-base', sae=True),
    'qwen3-8b-base': dict(hf='Qwen/Qwen3-8B-Base', params_b=8.2, sae=True),
    'deepseek-r1-qwen3-8b': dict(hf='deepseek-ai/DeepSeek-R1-0528-Qwen3-8B', params_b=8.2, base='qwen3-8b-base'),
    'deepseek-r1-distill-1.5b': dict(hf='deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B', params_b=1.8),
    'deepseek-r1-distill-7b': dict(hf='deepseek-ai/DeepSeek-R1-Distill-Qwen-7B', params_b=7.6),
    'glm-4-9b': dict(hf='zai-org/GLM-4-9B-0414', params_b=9.4),
    'glm-z1-9b': dict(hf='zai-org/GLM-Z1-9B-0414', params_b=9.4),
    'gemma-3-270m-it': dict(hf='google/gemma-3-270m-it', params_b=0.3, gated=True),
    'gemma-3-1b-it': dict(hf='google/gemma-3-1b-it', params_b=1.0, gated=True),
    'gemma-2-2b': dict(hf='google/gemma-2-2b', params_b=2.6, gated=True),
    'gpt2': dict(hf='openai-community/gpt2', params_b=0.12),
    'tiny-qwen3.5': dict(tiny=True, params_b=0.001),
    'tiny-qwen3.5-tuned': dict(tiny=True, params_b=0.001, perturb=0.05),
}


def resolve(name):
    if name in MODELS:
        return {'id': name, **MODELS[name]}
    if Path(name).is_dir():
        return {'id': Path(name).name.lower(), 'hf': str(name), 'local': True}
    if name.startswith('hf:'):
        return {'id': name[3:].split('/')[-1].lower(), 'hf': name[3:]}
    raise ValueError(f'unknown model {name!r}; use one of {sorted(MODELS)} or hf:<org>/<repo>')


def weights_gb(entry, revision=None):
    """Size of the checkpoint's weight files, from the hub (or the local cache), else from the rough parameter count."""
    if entry.get('tiny'):
        return 0.001
    if entry.get('local'):
        return sum(f.stat().st_size for f in Path(entry['hf']).rglob('*.safetensors')) / 2 ** 30
    try:
        from huggingface_hub import HfApi
        info = HfApi().model_info(entry['hf'], revision=revision, files_metadata=True)
        sizes = [s.size for s in info.siblings if s.rfilename.endswith(('.safetensors', '.bin')) and s.size]
        if sizes:
            return sum(sizes) / 2 ** 30
    except Exception:
        pass
    try:
        from huggingface_hub import snapshot_download
        p = Path(snapshot_download(entry['hf'], revision=revision, local_files_only=True))
        sizes = [f.stat().st_size for f in p.rglob('*.safetensors')]
        if sizes:
            return sum(sizes) / 2 ** 30
    except Exception:
        pass
    return entry.get('params_b', 8) * 2


def choose_precision(entry, precision, device, revision=None, headroom_gb=2.5):
    if precision != 'auto':
        return precision, None
    if not str(device).startswith('cuda'):
        return 'fp32', None
    free = torch.cuda.mem_get_info()[0] / 2 ** 30
    need = weights_gb(entry, revision)
    note = f'{free:.1f} GB free on the GPU; bf16 weights need about {need:.1f} GB'
    if need + headroom_gb <= free:
        return 'bf16', note
    try:
        import bitsandbytes  # noqa: F401
        has_bnb = True
    except ImportError:
        has_bnb = False
    if has_bnb and need * 0.3 + 0.6 + headroom_gb <= free:
        return 'nf4', note + '; using 4-bit NF4'
    raise RuntimeError(f'{entry["id"]} does not fit: {note}. Free GPU memory (for example unload models in ComfyUI), '
                       f'pick a smaller model, or set precision to "nf4"' + ('' if has_bnb else ' after installing bitsandbytes'))


def find_layers(model):
    """The decoder layer list, whatever the wrapper: model.layers, model.language_model.layers, transformer.h, ..."""
    for path in ('model.layers', 'model.language_model.layers', 'model.model.layers', 'language_model.model.layers',
                 'model.text_model.layers', 'transformer.h', 'gpt_neox.layers', 'model.decoder.layers'):
        obj = model
        try:
            for part in path.split('.'):
                obj = getattr(obj, part)
        except AttributeError:
            continue
        if isinstance(obj, torch.nn.ModuleList) and len(obj) > 0:
            return obj, path
    best = None
    for name, mod in model.named_modules():
        if isinstance(mod, torch.nn.ModuleList) and len(mod) > 1 and (best is None or len(mod) > len(best[0])):
            best = (mod, name)
    if best is None:
        raise RuntimeError('cannot find the decoder layers')
    return best


def find_final_norm(model, layers_path):
    parent = model
    for part in layers_path.split('.')[:-1]:
        parent = getattr(parent, part)
    for name in ('norm', 'final_layernorm', 'ln_f', 'final_norm'):
        if hasattr(parent, name):
            return getattr(parent, name)
    raise RuntimeError('cannot find the final norm')


@dataclass
class Batch:
    ids: torch.Tensor     # [B, T], right-padded
    mask: torch.Tensor    # [B, T], 1 on real tokens
    lengths: list         # real lengths
    index: list           # positions of these rows in the caller's list


class LM:
    def __init__(self, model, tok, entry, precision, revision, note=None):
        self.model, self.tok, self.entry = model, tok, entry
        self.id = entry['id']
        self.layers, self.layers_path = find_layers(model)
        self.final_norm = find_final_norm(model, self.layers_path)
        self.n_layers = len(self.layers)
        cfg = getattr(model.config, 'text_config', None) or model.config
        self.d_model = cfg.hidden_size
        self.device = next(model.parameters()).device
        self.dtype = torch.float32 if precision == 'fp32' else torch.bfloat16
        self.precision = precision
        self.revision = revision or getattr(model.config, '_commit_hash', None)
        self.load_note = note
        self.batch_size = 8 if self.device.type == 'cuda' else 4
        self.hold = contextlib.nullcontext
        self._stats = {}
        self._gain = None
        if self.tok.pad_token_id is None:
            self.tok.pad_token = self.tok.eos_token

    # ---- description -------------------------------------------------------------------------------------------
    def info(self):
        return {'id': self.id, 'hf': self.entry.get('hf', 'local'), 'revision': self.revision,
                'precision': self.precision, 'layers': self.n_layers, 'd_model': self.d_model,
                'vocab': int(self.unembed().shape[0]), 'layers_path': self.layers_path, 'load_note': self.load_note}

    # ---- text --------------------------------------------------------------------------------------------------
    def chat(self, text, system=None):
        msgs = ([{'role': 'system', 'content': system}] if system else []) + [{'role': 'user', 'content': text}]
        if getattr(self.tok, 'chat_template', None):
            try:
                return self.tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True, enable_thinking=False)
            except TypeError:
                return self.tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
        return (f'{system}\n\n' if system else '') + f'User: {text}\nAssistant:'

    def encode(self, texts, fmt='raw', system=None):
        if fmt == 'chat':
            return [self.tok(self.chat(t, system), add_special_tokens=False)['input_ids'] for t in texts]
        return [self.tok(t, add_special_tokens=True)['input_ids'] for t in texts]

    def token_id(self, s):
        ids = self.tok(s, add_special_tokens=False)['input_ids']
        if not ids:
            raise ValueError(f'{s!r} has no tokens')
        return ids[0]

    def single_token(self, s):
        return len(self.tok(s, add_special_tokens=False)['input_ids']) == 1

    def decode_tokens(self, ids):
        return [self.tok.decode([int(i)]) for i in ids]

    # ---- running -----------------------------------------------------------------------------------------------
    def batches(self, seqs, batch_size=None):
        """Right padding: causal attention and the recurrent layers never look ahead, so real positions are exact."""
        bs = batch_size or self.batch_size
        order = sorted(range(len(seqs)), key=lambda i: len(seqs[i]))
        pad = self.tok.pad_token_id
        for s in range(0, len(order), bs):
            idx = order[s:s + bs]
            T = max(len(seqs[i]) for i in idx)
            ids = torch.full((len(idx), T), pad, dtype=torch.long)
            mask = torch.zeros((len(idx), T), dtype=torch.long)
            for r, i in enumerate(idx):
                ids[r, :len(seqs[i])] = torch.tensor(seqs[i])
                mask[r, :len(seqs[i])] = 1
            yield Batch(ids.to(self.device), mask.to(self.device), [len(seqs[i]) for i in idx], idx)

    def call(self, b, setup=None):
        """One forward pass under the GPU lock, with hooks set up by setup(hooks, batch). Returns the logits, or
        None when a hook stopped the pass early."""
        out = None
        with self.hold():
            with Hooks(self.layers) as hk:
                if setup:
                    setup(hk, b)
                out = self.model(input_ids=b.ids, attention_mask=b.mask, use_cache=False).logits
        return out

    @torch.no_grad()
    def capture(self, b, layers, setup=None):
        """{layer: hidden [B, T, D]} for one batch, stopping after the last layer needed."""
        store = {}

        def s(hk, bb):
            if setup:
                setup(hk, bb)
            for L in layers:
                hk.capture(L, store)
            hk.stop_after(max(layers))
        self.call(b, s)
        return {L: store[L][0] for L in layers}

    @torch.no_grad()
    def pooled(self, seqs, layers, pool='last', progress=None):
        """{layer: [N, D] float32 on the CPU}: the residual stream at the last token, or averaged over the tokens
        after the first (the first token is an attention sink with a huge norm)."""
        out = {L: [None] * len(seqs) for L in layers}
        done = 0
        for b in self.batches(seqs):
            hs = self.capture(b, layers)
            for L in layers:
                h = hs[L].float()
                for r, i in enumerate(b.index):
                    n = b.lengths[r]
                    out[L][i] = (h[r, n - 1] if pool == 'last' else h[r, 1 if n > 1 else 0:n].mean(0)).cpu()
            done += len(b.index)
            if progress:
                progress(done)
        return {L: torch.stack(v) for L, v in out.items()}

    @torch.no_grad()
    def resid_stats(self, layer, texts=None):
        """(median norm, mean vector) of the residual stream at a layer over neutral text, skipping the first token.
        Steering doses are measured in the median norm, so 1.0 means a push as long as a typical residual vector."""
        if layer in self._stats:
            return self._stats[layer]
        from .data import NEUTRAL
        rows = []
        for b in self.batches(self.encode(texts or NEUTRAL)):
            h = self.capture(b, [layer])[layer].float()
            for r, n in enumerate(b.lengths):
                rows.append(h[r, 1:n].cpu())
        rows = torch.cat(rows)
        self._stats[layer] = (float(rows.norm(dim=-1).median()), rows.mean(0))
        return self._stats[layer]

    def unembed(self):
        return self.model.get_output_embeddings().weight

    @torch.no_grad()
    def gain(self):
        """The final norm's per-dimension gain, read off by normalising a vector of ones (covers both the w and the
        1 + w parameterisations; Qwen 3.5 uses 1 + w)."""
        if self._gain is None:
            ones = torch.ones(1, 1, self.d_model, device=self.device, dtype=self.dtype)
            self._gain = self.final_norm(ones).float().reshape(-1)
        return self._gain

    @torch.no_grad()
    def logit_lens(self, vec, top=12):
        """Which tokens a residual-stream direction pushes up and down when read straight out through the final
        norm's gain and the unembedding (the norm's division by the vector's size is left out)."""
        W = self.unembed()
        v = (vec.to(self.device).float() * self.gain()).to(W.dtype)
        scores = (W @ v).float()
        up = scores.topk(top)
        down = (-scores).topk(top)
        return {'up': [[self.tok.decode([int(i)]), float(s)] for s, i in zip(up.values, up.indices)],
                'down': [[self.tok.decode([int(i)]), float(-s)] for s, i in zip(down.values, down.indices)]}

    # ---- outputs -----------------------------------------------------------------------------------------------
    @torch.no_grad()
    def last_logprobs(self, seqs, setup=None):
        """[N, V] float32 log-probabilities of the next token after each sequence."""
        out = [None] * len(seqs)
        for b in self.batches(seqs):
            logits = self.call(b, setup)
            for r, i in enumerate(b.index):
                out[i] = torch.log_softmax(logits[r, b.lengths[r] - 1].float(), -1).cpu()
        return torch.stack(out)

    @torch.no_grad()
    def token_nll(self, seqs, setup=None):
        """Mean negative log-likelihood per sequence over every predicted token after the first."""
        out = [None] * len(seqs)
        for b in self.batches(seqs):
            logits = self.call(b, setup).float()
            lp = torch.log_softmax(logits[:, :-1], -1).gather(-1, b.ids[:, 1:].unsqueeze(-1)).squeeze(-1)
            for r, i in enumerate(b.index):
                n = b.lengths[r]
                out[i] = float(-lp[r, :n - 1].mean()) if n > 1 else float('nan')
        return out

    @torch.no_grad()
    def cont_logprob(self, prompts, conts, setup=None):
        """Mean log-probability per token of each continuation given its prompt (teacher-forced)."""
        seqs = [p + c for p, c in zip(prompts, conts)]
        out = [None] * len(seqs)
        for b in self.batches(seqs):
            logits = self.call(b, setup).float()
            lp = torch.log_softmax(logits[:, :-1], -1).gather(-1, b.ids[:, 1:].unsqueeze(-1)).squeeze(-1)
            for r, i in enumerate(b.index):
                a, n = len(prompts[i]), b.lengths[r]
                out[i] = float(lp[r, a - 1:n - 1].mean())
        return out

    @torch.no_grad()
    def generate(self, seqs, new_tokens=40, greedy=True, temperature=0.7, seed=0, setup=None):
        """One sequence at a time (no padding questions), with optional steering hooks at every step."""
        texts = []
        for s in seqs:
            torch.manual_seed(seed)
            ids = torch.tensor([s], device=self.device)
            kw = dict(max_new_tokens=new_tokens, pad_token_id=self.tok.pad_token_id)
            kw.update(dict(do_sample=False, temperature=None, top_p=None, top_k=None) if greedy else
                      dict(do_sample=True, temperature=temperature, top_p=0.95))
            with self.hold():
                with Hooks(self.layers) as hk:
                    if setup:
                        setup(hk, None)
                    out = self.model.generate(input_ids=ids, attention_mask=torch.ones_like(ids), **kw)
            texts.append(self.tok.decode(out[0, len(s):], skip_special_tokens=True))
        return texts

    def unload(self):
        self.model = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


def load(name, precision='auto', device=None, revision=None, headroom_gb=2.5):
    entry = resolve(name)
    device = device or ('cuda' if torch.cuda.is_available() else 'cpu')
    if entry.get('tiny'):
        from .tiny import tiny_lm
        return tiny_lm(entry)
    from transformers import AutoModelForCausalLM, AutoTokenizer
    prec, note = choose_precision(entry, precision, device, revision, headroom_gb)
    say(f'loading {entry["hf"]} as {prec} on {device}' + (f' ({note})' if note else ''))
    tok = AutoTokenizer.from_pretrained(entry['hf'], revision=revision)
    kw = {'revision': revision, 'dtype': torch.float32 if prec == 'fp32' else torch.bfloat16}
    if prec == 'nf4':
        from transformers import BitsAndBytesConfig
        kw['quantization_config'] = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type='nf4',
                                                       bnb_4bit_compute_dtype=torch.bfloat16,
                                                       bnb_4bit_use_double_quant=True)
    if str(device).startswith('cuda'):
        kw['device_map'] = {'': device}
    try:
        model = AutoModelForCausalLM.from_pretrained(entry['hf'], **kw)
    except ValueError as e:
        if 'Unrecognized configuration class' not in str(e):
            raise
        from transformers import AutoModelForImageTextToText
        model = AutoModelForImageTextToText.from_pretrained(entry['hf'], **kw)
    if 'device_map' not in kw:
        model.to(device)
    model.eval()
    model.requires_grad_(False)
    lm = LM(model, tok, entry, prec, revision, note)
    say(f'loaded {lm.id}: {lm.n_layers} layers, width {lm.d_model}, layers at {lm.layers_path}')
    if torch.cuda.is_available():
        say(f'GPU memory in use by this process: {torch.cuda.memory_allocated() / 2 ** 30:.1f} GB')
    return lm


def is_finite(x):
    return x is not None and not (isinstance(x, float) and (math.isnan(x) or math.isinf(x)))
