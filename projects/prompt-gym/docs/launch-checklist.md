# PromptGym — launch checklist

The list from `coding-runbook.md` §Session 10, split by who can actually check
each item. The cloud sessions that wrote the code have no Cloudflare auth, no
Firebase CLI auth and no Groq key, so everything in **By hand** is Arjun's.

**Session 11 ran on 26 Sep 2026** — see `session-11-validation.md`. All twelve
authored challenges have now been run against a real model, and `npm run try
--live` was added so the judge actually runs. Ten discriminate cleanly.
**pg-e4 and pg-c1 are not ready** — pg-e4 has no passing reference prompt and
pg-c1 is inverted because embedding similarity cannot measure fidelity. Both
need a content decision, neither is blocked on infrastructure. pg-b3 was fixed to penalise
deletion and over-redaction, and the golf par values were re-derived
(84 -> 97, 40 -> 49).

---

## Proven by the test suite

`cd worker/prompt-gym && npm test` — 353 tests. These items are covered, so a
regression fails the build rather than the launch:

| Item | Proven by |
| --- | --- |
| The 12 shipped challenges load | `test/api.test.ts` — "lists every challenge with the model allowlist" |
| pg-c1 and pg-e4 are withheld, and unrunnable by id | `test/api.test.ts` — "withheld challenges" (5 tests) |
| A guest's score survives Google linking | `test/linking.test.ts` (3 tests) |
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

### 1. KV namespace — ✅ done 26 Sep 2026

Created and bound: `id = "5e390c8016f94850b8fcea49b432c859"` in `wrangler.toml`.
Deployed and verified against production:

| check | result |
|---|---|
| `/api/health` reports the counter | `remainingToday: 180000` |
| a real run charges the declared cost | pg-a2 run -> `spentToday: 1400` |
| per-IP rate limit refuses | 3rd request -> 429 `rate_limited`, `Retry-After: 23` |
| budget exhaustion is typed | 429 `budget_exhausted`, `byoKeyAccepted: true` |
| a BYO key gets past an empty budget | same request + `X-Groq-Key` -> 200 |

**Known consequence:** a *cached* run bypasses both guards, because the dedupe
lookup returns before them. That is what the build guide asked for and it is
right for the budget — a cached run costs Groq nothing. It is arguably wrong for
the IP limit, which exists to protect our Worker and D1 rather than Groq's
quota, and which a replayed prompt can therefore sidestep without limit. One-line
fix if you want it: move the `consumeRateLimit` call above the dedupe block in
`handleRun` and leave `reserveBudget` where it is.

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

**Already done on 26 Sep 2026.** pg-c5 came back 82 vs 24 and eligible — ready.
pg-c1 came back 79 vs 88, still inverted with faithfulness fully measured, which
is why it needs a rubric rather than a `similar`. Re-run these two only if the
graders change.

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

### 6. Guest-to-Google linking — server side done, browser step is yours

`linkWithPopup` keeps the same Firebase uid, and every row in D1 is keyed by
uid, so a guest's scores are already the signed-in user's scores — nothing
migrates. `test/linking.test.ts` pins that invariant.

One real gap was found and fixed: `upsertUser` only ran during `/api/run`, so
after linking the board kept calling the player `player 4f2a1c` until they
happened to submit again. `/api/leaderboard` now refreshes the profile from the
token it has already verified.

What still needs a human, because it needs a Google popup:

1. Private window -> `https://arjunuvacha.com/prompt-gym/`, confirm the header
   reads "Playing as a guest".
2. Play a challenge and pass it. Note the score.
3. Sign in with Google.
4. The header should read "Signed in as <name>" with no page reload.
5. Open the Leaderboard. **The score from step 2 must still be there, now under
   your real name.** If it is, linking works end to end.

If instead you see "Signed in to your existing account — progress from this
guest session did not carry over", that Google account already had its own
PromptGym identity, so linking was refused and the guest rows were left behind.
That message is correct behaviour, not a bug — but use a Google account that has
never played before if you want to test the linking path itself.

### 7. The BYO-key path, end to end

- Landing page: the panel is collapsed and reads "Your key, your compute, no
  waiting".
- Paste a real Groq key, Save, run a challenge. The summary should change to
  "Running on your own Groq key" and the run should succeed.
- Temporarily set `BUDGET_TOKENS_PER_DAY = "1"` in `wrangler.toml`, deploy, and
  run **without** a key. Expect a 429, the panel opening by itself with the key
  input focused, and the same wording as the landing page. Put the real value
  back afterwards.

### 8. pg-d2 — decide before launch

Found while fixing the harness drift (see `session-11-validation.md`,
"Correction"): with the harness it was authored with, pg-d2's naive strawman is
hijacked on one case, leaks its instructions on another, and still passes at 72.
Options: gate the run on any injection, strengthen the t4 judge, or withhold it
alongside pg-c1 and pg-e4. It is still in the shipped set today.

### 9. Decisions left over from Session 11

Done, but it surfaced four things that are yours to call — full detail in
`session-11-validation.md`:

**Ten of the twelve ship. pg-c1 and pg-e4 are withheld** — dropped from the
catalog on 26 Sep 2026 via the `WITHHELD` map in `worker/prompt-gym/src/challenges.ts`,
which also records why. They stay imported and the build still validates them, so
bringing either back is a one-line deletion once its problem is fixed. The two
golf variants are unaffected: they derive from pg-a1 and pg-a2, both ready.

Why each is out:

- **pg-e4 has no passing reference prompt.** Two near-miss cases were added and
  they work — the strawman now fails at 58 — but the reference fails at 67, and
  at 58 on 120b, so it is not a small-model problem. Write a reference that
  holds the discipline, keep only one of the two new cases, or revert to four
  cases and raise the threshold. Do not ship it as it stands.
- **pg-c1 is inverted by design, and embeddings did not fix it.** Reference 79,
  strawman 88, with `faithfulness` at 93% for *both* — cosine similarity
  measures topical relatedness, not factual fidelity, so the strawman pays
  nothing for taking liberties while `novelty` rewards them. It needs an
  `llm-rubric` fact-check in place of `similar`, not more embedding work.
- **pg-b1's reference prompt** never tells the model to check its own sum, which
  is why t1 fails on 20b. The challenge itself is sound and it ships.

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
