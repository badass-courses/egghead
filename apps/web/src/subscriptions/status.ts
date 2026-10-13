import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { getEggheadDatabase } from "../db/adapter";
import { entitlements, merchantCustomer, merchantSubscription, subscription } from "../db/schema";
import { CURRENT_SUBSCRIPTION_STATUSES, STRIPE_SUBSCRIPTION_SOURCE } from "./access";

export async function getBillingSubscriptionForUser(userId: string) {
  const [owned] = await getEggheadDatabase()
    .select({ subscription })
    .from(subscription)
    .innerJoin(
      merchantSubscription,
      eq(merchantSubscription.id, subscription.merchantSubscriptionId),
    )
    .innerJoin(merchantCustomer, eq(merchantCustomer.id, merchantSubscription.merchantCustomerId))
    .where(eq(merchantCustomer.userId, userId))
    .orderBy(desc(subscription.createdAt))
    .limit(1);
  return owned?.subscription ?? null;
}

export async function getCurrentSubscriptionForUser(userId: string) {
  const db = getEggheadDatabase();
  const [owned] = await db
    .select({ subscription })
    .from(subscription)
    .innerJoin(
      merchantSubscription,
      eq(merchantSubscription.id, subscription.merchantSubscriptionId),
    )
    .innerJoin(merchantCustomer, eq(merchantCustomer.id, merchantSubscription.merchantCustomerId))
    .where(
      and(
        eq(merchantCustomer.userId, userId),
        inArray(subscription.status, CURRENT_SUBSCRIPTION_STATUSES),
      ),
    )
    .orderBy(desc(subscription.createdAt))
    .limit(1);
  if (owned) return owned.subscription;
  const [assigned] = await db
    .select({ subscription })
    .from(entitlements)
    .innerJoin(subscription, eq(subscription.id, entitlements.sourceId))
    .where(
      and(
        eq(entitlements.sourceType, STRIPE_SUBSCRIPTION_SOURCE),
        eq(entitlements.userId, userId),
        isNull(entitlements.deletedAt),
        gt(entitlements.expiresAt, new Date()),
        inArray(subscription.status, CURRENT_SUBSCRIPTION_STATUSES),
      ),
    )
    .orderBy(desc(subscription.createdAt))
    .limit(1);
  return assigned?.subscription ?? null;
}
