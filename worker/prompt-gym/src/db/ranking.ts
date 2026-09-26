/** Leaderboard ranking.
 *
 *  The order, as Arjun specified it on 26 Sep 2026:
 *
 *    1. More challenges passed at the highest difficulty, then the next level
 *       down, and so on — one Expert pass outranks any number of Beginner ones.
 *    2. Tied on every count: more points at the highest difficulty, then the next.
 *    3. Tied on points: fewer prompt characters in total, across passed challenges.
 *    4. Tied on that: fewer attempts it took to reach those scores.
 *
 *  Only signed-in players are ranked. A guest's progress is real and is kept, but
 *  the board is where names and photos are shown, and the nudge to sign in is how
 *  a guest gets onto it. Only shipped challenges count: a pass on something since
 *  withheld would otherwise rank a player on a card nobody can see.
 *
 *  Ranking happens here, in plain code, rather than in one clever ORDER BY. The
 *  rules are the product; they should read like the sentence above. */

/** challengeId -> difficulty, 1 (Beginner) to 5 (Expert). Built from the shipped
 *  catalogue by the caller, so this module never needs to know which ship. */
export type Levels = Record<string, number>;

export const LEVELS_HIGH_TO_LOW = [5, 4, 3, 2, 1] as const;

export interface Standing {
  uid: string;
  displayName: string | null;
  avatarUrl: string | null;
  /** Passes per difficulty level, indexed 1-5. */
  passedAt: Record<number, number>;
  /** Sum of best scores on passed challenges, per difficulty level. */
  pointsAt: Record<number, number>;
  completed: number;
  totalScore: number;
  promptChars: number;
  attempts: number;
}

export interface RankedStanding extends Standing {
  rank: number;
}

/** Negative when `a` ranks above `b`. Pure, so the rules are testable without a
 *  database. The uid is a last resort so the order is total and never flickers. */
export function compareStandings(a: Standing, b: Standing): number {
  for (const level of LEVELS_HIGH_TO_LOW) {
    const d = (b.passedAt[level] ?? 0) - (a.passedAt[level] ?? 0);
    if (d !== 0) return d;
  }
  for (const level of LEVELS_HIGH_TO_LOW) {
    const d = (b.pointsAt[level] ?? 0) - (a.pointsAt[level] ?? 0);
    if (d !== 0) return d;
  }
  if (a.promptChars !== b.promptChars) return a.promptChars - b.promptChars;
  if (a.attempts !== b.attempts) return a.attempts - b.attempts;
  return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
}

/** Every ranked player, best first. One query for the passes, the ordering in
 *  code. Fine for hundreds of players; past that, cache it or page it. */
export async function rankedPlayers(db: D1Database, levels: Levels): Promise<RankedStanding[]> {
  const ids = Object.keys(levels);
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(', ');
  const { results } = await db
    .prepare(
      `SELECT b.uid, b.challenge_id, b.score, u.display_name, u.avatar_url,
              COALESCE(s.prompt_chars, 0) AS prompt_chars,
              -- Attempts: this player's own runs on the challenge up to the run
              -- that set their best. A pass served from the dedupe cache has no
              -- run of its own, and still took one attempt.
              MAX(1, (SELECT COUNT(*) FROM submissions x
                       WHERE x.uid = b.uid AND x.challenge_id = b.challenge_id
                         AND x.created_at <= b.updated_at)) AS attempts
       FROM best_scores b
       JOIN users u ON u.uid = b.uid AND u.is_anonymous = 0
       LEFT JOIN submissions s ON s.id = b.submission_id
       WHERE b.passed = 1 AND b.challenge_id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<{
      uid: string;
      challenge_id: string;
      score: number;
      display_name: string | null;
      avatar_url: string | null;
      prompt_chars: number;
      attempts: number;
    }>();

  const byUid = new Map<string, Standing>();
  for (const row of results ?? []) {
    const level = levels[row.challenge_id];
    let s = byUid.get(row.uid);
    if (!s) {
      s = {
        uid: row.uid,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        passedAt: {},
        pointsAt: {},
        completed: 0,
        totalScore: 0,
        promptChars: 0,
        attempts: 0,
      };
      byUid.set(row.uid, s);
    }
    s.passedAt[level] = (s.passedAt[level] ?? 0) + 1;
    s.pointsAt[level] = (s.pointsAt[level] ?? 0) + row.score;
    s.completed += 1;
    s.totalScore += row.score;
    s.promptChars += row.prompt_chars;
    s.attempts += row.attempts;
  }

  return [...byUid.values()].sort(compareStandings).map((s, i) => ({ ...s, rank: i + 1 }));
}
