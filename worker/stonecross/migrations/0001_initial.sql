-- Games results. The Worker is the only writer, as with PromptGym: a browser
-- can never post a result directly, only moves the Worker replays or plays.
--
-- Players are keyed by Firebase uid, the same uid PromptGym uses, so one person
-- is one account across the site. A guest's uid survives signing in with Google
-- (the account is linked), so a guest's games stay theirs.

CREATE TABLE IF NOT EXISTS players (
  uid          TEXT PRIMARY KEY,
  display_name TEXT,
  avatar_url   TEXT,
  is_anonymous INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per finished game.
CREATE TABLE IF NOT EXISTS games (
  id          TEXT PRIMARY KEY,          -- client id (vs system) or room game id (online)
  game        TEXT NOT NULL,             -- 'stonecross'
  mode        TEXT NOT NULL,             -- 'system' | 'online'
  level       TEXT,                      -- vs system: 'beginner' | 'intermediate' | 'difficult'
  room_code   TEXT,                      -- online only
  starter     INTEGER NOT NULL,          -- seat that moved first
  winner      TEXT NOT NULL,             -- '0' | '1' | 'draw'
  reason      TEXT,                      -- 'banked' | 'outnumbered' | 'blocked'
  plies       INTEGER NOT NULL,
  moves_json  TEXT NOT NULL,             -- [[from, to], ...] so any game can be replayed
  finished_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Who played: one row per account in the game (vs system: just the player).
CREATE TABLE IF NOT EXISTS game_players (
  game_id TEXT NOT NULL,
  uid     TEXT NOT NULL,
  seat    INTEGER NOT NULL,              -- 0 = Ivory, 1 = Onyx
  result  TEXT NOT NULL,                 -- 'win' | 'loss' | 'draw'
  PRIMARY KEY (game_id, seat),
  FOREIGN KEY (game_id) REFERENCES games(id),
  FOREIGN KEY (uid) REFERENCES players(uid)
);

CREATE INDEX IF NOT EXISTS idx_game_players_uid ON game_players(uid);
CREATE INDEX IF NOT EXISTS idx_games_finished ON games(finished_at);
