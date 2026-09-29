// Staff: Cloudflare Access (SSO + MFA) protects /staff/* and /api/staff/*. The Worker verifies the Access JWT
// and looks the email up in the staff table.
// Patients: a session cookie issued after checkout, a magic-link email, or a date-of-birth check on their Rx link.
import { httpErr, getCookie, sha256, token, sessionCookie } from "./lib.js";

let jwksCache = { at: 0, keys: [] };
const b64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));

async function accessKeys(env) {
  if (Date.now() - jwksCache.at < 3600_000 && jwksCache.keys.length) return jwksCache.keys;
  const r = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!r.ok) throw httpErr(503, "Couldn't reach Cloudflare Access");
  const { keys } = await r.json();
  jwksCache = { at: Date.now(), keys };
  return keys;
}

async function verifyAccessJwt(env, jwt) {
  const [h, p, s] = jwt.split(".");
  if (!h || !p || !s) throw httpErr(401, "Sign in required");
  const header = JSON.parse(new TextDecoder().decode(b64url(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64url(p)));
  const jwk = (await accessKeys(env)).find(k => k.kid === header.kid);
  if (!jwk || header.alg !== "RS256") throw httpErr(401, "Sign in required");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw httpErr(401, "Sign in required");
  const now = Date.now() / 1000;
  if (payload.exp < now || (payload.nbf && payload.nbf > now + 60)) throw httpErr(401, "Session expired, sign in again");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) throw httpErr(401, "Sign in required");
  if (payload.iss && payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) throw httpErr(401, "Sign in required");
  return String(payload.email || "").toLowerCase();
}

export async function staffAuth(req, env) {
  // Google sign-in first (if the site uses it), then Cloudflare Access.
  const { staffSession, googleEnabled } = await import("./google.js");
  const sess = await staffSession(req, env);
  if (sess) return sess;
  const mode = env.AUTH_MODE || (env.ACCESS_AUD ? "access" : "google");
  if (mode === "google") {
    if (!(env.ENVIRONMENT === "development" && env.DEV_STAFF_EMAIL)) throw httpErr(401, googleEnabled(env) ? "Sign in required" : "Staff sign-in isn't set up yet");
  }
  let email;
  if (env.ENVIRONMENT === "development" && env.DEV_STAFF_EMAIL) email = env.DEV_STAFF_EMAIL.toLowerCase();
  else {
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw httpErr(500, "Cloudflare Access isn't configured (ACCESS_TEAM_DOMAIN, ACCESS_AUD)");
    const jwt = req.headers.get("Cf-Access-Jwt-Assertion") || getCookie(req, "CF_Authorization");
    if (!jwt) throw httpErr(401, "Sign in required");
    email = await verifyAccessJwt(env, jwt);
  }
  return await loadStaff(env, email);
}

// The owner (OWNER_EMAIL) is the super admin: always active, always admin, and can never be locked out.
export async function loadStaff(env, email) {
  const owner = String(env.OWNER_EMAIL || "").toLowerCase();
  let row = await env.DB.prepare("SELECT email,name,role,npi,states FROM staff WHERE email=? AND active=1").bind(email).first();
  if (!row && email && email === owner) {
    await env.DB.prepare("INSERT INTO staff (email,name,role,active) VALUES (?,?,'admin',1) ON CONFLICT(email) DO UPDATE SET role='admin', active=1")
      .bind(owner, "Owner").run();
    row = await env.DB.prepare("SELECT email,name,role,npi,states FROM staff WHERE email=?").bind(owner).first();
  }
  if (!row) throw httpErr(403, `${email} isn't set up as staff. Ask an admin to add you.`);
  const isOwner = row.email === owner;
  return { kind: "staff", email: row.email, name: row.name, role: isOwner ? "admin" : row.role, owner: isOwner,
    npi: row.npi || "", states: row.states ? JSON.parse(row.states) : [] };
}

const SESSION_DAYS = 30;
export async function patientAuth(req, env) {
  const t = getCookie(req, "dmm_sess");
  if (!t) throw httpErr(401, "Please sign in");
  const row = await env.DB.prepare("SELECT patient_id FROM sessions WHERE token_hash=? AND expires_at > datetime('now')").bind(await sha256(t)).first();
  if (!row) throw httpErr(401, "Your session ended. Please sign in again.");
  const acct = await env.DB.prepare("SELECT patient_id,email,stripe_customer_id,stripe_payment_method FROM accounts WHERE patient_id=?").bind(row.patient_id).first();
  return { kind: "patient", patientId: row.patient_id, email: acct?.email || "", account: acct };
}
export async function optionalPatient(req, env) {
  try { return await patientAuth(req, env); } catch { return null; }
}

export async function startSession(env, patientId) {
  const t = token(32);
  await env.DB.prepare(`INSERT INTO sessions (token_hash,patient_id,expires_at) VALUES (?,?,datetime('now','+${SESSION_DAYS} days'))`).bind(await sha256(t), patientId).run();
  return sessionCookie(t, SESSION_DAYS * 86400);
}
export async function endSession(req, env) {
  const t = getCookie(req, "dmm_sess");
  if (t) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(t)).run();
  return sessionCookie("", 0);
}
