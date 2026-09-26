-- Feedback from signed-in players. Stored before anyone is notified, so a message
-- survives an email provider having a bad day: `notified` says whether the email
-- went out, and a row with 0 is one to read here instead.
--
-- The email address is kept so a reply is possible even when the notification
-- failed. It comes from the player's verified Google token, never from the form.

CREATE TABLE IF NOT EXISTS feedback (
  id           TEXT PRIMARY KEY,
  uid          TEXT NOT NULL,
  email        TEXT,
  display_name TEXT,
  message      TEXT NOT NULL,
  -- Where they were when they wrote it, e.g. /prompt-gym/c/pg-a1. Checked against
  -- the site's own paths before it is stored, so it is context rather than input.
  page         TEXT,
  challenge_id TEXT,
  notified     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
