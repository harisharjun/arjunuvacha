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
  if (!e && level.decoyFaces && level.decoyFaces.includes(faceId(l))) decoy(t, s, l, n, level);
  if (e) {
    const wrap = el('g', {}, t);
    if ((e[2] === 1) !== l.x) wrap.setAttribute('transform', `rotate(180 ${s / 2} ${s / 2})`);
    el('use', { href: `#art-${n}` }, el('svg', { width: s, height: s, viewBox: `${e[0]} ${e[1]} 1 1` }, wrap));
  }
  if (edge) el('rect', { x: .5, y: .5, width: s - 1, height: s - 1, fill: 'none', stroke: EDGE, 'stroke-width': depth > 1 ? 1.6 : .5 }, t);
  return t;
}

// A piece of the same picture, cut across the grid and turned, on a face that is never
// part of the result. Its window never lines up with the squares, so it can't pass for
// a real piece, and it sits on the picture's edge, so it is never all ink or all blank.
function decoy(t, s, l, n, level) {
  const h = (l.i * 31 + (l.f ? 7 : 19) + n * 13) % 97, a = h * 2.399, r = Math.min(level.w, level.h) * .37;
  const ux = level.w / 2 + r * Math.cos(a) - .5, uy = level.h / 2 + r * Math.sin(a) - .5, turn = ((h % 4) * 90 + (l.x ? 180 : 0)) % 360;
  const wrap = el('g', { transform: `rotate(${turn} ${s / 2} ${s / 2})${h % 2 ? ` translate(${s} 0) scale(-1 1)` : ''}` }, t);
  el('use', { href: `#art-${n}` }, el('svg', { width: s, height: s, viewBox: `${ux} ${uy} 1 1` }, wrap));
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

// Where the paper sits. It stays put after a fold, so you can see what moved, and shifts
// only when it would leave `box` (the part of the board it may use), as far as it needs to.
export function fitted(cells, view, S, box) {
  const b = bounds(cells), out = { x: view.x, y: view.y };
  for (const [axis, lo0, hi0, min, max] of [['x', b.x0, b.x1, box.x0, box.x1], ['y', b.y0, b.y1, box.y0, box.y1]]) {
    const lo = lo0 * S + out[axis], hi = hi0 * S + out[axis];
    if (hi - lo > max - min) out[axis] += (min + max) / 2 - (lo + hi) / 2;
    else if (lo < min) out[axis] += min - lo;
    else if (hi > max) out[axis] -= hi - max;
  }
  return out;
}

// Moves a value from `from` to `to` over `ms`, easing out. If frames stall (a background
// tab, a phone saving power) it still finishes on time. Stops quietly once `alive` is false.
export function tween(from, to, ms, set, done, alive = () => true) {
  const t0 = performance.now();
  let ended = false;
  const end = () => {
    if (ended || !alive()) return;
    ended = true; clearTimeout(late); set(to);
    if (done) done();
  };
  const late = setTimeout(end, ms + 150);
  const step = (now) => {
    if (ended || !alive()) return;
    const t = ms ? Math.min(1, (now - t0) / ms) : 1;
    set(from + (to - from) * (1 - Math.pow(1 - t, 3)));
    if (t < 1) requestAnimationFrame(step); else end();
  };
  step(t0);
}

const TABLE = 'rgba(138, 122, 92, .10)';

// A fold in progress, drawn so it reads as paper turning over: the flap squashes toward
// its line, darkens as it turns away, casts a shadow on the paper it is heading for, and
// its free edge widens as it rises toward you. `set(c)` moves it, where c is the cosine of
// its angle: 1 lying flat, 0 standing up, -1 folded over. The sheet itself doesn't change.
export function makeFlap(svg, g, cells, line, level, n, S) {
  const tag = svg.id || 'paper', moved = movedCells(cells, line), inFlap = new Set(moved);
  const defs = [...svg.children].find((e) => e.tagName === 'defs') || el('defs', {}, svg);
  for (const k of moved) { const [x, y] = P(k); el('rect', { x: x * S + 1, y: y * S + 1, width: S - 2, height: S - 2, fill: TABLE, stroke: EDGE, 'stroke-dasharray': '3 3' }, g); }
  for (const [k, st] of cells) if (!inFlap.has(k)) { const [x, y] = P(k); tile(g, x, y, S, st[0], level, n, { depth: st.length }); }
  drawLines(g, cells, S, line);

  const pos = line.k * S, dir = line.side === 0 ? 1 : -1, across = moved.map((k) => P(k)[1 - line.ax]);
  const c0 = Math.min(...across) * S, c1 = (Math.max(...across) + 1) * S, mid = (c0 + c1) / 2;
  const reach = Math.max(...moved.map((k) => { const v = P(k)[line.ax]; return line.side === 0 ? pos - v * S : (v + 1) * S - pos; }));
  const grad = el('linearGradient', { id: `${tag}-shadow`, gradientUnits: 'userSpaceOnUse' }, defs);
  const shadow = el('rect', { fill: `url(#${tag}-shadow)`, opacity: 0 }, g);

  // The flap's squares, one group per column of squares, kept out of sight and drawn in strips below.
  const up = el('g', {}, g), over = el('g', { visibility: 'hidden' }, g), upShade = [], overShade = [], cols = {};
  const column = (side, col) => cols[side + col] || (cols[side + col] = el('g', { id: `${tag}-${side}${col}` }, defs));
  const shade = (t) => el('rect', { x: .5, y: .5, width: S - 1, height: S - 1, fill: '#000', opacity: 0 }, t);
  for (const k of moved) {
    const st = cells.get(k), p = P(k), q = reflect(p, line);
    upShade.push(shade(tile(column('u', p[line.ax]), p[0], p[1], S, st[0], level, n, { depth: st.length })));
    overShade.push(shade(tile(column('o', q[line.ax]), q[0], q[1], S, flip(st[st.length - 1], line.ax), level, n, { depth: st.length + 1 })));
  }
  // Each half is cut into thin strips across the fold, so the free edge can widen while
  // the crease keeps its width: a trapezoid, which a single SVG transform can't draw.
  const strips = [], STRIP = 5, count = Math.ceil(reach / STRIP);
  for (const [parent, side, toward] of [[up, 'u', -dir], [over, 'o', dir]]) {
    for (let i = 0; i < count; i++) {
      const lo = Math.min(pos + toward * i * STRIP, pos + toward * (i + 1) * STRIP), col = Math.floor((lo + .01) / S);
      if (!cols[side + col]) continue;
      const id = `${tag}-${side}s${i}`, clip = el('clipPath', { id, clipPathUnits: 'userSpaceOnUse' }, defs);
      el('rect', line.ax === 0 ? { x: lo - .3, width: STRIP + .6, y: c0 - 400, height: c1 - c0 + 800 } : { y: lo - .3, height: STRIP + .6, x: c0 - 400, width: c1 - c0 + 800 }, clip);
      strips.push({ use: el('use', { href: `#${tag}-${side}${col}` }, el('g', { 'clip-path': `url(#${id})` }, parent)), d: (i + .5) * STRIP });
    }
  }

  const squash = (s) => (line.ax === 0 ? `translate(${pos} 0) scale(${s} 1) translate(${-pos} 0)` : `translate(0 ${pos}) scale(1 ${s}) translate(0 ${-pos})`);
  const widen = (m) => (line.ax === 0 ? `translate(0 ${mid}) scale(1 ${m}) translate(0 ${-mid})` : `translate(${mid} 0) scale(${m} 1) translate(${-mid} 0)`);
  let now = 1;
  function set(c) {
    c = Math.max(-1, Math.min(1, c));
    now = c;
    const lift = Math.sqrt(1 - c * c), front = c >= 0;
    up.setAttribute('visibility', front ? 'visible' : 'hidden');
    over.setAttribute('visibility', front ? 'hidden' : 'visible');
    (front ? up : over).setAttribute('transform', squash(Math.max(Math.abs(c), .002)));
    for (const r of front ? upShade : overShade) r.setAttribute('opacity', (.42 * (1 - Math.abs(c))).toFixed(3));
    for (const s of strips) s.use.setAttribute('transform', widen(1 + .22 * lift * Math.min(1, s.d / reach)));
    // Darkest at the crease, reaching past the flap's edge, gone once it lands.
    const w = reach * Math.max(0, -c) + Math.min(reach, S) * .9 * lift + 4, a = pos, b = pos + dir * w;
    grad.innerHTML = `<stop offset="0" stop-color="#1b1408" stop-opacity="${(.78 * lift).toFixed(3)}"/><stop offset=".3" stop-color="#1b1408" stop-opacity="${(.42 * lift).toFixed(3)}"/><stop offset="1" stop-color="#1b1408" stop-opacity="0"/>`;
    if (line.ax === 0) { grad.setAttribute('x1', a); grad.setAttribute('x2', b); grad.setAttribute('y1', 0); grad.setAttribute('y2', 0); }
    else { grad.setAttribute('y1', a); grad.setAttribute('y2', b); grad.setAttribute('x1', 0); grad.setAttribute('x2', 0); }
    const lo = Math.min(a, b), len = Math.abs(b - a);
    if (line.ax === 0) { shadow.setAttribute('x', lo); shadow.setAttribute('width', len); shadow.setAttribute('y', c0); shadow.setAttribute('height', c1 - c0); }
    else { shadow.setAttribute('y', lo); shadow.setAttribute('height', len); shadow.setAttribute('x', c0); shadow.setAttribute('width', c1 - c0); }
    shadow.setAttribute('opacity', lift > .01 ? 1 : 0);
  }
  set(1);
  return { line, set, get c() { return now; } };
}
