import type { Assertion, AssertionResult, CaseResult, Challenge } from './grading/types';
import { evaluateAssertion } from './grading/assertions';
import { aggregateCase, challengeScore, golfBonus, meanCaseScore } from './grading/score';
import { validators } from './grading/validators';
import { applyReveal, type PublicTestResult } from './grading/reveal';
import { execute, judge, type GatewayConfig } from './providers/groq';
import { toOutcome } from './providers/errors';

const EXEC_CONCURRENCY = 3;

/** Assertions that need a model call. Everything else is free and runs first. */
const MODEL_GRADED = new Set(['llm-rubric', 'classifier', 'g-eval', 'factuality', 'answer-relevance']);
/** Needs Workers AI embeddings, which are not wired up yet. */
const NOT_YET_RUNNABLE = new Set(['similar']);

/** Pinned, and deliberately not the player's choice: if everyone graded with a
 *  different judge, no two scores would be comparable. */
const JUDGE_SCORE_MODEL = 'openai/gpt-oss-120b';
const JUDGE_LABEL_MODEL = 'openai/gpt-oss-20b';

export const EXEC_MODELS = [
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b',
] as const;

const bare = (type: string) => (type.startsWith('not-') ? type.slice(4) : type);

async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

export interface RunOptions {
  challenge: Challenge;
  prompt: string;
  model: string;
  apiKey: string;
  gateway?: GatewayConfig;
  fetchImpl?: typeof fetch;
}

export interface RunResponse {
  submissionId: string;
  challengeId: string;
  score: number;
  baseScore: number;
  efficiencyBonus: number;
  passed: boolean;
  execModel: string;
  promptChars: number;
  promptTokens: number;
  leaderboardEligible: boolean;
  byGrader: { metric: string; score: number; weight: number }[];
  tests: PublicTestResult[];
}

function familyOf(type: string): 'model' | 'pending' | 'cheap' {
  const t = bare(type);
  if (MODEL_GRADED.has(t)) return 'model';
  if (NOT_YET_RUNNABLE.has(t)) return 'pending';
  return 'cheap';
}

/** Turns one model-graded assertion into a result by asking the pinned judge. */
async function gradeWithJudge(
  assertion: Assertion,
  output: string,
  options: RunOptions,
): Promise<AssertionResult> {
  const weight = assertion.weight ?? 1;
  const base = { type: assertion.type, metric: assertion.metric, weight };
  const wantScore = assertion.threshold !== undefined;

  try {
    const verdict = await judge({
      apiKey: options.apiKey,
      gateway: options.gateway,
      fetchImpl: options.fetchImpl,
      model: wantScore ? JUDGE_SCORE_MODEL : JUDGE_LABEL_MODEL,
      output,
      rubric: String(assertion.value ?? ''),
      wantScore,
    });

    const score = 'pass' in verdict ? (verdict.pass ? 1 : 0) : Math.max(0, Math.min(1, verdict.score));
    const threshold = assertion.threshold ?? 1;
    const negated = assertion.type.startsWith('not-');
    const finalScore = negated ? 1 - score : score;
    return { ...base, score: finalScore, passed: finalScore >= threshold };
  } catch (err) {
    // A judge that cannot answer is an errored assertion, never a failing one.
    return {
      ...base,
      score: 0,
      passed: false,
      error: err instanceof Error ? err.message : 'Judge failed',
    };
  }
}

export async function runChallenge(options: RunOptions): Promise<RunResponse> {
  const { challenge, prompt, model } = options;

  // 1. Execute the player's prompt against every hidden test case.
  const executions = await mapWithLimit(challenge.tests, EXEC_CONCURRENCY, async (test) => {
    try {
      const r = await execute({
        apiKey: options.apiKey,
        gateway: options.gateway,
        fetchImpl: options.fetchImpl,
        model,
        prompt,
        input: test.input,
        template: challenge.harness?.template,
        maxOutputTokens: challenge.harness?.maxOutputTokens,
      });
      return { test, outcome: { status: 'ok' as const, ...r } };
    } catch (err) {
      return { test, outcome: toOutcome(err) };
    }
  });

  let promptTokens = 0;
  let anyErrored = false;
  let anyPending = false;

  const cases: CaseResult[] = [];
  const publicTests: PublicTestResult[] = [];

  for (const { test, outcome } of executions) {
    const declared = [...(challenge.defaultAssert ?? []), ...(test.assert ?? [])];

    if (outcome.status === 'errored') {
      anyErrored = true;
      const errored: AssertionResult[] = declared.map((a) => ({
        type: a.type,
        metric: a.metric,
        weight: a.weight ?? 1,
        score: 0,
        passed: false,
        error: outcome.reason,
      }));
      const caseResult: CaseResult = { id: test.id, score: 0, passed: false, assertions: errored };
      cases.push(caseResult);
      publicTests.push(applyReveal(test, caseResult, null, { errored: true }));
      continue;
    }

    promptTokens += outcome.promptTokens;
    const output = outcome.content;

    // 2. Cheap graders first — they cost nothing, and an output that is not even
    //    valid JSON does not need a rubric to explain why it is wrong.
    const cheap = declared.filter((a) => familyOf(a.type) === 'cheap');
    const modelGraded = declared.filter((a) => familyOf(a.type) === 'model');
    const pending = declared.filter((a) => familyOf(a.type) === 'pending');
    if (pending.length > 0) anyPending = true;

    const results = cheap.map((a) => evaluateAssertion(a, output, validators, test.input));
    const cheapAllPassed = results.every((r) => r.passed);

    // 3. The judge runs only if the cheap graders already passed.
    let judgingSkipped = false;
    if (modelGraded.length > 0) {
      if (cheapAllPassed) {
        results.push(...(await Promise.all(modelGraded.map((a) => gradeWithJudge(a, output, options)))));
      } else {
        judgingSkipped = true;
      }
    }

    if (results.some((r) => r.error)) anyErrored = true;

    const { score, passed } = aggregateCase(results, test.threshold);
    const caseResult: CaseResult = { id: test.id, score, passed, assertions: results };
    cases.push(caseResult);
    publicTests.push(applyReveal(test, caseResult, output, { judgingSkipped }));
  }

  const caseScores = cases.map((c) => c.score);
  const mean = meanCaseScore(caseScores);
  const baseScore = challengeScore(caseScores);
  const passed = cases.length > 0 && mean >= challenge.scoring.passThreshold;

  const { parTokens, maxBonus } = challenge.scoring;
  const efficiencyBonus =
    challenge.mode === 'golf' && parTokens !== undefined
      ? golfBonus({
          meanScore: mean,
          passThreshold: challenge.scoring.passThreshold,
          promptTokens: Math.round(promptTokens / Math.max(1, cases.length)),
          parTokens,
          maxBonus: maxBonus ?? 20,
        })
      : 0;

  const totals = new Map<string, { weighted: number; weight: number }>();
  for (const c of cases) {
    for (const a of c.assertions) {
      if (!a.metric) continue;
      const entry = totals.get(a.metric) ?? { weighted: 0, weight: 0 };
      entry.weighted += a.score * a.weight;
      entry.weight += a.weight;
      totals.set(a.metric, entry);
    }
  }

  return {
    submissionId: crypto.randomUUID(),
    challengeId: challenge.id,
    score: Math.min(challenge.scoring.maxScore, baseScore + efficiencyBonus),
    baseScore,
    efficiencyBonus,
    passed,
    execModel: model,
    promptChars: prompt.length,
    promptTokens,
    // A run that errored, or whose graders could not all run, must never be banked.
    leaderboardEligible: !anyErrored && !anyPending,
    byGrader: [...totals.entries()].map(([metric, t]) => ({
      metric,
      score: t.weight > 0 ? t.weighted / t.weight : 0,
      weight: t.weight,
    })),
    tests: publicTests,
  };
}
