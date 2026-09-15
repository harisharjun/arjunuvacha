import type {
  CaseResult,
  Challenge,
  ChallengeResult,
  MetricBreakdown,
  ValidatorRegistry,
} from './types';
import { evaluateAssertion } from './assertions';
import { aggregateCase, challengeScore, meanCaseScore } from './score';

function breakdownByMetric(cases: CaseResult[]): MetricBreakdown[] {
  const totals = new Map<string, { weighted: number; weight: number }>();

  for (const testCase of cases) {
    for (const assertion of testCase.assertions) {
      if (!assertion.metric) continue;
      const entry = totals.get(assertion.metric) ?? { weighted: 0, weight: 0 };
      entry.weighted += assertion.score * assertion.weight;
      entry.weight += assertion.weight;
      totals.set(assertion.metric, entry);
    }
  }

  return [...totals.entries()].map(([metric, { weighted, weight }]) => ({
    metric,
    score: weight > 0 ? weighted / weight : 0,
    weight,
  }));
}

/** Grades one challenge against the model outputs for its test cases.
 *
 *  Pure: no network, no I/O, no global state. `outputs` maps test-case id to the
 *  raw model output; a missing entry is graded as empty rather than skipped, so a
 *  case can never silently vanish from the denominator. */
export function gradeChallenge(
  challenge: Challenge,
  outputs: Record<string, string>,
  registry: ValidatorRegistry,
): ChallengeResult {
  const cases: CaseResult[] = challenge.tests.map((testCase) => {
    const output = outputs[testCase.id] ?? '';
    const assertions = [...(challenge.defaultAssert ?? []), ...(testCase.assert ?? [])].map(
      (assertion) => evaluateAssertion(assertion, output, registry),
    );
    const { score, passed } = aggregateCase(assertions, testCase.threshold);
    return { id: testCase.id, score, passed, assertions };
  });

  const caseScores = cases.map((c) => c.score);

  return {
    score: challengeScore(caseScores),
    passed: cases.length > 0 && meanCaseScore(caseScores) >= challenge.scoring.passThreshold,
    cases,
    byMetric: breakdownByMetric(cases),
  };
}
