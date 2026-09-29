// Shared helpers for the DeliverMyMedications Worker.

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const httpErr = (status, message) => new HttpError(status, message);

const SEC_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin"
};
export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...SEC_HEADERS, ...headers } });
}
export async function readJson(req, maxBytes = 1_500_000) {
  const len = Number(req.headers.get("Content-Length") || 0);
  if (len > maxBytes) throw httpErr(413, "Request too large");
  const text = await req.text();
  if (text.length > maxBytes) throw httpErr(413, "Request too large");
  try { return text ? JSON.parse(text) : {}; } catch { throw httpErr(400, "Invalid JSON"); }
}

export const nowISO = () => new Date().toISOString();
export const uid = (n = 12) => [...crypto.getRandomValues(new Uint8Array(n))].map(b => (b % 36).toString(36)).join("");
export const token = (bytes = 24) => [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
export async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function getCookie(req, name) {
  const c = req.headers.get("Cookie") || "";
  for (const part of c.split(/;\s*/)) { const i = part.indexOf("="); if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1)); }
  return null;
}
export function sessionCookie(value, maxAgeSec) {
  return `dmm_sess=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export const clientIp = req => req.headers.get("CF-Connecting-IP") || "unknown";

// Simple fixed-window rate limit backed by D1. Also add a Cloudflare WAF rate-limiting rule for /api/auth/* and /api/links/*.
export async function rateLimit(env, key, limit, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare("SELECT count, window_start FROM rate_limits WHERE key=?").bind(key).first();
  if (!row || now - row.window_start >= windowSec) {
    await env.DB.prepare("INSERT INTO rate_limits (key,count,window_start) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=1, window_start=excluded.window_start").bind(key, now).run();
    return;
  }
  if (row.count >= limit) throw httpErr(429, "Too many attempts. Please wait a few minutes and try again.");
  await env.DB.prepare("UPDATE rate_limits SET count=count+1 WHERE key=?").bind(key).run();
}

/* ---------- Records ---------- */
export const KINDS = ["orders", "fills", "notes", "links", "tasks", "alerts", "breaches", "patients", "rxOnFile", "shipments", "tickets", "applications", "products", "payouts", "leads", "carts", "promos", "consents"];

export async function getRecords(env, keys) {
  const out = new Map();
  const byKind = {};
  for (const { kind, id } of keys) (byKind[kind] = byKind[kind] || new Set()).add(id);
  for (const [kind, ids] of Object.entries(byKind)) {
    const list = [...ids];
    for (let i = 0; i < list.length; i += 50) {
      const chunk = list.slice(i, i + 50);
      const { results } = await env.DB.prepare(`SELECT kind,id,patient_id,version,data FROM records WHERE kind=? AND id IN (${chunk.map(() => "?").join(",")})`).bind(kind, ...chunk).all();
      for (const r of results) out.set(`${r.kind}:${r.id}`, { ...r, data: JSON.parse(r.data) });
    }
  }
  return out;
}
export async function getRecord(env, kind, id) {
  const r = await env.DB.prepare("SELECT kind,id,patient_id,version,data FROM records WHERE kind=? AND id=?").bind(kind, id).first();
  return r ? { ...r, data: JSON.parse(r.data) } : null;
}
export async function findByLookup(env, kind, lookup) {
  const { results } = await env.DB.prepare("SELECT kind,id,patient_id,version,data FROM records WHERE kind=? AND lookup=?").bind(kind, lookup).all();
  return results.map(r => ({ ...r, data: JSON.parse(r.data) }));
}
export function lookupFor(kind, data) {
  if (kind === "patients") return data.token || null;
  if (kind === "links") return data.token || null;
  if (kind === "fills") return data.tracking || null;
  return null;
}

// Writes are one transaction. A guard statement aborts the whole batch if any record changed since it was read.
export function guardStmt(env, kind, id, version) {
  return env.DB.prepare("SELECT CASE WHEN (SELECT version FROM records WHERE kind=? AND id=?) = ? THEN 1 ELSE json('version conflict') END").bind(kind, id, version);
}
export function upsertStmt(env, rec, existing) {
  const data = JSON.stringify(rec.data);
  const lookup = lookupFor(rec.kind, rec.data);
  if (!existing) {
    return env.DB.prepare("INSERT INTO records (kind,id,patient_id,lookup,version,data) VALUES (?,?,?,?,1,?)").bind(rec.kind, rec.id, rec.patientId ?? null, lookup, data);
  }
  return env.DB.prepare("UPDATE records SET data=?, patient_id=?, lookup=?, version=version+1, updated_at=datetime('now') WHERE kind=? AND id=?")
    .bind(data, rec.patientId ?? existing.patient_id ?? null, lookup, rec.kind, rec.id);
}
// For server-side edits (cron, webhooks): read, change, write with the version guard.
export async function updateRecord(env, kind, id, fn) {
  for (let i = 0; i < 3; i++) {
    const r = await getRecord(env, kind, id);
    if (!r) return null;
    const next = structuredClone(r.data);
    if (fn(next) === false) return r;
    try {
      await env.DB.batch([guardStmt(env, kind, id, r.version), upsertStmt(env, { kind, id, data: next, patientId: r.patient_id }, r)]);
      return { ...r, data: next, version: r.version + 1 };
    } catch (e) { if (!/version conflict|malformed JSON/i.test(String(e))) throw e; }
  }
  throw httpErr(409, "Busy, try again");
}
export async function insertRecord(env, kind, data, patientId) {
  await env.DB.prepare("INSERT INTO records (kind,id,patient_id,lookup,version,data) VALUES (?,?,?,?,1,?)")
    .bind(kind, data.id, patientId ?? null, lookupFor(kind, data), JSON.stringify(data)).run();
}

export function audit(env, actor, role, action, kind, recordId, detail, ip) {
  return env.DB.prepare("INSERT INTO audit_log (actor,role,action,kind,record_id,detail,ip) VALUES (?,?,?,?,?,?,?)")
    .bind(actor, role, action, kind ?? null, recordId ?? null, detail == null ? null : String(detail).slice(0, 500), ip ?? null);
}

/* ---------- Messages ---------- */
// Email through Resend (sign their BAA or use a HIPAA-eligible provider). Never put drug names in subject lines or texts.
export async function sendEmail(env, to, subject, text) {
  if (!to) return false;
  if (env.SES?.send) return env.SES.send(to, subject, text);        // AWS deployment uses SES
  if (!env.RESEND_API_KEY) { console.log(`[email not sent: no mail transport] to=${to} subject=${subject}`); return false; }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM || "DeliverMyMedications <no-reply@delivermymedications.com>", to: [to], subject, text })
  });
  if (!r.ok) console.log("email failed", r.status, await r.text());
  return r.ok;
}
export async function sendText(env, to, body) {
  const digits = String(to || "").replace(/\D/g, "");
  if (env.SMS?.send && digits.length === 10) return env.SMS.send(`+1${digits}`, body);   // AWS: Pinpoint/SNS
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM || digits.length !== 10) { console.log(`[text not sent] to=${digits.slice(-4)}`); return false; }
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: `+1${digits}`, From: env.TWILIO_FROM, Body: body })
  });
  if (!r.ok) console.log("text failed", r.status);
  return r.ok;
}

/* ---------- Stripe (REST, no SDK) ---------- */
function form(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v, key, out); else out.append(key, String(v));
  }
  return out;
}
export async function stripe(env, method, path, params, idempotencyKey) {
  if (!env.STRIPE_SECRET_KEY) throw httpErr(500, "Payments aren't configured (STRIPE_SECRET_KEY)");
  const headers = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };
  if (params) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const r = await fetch(`https://api.stripe.com/v1/${path}`, { method, headers, body: params ? form(params) : undefined });
  const j = await r.json();
  if (!r.ok) {
    const e = httpErr(r.status === 402 ? 402 : 502, j.error?.message || "Payment error");
    e.stripe = j.error; throw e;
  }
  return j;
}
export async function verifyStripeSignature(env, payload, header) {
  if (!env.STRIPE_WEBHOOK_SECRET || !header) return false;
  const parts = Object.fromEntries(header.split(",").map(p => p.split("=")));
  const t = parts.t, sig = parts.v1;
  if (!t || !sig || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(hex, sig);
}

/* ---------- Eastern time and business hours (Mon–Fri 9–5 ET) ---------- */
export function etParts(d) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" }).formatToParts(d);
  const g = k => p.find(x => x.type === k).value;
  return { y: +g("year"), m: +g("month"), d: +g("day"), h: +g("hour") % 24, min: +g("minute"), wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(g("weekday")) };
}
export function etDate(y, m, d, h) {
  const guess = new Date(Date.UTC(y, m - 1, d, h + 5));
  const p = etParts(guess);
  return new Date(guess.getTime() - ((p.h - h) * 60 + p.min) * 60000);
}
export function nextOpen(from) {
  let t = new Date(from);
  for (let i = 0; i < 10; i++) {
    const p = etParts(t);
    if (p.wd >= 1 && p.wd <= 5) { const o = etDate(p.y, p.m, p.d, 9), c = etDate(p.y, p.m, p.d, 17); if (t < o) return o; if (t < c) return t; }
    const n = etParts(new Date(t.getTime() + 86400000)); t = etDate(n.y, n.m, n.d, 0);
  }
  return new Date(from);
}
export const etYmd = d => { const p = etParts(d); return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`; };
