import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Miniflare } from 'miniflare';
import schemaSql from '../migrations/0001_initial.sql?raw';
import { boardFor, leaderboard, rankFor, progressFor, progressDetailFor, playerCount, upsertBestScore } from '../src/db/queries';
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

/** Difficulty per challenge, as the Worker builds it from the shipped list. */
const LEVELS = { 'pg-a2': 1, 'pg-a1': 2, 'pg-a3': 2, 'pg-b7': 3, 'pg-b1': 3, 'pg-b3': 4, 'pg-c5': 4, 'pg-x5': 5 };

let seq = 0;
/** A banked pass, with its submission. `extraAttempts` are earlier failed runs. */
const pass = async (uid: string, challenge: string, score: number, chars = 50, extraAttempts = 0) => {
  for (let i = 0; i < extraAttempts; i++) {
    await exec(`INSERT INTO submissions (id, uid, challenge_id, exec_model, prompt_text, prompt_chars,
                  score, grader_results_json, prompt_hash, created_at)
                VALUES ('try-${++seq}', '${uid}', '${challenge}', 'm', 'p', ${chars}, 10, '{}', 'h-${seq}',
                  '2026-09-01 00:00:00')`);
  }
  const id = `pass-${++seq}`;
  await exec(`INSERT INTO submissions (id, uid, challenge_id, exec_model, prompt_text, prompt_chars,
                score, passed, leaderboard_eligible, grader_results_json, prompt_hash, created_at)
              VALUES ('${id}', '${uid}', '${challenge}', 'm', 'p', ${chars}, ${score}, 1, 1, '{}', 'h-${id}',
                '2026-09-10 00:00:00')`);
  await exec(`INSERT INTO best_scores (uid, challenge_id, score, passed, submission_id, updated_at)
              VALUES ('${uid}', '${challenge}', ${score}, 1, '${id}', '2026-09-10 00:00:00')`);
};

const guest = (uid: string) => exec(`INSERT INTO users (uid, is_anonymous) VALUES ('${uid}', 1)`);
const order = async () => (await leaderboard(db, 50, LEVELS)).map((r) => r.uid);

describe('ranking — the order Arjun specified', () => {
  it('ranks one harder pass above any number of easier ones', async () => {
    await player('hard');
    await player('many');
    await pass('hard', 'pg-b3', 70);
    await pass('many', 'pg-a2', 100);
    await pass('many', 'pg-a1', 100);
    await pass('many', 'pg-b7', 100);
    expect(await order()).toEqual(['hard', 'many']);
  });

  it('compares level by level, highest first', async () => {
    await player('a');
    await player('b');
    // Same Hard count; `b` has more Intermediate, `a` has more Beginner.
    await pass('a', 'pg-b3', 80);
    await pass('a', 'pg-a2', 90);
    await pass('b', 'pg-b3', 80);
    await pass('b', 'pg-b7', 75);
    expect(await order()).toEqual(['b', 'a']);
  });

  it('breaks a tie on counts with points at the highest level, not total points', async () => {
    await player('topheavy');
    await player('bigtotal');
    await pass('topheavy', 'pg-b3', 95);
    await pass('topheavy', 'pg-a2', 70);
    await pass('bigtotal', 'pg-b3', 85);
    await pass('bigtotal', 'pg-a2', 100); // more points overall, fewer where it counts
    expect(await order()).toEqual(['topheavy', 'bigtotal']);
  });

  it('breaks a tie on points with fewer prompt characters', async () => {
    await player('verbose');
    await player('terse');
    await pass('verbose', 'pg-a1', 90, 400);
    await pass('terse', 'pg-a1', 90, 120);
    expect(await order()).toEqual(['terse', 'verbose']);
  });

  it('breaks a tie on characters with fewer attempts', async () => {
    await player('grinder');
    await player('sharp');
    await pass('grinder', 'pg-a1', 90, 100, 4);
    await pass('sharp', 'pg-a1', 90, 100, 0);
    const board = await leaderboard(db, 50, LEVELS);
    expect(board.map((r) => r.uid)).toEqual(['sharp', 'grinder']);
    expect(board.find((r) => r.uid === 'grinder')!.attempts).toBe(5);
    expect(board.find((r) => r.uid === 'sharp')!.attempts).toBe(1);
  });

  // A pass served from the dedupe cache has no run of its own. It still took one.
  it('counts a cached pass as one attempt, never zero', async () => {
    await player('orig');
    await player('copy');
    await pass('orig', 'pg-a2', 100);
    await exec(`INSERT INTO best_scores (uid, challenge_id, score, passed, submission_id, updated_at)
                SELECT 'copy', challenge_id, score, 1, submission_id, updated_at FROM best_scores WHERE uid = 'orig'`);
    expect((await leaderboard(db, 50, LEVELS)).find((r) => r.uid === 'copy')!.attempts).toBe(1);
  });

  it('gives every player a distinct rank, even when fully tied', async () => {
    await player('x');
    await player('y');
    await pass('x', 'pg-a1', 90);
    await pass('y', 'pg-a1', 90);
    const board = await leaderboard(db, 50, LEVELS);
    expect(board.map((r) => r.rank)).toEqual([1, 2]);
  });
});

describe('who is on the board', () => {
  it('leaves guests off — signing in is how a guest joins', async () => {
    await player('named');
    await guest('anon');
    await pass('named', 'pg-a1', 80);
    await pass('anon', 'pg-b3', 100);
    expect(await order()).toEqual(['named']);
  });

  it('counts only passes, so an unfinished attempt does not rank', async () => {
    await player('p');
    await best('p', 'pg-a1', 60, 0);
    expect(await order()).toEqual([]);
  });

  // A pass on something since withheld would rank a player on a card nobody sees.
  it('ignores passes on challenges that are not shipped', async () => {
    await player('p');
    await pass('p', 'pg-withheld', 100);
    expect(await order()).toEqual([]);
  });

  it('keeps a signed-in player who has no display name', async () => {
    await exec(`INSERT INTO users (uid, is_anonymous) VALUES ('noname', 0)`);
    await pass('noname', 'pg-a2', 100);
    const [row] = await leaderboard(db, 50, LEVELS);
    expect(row.uid).toBe('noname');
    expect(row.displayName).toBeNull();
  });

  it('honours the limit', async () => {
    for (const u of ['a', 'b', 'c']) {
      await player(u);
      await pass(u, 'pg-a2', 90);
    }
    expect(await leaderboard(db, 2, LEVELS)).toHaveLength(2);
    expect(await playerCount(db, LEVELS)).toBe(3);
  });

  it('returns an empty board rather than failing when nobody has played', async () => {
    expect(await leaderboard(db, 50, LEVELS)).toEqual([]);
    expect(await leaderboard(db, 50, {})).toEqual([]);
  });
});

describe('your own rank', () => {
  it('finds someone outside the top of the board, with the same rank the board gives', async () => {
    for (const [u, sc] of [['a', 99], ['b', 98], ['c', 97]] as const) {
      await player(u);
      await pass(u, 'pg-a2', sc);
    }
    const { board, you, total } = await boardFor(db, LEVELS, 2, 'c');
    expect(board.map((r) => r.uid)).toEqual(['a', 'b']);
    expect(you).toMatchObject({ uid: 'c', rank: 3 });
    expect(total).toBe(3);
    expect((await rankFor(db, 'c', LEVELS))!.rank).toBe(3);
  });

  it('has no rank for a guest, however well they did', async () => {
    await guest('anon');
    await pass('anon', 'pg-b3', 100);
    expect((await boardFor(db, LEVELS, 10, 'anon')).you).toBeNull();
  });

  it('has no rank for someone who has not passed anything', async () => {
    await player('p');
    expect(await rankFor(db, 'p', LEVELS)).toBeNull();
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
    expect((await leaderboard(db, 50, LEVELS))[0].totalScore).toBe(90);
  });

  // The rule the whole errored-vs-failed distinction exists to protect: an
  // upstream blip scored someone low, and that must never reach the board.
  it('refuses a run containing an errored grader', async () => {
    expect(await upsertBestScore(db, 'u', result({ leaderboardEligible: false, score: 0 }))).toBe(
      false,
    );
    expect(await leaderboard(db, 50, LEVELS)).toEqual([]);
  });

  it('keeps the better of two scores, whichever order they arrive in', async () => {
    await upsertBestScore(db, 'u', result({ score: 80, submissionId: 's1' }));
    await upsertBestScore(db, 'u', result({ score: 95, submissionId: 's2' }));
    expect((await leaderboard(db, 50, LEVELS))[0].totalScore).toBe(95);

    await upsertBestScore(db, 'u', result({ score: 60, submissionId: 's3' }));
    expect((await leaderboard(db, 50, LEVELS))[0].totalScore).toBe(95);
  });

  it('does not let a later worse run un-complete a challenge', async () => {
    await upsertBestScore(db, 'u', result({ score: 95, passed: true }));
    await upsertBestScore(db, 'u', result({ score: 10, passed: false }));
    expect((await leaderboard(db, 50, LEVELS))[0].completed).toBe(1);
  });
});

describe('per-challenge progress, for the cards', () => {
  /** A submission with an explicit time, eligibility and outcome. */
  const submission = (id: string, uid: string, challenge: string, score: number,
                      passed: number, eligible: number, at: string) =>
    exec(`INSERT INTO submissions (id, uid, challenge_id, exec_model, prompt_text, prompt_chars,
            score, passed, leaderboard_eligible, grader_results_json, prompt_hash, created_at)
          VALUES ('${id}', '${uid}', '${challenge}', 'm', 'p', 1, ${score}, ${passed}, ${eligible},
            '{}', 'h-${id}', '${at}')`);

  const banked = (uid: string, challenge: string, score: number, passed: number, subId: string, at: string) =>
    exec(`INSERT INTO best_scores (uid, challenge_id, score, passed, submission_id, updated_at)
          VALUES ('${uid}', '${challenge}', ${score}, ${passed}, '${subId}', '${at}')`);

  // "Completed on" is the day they first passed. Improving the score later must
  // not move it, or a card would claim they only finished yesterday.
  it('dates a pass by the first passing run, not the best one', async () => {
    await player('p');
    await submission('s1', 'p', 'pg-a1', 72, 1, 1, '2026-09-24 10:00:00');
    await submission('s2', 'p', 'pg-a1', 95, 1, 1, '2026-09-26 10:00:00');
    await banked('p', 'pg-a1', 95, 1, 's2', '2026-09-26 10:00:00');

    const [row] = await progressDetailFor(db, 'p');
    expect(row).toMatchObject({ challengeId: 'pg-a1', bestScore: 95, passed: true, passedAt: '2026-09-24 10:00:00' });
  });

  // A run that errored is not a pass, however it scored.
  it('ignores a passing run that was not leaderboard-eligible', async () => {
    await player('p');
    await submission('s0', 'p', 'pg-a1', 90, 1, 0, '2026-09-20 10:00:00');
    await submission('s1', 'p', 'pg-a1', 80, 1, 1, '2026-09-25 10:00:00');
    await banked('p', 'pg-a1', 80, 1, 's1', '2026-09-25 10:00:00');

    expect((await progressDetailFor(db, 'p'))[0].passedAt).toBe('2026-09-25 10:00:00');
  });

  // A deduped run banks a score against a submission someone else made first,
  // so this player has no passing submission of their own to date it by.
  it('falls back to the best-score date when the pass came from the cache', async () => {
    await player('first');
    await player('second');
    await submission('orig', 'first', 'pg-a2', 100, 1, 1, '2026-09-20 10:00:00');
    await banked('first', 'pg-a2', 100, 1, 'orig', '2026-09-20 10:00:00');
    await banked('second', 'pg-a2', 100, 1, 'orig', '2026-09-26 12:00:00');

    expect((await progressDetailFor(db, 'second'))[0].passedAt).toBe('2026-09-26 12:00:00');
  });

  it('reports an attempt that has not passed, with no completion date', async () => {
    await player('p');
    await best('p', 'pg-a3', 45, 0);

    const [row] = await progressDetailFor(db, 'p');
    expect(row).toMatchObject({ challengeId: 'pg-a3', bestScore: 45, passed: false, passedAt: null });
  });

  it("returns only this player's challenges", async () => {
    await player('p');
    await player('q');
    await best('p', 'pg-a1', 80, 1);
    await best('q', 'pg-a2', 90, 1);
    expect((await progressDetailFor(db, 'p')).map((r) => r.challengeId)).toEqual(['pg-a1']);
  });

  it('counts the players on the board — signed in, with at least one pass', async () => {
    await player('a');
    await player('b');
    await player('c');
    await best('a', 'pg-a1', 80, 1);
    await best('b', 'pg-a1', 30, 0);
    expect(await playerCount(db, LEVELS)).toBe(1);
  });
});
