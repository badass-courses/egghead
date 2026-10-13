import assert from "node:assert/strict";
import { test } from "node:test";
import { StripePaymentAdapter } from "@coursebuilder/commerce/stripe-provider";
import { createMembershipCheckout } from "../apps/web/src/subscriptions/checkout";
import { normalizeStripeBillingSnapshot } from "../apps/web/src/subscriptions/stripe-billing";
import { dispatchSubscriptionDeletion } from "../apps/web/src/subscriptions/webhook";

const billingEvent = {
  id: "synthetic-event",
  createdAt: 100,
  observedAt: 1000,
  kind: "subscription_update",
} as const;

await test("Stripe billing boundary decodes current item periods and rejects unsupported shapes", () => {
  const raw = {
    id: "synthetic-subscription",
    status: "active",
    items: { data: [{ current_period_end: 6000, quantity: 4 }] },
  };
  assert.equal(normalizeStripeBillingSnapshot(raw, billingEvent).currentPeriodEnd, 6000);
  assert.equal(normalizeStripeBillingSnapshot(raw, billingEvent).seats, 4);
  assert.throws(() =>
    normalizeStripeBillingSnapshot({ ...raw, items: { data: [] } }, billingEvent),
  );
  assert.throws(() => normalizeStripeBillingSnapshot({ ...raw, status: "unknown" }, billingEvent));
});

await test("checkout kind survives quantity changes and final deletions cannot carry active billing", () => {
  const raw = {
    id: "synthetic-subscription",
    status: "active",
    metadata: { bulk: "true" },
    items: { data: [{ current_period_end: 6000, quantity: 1 }] },
  };
  assert.equal(normalizeStripeBillingSnapshot(raw, billingEvent).initialKind, "team");
  assert.throws(() =>
    normalizeStripeBillingSnapshot(raw, { ...billingEvent, kind: "subscription_deleted" }),
  );
});

await test("only correctly signed final cancellations are dispatched; failed publishing remains retryable", async () => {
  const adapter = new StripePaymentAdapter({
    stripeToken: "sk_test_synthetic",
    stripeWebhookSecret: "synthetic-webhook-secret",
  });
  const body = JSON.stringify({
    id: "synthetic-event",
    created: 100,
    type: "customer.subscription.deleted",
    data: { object: { id: "synthetic-subscription" } },
  });
  const signature = adapter.stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: adapter.webhookSecret,
  });
  let publishes = 0;
  const boundary = {
    verify: (payload: string, sig: string) =>
      adapter.stripe.webhooks.constructEvent(payload, sig, adapter.webhookSecret),
    publish: async () => {
      publishes++;
    },
  };
  await assert.rejects(dispatchSubscriptionDeletion(body, "forged", boundary));
  assert.equal(publishes, 0);
  assert.equal(await dispatchSubscriptionDeletion(body, signature, boundary), true);
  assert.equal(publishes, 1);
  await assert.rejects(
    dispatchSubscriptionDeletion(body, signature, {
      ...boundary,
      publish: async () => {
        throw new Error("queue unavailable");
      },
    }),
    /queue unavailable/,
  );
});

await test("checkout refuses beta, production and live keys before any database or Stripe calls", async () => {
  const keys = [
    "EGGHEAD_RUNTIME",
    "EGGHEAD_BETA_DB_APPROVED",
    "DATABASE_URL",
    "STRIPE_SECRET_TOKEN",
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  const input = {
    user: { id: "synthetic-owner", email: "owner@example.test" },
    productId: "synthetic-product",
    priceId: "synthetic-price",
    quantity: 1,
    requestOrigin: "https://example.test",
    country: "US",
  };
  try {
    process.env["STRIPE_SECRET_TOKEN"] = "sk_test_synthetic";
    process.env["EGGHEAD_RUNTIME"] = "beta";
    process.env["EGGHEAD_BETA_DB_APPROVED"] = "true";
    process.env["DATABASE_URL"] = "mysql://synthetic:synthetic@aws.connect.psdb.cloud/synthetic";
    await assert.rejects(createMembershipCheckout(input), /Refusing Egghead commerce writes/);
    process.env["EGGHEAD_RUNTIME"] = "production";
    await assert.rejects(
      createMembershipCheckout(input),
      /Membership lifecycle writes require local Docker/,
    );
    process.env["EGGHEAD_RUNTIME"] = "local";
    process.env["DATABASE_URL"] = "mysql://root:root@127.0.0.1:3307/coursebuilder_test";
    process.env["STRIPE_SECRET_TOKEN"] = "sk_live_synthetic";
    await assert.rejects(createMembershipCheckout(input), /Stripe test key/);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
