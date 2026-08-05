import { and, eq, inArray } from "drizzle-orm";

import { getCourseBuilderAdapter, getEggheadDatabase } from "../db/adapter";
import { subscription } from "../db/schema";

const CURRENT_SUBSCRIPTION_STATUSES = ["active", "past_due", "trialing"];

export async function getCurrentSubscriptionForUser(userId: string) {
  const adapter = getCourseBuilderAdapter();
  const db = getEggheadDatabase();
  const memberships = await adapter.getMembershipsForUser(userId);

  const currentSubscriptions = await Promise.all(
    memberships.map((membership) => {
      if (!membership.organizationId) return Promise.resolve(null);

      return Promise.resolve(
        db.query.subscription.findFirst({
          where: and(
            eq(subscription.organizationId, membership.organizationId),
            inArray(subscription.status, CURRENT_SUBSCRIPTION_STATUSES),
          ),
        }),
      );
    }),
  );

  return currentSubscriptions.find((currentSubscription) => currentSubscription) ?? null;
}
