# PromptGym — end-to-end technical flow

What actually executes, where, and in what order — from a visitor landing on the page to a score appearing on screen. Written to be read alongside the design doc; nothing here is new design, it is the same system traced through one complete request.

---

## 0 · The three trust zones

Every decision in this flow falls out of one idea: there are three zones, and only the middle one can be trusted.

```
┌─────────────────────┐   ┌──────────────────────────┐   ┌─────────────────────┐
│  UNTRUSTED          │   │  TRUSTED                 │   │  EXTERNAL           │
│  The browser        │──▶│  The Cloudflare Worker   │──▶│  Groq, Workers AI,  │
│                     │◀──│                          │◀──│  Google JWKS        │
│  Anything here is   │   │  Holds every secret,     │   │                     │
│  visible and        │   │  every hidden test case, │   │  Reached only from  │
│  forgeable          │   │  all grading logic       │   │  the Worker         │
└─────────────────────┘   └──────────────────────────┘   └─────────────────────┘
```

The browser is a hostile environment by assumption — not because your players are malicious, but because a leaderboard creates an incentive and devtools are one keystroke away. So: the browser never receives a hidden test input, never computes a score, and never writes to the database. The Worker does all three.

---

## 1 · What exists before any user arrives

**On Firebase Hosting** (a CDN, serving static files): `index.html`, one JS bundle, one CSS file. Zero logic beyond rendering and fetching.

**On Cloudflare** (deployed via `wrangler deploy`): one bundled JavaScript file containing —

| Contents | Why it lives in the Worker |
|---|---|
| Route handlers | The API |
| The grading engine (pure functions) | Scores must be computed where they can't be tampered with |
| The validator registry (named functions) | So challenge data can *select* a function, never *become* one |
| All 14 challenge JSONs, imported as modules | No filesystem on the edge — data is baked into the bundle at deploy time |
| Auth verification code | Security boundary |

**Bound to the Worker, not inside it:** `GROQ_API_KEY` (a secret env var), the D1 database, a KV namespace for counters, and the Workers AI binding. These are injected by the runtime at request time as properties on `env`.

Note what this means: **deploying a new challenge is a code deploy**, not a database write. That is a deliberate trade — it costs a `wrangler deploy` to add a challenge, and it buys the guarantee that challenge data can never be altered by anything at runtime.

---

## 2 · Cold start — first visit

```
Browser                    Firebase Hosting      Google Identity        Worker
   │                              │                    │                  │
   │──GET /prompt-gym────────────▶│                    │                  │
   │◀─────html + js + css ────────│                    │                  │
   │                              │                    │                  │
   │  (js boots, checks IndexedDB for a session — none) │                  │
   │                              │                    │                  │
   │──signInAnonymously()──────────────────────────────▶│                  │
   │◀──{ idToken (JWT, 1hr), refreshToken }─────────────│                  │
   │  (Firebase SDK stores both in IndexedDB)           │                  │
   │                                                    │                  │
   │──OPTIONS /api/challenges (CORS preflight)─────────────────────────────▶│
   │◀──204 + Access-Control-Allow-Origin───────────────────────────────────│
   │──GET /api/challenges──────────────────────────────────────────────────▶│
   │◀──[ { id, title, goal, tags, difficulty, … } ]────────────────────────│
   │                                                                       │
   │  renders challenge list                                               │
```

Three things worth noticing.

**Anonymous sign-in is a real account.** It produces a genuine Firebase user with a stable `uid`, persisted in the browser's IndexedDB. The player can solve five challenges, close the tab, come back next week and still have them — with no signup. If they later sign in with Google, the SDK *links* the Google credential onto that same `uid`, so the history survives. This is why the sign-in wall is optional rather than upfront.

**`/api/challenges` returns only the `public` block** of each challenge JSON. The Worker holds objects with `tests`, `assert`, `input`, expected values — and serialises only `id`, `title`, `mode`, `difficulty`, `tags`, `goal`, `startingPrompt`, `exampleInput`, `constraintsShown`. The hidden half never enters the response object at all; it is not filtered at render time, it is never put in.

**No AI call has happened yet, and no database read.** Page load costs one static fetch and one Worker request that reads from the bundle. This matters because the free tiers are small and most visitors never run anything.

---

## 3 · Auth, in detail

What the browser holds is an **ID token** — a JWT, which is three base64url segments joined by dots:

```
eyJhbGciOiJSUzI1NiIsImtpZCI6ImFiYzEyMyJ9 . eyJpc3MiOiJodHRwczovL3Nl… . SflKxwRJSMeKKF2QT4…
└──────────── header ────────────────────┘ └──── payload ──────────┘ └─── signature ────┘

header  : { "alg": "RS256", "kid": "abc123" }
payload : { "iss": "https://securetoken.google.com/<projectId>",
            "aud": "<projectId>",
            "sub": "Xy7k…",              ← the user id
            "iat": 1757800000,
            "exp": 1757803600,           ← one hour later
            "firebase": { "sign_in_provider": "anonymous" } }
```

The header and payload are **not encrypted** — anyone can decode them. What makes the token trustworthy is the signature, which only Google can produce.

On every authenticated request the Worker does this:

1. Split the token, base64url-decode the header, read `kid`.
2. Fetch Google's public keys from the JWKS endpoint — **cached in the Cache API** honouring its `max-age`, so this is a network call roughly once a day, not once a request.
3. **Select** the key whose `kid` matches. (Not "try them all" — that is the bug M5 warns about.)
4. `crypto.subtle.importKey('jwk', key, {name:'RSASSA-PKCS1-v1_5', hash:'SHA-256'}, false, ['verify'])`
5. `crypto.subtle.verify(alg, publicKey, signatureBytes, utf8Bytes("header.payload"))` — this is the actual cryptography: does this exact header and payload, signed with Google's private key, produce this signature?
6. Only if that returns true, check the claims: `iss` matches your project, `aud` matches your project, `exp` is in the future, `iat` is in the past, `sub` is non-empty.

If all of that passes, the Worker trusts `sub` as the user's identity — **with no session store, no cookie, and no database lookup**. That is the property that makes auth work on the edge: every Worker invocation is a cold, stateless function with no shared memory, so anything requiring server-side session state would need a database round trip on every request. A signed token carries its own proof.

If the `Authorization` header is missing or malformed, the request proceeds as **anonymous** — it can run challenges, it just cannot write a score.

---

## 4 · The run — full trace

The player types a prompt, picks a model, clicks Run.

### 4.1 Client side (a few milliseconds)

Character count checked against the 2,000 cap — if over, the button is disabled and **no request is made**. This is UX, not security; the Worker checks again regardless.

```http
POST https://promptgym.<subdomain>.workers.dev/api/run
Authorization: Bearer eyJhbGciOiJSUzI1NiIs…
Content-Type: application/json
X-Groq-Key: gsk_…            ← only if the player supplied their own

{ "challengeId": "pg-a1", "prompt": "Extract the postal address…", "model": "openai/gpt-oss-20b" }
```

### 4.2 Worker, before spending anything

Cheapest checks first, deliberately — each one can end the request before it costs a token:

1. **Route match** on method and path.
2. **Verify the ID token** → `uid`, or anonymous. (~1ms, cached keys.)
3. **Load the challenge** from the bundled map. Unknown id → `400`. (Object lookup, no I/O.)
4. **Validate input** server-side: prompt ≤ 2000 chars, model in the three-item allowlist. A client that skips the UI guard gets rejected here.
5. **Compute the dedupe hash**:
   ```js
   const data = `${challengeId}\n${prompt}\n${model}`;
   const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
   const hash = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('');
   ```
6. **Dedupe lookup** — `SELECT … FROM submissions WHERE prompt_hash = ? LIMIT 1`.
   **On a hit, this request is over.** Return the stored scorecard with `cached: true`, having made zero model calls. Still upsert `best_scores` for *this* `uid`, since a different player submitting an identical prompt has genuinely earned it. Round trip ≈ 50ms.
   *Everything is temperature 0, which is what makes returning a cached grading honest rather than a shortcut.*
7. **Rate limit** — KV counters keyed by IP and minute/hour.
8. **Budget check** — KV counters keyed by day and minute, compared against the challenge's `estimatedTokensPerRun`. Exceeded → `429` with a typed `BudgetExhausted` body, which flips the UI into BYO-key mode. **Skipped entirely if `X-Groq-Key` is present** — their key, their quota.

### 4.3 Execution phase — running the player's prompt

For each of the 4 test cases, with a concurrency cap of 3:

```js
const finalPrompt = challenge.harness.template
  .replace('{{userPrompt}}', prompt)
  .replace('{{input}}', testCase.input);   // ← the hidden input, in Worker memory only
```

```http
POST https://api.groq.com/openai/v1/chat/completions
Authorization: Bearer <BYO key ?? env.GROQ_API_KEY>

{ "model": "openai/gpt-oss-20b",
  "messages": [{ "role": "user", "content": finalPrompt }],
  "temperature": 0,
  "max_tokens": 192 }
```

Four calls, ~1–2s each on the 20b, three in flight at a time → roughly 2–4 seconds wall clock. Each returns a content string plus a token count that feeds the budget counter.

The concurrency cap exists because of the 8K tokens-per-minute ceiling: firing all four at once is more likely to trip a 429 than to finish meaningfully sooner.

### 4.4 Grading phase — the cheap-first pipeline

Per test case, in strict order:

```
model output string
        │
        ▼
┌───────────────────────────────┐
│ 1. STRING CHECK   (free)      │  equals, contains, regex, is-json + schema,
│    in-process, synchronous    │  word-count, not-* variants
└───────────────┬───────────────┘
                ▼
┌───────────────────────────────┐
│ 2. RULE-BASED     (free)      │  validators[assert.ref](output, ctx)
│    registry lookup, call      │  ← arithmetic, leakage, polarity checks
└───────────────┬───────────────┘
                ▼
        ╔═══════════════╗
        ║  THE GATE     ║  did every free assertion pass for this case?
        ╚═══╦═══════╦═══╝
        no  ║       ║  yes
            ▼       ▼
    judgingSkipped  ┌───────────────────────────────┐
    (costs nothing) │ 3. SIMILARITY  (~free)        │  env.AI.run('@cf/baai/bge-m3')
                    │    → two vectors → cosine     │  → compare to threshold
                    └───────────────┬───────────────┘
                                    ▼
                    ┌───────────────────────────────┐
                    │ 4. LABEL MODEL   ($)          │  pinned gpt-oss-20b, or
                    │    → one label from an enum   │  prompt-guard / safeguard
                    └───────────────┬───────────────┘
                                    ▼
                    ┌───────────────────────────────┐
                    │ 5. SCORE MODEL   ($$)         │  pinned gpt-oss-120b @ temp 0
                    │    → { score, reason } JSON   │  ← the rubric verdict
                    └───────────────────────────────┘
```

The gate is the single most important cost decision in the system. An output that is not even valid JSON does not need a language model to explain why it is wrong — and on a failing run, that is most of the cases. In practice it means a beginner iterating on a broken prompt costs the shared budget almost nothing, while a nearly-correct prompt gets the expensive, useful feedback.

Note that steps 1 and 2 are **pure function calls inside the Worker** — no network, no I/O, sub-millisecond. Steps 3–5 are network calls. That division is exactly why the grading engine was specified as pure functions with no I/O: it is the part that has to be fast, deterministic, and exhaustively testable for free.

### 4.5 Aggregation

```js
caseScore      = Σ(assertionScore × weight) / Σ(weight)      // each assertion yields 0–1
challengeScore = round(100 × mean(caseScores))
golfBonus      = mode === 'golf' && meanCaseScore >= passThreshold
                 ? round(20 × max(0, 1 - promptTokens / parTokens)) : 0
leaderboardEligible = no grader returned `errored`
```

`errored` is structurally distinct from `failed` throughout. A Groq 500 or a timeout marks the case errored; an errored case cannot be aggregated into a numeric score, and an errored run cannot touch `best_scores`. The player's prompt is never punished for our infrastructure.

### 4.6 Persistence

```sql
INSERT INTO submissions (id, uid, challenge_id, exec_model, prompt_text, prompt_hash,
                         score, passed, grader_results_json, byo_key_used, created_at) …

-- only if better than the existing best, and only if leaderboardEligible
INSERT INTO best_scores (uid, challenge_id, score, submission_id, updated_at)
  VALUES (…) ON CONFLICT(uid, challenge_id) DO UPDATE SET … WHERE excluded.score > score;
```

The BYO key is recorded as a boolean — `byo_key_used` — and never as a value. It exists in a request-scoped variable, is used for the outbound Authorization header, and is garbage collected when the request ends.

### 4.7 The reveal filter — last step before serialising

This runs on the fully-populated result object, stripping per the challenge's per-case reveal level:

| Level | `input` | `output` | expected values | failure detail |
|---|---|---|---|---|
| `full` | sent | sent | sent | full, including the rubric's reasoning |
| `partial` | sent | sent | **removed** | which grader failed + generic reason |
| `verdict-only` | **null** | **null** | **removed** | the metric name + a one-line hint |

Then:

```json
{ "submissionId": "sub_01J…", "score": 78, "passed": true,
  "execModel": "openai/gpt-oss-20b", "promptTokens": 143,
  "leaderboardEligible": true, "cached": false,
  "byGrader": [ { "metric": "schema", "family": "string-check", "score": 1.0, "weight": 3 }, … ],
  "tests": [ { "id": "t3", "status": "failed", "reveal": "verdict-only",
               "input": null, "output": null,
               "failures": [ { "metric": "hallucination",
                               "hint": "One hidden input contains no address at all…" } ] } ],
  "budget": { "sharedPoolRemaining": "low", "byoKeyActive": false } }
```

The browser renders this. It cannot render what it was not sent, which is the point — the filter is applied to the object before `JSON.stringify`, not to the DOM after.

---

## 5 · Where the time goes

| Phase | Typical | Notes |
|---|---|---|
| Token verification | ~1 ms | JWKS cached; pure crypto |
| Challenge load | ~0 ms | Object lookup in the bundle |
| Dedupe lookup | ~20–50 ms | One indexed D1 read |
| Execution (4 calls, concurrency 3) | **2–4 s** | Dominates. Groq is fast; the round trips are the cost |
| Cheap grading | < 1 ms | Pure functions |
| Embeddings, if used | ~100–300 ms | Workers AI, same datacentre |
| Judge calls, if reached | **1–2 s** | Only for cases that passed the gate |
| Persistence | ~30 ms | Two D1 writes |
| **Total, uncached** | **4–8 s** | |
| **Total, cached** | **~50 ms** | Dedupe hit, zero model calls |

Four to eight seconds is long enough that the UI has to show per-test-case progress rather than a single spinner. It is also the argument for SSE streaming later — not needed for v1, but this table is why it eventually gets built.

---

## 6 · Failure paths

| What breaks | Where it is caught | What the player sees |
|---|---|---|
| Prompt over 2,000 chars | Client guard, then Worker | Button disabled; server 400 if bypassed |
| Unknown `challengeId` | Worker, before any cost | Clean 400 |
| Invalid / expired ID token | Auth verification | Treated as anonymous — can still play, cannot score |
| IP rate limit hit | KV counter | 429, "slow down", retry-after |
| Shared budget exhausted | KV counter | BYO-key panel, with the same message the landing page already made |
| Groq 429 | Provider layer | One retry honouring `retry-after`, then BYO-key mode |
| Groq 5xx / timeout | Provider layer | Case marked **errored**, run excluded from leaderboard, scorecard says infrastructure not prompt |
| Judge returns unparseable JSON | Provider layer | One stricter retry, then `JudgeError` → errored |
| Workers AI unavailable | Grading layer | Similarity degrades to rouge-n/levenshtein, flagged degraded, run not leaderboard-eligible |
| D1 write fails | Persistence | Scorecard still returned; score not banked; logged |

The pattern throughout: **an infrastructure failure must never look like a prompt failure.** That distinction is carried by the type system, not by convention, because it is the one error-handling mistake that would quietly make the whole product dishonest.

---

## 7 · What never leaves the Worker

A single list, because it is the security model in its entirety:

- Hidden test inputs (except where `reveal` is `full` or `partial`)
- Expected values, gold references, and rubric text — always, at every reveal level
- Validator function bodies
- `GROQ_API_KEY`
- A player's BYO key — in memory for one request, never stored, never logged, never echoed
- The scoring computation itself

And the corresponding list of what the browser is trusted with: nothing. It renders what it is given and posts what the player typed. Every consequential decision — is this token valid, has this been run before, did this pass, what does it score, does it go on the board — happens in the Worker.
