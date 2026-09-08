#!/usr/bin/env bun
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  assertStripeTestSecret,
  subscriptionCheckoutIdempotencyKey,
} from "../apps/web/src/coursebuilder/stripe-provider";
import {
  handleStripeWebhook,
  type ForwardedStripeEvent,
} from "../apps/web/src/coursebuilder/stripe-webhook";
import {
  assertMembershipCheckoutMapping,
  assertUniqueMembershipMappings,
  resolveMembershipMapping,
  validateStripeMembershipMapping,
  type MembershipCatalogProvider,
} from "../apps/web/src/subscriptions/catalog-contracts";
import {
  checkoutReservationSchema,
  startReservedSubscriptionCheckout,
  type CheckoutProvider,
  type CheckoutRequest,
  type CheckoutReservation,
  type CheckoutReservationStore,
  type CheckoutSession,
  type CheckoutSubscription,
  type SubscriptionCheckoutParams,
} from "../apps/web/src/subscriptions/checkout-state";
const webhookRequest = (body: string, header?: string) =>
  new Request("http://localhost/api/coursebuilder/webhook/stripe", {
    method: "POST",
    body,
    headers: header ? { "stripe-signature": header } : {},
  });

function catalogRows(interval: "month" | "year" = "month") {
  return {
    productId: `membership-${interval}`,
    interval,
    prices: [
      { id: `local-price-${interval}`, status: 1, unitAmount: interval === "month" ? 20 : 150 },
    ],
    merchantProducts: [
      {
        id: `mapped-product-${interval}`,
        productId: `membership-${interval}`,
        merchantAccountId: "local-account",
        identifier: `stripe-product-${interval}`,
        status: 1,
      },
    ],
    merchantPrices: [
      {
        id: `mapped-price-${interval}`,
        merchantProductId: `mapped-product-${interval}`,
        merchantAccountId: "local-account",
        priceId: `local-price-${interval}`,
        identifier: `stripe-price-${interval}`,
        status: 1,
      },
    ],
    merchantAccounts: [
      { id: "local-account", identifier: "stripe-account-fixture", label: "stripe", status: 1 },
    ],
  };
}
const monthly = resolveMembershipMapping(catalogRows());
const yearly = resolveMembershipMapping(catalogRows("year"));
assert.ok(monthly);
assert.ok(yearly);
const request: CheckoutRequest = {
  mapping: monthly,
  productName: "Synthetic membership",
  quantity: 1,
  country: "US",
  siteUrl: "https://checkout.example.test",
  userId: "synthetic-user",
  organizationId: "synthetic-organization",
  email: "synthetic@example.test",
};
const yearlyRequest: CheckoutRequest = { ...request, mapping: yearly };

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  if (!resolve) throw new Error("Deferred resolver missing.");
  return { promise, resolve };
}

class MemoryStore implements CheckoutReservationStore {
  value: unknown;
  private queue = Promise.resolve();
  async locked<T>(
    operation: (
      current: unknown,
      save: (reservation: CheckoutReservation) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    const previous = this.queue;
    const release = deferred<void>();
    this.queue = release.promise;
    await previous;
    let pending = this.value;
    try {
      const result = await operation(this.value, async (reservation) => {
        pending = reservation;
      });
      this.value = pending;
      return result;
    } finally {
      release.resolve();
    }
  }
}

class SyntheticCheckoutProvider implements CheckoutProvider {
  sessions = new Map<string, CheckoutSession>();
  keys = new Map<string, CheckoutSession>();
  subscriptions = new Map<string, CheckoutSubscription>();
  createKeys: string[] = [];
  beforeCreate: (() => Promise<void>) | undefined;
  loseCreateResponse = false;
  failExpiration = false;
  loseExpirationResponse = false;
  async create(params: SubscriptionCheckoutParams, token: string) {
    const key = subscriptionCheckoutIdempotencyKey(token, params);
    this.createKeys.push(key);
    await this.beforeCreate?.();
    const cachedResponse = this.keys.get(key);
    if (cachedResponse) return { ...cachedResponse };
    const id = `synthetic-session-${this.sessions.size + 1}`;
    const session: CheckoutSession = {
      id,
      status: "open",
      url: `https://checkout.example.test/${id}`,
      livemode: false,
      customerId: params.customer ?? "synthetic-customer",
      subscriptionId: null,
      userId: params.metadata["userId"] ?? null,
      organizationId: params.metadata["organizationId"] ?? null,
      productId: params.metadata["productId"] ?? null,
    };
    this.sessions.set(id, session);
    this.keys.set(key, { ...session });
    if (this.loseCreateResponse) throw new Error("Synthetic network response lost.");
    return session;
  }
  async retrieve(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Synthetic session missing.");
    return session;
  }
  async getSubscription(id: string) {
    const subscription = this.subscriptions.get(id);
    if (!subscription) throw new Error("Synthetic subscription lookup failed.");
    return subscription;
  }
  async expire(id: string) {
    if (this.failExpiration) throw new Error("Synthetic expiration failed.");
    const session = await this.retrieve(id);
    if (session.status !== "open") throw new Error("Synthetic session is no longer expireable.");
    const expired: CheckoutSession = { ...session, status: "expired", url: null };
    this.sessions.set(id, expired);
    if (this.loseExpirationResponse) throw new Error("Synthetic expiration response lost.");
    return expired;
  }
  payableCount() {
    return [...this.sessions.values()].filter((session) => session.status === "open").length;
  }
}

function catalogProvider(): MembershipCatalogProvider {
  return {
    getAccount: async () => ({ id: "stripe-account-fixture", livemode: false }),
    getProduct: async (id) => ({ id, active: true, livemode: false }),
    getPrice: async (id) => ({
      id,
      active: true,
      livemode: false,
      product: "stripe-product-month",
      currency: "usd",
      unit_amount: 2000,
      type: "recurring",
      billing_scheme: "per_unit",
      recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
    }),
  };
}

const checks: { name: string; pass: true }[] = [];
let runningCheck = "checkout readiness";
async function check(name: string, run: () => void | Promise<void>) {
  runningCheck = name;
  await run();
  checks.push({ name, pass: true });
}

try {
  await check(
    "monthly and yearly mappings retain distinct traceable product and price rows",
    () => {
      assert.equal(monthly.interval, "month");
      assert.equal(yearly.interval, "year");
      assert.notEqual(monthly.productId, yearly.productId);
      assert.notEqual(monthly.stripeProductId, yearly.stripeProductId);
      assert.notEqual(monthly.stripePriceId, yearly.stripePriceId);
      assert.equal(monthly.unitAmount, 2000);
      assert.equal(yearly.unitAmount, 15000);
    },
  );
  await check(
    "monthly and yearly cannot share a native product or price in one Stripe account",
    () => {
      assertUniqueMembershipMappings([monthly, yearly]);
      assert.throws(
        () =>
          assertUniqueMembershipMappings([
            monthly,
            { ...yearly, stripeProductId: monthly.stripeProductId },
          ]),
        /Ambiguous/,
      );
      assert.throws(
        () =>
          assertUniqueMembershipMappings([
            monthly,
            { ...yearly, stripePriceId: monthly.stripePriceId },
          ]),
        /Ambiguous/,
      );
    },
  );
  await check("checkout metadata binds to the exact local product native price and account", () => {
    const identity = {
      productId: monthly.productId,
      stripeProductId: monthly.stripeProductId,
      stripePriceId: monthly.stripePriceId,
      merchantAccountId: monthly.merchantAccountId,
    };
    assert.equal(assertMembershipCheckoutMapping(monthly, identity), monthly);
    assert.throws(() => assertMembershipCheckoutMapping(yearly, identity), /exact membership/);
    assert.throws(
      () => assertMembershipCheckoutMapping(monthly, { ...identity, productId: yearly.productId }),
      /exact membership/,
    );
    assert.throws(
      () =>
        assertMembershipCheckoutMapping(monthly, {
          ...identity,
          stripePriceId: yearly.stripePriceId,
        }),
      /exact membership/,
    );
    assert.throws(
      () =>
        assertMembershipCheckoutMapping(monthly, {
          ...identity,
          merchantAccountId: "different-account",
        }),
      /exact membership/,
    );
  });
  await check("inactive and ambiguous local merchant mappings fail closed", () => {
    for (const key of [
      "prices",
      "merchantProducts",
      "merchantPrices",
      "merchantAccounts",
    ] as const) {
      const rows = catalogRows();
      for (const row of rows[key]) row.status = 0;
      assert.equal(resolveMembershipMapping(rows), null);
    }
    const ambiguous = catalogRows();
    ambiguous.merchantPrices.push({
      id: "second-mapping",
      merchantProductId: "mapped-product-month",
      merchantAccountId: "local-account",
      priceId: "local-price-month",
      identifier: "another-price",
      status: 1,
    });
    assert.throws(() => resolveMembershipMapping(ambiguous), /Ambiguous/);
    const mismatch = catalogRows();
    for (const row of mismatch.merchantPrices) row.priceId = "unrelated-local-price";
    assert.throws(() => resolveMembershipMapping(mismatch), /Mismatched/);
  });
  await check(
    "Stripe active state, currency, interval, amount, quantity and test account are verified",
    async () => {
      await validateStripeMembershipMapping(monthly, 1, catalogProvider());
      await validateStripeMembershipMapping(monthly, 100, catalogProvider());
      const base = catalogProvider();
      const price = await base.getPrice(monthly.stripePriceId);
      await validateStripeMembershipMapping(yearly, 1, {
        ...base,
        getPrice: async (id) => ({
          ...price,
          id,
          product: yearly.stripeProductId,
          unit_amount: yearly.unitAmount,
          recurring: { interval: "year", interval_count: 1, usage_type: "licensed" },
        }),
      });
      const invalidPrices = [
        { ...price, active: false },
        { ...price, livemode: true },
        { ...price, currency: "eur" },
        { ...price, unit_amount: 15000 },
        { ...price, product: "unrelated-product" },
        { ...price, recurring: { interval: "year", interval_count: 1, usage_type: "licensed" } },
        { ...price, recurring: { interval: "month", interval_count: 2, usage_type: "licensed" } },
        { ...price, recurring: { interval: "month", interval_count: 1, usage_type: "metered" } },
        { ...price, transform_quantity: { divide_by: 10, round: "up" } },
      ];
      await Promise.all(
        invalidPrices.map((invalid) =>
          assert.rejects(
            validateStripeMembershipMapping(monthly, 1, { ...base, getPrice: async () => invalid }),
          ),
        ),
      );
      await assert.rejects(
        validateStripeMembershipMapping(monthly, 1, {
          ...base,
          getProduct: async (id) => ({ id, active: false, livemode: false }),
        }),
      );
      await assert.rejects(
        validateStripeMembershipMapping(monthly, 1, {
          ...base,
          getProduct: async (id) => ({ id, active: true, livemode: true }),
        }),
      );
      await assert.rejects(
        validateStripeMembershipMapping(monthly, 1, {
          ...base,
          getAccount: async () => ({ id: "stripe-account-fixture", livemode: true }),
        }),
      );
      await assert.rejects(
        validateStripeMembershipMapping(monthly, 1, {
          ...base,
          getAccount: async () => ({ id: "other-account", livemode: false }),
        }),
      );
      await assert.rejects(validateStripeMembershipMapping(monthly, 0, base));
      await assert.rejects(validateStripeMembershipMapping(monthly, 101, base));
      assert.throws(() => assertStripeTestSecret("sk_live_synthetic"));
      assertStripeTestSecret("sk_test_synthetic");
    },
  );
  await check(
    "idempotency is stable across property ordering and distinguishes changed parameters",
    () => {
      const first = subscriptionCheckoutIdempotencyKey("synthetic-attempt", {
        mode: "subscription",
        line_items: [{ price: "synthetic-price", quantity: 1 }],
      });
      assert.equal(
        first,
        subscriptionCheckoutIdempotencyKey("synthetic-attempt", {
          line_items: [{ quantity: 1, price: "synthetic-price" }],
          mode: "subscription",
        }),
      );
      assert.notEqual(
        first,
        subscriptionCheckoutIdempotencyKey("synthetic-attempt", {
          mode: "subscription",
          line_items: [{ price: "synthetic-price", quantity: 2 }],
        }),
      );
    },
  );
  await check("backend quantity zero and 101 never reserve or call Stripe", async () => {
    const store = new MemoryStore();
    const provider = new SyntheticCheckoutProvider();
    await Promise.all(
      [0, 101].map((quantity) =>
        assert.rejects(
          startReservedSubscriptionCheckout({ ...request, quantity }, store, provider),
        ),
      ),
    );
    assert.equal(store.value, undefined);
    assert.equal(provider.createKeys.length, 0);
  });
  await check(
    "slow concurrent creates outlive the former TTL without two payable sessions",
    async () => {
      const store = new MemoryStore();
      const provider = new SyntheticCheckoutProvider();
      const entered = deferred<void>();
      const release = deferred<void>();
      let now = 1000;
      provider.beforeCreate = async () => {
        entered.resolve();
        await release.promise;
      };
      const first = startReservedSubscriptionCheckout(request, store, provider, () => now);
      await entered.promise;
      now += 10 * 60;
      const second = startReservedSubscriptionCheckout(request, store, provider, () => now);
      release.resolve();
      const urls = await Promise.all([first, second]);
      assert.equal(urls[0], urls[1]);
      assert.equal(provider.sessions.size, 1);
      assert.equal(provider.payableCount(), 1);
    },
  );
  await check(
    "concurrent changed selection expires the late first session before making another payable",
    async () => {
      const store = new MemoryStore();
      const provider = new SyntheticCheckoutProvider();
      const entered = deferred<void>();
      const release = deferred<void>();
      provider.beforeCreate = async () => {
        entered.resolve();
        await release.promise;
      };
      const first = startReservedSubscriptionCheckout(request, store, provider, () => 1000);
      await entered.promise;
      const replacement = startReservedSubscriptionCheckout(
        yearlyRequest,
        store,
        provider,
        () => 2000,
      );
      release.resolve();
      const [oldUrl, newUrl] = await Promise.all([first, replacement]);
      assert.notEqual(oldUrl, newUrl);
      assert.equal(provider.sessions.size, 2);
      assert.equal(provider.payableCount(), 1);
      assert.equal(checkoutReservationSchema.parse(store.value).mapping.interval, "year");
      const oldSession = [...provider.sessions.values()].find((session) =>
        oldUrl.endsWith(session.id),
      );
      assert.equal(oldSession?.status, "expired");
    },
  );
  await check("failed expiration keeps the old reservation blocking replacement", async () => {
    const store = new MemoryStore();
    const provider = new SyntheticCheckoutProvider();
    await startReservedSubscriptionCheckout(request, store, provider, () => 1000);
    const before = checkoutReservationSchema.parse(store.value);
    provider.failExpiration = true;
    await assert.rejects(
      startReservedSubscriptionCheckout(yearlyRequest, store, provider, () => 2000),
    );
    assert.equal(checkoutReservationSchema.parse(store.value).token, before.token);
    assert.equal(provider.sessions.size, 1);
    assert.equal(provider.payableCount(), 1);
    provider.failExpiration = false;
    await startReservedSubscriptionCheckout(yearlyRequest, store, provider, () => 2100);
    assert.equal(provider.sessions.size, 2);
    assert.equal(provider.payableCount(), 1);
    assert.equal(checkoutReservationSchema.parse(store.value).mapping.interval, "year");
  });
  await check(
    "lost create response is replayed with the exact stored key before replacement",
    async () => {
      const store = new MemoryStore();
      const provider = new SyntheticCheckoutProvider();
      provider.loseCreateResponse = true;
      await assert.rejects(startReservedSubscriptionCheckout(request, store, provider, () => 1000));
      const before = checkoutReservationSchema.parse(store.value);
      provider.loseCreateResponse = false;
      await startReservedSubscriptionCheckout(yearlyRequest, store, provider, () => 5000);
      assert.equal(provider.createKeys[0], provider.createKeys[1]);
      assert.notEqual(checkoutReservationSchema.parse(store.value).token, before.token);
      assert.equal(provider.sessions.size, 2);
      assert.equal(provider.payableCount(), 1);
    },
  );
  await check(
    "expired session replay retrieves current state instead of cached open create response",
    async () => {
      const store = new MemoryStore();
      const provider = new SyntheticCheckoutProvider();
      provider.loseCreateResponse = true;
      await assert.rejects(startReservedSubscriptionCheckout(request, store, provider, () => 1000));
      for (const [id, session] of provider.sessions)
        provider.sessions.set(id, { ...session, status: "expired", url: null });
      provider.loseCreateResponse = false;
      await startReservedSubscriptionCheckout(
        yearlyRequest,
        store,
        provider,
        () => 1000 + 13 * 60 * 60,
      );
      assert.equal(provider.createKeys[0], provider.createKeys[1]);
      assert.equal(provider.sessions.size, 2);
      assert.equal(provider.payableCount(), 1);
      assert.equal(checkoutReservationSchema.parse(store.value).mapping.interval, "year");
    },
  );
  await check("lost expiration response reconciles by retrieval before replacement", async () => {
    const store = new MemoryStore();
    const provider = new SyntheticCheckoutProvider();
    await startReservedSubscriptionCheckout(request, store, provider, () => 1000);
    provider.loseExpirationResponse = true;
    await assert.rejects(
      startReservedSubscriptionCheckout(yearlyRequest, store, provider, () => 2000),
    );
    assert.equal(provider.payableCount(), 0);
    provider.loseExpirationResponse = false;
    await startReservedSubscriptionCheckout(yearlyRequest, store, provider, () => 3000);
    assert.equal(provider.payableCount(), 1);
  });
  await check("unassociated completed and legacy unknown sessions cannot be replaced", async () => {
    const store = new MemoryStore();
    const provider = new SyntheticCheckoutProvider();
    await startReservedSubscriptionCheckout(request, store, provider, () => 1000);
    for (const [id, session] of provider.sessions)
      provider.sessions.set(id, { ...session, status: "complete" });
    await assert.rejects(
      startReservedSubscriptionCheckout(yearlyRequest, store, provider, () => 2000),
      /Completed/,
    );
    assert.equal(provider.sessions.size, 1);
    store.value = { token: "old-attempt", pendingUntil: 1, productId: "old-membership" };
    await assert.rejects(
      startReservedSubscriptionCheckout(request, store, provider, () => 2000),
      /reconciliation/,
    );
  });
  await check(
    "canceled subscription repurchase requires exact completed session and customer association",
    async () => {
      const store = new MemoryStore();
      const provider = new SyntheticCheckoutProvider();
      await startReservedSubscriptionCheckout(request, store, provider, () => 1000);
      const old = checkoutReservationSchema.parse(store.value);
      for (const [id, session] of provider.sessions)
        provider.sessions.set(id, {
          ...session,
          status: "complete",
          subscriptionId: "synthetic-subscription",
        });
      provider.subscriptions.set("synthetic-subscription", {
        id: "synthetic-subscription",
        customerId: "synthetic-customer",
        status: "canceled",
        livemode: false,
      });
      await startReservedSubscriptionCheckout(
        { ...yearlyRequest, customerId: "synthetic-customer" },
        store,
        provider,
        () => 2000,
      );
      assert.equal(provider.sessions.size, 2);
      assert.equal(provider.payableCount(), 1);
      const renewed = checkoutReservationSchema.parse(store.value);
      assert.notEqual(renewed.token, old.token);
      assert.equal(renewed.params.customer, "synthetic-customer");
    },
  );
  await check(
    "active uncertain or mismatched completed subscriptions keep repurchase blocked",
    async () => {
      const store = new MemoryStore();
      const provider = new SyntheticCheckoutProvider();
      await startReservedSubscriptionCheckout(request, store, provider, () => 1000);
      const old = checkoutReservationSchema.parse(store.value);
      for (const [id, session] of provider.sessions)
        provider.sessions.set(id, {
          ...session,
          status: "complete",
          subscriptionId: "synthetic-subscription",
        });
      const repurchase = { ...yearlyRequest, customerId: "synthetic-customer" };
      await ["active", "trialing", "past_due", "unpaid", "paused"].reduce(
        async (previous, status) => {
          await previous;
          provider.subscriptions.set("synthetic-subscription", {
            id: "synthetic-subscription",
            customerId: "synthetic-customer",
            status,
            livemode: false,
          });
          await assert.rejects(
            startReservedSubscriptionCheckout(repurchase, store, provider, () => 2000),
            /not terminal/,
          );
        },
        Promise.resolve(),
      );
      provider.subscriptions.delete("synthetic-subscription");
      await assert.rejects(
        startReservedSubscriptionCheckout(repurchase, store, provider, () => 2000),
        /lookup failed/,
      );
      provider.subscriptions.set("synthetic-subscription", {
        id: "synthetic-subscription",
        customerId: "different-customer",
        status: "canceled",
        livemode: false,
      });
      await assert.rejects(
        startReservedSubscriptionCheckout(repurchase, store, provider, () => 2000),
        /not terminal/,
      );
      provider.subscriptions.set("synthetic-subscription", {
        id: "synthetic-subscription",
        customerId: "synthetic-customer",
        status: "canceled",
        livemode: false,
      });
      await assert.rejects(
        startReservedSubscriptionCheckout(
          { ...repurchase, customerId: "different-customer" },
          store,
          provider,
          () => 2000,
        ),
        /association/,
      );
      assert.equal(checkoutReservationSchema.parse(store.value).token, old.token);
      assert.equal(provider.sessions.size, 1);
    },
  );
  await check(
    "unknown outcomes beyond Stripe key retention remain blocked rather than replayed",
    async () => {
      const store = new MemoryStore();
      const provider = new SyntheticCheckoutProvider();
      provider.loseCreateResponse = true;
      await assert.rejects(startReservedSubscriptionCheckout(request, store, provider, () => 1000));
      await assert.rejects(
        startReservedSubscriptionCheckout(request, store, provider, () => 1000 + 24 * 60 * 60),
        /unknown/,
      );
      assert.equal(provider.createKeys.length, 1);
      assert.ok(store.value);
    },
  );
  await check(
    "webhook verifies actual signatures and awaits dispatch including deletion",
    async () => {
      const keys = [
        "DATABASE_URL",
        "EGGHEAD_RUNTIME",
        "STRIPE_SECRET_TOKEN",
        "STRIPE_WEBHOOK_SECRET",
      ] as const;
      const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
      try {
        process.env["DATABASE_URL"] = "mysql://root:root@127.0.0.1:3307/coursebuilder_test";
        process.env["EGGHEAD_RUNTIME"] = "local";
        process.env["STRIPE_SECRET_TOKEN"] = "sk_test_synthetic_offline";
        const secret = "whsec_synthetic_offline_contract_only";
        process.env["STRIPE_WEBHOOK_SECRET"] = secret;
        const timestamp = Math.floor(Date.now() / 1000);
        const payload = JSON.stringify({
          id: "synthetic-event",
          created: timestamp,
          livemode: false,
          type: "customer.subscription.deleted",
          data: { object: { id: "synthetic-subscription" } },
        });
        const signature = `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex")}`;
        const delivered: ForwardedStripeEvent[] = [];
        const publish = async (event: ForwardedStripeEvent) => {
          delivered.push(event);
        };
        assert.equal((await handleStripeWebhook(webhookRequest(payload), publish)).status, 400);
        assert.equal(
          (await handleStripeWebhook(webhookRequest(payload, "invalid"), publish)).status,
          400,
        );
        assert.equal(
          (await handleStripeWebhook(webhookRequest(`${payload} `, signature), publish)).status,
          400,
        );
        assert.equal(delivered.length, 0);
        assert.equal(
          (await handleStripeWebhook(webhookRequest(payload, signature), publish)).status,
          200,
        );
        assert.equal(delivered.length, 1);
        assert.equal(delivered[0]?.name, "stripe/customer-subscription-deleted");
        assert.equal(delivered[0]?.id, "synthetic-event");
        const invoicePayload = JSON.stringify({
          id: "synthetic-paid-event",
          created: timestamp,
          livemode: false,
          type: "invoice.paid",
          data: { object: { id: "synthetic-invoice", subscription: "synthetic-subscription" } },
        });
        const invoiceSignature = `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${invoicePayload}`).digest("hex")}`;
        assert.equal(
          (await handleStripeWebhook(webhookRequest(invoicePayload, signature), publish)).status,
          400,
        );
        assert.equal(delivered.length, 1);
        assert.equal(
          (await handleStripeWebhook(webhookRequest(invoicePayload, invoiceSignature), publish))
            .status,
          200,
        );
        const paid = delivered[1];
        assert.equal(paid?.name, "stripe/invoice-paid");
        if (paid?.name !== "stripe/invoice-paid")
          throw new Error("Paid invoice event not forwarded.");
        assert.equal(paid.data.stripeEvent.data.object.subscription, "synthetic-subscription");
        assert.equal(paid.id, "synthetic-paid-event");
        const failed = await handleStripeWebhook(webhookRequest(payload, signature), async () => {
          throw new Error("Synthetic dispatch failure");
        });
        assert.equal(failed.status, 503);
        process.env["EGGHEAD_RUNTIME"] = "production";
        assert.equal(
          (await handleStripeWebhook(webhookRequest(payload, signature), publish)).status,
          403,
        );
        assert.equal(delivered.length, 2);
      } finally {
        for (const key of keys) {
          const value = original[key];
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
  );
  console.log(JSON.stringify({ ok: true, checks }));
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      check: runningCheck,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
}
