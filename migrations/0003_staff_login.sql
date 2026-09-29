CREATE TABLE IF NOT EXISTS staff_sessions (
  token_hash  TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  user_agent  TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_staff_sessions_email ON staff_sessions(email);
ALTER TABLE staff ADD COLUMN mfa_secret TEXT;
ALTER TABLE staff ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE staff ADD COLUMN recovery_hashes TEXT;
ALTER TABLE staff ADD COLUMN last_login_at TEXT;
ALTER TABLE staff ADD COLUMN google_sub TEXT;
