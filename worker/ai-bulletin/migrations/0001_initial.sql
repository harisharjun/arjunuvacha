-- AI Bulletin — one edition a day, and the record of how it was judged.
--
-- The shape here is deliberately producer-agnostic. Editions arrive from a
-- Claude cloud routine today and from a coded pipeline later (see
-- projects/ai-bulletin/ai-bulletin-design-doc.md §Build order); both POST the
-- same JSON to /ingest/edition, so neither this schema nor the page changes
-- when the producer is swapped.
--
-- `cards` duplicates what is already inside editions.payload_json, on purpose.
-- The payload is what the page renders; the rows are what the eval set is made
-- of. A labelled set that needs JSON parsed out of a blob before it can be
-- queried is a labelled set nobody queries.

CREATE TABLE IF NOT EXISTS editions (
  date          TEXT PRIMARY KEY,          -- YYYY-MM-DD, the edition's own date
  published_at  TEXT NOT NULL DEFAULT (datetime('now')),
  through_line  TEXT,                      -- 2-3 sentences: what the day was about
  quiet_day     INTEGER NOT NULL DEFAULT 0,
  -- 0 when the producer could not get model judgment and fell back to its own
  -- ranking. The page says so rather than passing it off as a full edition.
  llm_enriched  INTEGER NOT NULL DEFAULT 1,
  producer      TEXT,                      -- 'claude-routine' | 'pipeline'
  model         TEXT,
  -- Counts the producer reports: sources tried, items seen, stories considered,
  -- quotas it could not fill. The honest record of what was looked at.
  stats_json    TEXT,
  payload_json  TEXT NOT NULL,             -- the whole edition, as the page reads it
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cards (
  id            TEXT PRIMARY KEY,          -- <date>:<idx>
  edition_date  TEXT NOT NULL,
  idx           INTEGER NOT NULL,
  kind          TEXT NOT NULL,             -- 'lead' | 'card' | 'note'
  headline      TEXT NOT NULL,
  source_name   TEXT,
  source_url    TEXT,
  source_tier   TEXT,
  -- 1-10 against the rubric in the design doc, and the separate 0-3 penalty for
  -- "announcement about a future thing" rather than a thing that happened.
  significance  INTEGER,
  hype_discount INTEGER,
  category      TEXT,
  region        TEXT,
  why_it_matters TEXT,
  thread_slug   TEXT,
  corroboration INTEGER,                   -- how many outlets had it
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (edition_date) REFERENCES editions(date) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cards_by_edition ON cards (edition_date, idx);
CREATE INDEX IF NOT EXISTS cards_by_thread  ON cards (thread_slug);
CREATE INDEX IF NOT EXISTS cards_by_region  ON cards (region);

-- Storylines, so a development is framed as a development and a story covered
-- two days ago has to clear a higher bar to come back. Written by the producer,
-- which reads this table (via GET /bulletin/threads) before it curates.
CREATE TABLE IF NOT EXISTS threads (
  slug        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
  n_items     INTEGER NOT NULL DEFAULT 1
);

-- Thumbs. Anonymous visitors are counted by the browser id the page generates;
-- signed-in ones by their Firebase uid, the same uid the games and PromptGym
-- use. One vote per card per voter, changeable.
CREATE TABLE IF NOT EXISTS feedback (
  card_id     TEXT NOT NULL,
  voter       TEXT NOT NULL,               -- 'uid:<uid>' or 'anon:<browser id>'
  vote        INTEGER NOT NULL,            -- +1 | -1
  uid         TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (card_id, voter)
);

CREATE INDEX IF NOT EXISTS feedback_by_card ON feedback (card_id);

-- "What did I miss?" Each entry is a story the bulletin failed to surface.
-- `diagnosis` is filled in later, by hand today and by the pipeline once it has
-- a record of what it cut: never_ingested | low_prior | low_llm_score |
-- quota_dropped. Four entirely different fixes, which is the whole point of
-- writing them down.
CREATE TABLE IF NOT EXISTS regret (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  edition_date  TEXT,
  text          TEXT NOT NULL,
  url           TEXT,
  diagnosis     TEXT,
  uid           TEXT,
  voter         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS regret_by_date ON regret (edition_date);
