-- How hard each Paperfold level is in practice: the most moves plus undos a player
-- made in any one attempt at it. Kept apart from paperfold_progress because it
-- counts attempts that never finished too, which is where a level is hardest.
CREATE TABLE IF NOT EXISTS paperfold_effort (
  uid         TEXT NOT NULL,
  level       INTEGER NOT NULL,
  max_actions INTEGER NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (uid, level),
  FOREIGN KEY (uid) REFERENCES players(uid)
);
