-- DeliverMyMedications: D1 schema.
-- Clinical and pharmacy data is stored as versioned JSON records (one row per order, fill, note, Rx on file, ...).
-- Every write is checked by the Worker (role, ownership, protected fields, prices) and recorded in audit_log.
-- D1 stores PHI: sign a BAA with Cloudflare before going live.

CREATE TABLE IF NOT EXISTS records (
  kind        TEXT NOT NULL,            -- orders | fills | notes | links | tasks | alerts | breaches | patients | rxOnFile | shipments
  id          TEXT NOT NULL,
  patient_id  TEXT,                     -- owner, used to scope what a patient can read and write
  lookup      TEXT,                     -- secondary key (patient link token, tracking number)
  version     INTEGER NOT NULL DEFAULT 1,
  data        TEXT NOT NULL,            -- JSON
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS idx_records_patient ON records(patient_id, kind);
CREATE INDEX IF NOT EXISTS idx_records_lookup  ON records(kind, lookup);
CREATE INDEX IF NOT EXISTS idx_records_updated ON records(kind, updated_at);

-- Staff sign in through Cloudflare Access; this table says what each email may do.
CREATE TABLE IF NOT EXISTS staff (
  email       TEXT PRIMARY KEY,         -- lower case, must match the Cloudflare Access identity
  name        TEXT NOT NULL,            -- providers: exactly as it should appear on prescriptions
  role        TEXT NOT NULL CHECK (role IN ('provider','pharmacist','technician','support','admin')),
  npi         TEXT,
  states      TEXT,                     -- providers: JSON array of license states, e.g. ["NY","NJ"]
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Patient accounts (login identity). The clinical patient record lives in records(kind='patients').
CREATE TABLE IF NOT EXISTS accounts (
  patient_id  TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,     -- lower case
  dob         TEXT NOT NULL,            -- MM/DD/YYYY
  stripe_customer_id TEXT,
  stripe_payment_method TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  patient_id  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
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
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS charges (      -- off-session refill and renewal charges
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL,
  line_id     TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  stripe_id   TEXT,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key         TEXT PRIMARY KEY,
  count       INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  actor       TEXT NOT NULL,
  role        TEXT NOT NULL,
  action      TEXT NOT NULL,
  kind        TEXT,
  record_id   TEXT,
  detail      TEXT,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_record ON audit_log(kind, record_id);
