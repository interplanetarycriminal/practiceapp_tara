/* lab/ui/tools/index.js: the live GPT-2 tools. Each entry says where in the model the tool looks (its pin on the
   river map), which TARA weeks use it, and which concept-map nodes it makes concrete. Modules load on demand. */

export const TOOLS = [
  { id: 'next', name: 'What comes next', where: 'out', weeks: [1, 2], cost: 'instant',
    blurb: 'The model\'s bet on the next token, and the sampling dials that turn bets into text.',
    nodes: ['sampling', 'temperature', 'top-k-sampling', 'top-p-sampling', 'unembedding'], load: () => import('./next.js') },
  { id: 'surprise', name: 'Surprise meter', where: 'out', weeks: [0, 1, 9], cost: 'instant',
    blurb: 'How surprised GPT-2 is by every token of your text: the number training pushes down.',
    nodes: ['cross-entropy-loss', 'training-loop', 'tokenization'], load: () => import('./surprise.js') },
  { id: 'lens', name: 'Logit lens', where: 'stream', weeks: [2, 3], cost: 'seconds',
    blurb: 'Read the residual stream after every layer as if it were the last, and watch the answer form.',
    nodes: ['logit-lens', 'residual-stream', 'unembedding', 'layernorm'], load: () => import('./lens.js') },
  { id: 'attention', name: 'Attention patterns', where: 'attn', weeks: [2, 3], cost: 'instant',
    blurb: 'Where each head looks, plus a fingerprint of all 144 heads: previous-token, duplicate and induction heads.',
    nodes: ['attention-pattern', 'attention-head', 'previous-token-head', 'induction-heads', 'induction-score', 'duplicate-token-head'],
    load: () => import('./attention.js') },
  { id: 'ov', name: 'OV circuit', where: 'attn', weeks: [3], cost: 'instant',
    blurb: 'If a head looks at a token, what does it write? Copying heads put the same token back.',
    nodes: ['ov-circuit', 'qk-circuit', 'factored-matrix', 'name-mover-head'], load: () => import('./ov.js') },
  { id: 'dla', name: 'Who wrote the answer', where: 'out', weeks: [3, 4], cost: 'instant',
    blurb: 'Split the final answer exactly into what every head, MLP and neuron wrote (direct logit attribution).',
    nodes: ['direct-logit-attribution', 'logit-difference', 'residual-stream'], load: () => import('./dla.js') },
  { id: 'ablate', name: 'Knock-out sweep', where: 'attn', weeks: [3, 4], cost: 'minutes on a processor',
    blurb: 'Switch off each of the 144 heads in turn and measure what breaks.',
    nodes: ['ablation', 'circuit', 'minimal-circuit'], load: () => import('./ablate.js') },
  { id: 'patch', name: 'Activation patching', where: 'stream', weeks: [4], cost: 'minutes on a processor',
    blurb: 'Swap one piece of a corrupted run with the clean one, and find where the answer lives.',
    nodes: ['activation-patching', 'denoising-vs-noising', 'indirect-object-identification', 'logit-difference', 'path-patching'],
    load: () => import('./patch.js') },
  { id: 'neurons', name: 'Neuron explorer', where: 'mlp', weeks: [3, 4], cost: 'instant',
    blurb: 'Which of the 36,864 neurons fire on your text; for any one, where it fires hardest across millions of tokens, what it writes, who it talks to, and what pushing it does.',
    nodes: ['mlp-layer', 'polysemanticity', 'superposition', 'max-activating-examples', 'feature'], load: () => import('./neurons.js') },
  { id: 'features', name: 'SAE features', where: 'stream', weeks: [4, 10, 11], cost: 'seconds, after a 39 MB download',
    blurb: 'Rewrite the stream at layer 7 as a few dozen features out of 24,576: what each fires on, writes, and does when pushed.',
    nodes: ['sparse-autoencoder', 'sae-latent', 'feature', 'superposition', 'max-activating-examples', 'dead-latent', 'sae-steering'],
    load: () => import('./features.js') },
  { id: 'steer', name: 'Steering', where: 'stream', weeks: [6, 10, 11], cost: 'seconds',
    blurb: 'Build a direction from two sets of sentences, add it while GPT-2 writes, and compare with random pushes.',
    nodes: ['steering-vector', 'contrastive-steering-vector', 'steering-hook', 'persona-vector'], load: () => import('./steer.js') },
  { id: 'probe', name: 'Linear probe', where: 'stream', weeks: [4, 5, 7, 11], cost: 'seconds',
    blurb: 'Is a property written as a straight line inside the model, and from which layer? With a shuffled-label control.',
    nodes: ['linear-probe', 'activation-pca', 'linear-representation-hypothesis', 'projection-monitoring'], load: () => import('./probe.js') },
];

export const toolById = (id) => TOOLS.find((t) => t.id === id);

/* concept-map node -> its label, film and 3D twin, from the films' own index (loaded once) */
let NODES = null;
export async function nodeIndex() {
  if (NODES) return NODES;
  try {
    const j = await (await fetch('../intuition/nodes/index.json')).json();
    NODES = {};
    for (const n of j.nodes || []) NODES[n.id] = n;
  } catch (e) { NODES = {}; }
  return NODES;
}
