import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Miniflare } from 'miniflare';
import schemaSql from '../migrations/0001_initial.sql?raw';
import { upsertUser, leaderboard, progressDetailFor } from '../src/db/queries';

/** The linking invariant, tested at the layer that actually has to hold it.
 *
 *  Firebase's `linkWithPopup` keeps the same uid, so nothing needs to migrate —
 *  the guest's rows are already the signed-in user's rows. What can go wrong is
 *  on our side: the profile that decides how they are named, and whether they are
 *  ranked at all, is written separately from the scores. A real D1 via Miniflare,
 *  because a hand-written fake only replays what I assumed the SQL does. */
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
});

afterEach(async () => {
  await mf.dispose();
});

const LEVELS = { 'pg-a2': 1 };
const UID = 'firebase-uid-unchanged-by-linking';

const guestPasses = async () => {
  await upsertUser(db, { uid: UID, displayName: null, avatarUrl: null, isAnonymous: true });
  await db
    .prepare(
      `INSERT INTO submissions (id, uid, challenge_id, exec_model, prompt_text, prompt_chars, score,
         passed, leaderboard_eligible, grader_results_json, prompt_hash)
       VALUES ('s1', ?, 'pg-a2', 'm', 'p', 40, 88, 1, 1, '{}', 'h1')`,
    )
    .bind(UID)
    .run();
  await db
    .prepare(`INSERT INTO best_scores (uid, challenge_id, score, passed, submission_id) VALUES (?, 'pg-a2', 88, 1, 's1')`)
    .bind(UID)
    .run();
};

const link = () =>
  upsertUser(db, { uid: UID, displayName: 'Arjun', avatarUrl: 'https://x/p.jpg', isAnonymous: false });

describe('a guest score surviving Google account linking', () => {
  it('keeps the progress, because linking never changes the uid', async () => {
    await guestPasses();
    await link();
    const [p] = await progressDetailFor(db, UID);
    expect(p).toMatchObject({ challengeId: 'pg-a2', bestScore: 88, passed: true });
  });

  // Guests are not ranked; linking is exactly the moment they join the board.
  it('puts the player on the board once linked, under their real name and photo', async () => {
    await guestPasses();
    expect(await leaderboard(db, 10, LEVELS)).toEqual([]);

    await link();
    const [row] = await leaderboard(db, 10, LEVELS);
    expect(row).toMatchObject({ uid: UID, displayName: 'Arjun', avatarUrl: 'https://x/p.jpg', totalScore: 88 });
  });

  // COALESCE on the name, not on the flag: a later request without a name must
  // not un-name the account, but the anonymous flag does have to flip.
  it('keeps a stored name when a later update carries none', async () => {
    await link();
    await upsertUser(db, { uid: UID, displayName: null, avatarUrl: null, isAnonymous: false });
    const [row] = (
      await db.prepare('SELECT display_name, is_anonymous FROM users WHERE uid = ?').bind(UID).all<{
        display_name: string;
        is_anonymous: number;
      }>()
    ).results;
    expect(row).toEqual({ display_name: 'Arjun', is_anonymous: 0 });
  });
});
