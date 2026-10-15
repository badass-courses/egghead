import { assert, describe, it } from "@effect/vitest";
import { beforeAll, beforeEach, vi } from "vitest";
import * as Effect from "effect/Effect";
import mysql from "mysql2/promise";
import { WorkshopCatalog } from "@egghead/workshops/catalog";
import {
  getWorkshop,
  listUpcomingWorkshops,
  listWorkshopReferences,
} from "@egghead/workshops/capabilities";
import { InvalidWorkshopData } from "@egghead/workshops/contracts";
import * as TestClock from "effect/testing/TestClock";
import { mysqlWorkshopCatalog } from "../src/mysql";

const options = {
  host: "127.0.0.1",
  port: 13319,
  user: "root",
  password: "root",
  database: "egghead_workshop_test",
};
const connections: Array<{ statements: () => number; endCalls: () => number }> = [];
const now = Date.parse("2026-01-15T12:00:00.000Z");
const layer = mysqlWorkshopCatalog(async () => {
  const connection = await mysql.createConnection(options);
  const execute = vi.spyOn(connection, "execute");
  const query = vi.spyOn(connection, "query");
  const end = vi.spyOn(connection, "end");
  connections.push({
    statements: () => execute.mock.calls.length + query.mock.calls.length,
    endCalls: () => end.mock.calls.length,
  });
  return connection;
});
const countStatements = () =>
  connections.reduce((total, connection) => total + connection.statements(), 0);
function assertReleased() {
  assert.isAbove(connections.length, 0);
  for (const connection of connections) assert.strictEqual(connection.endCalls(), 1);
}

beforeAll(async () => {
  const db = await mysql.createConnection(options);
  try {
    await Promise.all(
      [
        "ContentResourceProduct",
        "Purchase",
        "Price",
        "Product",
        "Coupon",
        "MerchantCoupon",
        "ContentResource",
      ].map((table) => db.query(`DROP TABLE IF EXISTS egghead_${table}`)),
    );
    await db.query(
      `CREATE TABLE egghead_ContentResource (id varchar(191) PRIMARY KEY, type varchar(191), fields JSON, slug varchar(191), updatedAt datetime(3), createdAt datetime(3), deletedAt datetime(3))`,
    );
    await db.query(
      `CREATE TABLE egghead_ContentResourceProduct (resourceId varchar(191), productId varchar(191), position int, deletedAt datetime(3), INDEX (resourceId))`,
    );
    await db.query(
      `CREATE TABLE egghead_Product (id varchar(191) PRIMARY KEY, name varchar(191), quantityAvailable int, status int)`,
    );
    await db.query(
      `CREATE TABLE egghead_Price (id varchar(191) PRIMARY KEY, productId varchar(191), unitAmount decimal(10,2), status int, createdAt datetime(3), INDEX(productId))`,
    );
    await db.query(
      `CREATE TABLE egghead_Purchase (id varchar(191) PRIMARY KEY, productId varchar(191), status varchar(191), INDEX(productId,status))`,
    );
    await db.query(
      `CREATE TABLE egghead_MerchantCoupon (id varchar(191) PRIMARY KEY, status int, percentageDiscount decimal(10,2), amountDiscount int)`,
    );
    await db.query(
      `CREATE TABLE egghead_Coupon (id varchar(191) PRIMARY KEY, restrictedToProductId varchar(191), \`default\` boolean, expires datetime(3), fields JSON, percentageDiscount decimal(10,2), amountDiscount int, merchantCouponId varchar(191), status int, maxUses int, usedCount int, createdAt datetime(3), INDEX(restrictedToProductId))`,
    );
    const eventFixtures = [
      ["public-a", "published", "public", "public"],
      ["public-b", "published", "public", "public"],
      ["unlisted", "published", "unlisted", "public"],
      ["unlisted-state", "published", "public", "unlisted"],
      ["draft", "draft", "public", "public"],
      ["private", "published", "private", "public"],
      ["past", "published", "public", "public"],
      ["malformed", "published", "public", "public"],
    ] satisfies Array<[string, string, string, string]>;
    const eventValues = eventFixtures.flatMap(([id, state, visibility, visibilityState]) => {
      const fields = {
        title: id,
        slug: id,
        state,
        visibility,
        visibilityState,
        startsAt: id === "past" ? "2026-01-14T12:00:00.000Z" : "2026-01-16T12:00:00.000Z",
        endsAt: null,
        registrationUrl: "https://example.com/register",
      };
      return [id, id === "malformed" ? '"bad fields"' : JSON.stringify(fields), id];
    });
    await db.execute(
      `INSERT INTO egghead_ContentResource (id,type,fields,slug,updatedAt,createdAt) VALUES ${eventFixtures.map(() => "(?, 'event', ?, ?, '2026-01-01', '2026-01-01')").join(", ")}`,
      eventValues,
    );
    await db.query(`INSERT INTO egghead_Product VALUES ('product','Workshop',2,1)`);
    await db.query(`INSERT INTO egghead_Price VALUES ('price','product',100,1,'2026-01-01')`);
    await db.query(
      `INSERT INTO egghead_ContentResourceProduct VALUES ('public-a','product',0,NULL)`,
    );
    await db.query(`INSERT INTO egghead_Purchase VALUES ('purchase','product','Valid')`);
    const couponFixtures = [
      ["malformed-condition", { eligibilityCondition: {} }, null, -1, 0],
      [
        "conditional",
        {
          eligibilityCondition: { type: "hasValidProductPurchase", productId: "unrelated-product" },
        },
        null,
        -1,
        0,
      ],
      ["inactive-merchant", {}, "inactive", -1, 0],
      ["exhausted", {}, null, 1, 1],
      ["sale", {}, null, -1, 0],
    ] satisfies Array<[string, Record<string, unknown>, string | null, number, number]>;
    const couponValues = couponFixtures.flatMap(([id, fields, merchant, maxUses, usedCount]) => [
      id,
      JSON.stringify(fields),
      id === "exhausted"
        ? 0.95
        : id === "inactive-merchant"
          ? 0.9
          : id === "malformed-condition"
            ? 0.8
            : 0.2,
      merchant,
      maxUses,
      usedCount,
    ]);
    await db.execute(
      `INSERT INTO egghead_Coupon VALUES ${couponFixtures.map(() => "(?, 'product', true, '2026-01-15 12:01:00', ?, ?, NULL, ?, 1, ?, ?, '2026-01-01')").join(", ")}`,
      couponValues,
    );
    await db.query(`INSERT INTO egghead_MerchantCoupon VALUES ('inactive',0,0.9,NULL)`);
  } finally {
    await db.end();
  }
});
beforeEach(() => {
  connections.length = 0;
});

describe("native MySQL workshop adapter", () => {
  it.effect("decodes real rows, rejects unrelated member claims, and releases the connection", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const workshop = yield* getWorkshop({ slug: "public-a" }).pipe(Effect.provide(layer));
      assert.strictEqual(workshop?.offer?.currentPrice, 80);
      assert.deepStrictEqual(workshop?.offer?.conditionalOffer, {
        price: 80,
        requiresProductId: "unrelated-product",
      });
      assert.strictEqual(workshop?.offer?.seatsRemaining, 1);
      assert.strictEqual(countStatements(), 4);
      assertReleased();
      yield* TestClock.adjust(60_000);
      assert.strictEqual(
        (yield* getWorkshop({ slug: "public-a" }).pipe(Effect.provide(layer)))?.offer?.currentPrice,
        100,
      );
    }),
  );
  it.effect(
    "uses the same visibility policy for index and sitemap, with linkable unlisted events",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        assert.strictEqual(
          (yield* getWorkshop({ slug: "unlisted" }).pipe(Effect.provide(layer)))?.visibility,
          "unlisted",
        );
        assert.strictEqual(
          (yield* getWorkshop({ slug: "unlisted-state" }).pipe(Effect.provide(layer)))?.visibility,
          "unlisted",
        );
        assert.strictEqual(yield* getWorkshop({ slug: "draft" }).pipe(Effect.provide(layer)), null);
        assert.strictEqual(
          yield* getWorkshop({ slug: "private" }).pipe(Effect.provide(layer)),
          null,
        );
        const page = yield* listUpcomingWorkshops({ limit: 1 }).pipe(Effect.provide(layer));
        assert.deepStrictEqual(
          page.workshops.map((workshop) => workshop.slug),
          ["public-a"],
        );
        const next = yield* listUpcomingWorkshops({
          limit: 1,
          ...(page.next ? { after: page.next } : {}),
        }).pipe(Effect.provide(layer));
        assert.deepStrictEqual(
          next.workshops.map((workshop) => workshop.slug),
          ["public-b"],
        );
        const references = yield* listWorkshopReferences().pipe(Effect.provide(layer));
        assert.deepStrictEqual(
          references.map((reference) => reference.slug),
          ["malformed", "past", "public-a", "public-b"],
        );
        assertReleased();
      }),
  );
  it.effect("malformed event fields fail explicitly and still release the connection", () =>
    Effect.gen(function* () {
      const failure = yield* getWorkshop({ slug: "malformed" }).pipe(
        Effect.provide(layer),
        Effect.flip,
      );
      assert.instanceOf(failure, InvalidWorkshopData);
      assertReleased();
    }),
  );
  it.effect("read budgets do not grow with the number of workshops in a page", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      yield* listUpcomingWorkshops({ limit: 1 }).pipe(Effect.provide(layer));
      const one = countStatements();
      connections.length = 0;
      const catalog = yield* WorkshopCatalog.pipe(Effect.provide(layer));
      const page = yield* catalog.listUpcoming({
        now: "2026-01-15T12:00:00.000Z",
        limit: 2,
        after: null,
      });
      assert.strictEqual(page.workshops.length, 2);
      assert.strictEqual(countStatements(), one);
      assert.strictEqual(one, 4);
      assertReleased();
    }),
  );
  it.effect("reads JSON-only slugs when the native slug column is absent", () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(() => mysql.createConnection(options));
      yield* Effect.promise(() => db.query("ALTER TABLE egghead_ContentResource DROP COLUMN slug"));
      yield* Effect.promise(() => db.end());
      const workshop = yield* getWorkshop({ slug: "public-a" }).pipe(Effect.provide(layer));
      assert.strictEqual(workshop?.slug, "public-a");
      assertReleased();
    }),
  );
});
