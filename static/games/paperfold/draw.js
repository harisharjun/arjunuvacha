// Drawing paper, shared by the game and How to play.
import { K, P, faceId, flip, bounds, creases, movedCells, reflect } from './engine.js';

const NS = 'http://www.w3.org/2000/svg';
export const FRONT = '#F3E9D2', BACK = '#D85A30', EDGE = '#8A7A5C', GOLD = '#EF9F27', ACTIVE = '#993C1D';

export const el = (name, attrs, parent) => {
  const e = document.createElementNS(NS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
};

// One square of paper, showing its part of the picture if this face has one. A face
// that has not reached its final turn shows its part upside down, as printed paper would.
export function tile(parent, x, y, s, l, level, n, { edge = true, depth = 1, data = false } = {}) {
  const t = el('g', { transform: `translate(${x * s} ${y * s})` }, parent);
  const a = { x: .5, y: .5, width: s - 1, height: s - 1, fill: l.f ? FRONT : BACK };
  if (data) { a['data-x'] = x; a['data-y'] = y; }
  el('rect', a, t);
  const e = level.fin[faceId(l)];
  if (e) {
    const wrap = el('g', {}, t);
    if ((e[2] === 1) !== l.x) wrap.setAttribute('transform', `rotate(180 ${s / 2} ${s / 2})`);
    el('use', { href: `#art-${n}` }, el('svg', { width: s, height: s, viewBox: `${e[0]} ${e[1]} 1 1` }, wrap));
  }
  if (edge) el('rect', { x: .5, y: .5, width: s - 1, height: s - 1, fill: 'none', stroke: EDGE, 'stroke-width': depth > 1 ? 1.6 : .5 }, t);
  return t;
}

// The finished picture, for the target box and the level map.
export function picture(parent, level, n, s, edge) {
  for (const k of Object.keys(level.fin)) {
    const e = level.fin[k];
    tile(parent, e[0], e[1], s, { i: parseInt(k, 10), f: k.endsWith('F'), x: e[2] === 1, y: e[3] === 1 }, level, n, { edge });
  }
}

export function drawLines(g, cells, S, active) {
  for (const ax of [0, 1]) for (const k of creases(cells, ax)) {
    const on = active && active.ax === ax && active.k === k;
    if (active && !on) continue;
    const b = bounds(cells), lo = ax === 0 ? b.y0 : b.x0, hi = ax === 0 ? b.y1 : b.x1, sides = [];
    for (let t = lo; t < hi; t++) {
      const A = cells.has(ax === 0 ? K(k - 1, t) : K(t, k - 1)), B = cells.has(ax === 0 ? K(k, t) : K(t, k));
      sides.push({ t, both: A && B, any: A || B });
    }
    // Across the paper only; along an edge just when the paper does not cross the line at all.
    const use = sides.some((u) => u.both) ? sides.filter((u) => u.both) : sides.filter((u) => u.any);
    for (const { t } of use) {
      const a = ax === 0 ? { x1: k * S, x2: k * S, y1: t * S, y2: (t + 1) * S } : { x1: t * S, x2: (t + 1) * S, y1: k * S, y2: k * S };
      el('line', a, g).setAttribute('style', `stroke:${on ? ACTIVE : '#6b6b6b'};stroke-width:${on ? 2.5 : 1.25};stroke-dasharray:${on ? 'none' : '5 4'};pointer-events:none`);
    }
  }
}

// Fold the paper over its line on screen, without changing the sheet itself.
export function drawFold(g, cells, c, level, n, S, { ms = 200, alive = () => true } = {}) {
  const moved = movedCells(cells, c), set = new Set(moved);
  for (const k of moved) { const [x, y] = P(k); el('rect', { x: x * S + 1, y: y * S + 1, width: S - 2, height: S - 2, fill: 'none', stroke: EDGE, 'stroke-dasharray': '3 3' }, g); }
  for (const [k, st] of cells) if (!set.has(k)) { const [x, y] = P(k); tile(g, x, y, S, st[0], level, n, { depth: st.length }); }
  drawLines(g, cells, S, c);
  const up = el('g', {}, g), over = el('g', { visibility: 'hidden' }, g);
  for (const k of moved) {
    const st = cells.get(k), [x, y] = P(k), [qx, qy] = reflect([x, y], c);
    tile(up, x, y, S, st[0], level, n, { depth: st.length });
    tile(over, qx, qy, S, flip(st[st.length - 1], c.ax), level, n, { depth: st.length + 1 });
  }
  const pos = c.k * S;
  const squash = (s) => (c.ax === 0 ? `translate(${pos} 0) scale(${s} 1) translate(${-pos} 0)` : `translate(0 ${pos}) scale(1 ${s}) translate(0 ${-pos})`);
  const t0 = performance.now();
  const step = (now) => {
    if (!alive()) return;
    const t = ms ? Math.min(1, (now - t0) / ms) : 1, s = 1 - 2 * t * t * (3 - 2 * t);
    if (s >= 0) up.setAttribute('transform', squash(Math.max(s, .001)));
    else { up.setAttribute('visibility', 'hidden'); over.setAttribute('visibility', 'visible'); over.setAttribute('transform', squash(Math.max(-s, .001))); }
    if (t < 1) requestAnimationFrame(step);
  };
  step(t0);
}
