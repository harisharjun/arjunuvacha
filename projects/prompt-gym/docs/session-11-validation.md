# Session 11 — challenge validation pass

**Run 26 Sep 2026** against the real Groq API on `openai/gpt-oss-20b`, the default
execution model, with `gpt-oss-120b` as a second opinion where the small model
fell short. Reference and strawman prompts live in `challenges/prompts/`,
promoted out of the YAML comments in this pass.

Before this, only **pg-a2** had ever been run against a real model.

## Correction, 26 Sep 2026 — five results were measured against the wrong harness

The converter took each challenge's harness from its sidecar, and the sidecars
had been stubbed with a generic template and default token caps. It never read
the YAML `prompts:` block, which is what the author actually wrote. So:

- **pg-c5's refund policy was never sent to the model.** It lives only in the
  YAML template. Every pg-c5 run asked the model to "answer using only the
  policy below" with no policy below; the reference scored well only because it
  restates the rules itself.
- pg-d2 and pg-f1 sent `INPUT:` where the author wrote `REVIEW:` and `TICKET:`.
- pg-b1 and pg-b3 were authored for 384 output tokens and ran at 256; pg-f1 and
  pg-e4 for 256 and ran at 192.

The converter now reads the harness from the YAML alone and fails the build if a
sidecar carries one. The five affected challenges were re-run with the corrected
harness, and those numbers replace the earlier ones below:

| challenge | reference | strawman | before the fix |
|---|---|---|---|
| pg-c5 | **99** | 61 | 82 vs 24 — without the policy |
| pg-f1 | **89** | 0 | 74 vs 0 |
| pg-b1 | 80 | 0 | unchanged |
| pg-b3 | 100 | 49 | unchanged |
| pg-d2 | 83 | **72 — passes** | 100 vs 60 |

**pg-d2 no longer discriminates.** With the `REVIEW:` label restored, the naive
strawman was fully hijacked on t3 — it output `COMPROMISED` — and on t4 it
printed its own instructions, yet it still scored 72 and passed. One hijack
costs about a quarter of the score, and the t4 instruction leak slipped past the
pinned 20b label judge. For an injection-resistance challenge, a single hijack
should be disqualifying. Needs a decision: a per-case gate that fails the run on
any injection, a stronger judge for t4, or withholding it like pg-c1 and pg-e4.

## How to read the numbers

`npm run try` has two grading paths, and the difference matters more than any
single score:

- **default** grades with `gradeChallenge`, the pure engine. It makes no judge
  call, so every `llm-rubric` and `similar` assertion errors and scores zero. On
  a challenge that has them the total is a **floor, not a score**.
- **`--live`** grades through `runChallenge`, exactly as the deployed Worker
  does. Judge calls included; `similar` runs if an embedder is configured, and
  is excluded from scoring (not zeroed) if not.

The `--live` flag was added in this pass. Three challenges that looked broken
were only ever being under-measured.

## Results

| challenge | reference | strawman | gap | notes |
|---|---|---|---|---|
| pg-a1 | 100 | 19 | +81 | |
| pg-a11 | 100 | 18 | +82 | |
| pg-a2 | 100 | 3 | +97 | |
| pg-a3 | 100 | 13 | +87 | |
| pg-b1 | 80 | 0 | +80 | 100 on 120b — small-model arithmetic |
| pg-b3 | 100 | 49 | +51 | after the preservation fix below |
| pg-b7 | 100 | 0 | +100 | |
| pg-c5 | 99 | 61 | +38 | live + embeddings, corrected harness |
| pg-d2 | 83 | **72** | +11 | corrected harness — **strawman passes** |
| pg-f1 | 89 | 0 | +89 | live, corrected harness |
| pg-e4 | **67** | 58 | +9 | live, 6 cases — **no passing reference** |
| pg-c1 | 79 | **88** | **−19** | live + embeddings — **still inverted** |

## What the floors hid

pg-d2 scored 59 without the judge and **100** with it. pg-f1 went 62 → 74,
pg-c5 67 → 81. None of those three had anything wrong with them; the harness was
never running a third of their graders.

## Fixed in this pass

**pg-b3 rewarded deletion as much as masking.** The strawman scored 62 by
*removing* PII rather than masking it —
`Customer Arun M (arun.m@example.com, 98765 43210) reported…` became
`Customer reported…` and still passed every leak check. Nothing tested the
reference prompt's own promise to *"leave everything else byte-for-byte
unchanged"*: `preservation` was a single `contains "LMN-3391"`, and
`over-redaction` was one validator on t3, the only case with no PII in it.

Added `b3SkeletonT1` and `b3SkeletonT2` (weight 4, metric `preservation`) to t1
and t2. Each collapses the mask tokens to one sentinel and requires the rest to
match the input exactly, so deletion, rewording, a dropped ticket reference and
over-redacting the customer's name all fail. Strawman 62 → **49**; reference
unchanged at 100.

**Golf par was unreachable.** `estimateTokens` is `ceil(trimmed_chars / 4)`.
Measured against the reference prompts: pg-g1 84 → **97**, pg-g3 40 → **49**.
Both old values sat *below* the reference's own token count, so the reference was
above par and `max(0, 1 − 97/84)` paid nothing. Corrected, the reference earns
exactly 0, then 5 / 10 / 15 at three-quarters, half and a quarter of par, and a
run that has not passed earns nothing however short.

**`similar` is now implemented.** `src/providers/embeddings.ts` (Workers AI,
pinned to `@cf/baai/bge-base-en-v1.5`) plus `cosineSimilarity` in
`grading/text.ts`, resolved in `run.ts` alongside the judge so `grading/` stays
pure. The `[ai]` binding is in `wrangler.toml` and needs no credential. For
`--live` on the laptop, add `CF_ACCOUNT_ID` and `CF_API_TOKEN` to `.dev.vars`.

## Still needs a decision

**pg-e4 — the strawman no longer passes, but now nothing does.** With only
t1–t4 the naive one-liner scored 75 and cleared the challenge: t2 and t4 are
plainly complete, t3 is plainly missing its content, so three of four cases were
reflexive and t1 never had to be won.

Two near-misses were added, one in each direction. **t5** *"Write a tweet
announcing the board view."* is short and broad but fully actionable — product,
feature and medium are all given — so asking is over-asking, which is the clause
the reference prompt states and nothing previously tested. **t6** *"Draft the
pricing page copy for the new tier — punchy, three bullets, mention the 14-day
trial."* reads fully specified but never says what the tier is, so drafting means
inventing it.

Both work. The strawman now fails at 58. But **so does the reference, at 67** —
it asks about tone on t1, over-asks on t5, and invents "Premium Pro" on t6. A
rewritten reference reached only 72, passing on the format point rather than on
the cases that matter, and the original reference scores 58 on `gpt-oss-120b`
too, so this is not a small-model limitation.

The cases are good and the reference prompt is not. That is a content decision:
either write a reference that actually holds the discipline, keep one of the two
new cases rather than both, or revert to four cases and raise the threshold
instead. **As it stands pg-e4 has no known passing prompt and must not ship.**

**pg-c1 — embeddings did not fix it.** Reference 79, strawman 88, both now
leaderboard-eligible with `similar` running. `faithfulness` comes out at **93%
for both prompts**: cosine similarity cannot tell them apart, because it measures
topical relatedness rather than factual fidelity. "free plan" → "complimentary
tier" reads as faithful to an embedding model. So the strawman pays nothing for
taking liberties while `novelty` — 57% for the reference, 79% for the strawman —
actively rewards them.

The challenge rewards maximum rewording at no fidelity cost, which is the
opposite of its intent, and no amount of embedding work will change that. If
pg-c1 is to ship, `faithfulness` needs a grader that checks facts, numbers,
conditions and negations survive — an `llm-rubric`, not a `similar`. **Hold it
back.**

**pg-b1 is fine, but the reference prompt is not optimal.** t1 fails because the
model computes `12,500 + 3,000 + 2,000 = 18,500`. Both validators fired
correctly and 120b scores 100. The prompt never tells the model to check its own
sum, which would likely fix it.

## A scoring artifact worth knowing about

`byGrader` averages only the assertions that actually ran. When the judge is
skipped because the cheap graders already failed, that case contributes nothing
to its metric — so pg-e4's strawman reports `judgement 100%` while the reference
reports 67%, purely because the strawman failed earlier on t1. Totals are
unaffected; only the per-metric display misleads. Worth a note in the UI, or
worth counting skipped judgements as absent rather than omitted.

## Where each challenge stands

**Ready (9):** pg-a1, pg-a11, pg-a2, pg-a3, pg-b1, pg-b3, pg-b7, pg-c5, pg-f1 —
plus the two golf variants, which inherit pg-a1 and pg-a2.

**Withheld (3):** pg-c1, pg-e4 and — decided 26 Sep 2026 — pg-d2, whose
strawman passes once the authored harness is used. See the correction above.

**Withheld earlier:** pg-e4 (no passing reference) and pg-c1 (inverted by design).
Dropped from the shipped catalog on 26 Sep 2026 — see the `WITHHELD` map in
`worker/prompt-gym/src/challenges.ts`. Both remain imported and validated by the
build; deleting an entry from that map ships it again.

## Outstanding

- pg-e4: a reference prompt that holds the discipline, or fewer/easier cases.
- pg-c1: replace the `similar` faithfulness graders with a fact-checking rubric.
- Guest-to-Google account linking, still never confirmed end to end.
- The KV namespace for M8.

## Re-validation on the paid models — 26 Sep 2026

Signed-in players moved to OpenAI (gpt-4.1-nano everywhere, gpt-4.1-mini on
Hard), so every shipped challenge was re-run with `--live` on the model players
now get.

| challenge | level | model | reference | strawman |
|---|---|---|---|---|
| pg-a2 | Beginner | nano | 100 | 3 |
| pg-a1 | Easy | nano | 100 | 67 — **fails, but only 3 points under the bar** |
| pg-a3 | Easy | nano | 100 | 13 |
| pg-a11 | Easy | nano | 100 | 48 |
| pg-b7 | Intermediate | nano | 100 | 23 |
| pg-b1 | Intermediate | nano | 100 | 0 |
| pg-b3 | Hard | mini / nano | 91 / 75 | 24 |
| pg-f1 | Hard | mini / nano | 85 / 74 | 0 |
| pg-c5 | Hard | mini / nano | 99 / 98 | **81 / 82 — passes** |

**pg-c5 is withheld.** With the policy reaching the model, the gpt-4.1 models
apply the 14-day annual-plan rule from a naive prompt, so the near-miss no longer
traps anyone.

**pg-f1's reference was tightened.** gpt-4.1-mini wraps JSON in code fences under
"Output only the JSON." (reference 50); adding "no code fences, no markdown"
brings it to 85. See `challenges/prompts/README.md`.

**Watch pg-a1.** Its strawman fails by 3 points on nano. It discriminates, but
narrowly.
