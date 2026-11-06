// Paperfold levels 26-50. Each level is 10% harder than level 25, by one difficulty
// score: level 25 + n scores x(1 + 0.1n), where x is level 25's score.
//
// The score is the number of positions a player can reach within the level's target
// folds (how much there is to search), raised by the decoy prints:
//     score = positions x (1 + 2.5 x decoy share)
// The decoy share is the share of the sheet's spare faces (faces that are never part of the
// picture) that carry a print anyway, so blank squares stop giving the answer away. With
// every spare face printed a sheet counts as 3.5 times harder. That weight is a judgement:
// the old level 26 had fewer positions than level 25 (472 against 832) but every spare
// face printed, and players who finished 1-25 got stuck on it.
//
// Decoys are the dial. They start with one print at level 26 and only ever grow, by at
// most two a level, on 3-fold sheets about the size of level 25's, until every spare face is
// printed at level 50. Bigger sheets would jump the positions up and force the decoys back
// down to keep the score on target, so they are left for later levels.
//
// `node generate-hard-levels.mjs` writes static/games/paperfold/levels-hard.js; copy it to
// public/ as with every static file.
import fs from 'fs';
import { K, P, bounds, applyFold, allFolds, startCells, faceId, isSolved, stateKey } from '../../static/games/paperfold/engine.js';
import { LEVELS } from '../../static/games/paperfold/levels.js';

const FOLDS = 3, STEP = .1, DECOY_WEIGHT = 2.5;
const score = (positions, decoyShare) => positions * (1 + DECOY_WEIGHT * decoyShare);

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

function finOf(c) {
  const b = bounds(c), fin = {};
  for (const [k, v] of c) { const [x, y] = P(k), l = v[0]; fin[faceId(l)] = [x - b.x0, y - b.y0, l.x ? 1 : 0, l.y ? 1 : 0]; }
  return fin;
}

// The same shuffle every run, so regenerating gives the same levels.
function shuffled(list, seed) {
  const out = [...list];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// 3-fold sheets about the size of level 25's.
const SHEETS = [
  ['####', '####', '####', '####'],
  ['##..', '##..', '####', '####'],
  ['####', '####', '.##.', '.##.'],
  ['.##.', '####', '####', '.##.'],
];
// Every picture here is 2x3 or 3x2. The square pictures sit centred in either, so they
// share out between the two to keep repeats down.
const PICTURES = {
  wide: ['boat', 'fish', 'whale', 'mountain', 'hills', 'bird', 'crown', 'sun', 'star', 'flower', 'house'],
  tall: ['rocket', 'lighthouse', 'tree', 'cactus', 'lamp', 'key', 'umbrella', 'cup', 'bell', 'apple', 'mushroom', 'cat', 'anchor', 'leaf', 'moon'],
};
const take = (shape) => { const p = PICTURES[shape], a = p.shift(); p.push(a); return a; };

// x: level 25's score. It has no decoys, so its score is its positions.
const level25 = LEVELS[24];
const x = explore(level25.sheet, level25.par).positions;
const easy = new Set(LEVELS.slice(0, 25).map((l) => l.sheet.join('/') + JSON.stringify(l.fin)));

const pools = SHEETS.map((sheet) => {
  const { targets, finals, positions } = explore(sheet, FOLDS);
  const cand = [];
  for (const e of targets.values()) {
    if (e.d !== FOLDS || e.p !== 1 || e.pf !== 1) continue;
    const b = bounds(e.c), w = b.x1 - b.x0, h = b.y1 - b.y0;
    if (e.c.size !== w * h || w < 2 || h < 2 || w > 4 || h > 4) continue;
    const tops = [...e.c.values()].map((v) => v[0].f);
    if (!tops.some(Boolean) || tops.every(Boolean)) continue;
    if (easy.has(sheet.join('/') + JSON.stringify(finOf(e.c)))) continue;
    // Six-square pictures throughout, so every level on a sheet has the same spare faces.
    if (e.c.size !== 6) continue;
    cand.push(e);
  }
  const scored = cand.slice(0, 200).map((e) => ({ e, n: nearMisses(e.c, finals, e.seq[0]) })).sort((a, b) => a.n - b.n);
  // Spare faces: each square has two, and the picture uses six of them.
  return { sheet, positions, scored, spare: startCells(sheet).size * 2 - 6, used: 0 };
});

// What each sheet would need at level 25 + n: the decoys that bring its score to the target.
function optionsAt(n) {
  const target = x * (1 + STEP * n);
  return pools.map((p) => {
    const count = Math.max(n === 1 ? 1 : 0, Math.round((target / p.positions - 1) / DECOY_WEIGHT * p.spare));
    return { p, count, target, score: score(p.positions, count / p.spare) };
  }).filter((o) => o.count >= 0 && o.count <= o.p.spare && Math.abs(o.score / o.target - 1) <= .05);
}
// The number of decoys never goes down and grows by at most two a level. Whether levels
// n..25 can still keep that, starting from `count` decoys, so no level paints itself into
// a corner (small sheets fill up first, and a bigger sheet then needs a jump).
const steady = (from, to) => to >= from && to <= from + 2;
const reachable = new Map();
function canFinish(n, count) {
  if (n > 25) return true;
  const key = n + ':' + count;
  if (!reachable.has(key)) reachable.set(key, optionsAt(n).some((o) => steady(count, o.count) && canFinish(n + 1, o.count)));
  return reachable.get(key);
}

const out = [];
let lastCount = 0, lastNear = 0;
for (let n = 1; n <= 25; n++) {
  // Among the sheets that keep the decoys steady now and later, the least used, then the
  // fewest decoys.
  const options = optionsAt(n).filter((o) => o.p.scored.some((m) => !m.taken) && steady(lastCount, o.count) && canFinish(n + 1, o.count));
  options.sort((a, b) => a.p.used - b.p.used || a.count - b.count);
  const pick = options[0];
  if (!pick) throw new Error(`no sheet fits level ${25 + n} (decoys from ${lastCount})`);
  const pool = pick.p, target = pick.target;
  pool.used++;
  const fresh = pool.scored.filter((m) => !m.taken);
  const m = fresh.find((s) => s.n >= lastNear) || fresh[fresh.length - 1];
  m.taken = true;
  lastNear = Math.max(lastNear, m.n);

  const fin = finOf(m.e.c), b = bounds(m.e.c), w = b.x1 - b.x0, h = b.y1 - b.y0;
  // Every face of every square that is never part of the picture: decoys go on some of them.
  const spare = [];
  for (const [, v] of startCells(pool.sheet)) for (const side of ['F', 'B']) { const id = v[0].i + side; if (!fin[id]) spare.push(id); }
  const decoyFaces = shuffled(spare, 7919 * n).slice(0, pick.count).sort();
  const share = decoyFaces.length / spare.length;
  lastCount = decoyFaces.length;
  const level = {
    sheet: pool.sheet, par: FOLDS, w, h, art: take(w > h ? 'wide' : 'tall'), fin,
    decoyFaces, lineHint: n > 10, route: m.e.seq, score: Math.round(score(pool.positions, share)),
  };
  let c = startCells(pool.sheet);
  for (const f of m.e.seq) c = applyFold(c, f);
  if (!isSolved(c, level)) throw new Error('route does not solve the level');
  out.push(level);
  console.log(`level ${25 + n}: target ${Math.round(target)} (${(1 + STEP * n).toFixed(1)}x), score ${level.score} (${(level.score / x).toFixed(2)}x), sheet ${pool.sheet.join('/')} (${pool.positions} positions), decoys ${decoyFaces.length} of ${spare.length}, near misses ${m.n}, ${level.art} ${w}x${h}${level.lineHint ? ', hint marks the line only' : ''}`);
}
console.log(`x, level 25's score: ${x}`);

const body = out.map((l) => '  ' + JSON.stringify(l)).join(',\n');
fs.writeFileSync(new URL('../../static/games/paperfold/levels-hard.js', import.meta.url),
  `// Levels 26-50, from projects/paperfold/generate-hard-levels.mjs. Do not edit by hand.\n// Each level scores 10% more of level 25's score than the one before; the generator explains the score.\nexport const HARD_LEVELS = [\n${body}\n];\n`);
