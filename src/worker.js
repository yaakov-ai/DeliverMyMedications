// DeliverMyMedications API (Cloudflare Worker). Static site files are served from /public by Workers Static Assets.
import {
  HttpError, httpErr, json, readJson, nowISO, uid, token, sha256, clientIp, rateLimit, KINDS,
  getRecords, getRecord, findByLookup, guardStmt, upsertStmt, updateRecord, insertRecord, audit,
  sendEmail, sendText, stripe, verifyStripeSignature, nextOpen, etYmd, timingSafeEqual
} from "./lib.js";
import { staffAuth, patientAuth, optionalPatient, startSession, endSession } from "./auth.js";
import { PATIENT_ACTIONS, staffMayRun, checkShape, ownerOf, checkStaffChange, checkPatientChange } from "./rules.js";
import { accountRoutes } from "./accounts.js";
import { googleRoutes, googleEnabled } from "./google.js";
import { verifyOrder, cartTotals, memberPricing, refillCharge, capturableTotal, PRODUCTS, PROVIDER_FEE, SHIP, setOverrides } from "./pricing.js";

// Product changes from the admin console, cached briefly so pricing stays in step with the site.
let overrideCache = { at: 0 };
async function loadOverrides(env) {
  if (Date.now() - overrideCache.at < 20000) return;
  const { results } = await env.DB.prepare("SELECT data FROM records WHERE kind='products' LIMIT 1000").all();
  setOverrides(results.map(r => JSON.parse(r.data)));
  overrideCache = { at: Date.now() };
}

const live = env => env.LIVE_MODE === "true" && !!env.DB;
const testPayments = env => env.PAYMENT_MODE === "test";
const cents = n => Math.round(n * 100);
const publicUrl = env => (env.PUBLIC_URL || "").replace(/\/$/, "");

/* Carts left behind get two touches, both only with marketing consent, both inside sending hours.
   First a short offer of help — no discount, no pressure. Then, twelve hours later, one code.
   Texts are marketing under the TCPA, so consent, the wording shown, the time and the IP are all recorded. */
const SEND_START = 9, SEND_END = 20;                 // 9am to 8pm Eastern
function inSendWindow(env) {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date()));
  return h >= SEND_START && h < SEND_END;
}
async function chaseCarts(env) {
  if (!live(env) || !inSendWindow(env)) return;
  const set = async (k, dflt) => Number((await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(k).first())?.value ?? dflt);
  const pct = Math.min(20, Math.max(1, await set("cart_discount_pct", 10)));
  const assistMins = await set("cart_assist_minutes", 5);
  const offerHours = await set("cart_discount_hours", 12);
  const { results } = await env.DB.prepare(
    "SELECT data FROM records WHERE kind='carts' AND created_at >= datetime('now','-3 day') LIMIT 200").all();
  const assistant = (await env.DB.prepare("SELECT value FROM settings WHERE key='assistant_name'").first())?.value || "Noah";
  for (const r of results) {
    const c = JSON.parse(r.data);
    if (c.ordered) continue;
    const ageMin = (Date.now() - new Date(c.at)) / 60000;
    const what = c.items?.[0]?.name ? `your ${c.items[0].name}` : "your order";
    // Did they order in the meantime?
    const placed = await env.DB.prepare("SELECT 1 FROM records WHERE kind='orders' AND json_extract(data,'$.patient.email')=? AND created_at >= ? LIMIT 1")
      .bind(c.email, c.at).first();
    if (placed) { await updateRecord(env, "carts", c.id, d => { d.ordered = true; }); continue; }

    // Touch one: an offer of help.
    if (!c.helped && ageMin >= assistMins) {
      const line = `Hi${c.first ? " " + c.first : ""}, it's ${assistant}, the assistant at DeliverMyMedications. I saw you were looking at ${what} — any questions about how the review works or what happens next? Just reply here and a person will pick it up. Reply STOP to opt out.`;
      if (c.smsOptIn) await sendText(env, c.phone, line);
      else if (c.emailOptIn) await sendEmail(env, c.email, "Any questions about your order?", `${line.replace(" Reply STOP to opt out.", "")}\n\n${publicUrl(env)}/#/cart`);
      await updateRecord(env, "carts", c.id, d => { d.helped = nowISO(); });
      continue;
    }
    // Touch two: one code, twelve hours later.
    if (c.helped && !c.reminded && ageMin >= offerHours * 60 && (c.smsOptIn || c.emailOptIn)) {
      const code = `SAVE${pct}${uid(4).toUpperCase()}`;
      await insertRecord(env, "promos", { id: code, pct, email: c.email, cartId: c.id, at: nowISO(),
        expires: new Date(Date.now() + 3 * 864e5).toISOString() }, null);
      const url = `${publicUrl(env)}/#/cart?code=${code}`;
      if (c.smsOptIn) await sendText(env, c.phone, `${assistant} here again — if cost is the sticking point, here's ${pct}% off ${what}: code ${code}, good 3 days. ${url} Reply STOP to opt out.`);
      if (c.emailOptIn) await sendEmail(env, c.email, `${pct}% off, if it helps`,
        `You left ${what} in your cart.\n\nUse code ${code} for ${pct}% off the medication — good for three days.\n\n${url}\n\nIf you decided against it, no problem at all. Reply and tell us why if you have a moment; it genuinely helps.`);
      await updateRecord(env, "carts", c.id, d => { d.reminded = nowISO(); d.code = code; });
    }
  }
}

/* =================== Routes =================== */
const routes = {
  ...accountRoutes,
  ...googleRoutes,
  "GET /api/config": async (req, env) => json({
    mode: live(env) ? "live" : "demo",
    paymentMode: testPayments(env) ? "test" : "stripe",
    stripePublishableKey: testPayments(env) ? "" : (env.STRIPE_PUBLISHABLE_KEY || ""),
    staffAuth: googleEnabled(env) ? "google" : "access",
    videoRules: await videoRules(env),
    alertEmail: env.ALERT_EMAIL || ""
  }),
  // /api/health?setup=1 reports what's configured (never any values) so you can see what's missing.
  "GET /api/health": async (req, env, url) => {
    const ok = live(env) ? !!(await env.DB.prepare("SELECT 1 AS x").first()) : true;
    const body = { ok, mode: live(env) ? "live" : "demo" };
    if (url.searchParams.get("setup") === "1") {
      const tables = {};
      for (const t of ["records", "staff", "accounts", "sessions", "staff_sessions", "login_codes", "pending_logins", "payment_intents", "settings", "audit_log"]) {
        try { await env.DB.prepare(`SELECT 1 FROM ${t} LIMIT 1`).all(); tables[t] = true; } catch { tables[t] = false; }
      }
      // How big is the page we're actually serving? A short answer here means a truncated upload.
      let page = null;
      try {
        const res = await env.ASSETS.fetch(new Request(`${url.origin}/index.html`));
        const text = await res.text();
        page = { bytes: text.length, complete: text.trimEnd().endsWith("</html>") };
      } catch { }
      let staff = null;
      try { const r = await env.DB.prepare("SELECT COUNT(*) n FROM staff WHERE active=1").first(); staff = r.n; } catch { }
      body.setup = {
        liveMode: env.LIVE_MODE === "true", publicUrl: env.PUBLIC_URL || null, authMode: env.AUTH_MODE || "google",
        googleClientId: !!env.GOOGLE_CLIENT_ID, googleClientSecret: !!env.GOOGLE_CLIENT_SECRET, googleHd: env.GOOGLE_HD || null,
        ownerEmail: env.OWNER_EMAIL || null, staffMfa: env.STAFF_MFA !== "off",
        email: !!env.RESEND_API_KEY, texts: !!env.TWILIO_AUTH_TOKEN, stripe: !!env.STRIPE_SECRET_KEY, paymentMode: env.PAYMENT_MODE || "stripe",
        page, activeStaff: staff, tables, missing: Object.entries(tables).filter(([, v]) => !v).map(([k]) => k)
      };
    }
    return json(body);
  },

  // Cloudflare Access protects this path; after sign-in we send staff back into the app.
  "GET /staff/login": async (req, env, url) => {
    const to = url.searchParams.get("to") || "#/pharmacy";
    const safe = /^#\/[a-z0-9/_-]*$/i.test(to) ? to : "#/pharmacy";
    if (googleEnabled(env)) {
      try { await staffAuth(req, env); } catch { return Response.redirect(`${url.origin}/auth/google/start?to=${encodeURIComponent(safe)}`, 302); }
      return Response.redirect(`${url.origin}/${safe}`, 302);
    }
    await staffAuth(req, env);   // Cloudflare Access protects this path
    return Response.redirect(`${url.origin}/${safe}`, 302);
  },

  /* ----- state ----- */
  "GET /api/staff/state": async (req, env) => {
    const who = await staffAuth(req, env);
    const db = {}, versions = {};
    for (const kind of KINDS) {
      const { results } = await env.DB.prepare("SELECT id,version,data FROM records WHERE kind=? ORDER BY updated_at DESC LIMIT 5000").bind(kind).all();
      db[kind] = results.map(r => { versions[`${kind}:${r.id}`] = r.version; return JSON.parse(r.data); });
    }
    return json({ db, versions, me: { role: who.role, owner: !!who.owner, name: who.name, email: who.email, provider: { id: who.email, name: who.name, npi: who.npi, states: who.states } } });
  },
  "GET /api/patient/state": async (req, env) => {
    const me = await patientAuth(req, env);
    const db = {}, versions = {};
    for (const kind of ["orders", "fills", "notes", "links", "rxOnFile", "patients", "shipments", "tickets"]) db[kind] = [];
    const { results } = await env.DB.prepare("SELECT kind,id,version,data FROM records WHERE patient_id=? AND kind IN ('orders','fills','notes','links','rxOnFile','patients','shipments','tickets') ORDER BY updated_at DESC LIMIT 3000").bind(me.patientId).all();
    for (const r of results) { db[r.kind].push(JSON.parse(r.data)); versions[`${r.kind}:${r.id}`] = r.version; }
    return json({ db, versions, me: { role: "patient", email: me.email, patientId: me.patientId } });
  },

  /* ----- commits ----- */
  "POST /api/staff/commit": async (req, env, url, ctx) => {
    const who = await staffAuth(req, env);
    await loadOverrides(env);
    const body = await readJson(req);
    if (!staffMayRun(who, body.action)) throw httpErr(403, `Your role (${who.role}) can't do that`);
    return json(await commit(env, ctx, { who, action: body.action, payload: body.payload, changes: body.changes, ip: clientIp(req) }));
  },
  "POST /api/patient/commit": async (req, env, url, ctx) => {
    const me = await patientAuth(req, env);
    await loadOverrides(env);
    const body = await readJson(req);
    if (!PATIENT_ACTIONS.has(body.action)) throw httpErr(403, "Not allowed");
    return json(await commit(env, ctx, { who: me, action: body.action, payload: body.payload, changes: body.changes, ip: clientIp(req) }));
  },

  /* ----- checkout ----- */
  "POST /api/checkout/intent": async (req, env) => {
    await rateLimit(env, `intent:${clientIp(req)}`, 30, 600);
    const { cart, speed, email, promo: promoCode } = await readJson(req);
    const em = String(email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) throw httpErr(400, "Enter a valid email");
    const promo = await checkPromo(env, promoCode, em);
    let t; try { t = cartTotals(cart, speed === "next" ? "next" : "standard", promo); } catch (e) { throw httpErr(400, e.message); }
    const id = await createIntent(env, { purpose: "cart", amount: cents(t.total), email: em, details: { cart, speed, total: t.total }, capture: "manual" });
    return json({ ...id, total: t.total });
  },
  "POST /api/checkout/commit": async (req, env, url, ctx) => {
    await rateLimit(env, `checkout:${clientIp(req)}`, 20, 600);
    const { payload, changes } = await readJson(req);
    const order = payload?.order;
    let totals; try { totals = verifyOrder(order); } catch (e) { throw httpErr(400, e.message); }
    // A line bought against a prescription we already hold must point at a real recommendation of theirs.
    const onfile = order.lines.filter(l => l.rx === "onfile");
    if (onfile.length) {
      const email = String(order.patient.email || "").trim().toLowerCase();
      const { results } = await env.DB.prepare(
        "SELECT data FROM records WHERE kind='orders' AND json_extract(data,'$.patient.email')=? ORDER BY created_at DESC LIMIT 50").bind(email).all();
      const mine = results.map(r => JSON.parse(r.data));
      for (const l of onfile) {
        const ok = mine.some(o => (o.lines || []).some(x => x.id === l.id && x.status === "recommended" && !x.boughtAt))
          || mine.some(o => (o.lines || []).some(x => x.id === l.id && ["approved", "shipped", "delivered"].includes(x.status)));
        if (!ok) throw httpErr(403, `We don't have a prescription on file for ${l.name}. Start a review instead.`);
      }
    }
    const pi = await env.DB.prepare("SELECT * FROM payment_intents WHERE id=? AND purpose='cart' AND status='created'").bind(String(payload.paymentIntentId || "")).first();
    if (!pi) throw httpErr(400, "Payment not found. Please try again.");
    if (pi.amount !== cents(totals.total)) throw httpErr(400, "Order total changed, refresh and try again");
    const email = String(order.patient.email || "").trim().toLowerCase();
    if (pi.email !== email) throw httpErr(400, "Payment email doesn't match");
    let pm = null, customer = null;
    if (!testPayments(env)) {
      const s = await stripe(env, "GET", `payment_intents/${pi.id}`);
      if (s.status !== "requires_capture" || s.amount !== pi.amount) throw httpErr(402, "Card authorization didn't complete");
      pm = s.payment_method; customer = s.customer;
    }
    // Account: reuse by email (date of birth must match), or create.
    const signedIn = await optionalPatient(req, env);
    let acct = await env.DB.prepare("SELECT * FROM accounts WHERE email=?").bind(email).first();
    if (acct && acct.dob !== order.patient.dob && signedIn?.patientId !== acct.patient_id) throw httpErr(409, "An account with this email already exists. Sign in from My account, then place your order.");
    const patientId = acct?.patient_id || `pt_${uid(14)}`;
    if (!acct) {
      await env.DB.prepare("INSERT INTO accounts (patient_id,email,dob,stripe_customer_id,stripe_payment_method) VALUES (?,?,?,?,?)").bind(patientId, email, order.patient.dob, customer, pm).run();
    } else if (pm) {
      await env.DB.prepare("UPDATE accounts SET stripe_customer_id=COALESCE(?,stripe_customer_id), stripe_payment_method=? WHERE patient_id=?").bind(customer, pm, patientId).run();
    }
    // Only the new order and its own fills may be written here.
    order.patientId = patientId;
    order.payment = { provider: testPayments(env) ? "test" : "stripe", intentId: pi.id, status: "authorized", authorized: totals.total, captured: 0, refunded: 0, last4: order.payment?.last4 || "" };
    const allowed = (changes || []).filter(c => (c.kind === "orders" && c.id === order.id) || (c.kind === "fills" && c.data?.orderId === order.id && !c.baseVersion));
    if (allowed.length !== (changes || []).length) throw httpErr(403, "Checkout can only create your order");
    for (const c of allowed) {
      if (c.kind === "orders") c.data = order;
      if (c.kind === "fills" && (c.data.stage !== "queue" && c.data.stage !== "transfer" || c.data.verifiedBy || c.data.rxNumbers)) throw httpErr(403, "Bad fill");
    }
    const exists = await getRecord(env, "patients", patientId);
    const extra = [];
    if (!exists) extra.push({ kind: "patients", id: patientId, data: { id: patientId, first: order.patient.first, last: order.patient.last, dob: order.patient.dob, phone: order.patient.phone, email, createdAt: nowISO(), token: token(16) }, patientId });
    await env.DB.prepare("UPDATE payment_intents SET status='used', order_id=?, patient_id=? WHERE id=?").bind(order.id, patientId, pi.id).run();
    const result = await writeChanges(env, [...allowed.map(c => ({ ...c, patientId })), ...extra], new Map(), { actor: email, role: "patient", action: "checkout", ip: clientIp(req) });
    // Nothing to review (only transfers / non-prescription items): capture now.
    ctx.waitUntil(reconcilePayment(env, order.id).then(() => sendEmail(env, email, "We received your order", `Hi ${order.patient.first},\n\nThanks for your order ${order.number}. We'll email you as it moves along.\n\nTrack it here: ${publicUrl(env)}/#/account`)));
    const cookie = await startSession(env, patientId);
    return json({ records: result }, 200, { "Set-Cookie": cookie });
  },

  /* ----- patient Rx links and memberships ----- */
  "POST /api/links/verify": async (req, env) => {
    const { token: tk, dob } = await readJson(req);
    if (typeof tk !== "string" || tk.length < 16) throw httpErr(400, "This link isn't valid");
    await rateLimit(env, `lv-ip:${clientIp(req)}`, 30, 3600);
    const [pt] = await findByLookup(env, "patients", tk);
    if (!pt) throw httpErr(404, "This link isn't valid. It may have been replaced by a newer link.");
    const { results: links } = await env.DB.prepare("SELECT id,data FROM records WHERE kind='links' AND patient_id=?").bind(pt.id).all();
    const active = links.map(l => JSON.parse(l.data)).filter(l => l.token === tk);
    if (active.length && active.every(l => ["expired", "cancelled"].includes(l.status))) throw httpErr(410, "This link has expired. Call or text the pharmacy for a new one.");
    const key = `lv:${await sha256(tk)}`;
    const row = await env.DB.prepare("SELECT count FROM rate_limits WHERE key=?").bind(key).first();
    if ((row?.count || 0) >= 5) throw httpErr(429, "Too many tries. Call the pharmacy for a new link.");
    if (!timingSafeEqual(String(dob || ""), pt.data.dob)) {
      await env.DB.prepare("INSERT INTO rate_limits (key,count,window_start) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1").bind(key, Math.floor(Date.now() / 1000)).run();
      if ((row?.count || 0) + 1 >= 5) {
        await updateRecord(env, "patients", pt.id, d => { d.token = token(16); });
        for (const l of active) await updateRecord(env, "links", l.id, d => { d.status = "expired"; d.log = [...(d.log || []), { t: nowISO(), text: "Locked after 5 wrong dates of birth" }]; });
        throw httpErr(429, "Too many tries. Call the pharmacy for a new link.");
      }
      throw httpErr(401, "That doesn't match our records. Try again.");
    }
    await ensureAccount(env, pt);
    for (const l of active.filter(l => l.status === "sent")) await updateRecord(env, "links", l.id, d => { d.status = "opened"; d.openedAt = nowISO(); d.log = [...(d.log || []), { t: nowISO(), text: "Opened by patient" }]; });
    await audit(env, pt.id, "patient", "link.verify", "patients", pt.id, null, clientIp(req)).run();
    return json({ ok: true }, 200, { "Set-Cookie": await startSession(env, pt.id) });
  },
  "POST /api/links/intent": async (req, env) => {
    const me = await patientAuth(req, env);
    const { rxId, months, speed, cover } = await readJson(req);
    const rx = await getRecord(env, "rxOnFile", String(rxId || ""));
    if (!rx || rx.patient_id !== me.patientId) throw httpErr(404, "Prescription not found");
    if (![1, 2, 3].includes(months)) throw httpErr(400, "Bad plan length");
    const amount = await linkAmount(env, me.patientId, rx.data, months, speed === "next" ? "next" : "standard", cover);
    const id = await createIntent(env, { purpose: "link", amount: cents(amount.total), email: me.email, patientId: me.patientId, details: { rxId: rx.id, productId: rx.data.productId, months, speed, cover, ...amount }, capture: "automatic" });
    return json({ ...id, total: amount.total });
  },

  /* ----- patient sign-in ----- */
  "POST /api/auth/magic": async (req, env) => {
    const { email } = await readJson(req);
    const em = String(email || "").trim().toLowerCase();
    await rateLimit(env, `magic:${clientIp(req)}`, 10, 600);
    await rateLimit(env, `magic:${em}`, 5, 3600);
    let acct = await env.DB.prepare("SELECT patient_id FROM accounts WHERE email=?").bind(em).first();
    if (!acct) {
      const pt = await env.DB.prepare("SELECT id,data FROM records WHERE kind='patients' AND json_extract(data,'$.email')=? LIMIT 1").bind(em).first();
      if (pt) { await ensureAccount(env, { id: pt.id, data: JSON.parse(pt.data) }); acct = { patient_id: pt.id }; }
    }
    if (acct) {
      const t = token(24);
      await env.DB.prepare("INSERT INTO magic_links (token_hash,patient_id,expires_at) VALUES (?,?,datetime('now','+20 minutes'))").bind(await sha256(t), acct.patient_id).run();
      await sendEmail(env, em, "Your sign-in link", `Use this link to sign in to DeliverMyMedications. It works once and expires in 20 minutes.\n\n${publicUrl(env)}/api/auth/verify?t=${t}\n\nIf you didn't ask for this, you can ignore this email.`);
    }
    return json({ ok: true }); // same answer either way
  },
  "GET /api/auth/verify": async (req, env, url) => {
    const t = url.searchParams.get("t") || "";
    const row = await env.DB.prepare("SELECT patient_id FROM magic_links WHERE token_hash=? AND used_at IS NULL AND expires_at > datetime('now')").bind(await sha256(t)).first();
    if (!row) return Response.redirect(`${url.origin}/#/account?signin=expired`, 302);
    await env.DB.prepare("UPDATE magic_links SET used_at=datetime('now') WHERE token_hash=?").bind(await sha256(t)).run();
    const cookie = await startSession(env, row.patient_id);
    return new Response(null, { status: 302, headers: { Location: `${url.origin}/#/account`, "Set-Cookie": cookie } });
  },
  "POST /api/auth/logout": async (req, env) => json({ ok: true }, 200, { "Set-Cookie": await endSession(req, env) }),

  /* ----- shipping ----- */
  "POST /api/staff/shipping/label": async (req, env) => {
    const who = await staffAuth(req, env);
    if (!["pharmacist", "technician", "admin"].includes(who.role)) throw httpErr(403, "Pharmacy staff only");
    const { fillIds, service } = await readJson(req);
    if (!Array.isArray(fillIds) || !fillIds.length || fillIds.length > 12) throw httpErr(400, "Pick the fills to ship");
    const recs = await getRecords(env, fillIds.map(id => ({ kind: "fills", id })));
    const fills = fillIds.map(id => recs.get(`fills:${id}`)?.data);
    if (fills.some(f => !f || f.stage !== "packed")) throw httpErr(409, "Every Rx must be packed first");
    if (new Set(fills.map(f => !!f.cold)).size > 1) throw httpErr(400, "Don't mix cold-chain and room-temperature items in one package");
    const orders = await getRecords(env, [...new Set(fills.map(f => f.orderId))].map(id => ({ kind: "orders", id })));
    const pts = [...orders.values()].map(o => o.data.patient);
    const addrKey = a => [a.addr1, a.zip].join("|").toLowerCase();
    if (new Set(pts.map(addrKey)).size > 1) throw httpErr(400, "Rx in one package must share an address");
    if (!env.SHIPSTATION_API_KEY) throw httpErr(501, "ShipStation isn't connected yet. Enter tracking by hand.");
    const a = pts[0], cold = !!fills[0].cold;
    const svc = { Overnight: env.SS_SERVICE_OVERNIGHT, "2-Day": env.SS_SERVICE_2DAY, Ground: env.SS_SERVICE_GROUND }[service];
    if (!svc) throw httpErr(400, "That service isn't configured");
    const r = await fetch("https://api.shipstation.com/v2/labels", {
      method: "POST", headers: { "API-Key": env.SHIPSTATION_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ shipment: {
        service_code: svc, ship_from_id: env.SS_WAREHOUSE_ID,
        ship_to: { name: `${a.first} ${a.last}`, phone: a.phone, address_line1: a.addr1, address_line2: a.addr2 || "", city_locality: a.city, state_province: a.state, postal_code: a.zip, country_code: "US" },
        packages: [{ package_code: cold ? env.SS_PKG_COLD : env.SS_PKG_STANDARD, weight: { value: cold ? 3 : 0.5, unit: "pound" } }],
        external_shipment_id: fillIds.join(",").slice(0, 50)
      } })
    });
    const label = await r.json();
    if (!r.ok) throw httpErr(502, label.errors?.[0]?.message || "ShipStation couldn't create the label");
    await audit(env, who.email, who.role, "label.create", "fills", fillIds.join(","), label.tracking_number, clientIp(req)).run();
    return json({ carrier: String(label.carrier_code || "").toUpperCase(), service, tracking: label.tracking_number, labelUrl: label.label_download?.pdf || null });
  },

  /* ----- webhooks ----- */
  "POST /api/carrier/webhook": async (req, env, url) => {
    if (!env.CARRIER_WEBHOOK_KEY || !timingSafeEqual(url.searchParams.get("key") || "", env.CARRIER_WEBHOOK_KEY)) throw httpErr(401, "Bad key");
    const evt = await readJson(req);
    const t = evt.data || evt.result || evt;
    const code = String(t.status_code || t.status || "").toUpperCase();
    const map = { AC: "label_created", PRE_TRANSIT: "label_created", IT: "in_transit", IN_TRANSIT: "in_transit", OUT_FOR_DELIVERY: "out_for_delivery", DE: "delivered", DELIVERED: "delivered", EX: "exception", AVAILABLE_FOR_PICKUP: "out_for_delivery" };
    const status = map[code] || (/deliver/i.test(t.status_description || "") ? "delivered" : "in_transit");
    const num = t.tracking_number || t.tracking_code;
    if (!num) return json({ ignored: true });
    const fills = await findByLookup(env, "fills", num);
    for (const f of fills) {
      await updateRecord(env, "fills", f.id, d => {
        if (d.stage === "delivered") return false;
        d.trackStatus = status; d.trackUpdatedAt = nowISO();
        d.events = [...(d.events || []), { t: nowISO(), who: "Carrier", text: status.replace(/_/g, " ") }];
        if (status === "delivered") { d.stage = "delivered"; d.deliveredBy = "carrier"; }
      });
      if (TRACK_TEXT[status]) {
        const o = await getRecord(env, "orders", f.data.orderId);
        if (o) {
          await sendEmail(env, o.data.patient.email, `Update on order ${o.data.number}`, `Hi ${o.data.patient.first},\n\nYour order ${o.data.number} ${TRACK_TEXT[status]}.\n\nTracking and details: ${publicUrl(env)}/#/account`);
          await sendText(env, o.data.patient.phone, `DeliverMyMedications: your order ${o.data.number} ${TRACK_TEXT[status]}.`);
        }
      }
      if (status === "exception") ctx_email(env, `Delivery problem: ${f.data.number}`, `The carrier reported a problem with ${f.data.number} (${num}). Check tracking and contact the patient.`);
    }
    await audit(env, "carrier", "system", `track.${status}`, "fills", num).run();
    return json({ ok: true, updated: fills.length });
  },
  "POST /api/stripe/webhook": async (req, env) => {
    const raw = await req.text();
    if (!(await verifyStripeSignature(env, raw, req.headers.get("Stripe-Signature")))) throw httpErr(400, "Bad signature");
    const evt = JSON.parse(raw);
    const obj = evt.data?.object || {};
    if (evt.type === "payment_intent.payment_failed") await audit(env, "stripe", "system", "payment.failed", "payment_intents", obj.id, obj.last_payment_error?.message).run();
    if (evt.type === "charge.refunded") await audit(env, "stripe", "system", "payment.refunded", "payment_intents", obj.payment_intent, obj.amount_refunded).run();
    if (evt.type === "charge.dispute.created") ctx_email(env, "Card dispute opened", `Stripe reported a dispute on payment ${obj.payment_intent}. Review it in the Stripe dashboard.`);
    return json({ received: true });
  }
};
function ctx_email(env, subject, text) { return sendEmail(env, env.ALERT_EMAIL, subject, text); }

/* =================== Commit =================== */
async function commit(env, ctx, { who, action, payload, changes, ip }) {
  checkShape(changes);
  if (!changes.length) return { records: [] };
  const keys = changes.map(c => ({ kind: c.kind, id: c.id }));
  // Load the records being changed, plus orders referenced by fills/notes/tasks so ownership can be checked.
  const refOrderIds = new Set();
  for (const c of changes) if (["fills", "notes", "tasks"].includes(c.kind) && c.data.orderId) refOrderIds.add(c.data.orderId);
  const shipFillIds = new Set(); for (const c of changes) if (c.kind === "shipments") (c.data.fillIds || []).forEach(id => shipFillIds.add(id));
  const existing = await getRecords(env, [...keys, ...[...refOrderIds].map(id => ({ kind: "orders", id })), ...[...shipFillIds].map(id => ({ kind: "fills", id }))]);
  const byKey = new Map(changes.map(c => [`${c.kind}:${c.id}`, c]));
  const ctxInfo = { refillLines: [], newLinkOrders: [] };
  const writes = [];
  for (const c of changes) {
    const ex = existing.get(`${c.kind}:${c.id}`);
    if (ex && c.baseVersion !== ex.version) throw httpErr(409, "Someone else just changed this. Refreshing.");
    if (!ex && c.baseVersion != null) throw httpErr(409, "Record no longer exists. Refreshing.");
    const owner = ownerOf(c, existing, byKey, existing);
    if (who.kind === "staff") checkStaffChange(who, action, c, ex, ctxInfo);
    else checkPatientChange(who, action, c, ex, owner, ctxInfo);
    if (c.kind === "orders" && ex) c.data.payment = ex.data.payment; // payments are server-owned
    writes.push({ ...c, patientId: owner });
  }
  // New patients created by staff: don't let an email point at two different people.
  const tokenSwap = new Map();
  for (const w of writes.filter(w => w.kind === "patients")) {
    const ex = existing.get(`patients:${w.id}`);
    if (!ex && w.data.email) {
      const other = await env.DB.prepare("SELECT patient_id FROM accounts WHERE email=? AND patient_id<>?").bind(String(w.data.email).toLowerCase(), w.id).first();
      if (other) throw httpErr(409, "A different patient already uses that email. Search for them instead.");
    }
    if (!ex || ex.data.token !== w.data.token) { const t = token(16); tokenSwap.set(w.data.token, t); w.data.token = t; }  // links use server-made tokens only
  }
  for (const w of writes.filter(w => w.kind === "links" && tokenSwap.has(w.data.token))) w.data.token = tokenSwap.get(w.data.token);
  if (action === "/api/links/complete") await checkLinkPurchase(env, who, payload, ctxInfo);

  // Charge refills before saving (off-session, saved card). Refund if the save fails.
  const charges = [];
  if (action === "/api/refills") {
    const lines = dedupe(ctxInfo.refillLines.length ? ctxInfo.refillLines : staffRefillLines(changes, existing));
    if (!lines.length) throw httpErr(400, "Nothing to refill");
    for (const { order, line } of lines) charges.push(await chargeRefill(env, order, line, who));
  }
  let records;
  try {
    records = await writeChanges(env, writes, existing, { actor: who.email || who.patientId, role: who.role || "patient", action, ip });
  } catch (e) {
    for (const ch of charges) await refundCharge(env, ch).catch(() => {});
    throw e;
  }
  // After-save effects
  const touchedOrders = new Set(writes.filter(w => w.kind === "orders").map(w => w.id));
  for (const w of writes) {
    if (w.kind === "fills" && w.data.orderId) touchedOrders.add(w.data.orderId);
    if (w.kind === "orders" && w.data.parentOrderId) touchedOrders.add(w.data.parentOrderId);
  }
  for (const ch of charges) touchedOrders.add(ch.orderId);
  if (touchedOrders.size) {
    // Return server-updated payment fields right away for the orders we charged.
    for (const ch of charges) {
      const r = await updateRecord(env, "orders", ch.orderId, d => {
        d.payment = d.payment || { captured: 0, refunded: 0 };
        d.payment.refillCharges = [...(d.payment.refillCharges || []), { at: nowISO(), amount: ch.amount / 100, line: ch.lineId, id: ch.id }];
        d.payment.captured = Math.round(((d.payment.captured || 0) + ch.amount / 100) * 100) / 100;
      });
      if (r) { const i = records.findIndex(x => x.kind === "orders" && x.id === ch.orderId); const rec = { kind: "orders", id: r.id, version: r.version, data: r.data }; if (i >= 0) records[i] = rec; else records.push(rec); }
    }
  }
  ctx.waitUntil((async () => {
    for (const id of touchedOrders) await reconcilePayment(env, id);
    await sendLinkMessages(env, writes, existing);
    await recordProviderPay(env, who, writes, existing);
    await notifyPatient(env, writes, existing);
  })().catch(e => console.log("after-commit", e)));
  return { records };
}
const dedupe = list => { const s = new Set(); return list.filter(x => { const k = `${x.order.id}:${x.line.lid}`; if (s.has(k)) return false; s.add(k); return true; }); };
function staffRefillLines(changes, existing) {
  const out = [];
  for (const c of changes) {
    if (c.kind !== "orders") continue;
    const old = existing.get(`orders:${c.id}`)?.data; if (!old) continue;
    for (const l of c.data.lines) {
      const o = old.lines.find(x => x.lid === l.lid);
      if (o && (l.refillsLeft < o.refillsLeft || (o.membership && l.lastFillAt !== o.lastFillAt))) out.push({ order: old, line: o });
    }
  }
  return out;
}

async function writeChanges(env, writes, existing, { actor, role, action, ip }) {
  if (!writes.length) return [];
  const stmts = [];
  for (const w of writes) { const ex = existing.get(`${w.kind}:${w.id}`); if (ex) stmts.push(guardStmt(env, w.kind, w.id, ex.version)); }
  for (const w of writes) stmts.push(upsertStmt(env, w, existing.get(`${w.kind}:${w.id}`)));
  for (const w of writes) stmts.push(audit(env, actor, role, action, w.kind, w.id, existing.get(`${w.kind}:${w.id}`) ? "update" : "create", ip));
  try { await env.DB.batch(stmts); }
  catch (e) {
    if (/version conflict|malformed JSON|UNIQUE constraint/i.test(String(e))) throw httpErr(409, "Someone else just changed this. Refreshing.");
    throw e;
  }
  return writes.map(w => { const ex = existing.get(`${w.kind}:${w.id}`); return { kind: w.kind, id: w.id, version: ex ? ex.version + 1 : 1, data: w.data }; });
}

/* =================== Payments =================== */
async function createIntent(env, { purpose, amount, email, patientId, details, capture }) {
  if (amount < 50) throw httpErr(400, "Amount too small");
  let id, clientSecret = null;
  if (testPayments(env)) id = `test_${uid(16)}`;
  else {
    let customer = null;
    const acct = patientId ? await env.DB.prepare("SELECT stripe_customer_id FROM accounts WHERE patient_id=?").bind(patientId).first()
      : await env.DB.prepare("SELECT stripe_customer_id FROM accounts WHERE email=?").bind(email).first();
    customer = acct?.stripe_customer_id;
    if (!customer) customer = (await stripe(env, "POST", "customers", { email })).id;
    if (patientId && !acct?.stripe_customer_id) await env.DB.prepare("UPDATE accounts SET stripe_customer_id=? WHERE patient_id=?").bind(customer, patientId).run();
    const pi = await stripe(env, "POST", "payment_intents", {
      amount, currency: "usd", customer, capture_method: capture, setup_future_usage: "off_session",
      automatic_payment_methods: { enabled: true }, metadata: { purpose }, description: "DeliverMyMedications order"
    });
    id = pi.id; clientSecret = pi.client_secret;
  }
  await env.DB.prepare("INSERT INTO payment_intents (id,purpose,amount,patient_id,email,details,status) VALUES (?,?,?,?,?,?,'created')")
    .bind(id, purpose, amount, patientId || null, email || null, JSON.stringify(details)).run();
  return { paymentIntentId: id, clientSecret };
}

// Bring Stripe in line with the order.
// Checkout orders: authorize at checkout, capture once nothing is waiting on a provider (approved and transferred items only).
// Refunds are computed here, never taken from the browser: items the pharmacy cancels after capture, months a prescriber
// denies on a membership, and the review fee when our provider declines a continuation.
async function reconcilePayment(env, orderId) {
  const o = await getRecord(env, "orders", orderId);
  if (!o) return;
  const order = o.data;
  if (order.source === "link-extension") return; // paid through its parent order
  let pi = await env.DB.prepare("SELECT * FROM payment_intents WHERE order_id=?").bind(orderId).first();
  const det = pi ? JSON.parse(pi.details || "{}") : {};
  if (pi && pi.purpose === "cart" && pi.status === "used" && !order.lines.some(l => ["review", "info"].includes(l.status))) {
    const amt = Math.min(pi.amount, cents(capturableTotal(order)));
    if (!testPayments(env)) {
      if (amt > 0) await stripe(env, "POST", `payment_intents/${pi.id}/capture`, { amount_to_capture: amt }, `cap_${pi.id}`);
      else await stripe(env, "POST", `payment_intents/${pi.id}/cancel`, {}, `cancel_${pi.id}`);
    }
    det.capturedLines = order.lines.filter(l => ["approved", "transfer"].includes(l.status)).map(l => l.lid);
    await env.DB.prepare("UPDATE payment_intents SET status=?, captured=?, details=? WHERE id=?").bind(amt > 0 ? "captured" : "canceled", amt, JSON.stringify(det), pi.id).run();
    pi = await env.DB.prepare("SELECT * FROM payment_intents WHERE id=?").bind(pi.id).first();
  }
  if (pi && pi.status === "captured") {
    let due = 0;
    if (pi.purpose === "cart") {
      const done = new Set(JSON.parse(pi.details || "{}").capturedLines || []);
      for (const l of order.lines) if (done.has(l.lid) && ["declined", "cancelled"].includes(l.status)) due += cents(((l.plan && l.plan.prepaid != null) ? l.plan.prepaid : l.price) * l.count + (l.fee || 0));
    } else {
      const { results } = await env.DB.prepare("SELECT data FROM records WHERE kind='fills' AND json_extract(data,'$.orderId')=?").bind(orderId).all();
      const line = order.lines[0];
      for (const r of results) { const f = JSON.parse(r.data); if (f.cancelled) due += cents((line?.price || 0) + (f.cold ? SHIP.coldFee : 0)); }
      const { results: kids } = await env.DB.prepare("SELECT data FROM records WHERE kind='orders' AND json_extract(data,'$.parentOrderId')=?").bind(orderId).all();
      for (const k of kids) for (const l of JSON.parse(k.data).lines || []) if (l.status === "declined") due += cents(l.fee || 0);
    }
    due = Math.min(due, pi.captured);
    if (due > pi.refunded) {
      const delta = due - pi.refunded;
      if (!testPayments(env)) await stripe(env, "POST", "refunds", { payment_intent: pi.id, amount: delta }, `ref_${pi.id}_${due}`);
      await env.DB.prepare("UPDATE payment_intents SET refunded=? WHERE id=?").bind(due, pi.id).run();
      pi.refunded = due;
    }
  }
  await updateRecord(env, "orders", orderId, d => {
    const refills = (d.payment?.refillCharges || []).reduce((a, c) => a + cents(c.amount), 0);
    const next = {
      ...(d.payment || {}),
      status: !pi ? d.payment?.status : pi.status === "used" ? "authorized" : pi.status,
      captured: Math.round((pi ? pi.captured : 0) + refills) / 100,
      refunded: (pi ? pi.refunded : 0) / 100
    };
    if (JSON.stringify(next) === JSON.stringify(d.payment)) return false;
    d.payment = next;
  });
}

async function chargeRefill(env, order, line, who) {
  const amount = cents(refillCharge(line));
  const acct = await env.DB.prepare("SELECT stripe_customer_id, stripe_payment_method FROM accounts WHERE patient_id=?").bind(order.patientId).first();
  const id = `ch_${uid(14)}`;
  let stripeId = null;
  if (!testPayments(env)) {
    if (!acct?.stripe_customer_id || !acct?.stripe_payment_method) throw httpErr(402, "No saved card on file. The patient needs to update their card.");
    try {
      const pi = await stripe(env, "POST", "payment_intents", {
        amount, currency: "usd", customer: acct.stripe_customer_id, payment_method: acct.stripe_payment_method,
        off_session: true, confirm: true, description: `Refill ${order.number}`, metadata: { order: order.id, line: line.lid }
      }, `refill_${order.id}_${line.lid}_${line.refillsLeft}_${line.lastFillAt || ""}`);
      stripeId = pi.id;
    } catch (e) {
      await sendEmail(env, acct?.email || order.patient.email, "Action needed: update your card", `We couldn't charge your card for your refill on order ${order.number}. Sign in to update your card: ${publicUrl(env)}/#/account`);
      throw httpErr(402, `Card declined for ${order.patient.first} ${order.patient.last}. We emailed them to update it.`);
    }
  }
  await env.DB.prepare("INSERT INTO charges (id,order_id,line_id,amount,stripe_id,status) VALUES (?,?,?,?,?,'succeeded')").bind(id, order.id, line.lid, amount, stripeId).run();
  return { id, orderId: order.id, lineId: line.lid, amount, stripeId };
}
async function refundCharge(env, ch) {
  if (ch.stripeId && !testPayments(env)) await stripe(env, "POST", "refunds", { payment_intent: ch.stripeId }, `undo_${ch.id}`);
  await env.DB.prepare("UPDATE charges SET status='refunded' WHERE id=?").bind(ch.id).run();
}

async function ensureAccount(env, pt) {
  const has = await env.DB.prepare("SELECT patient_id FROM accounts WHERE patient_id=?").bind(pt.id).first();
  if (has) return;
  const email = String(pt.data.email || "").toLowerCase();
  const taken = email && await env.DB.prepare("SELECT patient_id FROM accounts WHERE email=?").bind(email).first();
  await env.DB.prepare("INSERT INTO accounts (patient_id,email,dob) VALUES (?,?,?)").bind(pt.id, taken || !email ? `${pt.id}@no-email.invalid` : email, pt.data.dob).run();
}

// Amount for a membership / Rx-on-file purchase, including whether some months still need a prescription.
async function linkAmount(env, patientId, rx, months, speed, cover) {
  if (rx.status === "cancelled") throw httpErr(400, "That prescription isn't available");
  const pricing = memberPricing(rx, months, speed);
  const { results } = await env.DB.prepare("SELECT data FROM records WHERE kind='rxOnFile' AND patient_id=?").bind(patientId).all();
  const today = etYmd(new Date());
  const active = results.map(r => JSON.parse(r.data)).filter(r => r.productId === rx.productId && r.status !== "cancelled" && addDaysYmd(r.writtenYmd, 365) >= today);
  const fillsLeft = r => Math.max(0, r.refills + 1 - (r.fillsAllocated || 0));
  const short = rx.compounded ? active.reduce((a, r) => a + fillsLeft(r), 0) < months : fillsLeft(rx) * rx.daysSupply < months * 30;
  if (short && !["prescriber", "provider"].includes(cover)) throw httpErr(400, "Choose how to get the rest of your prescription");
  const reviewFee = short && cover === "provider" ? PROVIDER_FEE : 0;
  return { meds: pricing.meds, ship: pricing.ship, reviewFee, short, total: Math.round((pricing.meds + pricing.ship + reviewFee) * 100) / 100 };
}
const addDaysYmd = (ymd, n) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function checkLinkPurchase(env, me, payload, ctxInfo) {
  const pi = await env.DB.prepare("SELECT * FROM payment_intents WHERE id=? AND purpose='link' AND status='created' AND patient_id=?").bind(String(payload?.paymentIntentId || ""), me.patientId).first();
  if (!pi) throw httpErr(400, "Payment not found. Please try again.");
  const det = JSON.parse(pi.details);
  const main = ctxInfo.newLinkOrders.find(o => o.source === "link");
  if (!main) throw httpErr(400, "Bad order");
  if (Math.abs(cents(main.totals?.total || 0) - pi.amount) > 1) throw httpErr(400, "Total changed, refresh and try again");
  if (!main.lines.every(l => l.id === (det.productId || l.id))) throw httpErr(400, "Bad order");
  if (!testPayments(env)) {
    const s = await stripe(env, "GET", `payment_intents/${pi.id}`);
    if (s.status !== "succeeded" || s.amount !== pi.amount) throw httpErr(402, "Payment didn't complete");
    if (s.payment_method) await env.DB.prepare("UPDATE accounts SET stripe_payment_method=?, stripe_customer_id=COALESCE(stripe_customer_id,?) WHERE patient_id=?").bind(s.payment_method, s.customer, me.patientId).run();
  }
  main.payment = { provider: testPayments(env) ? "test" : "stripe", intentId: pi.id, status: "captured", authorized: pi.amount / 100, captured: pi.amount / 100, refunded: 0, last4: main.payment?.last4 || "" };
  for (const o of ctxInfo.newLinkOrders) {
    if (o.source === "link-extension") o.payment = { provider: main.payment.provider, status: "included", authorized: 0, captured: 0, refunded: 0 };
    for (const l of o.lines) if (!PRODUCTS.get(l.id)) throw httpErr(400, "Unknown product");
  }
  await env.DB.prepare("UPDATE payment_intents SET status='captured', captured=amount, order_id=? WHERE id=?").bind(main.id, pi.id).run();
}

/* Abandoned carts: a code is only valid if we issued it to that person, and only once.
   Codes live in the records store as kind "promos" so they expire and can be audited like anything else. */
async function checkPromo(env, code, email) {
  if (!code) return null;
  const rec = await getRecord(env, "promos", String(code).toUpperCase().slice(0, 24));
  if (!rec) throw httpErr(400, "That code isn't valid");
  const p = rec.data;
  if (p.usedAt) throw httpErr(400, "That code has already been used");
  if (p.expires && p.expires < nowISO()) throw httpErr(400, "That code has expired");
  if (p.email && email && p.email.toLowerCase() !== String(email).toLowerCase()) throw httpErr(400, "That code belongs to a different account");
  return { code: rec.id, pct: p.pct };
}

/* A live video visit can be required per medication class or per product, in named states.
   Stored as a setting so it changes without a deploy: {"glp1":["AR","LA"],"product:compounded-enclomiphene":["NY"]} */
let videoCache = { at: 0, rules: {} };
async function videoRules(env) {
  if (!live(env)) return {};
  if (Date.now() - videoCache.at < 30000) return videoCache.rules;
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key='video_rules'").first();
    videoCache = { at: Date.now(), rules: row?.value ? JSON.parse(row.value) : {} };
  } catch { videoCache = { at: Date.now(), rules: {} }; }
  return videoCache.rules;
}

/* =================== Provider pay =================== */
/* The patient's $20 review fee is the provider's fee for the asynchronous visit. The platform keeps a service
   fee out of it (platform_fee_per_review, default $5) for the technology, pharmacy coordination and support;
   the rest goes to the provider. Payout rows are written when the note is signed, never by the browser. */
async function recordProviderPay(env, who, writes, existing) {
  const notes = writes.filter(w => w.kind === "notes" && !existing.get(`notes:${w.id}`));
  if (!notes.length || who.kind !== "staff") return;
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key='platform_fee_per_review'").first();
  const platformFee = Math.max(0, Number(row?.value ?? 5));
  for (const n of notes) {
    const o = await getRecord(env, "orders", n.data.orderId);
    if (!o) continue;
    // Declined prescriptions are refunded to the patient in full, so no fee is collected and none is paid out.
    const reviewed = o.data.lines.filter(l => l.rx === "need" && ["approved", "external"].includes(l.status));
    if (!reviewed.length) continue;
    const fees = reviewed.reduce((a, l) => a + (l.fee || 0), 0);
    const platform = Math.round(Math.min(fees, platformFee * reviewed.length) * 100) / 100;
    const amount = Math.round((fees - platform) * 100) / 100;
    if (amount <= 0) continue;
    await insertRecord(env, "payouts", {
      id: `pay_${uid(10)}`, providerEmail: who.email, providerName: who.name, orderId: o.id, orderNumber: o.data.number,
      noteId: n.id, reviews: reviewed.length, approved: reviewed.filter(l => l.status === "approved").length,
      declined: o.data.lines.filter(l => l.rx === "need" && l.status === "declined").length,
      patientPaid: Math.round(fees * 100) / 100, platformFee: platform, rate: Math.round((fees - platform) / reviewed.length * 100) / 100,
      amount, patientState: o.data.patient?.state || "", status: "unpaid", at: nowISO()
    }, null);
    await audit(env, who.email, who.role, "payout.accrue", "payouts", o.id, `patient $${fees.toFixed(2)} - platform $${platform.toFixed(2)} = $${amount.toFixed(2)}`).run();
  }
}

/* =================== Patient status updates =================== */
/* The patient hears about every step. Messages never name the medication; the detail lives behind their login. */
const STAGE_TEXT = {
  queue: "is being prepared at the pharmacy", verify: "is with the pharmacist for checking", packed: "is packed and ready to ship",
  shipped: "has shipped", delivered: "was delivered", transfer: "transfer is in progress with your other pharmacy"
};
const TRACK_TEXT = { in_transit: "is on its way", out_for_delivery: "is out for delivery today", delivered: "was delivered", exception: "has a delivery problem — we're looking into it" };
async function notifyPatient(env, writes, existing) {
  const sent = new Set();
  const tell = async (orderId, line, sms) => {
    const o = await getRecord(env, "orders", orderId);
    if (!o || sent.has(orderId + line)) return;
    sent.add(orderId + line);
    const p = o.data.patient;
    const url = `${publicUrl(env)}/#/account`;
    await sendEmail(env, p.email, `Update on order ${o.data.number}`, `Hi ${p.first},\n\nYour order ${o.data.number} ${line}\n\nSee the details and tracking in your account: ${url}\n\nQuestions? Reply to this email or call us Monday–Friday, 9 AM–5 PM ET.`);
    if (sms !== false) await sendText(env, p.phone, `DeliverMyMedications: your order ${o.data.number} ${line} ${url}`);
  };
  for (const w of writes) {
    if (w.kind === "fills") {
      const old = existing.get(`fills:${w.id}`)?.data;
      const f = w.data;
      if (!old) { if (!f.holdUntil && !f.pendingRx) await tell(f.orderId, `${STAGE_TEXT.queue}.`); continue; }
      if (old.stage !== f.stage && STAGE_TEXT[f.stage]) {
        const extra = f.stage === "shipped" && f.tracking ? ` Track it: ${f.carrier} ${f.tracking}.` : "";
        await tell(f.orderId, `${STAGE_TEXT[f.stage]}.${extra}`);
      } else if (old.trackStatus !== f.trackStatus && TRACK_TEXT[f.trackStatus]) {
        await tell(f.orderId, `${TRACK_TEXT[f.trackStatus]}.`);
      }
      if (!old.cancelled && f.cancelled) await tell(f.orderId, "had a shipment cancelled and refunded.");
    }
    if (w.kind === "orders") {
      const old = existing.get(`orders:${w.id}`)?.data;
      if (!old) continue;
      const o = w.data;
      const wasReview = old.lines.some(l => l.status === "review");
      const nowDecided = !o.lines.some(l => l.status === "review");
      if (wasReview && nowDecided) {
        const ok = o.lines.filter(l => l.status === "approved").length;
        const ext = o.lines.filter(l => l.status === "external").length;
        const no = o.lines.filter(l => l.status === "declined").length;
        const parts = [];
        if (ok) parts.push(`${ok} approved and heading to our pharmacy`);
        if (ext) parts.push(`${ext} sent to your own pharmacy`);
        if (no) parts.push(`${no} not approved (you weren't charged for those)`);
        await tell(o.id, `was reviewed by a licensed provider: ${parts.join(", ")}.`);
      }
      if (old.status !== "info" && o.status === "info") await tell(o.id, "has a question from the provider waiting for you.", false);
    }
  }
}

/* =================== Messages for pharmacy-entered Rx =================== */
async function sendLinkMessages(env, writes, existing) {
  for (const w of writes.filter(w => w.kind === "links")) {
    const old = existing.get(`links:${w.id}`)?.data;
    const fresh = !old || (old.sentAt !== w.data.sentAt && w.data.status === "sent");
    if (!fresh || w.data.status !== "sent") continue;
    const pt = await getRecord(env, "patients", w.data.patientId);
    if (!pt) continue;
    await updateRecord(env, "links", w.id, d => { if (d.token === pt.data.token) return false; d.token = pt.data.token; });
    const url = `${publicUrl(env)}/#/rx/${pt.data.token}`;
    await sendText(env, pt.data.phone, `DeliverMyMedications: Hi ${pt.data.first}, your prescription is ready. Review it and choose delivery here: ${url} Reply STOP to opt out.`);
    await sendEmail(env, pt.data.email, "Your prescription is ready", `Hi ${pt.data.first},\n\nYour pharmacy has a prescription ready for you. Confirm your date of birth to review it and choose delivery:\n\n${url}\n\nQuestions? Call us Monday–Friday, 9 AM–5 PM ET.`);
  }
}

/* =================== Scheduled jobs =================== */
async function everyFifteenMinutes(env) {
  const now = Date.now(), today = etYmd(new Date());
  // 24-hour clock on pharmacy work.
  const { results } = await env.DB.prepare("SELECT id,data FROM records WHERE kind='fills' AND json_extract(data,'$.stage') IN ('transfer','queue','verify','packed')").all();
  for (const r of results) {
    const f = JSON.parse(r.data);
    if (f.cancelled || f.pendingRx || (f.holdUntil && f.holdUntil > today)) continue;
    let start = new Date(f.createdAt);
    if (f.holdUntil) { const h = new Date(`${f.holdUntil}T09:00:00-04:00`); if (h > start) start = h; }
    start = nextOpen(start);
    const hours = (now - start.getTime()) / 3600000;
    if (hours >= 20 && !f.alertedAt) {
      await sendEmail(env, env.ALERT_EMAIL, `Needs attention: ${f.number}`, `${f.number} has been waiting ${Math.floor(hours)} hours and must move within 24. Open the pharmacy board: ${publicUrl(env)}/#/pharmacy`);
      await updateRecord(env, "fills", f.id, d => { d.alertedAt = nowISO(); });
      await insertRecord(env, "alerts", { id: `al_${uid(10)}`, at: nowISO(), subject: `Needs attention: ${f.number}`, body: `Waiting ${Math.floor(hours)} hours`, fillId: f.id });
    }
    if (hours >= 24 && !f.breachedAt) {
      await updateRecord(env, "fills", f.id, d => { d.breachedAt = nowISO(); });
      await insertRecord(env, "breaches", { id: `br_${uid(10)}`, at: nowISO(), label: f.number, due: new Date(start.getTime() + 24 * 3600000).toISOString(), fillId: f.id });
      await sendEmail(env, env.ALERT_EMAIL, `Missed 24 hours: ${f.number}`, `${f.number} passed the 24-hour limit.`);
    }
  }
  // Patient link reminders at 24 and 72 hours; expire after 7 days.
  const { results: links } = await env.DB.prepare("SELECT id,data FROM records WHERE kind='links' AND json_extract(data,'$.status') IN ('sent','opened')").all();
  for (const r of links) {
    const k = JSON.parse(r.data);
    const age = (now - new Date(k.sentAt || k.createdAt).getTime()) / 3600000;
    if (new Date(k.expiresAt).getTime() < now) { await updateRecord(env, "links", k.id, d => { d.status = "expired"; d.log = [...(d.log || []), { t: nowISO(), text: "Expired after 7 days" }]; }); continue; }
    for (const [h, flag] of [[24, "rem24"], [72, "rem72"]]) {
      if (age >= h && !k[flag] && k.status === "sent") {
        const pt = await getRecord(env, "patients", k.patientId);
        if (pt) await sendText(env, pt.data.phone, `DeliverMyMedications: a reminder that your prescription is ready: ${publicUrl(env)}/#/rx/${pt.data.token}`);
        await updateRecord(env, "links", k.id, d => { d[flag] = nowISO(); d.log = [...(d.log || []), { t: nowISO(), text: `${h}-hour reminder sent` }]; });
      }
    }
  }
}
async function everyMorning(env) {
  const today = etYmd(new Date());
  const in3 = addDaysYmd(today, 3);
  const { results } = await env.DB.prepare("SELECT id,data FROM records WHERE kind='orders'").all();
  let due = 0;
  for (const r of results) {
    const o = JSON.parse(r.data);
    for (const l of o.lines || []) {
      if (!l.auto || l.status !== "approved" || (!(l.refillsLeft > 0) && !l.membership)) continue;
      if (l.nextFill && l.nextFill <= today) due++;
      if (l.nextFill === in3 && l.remindedFor !== in3) {
        await sendText(env, o.patient.phone, `DeliverMyMedications: your auto-refill ships in 3 days. To change or pause it, visit ${publicUrl(env)}/#/account`);
        await updateRecord(env, "orders", o.id, d => { const x = d.lines.find(y => y.lid === l.lid); if (!x || x.remindedFor === in3) return false; x.remindedFor = in3; });
      }
    }
  }
  if (due) await sendEmail(env, env.ALERT_EMAIL, `${due} auto-ship order${due > 1 ? "s" : ""} due today`, `Open the pharmacy board to process them (they're charged and queued when the board opens): ${publicUrl(env)}/#/pharmacy`);
}

/* =================== Entry =================== */
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const isApi = url.pathname.startsWith("/api/") || url.pathname.startsWith("/staff/") || url.pathname.startsWith("/admin/") || url.pathname.startsWith("/auth/google/");
    if (!isApi) return env.ASSETS.fetch(req);
    const key = `${req.method} ${url.pathname}`;
    const handler = routes[key];
    try {
      if (!handler) throw httpErr(404, "Not found");
      if (!["GET /api/config", "GET /api/health", "GET /api/catalog"].includes(key) && !live(env)) throw httpErr(503, "The backend isn't turned on yet (set LIVE_MODE=true after setup).");
      if (live(env) && /\/api\/(checkout|links|refills|admin\/product)/.test(url.pathname)) { overrideCache.at = /admin\/product/.test(url.pathname) ? 0 : overrideCache.at; await loadOverrides(env); }
      if (req.method === "POST") {
        const origin = req.headers.get("Origin");
        const isWebhook = /webhook$/.test(url.pathname);
        if (!isWebhook && origin && origin !== url.origin) throw httpErr(403, "Cross-site request blocked");
      }
      return await handler(req, env, url, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.log("error", key, e && e.stack || e);
      // Sign-in pages are browser navigations: send people back to the site with a readable reason.
      if (url.pathname.startsWith("/auth/") || url.pathname.startsWith("/staff/")) {
        // Say what actually went wrong: chasing these through the log viewer wastes everyone's time.
        const raw = String((e && e.message) || e).slice(0, 160);
        const hint = /no such table|no such column/i.test(raw)
          ? `Database: ${raw}. Run the migration files in your D1 console.`
          : `Sign-in failed: ${raw}`;
        return new Response(null, { status: 302, headers: { Location: `${url.origin}/#/staff-signin?e=${encodeURIComponent(hint)}` } });
      }
      return json({ error: "Something went wrong. Please try again." }, 500);
    }
  },
  async scheduled(evt, env, ctx) {
    if (!live(env)) return;
    if (evt.cron === "0 10 * * *") ctx.waitUntil(everyMorning(env));
    else ctx.waitUntil(everyFifteenMinutes(env));
    ctx.waitUntil(chaseCarts(env).catch(e => console.log("carts", e)));
  }
};
