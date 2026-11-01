// Stonecross — How to play: five short scenes, each looping on a small board.
// The scenes run on the real engine, so the dots and captures they show are the
// game's own. A scene is a starting position and a script of beats:
//   say   the caption under the board
//   set   jump to a new position (stones fade rather than slide, so it never
//         looks like an illegal move)
//   pick  select a stone and show where the engine lets it go
//   go    play from -> to
//   no    cross out these cells
//   t     how long to hold the beat, in ms
import * as E from './engine.js';

const at = (r, c) => E.idx(r, c);

export const SCENES = [
  {
    title: 'Move one stone',
    text: 'Get 3 stones across to win. On your turn, move one stone one cell into an empty space, straight or diagonally ahead.',
    script: [
      { set: { iv: [[4, 3]], on: [] }, say: 'Pick a stone. The dots show where it can go.', t: 400 },
      { pick: [4, 3], t: 1600 },
      { no: [[4, 2], [4, 4], [5, 2], [5, 3], [5, 4]], say: 'Never sideways, never back.', t: 1900 },
      { no: [], go: [[4, 3], [3, 2]], say: 'Diagonally ahead…', t: 800 },
      { pick: [3, 2], t: 900 },
      { go: [[3, 2], [2, 2]], say: 'or straight ahead.', t: 1500 },
    ],
  },
  {
    title: 'Jump over a stone',
    text: 'A stone next to you can be jumped, straight or diagonally ahead, if the cell beyond it is empty.',
    script: [
      { set: { iv: [[5, 3], [4, 3], [5, 0], [4, 1]], on: [] }, say: 'Your own stone is in the way.', t: 900 },
      { pick: [5, 3], t: 1500 },
      { go: [[5, 3], [3, 3]], say: 'Jump it. Your stone stays on the board.', t: 1700 },
      { pick: [5, 0], say: 'It works on the diagonal too.', t: 1400 },
      { go: [[5, 0], [3, 2]], t: 1500 },
    ],
  },
  {
    title: 'Capture by jumping',
    text: 'Jump over an enemy stone and it is removed from the board.',
    script: [
      { set: { iv: [[4, 3]], on: [[3, 3], [0, 1], [0, 5]] }, say: 'An enemy stone with an empty cell behind it.', t: 1100 },
      { pick: [4, 3], say: 'The ring marks a capture.', t: 1700 },
      { go: [[4, 3], [2, 3]], say: 'Captured!', t: 1900 },
    ],
  },
  {
    title: 'Keep your stones safe',
    text: 'The other side can capture you the same way. Keep a stone right behind yours and it can’t be jumped.',
    script: [
      { set: { iv: [[3, 3], [6, 1], [6, 5]], on: [[2, 3]] }, say: 'The cell behind your stone is empty.', t: 1200 },
      { pick: [2, 3], t: 1200 },
      { go: [[2, 3], [4, 3]], say: 'So the enemy jumps it.', t: 1800 },
      { set: { iv: [[3, 3], [4, 3], [6, 5]], on: [[2, 3]] }, say: 'Now a friend covers it from behind.', t: 1300 },
      { pick: [2, 3], say: 'No jump. The enemy has to go around.', t: 2300 },
    ],
  },
  {
    title: 'How the game ends',
    text: 'First to 3 across wins. Left with too few stones to reach 3, you lose. No legal move? Your turn is skipped.',
    score: true,
    script: [
      { set: { iv: [[1, 1], [1, 3], [1, 5], [5, 2], [5, 4]], on: [[0, 5], [3, 0], [3, 6]] }, say: 'Three stones, one cell from your finish line.', t: 1500 },
      { pick: [1, 1], say: 'The cell ahead is empty.', t: 1300 },
      { go: [[1, 1], [0, 1]], say: 'Straight across. That’s 1.', t: 1500 },
      { pick: [1, 3], say: 'Empty again.', t: 1100 },
      { go: [[1, 3], [0, 3]], say: 'Across. That’s 2.', t: 1500 },
      { pick: [1, 5], say: 'An enemy stone blocks the cell ahead, so go diagonally.', t: 2200 },
      { go: [[1, 5], [0, 4]], say: 'Across. That’s 3. You win!', t: 2600 },
      { set: { iv: [[3, 3], [6, 0], [6, 6]], on: [[2, 3], [1, 1], [1, 5], [0, 3]] }, say: 'Now just 3 stones left, none across yet.', t: 1300 },
      { go: [[2, 3], [4, 3]], say: 'One is captured. Only 2 left, so 3 is out of reach. You lose.', t: 3000 },
    ],
  },
];

// A position from { iv, on, banked }: ivory takes ids 0–6, onyx ids 7–13.
export function position({ iv = [], on = [], banked = 0 }) {
  const s = E.newGame(0);
  s.board.fill(-1);
  iv.forEach(([r, c], k) => { s.board[at(r, c)] = k; });
  on.forEach(([r, c], k) => { s.board[at(r, c)] = E.STONES + k; });
  s.banked = [banked, 0];
  return s;
}

// The engine, with the side to move set by whichever stone is being played. The
// scenes keep few stones, which a real game would already have called as lost.
const asMover = (s, from) => ({ ...s, turn: E.owner(s.board[from]), winner: null });
export const movesFrom = (s, from) => E.legalMoves(asMover(s, from)).filter((m) => m.from === from);
export function playBeat(s, [[fr, fc], [tr, tc]]) {
  const from = at(fr, fc), to = at(tr, tc);
  const m = s.board[from] >= 0 && movesFrom(s, from).find((x) => x.to === to);
  if (!m) throw new Error(`Stonecross tutorial: illegal move ${fr},${fc} -> ${tr},${tc}`);
  return { ...E.applyMove(asMover(s, from), m), winner: null };
}

const SEEN = 'sc-rules-seen';
const safe = (fn) => { try { return fn(); } catch { return null; } };
const stillMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

let ui = null;
let step = 0;
let runId = 0;

function build() {
  const $ = (id) => document.getElementById(id);
  ui = {
    dlg: $('rules'), stepNo: $('tutStep'), title: $('tutTitle'), text: $('tutText'),
    board: $('tutBoard'), note: $('tutNote'), score: $('tutScore'), dots: $('tutDots'),
    back: $('tutBack'), next: $('tutNext'), cells: [], stones: [],
  };
  for (let i = 0; i < 49; i++) {
    const c = document.createElement('div');
    c.className = 'cell';
    $('tutCells').appendChild(c);
    ui.cells.push(c);
  }
  for (let id = 0; id < E.STONES * 2; id++) {
    const s = document.createElement('div');
    s.className = 'stone';
    s.innerHTML = `<b class="${E.owner(id) === 0 ? 'iv' : 'on'}"></b>`;
    $('tutStones').appendChild(s);
    ui.stones.push(s);
  }
  SCENES.forEach((_, k) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', `Step ${k + 1}: ${SCENES[k].title}`);
    b.addEventListener('click', () => goTo(k));
    ui.dots.appendChild(b);
  });
  ui.back.addEventListener('click', () => goTo(step - 1));
  ui.next.addEventListener('click', () => (step === SCENES.length - 1 ? ui.dlg.close() : goTo(step + 1)));
  $('tutSkip').addEventListener('click', () => ui.dlg.close());
  ui.dlg.addEventListener('close', () => { runId++; });
  ui.dlg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' && step < SCENES.length - 1) goTo(step + 1);
    if (e.key === 'ArrowLeft' && step > 0) goTo(step - 1);
  });
}

function draw(s, { picked = -1, targets = [], crossed = [] } = {}) {
  ui.cells.forEach((el, i) => {
    const t = targets.find((m) => m.to === i);
    el.className = 'cell'
      + (i < E.SIZE ? ' goal' : '')
      + (t ? ' target' + (t.capture !== null ? ' capture' : '') + (t.bank ? ' bank' : '') : '')
      + (crossed.includes(i) ? ' no' : '');
  });
  const where = new Map();
  s.board.forEach((id, i) => { if (id >= 0) where.set(id, i); });
  const last = s.last;
  ui.stones.forEach((el, id) => {
    let i = where.get(id);
    const gone = i === undefined;
    if (gone && last?.bank && last.id === id) i = last.to;
    if (i !== undefined) el.style.transform = `translate(${(i % E.SIZE) * 100}%, ${Math.floor(i / E.SIZE) * 100}%)`;
    el.className = 'stone'
      + (gone ? ' gone' : '')
      + (gone && last?.bank && last.id === id ? ' banked' : '')
      + (gone && last?.capturedId === id ? ' captured' : '')
      + (!gone && where.get(id) === picked ? ' sel' : '');
  });
}

function drawScore(s) {
  const n = s.banked[0];
  ui.score.querySelector('.score-n').innerHTML = `<b>${n}</b> of ${E.WIN_BANK} across`;
  const had = ui.score.querySelectorAll('.bank i.full').length;
  const bank = ui.score.querySelector('.bank');
  bank.innerHTML = '';
  for (let k = 0; k < E.WIN_BANK; k++) {
    const pip = document.createElement('i');
    if (k < n) pip.className = 'full iv' + (k >= had ? ' pop' : '');
    bank.appendChild(pip);
  }
}

async function playScene(scene, id) {
  const still = stillMotion();
  const wait = (ms) => (still ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));
  const live = () => id === runId;
  while (live()) {
    let s = position({});
    let picked = -1;
    for (const beat of scene.script) {
      let targets = [];
      let crossed = [];
      if ('say' in beat) ui.note.textContent = beat.say;
      if (beat.set) {
        ui.board.classList.add('tut-still');
        ui.board.style.opacity = 0;
        await wait(160);
        if (!live()) return;
        s = position(beat.set);
        picked = -1;
      }
      if (beat.pick) {
        picked = at(...beat.pick);
        targets = movesFrom(s, picked);
      }
      if (beat.no) {
        crossed = beat.no.map(([r, c]) => at(r, c));
        if (picked >= 0) targets = movesFrom(s, picked);
      }
      if (beat.go) {
        s = playBeat(s, beat.go);
        picked = -1;
      }
      draw(s, { picked, targets, crossed });
      drawScore(s);
      if (beat.set) {
        // Lay the new position out before the stones may slide again.
        void ui.board.offsetWidth;
        ui.board.classList.remove('tut-still');
        ui.board.style.opacity = 1;
      }
      await wait(beat.t);
      if (!live()) return;
    }
    if (still) return;
  }
}

function goTo(k) {
  step = k;
  const scene = SCENES[k];
  ui.stepNo.textContent = `Step ${k + 1} of ${SCENES.length}`;
  ui.title.textContent = scene.title;
  ui.text.textContent = scene.text;
  ui.score.hidden = !scene.score;
  if (k === 0 && document.activeElement === ui.back) ui.next.focus();
  ui.back.hidden = k === 0;
  ui.next.textContent = k === SCENES.length - 1 ? 'Got it' : 'Next';
  [...ui.dots.children].forEach((b, i) => {
    b.classList.toggle('now', i === k);
    if (i === k) b.setAttribute('aria-current', 'step');
    else b.removeAttribute('aria-current');
  });
  playScene(scene, ++runId);
}

export function openRules() {
  if (!ui) build();
  safe(() => localStorage.setItem(SEEN, '1'));
  if (!ui.dlg.open) ui.dlg.showModal();
  goTo(0);
  ui.next.focus();
}

// Someone sitting down to their first game gets it without having to look for it.
export function openRulesOnce() {
  if (!safe(() => localStorage.getItem(SEEN))) openRules();
}
