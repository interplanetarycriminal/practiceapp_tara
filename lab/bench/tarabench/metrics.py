"""Behaviour metrics: one number per prompt that says how much the model leans one way, so an intervention's effect
is a shift in that number. Every metric can run under steering hooks."""
import numpy as np
import torch

from .data import texts


class Metric:
    """kinds:
    logit_diff   {'prompts', 'target', 'foil'}: next-token log-prob of the target's first token minus the foil's.
    seq_logprob  {'prompts', 'positive', 'negative'}: mean per-token log-prob of a positive continuation minus a
                 negative one (teacher-forced), for behaviours longer than one token.
    prob         {'prompts', 'target'}: next-token probability of any of the target strings' first tokens.
    Strings can be one for all prompts or a list with one per prompt. 'format': 'raw' or 'chat'."""

    def __init__(self, lm, spec):
        self.lm, self.spec = lm, spec
        self.kind = spec['kind']
        self.fmt = spec.get('format', 'raw')
        self.prompts = texts(spec['prompts'])
        n = len(self.prompts)
        per = lambda v: list(v) if isinstance(v, list) and len(v) == n and n > 1 else [v] * n
        self.seqs = lm.encode(self.prompts, self.fmt, spec.get('system'))
        if self.kind == 'logit_diff':
            self.t = [lm.token_id(s) for s in per(spec['target'])]
            self.f = [lm.token_id(s) for s in per(spec['foil'])]
            self.warn = [s for s in set(per(spec['target']) + per(spec['foil'])) if not lm.single_token(s)]
        elif self.kind == 'prob':
            tg = spec['target'] if isinstance(spec['target'], list) else [spec['target']]
            self.t = sorted({lm.token_id(s) for s in tg})
            self.warn = [s for s in tg if not lm.single_token(s)]
        elif self.kind == 'seq_logprob':
            enc = lambda s: lm.tok(s, add_special_tokens=False)['input_ids']
            self.pos = [enc(s) for s in per(spec['positive'])]
            self.neg = [enc(s) for s in per(spec['negative'])]
            self.warn = []
        else:
            raise ValueError(f'unknown metric kind {self.kind!r}')

    def describe(self):
        s = self.spec
        if self.kind == 'logit_diff':
            return f"log-prob of {s['target']!r} minus {s['foil']!r} as the next token"
        if self.kind == 'prob':
            return f"probability that the next token is {s['target']!r}"
        return 'mean log-prob per token of the positive continuation minus the negative one'

    def __call__(self, setup=None):
        if self.kind in ('logit_diff', 'prob'):
            lp = self.lm.last_logprobs(self.seqs, setup)
            if self.kind == 'logit_diff':
                r = torch.arange(len(self.seqs))
                return (lp[r, self.t] - lp[r, self.f]).numpy()
            return lp[:, self.t].exp().sum(-1).numpy()
        a = self.lm.cont_logprob(self.seqs, self.pos, setup)
        b = self.lm.cont_logprob(self.seqs, self.neg, setup)
        return np.asarray(a) - np.asarray(b)
