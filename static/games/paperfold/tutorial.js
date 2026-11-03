// How to play: real levels, folded on the real rules, one idea at a time.
import { P, startCells, bounds, movedCells, reflect, applyFold, isSolved, squareMatches } from './engine.js';
import { LEVELS } from './levels.js';
import { GOLD, el, tile, picture, drawLines, makeFlap, fitted, tween } from './draw.js';

const $ = (id) => document.getElementById(id);
const S = 34, CX = 150, CY = 164, WRONG = '#B3261E';
// The part of the picture the paper may use, below the small target picture.
const BOX = { x0: 8, x1: 292, y0: 80, y1: 246 };
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

// runs: fold sequences to show in turn, each with what to say during and after it.
const STEPS = [
  { title: 'Make the picture', level: 16,
    text: 'The small picture at the top is your goal. Part of it is printed on the front of the paper, and the rest is on the back.' },
  { title: 'Drag to fold', level: 0,
    runs: [{ folds: [{ ax: 1, k: 1, side: 0 }] }],
    text: 'Drag any part of the paper across a dashed line. It folds as your finger moves. Let go past the line to keep the fold, or before it to cancel.' },
  { title: 'Drag a fold back to undo it', level: 9,
    runs: [{ folds: [{ ax: 1, k: 1, side: 0 }], unfold: true, doing: 'Fold the top down.', unfolding: 'Now drag it back up.', after: 'Unfolded. That counts as an undo.' }],
    text: 'Changed your mind? Drag the fold you just made back over its line to unfold it. Only the last fold unfolds this way, and it counts as an undo.' },
  { title: 'The part you drag flips', level: 3,
    runs: [
      { folds: [{ ax: 1, k: 1, side: 0 }], doing: 'First, drag the top down.', after: "The marked squares don't match the picture." },
      { folds: [{ ax: 1, k: 1, side: 1 }], doing: 'Now drag the bottom up instead.', after: 'This matches the picture.' },
    ],
    text: 'Only the part you drag flips over and shows its back. The rest of the paper stays where it is.' },
  { title: 'Folds stack up', level: 9,
    runs: [{ folds: [{ ax: 1, k: 1, side: 0 }, { ax: 1, k: 2, side: 0 }] }],
    text: 'Each fold lands on top of the paper and covers whatever is underneath. You can fold through paper you have already folded.' },
  { title: 'Order matters', level: 17,
    runs: [
      { folds: [{ ax: 1, k: 1, side: 1 }, { ax: 0, k: 2, side: 0 }], doing: 'Fold the bottom first, then the left side.', after: "The marked squares don't match the picture." },
      { folds: [{ ax: 0, k: 2, side: 0 }, { ax: 1, k: 1, side: 1 }], doing: 'Now fold the left side first, then the bottom.', after: 'The same two folds now match the picture.' },
    ],
    text: 'Your last fold always lands on top. So the same two folds can give a different result in a different order.' },
  { title: 'Fold it perfectly', level: 16, finished: true,
    text: 'Finish in the target number of folds, with no undo or hint, for a perfect fold. Stuck? Undo, start over, or ask for a hint.' },
];

let step = 0, run = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function drawTarget(svg, level, n, done) {
  const s = Math.floor(Math.min(14, 76 / level.w, 58 / level.h));
  el('rect', { x: CX - 44, y: 4, width: 88, height: 68, rx: 6, fill: '#fff', stroke: done ? GOLD : '#d4d4d8', 'stroke-width': done ? 2.5 : 1 }, svg);
  picture(el('g', { transform: `translate(${CX - level.w * s / 2} ${38 - level.h * s / 2})` }, svg), level, n, s, false);
}

function offset(cells) {
  const b = bounds(cells);
  return { x: CX - (b.x0 + b.x1) / 2 * S, y: CY - (b.y0 + b.y1) / 2 * S };
}

function scene(svg, cells, level, n, { done = false, marks = false, view = null } = {}) {
  svg.innerHTML = '';
  drawTarget(svg, level, n, done);
  const o = view || offset(cells), g = el('g', { transform: `translate(${o.x} ${o.y})` }, svg);
  for (const [k, st] of cells) { const [x, y] = P(k); tile(g, x, y, S, st[0], level, n, { depth: st.length, edge: !done }); }
  if (marks) for (const k of cells.keys()) if (!squareMatches(cells, k, level)) {
    const [x, y] = P(k);
    el('rect', { x: x * S + 2, y: y * S + 2, width: S - 4, height: S - 4, rx: 2, fill: 'none', stroke: WRONG, 'stroke-width': 2.5 }, g);
  }
  if (!done && !marks) drawLines(g, cells, S);
  return o;
}

function finger(svg, x, y) {
  return el('circle', { r: 10, fill: 'rgba(36, 50, 61, .35)', stroke: '#24323D', 'stroke-width': 1.5, transform: `translate(${x} ${y})` }, svg);
}

// Fold through each run in turn, again and again until the step changes.
async function play(n, runs, id) {
  const svg = $('howStage'), level = LEVELS[n], live = () => id === run;
  while (live()) for (const r of runs) {
    let cells = startCells(level.sheet), view = offset(cells);
    $('howNote').textContent = r.doing || '';
    scene(svg, cells, level, n, { view });
    await sleep(900);
    let prev = null, prevView = null;
    for (const c of r.folds) {
      if (!live()) return;
      prev = cells; prevView = view;
      const o = scene(svg, cells, level, n, { view });
      const grab = movedCells(cells, c).map(P).sort((a, b) => (c.side === 0 ? b[c.ax] - a[c.ax] : a[c.ax] - b[c.ax]))[0];
      const at = (p) => [o.x + (p[0] + .5) * S, o.y + (p[1] + .5) * S];
      const [ax, ay] = at(grab), [bx, by] = at(reflect(grab, c));
      const f = finger(svg, ax, ay);
      await sleep(350);
      if (!live()) return;
      // The fold follows the finger, as it does in the game.
      svg.innerHTML = '';
      drawTarget(svg, level, n, false);
      const flap = makeFlap(svg, el('g', { transform: `translate(${o.x} ${o.y})` }, svg), cells, c, level, n, S);
      svg.appendChild(f);
      const pos = c.k * S + (c.ax === 0 ? o.x : o.y), from = c.ax === 0 ? ax : ay;
      await new Promise((done) => tween(0, 1, calm ? 0 : 1100, (t) => {
        const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
        f.setAttribute('transform', `translate(${x} ${y})`);
        flap.set(((c.ax === 0 ? x : y) - pos) / (from - pos));
      }, done, live));
      if (!live()) return;
      await sleep(300);
      cells = applyFold(cells, c);
      view = fitted(cells, view, S, BOX);
      scene(svg, cells, level, n, { view });
      await sleep(350);
    }
    if (!live()) return;
    // Then drag the last fold back over its line, as in the game.
    if (r.unfold) {
      const c = r.folds[r.folds.length - 1];
      $('howNote').textContent = r.unfolding;
      const o = scene(svg, cells, level, n, { view });
      const home = movedCells(prev, c).map(P).sort((a, b) => (c.side === 0 ? b[c.ax] - a[c.ax] : a[c.ax] - b[c.ax]))[0];
      const at = (p) => [o.x + (p[0] + .5) * S, o.y + (p[1] + .5) * S];
      const [ax, ay] = at(reflect(home, c)), [bx, by] = at(home);
      const f = finger(svg, ax, ay);
      await sleep(500);
      if (!live()) return;
      svg.innerHTML = '';
      drawTarget(svg, level, n, false);
      const flap = makeFlap(svg, el('g', { transform: `translate(${o.x} ${o.y})` }, svg), prev, c, level, n, S);
      flap.set(-1);
      svg.appendChild(f);
      const pos = c.k * S + (c.ax === 0 ? o.x : o.y), from = c.ax === 0 ? ax : ay;
      await new Promise((done) => tween(0, 1, calm ? 0 : 1100, (t) => {
        const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
        f.setAttribute('transform', `translate(${x} ${y})`);
        flap.set(-((c.ax === 0 ? x : y) - pos) / (from - pos));
      }, done, live));
      if (!live()) return;
      await sleep(300);
      cells = prev; view = prevView;
      scene(svg, cells, level, n, { view });
      $('howNote').textContent = r.after;
      await sleep(2400);
      continue;
    }
    const solved = isSolved(cells, level);
    scene(svg, cells, level, n, { done: solved, marks: !solved, view });
    if (r.after) $('howNote').textContent = r.after;
    await sleep(r.after ? 2600 : 1900);
  }
}

function show(i) {
  step = i;
  const id = ++run, s = STEPS[i], n = s.level, level = LEVELS[n], svg = $('howStage');
  $('howCount').textContent = `Step ${i + 1} of ${STEPS.length}`;
  $('howTitle').textContent = s.title;
  $('howText').textContent = s.text;
  $('howNote').textContent = '';
  $('howBack').style.visibility = i ? 'visible' : 'hidden';
  $('howNext').textContent = i === STEPS.length - 1 ? 'Start playing' : 'Next';
  [...$('howDots').children].forEach((d, k) => { d.classList.toggle('now', k === i); d.setAttribute('aria-current', k === i ? 'step' : 'false'); });
  if (s.finished) {
    svg.innerHTML = '';
    drawTarget(svg, level, n, true);
    const big = 40;
    picture(el('g', { transform: `translate(${CX - level.w * big / 2} ${CY + 4 - level.h * big / 2})` }, svg), level, n, big, false);
  } else if (s.runs) play(n, s.runs, id);
  else scene(svg, startCells(level.sheet), level, n);
}

$('howDots').append(...STEPS.map((_, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('aria-label', `Step ${i + 1}`);
  b.addEventListener('click', () => show(i));
  return b;
}));
$('howBack').addEventListener('click', () => { if (step) show(step - 1); });
$('howNext').addEventListener('click', () => { if (step < STEPS.length - 1) show(step + 1); else $('how').close(); });
$('howClose').addEventListener('click', () => $('how').close());
$('how').addEventListener('close', () => { run++; });
$('how').addEventListener('click', (ev) => { if (ev.target === $('how')) $('how').close(); });

export function openHowTo() {
  $('how').showModal();
  show(0);
}
