import type { RunResponse } from '../run';

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

export interface LeaderboardRow {
  rank: number;
  uid: string;
  displayName: string | null;
  isAnonymous: boolean;
  completed: number;
  totalScore: number;
}

/** The metric is challenges *completed* — a whole number, the easiest thing to
 *  read and to brag about — tie-broken by total score so partial progress counts
 *  for something without needing a second visible number.
 *
 *  `COUNT(*) FILTER` would be tidier but needs a recent SQLite; the CASE form
 *  means the query cannot break under us if D1's engine moves. */
const TOTALS = `
  SELECT b.uid AS uid,
         SUM(CASE WHEN b.passed = 1 THEN 1 ELSE 0 END) AS completed,
         SUM(b.score) AS total_score
  FROM best_scores b
  GROUP BY b.uid`;

export async function leaderboard(db: D1Database, limit: number): Promise<LeaderboardRow[]> {
  const { results } = await db
    .prepare(
      `WITH totals AS (${TOTALS})
       SELECT t.uid, t.completed, t.total_score, u.display_name, u.is_anonymous
       FROM totals t
       LEFT JOIN users u ON u.uid = t.uid
       ORDER BY t.completed DESC, t.total_score DESC, t.uid ASC
       LIMIT ?`,
    )
    .bind(limit)
    .all<{
      uid: string;
      completed: number;
      total_score: number;
      display_name: string | null;
      is_anonymous: number | null;
    }>();

  return (results ?? []).map((row, i) => ({
    rank: i + 1,
    uid: row.uid,
    displayName: row.display_name,
    // A row whose user has been deleted from Firebase still has a real score.
    // Treat it as anonymous rather than dropping it or crashing on the null.
    isAnonymous: row.is_anonymous !== 0,
    completed: row.completed ?? 0,
    totalScore: row.total_score ?? 0,
  }));
}

/** One user's standing, so someone outside the top N still sees where they are.
 *  Rank is "how many people are ahead of me, plus one", which matches the
 *  ordering above exactly — including the tie-break. */
export async function rankFor(db: D1Database, uid: string): Promise<LeaderboardRow | null> {
  const row = await db
    .prepare(
      `WITH totals AS (${TOTALS})
       SELECT t.uid, t.completed, t.total_score, u.display_name, u.is_anonymous,
              (SELECT COUNT(*) FROM totals o
                WHERE o.completed > t.completed
                   OR (o.completed = t.completed AND o.total_score > t.total_score)
                   OR (o.completed = t.completed AND o.total_score = t.total_score AND o.uid < t.uid)
              ) + 1 AS rank
       FROM totals t
       LEFT JOIN users u ON u.uid = t.uid
       WHERE t.uid = ?`,
    )
    .bind(uid)
    .first<{
      uid: string;
      completed: number;
      total_score: number;
      display_name: string | null;
      is_anonymous: number | null;
      rank: number;
    }>();

  if (!row) return null;
  return {
    rank: row.rank,
    uid: row.uid,
    displayName: row.display_name,
    isAnonymous: row.is_anonymous !== 0,
    completed: row.completed ?? 0,
    totalScore: row.total_score ?? 0,
  };
}

/** Which challenges this user has cleared, for the progress strip. */
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
