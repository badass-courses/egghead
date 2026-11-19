import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handleCheckoutSessionCompleted,
  type CheckoutCompletedDeps,
} from "../apps/web/src/inngest/stripe-subscription";
import {
  alertOnRetriesExhausted,
  handleSubscriptionBillingEvent,
  type StepRun,
  type SubscriptionBillingDeps,
} from "../apps/web/src/inngest/subscription-billing";
import type { RoutedEvent } from "../apps/web/src/subscriptions/ownership-seam";
import { normalizeStripeBillingSnapshot } from "../apps/web/src/subscriptions/stripe-billing";
import { SUBSCRIPTION_DELETED_EVENT } from "../apps/web/src/subscriptions/webhook-contract";

process.env["EGGHEAD_RUNTIME"] = "local";
const UPDATED = "stripe/customer-subscription-updated";
const stripeSubscription = (status: string) => ({
  id: "sub_synthetic",
  status,
  customer: "cus_synthetic",
  items: { data: [{ current_period_end: 6000, quantity: 1 }] },
});
const routed = (owner: "rails" | "cb", eventCreated: number): RoutedEvent => ({
  stamp: {
    eventId: "evt_synthetic",
    owner,
    basis: "customer_timeline",
    markerGeneration: 1,
    decidedAt: 1,
  },
  eventCreated,
  stripeCustomerId: "cus_synthetic",
});

function harness(overrides: Partial<SubscriptionBillingDeps> = {}, owner: "rails" | "cb" = "cb") {
  const steps: string[] = [];
  const routes: Array<{ eventCreated?: number; stripeCustomerId: string | null }> = [];
  const loads: Array<{ id: string; kind: string; createdAt?: number }> = [];
  const reconciled: Array<{
    kind: string;
    status: string;
    owner: string;
    customer: string | null;
  }> = [];
  // A mocked step: runs the work once and round-trips its output through JSON,
  // as Inngest memoization does.
  const run: StepRun = async (name, work) => {
    steps.push(name);
    return JSON.parse(JSON.stringify(await work()));
  };
  const deps: SubscriptionBillingDeps = {
    writesAllowed: () => true,
    routeEvent: async (input) => {
      routes.push({
        ...(input.eventCreated === undefined ? {} : { eventCreated: input.eventCreated }),
        stripeCustomerId: input.stripeCustomerId,
      });
      // The default reads the creation time from Stripe when the payload omits it.
      return routed(owner, input.eventCreated ?? 777);
    },
    loadSnapshot: async (stripeSubscriptionId, event) => {
      loads.push(event);
      assert.equal(stripeSubscriptionId, "sub_synthetic");
      return normalizeStripeBillingSnapshot(
        stripeSubscription(event.kind === "subscription_deleted" ? "canceled" : "active"),
        { ...event, createdAt: event.createdAt ?? 50, observedAt: 1000 },
      );
    },
    reconcile: async (snapshot, ownership) => {
      reconciled.push({
        kind: snapshot.event.kind,
        status: snapshot.status,
        owner: ownership.owner,
        customer: ownership.stripeCustomerId,
      });
      return { status: "applied", subscriptionId: "local-subscription", assignedSeats: 1 };
    },
    ...overrides,
  };
  return { run, deps, steps, routes, loads, reconciled };
}

const updated = (created?: number) => ({
  name: UPDATED,
  data: {
    stripeEvent: {
      id: "evt_synthetic",
      ...(created === undefined ? {} : { created }),
      data: { object: { id: "sub_synthetic", customer: "cus_synthetic" } },
    },
  },
});
const deletion = (owner: "rails" | "cb" = "cb") => ({
  name: SUBSCRIPTION_DELETED_EVENT,
  data: {
    stripeEvent: { id: "evt_synthetic", created: 1234, data: { object: { id: "sub_synthetic" } } },
    routing: routed(owner, 1234),
  },
});

await test("a final cancellation uses the routing and creation time it carries", async () => {
  const h = harness();
  const result = await handleSubscriptionBillingEvent(deletion(), h.run, h.deps);
  assert.equal(result?.status, "applied");
  assert.deepEqual(h.routes, [], "routed at receipt, never again");
  assert.deepEqual(h.loads, [
    { id: "evt_synthetic", kind: "subscription_deleted", createdAt: 1234 },
  ]);
  assert.deepEqual(h.reconciled, [
    { kind: "subscription_deleted", status: "canceled", owner: "cb", customer: "cus_synthetic" },
  ]);
  assert.deepEqual(h.steps, ["load current subscription billing", "reconcile subscription"]);
});

await test("an update is routed once in a memoized step, and its routed time feeds the snapshot", async () => {
  const h = harness();
  await handleSubscriptionBillingEvent(updated(), h.run, h.deps);
  assert.deepEqual(h.routes, [{ stripeCustomerId: "cus_synthetic" }]);
  assert.deepEqual(h.steps, [
    "route event ownership",
    "load current subscription billing",
    "reconcile subscription",
  ]);
  assert.deepEqual(h.loads, [{ id: "evt_synthetic", kind: "subscription_update", createdAt: 777 }]);
  assert.equal(h.reconciled[0]?.kind, "subscription_update");
});

await test("events the marker gives to Rails are acknowledged before any billing read", async () => {
  const h = harness({}, "rails");
  assert.deepEqual(await handleSubscriptionBillingEvent(updated(5), h.run, h.deps), {
    status: "not-owner",
    owner: "rails",
  });
  assert.deepEqual(await handleSubscriptionBillingEvent(deletion("rails"), h.run, h.deps), {
    status: "not-owner",
    owner: "rails",
  });
  assert.deepEqual(h.loads, []);
  assert.deepEqual(h.reconciled, []);
});

await test("blocked writes are acknowledged before any Stripe read or step", async () => {
  const h = harness({ writesAllowed: () => false });
  const results = await Promise.all(
    [updated(1), deletion()].map((event) => handleSubscriptionBillingEvent(event, h.run, h.deps)),
  );
  assert.deepEqual(results, [
    { status: "skipped", reason: "writes-blocked" },
    { status: "skipped", reason: "writes-blocked" },
  ]);
  assert.deepEqual(h.steps, []);
  assert.deepEqual(h.routes, []);
});

await test("a multi-item subscription is acknowledged with an alert instead of retried", async () => {
  const h = harness({
    loadSnapshot: async (_id, loadEvent) =>
      normalizeStripeBillingSnapshot(
        {
          ...stripeSubscription("active"),
          items: { data: [{ quantity: 1 }, { quantity: 2 }] },
        },
        { ...loadEvent, createdAt: 1, observedAt: 1 },
      ),
  });
  assert.deepEqual(await handleSubscriptionBillingEvent(updated(), h.run, h.deps), {
    status: "skipped",
    reason: "unsupported-stripe-shape",
  });
  assert.deepEqual(h.reconciled, []);
});

await test("store data errors are acknowledged; only an owned missing row retries", async () => {
  const { SubscriptionDataError } = await import("../apps/web/src/subscriptions/alerts");
  const corrupt = harness({
    reconcile: async () => {
      throw new SubscriptionDataError("unsupported-stripe-shape", "synthetic");
    },
  });
  assert.deepEqual(await handleSubscriptionBillingEvent(updated(), corrupt.run, corrupt.deps), {
    status: "skipped",
    reason: "unsupported-stripe-shape",
  });
  const early = harness({ reconcile: async () => ({ status: "not-ready" }) });
  await assert.rejects(
    handleSubscriptionBillingEvent(updated(), early.run, early.deps),
    (error: unknown) => error instanceof Error && error.name === "SubscriptionNotReadyError",
  );
});

await test("when retries run out, the failure handler logs an alert line", () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => {
    lines.push(String(line));
  };
  try {
    const failed = (name: string) => ({
      error: { name, message: "Local subscription is not ready for reconciliation" },
      event: {
        name: "inngest/function.failed",
        data: { event: { name: UPDATED, data: { stripeEvent: { id: "evt_synthetic" } } } },
      },
    });
    alertOnRetriesExhausted(failed("SubscriptionNotReadyError"));
    alertOnRetriesExhausted({
      error: { name: "Error", message: "boom" },
      event: failed("x").event,
    });
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /alert=not-ready-retries-exhausted/);
  assert.match(lines[0] ?? "", /evt_synthetic/);
  assert.match(lines[1] ?? "", /alert=retries-exhausted/);
  assert.equal(lines.join("").includes("boom"), false, "no error message is logged");
});

// The live ownership read, against the real Stripe SDK objects the provider
// builds. Only the network methods are replaced, on the SDK's own resource
// prototypes, so the seam's lookup by shape and its `this` binding run for real.
process.env["DATABASE_URL"] = "mysql://root:root@127.0.0.1:3307/coursebuilder_test";
process.env["STRIPE_SECRET_TOKEN"] = "sk_test_synthetic";
process.env["STRIPE_WEBHOOK_SECRET"] = "synthetic-webhook-secret";
process.env["NEXT_PUBLIC_APP_URL"] = "https://example.test";
const { getStripeProvider } = await import("../apps/web/src/coursebuilder/stripe-provider");
const { readStripeCustomerMarker } = await import("../apps/web/src/subscriptions/ownership-seam");
const { defaultSubscriptionBillingDeps } =
  await import("../apps/web/src/inngest/subscription-billing");
const { handleSubscriptionDeletion } = await import("../apps/web/src/subscriptions/webhook");

function liveStripe() {
  const adapter = getStripeProvider()?.options.paymentsAdapter;
  const stripe: unknown = adapter ? Reflect.get(adapter, "stripe") : undefined;
  assert.ok(typeof stripe === "object" && stripe !== null, "the provider builds a Stripe client");
  return stripe;
}

/** Replace one resource method on the SDK prototype; returns the calls and a restore. */
function stubResource(resource: string, method: string, reply: (id: string) => unknown) {
  const instance: unknown = Reflect.get(liveStripe(), resource);
  assert.ok(typeof instance === "object" && instance !== null);
  assert.equal(
    Object.hasOwn(instance, method),
    false,
    `${resource}.${method} lives on the SDK prototype`,
  );
  const prototype: unknown = Object.getPrototypeOf(instance);
  assert.ok(typeof prototype === "object" && prototype !== null);
  const original = Object.getOwnPropertyDescriptor(prototype, method);
  assert.equal(typeof original?.value, "function", `the SDK defines ${resource}.${method}`);
  const calls: Array<{ id: string; boundTo: string }> = [];
  Object.defineProperty(prototype, method, {
    configurable: true,
    writable: true,
    value: async function (this: unknown, id: string) {
      // The SDK's resources are bound to their client; a lost `this` would break them.
      calls.push({
        id,
        boundTo: this === instance || Object.getPrototypeOf(this) === prototype ? resource : "lost",
      });
      return reply(id);
    },
  });
  return {
    calls,
    restore: () => {
      if (original) Object.defineProperty(prototype, method, original);
    },
  };
}

await test("the live marker read calls the SDK's customers.retrieve and reads metadata or deletion", async () => {
  const stub = stubResource("customers", "retrieve", (id) =>
    id === "cus_gone"
      ? { id, object: "customer", deleted: true }
      : { id, object: "customer", metadata: { egghead_owner_timeline: "cb@0" } },
  );
  try {
    assert.deepEqual(await readStripeCustomerMarker("cus_live"), {
      deleted: false,
      metadata: { egghead_owner_timeline: "cb@0" },
    });
    assert.deepEqual(await readStripeCustomerMarker("cus_gone"), { deleted: true });
    assert.deepEqual(stub.calls, [
      { id: "cus_live", boundTo: "customers" },
      { id: "cus_gone", boundTo: "customers" },
    ]);
  } finally {
    stub.restore();
  }
});

await test("an update without a customer or creation time is routed from Stripe's own records", async () => {
  const customers = stubResource("customers", "retrieve", (id) => ({
    id,
    object: "customer",
    metadata: { egghead_owner_timeline: "rails@0;cb@1000" },
  }));
  const events = stubResource("events", "retrieve", (id) => ({
    id,
    object: "event",
    created: 1500,
  }));
  const subscriptions = stubResource("subscriptions", "retrieve", (id) => ({
    id,
    object: "subscription",
    status: "active",
    customer: "cus_from_subscription",
    items: { object: "list", data: [] },
  }));
  try {
    const routedLive = await defaultSubscriptionBillingDeps.routeEvent({
      eventId: "evt_live",
      stripeSubscriptionId: "sub_live",
      stripeCustomerId: null,
    });
    assert.equal(routedLive.stamp.owner, "cb", "created 1500 is after the flip at 1000");
    assert.equal(routedLive.eventCreated, 1500);
    assert.equal(routedLive.stripeCustomerId, "cus_from_subscription");
    assert.deepEqual(
      events.calls.map((call) => call.id),
      ["evt_live"],
    );
    assert.deepEqual(
      subscriptions.calls.map((call) => call.id),
      ["sub_live"],
    );
    assert.deepEqual(
      customers.calls.map((call) => call.id),
      ["cus_from_subscription"],
    );
  } finally {
    customers.restore();
    events.restore();
    subscriptions.restore();
  }
});

await test("a marker read failure at the deletion seam answers 503, so Stripe retries", async () => {
  const { StripePaymentAdapter } = await import("@coursebuilder/commerce/stripe-provider");
  const signer = new StripePaymentAdapter({
    stripeToken: "sk_test_synthetic",
    stripeWebhookSecret: "synthetic-webhook-secret",
  });
  const body = JSON.stringify({
    id: "evt_marker_down",
    created: 100,
    type: "customer.subscription.deleted",
    data: { object: { id: "sub_live", customer: "cus_live" } },
  });
  const signature = signer.stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: "synthetic-webhook-secret",
  });
  const stub = stubResource("customers", "retrieve", () => {
    throw Object.assign(new Error("connect ECONNRESET for someone@example.test"), {
      type: "StripeConnectionError",
    });
  });
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => {
    lines.push(String(line));
  };
  try {
    const response = await handleSubscriptionDeletion(
      new Request("https://example.test/api/coursebuilder/webhook/stripe", {
        method: "POST",
        headers: { "stripe-signature": signature },
        body,
      }),
      async () => {
        throw new Error("a subscription deletion is not forwarded");
      },
    );
    assert.equal(response?.status, 503);
  } finally {
    console.error = original;
    stub.restore();
  }
  assert.equal(stub.calls.length, 1);
  assert.match(lines.join("\n"), /alert=deletion-dispatch-failed/);
  assert.equal(lines.join("\n").includes("example.test"), false, "no message is logged");
});

await test("CourseBuilder's published update schema keeps the customer and drops the creation time", async () => {
  const { customerSubscriptionUpdatedEvent } =
    await import("@coursebuilder/core/schemas/stripe/customer-subscription-updated");
  // The shape @coursebuilder/commerce publishes: customerSubscriptionUpdatedEvent.parse(event).
  const published = customerSubscriptionUpdatedEvent.parse({
    id: "evt_published",
    object: "event",
    created: 1234,
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_synthetic",
        object: "subscription",
        status: "active",
        customer: "cus_published",
        items: { data: [{ id: "si_1", price: { id: "price_1", product: "prod_1" } }] },
      },
    },
  });
  assert.equal(published.data.object.customer, "cus_published");
  assert.equal("created" in published, false);
  // So the router reads the customer from the payload and never asks Stripe for it.
  const h = harness();
  await handleSubscriptionBillingEvent(
    { name: UPDATED, data: { stripeEvent: published } },
    h.run,
    h.deps,
  );
  assert.deepEqual(h.routes, [{ stripeCustomerId: "cus_published" }]);
});

await test("a CB-owned billing signal reconciles its subscription; without a local row it leaves a receipt", async () => {
  const signalEventFor = (owner: "rails" | "cb") => ({
    name: "egghead/stripe-billing-signal",
    data: {
      stripeEvent: {
        id: "evt_refund",
        created: 900,
        data: { object: { id: "sub_synthetic", customer: "cus_synthetic" } },
      },
      routing: routed(owner, 900),
      signal: { type: "charge.refunded", objectId: "ch_1" },
    },
  });
  const h = harness();
  assert.equal(
    (await handleSubscriptionBillingEvent(signalEventFor("cb"), h.run, h.deps))?.status,
    "applied",
  );
  assert.deepEqual(h.routes, [], "routed at receipt");
  assert.deepEqual(h.loads, [{ id: "evt_refund", kind: "subscription_update", createdAt: 900 }]);
  const rails = harness();
  assert.equal(
    (await handleSubscriptionBillingEvent(signalEventFor("rails"), rails.run, rails.deps))?.status,
    "not-owner",
  );
  assert.deepEqual(rails.loads, []);
  // No local row: a charge from before CB held the subscription (ADR §12).
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => {
    lines.push(String(line));
  };
  try {
    const missing = harness({ reconcile: async () => ({ status: "not-ready" }) });
    assert.deepEqual(
      await handleSubscriptionBillingEvent(signalEventFor("cb"), missing.run, missing.deps),
      {
        status: "skipped",
        reason: "no-local-subscription",
      },
    );
  } finally {
    console.error = original;
  }
  assert.match(lines.join("\n"), /alert=unmatched-billing-signal/);
});

const completedCheckout = {
  id: "evt_checkout",
  created: 700,
  type: "checkout.session.completed",
  data: {
    object: {
      id: "cs_synthetic",
      object: "checkout.session",
      amount_subtotal: 1000,
      amount_total: 1000,
      created: 690,
      currency: "usd",
      custom_fields: [],
      customer: "cus_synthetic",
      customer_details: { address: null, email: null, name: null },
      livemode: false,
      metadata: {},
      payment_method_collection: "always",
      payment_status: "paid",
      phone_number_collection: { enabled: false },
      status: "complete",
      success_url: "https://example.test/thanks",
      total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
      mode: "subscription",
      payment_intent: null,
      subscription: "sub_synthetic",
    },
  },
};

function checkoutHarness(input: {
  owner?: "rails" | "cb";
  writesAllowed?: boolean;
  reconcile?: () => Promise<Awaited<ReturnType<SubscriptionBillingDeps["reconcile"]>>>;
}) {
  const steps: string[] = [];
  const created: string[] = [];
  const announced: string[] = [];
  const loaded: string[] = [];
  const run: StepRun = async (name, work) => {
    steps.push(name);
    return JSON.parse(JSON.stringify(await work()));
  };
  const deps: CheckoutCompletedDeps<{
    customerIdentifier: string;
    subscriptionIdentifier: string;
  }> = {
    writesAllowed: () => input.writesAllowed ?? true,
    loadSubscriptionInfo: async (sessionId) => {
      loaded.push(sessionId);
      return { customerIdentifier: "cus_synthetic", subscriptionIdentifier: "sub_synthetic" };
    },
    routeEvent: async (route) => routed(input.owner ?? "cb", route.eventCreated),
    createRows: async (_info, sessionId) => {
      created.push(sessionId);
      return {
        subscriptionId: "local-subscription",
        announce: async () => {
          announced.push("local-subscription");
        },
      };
    },
    loadSnapshot: async (_stripeSubscriptionId, snapshotEvent) =>
      normalizeStripeBillingSnapshot(stripeSubscription("active"), {
        ...snapshotEvent,
        observedAt: 1000,
      }),
    reconcile:
      input.reconcile ??
      (async () => ({ status: "applied", subscriptionId: "local-subscription", assignedSeats: 1 })),
  };
  return { run, deps, steps, created, announced, loaded };
}

await test("checkout completion: blocked or Rails-owned creates no rows; only an applied reconcile announces", async () => {
  // Writes blocked: nothing read, routed, created or announced.
  const blocked = checkoutHarness({ writesAllowed: false });
  assert.deepEqual(
    await handleCheckoutSessionCompleted(completedCheckout, blocked.run, blocked.deps),
    {
      status: "skipped",
      reason: "writes-blocked",
    },
  );
  assert.deepEqual(
    [blocked.steps, blocked.loaded, blocked.created, blocked.announced],
    [[], [], [], []],
  );
  // Rails owns the customer: routed before any row exists, then acknowledged.
  const rails = checkoutHarness({ owner: "rails" });
  assert.deepEqual(await handleCheckoutSessionCompleted(completedCheckout, rails.run, rails.deps), {
    status: "not-owner",
    owner: "rails",
  });
  assert.deepEqual(rails.steps, ["route event ownership"]);
  assert.deepEqual([rails.created, rails.announced], [[], []]);
  // Reconcile skips undecodable data or finds another owner: rows exist, no announcement.
  const { SubscriptionDataError } = await import("../apps/web/src/subscriptions/alerts");
  const skipped = checkoutHarness({
    reconcile: async () => {
      throw new SubscriptionDataError("unsupported-stripe-shape", "synthetic");
    },
  });
  assert.deepEqual(
    await handleCheckoutSessionCompleted(completedCheckout, skipped.run, skipped.deps),
    {
      status: "skipped",
      reason: "unsupported-stripe-shape",
    },
  );
  assert.deepEqual(skipped.announced, []);
  const foreign = checkoutHarness({
    reconcile: async () => ({ status: "not-owner", subscriptionId: null }),
  });
  assert.equal(
    (await handleCheckoutSessionCompleted(completedCheckout, foreign.run, foreign.deps))?.status,
    "not-owner",
  );
  assert.deepEqual(foreign.announced, []);
  // Unchanged (an update event applied first): still the creation, so announced.
  const unchanged = checkoutHarness({
    reconcile: async () => ({
      status: "unchanged",
      subscriptionId: "local-subscription",
      assignedSeats: 1,
    }),
  });
  assert.equal(
    (await handleCheckoutSessionCompleted(completedCheckout, unchanged.run, unchanged.deps))
      ?.status,
    "active",
  );
  assert.deepEqual(unchanged.announced, ["local-subscription"]);
  // Applied: rows created once, announced once.
  const applied = checkoutHarness({});
  const result = await handleCheckoutSessionCompleted(completedCheckout, applied.run, applied.deps);
  assert.deepEqual(result, {
    seatCount: 1,
    subscriptionId: "local-subscription",
    status: "active",
  });
  assert.deepEqual(
    [applied.created, applied.announced],
    [["cs_synthetic"], ["local-subscription"]],
  );
  assert.deepEqual(applied.steps, [
    "route event ownership",
    "load current subscription billing",
    "reconcile initial subscription",
  ]);
});

await test("a deleted customer's pending record waits durably instead of spending retries", async () => {
  const { DeletedCustomerPendingError } =
    await import("../apps/web/src/subscriptions/ownership-seam");
  const { MAX_DELETED_CUSTOMER_WAITS } =
    await import("../apps/web/src/inngest/subscription-billing");
  // Pending twice (the customer.deleted record has not landed), then routed.
  let pendingLeft = 2;
  const h = harness({
    routeEvent: async (input) => {
      if (pendingLeft > 0) {
        pendingLeft -= 1;
        throw new DeletedCustomerPendingError();
      }
      return routed("cb", input.eventCreated ?? 5);
    },
  });
  const waits: Array<{ customer: string; attempt: number }> = [];
  const result = await handleSubscriptionBillingEvent(
    updated(5),
    h.run,
    h.deps,
    async (customer, attempt) => {
      waits.push({ customer, attempt });
      return null;
    },
  );
  assert.equal(result.status, "applied");
  assert.deepEqual(waits, [
    { customer: "cus_synthetic", attempt: 1 },
    { customer: "cus_synthetic", attempt: 2 },
  ]);
  // Each attempt is its own memoized step, so a replay never re-decides an earlier one.
  assert.deepEqual(h.steps.slice(0, 3), [
    "route event ownership",
    "route event ownership after wait 1",
    "route event ownership after wait 2",
  ]);
  // Without a durable wait (or past the cap) the pending error still throws.
  const bare = harness({
    routeEvent: async () => {
      throw new DeletedCustomerPendingError();
    },
  });
  await assert.rejects(
    handleSubscriptionBillingEvent(updated(5), bare.run, bare.deps),
    (error: unknown) => error instanceof DeletedCustomerPendingError,
  );
  let waited = 0;
  await assert.rejects(
    handleSubscriptionBillingEvent(updated(5), bare.run, bare.deps, async () => {
      waited += 1;
    }),
    (error: unknown) => error instanceof DeletedCustomerPendingError,
  );
  assert.equal(waited, MAX_DELETED_CUSTOMER_WAITS);
});

await test("recording a customer.deleted wakes the waiting runs, and a failed wake is only an alert", async () => {
  const { recordCustomerDeletion } = await import("../apps/web/src/subscriptions/webhook");
  const { DELETED_CUSTOMER_RECORDED_EVENT } =
    await import("../apps/web/src/subscriptions/webhook-contract");
  const deletedEvent = {
    id: "evt_customer_deleted",
    created: 10,
    type: "customer.deleted",
    data: { object: { id: "cus_synthetic", metadata: { egghead_owner_timeline: "cb@0" } } },
  };
  const announced: unknown[] = [];
  assert.equal(
    await recordCustomerDeletion(
      deletedEvent,
      async () => 2,
      async (event) => {
        announced.push(event);
      },
    ),
    2,
  );
  assert.deepEqual(announced, [
    { name: DELETED_CUSTOMER_RECORDED_EVENT, data: { stripeCustomerId: "cus_synthetic" } },
  ]);
  // No local rows: nothing waits on this customer, so nothing is sent.
  announced.length = 0;
  await recordCustomerDeletion(
    deletedEvent,
    async () => 0,
    async (event) => {
      announced.push(event);
    },
  );
  assert.deepEqual(announced, []);
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => {
    lines.push(String(line));
  };
  try {
    assert.equal(
      await recordCustomerDeletion(
        deletedEvent,
        async () => 1,
        async () => {
          throw new Error("inngest down");
        },
      ),
      1,
    );
  } finally {
    console.error = original;
  }
  assert.match(lines.join("\n"), /alert=deleted-customer-announce-failed/);
});
