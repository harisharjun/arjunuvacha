# PromptGym — launch checklist

The list from `coding-runbook.md` §Session 10, split by who can actually check
each item. The cloud sessions that wrote the code have no Cloudflare auth, no
Firebase CLI auth and no Groq key, so everything in **By hand** is Arjun's.

**Session 11 ran on 26 Sep 2026** — see `session-11-validation.md`. All twelve
authored challenges have now been run against a real model, and `npm run try
--live` was added so the judge actually runs. Ten discriminate cleanly.
**pg-e4's strawman passes the challenge** and **pg-c1 scores its strawman above
its reference**; both need a decision before launch. pg-b3 was fixed to penalise
deletion and over-redaction, and the golf par values were re-derived
(84 -> 97, 40 -> 49).

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

### 2. Workers AI — the `[ai]` binding needs no credential, `--live` does

The `[ai]` binding in `wrangler.toml` is complete as written and deploys as is;
it is what makes pg-c1 and pg-c5 leaderboard-eligible. Only the local
`npm run try -- <id> --live` path needs credentials, because there is no binding
outside the Worker. Create a Cloudflare API token with **Workers AI read** and
add to `worker/prompt-gym/.dev.vars` (gitignored):

```
CF_ACCOUNT_ID=<your Cloudflare account id>
CF_API_TOKEN=<the token>
```

Then re-run the two that depend on it:

```bash
cd worker/prompt-gym
npm run try -- pg-c1 --prompt-file ../../projects/prompt-gym/challenges/prompts/pg-c1.reference.txt --live
npm run try -- pg-c5 --prompt-file ../../projects/prompt-gym/challenges/prompts/pg-c5.reference.txt --live
```

Expect both to report leaderboard-eligible, and pg-c1's reference to beat its
strawman. If pg-c1 is still inverted with faithfulness measured, the challenge
itself needs work.

### 3. Secrets

```bash
npx wrangler secret list                 # GROQ_API_KEY present
npx wrangler secret put GROQ_API_KEY     # only if it is not
```

### 4. Anonymous play in a private window

Open `https://arjunuvacha.com/prompt-gym/` in a private window. Expect: a guest
session appears without any click, a challenge runs, a score comes back. The
header should read "Playing as a guest".

### 5. The reveal filter in the network tab

On that run, open the `POST /api/run` response. Every test case after the first
should carry `"input": null` and no `output`. If any hidden input is visible, stop
— that is the one bug that makes every challenge worthless.

### 6. Guest-to-Google linking — still unconfirmed

Score a challenge as a guest, then sign in with Google and check the score
survived. This has never been verified end to end. If the score is lost, the
fallback path in `web/auth.js` already tells the player so, but the linking itself
is the thing to fix.

### 7. The BYO-key path, end to end

- Landing page: the panel is collapsed and reads "Your key, your compute, no
  waiting".
- Paste a real Groq key, Save, run a challenge. The summary should change to
  "Running on your own Groq key" and the run should succeed.
- Temporarily set `BUDGET_TOKENS_PER_DAY = "1"` in `wrangler.toml`, deploy, and
  run **without** a key. Expect a 429, the panel opening by itself with the key
  input focused, and the same wording as the landing page. Put the real value
  back afterwards.

### 8. Decisions left over from Session 11

Done, but it surfaced four things that are yours to call — full detail in
`session-11-validation.md`:

- **pg-e4's strawman passes** — 88 vs 75 against a 70% threshold. A player can
  clear it with a naive one-liner. Needs sharper cases or a higher threshold.
- **pg-c1 scores its strawman above its reference** (69 vs 88) because
  `faithfulness` was unmeasurable. Embeddings are now implemented, so re-run it
  with `--live` once the Cloudflare token is in `.dev.vars` — it has not been
  re-run yet.
- **pg-b1's reference prompt** never tells the model to check its own sum, which
  is why t1 fails on 20b. The challenge itself is sound.

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
