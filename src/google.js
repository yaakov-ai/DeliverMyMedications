// Staff sign-in with Google, with an authenticator app as the second factor.
// Works instead of Cloudflare Access (AUTH_MODE="google") or alongside it (AUTH_MODE="both").
// Google verifies the password and any Google 2-step; we then check the email is in the staff table
// and, when STAFF_MFA is on, ask for a 6-digit code from their authenticator app.
import { httpErr, json, readJson, token, sha256, clientIp, rateLimit, getCookie, audit, sendEmail } from "./lib.js";
import { randomSecret, verifyTotp, otpauthUrl, makeRecoveryCodes, useRecoveryCode } from "./totp.js";

const STAFF_DAYS = 1;                 // staff sessions are short; pharmacies share screens
const cookie = (value, maxAge) => `dmm_staff=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const base = env => (env.PUBLIC_URL || "").replace(/\/$/, "");
export const googleEnabled = env => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) && ["google", "both"].includes(env.AUTH_MODE || "google");

export async function staffSession(req, env) {
  const t = getCookie(req, "dmm_staff");
  if (!t) return null;
  const row = await env.DB.prepare("SELECT email FROM staff_sessions WHERE token_hash=? AND expires_at > datetime('now')").bind(await sha256(t)).first();
  if (!row) return null;
  const { loadStaff } = await import("./auth.js");
  let who; try { who = await loadStaff(env, row.email); } catch { return null; }
  await env.DB.prepare("UPDATE staff_sessions SET last_seen_at=datetime('now') WHERE token_hash=?").bind(await sha256(t)).run();
  return who;
}

async function startSession(env, req, email) {
  const t = token(32);
  await env.DB.prepare(`INSERT INTO staff_sessions (token_hash,email,expires_at,user_agent,ip,last_seen_at) VALUES (?,?,datetime('now','+${STAFF_DAYS} day'),?,?,datetime('now'))`)
    .bind(await sha256(t), email, (req.headers.get("User-Agent") || "").slice(0, 200), clientIp(req)).run();
  await env.DB.prepare("UPDATE staff SET last_login_at=datetime('now') WHERE email=?").bind(email).run();
  return cookie(t, STAFF_DAYS * 86400);
}
const safeTo = to => /^#\/[a-z0-9/_-]*$/i.test(to || "") ? to : "#/pharmacy";

export const googleRoutes = {
  // Where the "Sign in with Google" button sends people.
  "GET /auth/google/start": async (req, env, url) => {
    if (!googleEnabled(env)) throw httpErr(501, "Google sign-in isn't set up yet");
    const state = token(16);
    await env.DB.prepare("INSERT INTO pending_logins (token_hash,email,stage,data,expires_at) VALUES (?,?,'google',?,datetime('now','+15 minutes'))")
      .bind(await sha256(state), "", JSON.stringify({ to: safeTo(url.searchParams.get("to")) })).run();
    const p = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${base(env)}/auth/google/callback`, response_type: "code",
      scope: "openid email profile", state, prompt: "select_account", access_type: "online"
    });
    if (env.GOOGLE_HD) p.set("hd", env.GOOGLE_HD);   // limit the account picker to your Workspace domain
    return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${p}`, 302);
  },

  // Google sends the person back here with a one-time code.
  "GET /auth/google/callback": async (req, env, url) => {
    const code = url.searchParams.get("code"), state = url.searchParams.get("state");
    const deny = msg => new Response(null, { status: 302, headers: { Location: `${base(env) || url.origin}/#/staff-signin?e=${encodeURIComponent(msg)}` } });
    if (url.searchParams.get("error")) return deny("Sign-in was cancelled.");
    const row = await env.DB.prepare("SELECT data FROM pending_logins WHERE token_hash=? AND stage='google' AND expires_at > datetime('now')").bind(await sha256(String(state || ""))).first();
    if (!row || !code) return deny("That sign-in link expired. Try again.");
    await env.DB.prepare("DELETE FROM pending_logins WHERE token_hash=?").bind(await sha256(state)).run();
    const to = JSON.parse(row.data || "{}").to || "#/pharmacy";
    // Exchange the code with Google over TLS; the id_token comes straight from Google, so we read it directly.
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: `${base(env)}/auth/google/callback`, grant_type: "authorization_code" })
    });
    const tok = await r.json();
    if (!r.ok || !tok.id_token) return deny("Google couldn't confirm that sign-in.");
    const claims = JSON.parse(atob(tok.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/") + "=="));
    if (claims.aud !== env.GOOGLE_CLIENT_ID || !claims.email_verified) return deny("That Google account can't be used here.");
    if (env.GOOGLE_HD && claims.hd !== env.GOOGLE_HD) return deny(`Use your ${env.GOOGLE_HD} account.`);
    const email = String(claims.email).toLowerCase();
    if (email === String(env.OWNER_EMAIL || "").toLowerCase()) {
      const { loadStaff } = await import("./auth.js");
      await loadStaff(env, email);   // creates the owner's staff row on first sign-in
    }
    const s = await env.DB.prepare("SELECT email,name,role,mfa_enabled,mfa_secret FROM staff WHERE email=? AND active=1").bind(email).first();
    if (!s) {
      await audit(env, email, "staff", "auth.google_denied", "staff", email, "not on staff", clientIp(req)).run();
      return deny(`${email} isn't set up as staff. Ask an admin to add you.`);
    }
    await env.DB.prepare("UPDATE staff SET google_sub=? WHERE email=?").bind(claims.sub, email).run();
    const needMfa = env.STAFF_MFA !== "off";
    if (needMfa) {
      const t = token(24);
      await env.DB.prepare("INSERT INTO pending_logins (token_hash,email,stage,data,expires_at) VALUES (?,?,'staff-mfa',?,datetime('now','+15 minutes'))")
        .bind(await sha256(t), email, JSON.stringify({ to, setup: !s.mfa_enabled })).run();
      return new Response(null, { status: 302, headers: { Location: `${base(env) || url.origin}/#/staff-signin?t=${t}&step=${s.mfa_enabled ? "mfa" : "setup"}&to=${encodeURIComponent(to)}` } });
    }
    await audit(env, email, s.role, "auth.google", "staff", email, null, clientIp(req)).run();
    return new Response(null, { status: 302, headers: { Location: `${base(env) || url.origin}/${to}`, "Set-Cookie": await startSession(env, req, email) } });
  },

  // Second factor: set up an authenticator app, or enter this minute's code.
  "POST /api/staff/mfa/setup": async (req, env) => {
    const { token: t } = await readJson(req);
    const p = await env.DB.prepare("SELECT * FROM pending_logins WHERE token_hash=? AND stage='staff-mfa' AND expires_at > datetime('now')").bind(await sha256(String(t || ""))).first();
    if (!p) throw httpErr(401, "That took too long. Sign in again.");
    const secret = randomSecret();
    await env.DB.prepare("UPDATE pending_logins SET data=? WHERE token_hash=?").bind(JSON.stringify({ ...JSON.parse(p.data || "{}"), secret }), await sha256(t)).run();
    return json({ secret, url: otpauthUrl(secret, p.email) });
  },
  "POST /api/staff/mfa": async (req, env) => {
    const { token: t, code, method } = await readJson(req);
    const p = await env.DB.prepare("SELECT * FROM pending_logins WHERE token_hash=? AND stage='staff-mfa' AND expires_at > datetime('now')").bind(await sha256(String(t || ""))).first();
    if (!p) throw httpErr(401, "That took too long. Sign in again.");
    await rateLimit(env, `smfa:${p.email}`, 10, 900);
    const data = JSON.parse(p.data || "{}");
    const s = await env.DB.prepare("SELECT email,role,mfa_secret,mfa_enabled,recovery_hashes FROM staff WHERE email=? AND active=1").bind(p.email).first();
    if (!s) throw httpErr(403, "Your access was removed");
    let ok = false, codes = null;
    if (data.secret) {                       // first-time setup
      ok = await verifyTotp(data.secret, code);
      if (ok) {
        const rec = await makeRecoveryCodes();
        codes = rec.codes;
        await env.DB.prepare("UPDATE staff SET mfa_secret=?, mfa_enabled=1, recovery_hashes=? WHERE email=?").bind(data.secret, JSON.stringify(rec.hashes), s.email).run();
      }
    } else if (method === "recovery") {
      const left = await useRecoveryCode(JSON.parse(s.recovery_hashes || "[]"), code);
      if (left) { ok = true; await env.DB.prepare("UPDATE staff SET recovery_hashes=? WHERE email=?").bind(JSON.stringify(left), s.email).run(); }
    } else ok = await verifyTotp(s.mfa_secret, code);
    if (!ok) { await audit(env, s.email, s.role, "auth.staff_mfa_failed", "staff", s.email, null, clientIp(req)).run(); throw httpErr(401, "That code doesn't match. Try again."); }
    await env.DB.prepare("DELETE FROM pending_logins WHERE token_hash=?").bind(await sha256(t)).run();
    await audit(env, s.email, s.role, "auth.staff_login", "staff", s.email, data.secret ? "mfa set up" : "mfa", clientIp(req)).run();
    return json({ ok: true, to: data.to || "#/pharmacy", recoveryCodes: codes }, 200, { "Set-Cookie": await startSession(env, req, s.email) });
  },
  "POST /api/staff/logout": async (req, env) => {
    const t = getCookie(req, "dmm_staff");
    if (t) await env.DB.prepare("DELETE FROM staff_sessions WHERE token_hash=?").bind(await sha256(t)).run();
    return json({ ok: true }, 200, { "Set-Cookie": cookie("", 0) });
  },
  // Lets an admin turn two-factor off for someone who lost their phone (they set it up again next sign-in).
  "POST /api/admin/staff/mfa-reset": async (req, env) => {
    const { adminAuth } = await import("./accounts.js");
    const who = await adminAuth(req, env);
    const { email } = await readJson(req);
    const em = String(email || "").toLowerCase();
    await env.DB.prepare("UPDATE staff SET mfa_secret=NULL, mfa_enabled=0, recovery_hashes=NULL WHERE email=?").bind(em).run();
    await env.DB.prepare("DELETE FROM staff_sessions WHERE email=?").bind(em).run();
    await audit(env, who.email, "admin", "staff.mfa_reset", "staff", em, null, clientIp(req)).run();
    await sendEmail(env, em, "Two-factor reset", "An administrator reset two-factor on your DeliverMyMedications staff account. You'll set it up again next time you sign in.");
    return json({ ok: true });
  }
};
