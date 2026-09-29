// Server-side pricing. Mirrors the storefront (public/index.html) so the server never trusts a price sent by a browser.
// src/generated/catalog.json is extracted from public/index.html by scripts/build.mjs on every build.
import DATA from "./generated/catalog.json" with { type: "json" };

export const { PROVIDER_FEE, EXCLUDED_STATES, SHIP, PLAN_DISCOUNT } = DATA.constants;
const SUPPLY_SUBS = new Set(DATA.supplySubs);

function supplyOk(c) { return c.kind === "rx" && SUPPLY_SUBS.has(c.sub) && !["carton", "tube", "pump", "doc"].includes(c.pkg); }

function buildProduct(c) {
  // A product can carry its own quantity tiers and prices (gridQtys/gridPrices), as the storefront does.
  const g = DATA.grid[c.id] || (c.gridQtys ? { qtys: c.gridQtys, doses: c.dosages, prices: Object.fromEntries(c.gridQtys.map(q => [`${c.dosages[0]}|${q}`, c.gridPrices[q]])) } : null);
  const plans = /compounded/i.test(c.name), supply = !g && !plans && supplyOk(c);
  const qtys = g ? g.qtys : plans ? ["30-day plan", "60-day plan", "90-day plan"] : supply ? ["30-day supply", "60-day supply", "90-day supply"] : [c.qtyLabel || "Standard quantity"];
  let dosages = c.dosages;
  if (c.slider) { const { min, max, step, unit } = c.slider; dosages = []; for (let v = min; v <= max + 1e-9; v += step) dosages.push(`${+v.toFixed(2)} ${unit}`); }
  if (g && g.doses) dosages = g.doses;
  return [c.id, { ...c, dosages, qtys, plans, supply, grid: g ? g.prices : null, rx: c.kind !== "otc" }];
}
const BASE = new Map(DATA.catalog.map(buildProduct));
export let PRODUCTS = BASE;
// Product changes made in the admin console are applied here too, so the server prices what the site shows.
export function setOverrides(list) {
  if (!list || !list.length) { PRODUCTS = BASE; return; }
  const merged = new Map(DATA.catalog.map(c => [c.id, c]));
  for (const o of list) {
    const base = merged.get(o.id);
    if (base) merged.set(o.id, { ...base, ...o, id: base.id });
    else merged.set(o.id, { id: o.id, name: o.name || o.id, cat: o.cat || "", sub: o.sub || "", brandFor: o.brandFor || "", price: o.price ?? 0, pkg: "bottle", att: o.att || [], dosages: o.dosages || ["As prescribed"], use: o.use || "", kind: o.kind || "rx", qtyLabel: o.qtyLabel || "Standard quantity", hidden: o.hidden });
  }
  PRODUCTS = new Map([...merged.values()].filter(c => !c.hidden).map(buildProduct));
}

const r2 = n => Math.round(n * 100) / 100;
export const isCompounded = p => !!p && /compounded/i.test(p.name);

export function price(p, d, q) {
  const base = (p.prices && p.prices[p.dosages[d]]) || p.price;   // some products price per strength
  if (!p.grid) {
    if (!p.plans && !p.supply) return base;
    const m = q + 1;
    return r2(base * m * (1 - ({ 1: 0, 2: 0.10, 3: 0.20 })[m]));
  }
  const v = p.grid[`${p.dosages[d]}|${p.qtys[q]}`];
  return v == null ? null : v;
}
// "onfile" = buying against a prescription we already hold, so no second review fee.
export const feeFor = (p, rx) => rx === "need" && p.kind !== "service" ? PROVIDER_FEE : 0;
export const ASK_DOSE = -1;   // the patient asked the provider to choose the strength
export const shippingFor = (cold, speed) => cold ? SHIP.coldFee : speed === "next" ? SHIP.nextDayFee : SHIP.standardFee;

// cart: [{id, dose, qty, rx, count}]
// A promotion reduces the medication subtotal only — never the provider's fee or shipping.
export const promoOff = (sub, promo) => promo && promo.pct ? Math.round(sub * (Math.min(20, Math.max(1, promo.pct)) / 100) * 100) / 100 : 0;
export function cartTotals(cart, speed, promo) {
  if (!Array.isArray(cart) || !cart.length || cart.length > 30) throw new Error("Cart is empty or too large");
  let sub = 0, fees = 0;
  for (const l of cart) {
    const p = PRODUCTS.get(l.id);
    if (!p) throw new Error(`Unknown product ${l.id}`);
    if (l.dose === ASK_DOSE) {            // review only: no strength chosen yet, nothing dispensed
      if (l.rx !== "need" || !p.rx) throw new Error("Only a new prescription can be left for the provider to dose");
      fees += feeFor(p, l.rx);
      continue;
    }
    if (!Number.isInteger(l.dose) || !p.dosages[l.dose]) throw new Error(`Bad strength for ${p.name}`);
    if (!Number.isInteger(l.qty) || !p.qtys[l.qty]) throw new Error(`Bad quantity for ${p.name}`);
    if (!Number.isInteger(l.count) || l.count < 1 || l.count > 9) throw new Error("Bad count");
    if (!["need", "have", "otc", "onfile"].includes(l.rx) || (l.rx === "otc") === p.rx) throw new Error("Bad prescription option");
    const v = price(p, l.dose, l.qty);
    if (v == null) throw new Error(`${p.name} isn't sold in that size`);
    sub += v * l.count;
    fees += feeFor(p, l.rx);
  }
  const cold = cart.some(l => l.dose !== ASK_DOSE && isCompounded(PRODUCTS.get(l.id)));
  const coldMonths = Math.max(1, ...cart.filter(l => l.dose !== ASK_DOSE && PRODUCTS.get(l.id).plans).map(l => l.qty + 1));
  const nothingShips = cart.length > 0 && cart.every(l => l.dose === ASK_DOSE);
  const ship = nothingShips ? 0 : cold ? SHIP.coldFee * coldMonths : shippingFor(false, speed);
  const discount = promoOff(r2(sub), promo);
  return { sub: r2(sub), fees, ship, cold, discount, total: r2(sub + fees + ship - discount) };
}

// Rebuild the cart from a submitted order and check every price the browser computed.
const isGlp1 = p => /GLP-1/i.test(p.sub || "") || (p.att || []).includes("glp1");
export function verifyOrder(order) {
  if (!order || !Array.isArray(order.lines)) throw new Error("Bad order");
  for (const l of order.lines) {
    if (!l.askDose) continue;
    if (l.rx !== "need") throw new Error("Only a new prescription can be left for the provider to dose");
    if (+l.price !== 0 || l.count !== 1) throw new Error("A line with no dose yet can't carry a price");
    if ((l.fee || 0) !== PROVIDER_FEE) throw new Error("The review fee is still due");
  }
  // One of each prescription per order, and never two weight-loss medications at once.
  const rxIds = order.lines.filter(l => l.rx !== "otc").map(l => l.id);
  if (new Set(rxIds).size !== rxIds.length) throw new Error("Only one of each prescription per order");
  if (order.lines.filter(l => l.rx !== "otc" && isGlp1(PRODUCTS.get(l.id) || {})).length > 1) throw new Error("Only one weight-loss medication per order");
  for (const l of order.lines) if (l.rx !== "otc" && l.count !== 1) throw new Error("Prescriptions are dispensed one per order");
  const cart = order.lines.map(l => {
    const p = PRODUCTS.get(l.id);
    if (!p) throw new Error(`Unknown product ${l.id}`);
    if (l.askDose) return { id: l.id, dose: ASK_DOSE, qty: 0, rx: l.rx, count: 1 };
    const dose = p.dosages.indexOf(l.dosage), qty = p.qtys.indexOf(l.quantity);
    if (dose < 0 || qty < 0) throw new Error(`${p.name}: strength or quantity doesn't match the catalog`);
    const v = price(p, dose, qty);
    const expectLine = p.plans ? r2(v / (qty + 1)) : v;
    if (Math.abs((l.price ?? -1) - expectLine) > 0.011) throw new Error(`${p.name}: price changed, refresh and try again`);
    if (p.plans && Math.abs((l.plan?.prepaid ?? -1) - v) > 0.011) throw new Error(`${p.name}: plan price changed`);
    if ((l.fee || 0) !== feeFor(p, l.rx)) throw new Error("Fee mismatch");
    const expectStatus = l.rx === "need" ? "review" : l.rx === "have" ? "transfer" : "approved";
    if (l.status !== expectStatus) throw new Error("Bad line status");
    if ((l.refills || 0) !== 0 || (l.refillsLeft || 0) !== 0) throw new Error("Refills are set by the provider");
    return { id: l.id, dose, qty, rx: l.rx, count: l.count };
  });
  const t = cartTotals(cart, order.shipping?.speed === "next" ? "next" : "standard", order.promo);
  if (Math.abs(t.total - (order.totals?.total ?? -1)) > 0.011) throw new Error("Order total changed, refresh and try again");
  if (EXCLUDED_STATES.includes(order.patient?.state)) throw new Error("We can't ship to that state");
  return t;
}

// Membership / Rx-on-file purchase (patient link page)
export function memberPricing(rx, months, speed) {
  const p = PRODUCTS.get(rx.productId);
  if (!p) throw new Error("Unknown product");
  const monthly = rx.pricing?.custom ?? p.price;
  const disc = (rx.pricing?.discountPct || 0) / 100;
  const planDisc = PLAN_DISCOUNT[months * 30] || 0;
  const meds = r2(monthly * months * (1 - disc) * (1 - planDisc));
  const ship = rx.compounded ? SHIP.coldFee * months : shippingFor(false, speed);
  return { monthly, months, planDisc, meds, ship };
}

// What a patient-requested refill costs (stored line prices were verified when the order was placed).
export function refillCharge(line) {
  if (line.membership) return r2(line.membership.prepaid + line.membership.shipPrepaid);
  const base = (line.plan && line.plan.prepaid != null ? line.plan.prepaid : line.price) * line.count;
  const months = line.plan ? Math.round(line.plan.days / 30) : 1;
  return r2(base + (/compounded/i.test(line.name) ? SHIP.coldFee * months : 0));
}

// The most that may be captured on an order: approved or transferred lines, their fees, and shipping.
export function capturableTotal(order) {
  let t = 0;
  for (const l of order.lines) {
    // The patient asked the provider to choose: we keep the review fee, the medication is bought afterwards.
    // Declined means refunded in full, review fee included — same as any other decline.
    if (l.askDose) { if (["recommended", "approved", "external"].includes(l.status)) t += (l.fee || 0); continue; }
    // "external" = the provider sent the prescription to the patient's own pharmacy: we keep only the review fee.
    if (l.status === "external") t += (l.fee || 0);
    else if (["approved", "transfer"].includes(l.status)) t += (l.plan && l.plan.prepaid != null ? l.plan.prepaid : l.price) * l.count + (l.fee || 0);
  }
  if (order.lines.some(l => ["approved", "transfer"].includes(l.status) && l.kind !== "service")) t += order.totals?.ship || 0;   // no shipping if nothing ships from us
  return r2(t);
}
