export type RevealLevel = 'full' | 'partial' | 'verdict-only';

export type ChallengeMode = 'goal' | 'debug' | 'golf';

/** A JSON-schema subset. Unknown keywords are rejected rather than ignored — an
 *  unenforced constraint in a challenge is worse than a loud failure. */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  required?: string[];
  properties?: Record<string, JsonSchema>;
  enum?: unknown[];
  pattern?: string;
  additionalProperties?: boolean;
}

export interface Assertion {
  /** Assertion type, optionally carrying a `not-` prefix (e.g. `not-contains`). */
  type: string;
  value?: unknown;
  /** For `javascript` assertions: the key of a function in the validator registry. */
  ref?: string;
  /** Relative importance within its test case. Defaults to 1. */
  weight?: number;
  metric?: string;
  /** Pass bar for continuous graders (similarity). Defaults to 0.75. */
  threshold?: number;
  /** For `rouge-n`: the n in n-gram. Defaults to 1. */
  n?: number;
}

export interface TestCase {
  id: string;
  input: string;
  reveal: RevealLevel;
  hint?: string;
  /** Minimum weighted case score for this case to count as passed. Defaults to 1 —
   *  every assertion must pass unless the challenge says otherwise. */
  threshold?: number;
  assert?: Assertion[];
}

export interface Challenge {
  id: string;
  title: string;
  mode: ChallengeMode;
  difficulty?: number;
  tags?: string[];
  graderFamilies?: string[];
  public?: unknown;
  harness?: { template: string; temperature?: number; maxOutputTokens?: number };
  limits?: Record<string, unknown>;
  scoring: {
    maxScore: number;
    /** Fraction of 1, not of 100 — compared against the mean case score. */
    passThreshold: number;
    golfVariant?: { id: string; parTokens: number; maxBonus: number } | null;
  };
  /** Assertions applied to every test case, before the case's own. */
  defaultAssert?: Assertion[];
  tests: TestCase[];
}

export interface AssertionResult {
  type: string;
  metric?: string;
  weight: number;
  /** 0–1. Binary graders emit exactly 0 or 1; similarity graders emit a fraction. */
  score: number;
  passed: boolean;
  /** Set when the assertion could not be evaluated — a malformed output that threw,
   *  or a missing validator. Distinct from scoring 0 on the merits. */
  error?: string;
}

export interface CaseResult {
  id: string;
  /** 0–1. */
  score: number;
  passed: boolean;
  assertions: AssertionResult[];
}

export interface MetricBreakdown {
  metric: string;
  score: number;
  weight: number;
}

export interface ChallengeResult {
  /** 0–100, rounded. */
  score: number;
  passed: boolean;
  cases: CaseResult[];
  byMetric: MetricBreakdown[];
}

/** Validator functions are shipped in the bundle and selected by name. Challenge
 *  data can only ever *choose* from this map — it can never supply a function body. */
export type ValidatorRegistry = Record<string, (output: string) => boolean>;
