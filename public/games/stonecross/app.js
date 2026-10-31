// Stonecross — page logic: menu, the board, the system opponent, online rooms.
import * as E from './engine.js';

// Which Worker, by hostname, as PromptGym does: localhost talks to `wrangler dev`,
// the staging site to the staging Worker (both sign in to the test Firebase
// project), everything else to production.
const HOST = location.hostname;
const API = HOST === 'localhost' || HOST === '127.0.0.1'
  ? 'http://localhost:8787'
  : HOST === 'arjunuvacha-test.web.app' || HOST === 'arjunuvacha-test.firebaseapp.com'
    ? 'https://stonecross-staging.harisharjun127.workers.dev'
    : 'https://stonecross.harisharjun127.workers.dev';
const WS_API = API.replace(/^http/, 'ws');

const $ = (id) => document.getElementById(id);

// ───────────── who is playing ─────────────
// The site-wide sign-in (/auth/auth.js), the same as PromptGym's: everyone has an
// account, a guest one until they sign in with Google, and every game is saved
// to it. Signing in links the guest, so its record carries over.
// Loaded on the side: if Firebase can't load, play against the system still works,
// it just isn't saved, and online play (which needs an account) says so.
let profile = null; // { uid, name, photo, guest } once Firebase has answered
let authM = null;
const authLoaded = import('/auth/auth.js').then(async (m) => {
  m.enableGuests();
  authM = m;
  await m.authReady;
  m.onUserChanged((u) => {
    const next = u ? { uid: u.uid, name: u.isAnonymous ? null : u.name || null, photo: u.isAnonymous ? null : u.photo || null, guest: u.isAnonymous } : null;
    const prev = profile;
    if (JSON.stringify(next) === JSON.stringify(prev)) return;
    profile = next;
    // Same account, new name (a guest who just signed in): tell the room.
    if (mode?.kind === 'online' && next && prev && next.uid === prev.uid) sendAuth(true);
    if (!next || !prev || next.uid !== prev.uid) loadStats();
    else renderRecord();
    if (game) render();
  });
  return m;
}).catch((err) => { console.warn('Sign-in unavailable; games will not be saved.', err); return null; });

async function idToken(force = false) {
  const m = await authLoaded;
  if (!m) return null;
  await m.authReady;
  return m.getIdToken(force);
}

const firstName = (n) => (n || '').trim().split(/\s+/)[0] || '';
// Everyone's display name for player p, from the local viewer's point of view.
function label(p, { short = false } = {}) {
  if (mode.kind === 'local') return p === 0 ? 'Ivory' : 'Onyx';
  const mine = mode.kind === 'ai' ? p === mode.me : p === mode.seat;
  if (mine) return profile?.name && !short ? `${firstName(profile.name)} (you)` : 'You';
  if (mode.kind === 'ai') return short ? 'The system' : `System · ${LEVELS[mode.level].label}`;
  const theirs = room?.names?.[p];
  if (theirs?.name) return firstName(theirs.name);
  if (theirs?.guest) return short ? 'Your friend' : 'Friend (guest)';
  return short ? 'Your friend' : 'Friend';
}
function faceOf(p) {
  if (mode.kind === 'local') return null;
  const mine = mode.kind === 'ai' ? p === mode.me : p === mode.seat;
  if (mine) return profile?.guest ? null : profile;
  return mode.kind === 'online' ? room?.names?.[p] || null : null;
}
const LEVELS = {
  beginner: { label: 'Beginner', hint: 'Plays loosely. Good for learning the rules.' },
  intermediate: { label: 'Intermediate', hint: 'Thinks two moves ahead.' },
  difficult: { label: 'Difficult', hint: 'Searches deep. Expect to lose a few.' },
};
const REASONS = {
  banked: 'Three stones made it across.',
  outnumbered: 'Not enough stones left to get three across.',
  blocked: 'Both sides were stuck, so the most stones banked wins.',
};

// ───────────── state ─────────────
let mode = null;   // { kind: 'ai', level, me: 0 } | { kind: 'local' } | { kind: 'online', code, seat }
let game = null;
let selected = -1; // board index of the selected stone
let thinking = false;
let room = null;   // online extras: { online, rematch }
let level = 'intermediate';
let localStarter = 0;
let history = [];  // [[from, to], ...] of the current game against the system
let gameId = null; // its id, so a retried save can't count twice
let saved = false;
let stats = null;  // your record, from the Worker

const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

// ───────────── screens ─────────────
function show(name) {
  for (const s of ['menu', 'waiting', 'game']) $(s).hidden = s !== name;
  window.scrollTo(0, 0);
}

function toast(text, ms = 2200) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), ms);
}

// ───────────── board ─────────────
const cellEls = [];
const stoneEls = [];
(function buildBoard() {
  for (let d = 0; d < 49; d++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cell';
    b.dataset.d = d;
    b.addEventListener('click', () => onCell(d));
    $('cells').appendChild(b);
    cellEls.push(b);
  }
  for (let id = 0; id < 14; id++) {
    const s = document.createElement('div');
    s.className = 'stone ' + (E.owner(id) === 0 ? 'p0' : 'p1');
    s.innerHTML = `<b class="${E.owner(id) === 0 ? 'iv' : 'on'}"></b>`;
    $('stones').appendChild(s);
    stoneEls.push(s);
  }
})();

// Whoever sits at the bottom of the screen. Online, seat 1 sees the board turned round.
const bottom = () => (mode?.kind === 'online' ? mode.seat : mode?.kind === 'ai' ? mode.me : 0);
const flip = () => bottom() === 1;
const toReal = (d) => (flip() ? 48 - d : d);
const toDisp = (i) => (flip() ? 48 - i : i);

function canAct() {
  if (!game || game.winner !== null || thinking) return false;
  if (mode.kind === 'local') return true;
  if (mode.kind === 'ai') return game.turn === mode.me;
  return game.turn === mode.seat && conn.open;
}

function onCell(d) {
  if (!canAct()) return;
  const i = toReal(d);
  const id = game.board[i];
  if (id >= 0 && E.owner(id) === game.turn) {
    selected = selected === i ? -1 : i;
    return render();
  }
  if (selected >= 0) {
    const m = E.findMove(game, selected, i);
    selected = -1;
    if (m) return commit(m);
  }
  render();
}

function commit(m) {
  const prev = game;
  game = E.play(game, m);
  if (mode.kind === 'online') send({ type: 'move', from: m.from, to: m.to });
  if (mode.kind === 'ai') history.push([m.from, m.to]);
  afterChange(prev);
  if (mode.kind === 'ai') { saveSystemGame(); maybeSystem(); }
}

function afterChange(prev) {
  selected = -1;
  render();
  const l = game.last;
  if (l && l.skipped !== undefined && (!prev || prev.moveNo < game.moveNo)) {
    toast(`${nameOf(l.skipped)} had no legal move, so the turn passes.`);
  }
}

const nameOf = (p) => label(p, { short: true });

let lastRenderedMove = -1;
function render() {
  if (!game) return;
  const me = bottom();
  const targets = new Map();
  if (selected >= 0) for (const m of E.legalMoves(game)) if (m.from === selected) targets.set(m.to, m);

  // cells
  const last = game.last;
  for (let d = 0; d < 49; d++) {
    const i = toReal(d);
    const el = cellEls[d];
    const t = targets.get(i);
    el.className = 'cell'
      + (Math.floor(d / 7) === 0 ? ' goal' : '')
      + (last && (last.from === i || last.to === i) && !last.pass ? ' last' : '')
      + (t ? ' target' + (t.capture !== null ? ' capture' : '') + (t.bank ? ' bank' : '') : '');
    el.setAttribute('aria-label', t
      ? (t.bank ? 'Bank here' : t.capture !== null ? 'Jump and capture' : 'Move here')
      : `Row ${7 - Math.floor(d / 7)}, column ${(d % 7) + 1}` + (game.board[i] >= 0 ? (E.owner(game.board[i]) === 0 ? ', ivory stone' : ', onyx stone') : ''));
  }

  // stones
  const where = new Map();
  game.board.forEach((id, i) => { if (id >= 0) where.set(id, i); });
  const animate = game.moveNo !== lastRenderedMove;
  for (let id = 0; id < 14; id++) {
    const el = stoneEls[id];
    let i = where.get(id);
    const gone = i === undefined;
    if (gone) {
      if (animate && last && last.bank && last.id === id) i = last.to;
      el.classList.toggle('banked', !!(last && last.bank && last.id === id));
      el.classList.toggle('captured', !!(last && last.capturedId === id));
    }
    if (i !== undefined) {
      const d = toDisp(i);
      el.style.transform = `translate(${(d % 7) * 100}%, ${Math.floor(d / 7) * 100}%)`;
    }
    el.classList.toggle('gone', gone);
    const mine = !gone && E.owner(id) === game.turn && canAct();
    el.classList.toggle('mine', mine);
    el.classList.toggle('sel', !gone && where.get(id) === selected);
  }
  lastRenderedMove = game.moveNo;

  // players
  panel($('pBot'), me);
  panel($('pTop'), 1 - me);
  $('status').textContent = statusText();
  $('restartBtn').hidden = mode.kind === 'online';
  overlay();
}

function panel(el, p) {
  const chip = el.querySelector('.chip');
  chip.className = 'chip ' + (p === 0 ? 'iv' : 'on');
  chip.replaceChildren();
  const face = faceOf(p);
  if (face?.name || face?.photo) {
    const f = document.createElement('span');
    f.className = 'face';
    if (face.photo) {
      const img = document.createElement('img');
      img.src = face.photo; img.alt = ''; img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => { f.textContent = (face.name || '?')[0].toUpperCase(); });
      f.appendChild(img);
    } else f.textContent = face.name[0].toUpperCase();
    chip.appendChild(f);
  }
  const name = label(p);
  let sub = `${E.onBoard(game, p)} on board`;
  if (mode.kind === 'ai' && p !== mode.me && thinking) sub = 'thinking…';
  if (mode.kind === 'online' && p !== mode.seat && room && !room.online[p]) sub += ' · <span class="off">offline</span>';
  el.querySelector('.name').textContent = name;
  el.querySelector('.sub').innerHTML = sub;
  const bank = el.querySelector('.bank');
  const had = bank.querySelectorAll('i.full').length;
  bank.innerHTML = '';
  for (let k = 0; k < E.WIN_BANK; k++) {
    const pip = document.createElement('i');
    if (k < game.banked[p]) pip.className = 'full ' + (p === 0 ? 'iv' : 'on') + (k >= had ? ' pop' : '');
    bank.appendChild(pip);
  }
  el.classList.toggle('turn', game.winner === null && game.turn === p);
}

function statusText() {
  if (game.winner !== null) return '';
  if (mode.kind === 'local') return `${game.turn === 0 ? 'Ivory' : 'Onyx'} to move`;
  if (mode.kind === 'ai') {
    if (thinking) return 'The system is thinking…';
    return selected >= 0 ? 'Pick a highlighted cell' : 'Your turn: pick a stone';
  }
  if (!conn.open) return 'Reconnecting…';
  if (room && !room.online[1 - mode.seat]) return `${label(1 - mode.seat, { short: true })} is offline. The game continues when they're back.`;
  if (game.turn !== mode.seat) return `${label(1 - mode.seat, { short: true })}'s turn`;
  return selected >= 0 ? 'Pick a highlighted cell' : 'Your turn: pick a stone';
}

let overTimer = null;
function overlay() {
  const over = $('over');
  if (game.winner === null) { clearTimeout(overTimer); overTimer = null; over.hidden = true; return; }
  let title;
  if (game.winner === 'draw') title = 'Draw';
  else if (mode.kind === 'local') title = `${game.winner === 0 ? 'Ivory' : 'Onyx'} wins`;
  else if (mode.kind === 'ai') title = game.winner === mode.me ? 'You win!' : 'The system wins';
  else title = game.winner === mode.seat ? 'You win!' : `${label(game.winner, { short: true })} wins`;
  $('overTitle').textContent = title;
  let sub = REASONS[game.reason] || '';
  const again = $('againBtn');
  again.disabled = false;
  if (mode.kind === 'online') {
    const mine = room?.rematch?.[mode.seat], theirs = room?.rematch?.[1 - mode.seat];
    again.textContent = mine ? 'Waiting for friend…' : 'Rematch';
    again.disabled = !!mine;
    if (theirs && !mine) sub += ` ${label(1 - mode.seat, { short: true })} wants a rematch.`;
  } else again.textContent = 'Play again';
  $('overSub').textContent = sub;
  if (over.hidden && !overTimer) overTimer = setTimeout(() => { overTimer = null; over.hidden = game.winner === null; }, 800);
}

// ───────────── the system ─────────────
let aiWorker = null;
let aiSeq = 0;
function getWorker() {
  if (aiWorker === null) aiWorker = safe(() => new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' }), false);
  return aiWorker;
}
async function systemMove(state, lvl) {
  const w = getWorker();
  if (w) {
    const id = ++aiSeq;
    return new Promise((resolve) => {
      const on = (e) => { if (e.data.id === id) { w.removeEventListener('message', on); resolve(e.data.move); } };
      w.addEventListener('message', on);
      w.postMessage({ id, state, level: lvl });
    });
  }
  const { chooseMove } = await import('./ai.js');
  return chooseMove(state, lvl);
}

async function maybeSystem() {
  if (mode?.kind !== 'ai' || !game || game.winner !== null || game.turn === mode.me) return;
  const token = game;
  thinking = true;
  render();
  const started = Date.now();
  const mv = await systemMove(game, mode.level);
  const wait = Math.max(0, 550 - (Date.now() - started));
  await new Promise((r) => setTimeout(r, wait));
  if (game !== token) return; // a new game started meanwhile
  thinking = false;
  const m = mv && E.findMove(game, mv.from, mv.to);
  if (!m) return render();
  const prev = game;
  game = E.play(game, m);
  history.push([m.from, m.to]);
  afterChange(prev);
  saveSystemGame();
  maybeSystem();
}

// ───────────── your record ─────────────
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

async function api(path, init = {}) {
  const tok = await idToken();
  if (!tok) throw new Error('no_account');
  const r = await fetch(API + path, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${tok}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || String(r.status));
  return data;
}

// A finished game against the system goes to the Worker as its move list; the
// Worker replays it and saves the result to your account.
async function saveSystemGame() {
  if (mode?.kind !== 'ai' || !game || game.winner === null || saved) return;
  saved = true;
  const body = JSON.stringify({ id: gameId, level: mode.level, starter: game.starter, moves: history });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await api('/results/system', { method: 'POST', body });
      stats = res.stats;
      renderRecord();
      $('overSaved').textContent = profile?.guest
        ? 'Saved to your guest record. Sign in with Google to keep it on any device.'
        : 'Saved to your record.';
      return;
    } catch (err) {
      if (err.message === 'no_account') break;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  $('overSaved').textContent = "Couldn't save this game to your record.";
}

async function loadStats() {
  try { stats = await api('/me/stats?game=stonecross'); } catch { stats = null; }
  renderRecord();
}

function renderRecord() {
  const box = $('record');
  if (!box) return;
  if (!stats) { box.hidden = true; return; }
  box.hidden = false;
  const wl = (b) => `${b.win}–${b.loss}${b.draw ? `–${b.draw}` : ''}`;
  const rows = [
    ...Object.keys(LEVELS).map((k) => [`vs ${LEVELS[k].label}`, stats.system[k]]),
    ['Online', stats.online],
  ];
  const total = rows.reduce((n, [, b]) => n + b.win + b.loss + b.draw, 0);
  $('recordRows').innerHTML = rows.map(([name, b]) =>
    `<div class="rec"><span>${name}</span><b>${wl(b)}</b></div>`).join('');
  $('recordNote').textContent = total === 0
    ? 'Finish a game and it shows up here.'
    : profile?.guest
      ? 'You are playing as a guest. Sign in with Google to keep this record on any device.'
      : 'Wins–losses, saved to your account.';
}

function startAi() {
  mode = { kind: 'ai', level, me: 0 };
  game = E.newGame($('aiFirst').checked ? 1 : 0);
  history = [];
  gameId = randomId();
  saved = false;
  $('overSaved').textContent = '';
  thinking = false;
  selected = -1;
  show('game');
  render();
  maybeSystem();
}

function startLocal() {
  mode = { kind: 'local' };
  game = E.newGame(localStarter);
  localStarter = 1 - localStarter;
  selected = -1;
  show('game');
  render();
}

// ───────────── online ─────────────
const conn = { ws: null, code: null, open: false, closing: false, retry: 0, ping: null };

async function createRoom() {
  const btn = $('createRoom');
  btn.disabled = true;
  try {
    const { code } = await api('/rooms', { method: 'POST', body: '{}' });
    showWaiting(code);
    connect(code);
  } catch (err) {
    $('joinErr').textContent = err.message === 'no_account'
      ? "Online games need an account, and sign-in isn't loading. Check your connection and reload."
      : "Couldn't create a game. Check your connection and try again.";
  } finally {
    btn.disabled = false;
  }
}

async function joinRoom(code) {
  $('joinErr').textContent = '';
  if (!/^\d{6}$/.test(code)) { $('joinErr').textContent = 'Enter the 6-digit code.'; return; }
  try {
    const r = await fetch(`${API}/rooms/${code}`);
    const info = await r.json();
    if (!info.exists) { $('joinErr').textContent = 'No game with that code. Check the digits?'; return; }
    if (info.full) { $('joinErr').textContent = 'That game already has two players.'; return; }
  } catch {
    $('joinErr').textContent = "Couldn't reach the game server. Try again in a moment.";
    return;
  }
  connect(code);
}

function showWaiting(code) {
  $('codeDigits').textContent = code;
  show('waiting');
}

function connect(code) {
  disconnect();
  conn.code = code;
  conn.closing = false;
  safe(() => sessionStorage.setItem('sc-room', code));
  const ws = new WebSocket(`${WS_API}/rooms/${code}/ws`);
  conn.ws = ws;
  ws.onopen = () => {
    conn.open = true;
    conn.retry = 0;
    // The first message says who we are; the room seats us by account.
    sendAuth();
    clearInterval(conn.ping);
    conn.ping = setInterval(() => send({ type: 'ping' }), 25000);
    if (game) render();
  };
  ws.onmessage = (e) => {
    const msg = safe(() => JSON.parse(e.data));
    if (!msg) return;
    if (msg.type === 'hello') {
      mode = { kind: 'online', code: msg.code, seat: msg.seat };
    } else if (msg.type === 'state') {
      room = { online: msg.online, rematch: msg.rematch, names: msg.names || [null, null] };
      if (!msg.game) { showWaiting(code); return; }
      const prev = game;
      const fresh = !prev || msg.game.moveNo < prev.moveNo || prev.winner !== null && msg.game.winner === null;
      game = msg.game;
      if (game.winner !== null && (!prev || prev.winner === null)) {
        // The room saved the result before telling us; refresh the record.
        $('overSaved').textContent = profile?.guest
          ? 'Saved to your guest record. Sign in with Google to keep it on any device.'
          : 'Saved to your record.';
        loadStats();
      } else if (game.winner === null) $('overSaved').textContent = '';
      if ($('game').hidden) { show('game'); lastRenderedMove = -1; }
      if (fresh) lastRenderedMove = -1;
      // Our own optimistic move comes back as the same state; don't re-toast.
      if (prev && prev.moveNo === game.moveNo) { render(); return; }
      afterChange(prev);
    } else if (msg.type === 'notice' && msg.code === 'account_changed') {
      toast('You signed in to a different account. This game stays with the account that started it.', 4000);
    } else if (msg.type === 'error') {
      if (msg.code === 'not_found' || msg.code === 'full' || msg.code === 'auth') {
        leave();
        $('joinErr').textContent = msg.code === 'full' ? 'That game already has two players.'
          : msg.code === 'auth' ? "Couldn't confirm your account. Reload the page and try again."
          : 'That game has ended or expired.';
      } else if (msg.code === 'illegal' || msg.code === 'not_your_turn') {
        toast("That move wasn't accepted. Syncing the board…");
        game = null; // the server follows up with the real state
      }
    }
  };
  ws.onclose = (e) => {
    conn.open = false;
    clearInterval(conn.ping);
    if (conn.closing || conn.ws !== ws) return;
    if (e.code === 4000 || e.code === 4001 || e.code === 4003) {
      if (e.code === 4001) { leave(); toast('That game expired.'); }
      return;
    }
    if (game) render();
    const delay = Math.min(8000, 500 * 2 ** conn.retry++);
    setTimeout(() => { if (!conn.closing && conn.code === code) connect(code); }, delay);
  };
}

async function sendAuth(force = false) {
  const ws = conn.ws;
  const tok = await idToken(force);
  if (!tok) {
    leave();
    $('joinErr').textContent = "Online games need an account, and sign-in isn't loading. Check your connection and reload.";
    return;
  }
  if (conn.ws === ws) send({ type: 'auth', idToken: tok });
}

function send(o) {
  if (conn.ws && conn.ws.readyState === 1) conn.ws.send(JSON.stringify(o));
}

function disconnect() {
  conn.closing = true;
  clearInterval(conn.ping);
  if (conn.ws) safe(() => conn.ws.close(1000));
  conn.ws = null;
  conn.open = false;
}

// ───────────── navigation ─────────────
function leave() {
  disconnect();
  conn.code = null;
  safe(() => sessionStorage.removeItem('sc-room'));
  game = null;
  mode = null;
  room = null;
  thinking = false;
  $('over').hidden = true;
  show('menu');
}

$('levelSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-level]');
  if (!b) return;
  level = b.dataset.level;
  for (const x of $('levelSeg').children) x.setAttribute('aria-checked', String(x === b));
  $('levelHint').textContent = LEVELS[level].hint;
  safe(() => localStorage.setItem('sc-level', level));
});
$('playAi').addEventListener('click', startAi);
$('playLocal').addEventListener('click', startLocal);
$('createRoom').addEventListener('click', createRoom);
$('joinForm').addEventListener('submit', (e) => { e.preventDefault(); joinRoom($('joinCode').value.trim()); });
$('joinCode').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });
$('cancelWait').addEventListener('click', leave);
$('leaveBtn').addEventListener('click', leave);
$('overMenu').addEventListener('click', leave);
$('restartBtn').addEventListener('click', () => (mode.kind === 'ai' ? startAi() : startLocal()));
$('againBtn').addEventListener('click', () => {
  if (mode.kind === 'online') { send({ type: 'rematch' }); room.rematch[mode.seat] = true; overlay(); }
  else { $('over').hidden = true; mode.kind === 'ai' ? startAi() : startLocal(); }
});
$('rulesBtn').addEventListener('click', () => $('rules').showModal());

const shareUrl = (code) => `${location.origin}${location.pathname}?code=${code}`;
$('copyCode').addEventListener('click', async () => {
  const ok = await safe(() => navigator.clipboard.writeText(conn.code).then(() => true), Promise.resolve(false)).catch(() => false);
  toast(ok ? 'Code copied' : `Your code is ${conn.code}`);
});
$('shareLink').addEventListener('click', async () => {
  const url = shareUrl(conn.code);
  const text = `Play Stonecross with me. Code: ${conn.code}`;
  if (navigator.share) { safe(() => navigator.share({ title: 'Stonecross', text, url }).catch(() => {})); return; }
  const ok = await safe(() => navigator.clipboard.writeText(`${text}\n${url}`).then(() => true), Promise.resolve(false)).catch(() => false);
  toast(ok ? 'Link copied' : url, 4000);
});

// ───────────── boot ─────────────
(function boot() {
  const saved = safe(() => localStorage.getItem('sc-level'));
  if (saved && LEVELS[saved]) $('levelSeg').querySelector(`[data-level="${saved}"]`).click();
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const resume = safe(() => sessionStorage.getItem('sc-room'));
  if (resume && /^\d{6}$/.test(resume)) { connect(resume); return; }
  if (code && /^\d{6}$/.test(code)) {
    $('joinCode').value = code;
    $('joinCode').focus();
    toast('Code filled in. Tap Join to play.', 3000);
  }
})();
