// Quick checks that run without a server: catalog extraction and server-side pricing.
import assert from "node:assert/strict";
import { PRODUCTS, price, cartTotals, verifyOrder, memberPricing, refillCharge, capturableTotal } from "../src/pricing.js";

const p = id => { const x = PRODUCTS.get(id); assert.ok(x, `missing ${id}`); return x; };
assert.ok(PRODUCTS.size > 400, "catalog loaded");
// 60/90-day supplies: 10% / 20% off
assert.equal(price(p("lisinopril"), 0, 0), 24.99);
assert.equal(price(p("lisinopril"), 0, 2), 59.98);
// compounded plans
assert.equal(price(p("compounded-semaglutide"), 0, 2), 477.6);
assert.equal(p("compounded-tirzepatide").dosages.at(-1), "18 mg weekly");
// cart: need-Rx fee, cold chain prepaid per month
const t = cartTotals([{ id: "compounded-semaglutide", dose: 3, qty: 2, rx: "need", count: 1 }, { id: "coq10", dose: 0, qty: 0, rx: "otc", count: 1 }], "standard");
assert.deepEqual([t.sub, t.fees, t.ship, t.total], [547.59, 20, 75, 642.59]);
assert.equal(cartTotals([{ id: "lisinopril", dose: 0, qty: 0, rx: "need", count: 1 }], "next").ship, 20);
assert.throws(() => cartTotals([{ id: "coq10", dose: 0, qty: 0, rx: "need", count: 1 }], "standard"), /prescription option/);
// order verification rejects a changed price
const order = {
  patient: { state: "NY" }, shipping: { speed: "standard" }, totals: { total: 44.99 },
  lines: [{ id: "lisinopril", dosage: "2.5 mg", quantity: "30-day supply", price: 24.99, fee: 20, rx: "need", count: 1, status: "review", refills: 0, refillsLeft: 0 }]
};
verifyOrder(order);
assert.throws(() => verifyOrder({ ...order, lines: [{ ...order.lines[0], price: 1 }] }), /price changed/);
assert.throws(() => verifyOrder({ ...order, patient: { state: "AR" } }), /can't ship/);
// memberships and refills
const m = memberPricing({ productId: "compounded-semaglutide", compounded: true, pricing: {} }, 3, "standard");
assert.deepEqual([m.meds, m.ship], [477.6, 75]);
assert.equal(refillCharge({ membership: { prepaid: 477.6, shipPrepaid: 75 } }), 552.6);
assert.equal(refillCharge({ name: "Lisinopril", price: 59.98, count: 1 }), 59.98);
assert.equal(capturableTotal({ totals: { ship: 0 }, lines: [{ status: "approved", price: 24.99, count: 1, fee: 20 }, { status: "declined", price: 10, count: 1, fee: 20 }] }), 44.99);
console.log("smoke: all pricing checks passed");
