import assert from "node:assert/strict";

import { subscriptionCheckoutIdempotencyKey } from "../apps/web/src/coursebuilder/stripe-provider";
import {
  stripeSubscriptionEntitlementId,
  stripeSubscriptionGrantsAccess,
  stripeSubscriptionSeatEntitlementId,
} from "../apps/web/src/subscriptions/access";
import { assertCommerceWritesAllowed } from "../apps/web/src/db/local-docker";
import {
  formatMembershipCost,
  formatProductPrice,
  membershipIntervalLabel,
  stripeInvoiceDownloadUrl,
} from "../apps/web/src/subscriptions/billing";
import {
  isConfiguredSubscriptionProductId,
  subscriptionIntervalLabel,
  subscriptionProductIds,
} from "../apps/web/src/subscriptions/options";
import {
  getStripeSubscriptionCurrentPeriodEnd,
  getStripeSubscriptionQuantity,
} from "../apps/web/src/subscriptions/stripe";
import {
  isTeamSubscription,
  mergeTeamSubscriptionFields,
  subscriptionCheckoutQuantitySchema,
} from "../apps/web/src/subscriptions/team-contracts";

type ContractCheck = {
  name: string;
  pass: true;
};

const originalEnv = {
  databaseUrl: process.env["DATABASE_URL"],
  runtime: process.env["EGGHEAD_RUNTIME"],
};

function setEnv(name: "DATABASE_URL" | "EGGHEAD_RUNTIME", value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

let runningCheckName: string | null = null;

function check(name: string, run: () => void): ContractCheck {
  runningCheckName = name;
  run();
  runningCheckName = null;
  return { name, pass: true };
}

try {
  const checks = [
    check("access-granting Stripe statuses remain explicit", () => {
      assert.equal(stripeSubscriptionGrantsAccess("active"), true);
      assert.equal(stripeSubscriptionGrantsAccess("trialing"), true);
      assert.equal(stripeSubscriptionGrantsAccess("past_due"), true);
      assert.equal(stripeSubscriptionGrantsAccess("canceled"), false);
      assert.equal(stripeSubscriptionGrantsAccess("unpaid"), false);
    }),
    check("Stripe entitlement IDs are deterministic", () => {
      assert.equal(
        stripeSubscriptionEntitlementId("sub_contract_fixture"),
        "stripe_ent_sub_contract_fixture",
      );
      assert.equal(
        stripeSubscriptionSeatEntitlementId("sub_contract_fixture", "user_1"),
        stripeSubscriptionSeatEntitlementId("sub_contract_fixture", "user_1"),
      );
      assert.notEqual(
        stripeSubscriptionSeatEntitlementId("sub_contract_fixture", "user_1"),
        stripeSubscriptionSeatEntitlementId("sub_contract_fixture", "user_2"),
      );
    }),
    check("Stripe checkout idempotency includes request parameters", () => {
      const checkoutParams = {
        country: "US",
        line_items: [{ price: "price_monthly", quantity: 1 }],
        mode: "subscription",
      };
      const checkoutKey = subscriptionCheckoutIdempotencyKey(
        "reservation-contract-fixture",
        checkoutParams,
      );

      assert.equal(
        checkoutKey,
        subscriptionCheckoutIdempotencyKey("reservation-contract-fixture", {
          ...checkoutParams,
        }),
      );
      assert.notEqual(
        checkoutKey,
        subscriptionCheckoutIdempotencyKey("reservation-contract-fixture", {
          ...checkoutParams,
          country: "CA",
        }),
      );
    }),
    check("Stripe subscription period parsing uses the latest item period", () => {
      assert.equal(
        getStripeSubscriptionCurrentPeriodEnd({
          current_period_end: 300,
          items: { data: [{ current_period_end: 400 }] },
        }),
        300,
      );
      assert.equal(
        getStripeSubscriptionCurrentPeriodEnd({
          items: {
            data: [{ current_period_end: 200 }, {}, { current_period_end: 400 }],
          },
        }),
        400,
      );
      assert.equal(getStripeSubscriptionCurrentPeriodEnd({}), null);
    }),
    check("team subscription quantities remain bounded and explicit", () => {
      assert.equal(subscriptionCheckoutQuantitySchema.parse("1"), 1);
      assert.equal(subscriptionCheckoutQuantitySchema.parse("25"), 25);
      assert.throws(() => subscriptionCheckoutQuantitySchema.parse("0"));
      assert.throws(() => subscriptionCheckoutQuantitySchema.parse("101"));
      assert.equal(getStripeSubscriptionQuantity({ items: { data: [{ quantity: 8 }] } }), 8);
      assert.equal(getStripeSubscriptionQuantity({ items: { data: [{}] } }), 1);
      assert.equal(isTeamSubscription({ ownerId: "owner_1", seats: 2 }), true);
      assert.equal(isTeamSubscription({ ownerId: "owner_1", seats: 1 }), false);
      assert.deepEqual(
        mergeTeamSubscriptionFields({ preserved: true }, { ownerId: "owner_1", seats: 6 }),
        { ownerId: "owner_1", preserved: true, seats: 6 },
      );
    }),
    check("membership billing details are customer-readable", () => {
      assert.equal(membershipIntervalLabel("month", 1), "Monthly");
      assert.equal(membershipIntervalLabel("year", 1), "Yearly");
      assert.equal(membershipIntervalLabel("month", 3), "Every 3 months");
      assert.equal(membershipIntervalLabel(null, null), "Recurring");
      assert.equal(formatMembershipCost(2_000, "usd", 1), "$20.00");
      assert.equal(formatMembershipCost(2_000, "usd", 3), "$60.00");
      assert.equal(formatMembershipCost(2_000, "jpy", 1), "¥2,000");
      assert.equal(formatMembershipCost(500, "isk", 1), "ISK 5");
      assert.equal(formatMembershipCost(500, "ugx", 1), "UGX 5");
    }),
    check("CourseBuilder product prices use major currency units", () => {
      assert.equal(formatProductPrice(20, "usd"), "$20");
      assert.equal(formatProductPrice(150, "usd"), "$150");
      assert.equal(formatProductPrice(20.5, "usd"), "$20.50");
    }),
    check("subscription options preserve product allowlisting", () => {
      const configuredIds = subscriptionProductIds(" monthly-product, yearly-product ", undefined);

      assert.deepEqual(configuredIds, ["monthly-product", "yearly-product"]);
      assert.deepEqual(subscriptionProductIds(undefined, "single-product"), ["single-product"]);
      assert.equal(isConfiguredSubscriptionProductId("yearly-product", configuredIds), true);
      assert.equal(isConfiguredSubscriptionProductId("unlisted-product", configuredIds), false);
      assert.equal(subscriptionIntervalLabel("month"), "Monthly");
      assert.equal(subscriptionIntervalLabel("year"), "Yearly");
    }),
    check("invoice downloads only use secure Stripe URLs", () => {
      assert.equal(
        stripeInvoiceDownloadUrl("https://pay.stripe.com/invoice/acct_test/pdf"),
        "https://pay.stripe.com/invoice/acct_test/pdf",
      );
      assert.equal(stripeInvoiceDownloadUrl("http://pay.stripe.com/invoice/test"), null);
      assert.equal(stripeInvoiceDownloadUrl("not-a-url"), null);
      assert.equal(stripeInvoiceDownloadUrl(null), null);
    }),
    check("commerce writes are allowed for local Docker only", () => {
      setEnv("DATABASE_URL", "mysql://root:root@127.0.0.1:3307/coursebuilder_test");
      setEnv("EGGHEAD_RUNTIME", "local");
      assert.equal(assertCommerceWritesAllowed().commerceWritesAllowed, true);

      setEnv("DATABASE_URL", "mysql://user:password@aws.connect.psdb.cloud/egghead");
      setEnv("EGGHEAD_RUNTIME", "beta");
      assert.throws(() => assertCommerceWritesAllowed());
    }),
  ];

  console.log(JSON.stringify({ ok: true, checks }));
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      check: runningCheckName ?? "stripe subscription contract",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
} finally {
  setEnv("DATABASE_URL", originalEnv.databaseUrl);
  setEnv("EGGHEAD_RUNTIME", originalEnv.runtime);
}
