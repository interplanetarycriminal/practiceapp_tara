"""Attribution graphs with circuit-tracer (Hanna, Piotrowski et al., Decode Research; the open implementation of
Anthropic's circuit-tracing method, Ameisen et al. 2025).

A replacement model swaps every MLP for a transcoder, so each MLP's work becomes a few readable features; the graph
says which features, at which positions, push the model toward its next token, and through which others. This needs
transcoders for the model: circuit-tracer ships sets for Gemma 2 2B, Llama 3.2 1B, Qwen 3 (0.6B to 14B) and
Gemma 3 (Gemma Scope 2). Qwen 3.5 has none yet; for it, use the circuit engine, which builds feature circuits from
Qwen-Scope's residual dictionaries.

circuit-tracer pins an older transformers, so it lives in its own environment (see README.md, "graph environment").
This engine runs there, writes circuit-tracer's own graph JSON into the pack, and summarises the strongest nodes."""
import inspect
import json

from ..common import say, seed_all
from ..packs import claim


def resolve_transcoders(ref, model_name):
    """'collection:<owner>/<slug>' picks the collection item whose name matches the model (Gemma Scope 2's
    transcoders for circuit-tracer are published as one collection with a repo per model)."""
    if not str(ref).startswith('collection:'):
        return ref
    from huggingface_hub import get_collection
    want = model_name.split('/')[-1].lower()
    items = [i.item_id for i in get_collection(ref.split(':', 1)[1]).items if i.item_type == 'model']
    hits = [i for i in items if want in i.lower()]
    if not hits:
        raise RuntimeError(f'no transcoders for {want} in {ref}; the collection holds {items}')
    say(f'transcoders for {want}: {hits[0]} (from {len(items)} in the collection)')
    return hits[0]


def run(spec, ctx):
    try:
        import torch
        from circuit_tracer import ReplacementModel, attribute
        from circuit_tracer.utils.create_graph_files import create_graph_files
    except ImportError as e:
        raise RuntimeError('circuit-tracer is not installed in this Python; run graph specs with the graph '
                           'environment described in lab/bench/README.md') from e
    seed_all(spec.get('seed', 0))
    model_name = spec['hf_model']
    transcoders = resolve_transcoders(spec['transcoders'], model_name)
    backend = spec.get('backend', 'nnsight' if 'gemma-3' in model_name.lower() else 'transformerlens')
    dtype = {'bf16': torch.bfloat16, 'fp32': torch.float32, 'fp16': torch.float16}[spec.get('dtype', 'bf16')]
    kw = {}
    sig = inspect.signature(ReplacementModel.from_pretrained)
    if 'backend' in sig.parameters:
        kw['backend'] = backend
    with ctx.hold():
        say(f'loading {model_name} with transcoders {transcoders} ({backend})')
        model = ReplacementModel.from_pretrained(model_name, transcoders, dtype=dtype, **kw)
    pack = ctx.pack('graph')
    graphs = []
    for i, prompt in enumerate(spec['prompts']):
        akw = {k: v for k, v in {'max_n_logits': spec.get('max_n_logits', 10),
                                 'desired_logit_prob': spec.get('desired_logit_prob', 0.95),
                                 'batch_size': spec.get('batch_size', 256),
                                 'max_feature_nodes': spec.get('max_feature_nodes', 4096),
                                 'offload': spec.get('offload'), 'verbose': True}.items()
               if k in inspect.signature(attribute).parameters}
        with ctx.hold():
            g = attribute(prompt=prompt, model=model, **akw)
        slug = f"{spec['id']}-{i}"
        create_graph_files(graph_or_path=g, slug=slug, output_path=str(pack.dir),
                           node_threshold=spec.get('node_threshold', 0.8), edge_threshold=spec.get('edge_threshold', 0.98))
        gj = json.loads((pack.dir / f'{slug}.json').read_text(encoding='utf-8'))
        feats = sorted([n for n in gj['nodes'] if n.get('feature_type') not in ('logit', 'embedding')],
                       key=lambda n: -(n.get('influence') or 0))
        logits = [n for n in gj['nodes'] if n.get('is_target_logit') or n.get('feature_type') == 'logit']
        graphs.append({'prompt': prompt, 'file': f'{slug}.json', 'n_nodes': len(gj['nodes']),
                       'n_links': len(gj['links']), 'top_logits': [{'node_id': n['node_id'],
                                                                     'clerp': n.get('clerp'),
                                                                     'token_prob': n.get('token_prob')}
                                                                    for n in logits[:5]],
                       'top_features': [{'node_id': n['node_id'], 'layer': n['layer'], 'ctx_idx': n['ctx_idx'],
                                         'influence': n.get('influence'), 'clerp': n.get('clerp')} for n in feats[:20]]})
        say(f"graph {i}: {len(gj['nodes'])} nodes, {len(gj['links'])} links")
    claims = [claim(
        'Attribution graphs explain the model through a replacement that is not exact: the error nodes show how '
        'much the transcoders miss. Anthropic found the method gives satisfying answers on about a quarter of the '
        'prompts they tried, so treat a graph as a hypothesis to test with interventions.',
        'weak', {'graphs': len(graphs)}, test='a reminder, not a measurement')]
    data = {'hf_model': model_name, 'transcoders': transcoders, 'backend': backend, 'graphs': graphs}
    info = [{'id': spec.get('model', model_name), 'hf': model_name, 'precision': spec.get('dtype', 'bf16')}]
    return pack.save(models=info, summary={'headline': f'{len(graphs)} attribution graphs'}, claims=claims, data=data,
                     provenance=ctx.provenance({'circuit_tracer': getattr(__import__('circuit_tracer'), '__version__', None)}),
                     dictionary={'kind': 'transcoders', 'repo': transcoders})
