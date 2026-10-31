// Stonecross — the system opponent. Three levels:
//   beginner     — mostly random, grabs an obvious capture or bank half the time
//   intermediate — looks 2 moves ahead, with a little noise so it isn't robotic
//   difficult    — iterative-deepening alpha-beta for ~0.9s per move
import { SIZE, STONES, owner, goalRow, rc, legalMoves, applyMove, applyPass, WIN_BANK } from './engine.js';

const WIN = 1e6;
// Value of a stone by how many rows it has advanced (0 = still at home).
const ADV = [0, 6, 14, 26, 44, 70, 0];

// Static evaluation from player p's point of view.
export function evaluate(s, p) {
  if (s.winner !== null) return s.winner === p ? WIN : s.winner === 'draw' ? 0 : -WIN;
  let score = 0;
  for (const q of [0, 1]) {
    const sign = q === p ? 1 : -1;
    let v = s.banked[q] * 400;
    for (let i = 0; i < s.board.length; i++) {
      const id = s.board[i];
      if (id < 0 || owner(id) !== q) continue;
      const [r, c] = rc(i);
      const progress = q === 0 ? SIZE - 1 - r : r;
      v += 90 + ADV[progress];
      // A runner: no enemy stone anywhere in the cone ahead of it.
      if (progress >= 3 && clearAhead(s, r, c, q)) v += 30 * progress;
      // Backed up by a friend directly behind: safe from a frontal jump.
      const rb = r - (q === 0 ? -1 : 1);
      if (rb >= 0 && rb < SIZE) {
        const b = s.board[rb * SIZE + c];
        if (b >= 0 && owner(b) === q) v += 8;
      }
    }
    score += sign * v;
  }
  // Tempo: being on move matters when stones are in contact.
  score += s.turn === p ? 12 : -12;
  return score;
}

function clearAhead(s, r, c, q) {
  const dr = q === 0 ? -1 : 1;
  const goal = goalRow(q);
  for (let rr = r + dr, w = 1; dr < 0 ? rr >= goal : rr <= goal; rr += dr, w++) {
    for (let cc = c - w; cc <= c + w; cc++) {
      if (cc < 0 || cc >= SIZE) continue;
      const v = s.board[rr * SIZE + cc];
      if (v >= 0 && owner(v) !== q) return false;
    }
  }
  return true;
}

function next(s, m) {
  let n = applyMove(s, m);
  if (n.winner === null && legalMoves(n).length === 0) n = applyPass(n);
  return n;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function ordered(s, list) {
  const ms = list || legalMoves(s);
  const key = (m) => (m.bank ? 3 : 0) + (m.capture !== null ? 2 : 0) + (m.type === 'jump' ? 0.5 : 0);
  return ms.sort((a, b) => key(b) - key(a));
}

// Negamax with alpha-beta. Score is from the side-to-move's view.
function search(s, depth, alpha, beta, ply, clock) {
  if (clock && ++clock.nodes % 1024 === 0 && Date.now() > clock.deadline) throw clock;
  if (s.winner !== null || depth === 0) {
    const e = evaluate(s, s.turn);
    return Math.abs(e) >= WIN ? e - Math.sign(e) * ply : e;
  }
  const ms = ordered(s);
  if (ms.length === 0) {
    const n = applyPass(s);
    return -search(n, depth - 1, -beta, -alpha, ply + 1, clock);
  }
  let best = -Infinity;
  for (const m of ms) {
    const n = next(s, m);
    // A pass inside next() can leave the same side on move again.
    const v = n.turn === s.turn
      ? search(n, depth - 1, alpha, beta, ply + 1, clock)
      : -search(n, depth - 1, -beta, -alpha, ply + 1, clock);
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

function rootScores(s, depth, clock, order, exact = false) {
  const out = [];
  let alpha = -Infinity;
  for (const m of order) {
    const n = next(s, m);
    const v = n.turn === s.turn
      ? search(n, depth - 1, alpha, Infinity, 1, clock)
      : -search(n, depth - 1, -Infinity, -alpha, 1, clock);
    out.push({ m, v });
    if (!exact && v > alpha) alpha = v;
  }
  return out.sort((a, b) => b.v - a.v);
}

const pick = (a) => a[Math.floor(Math.random() * a.length)];

export function chooseMove(s, level = 'intermediate', opts = {}) {
  const ms = legalMoves(s);
  if (ms.length <= 1) return ms[0] || null;

  if (level === 'beginner') {
    // Takes a win if it is right there, otherwise plays loosely.
    const winning = ms.filter((m) => m.bank && s.banked[s.turn] + 1 >= WIN_BANK);
    if (winning.length && Math.random() < 0.7) return pick(winning);
    const juicy = ms.filter((m) => m.bank || m.capture !== null);
    if (juicy.length && Math.random() < 0.5) return pick(juicy);
    // Prefer not to step straight into a capture, but only sometimes.
    if (Math.random() < 0.4) {
      const safe = ms.filter((m) => !hangs(s, m));
      if (safe.length) return pick(safe);
    }
    return pick(ms);
  }

  if (level === 'intermediate') {
    const scored = rootScores(s, 2, null, ordered(s), true);
    const top = scored[0].v;
    if (top >= WIN / 2) return scored[0].m;
    // Choose among moves within a small margin of the best.
    const close = scored.filter((x) => x.v >= top - 25);
    return pick(close).m;
  }

  // difficult — iterative deepening until the time budget runs out.
  const budget = opts.timeMs ?? 900;
  const clock = { deadline: Date.now() + budget, nodes: 0 };
  // Shuffle first so equal-scoring moves don't always favour one side of the board.
  let order = ordered(s, shuffle(legalMoves(s)));
  let best = order[0];
  for (let depth = 1; depth <= 40; depth++) {
    try {
      const scored = rootScores(s, depth, clock, order);
      best = scored[0].m;
      order = scored.map((x) => x.m); // best-first for the next iteration
      if (Math.abs(scored[0].v) >= WIN / 2) break; // forced result found
    } catch (e) {
      if (e !== clock) throw e;
      break;
    }
  }
  return best;
}

// Can the opponent capture the moved stone straight away?
function hangs(s, m) {
  if (m.bank) return false;
  const n = applyMove(s, m);
  return legalMoves(n).some((x) => x.capture === m.to);
}

export { STONES };
