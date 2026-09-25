import { onUserChanged, getIdToken, signInWithGoogle, signOutUser, authReady } from './auth.js';

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
    const item = document.createElement('li');
    const button = el('button', 'challenge');
    button.appendChild(el('div', 'challenge-title', challenge.title));

    const meta = el('div', 'challenge-meta');
    meta.appendChild(el('span', 'badge', challenge.mode));
    meta.appendChild(el('span', 'badge', `difficulty ${challenge.difficulty}`));
    meta.appendChild(el('span', 'badge', `${challenge.testCaseCount} hidden cases`));
    for (const family of challenge.graderFamilies) meta.appendChild(el('span', 'badge', family));
    button.appendChild(meta);

    button.addEventListener('click', () => openChallenge(challenge));
    item.appendChild(button);
    list.appendChild(item);
  }
}

// --------------------------------------------------------------------- play

function openChallenge(challenge) {
  current = challenge;
  $('list-view').hidden = true;
  $('play-view').hidden = false;
  $('scorecard').replaceChildren();
  $('run-status').replaceChildren();

  $('play-title').textContent = challenge.title;
  $('play-meta').textContent =
    `${challenge.mode} · difficulty ${challenge.difficulty} · ` +
    `${challenge.testCaseCount} hidden test cases · pass at ${Math.round(challenge.passThreshold * 100)}%`;
  $('play-goal').textContent = challenge.goal;

  const detail = $('play-constraints');
  detail.replaceChildren();
  const addBlock = (title, items) => {
    if (!items || items.length === 0) return;
    detail.appendChild(el('p', 'muted', title));
    const ul = document.createElement('ul');
    for (const entry of items) ul.appendChild(el('li', null, entry));
    detail.appendChild(ul);
  };
  addBlock('Constraints', challenge.constraintsShown);
  addBlock('Graded on', challenge.gradedOn);
  if (challenge.exampleInput) {
    detail.appendChild(el('p', 'muted', 'Example input'));
    detail.appendChild(el('pre', null, challenge.exampleInput));
  }
  $('play-detail').hidden = detail.childElementCount === 0;

  // A debug challenge hands over a broken prompt to fix; a goal challenge starts blank.
  $('prompt').value = challenge.startingPrompt ?? '';
  updateCharCount();
  $('prompt').focus();
}

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
    el('span', result.passed ? 'verdict-pass' : 'verdict-fail', result.passed ? 'PASSED' : 'not yet'),
  );
  total.appendChild(el('span', 'muted', `${result.execModel} · ${result.promptChars} chars`));
  if (result.efficiencyBonus > 0) {
    total.appendChild(el('span', 'muted', `${result.baseScore} correctness + ${result.efficiencyBonus} brevity`));
  }
  card.appendChild(total);

  if (result.byGrader.length > 0) {
    const bars = el('div', 'bars');
    for (const grader of result.byGrader) {
      const row = el('div', 'bar-row');
      row.appendChild(el('span', null, grader.metric));
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
    heading.appendChild(el('span', null, test.id));
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
          ? `${failure.metric}: ${failure.reason} Expected: ${failure.expected}`
          : `${failure.metric}: ${failure.reason}`;
        ul.appendChild(el('li', null, text));
      }
      box.appendChild(ul);
    }
    card.appendChild(box);
  }

  if (!result.leaderboardEligible) {
    card.appendChild(
      el(
        'div',
        'notice',
        'This run is not leaderboard-eligible: at least one grader could not run. ' +
          'That is our side, not your prompt.',
      ),
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
      },
      body: JSON.stringify({
        challengeId: current.id,
        prompt: $('prompt').value,
        model: $('model').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
    $('run-status').textContent = '';
    renderScorecard(data);
  } catch (err) {
    $('run-status').className = 'notice error-box';
    $('run-status').textContent = `Run failed — ${err.message}`;
  } finally {
    button.disabled = false;
    updateCharCount();
  }
}

// -------------------------------------------------------------------- wiring

$('prompt').addEventListener('input', updateCharCount);
$('run').addEventListener('click', run);
$('back').addEventListener('click', () => {
  $('play-view').hidden = true;
  $('list-view').hidden = false;
  current = null;
});

onUserChanged((user) => {
  const label = $('account-label');
  const signin = $('signin');
  const signout = $('signout');

  if (!user) {
    label.textContent = 'Signing in…';
    signin.hidden = true;
    signout.hidden = true;
    return;
  }

  if (user.isAnonymous) {
    // Anonymous play works fully; signing in is what makes a score persist.
    label.textContent = 'Playing as a guest — scores are not saved across devices';
    signin.hidden = false;
    signout.hidden = true;
  } else {
    label.textContent = `Signed in${user.name ? ` as ${user.name}` : ''}`;
    signin.hidden = true;
    signout.hidden = false;
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
    $('account-label').textContent = `Sign-in failed: ${result.error}`;
    return;
  }

  if (!result.linked) {
    $('account-label').textContent =
      'Signed in to your existing account — progress from this guest session did not carry over.';
  }
});

$('signout').addEventListener('click', () => signOutUser());

loadChallenges().then(() => {
  const select = $('model');
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model.replace(/^[^/]+\//, '');
    select.appendChild(option);
  }
});
