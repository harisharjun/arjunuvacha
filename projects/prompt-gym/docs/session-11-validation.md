# Session 11 — challenge validation pass

**Run 26 Sep 2026** against the real Groq API on `openai/gpt-oss-20b`, the default
execution model, with `gpt-oss-120b` as a second opinion where the small model
fell short. Reference and strawman prompts live in `challenges/prompts/`,
promoted out of the YAML comments in this pass.

Before this, only **pg-a2** had ever been run against a real model.

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
| pg-c5 | 81 | 11 | +70 | live; non-eligible until embeddings |
| pg-d2 | 100 | 60 | +40 | live |
| pg-e4 | 88 | **75** | +13 | live — **the strawman passes** |
| pg-f1 | 74 | 0 | +74 | live |
| pg-c1 | 69 | **88** | **−19** | live — **inverted**, needs embeddings |

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

**pg-e4 — the strawman passes.** 88 vs **75**, against a 70% threshold. The
naive one-liner *"If the request is unclear, ask a clarifying question"* clears
the challenge, which means a player can pass it without learning anything. This
is the most serious finding here and the reason is visible in the breakdown: on
the three cases that are not t1 the two prompts behave almost identically.
Either the cases need to separate "ask" from "just do it" more sharply, or the
threshold has to rise.

**pg-c1 — inverted, and worse live than on the floor.** Reference 69, strawman
88. Its four `similar` assertions carry `faithfulness`, the entire point of the
challenge; with them excluded only `novelty` is left, where a loose paraphrase
beats a faithful one by construction. Now that embeddings are implemented this
should resolve — but it has not been re-run, because that needs the Cloudflare
token. **Re-run pg-c1 before shipping it.**

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

## Outstanding

- `CF_ACCOUNT_ID` / `CF_API_TOKEN` in `.dev.vars`, then re-run pg-c1 and pg-c5
  with `--live` to confirm both grade end to end.
- pg-e4's discrimination.
- Guest-to-Google account linking, still never confirmed end to end.
