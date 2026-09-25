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
