"""The live lab: a small server on the PC that runs the lab's tools on a model held on the GPU, so the same pages that
run GPT-2 in the browser can run Qwen on the 3090. lab/core/remote.js is its client.

    python serve.py --lock Z:/tara-lab/gpulock.py

model.py runs one model with every hook point the browser engine has, recipes.py holds the tools' maths, wire.py
packs results with their arrays as raw bytes, and server.py answers the browser."""
