-- Patient logins with two-factor, provider applications, staff invitations, and the admin console.

ALTER TABLE accounts ADD COLUMN phone TEXT;
ALTER TABLE accounts ADD COLUMN profile_json TEXT;          -- name, address, contact preferences
ALTER TABLE accounts ADD COLUMN mfa_type TEXT;              -- totp | sms | null (not set up yet)
ALTER TABLE accounts ADD COLUMN mfa_secret TEXT;            -- base32 shared secret for authenticator apps
ALTER TABLE accounts ADD COLUMN recovery_hashes TEXT;       -- JSON array of hashed one-time recovery codes
ALTER TABLE accounts ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN locked_until TEXT;
ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'active';   -- active | disabled
ALTER TABLE accounts ADD COLUMN last_login_at TEXT;

-- Short-lived email codes and half-finished sign-ins (step 1 done, second factor pending).
CREATE TABLE IF NOT EXISTS login_codes (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  purpose     TEXT NOT NULL,              -- signin | signup
  patient_id  TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes(email);

-- Tokens held between the email code and the second factor, and during account setup.
CREATE TABLE IF NOT EXISTS pending_logins (
  token_hash  TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  patient_id  TEXT,
  stage       TEXT NOT NULL,              -- mfa | setup
  data        TEXT,
  expires_at  TEXT NOT NULL
);

-- Sessions gain device details and an idle timer.
ALTER TABLE sessions ADD COLUMN user_agent TEXT;
ALTER TABLE sessions ADD COLUMN ip TEXT;
ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;

-- Staff details beyond what Cloudflare Access knows.
ALTER TABLE staff ADD COLUMN phone TEXT;
ALTER TABLE staff ADD COLUMN profile_json TEXT;             -- practice, licenses, malpractice, initials
ALTER TABLE staff ADD COLUMN invited_by TEXT;
ALTER TABLE staff ADD COLUMN invited_at TEXT;
ALTER TABLE staff ADD COLUMN accepted_at TEXT;

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_by  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
