// Paperfold: the board and everything around it. The rules are in engine.js.
import { K, P, startCells, bounds, creases, applyFold, isSolved, solve } from './engine.js';
import { LEVELS } from './levels.js';
import { artFor } from './art.js';
import { GOLD, el, tile, picture, drawLines, drawFold } from './draw.js';
import { openHowTo } from './tutorial.js';

const $ = (id) => document.getElementById(id);
const S = 50, CX = 170, CY = 240;
const board = $('board');
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
const safe = (f) => { try { return f(); } catch (e) { return undefined; } };
const track = (name, params) => safe(() => window.gtag && window.gtag('event', name, params));

// ── progress: this browser only
const KEY = 'paperfold-progress';
let progress = safe(() => JSON.parse(localStorage.getItem(KEY))) || { solved: {}, at: 0 };
let soundOn = safe(() => localStorage.getItem('paperfold-sound')) !== 'off';
const saveProgress = () => safe(() => localStorage.setItem(KEY, JSON.stringify(progress)));
const firstUnsolved = () => { const i = LEVELS.findIndex((_, n) => !progress.solved[n]); return i < 0 ? LEVELS.length - 1 : i; };
const isOpen = (n) => n === 0 || !!progress.solved[n] || !!progress.solved[n - 1];

// ── state
let lvl = 0, L = null, cells = null, history = [], won = false, clean = true, usedHint = false;
let drag = null, preview = null, animId = 0, lastOffset = null, peekTimer = 0, loopTimer = 0;

$('artDefs').innerHTML = LEVELS.map((l, i) => `<g id="art-${i}">${artFor(l.art, l.w, l.h)}</g>`).join('');

function offset() {
  const b = bounds(cells);
  return { x: CX - (b.x0 + b.x1) / 2 * S, y: CY - (b.y0 + b.y1) / 2 * S };
}

function drawTarget() {
  const s = Math.floor(Math.min(25, 96 / L.w, 78 / L.h));
  el('rect', { x: CX - 60, y: 6, width: 120, height: 92, rx: 8, fill: '#fff', stroke: won ? GOLD : '#d4d4d8', 'stroke-width': won ? 2.5 : 1 }, board);
  picture(el('g', { transform: `translate(${CX - L.w * s / 2} ${52 - L.h * s / 2})` }, board), L, lvl, s, false);
}

function paperGroup() {
  const o = offset(), g = el('g', {}, board), from = lastOffset || o;
  g.setAttribute('style', `transform:translate(${from.x}px,${from.y}px)`);
  if (!calm && (from.x !== o.x || from.y !== o.y)) {
    g.getBoundingClientRect();
    g.style.transition = 'transform 200ms ease-out';
  }
  g.style.transform = `translate(${o.x}px,${o.y}px)`;
  lastOffset = o;
  return g;
}

function render() {
  board.innerHTML = '';
  drawTarget();
  const g = paperGroup();
  for (const [k, st] of cells) { const [x, y] = P(k); tile(g, x, y, S, st[0], L, lvl, { edge: !won, depth: st.length, data: true }); }
  if (!won) drawLines(g, cells, S);
  $('foldCount').textContent = `${history.length} of ${L.par} ${L.par === 1 ? 'fold' : 'folds'}`;
}

// Fold the paper over the line on screen, without keeping it yet.
function showPreview(c) {
  if ((!c && !preview) || (c && preview && c.ax === preview.ax && c.k === preview.k && c.side === preview.side)) return;
  animId++;
  preview = c;
  if (!c) { render(); return; }
  const id = animId;
  board.innerHTML = '';
  drawTarget();
  drawFold(paperGroup(), cells, c, L, lvl, S, { ms: calm ? 0 : 200, alive: () => id === animId });
}

function commit(c) {
  animId++;
  preview = null;
  history.push(cells);
  cells = applyFold(cells, c);
  tone(190, 0, .09, .05);
  if (isSolved(cells, L)) finish();
  render();
}

function finish() {
  won = true;
  const perfect = clean && !usedHint && history.length === L.par;
  const was = progress.solved[lvl];
  progress.solved[lvl] = { perfect: perfect || !!(was && was.perfect) };
  progress.at = lvl;
  saveProgress();
  [523, 659, 784].forEach((f, i) => tone(f, i * .1, .5, .07));
  if (!calm) { board.classList.remove('pop'); board.getBoundingClientRect(); board.classList.add('pop'); }
  $('tools').hidden = true;
  $('win').hidden = false;
  $('winTitle').textContent = perfect ? 'Perfect fold' : 'Picture complete';
  $('winSub').textContent = perfect ? `${L.par} ${L.par === 1 ? 'fold' : 'folds'}, no undo, no hint.`
    : usedHint ? 'You used a hint. Play again for a perfect fold.' : 'You took an undo. Play again for a perfect fold.';
  $('nextBtn').hidden = lvl === LEVELS.length - 1;
  if (lvl === LEVELS.length - 1) $('winSub').textContent += ' That was the last level, for now.';
  track('paperfold_level_complete', { level: lvl + 1, perfect, hint: usedHint });
}

function load(n) {
  lvl = n; L = LEVELS[n]; cells = startCells(L.sheet); history = []; won = false; clean = true; usedHint = false;
  drag = null; preview = null; animId++; lastOffset = null;
  clearTimeout(peekTimer); stopLoop();
  progress.at = n; saveProgress();
  board.classList.remove('pop');
  $('tools').hidden = false;
  $('win').hidden = true;
  $('levelName').textContent = `Level ${n + 1} of ${LEVELS.length}`;
  render();
  if (L.demo) loopFold(L.demo);
  track('paperfold_level_start', { level: n + 1 });
}

// Show a fold again and again until the player touches the paper. Teaches level 1; also the hint.
function loopFold(c, times = Infinity) {
  stopLoop();
  let on = false, left = times * 2;
  const tick = () => {
    if (left-- <= 0) { stopLoop(); showPreview(null); return; }
    on = !on;
    showPreview(on ? c : null);
  };
  tick();
  loopTimer = setInterval(tick, 1100);
}
function stopLoop() { clearInterval(loopTimer); loopTimer = 0; }

// ── sound
let audio = null;
function tone(f, at, d, g) {
  if (!soundOn) return;
  safe(() => {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(), v = audio.createGain(), t = audio.currentTime + at;
    o.type = 'sine'; o.frequency.value = f;
    v.gain.setValueAtTime(g, t); v.gain.exponentialRampToValueAtTime(.001, t + d);
    o.connect(v); v.connect(audio.destination); o.start(t); o.stop(t + d);
  });
}
function showSound() { $('soundBtn').textContent = soundOn ? 'Sound on' : 'Sound off'; $('soundBtn').setAttribute('aria-pressed', soundOn); }

// ── dragging. As with real paper, the fold falls halfway between where you
// grabbed and where your finger is, so it lands on the line nearest that point.
function point(ev) {
  const r = board.getBoundingClientRect(), f = 340 / r.width, o = offset();
  return { x: (ev.clientX - r.left) * f - o.x, y: (ev.clientY - r.top) * f - o.y };
}
const onPaper = (p) => cells.has(K(Math.floor(p.x / S), Math.floor(p.y / S)));

function foldFor(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, ax = Math.abs(dx) >= Math.abs(dy) ? 0 : 1, d = ax === 0 ? dx : dy, from = ax === 0 ? a.x : a.y;
  if (Math.abs(d) < 12) return null;
  const mid = from + d / 2;
  let best = null, gap = Infinity;
  for (const k of creases(cells, ax)) {
    const pos = k * S;
    if (d > 0 ? pos < from - 14 : pos > from + 14) continue;
    if (Math.abs(pos - mid) < gap) { gap = Math.abs(pos - mid); best = k; }
  }
  return best === null ? null : { ax, k: best, side: d > 0 ? 0 : 1 };
}

function nearestFold(p) {
  let best = null, gap = Infinity;
  for (const ax of [0, 1]) {
    const v = ax === 0 ? p.x : p.y;
    for (const k of creases(cells, ax)) if (Math.abs(k * S - v) < gap) { gap = Math.abs(k * S - v); best = { ax, k, side: v < k * S ? 0 : 1 }; }
  }
  return best;
}

board.addEventListener('pointerdown', (ev) => {
  if (won) return;
  stopLoop(); clearTimeout(peekTimer); showPreview(null);
  const p = point(ev);
  if (!onPaper(p)) return;
  drag = { p };
  board.classList.add('dragging');
  safe(() => board.setPointerCapture(ev.pointerId));
  ev.preventDefault();
});
board.addEventListener('pointermove', (ev) => { if (drag) showPreview(foldFor(drag.p, point(ev))); });
board.addEventListener('pointerup', (ev) => {
  if (!drag) return;
  const p = drag.p, q = point(ev), c = foldFor(p, q);
  drag = null;
  board.classList.remove('dragging');
  if (c) { commit(c); return; }
  // A tap does not fold; the paper lifts to show that it can be moved.
  const n = nearestFold(p);
  if (Math.abs(q.x - p.x) + Math.abs(q.y - p.y) < 12 && n) {
    showPreview(n);
    peekTimer = setTimeout(() => showPreview(null), 550);
  } else showPreview(null);
});
board.addEventListener('pointercancel', () => { drag = null; board.classList.remove('dragging'); showPreview(null); });

// ── controls
let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

$('undoBtn').addEventListener('click', () => {
  if (won || !history.length) return;
  stopLoop(); clearTimeout(peekTimer); animId++; preview = null;
  cells = history.pop(); clean = false;
  render();
  track('paperfold_undo', { level: lvl + 1 });
});
$('resetBtn').addEventListener('click', () => { track('paperfold_start_over', { level: lvl + 1 }); load(lvl); });
$('hintBtn').addEventListener('click', () => {
  if (won) return;
  clearTimeout(peekTimer);
  const route = solve(cells, L, Math.max(L.par, 4));
  track('paperfold_hint', { level: lvl + 1, stuck: !route });
  if (!route) { toast("This fold can't reach the picture. Undo it, or start over."); return; }
  usedHint = true;
  loopFold(route[0], 2);
});
$('againBtn').addEventListener('click', () => load(lvl));
$('nextBtn').addEventListener('click', () => { if (lvl < LEVELS.length - 1) load(lvl + 1); });
$('soundBtn').addEventListener('click', () => {
  soundOn = !soundOn;
  safe(() => localStorage.setItem('paperfold-sound', soundOn ? 'on' : 'off'));
  showSound();
});
$('shareBtn').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}`;
  const done = Object.keys(progress.solved).length;
  const text = `I've folded ${done} of ${LEVELS.length} pictures in Paperfold. Think you can do it in fewer folds?`;
  track('paperfold_share', { level: lvl + 1 });
  if (navigator.share) { safe(() => navigator.share({ title: 'Paperfold', text, url }).catch(() => {})); return; }
  const ok = await navigator.clipboard?.writeText(`${text} ${url}`).then(() => true, () => false);
  toast(ok ? 'Copied. Paste it wherever you like.' : url);
});

// ── the level map
function openMap() {
  const grid = $('mapGrid');
  grid.innerHTML = '';
  const solved = Object.keys(progress.solved).length, perfects = Object.values(progress.solved).filter((s) => s.perfect).length;
  $('mapNote').textContent = solved
    ? `${solved} of ${LEVELS.length} pictures folded, ${perfects} perfect. Saved in this browser.`
    : 'Finish a level to open the next one. Saved in this browser.';
  LEVELS.forEach((level, n) => {
    const b = document.createElement('button'), s = progress.solved[n];
    b.type = 'button'; b.className = 'map-cell' + (n === lvl ? ' current' : '');
    b.disabled = !isOpen(n);
    b.setAttribute('aria-label', `Level ${n + 1}${s ? (s.perfect ? ', perfect' : ', folded') : b.disabled ? ', locked' : ''}`);
    if (s) {
      const v = el('svg', { viewBox: `0 0 ${level.w * 20} ${level.h * 20}` }, b);
      picture(v, level, n, 20, false);
      if (s.perfect) b.appendChild(Object.assign(document.createElement('span'), { className: 'perfect' }));
    } else b.textContent = n + 1;
    b.addEventListener('click', () => { $('map').close(); load(n); });
    grid.appendChild(b);
  });
  $('map').showModal();
}
$('mapBtn').addEventListener('click', openMap);
$('howBtn').addEventListener('click', () => { track('paperfold_how_to', { level: lvl + 1 }); openHowTo(); });
$('mapClose').addEventListener('click', () => $('map').close());
$('map').addEventListener('click', (ev) => { if (ev.target === $('map')) $('map').close(); });

showSound();
const saved = Number(progress.at);
load(Number.isInteger(saved) && saved >= 0 && saved < LEVELS.length && isOpen(saved) ? (progress.solved[saved] ? firstUnsolved() : saved) : firstUnsolved());
