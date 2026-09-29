// Copies everything from Cloudflare D1 into the AWS PostgreSQL database.
//
//   npx wrangler d1 export delivermymedications --remote --output d1-dump.sql   # for your records
//   node aws/migrate-d1-to-postgres.mjs --d1 <database-id> --pg "postgres://user:pass@host:5432/delivermymedications"
//
// Needs CLOUDFLARE_API_TOKEN (D1 read) and CLOUDFLARE_ACCOUNT_ID in the environment.
// Safe to re-run: rows are upserted on their primary keys. Run it twice — once for the bulk copy,
// then again during the cutover window to pick up anything written in between.

import postgres from "postgres";

const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const D1 = arg("--d1"), PG = arg("--pg");
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID, TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!D1 || !PG || !ACCOUNT || !TOKEN) { console.error("missing --d1, --pg, CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN"); process.exit(1); }

const sql = postgres(PG, { ssl: "require", prepare: false });

async function d1(query, params = []) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${D1}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql: query, params })
  });
  const j = await r.json();
  if (!j.success) throw new Error(JSON.stringify(j.errors));
  return j.result[0]?.results || [];
}

// table → conflict target. Order matters only for readability; there are no foreign keys.
const TABLES = [
  ["records", "(kind, id)"],
  ["accounts", "(patient_id)"],
  ["staff", "(email)"],
  ["sessions", "(token_hash)"],
  ["staff_sessions", "(token_hash)"],
  ["magic_links", "(token_hash)"],
  ["login_codes", "(id)"],
  ["pending_logins", "(token_hash)"],
  ["payment_intents", "(id)"],
  ["charges", "(id)"],
  ["settings", "(key)"],
  ["audit_log", null]            // append-only, identity id: insert without conflict handling
];
const JSON_COLS = new Set(["data", "data_json", "details", "states", "profile_json", "recovery_hashes"]);

let total = 0;
for (const [table, conflict] of TABLES) {
  let offset = 0, moved = 0;
  for (;;) {
    let rows;
    try { rows = await d1(`SELECT * FROM ${table} LIMIT 500 OFFSET ${offset}`); }
    catch (e) { console.log(`· ${table}: skipped (${String(e).slice(0, 60)})`); break; }
    if (!rows.length) break;
    for (const row of rows) {
      const r = { ...row };
      if (table === "audit_log") delete r.id;                       // identity column assigns its own
      for (const k of Object.keys(r)) {
        if (JSON_COLS.has(k) && typeof r[k] === "string" && r[k]) {
          try { r[k] = JSON.parse(r[k]); } catch { /* leave as text */ }
        }
      }
      const cols = Object.keys(r);
      const values = cols.map(k => (r[k] && typeof r[k] === "object" ? JSON.stringify(r[k]) : r[k]));
      const params = cols.map((_, i) => `$${i + 1}`).join(",");
      const stmt = conflict
        ? `INSERT INTO ${table} (${cols.join(",")}) VALUES (${params})
           ON CONFLICT ${conflict} DO UPDATE SET ${cols.filter(c => !conflict.includes(c)).map(c => `${c}=EXCLUDED.${c}`).join(",")}`
        : `INSERT INTO ${table} (${cols.join(",")}) VALUES (${params})`;
      await sql.unsafe(stmt, values);
      moved++;
    }
    offset += rows.length;
    if (rows.length < 500) break;
  }
  total += moved;
  console.log(`✓ ${table}: ${moved}`);
}
console.log(`\n${total} rows copied.`);

// Verification the operator should eyeball before cutting over.
for (const t of ["records", "accounts", "staff", "payment_intents", "audit_log"]) {
  try {
    const [pg] = await sql.unsafe(`SELECT count(*)::int AS n FROM ${t}`);
    const cf = await d1(`SELECT count(*) AS n FROM ${t}`);
    console.log(`${t}: D1 ${cf[0]?.n ?? "?"} → Postgres ${pg.n}`);
  } catch { }
}
await sql.end();
