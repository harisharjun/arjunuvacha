-- PromptGym schema. The Worker is the only writer: keeping scores server-side is
-- the whole reason this is D1 rather than Firestore with client-side rules.

CREATE TABLE IF NOT EXISTS users (
  uid          TEXT PRIMARY KEY,
  display_name TEXT,
  avatar_url   TEXT,
  is_anonymous INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS submissions (
  id                  TEXT PRIMARY KEY,
  uid                 TEXT,
  challenge_id        TEXT NOT NULL,
  exec_model          TEXT NOT NULL,
  prompt_text         TEXT NOT NULL,
  prompt_chars        INTEGER NOT NULL,
  prompt_tokens       INTEGER NOT NULL DEFAULT 0,
  score               INTEGER NOT NULL,
  base_score          INTEGER NOT NULL DEFAULT 0,
  efficiency_bonus    INTEGER NOT NULL DEFAULT 0,
  passed              INTEGER NOT NULL DEFAULT 0,
  -- A run containing any errored grader is excluded from best_scores: an
  -- infrastructure blip must never bank a score, in either direction.
  leaderboard_eligible INTEGER NOT NULL DEFAULT 0,
  grader_results_json TEXT NOT NULL,
  byo_key_used        INTEGER NOT NULL DEFAULT 0,
  -- SHA-256 of challenge_id + "\n" + prompt + "\n" + exec_model. Everything runs
  -- at temperature 0, so an identical submission is genuinely the same run and
  -- replaying the stored grading is honest rather than a shortcut.
  prompt_hash         TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (uid) REFERENCES users(uid)
);

-- What makes dedupe a lookup rather than a re-run.
CREATE INDEX IF NOT EXISTS idx_submissions_hash ON submissions(prompt_hash);
CREATE INDEX IF NOT EXISTS idx_submissions_uid_challenge ON submissions(uid, challenge_id);

CREATE TABLE IF NOT EXISTS best_scores (
  uid           TEXT NOT NULL,
  challenge_id  TEXT NOT NULL,
  score         INTEGER NOT NULL,
  passed        INTEGER NOT NULL DEFAULT 0,
  submission_id TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (uid, challenge_id),
  FOREIGN KEY (uid) REFERENCES users(uid),
  FOREIGN KEY (submission_id) REFERENCES submissions(id)
);

-- The leaderboard is one query over this table: count of passed challenges
-- descending, tie-broken by total score. No separate table to keep in sync.
CREATE INDEX IF NOT EXISTS idx_best_scores_uid ON best_scores(uid);

CREATE TABLE IF NOT EXISTS share_results (
  id            TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  show_prompt   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (submission_id) REFERENCES submissions(id)
);
