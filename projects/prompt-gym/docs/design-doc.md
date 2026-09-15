# PromptGym — Design Doc (v3)

**Status:** design, not built. Scope, models, leaderboard metric, challenge shortlist, and reveal/decay policy are all locked.
**Path:** `arjunuvacha.com/prompt-gym`
**Last updated:** 15 Sep 2026

> **Companion docs in this folder** (`projects/prompt-gym/docs/`)
> - `challenge-data.md` — the test data for all 14 v1 challenges: inputs, gold references, what each case catches
> - `challenge-catalog.md` — the full ~50 candidate pool the 14 were picked from, plus authoring sequence
> - `groq-models.md` — Groq free-tier model options, pros/cons, rate-limit math
> - `challenge-format.md` — promptfoo-compatible input/output format + grader mapping + failure-reveal policy
> - `repo-layout.md` — where this lives in the `arjunuvacha` repo, the two deploy pipelines, and what to change in the existing config
> - `end-to-end-flow.md` — the complete technical trace: trust zones, auth, the run, the grading pipeline, timings, failure paths
> - `build-guide.md` — how to actually build it: milestones M0–M8, briefs to hand a coding agent, what to review by hand, plus appendices on the YAML→JSON converter and the Workers edge runtime
> - `coding-runbook.md` — the session-by-session order of operations: commands, paste-ready prompts, done-when tests, and the repo `CLAUDE.md`
>
> **Challenge files** live one level up, in `projects/prompt-gym/challenges/`
> - `pg-*.promptfoo.yaml` — all 12 authored challenges (the runtime JSON is generated from these by the build script into `challenges/generated/`; `pg-a1` and `pg-a2` ship both forms as worked examples)
> - `pg-golf-variants.json` — G1 and G3, expanded from their parents at build time

---

## Problem

People who want to get good at prompt engineering — PMs, analysts, junior engineers, anyone shipping AI features — have no structured way to find out whether a prompt is actually good. The loop today is: write a prompt, paste one example into ChatGPT, eyeball the output, ship it. Edge cases and silent failure modes surface later, in production, on an input the author never tried.

The people who do test properly reach for promptfoo or a similar eval harness — but that is a YAML-and-CLI workflow aimed at engineers who already have the habit. For the PM/analyst audience now writing prompts that go into real products, there is no low-friction way to practise against a real test suite and get graded, structured feedback on where a prompt breaks.

**The gap:** no prompt-engineering equivalent of running unit tests against your code, in a form a non-engineer will actually open on a Sunday.

**Persona.** A practising or aspiring AI/product person — PM, analyst, early-career engineer — who wants to sharpen prompt-writing skill and likes a challenge-and-score format. They arrive curious, want to try one challenge without signing up, and sign in only once they want their score to count.

**Secondary audience (the strategic one).** AI PM hiring managers browsing the AI Lab. What should land for them is the evaluation design — that grading an open-ended output is itself a product problem with real trade-offs — not the fact that the app calls an LLM.

## Solution

PromptGym is a web app with a library of prompt-writing challenges. Each challenge states a goal, sometimes hands over a broken starting prompt to fix, and sometimes asks for the shortest prompt that still works. The user writes a prompt, picks a model, hits Run. The app executes that prompt against several hidden test inputs, grades each output through a mix of graders (string checks, rule-based validators, text similarity, label models, rubric-scoring models), and returns a scorecard showing what passed, what failed, and why. The user iterates. Scores go on a leaderboard; a result can be turned into a share card.

**Core user journey**

1. Land on `/prompt-gym`, browse challenges by tag, difficulty and grader type. No sign-in required.
2. Open a challenge — read the goal, and the starting prompt if it is a debug challenge.
3. Write or edit a prompt; optionally switch the execution model in the picker.
4. Run. The prompt executes against hidden test inputs; each output goes through that challenge's graders.
5. Scorecard: per-test-case pass/fail with reasons, per-grader breakdown, total score, token efficiency.
6. Iterate until satisfied. Sign in to save the score, appear on the leaderboard, and generate a share card.

**Why AI specifically.** Deterministic checks verify the mechanical slice — did the output parse, match the schema, contain the required field. Most of what separates a good prompt from a bad one is not mechanical: did it stay faithful to the source, hold its format on an adversarial input, refuse the right thing, get the tone right, ask the clarifying question instead of guessing. That needs a model to judge. And the input side is unbounded — users submit arbitrary prompts the system has never seen, so the execution side has to be a model too. The interesting design work is in the grading: which grader type is honest for which kind of correctness, and what a score means when part of it comes from a model that is itself fallible. That is the part of this project worth talking about in an interview.

## Scope

### MVP (v1)

Everything below is in v1, including the five items promoted from the earlier draft's out-of-scope list.

**Core loop**
- One unified challenge engine driving three challenge modes: **goal** (blank editor), **debug** (pre-filled broken prompt), **golf** (token-efficiency bonus once correctness passes). Same schema, same runtime — mode is a field, not a separate code path.
- **14 hand-authored challenges — shortlist locked** (14 Sep 2026): A2, A1, A3, A11, B7, B1, B3, C1, C5, D2, E4, F1, plus golf variants G1 and G3 which reuse A1's and A2's test cases. Covers all six grader families and all three modes, with four model-graded challenges. Authoring sequence and rationale in `challenge-catalog.md`; the test data for all of them is in `challenge-data.md`.
- Six grader families wired up: string check, rule-based JS validator, text similarity, label model, score model, and composite (weighted `assert-set`).
- Prompt editor, run button, scorecard with per-test-case and per-grader breakdown.

**Accounts and identity**
- Firebase Auth: Google sign-in, plus **anonymous sign-in** so anyone can play immediately. An anonymous session can be upgraded to a real account later without losing scores (Firebase account linking).
- Sign-in is only required to appear on the leaderboard, keep history across devices, or publish a share card.

**Server-side persistence**
- Every run is stored server-side: prompt text, challenge, model used, per-grader results, score, token counts, timestamp.
- This buys three things at once: leaderboard integrity (scores are written by the server, never the client), an audit trail for contested top scores, and a corpus of real prompts per challenge that becomes genuinely interesting material later ("here is what 200 people's prompts for the same task actually look like").

**Leaderboard (one global board, one metric)**
- **Metric: challenges completed** — the count of distinct challenges where the user's best submission cleared that challenge's pass threshold. A whole number, which is the easiest thing in the world to read and to brag about.
- **Tie-break: sum of best scores across all challenges, completed or not.** Two people on 7 completions are separated by how well they did everywhere else, so partial progress counts for something without needing a second visible number.
- One global board only. No per-challenge boards in v1 — they would invite optimising for a single challenge, and the whole point of the metric is breadth.
- Written server-side only, from the Worker. Clients never post scores.

**Model picker**
- The user picks the **execution** model from an allowlist of Groq free-tier models (see `groq-models.md`).
- The **judge** model is pinned and not user-selectable. This is the important design call: if users could pick their own grader, no two scores would be comparable and the leaderboard would be meaningless. Execution is the user's choice; grading is the house's.
- Scores record which execution model produced them, and the scorecard shows it — trying the same prompt across models to see where it breaks is one of the more interesting things the app can teach.

**Bring-your-own key — stated on the landing page, not discovered on failure**
- The landing page says it upfront, in plain language: PromptGym runs on a free Groq tier that is shared by everyone on the site, it is small, and bringing your own free Groq key (with a link to where to get one) means you never queue behind anyone. Framed as "your key, your compute, no waiting" rather than as an apology.
- Default remains the app's shared key, so a visitor can try a challenge in one click without fetching a key first.
- When the shared budget is exhausted or Groq returns 429, the same message the landing page already made is repeated in context, with the key input right there. Nobody meets this idea for the first time at the moment they are blocked.
- The key lives in that browser's local storage only. It is sent per request over HTTPS, used for that request, never written to the database, never logged. Stated plainly in the UI, not buried.
- BYO-key runs are still graded server-side with the pinned judge, so they remain leaderboard-eligible.

**Shareable result link** (no image generation)
- A public permalink `/prompt-gym/r/<resultId>` rendering the result — challenge, score, grader breakdown, execution model — as a normal page, with OG tags so a pasted link previews reasonably.
- The user chooses whether the page shows their prompt text or just the score.
- No PNG, no canvas render, no dynamic OG image. A link is enough, and it removes a whole rendering path from v1.

**Guardrails**
- Per-user and per-IP rate limits on the Worker; global shared-budget counter with graceful degradation to BYO-key mode.
- Caps: max prompt length, max output tokens per execution call, 3–5 test cases per challenge.

### Explicitly out of scope for v1

- User-submitted or community-authored challenges.
- Multi-turn, conversational, or tool-calling/agentic challenges.
- Any paid infrastructure tier, anywhere in the stack.
- Team/org accounts, private leaderboards, or anything multi-tenant.
- Prompt version history / diffing between a user's own attempts.
- Email — no verification flows, no notifications, no digest.
- Real-time leaderboard updates (polling or refresh-on-load is fine).

### Later (v2+)

- Community-submitted challenges with light moderation.
- Side-by-side prompt comparison, and "run across all models" robustness view.
- Prompt history and diff per user.
- Per-challenge leaderboards, once there is enough traffic for them to mean anything.
- A generated share image (satori + resvg-wasm on the Worker) if the plain link turns out to under-perform on LinkedIn.
- Agentic/tool-use challenge type once the free-tier budget realistically supports multi-step runs.
- Public aggregate insights per challenge — what patterns the winning prompts share.

## Architecture

```
Browser (static SPA at arjunuvacha.com/prompt-gym)
  │  Firebase Auth (Google + anonymous) → ID token
  │  challenge metadata (public fields only)
  ▼
Cloudflare Worker  ── the only thing that holds test cases, graders, and secrets
  ├─ verifies Firebase ID token (RS256 against Google's public certs, cached)
  ├─ rate limit + shared-budget check
  ├─ execution calls ──────────────► Groq API (user-picked model)
  ├─ judge / label calls ──────────► Groq API (pinned model)
  ├─ similarity embeddings ────────► Cloudflare Workers AI (bge-m3)
  └─ writes ───────────────────────► Cloudflare D1 (submissions, best scores, share results)
```

**Frontend.** Static SPA (plain JS or a small Vite build — no SSR needed), published as part of the existing Hugo site's static output so it lands at `/prompt-gym/`. Add a Firebase Hosting rewrite for `/prompt-gym/**` → `/prompt-gym/index.html` so client-side routes (challenge pages, `/r/<id>` share pages) resolve. The frontend receives only public challenge fields: title, tags, difficulty, goal text, starting prompt for debug challenges, and which grader families are in play. Test inputs, expected values, rubrics and validator code never reach the browser.

**Backend.** A single Cloudflare Worker holds the full challenge definitions, all grading logic, and every secret. It is also the only writer to the database — this is what makes the leaderboard defensible.

**Identity.** Firebase Auth issues the ID token client-side; the Worker verifies the JWT signature against Google's published certs (cached in KV or the Cache API) and trusts the `uid`. No Firebase Admin SDK needed — it does not run on the Workers edge runtime — plain WebCrypto JWT verification is enough.

**Persistence: Cloudflare D1, not Firestore.** D1 is native to Workers (no service-account JWT signing dance), and keeping writes server-side is the whole point. Firestore with client-side security rules would let a determined user write their own score. Free tier: 5 GB storage, 5M row reads/day, 100k row writes/day — orders of magnitude beyond what this needs.

Tables, roughly:

| Table | Purpose |
|---|---|
| `users` | uid, display name, avatar, created_at |
| `submissions` | id, uid, challenge_id, exec_model, prompt_text, prompt_tokens, score, passed, grader_results_json, byo_key_used (bool), created_at |
| `best_scores` | uid + challenge_id (unique), score, submission_id, updated_at — `exec_model` for display is read via `submission_id → submissions.exec_model`, not duplicated here |
| `share_results` | id, submission_id, show_prompt (bool), created_at |

The leaderboard is a single query over `best_scores`: `COUNT(*) FILTER (WHERE passed) DESC, SUM(score) DESC GROUP BY uid`. No separate score table to keep in sync, and the tie-break falls out of the same row set.

`submissions` also carries a `prompt_hash` column (a hash of `challenge_id + prompt + exec_model`) with an index on it, which is what makes submission dedupe a lookup rather than a re-run.

**AI / inference.** Groq for execution and judging; Cloudflare Workers AI for embeddings (Groq has no embeddings endpoint). Full model analysis in `groq-models.md`; the short version is that the Llama models moved to enterprise-only and the free tier is now the GPT-OSS and Qwen families, with a **binding 8K tokens/minute and 1,000 requests/day cap shared across every visitor** — which is exactly why BYO-key is in v1.

**Security.** `GROQ_API_KEY` and any Firebase config secrets live as Worker secrets (`wrangler secret put`), never in client code. User-supplied BYO keys are request-scoped: never persisted, never logged, never echoed back. Validator functions are authored by Arjun and shipped in the Worker bundle — no user-supplied code is ever executed.

## AI design

**Three distinct call types, deliberately separated.**

**Locked configuration** (accepted 14 Sep 2026):

| Call | Model | Who chooses |
|---|---|---|
| Execution | `openai/gpt-oss-20b` ("Fast", default) · `openai/gpt-oss-120b` ("Strong") · `qwen/qwen3.8-27b` ("Preview · different family") | The user, from these three |
| Judge — rubric / score model | `openai/gpt-oss-120b` @ temp 0 | Pinned |
| Judge — label model | `openai/gpt-oss-20b` @ temp 0 | Pinned |
| Safety / refusal labels | `openai/gpt-oss-safeguard-20b` | Pinned |
| Injection / jailbreak labels | `meta-llama/llama-prompt-guard-2-86m` | Pinned |
| Embeddings for `similar` | Workers AI `@cf/baai/bge-m3` | Fixed |

Every call runs at temperature 0. Execution output is capped at **192 tokens** (256 for challenges whose correct answer is genuinely longer — set per challenge, not globally). Submitted prompts are capped at **2,000 characters**, enforced both in the editor and again in the Worker.

If `qwen/qwen3.8-27b` disappears — it is a preview model and may — the picker falls back to `gpt-oss-20b` and says so rather than erroring.

Pinning the judge is the leaderboard's integrity story. Letting the user pick the execution model is the teaching feature. Those two decisions pull in opposite directions and it is worth being explicit about why each one goes the way it does.

**Grader families and how each is implemented** (detail in `challenge-format.md`):

| Family | Implementation | AI call? |
|---|---|---|
| String check | `equals`, `contains`, `regex`, `is-json`, `word-count` in the Worker | No |
| Rule-based | Arjun-authored JS validator functions in the Worker bundle | No |
| Text similarity | `similar` via Workers AI embeddings + cosine; `rouge-n` / `levenshtein` in pure JS | Embedding only |
| Label model | Pinned judge returns one label from a fixed set; injection challenges can route to `meta-llama/llama-prompt-guard-2-86m` | Yes |
| Score model | Pinned judge returns a 0–1 or 1–5 score against a rubric, with a one-line reason | Yes |
| Composite | Weighted `assert-set` combining any of the above, with a pass threshold | Inherits |

**Determinism.** Everything runs at temperature 0 and outputs are capped, so a re-run of the same prompt should land on the same score in almost all cases. Not guaranteed — and the honest thing is to say so in the UI rather than pretend the score is exact. One of the golf/debug challenges can be built around exactly this (make a prompt that is stable across runs), which turns the system's own weakness into teaching material.

**Fallback behaviour.**

- Groq 429 → read the `retry-after` header, retry once, and if it fails again surface the shared-budget banner and offer BYO-key mode. Never silently return a partial score.
- Groq 5xx or timeout → mark that test case `errored`, not `failed`. An infrastructure failure must never be scored as the user's prompt failing, and the scorecard must say which it was.
- Workers AI unavailable → similarity graders degrade to `rouge-n`/`levenshtein` (no embedding needed), flagged in the scorecard as degraded, and the run is marked non-leaderboard-eligible.
- Judge returns unparseable output → one retry with a stricter format instruction, then mark `errored`.
- Any run containing an `errored` grader is excluded from `best_scores`.

**Budget discipline.** Test cases execute with a small concurrency cap (2–3) rather than all at once, to stay under the per-minute token ceiling. A challenge's total call budget is computed at authoring time and stored in its definition, so the Worker can refuse to start a run it cannot afford rather than failing halfway through.

Four levers are **adopted for v1**:

1. **Dedupe identical submissions.** Look up `hash(challengeId + prompt + execModel)` in `submissions`; on a hit, return the stored grading without calling anything. Everything is temperature 0, so this is honest, not a shortcut — and it makes leaderboard grinding free.
2. **Cap output at 192–256 tokens, and cap input at 2,000 characters.** Both enforced server-side, not just in the editor.
3. **Grade cheap-first, and gate the judge.** Deterministic and rule-based graders run first, at zero cost. Model-graded assertions run only if the cheap graders passed — an output that is not even valid JSON does not need a rubric to explain why it is wrong. The scorecard says explicitly when judging was skipped, so a user is never left wondering whether their score is incomplete.
4. **Route to the classifier budget wherever possible.** `llama-prompt-guard-2-86m` (500K TPD) and `gpt-oss-safeguard-20b` sit in rate-limit buckets separate from the main GPT-OSS pool, so injection and safety challenges cost effectively nothing from the budget that matters.

Two further levers are documented but **not adopted**, and remain available if the budget bites harder than expected: batching all test-case outputs into a single judge call, and cutting challenges to three test cases. Both trade something real — per-case verdict clarity, and coverage — so they are held in reserve rather than taken pre-emptively.

## Data flow

1. Browser loads `/prompt-gym`, signs in anonymously via Firebase Auth, fetches public challenge metadata from `GET /api/challenges`.
2. User opens a challenge, writes a prompt, picks an execution model, hits Run.
3. Browser `POST /api/run` with `{challengeId, prompt, model}`, `Authorization: Bearer <Firebase ID token>`, and optionally a BYO Groq key header.
4. Worker verifies the token, applies per-user and per-IP rate limits, and checks the shared budget (skipped if a BYO key is present).
5. Worker loads the challenge's hidden test cases and grader config from its bundle.
6. For each test case (concurrency 2–3): substitute the user's prompt and the test input, call Groq with the chosen execution model, collect the output.
7. Grade each output: deterministic and rule-based graders run locally in the Worker; similarity graders call Workers AI for embeddings; label and score graders call Groq with the pinned judge.
8. Worker computes the weighted composite score (0–100), applies the golf efficiency bonus where the mode calls for it, and assembles per-grader results plus reveal-filtered feedback.
9. Worker writes the submission to D1 and upserts `best_scores` if this beats the user's previous best.
10. Worker returns the scorecard; the browser renders it and offers share-card generation.
11. Leaderboard reads come from `GET /api/leaderboard`, computed from `best_scores`.

## Setup needed

**Accounts and services** (all free tier)
- Groq — API key for the shared pool (Arjun's existing free-tier key).
- Cloudflare — Worker, D1 database, KV namespace (budget counters, JWT cert cache), Workers AI binding.
- Firebase — existing arjunuvacha.com project; enable Authentication with Google and Anonymous providers; add the Hosting rewrite for `/prompt-gym/**`.

**Secrets** (Worker environment, via `wrangler secret put`)
- `GROQ_API_KEY` — shared pool key.
- `FIREBASE_PROJECT_ID` — for ID token audience validation (not secret, but config).

**Free-tier limits to watch**

| Service | Limit | Where it bites |
|---|---|---|
| Groq free tier (GPT-OSS / Qwen) | 30 RPM, 1K RPD, 8K TPM, 200K TPD — shared across all visitors | The real ceiling. See the math in `groq-models.md` |
| Cloudflare Workers | 100K requests/day | Comfortable |
| Cloudflare D1 | 5 GB, 5M reads/day, 100K writes/day | Comfortable |
| Workers AI | 10,000 neurons/day | bge-m3 is ~1,075 neurons per million tokens, so effectively unlimited here |
| Firebase Auth | Google + anonymous sign-in unmetered on Spark | Comfortable |
| Firebase Hosting | 10 GB storage, 360 MB/day transfer | Watch only if the app gets genuinely popular |

Verify Groq's model lineup and limits in the console at build time — they have already changed once since this project was conceived.

## Open questions / risks

**Settled**
- ~~promptfoo as a runtime dependency~~ — not used at runtime, and no money goes behind this. promptfoo earns its place as the **local authoring tool**: challenges are authored as promptfoo-format YAML and validated by running `promptfoo eval` locally against Arjun's own key before being exported to the runtime JSON the Worker ships. Free, offline, and every challenge is proven solvable and proven discriminating before it goes live.
- ~~Free-tier Groq assumption~~ — confirmed as the default, with BYO-key as the documented escape hatch.
- ~~The shared-ceiling framing~~ — BYO-key is stated on the landing page as a feature ("your key, your compute, no waiting"), not surfaced as an error when someone hits the wall. The shared pool stays as a one-click way to try a challenge without fetching a key first.
- ~~Model shortlist~~ — locked, see the AI design section above.
- ~~Challenge shortlist~~ — locked at 14, see Scope above.
- ~~Leaderboard metric~~ — challenges completed, tie-broken on total best scores. One global board.
- ~~Share format~~ — link only, no generated image.
- ~~Failure-information reveal policy~~ — v1 ships `reveal: partial` on every test case, uniformly, no exceptions by position or grader family. See `challenge-format.md` §5 for the full reasoning and the deferred differentiated policy. Sub-question resolved too: a passed challenge unlocks the **reference prompt only** — hidden inputs and expected values stay hidden even after passing, so an alt-account pass can't be used to read the answer key for cases still hidden.
- ~~Anonymous abuse~~ — accepted as a documented trade-off, no change. Per-uid rate limiting alone is not enough given unlimited anonymous identities, so IP-based limits and the global shared-budget counter (M8) are doing the real work. Acceptable for a portfolio project.
- ~~Leaderboard decay~~ — **model column + asterisk**. Historical scores are never re-graded or archived into seasons; `best_scores` (and the leaderboard UI) show which execution model earned each score, plus a standing UI note that the model lineup can change over time. Simplest option, no re-grading cost, no season/archive logic to build.

**Still open**

None — resolved 15 Sep 2026.
