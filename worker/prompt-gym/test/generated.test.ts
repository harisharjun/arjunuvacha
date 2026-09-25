import { describe, it, expect } from 'vitest';
import { gradeChallenge } from '../src/grading/engine';
import { validators } from '../src/grading/validators';
import { assertSchemaSupported } from '../src/grading/schema';
import type { Challenge, JsonSchema } from '../src/grading/types';

// Proves the converter's output is loadable by the engine — something unit tests
// over hand-written fixtures cannot tell us. Loaded with vitest's glob rather than
// node:fs so this file needs no Node types, which keeps them out of a tsconfig
// shared with Worker code that must never see them. The glob also picks up a new
// challenge automatically instead of silently ignoring it.
const modules = (
  import.meta as unknown as {
    glob: (p: string, o: { eager: boolean }) => Record<string, { default: Challenge }>;
  }
).glob('../../../projects/prompt-gym/challenges/generated/*.json', { eager: true });

const challenges: Challenge[] = Object.values(modules).map((m) => m.default);

/** Assertions the engine cannot run yet: they need the judge (M2) or embeddings
 *  (M3). Listed so this test fails loudly if a *new* unimplemented type appears. */
const NOT_YET_RUNNABLE = new Set(['llm-rubric', 'similar']);

const allAssertions = (c: Challenge) =>
  c.tests.flatMap((t) => [...(c.defaultAssert ?? []), ...(t.assert ?? [])]);

describe('generated challenges', () => {
  it('there are fourteen of them — twelve authored plus two golf variants', () => {
    expect(challenges.length).toBe(14);
  });

  // The golf bonus was written at M1 but had no golf challenge to run against
  // until the variants were expanded.
  it('every golf challenge carries the par it is scored against', () => {
    const golf = challenges.filter((c) => c.mode === 'golf');
    expect(golf.length).toBe(2);
    for (const c of golf) {
      expect(c.scoring.parTokens).toBeGreaterThan(0);
      expect(c.scoring.maxBonus).toBeGreaterThan(0);
      expect(c.tests.length).toBeGreaterThan(0);
    }
  });

  it('a golf variant reuses its parent test cases exactly', () => {
    const byId = new Map(challenges.map((c) => [c.id, c]));
    for (const [variant, parent] of [['pg-g1', 'pg-a1'], ['pg-g3', 'pg-a2']] as const) {
      expect(byId.get(variant)!.tests).toEqual(byId.get(parent)!.tests);
      expect(byId.get(variant)!.defaultAssert).toEqual(byId.get(parent)!.defaultAssert);
    }
  });

  it.each(challenges.map((c) => [c.id, c] as const))('%s is structurally loadable', (_id, c) => {
    expect(c.id).toMatch(/^pg-/);
    expect(c.title.length).toBeGreaterThan(0);
    expect(['goal', 'debug', 'golf']).toContain(c.mode);
    expect(c.scoring.passThreshold).toBeGreaterThan(0);
    expect(c.scoring.passThreshold).toBeLessThanOrEqual(1);
    expect(c.tests.length).toBeGreaterThanOrEqual(3);
  });

  it.each(challenges.map((c) => [c.id, c] as const))('%s names only real validators', (_id, c) => {
    const refs = allAssertions(c)
      .filter((a) => a.type === 'javascript' || a.type === 'not-javascript')
      .map((a) => a.ref);
    expect(refs.every((r) => typeof r === 'string' && r.length > 0)).toBe(true);
    for (const ref of refs) expect(Object.keys(validators)).toContain(ref);
  });

  it.each(challenges.map((c) => [c.id, c] as const))('%s uses a supported schema', (_id, c) => {
    for (const a of allAssertions(c)) {
      if (a.type === 'is-json' && a.value) {
        expect(() => assertSchemaSupported(a.value as JsonSchema)).not.toThrow();
      }
    }
  });

  it.each(challenges.map((c) => [c.id, c] as const))('%s ships reveal: partial only', (_id, c) => {
    for (const t of c.tests) expect(t.reveal).toBe('partial');
  });

  // A debug challenge whose starting prompt is missing would present the player an
  // empty editor and no bug to fix.
  it.each(challenges.filter((c) => c.mode === 'debug').map((c) => [c.id, c] as const))(
    '%s is a debug challenge and hands over a starting prompt',
    (_id, c) => {
      const starting = (c.public as { startingPrompt?: string | null })?.startingPrompt;
      expect(typeof starting).toBe('string');
      expect((starting as string).length).toBeGreaterThan(20);
    },
  );

  it.each(challenges.map((c) => [c.id, c] as const))('%s grades without throwing', (_id, c) => {
    const empty: Record<string, string> = {};
    const garbage = Object.fromEntries(c.tests.map((t) => [t.id, 'not a valid answer']));
    expect(() => gradeChallenge(c, empty, validators)).not.toThrow();
    expect(() => gradeChallenge(c, garbage, validators)).not.toThrow();

    const r = gradeChallenge(c, garbage, validators);
    expect(Number.isNaN(r.score)).toBe(false);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it('only the known model-graded types are still unimplemented', () => {
    const unrunnable = new Set<string>();
    for (const c of challenges) {
      const garbage = Object.fromEntries(c.tests.map((t) => [t.id, 'x']));
      for (const caseResult of gradeChallenge(c, garbage, validators).cases) {
        for (const a of caseResult.assertions) {
          if (a.error?.includes('Unknown assertion type')) {
            unrunnable.add(a.type.replace(/^not-/, ''));
          }
        }
      }
    }
    // Anything here beyond the known deferred set is a genuine gap, which is how
    // `icontains-any` was found: authored in a challenge, absent from the engine.
    expect([...unrunnable].filter((t) => !NOT_YET_RUNNABLE.has(t))).toEqual([]);
  });
});
