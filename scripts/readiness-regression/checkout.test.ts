import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock, beforeEach, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { appImport, appModule, appRequire, resetRuntimeEnvironment } from "./fixtures";

type Row = Record<string, unknown>;
type Product = {
  id: string;
  name: string;
  type: string;
  status: number;
  fields: { billingInterval: string };
  price: { id: string; productId: string; status: number; unitAmount: number };
};
type SessionParams = {
  mode: string;
  line_items: { price: string; quantity: number }[];
  metadata: Record<string, string>;
  expires_at?: number;
  customer?: string;
  customer_email?: string;
};
type Session = {
  id: string;
  status: "open" | "complete" | "expired";
  url: string;
  livemode: boolean;
  expires_at: number;
  customer: string | null;
  subscription: string | null;
  metadata: Record<string, string>;
};

const user = { id: "checkout-owner", email: "checkout-owner@example.test" };
const organization = { id: "checkout-organization" };
const stripeAccountId = "acct_checkout_fixture";
const merchantAccountId = "merchant-account";
const customerId = "cus_checkout_fixture";
const startTime = Date.parse("2026-01-10T12:00:00Z");
let now = startTime;
let organizationFields: Row = {};
let transactionTail = Promise.resolve();
let products: Product[];
let priceRows: Row[];
let merchantProducts: Row[];
let merchantPrices: Row[];
let merchantAccounts: Row[];
let merchantCustomers: Row[];
let stripePrices: Map<string, Row>;
let stripeProducts: Map<string, Row>;
let sessions = new Map<string, Session>();
let sessionParams = new Map<string, SessionParams>();
let idempotentSessions = new Map<string, Session>();
let expireBehavior: "expire" | "throw" | "open" = "expire";
let dropNextAcknowledgment = false;
let holdNextCreate: Promise<void> | undefined;
let onCreate: (() => void) | undefined;
let createCalls = 0;
let expireCalls = 0;
let customerWrites = 0;

function membership(id: string, interval: string, amount: number): Product {
  return {
    id,
    name: `Membership ${id}`,
    type: "membership",
    status: 1,
    fields: { billingInterval: interval },
    price: { id: `local-price-${id}`, productId: id, status: 1, unitAmount: amount },
  };
}

function resetStorage() {
  now = startTime;
  organizationFields = {};
  transactionTail = Promise.resolve();
  products = [membership("monthly", "month", 25), membership("yearly", "year", 250)];
  priceRows = products.map((product) => ({ ...product.price }));
  merchantProducts = products.map((product) => ({
    id: `merchant-product-${product.id}`,
    productId: product.id,
    identifier: `prod_${product.id}`,
    merchantAccountId,
    status: 1,
  }));
  merchantPrices = products.map((product) => ({
    id: `merchant-price-${product.id}`,
    merchantProductId: `merchant-product-${product.id}`,
    merchantAccountId,
    priceId: product.price.id,
    identifier: `price_${product.id}`,
    status: 1,
  }));
  merchantAccounts = [
    { id: merchantAccountId, identifier: stripeAccountId, label: "stripe", status: 1 },
  ];
  merchantCustomers = [
    {
      id: "merchant-customer",
      userId: user.id,
      merchantAccountId,
      identifier: customerId,
      status: 1,
    },
  ];
  stripeProducts = new Map(
    products.map((product) => [
      `prod_${product.id}`,
      { id: `prod_${product.id}`, active: true, livemode: false },
    ]),
  );
  stripePrices = new Map(
    products.map((product) => [
      `price_${product.id}`,
      {
        id: `price_${product.id}`,
        active: true,
        livemode: false,
        product: `prod_${product.id}`,
        currency: "usd",
        unit_amount: product.price.unitAmount * 100,
        type: "recurring",
        billing_scheme: "per_unit",
        recurring: {
          interval: product.fields.billingInterval,
          interval_count: 1,
          usage_type: "licensed",
        },
      },
    ]),
  );
  sessions = new Map();
  sessionParams = new Map();
  idempotentSessions = new Map();
  expireBehavior = "expire";
  dropNextAcknowledgment = false;
  holdNextCreate = undefined;
  onCreate = undefined;
  createCalls = 0;
  expireCalls = 0;
  customerWrites = 0;
}

function required<T>(value: T | undefined): T {
  assert.notEqual(value, undefined, "Fixture row must exist");
  if (value === undefined) throw new Error("Missing fixture row");
  return value;
}

// Replace only external Stripe. Both revisions retain their real application
// adapter and published CourseBuilder checkout/pricing implementation.
class StripeFixture {
  accounts = { retrieve: async () => ({ id: stripeAccountId }) };
  balance = { retrieve: async () => ({ livemode: false }) };
  products = { retrieve: async (id: string) => structuredClone(required(stripeProducts.get(id))) };
  prices = { retrieve: async (id: string) => structuredClone(required(stripePrices.get(id))) };
  customers = {
    retrieve: async (id: string) => ({ id, email: user.email, livemode: false }),
    create: async () => {
      customerWrites++;
      return { id: customerId };
    },
  };
  subscriptions = {
    retrieve: async (id: string) => ({
      id,
      customer: customerId,
      status: "active",
      livemode: false,
    }),
  };
  checkout = {
    sessions: {
      create: async (params: SessionParams, options?: { idempotencyKey?: string }) => {
        createCalls++;
        const key = options?.idempotencyKey;
        const replay = key ? idempotentSessions.get(key) : undefined;
        if (replay) return structuredClone(replay);
        const id = `cs_fixture_${sessions.size + 1}`;
        const session: Session = {
          id,
          status: "open",
          url: `https://checkout.stripe.test/${id}`,
          livemode: false,
          expires_at: params.expires_at ?? Math.floor(now / 1000) + 24 * 60 * 60,
          customer: params.customer ?? null,
          subscription: null,
          metadata: structuredClone(params.metadata),
        };
        sessions.set(id, session);
        sessionParams.set(id, structuredClone(params));
        if (key) idempotentSessions.set(key, structuredClone(session));
        const pending = holdNextCreate;
        holdNextCreate = undefined;
        onCreate?.();
        if (pending) await pending;
        if (dropNextAcknowledgment) {
          dropNextAcknowledgment = false;
          throw new Error("Stripe accepted create, but its response was lost");
        }
        return structuredClone(session);
      },
      retrieve: async (id: string) => structuredClone(required(sessions.get(id))),
      expire: async (id: string) => {
        expireCalls++;
        const session = required(sessions.get(id));
        if (expireBehavior === "throw") throw new Error("Stripe expiration outcome is unknown");
        if (expireBehavior === "expire" && session.status === "open") session.status = "expired";
        return structuredClone(session);
      },
    },
  };
}

const coreImport = appImport("@coursebuilder/core/providers/stripe");
const coreRequire = createRequire(coreImport);
mock.module(coreRequire.resolve("stripe"), {
  defaultExport: StripeFixture,
  namedExports: { Stripe: StripeFixture },
});
mock.module(import.meta.resolve("stripe", coreImport), {
  defaultExport: StripeFixture,
  namedExports: { Stripe: StripeFixture },
});

const schema: Record<string, unknown> = await import(appModule("db/schema.ts"));
const {
  MySqlDialect,
}: { MySqlDialect: new () => { sqlToQuery(sql: unknown): { params: unknown[] } } } =
  appRequire("drizzle-orm/mysql-core");
const dialect = new MySqlDialect();

function deferred() {
  const state: { resolve?: () => void } = {};
  const promise = new Promise<void>((resolve) => {
    state.resolve = resolve;
  });
  return { promise, resolve: required(state.resolve) };
}

function database(fields: { value: Row }) {
  return {
    select() {
      return {
        from(table: unknown) {
          return {
            where(condition: unknown) {
              const params = dialect.sqlToQuery(condition).params;
              let rows: Row[];
              if (table === schema["products"]) rows = products;
              else if (table === schema["prices"])
                rows = priceRows.filter((row) => params.includes(row["productId"]));
              else if (table === schema["merchantProduct"])
                rows = merchantProducts.filter((row) => params.includes(row["productId"]));
              else if (table === schema["merchantPrice"])
                rows = merchantPrices.filter((row) => params.includes(row["merchantProductId"]));
              else if (table === schema["merchantAccount"])
                rows = merchantAccounts.filter((row) => params.includes(row["label"]));
              else if (table === schema["merchantCustomer"])
                rows = merchantCustomers.filter((row) => params.includes(row["userId"]));
              else if (table === schema["organization"]) rows = [{ fields: fields.value }];
              else throw new Error("Unexpected fixture database table");
              const result = Promise.resolve(structuredClone(rows));
              return Object.assign(result, { for: () => result });
            },
          };
        },
      };
    },
    update(table: unknown) {
      assert.equal(table, schema["organization"]);
      return {
        set(update: { fields: Row }) {
          return {
            where: async () => {
              fields.value = structuredClone(update.fields);
            },
          };
        },
      };
    },
  };
}

const db = {
  select: () => database({ value: organizationFields }).select(),
  async transaction<T>(operation: (transaction: ReturnType<typeof database>) => Promise<T>) {
    const previous = transactionTail;
    const gate = deferred();
    transactionTail = gate.promise;
    await previous;
    const fields = { value: structuredClone(organizationFields) };
    try {
      const result = await operation(database(fields));
      organizationFields = fields.value;
      return result;
    } finally {
      gate.resolve();
    }
  },
};

const adapter = {
  getProduct: async (id: string) => products.find((product) => product.id === id) ?? null,
  getPriceForProduct: async (id: string) =>
    products.find((product) => product.id === id)?.price ?? null,
  getMerchantProductForProductId: async (id: string) =>
    merchantProducts.find((row) => row["productId"] === id) ?? null,
  getMerchantPriceForProductId: async (id: string) =>
    merchantPrices.find((row) => row["merchantProductId"] === id) ?? null,
  getUser: async () => user,
  getMerchantCustomerForUserId: async () => merchantCustomers[0] ?? null,
  getMerchantAccount: async () => merchantAccounts[0] ?? null,
  createMerchantCustomer: async (row: Row) => {
    merchantCustomers.push(row);
    return row;
  },
  getDefaultCoupon: async () => null,
  getEntitlementTypeByName: async () => null,
  getPurchasesForUser: async () => [],
  getMerchantCouponsForTypeAndPercent: async () => [],
};
mock.module(appModule("db/adapter.ts"), {
  namedExports: { getEggheadDatabase: () => db, getCourseBuilderAdapter: () => adapter },
});
mock.module(appModule("coursebuilder/current-user.ts"), {
  namedExports: { getCurrentUser: async () => user },
});
mock.module(appModule("subscriptions/personal-organization.ts"), {
  namedExports: { ensurePersonalOrganization: async () => ({ organization }) },
});
mock.module(appModule("subscriptions/status.ts"), {
  namedExports: { getCurrentSubscriptionForUser: async () => null },
});
mock.module(appImport("next/headers"), {
  namedExports: { headers: async () => new Headers({ "x-vercel-ip-country": "US" }) },
});
class Redirect extends Error {
  get location() {
    return this.message;
  }
}
mock.module(appImport("next/navigation"), {
  namedExports: {
    redirect: (location: string) => {
      throw new Redirect(location);
    },
  },
});
mock.method(Date, "now", () => now);

const pricing: { startSubscriptionCheckout(form: FormData): Promise<void> } = await import(
  appModule("app/pricing/actions.ts")
);
const catalog: { getActiveMembershipProduct(id: string): Promise<unknown> } = await import(
  appModule("subscriptions/catalog.ts")
);
const stripeProvider: {
  subscriptionCheckoutIdempotencyKey(attempt: string, params: object): string;
  getStripeProvider(): null | {
    createCheckoutSession(params: object, adapter: object): Promise<unknown>;
    options: {
      paymentsAdapter: { createCheckoutSession(params: SessionParams): Promise<unknown> };
    };
  };
} = await import(appModule("coursebuilder/stripe-provider.ts"));

beforeEach(() => {
  resetRuntimeEnvironment();
  resetStorage();
});

async function checkout(productId = "monthly", quantity = 1) {
  const form = new FormData();
  form.set("productId", productId);
  form.set("quantity", String(quantity));
  try {
    await pricing.startSubscriptionCheckout(form);
    return assert.fail("Pricing action must redirect");
  } catch (error) {
    if (error instanceof Redirect) return error.location;
    throw error;
  }
}

function payableSessions() {
  return [...sessions.values()].filter((session) => session.status === "open");
}

async function successfulCheckout() {
  const location = await checkout();
  assert.equal(location, "https://checkout.stripe.test/cs_fixture_1");
  assert.equal(payableSessions().length, 1);
  return required(sessions.get("cs_fixture_1"));
}

for (const quantity of [1, 2]) {
  void test(`authenticated concurrent checkout after two minutes leaves one payable session (quantity ${quantity})`, async () => {
    const started = deferred();
    const release = deferred();
    holdNextCreate = release.promise;
    onCreate = () => started.resolve();
    const first = checkout();
    await Promise.race([
      started.promise,
      first.then((location) =>
        assert.fail(`Checkout returned before reaching Stripe: ${location}`),
      ),
    ]);
    now += 121_000;
    const second = checkout("monthly", quantity);
    await setImmediate();
    release.resolve();
    const locations = await Promise.all([first, second]);
    assert.equal(
      payableSessions().length,
      1,
      "A slow create must not outlive its durable reservation",
    );
    assert.equal(locations[1], required(payableSessions()[0]).url);
    assert.equal(
      required(sessionParams.get(required(payableSessions()[0]).id)).line_items[0]?.quantity,
      quantity,
    );
  });
}

void test("authenticated retry recovers a lost Stripe create response after the old pending TTL", async () => {
  dropNextAcknowledgment = true;
  assert.equal(await checkout(), "/pricing?error=checkout");
  assert.equal(payableSessions().length, 1, "The provider accepted the first create");
  now += 121_000;
  const location = await checkout();
  assert.equal(
    payableSessions().length,
    1,
    "Unknown create outcomes must replay the original Stripe intent",
  );
  assert.equal(location, "https://checkout.stripe.test/cs_fixture_1");
});

for (const behavior of ["throw", "open"] as const) {
  void test(`authenticated changed selection fails closed when Stripe expiration ${behavior === "throw" ? "throws" : "is unconfirmed"}`, async () => {
    await successfulCheckout();
    expireBehavior = behavior;
    const location = await checkout("yearly");
    assert.equal(expireCalls, 1, "The old payable session must be reconciled");
    assert.equal(
      payableSessions().length,
      1,
      "An unexpired old checkout must prevent a replacement",
    );
    assert.equal(location, "/pricing?error=checkout");
    assert.equal(
      await checkout(),
      "https://checkout.stripe.test/cs_fixture_1",
      "Failed replacement must retain the old selection",
    );
  });
}

void test("authenticated retry blocks a completed checkout while its subscription remains active", async () => {
  const session = await successfulCheckout();
  session.status = "complete";
  session.customer = customerId;
  session.subscription = "sub_checkout_fixture";
  const location = await checkout("yearly");
  assert.equal(
    sessions.size,
    1,
    "A completed checkout must not start a second subscription before reconciliation",
  );
  assert.equal(location, "/pricing?error=checkout");
});

void test("authenticated checkout does not replay an unknown outcome beyond Stripe's idempotency window", async () => {
  dropNextAcknowledgment = true;
  assert.equal(await checkout(), "/pricing?error=checkout");
  assert.equal(sessions.size, 1);
  now += 24 * 60 * 60 * 1000 + 1;
  idempotentSessions.clear();
  const location = await checkout();
  assert.equal(createCalls, 1, "A pruned idempotency key must not be submitted again");
  assert.equal(location, "/pricing?error=checkout");
});

void test("checkout idempotency is stable under nested object property order but separates changed selections", () => {
  const first = {
    mode: "subscription",
    metadata: { userId: user.id, organizationId: organization.id },
    line_items: [{ price: "price_monthly", quantity: 1 }],
  };
  const reordered = {
    line_items: [{ quantity: 1, price: "price_monthly" }],
    metadata: { organizationId: organization.id, userId: user.id },
    mode: "subscription",
  };
  assert.notEqual(
    stripeProvider.subscriptionCheckoutIdempotencyKey("attempt", first),
    stripeProvider.subscriptionCheckoutIdempotencyKey("different-attempt", first),
  );
  assert.notEqual(
    stripeProvider.subscriptionCheckoutIdempotencyKey("attempt", first),
    stripeProvider.subscriptionCheckoutIdempotencyKey("attempt", {
      ...first,
      line_items: [{ price: "price_monthly", quantity: 2 }],
    }),
  );
  assert.equal(
    stripeProvider.subscriptionCheckoutIdempotencyKey("attempt", first),
    stripeProvider.subscriptionCheckoutIdempotencyKey("attempt", reordered),
  );
});

void test("catalog does not expose an unsupported recurring interval", async () => {
  assert.notEqual(await catalog.getActiveMembershipProduct("monthly"), null);
  required(products[0]).fields.billingInterval = "week";
  assert.equal(await catalog.getActiveMembershipProduct("monthly"), null);
});

const ambiguousCatalogCases: { name: string; mutate(): void }[] = [
  {
    name: "local price",
    mutate() {
      priceRows.push({ ...required(priceRows[0]), id: "second-local-price" });
    },
  },
  {
    name: "merchant product",
    mutate() {
      merchantProducts.push({
        ...required(merchantProducts[0]),
        id: "second-merchant-product",
        identifier: "prod_alternative",
      });
    },
  },
  {
    name: "merchant price",
    mutate() {
      merchantPrices.push({
        ...required(merchantPrices[0]),
        id: "second-merchant-price",
        identifier: "price_alternative",
      });
    },
  },
  {
    name: "Stripe merchant account",
    mutate() {
      merchantAccounts.push({
        ...required(merchantAccounts[0]),
        id: "second-merchant-account",
        identifier: "acct_alternative",
      });
    },
  },
  {
    name: "billing interval",
    mutate() {
      required(products[1]).fields.billingInterval = "month";
    },
  },
  {
    name: "native Stripe product",
    mutate() {
      required(merchantProducts[1])["identifier"] = required(merchantProducts[0])["identifier"];
    },
  },
];
for (const scenario of ambiguousCatalogCases) {
  void test(`direct catalog selection rejects ambiguous ${scenario.name} mappings`, async () => {
    assert.notEqual(await catalog.getActiveMembershipProduct("monthly"), null);
    scenario.mutate();
    await assert.rejects(
      () => catalog.getActiveMembershipProduct("monthly"),
      /Ambiguous membership/,
    );
  });
}

const mismatchedStripeCases: { name: string; mutate(): void }[] = [
  {
    name: "recurring interval",
    mutate() {
      required(stripePrices.get("price_monthly"))["recurring"] = {
        interval: "year",
        interval_count: 1,
        usage_type: "licensed",
      };
    },
  },
  {
    name: "native amount",
    mutate() {
      required(stripePrices.get("price_monthly"))["unit_amount"] = 1;
    },
  },
  {
    name: "native product",
    mutate() {
      required(stripePrices.get("price_monthly"))["product"] = "prod_wrong";
    },
  },
  {
    name: "live-mode price",
    mutate() {
      required(stripePrices.get("price_monthly"))["livemode"] = true;
    },
  },
];
for (const scenario of mismatchedStripeCases) {
  void test(`authenticated checkout rejects a mismatched ${scenario.name} before creating a payable session`, async () => {
    await successfulCheckout();
    resetStorage();
    scenario.mutate();
    const location = await checkout();
    assert.equal(createCalls, 0, "Stripe validation must precede session creation");
    assert.equal(location, "/pricing?error=checkout");
    assert.equal(sessions.size, 0);
  });
}

void test("generic provider checkout cannot bypass the authenticated durable reservation", async () => {
  const provider = stripeProvider.getStripeProvider();
  assert.ok(provider);
  await assert.rejects(
    () =>
      provider.createCheckoutSession(
        {
          productId: "monthly",
          quantity: 1,
          country: "US",
          userId: user.id,
          organizationId: organization.id,
          bulk: false,
          cancelUrl: "http://127.0.0.1:3008/pricing",
        },
        adapter,
      ),
    /reserved membership checkout/,
  );
  assert.equal(createCalls, 0);
  assert.equal(customerWrites, 0);
});

for (const quantity of [0, 1.5, 101]) {
  void test(`generic payment adapter rejects unreserved quantity ${quantity} without a payable session`, async () => {
    const provider = stripeProvider.getStripeProvider();
    assert.ok(provider);
    await assert.rejects(
      () =>
        provider.options.paymentsAdapter.createCheckoutSession({
          mode: "subscription",
          line_items: [{ price: "price_monthly", quantity }],
          metadata: { userId: user.id },
        }),
      /durable organization reservation/,
    );
    assert.equal(createCalls, 0);
    assert.equal(sessions.size, 0);
  });
}
