import type { Assertion, AssertionResult, JsonSchema, ValidatorRegistry } from './types';
import { assertSchemaSupported, validateJson } from './schema';
import { levenshteinSimilarity, rougeN } from './text';

/** Graders that emit a fraction rather than a verdict. Everything else must score
 *  exactly 1 to pass. */
const CONTINUOUS = new Set(['levenshtein', 'rouge-n']);
const DEFAULT_SIMILARITY_THRESHOLD = 0.75;

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function wordCountScore(text: string, value: unknown): number {
  const count = countWords(text);
  if (typeof value === 'number') return count === value ? 1 : 0;
  if (value !== null && typeof value === 'object') {
    const { min, max } = value as { min?: number; max?: number };
    if (min !== undefined && count < min) return 0;
    if (max !== undefined && count > max) return 0;
    return 1;
  }
  throw new Error('word-count expects a number or a {min,max} object');
}

function isJsonScore(text: string, schema: unknown): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 0;
  }
  if (schema === undefined || schema === null) return 1;
  // Throws on an unsupported keyword — an authoring bug, surfaced as an errored
  // assertion rather than quietly letting the output through.
  assertSchemaSupported(schema as JsonSchema);
  return validateJson(parsed, schema as JsonSchema) ? 1 : 0;
}

function javascriptScore(
  assertion: Assertion,
  output: string,
  registry: ValidatorRegistry,
  input: string,
): number {
  if (typeof assertion.ref !== 'string' || assertion.ref.length === 0) {
    throw new Error(
      'javascript assertion requires a `ref`; function bodies supplied as data are never executed',
    );
  }
  const fn = registry[assertion.ref];
  if (typeof fn !== 'function') {
    throw new Error(`Validator "${assertion.ref}" is not in the registry`);
  }
  return fn(output, { vars: { input }, args: assertion.args ?? [] }) === true ? 1 : 0;
}

function rawScore(
  type: string,
  assertion: Assertion,
  output: string,
  registry: ValidatorRegistry,
  input: string,
): number {
  // Leading and trailing whitespace is not a prompt defect, so anchored and exact
  // comparisons run against the trimmed output. Substring checks use it as-is.
  const text = output.trim();

  switch (type) {
    case 'equals':
      return text === String(assertion.value) ? 1 : 0;
    case 'contains':
      return output.includes(String(assertion.value)) ? 1 : 0;
    case 'icontains':
      return output.toLowerCase().includes(String(assertion.value).toLowerCase()) ? 1 : 0;
    case 'contains-all':
      return asStringArray(assertion.value).every((v) => output.includes(v)) ? 1 : 0;
    case 'contains-any':
      return asStringArray(assertion.value).some((v) => output.includes(v)) ? 1 : 0;
    case 'icontains-any': {
      const lower = output.toLowerCase();
      return asStringArray(assertion.value).some((v) => lower.includes(v.toLowerCase())) ? 1 : 0;
    }
    case 'starts-with':
      return text.startsWith(String(assertion.value)) ? 1 : 0;
    case 'regex':
      return new RegExp(String(assertion.value)).test(text) ? 1 : 0;
    case 'word-count':
      return wordCountScore(text, assertion.value);
    case 'is-json':
      return isJsonScore(text, assertion.value);
    case 'javascript':
      return javascriptScore(assertion, output, registry, input);
    case 'levenshtein':
      return levenshteinSimilarity(String(assertion.value), text);
    case 'rouge-n':
      return rougeN(String(assertion.value), text, assertion.n ?? 1);
    default:
      throw new Error(`Unknown assertion type "${type}"`);
  }
}

export function evaluateAssertion(
  assertion: Assertion,
  output: string,
  registry: ValidatorRegistry,
  /** The test case's hidden input, for validators that compare against it. */
  input = '',
): AssertionResult {
  const weight = assertion.weight ?? 1;
  const base = { type: assertion.type, metric: assertion.metric, weight };

  const negated = assertion.type.startsWith('not-');
  const type = negated ? assertion.type.slice(4) : assertion.type;

  let score: number;
  try {
    score = rawScore(type, assertion, output, registry, input);
  } catch (err) {
    // An assertion that could not be evaluated scores 0 and says why. Negation is
    // deliberately not applied — a broken assertion must never invert into a pass.
    return {
      ...base,
      score: 0,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (negated) score = 1 - score;

  const threshold =
    assertion.threshold ?? (CONTINUOUS.has(type) ? DEFAULT_SIMILARITY_THRESHOLD : 1);

  return { ...base, score, passed: score >= threshold };
}
