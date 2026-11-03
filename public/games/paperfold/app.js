// Paperfold: the board and everything around it. The rules are in engine.js.
import { K, P, startCells, bounds, creases, movedCells, reflect, applyFold, isSolved, solve, stateKey } from './engine.js';
import { LEVELS } from './levels.js';
import { artFor } from './art.js';
import { GOLD, el, tile, picture, drawLines, makeFlap, fitted, tween } from './draw.js';
import { openHowTo } from './tutorial.js';

const $ = (id) => document.getElementById(id);
const S = 50, CX = 170, CY = 240;
// The part of the board the paper may use, below the picture to make.
const BOX = { x0: 10, x1: 330, y0: 106, y1: 384 };
const board = $('board');
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
const safe = (f) => { try { return f(); } catch (e) { return undefined; } };
const track = (name, params) => safe(() => window.gtag && window.gtag('event', name, params));

// ── progress: kept in this browser, and sent to the account (see the end of this file)
const KEY = 'paperfold-progress';
let progress = safe(() => JSON.parse(localStorage.getItem(KEY))) || { solved: {}, at: 0 };
// The most moves plus undos in any one attempt at a level, solved or not.
progress.effort = progress.effort || {};
let soundOn = safe(() => localStorage.getItem('paperfold-sound')) !== 'off';
const saveProgress = () => safe(() => localStorage.setItem(KEY, JSON.stringify(progress)));
const firstUnsolved = () => { const i = LEVELS.findIndex((_, n) => !progress.solved[n]); return i < 0 ? LEVELS.length - 1 : i; };
// A level opens once the one before it is solved. Solved levels stay open to replay.
const isOpen = (n) => n === 0 || !!progress.solved[n] || !!progress.solved[n - 1];

// ── state
let lvl = 0, L = null, cells = null, history = [], won = false, clean = true, usedHint = false;
let drag = null, flap = null, animId = 0, lastOffset = null, peekTimer = 0, loopTimer = 0, settling = false;
// Where the paper sits, the folds made so far, and where it sat before each one, for undo.
let view = null, views = [], lines = [], pinned = null;
let attemptActions = 0, effortUnsent = false, hintLine = null;

$('artDefs').innerHTML = LEVELS.map((l, i) => `<g id="art-${i}">${artFor(l.art, l.w, l.h)}</g>`).join('');

function centred(cs) {
  const b = bounds(cs);
  return { x: CX - (b.x0 + b.x1) / 2 * S, y: CY - (b.y0 + b.y1) / 2 * S };
}
const offset = () => pinned || view || centred(cells);

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
  flap = null;
  board.innerHTML = '';
  drawTarget();
  const g = paperGroup();
  for (const [k, st] of cells) { const [x, y] = P(k); tile(g, x, y, S, st[0], L, lvl, { edge: !won, depth: st.length, data: true }); }
  if (!won) { drawLines(g, cells, S); if (hintLine) drawLines(g, cells, S, hintLine); }
  $('foldCount').textContent = `${history.length} of ${L.par} ${L.par === 1 ? 'fold' : 'folds'}`;
}

// A fold on screen for a line, lying flat, not kept until it is committed.
function startFlap(line) {
  animId++;
  board.innerHTML = '';
  drawTarget();
  flap = makeFlap(board, paperGroup(), cells, line, L, lvl, S);
  return flap;
}
function animateFlap(to, ms, done) {
  const id = ++animId, f = flap;
  if (f) tween(f.c, to, calm ? 0 : ms, (c) => f.set(c), done, () => id === animId && flap === f);
}

function commit(c) {
  animId++;
  history.push(cells);
  lines.push(c);
  views.push(view);
  cells = applyFold(cells, c);
  view = fitted(cells, view, S, BOX);
  safe(() => navigator.vibrate && navigator.vibrate(12));
  hintLine = null;
  countAction();
  tone(190, 0, .09, .05);
  if (isSolved(cells, L)) finish();
  render();
}

function countAction() {
  attemptActions++;
  if (attemptActions > (progress.effort[lvl] || 0)) {
    progress.effort[lvl] = attemptActions;
    effortUnsent = true;
    saveProgress();
  }
}

function finish() {
  won = true;
  const perfect = clean && !usedHint && history.length === L.par;
  const was = progress.solved[lvl];
  progress.solved[lvl] = { perfect: perfect || !!(was && was.perfect) };
  progress.at = lvl;
  saveProgress();
  syncProgress();
  [523, 659, 784].forEach((f, i) => tone(f, i * .1, .5, .07));
  if (!calm) { board.classList.remove('pop'); board.getBoundingClientRect(); board.classList.add('pop'); }
  $('tools').hidden = true;
  $('win').hidden = false;
  $('winTitle').textContent = perfect ? 'Perfect fold' : 'Picture complete';
  $('winSub').textContent = perfect ? `${L.par} ${L.par === 1 ? 'fold' : 'folds'}, no undo, no hint.`
    : usedHint ? 'You used a hint. Play again for a perfect fold.' : 'You took an undo. Play again for a perfect fold.';
  $('nextBtn').hidden = lvl === LEVELS.length - 1;
  if (lvl === LEVELS.length - 1) $('winSub').textContent += ' That was the last level, for now.';
  track('paperfold_level_complete', { level: lvl + 1, perfect, hint: usedHint, actions: attemptActions });
}

function load(n) {
  if (effortUnsent) syncProgress();
  attemptActions = 0; hintLine = null;
  lvl = n; L = LEVELS[n]; cells = startCells(L.sheet); history = []; won = false; clean = true; usedHint = false;
  lines = []; views = []; view = centred(cells); pinned = null;
  drag = null; flap = null; animId++; lastOffset = null; settling = false;
  clearTimeout(peekTimer); stopLoop();
  progress.at = n; saveProgress();
  board.classList.remove('pop');
  $('tools').hidden = false;
  $('win').hidden = true;
  $('levelName').textContent = `Level ${n + 1} of ${LEVELS.length}`;
  render();
  if (L.demo) loopFold(L.demo);
  if (L.decoys && !LEVELS[n - 1].decoys && !progress.solved[n]) toast('From here, every square is printed, and only some prints belong to the picture. Hints mark the line, not the side.', 7000);
  track('paperfold_level_start', { level: n + 1 });
}

// Shows a fold again and again until the player touches the paper. Teaches level 1;
// also the hint on the early levels.
function loopFold(c, times = Infinity) {
  stopLoop();
  let left = times;
  const once = () => {
    if (left-- <= 0) { stopLoop(); render(); return; }
    startFlap(c);
    animateFlap(-1, 1000, () => {
      loopTimer = setTimeout(() => animateFlap(1, 600, () => { render(); loopTimer = setTimeout(once, 500); }), 600);
    });
  };
  once();
}
function stopLoop() { clearTimeout(loopTimer); loopTimer = 0; }

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

// ── dragging. The paper follows the finger: the part you grab lifts from a line and stays
// under your finger, standing up as you reach the line and landing past it. The line is
// the one nearest halfway between where you grabbed and where your finger is.
function point(ev) {
  const r = board.getBoundingClientRect(), f = 340 / r.width, o = offset();
  return { x: (ev.clientX - r.left) * f - o.x, y: (ev.clientY - r.top) * f - o.y };
}
const onPaper = (p) => cells.has(K(Math.floor(p.x / S), Math.floor(p.y / S)));
const sameLine = (a, b) => a && b && a.ax === b.ax && a.k === b.k && a.side === b.side;

// `also` is one more line to consider: the last fold's, which can be the paper's edge now.
function lineFor(a, b, ax, also = null) {
  const d = ax === 0 ? b.x - a.x : b.y - a.y, from = ax === 0 ? a.x : a.y;
  if (Math.abs(d) < 8) return null;
  const mid = from + d / 2, ks = creases(cells, ax);
  if (also && also.ax === ax && !ks.includes(also.k)) ks.push(also.k);
  let best = null, gap = Infinity;
  for (const k of ks) {
    const pos = k * S;
    if (d > 0 ? pos < from - 14 : pos > from + 14) continue;
    if (Math.abs(pos - mid) < gap) { gap = Math.abs(pos - mid); best = k; }
  }
  return best === null ? null : { ax, k: best, side: d > 0 ? 0 : 1 };
}

// How far over a flap is, from where it was grabbed and where the finger is now: 1 flat,
// 0 standing up, -1 folded over. `landed` is for unfolding, grabbed where it landed.
function foldCos(line, grab, q, landed) {
  const pos = line.k * S, now = line.ax === 0 ? q.x : q.y, start = line.side === 0 ? -1 : 1;
  let g = line.ax === 0 ? grab.x : grab.y;
  if (Math.abs(g - pos) < S * .35) g = pos + (landed ? -start : start) * S * .5;
  return (landed ? -1 : 1) * (now - pos) / (g - pos);
}

function nearestFold(p) {
  let best = null, gap = Infinity;
  for (const ax of [0, 1]) {
    const v = ax === 0 ? p.x : p.y;
    for (const k of creases(cells, ax)) if (Math.abs(k * S - v) < gap) { gap = Math.abs(k * S - v); best = { ax, k, side: v < k * S ? 0 : 1 }; }
  }
  return best;
}

// A tap doesn't fold; the nearest edge lifts a little to show the paper can move.
function peek(p) {
  const line = nearestFold(p);
  if (!line) { render(); return; }
  startFlap(line);
  animateFlap(.45, 180, () => { peekTimer = setTimeout(() => { if (flap && !drag) animateFlap(1, 200, render); }, 350); });
}

// The fold just made sits on top, so it can be dragged back over its line to unfold it.
// Only the last one: earlier folds are underneath it. It counts as an undo.
function lastFoldAt(p) {
  if (!history.length) return null;
  const prev = history[history.length - 1], line = lines[lines.length - 1], here = K(Math.floor(p.x / S), Math.floor(p.y / S));
  const landed = movedCells(prev, line).map((k) => { const [x, y] = reflect(P(k), line); return K(x, y); });
  return landed.includes(here) ? { prev, line } : null;
}
function startUnfold(d) {
  d.unfold = d.back;
  d.current = cells;
  pinned = offset();
  cells = d.back.prev;
  startFlap(d.back.line).set(-1);
}
function endUnfold(d, unfolded) {
  pinned = null;
  settling = false;
  if (unfolded) {
    cells = d.unfold.prev; history.pop(); lines.pop(); view = views.pop(); clean = false; hintLine = null;
    countAction();
    track('paperfold_unfold', { level: lvl + 1 });
  } else cells = d.current;
  render();
}

board.addEventListener('pointerdown', (ev) => {
  if (won || settling) return;
  stopLoop(); clearTimeout(peekTimer);
  if (flap) { animId++; render(); }
  const p = point(ev);
  if (!onPaper(p)) return;
  drag = { p, ax: null, locked: false, line: null, back: lastFoldAt(p), unfold: null, v: 0, t: performance.now(), at: 0 };
  board.classList.add('dragging');
  safe(() => board.setPointerCapture(ev.pointerId));
  ev.preventDefault();
});
board.addEventListener('pointermove', (ev) => {
  if (!drag) return;
  const q = point(ev), dx = q.x - drag.p.x, dy = q.y - drag.p.y;
  if (drag.ax === null) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 6) return;
    drag.ax = Math.abs(dx) >= Math.abs(dy) ? 0 : 1;
    drag.at = drag.ax === 0 ? drag.p.x : drag.p.y;
  }
  const along = drag.ax === 0 ? q.x : q.y, now = performance.now();
  drag.v = (along - drag.at) / Math.max(1, now - drag.t); drag.t = now; drag.at = along;
  if (!drag.locked) {
    const b = drag.back, line = lineFor(drag.p, q, drag.ax, b && b.line);
    // Dragging the fold just made back over its own line unfolds it. Over any other
    // line, the same drag is an ordinary fold.
    const unfolding = !!(b && line && line.ax === b.line.ax && line.k === b.line.k && line.side !== b.line.side);
    if (unfolding && !drag.unfold) { drag.line = null; startUnfold(drag); }
    else if (!unfolding && drag.unfold) { pinned = null; cells = drag.current; drag.unfold = null; drag.line = null; render(); }
    if (!unfolding && !sameLine(line, drag.line)) { drag.line = line; if (line) startFlap(line); else render(); }
  }
  if (drag.unfold) {
    const c = foldCos(drag.unfold.line, drag.p, q, true);
    flap.set(c);
    if (c > -.8) drag.locked = true;
    return;
  }
  if (!drag.line) return;
  const c = foldCos(drag.line, drag.p, q, false);
  flap.set(Math.min(1, c));
  // Once the flap has visibly lifted, the line stays put even if the finger drifts.
  if (c < .8) drag.locked = true;
});
board.addEventListener('pointerup', (ev) => {
  if (!drag) return;
  const d = drag, q = point(ev);
  drag = null;
  board.classList.remove('dragging');
  if (d.unfold) {
    const towardStart = (d.unfold.line.side === 0 ? -1 : 1) * d.v, unfold = flap.c > 0 || (flap.c > -.75 && towardStart > .45);
    settling = true;
    animateFlap(unfold ? 1 : -1, 170, () => endUnfold(d, unfold));
    return;
  }
  if (!d.line || !flap) {
    if (Math.abs(q.x - d.p.x) + Math.abs(q.y - d.p.y) < 8) peek(d.p); else render();
    return;
  }
  // Past halfway, or flicked toward the line, the fold finishes; otherwise it falls back.
  const toward = (d.line.side === 0 ? 1 : -1) * d.v, keep = flap.c < 0 || (flap.c < .75 && toward > .45);
  settling = true;
  animateFlap(keep ? -1 : 1, 170, () => { settling = false; if (keep) commit(d.line); else render(); });
});
board.addEventListener('pointercancel', () => {
  if (drag && drag.unfold) { pinned = null; cells = drag.current; }
  drag = null; settling = false; animId++;
  board.classList.remove('dragging');
  render();
});

// ── controls
let toastTimer = 0;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

$('undoBtn').addEventListener('click', () => {
  if (won || settling || !history.length) return;
  stopLoop(); clearTimeout(peekTimer); animId++;
  cells = history.pop(); lines.pop(); view = views.pop(); clean = false; hintLine = null;
  countAction();
  render();
  track('paperfold_undo', { level: lvl + 1 });
});
$('resetBtn').addEventListener('click', () => { track('paperfold_start_over', { level: lvl + 1 }); load(lvl); });
// The next fold. Levels with a known route check it first: searching six folds from
// the start is 400,000 positions, too many to do on a click.
function nextFold() {
  if (!L.route) { const r = solve(cells, L, Math.max(L.par, 4)); return r && r[0]; }
  const here = stateKey(cells);
  let s = startCells(L.sheet);
  for (const f of L.route) {
    if (stateKey(s) === here) return f;
    s = applyFold(s, f);
  }
  const r = solve(cells, L, 3);
  return r && r[0];
}

$('hintBtn').addEventListener('click', () => {
  if (won || settling) return;
  clearTimeout(peekTimer);
  const fold = nextFold();
  track('paperfold_hint', { level: lvl + 1, stuck: !fold });
  if (!fold) { toast(L.route ? 'No quick route from here. Undo or start over.' : "This fold can't reach the picture. Undo it, or start over."); return; }
  usedHint = true;
  if (L.decoys) {
    stopLoop();
    hintLine = { ax: fold.ax, k: fold.k };
    render();
    toast('Fold on the marked line. You decide which side.');
  } else loopFold(fold, 2);
});
$('againBtn').addEventListener('click', () => load(lvl));
$('nextBtn').addEventListener('click', () => { if (lvl < LEVELS.length - 1 && isOpen(lvl + 1)) load(lvl + 1); });
$('soundBtn').addEventListener('click', () => {
  soundOn = !soundOn;
  safe(() => localStorage.setItem('paperfold-sound', soundOn ? 'on' : 'off'));
  showSound();
});
$('shareBtn').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}`;
  const done = Object.keys(progress.solved).length;
  const perfect = Object.values(progress.solved).filter((v) => v.perfect).length;
  const text = `I've folded ${done} of ${LEVELS.length} pictures in Paperfold, ${perfect} of them perfect. Think you can beat that?`;
  track('paperfold_share', { level: lvl + 1 });
  if (navigator.share) { safe(() => navigator.share({ title: 'Paperfold', text, url }).catch(() => {})); return; }
  const ok = await navigator.clipboard?.writeText(`${text} ${url}`).then(() => true, () => false);
  toast(ok ? 'Copied. Paste it wherever you like.' : url);
});

// ── the level map
function openMap() {
  fillMap();
  $('map').showModal();
}
function fillMap() {
  const grid = $('mapGrid');
  grid.innerHTML = '';
  const solved = Object.keys(progress.solved).length, perfects = Object.values(progress.solved).filter((s) => s.perfect).length;
  $('mapNote').textContent = solved
    ? `${solved} of ${LEVELS.length} pictures folded, ${perfects} perfect. ${whereSaved()}`
    : `Finish a level to open the next one. ${whereSaved()}`;
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
    b.addEventListener('click', () => { if (!isOpen(n)) return; $('map').close(); load(n); });
    grid.appendChild(b);
  });
}
$('mapBtn').addEventListener('click', openMap);
// New players see How to play once, the first time they arrive with nothing solved. It
// waits for the account's progress first, so a returning player on a new device skips it.
const HOW_TO_SEEN = 'paperfold-how-to-seen';
let howToDecided = false;
function showHowTo(auto) {
  safe(() => localStorage.setItem(HOW_TO_SEEN, '1'));
  track('paperfold_how_to', { level: lvl + 1, auto });
  openHowTo();
}
function maybeShowHowTo() {
  if (howToDecided) return;
  howToDecided = true;
  if (Object.keys(progress.solved).length || safe(() => localStorage.getItem(HOW_TO_SEEN))) return;
  showHowTo(true);
}
setTimeout(maybeShowHowTo, 2500);
$('howBtn').addEventListener('click', () => showHowTo(false));
$('mapClose').addEventListener('click', () => $('map').close());
$('map').addEventListener('click', (ev) => { if (ev.target === $('map')) $('map').close(); });

showSound();
const saved = Number(progress.at);
load(Number.isInteger(saved) && saved >= 0 && saved < LEVELS.length && isOpen(saved) ? (progress.solved[saved] ? firstUnsolved() : saved) : firstUnsolved());

// ── the account. As on Stonecross: a guest from the first visit, and signing in links
// the guest. Everything the game keeps here goes to whichever account is signed in,
// on every visit and after every solved level; the Worker only ever adds to it. If
// Firebase or the Worker can't be reached the game carries on, saved in this browser,
// and the next visit sends it. Folds are not kept, here or there.
const HOST = location.hostname;
const API = HOST === 'localhost' || HOST === '127.0.0.1'
  ? 'http://localhost:8787'
  : HOST === 'arjunuvacha-test.web.app' || HOST === 'arjunuvacha-test.firebaseapp.com'
    ? 'https://stonecross-staging.harisharjun127.workers.dev'
    : 'https://stonecross.harisharjun127.workers.dev';
const OWNER_KEY = 'paperfold-owner';
let authModule = null, account = null, savedToAccount = false, syncRun = 0;

function whereSaved() {
  if (!savedToAccount) return 'Saved in this browser.';
  return account?.isAnonymous ? 'Saved to your guest account. Sign in to keep it on any device.' : 'Saved to your account.';
}

async function syncProgress() {
  if (!authModule || !account) return;
  const run = ++syncRun, uid = account.uid;
  try {
    const token = await authModule.getIdToken();
    if (!token) return;
    const levels = {};
    for (const n of Object.keys(progress.solved)) levels[n] = { perfect: !!progress.solved[n].perfect };
    const res = await fetch(`${API}/paperfold/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      keepalive: true,
      body: JSON.stringify({ levels, effort: progress.effort, at: Number.isInteger(progress.at) ? progress.at : null, sound: safe(() => localStorage.getItem('paperfold-sound')) || null }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const saved = await res.json();
    if (run !== syncRun || !account || account.uid !== uid) return;
    savedToAccount = true;
    effortUnsent = false;
    for (const n of Object.keys(saved.effort || {})) progress.effort[n] = Math.max(progress.effort[n] || 0, saved.effort[n]);
    let gained = false;
    for (const n of Object.keys(saved.levels)) {
      const had = progress.solved[n];
      if (!had || (saved.levels[n].perfect && !had.perfect)) gained = true;
      progress.solved[n] = { perfect: saved.levels[n].perfect };
    }
    saveProgress();
    if (saved.sound && safe(() => localStorage.getItem('paperfold-sound')) === null) {
      soundOn = saved.sound !== 'off';
      safe(() => localStorage.setItem('paperfold-sound', saved.sound));
      showSound();
    }
    // New to this device: pick up where the account left off, unless a level is under way.
    if (gained && !history.length && !won && progress.solved[lvl]) load(firstUnsolved());
    if ($('map').open) fillMap();
  } catch (err) {
    console.warn('Paperfold progress not saved to the account yet:', err.message);
  }
  maybeShowHowTo();
}

function onAccount(u) {
  account = u;
  savedToAccount = false;
  if (!u) { syncRun++; return; }
  // A signed-in player's progress is theirs: whoever comes next on this browser starts
  // fresh. A guest's goes with them into the account they sign in to.
  const owner = safe(() => JSON.parse(localStorage.getItem(OWNER_KEY)));
  if (owner && !owner.guest && owner.uid !== u.uid) {
    progress = { solved: {}, at: 0, effort: {} };
    saveProgress();
    load(0);
  }
  safe(() => localStorage.setItem(OWNER_KEY, JSON.stringify({ uid: u.uid, guest: u.isAnonymous })));
  syncProgress();
}

// Leaving mid-level still counts. If this doesn't get out in time, the next visit sends it.
addEventListener('pagehide', () => { if (effortUnsent) syncProgress(); });

import('/auth/auth.js').then(async (m) => {
  m.enableGuests();
  authModule = m;
  await m.authReady;
  m.onUserChanged(onAccount);
}).catch((err) => console.warn('Sign-in unavailable; progress stays in this browser.', err));
