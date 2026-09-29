-- Generated from migrations/0001–0003 for PostgreSQL 15+.
-- Apply once: psql "$DATABASE_URL" -f aws/schema-postgres.sql
-- Differences from the SQLite version: JSON columns are JSONB, timestamps are TIMESTAMPTZ,
-- and the audit id is an identity column. Everything else keeps the same names, so application
-- queries port with the small dialect shim in src/db/postgres.js.

-- DeliverMyMedications: PostgreSQL schema (Amazon Aurora / RDS).
-- Clinical and pharmacy data is stored as versioned JSON records (one row per order, fill, note, Rx on file, ...).
-- Every write is checked by the Worker (role, ownership, protected fields, prices) and recorded in audit_log.
-- This database holds PHI. Deploy it only inside the private VPC described in aws/README.md, under a signed BAA.

CREATE TABLE IF NOT EXISTS records (
  kind        TEXT NOT NULL,            -- orders | fills | notes | links | tasks | alerts | breaches | patients | rxOnFile | shipments
  id          TEXT NOT NULL,
  patient_id  TEXT,                     -- owner, used to scope what a patient can read and write
  lookup      TEXT,                     -- secondary key (patient link token, tracking number)
  version     INTEGER NOT NULL DEFAULT 1,
  data        JSONB NOT NULL,            -- JSON
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS idx_records_patient ON records(patient_id, kind);
CREATE INDEX IF NOT EXISTS idx_records_lookup  ON records(kind, lookup);
CREATE INDEX IF NOT EXISTS idx_records_updated ON records(kind, updated_at);

-- Staff sign in through Cloudflare Access; this table says what each email may do.
CREATE TABLE IF NOT EXISTS staff (
  email       TEXT PRIMARY KEY,         -- lower case, must match the Cloudflare Access identity
  name        TEXT NOT NULL,            -- providers: exactly as it should appear on prescriptions
  role        TEXT NOT NULL CHECK (role IN ('provider','pharmacist','technician','admin')),
  npi         TEXT,
  states      TEXT,                     -- providers: JSON array of license states, e.g. ["NY","NJ"]
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Patient accounts (login identity). The clinical patient record lives in records(kind='patients').
CREATE TABLE IF NOT EXISTS accounts (
  patient_id  TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,     -- lower case
  dob         TEXT NOT NULL,            -- MM/DD/YYYY
  stripe_customer_id TEXT,
  stripe_payment_method TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  patient_id  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_patient ON sessions(patient_id);

CREATE TABLE IF NOT EXISTS magic_links (
  token_hash  TEXT PRIMARY KEY,
  patient_id  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);

-- Payment intents created by the server, so an order can only use an amount the server computed.
CREATE TABLE IF NOT EXISTS payment_intents (
  id          TEXT PRIMARY KEY,         -- Stripe PaymentIntent id (or test_... in PAYMENT_MODE=test)
  purpose     TEXT NOT NULL,            -- cart | link
  amount      INTEGER NOT NULL,         -- cents
  patient_id  TEXT,
  email       TEXT,
  details     TEXT,                     -- JSON of what was priced
  status      TEXT NOT NULL,            -- created | used | captured | canceled
  order_id    TEXT,
  captured    INTEGER NOT NULL DEFAULT 0,
  refunded    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS charges (      -- off-session refill and renewal charges
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL,
  line_id     TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  stripe_id   TEXT,
  status      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key         TEXT PRIMARY KEY,
  count       INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor       TEXT NOT NULL,
  role        TEXT NOT NULL,
  action      TEXT NOT NULL,
  kind        TEXT,
  record_id   TEXT,
  detail      TEXT,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_record ON audit_log(kind, record_id);

-- Patient logins with two-factor, provider applications, staff invitations, and the admin console.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS profile_json TEXT;          -- name, address, contact preferences
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS mfa_type TEXT;              -- totp | sms | null (not set up yet)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS mfa_secret TEXT;            -- base32 shared secret for authenticator apps
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS recovery_hashes TEXT;       -- JSON array of hashed one-time recovery codes
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS locked_until TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';   -- active | disabled
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_login_at TEXT;

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
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
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
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at TEXT;

-- Staff details beyond what Cloudflare Access knows.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS profile_json TEXT;             -- practice, licenses, malpractice, initials
ALTER TABLE staff ADD COLUMN IF NOT EXISTS invited_by TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS invited_at TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS accepted_at TEXT;

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff_sessions (
  token_hash  TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  user_agent  TEXT,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_staff_sessions_email ON staff_sessions(email);
ALTER TABLE staff ADD COLUMN IF NOT EXISTS mfa_secret TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS mfa_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS recovery_hashes TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS last_login_at TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS google_sub TEXT;

-- Helpful indexes for the queries the application actually runs.
CREATE INDEX IF NOT EXISTS idx_records_data_order   ON records ((data->>'orderId')) WHERE kind = 'fills';
CREATE INDEX IF NOT EXISTS idx_records_data_stage   ON records ((data->>'stage'))   WHERE kind = 'fills';
CREATE INDEX IF NOT EXISTS idx_records_data_status  ON records ((data->>'status'));
CREATE INDEX IF NOT EXISTS idx_records_data_email   ON records ((data->>'email'))   WHERE kind = 'patients';
CREATE INDEX IF NOT EXISTS idx_audit_at             ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_intents_order ON payment_intents (order_id);

-- Least privilege: the application connects as a role that can read and write rows but not change schema.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dmm_app') THEN
    CREATE ROLE dmm_app LOGIN;
  END IF;
END
$$;
GRANT CONNECT ON DATABASE CURRENT_CATALOG TO dmm_app;
GRANT USAGE ON SCHEMA public TO dmm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dmm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dmm_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dmm_app;

-- Audit rows are append-only: no updates, no deletes, even for the application role.
REVOKE UPDATE, DELETE ON audit_log FROM dmm_app;
