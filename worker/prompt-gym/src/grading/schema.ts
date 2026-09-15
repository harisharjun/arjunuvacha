import type { JsonSchema } from './types';

const SUPPORTED_KEYWORDS = [
  'type',
  'required',
  'properties',
  'enum',
  'pattern',
  'additionalProperties',
] as const;

/** Rejects any schema using a keyword this validator does not implement.
 *  Silently ignoring one would make a challenge easier to pass than its author
 *  intended, and nobody would notice until a player reported a wrong score. */
export function assertSchemaSupported(schema: JsonSchema, path = '$'): void {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new Error(`Schema at ${path} must be an object`);
  }
  for (const key of Object.keys(schema)) {
    if (!(SUPPORTED_KEYWORDS as readonly string[]).includes(key)) {
      throw new Error(`Unsupported JSON-schema keyword "${key}" at ${path}`);
    }
  }
  for (const [name, sub] of Object.entries(schema.properties ?? {})) {
    assertSchemaSupported(sub, `${path}.${name}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesType(value: unknown, type: NonNullable<JsonSchema['type']>): boolean {
  switch (type) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function validateJson(value: unknown, schema: JsonSchema): boolean {
  if (schema.type !== undefined && !matchesType(value, schema.type)) return false;

  if (schema.enum !== undefined && !schema.enum.some((allowed) => sameValue(allowed, value))) {
    return false;
  }

  if (schema.pattern !== undefined) {
    if (typeof value !== 'string') return false;
    if (!new RegExp(schema.pattern).test(value)) return false;
  }

  if (schema.required !== undefined) {
    if (!isPlainObject(value)) return false;
    for (const key of schema.required) {
      if (!(key in value)) return false;
    }
  }

  // `properties` constrains keys that are present; it does not make them required.
  if (schema.properties !== undefined && isPlainObject(value)) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in value && !validateJson(value[key], sub)) return false;
    }
  }

  if (schema.additionalProperties === false) {
    if (!isPlainObject(value)) return false;
    const allowed = new Set(Object.keys(schema.properties ?? {}));
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) return false;
    }
  }

  return true;
}
