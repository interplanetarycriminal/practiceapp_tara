"""A tiny, randomly initialised model with Qwen 3.5's real architecture (three Gated DeltaNet layers, then one gated
attention layer), a word-level tokenizer built from the bench's own datasets, and random dictionaries in Qwen-Scope's
file layout. Nothing is downloaded, so every engine can be exercised on a CPU in seconds; the numbers it produces
mean nothing, only the plumbing is under test."""
import re
from pathlib import Path

import torch

from . import data

SPECIALS = ['<|endoftext|>', '<|im_start|>', '<|im_end|>', '[UNK]']
CHAT = ("{% for m in messages %}<|im_start|>{{ m['role'] }}\n{{ m['content'] }}<|im_end|>\n{% endfor %}"
        "{% if add_generation_prompt %}<|im_start|>assistant\n{% endif %}")


def _words():
    pool = list(data.NEUTRAL) + [a for p in data.FORMAL_CASUAL for a in p] + data.DIFF_PROMPTS
    pool += data.cities()[0] + data.cities()[1] + data.eval_deploy()[0] + data.eval_deploy()[1]
    pool += data.eval_deploy_implicit()[0] + data.eval_deploy_implicit()[1]
    pool += [p['clean'] + ' ' + p['corrupt'] + p['answer'] + p['foil'] for p in data.ioi_pairs(48)]
    pool += ['user', 'assistant', 'system']
    words = set()
    for t in pool:
        words.update(re.findall(r'\w+|[^\w\s]', t))
    return sorted(words)


def tokenizer():
    from tokenizers import Tokenizer, decoders, models, pre_tokenizers
    from transformers import PreTrainedTokenizerFast
    vocab = {s: i for i, s in enumerate(SPECIALS)}
    for w in _words():
        vocab.setdefault(w, len(vocab))
    tk = Tokenizer(models.WordLevel(vocab=vocab, unk_token='[UNK]'))
    tk.pre_tokenizer = pre_tokenizers.Sequence([pre_tokenizers.Split(r'\n', 'isolated'), pre_tokenizers.Whitespace()])
    tk.decoder = decoders.WordPiece(prefix='##')
    tok = PreTrainedTokenizerFast(tokenizer_object=tk, eos_token='<|im_end|>', pad_token='<|endoftext|>',
                                  unk_token='[UNK]', additional_special_tokens=['<|im_start|>'])
    tok.chat_template = CHAT
    return tok


def model(vocab_size, seed=0, perturb=0.0):
    from transformers.models.qwen3_5.configuration_qwen3_5 import Qwen3_5TextConfig
    from transformers.models.qwen3_5.modeling_qwen3_5 import Qwen3_5ForCausalLM
    cfg = Qwen3_5TextConfig(vocab_size=vocab_size, hidden_size=64, intermediate_size=128, num_hidden_layers=4,
                            num_attention_heads=4, num_key_value_heads=2, head_dim=16, linear_key_head_dim=16,
                            linear_value_head_dim=16, linear_num_key_heads=2, linear_num_value_heads=4,
                            max_position_embeddings=512, pad_token_id=0, eos_token_id=2, tie_word_embeddings=False)
    torch.manual_seed(seed)
    m = Qwen3_5ForCausalLM(cfg)
    with torch.no_grad():
        for p in m.parameters():
            if p.dim() >= 2:
                p.normal_(0, 0.08)
        # Give the norms some shape, so the 1 + w gain is not all ones.
        for name, p in m.named_parameters():
            if name.endswith('layernorm.weight') or name.endswith('norm.weight'):
                p.uniform_(-0.2, 0.2)
        if perturb:
            g = torch.Generator().manual_seed(seed + 1)
            for p in m.parameters():
                p.add_(torch.randn(p.shape, generator=g) * perturb * (p.std() if p.numel() > 1 else 1))
    m.eval()
    m.requires_grad_(False)
    return m


def tiny_lm(entry):
    from .models import LM
    tok = tokenizer()
    m = model(len(tok), seed=0, perturb=entry.get('perturb', 0.0))
    lm = LM(m, tok, {**entry, 'hf': 'local'}, 'fp32', 'tiny')
    lm.batch_size = 4
    return lm


def write_dictionaries(folder, d_model=64, width=256, k=8, layers=range(4), seed=0):
    """Random TopK dictionaries in Qwen-Scope's layout (layer<n>.sae.pt), decoder columns of unit length."""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    g = torch.Generator().manual_seed(seed)
    for L in layers:
        W_dec = torch.randn(d_model, width, generator=g)
        W_dec = W_dec / W_dec.norm(dim=0, keepdim=True)
        torch.save({'W_enc': W_dec.T.clone() * 2.0, 'W_dec': W_dec, 'b_enc': torch.zeros(width) - 0.05,
                    'b_dec': torch.zeros(d_model)}, folder / f'layer{L}.sae.pt')
    return str(folder)
