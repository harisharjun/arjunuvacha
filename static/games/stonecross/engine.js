// Stonecross — rules engine.
// Pure functions, no DOM and no network, so the page, the AI and the room
// Worker all run the exact same rules. The Worker imports this file directly.
//
// Board: 7×7, cells indexed r*7+c. A cell holds -1 (empty) or a stone id.
// Stones 0–6 belong to player 0 (Ivory, starts on row 6, moves up),
// stones 7–13 to player 1 (Onyx, starts on row 0, moves down).

export const SIZE = 7;
export const STONES = 7;
export const WIN_BANK = 3;

export const owner = (id) => (id < STONES ? 0 : 1);
export const dirOf = (p) => (p === 0 ? -1 : 1);
export const homeRow = (p) => (p === 0 ? SIZE - 1 : 0);
export const goalRow = (p) => (p === 0 ? 0 : SIZE - 1);
export const rc = (i) => [Math.floor(i / SIZE), i % SIZE];
export const idx = (r, c) => r * SIZE + c;

export function newGame(starter = 0) {
  const board = new Array(SIZE * SIZE).fill(-1);
  for (let c = 0; c < SIZE; c++) {
    board[idx(homeRow(0), c)] = c;
    board[idx(homeRow(1), c)] = STONES + c;
  }
  return {
    board,
    turn: starter,
    starter,
    banked: [0, 0],
    lost: [0, 0], // stones of each player that were captured
    passes: 0,
    moveNo: 0,
    winner: null, // null | 0 | 1 | 'draw'
    reason: null,
    last: null,
  };
}

export const onBoard = (s, p) => {
  let n = 0;
  for (const v of s.board) if (v >= 0 && owner(v) === p) n++;
  return n;
};

// Every legal move for the side to move.
// A move: { from, to, type: 'step'|'jump', capture: cellIndex|null, bank: bool }
export function legalMoves(s, p = s.turn) {
  const moves = [];
  if (s.winner !== null) return moves;
  const dr = dirOf(p);
  const goal = goalRow(p);
  for (let i = 0; i < s.board.length; i++) {
    const id = s.board[i];
    if (id < 0 || owner(id) !== p) continue;
    const [r, c] = rc(i);
    for (let dc = -1; dc <= 1; dc++) {
      const r1 = r + dr, c1 = c + dc;
      if (r1 < 0 || r1 >= SIZE || c1 < 0 || c1 >= SIZE) continue;
      const a = idx(r1, c1);
      if (s.board[a] < 0) {
        moves.push({ from: i, to: a, type: 'step', capture: null, bank: r1 === goal });
        continue;
      }
      const r2 = r1 + dr, c2 = c1 + dc;
      if (r2 < 0 || r2 >= SIZE || c2 < 0 || c2 >= SIZE) continue;
      const b = idx(r2, c2);
      if (s.board[b] >= 0) continue;
      const enemy = owner(s.board[a]) !== p;
      moves.push({ from: i, to: b, type: 'jump', capture: enemy ? a : null, bank: r2 === goal });
    }
  }
  return moves;
}

// Returns a NEW state. Assumes `m` came from legalMoves(s).
export function applyMove(s, m) {
  const p = s.turn;
  const board = s.board.slice();
  const banked = s.banked.slice();
  const lost = s.lost.slice();
  const id = board[m.from];
  let capturedId = null;
  board[m.from] = -1;
  if (m.capture !== null) {
    capturedId = board[m.capture];
    board[m.capture] = -1;
    lost[1 - p]++;
  }
  if (m.bank) banked[p]++;
  else board[m.to] = id;
  const n = {
    ...s,
    board, banked, lost,
    turn: 1 - p,
    passes: 0,
    moveNo: s.moveNo + 1,
    last: { ...m, id, capturedId, by: p },
  };
  return settle(n);
}

// The side to move has nothing legal: hand the turn over.
export function applyPass(s) {
  // Keep the previous move in `last` (the page animates it) and note who was skipped.
  const n = { ...s, turn: 1 - s.turn, passes: s.passes + 1, moveNo: s.moveNo + 1,
    last: { ...(s.last || {}), skipped: s.turn } };
  return settle(n);
}

// Decide wins, and auto-pass a side that cannot move.
function settle(s) {
  for (const p of [0, 1]) {
    if (s.banked[p] >= WIN_BANK) return { ...s, winner: p, reason: 'banked' };
  }
  for (const p of [0, 1]) {
    if (s.banked[p] + onBoard(s, p) < WIN_BANK) return { ...s, winner: 1 - p, reason: 'outnumbered' };
  }
  if (s.passes >= 2) {
    // Both sides stuck. Most banked wins, then most stones left.
    const [a, b] = [s.banked[0] - s.banked[1], onBoard(s, 0) - onBoard(s, 1)];
    const w = a !== 0 ? (a > 0 ? 0 : 1) : b !== 0 ? (b > 0 ? 0 : 1) : 'draw';
    return { ...s, winner: w, reason: 'blocked' };
  }
  return s;
}

// Convenience used by every front end: move, then auto-pass while stuck.
export function play(s, m) {
  let n = applyMove(s, m);
  while (n.winner === null && legalMoves(n).length === 0) n = applyPass(n);
  return n;
}

export function findMove(s, from, to) {
  return legalMoves(s).find((m) => m.from === from && m.to === to) || null;
}
