# The research bench

The lab in the app runs GPT-2 small in your browser, which is perfect for learning and too small for new findings.
The bench is the other half: Python jobs that run open models (Qwen 3.5 first) on the RTX 3090 and write result
packs that the lab's viewers draw. Each job asks one question, answers it with a number, and checks that number
against a control, so every claim it makes says how it could have been wrong.

| engine | the question it answers | the control |
|---|---|---|
| `steer` | Does pushing along one direction change a behaviour, how much per unit of push, and what does it break? | the same pushes along random directions; loss on neutral text |
| `probe` | Is a property written in a straight line inside the model, from which layer, and does it carry over to other wording? | the same probe trained and scored on shuffled labels (a permutation test); probes on the words alone and on what they mean; 32 random directions; optionally a probe for a rival property |
| `features` | What does one dictionary feature respond to, and what does it make the model say? | the dictionary's reconstruction quality on this model |
| `diff` | What did post-training (or a fine-tune) change inside the model, and where? | random vectors of the same size as the measured shift, on prompts the shift was not made from |
| `circuit` | Which dictionary features carry a behaviour, and how do they feed each other? | patching the top features for real on pairs they were not ranked on, against random active features |
| `graph` | The same through circuit-tracer's transcoders, for models that have them (Qwen 3, Gemma 3) | the graph's own error nodes; interventions |

The result format is in [PACKS.md](PACKS.md). The specs in `specs/` are the first experiments; copy one to start a
new one. `python run.py --list` shows them.

## Models and dictionaries

The registry is in `tarabench/models.py`. Qwen 3.5 2B and 9B (base and instruct) come first, because Qwen-Scope
(the Qwen team's own sparse autoencoders, May 2026, arXiv:2605.11887) covers every layer of their base models:
`Qwen/SAE-Res-Qwen3.5-2B-Base-W32K-L0_50` and `Qwen/SAE-Res-Qwen3.5-9B-Base-W64K-L0_50` (also `L0_100`). The
dictionaries were trained on the base models; reading the instruct model with them works less well, which the
features engine measures before showing anything. DeepSeek's small models (R1-0528-Qwen3-8B, the R1 distills) and
Z.ai's GLM-4 9B and GLM-Z1 9B run in every engine that does not need a dictionary.

Memory on a shared 24 GB card: precision `auto` looks at free memory when the model loads and picks float32 when
it fits, then bf16, then 4-bit NF4. Float32 is exact: batched and single runs agree to about 1e-5. In bf16 a batch
takes different kernels through the whole network, so a log-prob moves by about 0.02 nats on average (0.2 at most,
Qwen 3.5 2B on the 3090), and an effect smaller than a few hundredths of a nat is below bf16's resolution;
`setup_check.py` measures it for each model. Qwen 3.5 2B in float32 peaks at about 7 GB, so its specs pin
`"precision": "fp32"`. A 9B model takes about 19 GB in bf16, so with ComfyUI holding its models it loads in 4-bit
NF4 (about 6.5 GB), and the 9B specs pin `"precision": "nf4"` so a run does not change with what else is loaded.
Dictionaries follow the model's precision when they fit beside it; a 9B dictionary is about 1 GB per layer in bf16,
and when several do not fit the engines keep them on the CPU instead, which is slower but works. `setup_check.py
--model <name> --precision nf4` measures a precision's resolution before a run.

## How the numbers are kept honest

- **Nothing is scored on what chose it.** A probe's best layer is picked by cross-validation inside its training
  half; a circuit's features are ranked on half the pairs and patched on the other half; a diff's shift vector is
  made, and its layer and dose chosen, on half the prompts and scored on the rest.
- **Intervals fit the statistic.** A mean over prompts or pairs gets a Student t interval (a percentile bootstrap of
  eight prompts covered the truth 88% of the time, against 95% for t, and of one prompt it has no width at all, so
  one prompt cannot make a supported claim). A share of a gap is a ratio of means with a bootstrap that resamples
  whole items. A probe's accuracy gets the exact binomial interval, which stays honest at a perfect score.
- **Controls are numerous and matched.** 32 random directions for steering, 10 random feature sets for a circuit,
  8 random vectors for a diff, all the same size as the real intervention.
- **Probes face the words.** Matched pairs are held out whole (every built-in contrast set is one: the same city,
  task or message once with each label), and every probe is compared, on the same held-out texts and by an exact
  McNemar test, with a probe that sees only which tokens each text contains. When the words alone give the label
  away (formal against casual wording does), a perfect probe says nothing about the model. A second probe reads what
  the words mean: each text's average input embedding, before any layer has combined the words. Synonyms share an
  embedding direction, so it carries a label across wordings that share no tokens, and what the layers add is the
  step from it to the probe. (The bench's layer 0 is the output of the first block, which has already mixed in
  context, so it is not this control.)
- **Probes face random directions.** 32 random directions in the probe's standardised space, each pointed the way it
  splits the training texts and cut like the probe, are scored on the same texts. When two kinds of text differ in
  many ways at once, a random direction separates them too; a probe's direction is supported only when its interval
  clears the best of them by 5 points. When the words do not give the label away and random directions still read
  it (true against false facts in the 2B: 72% on average at layer 10), the label is a major axis of the model's state
  there, which says the property is big, not that the probe's direction is special; the pack's note says which.
- **Transfer is the stronger test.** With `"test_dataset"` a probe trains on one set and is scored on another that
  carries the label in other words; part of the new set (`"dev_fraction"`, by pairs) re-centres each probe's cut and
  picks the layer, and every control is scored the same way. `"controls": {"confound": {"dataset": ..., "name": ...}}`
  adds a probe for a rival property, pointed the way it runs in the training texts. The eval-awareness specs use
  both: trained on prompts that say outright whether they are a test (`builtin:eval_deploy`), scored on other tasks
  whose cues are only implied (`builtin:eval_deploy_implicit`, written so that neither shared words, register,
  letter case nor length gives the label away), against a formality probe.

## On the 3090 PC

One-time setup, in the existing venv (`Z:\tara-lab\venv`, which already has torch with CUDA):

    cd <checkout>\lab\bench
    set HF_HOME=Z:\tara-lab\hf
    Z:\tara-lab\venv\Scripts\python -m pip install -r requirements.txt
    Z:\tara-lab\venv\Scripts\python setup_check.py
    Z:\tara-lab\venv\Scripts\python setup_check.py --model qwen3.5-2b-base --dict-layer 12 --lock Z:\tara-lab\gpulock.py

The first check needs nothing downloaded and ends with the self-test (a tiny random Qwen 3.5, every engine, about a
minute). The second downloads Qwen 3.5 2B Base (about 4.5 GB) and one dictionary layer (about 0.5 GB) and reports how
much of the model's residual stream the dictionary explains; expect well over half.

Then the experiments, smoke versions first (minutes), then the real ones:

    Z:\tara-lab\venv\Scripts\python run.py specs\qwen35-2b-*.json --smoke --lock Z:\tara-lab\gpulock.py
    Z:\tara-lab\venv\Scripts\python run.py specs\qwen35-2b-*.json --lock Z:\tara-lab\gpulock.py
    Z:\tara-lab\venv\Scripts\python run.py specs\qwen35-9b-*.json --lock Z:\tara-lab\gpulock.py

Packs land in `lab/findings/`; commit them and the app shows them. `--lock` takes turns with the other GPU users of
the machine through the studio's `hold()` lock, one batch at a time. Progress is in `work/status.json`.

### The graph environment

circuit-tracer pins transformers 4.x, which cannot load Qwen 3.5, so graph specs run from a second venv:

    python -m venv Z:\tara-lab\venv-graph
    Z:\tara-lab\venv-graph\Scripts\python -m pip install torch --index-url https://download.pytorch.org/whl/cu128
    Z:\tara-lab\venv-graph\Scripts\python -m pip install "circuit-tracer @ git+https://github.com/decoderesearch/circuit-tracer"
    Z:\tara-lab\venv-graph\Scripts\python run.py specs\graph-qwen3-1.7b.json --lock Z:\tara-lab\gpulock.py

Gemma needs its licence accepted on Hugging Face and a read token on the PC (`hf auth login`, typed on the PC, never
pasted into a chat).

## Being honest about what this can find

A bench like this makes new, small findings possible; it does not make them likely by itself. The novelty has to
come from the question (a behaviour nobody has traced in Qwen 3.5, a comparison across sizes, what post-training
did) and the rigour from the controls, which is why every engine has one and every claim states its test. Three
standing cautions: sparse autoencoders explain only part of the residual stream (the error nodes show how much is
left over); attribution graphs gave Anthropic satisfying answers on about a quarter of the prompts they tried; and
a probe shows that information is present, not that the model uses it, which is what steering and patching test.

## Credits

The dose-ladder steering with random-direction controls follows Lyra's neuron-explorer
(github.com/lyramakesmusic/neuron-explorer), reimplemented here. Contrastive steering vectors: Rimsky et al.
(Steering Llama 2 via Contrastive Activation Addition, 2024). Difference-of-means probes: Marks and Tegmark (The
Geometry of Truth, 2023). Directional ablation: Arditi et al. (Refusal Is Mediated by a Single Direction, 2024).
Feature circuits and the gradient routing through spliced dictionaries: Marks et al. (Sparse Feature Circuits,
2024). The activation-difference lens for model diffing: Minder et al. (2025). Attribution graphs: Ameisen et al.
and Lindsey et al. (Anthropic, 2025) and circuit-tracer (Hanna, Piotrowski et al., Decode Research). Dictionaries:
the Qwen team's Qwen-Scope. Indirect object identification: Wang et al. (2022).
