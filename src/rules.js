// Who may write what. The browser proposes record changes; these rules decide whether they are allowed.
import { httpErr, KINDS } from "./lib.js";

export const PATIENT_ACTIONS = new Set(["/api/refills", "/api/patient/auto-refill", "/api/patient/reply", "/api/links/complete"]);
const PROVIDER_ACTIONS = /^\/api\/provider\//;
const PHARMACY_ACTIONS = /^\/api\/(pharmacy\/[a-z/-]+|refills|carrier\/webhook)$/;
// Customer service helps patients without touching clinical decisions or the dispensing record.
const SUPPORT_ACTIONS = /^\/api\/(pharmacy\/links\/(resend|cancel)|support\/[a-z-]+)$/;

export const ROLES = ["provider", "pharmacist", "technician", "support", "admin"];
export const ROLE_LABELS = { provider: "Provider", pharmacist: "Pharmacist", technician: "Pharmacy technician", support: "Customer service", admin: "Admin" };

export function staffMayRun(who, action) {
  if (who.owner) return true;                      // super admin
  if (who.role === "admin") return PROVIDER_ACTIONS.test(action) || PHARMACY_ACTIONS.test(action) || SUPPORT_ACTIONS.test(action);
  if (who.role === "provider") return PROVIDER_ACTIONS.test(action);
  if (who.role === "pharmacist" || who.role === "technician") return PHARMACY_ACTIONS.test(action) || SUPPORT_ACTIONS.test(action);
  if (who.role === "support") return SUPPORT_ACTIONS.test(action);
  return false;
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const appendOnly = (oldArr = [], newArr = []) => newArr.length >= oldArr.length && eq(oldArr, newArr.slice(0, oldArr.length));
function onlyChanged(oldObj, newObj, allowed, what) {
  const keys = new Set([...Object.keys(oldObj || {}), ...Object.keys(newObj || {})]);
  for (const k of keys) {
    if (allowed.includes(k)) continue;
    if (!eq(oldObj?.[k], newObj?.[k])) throw httpErr(403, `${what}: "${k}" can't be changed here`);
  }
}

export function checkShape(changes) {
  if (!Array.isArray(changes) || changes.length > 80) throw httpErr(400, "Too many changes");
  const seen = new Set();
  for (const c of changes) {
    if (!c || !KINDS.includes(c.kind) || typeof c.id !== "string" || !c.id || c.id.length > 80) throw httpErr(400, "Bad change");
    if (!c.data || typeof c.data !== "object" || c.data.id !== c.id) throw httpErr(400, "Bad record");
    if (JSON.stringify(c.data).length > 250_000) throw httpErr(413, "Record too large");
    const k = `${c.kind}:${c.id}`; if (seen.has(k)) throw httpErr(400, "Duplicate change"); seen.add(k);
  }
}

// Work out which patient owns each changed record.
export function ownerOf(change, existing, changesByKey, existingByKey) {
  const ex = existing.get(`${change.kind}:${change.id}`);
  const find = (kind, id) => changesByKey.get(`${kind}:${id}`)?.data || existingByKey.get(`${kind}:${id}`)?.data;
  const orderOwner = orderId => { const o = find("orders", orderId); return o?.patientId || existingByKey.get(`orders:${orderId}`)?.patient_id || null; };
  switch (change.kind) {
    case "patients": return change.id;
    case "orders": return change.data.patientId || ex?.patient_id || null;
    case "fills": return orderOwner(change.data.orderId);
    case "notes": return orderOwner(change.data.orderId);
    case "links": case "rxOnFile": return change.data.patientId || ex?.patient_id || null;
    case "tasks": return change.data.patientId || (change.data.orderId ? orderOwner(change.data.orderId) : null) || ex?.patient_id || null;
    case "shipments": { const f = find("fills", (change.data.fillIds || [])[0]); return f ? orderOwner(f.orderId) : null; }
    default: return null;
  }
}

/* ---------- Staff ---------- */
const SUPPORT_FIELDS = { orders: ["patient", "events", "flag"], tickets: ["messages", "status"], links: ["events", "status", "sentAt", "reminders"], patients: ["phone", "email", "first", "last"] };
export function checkStaffChange(who, action, c, ex, ctx) {
  // Customer service: contact details, ticket replies and link resends only — never clinical or dispensing data.
  if (who.role === "support" && !who.owner) {
    if (!["tickets", "orders", "links", "patients", "tasks"].includes(c.kind)) throw httpErr(403, "Customer service can't change that");
    if (!["/api/support/address", "/api/support/note", "/api/pharmacy/links/resend", "/api/pharmacy/links/cancel"].includes(action)) throw httpErr(403, "Customer service can't do that");
    if (!ex && c.kind !== "tasks") throw httpErr(403, "Customer service can't create that");
    if (ex && SUPPORT_FIELDS[c.kind]) onlyChanged(ex.data, c.data, SUPPORT_FIELDS[c.kind], "Customer service");
    if (c.kind === "orders" && !eq(ex.data.patient, c.data.patient)) {
      const shipped = (ex.data.lines || []).some(l => ["shipped", "delivered"].includes(l.status));
      if (shipped) throw httpErr(403, "That order has already shipped — the address can't be changed");
    }
    return;
  }
  if (c.kind === "notes") {
    if (ex) throw httpErr(403, "Signed notes can't be changed");
    if (!["provider", "admin"].includes(who.role)) throw httpErr(403, "Only providers sign notes");
    if (c.data.signedBy !== who.name) throw httpErr(403, `Notes must be signed as ${who.name}`);
    return;
  }
  if (c.kind === "orders") {
    const old = ex?.data;
    if (!old) {
      // Providers don't create orders; pharmacy may create link-extension orders only through patients. Staff-created orders are not allowed.
      throw httpErr(403, "Staff can't create orders directly");
    }
    if (old.patientId !== c.data.patientId && old.patientId) throw httpErr(403, "Order owner can't change");
    if (!appendOnly(old.events, c.data.events)) throw httpErr(403, "Order history is append-only");
    const oldLines = new Map((old.lines || []).map(l => [l.lid, l]));
    if ((c.data.lines || []).length !== oldLines.size) throw httpErr(403, "Order lines can't be added or removed");
    for (const l of c.data.lines) {
      const o = oldLines.get(l.lid);
      if (!o) throw httpErr(403, "Unknown order line");
      for (const k of ["id", "price", "fee", "count", "rx", "quantity"]) if (!eq(o[k], l[k])) throw httpErr(403, `Line "${k}" can't be changed`);
      if (o.status !== l.status) {
        const clinical = o.status === "review" && ["approved", "declined", "external"].includes(l.status);
        if (clinical) {
          if (!["provider", "admin"].includes(who.role)) throw httpErr(403, "Only a provider can approve or decline");
          if (who.role === "provider" && !who.owner && !who.states.includes(c.data.patient?.state)) throw httpErr(403, `You aren't licensed in ${c.data.patient?.state}`);
          if (["approved", "external"].includes(l.status) && l.kind !== "service" && !(l.sig || "").trim()) throw httpErr(400, "Approved prescriptions need directions");
          if (l.status === "external" && !(l.externalPharmacy?.name || "").trim()) throw httpErr(400, "Name the pharmacy the prescription was sent to");
        } else if (!["pharmacist", "technician", "admin"].includes(who.role)) throw httpErr(403, "Status change not allowed");
      }
    }
    return;
  }
  if (c.kind === "fills" && ex && ex.data.stage !== "packed" && c.data.stage === "packed") {
    if (!["pharmacist", "admin"].includes(who.role)) throw httpErr(403, "A pharmacist must verify before packing");
    if (!c.data.verifiedBy) throw httpErr(400, "Verification initials required");
  }
  if (c.kind === "fills" && ex && !appendOnly(ex.data.events, c.data.events)) throw httpErr(403, "Fill history is append-only");
  if (["applications", "products"].includes(c.kind)) throw httpErr(403, "Use the admin console");
  if (c.kind === "payouts") throw httpErr(403, "Provider pay is calculated by the server");
  if (who.role === "provider" && !["orders", "notes", "fills", "rxOnFile", "tasks"].includes(c.kind)) throw httpErr(403, "Not allowed for providers");
  if (c.kind === "patients" && ex && ex.data.email && c.data.email !== ex.data.email && !["pharmacist", "admin"].includes(who.role)) throw httpErr(403, "Only a pharmacist can change a patient's email");
}

/* ---------- Patients ---------- */
const LINE_PATIENT_FIELDS = ["auto", "intervalDays", "nextFill", "lastFillAt", "refillsLeft", "plan"];
export function checkPatientChange(me, action, c, ex, owner, ctx) {
  if (owner !== me.patientId) throw httpErr(403, "Not your record");
  switch (c.kind) {
    case "orders": {
      if (!ex) {
        if (action !== "/api/links/complete") throw httpErr(403, "Orders are placed through checkout");
        if (c.data.patientId !== me.patientId || !["link", "link-extension"].includes(c.data.source)) throw httpErr(403, "Bad order");
        ctx.newLinkOrders.push(c.data);
        return;
      }
      const old = ex.data;
      const allowedTop = ["events", "lines"];
      if (action === "/api/patient/reply") allowedTop.push("info", "status");
      // Blood work: the patient records how they'll get it done and sends the report back.
      if (action === "/api/patient/visit") {
        allowedTop.push("visit");
        const v = c.data.visit || {};
        if (!["needed", "proposed"].includes(v.status)) throw httpErr(403, "Only the provider confirms a visit");
        if (v.required !== old.visit?.required || (v.reason || "") !== (old.visit?.reason || "")) throw httpErr(403, "Visit requirements are set by the provider");
      }
      // Comfort medicines: the patient may only order one the provider already approved.
      // Marking a recommendation as bought, nothing else on that order.
      if (action === "/api/patient/bought") {
        allowedTop.push("lines", "events");
        const before = old.lines, after = c.data.lines;
        if (before.length !== after.length) throw httpErr(403, "Lines can't be added here");
        after.forEach((l, i) => {
          const b = before[i];
          const changed = Object.keys({ ...b, ...l }).filter(k => JSON.stringify(b[k]) !== JSON.stringify(l[k]));
          if (changed.length && (changed.join() !== "boughtAt" || b.status !== "recommended")) throw httpErr(403, "Only a recommendation can be marked bought");
        });
        return;
      }
      if (action === "/api/patient/comfort") {
        allowedTop.push("ancillaryOrders", "events");
        const added = (c.data.ancillaryOrders || []).slice((old.ancillaryOrders || []).length);
        if (added.length !== 1) throw httpErr(403, "One at a time");
        const ok = (old.ancillary || []).find(x => x.id === added[0].id && x.status === "approved");
        if (!ok) throw httpErr(403, "That isn't approved for you");
        if (Number(added[0].price) !== Number(ok.price)) throw httpErr(403, "Price mismatch");
        if (JSON.stringify(c.data.ancillary) !== JSON.stringify(old.ancillary)) throw httpErr(403, "Approvals are set by the provider");
        return;
      }
      if (action === "/api/patient/checkin") {
        allowedTop.push("checkins", "flag");
        if ((c.data.checkins || []).length !== (old.checkins || []).length + 1) throw httpErr(403, "One check-in at a time");
      }
      if (action === "/api/patient/labs") {
        allowedTop.push("labs");
        const size = JSON.stringify(c.data.labs || {}).length;
        if (size > 6_000_000) throw httpErr(413, "That file is too large — send a smaller photo or PDF");
        if ((c.data.labs?.required) !== (old.labs?.required)) throw httpErr(403, "Lab requirements are set by the provider");
      }
      onlyChanged(old, c.data, allowedTop, "Order");
      if (!appendOnly(old.events, c.data.events)) throw httpErr(403, "Order history is append-only");
      if (action === "/api/patient/reply" && old.status !== c.data.status && !(old.status === "info" && c.data.status === "review")) throw httpErr(403, "Bad status");
      if ((c.data.lines || []).length !== old.lines.length) throw httpErr(403, "Order lines can't be added or removed");
      for (let i = 0; i < old.lines.length; i++) {
        const o = old.lines[i], n = c.data.lines[i];
        if (o.lid !== n.lid) throw httpErr(403, "Order lines can't be reordered");
        onlyChanged(o, n, LINE_PATIENT_FIELDS, "Prescription");
        if (n.refillsLeft > o.refillsLeft) throw httpErr(403, "Refills can't be added");
        if (n.refillsLeft < o.refillsLeft) { if (action !== "/api/refills") throw httpErr(403, "Bad refill change"); ctx.refillLines.push({ order: old, line: o }); }
        if (!eq(o.plan, n.plan)) {
          if (!o.plan || !n.plan) throw httpErr(403, "Plan can't be changed");
          onlyChanged(o.plan, n.plan, ["doses"], "Plan");
          if (n.plan.doses.length !== o.plan.doses.length || n.plan.doses.some(d => !o.plan.doses.includes(d))) throw httpErr(403, "Dose can't be changed");
        }
        if (n.intervalDays != null && ![30, 60, 90, n.daysSupply].includes(n.intervalDays)) throw httpErr(400, "Bad interval");
        if (o.membership && action === "/api/refills" && !eq(o.lastFillAt, n.lastFillAt)) ctx.refillLines.push({ order: old, line: o });
      }
      return;
    }
    case "fills": {
      if (ex) throw httpErr(403, "Fills are updated by the pharmacy");
      const f = c.data;
      if (f.stage !== "queue" || f.verifiedBy || f.rxNumbers || f.tracking || f.shipmentId || f.cancelled) throw httpErr(403, "Bad fill");
      const okType = action === "/api/refills" ? ["refill", "auto", "plan"] : action === "/api/links/complete" ? ["new", "plan"] : [];
      if (!okType.includes(f.type)) throw httpErr(403, "Bad fill type");
      return;
    }
    case "tasks":
      if (ex || !["renewal"].includes(c.data.type) || c.data.status !== "open") throw httpErr(403, "Bad task");
      return;
    case "links":
      if (!ex) throw httpErr(403, "Bad link");
      onlyChanged(ex.data, c.data, ["status", "completedAt", "orderId", "log"], "Link");
      if (!["completed"].includes(c.data.status) || !appendOnly(ex.data.log, c.data.log)) throw httpErr(403, "Bad link change");
      return;
    case "rxOnFile":
      if (!ex) throw httpErr(403, "Prescriptions are entered by the pharmacy");
      onlyChanged(ex.data, c.data, ["fillsAllocated"], "Prescription on file");
      if ((c.data.fillsAllocated || 0) < (ex.data.fillsAllocated || 0) || (c.data.fillsAllocated || 0) > ex.data.refills + 1) throw httpErr(403, "Bad fill count");
      return;
    case "tickets":
      throw httpErr(403, "Use the help form to send messages");
    default:
      throw httpErr(403, "Not allowed");
  }
}
