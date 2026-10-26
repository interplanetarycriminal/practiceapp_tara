"""Forward hooks on the decoder layers: read the residual stream, add to it, project a direction out of it, or stop
the forward pass early. The residual stream "at layer L" is the output of decoder layer L, the same point that
Qwen-Scope's sparse autoencoders read (model.model.layers[L] in Hugging Face Qwen models).

Decoder layers return either a tensor or a tuple whose first element is the hidden state, depending on the model and
the transformers version; every hook here handles both."""


class StopForward(Exception):
    """Raised by a hook once everything needed has been read, so later layers are skipped."""


def hidden(out):
    return out[0] if isinstance(out, tuple) else out


def replace(out, h):
    return (h,) + tuple(out[1:]) if isinstance(out, tuple) else h


class Hooks:
    """Collects forward hooks and removes them on exit, even when the forward pass raises."""

    def __init__(self, layers):
        self.layers = layers
        self.handles = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        for h in self.handles:
            h.remove()
        self.handles.clear()
        return exc[0] is StopForward

    def on(self, layer, fn):
        """fn(h) returns a new hidden state, or None to leave it alone."""
        def hook(mod, args, out):
            new = fn(hidden(out))
            return None if new is None else replace(out, new)
        self.handles.append(self.layers[layer].register_forward_hook(hook))
        return self

    def capture(self, layer, store, select=None, stop=False):
        """Appends the hidden state (or select(h)) to store[layer]; with stop=True, ends the forward pass there."""
        def fn(h):
            v = select(h) if select else h
            store.setdefault(layer, []).append(v.detach())
            if stop:
                raise StopForward()
        return self.on(layer, fn)

    def add(self, layer, vec, scale=1.0, mask=None):
        """h + scale * vec, at every position or where mask [batch, seq] is true. During cached generation each step
        sees only the new token, so 'every position' also covers everything generated."""
        def fn(h):
            v = vec.to(h.dtype).to(h.device) * scale
            if mask is None or mask.shape[-1] != h.shape[1]:
                return h + v
            return h + mask.to(h.device).unsqueeze(-1).to(h.dtype) * v
        return self.on(layer, fn)

    def project_out(self, layer, unit):
        """Removes the component along a unit direction (directional ablation, as in Arditi et al. 2024)."""
        def fn(h):
            u = unit.to(h.dtype).to(h.device)
            return h - (h @ u).unsqueeze(-1) * u
        return self.on(layer, fn)

    def stop_after(self, layer):
        def fn(h):
            raise StopForward()
        return self.on(layer, fn)


def max_layer(layers):
    return max(layers) if layers else -1
