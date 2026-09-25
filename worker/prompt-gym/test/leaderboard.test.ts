import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Miniflare } from 'miniflare';
import schemaSql from '../migrations/0001_initial.sql?raw';
import { leaderboard, rankFor, progressFor, upsertBestScore } from '../src/db/queries';
import type { RunResponse } from '../src/run';

/** A real D1, via Miniflare — the same SQLite engine the Worker runs against.
 *  The ordering and the tie-break ARE the feature here, and a hand-written mock
 *  would only replay whatever I assumed the SQL does. */
let mf: Miniflare;
let db: D1Database;

const SCHEMA = schemaSql
  .split(';')
  .map((statement: string) => statement.trim())
  .filter(
    (statement: string) =>
      statement.length > 0 &&
      !statement.split('\n').every((line: string) => line.trim().startsWith('--')),
  );

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

const exec = (sql: string) => db.prepare(sql).run();

const player = (uid: string) =>
  exec(`INSERT INTO users (uid, display_name, is_anonymous) VALUES ('${uid}', '${uid}-name', 0)`);

/** D1 enforces foreign keys, so a best score needs its submission to exist —
 *  which mirrors production, where the submission is always inserted first. */
const best = async (uid: string, challenge: string, score: number, passed: number) => {
  const id = `sub-${uid}-${challenge}`;
  await exec(`INSERT INTO submissions (id, uid, challenge_id, exec_model, prompt_text,
                prompt_chars, score, grader_results_json, prompt_hash)
              VALUES ('${id}', '${uid}', '${challenge}', 'm', 'p', 1, ${score}, '{}', 'h-${id}')`);
  await exec(`INSERT INTO best_scores (uid, challenge_id, score, passed, submission_id)
              VALUES ('${uid}', '${challenge}', ${score}, ${passed}, '${id}')`);
};

describe('ranking', () => {
  it('ranks by challenges completed, not by total score', async () => {
    // `low` has a far higher total but cleared fewer challenges. Breadth is the
    // metric, so they must rank below.
    await player('wide');
    await player('low');
    await best('wide', 'pg-a1', 71, 1);
    await best('wide', 'pg-a2', 76, 1);
    await best('low', 'pg-a1', 100, 1);
    await best('low', 'pg-a3', 99, 0);

    const board = await leaderboard(db, 50);
    expect(board.map((r) => r.uid)).toEqual(['wide', 'low']);
    expect(board[0].completed).toBe(2);
    expect(board[1].completed).toBe(1);
    expect(board[1].totalScore).toBeGreaterThan(board[0].totalScore);
  });

  it('breaks a tie on completions with total score', async () => {
    await player('a');
    await player('b');
    await best('a', 'pg-a1', 80, 1);
    await best('a', 'pg-a2', 10, 0);
    await best('b', 'pg-a1', 80, 1);
    await best('b', 'pg-a2', 40, 0);

    const board = await leaderboard(db, 50);
    expect(board.map((r) => r.uid)).toEqual(['b', 'a']);
    expect(board[0].completed).toBe(board[1].completed);
  });

  it('honours the limit', async () => {
    for (const uid of ['a', 'b', 'c', 'd']) {
      await player(uid);
      await best(uid, 'pg-a1', 90, 1);
    }
    expect((await leaderboard(db, 2)).length).toBe(2);
  });

  it('returns an empty board rather than failing when nobody has played', async () => {
    expect(await leaderboard(db, 50)).toEqual([]);
  });

  // Deleting someone from Firebase Auth leaves their D1 rows untouched — the two
  // know nothing about each other — so their score stays on the board with no
  // name attached. Seen in production: every user row so far has a null name,
  // because the Worker sees the token before Firebase fills in the profile.
  it('keeps a score whose user has no display name', async () => {
    await exec("INSERT INTO users (uid, display_name, is_anonymous) VALUES ('nameless', NULL, 0)");
    await best('nameless', 'pg-a1', 88, 1);
    const board = await leaderboard(db, 50);
    expect(board).toHaveLength(1);
    expect(board[0].displayName).toBeNull();
    expect(board[0].completed).toBe(1);
  });
});

describe('your own rank', () => {
  beforeEach(async () => {
    for (const [uid, completed] of [['first', 3], ['second', 2], ['third', 1]] as const) {
      await player(uid);
      for (let i = 0; i < completed; i++) await best(uid, `pg-${i}`, 90, 1);
    }
  });

  it('gives the same rank the board would', async () => {
    const board = await leaderboard(db, 50);
    for (const row of board) {
      expect((await rankFor(db, row.uid))?.rank).toBe(row.rank);
    }
  });

  it('finds someone outside the top of the board', async () => {
    const you = await rankFor(db, 'third');
    expect(you?.rank).toBe(3);
    expect(you?.completed).toBe(1);
  });

  it('returns null for a user who has never scored', async () => {
    expect(await rankFor(db, 'nobody')).toBeNull();
  });

  it('does not give two tied users the same rank', async () => {
    await player('tieA');
    await player('tieB');
    await best('tieA', 'pg-x', 50, 1);
    await best('tieB', 'pg-x', 50, 1);
    const a = await rankFor(db, 'tieA');
    const b = await rankFor(db, 'tieB');
    expect(a?.rank).not.toBe(b?.rank);
  });
});

describe('progress', () => {
  it('lists only the challenges actually cleared', async () => {
    await player('p');
    await best('p', 'pg-a1', 90, 1);
    await best('p', 'pg-a2', 40, 0);
    expect(await progressFor(db, 'p')).toEqual(['pg-a1']);
  });
});

describe('what may be banked', () => {
  const result = (over: Partial<RunResponse> = {}): RunResponse =>
    ({
      submissionId: 'sub-1',
      challengeId: 'pg-a1',
      score: 90,
      baseScore: 90,
      efficiencyBonus: 0,
      passed: true,
      execModel: 'm',
      promptChars: 10,
      promptTokens: 10,
      leaderboardEligible: true,
      byGrader: [],
      tests: [],
      ...over,
    }) as RunResponse;

  beforeEach(async () => {
    await player('u');
    for (const id of ['sub-1', 's1', 's2', 's3']) {
      await exec(`INSERT INTO submissions (id, uid, challenge_id, exec_model, prompt_text,
                    prompt_chars, score, grader_results_json, prompt_hash)
                  VALUES ('${id}', 'u', 'pg-a1', 'm', 'p', 1, 0, '{}', 'h-${id}')`);
    }
  });

  it('banks an eligible run', async () => {
    expect(await upsertBestScore(db, 'u', result())).toBe(true);
    expect((await leaderboard(db, 50))[0].totalScore).toBe(90);
  });

  // The rule the whole errored-vs-failed distinction exists to protect: an
  // upstream blip scored someone low, and that must never reach the board.
  it('refuses a run containing an errored grader', async () => {
    expect(await upsertBestScore(db, 'u', result({ leaderboardEligible: false, score: 0 }))).toBe(
      false,
    );
    expect(await leaderboard(db, 50)).toEqual([]);
  });

  it('keeps the better of two scores, whichever order they arrive in', async () => {
    await upsertBestScore(db, 'u', result({ score: 80, submissionId: 's1' }));
    await upsertBestScore(db, 'u', result({ score: 95, submissionId: 's2' }));
    expect((await leaderboard(db, 50))[0].totalScore).toBe(95);

    await upsertBestScore(db, 'u', result({ score: 60, submissionId: 's3' }));
    expect((await leaderboard(db, 50))[0].totalScore).toBe(95);
  });

  it('does not let a later worse run un-complete a challenge', async () => {
    await upsertBestScore(db, 'u', result({ score: 95, passed: true }));
    await upsertBestScore(db, 'u', result({ score: 10, passed: false }));
    expect((await leaderboard(db, 50))[0].completed).toBe(1);
  });
});
