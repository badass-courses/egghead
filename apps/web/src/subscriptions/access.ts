import { eq, sql } from "drizzle-orm";

import { getEggheadDatabase } from "../db/adapter";
import { entitlements } from "../db/schema";

export const EGGHEAD_SUBSCRIPTION_ENTITLEMENT = "egghead_all_access_subscription";
export const STRIPE_SUBSCRIPTION_SOURCE = "stripe_subscription";

const ACCESS_GRANTING_STATUSES = new Set(["active", "past_due", "trialing"]);

export function stripeSubscriptionGrantsAccess(status: string) {
  return ACCESS_GRANTING_STATUSES.has(status);
}

export function stripeSubscriptionEntitlementId(stripeSubscriptionId: string) {
  return `stripe_ent_${stripeSubscriptionId}`;
}

export async function syncStripeSubscriptionEntitlement(input: {
  currentPeriodEnd: Date;
  localSubscriptionId: string;
  organizationId: string;
  organizationMembershipId: string;
  productId: string;
  status: string;
  stripeEventCreatedAt: number;
  stripeSubscriptionId: string;
  userId: string;
}) {
  const db = getEggheadDatabase();
  const id = stripeSubscriptionEntitlementId(input.stripeSubscriptionId);
  const deletedAt = stripeSubscriptionGrantsAccess(input.status) ? null : new Date();
  const metadata = {
    productId: input.productId,
    status: input.status,
    stripeEventCreatedAt: input.stripeEventCreatedAt,
    stripeSubscriptionId: input.stripeSubscriptionId,
  };
  const incomingEventIsCurrent = sql`COALESCE(
    CAST(JSON_UNQUOTE(JSON_EXTRACT(${entitlements.metadata}, '$.stripeEventCreatedAt')) AS UNSIGNED)
      <= ${input.stripeEventCreatedAt},
    TRUE
  )`;

  await db
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
        metadata: sql`IF(${incomingEventIsCurrent}, VALUES(${entitlements.metadata}), ${entitlements.metadata})`,
        expiresAt: sql`IF(${incomingEventIsCurrent}, VALUES(${entitlements.expiresAt}), ${entitlements.expiresAt})`,
        deletedAt: sql`IF(${incomingEventIsCurrent}, VALUES(${entitlements.deletedAt}), ${entitlements.deletedAt})`,
        updatedAt: sql`IF(${incomingEventIsCurrent}, VALUES(${entitlements.updatedAt}), ${entitlements.updatedAt})`,
      },
    });

  return db.query.entitlements.findFirst({
    where: eq(entitlements.id, id),
  });
}
