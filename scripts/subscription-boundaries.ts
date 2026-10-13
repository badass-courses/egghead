import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const lifecycle = await readFile(
  new URL("../apps/web/src/inngest/stripe-subscription.ts", import.meta.url),
  "utf8",
);
const teamActions = await readFile(
  new URL("../apps/web/src/app/team/actions.ts", import.meta.url),
  "utf8",
);
assert.equal(
  /syncStripeSubscriptionEntitlement|teamSeat\s*:/.test(lifecycle),
  false,
  "Webhook callers must submit billing snapshots, not choose grant identity",
);
assert.equal(
  /getTeamStripeState|currentPeriodEnd\s*:/.test(teamActions),
  false,
  "Seat commands must use stored billing state, not caller-supplied access facts",
);
console.log("Subscription boundary checks passed.");

const checkoutAction = await readFile(
  new URL("../apps/web/src/app/pricing/actions.ts", import.meta.url),
  "utf8",
);
assert.equal(
  /drizzle-orm|StripePaymentAdapter|stripe\.checkout|reserveSubscriptionCheckout/.test(
    checkoutAction,
  ),
  false,
  "The pricing action must delegate checkout to the subscription capability",
);
