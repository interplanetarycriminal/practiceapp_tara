/* lab/core/bpe.js: GPT-2's byte-pair tokenizer, written from the published algorithm
   (OpenAI's encoder.py). Data: lab/model/bpe.json = {vocab: [50257 byte-level strings], merges: [50000 "a b"]}.
   Works in a page, a worker and Node. */

const PAT = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

function bytesToUnicode() {
  const bs = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
  const m = new Map();
  bs.forEach((b, i) => m.set(b, String.fromCharCode(cs[i])));
  return m;
}

export class BPE {
  constructor(data) {
    this.vocab = data.vocab;
    this.enc = new Map();
    this.vocab.forEach((t, i) => this.enc.set(t, i));
    this.ranks = new Map();
    data.merges.forEach((m, i) => this.ranks.set(m, i));
    this.b2u = bytesToUnicode();
    this.u2b = new Map();
    for (const [b, u] of this.b2u) this.u2b.set(u, b);
    this.cache = new Map();
    this.te = new TextEncoder();
    this.td = new TextDecoder('utf-8', { fatal: false });
  }
  bpe(token) {
    const hit = this.cache.get(token);
    if (hit) return hit;
    let word = Array.from(token);
    while (word.length > 1) {
      let best = -1, bestRank = Infinity;
      for (let i = 0; i < word.length - 1; i++) {
        const r = this.ranks.get(word[i] + ' ' + word[i + 1]);
        if (r !== undefined && r < bestRank) { bestRank = r; best = i; }
      }
      if (best < 0) break;
      const a = word[best], b = word[best + 1], out = [];
      for (let i = 0; i < word.length;) {
        if (i < word.length - 1 && word[i] === a && word[i + 1] === b) { out.push(a + b); i += 2; }
        else { out.push(word[i]); i++; }
      }
      word = out;
    }
    if (this.cache.size > 20000) this.cache.clear();
    this.cache.set(token, word);
    return word;
  }
  encode(text) {
    const ids = [];
    for (const m of text.matchAll(PAT)) {
      let u = '';
      for (const b of this.te.encode(m[0])) u += this.b2u.get(b);
      for (const p of this.bpe(u)) ids.push(this.enc.get(p));
    }
    return ids;
  }
  bytes(ids) {
    const out = [];
    for (const id of ids) for (const ch of this.vocab[id]) out.push(this.u2b.get(ch));
    return new Uint8Array(out);
  }
  decode(ids) { return this.td.decode(this.bytes(ids)); }
  /* One display string per token. A token that is only part of a multi-byte character shows as
     the joined character on the last token that completes it, and as '' on the earlier ones. */
  pieces(ids) {
    const out = [];
    let pend = [];
    for (let i = 0; i < ids.length; i++) {
      pend.push(ids[i]);
      const s = this.td.decode(this.bytes(pend));
      if (s.includes('�') && i < ids.length - 1 && pend.length < 4) { out.push(''); continue; }
      out.push(s);
      pend = [];
    }
    return out;
  }
  piece(id) { return this.decode([id]); }
}
