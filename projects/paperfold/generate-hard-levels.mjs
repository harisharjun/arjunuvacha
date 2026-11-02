// Paperfold levels 26-50: decoy prints, more folds and bigger sheets, up to 5x5 so
// the squares stay big enough on a phone. Solves every fold of each sheet, keeps
// puzzles with one shortest route, and prefers ones where a wrong first fold ends
// close to the picture (a near miss). `node generate-hard-levels.mjs` writes
// static/games/paperfold/levels-hard.js; copy it to public/ as with every static file.
// Run with --max-old-space-size=6000: six folds of a 5x5 sheet is 400,000 positions.
import fs from 'fs';
import { K, P, bounds, applyFold, allFolds, startCells, faceId, isSolved, stateKey } from '../../static/games/paperfold/engine.js';

const topKey = (c, pose = true) => {
  const b = bounds(c);
  return [...c].map(([k, v]) => {
    const [x, y] = P(k), l = v[0];
    return K(x - b.x0, y - b.y0) + ':' + faceId(l) + (pose ? (l.x ? 1 : 0) + '' + (l.y ? 1 : 0) : '');
  }).sort().join('|');
};

function explore(sheet, depth) {
  let layer = [{ c: startCells(sheet), p: 1, seq: [] }];
  const seen = new Set([stateKey(layer[0].c)]), targets = new Map(), poses = new Map();
  for (let d = 1; d <= depth; d++) {
    const next = new Map();
    for (const { c, p, seq } of layer) for (const f of allFolds(c)) {
      const a = applyFold(c, f), t = topKey(a), q = seq.concat(f), e = targets.get(t);
      if (!e) targets.set(t, { d, p, c: a, seq: q });
      else if (e.d === d) e.p += p;
      const pf = topKey(a, false);
      if (!poses.has(pf)) poses.set(pf, new Set());
      poses.get(pf).add(t);
      const k = stateKey(a);
      if (seen.has(k)) continue;
      const o = next.get(k);
      if (o) o.p += p; else next.set(k, { c: a, p, seq: q });
    }
    for (const k of next.keys()) seen.add(k);
    layer = [...next.values()];
  }
  for (const e of targets.values()) e.pf = poses.get(topKey(e.c, false)).size;
  return { targets, finals: layer, positions: seen.size - 1 };
}

// Results of a different first fold that end within two squares of the picture.
function nearMisses(target, finals, first) {
  const b = bounds(target), want = new Map();
  for (const [k, v] of target) { const [x, y] = P(k), l = v[0]; want.set(K(x - b.x0, y - b.y0), faceId(l) + (l.x ? 1 : 0) + (l.y ? 1 : 0)); }
  let near = 0;
  for (const { c, seq } of finals) {
    const f = seq[0];
    if ((f.ax === first.ax && f.k === first.k && f.side === first.side) || c.size !== want.size) continue;
    const q = bounds(c);
    if (q.x1 - q.x0 !== b.x1 - b.x0 || q.y1 - q.y0 !== b.y1 - b.y0) continue;
    let miss = 0;
    for (const [k, v] of c) {
      const [x, y] = P(k), l = v[0];
      if (want.get(K(x - q.x0, y - q.y0)) !== faceId(l) + (l.x ? 1 : 0) + (l.y ? 1 : 0) && ++miss > 2) break;
    }
    if (miss > 0 && miss <= 2) near++;
  }
  return near;
}

const S4 = ['####', '####', '####', '####'];
const S55 = ['#####', '#####', '#####', '#####', '#####'], NOTCH = ['#####', '#####', '###..', '###..', '###..'];
const T5 = ['#####', '#####', '.###.', '.###.', '.###.'], PLUS5 = ['.###.', '#####', '#####', '#####', '.###.'], U5 = ['##.##', '##.##', '#####', '#####', '#####'];
const CHAPTERS = [
  { folds: 3, sheets: [S4, ['####', '####', '.##.', '.##.'], ['##..', '##..', '####', '####'], ['.##.', '####', '####', '.##.'], ['####', '####', '####']] },
  { folds: 4, sheets: [['#####', '#####', '#####', '#####'], ['####', '####', '####', '####', '####'], ['#####', '#####', '###..', '###..'], ['####', '####', '####', '##..', '##..'], ['.###.', '#####', '#####', '.###.']] },
  { folds: 4, sheets: [S55, NOTCH, T5, PLUS5, U5] },
  { folds: 5, sheets: [S55, NOTCH, T5, PLUS5, U5] },
  { folds: 6, sheets: [S55, NOTCH, T5, PLUS5, U5] },
];
const PICTURES = {
  wide: ['boat', 'fish', 'whale', 'mountain', 'hills'],
  tall: ['rocket', 'lighthouse', 'tree', 'cactus', 'lamp', 'key'],
  square: ['anchor', 'umbrella', 'cup', 'leaf', 'crown', 'bell', 'apple', 'mushroom', 'cat', 'star', 'moon', 'sun', 'house', 'bird', 'flower'],
};
const take = (shape) => { const p = PICTURES[shape], a = p.shift(); p.push(a); return a; };

// Difficulty has to rise with every level. In a chapter each level uses its own sheet,
// the sheets in order of positions to search, and across the ladder the folds and the
// near misses never drop. Chapters are chained from the top down, so each level has as
// many near misses as it can without passing the level above it.
const chapterPools = CHAPTERS.map((ch) => {
  const pools = [];
  for (const sheet of ch.sheets) {
    const { targets, finals, positions } = explore(sheet, ch.folds);
    let cand = [];
    for (const [minCells, maxRoutes] of ch.folds === 3 ? [[4, 1]] : [[6, 1], [4, 1]]) {
      cand = [...targets.values()].filter((e) => {
        if (e.d !== ch.folds || e.p > maxRoutes || e.pf !== 1) return false;
        const b = bounds(e.c), w = b.x1 - b.x0, h = b.y1 - b.y0;
        if (e.c.size !== w * h || w < 2 || h < 2 || w > 4 || h > 4 || e.c.size < minCells) return false;
        const tops = [...e.c.values()].map((v) => v[0].f);
        return tops.some(Boolean) && !tops.every(Boolean);
      });
      if (cand.length) break;
    }
    cand.sort((a, b) => b.c.size - a.c.size);
    // One puzzle per near-miss count, the biggest picture for that count.
    const byNear = new Map();
    for (const e of cand.slice(0, ch.folds >= 6 ? 60 : ch.folds === 5 ? 120 : 400)) {
      const n = nearMisses(e.c, finals, e.seq[0]);
      if (!byNear.has(n)) byNear.set(n, { e, n, sheet, positions });
    }
    pools.push({ positions, items: [...byNear.values()].sort((x, y) => x.n - y.n) });
  }
  return pools.sort((a, b) => a.positions - b.positions);
});

// The chain through one chapter's sheets with the most near misses, none above `cap`.
function bestChain(pools, cap) {
  let tails = [{ total: 0, n: Infinity, chain: [] }];
  for (let i = pools.length - 1; i >= 0; i--) {
    const next = [];
    for (const x of pools[i].items) {
      if (x.n > cap) continue;
      const usable = tails.filter((t) => x.n <= t.n);
      if (!usable.length) continue;
      const t = usable.reduce((a, b) => (b.total > a.total ? b : a));
      next.push({ total: t.total + x.n, n: x.n, chain: [x, ...t.chain] });
    }
    tails = next;
  }
  if (!tails.length) throw new Error(`no chain at or below ${cap} near misses`);
  return tails.reduce((a, b) => (b.total > a.total ? b : a)).chain;
}

const chains = [];
let cap = Infinity;
for (let i = CHAPTERS.length - 1; i >= 0; i--) {
  const chain = bestChain(chapterPools[i], cap);
  chains[i] = chain;
  cap = chain[0].n;
}

const out = [];
chains.forEach((chain, ci) => {
  for (const m of chain) {
    const b = bounds(m.e.c), w = b.x1 - b.x0, h = b.y1 - b.y0, fin = {};
    for (const [k, v] of m.e.c) { const [x, y] = P(k), l = v[0]; fin[faceId(l)] = [x - b.x0, y - b.y0, l.x ? 1 : 0, l.y ? 1 : 0]; }
    const art = take(w > h ? 'wide' : h > w ? 'tall' : 'square');
    const level = { sheet: m.sheet, par: CHAPTERS[ci].folds, w, h, art, fin, decoys: true, route: m.e.seq };
    let c = startCells(m.sheet);
    for (const f of m.e.seq) c = applyFold(c, f);
    if (!isSolved(c, level)) throw new Error('route does not solve the level');
    out.push(level);
    console.log(`level ${25 + out.length} chapter ${ci + 1} folds ${level.par} sheet ${m.sheet.join('/')} positions ${m.positions} near ${m.n} picture ${art} ${w}x${h}`);
  }
});
const body = out.map((x) => '  ' + JSON.stringify(x)).join(',\n');
fs.writeFileSync(new URL('../../static/games/paperfold/levels-hard.js', import.meta.url),
  `// Levels 26-50, from projects/paperfold/generate-hard-levels.mjs. Do not edit by hand.\nexport const HARD_LEVELS = [\n${body}\n];\n`);
