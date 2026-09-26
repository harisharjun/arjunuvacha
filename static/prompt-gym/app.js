import { onUserChanged, getIdToken, getUser, signInWithGoogle, signOutUser, authReady } from './auth.js';

// Served from localhost while developing, so talk to `wrangler dev` rather than
// the deployed worker. `?api=` overrides both when testing one against the other.
const API =
  new URLSearchParams(location.search).get('api') ??
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? 'http://localhost:8787'
    : 'https://prompt-gym.harisharjun127.workers.dev');

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

let challenges = [];
let models = [];
let current = null;
/** challengeId -> { bestScore, passed, passedAt } for whoever is signed in. */
let progress = new Map();
let boardUid = null;

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
function formatDate(sqlite) {
  if (!sqlite) return '';
  const d = new Date(sqlite.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

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

/** One of three states, and the only place the rules for them live. */
function statusOf(challenge) {
  const p = progress.get(challenge.id);
  if (!p) return { kind: 'new' };
  if (p.passed) return { kind: 'passed', score: p.bestScore, date: formatDate(p.passedAt) };
  return { kind: 'partial', score: p.bestScore, bar: Math.round(challenge.passThreshold * 100) };
}

function statusNode(challenge) {
  const s = statusOf(challenge);
  if (s.kind === 'passed') return el('span', 'status passed', `✓ Passed${s.date ? ` · ${s.date}` : ''}`);
  if (s.kind === 'partial') return el('span', 'status partial', `In progress · best ${s.score}`);
  return el('span', 'status new', 'Not started');
}

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
const initial = (name) => (name?.trim()?.[0] ?? '?').toUpperCase();

function toast(message) {
  const t = $('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 7000);
}

// ------------------------------------------------------------ bring-your-own key

// This browser and nowhere else. The key is sent with each run and used for that
// run; the Worker never writes it to the database or to a log. Local storage
// throws in some private-browsing modes, so every access is guarded — a browser
// that refuses to remember the key should still let someone play on the shared one.
const KEY_STORAGE = 'promptgym.groqKey';

function storedKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

function rememberKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
    return true;
  } catch {
    return false;
  }
}

/** Held in memory as well as in storage, so a browser that refuses to persist it
 *  still uses it for the rest of the session. */
let sessionKey = storedKey();

function renderKeyState(message) {
  const status = $('byo-status');
  const active = Boolean(sessionKey);

  $('byo-summary').textContent = active ? 'Using your own Groq key' : 'Use your own Groq key';
  $('byo-key').value = active ? sessionKey : '';
  $('byo-clear').hidden = !active;
  $('byo-save').textContent = active ? 'Update' : 'Save key';

  if (message !== undefined) {
    status.textContent = message;
    status.className = 'muted';
  } else if (active) {
    status.textContent = 'Every run from this browser uses your key.';
    status.className = 'byo-active';
  } else {
    status.textContent = '';
    status.className = 'muted';
  }
}

/** Opens the panel where the player can reach it, with the reason. The copy comes
 *  from the Worker so the landing page and the blocked moment cannot drift. */
function offerKey(message) {
  const panel = $('byo');
  panel.open = true;
  panel.classList.add('urgent');
  renderKeyState(message);
  panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('byo-key').focus({ preventScroll: true });
}

function keyHeader() {
  return sessionKey ? { 'X-Groq-Key': sessionKey } : {};
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

// ---------------------------------------------------------------- challenges

async function loadChallenges() {
  try {
    const res = await fetch(`${API}/api/challenges`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    challenges = data.challenges;
    models = data.models;
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

  for (const challenge of challenges) {
    const s = statusOf(challenge);
    const item = document.createElement('li');
    const card = el('button', `card ${s.kind === 'new' ? '' : s.kind}`);
    card.type = 'button';

    const top = el('div', 'card-top');
    top.append(typeChip(challenge.mode), statusNode(challenge));
    card.appendChild(top);

    card.appendChild(el('h3', 'card-title', challenge.title));
    card.appendChild(el('p', 'card-summary', challenge.summary ?? ''));

    const foot = el('div', 'card-foot');
    foot.appendChild(difficultyNode(challenge.difficulty));
    if (s.kind === 'passed') {
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
  renderProgressStrip();
}

function renderProgressStrip() {
  const strip = $('progress-strip');
  if (challenges.length === 0 || progress.size === 0) {
    strip.hidden = true;
    return;
  }
  strip.hidden = false;
  strip.replaceChildren();

  const passed = challenges.filter((c) => statusOf(c).kind === 'passed').length;
  const line = el('div');
  line.appendChild(el('span', 'progress-count', `${passed} of ${challenges.length}`));
  line.appendChild(el('span', 'muted', ' passed'));
  strip.appendChild(line);

  const pips = el('div', 'pips');
  for (const c of challenges) {
    const kind = statusOf(c).kind;
    const pip = el('div', `pip${kind === 'passed' ? ' done' : kind === 'partial' ? ' partial' : ''}`);
    pip.title = c.title;
    pips.appendChild(pip);
  }
  strip.appendChild(pips);
}

// --------------------------------------------------------------------- play

function showView(which) {
  $('list-view').hidden = which !== 'list';
  $('play-view').hidden = which !== 'play';
  $('result-view').hidden = which !== 'result';
  window.scrollTo({ top: 0 });
}

function renderPlayTags(challenge) {
  const tags = $('play-tags');
  tags.replaceChildren(typeChip(challenge.mode), difficultyNode(challenge.difficulty), statusNode(challenge));
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

function openChallenge(challenge) {
  current = challenge;
  showView('play');
  $('scorecard').replaceChildren();
  $('run-status').replaceChildren();

  renderPlayTags(challenge);
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
  $('prompt').value = challenge.startingPrompt ?? '';
  updateCharCount();
  $('prompt').focus({ preventScroll: true });
}

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

function renderScorecard(result) {
  const card = $('scorecard');
  card.replaceChildren();

  const total = el('div', 'total');
  total.appendChild(el('span', 'score', String(result.score)));
  total.appendChild(el('span', 'muted', '/ 100'));
  total.appendChild(
    el('span', result.passed ? 'verdict-pass' : 'verdict-fail', result.passed ? 'Passed' : 'Not yet'),
  );
  total.appendChild(el('span', 'muted', `${result.execModel.replace(/^[^/]+\//, '')} · ${result.promptChars} chars`));
  if (result.efficiencyBonus > 0) {
    total.appendChild(el('span', 'muted', `${result.baseScore} correctness + ${result.efficiencyBonus} brevity`));
  }
  card.appendChild(total);

  if (result.byGrader.length > 0) {
    const bars = el('div', 'bars');
    for (const grader of result.byGrader) {
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
    card.appendChild(bars);
  }

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

  // Share controls. The link is an unguessable id, so it is unlisted rather than
  // public, and the prompt stays private until its owner chooses otherwise.
  if (result.submissionId && !result.cached) {
    const share = el('div', 'share');
    const url = `${location.origin}/prompt-gym/r/${result.submissionId}`;

    const copy = el('button', 'secondary', 'Copy share link');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy share link'), 1500);
      } catch {
        // Clipboard access can be refused; showing the link is the fallback.
        copy.replaceWith(el('code', null, url));
      }
    });
    share.appendChild(copy);

    if (result.uid) {
      const label = document.createElement('label');
      label.className = 'muted inline';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.addEventListener('change', async () => {
        const token = await getIdToken();
        if (!token) return;
        await fetch(`${API}/api/result/${result.submissionId}/visibility`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ showPrompt: box.checked }),
        });
      });
      label.appendChild(box);
      label.appendChild(document.createTextNode(' show my prompt on the shared page'));
      share.appendChild(label);
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
}

async function run() {
  const button = $('run');
  button.disabled = true;
  $('scorecard').replaceChildren();
  $('run-status').className = 'muted';
  $('run-status').textContent = `Running against ${current.testCaseCount} hidden test cases…`;

  try {
    const token = await getIdToken();
    const res = await fetch(`${API}/api/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...keyHeader(),
      },
      body: JSON.stringify({
        challengeId: current.id,
        prompt: $('prompt').value,
        model: $('model').value,
      }),
    });
    const data = await res.json();

    // The shared allowance is gone, or Groq throttled the house key. Either way
    // the player's own key is what clears it, so the offer is made here rather
    // than reported as a failure they can do nothing about.
    if (!res.ok && data.byoKeyAccepted) {
      $('run-status').className = 'notice';
      $('run-status').textContent = data.message;
      offerKey(data.message);
      return;
    }

    if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
    $('run-status').textContent = '';
    renderScorecard(data);
    // Any banked run can change a card's status or the board, not only a new best.
    await loadBoard();
    if (current) renderPlayTags(current);
  } catch (err) {
    $('run-status').className = 'notice error-box';
    $('run-status').textContent = `Run failed — ${err.message}`;
  } finally {
    button.disabled = false;
    updateCharCount();
  }
}

// -------------------------------------------------------------- leaderboard

function playerName(row, isYou) {
  if (row.displayName) return row.displayName;
  if (isYou) return 'You';
  // Anonymous players, and anyone whose profile we never saw, get a stable
  // handle from their uid rather than a blank cell.
  return `Player ${row.uid.slice(0, 6)}`;
}

function boardRow(row, youUid) {
  const isYou = row.uid === youUid;
  const li = el('li', `board-row${isYou ? ' you' : ''}${row.rank <= 3 ? ' top' : ''}`);
  li.appendChild(el('span', 'board-rank', String(row.rank)));
  // Initials, not other players' Google photos: the board already shows a name,
  // and publishing everyone's profile picture is a bigger step than this needs.
  li.appendChild(avatarNode(playerName(row, isYou), isYou ? getUser()?.photo : null, true));
  const name = el('span', 'board-name', playerName(row, isYou));
  if (isYou && row.displayName) name.appendChild(el('small', null, ' (you)'));
  li.appendChild(name);
  const score = el('span', 'board-score', `${row.completed} passed`);
  score.appendChild(el('small', null, `${row.totalScore} pts`));
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
    if (challenges.length) renderList();

    const list = $('board-top');
    list.replaceChildren();
    const youUid = data.you?.uid ?? getUser()?.uid;

    if (data.leaderboard.length === 0) {
      status.hidden = false;
      status.textContent = 'Nobody has passed a challenge yet. Be first.';
    } else {
      status.hidden = true;
      for (const row of data.leaderboard) list.appendChild(boardRow(row, youUid));
    }

    // Someone outside the top ten still gets to see where they stand.
    const you = $('board-you');
    you.replaceChildren();
    const inTop = data.leaderboard.some((r) => r.uid === youUid);
    if (data.you && !inTop) {
      const ol = el('ol', 'board-list');
      ol.appendChild(boardRow(data.you, youUid));
      you.appendChild(ol);
    }

    const more = $('board-more');
    const total = data.totalPlayers ?? data.leaderboard.length;
    more.hidden = total <= data.leaderboard.length;
    more.textContent = `Show all ${total} players →`;
  } catch (err) {
    status.hidden = false;
    status.textContent = `Could not load the leaderboard — ${err.message}`;
  }
}

$('board-more').addEventListener('click', async () => {
  showDrawer('drawer-board');
  const status = $('full-board-status');
  const list = $('full-board');
  status.hidden = false;
  status.textContent = 'Loading…';
  list.replaceChildren();
  try {
    const data = await fetchBoard(500);
    const youUid = data.you?.uid ?? getUser()?.uid;
    for (const row of data.leaderboard) list.appendChild(boardRow(row, youUid));
    status.hidden = true;
  } catch (err) {
    status.textContent = `Could not load the full list — ${err.message}`;
  }
});

// ------------------------------------------------------------- share links

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
    const res = await fetch(`${API}/api/result/${encodeURIComponent(id)}`);
    if (res.status === 404) throw new Error('That result does not exist.');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = await res.json();

    const challenge = challenges.find((c) => c.id === r.challengeId);
    status.hidden = true;

    const total = el('div', 'total');
    total.appendChild(el('span', 'score', String(r.score)));
    total.appendChild(el('span', 'muted', '/ 100'));
    total.appendChild(el('span', r.passed ? 'verdict-pass' : 'verdict-fail', r.passed ? 'Passed' : 'Not passed'));
    total.appendChild(el('span', 'muted', r.execModel.replace(/^[^/]+\//, '')));
    card.appendChild(total);

    card.appendChild(
      el('p', 'muted',
        `${challenge ? challenge.title : r.challengeId} · ` +
          `${r.cases.passed} passed, ${r.cases.failed} failed` +
          (r.cases.errored ? `, ${r.cases.errored} errored` : '') +
          (r.playerName ? ` · by ${r.playerName}` : '')),
    );

    if (r.byGrader.length > 0) {
      const bars = el('div', 'bars');
      for (const grader of r.byGrader) {
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
      card.appendChild(bars);
    }

    if (r.prompt) {
      card.appendChild(el('p', 'muted', 'The prompt'));
      card.appendChild(el('pre', null, r.prompt));
    } else {
      card.appendChild(el('p', 'muted', `Prompt not shown — ${r.promptChars} characters.`));
    }

    const tryIt = el('button', 'primary', 'Try this challenge');
    tryIt.type = 'button';
    tryIt.addEventListener('click', () => {
      history.pushState({}, '', '/prompt-gym/');
      if (challenge) openChallenge(challenge);
      else showView('list');
    });
    card.appendChild(tryIt);
  } catch (err) {
    status.className = 'notice error-box';
    status.textContent = `Could not load that result — ${err.message}`;
  }
}

/** `/prompt-gym/r/<id>` — Firebase rewrites every path under /prompt-gym/ to this
 *  page, so the id has to be read back off the URL here. */
function sharedResultId() {
  const match = /\/r\/([A-Za-z0-9-]{8,64})\/?$/.exec(location.pathname);
  return match ? match[1] : null;
}

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

onUserChanged((user) => {
  $('account-loading').hidden = Boolean(user);
  $('account-guest').hidden = !user || !user.isAnonymous;
  $('account-user').hidden = !user || user.isAnonymous;

  if (user && !user.isAnonymous) {
    const name = user.name || 'Signed in';
    $('user-avatar').replaceWith(Object.assign(avatarNode(name, user.photo), { id: 'user-avatar' }));
    $('user-name').textContent = name;
    $('user-menu-name').textContent = name;
  }

  // Progress is per-uid; refetch whenever the uid changes. The board itself is
  // public and has already been fetched without waiting for sign-in.
  const uid = user?.uid ?? null;
  if (uid && uid !== boardUid) {
    boardUid = uid;
    loadBoard();
  }
});

// Disabled until the anonymous session exists, so a fast click cannot bypass
// account linking and strand the guest's scores.
$('signin').disabled = true;
authReady.then(() => {
  $('signin').disabled = false;
});

$('signin').addEventListener('click', async () => {
  const button = $('signin');
  button.disabled = true;
  const result = await signInWithGoogle();
  button.disabled = false;

  if (!result.ok) {
    // A closed popup is the user changing their mind, not a failure worth shouting about.
    if (result.error === 'auth/popup-closed-by-user' || result.error === 'auth/cancelled-popup-request') return;
    toast(`Sign-in failed: ${result.error}`);
    return;
  }

  if (!result.linked) {
    toast('Signed in to your existing account — progress from this guest session did not carry over.');
  }
  // Linking keeps the uid, so the uid-change refetch above will not fire; the
  // board still has to pick up the new name.
  loadBoard();
});

$('signout').addEventListener('click', () => {
  closeUserMenu();
  signOutUser();
});

// -------------------------------------------------------------------- wiring

$('prompt').addEventListener('input', updateCharCount);
$('run').addEventListener('click', run);

$('back').addEventListener('click', () => {
  current = null;
  showView('list');
});

$('home-link').addEventListener('click', (e) => {
  // Stay in the app rather than reloading the page, unless on a share link.
  if (sharedResultId()) return;
  e.preventDefault();
  current = null;
  showView('list');
});

$('result-back').addEventListener('click', () => {
  history.pushState({}, '', '/prompt-gym/');
  showView('list');
});

$('byo-save').addEventListener('click', () => {
  const key = $('byo-key').value.trim();
  if (!key) {
    renderKeyState('Paste a key first — it starts with gsk_.');
    return;
  }
  // Checked here only to catch a pasted wrong thing early. The Worker does not
  // validate the shape: Groq owns what a valid key looks like, not us.
  if (!key.startsWith('gsk_')) {
    renderKeyState('That does not look like a Groq key — they start with gsk_.');
    return;
  }

  sessionKey = key;
  $('byo').classList.remove('urgent');
  renderKeyState(
    rememberKey(key)
      ? 'Saved in this browser. Your runs use your key from now on.'
      : 'This browser will not let the page store anything, so the key is used for ' +
          'this session only and forgotten when you close the tab.',
  );
});

$('byo-clear').addEventListener('click', () => {
  sessionKey = '';
  rememberKey('');
  $('byo').classList.remove('urgent');
  renderKeyState('Removed. Runs go back to the shared allowance.');
});

renderKeyState();

loadChallenges().then(() => {
  const select = $('model');
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model.replace(/^[^/]+\//, '');
    select.appendChild(option);
  }

  // A share link lands here too, because Firebase rewrites all of /prompt-gym/**
  // to this page. Challenge titles are needed first so the result can name one.
  const shared = sharedResultId();
  if (shared) loadSharedResult(shared);

  // The board is public, so it does not wait for sign-in. If Firebase is slow or
  // fails, visitors still see who is winning; progress fills in once a uid exists.
  if (!boardUid) loadBoard();
});
