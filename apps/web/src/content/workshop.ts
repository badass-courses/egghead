import type { RowDataPacket } from "mysql2";
import { cacheLife, cacheTag } from "next/cache";

import { createLocalMysqlConnection } from "../db/local-docker";
import {
  descriptionField,
  fieldsFromJson,
  objectField,
  stringField,
  type JsonFields,
} from "./fields";
import { publishedResourceSql } from "./publication";
import { contentResourceSlugSql } from "./resource-slug";

type WorkshopRow = RowDataPacket & {
  id: string;
  fields: unknown;
  updatedAt: Date | string;
};

type WorkshopOfferRow = RowDataPacket & {
  productId: string;
  productName: string;
  purchaseCount: number | string;
  quantityAvailable: number | string;
  resourceId: string;
  unitAmount: number | string | null;
};

type WorkshopCouponRow = RowDataPacket & {
  amountDiscount: number | string | null;
  couponFields: unknown;
  default: number | boolean;
  expires: Date | string | null;
  merchantAmountDiscount: number | string | null;
  merchantPercentageDiscount: number | string | null;
  percentageDiscount: number | string | null;
  productId: string;
};

export type WorkshopStatus = "in-progress" | "past" | "schedule-pending" | "upcoming";

export type WorkshopOffer = {
  currentPrice: number;
  discountEndsAt: string | null;
  discountPercent: number | null;
  fullPrice: number;
  memberPrice: number | null;
  productId: string;
  productName: string;
  seatsRemaining: number | null;
  soldOut: boolean;
};

export type Workshop = {
  body: string | null;
  ctaLabel: string;
  description: string;
  endsAt: string | null;
  id: string;
  imageUrl: string | null;
  offer: WorkshopOffer | null;
  registrationUrl: string | null;
  slug: string;
  startsAt: string | null;
  status: WorkshopStatus;
  timezone: string;
  title: string;
  updatedAt: Date | string;
};

function numberValue(value: number | string | null | undefined) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoDate(value: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function safePublicUrl(value: string | null) {
  if (!value) return null;

  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function imageFromFields(fields: JsonFields) {
  const socialImage = objectField(fields, "socialImage");
  return (
    stringField(fields, "image") ??
    stringField(fields, "imageUrl") ??
    (socialImage ? stringField(socialImage, "url") : null)
  );
}

export function workshopStatus(
  startsAt: string | null,
  endsAt: string | null,
  now = new Date(),
): WorkshopStatus {
  const starts = startsAt ? new Date(startsAt) : null;
  const ends = endsAt ? new Date(endsAt) : null;

  if (!starts || Number.isNaN(starts.getTime())) return "schedule-pending";
  if (ends && !Number.isNaN(ends.getTime()) && ends <= now) return "past";
  if (starts <= now) return "in-progress";
  return "upcoming";
}

function discountAmount(row: WorkshopCouponRow, fullPrice: number) {
  const percentage =
    numberValue(row.merchantPercentageDiscount) ?? numberValue(row.percentageDiscount);
  const fixedCents = numberValue(row.merchantAmountDiscount) ?? numberValue(row.amountDiscount);

  if (percentage !== null && percentage > 0) return fullPrice * percentage;
  if (fixedCents !== null && fixedCents > 0) return fixedCents / 100;
  return 0;
}

function isMemberCoupon(row: WorkshopCouponRow) {
  const fields = fieldsFromJson(row.couponFields);
  return objectField(fields, "eligibilityCondition") !== null;
}

function offerForRows(row: WorkshopOfferRow, coupons: WorkshopCouponRow[]): WorkshopOffer {
  const fullPrice = Math.max(0, numberValue(row.unitAmount) ?? 0);
  const publicCoupon = coupons.find((coupon) => Boolean(coupon.default) && !isMemberCoupon(coupon));
  const memberCoupon = coupons.find(isMemberCoupon);
  const publicDiscount = publicCoupon ? discountAmount(publicCoupon, fullPrice) : 0;
  const memberDiscount = memberCoupon ? discountAmount(memberCoupon, fullPrice) : 0;
  const quantityAvailable = numberValue(row.quantityAvailable) ?? -1;
  const purchaseCount = numberValue(row.purchaseCount) ?? 0;
  const seatsRemaining =
    quantityAvailable < 0 ? null : Math.max(0, quantityAvailable - purchaseCount);
  const percentage = publicCoupon
    ? (numberValue(publicCoupon.merchantPercentageDiscount) ??
      numberValue(publicCoupon.percentageDiscount))
    : null;

  return {
    currentPrice: Math.max(0, fullPrice - publicDiscount),
    discountEndsAt: publicCoupon ? isoDate(String(publicCoupon.expires ?? "")) : null,
    discountPercent: percentage === null ? null : Math.round(percentage * 100),
    fullPrice,
    memberPrice: memberCoupon ? Math.max(0, fullPrice - memberDiscount) : null,
    productId: row.productId,
    productName: row.productName,
    seatsRemaining,
    soldOut: seatsRemaining === 0,
  };
}

async function loadOffers(
  connection: Awaited<ReturnType<typeof createLocalMysqlConnection>>,
  resourceIds: string[],
) {
  const offers = new Map<string, WorkshopOffer>();
  if (resourceIds.length === 0) return offers;

  const resourcePlaceholders = resourceIds.map(() => "?").join(", ");
  const [offerRows] = await connection.execute<WorkshopOfferRow[]>(
    `
      SELECT
        link.resourceId,
        product.id AS productId,
        product.name AS productName,
        product.quantityAvailable,
        price.unitAmount,
        (
          SELECT COUNT(*)
          FROM egghead_Purchase purchase
          WHERE purchase.productId = product.id
            AND purchase.status IN ('Valid', 'Restricted')
        ) AS purchaseCount
      FROM egghead_ContentResourceProduct link
      JOIN egghead_Product product
        ON product.id = link.productId
       AND product.status = 1
      LEFT JOIN egghead_Price price
        ON price.productId = product.id
       AND price.status = 1
      WHERE link.deletedAt IS NULL
        AND link.resourceId IN (${resourcePlaceholders})
      ORDER BY link.position ASC, price.createdAt DESC
    `,
    resourceIds,
  );

  const productIds = [...new Set(offerRows.map((row) => row.productId))];
  const couponsByProduct = new Map<string, WorkshopCouponRow[]>();

  if (productIds.length > 0) {
    const productPlaceholders = productIds.map(() => "?").join(", ");
    const [couponRows] = await connection.execute<WorkshopCouponRow[]>(
      `
        SELECT
          coupon.restrictedToProductId AS productId,
          coupon.default,
          coupon.expires,
          coupon.fields AS couponFields,
          coupon.percentageDiscount,
          coupon.amountDiscount,
          merchant.percentageDiscount AS merchantPercentageDiscount,
          merchant.amountDiscount AS merchantAmountDiscount
        FROM egghead_Coupon coupon
        LEFT JOIN egghead_MerchantCoupon merchant
          ON merchant.id = coupon.merchantCouponId
         AND merchant.status = 1
        WHERE coupon.restrictedToProductId IN (${productPlaceholders})
          AND coupon.status = 1
          AND (coupon.expires IS NULL OR coupon.expires > UTC_TIMESTAMP())
        ORDER BY coupon.default DESC, coupon.createdAt DESC
      `,
      productIds,
    );

    for (const coupon of couponRows) {
      const existing = couponsByProduct.get(coupon.productId) ?? [];
      existing.push(coupon);
      couponsByProduct.set(coupon.productId, existing);
    }
  }

  for (const offerRow of offerRows) {
    if (offers.has(offerRow.resourceId)) continue;
    offers.set(
      offerRow.resourceId,
      offerForRows(offerRow, couponsByProduct.get(offerRow.productId) ?? []),
    );
  }

  return offers;
}

function workshopFromRow(row: WorkshopRow, offer: WorkshopOffer | null): Workshop {
  const fields = fieldsFromJson(row.fields);
  const startsAt = isoDate(stringField(fields, "startsAt"));
  const endsAt = isoDate(stringField(fields, "endsAt"));

  return {
    body: stringField(fields, "body") ?? stringField(fields, "markdown"),
    ctaLabel: stringField(fields, "ctaLabel") ?? "Register for the workshop",
    description: descriptionField(fields),
    endsAt,
    id: row.id,
    imageUrl: imageFromFields(fields),
    offer,
    registrationUrl: safePublicUrl(stringField(fields, "registrationUrl")),
    slug: stringField(fields, "slug") ?? row.id,
    startsAt,
    status: workshopStatus(startsAt, endsAt),
    timezone: stringField(fields, "timezone") ?? "America/Los_Angeles",
    title: stringField(fields, "title") ?? "Untitled workshop",
    updatedAt: row.updatedAt,
  };
}

async function workshopRows(slug?: string) {
  const connection = await createLocalMysqlConnection();

  try {
    const slugSql = await contentResourceSlugSql(connection, "event");
    const [rows] = await connection.execute<WorkshopRow[]>(
      `
        SELECT event.id, event.fields, event.updatedAt
        FROM egghead_ContentResource event
        WHERE event.deletedAt IS NULL
          AND event.type = 'event'
          ${publishedResourceSql("event")}
          AND ${slugSql} IS NOT NULL
          AND ${slugSql} != ''
          ${slug ? `AND ${slugSql} = ?` : ""}
        ORDER BY event.updatedAt DESC, event.createdAt DESC
        ${slug ? "LIMIT 1" : "LIMIT 100"}
      `,
      slug ? [slug] : [],
    );
    const offers = await loadOffers(
      connection,
      rows.map((row) => row.id),
    );

    return rows.map((row) => workshopFromRow(row, offers.get(row.id) ?? null));
  } finally {
    await connection.end();
  }
}

export async function getUpcomingWorkshops() {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-workshops");
  cacheTag("egghead-content");

  const workshops = await workshopRows();
  return workshops
    .filter((workshop) => workshop.status === "upcoming" || workshop.status === "in-progress")
    .toSorted((left, right) => (left.startsAt ?? "").localeCompare(right.startsAt ?? ""));
}

export async function getWorkshopBySlug(slug: string) {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-workshops");
  cacheTag(`egghead-workshop:${slug}`);

  const workshops = await workshopRows(slug);
  return workshops[0] ?? null;
}

export function formatWorkshopDate(workshop: Pick<Workshop, "startsAt" | "timezone">) {
  if (!workshop.startsAt) return "Schedule coming soon";

  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: workshop.timezone,
    }).format(new Date(workshop.startsAt));
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(workshop.startsAt));
  }
}

export function formatWorkshopPrice(price: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: Number.isInteger(price) ? 0 : 2,
    style: "currency",
  }).format(price);
}
