-- Paperfold progress, by the same Firebase uid as the rest of the site. This is
-- everything the game keeps in a player's browser: which levels are solved and
-- whether each was perfect, the last level open, and the sound setting. Individual
-- folds are not kept, here or in the browser.
--
-- Levels are numbered from 0, in the order of static/games/paperfold/levels.js, so
-- reordering that list would shift what these rows mean.

CREATE TABLE IF NOT EXISTS paperfold_progress (
  uid             TEXT NOT NULL,
  level           INTEGER NOT NULL,
  perfect         INTEGER NOT NULL DEFAULT 0,
  first_saved_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (uid, level),
  FOREIGN KEY (uid) REFERENCES players(uid)
);

CREATE TABLE IF NOT EXISTS paperfold_state (
  uid         TEXT PRIMARY KEY,
  last_level  INTEGER,
  sound       TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (uid) REFERENCES players(uid)
);
