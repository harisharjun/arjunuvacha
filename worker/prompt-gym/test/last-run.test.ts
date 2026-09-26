import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Miniflare } from 'miniflare';
import schemaSql from '../migrations/0001_initial.sql?raw';
import { insertSubmission, setShowPrompt, upsertUser } from '../src/db/queries';
import type { RunResponse } from '../src/run';

/** Who the Worker thinks is calling, set per test. */
const who = vi.hoisted(() => ({ user: null as null | { uid: string; isAnonymous: boolean } }));
vi.mock('../src/auth/verify', () => ({
  userFromRequest: async () => ({
    user: who.user && { ...who.user, email: null, name: null, picture: null },
    error: undefined,
  }),
}));

import worker from '../src/index';

/** The scorecard coming back when a player returns to a challenge. Real D1, because
 *  the question is which row the SQL picks. */
let mf: Miniflare;
let db: D1Database;

const SCHEMA = schemaSql
  .split(';')
  .map((s: string) => s.trim())
  .filter((s: string) => s.length > 0 && !s.split('\n').every((l: string) => l.trim().startsWith('--')));

beforeEach(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    d1Databases: { DB: ':memory:' },
  });
  db = (await mf.getD1Database('DB')) as unknown as D1Database;
  for (const statement of SCHEMA) await db.prepare(statement).run();
  for (const uid of ['meera', 'ravi']) {
    await upsertUser(db, { uid, displayName: uid, avatarUrl: null, isAnonymous: false });
  }
  who.user = { uid: 'meera', isAnonymous: false };
});

afterEach(async () => {
  who.user = null;
  await mf.dispose();
});

const result = (id: string, challengeId: string, score: number) =>
  ({
    submissionId: id, challengeId, score, baseScore: score, efficiencyBonus: 0, passed: score >= 70,
    leaderboardEligible: true, execModel: 'gpt-4.1-nano', promptChars: 40, promptTokens: 10, tests: [], byGrader: [],
  }) as unknown as RunResponse;

const bank = (uid: string, id: string, challengeId: string, score: number) =>
  insertSubmission(db, { result: result(id, challengeId, score), uid, prompt: `p-${id}`, hash: `h-${id}`, byoKeyUsed: false });

const get = (challengeId: string) =>
  worker.fetch(
    new Request(`https://worker.test/api/last-run/${challengeId}`, {
      headers: { Origin: 'https://arjunuvacha.com', Authorization: 'Bearer t' },
    }),
    { DB: db } as never,
  );

describe('GET /api/last-run/:challengeId', () => {
  // Latest, not best: the card describes what the player last did, and a lower
  // score after a better one is exactly what they need to see.
  it("returns the player's most recent run, even when an earlier one scored higher", async () => {
    await bank('meera', 's1', 'pg-a2', 100);
    await bank('meera', 's2', 'pg-a2', 40);
    const res = await get('pg-a2');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ submissionId: 's2', score: 40, shareable: true, sharedToGallery: false });
  });

  it("never returns another player's run, nor a run of a different challenge", async () => {
    await bank('ravi', 'r1', 'pg-a2', 100);
    await bank('meera', 's1', 'pg-a3', 90);
    expect((await get('pg-a2')).status).toBe(404);
  });

  it('says whether the run is already public, so the switch starts in the right place', async () => {
    await bank('meera', 's1', 'pg-a2', 100);
    await setShowPrompt(db, 's1', true);
    expect(await (await get('pg-a2')).json()).toMatchObject({ sharedToGallery: true });
  });

  it('works for a guest, whose anonymous account owns its runs', async () => {
    await upsertUser(db, { uid: 'guest-1', displayName: null, avatarUrl: null, isAnonymous: true });
    await bank('guest-1', 'g1', 'pg-a2', 55);
    who.user = { uid: 'guest-1', isAnonymous: true };
    expect(await (await get('pg-a2')).json()).toMatchObject({ submissionId: 'g1', score: 55 });
  });

  it('refuses a request with no token', async () => {
    await bank('meera', 's1', 'pg-a2', 100);
    who.user = null;
    expect((await get('pg-a2')).status).toBe(401);
  });

  it('is a 404 for a challenge that is not shipped', async () => {
    expect((await get('pg-nope')).status).toBe(404);
  });
});
