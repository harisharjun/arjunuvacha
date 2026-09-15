import { describe, it, expect } from 'vitest';
import { aggregateCase, challengeScore } from '../src/grading/score';
import type { AssertionResult } from '../src/grading/types';

const a = (score: number, weight: number): AssertionResult => ({
  type: 'equals',
  weight,
  score,
  passed: score === 1,
});

describe('aggregateCase', () => {
  it('is the weighted mean of assertion scores', () => {
    // (1×3 + 0×1) / 4
    expect(aggregateCase([a(1, 3), a(0, 1)]).score).toBeCloseTo(0.75, 5);
  });

  it('scores 1 when everything passes', () => {
    expect(aggregateCase([a(1, 3), a(1, 1)]).score).toBe(1);
  });

  it('scores 0 when everything fails — never NaN', () => {
    const r = aggregateCase([a(0, 3), a(0, 1)]);
    expect(r.score).toBe(0);
    expect(Number.isNaN(r.score)).toBe(false);
  });

  // The review point: weights must actually move the number, not be accepted and ignored.
  it('weights change the result', () => {
    const light = aggregateCase([a(1, 3), a(0, 1)]).score;
    const heavy = aggregateCase([a(1, 6), a(0, 1)]).score;
    expect(heavy).toBeGreaterThan(light);
    expect(light).toBeCloseTo(0.75, 5);
    expect(heavy).toBeCloseTo(6 / 7, 5);
  });

  it('a heavier failing assertion drags the score down further', () => {
    expect(aggregateCase([a(1, 1), a(0, 9)]).score).toBeCloseTo(0.1, 5);
  });

  // The division-by-zero paths, traced explicitly.
  it('an empty assertion list scores 0 rather than NaN', () => {
    const r = aggregateCase([]);
    expect(r.score).toBe(0);
    expect(Number.isNaN(r.score)).toBe(false);
    expect(r.passed).toBe(false);
  });

  it('all-zero weights score 0 rather than NaN', () => {
    const r = aggregateCase([a(1, 0), a(1, 0)]);
    expect(r.score).toBe(0);
    expect(Number.isNaN(r.score)).toBe(false);
    expect(r.passed).toBe(false);
  });

  it('a negative weight is refused rather than silently inverting the maths', () => {
    expect(() => aggregateCase([a(1, -5), a(0, 1)])).toThrow();
  });

  it('passes only when every assertion passes, by default', () => {
    expect(aggregateCase([a(1, 1), a(1, 1)]).passed).toBe(true);
    expect(aggregateCase([a(1, 3), a(0, 1)]).passed).toBe(false);
  });

  it('honours an explicit case threshold', () => {
    expect(aggregateCase([a(1, 3), a(0, 1)], 0.7).passed).toBe(true);
    expect(aggregateCase([a(1, 3), a(0, 1)], 0.8).passed).toBe(false);
  });

  it('treats an errored assertion as scoring 0', () => {
    const errored: AssertionResult = {
      type: 'javascript',
      weight: 1,
      score: 0,
      passed: false,
      error: 'boom',
    };
    const r = aggregateCase([a(1, 1), errored]);
    expect(r.score).toBeCloseTo(0.5, 5);
    expect(r.passed).toBe(false);
  });
});

describe('challengeScore', () => {
  it('is 100 × the mean of case scores, rounded', () => {
    expect(challengeScore([1, 1, 1])).toBe(100);
    expect(challengeScore([1, 0])).toBe(50);
    expect(challengeScore([0, 0])).toBe(0);
  });

  it('rounds to the nearest whole number', () => {
    // mean = 0.8333…
    expect(challengeScore([1, 1, 0.5])).toBe(83);
  });

  it('gives every case equal say regardless of how many assertions it held', () => {
    expect(challengeScore([1, 0, 0, 0])).toBe(25);
  });

  it('returns 0 for no cases rather than NaN', () => {
    const s = challengeScore([]);
    expect(s).toBe(0);
    expect(Number.isNaN(s)).toBe(false);
  });
});
