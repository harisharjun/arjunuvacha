import { onUserChanged, getIdToken, getUser, signInWithGoogle, signOutUser, authReady } from './auth.js';

// Served from localhost while developing, so talk to `wrangler dev` rather than
// the deployed worker. The staging site talks to the staging Worker, so staging
// can run code production has not got yet. `?api=` overrides all of it.
const API =
  new URLSearchParams(location.search).get('api') ??
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? 'http://localhost:8787'
    : location.hostname.startsWith('arjunuvacha-test.')
      ? 'https://prompt-gym-staging.harisharjun127.workers.dev'
      : 'https://prompt-gym.harisharjun127.workers.dev');

const BASE = '/prompt-gym';

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

let challenges = [];
/** Groq models, for guests. Signed-in players get each challenge's own list. */
let guestModels = [];
let current = null;
/** challengeId -> { bestScore, passed, passedAt } for whoever is signed in. */
let progress = new Map();
/** This player's leaderboard row, or null if unranked. */
let myStanding = null;
let totalPlayers = 0;
let boardUid = null;
let boardLoaded = false;
let listFilter = 'all';
let signingOut = false;

// ------------------------------------------------------------- presentation

/** The runtime modes, in words a first-time visitor would use. */
const TYPE = {
  goal: { label: 'Write a prompt', cls: 'goal' },
  debug: { label: 'Fix a prompt', cls: 'debug' },
  golf: { label: 'Shortest prompt', cls: 'golf' },
};

const DIFFICULTY = ['', 'Beginner', 'Easy', 'Intermediate', 'Hard', 'Expert'];

/** Metric names come from the assertions. These are what they mean to a player —
 *  written once here rather than per challenge, so the panel cannot drift. */
const METRIC = {
  format: ['Format', 'The output is in exactly the shape asked for.'],
  schema: ['Structure', 'Fields and types match the required structure.'],
  accuracy: ['Accuracy', 'The values are right for the input.'],
  hallucination: ['No guessing', "Nothing is invented that the input doesn't say."],
  arithmetic: ['Arithmetic', 'The numbers genuinely add up.'],
  faithfulness: ['Faithfulness', 'Stays true to what the source says.'],
  leakage: ['No leaks', 'No personal detail survives, in any form.'],
  preservation: ['Preservation', 'Everything that should stay is left exactly as written.'],
  'over-redaction': ['No over-redaction', 'Nothing harmless gets masked.'],
  correctness: ['Correct outcome', 'Reaches the right answer.'],
  relevance: ['On point', 'Says what a correct answer would say.'],
  injection: ['Injection resistance', 'Ignores instructions hidden inside the input.'],
  usefulness: ['Usefulness', 'Still does the actual job.'],
  triage: ['Triage', 'Category and priority are right.'],
  'summary-quality': ['Summary quality', 'The summary describes the real problem.'],
  discipline: ['Discipline', 'Follows the response rules exactly.'],
  judgement: ['Judgement', 'Makes the right call.'],
  novelty: ['Novelty', 'Reworded rather than copied.'],
};
const metricName = (m) => METRIC[m]?.[0] ?? m.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Labels on the harness slots, as the player should read them. */
const INPUT_LABEL = {
  INPUT: 'Example input',
  CUSTOMER: 'Example customer message',
  REVIEW: 'Example review',
  TICKET: 'Example ticket',
  REQUEST: 'Example request',
};
const titleCase = (s) => s.toLowerCase().replace(/(^|\s)\w/g, (c) => c.toUpperCase());

/** SQLite stores `datetime('now')` as UTC without a zone marker. */
function parseDate(sqlite) {
  if (!sqlite) return null;
  const d = new Date(sqlite.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDate(sqlite) {
  const d = parseDate(sqlite);
  if (!d) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

function formatDateTime(sqlite) {
  const d = parseDate(sqlite);
  if (!d) return '';
  return `${formatDate(sqlite)}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

const displayName = (name) => name || 'Anonymous User';
const shortModel = (m) => (m ?? '').replace(/^[^/]+\//, '');

function difficultyNode(level) {
  const wrap = el('span', 'difficulty');
  wrap.setAttribute('aria-label', `Difficulty ${level} of 5 — ${DIFFICULTY[level] ?? ''}`);
  const dots = el('span', 'dots');
  for (let i = 1; i <= 5; i++) dots.appendChild(el('i', i <= level ? 'on' : ''));
  wrap.append(dots, el('span', null, DIFFICULTY[level] ?? ''));
  return wrap;
}

function typeChip(mode) {
  const t = TYPE[mode] ?? { label: mode, cls: 'goal' };
  return el('span', `type-chip ${t.cls}`, t.label);
}

const LOCK_ICON = '<svg viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="M6 1a2.5 2.5 0 0 0-2.5 2.5V5H3a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-.5V3.5A2.5 2.5 0 0 0 6 1Zm-1.5 4V3.5a1.5 1.5 0 0 1 3 0V5h-3Z"/></svg>';

const isGuest = () => {
  const u = getUser();
  return !u || u.isAnonymous;
};
/** Guests get the free challenges; the rest need a Google sign-in. The Worker
 *  enforces the same rule — this only decides what the page offers. */
const isLocked = (c) => isGuest() && !c.freeToPlay;
const isPassed = (c) => Boolean(progress.get(c.id)?.passed);

/** One of four states, and the only place the rules for them live. */
function statusOf(challenge) {
  if (isLocked(challenge)) return { kind: 'locked' };
  const p = progress.get(challenge.id);
  if (!p) return { kind: 'new' };
  if (p.passed) return { kind: 'passed', score: p.bestScore, date: formatDate(p.passedAt) };
  return { kind: 'partial', score: p.bestScore, bar: Math.round(challenge.passThreshold * 100) };
}

function statusNode(challenge) {
  const s = statusOf(challenge);
  if (s.kind === 'locked') return el('span', 'status locked', 'Locked');
  if (s.kind === 'passed') return el('span', 'status passed', `✓ Passed${s.date ? ` · ${s.date}` : ''}`);
  if (s.kind === 'partial') return el('span', 'status partial', `In progress · best ${s.score}`);
  return el('span', 'status new', 'Not started');
}

const initial = (name) => (name?.trim()?.[0] ?? '?').toUpperCase();

function avatarNode(name, photo, small = false) {
  const node = el('span', `avatar${small ? ' sm' : ''}`);
  if (photo) {
    const img = document.createElement('img');
    img.src = photo;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    // A Google avatar URL can 403 from some referrers; fall back to an initial.
    img.addEventListener('error', () => img.replaceWith(document.createTextNode(initial(name))));
    node.appendChild(img);
  } else {
    node.textContent = initial(name);
  }
  return node;
}

function googleButton(label = 'Sign in with Google') {
  const btn = el('button', 'google-btn');
  btn.type = 'button';
  btn.innerHTML = $('signin').querySelector('svg').outerHTML;
  btn.appendChild(el('span', null, label));
  return btn;
}

function toast(message) {
  const t = $('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 7000);
}

// ------------------------------------------------------------------ storage

// Local storage throws in some private-browsing modes, so every access is
// guarded: a browser that refuses to remember anything should still play.
function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ drafts

// Every prompt a player has typed is kept, per challenge, so wandering off to
// look at another one never costs them their work. In memory for the session and
// in local storage across visits; the last scorecard is kept for the session.
const DRAFT_KEY = (id) => `promptgym.draft.${id}`;
const drafts = new Map();
const lastResults = new Map();

function draftFor(challenge) {
  if (drafts.has(challenge.id)) return drafts.get(challenge.id);
  const stored = storageGet(DRAFT_KEY(challenge.id));
  return stored ?? challenge.startingPrompt ?? '';
}

function saveDraft() {
  if (!current) return;
  const value = $('prompt').value;
  drafts.set(current.id, value);
  // Nothing worth remembering: do not keep an empty or untouched draft around.
  storageSet(DRAFT_KEY(current.id), value && value !== (current.startingPrompt ?? '') ? value : null);
}

// ------------------------------------------------------------------ drawers

let openDrawer = null;
let drawerReturnFocus = null;

function showDrawer(id) {
  closeDrawer();
  drawerReturnFocus = document.activeElement;
  openDrawer = $(id);
  openDrawer.hidden = false;
  $('backdrop').hidden = false;
  document.body.style.overflow = 'hidden';
  openDrawer.querySelector('[data-close]')?.focus();
}

function closeDrawer() {
  if (!openDrawer) return;
  openDrawer.hidden = true;
  $('backdrop').hidden = true;
  document.body.style.overflow = '';
  openDrawer = null;
  drawerReturnFocus?.focus?.();
}

$('backdrop').addEventListener('click', closeDrawer);
for (const btn of document.querySelectorAll('[data-close]')) btn.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeDrawer();
    closeUserMenu();
  }
});

// ------------------------------------------------------------------ routing

// Firebase rewrites every path under /prompt-gym/ to this page, so the route is
// read back off the URL here. Pushing state keeps the browser's back button and
// shareable links working without a server that knows the routes.
function navigate(path) {
  if (location.pathname !== path) history.pushState({}, '', path);
  route();
}

function route() {
  const path = location.pathname.replace(/\/+$/, '');
  const result = /\/r\/([A-Za-z0-9-]{8,64})$/.exec(path);
  const play = /\/c\/([a-z0-9-]+)$/.exec(path);
  closeDrawer();
  tip?.classList.remove('open');

  if (result) return loadSharedResult(result[1]);
  if (path === `${BASE}/shared`) return openGallery();
  if (path === `${BASE}/terms`) return showView('terms');
  if (play) {
    const challenge = challenges.find((c) => c.id === play[1]);
    if (challenge && !isLocked(challenge)) return openChallenge(challenge, { push: false });
    if (challenge) toast('Sign in with Google to play that challenge.');
  }
  current = null;
  showView('list');
}

window.addEventListener('popstate', route);

for (const [id, path] of [
  ['back', BASE + '/'],
  ['result-back', BASE + '/'],
  ['gallery-back', BASE + '/'],
  ['terms-back', BASE + '/'],
]) {
  $(id).addEventListener('click', () => {
    if (id === 'back') saveDraft();
    navigate(path);
  });
}

// In-app links: handled here rather than reloading the page.
for (const id of ['home-link', 'gallery-link', 'terms-link']) {
  $(id).addEventListener('click', (e) => {
    e.preventDefault();
    navigate(new URL($(id).href).pathname);
  });
}
document.querySelector('.view-nav-link').addEventListener('click', (e) => {
  e.preventDefault();
  navigate(`${BASE}/shared`);
});

// ---------------------------------------------------------------- challenges

async function loadChallenges() {
  try {
    const res = await fetch(`${API}/api/challenges`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    challenges = data.challenges;
    guestModels = data.guestModels ?? data.models;
    renderList();
  } catch (err) {
    $('list-status').textContent = `Could not load challenges — ${err.message}`;
    $('list-status').className = 'notice error-box';
  }
}

function renderList() {
  $('list-status').hidden = true;
  const list = $('challenge-list');
  list.replaceChildren();

  // A guest sees what they can play first; the rest follow, locked.
  let shown = isGuest() ? [...challenges].sort((a, b) => Number(b.freeToPlay) - Number(a.freeToPlay)) : challenges;
  if (listFilter === 'unsolved') shown = shown.filter((c) => !isPassed(c));

  if (shown.length === 0) {
    list.appendChild(el('li', 'list-empty', 'Nothing left unsolved. Every challenge here is passed.'));
  }

  for (const challenge of shown) {
    const s = statusOf(challenge);
    const item = document.createElement('li');
    const card = el('button', `card ${s.kind === 'new' ? '' : s.kind}`);
    card.type = 'button';
    if (s.kind === 'locked') card.setAttribute('aria-label', `${challenge.title} — sign in to unlock`);

    const top = el('div', 'card-top');
    top.append(typeChip(challenge.mode), statusNode(challenge));
    card.appendChild(top);

    card.appendChild(el('h3', 'card-title', challenge.title));
    card.appendChild(el('p', 'card-summary', challenge.summary ?? ''));

    const foot = el('div', 'card-foot');
    foot.appendChild(difficultyNode(challenge.difficulty));
    if (s.kind === 'locked') {
      // The one thing to do with a locked card, said as loudly as the card allows.
      const cta = el('span', 'unlock-cta');
      cta.innerHTML = LOCK_ICON;
      cta.appendChild(document.createTextNode('Sign in to unlock'));
      foot.appendChild(cta);
    } else if (s.kind === 'passed') {
      foot.appendChild(el('span', null, `Best ${s.score}`));
    } else if (s.kind === 'partial') {
      // How far off the pass mark they are, at a glance.
      const meter = el('span', 'meter');
      meter.style.width = '5.5rem';
      meter.setAttribute('aria-label', `Best ${s.score}, pass at ${s.bar}`);
      const fill = document.createElement('span');
      fill.style.width = `${Math.min(100, s.score)}%`;
      const mark = document.createElement('b');
      mark.style.left = `${s.bar}%`;
      meter.append(fill, mark);
      foot.appendChild(meter);
    }
    card.appendChild(foot);

    card.addEventListener('click', () => openChallenge(challenge));
    item.appendChild(card);
    list.appendChild(item);
  }

  // Always last: the catalogue is meant to grow, and saying so beats an ending.
  const soon = document.createElement('li');
  const card = el('div', 'card coming-soon');
  card.append(
    el('span', 'coming-soon-mark', '+'),
    el('h3', 'card-title', 'More challenges coming soon'),
    el('p', 'card-summary', 'New ones are added as they pass validation.'),
  );
  soon.appendChild(card);
  list.appendChild(soon);

  renderHero();
  renderStanding();
}

function setFilter(which) {
  listFilter = which;
  for (const [id, value] of [['filter-all', 'all'], ['filter-unsolved', 'unsolved']]) {
    $(id).classList.toggle('active', which === value);
    $(id).setAttribute('aria-pressed', String(which === value));
  }
  renderList();
}
$('filter-all').addEventListener('click', () => setFilter('all'));
$('filter-unsolved').addEventListener('click', () => setFilter('unsolved'));

// --------------------------------------------------------------------- hero

/** Where the hero's button goes: the easiest challenge this player can open and
 *  has not passed. For a guest that is always a free one, which is what makes
 *  "no signup to start" true of wherever the button lands. */
function nextChallenge() {
  const open = challenges
    .filter((c) => !isLocked(c) && !isPassed(c))
    .sort((a, b) => (a.difficulty ?? 1) - (b.difficulty ?? 1));
  return open[0] ?? null;
}

function renderHero() {
  const button = $('hero-start');
  const note = $('hero-note');
  if (challenges.length === 0) return;

  const next = nextChallenge();
  if (!next) {
    button.textContent = 'See the leaderboard';
    note.textContent = isGuest()
      ? 'Every free challenge is passed. Sign in to unlock the rest.'
      : "You've passed every challenge.";
    return;
  }
  button.textContent = 'Find out where yours breaks';
  note.textContent = isGuest() ? `No signup. Starts with “${next.title}”.` : `Next up: “${next.title}”.`;
}

$('hero-start').addEventListener('click', () => {
  const next = nextChallenge();
  if (next) openChallenge(next);
  else if (isGuest()) startSignIn();
  else openFullBoard();
});

// ----------------------------------------------------------------- standing

/** Where the player stands: their rank, or the one thing that would get them one.
 *  Never a "3 of 11" — the catalogue will grow, and a denominator ages badly. */
function renderStanding() {
  const box = $('standing');
  if (challenges.length === 0 || !boardLoaded) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.replaceChildren();
  box.classList.remove('nudge');

  const passedCount = challenges.filter(isPassed).length;
  const free = challenges.filter((c) => c.freeToPlay);
  const lockedCount = challenges.filter(isLocked).length;

  const badge = (value, caption, zero = false) => {
    const b = el('div', `standing-rank${zero ? ' zero' : ''}`, value);
    b.title = caption;
    b.setAttribute('aria-label', `${value} ${caption}`);
    return b;
  };
  const text = (strong, span) => {
    const t = el('div', 'standing-text');
    t.append(el('strong', null, strong), el('span', null, span));
    return t;
  };
  const actions = el('div', 'standing-actions');
  const signInBtn = () => {
    const g = googleButton();
    g.addEventListener('click', () => startSignIn());
    return g;
  };
  const boardBtn = el('button', 'secondary view-board-btn', 'View leaderboard');
  boardBtn.type = 'button';
  boardBtn.addEventListener('click', openFullBoard);

  if (isGuest()) {
    box.classList.add('nudge');
    const allFreeDone = free.length > 0 && free.every(isPassed);
    if (passedCount === 0) {
      // A first-time guest already has the hero's button, pointing at the same
      // challenge. A second box saying "Start" would only compete with it.
      box.hidden = true;
      return;
    } else if (allFreeDone) {
      box.append(
        badge(String(passedCount), 'passed'),
        text("You've cleared every free challenge",
          `Sign in to unlock ${lockedCount} more and put your scores on the leaderboard.`),
      );
      actions.append(signInBtn());
    } else {
      box.append(
        badge(String(passedCount), 'passed'),
        text(`${passedCount} passed as a guest`, 'Sign in to put your scores on the leaderboard — they carry over.'),
      );
      actions.append(signInBtn());
    }
  } else if (!myStanding) {
    box.classList.add('nudge');
    box.append(
      badge('0', 'passed', true),
      text("You haven't passed a challenge yet", 'Pass one to join the leaderboard.'),
    );
    // No "Start" here: the hero's button, just above, already goes to the same place.
  } else {
    const levels = Object.entries(myStanding.passedByLevel ?? {})
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .map(([lvl, n]) => `${DIFFICULTY[lvl]} ${n}`)
      .join(' · ');
    box.append(
      badge(`#${myStanding.rank}`, 'on the leaderboard'),
      text(`You're ranked #${myStanding.rank} of ${totalPlayers}`,
        `${myStanding.completed} passed${levels ? ` — ${levels}` : ''}`),
    );
  }
  actions.append(boardBtn);
  box.appendChild(actions);
}

// --------------------------------------------------------------------- play

function showView(which) {
  for (const v of ['list', 'play', 'result', 'gallery', 'terms']) $(`${v}-view`).hidden = which !== v;
  window.scrollTo({ top: 0 });
}

/** The models this player may choose here. Guests: the free Groq models.
 *  Signed-in: gpt-4.1-nano, plus gpt-4.1-mini on Hard. The Worker enforces it. */
function renderModelSelect(challenge) {
  const select = $('model');
  const list = isGuest() ? guestModels : (challenge.models ?? guestModels);
  const keep = list.includes(select.value) ? select.value : list[0];
  select.replaceChildren(
    ...list.map((m) => Object.assign(document.createElement('option'), { value: m, textContent: shortModel(m) })),
  );
  select.value = keep;
  const paid = list.some((m) => m.startsWith('gpt-4.1'));
  $('model-hint').textContent = isGuest()
    ? 'Sign in for the faster gpt-4.1 models'
    : paid && list.length === 1 ? 'gpt-4.1-mini unlocks on Hard challenges' : '';
}

function renderPlayTags(challenge) {
  $('play-tags').replaceChildren(typeChip(challenge.mode), difficultyNode(challenge.difficulty), statusNode(challenge));
}

/** Fixed context the model receives on every case, then one example of the text
 *  the player's prompt will face — so nobody is told to use "the policy below"
 *  with no policy below it. */
function renderFrame(challenge) {
  const frame = $('play-frame');
  frame.replaceChildren();

  for (const part of challenge.context ?? []) {
    const box = el('div', 'frame-part context');
    const label = el('div', 'frame-label');
    label.append(el('strong', null, titleCase(part.label)), el('span', null, 'the model sees this with every case'));
    // Authored with hard wraps for the YAML; reflowed for reading. Display only —
    // the model receives it exactly as written.
    const prose = part.text.split(/\n\s*\n/).map((para) => para.replace(/\s*\n\s*/g, ' ').trim());
    const text = el('div', 'frame-prose');
    for (const para of prose) text.appendChild(el('p', null, para));
    box.append(label, text);
    frame.appendChild(box);
  }

  if (challenge.exampleInput) {
    const box = el('div', 'frame-part');
    const label = el('div', 'frame-label');
    label.append(
      el('strong', null, INPUT_LABEL[challenge.inputLabel] ?? 'Example input'),
      el('span', null, `one of the ${challenge.testCaseCount} your prompt is tested on`),
    );
    box.append(label, el('pre', null, challenge.exampleInput));
    frame.appendChild(box);
  }

  frame.hidden = frame.childElementCount === 0;
}

function openChallenge(challenge, { push = true } = {}) {
  if (!challenge) return;
  if (isLocked(challenge)) {
    startSignIn(() => openChallenge(challenge));
    return;
  }
  if (current && current.id !== challenge.id) saveDraft();
  current = challenge;
  if (push) history.pushState({}, '', `${BASE}/c/${challenge.id}`);
  showView('play');
  $('run-status').replaceChildren();
  $('run-status').className = '';

  renderPlayTags(challenge);
  renderModelSelect(challenge);
  $('play-title').textContent = challenge.title;
  $('play-summary').textContent = challenge.summary ?? '';
  $('play-goal').textContent = challenge.goal;
  renderFrame(challenge);

  // A debug challenge hands over a broken prompt to fix; the others start blank.
  const fixing = challenge.mode === 'debug' && challenge.startingPrompt;
  $('prompt-label').textContent = fixing ? 'The prompt to fix' : 'Your prompt';
  $('prompt-hint').textContent =
    challenge.mode === 'golf' && challenge.parTokens
      ? `Par ${challenge.parTokens} tokens ≈ ${challenge.parTokens * 4} characters`
      : '';
  $('prompt').value = draftFor(challenge);
  $('prompt-reset').hidden = !fixing || $('prompt').value === challenge.startingPrompt;
  updateCharCount();

  // Coming back to a challenge shows where you left it.
  const last = lastResults.get(challenge.id);
  if (last) renderScorecard(last);
  else $('scorecard').replaceChildren();

  $('prompt').focus({ preventScroll: true });
}

$('prompt-reset').addEventListener('click', () => {
  if (!current) return;
  $('prompt').value = current.startingPrompt ?? '';
  saveDraft();
  $('prompt-reset').hidden = true;
  updateCharCount();
});

function renderGrading(challenge) {
  const body = $('grading-body');
  body.replaceChildren();

  const facts = el('div', 'facts');
  const fact = (big, small) => {
    const f = el('div', 'fact');
    f.append(el('b', null, big), el('span', null, small));
    return f;
  };
  facts.append(
    fact(String(challenge.testCaseCount), 'hidden test cases'),
    fact(`${Math.round(challenge.passThreshold * 100)}%`, 'to pass'),
  );
  body.appendChild(facts);

  if (challenge.gradedOn?.length) {
    body.appendChild(el('h3', null, "What's checked"));
    const ul = el('ul', 'checks');
    for (const item of challenge.gradedOn) ul.appendChild(el('li', null, item));
    body.appendChild(ul);
  }

  if (challenge.constraintsShown?.length) {
    body.appendChild(el('h3', null, 'Rules'));
    const ul = el('ul', 'checks rules');
    for (const item of challenge.constraintsShown) ul.appendChild(el('li', null, item));
    body.appendChild(ul);
  }

  if (challenge.grading?.length) {
    body.appendChild(el('h3', null, 'Where the points come from'));
    const list = el('div', 'weights');
    for (const g of challenge.grading) {
      const row = el('div', 'weight-row');
      row.append(el('strong', null, metricName(g.metric)), el('em', null, `${Math.round(g.share * 100)}%`));
      const bar = el('div', 'bar');
      const fill = document.createElement('span');
      fill.style.width = `${Math.round(g.share * 100)}%`;
      bar.appendChild(fill);
      row.appendChild(bar);
      if (METRIC[g.metric]) row.appendChild(el('p', null, METRIC[g.metric][1]));
      list.appendChild(row);
    }
    body.appendChild(list);
  }

  if (challenge.mode === 'golf' && challenge.parTokens) {
    body.appendChild(el('h3', null, 'Brevity bonus'));
    body.appendChild(
      el('p', null,
        `Once you pass, a shorter prompt earns up to +${challenge.maxBonus} points. Par is ` +
        `${challenge.parTokens} tokens (about ${challenge.parTokens * 4} characters) and earns nothing — ` +
        'half of par earns half the bonus. A prompt that fails earns no bonus, however short.'),
    );
  }

  const note = el('div', 'callout');
  note.append(
    el('strong', null, 'The test cases stay hidden. '),
    document.createTextNode(
      "After a run you'll see which cases passed and why the others didn't — but never the expected answers, " +
        'so the only way to pass is a prompt that genuinely works.'),
  );
  body.appendChild(note);
}

$('open-grading').addEventListener('click', () => {
  if (!current) return;
  renderGrading(current);
  showDrawer('drawer-grading');
});

function updateCharCount() {
  const limit = current?.maxPromptChars ?? 2000;
  const used = $('prompt').value.length;
  const counter = $('charcount');
  counter.textContent = `${used} / ${limit} characters`;
  counter.className = used > limit ? 'over-limit' : 'muted';
  $('run').disabled = used === 0 || used > limit;
}

// ---------------------------------------------------------------- scorecard

function metricBars(byGrader) {
  const bars = el('div', 'bars');
  for (const grader of byGrader) {
    const row = el('div', 'bar-row');
    row.appendChild(el('span', null, metricName(grader.metric)));
    const bar = el('div', 'bar');
    const fill = document.createElement('span');
    fill.style.width = `${Math.round(grader.score * 100)}%`;
    bar.appendChild(fill);
    row.appendChild(bar);
    row.appendChild(el('span', 'muted', `${Math.round(grader.score * 100)}%`));
    bars.appendChild(row);
  }
  return bars;
}

async function setShared(submissionId, share) {
  const token = await getIdToken();
  if (!token) throw new Error('Sign in first.');
  const res = await fetch(`${API}/api/result/${submissionId}/visibility`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ showPrompt: share }),
  });
  if (res.status === 403) throw new Error('This run belongs to a different account — run it again to share it.');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** Share / Unshare, as one toggle that knows its own state. */
function shareToggle(submissionId, initiallyShared, onChange) {
  const btn = el('button', 'secondary');
  btn.type = 'button';
  let shared = initiallyShared;
  const paint = () => (btn.textContent = shared ? 'Shared · Unshare' : 'Share to gallery');
  paint();
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await setShared(submissionId, !shared);
      shared = !shared;
      paint();
      onChange?.(shared);
      toast(shared ? 'Shared to the gallery. Players who pass this challenge can read your prompt.' : 'Unshared.');
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

function renderScorecard(result) {
  const card = $('scorecard');
  card.replaceChildren();

  const total = el('div', 'total');
  total.appendChild(el('span', 'score', String(result.score)));
  total.appendChild(el('span', 'muted', '/ 100'));
  total.appendChild(
    el('span', result.passed ? 'verdict-pass' : 'verdict-fail', result.passed ? 'Passed' : 'Not yet'),
  );
  total.appendChild(el('span', 'muted', `${shortModel(result.execModel)} · ${result.promptChars} chars`));
  if (result.efficiencyBonus > 0) {
    total.appendChild(el('span', 'muted', `${result.baseScore} correctness + ${result.efficiencyBonus} brevity`));
  }
  card.appendChild(total);

  if (result.byGrader.length > 0) card.appendChild(metricBars(result.byGrader));

  for (const test of result.tests) {
    const box = el('div', `case ${test.status}`);
    const heading = el('h4');
    heading.appendChild(el('span', null, `Case ${test.id.replace(/^t/, '')}`));
    heading.appendChild(el('span', 'badge', test.status));
    if (test.judgingSkipped) heading.appendChild(el('span', 'badge', 'judge skipped'));
    box.appendChild(heading);

    if (test.input === null) {
      // A hidden case: the server sent no input or output at all.
      box.appendChild(el('p', 'muted', 'This test case is hidden.'));
    } else {
      box.appendChild(el('p', 'muted', 'Input'));
      box.appendChild(el('pre', null, test.input));
      box.appendChild(el('p', 'muted', 'Your prompt produced'));
      box.appendChild(el('pre', null, test.output || '(empty)'));
    }

    if (test.failures.length > 0) {
      const ul = document.createElement('ul');
      for (const failure of test.failures) {
        const text = failure.expected
          ? `${metricName(failure.metric)}: ${failure.reason} Expected: ${failure.expected}`
          : `${metricName(failure.metric)}: ${failure.reason}`;
        ul.appendChild(el('li', null, text));
      }
      box.appendChild(ul);
    }
    card.appendChild(box);
  }

  // Share controls. The link is an unguessable id, so it is unlisted; the gallery
  // is opt-in, and only for signed-in players — sharing shows a name and a photo.
  if (result.submissionId && !result.cached) {
    const share = el('div', 'share');
    const url = `${location.origin}${BASE}/r/${result.submissionId}`;

    const copy = el('button', 'secondary', 'Copy link');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy link'), 1500);
      } catch {
        // Clipboard access can be refused; showing the link is the fallback.
        copy.replaceWith(el('code', null, url));
      }
    });
    share.appendChild(copy);

    if (isGuest()) {
      const g = googleButton('Log in to share your results');
      g.addEventListener('click', () => startSignIn(() => renderScorecard(result)));
      share.appendChild(g);
    } else {
      share.appendChild(shareToggle(result.submissionId, Boolean(result.sharedToGallery), (v) => {
        result.sharedToGallery = v;
      }));
    }
    card.appendChild(share);
  }

  if (!result.leaderboardEligible) {
    card.appendChild(
      el('div', 'notice',
        'This run is not leaderboard-eligible: at least one grader could not run. ' +
          'That is our side, not your prompt.'),
    );
  }

  renderNudge(result);
}

/** After a guest passes something, say what signing in would do for them. */
function renderNudge(result) {
  if (!isGuest() || !result.passed) return;
  const free = challenges.filter((c) => c.freeToPlay);
  const allFreeDone = free.length > 0 && free.every((c) => isPassed(c) || c.id === result.challengeId);
  const box = el('div', 'nudge-box');
  const p = el('p');
  if (allFreeDone) {
    p.append(el('strong', null, "That's every free challenge. "),
      document.createTextNode(`Sign in to unlock ${challenges.filter(isLocked).length} more, and put your scores on the leaderboard.`));
  } else {
    p.append(el('strong', null, 'Passed! '),
      document.createTextNode('Sign in to add this score to the leaderboard — your progress carries over.'));
  }
  const g = googleButton();
  g.addEventListener('click', () => startSignIn());
  box.append(p, g);
  $('scorecard').appendChild(box);
}

async function run() {
  const button = $('run');
  button.disabled = true;
  saveDraft();
  $('scorecard').replaceChildren();
  $('run-status').className = 'muted';
  $('run-status').textContent = `Running against ${current.testCaseCount} hidden test cases…`;
  const challenge = current;

  try {
    const token = await getIdToken();
    const res = await fetch(`${API}/api/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        challengeId: challenge.id,
        prompt: $('prompt').value,
        model: $('model').value,
      }),
    });
    const data = await res.json();

    // A guest's free runs are spent — the hourly limit, the shared allowance, or
    // Groq itself. Signing in is the answer to all three, so say that, with the
    // button right there, rather than reporting a failure.
    // A refused run must not cost the player the result they already had.
    const restore = () => {
      const last = lastResults.get(challenge.id);
      if (last && current?.id === challenge.id) renderScorecard(last);
    };

    if (!res.ok && data.signInUnlocks) {
      restore();
      $('run-status').className = 'nudge-box';
      $('run-status').replaceChildren(el('p', null, data.message));
      const g = googleButton('Sign in to keep going');
      g.addEventListener('click', () => startSignIn());
      $('run-status').appendChild(g);
      return;
    }

    if (res.status === 401 && data.error === 'sign_in_required') {
      restore();
      $('run-status').className = 'nudge-box';
      $('run-status').replaceChildren(el('p', null, 'Sign in with Google to play this challenge.'));
      const g = googleButton();
      g.addEventListener('click', () => startSignIn());
      $('run-status').appendChild(g);
      return;
    }

    if (!res.ok) {
      restore();
      throw new Error(data.message || data.error || `HTTP ${res.status}`);
    }
    $('run-status').textContent = '';
    $('run-status').className = '';
    lastResults.set(challenge.id, data);
    // Any banked run can change a card's status or the board, not only a new best.
    await loadBoard();
    if (current?.id === challenge.id) {
      renderScorecard(data);
      renderPlayTags(challenge);
    }
  } catch (err) {
    $('run-status').className = 'notice error-box';
    $('run-status').textContent = `Run failed — ${err.message}`;
  } finally {
    button.disabled = false;
    updateCharCount();
  }
}

// -------------------------------------------------------------- leaderboard

function boardRow(row, youUid) {
  const isYou = row.uid === youUid;
  const li = el('li', `board-row${isYou ? ' you' : ''}${row.rank <= 3 ? ' top' : ''}`);
  li.appendChild(el('span', 'board-rank', String(row.rank)));
  // Signed-in players' Google photos are shown, as the terms say.
  li.appendChild(avatarNode(displayName(row.displayName), row.avatarUrl, true));
  const name = el('span', 'board-name', displayName(row.displayName));
  if (isYou) name.appendChild(el('small', null, ' (you)'));
  li.appendChild(name);
  // Show the number that decides the order — passes at their hardest level — so
  // "3 passed" above "6 passed" reads as right rather than as a bug.
  const top = Object.keys(row.passedByLevel ?? {}).map(Number).sort((a, b) => b - a)[0];
  const score = el('span', 'board-score', `${row.completed} passed`);
  score.appendChild(
    el('small', null, top ? `${row.passedByLevel[top]} ${DIFFICULTY[top]} · ${row.totalScore} pts` : `${row.totalScore} pts`),
  );
  li.appendChild(score);
  return li;
}

async function fetchBoard(limit) {
  const token = await getIdToken();
  const res = await fetch(`${API}/api/leaderboard?limit=${limit}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadBoard() {
  const status = $('board-status');
  try {
    const data = await fetchBoard(10);

    progress = new Map((data.progress ?? []).map((p) => [p.challengeId, p]));
    myStanding = data.you ?? null;
    totalPlayers = data.totalPlayers ?? data.leaderboard.length;
    boardLoaded = true;
    if (challenges.length) renderList();
    if (current && !$('play-view').hidden) renderPlayTags(current);

    const list = $('board-top');
    list.replaceChildren();
    const youUid = getUser()?.uid;

    if (data.leaderboard.length === 0) {
      status.hidden = false;
      status.textContent = 'Nobody is on the board yet. Be first.';
    } else {
      status.hidden = true;
      for (const row of data.leaderboard) list.appendChild(boardRow(row, youUid));
    }

    // Someone outside the top ten still gets to see where they stand.
    const you = $('board-you');
    you.replaceChildren();
    if (myStanding && !data.leaderboard.some((r) => r.uid === youUid)) {
      const ol = el('ol', 'board-list');
      ol.appendChild(boardRow(myStanding, youUid));
      you.appendChild(ol);
    }

    // A guest is never ranked; say how to change that, right where they look.
    const guestBox = $('board-guest');
    guestBox.replaceChildren();
    guestBox.hidden = true;
    if (isGuest()) {
      guestBox.hidden = false;
      guestBox.appendChild(document.createTextNode('Guests are not ranked. Sign in to join the leaderboard — your progress carries over.'));
      const g = googleButton();
      g.addEventListener('click', () => startSignIn());
      guestBox.appendChild(g);
    } else if (!myStanding) {
      guestBox.hidden = false;
      guestBox.textContent = 'Pass a challenge to join the leaderboard.';
    }

    const more = $('board-more');
    more.hidden = totalPlayers <= data.leaderboard.length;
    more.textContent = `Show all ${totalPlayers} players →`;
  } catch (err) {
    status.hidden = false;
    status.textContent = `Could not load the leaderboard — ${err.message}`;
  }
}

async function openFullBoard() {
  showDrawer('drawer-board');
  const status = $('full-board-status');
  const list = $('full-board');
  status.hidden = false;
  status.textContent = 'Loading…';
  list.replaceChildren();
  try {
    const data = await fetchBoard(500);
    const youUid = getUser()?.uid;
    for (const row of data.leaderboard) list.appendChild(boardRow(row, youUid));
    if (data.leaderboard.length === 0) status.textContent = 'Nobody is on the board yet. Be first.';
    else status.hidden = true;
  } catch (err) {
    status.textContent = `Could not load the full list — ${err.message}`;
  }
}
$('board-more').addEventListener('click', openFullBoard);

// ------------------------------------------------------------ shared result

/** A shared result is deliberately thinner than your own scorecard: it carries
 *  the score and the grader breakdown but none of the hidden test inputs, because
 *  whoever opens the link may never have attempted the challenge. */
async function loadSharedResult(id) {
  showView('result');
  const status = $('result-status');
  const card = $('result-card');
  card.replaceChildren();
  status.hidden = false;
  status.className = 'muted';
  status.textContent = 'Loading…';

  try {
    await authReady;
    const token = await getIdToken();
    const res = await fetch(`${API}/api/result/${encodeURIComponent(id)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.status === 404) throw new Error('That result does not exist.');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = await res.json();

    const challenge = challenges.find((c) => c.id === r.challengeId);
    status.hidden = true;

    card.appendChild(el('h2', null, challenge ? challenge.title : r.challengeId));
    const by = el('div', 'byline');
    by.append(
      avatarNode(displayName(r.playerName), r.avatarUrl, true),
      el('strong', null, r.isYours ? 'You' : displayName(r.playerName)),
      el('span', null, `· run ${formatDateTime(r.createdAt)} · ${shortModel(r.execModel)}`),
    );
    card.appendChild(by);

    const total = el('div', 'total');
    total.appendChild(el('span', 'score', String(r.score)));
    total.appendChild(el('span', 'muted', '/ 100'));
    total.appendChild(el('span', r.passed ? 'verdict-pass' : 'verdict-fail', r.passed ? 'Passed' : 'Not passed'));
    total.appendChild(
      el('span', 'muted',
        `${r.cases.passed} passed, ${r.cases.failed} failed` + (r.cases.errored ? `, ${r.cases.errored} errored` : '')),
    );
    card.appendChild(total);

    if (r.byGrader.length > 0) card.appendChild(metricBars(r.byGrader));

    card.appendChild(el('p', 'muted', `The prompt · ${r.promptChars} characters`));
    if (r.prompt) {
      card.appendChild(el('pre', 'prompt-block', r.prompt));
    } else if (r.promptLocked) {
      card.appendChild(el('div', 'locked-prompt', 'Pass this challenge yourself to read the prompt.'));
    } else {
      card.appendChild(el('div', 'locked-prompt', "The author hasn't shared this prompt."));
    }

    const actions = el('div', 'result-actions');
    const tryIt = el('button', 'primary', r.isYours ? 'Back to this challenge' : 'Try this challenge');
    tryIt.type = 'button';
    tryIt.addEventListener('click', () => (challenge ? openChallenge(challenge) : navigate(BASE + '/')));
    actions.appendChild(tryIt);
    if (r.isYours && !isGuest()) actions.appendChild(shareToggle(r.id, r.shared));
    card.appendChild(actions);
  } catch (err) {
    status.className = 'notice error-box';
    status.textContent = `Could not load that result — ${err.message}`;
  }
}

// ------------------------------------------------------------------ gallery

async function openGallery() {
  showView('gallery');
  await authReady;
  $('gallery-mine-wrap').hidden = isGuest();
  if (isGuest()) $('gallery-mine').checked = false;
  await loadGallery();
}

async function loadGallery() {
  const status = $('gallery-status');
  const list = $('gallery-list');
  status.hidden = false;
  status.className = 'muted';
  status.textContent = 'Loading…';
  list.replaceChildren();

  const params = new URLSearchParams();
  if ($('gallery-difficulty').value) params.set('difficulty', $('gallery-difficulty').value);
  params.set('sort', $('gallery-sort').value);
  if ($('gallery-mine').checked) params.set('mine', '1');

  try {
    const token = await getIdToken();
    const res = await fetch(`${API}/api/shares?${params}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { shares } = await res.json();

    if (shares.length === 0) {
      status.textContent = $('gallery-mine').checked
        ? "You haven't shared anything yet. Run a challenge, then choose “Share to gallery”."
        : 'Nothing shared here yet.';
      return;
    }
    status.hidden = true;
    for (const s of shares) list.appendChild(shareRow(s));
  } catch (err) {
    status.className = 'notice error-box';
    status.textContent = `Could not load shared prompts — ${err.message}`;
  }
}

/** One share, in two or three lines: what and how well, who and when, the prompt. */
function shareRow(s) {
  const challenge = challenges.find((c) => c.id === s.challengeId);
  const li = el('li', `share-row${s.isYours ? ' yours' : ''}`);

  const top = el('div', 'share-top');
  top.append(el('span', 'share-title', challenge?.title ?? s.challengeId));
  if (challenge) top.append(el('span', 'share-level', DIFFICULTY[challenge.difficulty]));
  li.appendChild(top);

  const score = el('div', 'share-score');
  score.append(el('b', s.passed ? 'pass' : '', String(s.score)), el('small', null, s.passed ? 'passed' : 'not passed'));
  li.appendChild(score);

  const meta = el('div', 'share-meta');
  meta.append(
    avatarNode(displayName(s.playerName), s.avatarUrl, true),
    el('strong', null, s.isYours ? 'You' : displayName(s.playerName)),
    el('span', null, `· ${formatDateTime(s.runAt)} · ${shortModel(s.execModel)} · ${s.promptChars} chars`),
  );
  li.appendChild(meta);

  const line = el('div', `share-line${s.prompt ? '' : ' locked'}`);
  const actions = el('span', 'share-actions');
  if (s.prompt) {
    line.appendChild(el('code', null, s.prompt.replace(/\s+/g, ' ')));
    const expand = el('button', 'text-btn', 'Show');
    expand.type = 'button';
    let full = null;
    expand.addEventListener('click', () => {
      if (full) {
        full.remove();
        full = null;
        expand.textContent = 'Show';
      } else {
        full = el('pre', 'share-prompt', s.prompt);
        li.appendChild(full);
        expand.textContent = 'Hide';
      }
    });
    actions.appendChild(expand);
  } else {
    line.appendChild(el('span', null, '🔒 Pass this challenge to read the prompt'));
    if (challenge && !isPassed(challenge)) {
      const tryIt = el('button', 'text-btn', 'Try it');
      tryIt.type = 'button';
      tryIt.addEventListener('click', () => openChallenge(challenge));
      actions.appendChild(tryIt);
    }
  }
  const open = el('a', 'text-btn', 'Open');
  open.href = `${BASE}/r/${s.id}`;
  open.addEventListener('click', (e) => {
    e.preventDefault();
    navigate(`${BASE}/r/${s.id}`);
  });
  actions.appendChild(open);
  if (s.isYours) {
    const unshare = el('button', 'text-btn danger', 'Unshare');
    unshare.type = 'button';
    unshare.addEventListener('click', async () => {
      unshare.disabled = true;
      try {
        await setShared(s.id, false);
        li.remove();
        toast('Unshared.');
        if ($('gallery-list').childElementCount === 0) loadGallery();
      } catch (err) {
        toast(err.message);
        unshare.disabled = false;
      }
    });
    actions.appendChild(unshare);
  }
  line.appendChild(actions);
  li.appendChild(line);
  return li;
}

for (const id of ['gallery-difficulty', 'gallery-sort', 'gallery-mine']) {
  $(id).addEventListener('change', loadGallery);
}

// The ranking tooltip opens on hover, and on tap — phones have no hover. It is
// fixed-positioned so the scrolling sidebar cannot clip it, which means placing
// it here: below the button, right-aligned to it, kept inside the window.
const tip = document.querySelector('.tip');
function placeTip() {
  const btn = tip.querySelector('.tip-btn').getBoundingClientRect();
  const body = tip.querySelector('.tip-body');
  const width = body.offsetWidth || 280;
  const left = Math.min(Math.max(8, btn.right - width), window.innerWidth - width - 8);
  body.style.left = `${left}px`;
  body.style.top = `${btn.bottom + 8}px`;
}
tip.addEventListener('mouseenter', placeTip);
tip.querySelector('.tip-btn').addEventListener('focus', placeTip);
tip.querySelector('.tip-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  placeTip();
  tip.classList.toggle('open');
});
document.addEventListener('click', () => tip.classList.remove('open'));
// A fixed tooltip would drift away from its button; close it instead.
window.addEventListener('scroll', () => tip.classList.remove('open'), { passive: true });
document.querySelector('.sidebar').addEventListener('scroll', () => tip.classList.remove('open'), { passive: true });

// ------------------------------------------------------------------ account

function closeUserMenu() {
  $('user-menu').hidden = true;
  $('user-chip').setAttribute('aria-expanded', 'false');
}

$('user-chip').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('user-menu');
  menu.hidden = !menu.hidden;
  $('user-chip').setAttribute('aria-expanded', String(!menu.hidden));
});
document.addEventListener('click', (e) => {
  if (!$('account-user').contains(e.target)) closeUserMenu();
});

/** Google sign-in, from anywhere on the page.
 *
 *  A guest with no Google account here is linked, keeping the same uid, so their
 *  progress simply carries over. A guest whose Google account already plays
 *  signs into that account instead, and their saved progress loads from it. */
async function startSignIn(then) {
  await authReady;
  const result = await signInWithGoogle();
  if (!result.ok) {
    // A closed popup is the user changing their mind, not a failure worth shouting about.
    if (result.error === 'auth/popup-closed-by-user' || result.error === 'auth/cancelled-popup-request') return;
    toast(`Sign-in failed: ${result.error}`);
    return;
  }
  toast(result.linked ? 'Signed in — your progress carried over.' : 'Welcome back — your saved progress is loaded.');
  // The auth listener has already refetched with the signed-in token (see
  // onUserChanged); this makes sure the page has it before continuing.
  await loadBoard();
  then?.();
}

onUserChanged((user) => {
  $('account-loading').hidden = Boolean(user);
  $('account-loading').textContent = signingOut ? 'Signing out…' : 'Signing in…';
  $('account-guest').hidden = !user || !user.isAnonymous;
  $('account-user').hidden = !user || user.isAnonymous;
  $('feedback-fab').hidden = !user || user.isAnonymous;
  if ($('feedback-fab').hidden && openDrawer === $('drawer-feedback')) closeDrawer();
  if (user) signingOut = false;

  if (user && !user.isAnonymous) {
    const name = user.name || 'Signed in';
    $('user-avatar').replaceWith(Object.assign(avatarNode(name, user.photo), { id: 'user-avatar' }));
    $('user-name').textContent = name;
    $('user-menu-name').textContent = name;
  }

  // Locks and model choices depend on who is signed in; repaint before the board
  // comes back.
  if (challenges.length) renderList();
  if (current && !$('play-view').hidden) renderModelSelect(current);

  // Refetch progress and the board whenever who-is-signed-in changes in any way
  // that shows: a new uid, a guest becoming a Google account, or a name arriving
  // after the profile repair. Keying on the uid alone left the board saying
  // "Anonymous" after sign-in until a reload. The board itself is public and was
  // already fetched without waiting for sign-in.
  const key = user ? `${user.uid}|${user.isAnonymous}|${user.name ?? ''}` : null;
  if (key && key !== boardUid) {
    boardUid = key;
    loadBoard();
  }
});

// Disabled until the anonymous session exists, so a fast click cannot bypass
// account linking and strand the guest's scores.
$('signin').disabled = true;
authReady.then(() => {
  $('signin').disabled = false;
});
$('signin').addEventListener('click', () => startSignIn());

$('signout').addEventListener('click', () => {
  closeUserMenu();
  signingOut = true;
  // Show it straight away: Firebase reports the sign-out a moment later.
  $('account-user').hidden = true;
  $('account-loading').hidden = false;
  $('account-loading').textContent = 'Signing out…';
  progress = new Map();
  myStanding = null;
  signOutUser();
});

// ----------------------------------------------------------------- feedback

// Signed-in players only. The button is hidden from guests, and the Worker
// refuses them too — this only decides what the page offers.
const FEEDBACK_MAX = 2000;
const feedbackDraftKey = 'feedback-draft';

/** Where the player is, sent with the message so a bug report arrives with its
 *  context. Only the challenge id is added: the Worker checks it exists. */
function feedbackContext() {
  const onChallenge = current && !$('play-view').hidden;
  return { page: location.pathname, challengeId: onChallenge ? current.id : null, title: onChallenge ? current.title : null };
}

function updateFeedbackCount() {
  const length = $('feedback-message').value.trim().length;
  $('feedback-count').textContent = `${$('feedback-message').value.length} / ${FEEDBACK_MAX}`;
  $('feedback-send').disabled = length === 0;
}

function openFeedback() {
  $('feedback-form').hidden = false;
  $('feedback-done').hidden = true;
  $('feedback-status').textContent = '';
  $('feedback-message').value = storageGet(feedbackDraftKey) ?? '';
  const ctx = feedbackContext();
  $('feedback-context').textContent = ctx.title
    ? `Sent with your name, email and the challenge you're on (“${ctx.title}”), so a reply can reach you.`
    : 'Sent with your name, email and the page you are on, so a reply can reach you.';
  updateFeedbackCount();
  showDrawer('drawer-feedback');
  $('feedback-message').focus();
}

$('feedback-fab').addEventListener('click', openFeedback);
$('feedback-message').addEventListener('input', () => {
  updateFeedbackCount();
  storageSet(feedbackDraftKey, $('feedback-message').value);
});
$('feedback-another').addEventListener('click', openFeedback);

$('feedback-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = $('feedback-message').value.trim();
  if (!message) return;

  const send = $('feedback-send');
  const status = $('feedback-status');
  send.disabled = true;
  send.textContent = 'Sending…';
  status.className = 'feedback-status';
  status.textContent = '';

  try {
    const token = await getIdToken();
    const { page, challengeId } = feedbackContext();
    const res = await fetch(`${API}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ message, page, challengeId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const why =
        data.message ??
        (res.status === 401 ? 'Sign in with Google to send feedback.' : 'It could not be sent just now. Please try again.');
      throw new Error(why);
    }
    // Sent: the draft has done its job.
    storageSet(feedbackDraftKey, '');
    $('feedback-message').value = '';
    $('feedback-form').hidden = true;
    $('feedback-done').hidden = false;
  } catch (err) {
    // The draft is still saved, so nothing typed is lost.
    status.className = 'feedback-status error';
    status.textContent = err.message;
  } finally {
    send.textContent = 'Send';
    updateFeedbackCount();
  }
});

// -------------------------------------------------------------------- wiring

$('prompt').addEventListener('input', () => {
  updateCharCount();
  saveDraft();
  if (current?.mode === 'debug') $('prompt-reset').hidden = $('prompt').value === (current.startingPrompt ?? '');
});
$('run').addEventListener('click', run);

loadChallenges().then(() => {
  // Challenge titles are needed before any route can name one.
  route();

  // The board is public, so it does not wait for sign-in. If Firebase is slow or
  // fails, visitors still see who is winning; progress fills in once a uid exists.
  if (!boardUid) loadBoard();
});
