# PromptGym — build guide

**This is a separate document from the design doc on purpose.** The design doc says what to build and why; this says in what order to build it, what to hand a coding agent at each step, and which parts to read carefully rather than accept on trust.

**How to use it.** You build AI-assisted, so the unit of work here is a *milestone*, not a file. Each milestone below has a brief you can paste into Claude Code more or less as-is, a "done when" test, and — where it matters — a note on what the generated code is likely to get subtly wrong. Do one milestone per session. Do not let a session sprawl across two: the review step is where the learning is, and it stops working when the diff is 900 lines.

Point Claude Code at `design-doc.md` at the start of every session. The spec is written; you should not be re-explaining the architecture each time.

---

## 0 · Before any code

**Accounts** (all free): Groq (you have it), Cloudflare, and your existing Firebase project for arjunuvacha.com.

**Local tooling:** Node 20+, `npm i -g wrangler`, and `npx promptfoo` (no global install needed).

**One decision to make first — where the API lives.**

Firebase Hosting cannot proxy to a Cloudflare Worker (its rewrites only reach Cloud Functions and Cloud Run), so the frontend and the API will be on different origins no matter what. Two workable shapes:

| | Setup | Trade |
|---|---|---|
| **A — default** | SPA on Firebase Hosting at `/prompt-gym`, Worker on `*.workers.dev`, CORS allowlisting `arjunuvacha.com` | Nothing moves. One CORS config to get right. Ugly API URL nobody sees. |
| **B** | Move `arjunuvacha.com` DNS to Cloudflare, Worker on `api.arjunuvacha.com` | Nicer URLs, same-origin cookies possible later. Requires touching DNS for your live blog — real risk for cosmetic gain. |

Go with **A** — and this is now **settled rather than recommended**: the `arjunuvacha` repo deploys `public/` to Firebase via a GitHub Action, and your two existing Workers (`arjun-rag`, `tax-copilot-groq`) already deploy separately through wrangler. Option A is the shape you are already running; B would mean moving DNS for a live blog to gain nothing this project needs.

One consequence worth reading before M7: because Firebase serves `/prompt-gym/**` from static files and its rewrites cannot target a Cloudflare Worker, per-result OG tags on share links are not achievable on this setup. See §6 of `repo-layout.md` — the recommendation is a static share page with a generic preview for v1.

**Repo layout:** see `repo-layout.md`. Short version — PromptGym lives **inside the existing `arjunuvacha` repo**, following the convention already established by Tax Copilot: source in `projects/prompt-gym/`, the Worker in `worker/prompt-gym/` alongside `arjun-rag` and `tax-copilot-groq`, built SPA in `static/prompt-gym/`, and a listing entry in `content/page/ai-lab.md`. Two deploy pipelines (wrangler for the Worker, Hugo + Firebase for the frontend), one repo.

---

## M0 · Two empty things, deployed

**Goal:** prove the two halves of the stack are reachable before there is anything in them. Most deployment pain is cheaper to hit now than at M6.

**Brief:** *Create a Cloudflare Worker that responds to `GET /api/health` with `{"ok":true}` and nothing else. Set up `wrangler.toml` with a `[vars]` section and no bindings yet. Separately, create a static `index.html` under `web/` that fetches that endpoint and prints the result, and add the Firebase Hosting config to serve `web/` at `/prompt-gym` with a rewrite of `/prompt-gym/**` to `/prompt-gym/index.html`.*

**Watch for:** the Hugo integration. Your blog builds the site, so `web/` output needs to land in Hugo's `static/prompt-gym/` (or be published as a separate Hosting target). Decide which now — retrofitting it later means moving every asset path.

**Done when:** `arjunuvacha.com/prompt-gym` loads and displays `{"ok":true}` fetched cross-origin from the Worker. That means CORS is already solved, at the point where it is trivial to debug.

---

## M1 · The grading engine, offline

**This is the milestone that matters.** Everything else is plumbing around it. Build it as pure functions with no network access at all, so it can be tested exhaustively for free.

**Brief:** *Build a grading engine as pure TypeScript functions in `worker/src/grading/`. It takes a challenge definition (see `pg-a1-address-extractor.json` for the runtime format), a map of test-case id to model output string, and returns a scorecard. Implement these assertion types: `equals`, `contains`, `icontains`, `contains-all`, `contains-any`, `not-*` variants of each, `regex`, `word-count` (accepting a number or `{min,max}`), `is-json` (with a minimal JSON-schema subset: type, required, properties, enum, pattern, additionalProperties), and `javascript` (resolved from a registry of named validator functions — never `eval` a string). Scoring: per test case, sum(assertionScore × weight) / sum(weight); challenge score = round(100 × mean of case scores). Also implement `rouge-n` and `levenshtein` in pure JS. Write vitest tests covering each assertion type, plus a fixture test that runs the pg-a1 and pg-a2 definitions against hand-written passing and failing outputs.*

**Then, same milestone:** *Write `build/convert.mjs` that reads a `.promptfoo.yaml` challenge and emits the runtime JSON: lift `defaultTest.assert` to `defaultAssert`, move `metadata.reveal` onto each test, and replace inline `javascript` assertion bodies with `ref` names matching the `# ref:` comments in the YAML, failing loudly if a referenced validator is not in the registry.*

**Read this code yourself.** The scoring aggregation and the JSON-schema subset are where quiet bugs live, and a grading bug means every score on the leaderboard is wrong. Specifically check: weights actually applied (not silently defaulted to 1), a test case with zero passing assertions scoring 0 rather than NaN, and `additionalProperties: false` genuinely rejecting extra keys.

**Done when:** `npm test` passes with every assertion type covered, and `node build/convert.mjs challenges/pg-a1-address-extractor.promptfoo.yaml` produces output that **deep-equals** the committed `pg-a1-address-extractor.json`, ignoring keys beginning with `$`.

*(Correction to an earlier draft of this guide, which said "byte-for-byte": that is not achievable and you would have wasted an hour discovering why. The committed JSON carries `$comment` and `$validators` blocks that exist to document the format for a human reader — the converter has no way to invent them, and the `$validators` bodies belong in the Worker's code registry, not in data. Compare parsed objects with `$`-prefixed keys stripped. See the appendix for the full explanation of what this converter is for.)*

---

## M2 · Talking to Groq

**Brief:** *Build `worker/src/providers/groq.ts` exposing `execute({prompt, input, model, apiKey, maxOutputTokens})` and `judge({output, rubric, model, apiKey})`. Both call Groq's OpenAI-compatible chat completions endpoint at temperature 0. Enforce: prompt ≤ 2000 characters (reject before calling), `max_tokens` from the challenge definition, and a 20-second timeout. On HTTP 429, read the `retry-after` header, retry exactly once after that delay, and if it fails again throw a typed `RateLimitedError`. On 5xx or timeout throw a typed `UpstreamError`. Never throw the raw response body — it can echo the API key in some error shapes. The judge returns strict JSON `{pass: boolean, reason: string}` or `{score: number, reason: string}`; on unparseable output, retry once with a stricter instruction, then throw `JudgeError`.*

**The distinction to insist on:** an upstream failure is `errored`, not `failed`. A user whose prompt was fine but whose run hit a 500 must never see a failing score. Make the type system carry this — an `errored` case should be structurally impossible to aggregate into a score.

**Done when:** a script grades one challenge end to end against real Groq, printing the scorecard. Run it with the reference prompt and with the strawman from the YAML; the gap should be obvious.

---

## M3 · First real run in a browser

**Brief:** *Add `POST /api/run` accepting `{challengeId, prompt, model}` plus an optional `X-Groq-Key` header. No auth and no database yet. Pipeline: validate input → load challenge from the bundled JSON → run execution calls across test cases with a concurrency cap of 3 → grade with the M1 engine, cheap graders first → if and only if the cheap graders passed for a case, run its model-graded assertions → aggregate → return the scorecard shape from `challenge-format.md`, with feedback filtered by each case's `reveal` level. Add `GET /api/challenges` returning only the `public` block of each. Build a minimal SPA: challenge list, prompt textarea, model dropdown, Run button, scorecard.*

**The reveal filter is a security boundary, not a display preference.** It must be applied server-side, in the Worker, before the response is serialised. If hidden inputs are sent to the browser and merely hidden in the UI, every challenge is trivially solvable with devtools open. Ask for a test that asserts a `verdict-only` case's `input` and `output` are `null` in the JSON response.

**Watch for:** the cheap-first gate needs to be visible in the response. If judging was skipped, say so (`"judgingSkipped": true`) so a user does not think their rubric score was zero.

**Done when:** you solve pg-a2 in your own browser, then deliberately fail it, and both scorecards read correctly.

---

## M4 · Persistence and dedupe

**Brief:** *Create a D1 database and migrations for `users`, `submissions`, `best_scores`, `share_results` per the design doc. Add a `prompt_hash` column on `submissions` (SHA-256 hex of `challengeId + '\n' + prompt + '\n' + execModel`, via WebCrypto `crypto.subtle.digest`) with an index. In `/api/run`, compute the hash first and look it up: on a hit, return the stored scorecard immediately with `"cached": true` and make zero model calls. Otherwise run, then insert.*

**Watch for:** the dedupe lookup must happen *before* the rate-limit and budget checks consume anything, since a cached run costs nothing. And the hash must include the model — the same prompt on 20b and 120b are different runs.

**Done when:** submitting the same prompt twice returns instantly the second time, and `wrangler d1 execute --command "select count(*) from submissions"` shows one row, not two.

---

## M5 · Auth — the part to read line by line

**Brief:** *Enable Google and Anonymous providers in Firebase Auth. In the SPA, sign in anonymously on first load and expose a sign-in-with-Google button that links the anonymous account rather than replacing it. Send the Firebase ID token as `Authorization: Bearer`. In `worker/src/auth/`, verify the token using WebCrypto only — no firebase-admin, which does not run on the edge. Fetch the public keys from the JWKS endpoint `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`, import with `crypto.subtle.importKey('jwk', ...)`, and verify RS256. Cache the JWKS in the Cache API honouring its `max-age`. Validate every claim: `alg` is RS256, `kid` matches a fetched key, `iss` equals `https://securetoken.google.com/<projectId>`, `aud` equals `<projectId>`, `exp` is in the future, `iat` is in the past, and `sub` is non-empty. Reject on any failure. On success, upsert the user and write `best_scores`.*

**Read every line of this one.** Token verification is the single place where generated code fails in a way that tests pass and security does not. The specific things to check by hand:

- The `kid` from the token header is used to *select* the key. Code that fetches the key set and tries them all, or takes the first, will accept a token signed by the wrong key.
- `aud` and `iss` are actually compared against your project ID, not merely read.
- Expiry is checked. It gets skipped surprisingly often.
- A missing or malformed `Authorization` header results in an anonymous request, not a crash — anonymous play must keep working.

Write a test with a hand-crafted token that has a valid signature but the wrong `aud`, and confirm it is rejected. If that test passes, the rest is probably fine.

**Done when:** signing in with Google preserves scores earned anonymously, and the wrong-`aud` test fails closed.

---

## M6 · Leaderboard

**Brief:** *Add `GET /api/leaderboard?limit=50` returning users ranked by `COUNT(*) FILTER (WHERE passed)` descending, tie-broken by `SUM(score)` descending, computed over `best_scores`. Include the requesting user's own rank even when outside the top 50. Add the leaderboard view to the SPA, and a personal progress strip showing challenges completed out of 14.*

**Watch for:** `best_scores` must only be written server-side, and only from a run that had no `errored` cases. Ask explicitly for the write path to refuse a submission containing any `errored` grader — otherwise an upstream blip can bank a bogus score.

**Done when:** two accounts with different progress rank correctly, and a run forced to error does not change the board.

---

## M7 · Share links

**Brief:** *Add `GET /api/result/:id` returning a public view of a submission, honouring its `share_results.show_prompt` flag, and `POST /api/result/:id/visibility` (owner only) to toggle it. Add a `/prompt-gym/r/:id` route to the SPA that fetches and renders the result client-side. Put static OG tags in the SPA's `index.html` — a generic PromptGym card with the `static/prompt-gym/og-image.png` — so shared links preview as something rather than nothing. No per-result OG tags and no image generation.*

**Why not per-result tags:** Firebase Hosting serves this path from static files and its rewrites cannot target a Cloudflare Worker, so there is no way to inject per-result tags into the initial HTML without either moving the share page onto the ugly `workers.dev` domain or moving DNS to Cloudflare. Neither is worth it for a preview card. The link itself works perfectly — a human clicking through sees the real result. Full reasoning in §6 of `repo-layout.md`.

**Done when:** a result link opens correctly for someone who is not signed in, respects the show-prompt toggle, and previews as a PromptGym card in LinkedIn's Post Inspector.

---

## M8 · Guardrails and launch

**Brief:** *Add a KV-backed shared-budget counter keyed by day and by minute, decremented by each run's estimated token cost from the challenge's `estimatedTokensPerRun`. When the budget is exhausted, return a typed `BudgetExhausted` response and have the SPA switch to BYO-key mode. Add per-IP rate limiting (runs per minute and per hour). Requests carrying an `X-Groq-Key` bypass the shared budget but not the IP limits. Write the BYO-key explanation into the landing page copy. Ensure the key is never written to D1, never logged, and never echoed in an error.*

**Watch for:** KV is eventually consistent, so the budget counter will overshoot slightly under concurrency. That is acceptable here — just do not build anything that assumes it is exact. (Durable Objects would be exact; check whether they are on your plan before reaching for them.)

**Launch checklist:** all 14 challenges converted and loaded · reference and strawman prompts verified for each · secrets set via `wrangler secret put` and absent from the repo · a run with a deliberately broken challenge id returns a clean 400 · anonymous play works in a private window · the reveal filter verified in the network tab, not just the UI.

---

## Testing, without burning quota

Three layers, and only the third costs tokens:

1. **Grading engine** — pure unit tests, no network. This should be where most of your tests are.
2. **Worker endpoints** — vitest with `@cloudflare/vitest-pool-workers`, with the Groq client stubbed. Record real Groq responses once into fixtures and replay them; do not call the API in tests.
3. **Challenge validation** — `promptfoo eval` against your own key, run deliberately when authoring a challenge, not in CI. This is the expensive layer and it is a human-in-the-loop step, not an automated one.

A CI run that calls Groq will eat the daily budget that the live site needs. Keep the API out of CI entirely.

---

## Working with Claude Code on this

A few things that make the difference between a good session and a 900-line diff you cannot review:

**Ask for tests before implementation on M1.** The grading engine is the one place where "it looks right" is not good enough, and tests-first is the cheapest way to force the edge cases into the open.

**Give it the runtime JSON, not a description of it.** `pg-a1-address-extractor.json` is a complete, valid example of the format. Hand it that file rather than explaining the schema — it will get the shape right and you will skip a round of corrections.

**When it proposes a library, ask whether it runs on the Workers edge runtime.** This is the most common failure mode for this stack. `firebase-admin`, `ajv` in its full form, anything touching `fs`, `child_process` or Node crypto — none of it works. The answer is almost always WebCrypto plus a hand-rolled subset.

**Keep the challenge YAMLs out of scope for code sessions.** They are content. If a session starts editing test cases to make its implementation pass, stop it — that is the tail wagging the dog, and it silently weakens the challenges.

---

## What is deliberately not in this guide

Deployment automation, CI/CD, a custom domain for the Worker, analytics, and the launch post. All of them are easier once the thing runs, and none of them blocks M0–M8.

---

# Appendix A · What `convert.mjs` is actually for

**The problem it solves: one challenge, two readers, two schemas.**

A challenge has to be read by two completely different programs:

| Reader | Where | Format it expects |
|---|---|---|
| **promptfoo** | Your laptop, while authoring | promptfoo's own YAML schema |
| **The Worker** | Production, on every run | Our runtime JSON schema |

They describe the same thing but not in the same shape, because promptfoo was not designed for this app and our Worker was not designed to be promptfoo. You could maintain both files by hand — and about three weeks in, you would fix a test case in the YAML, forget the JSON, and spend an evening wondering why a challenge behaves differently in production than it did when you validated it. The converter exists so the YAML is the single source of truth and the JSON is a build output you never edit.

**The four transformations, and why each one exists**

**1 · Lift `defaultTest.assert` → `defaultAssert`.** Pure renaming. promptfoo expresses "assertions that apply to every test case" by nesting them under a `defaultTest` key — that is its inheritance mechanism. Our runtime format calls the same thing `defaultAssert` at the top level. Moving it means the Worker never has to know that a concept called `defaultTest` exists.

**2 · Move `metadata.reveal` → `tests[].reveal`.** promptfoo has no concept of reveal levels, so in the YAML it has to hide inside `metadata`, which is promptfoo's generic "put whatever you like here" bucket. In the runtime JSON it becomes a first-class field, because for the Worker it is not a note — it is the flag that decides what gets stripped out of the response. Promoting it makes it visible to the type system, so a test case missing a reveal level fails the build instead of silently defaulting to something permissive.

**3 · Replace inline `javascript` bodies with `ref` names.** This is the one that actually matters.

In the YAML, a JS assertion carries its function *as a string*:

```yaml
- type: javascript
  # ref: validators.isEmptyArray
  value: "(output) => { const a = JSON.parse(output); return Array.isArray(a) && a.length === 0; }"
```

That is fine locally: promptfoo runs on Node, on your machine, and turns that string into a function. In the Worker it is not fine, for two separate reasons. First, turning a string into a function requires `eval` or `new Function`, which the Workers runtime blocks by default. Second — and this is the real reason — a server that handles untrusted public input should not contain a code path that executes code from data. Even though *you* wrote these strings, the machinery for running arbitrary strings as code is exactly the machinery you never want sitting in a request handler.

So at build time the string is thrown away and replaced by a name:

```json
{ "type": "javascript", "ref": "validators.isEmptyArray", "weight": 5, "metric": "hallucination" }
```

The Worker holds a plain object mapping those names to real functions, compiled into the bundle at deploy time:

```js
export const validators = {
  'validators.isEmptyArray': (output) => { /* ... */ },
  'validators.stateMustBeEmpty': (output) => { /* ... */ },
};
```

Grading looks up `ref` in that map. If the name is not there, nothing runs. There is no path from challenge data to executed code — the data can only *select* from functions you shipped.

The `# ref:` comments I put in every YAML are how the converter knows which name to assign. It reads the comment directly above the assertion.

**4 · Fail loudly on a missing validator.** If a YAML says `# ref: validators.foo` and the Worker's registry has no `validators.foo`, then in production that assertion silently never passes, the challenge becomes unsolvable, and you find out from a confused player. So the converter imports the registry, checks every ref it emits exists in it, and exits non-zero if not. A broken challenge should break the build, not the leaderboard.

**Why the golden-file check.** `pg-a1-address-extractor.json` was hand-written before the converter existed, which makes it a useful test: if the converter independently produces the same thing, both are probably right. It is a one-time check for correctness of the converter, not a permanent test to maintain — once you trust it, the YAML is the source of truth and the JSON is disposable output.

---

# Appendix B · "Does it run on the Workers edge runtime?"

## B.0 · Where your code actually runs

Three different machines are involved in this project, and the folder a file sits in decides which one it runs on. This is the thing to get straight before session 1, because "can I use `fs` here?" has a different answer in different directories of the same repo.

| Folder | Runs where | Runtime | Node APIs? |
|---|---|---|---|
| `build/`, `scripts/` | Your Mac, when you run the command | Node.js | **Yes, all of them** |
| `worker/src/` | Cloudflare's servers, when a request arrives | workerd (V8 isolate) | **No** |
| `web/` | The visitor's browser | Chrome/Safari (V8, JavaScriptCore) | No |

So `build/convert.mjs` can `import fs from 'node:fs'` and read challenge files off disk quite happily — it is a Node script you run yourself. `worker/src/grading/score.ts` cannot, ever. Same repo, same language, same `npm install`, different runtime.

**Engine versus environment.** V8 is the JavaScript *engine* — it parses and executes JS and nothing else. What differs is what has been built around it:

- **Node.js** = V8 + Node's libraries (`fs`, `net`, `child_process`, `node:crypto`, `Buffer`)
- **Chrome** = V8 + browser APIs (DOM, `fetch`, `localStorage`, WebCrypto)
- **Cloudflare Workers** = V8 + a web-standard API set (`fetch`, `crypto.subtle`, `TextEncoder`, streams) — no DOM, no filesystem, no processes

Same engine, three different cars built around it. Code written for one is not automatically portable to another, even though it is all "JavaScript".

**What about `wrangler dev`?** This is where people get confused. When you run `npx wrangler dev`, your Worker is served at `localhost:8787` — on your Mac. But it is not running under Node. Wrangler runs your code inside **workerd**, Cloudflare's actual runtime, compiled to run on your machine. So it is the real edge runtime, running locally. That is exactly why `wrangler dev` catches Node-API mistakes that plain `node worker.js` would sail straight past, and why you should develop the Worker under `wrangler dev` rather than any Node-based dev server.

**Why failures arrive late.** `npm install` puts a package on your Mac's disk. Your editor resolves its types, autocomplete works, everything looks healthy — because all of that is happening in the Node world where the package is perfectly at home. Wrangler then bundles the parts of your code that get imported into a single JavaScript file and uploads that to Cloudflare. The mismatch only surfaces when that bundled code actually executes:

- **At bundle time**, if the import is direct and unconditional — esbuild says "Could not resolve 'fs'". This is the good case.
- **At startup**, if the library touches a missing API while loading — every request fails immediately.
- **On one code path**, if it only calls the missing API inside a function you rarely hit — works fine for weeks, then breaks the first time someone triggers that path in production. This is the bad case, and it is why the habit is to ask before adopting rather than to test and hope.

---

**Cloudflare Workers do not run Node.js.** They run V8 isolates — the same JavaScript engine as Chrome, with web-standard APIs: `fetch`, `Request`, `Response`, `crypto.subtle`, `TextEncoder`, `URL`, streams. It looks like JavaScript, the npm install works, the types resolve. But there is no filesystem, no process, no Node standard library.

This matters because most npm packages were written for Node and assume all of that exists. The failure is often not at install time and not at build time — it is on the first request that reaches the line using the missing API. Which is why the habit worth building is asking *before* adopting a library, not after.

**What breaks:**

| Node thing | Why it fails on Workers | What you use instead |
|---|---|---|
| `fs` | There is no disk | Bundle data into the Worker at build time (this is why challenges ship as imported JSON) |
| `child_process` | No processes to spawn | Nothing — restructure the approach |
| `node:crypto` | Different API surface from WebCrypto | `crypto.subtle.*` |
| `Buffer` | Not a global | `TextEncoder` / `Uint8Array` |
| `net`, `tls` raw sockets | Only outbound `fetch` (plus limited TCP via `connect()`) | HTTP APIs |
| `eval` / `new Function` | Blocked by default | A lookup table of real functions — exactly what Appendix A describes |

**The three from the guide, specifically:**

**`firebase-admin`** — this one deserves unpacking, because it is two separate problems wearing one coat.

*Problem one: the service-account file.* Firebase has two SDKs. The **client** SDK runs in the browser, signs users in, and holds no secrets — its config is public by design. The **admin** SDK is meant for your server and can do privileged things: verify anyone's token, read any user record, write any data, ignore security rules. To prove it is entitled to that, it authenticates as a **service account** — a robot identity Google issues for your project, whose credentials arrive as a JSON file containing a private key. The standard setup points the library at that file on disk:

```js
admin.initializeApp({ credential: admin.credential.cert('/etc/secrets/serviceAccount.json') })
```

Under the hood that is `fs.readFileSync`. There is no disk on Workers, so it fails. (In fairness, you can hand the JSON in from an environment variable instead of a path, so this half alone would not be fatal.)

*Problem two — the actual blocker: verifying the JWT.* When a user signs in, Firebase hands the browser an **ID token**: a JWT, which is three base64 segments — header, payload, signature — where the payload carries claims like `sub` (the user's id), `aud` (which project it is for) and `exp` (when it expires). Google signs it with its private key.

Your server cannot simply read the payload and believe it, because anyone can type out a JSON object claiming to be any user. What makes it trustworthy is checking the **signature**: fetch Google's corresponding *public* key and verify cryptographically that this exact header and payload were signed by Google's private key. If the signature checks out, the claims inside are genuine, and you can trust `sub` without a database lookup or a session store — which is precisely what makes stateless auth work on the edge.

`firebase-admin` performs that verification with Node's `crypto` module — `crypto.createVerify('RSA-SHA256')` and friends. Workers has no `node:crypto`. It has WebCrypto, where the same operation is `crypto.subtle.importKey` followed by `crypto.subtle.verify` — different names, async instead of sync, `ArrayBuffer` instead of `Buffer`. It is not a shim you can drop in; it is a different API for the same mathematics.

So the replacement is about sixty lines of your own code. Worth noting how narrow the loss is: PromptGym needs exactly one thing from the admin SDK — token verification — because all our data lives in D1, not Firestore. None of the other privileged powers are ever used. You are not reimplementing firebase-admin; you are implementing the one percent of it this project touches. That is why M5 says read every line: it is short enough to read, and it is the only security-critical code in the project.

**`ajv` in full form** compiles a JSON schema into a JavaScript function *at runtime* — using `new Function`. That is precisely the blocked capability. (Nuance worth knowing: ajv has a standalone mode that precompiles schemas into plain code ahead of time, which can work on Workers. For the six schema keywords this project uses, hand-rolling is still less trouble than wiring up ajv's build step.)

**Node crypto for hashing** — the dedupe hash in M4 is the concrete case:

```js
// Node — does not work on Workers
crypto.createHash('sha256').update(s).digest('hex')

// Workers — WebCrypto
const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
```

Note the second one is `async`. That difference propagates up through your call stack, which is the kind of thing worth knowing before you have written the function that calls it.

**`nodejs_compat`.** Cloudflare offers a compatibility flag that polyfills a *subset* of Node APIs, and it has improved a great deal. It is genuinely useful, but "it might work with nodejs_compat" is not the same claim as "it works" — the subset has edges, and discovering where they are is not how you want to spend a Sunday. For this project you should need approximately zero dependencies in the Worker, so the flag should not be necessary at all.

**How to check a library in thirty seconds:**

1. Do its docs mention Workers, edge, Deno, or ship a browser/ESM build? Good sign.
2. Does its dependency tree include node builtins? `npm ls` and look.
3. Run `npx wrangler dev` and actually hit the code path. Import-time success proves nothing.
4. Ask Claude Code directly: *"Does this run on the Cloudflare Workers runtime without nodejs_compat? If not, what is the WebCrypto equivalent?"* — it answers this accurately and it is faster than finding out at M6.

**The rule of thumb:** on the edge, a dependency is a liability until proven otherwise. This entire Worker — grading engine, JWT verification, D1 queries, Groq client — should ship with essentially no runtime dependencies. If a session proposes adding one, that is the moment to ask question 4.
