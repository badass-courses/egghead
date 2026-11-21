import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { reconcileBilling, type SubscriptionSnapshot, type SubscriptionState } from "../lifecycle";
import { EGGHEAD_STRIPE_CATALOGUE } from "../shadow/catalogue";
import { shadowDependencies } from "../shadow/configuration";
import {
  dispatchShadowEvent,
  handleShadowRequest,
  verifyShadowSignature,
  type ShadowDependencies,
} from "../shadow/handler";
import { SHADOW_STRIPE_EVENTS, type ShadowRecord } from "../shadow/projection";
import { regenerateCatalogue } from "../shadow/regenerate-catalogue";
import { replayShadowWindow } from "../shadow/replay";
import { MemoryShadowStore, createRedisShadowStore } from "../shadow/store";
import { createShadowStripeReader, type ShadowStripeReader } from "../shadow/stripe-reader";
import { isEggheadSubscription } from "../shadow/tenant";

const { databaseAccess } = vi.hoisted(() => ({
  databaseAccess: vi.fn(() => {
    throw new Error("Shadow touched an application database");
  }),
}));
vi.mock("../../db/adapter", () => ({
  getEggheadDatabase: databaseAccess,
  getCourseBuilderAdapter: databaseAccess,
}));
vi.mock("../../db/local-docker", () => ({ getEggheadMysqlPool: databaseAccess }));

const now = 2_000_000_000_000;
const end = now / 1000 + 3600;
const catalogue = { products: ["prod_synthetic_egghead"], prices: ["price_synthetic_egghead"] };
const subscription = (overrides: Record<string, unknown> = {}) => ({
  id: "sub_synthetic",
  customer: "cus_synthetic",
  status: "active",
  current_period_end: end,
  metadata: {},
  items: {
    data: [
      { quantity: 1, price: { id: "price_synthetic_egghead", product: "prod_synthetic_egghead" } },
    ],
  },
  ...overrides,
});
function event(
  type: string,
  object: Record<string, unknown> = subscription(),
  id = `evt_synthetic_${type}`,
) {
  return { id, type, created: now / 1000, data: { object } };
}
function signedRequest(
  header?: string,
  payload = JSON.stringify(event("customer.subscription.updated")),
) {
  return new Request("https://example.test/api/stripe/subscription-shadow", {
    method: "POST",
    headers: header ? { "stripe-signature": header } : {},
    body: payload,
  });
}
function requestUrl(input: RequestInfo | URL | undefined) {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  if (input instanceof Request) return new URL(input.url);
  throw new Error("Expected a fetch URL");
}
function setup(raw: unknown = subscription()) {
  const store = new MemoryShadowStore();
  const log = vi.fn<(record: ShadowRecord) => void>();
  const retrieve = vi.fn<ShadowStripeReader["retrieve"]>(async (resource) => {
    switch (resource) {
      case "subscriptions":
        return raw;
      case "customers":
        return { id: "cus_synthetic", metadata: {} };
      case "products":
        return { id: "prod_synthetic_egghead", metadata: { site: "egghead.io" } };
      case "charges":
        return { id: "ch_synthetic", customer: "cus_synthetic", invoice: "in_synthetic" };
      case "invoices":
        return { id: "in_synthetic", customer: "cus_synthetic", subscription: "sub_synthetic" };
      default:
        throw new Error("Unexpected synthetic Stripe resource");
    }
  });
  const stripe: ShadowStripeReader = {
    retrieve,
    subscriptions: async () => [raw],
    events: async function* () {
      yield event("customer.subscription.updated");
    },
  };
  const deps: ShadowDependencies = { store, stripe, catalogue, log };
  return { store, log, stripe, retrieve, deps };
}
async function recorded(
  type: string,
  raw = subscription(),
  payload: Record<string, unknown> = raw,
) {
  const context = setup(raw);
  const result = await dispatchShadowEvent(event(type, payload), context.deps, now);
  expect(result.status).toBe("recorded");
  const record = context.log.mock.calls[0]?.[0];
  if (!record) throw new Error("No record");
  return { ...context, record, projected: record.subscriptions[0] };
}

describe("isolated shadow projection", () => {
  it("projects a Rails event with zero customer-visible writes and no PII", async () => {
    const database = Object.freeze({ entitlements: Object.freeze([{ expiresAt: "untouched" }]) });
    const before = JSON.stringify(database);
    const { record, projected, deps, log } = await recorded(
      "customer.subscription.updated",
      subscription({ email: "must-not-log@example.test" }),
    );
    expect(projected).toMatchObject({
      status: "active",
      currentPeriodEnd: end,
      expiresAt: new Date(end * 1000).toISOString(),
      targetSourceType: "rails_account_subscription",
      accessVerdict: "grant",
      seats: 1,
    });
    expect(record.name).toBe("subscription.shadow.would-do");
    expect(JSON.stringify(record)).not.toContain("must-not-log");
    expect(JSON.stringify(database)).toBe(before);
    expect(databaseAccess).not.toHaveBeenCalled();
    expect(Object.keys(deps).toSorted()).toEqual(["catalogue", "log", "store", "stripe"]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("rejects other tenants, unknown and mixed products even with egghead customer metadata", async () => {
    await Promise.all(
      [
        [{ quantity: 1, price: { id: "price_other", product: "prod_other" } }],
        [
          {
            quantity: 1,
            price: { id: "price_synthetic_egghead", product: "prod_synthetic_egghead" },
          },
          { quantity: 1, price: { id: "price_other", product: "prod_other" } },
        ],
        [],
      ].map(async (items) => {
        const raw = subscription({ items: { data: items } });
        expect(isEggheadSubscription(raw, { site: "egghead.io" }, catalogue)).toBe(false);
        const { record } = await recorded("customer.subscription.updated", raw);
        expect(record).toMatchObject({
          name: "subscription.shadow.skipped",
          reason: "not-egghead",
          skippedSubscriptions: 1,
          subscriptions: [],
        });
      }),
    );
  });

  it("accepts either product or price and supports legacy plan ids", () => {
    expect(
      isEggheadSubscription(subscription(), {}, { products: catalogue.products, prices: [] }),
    ).toBe(true);
    expect(
      isEggheadSubscription(subscription(), {}, { products: [], prices: catalogue.prices }),
    ).toBe(true);
    expect(
      isEggheadSubscription(
        subscription({
          items: {
            data: [{ plan: { id: "legacy", product: "prod_synthetic_egghead" }, quantity: 1 }],
          },
        }),
        {},
        catalogue,
      ),
    ).toBe(true);
    expect(EGGHEAD_STRIPE_CATALOGUE.products).toHaveLength(26);
    expect(EGGHEAD_STRIPE_CATALOGUE.prices).toHaveLength(30);
  });

  it("alerts and skips a conflicting product metadata site", async () => {
    const { deps, retrieve, log } = setup();
    const original = retrieve.getMockImplementation();
    retrieve.mockImplementation(async (resource, id) =>
      resource === "products"
        ? { id, metadata: { site: "another-site.test" } }
        : original?.(resource, id),
    );
    await dispatchShadowEvent(event("customer.subscription.updated"), deps, now);
    expect(log.mock.calls[0]?.[0]).toMatchObject({
      name: "subscription.shadow.skipped",
      tenantMetadataConflicts: 1,
      subscriptions: [],
    });
  });

  it("leaves CB-owned behaviour alone and does not guess ownership for deleted customer tombstones", async () => {
    await Promise.all(
      [
        { id: "cus_synthetic", metadata: { egghead_owner: "cb", egghead_owner_timeline: "cb@0" } },
        { id: "cus_synthetic", deleted: true },
      ].map(async (customer) => {
        const { deps, retrieve, log } = setup();
        const original = retrieve.getMockImplementation();
        retrieve.mockImplementation(async (resource, id) =>
          resource === "customers" ? customer : original?.(resource, id),
        );
        await dispatchShadowEvent(event("customer.subscription.updated"), deps, now);
        expect(log.mock.calls[0]?.[0].subscriptions).toEqual([]);
      }),
    );
  });

  it("renewal advances the one expiresAt boundary", async () => {
    const older = await recorded("invoice.paid", subscription({ current_period_end: end - 1000 }), {
      id: "in_synthetic",
      subscription: "sub_synthetic",
    });
    const newer = await recorded("invoice.payment_succeeded", subscription(), {
      id: "in_synthetic",
      parent: { subscription_details: { subscription: "sub_synthetic" } },
    });
    expect(Date.parse(newer.projected?.expiresAt ?? "")).toBeGreaterThan(
      Date.parse(older.projected?.expiresAt ?? ""),
    );
    expect(newer.projected?.accessVerdict).toBe("grant");
  });

  it.each([
    "past_due",
    "trialing",
    "unpaid",
    "paused",
    "canceled",
    "incomplete",
    "incomplete_expired",
  ])("strict paid-through denies %s", async (status) => {
    const { projected } = await recorded("invoice.payment_failed", subscription({ status }), {
      id: "in_synthetic",
      subscription: "sub_synthetic",
    });
    expect(projected?.accessVerdict).toBe("deny");
  });

  it("cancel-at-period-end grants only before the boundary; equality and missing period deny", async () => {
    expect(
      (
        await recorded(
          "customer.subscription.updated",
          subscription({ cancel_at_period_end: true }),
        )
      ).projected,
    ).toMatchObject({ cancelAtPeriodEnd: true, accessVerdict: "grant" });
    await Promise.all(
      [now / 1000, now / 1000 - 1, null].map(async (current_period_end) => {
        expect(
          (await recorded("customer.subscription.updated", subscription({ current_period_end })))
            .projected?.accessVerdict,
        ).toBe("deny");
      }),
    );
  });

  it("deletion and customer deletion deny without deleting assignments or rows", async () => {
    expect(
      (await recorded("customer.subscription.deleted", subscription({ status: "canceled" })))
        .projected?.accessVerdict,
    ).toBe("deny");
    expect(
      (await recorded("customer.deleted", subscription(), { id: "cus_synthetic", metadata: {} }))
        .projected,
    ).toMatchObject({ status: "canceled", accessVerdict: "deny" });
  });

  it.each([
    "charge.refunded",
    ...SHADOW_STRIPE_EVENTS.filter((type) => type.startsWith("charge.dispute.")),
  ])("%s observes billing, never initiates refunds or revokes on its own", async (type) => {
    const { projected } = await recorded(type, subscription(), {
      id: "ch_synthetic",
      charge: "ch_synthetic",
    });
    expect(projected?.accessVerdict).toBe("grant");
  });

  it("skips another site's one-time checkout and charge without a would-do", async () => {
    const checkout = await recorded("checkout.session.completed", subscription(), {
      id: "cs_other",
      mode: "payment",
      subscription: null,
    });
    expect(checkout.record.subscriptions).toEqual([]);
    const { deps, retrieve, log } = setup();
    retrieve.mockResolvedValue({ id: "ch_other", customer: "cus_other", invoice: null });
    await dispatchShadowEvent(event("charge.refunded", { id: "ch_other" }), deps, now);
    expect(log.mock.calls[0]?.[0]).toMatchObject({
      name: "subscription.shadow.skipped",
      subscriptions: [],
    });
  });

  it("records a quantity change, explicitly leaving team roster eligibility unknown", async () => {
    const { deps, log } = setup(
      subscription({
        items: {
          data: [
            {
              quantity: 4,
              price: { id: "price_synthetic_egghead", product: "prod_synthetic_egghead" },
            },
          ],
        },
      }),
    );
    const input = event("customer.subscription.updated");
    await dispatchShadowEvent(
      {
        ...input,
        data: { ...input.data, previous_attributes: { items: { data: [{ quantity: 2 }] } } },
      },
      deps,
      now,
    );
    expect(log.mock.calls[0]?.[0].subscriptions[0]).toMatchObject({
      seats: 4,
      seatChange: { previous: 2, next: 4, delta: 2 },
      accessVerdict: "unknown-team-roster",
    });
  });

  it("covers every required event with a single record, including checkout", async () => {
    await Promise.all(
      SHADOW_STRIPE_EVENTS.map(async (type) => {
        const payload =
          type === "customer.deleted"
            ? { id: "cus_synthetic", metadata: {} }
            : type.startsWith("customer.subscription.")
              ? subscription()
              : type.startsWith("charge.")
                ? { id: "ch_synthetic", charge: "ch_synthetic" }
                : { id: "obj_synthetic", subscription: "sub_synthetic" };
        const { record, log } = await recorded(type, subscription(), payload);
        expect(record.subscriptions).toHaveLength(1);
        expect(log).toHaveBeenCalledTimes(1);
      }),
    );
  });
});

describe("event claims, retries and replay", () => {
  it("claims before Stripe reads; duplicates do not read or log twice", async () => {
    const { deps, store, retrieve, log } = setup();
    const input = event("customer.subscription.updated");
    await dispatchShadowEvent(input, deps, now);
    const reads = retrieve.mock.calls.length;
    expect(await dispatchShadowEvent(input, deps, now + 10)).toEqual({ status: "duplicate" });
    expect(retrieve).toHaveBeenCalledTimes(reads);
    expect(log).toHaveBeenCalledTimes(1);
    expect(store.records.size).toBe(1);
  });

  it("busy claims retry; a failed projection releases its own lease", async () => {
    const { deps, store, retrieve, log } = setup();
    const input = event("customer.subscription.updated");
    await store.claim(input.id, "other");
    await expect(dispatchShadowEvent(input, deps, now)).rejects.toThrow("retry");
    expect(retrieve).not.toHaveBeenCalled();
    await store.release(input.id, "wrong-token");
    expect(await store.claim(input.id, "third")).toBe("busy");
    await store.release(input.id, "other");
    retrieve.mockRejectedValueOnce(new Error("private response body must not log"));
    await expect(dispatchShadowEvent(input, deps, now)).rejects.toThrow();
    expect(log).not.toHaveBeenCalled();
    expect((await dispatchShadowEvent(input, deps, now)).status).toBe("recorded");
  });

  it("stale lease cannot complete or release another worker", async () => {
    const { store } = setup();
    await store.claim("evt", "old");
    await store.release("evt", "old");
    await store.claim("evt", "new");
    const { record } = await recorded("customer.subscription.created");
    expect(await store.complete("evt", "old", record)).toBe(false);
    await store.release("evt", "old");
    expect(await store.claim("evt", "third")).toBe("busy");
    expect(await store.complete("evt", "new", record)).toBe(true);
  });

  it("recovers a crashed worker after lease expiry and prevents a stale completion", async () => {
    let time = 0;
    const store = new MemoryShadowStore(() => time);
    const { record } = await recorded("customer.subscription.updated");
    expect(await store.claim(record.stripeEventId, "crashed")).toBe("claimed");
    time = 300_000;
    expect(await store.complete(record.stripeEventId, "crashed", record)).toBe(false);
    expect(await store.claim(record.stripeEventId, "replacement")).toBe("claimed");
    await store.release(record.stripeEventId, "crashed");
    expect(await store.complete(record.stripeEventId, "replacement", record)).toBe(true);
    time += 1_000_000;
    expect(await store.claim(record.stripeEventId, "duplicate")).toBe("complete");
  });

  it("replays the same claimed path, including out-of-order deliveries", async () => {
    const { deps, store, stripe, log } = setup();
    stripe.events = async function* (from, to) {
      expect([from, to]).toEqual([10, 20]);
      yield {
        ...event("invoice.paid", { id: "in_synthetic", subscription: "sub_synthetic" }, "newer"),
        created: 19,
      };
      yield {
        ...event("invoice.paid", { id: "in_synthetic", subscription: "sub_synthetic" }, "older"),
        created: 11,
      };
    };
    expect(await replayShadowWindow(10, 20, deps)).toEqual({
      recorded: 2,
      duplicate: 0,
      ignored: 0,
    });
    expect(await replayShadowWindow(10, 20, deps)).toEqual({
      recorded: 0,
      duplicate: 2,
      ignored: 0,
    });
    expect(store.records.size).toBe(2);
    expect(log).toHaveBeenCalledTimes(2);
    await expect(replayShadowWindow(20, 10, deps)).rejects.toThrow();
  });
});

describe("signed POST and isolation fences", () => {
  const secret = "synthetic-webhook-secret";
  const body = JSON.stringify(event("customer.subscription.updated"));
  const timestamp = now / 1000;
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  const signature = `t=${timestamp},v1=${digest}`;

  it("rejects missing, forged, tampered and stale signatures before configuration/any work", async () => {
    const configure = vi.fn(() => setup().deps);
    await Promise.all(
      [
        signedRequest(),
        signedRequest("invalid"),
        signedRequest(signature, `${body} `),
        signedRequest(`t=${timestamp - 301},v1=${digest}`),
      ].map(async (req) => {
        expect((await handleShadowRequest(req, secret, configure, now)).status).toBe(400);
      }),
    );
    expect(configure).not.toHaveBeenCalled();
    expect(
      verifyShadowSignature(
        body,
        `t=${timestamp},v1=${"a".repeat(64)},v1=${digest}`,
        secret,
        timestamp,
      ),
    ).toBe(true);
    expect(
      (await handleShadowRequest(signedRequest(signature), secret, () => setup().deps, now)).status,
    ).toBe(200);
    expect(
      (await handleShadowRequest(signedRequest(signature), undefined, configure, now)).status,
    ).toBe(503);
  });

  it("cold-imports the real route without shadow env and returns 503 without any IO", async () => {
    const shadowKeys = [
      "STRIPE_SHADOW_WEBHOOK_SECRET",
      "STRIPE_SHADOW_READ_KEY",
      "STRIPE_SHADOW_REDIS_REST_URL",
      "STRIPE_SHADOW_REDIS_REST_TOKEN",
    ];
    shadowKeys.forEach((key) => vi.stubEnv(key, undefined));
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("Unexpected shadow IO"));
    vi.stubGlobal("fetch", transport);
    vi.resetModules();
    try {
      const route = await import("../../app/api/stripe/subscription-shadow/route");
      // cacheComponents rejects route-segment runtime config, even the Node.js default.
      expect(route).not.toHaveProperty("runtime");
      expect(transport).not.toHaveBeenCalled();
      const response = await route.POST(signedRequest(signature));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ received: false, error: "shadow-not-configured" });
      expect(transport).not.toHaveBeenCalled();
      expect(databaseAccess).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("never falls back to application credentials or an in-memory production store", () => {
    expect(() =>
      shadowDependencies({ STRIPE_SECRET_KEY: "synthetic", DATABASE_URL: "synthetic" }),
    ).toThrow();
    expect(() =>
      shadowDependencies({
        STRIPE_SHADOW_READ_KEY: "sk_synthetic",
        STRIPE_SHADOW_REDIS_REST_URL: "https://example.test",
        STRIPE_SHADOW_REDIS_REST_TOKEN: "synthetic",
      }),
    ).toThrow();
    expect(() => createRedisShadowStore("http://example.test", "synthetic")).toThrow();
  });

  it("recursively fences route, replay and regeneration away from all DB/writer/mail clients", () => {
    const here = resolve(dirname(fileURLToPath(import.meta.url)), "../shadow");
    const visited = new Set<string>();
    const walk = (path: string) => {
      if (visited.has(path)) return;
      visited.add(path);
      const source = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const inspect = (node: ts.Node) => {
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
          throw new Error("Dynamic import in shadow graph");
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          const specifier = node.moduleSpecifier.text;
          expect(specifier).not.toMatch(
            /mysql|drizzle|\/db|inngest|coursebuilder|mailer|ownership-seam|stripe-billing/,
          );
          if (specifier.startsWith(".")) walk(resolve(dirname(path), `${specifier}.ts`));
          else expect(["zod", "node:crypto", "node:url"]).toContain(specifier);
        }
        ts.forEachChild(node, inspect);
      };
      inspect(source);
    };
    walk(resolve(here, "../../app/api/stripe/subscription-shadow/route.ts"));
    walk(resolve(here, "replay.ts"));
    walk(resolve(here, "regenerate-catalogue.ts"));
    expect(visited.size).toBeGreaterThan(10);
  });

  it("uses GET-only Stripe reads and paginates the exact replay window", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ id: "evt_page1" }], has_more: true }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: "evt_page2" }], has_more: false }))
      .mockResolvedValueOnce(Response.json({ id: "sub_synthetic" }));
    const reader = createShadowStripeReader("rk_synthetic", request);
    const events = [];
    for await (const item of reader.events(10, 20)) events.push(item);
    await reader.retrieve("subscriptions", "sub_synthetic");
    expect(events).toHaveLength(2);
    for (const [url, init] of request.mock.calls) {
      expect(init?.method).toBe("GET");
      expect(requestUrl(url).href).toMatch(/^https:\/\/api.stripe.com\/v1\//);
    }
    const first = requestUrl(request.mock.calls[0]?.[0]);
    expect(first.searchParams.get("created[gte]")).toBe("10");
    expect(first.searchParams.get("created[lt]")).toBe("20");
    expect(requestUrl(request.mock.calls[1]?.[0]).searchParams.get("starting_after")).toBe(
      "evt_page1",
    );
  });

  it("regenerates only corroborated product and price IDs, without customer rows", async () => {
    const { stripe } = setup();
    const output = await regenerateCatalogue(stripe);
    expect(output).toEqual(catalogue);
    expect(JSON.stringify(output)).not.toMatch(/cus_|sub_/);
  });

  it("Redis adapter uses atomic Lua claims/completion and refuses transport errors", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ result: "claimed" }))
      .mockResolvedValueOnce(Response.json({ result: 1 }))
      .mockResolvedValueOnce(Response.json({ result: 0 }));
    const store = createRedisShadowStore("https://example.test", "synthetic", request);
    const { record } = await recorded("customer.subscription.updated");
    expect(await store.claim(record.stripeEventId, "token")).toBe("claimed");
    expect(await store.complete(record.stripeEventId, "token", record)).toBe(true);
    await store.release(record.stripeEventId, "token");
    for (const [, init] of request.mock.calls) {
      const payload = init?.body;
      if (typeof payload !== "string") throw new Error("Expected a Redis JSON command");
      expect(JSON.parse(payload)[0]).toBe("EVAL");
    }
    request.mockResolvedValueOnce(Response.json({ error: "private response" }));
    await expect(store.claim("evt", "token")).rejects.toThrow();
  });
});

describe("#2.4 fresh observation ordering", () => {
  const state: SubscriptionState = {
    ownerId: "synthetic-owner",
    kind: "individual",
    seats: 1,
    status: "active",
    currentPeriodEnd: end,
    assignments: [],
    reduction: null,
    revision: { id: "evt_newer", createdAt: 20, observedAt: 100, kind: "subscription_update" },
  };
  const snapshot: SubscriptionSnapshot = {
    stripeSubscriptionId: "sub_synthetic",
    status: "past_due",
    seats: 1,
    currentPeriodEnd: end,
    event: { id: "evt_older", createdAt: 10, observedAt: 200, kind: "subscription_update" },
  };
  it("accepts a later observedAt, preserves max createdAt, and dedupes the event id", () => {
    const result = reconcileBilling(state, snapshot);
    expect(result.status).toBe("applied");
    expect(result.state.status).toBe("past_due");
    expect(result.state.revision).toEqual({ ...snapshot.event, createdAt: 20 });
    expect(
      reconcileBilling(result.state, { ...snapshot, event: { ...snapshot.event, observedAt: 300 } })
        .status,
    ).toBe("unchanged");
    expect(
      reconcileBilling(result.state, {
        ...snapshot,
        event: { ...snapshot.event, id: "evt_stale", createdAt: 30, observedAt: 150 },
      }).status,
    ).toBe("unchanged");
  });
});
