-- Թռիչք · initial schema (SQLite / libSQL / Turso)
-- History is change-only: fares_current holds the latest price per itinerary,
-- and triggers append a row to fare_observations only when a price is new or changes.

CREATE TABLE IF NOT EXISTS users (
  tg_id         INTEGER PRIMARY KEY,
  first_name    TEXT,
  username      TEXT,
  lang          TEXT NOT NULL DEFAULT 'hy',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_seen_at  TEXT
);

-- Latest known price per itinerary (any source). fare_key = 'origin|dest|dep|ret|airline|flight_number'
CREATE TABLE IF NOT EXISTS fares_current (
  fare_key          TEXT PRIMARY KEY,
  origin            TEXT NOT NULL,
  dest              TEXT NOT NULL,
  dep_date          TEXT NOT NULL,             -- YYYY-MM-DD, origin local date
  ret_date          TEXT,                      -- NULL for one-way
  price_usd         REAL NOT NULL,
  airline           TEXT,
  flight_number     TEXT,
  transfers         INTEGER,
  return_transfers  INTEGER,
  duration_min      INTEGER,
  link              TEXT,
  source            TEXT NOT NULL,
  market            TEXT,
  found_at          TEXT,                      -- when the source saw this price
  first_seen_at     TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cur_origin_dep  ON fares_current (origin, dep_date);
CREATE INDEX IF NOT EXISTS idx_cur_route       ON fares_current (origin, dest, dep_date, ret_date);
CREATE INDEX IF NOT EXISTS idx_cur_updated     ON fares_current (updated_at);

CREATE TABLE IF NOT EXISTS fare_observations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  fare_key      TEXT NOT NULL,
  origin        TEXT NOT NULL,
  dest          TEXT NOT NULL,
  dep_date      TEXT NOT NULL,
  ret_date      TEXT,
  price_usd     REAL NOT NULL,
  airline       TEXT,
  source        TEXT NOT NULL,
  observed_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_route ON fare_observations (origin, dest, dep_date, observed_at);
CREATE INDEX IF NOT EXISTS idx_obs_key   ON fare_observations (fare_key, observed_at);

CREATE TRIGGER IF NOT EXISTS trg_fares_insert AFTER INSERT ON fares_current
BEGIN
  INSERT INTO fare_observations (fare_key, origin, dest, dep_date, ret_date, price_usd, airline, source, observed_at)
  VALUES (NEW.fare_key, NEW.origin, NEW.dest, NEW.dep_date, NEW.ret_date, NEW.price_usd, NEW.airline, NEW.source, NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_fares_price_change AFTER UPDATE OF price_usd ON fares_current
WHEN OLD.price_usd <> NEW.price_usd
BEGIN
  INSERT INTO fare_observations (fare_key, origin, dest, dep_date, ret_date, price_usd, airline, source, observed_at)
  VALUES (NEW.fare_key, NEW.origin, NEW.dest, NEW.dep_date, NEW.ret_date, NEW.price_usd, NEW.airline, NEW.source, NEW.updated_at);
END;

-- One row per route, departure month and calendar day: the daily snapshot used for history charts and deal scoring.
CREATE TABLE IF NOT EXISTS route_daily_stats (
  origin      TEXT NOT NULL,
  dest        TEXT NOT NULL,
  dep_month   TEXT NOT NULL,                   -- YYYY-MM
  day         TEXT NOT NULL,                   -- YYYY-MM-DD (snapshot day)
  min_usd     REAL NOT NULL,
  median_usd  REAL NOT NULL,
  n_fares     INTEGER NOT NULL,
  PRIMARY KEY (origin, dest, dep_month, day)
);
CREATE INDEX IF NOT EXISTS idx_stats_day ON route_daily_stats (origin, dep_month, day);

CREATE TABLE IF NOT EXISTS deals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL CHECK (kind IN ('special', 'drop', 'cheapest')),
  origin         TEXT NOT NULL,
  dest           TEXT NOT NULL,
  dep_date       TEXT NOT NULL,
  ret_date       TEXT,
  price_usd      REAL NOT NULL,
  ref_usd        REAL,                         -- typical price the deal is compared against
  pct_below      INTEGER,                      -- % below ref_usd
  airline        TEXT,
  transfers      INTEGER,
  link           TEXT,
  source         TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  UNIQUE (kind, origin, dest, dep_date, ret_date)
);
CREATE INDEX IF NOT EXISTS idx_deals_live ON deals (origin, expires_at);

CREATE TABLE IF NOT EXISTS watches (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id                 INTEGER NOT NULL REFERENCES users (tg_id) ON DELETE CASCADE,
  origin                TEXT NOT NULL,
  dest                  TEXT NOT NULL,
  dep_date              TEXT NOT NULL,
  ret_date              TEXT,
  flex_days             INTEGER NOT NULL DEFAULT 0 CHECK (flex_days BETWEEN 0 AND 3),
  target_usd            REAL NOT NULL CHECK (target_usd > 0),
  active                INTEGER NOT NULL DEFAULT 1,
  last_price_usd        REAL,
  last_checked_at       TEXT,
  last_alert_price_usd  REAL,
  last_alert_at         TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_watches_user   ON watches (tg_id, active);
CREATE INDEX IF NOT EXISTS idx_watches_active ON watches (active, dep_date);

CREATE TABLE IF NOT EXISTS alerts_sent (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id       INTEGER NOT NULL REFERENCES watches (id) ON DELETE CASCADE,
  price_usd      REAL NOT NULL,
  sent_at        TEXT NOT NULL,
  tg_message_id  INTEGER
);

CREATE TABLE IF NOT EXISTS scrape_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job           TEXT NOT NULL,
  source        TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'degraded', 'failed')),
  requests      INTEGER NOT NULL DEFAULT 0,
  rows_seen     INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0,
  notes         TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_job ON scrape_runs (job, started_at);
