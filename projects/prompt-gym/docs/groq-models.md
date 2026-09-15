# Groq free tier — model options for PromptGym

**Checked:** 13 Sep 2026, against Groq's own docs (`console.groq.com/docs/models` and `/docs/rate-limits`).
**Decision needed from you:** which models go in the execution picker, and which one is pinned as the judge.

> **The headline change since you last looked:** `llama-3.1-8b-instant` and `llama-3.3-70b-versatile` are now marked **Enterprise tier** and no longer appear in the free-tier rate-limit table at all. The design doc's earlier "fast small Llama for execution, bigger Llama for judging" assumption is dead. The free tier is now the **GPT-OSS** and **Qwen** families, plus the Compound agentic systems and some specialist classifiers.

---

## 1. What is actually on the free tier

### Chat / reasoning models

| Model ID | Context | Max output | Speed | Free-tier limits |
|---|---|---|---|---|
| `openai/gpt-oss-20b` | 131K | 65K | ~1000 T/s | 30 RPM · 1K RPD · 8K TPM · 200K TPD |
| `openai/gpt-oss-120b` | 131K | 65K | ~500 T/s | 30 RPM · 1K RPD · 8K TPM · 200K TPD |
| `openai/gpt-oss-safeguard-20b` | 131K | 65K | — | Same GPT-OSS bucket |
| `qwen/qwen3.6-27b` *(preview)* | 131K | — | — | Same bucket as GPT-OSS |
| `qwen/qwen3.8-27b` *(preview)* | 131K | — | — | Same bucket as GPT-OSS |

### Agentic systems (models with built-in tools)

| System ID | Context | Max output | Speed | Free-tier limits |
|---|---|---|---|---|
| `groq/compound` | 131K | 8,192 | ~450 T/s | 30 RPM · 250 RPD · **70K TPM** |
| `groq/compound-mini` | 131K | 8,192 | ~450 T/s | 30 RPM · 250 RPD · **70K TPM** |

> **What "agentic system" means here**
>
> A plain chat model is a single function call: text in, text out, nothing else happens in between. Whatever it knows, it knows from training.
>
> An agentic system is that model *plus a loop and a toolbox*, wrapped behind the same API shape. You send one request; behind the scenes it may decide to run a web search, execute a snippet of code, read the results, and only then write its answer. Groq's Compound systems bundle web search and code execution this way. You do not orchestrate any of it — that is the selling point. Ask "what is the USD/INR rate today" and a plain model guesses from training data while Compound goes and looks it up.
>
> The catch, and why they are wrong for PromptGym's execution path: you no longer control what the model had access to. A challenge that asks the user to write a prompt extracting structured data is measuring the prompt — but a tool-using model might solve the task by searching or by writing throwaway code, passing the test for reasons that have nothing to do with the prompt's quality. Worse for grading, the same input can produce different outputs on different runs depending on what the search returned, so a score stops being reproducible and a leaderboard built on it stops meaning anything.
>
> They are genuinely useful, just for a different kind of product — a research assistant, a live-data Q&A bot. For a system whose entire job is isolating the effect of one variable (the prompt), a model that can reach outside the box is a confound, not a feature. Worth revisiting only if a future challenge type is explicitly about *writing prompts for agents*, where tool use is the thing under test.

### Specialist classifiers

| Model ID | What it does | Free-tier limits |
|---|---|---|
| `meta-llama/llama-prompt-guard-2-86m` | Jailbreak / prompt-injection detection | 30 RPM · **14.4K RPD** · 15K TPM · **500K TPD** |
| `meta-llama/llama-prompt-guard-2-22m` | Same, smaller and faster | Same bucket |

### Not relevant here
`whisper-large-v3` / `-turbo` (speech-to-text), `canopylabs/orpheus-*` (text-to-speech). Ignore unless a voice challenge ever happens.

---

## 2. The budget math — read this before picking anything

A representative run: **4 test cases, 2 model-graded assertions.**

| Item | Count | Tokens each | Total |
|---|---|---|---|
| Execution calls (prompt + input in, capped output) | 4 | ~500 | 2,000 |
| Judge calls (output + rubric in, short verdict out) | 2 | ~500 | 1,000 |
| **Per run** | **6 requests** | | **~3,000 tokens** |

Against the GPT-OSS/Qwen free-tier bucket:

| Limit | Value | What it means site-wide |
|---|---|---|
| 8K **tokens per minute** | 8,000 | ~2.6 runs/minute across *all* visitors combined |
| 1K **requests per day** | 1,000 | ~166 runs/day |
| 200K **tokens per day** | 200,000 | **~66 runs/day** ← the binding constraint |

**So the shared pool supports roughly 66 full runs per day for the entire site.** One engaged visitor iterating ten times on a challenge consumes 15% of the daily budget. A LinkedIn post that lands will exhaust it within the hour.

This is not a reason to abandon the free tier — it is the reason BYO-key is in v1 rather than v2, and it is worth being upfront about in the product copy rather than letting visitors hit a wall and assume the app is broken.

### Budget levers worth designing in

Each of these buys real headroom, and most of them are one-line decisions:

1. **Dedupe identical submissions.** Hash `(challengeId, prompt, execModel)` and serve the cached grading. Everything runs at temperature 0, so a re-submission of the same prompt legitimately has the same result. Leaderboard grinding becomes free.
2. **Judge once, not per test case.** Pass all N outputs to the judge in a single call and ask for N verdicts. Cuts 4 judge calls to 1 — roughly a third off the run cost.
3. **Three test cases, not five.** Diminishing returns past three for teaching purposes, and it is a straight 25% saving.
4. **Cap output at ~192–256 tokens** on execution calls. Most challenges have short correct answers; a user whose prompt produces an essay should fail the word-count grader anyway.
5. **Gate the judge behind the cheap graders.** If the output already failed the string/rule-based checks, there is often nothing left for a rubric to add — skip the call and say so in the scorecard.
6. **Lean on the classifier budget.** `llama-prompt-guard-2` has 500K TPD and 14.4K RPD in its *own* bucket, entirely separate from GPT-OSS. Injection and safety challenges graded through it cost nothing from the main pool.

Levers 1, 2 and 5 together roughly triple the effective daily capacity.

---

## 3. Candidates for the **execution** model picker

This is the model that runs the user's prompt. What matters: speed (the user is waiting), instruction-following fidelity (a weak model makes good prompts look bad), and being interestingly *different* from its neighbours in the picker — the teaching value is in seeing a prompt hold up on one model and break on another.

### `openai/gpt-oss-20b` — recommended default
- **For:** ~1000 T/s, the fastest thing on the list, so the run feels instant. Small enough that sloppy prompts genuinely fail, which is exactly what a training tool wants — a model that is too good papers over bad prompting and the user learns nothing.
- **Against:** will fail some challenges for reasons that are the model's fault rather than the prompt's, which can feel unfair if it is the only option.
- **Verdict:** best default. Fast, cheap in tokens, and appropriately unforgiving.

### `openai/gpt-oss-120b` — recommended second slot
- **For:** noticeably stronger instruction-following; the natural "my prompt works here but not on 20b" comparison, which is the single most instructive thing the picker can show. Same rate-limit bucket, so no extra plumbing.
- **Against:** ~500 T/s and a larger model means more tokens burned per run against a shared 200K/day.
- **Verdict:** include. The 20b-vs-120b contrast is most of the picker's educational value.

### `qwen/qwen3.6-27b` or `qwen/qwen3.8-27b` — recommended third slot, pick one
- **For:** a genuinely different model family, so it surfaces family-specific prompt brittleness rather than just size effects. Sits mid-way in capability.
- **Against:** both are **preview** models — Groq can pull or rename them with little notice, which breaks stored leaderboard entries that reference them. Shipping two near-identical Qwen versions in the picker adds confusion without adding signal.
- **Verdict:** include one (the newer `qwen3.8-27b` unless testing shows it is worse), label it "preview" in the UI, and have the app degrade gracefully to 20b if the ID disappears.

### `groq/compound` / `groq/compound-mini` — EXCLUDED (decided 14 Sep 2026)
- **For:** a 70K TPM ceiling, nearly 9× the GPT-OSS bucket, which is tempting given the budget math above.
- **Against:** these are agentic *systems* with built-in tools (web search, code execution), not plain chat models. If a model can search the web mid-answer, it can solve an extraction challenge without following the user's prompt at all — the score stops measuring prompt quality. Also only 250 RPD.
- **Verdict:** exclude from the execution picker. The whole point is to measure the prompt, and a tool-using model confounds that. Worth revisiting only for a future agentic challenge type where tool use *is* the thing being tested.

### `openai/gpt-oss-safeguard-20b` — not an execution model
Purpose-built for safety classification. Belongs on the grading side, not in the picker.

---

## 4. Candidates for the **pinned judge**

Reminder of the design call: the judge is not user-selectable, because a leaderboard where everyone picks their own grader ranks nothing. Pick one and pin it.

### `openai/gpt-oss-120b` — recommended
- **For:** strongest free-tier reasoner for rubric scoring; no tools, so verdicts are reproducible; temperature 0 keeps it stable; same bucket as execution so there is one budget to reason about.
- **Against:** consumes the same scarce 200K TPD as execution. Mitigate with lever 2 (judge once over all outputs) and lever 5 (gate behind cheap graders).
- **Verdict:** pin this.

### `openai/gpt-oss-20b` — the budget alternative
- **For:** far cheaper per verdict; adequate for simple binary labelling ("is this JSON-shaped", "is this a refusal").
- **Against:** meaningfully weaker on nuanced rubrics, and a judge that grades inconsistently is worse than no judge — it makes the leaderboard noise rather than signal.
- **Verdict:** a reasonable *fallback* judge for label-model graders specifically, while 120b handles score-model rubrics. Splitting by grader type like this is defensible and saves real budget.

### `groq/compound-mini` — EXCLUDED here too (decided 14 Sep 2026)
Its 70K TPM would solve the budget problem outright. But it may invoke tools while grading, which makes verdicts non-reproducible — two identical runs can score differently because one of them decided to search the web. For a leaderboard, that is disqualifying. Ruled out entirely rather than held as a fallback: a load-shedding path that silently changes how scores are produced is worse than a queue.

### `meta-llama/llama-prompt-guard-2-86m` — yes, for one specific job
Not a general judge, but the right grader for prompt-injection and jailbreak challenges: purpose-built, fast, and on its own 500K TPD budget. Use it as the label-model grader wherever the challenge is "did the prompt hold up against an injected instruction."

### `openai/gpt-oss-safeguard-20b` — yes, for one specific job
Same idea for safety/refusal challenges — "did the output appropriately refuse" is exactly what it is built to answer, and it will be steadier at it than a general rubric prompt.

---

## 5. Configuration — ACCEPTED 14 Sep 2026

**Execution picker (3 options):**
1. `openai/gpt-oss-20b` — default, labelled "Fast"
2. `openai/gpt-oss-120b` — labelled "Strong"
3. `qwen/qwen3.8-27b` — labelled "Preview · different family"

**Grading (pinned, not user-visible as a choice):**
- Score-model rubrics → `openai/gpt-oss-120b` @ temp 0
- Label-model verdicts → `openai/gpt-oss-20b` @ temp 0
- Safety/refusal labels → `openai/gpt-oss-safeguard-20b`
- Injection/jailbreak labels → `meta-llama/llama-prompt-guard-2-86m`
- Embeddings for `similar` → Cloudflare Workers AI `@cf/baai/bge-m3` (Groq has no embeddings endpoint; Workers AI gives 10,000 neurons/day free and bge-m3 costs ~1,075 neurons per million tokens, so this is effectively free at any volume this app will see)

**Store the execution model ID on every submission** so that when Groq changes the lineup again — and it has already changed once during this project's design — you can tell which leaderboard entries were earned on which model.

---

## 6. Things to re-verify at build time

- Whether the Qwen previews are still listed, and under those exact IDs.
- Whether the GPT-OSS free-tier numbers (30 RPM / 1K RPD / 8K TPM / 200K TPD) still hold — check the live figures in your own console under Settings → Limits, since they are shown per-organisation.
- Whether Groq has added an embeddings endpoint (it had none as of this check); if it has, it may be simpler than the Workers AI hop.
- Whether `llama-3.1-8b-instant` has returned to the free tier — it was the obvious fast-execution choice before it moved to enterprise.

**Sources:** [Groq models documentation](https://console.groq.com/docs/models) · [Groq rate limits documentation](https://console.groq.com/docs/rate-limits) · [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
