import type { RunResponse } from '../run';
import { rankedPlayers, type Levels, type RankedStanding } from './ranking';

/** SHA-256 hex of the three things that decide a run's outcome.
 *
 *  The model is part of the key on purpose: the same prompt on 20b and on 120b are
 *  different runs and must not share a cached result.
 *
 *  Async because Workers has WebCrypto rather than node:crypto — `crypto.subtle`
 *  returns a promise where `createHash().digest()` was synchronous. That difference
 *  propagates up through every caller. */
export async function promptHash(
  challengeId: string,
  prompt: string,
  execModel: string,
): Promise<string> {
  const data = new TextEncoder().encode(`${challengeId}\n${prompt}\n${execModel}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface StoredSubmission {
  id: string;
  result: RunResponse;
}

/** Looks for an identical previous submission. Everything runs at temperature 0,
 *  so returning the stored grading is honest — and it makes re-running a prompt
 *  you already submitted free, which matters against a shared budget. */
export async function findByHash(db: D1Database, hash: string): Promise<StoredSubmission | null> {
  const row = await db
    .prepare('SELECT id, grader_results_json FROM submissions WHERE prompt_hash = ? LIMIT 1')
    .bind(hash)
    .first<{ id: string; grader_results_json: string }>();

  if (!row) return null;
  try {
    return { id: row.id, result: JSON.parse(row.grader_results_json) as RunResponse };
  } catch {
    // A corrupt row should cause a re-run, not a 500.
    return null;
  }
}

export async function insertSubmission(
  db: D1Database,
  params: {
    result: RunResponse;
    uid: string | null;
    prompt: string;
    hash: string;
    byoKeyUsed: boolean;
  },
): Promise<void> {
  const { result, uid, prompt, hash, byoKeyUsed } = params;
  await db
    .prepare(
      `INSERT INTO submissions (
         id, uid, challenge_id, exec_model, prompt_text, prompt_chars, prompt_tokens,
         score, base_score, efficiency_bonus, passed, leaderboard_eligible,
         grader_results_json, byo_key_used, prompt_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      result.submissionId,
      uid,
      result.challengeId,
      result.execModel,
      prompt,
      result.promptChars,
      result.promptTokens,
      result.score,
      result.baseScore,
      result.efficiencyBonus,
      result.passed ? 1 : 0,
      result.leaderboardEligible ? 1 : 0,
      JSON.stringify(result),
      byoKeyUsed ? 1 : 0,
      hash,
    )
    .run();
}

/** Upserts the user's best score for a challenge, but only when this run beat it.
 *
 *  Refuses anything not leaderboard-eligible: a run with an errored grader scored
 *  low for reasons that were never the player's fault, and banking it would be
 *  the infrastructure quietly penalising them. */
export async function upsertBestScore(
  db: D1Database,
  uid: string,
  result: RunResponse,
): Promise<boolean> {
  if (!result.leaderboardEligible) return false;

  const outcome = await db
    .prepare(
      `INSERT INTO best_scores (uid, challenge_id, score, passed, submission_id, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(uid, challenge_id) DO UPDATE SET
         score = excluded.score,
         passed = excluded.passed,
         submission_id = excluded.submission_id,
         updated_at = excluded.updated_at
       WHERE excluded.score > best_scores.score`,
    )
    .bind(uid, result.challengeId, result.score, result.passed ? 1 : 0, result.submissionId)
    .run();

  return (outcome.meta?.changes ?? 0) > 0;
}

/** What a share link may show.
 *
 *  Deliberately far less than the owner's own scorecard. The stored result carries
 *  each test case's input and the model's output, because the player who ran it
 *  has earned that; a permalink is visible to people who have never attempted the
 *  challenge, and handing them the hidden inputs would solve it for them. So this
 *  is built from scratch — score, breakdown, counts — and never by trimming the
 *  stored object, which would leak the day someone adds a field to it. */
export interface PublicResult {
  id: string;
  challengeId: string;
  score: number;
  baseScore: number;
  efficiencyBonus: number;
  passed: boolean;
  execModel: string;
  promptChars: number;
  createdAt: string;
  byGrader: { metric: string; score: number }[];
  cases: { passed: number; failed: number; errored: number };
  /** Null unless the owner has chosen to show it. */
  prompt: string | null;
  /** Shared, but this viewer has not passed the challenge yet. */
  promptLocked: boolean;
  /** In the public gallery. */
  shared: boolean;
  isYours: boolean;
  avatarUrl: string | null;
  playerName: string | null;
}

/** Who is looking, for the prompt gate. Absent for a request with no token. */
export interface Viewer {
  uid: string;
  /** Challenges the viewer has passed. */
  passed: Set<string>;
}

/** Whether a viewer may read a shared prompt.
 *
 *  Identical prompts replay the cached result, so a copied prompt passes
 *  instantly and banks on the leaderboard. A shared prompt is therefore readable
 *  only by someone who has already passed that challenge themselves — Arjun's
 *  call, 26 Sep 2026 — and always by its author. Everyone else sees that it
 *  exists, who wrote it, and how it scored. */
export function revealPrompt(o: { shared: boolean; isYours: boolean; viewerPassed: boolean }): boolean {
  if (o.isYours) return true;
  return o.shared && o.viewerPassed;
}

export async function publicResult(
  db: D1Database,
  id: string,
  viewer?: Viewer,
): Promise<PublicResult | null> {
  const row = await db
    .prepare(
      `SELECT s.id, s.challenge_id, s.exec_model, s.prompt_text, s.prompt_chars, s.score,
              s.base_score, s.efficiency_bonus, s.passed, s.grader_results_json, s.created_at,
              s.uid, u.display_name, u.avatar_url, u.is_anonymous,
              COALESCE(sh.show_prompt, 0) AS show_prompt
       FROM submissions s
       LEFT JOIN users u ON u.uid = s.uid
       LEFT JOIN share_results sh ON sh.submission_id = s.id
       WHERE s.id = ?`,
    )
    .bind(id)
    .first<{
      id: string;
      challenge_id: string;
      exec_model: string;
      prompt_text: string;
      prompt_chars: number;
      score: number;
      base_score: number;
      efficiency_bonus: number;
      passed: number;
      grader_results_json: string;
      created_at: string;
      uid: string | null;
      display_name: string | null;
      avatar_url: string | null;
      is_anonymous: number | null;
      show_prompt: number;
    }>();

  if (!row) return null;
  const isYours = Boolean(viewer && row.uid && viewer.uid === row.uid);
  const shared = row.show_prompt === 1;
  const unlocked = revealPrompt({ shared, isYours, viewerPassed: viewer?.passed.has(row.challenge_id) ?? false });

  let byGrader: { metric: string; score: number }[] = [];
  const counts = { passed: 0, failed: 0, errored: 0 };
  try {
    const stored = JSON.parse(row.grader_results_json) as {
      byGrader?: { metric: string; score: number }[];
      tests?: { status: 'passed' | 'failed' | 'errored' }[];
    };
    byGrader = (stored.byGrader ?? []).map((g) => ({ metric: g.metric, score: g.score }));
    for (const test of stored.tests ?? []) counts[test.status] += 1;
  } catch {
    /* a result we cannot parse still has a score worth showing */
  }

  return {
    id: row.id,
    challengeId: row.challenge_id,
    score: row.score,
    baseScore: row.base_score,
    efficiencyBonus: row.efficiency_bonus,
    passed: row.passed === 1,
    execModel: row.exec_model,
    promptChars: row.prompt_chars,
    createdAt: row.created_at,
    byGrader,
    cases: counts,
    prompt: unlocked ? row.prompt_text : null,
    promptLocked: shared && !unlocked,
    shared,
    isYours,
    playerName: row.is_anonymous === 0 ? row.display_name : null,
    avatarUrl: row.is_anonymous === 0 ? row.avatar_url : null,
  };
}

/** Sets whether a result's prompt is visible. Owner only — checked by the caller
 *  against the submission's uid, which is why that is returned here. */
export async function submissionOwner(db: D1Database, id: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT uid FROM submissions WHERE id = ?')
    .bind(id)
    .first<{ uid: string | null }>();
  return row?.uid ?? null;
}

export async function setShowPrompt(
  db: D1Database,
  submissionId: string,
  showPrompt: boolean,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO share_results (id, submission_id, show_prompt)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         show_prompt = excluded.show_prompt,
         -- Re-sharing after an unshare is a new share; it goes to the back.
         created_at = CASE WHEN excluded.show_prompt = 1 AND share_results.show_prompt = 0
                           THEN datetime('now') ELSE share_results.created_at END`,
    )
    .bind(`share-${submissionId}`, submissionId, showPrompt ? 1 : 0)
    .run();
}

export interface LeaderboardRow {
  rank: number;
  uid: string;
  displayName: string | null;
  avatarUrl: string | null;
  completed: number;
  totalScore: number;
  promptChars: number;
  attempts: number;
  /** Passes per difficulty level, 1 (Beginner) to 5 (Expert). */
  passedByLevel: Record<number, number>;
}

function toRow(s: RankedStanding): LeaderboardRow {
  return {
    rank: s.rank,
    uid: s.uid,
    displayName: s.displayName,
    avatarUrl: s.avatarUrl,
    completed: s.completed,
    totalScore: s.totalScore,
    promptChars: s.promptChars,
    attempts: s.attempts,
    passedByLevel: s.passedAt,
  };
}

/** The top of the board. See `ranking.ts` for the order and who is on it. */
export async function leaderboard(db: D1Database, limit: number, levels: Levels): Promise<LeaderboardRow[]> {
  return (await rankedPlayers(db, levels)).slice(0, limit).map(toRow);
}

/** One player's standing, so someone outside the top N still sees where they are.
 *  Null for a guest, or anyone who has not passed anything yet. */
export async function rankFor(db: D1Database, uid: string, levels: Levels): Promise<LeaderboardRow | null> {
  const found = (await rankedPlayers(db, levels)).find((s) => s.uid === uid);
  return found ? toRow(found) : null;
}

/** The board, the viewer's own row, and the player count, from one ranking pass. */
export async function boardFor(
  db: D1Database,
  levels: Levels,
  limit: number,
  uid?: string,
): Promise<{ board: LeaderboardRow[]; you: LeaderboardRow | null; total: number }> {
  const ranked = await rankedPlayers(db, levels);
  const mine = uid ? ranked.find((s) => s.uid === uid) : undefined;
  return { board: ranked.slice(0, limit).map(toRow), you: mine ? toRow(mine) : null, total: ranked.length };
}

/** How many players are on the board, so the page knows whether a "show all" is
 *  worth offering. */
export async function playerCount(db: D1Database, levels: Levels): Promise<number> {
  return (await rankedPlayers(db, levels)).length;
}

/** Which challenges this user has cleared, for the progress strip. */
export interface ChallengeProgress {
  challengeId: string;
  /** Best leaderboard-eligible score, 0-100. */
  bestScore: number;
  passed: boolean;
  /** When they first passed — the date a player thinks of as "completed". */
  passedAt: string | null;
  /** When their best score was last improved. */
  updatedAt: string;
}

/** Every challenge this player has a banked score on, passed or not.
 *
 *  `passedAt` is the first eligible passing submission, which is what
 *  "completed on" means to a player: later improvements do not move it. It falls
 *  back to `best_scores.updated_at` because a deduped run banks a score without
 *  writing a submission row of its own — the player passed, but the matching
 *  submission belongs to whoever first ran that prompt. */
export async function progressDetailFor(db: D1Database, uid: string): Promise<ChallengeProgress[]> {
  const { results } = await db
    .prepare(
      `SELECT b.challenge_id, b.score, b.passed, b.updated_at,
              (SELECT MIN(s.created_at) FROM submissions s
                WHERE s.uid = b.uid AND s.challenge_id = b.challenge_id
                  AND s.passed = 1 AND s.leaderboard_eligible = 1) AS first_passed_at
       FROM best_scores b
       WHERE b.uid = ?`,
    )
    .bind(uid)
    .all<{
      challenge_id: string;
      score: number;
      passed: number;
      updated_at: string;
      first_passed_at: string | null;
    }>();

  return (results ?? []).map((r) => ({
    challengeId: r.challenge_id,
    bestScore: r.score,
    passed: r.passed === 1,
    passedAt: r.passed === 1 ? (r.first_passed_at ?? r.updated_at) : null,
    updatedAt: r.updated_at,
  }));
}

export async function progressFor(db: D1Database, uid: string): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT challenge_id FROM best_scores WHERE uid = ? AND passed = 1')
    .bind(uid)
    .all<{ challenge_id: string }>();
  return (results ?? []).map((r) => r.challenge_id);
}

export async function upsertUser(
  db: D1Database,
  user: { uid: string; displayName?: string | null; avatarUrl?: string | null; isAnonymous: boolean },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (uid, display_name, avatar_url, is_anonymous)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(uid) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, users.display_name),
         avatar_url   = COALESCE(excluded.avatar_url, users.avatar_url),
         is_anonymous = excluded.is_anonymous`,
    )
    .bind(user.uid, user.displayName ?? null, user.avatarUrl ?? null, user.isAnonymous ? 1 : 0)
    .run();
}

export interface SharedEntry {
  id: string;
  challengeId: string;
  score: number;
  passed: boolean;
  promptChars: number;
  execModel: string;
  /** When the prompt was run. */
  runAt: string;
  /** When it was shared to the gallery. */
  sharedAt: string;
  playerName: string | null;
  avatarUrl: string | null;
  isYours: boolean;
  prompt: string | null;
  promptLocked: boolean;
}

/** The public gallery: every submission its author chose to share.
 *
 *  Only shipped challenges appear, and the caller narrows further by difficulty
 *  (as a set of ids) or to the viewer's own shares. Oldest share first by
 *  default, as asked; or highest score first, shortest prompt breaking ties. */
export async function sharedResults(
  db: D1Database,
  opts: { challengeIds: string[]; sort: 'oldest' | 'score'; mineOnly: boolean; viewer?: Viewer; limit: number },
): Promise<SharedEntry[]> {
  if (opts.challengeIds.length === 0) return [];
  if (opts.mineOnly && !opts.viewer) return [];

  const ids = opts.challengeIds.map(() => '?').join(', ');
  const order = opts.sort === 'score' ? 's.score DESC, s.prompt_chars ASC, sh.created_at ASC' : 'sh.created_at ASC';
  const { results } = await db
    .prepare(
      `SELECT s.id, s.challenge_id, s.score, s.passed, s.prompt_chars, s.exec_model, s.prompt_text,
              s.created_at AS run_at, sh.created_at AS shared_at, s.uid,
              u.display_name, u.avatar_url, u.is_anonymous
       FROM share_results sh
       JOIN submissions s ON s.id = sh.submission_id
       LEFT JOIN users u ON u.uid = s.uid
       WHERE sh.show_prompt = 1 AND s.challenge_id IN (${ids})
         ${opts.mineOnly ? 'AND s.uid = ?' : ''}
       ORDER BY ${order}
       LIMIT ?`,
    )
    .bind(...opts.challengeIds, ...(opts.mineOnly ? [opts.viewer!.uid] : []), opts.limit)
    .all<{
      id: string;
      challenge_id: string;
      score: number;
      passed: number;
      prompt_chars: number;
      exec_model: string;
      prompt_text: string;
      run_at: string;
      shared_at: string;
      uid: string | null;
      display_name: string | null;
      avatar_url: string | null;
      is_anonymous: number | null;
    }>();

  return (results ?? []).map((r) => {
    const isYours = Boolean(opts.viewer && r.uid === opts.viewer.uid);
    const unlocked = revealPrompt({ shared: true, isYours, viewerPassed: opts.viewer?.passed.has(r.challenge_id) ?? false });
    return {
      id: r.id,
      challengeId: r.challenge_id,
      score: r.score,
      passed: r.passed === 1,
      promptChars: r.prompt_chars,
      execModel: r.exec_model,
      runAt: r.run_at,
      sharedAt: r.shared_at,
      playerName: r.is_anonymous === 0 ? r.display_name : null,
      avatarUrl: r.is_anonymous === 0 ? r.avatar_url : null,
      isYours,
      prompt: unlocked ? r.prompt_text : null,
      promptLocked: !unlocked,
    };
  });
}
