import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Mysql from "mysql2/promise";
import { WorkshopCatalog, type UpcomingQuery } from "@egghead/workshops/catalog";
import {
  CatalogUnavailable,
  InvalidWorkshopData,
  CouponSnapshot,
  WorkshopSnapshot,
  WorkshopReference,
  WorkshopPageLimit,
  type OfferSnapshot,
} from "@egghead/workshops/contracts";
import {
  WorkshopFields as Fields,
  descriptionField,
  objectField,
  stringField,
  type JsonFields,
} from "./fields";
import { decodeCouponRow, type CouponData } from "./coupon";

// Infer the promise connection from the factory: mysql2 also re-exports the callback Connection.
type Connection = Awaited<ReturnType<typeof Mysql.createConnection>>;
type RowDataPacket = Mysql.RowDataPacket;

const PAGE_SIZE = 100;
const FANOUT_LIMIT = 1000;
type EventRow = RowDataPacket & {
  id: string;
  fields: unknown;
  slug: string;
  updatedAt: Date | string;
};
type OfferRow = RowDataPacket & {
  productId: string;
  productName: string;
  resourceId: string;
  unitAmount: number | string | null;
  quantityAvailable: number | string;
  purchaseCount: number | string;
};
type CouponRow = RowDataPacket & CouponData;

function isoDate(value: Date | string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function publicUrl(value: string | null) {
  if (!value || !URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
}
function placeholders(values: readonly string[]) {
  return values.map(() => "?").join(", ");
}
const startsSql = "NULLIF(JSON_UNQUOTE(JSON_EXTRACT(event.fields, '$.startsAt')), 'null')";
const endsSql = "NULLIF(JSON_UNQUOTE(JSON_EXTRACT(event.fields, '$.endsAt')), 'null')";

function workshopVisibilitySql(discoverable: boolean) {
  const allowed = discoverable ? "'public'" : "'public', 'unlisted'";
  return `
    AND LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(event.fields, '$.state')), 'published')) = 'published'
    AND LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(event.fields, '$.visibility')), 'public')) IN (${allowed})
    AND LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(event.fields, '$.visibilityState')), 'public')) IN (${allowed})
  `;
}

async function loadOffers(connection: Connection, resourceIds: string[]) {
  const offers = new Map<string, OfferSnapshot>();
  if (resourceIds.length === 0) return offers;
  const [offerRows] = await connection.execute<OfferRow[]>(
    `
    SELECT link.resourceId, product.id AS productId, product.name AS productName,
      product.quantityAvailable, price.unitAmount,
      (SELECT COUNT(*) FROM egghead_Purchase purchase WHERE purchase.productId = product.id
        AND purchase.status IN ('Valid', 'Restricted')) AS purchaseCount
    FROM egghead_ContentResourceProduct link
    JOIN egghead_Product product ON product.id = link.productId AND product.status = 1
    LEFT JOIN egghead_Price price ON price.productId = product.id AND price.status = 1
    WHERE link.deletedAt IS NULL AND link.resourceId IN (${placeholders(resourceIds)})
    ORDER BY link.position ASC, price.createdAt DESC, product.id ASC
    LIMIT ${FANOUT_LIMIT + 1}
  `,
    resourceIds,
  );
  if (offerRows.length > FANOUT_LIMIT)
    throw new RangeError("Workshop offer fan-out exceeds the read budget");
  const productIds = [...new Set(offerRows.map((row) => row.productId))];
  const couponsByProduct = new Map<string, Array<typeof CouponSnapshot.Type>>();
  if (productIds.length > 0) {
    const [couponRows] = await connection.execute<CouponRow[]>(
      `
      SELECT coupon.restrictedToProductId AS productId, coupon.default, DATE_FORMAT(coupon.expires, '%Y-%m-%dT%H:%i:%s.%fZ') AS expires,
        coupon.fields AS couponFields, coupon.percentageDiscount, coupon.amountDiscount,
        merchant.percentageDiscount AS merchantPercentageDiscount, merchant.amountDiscount AS merchantAmountDiscount
      FROM egghead_Coupon coupon
      LEFT JOIN egghead_MerchantCoupon merchant ON merchant.id = coupon.merchantCouponId AND merchant.status = 1
      WHERE coupon.restrictedToProductId IN (${placeholders(productIds)}) AND coupon.status = 1
        AND (coupon.merchantCouponId IS NULL OR merchant.id IS NOT NULL)
        AND (coupon.maxUses = -1 OR coupon.usedCount < coupon.maxUses)
      ORDER BY coupon.default DESC, coupon.createdAt DESC, coupon.id ASC
      LIMIT ${FANOUT_LIMIT + 1}
    `,
      productIds,
    );
    if (couponRows.length > FANOUT_LIMIT)
      throw new RangeError("Workshop coupon fan-out exceeds the read budget");
    for (const row of couponRows) {
      const coupon = decodeCouponRow(row);
      if (coupon) {
        const existing = couponsByProduct.get(row.productId) ?? [];
        existing.push(coupon);
        couponsByProduct.set(row.productId, existing);
      }
    }
  }
  for (const row of offerRows) {
    if (offers.has(row.resourceId) || row.unitAmount === null) continue;
    const quantity = Number(row.quantityAvailable);
    offers.set(row.resourceId, {
      fullPrice: Number(row.unitAmount),
      productId: row.productId,
      productName: row.productName,
      seatsRemaining: quantity < 0 ? null : Math.max(0, quantity - Number(row.purchaseCount)),
      coupons: couponsByProduct.get(row.productId) ?? [],
    });
  }
  return offers;
}

const decodeSnapshot = Effect.fn("decodeWorkshopSnapshot")(function* (
  row: EventRow,
  offer: OfferSnapshot | null,
) {
  const fields: JsonFields = yield* Schema.decodeUnknownEffect(Fields)(row.fields).pipe(
    Effect.mapError(() => new InvalidWorkshopData({ operation: "decode event fields" })),
  );
  const socialImage = objectField(fields, "socialImage");
  const visibility = stringField(fields, "visibility")?.toLowerCase() ?? "public";
  const visibilityState = stringField(fields, "visibilityState")?.toLowerCase() ?? "public";
  return yield* Schema.decodeUnknownEffect(WorkshopSnapshot)({
    id: row.id,
    slug: row.slug,
    updatedAt: isoDate(row.updatedAt),
    title: stringField(fields, "title") ?? "Untitled workshop",
    description: descriptionField(fields),
    body: stringField(fields, "body") ?? stringField(fields, "markdown"),
    imageUrl: publicUrl(
      stringField(fields, "image") ??
        stringField(fields, "imageUrl") ??
        (socialImage ? stringField(socialImage, "url") : null),
    ),
    registrationUrl: publicUrl(stringField(fields, "registrationUrl")),
    ctaLabel: stringField(fields, "ctaLabel") ?? "Register for the workshop",
    timezone: stringField(fields, "timezone") ?? "America/Los_Angeles",
    startsAt: isoDate(stringField(fields, "startsAt")),
    endsAt: isoDate(stringField(fields, "endsAt")),
    visibility:
      visibility === "unlisted" || visibilityState === "unlisted" ? "unlisted" : visibility,
    offer,
  }).pipe(Effect.mapError(() => new InvalidWorkshopData({ operation: "decode workshop" })));
});

export function mysqlWorkshopCatalog(openConnection: () => Promise<Connection>) {
  const connectionResource = Effect.acquireRelease(
    Effect.tryPromise({
      try: openConnection,
      catch: () => new CatalogUnavailable({ operation: "connect" }),
    }),
    (connection) =>
      Effect.tryPromise({
        try: () => connection.end(),
        catch: () => new CatalogUnavailable({ operation: "disconnect" }),
      }).pipe(Effect.orDie),
  );
  const slugSql = Effect.fn("workshopSlugSql")(function* (connection: Connection) {
    const [columns] = yield* Effect.tryPromise({
      try: () =>
        connection.query<RowDataPacket[]>("SHOW COLUMNS FROM egghead_ContentResource LIKE 'slug'"),
      catch: () => new CatalogUnavailable({ operation: "read schema" }),
    });
    return columns.length > 0 ? "event.slug" : "JSON_UNQUOTE(JSON_EXTRACT(event.fields, '$.slug'))";
  });
  const read = Effect.fn("readWorkshopSnapshots")(function* (
    query: { slug: string } | UpcomingQuery,
  ) {
    const db = yield* connectionResource;
    const slug = yield* slugSql(db);
    const isDetail = "slug" in query;
    const after = !isDetail ? query.after : null;
    const limit = isDetail
      ? 1
      : yield* Schema.decodeUnknownEffect(WorkshopPageLimit)(query.limit).pipe(
          Effect.mapError(() => new InvalidWorkshopData({ operation: "page limit" })),
        );
    const [rows] = yield* Effect.tryPromise({
      try: () =>
        db.execute<EventRow[]>(
          `
        SELECT event.id, event.fields, ${slug} AS slug, DATE_FORMAT(event.updatedAt, '%Y-%m-%dT%H:%i:%s.%fZ') AS updatedAt
        FROM egghead_ContentResource event
        WHERE event.deletedAt IS NULL AND event.type = 'event'
          ${workshopVisibilitySql(!isDetail)} AND ${slug} IS NOT NULL AND ${slug} != ''
          ${isDetail ? `AND ${slug} = ?` : `AND ${startsSql} IS NOT NULL AND COALESCE(${endsSql}, ${startsSql}) > ?`}
          ${after ? `AND (${startsSql} > ? OR (${startsSql} = ? AND event.id > ?))` : ""}
        ORDER BY ${isDetail ? "event.updatedAt DESC, event.id ASC" : `${startsSql} ASC, event.id ASC`}
        LIMIT ${isDetail ? limit : limit + 1}
      `,
          [
            isDetail ? query.slug : query.now,
            ...(after ? [after.startsAt, after.startsAt, after.id] : []),
          ],
        ),
      catch: () => new CatalogUnavailable({ operation: "read events" }),
    });
    const selected = isDetail ? rows : rows.slice(0, query.limit);
    const offers = yield* Effect.tryPromise({
      try: () =>
        loadOffers(
          db,
          selected.map((row) => row.id),
        ),
      catch: (error) =>
        error instanceof RangeError
          ? new InvalidWorkshopData({ operation: "read budget" })
          : new CatalogUnavailable({ operation: "read offers" }),
    });
    const workshops = yield* Effect.forEach(selected, (row) =>
      decodeSnapshot(row, offers.get(row.id) ?? null),
    );
    const last = workshops.at(-1);
    return {
      workshops,
      next:
        !isDetail && rows.length > query.limit && last?.startsAt
          ? { startsAt: last.startsAt, id: last.id }
          : null,
    };
  }, Effect.scoped);
  const listDiscoverable = Effect.fn("listDiscoverableWorkshops")(function* (after: string | null) {
    const db = yield* connectionResource;
    const slug = yield* slugSql(db);
    const [rows] = yield* Effect.tryPromise({
      try: () =>
        db.execute<EventRow[]>(
          `
        SELECT event.id, ${slug} AS slug, DATE_FORMAT(event.updatedAt, '%Y-%m-%dT%H:%i:%s.%fZ') AS updatedAt
        FROM egghead_ContentResource event WHERE event.deletedAt IS NULL AND event.type = 'event'
          ${workshopVisibilitySql(true)} AND ${slug} IS NOT NULL AND ${slug} != ''
          ${after ? "AND event.id > ?" : ""}
        ORDER BY event.id ASC LIMIT ${PAGE_SIZE + 1}
      `,
          after ? [after] : [],
        ),
      catch: () => new CatalogUnavailable({ operation: "read discovery references" }),
    });
    const workshops = yield* Effect.forEach(rows.slice(0, PAGE_SIZE), (row) =>
      Schema.decodeUnknownEffect(WorkshopReference)({
        id: row.id,
        slug: row.slug,
        updatedAt: isoDate(row.updatedAt),
      }).pipe(
        Effect.mapError(
          () => new InvalidWorkshopData({ operation: "decode discovery references" }),
        ),
      ),
    );
    return { workshops, next: rows.length > PAGE_SIZE ? (workshops.at(-1)?.id ?? null) : null };
  }, Effect.scoped);
  return Layer.succeed(WorkshopCatalog, {
    get: (slug) => read({ slug }).pipe(Effect.map((page) => page.workshops[0] ?? null)),
    listUpcoming: read,
    listDiscoverable,
  });
}
