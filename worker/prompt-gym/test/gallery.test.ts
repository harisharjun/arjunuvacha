import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Miniflare } from 'miniflare';
import schemaSql from '../migrations/0001_initial.sql?raw';
import { setShowPrompt, sharedResults } from '../src/db/queries';

/** The shared-results gallery, against a real D1. */
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

  await db.prepare(`INSERT INTO users (uid, display_name, avatar_url, is_anonymous) VALUES
    ('priya', 'Priya', 'https://x/priya.jpg', 0), ('arjun', 'Arjun', NULL, 0)`).run();
});

afterEach(async () => {
  await mf.dispose();
});

const run = async (id: string, uid: string, challenge: string, score: number, chars: number, at: string) =>
  db
    .prepare(
      `INSERT INTO submissions (id, uid, challenge_id, exec_model, prompt_text, prompt_chars, score, passed,
         leaderboard_eligible, grader_results_json, prompt_hash, created_at)
       VALUES (?, ?, ?, 'openai/gpt-oss-20b', ?, ?, ?, 1, 1, '{}', ?, ?)`,
    )
    .bind(id, uid, challenge, `prompt of ${id}`, chars, score, `h-${id}`, at)
    .run();

/** Shares happen in call order, so each gets a later shared-at time. */
const share = async (id: string, sharedAt: string) => {
  await setShowPrompt(db, id, true);
  await db.prepare('UPDATE share_results SET created_at = ? WHERE submission_id = ?').bind(sharedAt, id).run();
};

const ALL = ['pg-a2', 'pg-a1', 'pg-b3'];
const opts = (over: Partial<Parameters<typeof sharedResults>[1]> = {}) => ({
  challengeIds: ALL,
  sort: 'oldest' as const,
  mineOnly: false,
  limit: 50,
  ...over,
});

beforeEach(async () => {
  await run('p1', 'priya', 'pg-a2', 90, 120, '2026-09-20 10:00:00');
  await run('p2', 'priya', 'pg-b3', 100, 300, '2026-09-21 10:00:00');
  await run('a1', 'arjun', 'pg-a2', 100, 80, '2026-09-22 10:00:00');
  await run('a2', 'arjun', 'pg-a1', 70, 60, '2026-09-23 10:00:00'); // never shared
  await share('p2', '2026-09-24 09:00:00');
  await share('p1', '2026-09-25 09:00:00');
  await share('a1', '2026-09-26 09:00:00');
});

describe('what the gallery lists', () => {
  it('lists only what was shared, oldest share first', async () => {
    expect((await sharedResults(db, opts())).map((s) => s.id)).toEqual(['p2', 'p1', 'a1']);
  });

  it('sorts by score on request, shorter prompt breaking a tie', async () => {
    expect((await sharedResults(db, opts({ sort: 'score' }))).map((s) => s.id)).toEqual(['a1', 'p2', 'p1']);
  });

  it('narrows to the challenges it is given — the difficulty filter', async () => {
    expect((await sharedResults(db, opts({ challengeIds: ['pg-b3'] }))).map((s) => s.id)).toEqual(['p2']);
  });

  it("narrows to the viewer's own shares", async () => {
    const viewer = { uid: 'arjun', passed: new Set<string>() };
    expect((await sharedResults(db, opts({ mineOnly: true, viewer }))).map((s) => s.id)).toEqual(['a1']);
  });

  it('returns nothing for "my shares" without a viewer, rather than everything', async () => {
    expect(await sharedResults(db, opts({ mineOnly: true }))).toEqual([]);
  });

  it('drops an unshared result, and re-sharing sends it to the back', async () => {
    await setShowPrompt(db, 'p2', false);
    expect((await sharedResults(db, opts())).map((s) => s.id)).toEqual(['p1', 'a1']);
    await setShowPrompt(db, 'p2', true);
    expect((await sharedResults(db, opts())).map((s) => s.id)).toEqual(['p1', 'a1', 'p2']);
  });

  it('says who shared it and when it was run', async () => {
    const [first] = await sharedResults(db, opts());
    expect(first).toMatchObject({ playerName: 'Priya', avatarUrl: 'https://x/priya.jpg', runAt: '2026-09-21 10:00:00' });
  });
});

describe('the prompt gate', () => {
  it('locks every prompt for a viewer who has passed nothing', async () => {
    const viewer = { uid: 'stranger', passed: new Set<string>() };
    for (const s of await sharedResults(db, opts({ viewer }))) {
      expect(s.prompt).toBeNull();
      expect(s.promptLocked).toBe(true);
    }
  });

  it('unlocks exactly the challenges the viewer has passed', async () => {
    const viewer = { uid: 'stranger', passed: new Set(['pg-a2']) };
    const byId = Object.fromEntries((await sharedResults(db, opts({ viewer }))).map((s) => [s.id, s]));
    expect(byId.p1.prompt).toBe('prompt of p1');
    expect(byId.a1.prompt).toBe('prompt of a1');
    expect(byId.p2.prompt).toBeNull();
  });

  it("always shows an author their own prompt, and marks it theirs", async () => {
    const viewer = { uid: 'priya', passed: new Set<string>() };
    const mine = (await sharedResults(db, opts({ viewer }))).filter((s) => s.isYours);
    expect(mine.map((s) => s.id).sort()).toEqual(['p1', 'p2']);
    expect(mine.every((s) => s.prompt !== null)).toBe(true);
  });

  it('locks everything for a request with no token', async () => {
    expect((await sharedResults(db, opts())).every((s) => s.promptLocked)).toBe(true);
  });
});
