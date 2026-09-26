# Reference and strawman prompts

Extracted from the trailing comments of `../*.promptfoo.yaml` during Session 11
(26 Sep 2026), so that the challenge-validation pass has something it can
actually execute and re-run. Previously these lived only as comments, which
meant nothing could check them and the golf par values rested on them.

Each challenge has two:

- `<id>.reference.txt` — the prompt that should score high (>= ~0.9). It is also
  what the golf par values are measured from.
- `<id>.strawman.txt` — the naive attempt that should score low (<= ~0.4). If the
  two scores land close together, the graders are not discriminating and the
  challenge is not ready.

Run one with:

    cd worker/prompt-gym
    npm run try -- <id> --prompt-file ../../projects/prompt-gym/challenges/prompts/<id>.reference.txt

## Provenance

Ten of the twelve references and all eight of the original strawmen are Arjun's,
copied verbatim from the YAML comments.

**Four strawmen were written in this pass and need review** — pg-a11, pg-b1,
pg-b7 and pg-c1 had a reference but no strawman in the YAML. They are deliberate
one-line naive attempts in the same spirit as the other eight, but they are not
Arjun's words and nobody has agreed they are the *right* baseline.

These files are not read by the Worker or the converter. They are validation
material only.

**pg-f1's reference was tightened on 26 Sep 2026** when signed-in players moved to
gpt-4.1-mini. Its last sentence now reads "Output only the raw JSON object — no
code fences, no markdown, no prose before or after it." instead of "Output only
the JSON." gpt-4.1-mini wraps its answer in a ```json fence on two cases under the
original wording, which fails the structure checks: reference 50 before, 85 after.
The original in the YAML comment is unchanged.
