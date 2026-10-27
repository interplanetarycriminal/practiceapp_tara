# Result packs (`tara-pack/1`)

Every bench engine writes one pack; every viewer in the lab reads one. A pack is a folder:

    lab/findings/packs/<id>/pack.json     what was asked, what was found, and how
    lab/findings/packs/<id>/<name>.bin    arrays, little-endian, described in pack.json
    lab/findings/packs/<id>/graph.json    (circuit and graph packs) the graph, in circuit-tracer's layout
    lab/findings/index.json               every pack, newest first: id, kind, title, question, headline, claims

## pack.json

| field | meaning |
|---|---|
| `format` | `"tara-pack/1"` |
| `id`, `kind` | the spec's id; `steer`, `probe`, `features`, `diff`, `circuit` or `graph` |
| `title`, `question` | from the spec, in plain words |
| `created` | UTC time the pack was written |
| `models` | one entry per model: `id`, `hf`, `revision` (the exact commit), `precision`, `layers`, `d_model`, `vocab` |
| `dictionary` | the SAE or transcoders used: `repo`, `revision`, `layer(s)`, `width`, `k` (or null) |
| `summary.headline` | one line for lists |
| `claims` | the claim ledger: `{text, status, evidence, test}`; status is `supported` (clears its control), `weak` (right direction, control not cleared) or `not-supported` |
| `notes` | anything the viewer should say alongside |
| `data` | the engine's results (below) |
| `arrays` | `{name: {file, dtype, shape}}`; dtypes `f32 f16 i32 i16 u16 u8 i8` |
| `spec` | the spec exactly as run (with smoke overrides applied) |
| `provenance` | `spec_hash`, `seed`, `commit` (the bench's git commit), `bench_dirty`, `runtime_s`, `finished`, `torch`, `transformers`, `gpu`, `cuda`, `python`, `os` |

A claim is only as good as its `test`. Every engine compares against a control: random directions for steering,
shuffled labels for probes, random active features for circuits, a random vector for model diffs.

## data, by kind

**steer**: `doses`, `units` (`resid`: multiples of the layer's median residual norm), `layers`, `resid_norm`,
`direction` (source, layer, raw norm, `cos_with_mean_residual`), `metric` (kind, description, prompts),
`curve` [{dose, mean, lo, hi}], `random` {n, mean[], sd[]}, `nll` {base, direction[], random[][]}, `samples`
[{dose, prompt, text}], `logit_lens` {up, down}. Arrays: `per_prompt` [doses, prompts], `random_curve`
[random, doses], `direction` [d_model].

**probe**: `layers`, `rows` [{layer, logreg, logreg_ci, logreg_auc, diffmeans, diffmeans_ci, diffmeans_auc,
shuffled, shuffled_max, l2, mean_gap}] (the `_ci` pairs are exact binomial 95% intervals; packs before 27 October 2026
bootstrapped them), `best` (index into rows), `pca_ratio`, `texts`, `n`, `n_test`, `paired` (matched pairs held out
whole), `interval`. Arrays:
`pca` [layers, n, 2], `labels` [n], `is_test` [n], `dirs_dm` and `dirs_lr` [layers, d_model] (unit vectors,
usable by a steer spec as `{"from": "pack", "pack": "<id>", "layer": L}`), `scores_best` [n].

**features**: `layer`, `width`, `k`, `quality` {fve, cos, l0, rows}, `cards` [{feature, density, mean_act, max_act,
examples [{tokens, acts, at, max}], logit_lens, label}], `prompts` [{prompt, tokens, top [[[feature, act]...] per
token]}], `density_hist`, `corpus`. Arrays: `density` [width], `mean_act` [width].

**diff**: `a`, `b`, `precision`, `format`, `layers`, `rows` [{layer, rel_median, rel_mean, rel_p90, cos_mean,
delta_norm, delta_rel, resid_median_norm}], `lens` {layer: {up, down}}, `kl` {mean, ci}, `steer` [{layer, dose,
delta {kl, closed, closed_ci}, random {...}}], `features` {layer: {grew [...], faded [...]}}, `showcase` [{prompt,
tokens, array}], `prompts`. Arrays: `heat_<i>` [layers, tokens] relative change per token, `kl` [prompts].

**circuit**: `layers`, `aligned` (nodes are per position when every prompt has the same length), `positions`,
`method` (`attrib` or `ig`), `graph` (file name), `validation` [{k, top, top_ci, random[]}], `completeness`
{layer: summed node effects / real gap}, `tokens`, `examples`. Arrays: `m_clean`, `m_corrupt`.

**graph**: `hf_model`, `transcoders`, `backend`, `graphs` [{prompt, file, n_nodes, n_links, top_logits,
top_features}].

## graph.json

The layout circuit-tracer writes (and Neuronpedia reads), so one viewer draws both kinds:
`metadata` {slug, scan, prompt, prompt_tokens, ...}, `nodes` [{node_id, feature, layer, ctx_idx, feature_type,
influence, activation, clerp, is_target_logit, ...}], `links` [{source, target, weight}]. The circuit engine's
feature types are `sae feature`, `residual error` and `logit`; `ctx_idx` is -1 for a node summed over positions.
