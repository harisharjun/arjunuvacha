// The rules of Paperfold. A sheet is a map of "x,y" to a stack of layers, top first.
// Each layer knows which cell it is, which face is up, and how it has been flipped.
export const K = (x, y) => x + ',' + y;
export const P = (k) => k.split(',').map(Number);
export const faceId = (l) => l.i + (l.f ? 'F' : 'B');
export const flip = (l, ax) => ({ i: l.i, f: !l.f, x: ax === 0 ? !l.x : l.x, y: ax === 1 ? !l.y : l.y });

export function startCells(sheet) {
  const cells = new Map();
  let i = 0;
  sheet.forEach((row, y) => [...row].forEach((c, x) => {
    if (c === '#') cells.set(K(x, y), [{ i: i++, f: true, x: false, y: false }]);
  }));
  return cells;
}

export function bounds(cells) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of cells.keys()) {
    const [x, y] = P(k);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1);
  }
  return { x0, y0, x1, y1 };
}

// The lines a fold can use on an axis (0: vertical lines, 1: horizontal lines).
export function creases(cells, ax) {
  const b = bounds(cells), out = [];
  for (let k = (ax === 0 ? b.x0 : b.y0) + 1; k < (ax === 0 ? b.x1 : b.y1); k++) out.push(k);
  return out;
}

// A fold is { ax, k, side }: side 0 moves what is before line k, side 1 what is after it.
export function movedCells(cells, c) {
  return [...cells.keys()].filter((k) => (P(k)[c.ax] < c.k) === (c.side === 0));
}

export const reflect = ([x, y], c) => (c.ax === 0 ? [2 * c.k - 1 - x, y] : [x, 2 * c.k - 1 - y]);

export function applyFold(cells, c) {
  const moved = movedCells(cells, c), set = new Set(moved), next = new Map();
  for (const [k, v] of cells) if (!set.has(k)) next.set(k, v);
  for (const k of moved) {
    const [x, y] = reflect(P(k), c), to = K(x, y);
    const turned = [...cells.get(k)].reverse().map((l) => flip(l, c.ax));
    next.set(to, turned.concat(next.get(to) || []));
  }
  return next;
}

// Solved when the top faces are the target's, each where and how it should be.
export function isSolved(cells, level) {
  const b = bounds(cells);
  if (b.x1 - b.x0 !== level.w || b.y1 - b.y0 !== level.h || cells.size !== level.w * level.h) return false;
  for (const [k, stack] of cells) {
    const [x, y] = P(k), top = stack[0], e = level.fin[faceId(top)];
    if (!e || e[0] !== x - b.x0 || e[1] !== y - b.y0 || (e[2] === 1) !== top.x || (e[3] === 1) !== top.y) return false;
  }
  return true;
}

function stateKey(cells) {
  const b = bounds(cells);
  return [...cells].map(([k, v]) => {
    const [x, y] = P(k);
    return K(x - b.x0, y - b.y0) + ':' + v.map((l) => faceId(l) + (l.x ? 1 : 0) + (l.y ? 1 : 0)).join('.');
  }).sort().join('|');
}

export function allFolds(cells) {
  const out = [];
  for (const ax of [0, 1]) for (const k of creases(cells, ax)) for (const side of [0, 1]) out.push({ ax, k, side });
  return out;
}

// The folds of a shortest route to the target, or null if none within maxDepth.
export function solve(cells, level, maxDepth = 4) {
  if (isSolved(cells, level)) return [];
  let layer = [{ cells, route: [] }];
  const seen = new Set([stateKey(cells)]);
  for (let d = 0; d < maxDepth; d++) {
    const next = [];
    for (const s of layer) for (const fold of allFolds(s.cells)) {
      const after = applyFold(s.cells, fold), route = s.route.concat(fold);
      if (isSolved(after, level)) return route;
      const key = stateKey(after);
      if (!seen.has(key)) { seen.add(key); next.push({ cells: after, route }); }
    }
    layer = next;
  }
  return null;
}
