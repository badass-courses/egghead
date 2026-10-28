import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { WorkshopCatalog } from "../src/catalog";
import {
  getWorkshop,
  listUpcomingWorkshops,
  listWorkshopReferences,
  capabilities,
} from "../src/capabilities";
import {
  CatalogUnavailable,
  InvalidWorkshopInput,
  GetWorkshopInput,
  Workshop,
  type OfferSnapshot,
  type WorkshopSnapshot,
} from "../src/contracts";
import { memoryWorkshopCatalog } from "../src/memory";
import { evaluateOffer, evaluateWorkshop, registrationState } from "../src/policy";

const now = Date.parse("2026-01-15T12:00:00.000Z");
const offer: OfferSnapshot = {
  fullPrice: 100,
  productId: "synthetic-workshop-product",
  productName: "Synthetic workshop",
  seatsRemaining: 2,
  coupons: [
    {
      audience: { type: "public" },
      isDefault: true,
      expiresAt: "2026-01-15T12:01:00.000Z",
      percentage: 0.2,
      amount: null,
    },
  ],
};
const snapshot: WorkshopSnapshot = {
  id: "synthetic-event",
  slug: "synthetic-workshop",
  title: "Synthetic workshop",
  description: "Test workshop",
  body: null,
  imageUrl: null,
  registrationUrl: "https://example.com/register",
  ctaLabel: "Register",
  timezone: "UTC",
  startsAt: "2026-01-15T12:02:00.000Z",
  endsAt: "2026-01-15T13:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  visibility: "public",
  offer,
};

describe("workshop capability behavior", () => {
  it.effect("reused source snapshots change at coupon expiry, start, and end", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const layer = memoryWorkshopCatalog([snapshot]);
      const read = getWorkshop({ slug: snapshot.slug }).pipe(Effect.provide(layer));
      const before = yield* read;
      assert.strictEqual(before?.offer?.currentPrice, 80);
      assert.strictEqual(before?.registration.type, "open");
      yield* TestClock.adjust(60_000);
      const expired = yield* read;
      assert.strictEqual(expired?.offer?.currentPrice, 100);
      assert.strictEqual(expired?.offer?.discountPercent, null);
      yield* TestClock.adjust(60_000);
      assert.strictEqual((yield* read)?.registration.type, "closed");
      assert.strictEqual((yield* read)?.status, "in-progress");
      yield* TestClock.adjust(58 * 60_000);
      assert.strictEqual((yield* read)?.status, "past");
    }),
  );

  it.effect("unlisted workshops remain linkable and never enter discovery", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const layer = memoryWorkshopCatalog([
        { ...snapshot, visibility: "unlisted" },
        { ...snapshot, id: "public", slug: "public" },
      ]);
      const detail = yield* getWorkshop({ slug: snapshot.slug }).pipe(Effect.provide(layer));
      assert.strictEqual(detail?.id, snapshot.id);
      const page = yield* listUpcomingWorkshops({}).pipe(Effect.provide(layer));
      assert.deepStrictEqual(
        page.workshops.map((workshop) => workshop.id),
        ["public"],
      );
      const sitemap = yield* listWorkshopReferences().pipe(Effect.provide(layer));
      assert.deepStrictEqual(
        sitemap.map((workshop) => workshop.id),
        ["public"],
      );
    }),
  );

  it.effect("missing workshops and storage failures remain different outcomes", () =>
    Effect.gen(function* () {
      const absent = yield* getWorkshop({ slug: "missing" }).pipe(
        Effect.provide(memoryWorkshopCatalog([])),
      );
      assert.strictEqual(absent, null);
      const layer = Layer.succeed(WorkshopCatalog, {
        get: () => Effect.fail(new CatalogUnavailable({ operation: "read" })),
        listUpcoming: () => Effect.fail(new CatalogUnavailable({ operation: "read" })),
        listDiscoverable: () => Effect.fail(new CatalogUnavailable({ operation: "read" })),
      });
      const failure = yield* getWorkshop({ slug: snapshot.slug }).pipe(
        Effect.provide(layer),
        Effect.flip,
      );
      assert.instanceOf(failure, CatalogUnavailable);
    }),
  );

  it.effect("invalid capability input is rejected before storage", () =>
    Effect.gen(function* () {
      const failure = yield* getWorkshop({ slug: "" }).pipe(
        Effect.provide(memoryWorkshopCatalog([])),
        Effect.flip,
      );
      assert.instanceOf(failure, InvalidWorkshopInput);
      const pageFailure = yield* listUpcomingWorkshops({ limit: 101 }).pipe(
        Effect.provide(memoryWorkshopCatalog([])),
        Effect.flip,
      );
      assert.instanceOf(pageFailure, InvalidWorkshopInput);
      assert.isTrue(Option.isNone(Schema.decodeUnknownOption(GetWorkshopInput)({ slug: 42 })));
    }),
  );

  it.effect("a broken adapter is a defect rather than workshop absence", () =>
    Effect.gen(function* () {
      const layer = Layer.succeed(WorkshopCatalog, {
        get: () => Effect.die("synthetic defect"),
        listUpcoming: () => Effect.succeed({ workshops: [], next: null }),
        listDiscoverable: () => Effect.succeed({ workshops: [], next: null }),
      });
      const exit = yield* getWorkshop({ slug: snapshot.slug }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      assert.isTrue(Exit.hasDies(exit));
    }),
  );

  it.effect("keyset pages keep tied start times without duplicates", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const layer = memoryWorkshopCatalog(
        ["a", "b", "c"].map((id) => Object.assign({}, snapshot, { id, slug: id })),
      );
      const first = yield* listUpcomingWorkshops({ limit: 2 }).pipe(Effect.provide(layer));
      assert.deepStrictEqual(
        first.workshops.map((workshop) => workshop.id),
        ["a", "b"],
      );
      assert.isNotNull(first.next);
      const second = yield* listUpcomingWorkshops({
        limit: 2,
        ...(first.next ? { after: first.next } : {}),
      }).pipe(Effect.provide(layer));
      assert.deepStrictEqual(
        second.workshops.map((workshop) => workshop.id),
        ["c"],
      );
      assert.strictEqual(second.next, null);
    }),
  );

  it.effect("sitemap references cross page boundaries without missing or repeating events", () =>
    Effect.gen(function* () {
      const snapshots = Array.from({ length: 101 }, (_, index) =>
        Object.assign({}, snapshot, {
          id: `synthetic-${String(index).padStart(3, "0")}`,
          slug: `synthetic-${index}`,
        }),
      );
      const references = yield* listWorkshopReferences().pipe(
        Effect.provide(memoryWorkshopCatalog(snapshots)),
      );
      assert.strictEqual(references.length, 101);
      assert.strictEqual(new Set(references.map((reference) => reference.id)).size, 101);
      assert.strictEqual(references.at(-1)?.id, "synthetic-100");
    }),
  );

  it.effect("catalog replacement preserves validated capability output", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const workshop = yield* getWorkshop({ slug: snapshot.slug }).pipe(
        Effect.provide(memoryWorkshopCatalog([snapshot])),
      );
      const encoded = yield* Schema.encodeEffect(Schema.NullOr(Workshop))(workshop);
      const decoded = yield* Schema.decodeUnknownEffect(Schema.NullOr(Workshop))(encoded);
      assert.deepStrictEqual(decoded, workshop);
      assert.deepStrictEqual(
        capabilities.map((capability) => [
          capability.contract.name,
          capability.contract.annotations.readOnly,
          capability.contract.needsApproval,
        ]),
        [
          ["getWorkshop", true, false],
          ["listUpcomingWorkshops", true, false],
        ],
      );
    }),
  );
});

describe("pure workshop rules", () => {
  it("conditional product purchases are preserved without claiming membership", () => {
    const conditional = evaluateOffer(
      {
        ...offer,
        coupons: [
          {
            ...offer.coupons[0],
            audience: { type: "product-purchase", productId: "unrelated-product" },
            isDefault: true,
            expiresAt: null,
            percentage: 0.2,
            amount: null,
          },
        ],
      },
      new Date(now),
    );
    assert.strictEqual(conditional.currentPrice, 100);
    assert.deepStrictEqual(conditional.conditionalOffer, {
      price: 80,
      requiresProductId: "unrelated-product",
    });
    assert.isFalse(Object.hasOwn(conditional, "memberPrice"));
  });
  it("unsupported eligibility is never a public discount", () => {
    const result = evaluateOffer(
      {
        ...offer,
        coupons: [
          {
            audience: { type: "unsupported" },
            isDefault: true,
            expiresAt: null,
            percentage: 0.2,
            amount: null,
          },
        ],
      },
      new Date(now),
    );
    assert.strictEqual(result.currentPrice, 100);
    assert.strictEqual(result.conditionalOffer, null);
  });
  it("missing prices remain pending while explicit zero prices remain free", () => {
    assert.strictEqual(evaluateWorkshop({ ...snapshot, offer: null }, new Date(now)).offer, null);
    assert.strictEqual(evaluateOffer({ ...offer, fullPrice: 0 }, new Date(now)).currentPrice, 0);
  });
  it("registration preserves sold-out, live, and schedule-pending outcomes", () => {
    const soldOut = evaluateOffer({ ...offer, seatsRemaining: 0 }, new Date(now));
    assert.deepStrictEqual(
      registrationState("upcoming", soldOut, snapshot.registrationUrl, "Register"),
      { type: "sold-out" },
    );
    assert.deepStrictEqual(
      registrationState("in-progress", null, snapshot.registrationUrl, "Register"),
      { type: "closed" },
    );
    assert.deepStrictEqual(
      registrationState("schedule-pending", null, snapshot.registrationUrl, "Register"),
      { type: "pending" },
    );
  });
  it.prop(
    "discounted prices stay between zero and the full price",
    [
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100000 })),
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
    ],
    ([price, percent]) => {
      const result = evaluateOffer(
        {
          ...offer,
          fullPrice: price,
          coupons: [
            {
              audience: { type: "public" },
              isDefault: true,
              expiresAt: null,
              percentage: percent / 100,
              amount: null,
            },
          ],
        },
        new Date(now),
      );
      assert.isAtLeast(result.currentPrice, 0);
      assert.isAtMost(result.currentPrice, price);
    },
  );
});
