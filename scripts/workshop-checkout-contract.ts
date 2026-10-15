import assert from "node:assert/strict";
import {
  canPurchaseWorkshop,
  isVerifiedWorkshopPayment,
  localWorkshopPurchasesEnabled,
  workshopCheckoutIdempotencyKey,
} from "../apps/web/src/workshops/checkout-contract";
import { workshopCheckoutOrigin } from "../apps/web/src/workshops/payments";

const now = Date.parse("2026-10-15T12:00:00Z");
const workshop = { state: "published", hasOffer: true, startsAt: "2026-11-01T17:00:00Z" };
assert.equal(canPurchaseWorkshop(workshop, now), true);
assert.equal(canPurchaseWorkshop({ ...workshop, state: "draft" }, now), false);
assert.equal(canPurchaseWorkshop({ ...workshop, hasOffer: false }, now), false);
assert.equal(canPurchaseWorkshop({ ...workshop, startsAt: "2026-10-14T17:00:00Z" }, now), false);
assert.equal(canPurchaseWorkshop({ ...workshop, startsAt: "invalid" }, now), false);
for (const runtime of ["local", "beta", "production"])
  for (const node of ["development", "test", "production"])
    assert.equal(
      localWorkshopPurchasesEnabled({ EGGHEAD_RUNTIME: runtime, NODE_ENV: node }),
      runtime === "local" && node === "development",
    );
const payment = {
  mode: "payment",
  payment_status: "paid",
  livemode: false,
  amount_total: 37500,
  metadata: {
    workshopId: "workshop",
    productId: "product",
    priceId: "price",
    expectedTotalCents: "37500",
  },
};
assert.equal(isVerifiedWorkshopPayment(payment), true);
for (const status of ["unpaid", "processing", "no_payment_required"])
  assert.equal(isVerifiedWorkshopPayment({ ...payment, payment_status: status }), false);
assert.equal(isVerifiedWorkshopPayment({ ...payment, livemode: true }), false);
assert.equal(isVerifiedWorkshopPayment({ ...payment, mode: "subscription" }), false);
assert.equal(isVerifiedWorkshopPayment({ ...payment, amount_total: 1 }), false);
assert.equal(
  isVerifiedWorkshopPayment({
    ...payment,
    amount_total: 0,
    metadata: { ...payment.metadata, expectedTotalCents: "0" },
  }),
  false,
);
assert.equal(isVerifiedWorkshopPayment({ ...payment, metadata: null }), false);
assert.equal(workshopCheckoutIdempotencyKey("a", "request"), "workshop-checkout:a:request");
assert.notEqual(
  workshopCheckoutIdempotencyKey("a", "request"),
  workshopCheckoutIdempotencyKey("b", "request"),
);
assert.equal(
  workshopCheckoutOrigin("http://localhost:3009", "http://127.0.0.1:3009", "local"),
  "http://127.0.0.1:3009",
);
assert.throws(() =>
  workshopCheckoutOrigin("http://localhost:3009", "https://foreign.example", "local"),
);
assert.throws(() =>
  workshopCheckoutOrigin("https://egghead.io", "https://foreign.example", "production"),
);
console.log(
  "Workshop checkout contracts passed: publication, future schedule, matching paid amount, sandbox mode, checkout origin, and scoped idempotency.",
);
