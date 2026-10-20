import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { Schema } from "effect";
import { Workshop } from "@egghead/core/contracts";
import { priceSchema } from "@coursebuilder/core/schemas/price-schema";
import { isPriceAvailable } from "@coursebuilder/commerce/select-product-price";
import { getEggheadDatabase } from "../db/adapter";
import { contentResource, contentResourceProduct, products, prices } from "../db/schema";

export async function getStoredWorkshop(id: string) {
  const [row] = await getEggheadDatabase()
    .select({
      id: contentResource.id,
      type: contentResource.type,
      createdById: contentResource.createdById,
      fields: contentResource.fields,
    })
    .from(contentResource)
    .where(
      and(
        eq(contentResource.id, id),
        eq(contentResource.type, "workshop"),
        isNull(contentResource.deletedAt),
      ),
    )
    .limit(1);
  return row ? Schema.decodeUnknownSync(Workshop)(row) : null;
}

export async function getPublishedWorkshop(id: string) {
  const workshop = await getStoredWorkshop(id);
  return workshop?.fields.state === "published" ? workshop : null;
}

export type WorkshopPurchaseOffer = {
  productId: string;
  priceId: string;
  unitAmount: number;
  currency: "USD";
};

/** At most two linked offers; ambiguity fails closed. Published reads pin exact IDs. */
export async function getWorkshopOffer(workshop: Workshop): Promise<WorkshopPurchaseOffer | null> {
  const offer = workshop.fields.state === "published" ? workshop.fields.offer : null;
  const rows = await getEggheadDatabase()
    .select({ productId: products.id, price: prices })
    .from(contentResourceProduct)
    .innerJoin(products, eq(products.id, contentResourceProduct.productId))
    .innerJoin(
      prices,
      and(
        eq(prices.productId, products.id),
        offer
          ? eq(prices.id, offer.priceId)
          : sql`${prices.id} = JSON_UNQUOTE(JSON_EXTRACT(${products.fields}, '$.defaultPriceId'))`,
      ),
    )
    .where(
      and(
        eq(contentResourceProduct.resourceId, workshop.id),
        isNull(contentResourceProduct.deletedAt),
        offer ? eq(products.id, offer.productId) : undefined,
        eq(products.status, 1),
        eq(products.type, "live"),
        eq(products.quantityAvailable, -1),
        sql`JSON_UNQUOTE(JSON_EXTRACT(${products.fields}, '$.state')) = 'published'`,
      ),
    )
    .limit(2);
  if (rows.length !== 1 || !rows[0]) return null;
  const row = rows[0];
  const price = priceSchema.parse(row.price);
  if (
    !isPriceAvailable(price) ||
    price.unitAmount <= 0 ||
    price.fields.stripe?.type !== "one_time" ||
    price.fields.stripe.currency !== "usd"
  )
    return null;
  return {
    productId: row.productId,
    priceId: price.id,
    unitAmount: price.unitAmount,
    currency: "USD",
  };
}

/** Used before the generic CourseBuilder checkout route can create a session. */
export async function isWorkshopProduct(productId: string) {
  const [row] = await getEggheadDatabase()
    .select({ id: contentResource.id })
    .from(contentResourceProduct)
    .innerJoin(contentResource, eq(contentResource.id, contentResourceProduct.resourceId))
    .where(
      and(eq(contentResourceProduct.productId, productId), eq(contentResource.type, "workshop")),
    )
    .limit(1);
  return Boolean(row);
}

/** One type-indexed keyset read per page; the extra row detects another page. */
export async function listUpcomingWorkshops(cursor?: string) {
  const limit = 20;
  const rows = await getEggheadDatabase()
    .select({
      id: contentResource.id,
      title: sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.title'))`,
      description: sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.description'))`,
      startsAt: sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.startsAt'))`,
      timezone: sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.timezone'))`,
    })
    .from(contentResource)
    .where(
      and(
        eq(contentResource.type, "workshop"),
        isNull(contentResource.deletedAt),
        sql`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.state')) = 'published'`,
        sql`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.startsAt')) > ${new Date().toISOString()}`,
        cursor ? gt(contentResource.id, cursor) : undefined,
      ),
    )
    .orderBy(asc(contentResource.id))
    .limit(limit + 1);
  const workshops = rows.slice(0, limit);
  return {
    workshops,
    nextCursor: rows.length > limit ? workshops.at(-1)?.id : undefined,
  };
}
