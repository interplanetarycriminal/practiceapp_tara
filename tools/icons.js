'use strict';
/* tools/icons.js — the TARA mark, generated. A paper "T" on an accent tile.
   Colours come from the app's own CSS custom properties (--accent, --paper). */

const { encodePNG, canvas, hex } = require('./png.js');

/** Draw the mark at `size` px. `mode`:
 *   'any'      rounded tile, transparent corners  (favicon / normal icon)
 *   'maskable' full-bleed tile, glyph inside the 80% safe zone
 */
function mark(size, mode, accent, paper) {
  const A = hex(accent), P = hex(paper);
  const c = canvas(size, 4);
  const s = size;
  if (mode === 'maskable') c.fillRect(0, 0, s, s, A);
  else c.fillRoundRect(0, 0, s, s, s * 0.22, A);

  /* glyph box: 62% of the tile for 'any', 52% for 'maskable' (safe zone) */
  const g = mode === 'maskable' ? 0.52 : 0.62;
  const gw = s * g, gx = (s - gw) / 2, gy = (s - gw) / 2;

  const barH = gw * 0.20;
  const stemW = gw * 0.22;
  const r = barH * 0.22;

  /* top bar */
  c.fillRoundRect(gx, gy, gw, barH, r, P);
  /* stem */
  c.fillRoundRect(gx + (gw - stemW) / 2, gy + barH * 0.92, stemW, gw - barH * 0.92, r, P);

  return encodePNG(s, s, c.resolve());
}

function svg(accent, paper) {
  /* Same geometry as mark(512,'any'): tile 512, r=112.6, glyph box 317.4 @ 97.3 */
  const gw = 512 * 0.62, gx = (512 - gw) / 2, gy = gx;
  const barH = gw * 0.20, stemW = gw * 0.22, r = barH * 0.22;
  const n = (x) => Number(x.toFixed(2));
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="TARA">',
    `  <rect x="0" y="0" width="512" height="512" rx="${n(512 * 0.22)}" ry="${n(512 * 0.22)}" fill="${accent}"/>`,
    `  <rect x="${n(gx)}" y="${n(gy)}" width="${n(gw)}" height="${n(barH)}" rx="${n(r)}" fill="${paper}"/>`,
    `  <rect x="${n(gx + (gw - stemW) / 2)}" y="${n(gy + barH * 0.92)}" width="${n(stemW)}" height="${n(gw - barH * 0.92)}" rx="${n(r)}" fill="${paper}"/>`,
    '</svg>',
    ''
  ].join('\n');
}

module.exports = { mark, svg };
