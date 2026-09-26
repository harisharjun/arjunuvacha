/** Which models a player may run, and which provider serves each.
 *
 *  Two tiers, decided by Arjun on 26 Sep 2026:
 *
 *  - Guests run on Groq's free tier — the gpt-oss and Qwen models — within a
 *    small hourly allowance. It costs nothing, and it is shared.
 *  - Signed-in players run on OpenAI's paid API: gpt-4.1-nano on every challenge,
 *    and gpt-4.1-mini as well on Hard and Expert ones. Nano keeps the common case
 *    nearly free; mini is there where the extra capability matters.
 *
 *  Both OpenAI models accept temperature 0, which this app depends on: the result
 *  cache replays identical prompts, and a leaderboard needs a prompt to score the
 *  same twice. The GPT-5 family was ruled out for exactly that — it only accepts
 *  the default temperature. */

export type Provider = 'groq' | 'openai';

/** Groq model ids, as Groq names them. The first is the default. */
export const GROQ_MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b'] as const;

export const OPENAI_NANO = 'gpt-4.1-nano';
export const OPENAI_MINI = 'gpt-4.1-mini';

/** Difficulty at or above which gpt-4.1-mini is offered. 4 = Hard. */
export const MINI_FROM_DIFFICULTY = 4;

/** The judge for model-graded assertions, pinned so every score is comparable.
 *  Only challenges behind the sign-in wall have judged assertions, so this is
 *  always a signed-in run's judge. */
export const OPENAI_JUDGE = OPENAI_MINI;

export function providerFor(model: string): Provider {
  return model === OPENAI_NANO || model === OPENAI_MINI ? 'openai' : 'groq';
}

/** The models a player may choose on a challenge, best default first.
 *
 *  With no OpenAI key configured, signed-in players fall back to the Groq models
 *  rather than being unable to play at all — a missing secret should degrade the
 *  site, not break it. */
export function modelsFor(
  difficulty: number,
  tier: 'guest' | 'signed-in',
  paidEnabled: boolean,
): string[] {
  if (tier === 'guest' || !paidEnabled) return [...GROQ_MODELS];
  return difficulty >= MINI_FROM_DIFFICULTY ? [OPENAI_MINI, OPENAI_NANO] : [OPENAI_NANO];
}
