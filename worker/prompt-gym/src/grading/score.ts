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
