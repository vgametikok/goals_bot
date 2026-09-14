-- MYGOALS D1 schema (users, calendars JSON blob, login codes)

CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  photo_url TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS calendars (
  telegram_id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_codes (
  code TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  user_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed_at INTEGER,
  authenticated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_login_codes_expires ON login_codes(expires_at);
