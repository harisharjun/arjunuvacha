import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Miniflare } from 'miniflare';
import schemaSql from '../migrations/0001_initial.sql?raw';
import { publicResult, setShowPrompt, submissionOwner } from '../src/db/queries';

const SCHEMA = schemaSql
  .split(';')
  .map((statement: string) => statement.trim())
  .filter(
    (statement: string) =>
      statement.length > 0 &&
      !statement.split('\n').every((line: string) => line.trim().startsWith('--')),
  );

const HIDDEN_INPUT = 'Courier it to Meera S, 22 Residency Road, Pune 411001';
const MODEL_OUTPUT = '{"state":"Maharashtra"}';
const THE_PROMPT = 'Extract the address as strict JSON and never invent a value.';

let mf: Miniflare;
let db: D1Database;

/** A stored run, exactly as /api/run writes it — including the per-case inputs and
 *  outputs the owner is allowed to see. */
const storedResult = {
  submissionId: 'sub-share-1',
  challengeId: 'pg-a1',
  score: 82,
  baseScore: 82,
  efficiencyBonus: 0,
  passed: true,
  execModel: 'openai/gpt-oss-20b',
  promptChars: THE_PROMPT.length,
  promptTokens: 120,
  leaderboardEligible: true,
  byGrader: [
    { metric: 'schema', score: 1, weight: 6 },
    { metric: 'hallucination', score: 0.5, weight: 8 },
  ],
  tests: [
    { id: 't1', status: 'passed', reveal: 'partial', input: 'a short one', output: 'ok', failures: [] },
    { id: 't2', status: 'failed', reveal: 'partial', input: HIDDEN_INPUT, output: MODEL_OUTPUT, failures: [] },
    { id: 't3', status: 'errored', reveal: 'partial', input: null, output: null, failures: [] },
  ],
};

beforeEach(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    d1Databases: { DB: ':memory:' },
  });
  db = (await mf.getD1Database('DB')) as unknown as D1Database;
  for (const statement of SCHEMA) await db.prepare(statement).run();

  await db
    .prepare("INSERT INTO users (uid, display_name, is_anonymous) VALUES ('owner', 'Arjun', 0)")
    .run();
  await db
    .prepare(
      `INSERT INTO submissions (id, uid, challenge_id, exec_model, prompt_text, prompt_chars,
         score, base_score, efficiency_bonus, passed, leaderboard_eligible,
         grader_results_json, prompt_hash)
       VALUES ('sub-share-1', 'owner', 'pg-a1', 'openai/gpt-oss-20b', ?, ?, 82, 82, 0, 1, 1, ?, 'hash-1')`,
    )
    .bind(THE_PROMPT, THE_PROMPT.length, JSON.stringify(storedResult))
    .run();
});

afterEach(async () => {
  await mf.dispose();
});

describe('a share link never leaks the challenge', () => {
  // The point of the whole reveal design: the player who ran it earned the right
  // to see the inputs. A permalink is visible to people who have never attempted
  // the challenge, and handing them the hidden inputs would solve it for them.
  it('carries no test input or model output at all', async () => {
    const result = await publicResult(db, 'sub-share-1');
    const serialised = JSON.stringify(result);

    expect(serialised).not.toContain(HIDDEN_INPUT);
    expect(serialised).not.toContain(MODEL_OUTPUT);
    expect(serialised).not.toContain('Meera');
    expect(serialised).not.toContain('411001');
    expect(serialised).not.toContain('a short one');
    expect(serialised).not.toContain('"tests"');
  });

  it('still shows what makes the result worth sharing', async () => {
    const result = await publicResult(db, 'sub-share-1');
    expect(result?.score).toBe(82);
    expect(result?.passed).toBe(true);
    expect(result?.challengeId).toBe('pg-a1');
    expect(result?.execModel).toBe('openai/gpt-oss-20b');
    expect(result?.byGrader.map((g) => g.metric)).toEqual(['schema', 'hallucination']);
  });

  it('summarises the cases as counts rather than contents', async () => {
    const result = await publicResult(db, 'sub-share-1');
    expect(result?.cases).toEqual({ passed: 1, failed: 1, errored: 1 });
  });

  it('returns null for an id that does not exist', async () => {
    expect(await publicResult(db, 'sub-nope')).toBeNull();
  });

  it('survives a stored result it cannot parse', async () => {
    await db
      .prepare("UPDATE submissions SET grader_results_json = 'not json' WHERE id = 'sub-share-1'")
      .run();
    const result = await publicResult(db, 'sub-share-1');
    expect(result?.score).toBe(82);
    expect(result?.byGrader).toEqual([]);
  });
});

describe('the prompt is private until its owner publishes it', () => {
  it('is hidden by default, with no share row', async () => {
    expect((await publicResult(db, 'sub-share-1'))?.prompt).toBeNull();
  });

  // Shared prompts are gated (Arjun, 26 Sep 2026): identical prompts replay the
  // cached result, so a readable passing prompt is a free pass for anyone.
  const solver = { uid: 'solver', passed: new Set(['pg-a1']) };
  const stranger = { uid: 'stranger', passed: new Set<string>() };

  it('appears once shared, to a viewer who has passed the challenge', async () => {
    await setShowPrompt(db, 'sub-share-1', true);
    expect((await publicResult(db, 'sub-share-1', solver))?.prompt).toBe(THE_PROMPT);
  });

  it('stays locked for a viewer who has not passed it, and says so', async () => {
    await setShowPrompt(db, 'sub-share-1', true);
    const r = await publicResult(db, 'sub-share-1', stranger);
    expect(r?.prompt).toBeNull();
    expect(r?.promptLocked).toBe(true);
    // With no token at all, likewise.
    expect((await publicResult(db, 'sub-share-1'))?.promptLocked).toBe(true);
  });

  it('is always readable by its author, shared or not', async () => {
    const owner = { uid: 'owner', passed: new Set<string>() };
    expect((await publicResult(db, 'sub-share-1', owner))?.prompt).toBe(THE_PROMPT);
    expect((await publicResult(db, 'sub-share-1', owner))?.isYours).toBe(true);
  });

  it('can be turned back off, and is then private rather than locked', async () => {
    await setShowPrompt(db, 'sub-share-1', true);
    await setShowPrompt(db, 'sub-share-1', false);
    const r = await publicResult(db, 'sub-share-1', solver);
    expect(r?.prompt).toBeNull();
    expect(r?.promptLocked).toBe(false);
    expect(r?.shared).toBe(false);
  });

  it('does not create a second share row when toggled twice', async () => {
    await setShowPrompt(db, 'sub-share-1', true);
    await setShowPrompt(db, 'sub-share-1', false);
    const { results } = await db.prepare('SELECT id FROM share_results').all();
    expect(results).toHaveLength(1);
  });
});

describe('ownership', () => {
  it('reports who owns a submission, so only they can publish it', async () => {
    expect(await submissionOwner(db, 'sub-share-1')).toBe('owner');
  });

  it('reports null for an unknown submission', async () => {
    expect(await submissionOwner(db, 'sub-nope')).toBeNull();
  });
});

describe('who gets named on a shared result', () => {
  it('names a signed-in player', async () => {
    expect((await publicResult(db, 'sub-share-1'))?.playerName).toBe('Arjun');
  });

  // An anonymous player has no name to show, and their Firebase display name —
  // if one somehow existed — is not something they chose to publish.
  it('never names an anonymous player', async () => {
    await db.prepare("UPDATE users SET is_anonymous = 1 WHERE uid = 'owner'").run();
    expect((await publicResult(db, 'sub-share-1'))?.playerName).toBeNull();
  });
});
