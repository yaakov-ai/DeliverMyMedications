// Patient accounts, two-factor sign-in, provider and pharmacy applications, support tickets, and the admin console.
// Staff keep signing in through Cloudflare Access (SSO + MFA); the admin console sits behind the same Access
// application on /admin/* and additionally requires the admin role in the staff table.
import {
  httpErr, json, readJson, nowISO, uid, token, sha256, clientIp, rateLimit, getRecord, findByLookup,
  insertRecord, updateRecord, audit, sendEmail, sendText, stripe, timingSafeEqual
} from "./lib.js";
import { randomSecret, verifyTotp, otpauthUrl, sixDigit, makeRecoveryCodes, useRecoveryCode } from "./totp.js";
import { PRODUCTS } from "./pricing.js";
import { staffAuth, patientAuth, startSession } from "./auth.js";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const lower = s => String(s || "").trim().toLowerCase();
const digits = s => String(s || "").replace(/\D/g, "");
const MDY = /^\d{2}\/\d{2}\/\d{4}$/;

export async function adminAuth(req, env) {
  const who = await staffAuth(req, env);
  if (who.role !== "admin") throw httpErr(403, "Admin access only");
  return who;
}

/* ---------- sign-in ---------- */
async function issueCode(env, email, purpose, patientId) {
  const code = sixDigit();
  await env.DB.prepare("INSERT INTO login_codes (id,email,code_hash,purpose,patient_id,expires_at) VALUES (?,?,?,?,?,datetime('now','+10 minutes'))")
    .bind(uid(12), email, await sha256(code), purpose, patientId || null).run();
  await sendEmail(env, email, `Your sign-in code: ${code}`,
    `Your DeliverMyMedications ${purpose === "signup" ? "sign-up" : "sign-in"} code is ${code}. It expires in 10 minutes.\n\nIf you didn't ask for this, you can ignore this email — no one can sign in without the code.`);
  return code;
}
async function pending(env, { email, patientId, stage, data }) {
  const t = token(24);
  await env.DB.prepare("INSERT INTO pending_logins (token_hash,email,patient_id,stage,data,expires_at) VALUES (?,?,?,?,?,datetime('now','+20 minutes'))")
    .bind(await sha256(t), email, patientId || null, stage, JSON.stringify(data || {})).run();
  return t;
}
async function readPending(env, t, stage) {
  const row = await env.DB.prepare("SELECT * FROM pending_logins WHERE token_hash=? AND expires_at > datetime('now')").bind(await sha256(String(t || ""))).first();
  if (!row || (stage && row.stage !== stage)) throw httpErr(401, "That took too long. Start again.");
  return { ...row, data: JSON.parse(row.data || "{}") };
}
const clearPending = (env, t) => sha256(String(t || "")).then(h => env.DB.prepare("DELETE FROM pending_logins WHERE token_hash=?").bind(h).run());

async function finishLogin(env, req, acct) {
  await env.DB.prepare("UPDATE accounts SET failed_attempts=0, locked_until=NULL, last_login_at=datetime('now') WHERE patient_id=?").bind(acct.patient_id).run();
  const cookie = await startSession(env, acct.patient_id);
  await env.DB.prepare("UPDATE sessions SET user_agent=?, ip=?, last_seen_at=datetime('now') WHERE patient_id=? AND last_seen_at IS NULL")
    .bind((req.headers.get("User-Agent") || "").slice(0, 200), clientIp(req), acct.patient_id).run();
  await audit(env, acct.patient_id, "patient", "auth.login", "accounts", acct.patient_id, acct.mfa_type, clientIp(req)).run();
  return cookie;
}

export const accountRoutes = {
  // Step 1: email a 6-digit code. The answer never says whether the email is known.
  "POST /api/auth/start": async (req, env) => {
    const { email } = await readJson(req);
    const em = lower(email);
    if (!EMAIL_RE.test(em)) throw httpErr(400, "Enter a valid email address");
    await rateLimit(env, `start:${clientIp(req)}`, 15, 900);
    await rateLimit(env, `start:${em}`, 6, 900);
    const acct = await env.DB.prepare("SELECT * FROM accounts WHERE email=?").bind(em).first();
    if (acct?.status === "disabled") throw httpErr(403, "This account is turned off. Please call the pharmacy.");
    const code = await issueCode(env, em, acct ? "signin" : "signup", acct?.patient_id);
    // In local development the code is returned so you can test without an email provider.
    return json({ ok: true, exists: !!acct, devCode: env.ENVIRONMENT === "development" ? code : undefined });
  },

  // Step 2: check the emailed code.
  "POST /api/auth/code": async (req, env) => {
    const { email, code } = await readJson(req);
    const em = lower(email);
    await rateLimit(env, `code:${clientIp(req)}`, 30, 900);
    const row = await env.DB.prepare("SELECT * FROM login_codes WHERE email=? AND used_at IS NULL AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1").bind(em).first();
    if (!row) throw httpErr(401, "That code expired. Ask for a new one.");
    if (row.attempts >= 5) throw httpErr(429, "Too many tries. Ask for a new code.");
    if (!timingSafeEqual(await sha256(digits(code)), row.code_hash)) {
      await env.DB.prepare("UPDATE login_codes SET attempts=attempts+1 WHERE id=?").bind(row.id).run();
      throw httpErr(401, "That code doesn't match. Check your email and try again.");
    }
    await env.DB.prepare("UPDATE login_codes SET used_at=datetime('now') WHERE id=?").bind(row.id).run();
    const acct = row.patient_id ? await env.DB.prepare("SELECT * FROM accounts WHERE patient_id=?").bind(row.patient_id).first() : null;
    if (acct?.locked_until && acct.locked_until > nowISO()) throw httpErr(429, "This account is locked for a few minutes after too many wrong codes.");
    if (acct && acct.mfa_type) {
      const t = await pending(env, { email: em, patientId: acct.patient_id, stage: "mfa" });
      if (acct.mfa_type === "sms") {
        const c = sixDigit();
        await env.DB.prepare("INSERT INTO login_codes (id,email,code_hash,purpose,patient_id,expires_at) VALUES (?,?,?,'sms',?,datetime('now','+10 minutes'))").bind(uid(12), `sms:${em}`, await sha256(c), acct.patient_id).run();
        await sendText(env, acct.phone, `DeliverMyMedications security code: ${c}`);
        if (env.ENVIRONMENT === "development") console.log("dev sms code", c);
      }
      return json({ stage: "mfa", method: acct.mfa_type, phoneHint: acct.phone ? `•••• ${digits(acct.phone).slice(-4)}` : null, token: t });
    }
    // New account, or an account that hasn't finished setting up its second factor.
    const t = await pending(env, { email: em, patientId: acct?.patient_id, stage: "setup" });
    const pt = acct ? await getRecord(env, "patients", acct.patient_id) : null;
    return json({ stage: "setup", token: t, profile: { email: em, ...(pt?.data || {}), ...(acct?.profile_json ? JSON.parse(acct.profile_json) : {}) } });
  },

  // Step 3: second factor.
  "POST /api/auth/mfa": async (req, env) => {
    const { token: t, code, method } = await readJson(req);
    const p = await readPending(env, t, "mfa");
    await rateLimit(env, `mfa:${p.patient_id}`, 10, 900);
    const acct = await env.DB.prepare("SELECT * FROM accounts WHERE patient_id=?").bind(p.patient_id).first();
    let ok = false, note = acct.mfa_type;
    if (method === "recovery") {
      const left = await useRecoveryCode(JSON.parse(acct.recovery_hashes || "[]"), code);
      if (left) { ok = true; note = "recovery code"; await env.DB.prepare("UPDATE accounts SET recovery_hashes=? WHERE patient_id=?").bind(JSON.stringify(left), acct.patient_id).run(); }
    } else if (acct.mfa_type === "totp") ok = await verifyTotp(acct.mfa_secret, code);
    else {
      const row = await env.DB.prepare("SELECT * FROM login_codes WHERE email=? AND purpose='sms' AND used_at IS NULL AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1").bind(`sms:${p.email}`).first();
      if (row && timingSafeEqual(await sha256(digits(code)), row.code_hash)) { ok = true; await env.DB.prepare("UPDATE login_codes SET used_at=datetime('now') WHERE id=?").bind(row.id).run(); }
    }
    if (!ok) {
      const fails = (acct.failed_attempts || 0) + 1;
      await env.DB.prepare(`UPDATE accounts SET failed_attempts=?, locked_until=CASE WHEN ?>=5 THEN datetime('now','+15 minutes') ELSE locked_until END WHERE patient_id=?`).bind(fails, fails, acct.patient_id).run();
      await audit(env, acct.patient_id, "patient", "auth.mfa_failed", "accounts", acct.patient_id, null, clientIp(req)).run();
      throw httpErr(401, fails >= 5 ? "Too many wrong codes. Try again in 15 minutes." : "That code doesn't match. Try again.");
    }
    await clearPending(env, t);
    const cookie = await finishLogin(env, req, { ...acct, mfa_type: note });
    return json({ ok: true }, 200, { "Set-Cookie": cookie });
  },

  // Account setup: profile first, then the second factor, then recovery codes.
  "POST /api/auth/setup/profile": async (req, env) => {
    const { token: t, profile } = await readJson(req);
    const p = await readPending(env, t, "setup");
    const need = ["first", "last", "dob", "phone", "addr1", "city", "state", "zip"];
    const miss = need.filter(k => !String(profile?.[k] || "").trim());
    if (miss.length) throw httpErr(400, `Please fill in: ${miss.join(", ")}`);
    if (!MDY.test(profile.dob)) throw httpErr(400, "Enter your date of birth as MM/DD/YYYY");
    const age = Math.floor((Date.now() - new Date(+profile.dob.slice(6), +profile.dob.slice(0, 2) - 1, +profile.dob.slice(3, 5))) / 31557600000);
    if (!(age >= 18 && age < 120)) throw httpErr(400, "You must be 18 or older to use this service");
    if (digits(profile.phone).length !== 10) throw httpErr(400, "Enter a 10-digit mobile number");
    const clean = { first: profile.first.trim(), middle: (profile.middle || "").trim(), last: profile.last.trim(), dob: profile.dob,
      phone: profile.phone, addr1: profile.addr1.trim(), addr2: (profile.addr2 || "").trim(), city: profile.city.trim(), state: profile.state, zip: profile.zip,
      shipSame: profile.shipSame !== false, shipAddr: profile.shipAddr || null, contact: profile.contact || { email: true, sms: true } };
    let patientId = p.patient_id;
    if (!patientId) {
      const existing = await env.DB.prepare("SELECT patient_id FROM accounts WHERE email=?").bind(p.email).first();
      patientId = existing?.patient_id || `pt_${uid(14)}`;
      if (!existing) await env.DB.prepare("INSERT INTO accounts (patient_id,email,dob,phone,profile_json) VALUES (?,?,?,?,?)").bind(patientId, p.email, clean.dob, clean.phone, JSON.stringify(clean)).run();
    }
    await env.DB.prepare("UPDATE accounts SET dob=?, phone=?, profile_json=? WHERE patient_id=?").bind(clean.dob, clean.phone, JSON.stringify(clean), patientId).run();
    const rec = await getRecord(env, "patients", patientId);
    if (rec) await updateRecord(env, "patients", patientId, d => { Object.assign(d, { first: clean.first, middle: clean.middle, last: clean.last, dob: clean.dob, phone: clean.phone, email: p.email }); });
    else await insertRecord(env, "patients", { id: patientId, first: clean.first, middle: clean.middle, last: clean.last, dob: clean.dob, phone: clean.phone, email: p.email, createdAt: nowISO(), token: token(16) }, patientId);
    await env.DB.prepare("UPDATE pending_logins SET patient_id=? WHERE token_hash=?").bind(patientId, await sha256(t)).run();
    return json({ ok: true, patientId });
  },
  "POST /api/auth/setup/mfa": async (req, env) => {
    const { token: t, type, phone } = await readJson(req);
    const p = await readPending(env, t, "setup");
    if (!p.patient_id) throw httpErr(400, "Finish your details first");
    if (type === "totp") {
      const secret = randomSecret();
      await env.DB.prepare("UPDATE pending_logins SET data=? WHERE token_hash=?").bind(JSON.stringify({ secret, type }), await sha256(t)).run();
      return json({ type, secret, url: otpauthUrl(secret, p.email) });
    }
    if (type === "sms") {
      if (digits(phone).length !== 10) throw httpErr(400, "Enter a 10-digit mobile number");
      const c = sixDigit();
      await env.DB.prepare("INSERT INTO login_codes (id,email,code_hash,purpose,patient_id,expires_at) VALUES (?,?,?,'sms',?,datetime('now','+10 minutes'))").bind(uid(12), `sms:${p.email}`, await sha256(c), p.patient_id).run();
      await env.DB.prepare("UPDATE pending_logins SET data=? WHERE token_hash=?").bind(JSON.stringify({ type, phone }), await sha256(t)).run();
      await sendText(env, phone, `DeliverMyMedications security code: ${c}`);
      return json({ type, devCode: env.ENVIRONMENT === "development" ? c : undefined, sent: `•••• ${digits(phone).slice(-4)}` });
    }
    throw httpErr(400, "Choose an authenticator app or text messages");
  },
  "POST /api/auth/setup/confirm": async (req, env) => {
    const { token: t, code } = await readJson(req);
    const p = await readPending(env, t, "setup");
    const cfg = p.data || {};
    let ok = false;
    if (cfg.type === "totp") ok = await verifyTotp(cfg.secret, code);
    else {
      const row = await env.DB.prepare("SELECT * FROM login_codes WHERE email=? AND purpose='sms' AND used_at IS NULL AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1").bind(`sms:${p.email}`).first();
      if (row && timingSafeEqual(await sha256(digits(code)), row.code_hash)) { ok = true; await env.DB.prepare("UPDATE login_codes SET used_at=datetime('now') WHERE id=?").bind(row.id).run(); }
    }
    if (!ok) throw httpErr(401, "That code doesn't match. Try again.");
    const { codes, hashes } = await makeRecoveryCodes();
    await env.DB.prepare("UPDATE accounts SET mfa_type=?, mfa_secret=?, phone=COALESCE(?,phone), recovery_hashes=? WHERE patient_id=?")
      .bind(cfg.type, cfg.type === "totp" ? cfg.secret : null, cfg.phone || null, JSON.stringify(hashes), p.patient_id).run();
    await clearPending(env, t);
    const acct = await env.DB.prepare("SELECT * FROM accounts WHERE patient_id=?").bind(p.patient_id).first();
    const cookie = await finishLogin(env, req, acct);
    await audit(env, p.patient_id, "patient", "auth.mfa_enabled", "accounts", p.patient_id, cfg.type, clientIp(req)).run();
    return json({ ok: true, recoveryCodes: codes }, 200, { "Set-Cookie": cookie });
  },

  /* ---------- account management ---------- */
  "GET /api/patient/me": async (req, env) => {
    const me = await patientAuth(req, env);
    const a = await env.DB.prepare("SELECT patient_id,email,dob,phone,profile_json,mfa_type,recovery_hashes,last_login_at,stripe_payment_method FROM accounts WHERE patient_id=?").bind(me.patientId).first();
    const { results: sess } = await env.DB.prepare("SELECT user_agent,ip,created_at,last_seen_at FROM sessions WHERE patient_id=? AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 10").bind(me.patientId).all();
    let card = null;
    if (a.stripe_payment_method && env.STRIPE_SECRET_KEY) {
      try { const pm = await stripe(env, "GET", `payment_methods/${a.stripe_payment_method}`); card = { brand: pm.card?.brand, last4: pm.card?.last4, exp: `${pm.card?.exp_month}/${pm.card?.exp_year}` }; } catch { }
    }
    return json({ email: a.email, profile: a.profile_json ? JSON.parse(a.profile_json) : {}, mfa: a.mfa_type, recoveryLeft: JSON.parse(a.recovery_hashes || "[]").length, lastLogin: a.last_login_at, sessions: sess, card });
  },
  "POST /api/patient/profile": async (req, env) => {
    const me = await patientAuth(req, env);
    const { profile } = await readJson(req);
    const a = await env.DB.prepare("SELECT profile_json FROM accounts WHERE patient_id=?").bind(me.patientId).first();
    const old = JSON.parse(a.profile_json || "{}");
    const next = { ...old };
    for (const k of ["first", "middle", "last", "phone", "addr1", "addr2", "city", "state", "zip", "contact", "shipSame", "shipAddr"]) if (profile?.[k] !== undefined) next[k] = profile[k];
    if (digits(next.phone).length !== 10) throw httpErr(400, "Enter a 10-digit mobile number");
    await env.DB.prepare("UPDATE accounts SET profile_json=?, phone=? WHERE patient_id=?").bind(JSON.stringify(next), next.phone, me.patientId).run();
    await updateRecord(env, "patients", me.patientId, d => { Object.assign(d, { first: next.first, middle: next.middle, last: next.last, phone: next.phone }); });
    await audit(env, me.patientId, "patient", "profile.update", "accounts", me.patientId, null, clientIp(req)).run();
    return json({ ok: true, profile: next });
  },
  // Saving a card for later: Stripe holds the number; we only ever see the brand and last four digits.
  "POST /api/patient/card": async (req, env) => {
    const me = await patientAuth(req, env);
    if (!env.STRIPE_SECRET_KEY) throw httpErr(501, "Card saving isn't turned on yet");
    const a = await env.DB.prepare("SELECT stripe_customer_id,email FROM accounts WHERE patient_id=?").bind(me.patientId).first();
    let customer = a.stripe_customer_id;
    if (!customer) { customer = (await stripe(env, "POST", "customers", { email: a.email })).id; await env.DB.prepare("UPDATE accounts SET stripe_customer_id=? WHERE patient_id=?").bind(customer, me.patientId).run(); }
    const si = await stripe(env, "POST", "setup_intents", { customer, usage: "off_session", automatic_payment_methods: { enabled: true } });
    return json({ clientSecret: si.client_secret });
  },
  "POST /api/patient/card/save": async (req, env) => {
    const me = await patientAuth(req, env);
    const { paymentMethodId } = await readJson(req);
    const pm = await stripe(env, "GET", `payment_methods/${String(paymentMethodId || "")}`);
    const a = await env.DB.prepare("SELECT stripe_customer_id FROM accounts WHERE patient_id=?").bind(me.patientId).first();
    if (!pm.customer || pm.customer !== a.stripe_customer_id) throw httpErr(403, "That card isn't on your account");
    await env.DB.prepare("UPDATE accounts SET stripe_payment_method=? WHERE patient_id=?").bind(pm.id, me.patientId).run();
    return json({ ok: true, card: { brand: pm.card?.brand, last4: pm.card?.last4 } });
  },
  "POST /api/patient/sessions/revoke": async (req, env) => {
    const me = await patientAuth(req, env);
    await env.DB.prepare("DELETE FROM sessions WHERE patient_id=?").bind(me.patientId).run();
    await audit(env, me.patientId, "patient", "auth.revoke_all", "accounts", me.patientId, null, clientIp(req)).run();
    return json({ ok: true }, 200, { "Set-Cookie": "dmm_sess=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
  },

  /* ---------- support tickets ---------- */
  "POST /api/tickets": async (req, env) => {
    const me = await patientAuth(req, env);
    const { subject, body, orderNumber } = await readJson(req);
    if (String(subject || "").trim().length < 3 || String(body || "").trim().length < 5) throw httpErr(400, "Add a subject and a message");
    await rateLimit(env, `ticket:${me.patientId}`, 10, 3600);
    const t = { id: `tk_${uid(10)}`, patientId: me.patientId, email: me.email, subject: String(subject).slice(0, 120), orderNumber: String(orderNumber || "").slice(0, 40), status: "open", createdAt: nowISO(),
      messages: [{ at: nowISO(), who: "Patient", text: String(body).slice(0, 4000) }] };
    await insertRecord(env, "tickets", t, me.patientId);
    await sendEmail(env, env.ALERT_EMAIL, `New support ticket: ${t.subject}`, `From ${me.email}\n\n${t.messages[0].text}\n\nOpen the admin console to reply.`);
    return json({ ok: true, ticket: t });
  },
  "POST /api/tickets/reply": async (req, env) => {
    const me = await patientAuth(req, env);
    const { id, body } = await readJson(req);
    const rec = await getRecord(env, "tickets", String(id || ""));
    if (!rec || rec.patient_id !== me.patientId) throw httpErr(404, "Ticket not found");
    const r = await updateRecord(env, "tickets", rec.id, d => { d.messages.push({ at: nowISO(), who: "Patient", text: String(body || "").slice(0, 4000) }); d.status = "open"; });
    await sendEmail(env, env.ALERT_EMAIL, `Reply on ticket: ${r.data.subject}`, String(body || "").slice(0, 2000));
    return json({ ok: true, ticket: r.data });
  },

  /* ---------- provider and pharmacy applications (public) ---------- */
  "POST /api/apply": async (req, env) => {
    const a = await readJson(req);
    await rateLimit(env, `apply:${clientIp(req)}`, 5, 3600);
    const kind = a.kind === "pharmacy" ? "pharmacy" : "provider";
    const need = kind === "provider"
      ? ["first", "last", "credentials", "email", "phone", "npi", "licenses", "practiceName", "practiceAddr", "malpracticeCarrier", "malpracticePolicy"]
      : ["first", "last", "email", "phone", "role", "licenseNumber"];
    const miss = need.filter(k => !(Array.isArray(a[k]) ? a[k].length : String(a[k] || "").trim()));
    if (miss.length) throw httpErr(400, `Please fill in: ${miss.join(", ")}`);
    if (!EMAIL_RE.test(lower(a.email))) throw httpErr(400, "Enter a valid email");
    if (kind === "provider" && digits(a.npi).length !== 10) throw httpErr(400, "NPI must be 10 digits");
    if (kind === "provider" && !a.licenses.every(l => l.state && l.number && l.expires)) throw httpErr(400, "Each license needs a state, number, and expiry date");
    const rec = { id: `app_${uid(10)}`, kind, status: "pending", submittedAt: nowISO(), ...a, email: lower(a.email) };
    delete rec.token;
    await insertRecord(env, "applications", rec, null);
    await sendEmail(env, env.ALERT_EMAIL, `New ${kind} application: ${rec.first} ${rec.last}`, `Review it in the admin console: ${(env.PUBLIC_URL || "").replace(/\/$/, "")}/#/admin`);
    await sendEmail(env, rec.email, "We received your application", `Thanks ${rec.first}. We received your application to join DeliverMyMedications and will email you once it's reviewed.`);
    return json({ ok: true });
  },

  /* ---------- "tell us what's going on" ---------- */
  /* The patient writes in their own words. We shortlist candidates from the catalog ourselves, then ask the
     model to choose among them and explain why. It never diagnoses, never invents a product, and everything
     it suggests still goes to a licensed provider. Without an API key it falls back to the shortlist alone. */
  "POST /api/assist": async (req, env) => {
    const { text, history } = await readJson(req);
    const q = String(text || "").trim().slice(0, 600);
    if (q.length < 3) throw httpErr(400, "Tell us a little more");
    await rateLimit(env, `assist:${clientIp(req)}`, 20, 600);

    // Plain-language intents, so the shortlist is sensible even before the model sees it.
    const INTENTS = [
      [/(lose|losing|extra|overweight|obes|pounds|lbs|weight|diet|appetite|glp)/i, ["compounded-semaglutide", "compounded-tirzepatide"]],
      [/(erect|erection|hard|performance|libido|sex drive|bedroom|ed\b|viagra|cialis)/i, ["combo-odt-as-needed", "tadalafil-daily-b12", "tadalafil"]],
      [/(testosterone|low t\b|energy|fatigue|muscle|brain fog)/i, ["compounded-enclomiphene"]],
      [/(burning when|pee|urinat|uti|bladder)/i, ["nitrofurantoin-macrocrystals", "sulfamethoxazole-and-trimethoprim"]],
      [/(hair|balding|thinning|receding)/i, ["finasteride", "minoxidil-tablets"]],
      [/(acne|breakout|spots|wrinkle|aging|ageing)/i, ["tretinoin-acne", "clindamycin-gel"]],
      [/(blood pressure|hypertens)/i, ["lisinopril", "amlodipine"]],
      [/(cholesterol|statin|ldl)/i, ["atorvastatin", "rosuvastatin"]],
      [/(heartburn|reflux|acid|gerd)/i, ["omeprazole", "pantoprazole"]],
      [/(cold sore|herpes|outbreak)/i, ["valacyclovir"]],
      [/(birth control|contracept|the pill)/i, ["loryna", "sprintec"]],
      [/(sleep|insomnia|can't sleep|cant sleep)/i, ["hydroxyzine-tablets", "magnesium-glycinate"]]
    ];
    const STOP = new Set("the and for with have has been that this from about since still just really very not but you your are was were they them their when what which who how all any can could would should more most some much many little around carry carrying back keep keeps take taking tried try trying feel feels felt like lately years year months month weeks week days day".split(" "));
    const words = (q.toLowerCase().match(/[a-z]{3,}/g) || []).filter(w => !STOP.has(w));
    const intentIds = INTENTS.filter(([re]) => re.test(q)).flatMap(([, ids]) => ids).filter(id => PRODUCTS.has(id));
    const score = p => {
      const hay = `${p.name} ${p.brandFor || ""} ${p.sub} ${p.cat} ${p.use || ""}`.toLowerCase();
      return words.reduce((n, w) => n + (hay.includes(w) ? (p.name.toLowerCase().includes(w) ? 3 : 1) : 0), 0);
    };
    const keyword = [...PRODUCTS.values()].filter(p => !p.hidden)
      .map(p => ({ p, s: score(p) })).filter(x => x.s > 1).sort((a, b) => b.s - a.s).slice(0, 20).map(x => x.p);
    const seen = new Set();
    const shortlist = [...intentIds.map(id => PRODUCTS.get(id)), ...keyword]
      .filter(p => p && !seen.has(p.id) && (seen.add(p.id), true)).slice(0, 25);
    const pool = (shortlist.length ? shortlist : [...PRODUCTS.values()].slice(0, 25))
      .map(p => ({ id: p.id, name: p.name, treats: p.sub, from: p.price }));

    if (!env.ANTHROPIC_API_KEY) {
      return json({ reply: intentIds.length
        ? "Here's where most people in your situation start. A licensed provider reviews anything you request and decides."
        : "I'm not certain from that — here's what's closest. Try the categories below, or answer a few questions instead.",
        suggestions: pool.slice(0, 3).map(p => ({ id: p.id, why: `Commonly used for ${p.treats.toLowerCase()}.` })), followUp: null, fallback: true });
    }
    const system = `You help visitors to a cash-pay online pharmacy find a starting point. Rules, in order of importance:
1. You are not a clinician and must not diagnose, promise results, or tell anyone a medicine is safe for them. Every suggestion is reviewed by a licensed provider afterwards; say so.
2. Only suggest products from the list given to you, by id. Never invent one.
3. If the person describes chest pain, trouble breathing, signs of stroke, thoughts of self-harm, a child's illness, or anything urgent, suggest nothing and tell them to seek care now — 911, or 988 for mental health crises.
4. If what they describe isn't something this pharmacy treats (no controlled substances, no antipsychotics, no chemotherapy), say so plainly and suggest they see a clinician.
5. Keep the reply under 70 words, plain and warm. One follow-up question at most, only if it would change the suggestion.
Reply with JSON only: {"reply": string, "suggestions": [{"id": string, "why": string}], "followUp": string|null, "urgent": boolean}`;
    const messages = [...(Array.isArray(history) ? history.slice(-4) : []), { role: "user", content: `Products available:\n${JSON.stringify(pool)}\n\nWhat they wrote:\n${q}` }];
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: env.ASSIST_MODEL || "claude-sonnet-4-6", max_tokens: 700, system, messages })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || "assistant unavailable");
      const raw = (j.content || []).map(c => c.text || "").join("").replace(/```json|```/g, "").trim();
      const out = JSON.parse(raw);
      const valid = (out.suggestions || []).filter(x => PRODUCTS.has(x.id)).slice(0, 3);
      return json({ reply: String(out.reply || "").slice(0, 600), suggestions: valid, followUp: out.followUp || null, urgent: !!out.urgent });
    } catch (e) {
      console.log("assist", e.message);
      return json({ reply: "I couldn't work that one out. Here's the closest match — or use the questions instead.",
        suggestions: pool.slice(0, 3).map(p => ({ id: p.id, why: `Commonly used for ${p.treats.toLowerCase()}.` })), followUp: null, fallback: true });
    }
  },

  /* ---------- leads and abandoned carts ---------- */
  // The finder's "email this to me" — a lead, with the answers that produced it.
  "POST /api/lead": async (req, env) => {
    const { topic, email, phone, answers, suggested, marketing } = await readJson(req);
    if (!EMAIL_RE.test(lower(email))) throw httpErr(400, "Enter a valid email");
    await rateLimit(env, `lead:${clientIp(req)}`, 10, 3600);
    const lead = { id: `ld_${uid(10)}`, topic: String(topic || "").slice(0, 40), email: lower(email), phone: String(phone || "").slice(0, 20),
      answers: (answers || []).slice(0, 15), suggested: suggested || null, at: nowISO(), source: "finder",
      smsOptIn: !!marketing?.smsOptIn, emailOptIn: !!marketing?.emailOptIn };
    await insertRecord(env, "leads", lead, null);
    if (marketing?.smsOptIn || marketing?.emailOptIn) {
      await insertRecord(env, "consents", { id: `cn_${uid(10)}`, email: lead.email, phone: lead.phone,
        smsOptIn: !!marketing.smsOptIn, emailOptIn: !!marketing.emailOptIn,
        text: String(marketing.text || "").slice(0, 400), at: nowISO(), ip: clientIp(req), page: `finder:${lead.topic}` }, null);
    }
    const lines = lead.answers.map(a => `• ${a.q}\n  ${a.a}`).join("\n");
    await sendEmail(env, lead.email, "What we'd suggest, based on your answers",
      `Thanks for answering our questions.\n\n${suggested ? `Where we'd start: ${suggested}\n\n` : ""}Your answers:\n${lines}\n\nNothing is prescribed until a licensed provider reviews a request from you, and they may ask questions or decide against it.\n\n${(env.PUBLIC_URL || "").replace(/\/$/, "")}${suggested ? `/#/p/${suggested}` : "/#/browse"}`);
    await sendEmail(env, env.ALERT_EMAIL, `New lead: ${lead.topic}`, `${lead.email} · ${lead.phone || "no phone"}\nSuggested: ${suggested || "none"}\n\n${lines}`);
    return json({ ok: true });
  },
  // A cart that hasn't been paid for. The reminder goes out from the scheduled job, not from the browser.
  "POST /api/cart/hold": async (req, env) => {
    const { email, phone, items, total, first, marketing } = await readJson(req);
    if (!EMAIL_RE.test(lower(email)) && digits(phone).length !== 10) return json({ ok: false });
    await rateLimit(env, `cart:${clientIp(req)}`, 20, 3600);
    const id = `ct_${await sha256(lower(email) + digits(phone))}`.slice(0, 26);
    const ex = await getRecord(env, "carts", id);
    // Express written consent, recorded as the FCC expects: what they agreed to, when, and from where.
    const consent = marketing?.smsOptIn || marketing?.emailOptIn ? {
      smsOptIn: !!marketing.smsOptIn, emailOptIn: !!marketing.emailOptIn,
      text: String(marketing.text || "").slice(0, 400), at: nowISO(), ip: clientIp(req), page: String(marketing.page || "").slice(0, 60)
    } : null;
    if (consent) await insertRecord(env, "consents", { id: `cn_${uid(10)}`, email: lower(email), phone: String(phone || ""), ...consent }, null);
    const data = { id, email: lower(email), phone: String(phone || ""), first: String(first || "").slice(0, 40),
      items: (items || []).slice(0, 10), total: Number(total) || 0,
      smsOptIn: consent?.smsOptIn ?? ex?.data?.smsOptIn ?? false, emailOptIn: consent?.emailOptIn ?? ex?.data?.emailOptIn ?? false,
      at: nowISO(), helped: ex?.data?.helped || null, reminded: ex?.data?.reminded || null, ordered: false };
    if (ex) await updateRecord(env, "carts", id, d => { Object.assign(d, data, { reminded: d.reminded }); });
    else await insertRecord(env, "carts", data, null);
    return json({ ok: true });
  },

  /* ---------- provider payout accounts (Stripe Connect) ----------
     Bank details are entered on Stripe's own onboarding pages and never touch this database or the browser.
     We keep the connected-account id and whether Stripe says payouts are enabled. */
  "GET /api/staff/payouts": async (req, env) => {
    const who = await staffAuth(req, env);
    const row = await env.DB.prepare("SELECT profile_json FROM staff WHERE email=?").bind(who.email).first();
    const profile = row?.profile_json ? JSON.parse(row.profile_json) : {};
    let status = { state: profile.stripeAccount ? "pending" : "none", payoutsEnabled: false, needs: [] };
    if (profile.stripeAccount && env.STRIPE_SECRET_KEY) {
      try {
        const a = await stripe(env, "GET", `accounts/${profile.stripeAccount}`);
        status = {
          state: a.payouts_enabled ? "ready" : a.requirements?.disabled_reason ? "blocked" : "pending",
          payoutsEnabled: !!a.payouts_enabled,
          needs: (a.requirements?.currently_due || []).slice(0, 8),
          bank: a.external_accounts?.data?.[0] ? `${a.external_accounts.data[0].bank_name || "Bank"} ending ${a.external_accounts.data[0].last4}` : null
        };
      } catch (e) { status.state = "error"; }
    }
    const { results } = await env.DB.prepare("SELECT data FROM records WHERE kind='payouts' LIMIT 1000").all();
    const mine = results.map(r => JSON.parse(r.data)).filter(p => p.providerEmail === who.email);
    return json({ status, method: profile.payoutMethod || null, payouts: mine.slice(0, 100) });
  },
  // Returns a one-time Stripe link where the provider enters their bank details and identity information.
  "POST /api/staff/payouts/onboard": async (req, env) => {
    const who = await staffAuth(req, env);
    if (!env.STRIPE_SECRET_KEY) throw httpErr(501, "Payouts aren't connected yet. Ask an admin to finish the Stripe setup.");
    const row = await env.DB.prepare("SELECT profile_json FROM staff WHERE email=?").bind(who.email).first();
    const profile = row?.profile_json ? JSON.parse(row.profile_json) : {};
    if (!profile.stripeAccount) {
      const acct = await stripe(env, "POST", "accounts", {
        type: "express", email: who.email, business_type: "individual",
        capabilities: { transfers: { requested: true } },
        business_profile: { product_description: "Telehealth prescription reviews", mcc: "8011" },
        metadata: { staff: who.email, role: who.role }
      });
      profile.stripeAccount = acct.id;
      await env.DB.prepare("UPDATE staff SET profile_json=? WHERE email=?").bind(JSON.stringify(profile), who.email).run();
    }
    const base = (env.PUBLIC_URL || "").replace(/\/$/, "");
    const link = await stripe(env, "POST", "account_links", {
      account: profile.stripeAccount, type: "account_onboarding",
      refresh_url: `${base}/staff/login?to=%23/provider`, return_url: `${base}/#/provider?payouts=done`
    });
    await audit(env, who.email, who.role, "payout.onboard", "staff", who.email, profile.stripeAccount, clientIp(req)).run();
    return json({ url: link.url });
  },
  // If you'd rather pay by check or through payroll, the provider records that here. No account numbers are stored.
  "POST /api/staff/payouts/method": async (req, env) => {
    const who = await staffAuth(req, env);
    const { method, note } = await readJson(req);
    if (!["stripe", "check", "payroll"].includes(method)) throw httpErr(400, "Choose how you'd like to be paid");
    const row = await env.DB.prepare("SELECT profile_json FROM staff WHERE email=?").bind(who.email).first();
    const profile = row?.profile_json ? JSON.parse(row.profile_json) : {};
    profile.payoutMethod = { method, note: String(note || "").slice(0, 200), setAt: nowISO() };
    if (/\d{6,}/.test(String(note || ""))) throw httpErr(400, "Don't put account numbers here — use the bank setup button, or give them to the pharmacy directly.");
    await env.DB.prepare("UPDATE staff SET profile_json=? WHERE email=?").bind(JSON.stringify(profile), who.email).run();
    await audit(env, who.email, who.role, "payout.method", "staff", who.email, method, clientIp(req)).run();
    return json({ ok: true, method: profile.payoutMethod });
  },
  // Admin sends money for reviews already earned.
  "POST /api/admin/payouts/send": async (req, env) => {
    const who = await adminAuth(req, env);
    const { email, ids } = await readJson(req);
    if (!env.STRIPE_SECRET_KEY) throw httpErr(501, "Stripe isn't connected");
    const row = await env.DB.prepare("SELECT name, profile_json FROM staff WHERE email=?").bind(lower(email)).first();
    const profile = row?.profile_json ? JSON.parse(row.profile_json) : {};
    if (!profile.stripeAccount) throw httpErr(400, `${row?.name || email} hasn't set up their bank details yet`);
    const acct = await stripe(env, "GET", `accounts/${profile.stripeAccount}`);
    if (!acct.payouts_enabled) throw httpErr(400, "Stripe hasn't finished verifying that account yet");
    let total = 0; const paid = [];
    for (const id of (ids || []).slice(0, 500)) {
      const r = await getRecord(env, "payouts", String(id));
      if (!r || r.data.providerEmail !== lower(email) || r.data.status === "paid") continue;
      total += r.data.amount; paid.push(r.id);
    }
    if (!total) throw httpErr(400, "Nothing to send");
    const transfer = await stripe(env, "POST", "transfers", {
      amount: Math.round(total * 100), currency: "usd", destination: profile.stripeAccount,
      description: `Provider reviews (${paid.length})`, metadata: { staff: lower(email), payouts: paid.length }
    }, `xfer_${paid.sort().join("").slice(0, 60)}`);
    for (const id of paid) await updateRecord(env, "payouts", id, d => { d.status = "paid"; d.paidAt = nowISO(); d.paidBy = who.email; d.transferId = transfer.id; });
    await sendEmail(env, lower(email), "Payment sent", `We sent $${total.toFixed(2)} for ${paid.length} review${paid.length > 1 ? "s" : ""}. Banks usually post it within 1–2 business days.`);
    await audit(env, who.email, "admin", "payout.send", "staff", lower(email), `$${total.toFixed(2)} (${transfer.id})`, clientIp(req)).run();
    return json({ ok: true, total: Math.round(total * 100) / 100, transfer: transfer.id });
  },

  /* ---------- admin console ---------- */
  "GET /staff/admin": async (req, env, url) => { await adminAuth(req, env); return Response.redirect(`${url.origin}/#/admin`, 302); },
  "GET /api/admin/state": async (req, env) => {
    const who = await adminAuth(req, env);
    const kinds = ["applications", "tickets", "products", "payouts"];
    const db = {};
    for (const k of kinds) {
      const { results } = await env.DB.prepare("SELECT data FROM records WHERE kind=? ORDER BY updated_at DESC LIMIT 500").bind(k).all();
      db[k] = results.map(r => JSON.parse(r.data));
    }
    const { results: staff } = await env.DB.prepare("SELECT email,name,role,npi,states,active,phone,profile_json,invited_at,accepted_at FROM staff ORDER BY role, name").all();
    const { results: pts } = await env.DB.prepare("SELECT patient_id,email,dob,phone,mfa_type,status,last_login_at,created_at FROM accounts ORDER BY created_at DESC LIMIT 500").all();
    const { results: log } = await env.DB.prepare("SELECT at,actor,role,action,kind,record_id,detail FROM audit_log ORDER BY id DESC LIMIT 200").all();
    const { results: pay } = await env.DB.prepare("SELECT status, COUNT(*) n, SUM(captured) captured, SUM(refunded) refunded FROM payment_intents GROUP BY status").all();
    const { results: settings } = await env.DB.prepare("SELECT key,value FROM settings").all();
    const owner = lower(env.OWNER_EMAIL);
    return json({ db, me: { email: who.email, name: who.name, role: who.role, owner: !!who.owner }, ownerEmail: owner,
      staff: staff.map(s => ({ ...s, owner: s.email === owner, states: s.states ? JSON.parse(s.states) : [], profile: s.profile_json ? JSON.parse(s.profile_json) : {} })),
      patients: pts, log, payments: pay, settings: Object.fromEntries(settings.map(s => [s.key, s.value])) });
  },
  "POST /api/admin/application": async (req, env) => {
    const who = await adminAuth(req, env);
    const { id, action, role, states, npi, name, reason } = await readJson(req);
    const rec = await getRecord(env, "applications", String(id || ""));
    if (!rec) throw httpErr(404, "Application not found");
    if (action === "approve") {
      const a = rec.data;
      const finalRole = role || (a.kind === "provider" ? "provider" : a.role === "pharmacist" ? "pharmacist" : "technician");
      const finalName = name || `${a.first} ${a.last}${a.credentials ? ", " + a.credentials : ""}`;
      const st = states || (a.licenses || []).map(l => l.state);
      await env.DB.prepare(`INSERT INTO staff (email,name,role,npi,states,phone,profile_json,invited_by,invited_at,active)
        VALUES (?,?,?,?,?,?,?,?,datetime('now'),1)
        ON CONFLICT(email) DO UPDATE SET name=excluded.name, role=excluded.role, npi=excluded.npi, states=excluded.states, profile_json=excluded.profile_json, active=1`)
        .bind(a.email, finalName, finalRole, npi || a.npi || null, JSON.stringify(st), a.phone || null, JSON.stringify(a), who.email).run();
      await updateRecord(env, "applications", rec.id, d => { d.status = "approved"; d.decidedAt = nowISO(); d.decidedBy = who.email; d.role = finalRole; });
      await sendEmail(env, a.email, "You're approved — how to sign in", `Hi ${a.first},\n\nYour DeliverMyMedications account is ready. Sign in here with this email address:\n\n${(env.PUBLIC_URL || "").replace(/\/$/, "")}/staff/login\n\nYou'll be asked to verify your identity each time you sign in.`);
    } else {
      await updateRecord(env, "applications", rec.id, d => { d.status = "denied"; d.decidedAt = nowISO(); d.decidedBy = who.email; d.reason = String(reason || "").slice(0, 500); });
      await sendEmail(env, rec.data.email, "About your application", `Hi ${rec.data.first},\n\nThank you for applying to DeliverMyMedications. We aren't able to move forward at this time.${reason ? `\n\n${reason}` : ""}`);
    }
    await audit(env, who.email, "admin", `application.${action}`, "applications", rec.id, null, clientIp(req)).run();
    return json({ ok: true });
  },
  "POST /api/admin/staff": async (req, env) => {
    const who = await adminAuth(req, env);
    const { email, name, role, npi, states, phone, profile, active } = await readJson(req);
    const em = lower(email);
    if (!EMAIL_RE.test(em) || !["provider", "pharmacist", "technician", "support", "admin"].includes(role) || String(name || "").trim().length < 3) throw httpErr(400, "Enter a name, a valid email, and a role");
    if (role === "provider" && (digits(npi).length !== 10 || !(states || []).length)) throw httpErr(400, "Providers need a 10-digit NPI and at least one license state");
    if (em === who.email && role !== "admin") throw httpErr(400, "You can't remove your own admin role");
    if (em === lower(env.OWNER_EMAIL) && (role !== "admin" || active === false)) throw httpErr(400, "The owner account must stay an active admin");
    await env.DB.prepare(`INSERT INTO staff (email,name,role,npi,states,phone,profile_json,invited_by,invited_at,active) VALUES (?,?,?,?,?,?,?,?,datetime('now'),?)
      ON CONFLICT(email) DO UPDATE SET name=excluded.name, role=excluded.role, npi=excluded.npi, states=excluded.states, phone=excluded.phone, profile_json=excluded.profile_json, active=excluded.active`)
      .bind(em, name.trim(), role, npi || null, JSON.stringify(states || []), phone || null, JSON.stringify(profile || {}), who.email, active === false ? 0 : 1).run();
    await audit(env, who.email, "admin", "staff.save", "staff", em, role, clientIp(req)).run();
    if (active !== false) await sendEmail(env, em, "Your DeliverMyMedications account", `You've been added as ${role}. Sign in at ${(env.PUBLIC_URL || "").replace(/\/$/, "")}/staff/login using this email address.`);
    return json({ ok: true });
  },
  "POST /api/admin/staff/remove": async (req, env) => {
    const who = await adminAuth(req, env);
    const { email } = await readJson(req);
    if (lower(email) === who.email) throw httpErr(400, "You can't remove yourself");
    if (lower(email) === lower(env.OWNER_EMAIL)) throw httpErr(400, "The owner account can't be disabled");
    await env.DB.prepare("UPDATE staff SET active=0 WHERE email=?").bind(lower(email)).run();
    await audit(env, who.email, "admin", "staff.disable", "staff", lower(email), null, clientIp(req)).run();
    return json({ ok: true });
  },
  "POST /api/admin/patient": async (req, env) => {
    const who = await adminAuth(req, env);
    const { patientId, action, reason } = await readJson(req);
    const a = await env.DB.prepare("SELECT * FROM accounts WHERE patient_id=?").bind(String(patientId || "")).first();
    if (!a) throw httpErr(404, "Account not found");
    if (action === "reset-mfa") {
      await env.DB.prepare("UPDATE accounts SET mfa_type=NULL, mfa_secret=NULL, recovery_hashes=NULL, failed_attempts=0, locked_until=NULL WHERE patient_id=?").bind(a.patient_id).run();
      await env.DB.prepare("DELETE FROM sessions WHERE patient_id=?").bind(a.patient_id).run();
      await sendEmail(env, a.email, "Your two-factor setup was reset", "A pharmacy administrator reset two-factor on your account. Next time you sign in, you'll set it up again. If this wasn't expected, call the pharmacy.");
    } else if (action === "unlock") {
      await env.DB.prepare("UPDATE accounts SET failed_attempts=0, locked_until=NULL WHERE patient_id=?").bind(a.patient_id).run();
    } else if (action === "disable" || action === "enable") {
      await env.DB.prepare("UPDATE accounts SET status=? WHERE patient_id=?").bind(action === "disable" ? "disabled" : "active", a.patient_id).run();
      if (action === "disable") await env.DB.prepare("DELETE FROM sessions WHERE patient_id=?").bind(a.patient_id).run();
    } else if (action === "signout") {
      await env.DB.prepare("DELETE FROM sessions WHERE patient_id=?").bind(a.patient_id).run();
    } else throw httpErr(400, "Unknown action");
    await audit(env, who.email, "admin", `patient.${action}`, "accounts", a.patient_id, reason || null, clientIp(req)).run();
    return json({ ok: true });
  },
  "POST /api/admin/product": async (req, env) => {
    const who = await adminAuth(req, env);
    const { product, remove } = await readJson(req);
    const id = String(product?.id || "").trim();
    if (!/^[a-z0-9-]{2,60}$/.test(id)) throw httpErr(400, "Give the product a simple id (lowercase letters, numbers, dashes)");
    if (remove) {
      await env.DB.prepare("DELETE FROM records WHERE kind='products' AND id=?").bind(id).run();
      await audit(env, who.email, "admin", "product.remove", "products", id, null, clientIp(req)).run();
      return json({ ok: true });
    }
    if (product.price != null && !(Number(product.price) > 0 && Number(product.price) < 100000)) throw httpErr(400, "Enter a valid price");
    if (product.image && String(product.image).length > 400_000) throw httpErr(413, "Image is too large (keep it under 300 KB)");
    const clean = { id, name: product.name, price: product.price == null ? undefined : +Number(product.price).toFixed(2), use: product.use, image: product.image || undefined,
      cat: product.cat, sub: product.sub, kind: product.kind, dosages: product.dosages, qtyLabel: product.qtyLabel, brandFor: product.brandFor, att: product.att, hidden: !!product.hidden, updatedAt: nowISO(), updatedBy: who.email };
    for (const k of Object.keys(clean)) if (clean[k] === undefined || clean[k] === "") delete clean[k];
    clean.id = id;
    const ex = await getRecord(env, "products", id);
    if (ex) await updateRecord(env, "products", id, d => { Object.assign(d, clean); });
    else await insertRecord(env, "products", clean, null);
    await audit(env, who.email, "admin", "product.save", "products", id, null, clientIp(req)).run();
    return json({ ok: true, product: clean });
  },
  "POST /api/admin/ticket": async (req, env) => {
    const who = await staffAuth(req, env);
    if (!["admin", "support", "pharmacist"].includes(who.role) && !who.owner) throw httpErr(403, "Only customer service, pharmacists and admins answer tickets");
    const { id, action, message } = await readJson(req);
    const rec = await getRecord(env, "tickets", String(id || ""));
    if (!rec) throw httpErr(404, "Ticket not found");
    const r = await updateRecord(env, "tickets", rec.id, d => {
      if (message) d.messages.push({ at: nowISO(), who: who.name || "Pharmacy", text: String(message).slice(0, 4000) });
      d.status = action === "close" ? "closed" : "answered";
    });
    if (message) await sendEmail(env, rec.data.email, `Re: ${rec.data.subject}`, `${message}\n\nSee the full conversation in your account: ${(env.PUBLIC_URL || "").replace(/\/$/, "")}/#/account`);
    await audit(env, who.email, "admin", `ticket.${action || "reply"}`, "tickets", rec.id, null, clientIp(req)).run();
    return json({ ok: true, ticket: r.data });
  },
  // Provider pay: mark accrued reviews as paid (the transfer itself happens in your bank or payroll system).
  "POST /api/admin/payouts": async (req, env) => {
    const who = await adminAuth(req, env);
    const { ids, action } = await readJson(req);
    if (!Array.isArray(ids) || !ids.length) throw httpErr(400, "Nothing selected");
    if (!["paid", "unpaid"].includes(action)) throw httpErr(400, "Unknown action");
    let total = 0;
    for (const id of ids.slice(0, 500)) {
      const r = await updateRecord(env, "payouts", String(id), d => {
        if (d.status === action) return false;
        d.status = action; d.paidAt = action === "paid" ? nowISO() : null; d.paidBy = action === "paid" ? who.email : null;
      });
      if (r) total += r.data.amount || 0;
    }
    await audit(env, who.email, "admin", `payout.${action}`, "payouts", ids.join(",").slice(0, 200), total.toFixed(2), clientIp(req)).run();
    return json({ ok: true, total: Math.round(total * 100) / 100 });
  },
  "POST /api/admin/setting": async (req, env) => {
    const who = await adminAuth(req, env);
    const { key, value } = await readJson(req);
    if (!/^[a-z_]{2,40}$/.test(String(key || ""))) throw httpErr(400, "Bad setting");
    if (key === "video_rules") {
      let parsed; try { parsed = JSON.parse(value || "{}"); } catch { throw httpErr(400, "Video rules must be valid JSON"); }
      for (const [k, states] of Object.entries(parsed)) {
        if (!Array.isArray(states) || states.some(x => !/^[A-Z]{2}$/.test(x))) throw httpErr(400, `${k}: list states as two-letter codes`);
      }
    }
    await env.DB.prepare("INSERT INTO settings (key,value,updated_by) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=datetime('now')").bind(key, String(value ?? "").slice(0, 2000), who.email).run();
    await audit(env, who.email, "admin", "setting.save", "settings", key, String(value ?? "").slice(0, 100), clientIp(req)).run();
    return json({ ok: true });
  },
  "POST /api/admin/email": async (req, env) => {
    const who = await adminAuth(req, env);
    const { to, subject, body } = await readJson(req);
    if (!EMAIL_RE.test(lower(to)) || !subject || !body) throw httpErr(400, "Enter an address, subject, and message");
    const sent = await sendEmail(env, lower(to), String(subject).slice(0, 150), String(body).slice(0, 8000));
    await audit(env, who.email, "admin", "email.send", null, lower(to), String(subject).slice(0, 100), clientIp(req)).run();
    return json({ ok: sent, note: sent ? null : "Email isn't configured yet (RESEND_API_KEY)." });
  },

  // Product changes the storefront applies on top of the built-in catalog.
  "GET /api/catalog": async (req, env) => {
    const { results } = await env.DB.prepare("SELECT data FROM records WHERE kind='products' LIMIT 1000").all();
    return json({ products: results.map(r => JSON.parse(r.data)) }, 200, { "Cache-Control": "public, max-age=30" });
  }
};
