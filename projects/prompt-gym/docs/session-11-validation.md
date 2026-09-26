# Session 11 — challenge validation pass

**Run 26 Sep 2026** against the real Groq API, on `openai/gpt-oss-20b` (the
default execution model) with `openai/gpt-oss-120b` as a second opinion on the
six that did not score full marks. Reference and strawman prompts come from
`challenges/prompts/`, promoted out of the YAML comments in this same pass.

Before this, only **pg-a2** had ever been run against a real model. All twelve
now have been.

## Results

| challenge | ref (20b) | strawman | gap | ref (120b) | unmeasured | verdict |
|---|---|---|---|---|---|---|
| pg-a1 | 100 | 19 | +81 | — | — | good |
| pg-a11 | 100 | 18 | +82 | — | — | good |
| pg-a2 | 100 | 3 | +97 | — | — | good |
| pg-a3 | 100 | 13 | +87 | — | — | good |
| pg-b1 | 80 | 0 | +80 | 100 | — | good |
| pg-b3 | 100 | 62 | +38 | — | — | **weak strawman** |
| pg-b7 | 100 | 0 | +100 | — | — | good |
| pg-c1 | 42 | 52 | -10 | 52 | 40% | **blocked** — inverted |
| pg-c5 | 67 | 9 | +58 | 82 | 18% | partial |
| pg-d2 | 59 | 41 | +18 | 59 | 40% | partial |
| pg-e4 | 65 | 52 | +13 | 52 | 34% | partial |
| pg-f1 | 62 | 0 | +62 | 71 | 16% | partial |

"Unmeasured" is the fraction of each challenge's assertion weight that `npm run
try` cannot score. The harness calls `gradeChallenge`, the pure engine — it never
makes judge calls, so every `llm-rubric` and `similar` assertion comes back
`ERRORED (Unknown assertion type)` and scores zero. Those totals are therefore
floors, not scores, and the five marked *partial* have to be judged on their
per-metric breakdown instead.

## The seven that are ready

pg-a1, pg-a11, pg-a2, pg-a3, pg-b1, pg-b7 all separate cleanly — reference at or
near 100, strawman between 0 and 19. Their graders discriminate and nothing is
unmeasured.

**pg-b1 is model-sensitive.** The reference scores 80 on 20b and 100 on 120b;
t1 fails `b1Arithmetic` and `b1CleanThreeLine` on the small model only. It still
clears the 70% threshold on the default, so it ships, but it is the one challenge
where the default model is visibly working harder.

## Needs a decision

**pg-c1 — blocked, and currently inverted.** Reference 42, strawman 52. The four
`similar` assertions carry the `faithfulness` metric, which is 40% of the weight
and entirely unmeasured; what remains is `novelty`, where a loose paraphrase
beats a faithful one by construction (57% vs 79%). This is not evidence the
challenge is broken — it is evidence it cannot be validated at all until Workers
AI embeddings are wired up. **Do not ship pg-c1 until then**, or ship it flagged
non-leaderboard as it already is.

**pg-b3 — the strawman is too generous.** Reference 100, strawman 62 against a
≤40 target. The strawman still fails (threshold 70%), so the challenge works, but
"Remove any personal information from this text" scores 100% on both
`preservation` and `over-redaction` without trying. Only the exact
`[PHONE]`/`[EMAIL]`/`[ID]` token format and one leak on t4 separate them. Either
accept the narrower gap or make t1/t2 depend less on the literal token strings.

**pg-e4 — the big model does worse.** 65 on 20b, 52 on 120b. On 120b t1 fails
`discipline`: it asks a clarifying question where the reference prompt says to
just do the work. Worth a look, though the default model handles it.

**pg-f1 — `triage` only reaches 50% even for the reference.** Schema and format
are perfect and the strawman scores 0, so it discriminates, but half the triage
signal is being missed on the default model.

## The four strawmen I wrote

pg-a11, pg-b1, pg-b7 and pg-c1 had a reference in the YAML but no strawman. The
ones in `challenges/prompts/*.strawman.txt` for those four are mine, not Arjun's,
and nobody has agreed they are the right baseline. Three of them produce clean
separation (18, 0, 0). The pg-c1 one is the inverted case discussed above.

## Golf par, re-derived

`estimateTokens` is `ceil(trimmed_chars / 4)`. Measured against the reference
prompts:

| variant | parent | was | now | reference |
|---|---|---|---|---|
| pg-g1 | pg-a1 | 84 | **97** | 388 chars |
| pg-g3 | pg-a2 | 40 | **49** | 193 chars |

Both old values were *below* the reference's own token count, which put the
reference above par and made the bonus unreachable — `max(0, 1 - 97/84)` is 0.
With the corrected values the reference earns exactly 0 (par is the bar, not a
reward), 5 at three-quarters of par, 10 at half, 15 at a quarter, and a run that
has not passed earns nothing however short.

Changed in `challenges/pg-golf-variants.json` and regenerated; never hand-edited
in `generated/`.

## Still outstanding

- Workers AI embeddings, without which pg-c1 and pg-c5 cannot be fully graded.
- The judge path (`llm-rubric`) is implemented in `runChallenge` but `npm run
  try` does not exercise it. A `--live` flag on the try script that routes
  through `runChallenge` would make the remaining 34% of pg-d2 and pg-e4
  measurable.
- Guest-to-Google account linking, still never confirmed end to end.
