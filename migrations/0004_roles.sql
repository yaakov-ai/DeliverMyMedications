-- Adds the Customer service role. SQLite can't alter a CHECK constraint in place,
-- so the table is rebuilt with the same columns and the same data.
PRAGMA foreign_keys=off;
CREATE TABLE IF NOT EXISTS staff_new (
  email       TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('provider','pharmacist','technician','support','admin')),
  npi         TEXT,
  states      TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  phone       TEXT,
  profile_json TEXT,
  invited_by  TEXT,
  invited_at  TEXT,
  accepted_at TEXT,
  mfa_secret  TEXT,
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  recovery_hashes TEXT,
  last_login_at TEXT,
  google_sub  TEXT
);
INSERT OR IGNORE INTO staff_new
  SELECT email,name,role,npi,states,active,created_at,phone,profile_json,invited_by,invited_at,accepted_at,
         mfa_secret,mfa_enabled,recovery_hashes,last_login_at,google_sub FROM staff;
DROP TABLE staff;
ALTER TABLE staff_new RENAME TO staff;
PRAGMA foreign_keys=on;
