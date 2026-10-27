/* lab/ui/about.js: what the lab is, how its two halves fit, the honest limits, and credits. Also the river map's
   three-tier explanation, shared by Today and Tools. */

import { h, tiers } from './dom.js';

export const RIVER_TEACH = {
  1: `<p>Think of GPT-2 as a river with one channel for each piece of your text. The water flows up through 12 layers.
In every layer, <b>mills</b> work on the water inside one channel, and <b>bridges</b> carry water from earlier channels
into later ones, never backwards. Each layer <i>adds</i> to the water rather than replacing it. At the top, the last
channel's water is read out as a bet on the next piece of text.</p>
<p>Every tool in the lab is an instrument at one spot on this river: a tap to taste the water half-way up, a gauge on a
bridge, a valve that pours in dye.</p>`,
  2: `<p>Each token position carries a list of 768 numbers (the <b>residual stream</b>) up through 12 blocks. In each block,
12 attention heads read from earlier positions and add their output into the current position; then an MLP of 3,072
neurons works on each position by itself and adds its output. Nothing is overwritten: the stream at the top is the
starting embedding plus the sum of everything all 144 heads and 12 MLPs wrote.</p>
<p>That "it is all a sum" fact is what makes the tools possible. You can read the stream half-way (logit lens, probes),
split the final answer into who-wrote-what (attribution), swap one piece between two runs (patching), or add your own
direction (steering).</p>
<div data-angle="analogy"><p>A shared document that 156 editors append to in turn, where nobody may delete. Reading the
document after editor 80 shows what the model "thinks so far"; the final answer is whatever the whole document adds up to.</p></div>`,
  3: `<p>x<sub>l+1</sub> = x<sub>l</sub> + Σ<sub>h</sub> attn<sub>h</sub>(LN(x<sub>l</sub>)) + MLP(LN(x<sub>l</sub> + attn)): pre-LN,
d<sub>model</sub> 768, 12 × 12 heads (d<sub>head</sub> 64), d<sub>mlp</sub> 3,072 with GELU, learned absolute positions (1,024),
unembedding tied to the 50,257-token embedding. Linearity of the stream plus a final LayerNorm whose scale is fixed per
position gives exact direct logit attribution; the causal mask makes attention the only cross-position channel, which is
what path patching exploits.</p>
<p>Where the analogy breaks: water mixes irreversibly, but the stream is a vector space in which contributions superpose
along nearly orthogonal directions, so a projection can pull one back out. That is the whole reason probes and
attributions work, and superposition (more features than dimensions) is where it starts to fail.</p>`,
};

export function aboutView(view) {
  view.appendChild(h('div.wrap', null,
    h('h1', null, 'About the lab'),
    tiers('about-what', {
      1: `<p>The lab has two halves. <b>In your browser</b>, GPT-2 small (the model ARENA's interpretability chapter takes apart)
runs on your own device, and twelve tools let you look inside it. <b>On the 3090</b>, a research bench runs bigger open
models (Qwen 3.5, DeepSeek's distilled models, Z.ai's GLM) and writes each experiment as a result with its own
evidence. Those results appear under Results, drawn by the same charts. On the PC with the 3090, the twelve tools can also
take apart <b>Qwen 3.5 9B</b> live: pick it with the model button at the top of the page.</p>`,
      2: `<p>Two halves. The <b>lab</b> is GPT-2 small (124M parameters, int8 weights, 133 MB) running in a Web Worker,
on WebGPU when the browser offers a real graphics card and in plain JavaScript otherwise; each technique is a recipe
over one engine with hooks for capture and intervention. The <b>bench</b> is a Python package that runs open models
on the 3090 (Qwen 3.5 2B and 9B first, because the Qwen team published sparse autoencoders for every layer of them), one
JSON spec per experiment, and writes a result pack: the arrays, the claims, the controls and the exact settings. The
model button switches the tools to Qwen 3.5 9B, held in 4-bit on the 3090 by a small server on the PC (lab/bench/serve.py)
that the page reaches at 127.0.0.1:8790; it takes the studio's GPU lock for each request and gives the card back after 20
idle minutes.</p>`,
      3: `<p>Lab engine: GPT-2 small from OpenAI's checkpoint (via the ONNX Model Zoo export), int8 group-quantised (64-wide
groups, fp16 scales; top-1 agreement 98.8% and mean KL 0.0005 against fp32), with TransformerLens-style hook points
(resid_pre/mid/post, attn_z, attn_pattern, head_out, mlp_post) and interventions (add, set, mul, project_out, mean,
per-row values) on both a WGSL and a JS engine, cross-checked on load. Bench: transformers 5, forward hooks on decoder
layers, right padding (exact for causal and recurrent layers), Qwen-Scope TopK SAEs, bf16 or NF4 by free VRAM, packs in
<code>tara-pack/1</code> with provenance (spec hash, commit, versions, GPU). Live server (lab/bench/tarabench/live): a web
process that answers this site only, and a card process that holds the model and runs the tools' recipes in PyTorch
with the same hook names, streaming progress back in length-prefixed frames. A card process waits in standby with its
libraries already imported (minutes from the network drive) and no graphics memory, and a saved NF4 copy on Z: spares
the 19 GB read and the quantising, so a load takes about 90 s on the PC; lab/bench/live_check.py checks it end to
end.</p>`,
    }),
    h('h2', null, 'Being honest about what this can find'),
    tiers('about-honest', {
      1: `<p>The lab makes small new findings possible; it does not make them likely by itself. A finding becomes believable
when it beats a control: a fake version of the same experiment that should not work. That is why every result here
carries stamps (<b>supported</b>, <b>weak</b>, <b>not supported</b>) and says what test it had to pass.</p>`,
      2: `<p>Three standing cautions. Sparse autoencoders explain only part of what is in the residual stream (the error
nodes in a circuit show how much is left over). Attribution graphs gave Anthropic satisfying answers on about a quarter
of the prompts they tried. And a probe shows that information is <i>present</i>, not that the model <i>uses</i> it; steering
and patching test use. Novelty has to come from the question (a behaviour nobody has traced in Qwen 3.5, a comparison
across sizes, what post-training changed) and the rigour from the controls.</p>`,
      3: `<p>Controls by engine: random norm-matched directions and neutral-text loss for steering; a permutation test
(labels shuffled in training and scoring) for probes; reconstruction quality (fraction of variance explained) for
dictionaries; real patching of the top features against random active features, plus per-layer completeness, for
circuits; a random vector of the measured norm for model diffs. Claims are "supported" only when the 95% interval
clears the control's maximum (and, for steering, three standard deviations of it).</p>`,
    }),
    h('h2', null, 'How a result is made'),
    h('ol', null,
      h('li', null, 'A spec (a small JSON file in lab/bench/specs) says the model, the question, the data, the doses or layers, and the controls.'),
      h('li', null, 'The bench runs it on the 3090, taking turns with the other users of the card.'),
      h('li', null, 'It writes a pack: arrays, a claim ledger, notes, and how it was made (spec, commit, library versions).'),
      h('li', null, 'Committed packs appear under Results, with the chart that fits their kind.')),
    h('p', null, 'The bench\'s own guide, with the commands for the PC, is ',
      h('a', { href: 'https://github.com/interplanetarycriminal/practiceapp_tara/blob/main/lab/bench/README.md' }, 'lab/bench/README.md'), '.'),
    h('h2', null, 'Compared with neuron-explorer'),
    h('p', null, 'Lyra\'s neuron-explorer showed what a good neuron browser feels like: every neuron\'s top examples, what pushing it does, and pushes measured against random directions. The lab rebuilds those ideas (there is no licence on the original, so nothing is copied): every neuron\'s strongest and ordinary passages from 25 million tokens of web text, its histogram, co-firing partners, steer lens and steering sweep against random pushes, computed once on the 3090. It adds:'),
    h('ul', null,
      h('li', null, 'GPT-2 runs on your device, offline, with no server, and Qwen 3.5 9B runs live on your own 3090 with the same tools;'),
      h('li', null, 'ARENA\'s whole toolkit beside the neurons: logit lens, attention and head fingerprints, OV circuits, direct attribution, knock-outs, patching, steering, probes, the layer-7 SAE ARENA uses and Qwen-Scope\'s dictionaries for every layer of the 9B, read live on your own text;'),
      h('li', null, 'search from a word to its neurons or features, by what they write or what pushing them makes GPT-2 say;'),
      h('li', null, 'the bench for models far bigger than GPT-2, with controls and claim ledgers on every result;'),
      h('li', null, 'three reading levels, missions for every TARA week, and links into the concept map, films and 3D objects.')),
    h('h2', null, 'Credits'),
    h('ul.small', null,
      h('li', null, 'Lyra\'s neuron-explorer (github.com/lyramakesmusic/neuron-explorer): the neuron card, the steering sweep and its random-direction controls, the residual-norm steering unit. Reimplemented, not copied.'),
      h('li', null, 'ARENA and TransformerLens (Neel Nanda, Callum McDougall and contributors): the hook names, head detectors and the IOI exercises the tools follow.'),
      h('li', null, 'Logit lens: nostalgebraist (2020). Induction heads: Olsson et al. (2022). IOI: Wang et al. (2022). Activation patching and its pitfalls: Heimersheim and Nanda (2024); Zhang and Nanda (2023).'),
      h('li', null, 'Steering: Turner et al. (ActAdd, 2023), Rimsky et al. (contrastive activation addition, 2024), Chen et al. (persona vectors, 2025). Probes: Marks and Tegmark (2023). Directional ablation: Arditi et al. (2024).'),
      h('li', null, 'Feature circuits: Marks et al. (2024). Attribution graphs: Ameisen et al. and Lindsey et al. (Anthropic, 2025); circuit-tracer (Hanna, Piotrowski et al.). Model diffing: Minder et al. (2025). Dictionaries: the Qwen team\'s Qwen-Scope (2026).'),
      h('li', null, 'Sparse autoencoders: Bricken et al. (2023), Cunningham et al. (2023); the GPT-2 dictionary is Joseph Bloom\'s gpt2-small-res-jb, loaded as in ARENA through SAELens. Corpus: OpenWebText (Gokaslan and Cohen, 2019).'),
      h('li', null, 'Feature-card layout after Anthropic\'s feature browsers and Neuronpedia. GPT-2 by OpenAI, under its modified MIT licence. Qwen 3.5 and the Qwen-Scope dictionaries by the Qwen team (Alibaba).'))));
}
