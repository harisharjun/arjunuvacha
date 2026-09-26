import { describe, it, expect } from 'vitest';
import { evaluateAssertion } from '../src/grading/assertions';
import type { ValidatorRegistry } from '../src/grading/types';

const registry: ValidatorRegistry = {
  'validators.isEmptyObjectOrArray': (output) => {
    let j: unknown;
    try {
      j = JSON.parse(output);
    } catch {
      return false;
    }
    if (Array.isArray(j)) return j.length === 0;
    if (j && typeof j === 'object') return Object.keys(j).length === 0;
    return false;
  },
  // Deliberately unguarded: throws on non-JSON. Mirrors validators.stateMustBeEmpty
  // in pg-a1, which is exactly the shape that must not crash a run.
  'validators.throwsOnBadJson': (output) => JSON.parse(output).state === '',
};

const run = (type: string, value: unknown, output: string, extra = {}) =>
  evaluateAssertion({ type, value, weight: 1, ...extra }, output, registry);

describe('equals', () => {
  it('passes on an exact match', () => {
    expect(run('equals', 'billing', 'billing').score).toBe(1);
  });

  it('fails on a different value', () => {
    expect(run('equals', 'billing', 'bug').score).toBe(0);
  });

  it('ignores surrounding whitespace — a trailing newline is not a prompt defect', () => {
    expect(run('equals', 'billing', '  billing\n').score).toBe(1);
  });

  it('is case sensitive', () => {
    expect(run('equals', 'billing', 'Billing').score).toBe(0);
  });
});

describe('contains family', () => {
  it('contains matches a substring', () => {
    expect(run('contains', '560001', 'pincode is 560001 ok').score).toBe(1);
  });

  it('contains is case sensitive', () => {
    expect(run('contains', 'Billing', 'billing').score).toBe(0);
  });

  it('icontains is case insensitive', () => {
    expect(run('icontains', 'BILLING', 'billing').score).toBe(1);
  });

  it('contains-all requires every value', () => {
    expect(run('contains-all', ['a', 'b'], 'a and b').score).toBe(1);
    expect(run('contains-all', ['a', 'b'], 'only a').score).toBe(0);
  });

  it('contains-any requires at least one', () => {
    expect(run('contains-any', ['x', 'b'], 'only b here').score).toBe(1);
    expect(run('contains-any', ['x', 'y'], 'neither').score).toBe(0);
  });

  it('icontains-any ignores case', () => {
    expect(run('icontains-any', ['SORRY', 'AFRAID'], 'I am afraid not').score).toBe(1);
    expect(run('icontains-any', ['SORRY', 'AFRAID'], 'certainly').score).toBe(0);
  });

  // Five assertions across the challenge set are `not-icontains-any`; without this
  // type they would have become errored assertions in production.
  it('not-icontains-any inverts', () => {
    expect(run('not-icontains-any', ['Sure!', 'Here is'], 'plain output').score).toBe(1);
    expect(run('not-icontains-any', ['Sure!', 'Here is'], 'SURE! here goes').score).toBe(0);
  });

  it('starts-with checks the beginning', () => {
    expect(run('starts-with', '{', '{"a":1}').score).toBe(1);
    expect(run('starts-with', '{', 'Here is {"a":1}').score).toBe(0);
  });
});

describe('regex', () => {
  it('matches a valid label', () => {
    const pattern = '^(billing|bug|feature_request|account_access|other)$';
    expect(run('regex', pattern, 'billing').score).toBe(1);
    expect(run('regex', pattern, 'billing please').score).toBe(0);
  });

  it('anchors apply to the trimmed output', () => {
    expect(run('regex', '^abc$', 'abc\n').score).toBe(1);
  });
});

describe('word-count', () => {
  it('accepts an exact number', () => {
    expect(run('word-count', 1, 'billing').score).toBe(1);
    expect(run('word-count', 1, 'billing issue').score).toBe(0);
  });

  it('accepts a {min,max} range', () => {
    expect(run('word-count', { min: 2, max: 4 }, 'one two three').score).toBe(1);
    expect(run('word-count', { min: 2, max: 4 }, 'one').score).toBe(0);
    expect(run('word-count', { min: 2, max: 4 }, 'one two three four five').score).toBe(0);
  });

  it('accepts an open-ended range', () => {
    expect(run('word-count', { min: 2 }, 'a b c d e').score).toBe(1);
    expect(run('word-count', { max: 3 }, 'a b').score).toBe(1);
  });

  it('collapses repeated whitespace rather than counting empty strings', () => {
    expect(run('word-count', 2, '  hello   world \n').score).toBe(1);
  });

  it('counts an empty output as zero words', () => {
    expect(run('word-count', 0, '   ').score).toBe(1);
  });
});

describe('is-json', () => {
  it('passes on any valid JSON when no schema is given', () => {
    expect(run('is-json', undefined, '{"a":1}').score).toBe(1);
    expect(run('is-json', undefined, '[]').score).toBe(1);
  });

  it('fails on prose', () => {
    expect(run('is-json', undefined, 'Here is your JSON: {"a":1}').score).toBe(0);
  });

  it('fails on fenced JSON — the fence is the thing several challenges test for', () => {
    expect(run('is-json', undefined, '```json\n{"a":1}\n```').score).toBe(0);
  });

  it('enforces required keys', () => {
    const schema = { type: 'object', required: ['name', 'city'] };
    expect(run('is-json', schema, '{"name":"a","city":"b"}').score).toBe(1);
    expect(run('is-json', schema, '{"name":"a"}').score).toBe(0);
  });

  it('enforces a property pattern', () => {
    const schema = {
      type: 'object',
      properties: { pincode: { type: 'string', pattern: '^[0-9]{6}$' } },
    };
    expect(run('is-json', schema, '{"pincode":"560001"}').score).toBe(1);
    expect(run('is-json', schema, '{"pincode":"56001"}').score).toBe(0);
    expect(run('is-json', schema, '{"pincode":"WHAT"}').score).toBe(0);
  });

  it('rejects extra keys when additionalProperties is false', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    };
    expect(run('is-json', schema, '{"a":"x"}').score).toBe(1);
    expect(run('is-json', schema, '{"a":"x","sneaky":"y"}').score).toBe(0);
  });

  it('allows extra keys when additionalProperties is absent', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    expect(run('is-json', schema, '{"a":"x","extra":1}').score).toBe(1);
  });

  it('enforces enum', () => {
    const schema = { type: 'object', properties: { s: { enum: ['x', 'y'] } } };
    expect(run('is-json', schema, '{"s":"x"}').score).toBe(1);
    expect(run('is-json', schema, '{"s":"z"}').score).toBe(0);
  });

  it('distinguishes integer from number', () => {
    expect(run('is-json', { type: 'integer' }, '4').score).toBe(1);
    expect(run('is-json', { type: 'integer' }, '4.5').score).toBe(0);
    expect(run('is-json', { type: 'number' }, '4.5').score).toBe(1);
  });

  it('validates nested objects recursively', () => {
    const schema = {
      type: 'object',
      properties: { inner: { type: 'object', required: ['deep'] } },
    };
    expect(run('is-json', schema, '{"inner":{"deep":1}}').score).toBe(1);
    expect(run('is-json', schema, '{"inner":{"shallow":1}}').score).toBe(0);
  });
});

describe('javascript validators', () => {
  it('passes when the named validator returns true', () => {
    expect(run('javascript', undefined, '{}', { ref: 'validators.isEmptyObjectOrArray' }).score).toBe(1);
  });

  it('fails when it returns false', () => {
    expect(run('javascript', undefined, '{"a":1}', { ref: 'validators.isEmptyObjectOrArray' }).score).toBe(0);
  });

  // Reversed deliberately (26 Sep 2026). A validator throwing on the player's
  // output is the output failing the check. Recording it as an error made the run
  // ineligible and told the player "that is our side, not your prompt" when their
  // prompt had emitted ```json fences — exactly what pg-a11 is testing for.
  it('fails, without an error, when the validator throws on malformed output', () => {
    const r = run('javascript', undefined, 'not json at all', { ref: 'validators.throwsOnBadJson' });
    expect(r.score).toBe(0);
    expect(r.passed).toBe(false);
    expect(r.error).toBeUndefined();
  });

  it('does not invert a validator that threw on the output into a pass', () => {
    const r = run('not-javascript', undefined, 'not json at all', { ref: 'validators.throwsOnBadJson' });
    expect(r.score).toBe(0);
    expect(r.passed).toBe(false);
  });

  it('errors rather than silently passing when the ref is not in the registry', () => {
    const r = run('javascript', undefined, '{}', { ref: 'validators.doesNotExist' });
    expect(r.score).toBe(0);
    expect(r.error).toMatch(/registry|unknown|not found/i);
  });

  it('never evaluates a function body supplied as data', () => {
    const r = run('javascript', '(output) => true', '{}');
    expect(r.score).toBe(0);
    expect(r.error).toBeTruthy();
  });
});

describe('not- prefix', () => {
  it('inverts a passing assertion', () => {
    expect(run('not-contains', 'because', 'billing').score).toBe(1);
    expect(run('not-contains', 'because', 'billing because reasons').score).toBe(0);
  });

  it('works on equals', () => {
    expect(run('not-equals', 'billing', 'bug').score).toBe(1);
    expect(run('not-equals', 'billing', 'billing').score).toBe(0);
  });

  it('works on is-json', () => {
    expect(run('not-is-json', undefined, 'plain prose').score).toBe(1);
    expect(run('not-is-json', undefined, '{"a":1}').score).toBe(0);
  });

  it('does not invert an errored assertion into a pass', () => {
    const r = run('not-javascript', undefined, '{}', { ref: 'validators.doesNotExist' });
    expect(r.score).toBe(0);
    expect(r.error).toBeTruthy();
  });
});

describe('unknown assertion types', () => {
  it('errors rather than silently passing', () => {
    const r = run('telepathy', 'x', 'y');
    expect(r.score).toBe(0);
    expect(r.error).toBeTruthy();
  });
});

describe('similarity graders', () => {
  it('levenshtein scores 1 for identical strings', () => {
    expect(run('levenshtein', 'hello', 'hello').score).toBe(1);
  });

  it('levenshtein scores 0 for entirely different strings of equal length', () => {
    expect(run('levenshtein', 'abcd', 'wxyz').score).toBe(0);
  });

  it('levenshtein scores partially for a near miss', () => {
    const r = run('levenshtein', 'kitten', 'sitting');
    expect(r.score).toBeGreaterThan(0.5);
    expect(r.score).toBeLessThan(1);
  });

  it('levenshtein passes against its threshold', () => {
    expect(run('levenshtein', 'kitten', 'sitting', { threshold: 0.9 }).passed).toBe(false);
    expect(run('levenshtein', 'kitten', 'sitting', { threshold: 0.5 }).passed).toBe(true);
  });

  it('levenshtein treats two empty strings as identical rather than dividing by zero', () => {
    const r = run('levenshtein', '', '');
    expect(r.score).toBe(1);
    expect(Number.isNaN(r.score)).toBe(false);
  });

  it('rouge-n scores 1 when all reference unigrams appear', () => {
    expect(run('rouge-n', 'the cat sat', 'the cat sat').score).toBe(1);
  });

  it('rouge-n scores 0 with no overlap', () => {
    expect(run('rouge-n', 'alpha beta', 'gamma delta').score).toBe(0);
  });

  it('rouge-n scores partial overlap proportionally', () => {
    const r = run('rouge-n', 'the cat sat', 'the cat ran');
    expect(r.score).toBeCloseTo(2 / 3, 5);
  });

  it('rouge-n supports bigrams via n', () => {
    const r = run('rouge-n', 'the cat sat', 'the cat ran', { n: 2 });
    expect(r.score).toBeCloseTo(0.5, 5);
  });

  it('rouge-n on an empty reference does not produce NaN', () => {
    const r = run('rouge-n', '', 'anything');
    expect(Number.isNaN(r.score)).toBe(false);
  });
});

describe('weight is carried through untouched', () => {
  it('reports the declared weight', () => {
    const r = evaluateAssertion({ type: 'equals', value: 'a', weight: 7 }, 'a', registry);
    expect(r.weight).toBe(7);
  });

  it('defaults a missing weight to 1', () => {
    const r = evaluateAssertion({ type: 'equals', value: 'a' }, 'a', registry);
    expect(r.weight).toBe(1);
  });
});
