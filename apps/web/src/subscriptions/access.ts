import { createHash } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { getEggheadDatabase } from "../db/adapter";
import { entitlements, subscription } from "../db/schema";

export const EGGHEAD_SUBSCRIPTION_ENTITLEMENT = "egghead_all_access_subscription";
export const STRIPE_SUBSCRIPTION_SOURCE = "stripe_subscription";

const ACCESS_GRANTING_STATUSES = new Set(["active", "past_due", "trialing"]);

export function stripeSubscriptionGrantsAccess(status: string) {
  return ACCESS_GRANTING_STATUSES.has(status);
}

export function stripeSubscriptionEntitlementId(stripeSubscriptionId: string) {
  return `stripe_ent_${stripeSubscriptionId}`;
}

export function stripeSubscriptionSeatEntitlementId(stripeSubscriptionId: string, userId: string) {
  const seatFingerprint = createHash("sha256")
    .update(`${stripeSubscriptionId}:${userId}`)
    .digest("hex");
  return `stripe_seat_${seatFingerprint}`;
}

type StripeSubscriptionEventKind = "checkout" | "subscription_update";

function subscriptionEventWasApplied(
  metadata: unknown,
  stripeEventCreatedAt: number,
  stripeEventKind: StripeSubscriptionEventKind,
  status: string,
) {
  if (typeof metadata !== "object" || metadata === null) return false;

  return (
    "stripeEventCreatedAt" in metadata &&
    metadata.stripeEventCreatedAt === stripeEventCreatedAt &&
    "stripeEventKind" in metadata &&
    metadata.stripeEventKind === stripeEventKind &&
    "status" in metadata &&
    metadata.status === status
  );
}

export async function syncStripeSubscriptionEntitlement(input: {
  currentPeriodEnd: Date;
  entitlementId?: string;
  localSubscriptionId: string;
  organizationId: string;
  organizationMembershipId: string;
  productId: string;
  status: string;
  stripeEventCreatedAt: number;
  stripeEventKind: StripeSubscriptionEventKind;
  stripeSubscriptionId: string;
  userId: string;
}) {
  const db = getEggheadDatabase();
  const id = input.entitlementId ?? stripeSubscriptionEntitlementId(input.stripeSubscriptionId);
  const deletedAt = stripeSubscriptionGrantsAccess(input.status) ? null : new Date();
  const metadata = {
    productId: input.productId,
    status: input.status,
    stripeEventCreatedAt: input.stripeEventCreatedAt,
    stripeEventKind: input.stripeEventKind,
    stripeSubscriptionId: input.stripeSubscriptionId,
  };
  const storedEventCreatedAt = sql`CAST(
    JSON_UNQUOTE(JSON_EXTRACT(${entitlements.metadata}, '$.stripeEventCreatedAt')) AS UNSIGNED
  )`;
  const storedEventKind = sql`JSON_UNQUOTE(
    JSON_EXTRACT(${entitlements.metadata}, '$.stripeEventKind')
  )`;
  const incomingEventIsCurrent = sql`COALESCE(
    ${storedEventCreatedAt} < ${input.stripeEventCreatedAt}
      OR (
        ${storedEventCreatedAt} = ${input.stripeEventCreatedAt}
        AND (
          ${input.stripeEventKind} = 'subscription_update'
          OR ${storedEventKind} <> 'subscription_update'
        )
      ),
    TRUE
  )`;

  return db.transaction(async (transaction) => {
    await transaction
      .insert(entitlements)
      .values({
        id,
        entitlementType: EGGHEAD_SUBSCRIPTION_ENTITLEMENT,
        userId: input.userId,
        organizationId: input.organizationId,
        organizationMembershipId: input.organizationMembershipId,
        sourceType: STRIPE_SUBSCRIPTION_SOURCE,
        sourceId: input.localSubscriptionId,
        metadata,
        expiresAt: input.currentPeriodEnd,
        deletedAt,
      })
      .onDuplicateKeyUpdate({
        set: {
          userId: sql`IF(${incomingEventIsCurrent}, VALUES(${entitlements.userId}), ${entitlements.userId})`,
          organizationId: sql`IF(${incomingEventIsCurrent}, VALUES(${entitlements.organizationId}), ${entitlements.organizationId})`,
          organizationMembershipId: sql`IF(${incomingEventIsCurrent}, VALUES(${entitlements.organizationMembershipId}), ${entitlements.organizationMembershipId})`,
          sourceId: sql`IF(${incomingEventIsCurrent}, VALUES(${entitlements.sourceId}), ${entitlements.sourceId})`,
          expiresAt: sql`IF(${incomingEventIsCurrent}, VALUES(${entitlements.expiresAt}), ${entitlements.expiresAt})`,
          deletedAt: sql`IF(${incomingEventIsCurrent}, VALUES(${entitlements.deletedAt}), ${entitlements.deletedAt})`,
          updatedAt: sql`IF(${incomingEventIsCurrent}, VALUES(${entitlements.updatedAt}), ${entitlements.updatedAt})`,
          metadata: sql`IF(${incomingEventIsCurrent}, VALUES(${entitlements.metadata}), ${entitlements.metadata})`,
        },
      });

    const syncedEntitlement = await transaction.query.entitlements.findFirst({
      where: eq(entitlements.id, id),
    });

    if (
      subscriptionEventWasApplied(
        syncedEntitlement?.metadata,
        input.stripeEventCreatedAt,
        input.stripeEventKind,
        input.status,
      )
    ) {
      await transaction
        .update(subscription)
        .set({ status: input.status })
        .where(eq(subscription.id, input.localSubscriptionId));
    }

    return syncedEntitlement;
  });
}
