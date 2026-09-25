# PromptGym — launch checklist

The list from `coding-runbook.md` §Session 10, split by who can actually check
each item. The cloud sessions that wrote the code have no Cloudflare auth, no
Firebase CLI auth and no Groq key, so everything in **By hand** is Arjun's.

Nothing here is a substitute for **Session 11, the challenge-validation pass**.
Twelve of the fourteen challenges have still never had a real model pointed at
them. Do not launch before that runs.

---

## Proven by the test suite

`cd worker/prompt-gym && npm test` — 353 tests. These items are covered, so a
regression fails the build rather than the launch:

| Item | Proven by |
| --- | --- |
| All 14 challenges load | `test/api.test.ts` — "lists every challenge with the model allowlist" |
| An unknown challenge id returns a clean 400 | `test/api.test.ts` — "rejects an unknown challenge id cleanly" |
| The reveal filter holds server-side | `test/api.test.ts` — "leaks no hidden test input beyond the published example", and `test/reveal.test.ts` |
| No expected values, assertions or validator names reach the browser | `test/api.test.ts` — "carries no expected values, assertions or validator names" |
| A player's own key is never stored, logged or echoed | `test/guardrails.test.ts` — "a player's own key never leaves the request" (4 tests) |
| The shared budget refuses cleanly and offers BYO-key mode | `test/guardrails.test.ts` — "the shared budget" (7 tests) |
| Per-IP rate limits, including for BYO-key players | `test/guardrails.test.ts` — "per-IP rate limits" (3 tests) |

## Checked in the repository

- **No Groq key in git.** `git grep -nE 'gsk_[A-Za-z0-9]{10,}'` returns only the
  `gsk_test` / `gsk_house` / `gsk_PLAYER` literals in tests and the `gsk_…`
  placeholder in the key input. `.dev.vars` and `.wrangler/` are gitignored.
- **The Firebase web API key in `web/auth.js` is committed on purpose.** A secret
  scanner will flag `AIzaSy…`; it is not a secret. Firebase web config identifies
  the project and authorises nothing — the controls are the authorised-domains
  list and the Worker verifying each token's signature and `aud`. See the comment
  above the config block.

---

## By hand, on the Mac

### 1. Create the KV namespace — the guardrails are inert until this exists

```bash
cd worker/prompt-gym
npx wrangler kv namespace create BUDGET
```

Paste the id into the commented `[[kv_namespaces]]` block in `wrangler.toml` and
uncomment it. **This is the one M8 item that could not be finished in the cloud.**
The Worker deliberately runs unguarded when `env.BUDGET` is absent — a missing
counter must not take the site down — which also means that until this is bound
there is no budget at all, and Groq's own 429 is the only thing between a
LinkedIn post and an empty daily allowance.

Then confirm the counter is live:

```bash
npx wrangler deploy
curl -s https://prompt-gym.harisharjun127.workers.dev/api/health | jq
# budget should be an object, not null
```

Check the limits in `wrangler.toml` against your own console first —
**Settings → Limits**. They are written for 8K tokens/minute and 200K tokens/day
and sit under both; Groq publishes these per organisation and moves them.

### 2. Secrets

```bash
npx wrangler secret list                 # GROQ_API_KEY present
npx wrangler secret put GROQ_API_KEY     # only if it is not
```

### 3. Anonymous play in a private window

Open `https://arjunuvacha.com/prompt-gym/` in a private window. Expect: a guest
session appears without any click, a challenge runs, a score comes back. The
header should read "Playing as a guest".

### 4. The reveal filter in the network tab

On that run, open the `POST /api/run` response. Every test case after the first
should carry `"input": null` and no `output`. If any hidden input is visible, stop
— that is the one bug that makes every challenge worthless.

### 5. Guest-to-Google linking — still unconfirmed

Score a challenge as a guest, then sign in with Google and check the score
survived. This has never been verified end to end. If the score is lost, the
fallback path in `web/auth.js` already tells the player so, but the linking itself
is the thing to fix.

### 6. The BYO-key path, end to end

- Landing page: the panel is collapsed and reads "Your key, your compute, no
  waiting".
- Paste a real Groq key, Save, run a challenge. The summary should change to
  "Running on your own Groq key" and the run should succeed.
- Temporarily set `BUDGET_TOKENS_PER_DAY = "1"` in `wrangler.toml`, deploy, and
  run **without** a key. Expect a 429, the panel opening by itself with the key
  input focused, and the same wording as the landing page. Put the real value
  back afterwards.

### 7. Session 11 — the challenge-validation pass

See `coding-runbook.md` §Session 11. Twelve challenges to validate, plus
re-deriving the two golf par values against `estimateTokens` (4 chars/token).
That pass is a launch blocker, not a nice-to-have.

---

## Known gaps at launch

- **The 8 `similar` assertions in pg-c1 and pg-c5 need Workers AI embeddings**,
  which are not wired up. Runs on those challenges correctly return
  `leaderboardEligible: false` and the scorecard says a grader could not run.
  They are playable but cannot be banked.
- **The budget counter overshoots under concurrency.** KV is eventually
  consistent. The limits sit under Groq's real ceilings so the overshoot lands in
  headroom; do not build anything on the counter being exact.
- **The budget is reserved up front and never refunded**, so a Groq outage eats
  the day's allowance. Refunding against an eventually consistent counter can
  credit back more than was spent, and a budget that can grow is not a budget.
