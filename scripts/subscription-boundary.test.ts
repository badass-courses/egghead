import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

// A fake live-mode key, built so no literal live-key prefix sits in the source.
const FAKE_LIVE_STRIPE_KEY = ["sk", "live", "FAKE_FOR_TEST"].join("_");
import { StripePaymentAdapter } from "@coursebuilder/commerce/stripe-provider";
import { safeErrorSummary, SubscriptionDataError } from "../apps/web/src/subscriptions/alerts";
import { getStripeProvider } from "../apps/web/src/coursebuilder/stripe-provider";
import { pricingPanel } from "../apps/web/src/subscriptions/pricing-state";
import { membershipWritesAllowed } from "../apps/web/src/subscriptions/write-policy";
import { createMembershipCheckout } from "../apps/web/src/subscriptions/checkout";
import { parseCheckoutSelection } from "../apps/web/src/subscriptions/checkout-selection";
import { normalizeStripeBillingSnapshot } from "../apps/web/src/subscriptions/stripe-billing";
import {
  dispatchSubscriptionDeletion,
  handleSubscriptionDeletion,
  stripeWebhookVerifier,
} from "../apps/web/src/subscriptions/webhook";

const billingEvent = {
  id: "synthetic-event",
  createdAt: 100,
  observedAt: 1000,
  kind: "subscription_update",
} as const;

const unsupported = (error: unknown) =>
  error instanceof SubscriptionDataError && error.code === "unsupported-stripe-shape";
const form = (values: Record<string, string>) => ({
  get: (name: string) => values[name] ?? null,
});

await test("Stripe billing boundary decodes current item periods and rejects unsupported shapes", () => {
  const raw = {
    id: "synthetic-subscription",
    status: "active",
    items: { data: [{ current_period_end: 6000, quantity: 4 }] },
  };
  assert.equal(normalizeStripeBillingSnapshot(raw, billingEvent).currentPeriodEnd, 6000);
  assert.equal(normalizeStripeBillingSnapshot(raw, billingEvent).seats, 4);
  assert.throws(
    () => normalizeStripeBillingSnapshot({ ...raw, items: { data: [] } }, billingEvent),
    unsupported,
  );
  assert.throws(
    () => normalizeStripeBillingSnapshot({ ...raw, status: "unknown" }, billingEvent),
    unsupported,
  );
  assert.equal(
    normalizeStripeBillingSnapshot({ ...raw, customer: "cus_synthetic" }, billingEvent)
      .stripeCustomerId,
    "cus_synthetic",
  );
  assert.equal(
    normalizeStripeBillingSnapshot({ ...raw, customer: { id: "cus_expanded" } }, billingEvent)
      .stripeCustomerId,
    "cus_expanded",
  );
});

await test("a multi-item Stripe subscription is a data error to acknowledge, not a retry", () => {
  const multiItem = {
    id: "synthetic-subscription",
    status: "active",
    items: {
      data: [
        { current_period_end: 6000, quantity: 1 },
        { current_period_end: 6000, quantity: 2 },
      ],
    },
  };
  assert.throws(
    () => normalizeStripeBillingSnapshot(multiItem, billingEvent),
    (error: unknown) =>
      error instanceof SubscriptionDataError && error.code === "unsupported-stripe-shape",
  );
});

await test("the pricing form keeps invalid-seats for a bad quantity", () => {
  const valid = { productId: "synthetic-product", priceId: "synthetic-price", quantity: "3" };
  assert.deepEqual(parseCheckoutSelection(form(valid)), {
    status: "valid",
    selection: { productId: "synthetic-product", priceId: "synthetic-price", quantity: 3 },
  });
  for (const quantity of ["0", "abc", "101"])
    assert.deepEqual(parseCheckoutSelection(form({ ...valid, quantity })), {
      status: "invalid",
      error: "invalid-seats",
    });
  assert.deepEqual(parseCheckoutSelection(form({ ...valid, productId: "" })), {
    status: "invalid",
    error: "invalid-product",
  });
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

/** A boundary router that returns a fixed ownership decision for the synthetic deletion. */
const routedDeletion = (owner: "rails" | "cb") => async () => ({
  stamp: {
    eventId: "synthetic-event",
    owner,
    basis: "customer_timeline" as const,
    markerGeneration: 1,
    decidedAt: 1,
  },
  eventCreated: 100,
  stripeCustomerId: "cus_synthetic",
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
  const published: unknown[] = [];
  const routedTo = routedDeletion;
  const boundary = {
    verify: (payload: string, sig: string) =>
      adapter.stripe.webhooks.constructEvent(payload, sig, adapter.webhookSecret),
    route: routedTo("cb"),
    publish: async (event: unknown) => {
      published.push(event);
    },
  };
  await assert.rejects(dispatchSubscriptionDeletion(body, "forged", boundary));
  assert.equal(published.length, 0);
  // A deletion for a customer Rails owns is acknowledged and never published.
  assert.equal(
    await dispatchSubscriptionDeletion(body, signature, { ...boundary, route: routedTo("rails") }),
    "not-owner",
  );
  assert.equal(published.length, 0);
  assert.equal(await dispatchSubscriptionDeletion(body, signature, boundary), "dispatched");
  assert.equal(published.length, 1);
  // The routing decision travels with the event, so the function never decides again.
  assert.equal(
    z
      .object({ data: z.object({ routing: z.object({ stamp: z.object({ owner: z.string() }) }) }) })
      .parse(published[0]).data.routing.stamp.owner,
    "cb",
  );
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
    process.env["STRIPE_SECRET_TOKEN"] = FAKE_LIVE_STRIPE_KEY;
    await assert.rejects(createMembershipCheckout(input), /Stripe test key/);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

/** For events the seam answers itself or lets fall through as null. */
async function unreachable(): Promise<Response> {
  throw new Error("the seam forwarded an event it should not");
}

await test("the deletion seam leaves other webhooks to CourseBuilder and acknowledges blocked deletions", async () => {
  const keys = [
    "EGGHEAD_RUNTIME",
    "DATABASE_URL",
    "NEXT_PUBLIC_APP_URL",
    "STRIPE_SECRET_TOKEN",
    "STRIPE_WEBHOOK_SECRET",
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  const secret = "synthetic-webhook-secret";
  const adapter = new StripePaymentAdapter({
    stripeToken: "sk_test_synthetic",
    stripeWebhookSecret: secret,
  });
  const webhookUrl = "https://example.test/api/coursebuilder/webhook/stripe";
  const signed = (type: string, signature?: string) => {
    const body = JSON.stringify({
      id: "synthetic-event-" + type,
      created: 100,
      type,
      data: { object: { id: "synthetic-subscription" } },
    });
    return new Request(webhookUrl, {
      method: "POST",
      body,
      headers: {
        "stripe-signature":
          signature ?? adapter.stripe.webhooks.generateTestHeaderString({ payload: body, secret }),
      },
    });
  };
  try {
    process.env["STRIPE_SECRET_TOKEN"] = "sk_test_synthetic";
    process.env["STRIPE_WEBHOOK_SECRET"] = secret;
    process.env["NEXT_PUBLIC_APP_URL"] = "https://example.test";
    process.env["EGGHEAD_RUNTIME"] = "production";
    process.env["DATABASE_URL"] = "mysql://synthetic:synthetic@aws.connect.psdb.cloud/synthetic";
    assert.equal(
      await handleSubscriptionDeletion(signed("checkout.session.completed"), unreachable),
      null,
    );
    assert.equal(
      await handleSubscriptionDeletion(signed("customer.subscription.updated"), unreachable),
      null,
    );
    const unsigned = new Request(webhookUrl, { method: "POST", body: "{}" });
    assert.equal(await handleSubscriptionDeletion(unsigned, unreachable), null);
    const blocked = await handleSubscriptionDeletion(
      signed("customer.subscription.deleted"),
      unreachable,
    );
    assert.equal(blocked?.status, 200);
    assert.deepEqual(await blocked?.json(), { received: true, skipped: "writes-blocked" });
    // A signature this secret cannot verify goes to CourseBuilder, which verifies again.
    const forged = signed("customer.subscription.deleted", "t=1,v1=forged");
    assert.equal(await handleSubscriptionDeletion(forged, unreachable), null);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

const envKeys = [
  "EGGHEAD_RUNTIME",
  "EGGHEAD_BETA_DB_APPROVED",
  "DATABASE_URL",
  "NEXT_PUBLIC_APP_URL",
  "STRIPE_SECRET_TOKEN",
  "STRIPE_WEBHOOK_SECRET",
];
async function withEnv(values: Record<string, string>, work: () => void | Promise<void>) {
  const saved = new Map(envKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of envKeys) delete process.env[key];
    Object.assign(process.env, values);
    await work();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
const localDocker = {
  EGGHEAD_RUNTIME: "local",
  DATABASE_URL: "mysql://root:root@127.0.0.1:3307/coursebuilder_test",
  NEXT_PUBLIC_APP_URL: "https://example.test",
  STRIPE_WEBHOOK_SECRET: "synthetic-webhook-secret",
};
const planetScale = "mysql://synthetic:synthetic@aws.connect.psdb.cloud/synthetic";

await test("the pricing page shows the closed state wherever checkout is blocked", async () => {
  await withEnv(
    { EGGHEAD_RUNTIME: "beta", EGGHEAD_BETA_DB_APPROVED: "true", DATABASE_URL: planetScale },
    () => assert.equal(pricingPanel({ hasCurrentSubscription: false, optionCount: 3 }), "closed"),
  );
  await withEnv(
    {
      EGGHEAD_RUNTIME: "production",
      DATABASE_URL: planetScale,
      STRIPE_SECRET_TOKEN: FAKE_LIVE_STRIPE_KEY,
    },
    () => assert.equal(pricingPanel({ hasCurrentSubscription: false, optionCount: 3 }), "closed"),
  );
  await withEnv({ ...localDocker, STRIPE_SECRET_TOKEN: "sk_test_synthetic" }, () => {
    assert.equal(pricingPanel({ hasCurrentSubscription: false, optionCount: 3 }), "options");
    assert.equal(pricingPanel({ hasCurrentSubscription: false, optionCount: 0 }), "unavailable");
  });
  assert.equal(
    pricingPanel({ hasCurrentSubscription: true, optionCount: 3, checkoutOpen: false }),
    "current",
  );
});

await test("an owner whose team is paused for capacity review sees the paused panel, not active", () => {
  assert.equal(
    pricingPanel({ hasCurrentSubscription: true, optionCount: 3, ownedTeamPaused: true }),
    "paused",
  );
  assert.equal(
    pricingPanel({ hasCurrentSubscription: true, optionCount: 3, ownedTeamPaused: false }),
    "current",
  );
  // Paused only describes a current subscription; without one the usual rules apply.
  assert.equal(
    pricingPanel({
      hasCurrentSubscription: false,
      optionCount: 3,
      checkoutOpen: true,
      ownedTeamPaused: true,
    }),
    "options",
  );
});

await test("the writer guard reads the Stripe key name the CourseBuilder provider reads", async () => {
  await withEnv({ ...localDocker, STRIPE_SECRET_TOKEN: "sk_test_synthetic" }, () => {
    assert.notEqual(getStripeProvider(), null);
    assert.equal(membershipWritesAllowed(), true);
  });
  await withEnv({ ...localDocker, STRIPE_SECRET_TOKEN: FAKE_LIVE_STRIPE_KEY }, () => {
    assert.notEqual(getStripeProvider(), null);
    assert.equal(membershipWritesAllowed(), false);
  });
  await withEnv(localDocker, () => {
    assert.equal(getStripeProvider(), null);
    assert.equal(membershipWritesAllowed(), false);
  });
});

await test("logged errors carry Stripe codes, never customer data; app errors keep their message", async () => {
  const error = Object.assign(
    new Error("Your card ending 4242 for someone@example.test was declined"),
    {
      name: "StripeCardError",
      type: "card_error",
      code: "card_declined",
      decline_code: "insufficient_funds",
    },
  );
  const summary = safeErrorSummary(error);
  assert.deepEqual(summary, {
    name: "StripeCardError",
    type: "card_error",
    code: "card_declined",
    declineCode: "insufficient_funds",
    message: null,
  });
  assert.equal(JSON.stringify(summary).includes("4242"), false);
  assert.equal(safeErrorSummary("boom").name, "UnknownError");
  // Only our own fixed-message errors keep their message.
  const { FixedMessageError } = await import("../apps/web/src/subscriptions/alerts");
  assert.equal(
    safeErrorSummary(
      new FixedMessageError("Membership checkout requires an active merchant account"),
    ).message,
    "Membership checkout requires an active merchant account",
  );
  // mysql2 raises server errors as a plain Error with code and errno; its message
  // can carry customer data, so it is never logged.
  const mysqlShaped = Object.assign(
    new Error("Duplicate entry 'someone@example.test' for key 'User.email'"),
    { code: "ER_DUP_ENTRY", errno: 1062, sqlState: "23000" },
  );
  const mysqlSummary = safeErrorSummary(mysqlShaped);
  assert.deepEqual(mysqlSummary, {
    name: "Error",
    type: null,
    code: "ER_DUP_ENTRY",
    declineCode: null,
    message: null,
  });
  assert.equal(JSON.stringify(mysqlSummary).includes("example.test"), false);
  // Other classes (database, validation) can embed customer data: name only.
  class DatabaseError extends Error {}
  const database = Object.assign(new DatabaseError("Duplicate entry 'someone@example.test'"), {
    name: "DatabaseError",
    code: "ER_DUP_ENTRY",
  });
  assert.deepEqual(safeErrorSummary(database), {
    name: "DatabaseError",
    type: null,
    code: "ER_DUP_ENTRY",
    declineCode: null,
    message: null,
  });
});

await test("the deletion seam finds Stripe verification by shape, not class identity", () => {
  const calls: unknown[][] = [];
  // A second copy of the commerce package would hand us an object like this.
  const foreignAdapter = {
    webhookSecret: "synthetic-webhook-secret",
    stripe: {
      webhooks: {
        constructEvent(...args: unknown[]) {
          calls.push(args);
          return { type: "customer.subscription.deleted" };
        },
      },
    },
  };
  const verifier = stripeWebhookVerifier(foreignAdapter);
  assert.ok(verifier);
  assert.deepEqual(verifier.verify("body", "signature"), { type: "customer.subscription.deleted" });
  assert.deepEqual(calls, [["body", "signature", "synthetic-webhook-secret"]]);
  assert.equal(stripeWebhookVerifier({ webhookSecret: "", stripe: foreignAdapter.stripe }), null);
  assert.equal(stripeWebhookVerifier({ webhookSecret: "x" }), null);
  assert.equal(stripeWebhookVerifier(null), null);
});

await test("a Stripe item without a quantity is reported as unreported seats, not as one seat", () => {
  const raw = {
    id: "synthetic-subscription",
    status: "active",
    items: { data: [{ current_period_end: 6000 }] },
  };
  const missing = normalizeStripeBillingSnapshot(raw, billingEvent);
  assert.equal(missing.seatsReported, false);
  const nulled = normalizeStripeBillingSnapshot(
    { ...raw, items: { data: [{ current_period_end: 6000, quantity: null }] } },
    billingEvent,
  );
  assert.equal(nulled.seatsReported, false);
  const reported = normalizeStripeBillingSnapshot(
    { ...raw, items: { data: [{ current_period_end: 6000, quantity: 4 }] } },
    billingEvent,
  );
  assert.deepEqual([reported.seats, reported.seatsReported], [4, true]);
});

await test("a customer.deleted payload's marker is recorded, and only its marker keys", async () => {
  const { recordCustomerDeletion } = await import("../apps/web/src/subscriptions/webhook");
  const { deletedCustomerMarker } = await import("../apps/web/src/subscriptions/deleted-customers");
  const recorded: unknown[] = [];
  const marked = await recordCustomerDeletion(
    {
      id: "evt_customer_deleted",
      created: 100,
      type: "customer.deleted",
      data: {
        object: {
          id: "cus_synthetic",
          deleted: true,
          metadata: { egghead_owner: "cb", egghead_owner_timeline: "cb@0", userId: "someone" },
        },
      },
    },
    async (input) => {
      recorded.push(input);
      return 2;
    },
  );
  assert.equal(marked, 2);
  assert.equal(recorded.length, 1);
  assert.deepEqual(
    deletedCustomerMarker(z.object({ metadata: z.unknown() }).parse(recorded[0]).metadata),
    { egghead_owner: "cb", egghead_owner_timeline: "cb@0" },
  );
  await assert.rejects(
    recordCustomerDeletion(
      { id: "evt_x", created: 1, type: "customer.updated", data: {} },
      async () => 0,
    ),
  );
});

/** A fake Stripe reader for billing signals; records every read. */
function signalStripe(objects: Record<string, unknown>) {
  const reads: string[] = [];
  const reader = (kind: string) => ({
    retrieve: async (id: string) => {
      reads.push(`${kind}:${id}`);
      const found = objects[id];
      if (found === undefined) throw new Error(`no ${kind} ${id}`);
      return found;
    },
  });
  return { stripe: { invoices: reader("invoice"), charges: reader("charge") }, reads };
}
const signalEvent = (type: string, object: Record<string, unknown>) => ({
  id: `evt_${type}`,
  created: 500,
  type,
  data: { object },
});

await test("billing signals find their customer and subscription across Stripe API shapes", async () => {
  const { resolveBillingSignal } = await import("../apps/web/src/subscriptions/billing-signals");
  // A failed payment names its subscription in the payload (pinned API) ...
  const pinned = signalStripe({});
  const failed = await resolveBillingSignal(
    signalEvent("invoice.payment_failed", { id: "in_1", customer: "cus_1", subscription: "sub_1" }),
    pinned.stripe,
  );
  assert.deepEqual(
    [failed.stripeCustomerId, failed.stripeSubscriptionId, failed.objectId, pinned.reads],
    ["cus_1", "sub_1", "in_1", []],
  );
  // ... or under parent.subscription_details in newer payloads.
  const newer = await resolveBillingSignal(
    signalEvent("invoice.payment_failed", {
      id: "in_2",
      customer: "cus_1",
      parent: { subscription_details: { subscription: "sub_2" } },
    }),
    signalStripe({}).stripe,
  );
  assert.equal(newer.stripeSubscriptionId, "sub_2");
  // A refunded charge goes charge -> invoice -> subscription.
  const refund = signalStripe({ in_3: { id: "in_3", customer: "cus_1", subscription: "sub_3" } });
  const refunded = await resolveBillingSignal(
    signalEvent("charge.refunded", { id: "ch_3", customer: "cus_1", invoice: "in_3" }),
    refund.stripe,
  );
  assert.deepEqual([refunded.stripeSubscriptionId, refund.reads], ["sub_3", ["invoice:in_3"]]);
  // A newer charge payload without `invoice` is re-read through the pinned client.
  const reread = signalStripe({
    ch_4: { id: "ch_4", customer: "cus_1", invoice: "in_4" },
    in_4: { id: "in_4", customer: "cus_1", subscription: "sub_4" },
  });
  const rereadSignal = await resolveBillingSignal(
    signalEvent("charge.refunded", { id: "ch_4", customer: "cus_1" }),
    reread.stripe,
  );
  assert.deepEqual(
    [rereadSignal.stripeSubscriptionId, reread.reads],
    ["sub_4", ["charge:ch_4", "invoice:in_4"]],
  );
  // A dispute names its charge.
  const dispute = signalStripe({
    ch_5: { id: "ch_5", customer: "cus_1", invoice: "in_5" },
    in_5: { id: "in_5", customer: "cus_1", subscription: "sub_5" },
  });
  const disputed = await resolveBillingSignal(
    signalEvent("charge.dispute.created", { id: "dp_5", charge: "ch_5" }),
    dispute.stripe,
  );
  assert.deepEqual(
    [disputed.objectId, disputed.stripeCustomerId, disputed.stripeSubscriptionId],
    ["dp_5", "cus_1", "sub_5"],
  );
  // A one-off charge belongs to no subscription.
  const oneOff = await resolveBillingSignal(
    signalEvent("charge.refunded", { id: "ch_6", customer: "cus_1", invoice: null }),
    signalStripe({ ch_6: { id: "ch_6", customer: "cus_1", invoice: null } }).stripe,
  );
  assert.equal(oneOff.stripeSubscriptionId, null);
  // A Stripe read failure throws, so the route answers non-2xx.
  await assert.rejects(
    resolveBillingSignal(
      signalEvent("charge.dispute.created", { id: "dp_7", charge: "ch_7" }),
      signalStripe({}).stripe,
    ),
  );
});

/** A resolver that returns a fixed signal for the dispatch test. */
const resolvedSignal =
  (
    subscription: string | null,
    type: "charge.refunded" | "invoice.payment_failed" = "charge.refunded",
  ) =>
  async () => ({
    eventId: "evt_signal",
    created: 500,
    type,
    objectId: "ch_1",
    stripeCustomerId: "cus_1",
    stripeSubscriptionId: subscription,
  });

await test("only CB-owned billing signals are published; unmatched ones leave a receipt", async () => {
  const { dispatchBillingSignal } = await import("../apps/web/src/subscriptions/webhook");
  const published: unknown[] = [];
  const lines: string[] = [];
  const infos: string[] = [];
  const original = { error: console.error, warn: console.warn, info: console.info };
  console.error = (line: unknown) => {
    lines.push(String(line));
  };
  console.warn = (line: unknown) => {
    lines.push(String(line));
  };
  console.info = (line: unknown) => {
    infos.push(String(line));
  };
  try {
    const boundary = (
      owner: "rails" | "cb",
      subscription: string | null,
      type?: "invoice.payment_failed",
    ) => ({
      resolve: resolvedSignal(subscription, type),
      route: routedDeletion(owner),
      publish: async (event: unknown) => {
        published.push(event);
      },
    });
    assert.equal(await dispatchBillingSignal({}, boundary("rails", "sub_1")), "not-owner");
    assert.equal(await dispatchBillingSignal({}, boundary("cb", null)), "unmatched");
    assert.equal(published.length, 0);
    assert.equal(await dispatchBillingSignal({}, boundary("cb", "sub_1")), "dispatched");
    assert.equal(
      await dispatchBillingSignal({}, boundary("cb", "sub_1", "invoice.payment_failed")),
      "dispatched",
    );
  } finally {
    console.error = original.error;
    console.warn = original.warn;
    console.info = original.info;
  }
  assert.equal(published.length, 2);
  // Shaped like a subscription event: the function reads data.object.id as the subscription.
  const first = z
    .object({
      name: z.string(),
      data: z.object({
        stripeEvent: z.object({
          id: z.string(),
          data: z.object({ object: z.object({ id: z.string() }) }),
        }),
        routing: z.object({ stamp: z.object({ owner: z.string() }) }),
        signal: z.object({ type: z.string(), objectId: z.string() }),
      }),
    })
    .parse(published[0]);
  assert.deepEqual(
    [
      first.name,
      first.data.stripeEvent.data.object.id,
      first.data.routing.stamp.owner,
      first.data.signal,
    ],
    ["egghead/stripe-billing-signal", "sub_1", "cb", { type: "charge.refunded", objectId: "ch_1" }],
  );
  const log = lines.join("\n");
  assert.match(log, /alert=unmatched-refund-or-dispute/);
  // A handled refund or dispute is a routine receipt at info, never an alert.
  assert.equal(log.includes("billing-signal-receipt"), false);
  assert.match(infos.join("\n"), /receipt=billing-signal-receipt/);
  assert.equal(infos.join("\n").includes("@"), false, "receipts carry Stripe ids only");
  assert.match(log, /skipped reason=not-owner/);
  assert.equal(log.includes("@"), false, "receipts carry Stripe ids only");
});

await test("a billing-elsewhere refusal releases its reservation, so the next attempt is refused again, not pending", async () => {
  const {
    decideCheckoutReservation,
    readCheckoutReservation,
    releaseCheckoutReservation,
    CHECKOUT_RESERVATION_FIELD,
  } = await import("../apps/web/src/subscriptions/checkout-reservation");
  const { CheckoutCustomerRefusedError, getCheckoutCustomer } =
    await import("../apps/web/src/subscriptions/checkout-customer");
  const attempt = (productId: string, token: string, current: unknown) =>
    decideCheckoutReservation({
      current: readCheckoutReservation(current),
      country: "US",
      now: 1000,
      productId,
      priceId: `${productId}-price`,
      quantity: 1,
      token,
    });
  const first = attempt("monthly", "token-1", undefined);
  assert.equal(first.kind, "replace");
  if (first.kind !== "replace") return;
  const fields = { other: "kept", [CHECKOUT_RESERVATION_FIELD]: first.reservation };
  // Held: a different selection within the TTL reads as another open checkout.
  assert.equal(attempt("yearly", "token-2", fields[CHECKOUT_RESERVATION_FIELD]).kind, "pending");
  // Released after the refusal: the next attempt reserves again and reaches the
  // customer check, which refuses it the same way.
  const released = releaseCheckoutReservation(fields, "token-1");
  const releasedReservation = released ? released[CHECKOUT_RESERVATION_FIELD] : undefined;
  assert.deepEqual(released, { other: "kept" });
  assert.equal(attempt("yearly", "token-2", releasedReservation).kind, "replace");
  const railsCustomer = {
    id: "cus_rails",
    email: "account@example.invalid",
    livemode: false,
    metadata: { userId: "synthetic-user" },
  };
  const refusal = () =>
    getCheckoutCustomer({
      user: { id: "synthetic-user", email: "account@example.invalid" },
      merchantAccountId: "merchant",
      live: false,
      adapter: {
        getMerchantCustomerForUserId: async () => ({
          id: "mapping",
          userId: "synthetic-user",
          merchantAccountId: "merchant",
          identifier: "cus_rails",
          status: 1,
          createdAt: null,
        }),
        createMerchantCustomer: async () => null,
      },
      customers: {
        retrieve: async () => railsCustomer,
        create: async () => railsCustomer,
        update: async () => railsCustomer,
      },
    }).then(
      () => "accepted",
      (error: unknown) => (error instanceof CheckoutCustomerRefusedError ? error.reason : "error"),
    );
  assert.deepEqual(
    [await refusal(), await refusal()],
    ["customer_owned_by_rails", "customer_owned_by_rails"],
  );
  // Another attempt's reservation, or one already holding a Stripe session, stays.
  assert.equal(releaseCheckoutReservation(fields, "token-other"), null);
  const withSession = {
    [CHECKOUT_RESERVATION_FIELD]: {
      ...first.reservation,
      sessionId: "cs_1",
      sessionExpiresAt: 5000,
    },
  };
  assert.equal(releaseCheckoutReservation(withSession, "token-1"), null);
});

/** The comma-separated event list after `stripe listen --events`. */
function listedEvents(text: string) {
  return /stripe listen --events (\S+)/.exec(text)?.[1]?.split(",") ?? [];
}

await test("pnpm dev:stripe forwards the README's events, which cover every event the seam handles", async () => {
  const { readFile } = await import("node:fs/promises");
  const { BILLING_SIGNAL_TYPES } = await import("../apps/web/src/subscriptions/billing-signals");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const pkg = z
    .object({ scripts: z.object({ "dev:stripe": z.string() }) })
    .parse(
      JSON.parse(await readFile(new URL("../apps/web/package.json", import.meta.url), "utf8")),
    );
  assert.deepEqual(listedEvents(pkg.scripts["dev:stripe"]), listedEvents(readme));
  for (const type of [
    "checkout.session.completed",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "customer.deleted",
    ...BILLING_SIGNAL_TYPES,
  ])
    assert.ok(listedEvents(readme).includes(type), `${type} is forwarded locally`);
});
