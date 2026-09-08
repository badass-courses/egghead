import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { entitlementIsEffective } from "../access/evaluate";
import { fieldsFromJson, stringField } from "../content/fields";
import { getEggheadDatabase } from "../db/adapter";
import { entitlements, subscription } from "../db/schema";
import { EGGHEAD_SUBSCRIPTION_ENTITLEMENT, STRIPE_SUBSCRIPTION_SOURCE } from "./access";

const CURRENT_SUBSCRIPTION_STATUSES = ["active", "past_due", "trialing"];

type SubscriptionCandidate = { id: string; status: string; fields: unknown };
type SubscriptionSeat = {
  sourceId: string | null;
  sourceType: string;
  entitlementType: string;
  userId: string | null;
  deletedAt: Date | null;
  expiresAt: Date | null;
  metadata: unknown;
};

export function selectCurrentSubscriptionForUser<T extends SubscriptionCandidate>(
  candidates: readonly T[],
  seats: readonly SubscriptionSeat[],
  userId: string,
  now = Date.now(),
): T | null {
  const current = candidates.filter((candidate) =>
    CURRENT_SUBSCRIPTION_STATUSES.includes(candidate.status),
  );
  // Ownership is explicit for personal and team subscriptions alike. Org membership
  // alone is never ownership; an unseated owner may manage billing, not watch lessons.
  const owned = current.find(
    (candidate) => stringField(fieldsFromJson(candidate.fields), "ownerId") === userId,
  );
  if (owned) return owned;

  const assigned = seats.find(
    (seat) =>
      seat.userId === userId &&
      seat.sourceType === STRIPE_SUBSCRIPTION_SOURCE &&
      seat.entitlementType === EGGHEAD_SUBSCRIPTION_ENTITLEMENT &&
      seat.expiresAt !== null &&
      entitlementIsEffective(
        { ...seat, status: stringField(fieldsFromJson(seat.metadata), "status") },
        now,
      ) &&
      current.some((candidate) => candidate.id === seat.sourceId),
  );
  return assigned
    ? (current.find((candidate) => candidate.id === assigned.sourceId) ?? null)
    : null;
}

export async function getCurrentSubscriptionForUser(userId: string) {
  const db = getEggheadDatabase();
  const seats = await db.query.entitlements.findMany({
    where: and(
      eq(entitlements.sourceType, STRIPE_SUBSCRIPTION_SOURCE),
      eq(entitlements.entitlementType, EGGHEAD_SUBSCRIPTION_ENTITLEMENT),
      eq(entitlements.userId, userId),
      isNull(entitlements.deletedAt),
    ),
  });
  const sourceIds = seats.flatMap((seat) => (seat.sourceId ? [seat.sourceId] : []));
  const currentSubscriptions = await db.query.subscription.findMany({
    where: and(
      inArray(subscription.status, CURRENT_SUBSCRIPTION_STATUSES),
      or(
        sql`JSON_UNQUOTE(JSON_EXTRACT(${subscription.fields}, '$.ownerId')) = ${userId}`,
        sourceIds.length > 0 ? inArray(subscription.id, sourceIds) : undefined,
      ),
    ),
  });
  return selectCurrentSubscriptionForUser(currentSubscriptions, seats, userId);
}
