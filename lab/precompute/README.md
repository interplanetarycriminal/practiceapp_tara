# Lab precompute

Everything the lab shows that needs more than one prompt's worth of computing: what every neuron responds to across
millions of tokens of text, what pushing it does, and ARENA's GPT-2 SAE features. It runs once on a GPU (it was run
on an RTX 3090) and writes small binary files into `lab/data/`, which the lab loads on demand.

The model here is the lab's own: `labgpt2.py` loads the int8 shards in `lab/model/` and dequantises them the same way
the browser does, and every job starts with a self-test against numbers computed by the lab's engine
(`selftest.json`). So a neuron's top example shows the same activation you get when you paste that text into the lab.

| job | what it writes |
|---|---|
| `corpus.py` | `contexts.npy`: OpenWebText cut into contexts of `<|endoftext|>` + 127 tokens, shuffled |
| `neurons.py` | `neurons/`: every neuron's 12 top and 6 typical-strength examples, histogram, co-firing partners; residual norms in `stats.json` |
| `steerlens.py` | `steer/`: the tokens each neuron's push makes more likely, through all later layers |
| `sweep.py` | `sweep/`: ten greedy continuations per neuron with it pushed, plus random-direction controls |
| `sae.py` | `sae/L07/`: gpt2-small-res-jb layer 7 features (examples, logit lens, density) and an int8 copy of the SAE |

Run (Windows paths shown; `--lock` takes turns with other GPU users through a `hold()` context manager):

    python run_all.py --data Z:/tara-lab/data --work Z:/tara-lab/work --lock Z:/tara-lab/gpulock.py --smoke
    python run_all.py --data Z:/tara-lab/data --work Z:/tara-lab/work --lock Z:/tara-lab/gpulock.py

`--data` holds `owt/` (OpenWebText parquet, a `text` column) and `sae/blocks.N.hook_resid_pre/` (SAELens format).
Every job is resumable; rerunning skips finished work. Needs torch, numpy, regex, pyarrow, safetensors.

Method credits: the steer lens and the sweep design (pushes in units of the median residual norm, random-direction
controls) follow Lyra's neuron-explorer (github.com/lyramakesmusic/neuron-explorer), reimplemented here for GPT-2;
the top-and-band example layout follows Anthropic's feature browsers and Neuronpedia.
