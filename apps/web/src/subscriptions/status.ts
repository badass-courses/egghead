import { and, inArray } from "drizzle-orm";

import { getCourseBuilderAdapter, getEggheadDatabase } from "../db/adapter";
import { subscription } from "../db/schema";

const CURRENT_SUBSCRIPTION_STATUSES = ["active", "past_due", "trialing"];

export async function getCurrentSubscriptionForUser(userId: string) {
  const adapter = getCourseBuilderAdapter();
  const db = getEggheadDatabase();
  const memberships = await adapter.getMembershipsForUser(userId);

  const organizationIds = memberships
    .map((membership) => membership.organizationId)
    .filter((organizationId): organizationId is string => Boolean(organizationId));

  if (organizationIds.length === 0) return null;

  const currentSubscription = await db.query.subscription.findFirst({
    where: and(
      inArray(subscription.organizationId, organizationIds),
      inArray(subscription.status, CURRENT_SUBSCRIPTION_STATUSES),
    ),
  });

  return currentSubscription ?? null;
}
