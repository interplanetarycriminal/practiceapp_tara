/* lab/ui/river.js: GPT-2 drawn as a river, with every tool pinned where it looks.

   The allegory, kept accurate: each token has its own channel of water (its residual stream, 768 numbers) flowing
   up through 12 layers. Attention heads are the only bridges between channels, and they only carry water from
   earlier channels to later ones. MLPs are mills that work inside one channel. Every layer reads the water and pours
   its result back in, so the water at the top is the sum of everything poured in; the top of the last channel is
   read out as the next-token bet. */

import { TOOLS } from './tools/index.js';

const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  for (const k of kids) if (k) el.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
  return el;
}

/* where each tool's leader line lands (x, y in the 400 x 540 drawing) */
const TARGET = {
  next: [262, 52], surprise: [222, 58], dla: [246, 96],
  lens: [262, 222], probe: [262, 300], steer: [192, 342], patch: [122, 410],
  attention: [150, 368], ov: [200, 258], ablate: [130, 150],
  neurons: [262, 186],
};
const ORDER = ['next', 'surprise', 'dla', 'ablate', 'neurons', 'lens', 'ov', 'probe', 'steer', 'attention', 'patch'];

export function riverMap({ onPick } = {}) {
  const svg = s('svg', { class: 'river', viewBox: '0 0 400 540', role: 'group', 'aria-label': 'GPT-2 as a river, with the lab\'s tools pinned where they look' });
  const lanes = [60, 130, 200, 262], tok = ['The', ' cat', ' sat', ' on'];
  const g = s('g');
  // channels: one per token
  lanes.forEach((x, i) => {
    g.appendChild(s('rect', { x: x - 17, y: 70, width: 34, height: 410, rx: 10, class: 'lane' }));
    g.appendChild(s('text', { x, y: 508, class: 'tok', 'text-anchor': 'middle' }, tok[i].replace(' ', '␣')));
    g.appendChild(s('path', { d: `M${x} 490 L${x} 482`, stroke: 'var(--muted)', 'stroke-width': 1.2 }));
  });
  g.appendChild(s('text', { x: 160, y: 530, class: 'cap', 'text-anchor': 'middle' }, 'tokens in: each gets its own channel'));
  // three of the twelve blocks
  const blocks = [[400, 'layer 0'], [290, 'layers 1–10'], [170, 'layer 11']];
  for (const [y, name] of blocks) {
    g.appendChild(s('rect', { x: 30, y: y - 42, width: 262, height: 72, rx: 8, class: 'blk', 'fill-opacity': 0.0 }));
    g.appendChild(s('text', { x: 34, y: y - 46, class: 'cap' }, name));
    // attention bridges: from earlier channels into later ones only
    lanes.forEach((x2, j) => {
      for (let i = 0; i < j; i++) {
        const x1 = lanes[i];
        if (j - i > 2) continue;
        g.appendChild(s('path', { d: `M${x1} ${y + 18} C ${x1 + 10} ${y - 4}, ${x2 - 20} ${y - 4}, ${x2 - 3} ${y + 2}`, class: 'bridge', 'marker-end': 'url(#arrow)' }));
      }
    });
    // mills: one MLP per channel
    lanes.forEach((x) => g.appendChild(s('rect', { x: x - 9, y: y - 32, width: 18, height: 14, rx: 3, class: 'mill' })));
  }
  g.appendChild(s('text', { x: 160, y: 238, class: 'cap', 'text-anchor': 'middle' }, '⋮'));
  // read-out at the top of the last channel
  g.appendChild(s('rect', { x: 216, y: 30, width: 92, height: 30, rx: 6, class: 'blk' }));
  g.appendChild(s('text', { x: 262, y: 50, class: 'tok', 'text-anchor': 'middle' }, '␣the 41%'));
  g.appendChild(s('text', { x: 212, y: 22, class: 'cap' }, 'read out: the next-token bet'));
  // legend of shapes
  g.appendChild(s('rect', { x: 10, y: 6, width: 12, height: 10, rx: 3, class: 'mill' }));
  g.appendChild(s('text', { x: 26, y: 15, class: 'cap' }, 'MLP: a mill inside one channel'));
  g.appendChild(s('path', { d: 'M10 34 C 16 26, 24 26, 30 30', class: 'bridge' }));
  g.appendChild(s('text', { x: 34, y: 36, class: 'cap' }, 'attention: a bridge'));
  g.appendChild(s('text', { x: 34, y: 50, class: 'cap' }, 'from earlier channels'));
  const defs = s('defs', {}, s('marker', { id: 'arrow', viewBox: '0 0 8 8', refX: 6, refY: 4, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' },
    s('path', { d: 'M0 0 L8 4 L0 8 z', fill: 'var(--accent)', opacity: 0.8 })));
  svg.appendChild(defs);
  svg.appendChild(g);
  // pins
  ORDER.forEach((id, k) => {
    const t = TOOLS.find((x) => x.id === id);
    const y = 36 + k * 44, x = 318;
    const [tx, ty] = TARGET[id];
    const a = s('a', { href: `#tool/${id}`, class: 'pin', tabindex: 0, 'aria-label': `${t.name}: ${t.blurb}` });
    a.appendChild(s('path', { d: `M${x} ${y} L${tx + 8} ${ty}`, stroke: 'var(--muted)', 'stroke-width': 1, fill: 'none', 'stroke-dasharray': '0' }));
    a.appendChild(s('circle', { cx: tx, cy: ty, r: 5 }));
    const label = short(t.name);
    const w = 8 + label.length * 6.6;
    a.appendChild(s('rect', { x, y: y - 12, width: Math.min(80, w), height: 24, rx: 12 }));
    a.appendChild(s('text', { x: x + Math.min(80, w) / 2, y: y + 4.5, 'text-anchor': 'middle' }, label));
    if (onPick) a.addEventListener('click', (ev) => { ev.preventDefault(); onPick(id); });
    svg.appendChild(a);
  });
  return svg;
}

function short(name) {
  return { 'What comes next': 'Next token', 'Who wrote the answer': 'Who wrote it', 'Attention patterns': 'Attention',
    'Knock-out sweep': 'Knock-out', 'Activation patching': 'Patching', 'Neuron explorer': 'Neurons', 'Linear probe': 'Probe',
    'Surprise meter': 'Surprise' }[name] || name;
}
