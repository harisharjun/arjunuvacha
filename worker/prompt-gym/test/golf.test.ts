import { describe, it, expect } from 'vitest';
import { golfBonus, estimateTokens } from '../src/grading/score';
import { gradeChallenge } from '../src/grading/engine';
import { validators } from '../src/grading/validators';
import type { Challenge } from '../src/grading/types';

import pgA2 from '../../../projects/prompt-gym/challenges/pg-a2-single-label.json';

const par = { parTokens: 40, maxBonus: 20, passThreshold: 0.75 };

const bonus = (meanScore: number, promptTokens: number, over = {}) =>
  golfBonus({ meanScore, promptTokens, ...par, ...over });

describe('golfBonus — correctness first, brevity second', () => {
  it('pays nothing when correctness is below the pass threshold, however short the prompt', () => {
    expect(bonus(0.74, 1)).toBe(0);
    expect(bonus(0, 1)).toBe(0);
  });

  it('starts paying exactly at the threshold', () => {
    expect(bonus(0.75, 20)).toBeGreaterThan(0);
  });

  it('pays the full bonus for a prompt of no length', () => {
    expect(bonus(1, 0)).toBe(20);
  });

  it('pays half the bonus at half of par', () => {
    expect(bonus(1, 20)).toBe(10);
  });

  it('pays nothing at par — par is the bar, not a reward', () => {
    expect(bonus(1, 40)).toBe(0);
  });

  it('never goes negative for a prompt longer than par', () => {
    expect(bonus(1, 400)).toBe(0);
    expect(bonus(1, 41)).toBe(0);
  });

  it('respects a different maxBonus', () => {
    expect(bonus(1, 20, { maxBonus: 30 })).toBe(15);
  });

  it('rounds to a whole number', () => {
    // 1 - 13/40 = 0.675 → 13.5 → 14
    expect(bonus(1, 13)).toBe(14);
    expect(Number.isInteger(bonus(1, 13))).toBe(true);
  });

  it('pays nothing rather than Infinity when par is zero', () => {
    const b = bonus(1, 10, { parTokens: 0 });
    expect(b).toBe(0);
    expect(Number.isFinite(b)).toBe(true);
  });

  // 0/0 is the only division here that yields NaN rather than Infinity, so it is
  // the case the par guard actually exists for.
  it('pays nothing rather than NaN when both par and prompt are zero', () => {
    const b = bonus(1, 0, { parTokens: 0 });
    expect(Number.isNaN(b)).toBe(false);
    expect(b).toBe(0);
  });

  it('pays nothing rather than NaN for a negative prompt length', () => {
    const b = bonus(1, -5);
    expect(Number.isNaN(b)).toBe(false);
    expect(b).toBeLessThanOrEqual(20);
  });
});

describe('gradeChallenge on a golf challenge', () => {
  // pg-g3 as the converter will expand it: pg-a2's cases, mode golf, par attached.
  const golf: Challenge = {
    ...(pgA2 as unknown as Challenge),
    id: 'pg-g3',
    mode: 'golf',
    scoring: { maxScore: 100, passThreshold: 0.75, parTokens: 40, maxBonus: 20 },
  };

  const correct = { t1: 'billing', t2: 'bug', t3: 'account_access', t4: 'feature_request' };

  it('adds the bonus to a passing run', () => {
    const r = gradeChallenge(golf, correct, validators, { promptTokens: 20 });
    expect(r.baseScore).toBe(100);
    expect(r.efficiencyBonus).toBe(10);
    // Capped: correctness already took the whole scale.
    expect(r.score).toBe(100);
  });

  it('caps the total at 100 rather than overflowing', () => {
    const r = gradeChallenge(golf, correct, validators, { promptTokens: 0 });
    expect(r.score).toBe(100);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it('lets the bonus lift a partially-correct run that still cleared the bar', () => {
    // t4 answers with a label outside the allowed set: its case scores 0.25, so the
    // mean is 0.8125 — over the 0.75 threshold, and low enough that the bonus is
    // visible rather than swallowed by the cap.
    const mostly = { ...correct, t4: 'wrong' };
    const withBonus = gradeChallenge(golf, mostly, validators, { promptTokens: 10 });
    const withoutBonus = gradeChallenge(golf, mostly, validators, { promptTokens: 40 });

    expect(withoutBonus.baseScore).toBe(81);
    expect(withBonus.efficiencyBonus).toBe(15);
    expect(withBonus.score).toBe(96);
    expect(withoutBonus.score).toBe(81);
  });

  it('pays no bonus to a failing run even with a very short prompt', () => {
    const wrong = { t1: 'other', t2: 'other', t3: 'other', t4: 'other' };
    const r = gradeChallenge(golf, wrong, validators, { promptTokens: 1 });
    expect(r.passed).toBe(false);
    expect(r.efficiencyBonus).toBe(0);
    expect(r.score).toBe(r.baseScore);
  });

  it('pays no bonus when promptTokens was not supplied', () => {
    const r = gradeChallenge(golf, correct, validators);
    expect(r.efficiencyBonus).toBe(0);
    expect(r.score).toBe(r.baseScore);
  });
});

describe('the bonus measures the prompt, not the whole request', () => {
  // Found by expanding the golf variants: the bonus was being fed the provider's
  // prompt_tokens, which counts the harness template and the hidden test input
  // too. Par is ~40 and a whole request is ~143, so the ratio was always negative
  // and no golf run could ever earn a single point.
  it('estimates from the prompt text alone', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(160))).toBe(40);
    // Whitespace around the prompt is not something to be penalised for.
    expect(estimateTokens('  ' + 'a'.repeat(160) + '  ')).toBe(40);
  });

  it('gives a short prompt a real bonus against a realistic par', () => {
    const short = estimateTokens('Reply with one label only: billing, bug, other.');
    expect(short).toBeLessThan(40);
    expect(golfBonus({ meanScore: 1, passThreshold: 0.75, promptTokens: short, parTokens: 40, maxBonus: 20 }))
      .toBeGreaterThan(0);
  });
});

describe('gradeChallenge on a non-golf challenge', () => {
  const a2 = pgA2 as unknown as Challenge;

  it('ignores promptTokens entirely', () => {
    const r = gradeChallenge(
      a2,
      { t1: 'billing', t2: 'bug', t3: 'account_access', t4: 'feature_request' },
      validators,
      { promptTokens: 1 },
    );
    expect(r.efficiencyBonus).toBe(0);
    expect(r.score).toBe(r.baseScore);
  });
});
