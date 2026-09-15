import { describe, it, expect } from 'vitest';
import { applyReveal, publicChallenge } from '../src/grading/reveal';
import type { CaseResult, Challenge, TestCase } from '../src/grading/types';

const SECRET_INPUT = 'Courier it to Meera S, 22 Residency Road, Pune 411001';
const SECRET_EXPECTED = 'THE-EXACT-ANSWER-411001';

const testCase = (reveal: TestCase['reveal']): TestCase => ({
  id: 't4',
  input: SECRET_INPUT,
  reveal,
  hint: 'One hidden input is missing a field. Your prompt filled it in with a guess.',
  assert: [
    { type: 'contains', value: SECRET_EXPECTED, weight: 3, metric: 'accuracy' },
    { type: 'javascript', ref: 'validators.stateMustBeEmpty', weight: 4, metric: 'hallucination' },
  ],
});

const failedCase: CaseResult = {
  id: 't4',
  score: 0,
  passed: false,
  assertions: [
    { type: 'contains', metric: 'accuracy', weight: 3, score: 0, passed: false },
    { type: 'javascript', metric: 'hallucination', weight: 4, score: 0, passed: false },
  ],
};

const MODEL_OUTPUT = '{"state":"Maharashtra"}';

describe('verdict-only', () => {
  const r = applyReveal(testCase('verdict-only'), failedCase, MODEL_OUTPUT);

  it('returns null input and null output in the response body itself', () => {
    expect(r.input).toBeNull();
    expect(r.output).toBeNull();
  });

  it('leaks neither the input nor the expected value anywhere in the payload', () => {
    const serialised = JSON.stringify(r);
    expect(serialised).not.toContain(SECRET_INPUT);
    expect(serialised).not.toContain(SECRET_EXPECTED);
    expect(serialised).not.toContain('411001');
    expect(serialised).not.toContain('Meera');
  });

  it('still says which metric broke, so the player learns something', () => {
    expect(r.failures.map((f) => f.metric).sort()).toEqual(['accuracy', 'hallucination']);
  });

  it('uses the author-written hint as the reason', () => {
    expect(r.failures[0].reason).toContain('filled it in with a guess');
  });

  it('never carries an expected value', () => {
    expect(r.failures.every((f) => f.expected === undefined)).toBe(true);
  });
});

describe('partial', () => {
  const r = applyReveal(testCase('partial'), failedCase, MODEL_OUTPUT);

  it('shows the input and the output', () => {
    expect(r.input).toBe(SECRET_INPUT);
    expect(r.output).toBe(MODEL_OUTPUT);
  });

  // The whole point of `partial`: enough to debug, not enough to hardcode to.
  it('never reveals the expected value', () => {
    expect(JSON.stringify(r)).not.toContain(SECRET_EXPECTED);
    expect(r.failures.every((f) => f.expected === undefined)).toBe(true);
  });

  it('gives a generic reason per failing grader', () => {
    expect(r.failures).toHaveLength(2);
    expect(r.failures[0].reason.length).toBeGreaterThan(10);
  });

  // Seen in a real run: pg-a2 failed word-count and regex, both metric `format`,
  // and the player was told "the output did not hold the required format" twice.
  it('collapses two checks that produce the same generic sentence', () => {
    const twoFormatChecks: CaseResult = {
      id: 't1',
      score: 0,
      passed: false,
      assertions: [
        { type: 'word-count', metric: 'format', weight: 2, score: 0, passed: false },
        { type: 'regex', metric: 'format', weight: 2, score: 0, passed: false },
        { type: 'equals', metric: 'accuracy', weight: 4, score: 0, passed: false },
      ],
    };
    const out = applyReveal(testCase('partial'), twoFormatChecks, 'bad output');
    expect(out.failures).toHaveLength(2);
    expect(out.failures.map((f) => f.metric)).toEqual(['format', 'accuracy']);
  });

  it('never exposes validator names, which describe the check', () => {
    expect(JSON.stringify(r)).not.toContain('validators.');
    expect(JSON.stringify(r)).not.toContain('stateMustBeEmpty');
  });
});

describe('full', () => {
  const r = applyReveal(testCase('full'), failedCase, MODEL_OUTPUT);

  it('shows input, output and the expected value', () => {
    expect(r.input).toBe(SECRET_INPUT);
    expect(r.output).toBe(MODEL_OUTPUT);
    expect(r.failures[0].expected).toBe(SECRET_EXPECTED);
  });

  it('omits expected for an assertion that declares no value', () => {
    expect(r.failures[1].expected).toBeUndefined();
  });
});

describe('status and gating', () => {
  it('reports passed when the case passed', () => {
    const passedCase: CaseResult = { ...failedCase, passed: true, score: 1, assertions: [] };
    expect(applyReveal(testCase('partial'), passedCase, 'ok').status).toBe('passed');
  });

  it('distinguishes errored from failed', () => {
    const r = applyReveal(testCase('partial'), failedCase, null, { errored: true });
    expect(r.status).toBe('errored');
  });

  it('says when judging was skipped, so a zero is not mistaken for a rubric verdict', () => {
    const r = applyReveal(testCase('partial'), failedCase, 'x', { judgingSkipped: true });
    expect(r.judgingSkipped).toBe(true);
    expect(applyReveal(testCase('partial'), failedCase, 'x').judgingSkipped).toBeUndefined();
  });
});

describe('publicChallenge', () => {
  const challenge = {
    id: 'pg-x',
    title: 'Test',
    mode: 'goal',
    scoring: { maxScore: 100, passThreshold: 0.7 },
    public: { goal: 'do the thing', startingPrompt: null },
    defaultAssert: [{ type: 'contains', value: 'SECRET-DEFAULT' }],
    tests: [
      { id: 't1', input: SECRET_INPUT, reveal: 'partial', assert: [{ type: 'equals', value: SECRET_EXPECTED }] },
    ],
  } as unknown as Challenge;

  const pub = publicChallenge(challenge);

  it('carries the public copy', () => {
    expect(pub.id).toBe('pg-x');
    expect((pub as { goal?: string }).goal).toBe('do the thing');
    expect(pub.testCaseCount).toBe(1);
  });

  // The challenge list is fetched before a player writes anything. If it carried
  // the test cases, every challenge would be solvable before the first run.
  it('carries no test inputs, assertions or expected values', () => {
    const serialised = JSON.stringify(pub);
    expect(serialised).not.toContain(SECRET_INPUT);
    expect(serialised).not.toContain(SECRET_EXPECTED);
    expect(serialised).not.toContain('SECRET-DEFAULT');
    expect(serialised).not.toContain('assert');
    expect(serialised).not.toContain('"tests"');
  });
});
