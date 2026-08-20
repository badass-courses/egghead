import { and, eq, inArray, isNull } from "drizzle-orm";

import { getCourseBuilderAdapter, getEggheadDatabase } from "../db/adapter";
import { entitlements, subscription } from "../db/schema";
import { STRIPE_SUBSCRIPTION_SOURCE } from "./access";
import { isTeamSubscription, teamSubscriptionFieldsSchema } from "./team-contracts";

const CURRENT_SUBSCRIPTION_STATUSES = ["active", "past_due", "trialing"];

export async function getCurrentSubscriptionForUser(userId: string) {
  const adapter = getCourseBuilderAdapter();
  const db = getEggheadDatabase();
  const memberships = await adapter.getMembershipsForUser(userId);

  const organizationIds = memberships
    .map((membership) => membership.organizationId)
    .filter((organizationId): organizationId is string => Boolean(organizationId));

  if (organizationIds.length === 0) return null;

  const currentSubscriptions = await db.query.subscription.findMany({
    where: and(
      inArray(subscription.organizationId, organizationIds),
      inArray(subscription.status, CURRENT_SUBSCRIPTION_STATUSES),
    ),
  });
  if (currentSubscriptions.length === 0) return null;

  const ownedSubscription = currentSubscriptions.find((candidate) => {
    const fields = teamSubscriptionFieldsSchema.safeParse(candidate.fields);
    return (
      !isTeamSubscription(candidate.fields) || (fields.success && fields.data.ownerId === userId)
    );
  });
  if (ownedSubscription) return ownedSubscription;

  const assignedSeat = await db.query.entitlements.findFirst({
    where: and(
      inArray(
        entitlements.sourceId,
        currentSubscriptions.map((candidate) => candidate.id),
      ),
      eq(entitlements.sourceType, STRIPE_SUBSCRIPTION_SOURCE),
      eq(entitlements.userId, userId),
      isNull(entitlements.deletedAt),
    ),
  });

  return assignedSeat
    ? (currentSubscriptions.find((candidate) => candidate.id === assignedSeat.sourceId) ?? null)
    : null;
}
