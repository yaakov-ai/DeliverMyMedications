// PostgreSQL adapter: lets the existing application code run against Amazon Aurora/RDS instead of D1.
//
// The app only uses a small slice of the D1 API — prepare().bind().first()/all()/run() and batch() —
// so this file re-implements that surface on top of a Postgres connection, with a shim that rewrites
// the handful of SQLite-only expressions the queries use. Everything else is plain SQL that both engines run.
//
// Usage in src/worker.js:
//   import { pgDatabase } from "./db/postgres.js";
//   const env2 = { ...env, DB: env.HYPERDRIVE ? pgDatabase(env.HYPERDRIVE.connectionString) : env.DB };
//
// Connections go through Cloudflare Hyperdrive (pooling + TLS) or, if the API runs on AWS Lambda,
// through RDS Proxy. Never put the connection string in code: it belongs in a secret.

import postgres from "postgres";   // npm i postgres

/* ---------- dialect shim ---------- */
// Only these patterns differ between the two engines in this codebase.
export function toPg(sql) {
  let out = sql;
  // datetime('now','+15 minutes') → now() + interval '15 minutes'
  out = out.replace(/datetime\(\s*'now'\s*,\s*'([+-])\s*(\d+)\s+(second|minute|hour|day|month|year)s?'\s*\)/gi,
    (_, sign, n, unit) => `(now() ${sign} interval '${n} ${unit}')`);
  out = out.replace(/date\(\s*'now'\s*,\s*'([+-])\s*(\d+)\s+(day|month|year)s?'\s*\)/gi,
    (_, sign, n, unit) => `((now() ${sign} interval '${n} ${unit}')::date)`);
  out = out.replace(/datetime\(\s*'now'\s*\)/gi, "now()");
  out = out.replace(/\bdate\(\s*'now'\s*\)/gi, "current_date");
  // json_extract(data,'$.orderId') → data->>'orderId'
  out = out.replace(/json_extract\(\s*([A-Za-z_][\w.]*)\s*,\s*'\$\.([A-Za-z0-9_]+)'\s*\)/gi, "$1->>'$2'");
  // json('anything') was a deliberate abort in SQLite; in Postgres divide by zero aborts the transaction.
  out = out.replace(/json\('[^']*'\)/gi, "(1/0)");
  // ? placeholders → $1, $2, … (skip ?? and quoted text)
  let i = 0;
  out = out.replace(/'(?:[^']|'')*'|\?/g, m => (m === "?" ? `$${++i}` : m));
  return out;
}

/* ---------- D1-shaped wrapper ---------- */
class Statement {
  constructor(sql, client) { this.sql = toPg(sql); this.client = client; this.params = []; }
  bind(...params) { this.params = params.map(v => (v === undefined ? null : v)); return this; }
  async all() { const rows = await this.client.unsafe(this.sql, this.params); return { results: [...rows], success: true, meta: { rows_read: rows.length } }; }
  async first(column) {
    const rows = await this.client.unsafe(this.sql, this.params);
    const row = rows[0];
    if (!row) return null;
    return column ? row[column] : row;
  }
  async run() { const res = await this.client.unsafe(this.sql, this.params); return { success: true, meta: { changes: res.count ?? 0 } }; }
  raw() { return this.all().then(r => r.results.map(x => Object.values(x))); }
}

export function pgDatabase(connectionString, opts = {}) {
  const client = postgres(connectionString, {
    max: opts.max ?? 5,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: opts.ssl ?? "require",        // TLS to the database is required for PHI in transit
    prepare: false,                     // required when a pooler is in front (Hyperdrive, RDS Proxy)
    types: { bigint: postgres.BigInt }
  });
  return {
    prepare(sql) { return new Statement(sql, client); },
    // D1's batch() is a transaction: same here, so the version guards still protect a commit.
    async batch(statements) {
      return client.begin(async tx => {
        const out = [];
        for (const st of statements) {
          const rows = await tx.unsafe(st.sql, st.params);
          out.push({ results: [...rows], success: true, meta: { changes: rows.count ?? rows.length ?? 0 } });
        }
        return out;
      });
    },
    async exec(sql) { await client.unsafe(toPg(sql)); return { count: 1 }; },
    close() { return client.end({ timeout: 5 }); },
    _client: client
  };
}

/* ---------- queries that need a human eye when porting ----------
   1. Health check: `SELECT 1 FROM <table> LIMIT 1` works on both; the table list in /api/health is fine.
   2. `INSERT ... ON CONFLICT(col) DO UPDATE SET x=excluded.x` — identical in Postgres.
   3. JSONB columns return objects, not strings. Where the code does JSON.parse(row.data), use
      `row.data` directly, or keep the columns TEXT if you'd rather not touch the application code.
      The schema ships them as JSONB because the indexes below depend on it; set PG_JSON_AS_TEXT=true
      to have this adapter stringify them on read:
*/
export const jsonAsText = row => {
  for (const k of ["data", "data_json", "details", "states", "profile_json", "recovery_hashes", "notes_json", "rx_numbers_json"]) {
    if (row && row[k] && typeof row[k] === "object") row[k] = JSON.stringify(row[k]);
  }
  return row;
};
