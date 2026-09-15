import { describe, it, expect } from 'vitest';
import { validateJson, assertSchemaSupported } from '../src/grading/schema';

describe('type checking', () => {
  it('distinguishes the primitive types', () => {
    expect(validateJson('x', { type: 'string' })).toBe(true);
    expect(validateJson(1, { type: 'string' })).toBe(false);
    expect(validateJson(1, { type: 'number' })).toBe(true);
    expect(validateJson(true, { type: 'boolean' })).toBe(true);
    expect(validateJson(null, { type: 'null' })).toBe(true);
  });

  it('does not treat null or an array as an object', () => {
    expect(validateJson(null, { type: 'object' })).toBe(false);
    expect(validateJson([], { type: 'object' })).toBe(false);
    expect(validateJson({}, { type: 'object' })).toBe(true);
  });

  it('treats an array as an array', () => {
    expect(validateJson([], { type: 'array' })).toBe(true);
    expect(validateJson({}, { type: 'array' })).toBe(false);
  });

  it('accepts anything when no type is given', () => {
    expect(validateJson('x', {})).toBe(true);
    expect(validateJson(42, {})).toBe(true);
  });
});

describe('required', () => {
  it('requires the listed keys to be present', () => {
    expect(validateJson({ a: 1, b: 2 }, { required: ['a', 'b'] })).toBe(true);
    expect(validateJson({ a: 1 }, { required: ['a', 'b'] })).toBe(false);
  });

  it('counts a present-but-empty value as present', () => {
    expect(validateJson({ state: '' }, { required: ['state'] })).toBe(true);
  });

  it('counts an explicit null as present', () => {
    expect(validateJson({ state: null }, { required: ['state'] })).toBe(true);
  });
});

describe('additionalProperties', () => {
  const schema = {
    type: 'object' as const,
    properties: { a: { type: 'string' as const } },
    additionalProperties: false,
  };

  it('rejects a key not named in properties', () => {
    expect(validateJson({ a: 'x', b: 'y' }, schema)).toBe(false);
  });

  it('accepts exactly the named keys', () => {
    expect(validateJson({ a: 'x' }, schema)).toBe(true);
  });

  it('accepts a subset of the named keys when they are not required', () => {
    expect(validateJson({}, schema)).toBe(true);
  });

  it('permits extras when set to true', () => {
    expect(validateJson({ a: 'x', b: 'y' }, { ...schema, additionalProperties: true })).toBe(true);
  });
});

describe('pattern', () => {
  it('applies to strings', () => {
    expect(validateJson('560001', { pattern: '^[0-9]{6}$' })).toBe(true);
    expect(validateJson('56001', { pattern: '^[0-9]{6}$' })).toBe(false);
  });

  it('fails a non-string rather than coercing it', () => {
    expect(validateJson(560001, { pattern: '^[0-9]{6}$' })).toBe(false);
  });
});

describe('enum', () => {
  it('restricts to the listed values', () => {
    expect(validateJson('a', { enum: ['a', 'b'] })).toBe(true);
    expect(validateJson('c', { enum: ['a', 'b'] })).toBe(false);
  });

  it('compares numbers by value', () => {
    expect(validateJson(2, { enum: [1, 2] })).toBe(true);
  });
});

describe('nesting', () => {
  it('applies properties recursively', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        addr: {
          type: 'object' as const,
          properties: { pin: { type: 'string' as const, pattern: '^[0-9]{6}$' } },
          required: ['pin'],
        },
      },
    };
    expect(validateJson({ addr: { pin: '560001' } }, schema)).toBe(true);
    expect(validateJson({ addr: { pin: 'abc' } }, schema)).toBe(false);
    expect(validateJson({ addr: {} }, schema)).toBe(false);
  });

  it('ignores properties for a value that is not an object', () => {
    expect(validateJson('plain', { properties: { a: { type: 'string' } } })).toBe(true);
  });
});

// An unenforced constraint is worse than a loud failure: a challenge whose schema
// uses a keyword we silently skip would be easier to pass than its author intended.
describe('unsupported keywords', () => {
  it('assertSchemaSupported throws on a keyword the validator does not implement', () => {
    expect(() => assertSchemaSupported({ items: { type: 'string' } } as never)).toThrow(/items/);
  });

  it('names the offending keyword in nested schemas too', () => {
    const schema = { type: 'object', properties: { a: { minLength: 3 } } } as never;
    expect(() => assertSchemaSupported(schema)).toThrow(/minLength/);
  });

  it('accepts a schema using only the supported subset', () => {
    const schema = {
      type: 'object' as const,
      required: ['a'],
      properties: { a: { type: 'string' as const, pattern: '^x$' } },
      additionalProperties: false,
    };
    expect(() => assertSchemaSupported(schema)).not.toThrow();
  });
});
