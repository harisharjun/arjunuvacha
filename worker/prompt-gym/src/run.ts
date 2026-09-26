import type { Assertion, AssertionResult, CaseResult, Challenge } from './grading/types';
import { evaluateAssertion } from './grading/assertions';
import {
  aggregateCase,
  challengeScore,
  estimateTokens,
  golfBonus,
  meanCaseScore,
} from './grading/score';
import { validators } from './grading/validators';
import { applyReveal, type PublicTestResult } from './grading/reveal';
import { execute, judge, type GatewayConfig } from './providers/groq';
import { cosineSimilarity } from './grading/text';
import type { Embedder } from './providers/embeddings';
import { toOutcome } from './providers/errors';

const EXEC_CONCURRENCY = 3;

/** Assertions that need a model call. Everything else is free and runs first. */
const MODEL_GRADED = new Set(['llm-rubric', 'classifier', 'g-eval', 'factuality', 'answer-relevance']);
/** Needs Workers AI embeddings. Runnable only when an `Embedder` is supplied —
 *  without one these stay `pending`, which keeps the run off the leaderboard
 *  rather than scoring the player zero for a grader we could not run. */
const NEEDS_EMBEDDINGS = new Set(['similar']);

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
  /** Supplied by the Worker from its `AI` binding, or by the try script from the
   *  REST API. Absent means `similar` assertions cannot run. */
  embedder?: Embedder;
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
  /** True when the provider turned at least one call away with its own 429.
   *
   *  Distinct from every other kind of `errored`, because it is the one the player
   *  can do something about: their own key clears it. Optional because results
   *  cached in D1 before this field existed are replayed as-is. */
  rateLimited?: boolean;
  byGrader: { metric: string; score: number; weight: number }[];
  tests: PublicTestResult[];
}

function familyOf(type: string, hasEmbedder: boolean): 'model' | 'similarity' | 'pending' | 'cheap' {
  const t = bare(type);
  if (MODEL_GRADED.has(t)) return 'model';
  if (NEEDS_EMBEDDINGS.has(t)) return hasEmbedder ? 'similarity' : 'pending';
  return 'cheap';
}

/** Grades every `similar` assertion in one test case with a single embeddings
 *  call: the output once, then each expected string. Batched because each call
 *  is a round trip and the vectors are all needed together anyway. */
async function gradeSimilarity(
  assertions: Assertion[],
  output: string,
  embed: Embedder,
): Promise<AssertionResult[]> {
  const base = assertions.map((a) => ({
    type: a.type,
    metric: a.metric,
    weight: a.weight ?? 1,
  }));

  try {
    const vectors = await embed([output, ...assertions.map((a) => String(a.value ?? ''))]);
    const [outputVector, ...expectedVectors] = vectors;

    return assertions.map((a, i) => {
      const similarity = cosineSimilarity(outputVector, expectedVectors[i]);
      const negated = a.type.startsWith('not-');
      const score = negated ? 1 - similarity : similarity;
      // 0.75 matches the default documented on `Assertion.threshold`.
      const threshold = a.threshold ?? 0.75;
      return { ...base[i], score, passed: score >= threshold };
    });
  } catch (err) {
    // Embeddings unavailable is our failure, not the player's: errored, never failed.
    const reason = err instanceof Error ? err.message : 'Embeddings failed';
    return base.map((b) => ({ ...b, score: 0, passed: false, error: reason }));
  }
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
  let anyRateLimited = false;

  const cases: CaseResult[] = [];
  const publicTests: PublicTestResult[] = [];

  for (const { test, outcome } of executions) {
    const declared = [...(challenge.defaultAssert ?? []), ...(test.assert ?? [])];

    if (outcome.status === 'errored') {
      anyErrored = true;
      if (outcome.kind === 'rate-limited') anyRateLimited = true;
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
    const hasEmbedder = Boolean(options.embedder);
    const cheap = declared.filter((a) => familyOf(a.type, hasEmbedder) === 'cheap');
    const modelGraded = declared.filter((a) => familyOf(a.type, hasEmbedder) === 'model');
    const similarity = declared.filter((a) => familyOf(a.type, hasEmbedder) === 'similarity');
    const pending = declared.filter((a) => familyOf(a.type, hasEmbedder) === 'pending');
    if (pending.length > 0) anyPending = true;

    const results = cheap.map((a) => evaluateAssertion(a, output, validators, test.input));

    // Similarity sits between cheap and judged: it costs a call, but a much
    // smaller one than the judge, and it is not gated behind the cheap graders
    // because a paraphrase that fails a format check can still be faithful.
    if (similarity.length > 0 && options.embedder) {
      results.push(...(await gradeSimilarity(similarity, output, options.embedder)));
    }

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
          // The player's own prompt, not the whole request: `promptTokens` below
          // includes the harness and the test input, which they did not write.
          promptTokens: estimateTokens(prompt),
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
    rateLimited: anyRateLimited,
    byGrader: [...totals.entries()].map(([metric, t]) => ({
      metric,
      score: t.weight > 0 ? t.weighted / t.weight : 0,
      weight: t.weight,
    })),
    tests: publicTests,
  };
}
