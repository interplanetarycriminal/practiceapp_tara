# GPT-2 small, quantised for the lab

OpenAI's GPT-2 small (124M parameters, 12 layers, 12 heads, d_model 768), the model ARENA's interpretability chapter
uses through TransformerLens. Weights from the ONNX Model Zoo export of the Hugging Face checkpoint
(`gpt2-lm-head-10.onnx`, sha256 12fbb1ec...8f35), quantised for phones:

- every matrix is int8 in groups of 64 along its input axis, one fp16 scale per (output, group), stored output-major;
- the token embedding (also the unembedding) keeps its 64 most output-sensitive columns in fp16 and the other 704 in
  int8; position embeddings fp16; norms and biases fp32. `manifest.json` lists every tensor.

Against the fp32 model on held-out text: same top-1 token 98.8% of the time, mean KL 0.0005, and the IOI logit
difference 2.02-2.05 versus 2.006. Total 133 MB.

`bpe.json` is GPT-2's byte-pair vocabulary and merge list, from OpenAI's `encoder.json` and `vocab.bpe` (as shipped in
the MIT-licensed `gpt-3-encoder` npm package).

GPT-2 is released by OpenAI under a modified MIT licence; see `LICENSE-GPT2.txt`.
