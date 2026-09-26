# PromptGym — first-fold copy

Written 26 Sep 2026 against the brief: LinkedIn visitors who believe they are
good at prompting and have never been measured. Headlines at most 8 words,
subheadlines at most 25. No em dashes, no exclamation marks, no "practise",
"practice" or "learn" in a headline, and nothing the product does not do.

**One deliberate omission.** The brief's example "write a prompt that survives
an injection attempt" is pg-d2, which is withheld (`src/challenges.ts`,
`WITHHELD`). None of these pairs mention injection. Put it back only once pg-d2
ships.

## The eight pairs

| # | Angle | Headline | Subheadline |
|---|---|---|---|
| 1 | Curiosity gap | Your prompt works. On the inputs you tried. | PromptGym runs it on the ones you didn't. Two minutes, no signup to start, and a score that shows which cases broke. |
| 2 | Ego | You think you write good prompts. Prove it. | Write one prompt. We run it against hidden test cases and score every answer. Two minutes, and no signup to try one. |
| 3 | Specific claim | One address. Strict JSON. Four hidden tests. | Write a prompt that pulls an address out of messy text. We run it on four inputs you haven't seen, then grade each answer. |
| 4 | Dare | Bet your prompt fails at least one test. | Pick a task, write the prompt, hit run. Hidden inputs, graded answers, and a scorecard that shows exactly where it broke. |
| 5 | Ego | Everyone thinks their prompts are good. Test yours. | Short tasks, hidden test cases, a real score. See where your prompt holds up and where it quietly falls apart. |
| 6 | Curiosity gap | How does your prompt do on case four? | Every challenge hides its test cases. Your prompt runs on all of them, and you see which ones it missed and why. |
| 7 | Ego | There is a leaderboard. Where do you land? | Short, real tasks, each scored against hidden tests. Sign in with Google to get ranked. Two minutes a challenge. |
| 8 | Specific claim | A score for your prompt, not a vibe. | Exact checks where there is one right answer, an AI judge where there isn't. Every hidden case scored, every failure explained. |

Claims checked against the code: #3's "four" is pg-a1's four cases; #7's
"sign in to get ranked" is `ranking.ts` (guests are not ranked); "no signup" in
#1 and #2 is true of the three `FREE_TO_PLAY` challenges, which is where the
button sends a guest; "which cases broke, and why" is the `partial` reveal,
which returns each case's status and failure reasons.

## The pick: #1

**Your prompt works. On the inputs you tried.**
PromptGym runs it on the ones you didn't. Two minutes, no signup to start, and
a score that shows which cases broke.

It agrees with the reader before it corrects them: the first sentence grants the
belief they arrived with, so nobody bounces defensively in the first second, and
the second sentence turns it into the exact doubt the product resolves. The
dares and ego challenges (#2, #4, #5) ask for a fight before they have earned
attention, and the specific claims (#3, #8) describe the mechanic to someone who
has not yet decided to care.

## Buttons

1. **Find out where yours breaks** ← shipped
2. Try one, two minutes
3. Test a prompt now

#1 carries the headline's tension into the click. #2 sells the small
commitment. #3 is the plainest.
