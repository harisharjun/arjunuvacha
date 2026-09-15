import { describe, it, expect } from 'vitest';
import { gradeChallenge } from '../src/grading/engine';
import { validators } from '../src/grading/validators';
import type { Challenge } from '../src/grading/types';

import pgA1 from '../../../projects/prompt-gym/challenges/pg-a1-address-extractor.json';
import pgA2 from '../../../projects/prompt-gym/challenges/pg-a2-single-label.json';

const a1 = pgA1 as unknown as Challenge;
const a2 = pgA2 as unknown as Challenge;

describe('pg-a1 — strict JSON address extractor', () => {
  const good: Record<string, string> = {
    t1: '{"name":"Priya Raman","line1":"14 MG Road","city":"Bengaluru","pincode":"560001","state":"Karnataka"}',
    t2: '{"name":"Arun Kumar","line1":"Flat 3B Sunrise Apartments, Jubilee Hills","city":"Hyderabad","pincode":"500033","state":"Telangana"}',
    t3: '{}',
    t4: '{"name":"Meera S","line1":"22 Residency Road","city":"Pune","pincode":"411001","state":""}',
  };

  it('scores a correct set of outputs 100', () => {
    const r = gradeChallenge(a1, good, validators);
    expect(r.score).toBe(100);
    expect(r.passed).toBe(true);
  });

  it('scores conversational prose close to zero', () => {
    const chatty: Record<string, string> = {
      t1: 'Here is the address you asked for: Priya Raman, 14 MG Road, Bengaluru 560001.',
      t2: 'Here is the address: Arun Kumar, Hyderabad 500033.',
      t3: 'Here is the address: there was no address in that message.',
      t4: 'Here is the address: Meera S, 22 Residency Road, Pune 411001, Maharashtra.',
    };
    const r = gradeChallenge(a1, chatty, validators);
    expect(r.score).toBeLessThan(15);
    expect(r.passed).toBe(false);
  });

  // t3 and t4 are the anti-hallucination cases. A prompt can be perfectly
  // well-formatted and still fail them, which is the point of the challenge.
  it('catches a well-formed prompt that invents an address', () => {
    const hallucinating = {
      ...good,
      t3: '{"name":"","line1":"","city":"Bengaluru","pincode":"560001","state":"Karnataka"}',
    };
    const r = gradeChallenge(a1, hallucinating, validators);
    expect(r.score).toBeLessThan(100);
    const t3 = r.cases.find((c) => c.id === 't3')!;
    expect(t3.passed).toBe(false);
    expect(t3.assertions.some((x) => x.metric === 'hallucination' && !x.passed)).toBe(true);
  });

  it('catches a guessed value in a field the input never supplied', () => {
    const guessing = {
      ...good,
      t4: '{"name":"Meera S","line1":"22 Residency Road","city":"Pune","pincode":"411001","state":"Maharashtra"}',
    };
    const r = gradeChallenge(a1, guessing, validators);
    const t4 = r.cases.find((c) => c.id === 't4')!;
    expect(t4.passed).toBe(false);
    expect(r.score).toBeLessThan(100);
  });

  it('applies defaultAssert to every case', () => {
    // Valid JSON for the case's own assertions, but carrying the banned preamble.
    const withPreamble = { ...good, t1: 'Here is ' + good.t1 };
    const r = gradeChallenge(a1, withPreamble, validators);
    const t1 = r.cases.find((c) => c.id === 't1')!;
    // is-json and not-contains both come from defaultAssert, and both now fail.
    expect(t1.assertions.filter((x) => x.metric === 'format').length).toBe(2);
    expect(t1.passed).toBe(false);
  });

  it('does not throw on output that is not JSON at all', () => {
    const garbage: Record<string, string> = { t1: '???', t2: '', t3: 'nope', t4: '<html>' };
    expect(() => gradeChallenge(a1, garbage, validators)).not.toThrow();
    const r = gradeChallenge(a1, garbage, validators);
    // Not zero: `not-contains "Here is"` is genuinely satisfied by garbage, and it
    // would be dishonest to score it otherwise. Everything of substance fails.
    expect(r.score).toBeLessThan(20);
    expect(r.passed).toBe(false);
    expect(Number.isNaN(r.score)).toBe(false);
    expect(r.cases.every((c) => !c.passed)).toBe(true);
  });

  it('reports a per-metric breakdown', () => {
    const r = gradeChallenge(a1, good, validators);
    const metrics = r.byMetric.map((m) => m.metric).sort();
    expect(metrics).toContain('schema');
    expect(metrics).toContain('accuracy');
    expect(metrics).toContain('hallucination');
  });
});

describe('pg-a2 — one label, nothing else', () => {
  const good: Record<string, string> = {
    t1: 'billing',
    t2: 'bug',
    t3: 'account_access',
    t4: 'feature_request',
  };

  it('scores the correct labels 100', () => {
    const r = gradeChallenge(a2, good, validators);
    expect(r.score).toBe(100);
    expect(r.passed).toBe(true);
  });

  it('fails a prompt that explains itself, even when the label is right', () => {
    const explains = { ...good, t3: 'account_access because SSO broke on Friday' };
    const r = gradeChallenge(a2, explains, validators);
    const t3 = r.cases.find((c) => c.id === 't3')!;
    expect(t3.passed).toBe(false);
    // word-count, regex and not-contains all object; the label itself was right.
    expect(t3.assertions.filter((x) => !x.passed).length).toBeGreaterThanOrEqual(3);
  });

  it('fails a label outside the allowed set', () => {
    const r = gradeChallenge(a2, { ...good, t2: 'defect' }, validators);
    expect(r.cases.find((c) => c.id === 't2')!.passed).toBe(false);
  });

  it('tolerates a trailing newline', () => {
    const r = gradeChallenge(a2, { t1: 'billing\n', t2: 'bug\n', t3: 'account_access\n', t4: 'feature_request\n' }, validators);
    expect(r.score).toBe(100);
  });
});

describe('missing and malformed inputs', () => {
  it('treats a missing output for a test case as an empty string rather than crashing', () => {
    const r = gradeChallenge(a2, { t1: 'billing' }, validators);
    expect(r.score).toBeLessThan(100);
    expect(r.cases.length).toBe(a2.tests.length);
  });

  it('passes only when the mean case score clears the challenge threshold', () => {
    // pg-a2 has passThreshold 0.75 and four equally weighted cases.
    const twoOfFour = { t1: 'billing', t2: 'bug', t3: 'wrong', t4: 'wrong' };
    const r = gradeChallenge(a2, twoOfFour, validators);
    expect(r.passed).toBe(false);
  });
});
