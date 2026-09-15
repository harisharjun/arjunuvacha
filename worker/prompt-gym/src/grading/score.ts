import type { AssertionResult } from './types';

/** Weighted mean of a test case's assertion scores.
 *
 *  `threshold` is the minimum score for the case to count as passed. Without one,
 *  a case passes only if every assertion passed — which is stricter than the score
 *  alone, since a heavily-weighted pass can otherwise mask a light failure. */
export function aggregateCase(
  results: AssertionResult[],
  threshold?: number,
): { score: number; passed: boolean } {
  let weightedTotal = 0;
  let weightTotal = 0;

  for (const result of results) {
    if (result.weight < 0) {
      throw new Error(`Assertion weight must not be negative (got ${result.weight})`);
    }
    weightedTotal += result.score * result.weight;
    weightTotal += result.weight;
  }

  // No assertions, or every weight zero: there is nothing to have passed. Returning
  // 0 here is what keeps a malformed challenge from producing NaN and poisoning
  // every downstream mean.
  if (weightTotal <= 0) return { score: 0, passed: false };

  const score = weightedTotal / weightTotal;
  const passed = threshold === undefined ? results.every((r) => r.passed) : score >= threshold;

  return { score, passed };
}

/** Each test case counts equally, regardless of how many assertions it carried. */
export function challengeScore(caseScores: number[]): number {
  if (caseScores.length === 0) return 0;
  const mean = caseScores.reduce((sum, s) => sum + s, 0) / caseScores.length;
  return Math.round(100 * mean);
}

export function meanCaseScore(caseScores: number[]): number {
  if (caseScores.length === 0) return 0;
  return caseScores.reduce((sum, s) => sum + s, 0) / caseScores.length;
}

/** Golf mode's efficiency bonus: `maxBonus × (1 − promptTokens / parTokens)`.
 *
 *  Correctness first, brevity second — never the reverse. A run that has not
 *  cleared the challenge's pass threshold earns nothing at all, however short the
 *  prompt, so the bonus can never rescue a prompt that does not work. Par earns
 *  zero: it is the bar to beat, not a reward. */
export function golfBonus(opts: {
  meanScore: number;
  passThreshold: number;
  promptTokens: number;
  parTokens: number;
  maxBonus: number;
}): number {
  const { meanScore, passThreshold, promptTokens, parTokens, maxBonus } = opts;

  if (meanScore < passThreshold) return 0;
  // A challenge with no par cannot express brevity; pay nothing rather than divide
  // by zero and hand out an infinite bonus.
  if (!(parTokens > 0)) return 0;

  const saved = Math.max(0, 1 - Math.max(0, promptTokens) / parTokens);
  return Math.round(maxBonus * saved);
}
