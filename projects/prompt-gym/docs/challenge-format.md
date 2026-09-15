# PromptGym — challenge format, grader mapping, and failure-reveal policy

This is the file to read before authoring any challenge. It covers three things:

1. **The two formats** — promptfoo YAML for authoring, PromptGym JSON for runtime, and why there are two.
2. **The grader mapping** — every grader family, the promptfoo assertion it maps to, and how the Worker implements it.
3. **The failure-reveal policy** — how much to tell a user about why they failed. Decided 15 Sep 2026: `partial` for every test case in v1. The differentiated per-family/per-position policy is documented below as the target for a later iteration.

---

## 1. Why two formats

**Author in promptfoo. Ship as JSON.**

promptfoo's library needs a Node runtime and cannot run on the Cloudflare Workers edge, so it is not a runtime dependency — but it is free, local, and excellent at the job of *validating a challenge before it goes live*. So:

```
challenges/pg-a1.promptfoo.yaml     ← you author here
        │
        │  promptfoo eval -c pg-a1.promptfoo.yaml    (local, your own Groq key, free)
        │  → does a good prompt actually pass?
        │  → does a deliberately bad prompt actually fail?
        │  → do the graders discriminate between them?
        ▼
   build script (node, local)
        │
        ▼
challenges/pg-a1.json               ← shipped inside the Worker bundle
```

This resolves the "how central is promptfoo" question cleanly: it is central to authoring, absent from runtime, and costs nothing. It also gives every challenge a real validation gate — the failure mode this prevents is shipping a challenge that is impossible, trivially passable, or whose graders do not actually distinguish a good prompt from a bad one.

**The authoring loop per challenge:**

1. Write the YAML: goal, 3–5 test cases, assertions.
2. Write a *reference prompt* you believe should pass, and a *strawman prompt* you believe should fail.
3. `promptfoo eval` both. Reference should score high; strawman should score low. If they score the same, the graders are not discriminating and the challenge is not ready.
4. Run the reference prompt against each model you plan to put in the picker — a challenge that only `gpt-oss-120b` can pass makes the 20b default look broken.
5. Export to JSON, drop into the Worker bundle.

Budget note: steps 3–4 are the token-expensive part of authoring and they run against *your own* key, not the shared pool. Authoring 15 challenges at ~10 validation runs each is a real chunk of daily quota — space it across the weekend, or accept doing it in batches.

---

## 2. Authoring format (promptfoo YAML)

The user's submitted prompt is injected as the `{{userPrompt}}` var at runtime; during authoring you substitute your reference prompt in its place. Each test case's input is `{{input}}`.

```yaml
description: "PG-A1 — Strict JSON address extractor"

prompts:
  - |
    {{userPrompt}}

    ---
    INPUT:
    {{input}}

providers:
  - id: groq:openai/gpt-oss-20b
    config:
      temperature: 0
      max_tokens: 256

defaultTest:
  options:
    provider: groq:openai/gpt-oss-120b   # the pinned judge, for model-graded asserts
  assert:
    - type: is-json
      weight: 2
      metric: format

tests:
  - description: "clean single address"
    vars:
      input: "Ship to Priya Raman, 14 MG Road, Bengaluru 560001, Karnataka"
    assert:
      - type: is-json
        value:
          type: object
          required: [name, line1, city, pincode, state]
          properties:
            pincode: { type: string, pattern: "^[0-9]{6}$" }
        weight: 3
        metric: schema
      - type: contains
        value: "560001"
        weight: 1
        metric: accuracy

  - description: "no address present — must return empty, not hallucinate"
    vars:
      input: "Thanks for the update, I'll get back to you next week."
    assert:
      - type: javascript
        value: |
          (output) => {
            const j = JSON.parse(output);
            return Array.isArray(j) ? j.length === 0 : Object.keys(j).length === 0;
          }
        weight: 3
        metric: hallucination
```

### Fields that matter

| Field | Use |
|---|---|
| `prompts` | The harness template. Always wraps `{{userPrompt}}` and `{{input}}`. Keep it identical across challenges so users learn one mental model. |
| `providers` | The execution model. At runtime this is whatever the user picked, so treat the value here as the *authoring* default. |
| `defaultTest.assert` | Assertions applied to every test case — good for format rules that hold throughout. |
| `defaultTest.options.provider` | The grading model for model-graded assertions. Pinned. |
| `tests[].vars.input` | The hidden test input. Never shipped to the browser. |
| `tests[].assert[]` | Per-case assertions. |
| `assert[].weight` | Relative importance, default 1. This is how composite scoring is expressed. |
| `assert[].metric` | Names the grader family for the scorecard breakdown — use these consistently (`format`, `schema`, `accuracy`, `faithfulness`, `tone`, `safety`, `hallucination`, `efficiency`). |
| `assert[].threshold` | Pass bar for similarity and score-model assertions. |
| `tests[].threshold` | Minimum combined weighted score for the whole test case to count as passed. |
| `type: assert-set` | Groups assertions with their own threshold and weight — this is the composite grader. |

---

## 3. Runtime format (PromptGym JSON)

What the build script emits and the Worker ships. Same information, plus the fields promptfoo has no concept of: challenge mode, public-facing copy, reveal policy, and the call budget.

```json
{
  "id": "pg-a1",
  "title": "Strict JSON address extractor",
  "mode": "goal",
  "difficulty": 2,
  "tags": ["extraction", "json"],
  "graderFamilies": ["string-check", "rule-based"],
  "public": {
    "goal": "Write a prompt that extracts a postal address from free text into strict JSON with keys: name, line1, city, pincode, state. If there is no address, return an empty object.",
    "startingPrompt": null,
    "exampleInput": "Ship to Priya Raman, 14 MG Road, Bengaluru 560001, Karnataka",
    "constraintsShown": ["Output must be valid JSON", "No prose outside the JSON"]
  },
  "harness": {
    "template": "{{userPrompt}}\n\n---\nINPUT:\n{{input}}",
    "maxOutputTokens": 256,
    "temperature": 0
  },
  "limits": {
    "maxPromptChars": 2000,
    "estimatedCallsPerRun": 4,
    "estimatedTokensPerRun": 2400
  },
  "scoring": {
    "maxScore": 100,
    "passThreshold": 0.7,
    "golfBonus": null
  },
  "tests": [
    {
      "id": "t1",
      "input": "Ship to Priya Raman, 14 MG Road, Bengaluru 560001, Karnataka",
      "reveal": "partial",
      "assert": [
        { "type": "is-json", "value": { "...": "json schema" }, "weight": 3, "metric": "schema" },
        { "type": "contains", "value": "560001", "weight": 1, "metric": "accuracy" }
      ]
    },
    {
      "id": "t2",
      "input": "Thanks for the update, I'll get back to you next week.",
      "reveal": "verdict-only",
      "assert": [
        { "type": "javascript", "ref": "validators.emptyObjectOrArray", "weight": 3, "metric": "hallucination" }
      ]
    }
  ]
}
```

Two differences from the YAML worth noting: `javascript` assertions become a `ref` to a named validator function compiled into the Worker bundle (no `eval` of strings at runtime, ever), and every test case carries an explicit `reveal` level.

### Response shape returned to the browser

```json
{
  "submissionId": "sub_01J...",
  "score": 78,
  "passed": true,
  "execModel": "openai/gpt-oss-20b",
  "promptTokens": 143,
  "leaderboardEligible": true,
  "byGrader": [
    { "metric": "schema", "family": "string-check", "score": 1.0, "weight": 3 },
    { "metric": "accuracy", "family": "string-check", "score": 1.0, "weight": 1 },
    { "metric": "hallucination", "family": "rule-based", "score": 0.0, "weight": 3 }
  ],
  "tests": [
    {
      "id": "t1",
      "status": "passed",
      "reveal": "partial",
      "input": "Ship to Priya Raman, 14 MG Road, …",
      "output": "{\"name\":\"Priya Raman\", …}",
      "failures": []
    },
    {
      "id": "t2",
      "status": "failed",
      "reveal": "verdict-only",
      "input": null,
      "output": null,
      "failures": [
        { "metric": "hallucination", "hint": "On one hidden input your prompt invented address fields that were not in the text." }
      ]
    }
  ],
  "budget": { "sharedPoolRemaining": "low", "byoKeyActive": false }
}
```

---

## 4. Grader mapping

| Family | promptfoo assertion types | Worker implementation | AI call | Cost |
|---|---|---|---|---|
| **String check** | `equals`, `contains`, `icontains`, `contains-all`, `contains-any`, `starts-with`, `regex`, `is-json`, `contains-json`, `is-xml`, `word-count`, `not-*` variants | Pure JS in the Worker. `is-json` with a schema needs a tiny JSON-schema validator (ajv is too heavy for the edge — hand-roll the subset you use). | No | Free |
| **Rule-based** | `javascript` | Named validator functions compiled into the bundle, referenced by `ref`. **Note:** promptfoo's `python` assertion has no edge equivalent — author rule-based graders in JS so the same file runs both locally and in production. | No | Free |
| **Text similarity** | `similar`, `rouge-n`, `levenshtein`, `bleu`, `meteor` | `rouge-n`/`levenshtein`/`bleu` in pure JS. `similar` calls Cloudflare Workers AI `@cf/baai/bge-m3` for embeddings, then cosine. | Embedding only | ~free (10K neurons/day) |
| **Label model** | `llm-rubric` constrained to a fixed label set, `classifier` | Pinned judge (`gpt-oss-20b`) returning one label from an enum, temp 0. Safety labels route to `gpt-oss-safeguard-20b`; injection labels to `llama-prompt-guard-2-86m` (separate, generous budget). | Yes | Groq tokens |
| **Score model** | `llm-rubric` with threshold, `g-eval`, `factuality`, `answer-relevance` | Pinned judge (`gpt-oss-120b`) returning `{score, reason}` as JSON, temp 0. | Yes | Groq tokens |
| **Composite** | `assert-set` with `threshold` + per-assertion `weight` | Weighted aggregation in the Worker; inherits whatever the child assertions cost. | Inherits | Inherits |

**Assertions to avoid**, despite being available in promptfoo: `cost` and `latency` (meaningless on a shared free tier), `perplexity` (not exposed by Groq), `context-*` (no RAG context in v1), `trajectory:*` and `trace-*` (no agentic runs in v1), `webhook` (an extra network hop for nothing), `select-best` (needs multiple candidate outputs — interesting for a v2 side-by-side mode).

### Scoring formula

Per test case: `caseScore = Σ(assertionScore × weight) / Σ(weight)`, each assertion scoring 0–1 (binary graders emit 0 or 1; similarity and score-model graders emit their normalised value).

Challenge score: `round(100 × mean(caseScores))`.

Golf mode adds, only once `mean(caseScores) >= passThreshold`:
`efficiencyBonus = round(20 × max(0, 1 − promptTokens / parTokens))` where `parTokens` is the reference prompt's token count, capped so the total never exceeds 100. Correctness first, brevity second — never the reverse.

---

## 5. Failure-reveal policy — decided 15 Sep 2026

**v1 ships `reveal: partial` on every test case, with no exceptions by position or grader family.** No `full` worked-example case, no `verdict-only` case — every test case in every challenge discloses the input and the model's output, plus which grader failed and a generic reason, never the expected value. Simplest thing to build and to reason about for launch; the differentiated policy below (position- and family-aware) is the intended direction but deferred until there is real playtest data to decide where it's actually worth it, rather than guessing up front. Revisit after playing through the 12 challenges.

**Post-pass reveal — decided:** a user who has passed a challenge unlocks the **reference prompt only**. Hidden inputs and expected values stay hidden even after passing — an alt account passing a challenge can't be used to read the answer key for cases still hidden from a fresh attempt.

The rest of this section is the target policy for a later iteration, kept for reference — not what M1/M3 should implement for launch.

The tension it is designed to solve: reveal enough that the user learns something, without handing over the test oracle so they can hardcode to it. A user who can see the hidden input and the expected string can write `if input contains X, output Y` and pass without having written a good prompt.

Three levels, set per test case:

| Level | Shows | Use when |
|---|---|---|
| `full` | Input, model output, which assertions failed, expected vs actual | The test case is illustrative rather than discriminating — typically the first case in a challenge, acting as a worked example |
| `partial` | Input and model output, plus *which grader* failed and a generic reason — never the expected value | The default for most cases |
| `verdict-only` | Nothing but "a hidden case failed on <metric>" plus a one-line hint | Adversarial or edge cases where knowing the input is most of the answer |

**Proposed defaults per grader family:**

| Family | Default | Reasoning |
|---|---|---|
| String check | `partial` | Seeing that the output was not valid JSON teaches something; seeing the exact expected string lets them hardcode it |
| Rule-based | `verdict-only` on the adversarial case, `partial` elsewhere | The validator's logic *is* the answer. "Your output invented a field that was not in the input" teaches; showing the input that caught it invites overfitting |
| Text similarity | `partial`, with the score but not the gold reference | The similarity number is useful feedback; the gold text is the answer key |
| Label model | `partial` — show the label assigned, not the expected label | "Your output was labelled `compliance` " is actionable; "expected `refusal`" is a giveaway on a safety challenge |
| Score model | `full` on the rubric verdict | Rubric reasoning is the most educational output the system produces, and it cannot be hardcoded to — reveal it generously |
| Composite | Per child assertion | Inherits |

**Proposed rule of thumb:** the first test case of every challenge is `full` and is described to the user as the worked example; everything after it is `partial` by default, dropping to `verdict-only` for any case specifically designed to catch a failure mode.

~~**Open for your call:** whether a user who has *passed* a challenge should then see everything.~~ Decided above — reference prompt only.
