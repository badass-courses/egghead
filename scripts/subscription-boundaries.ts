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

// One gate for every membership write: checkout, the Stripe/Inngest writer and
// the /team seat actions all require local Docker plus a Stripe test key.
const teamPage =
  (await readFile(new URL("../apps/web/src/app/team/page.tsx", import.meta.url), "utf8")) +
  (await readFile(
    new URL("../apps/web/src/app/team/invite/[token]/page.tsx", import.meta.url),
    "utf8",
  ));
const exportedActions =
  teamActions.match(/export async function \w+\([^)]*\)[^{]*\{\n\s*\S+/g) ?? [];
assert.ok(exportedActions.length >= 5, "found the /team server actions");
for (const action of exportedActions)
  assert.match(
    action,
    /assertMembershipWritesAllowed\(\);$/,
    `Every /team action must open with the membership write gate: ${action.split("(")[0]}`,
  );
assert.equal(
  /assertLocalDockerDatabaseUrl|commerceWritesAreAllowed/.test(teamActions + teamPage),
  false,
);
assert.match(teamPage, /membershipWritesAllowed\(\)/, "/team forms follow the membership gate");
console.log("Subscription boundary checks passed.");
