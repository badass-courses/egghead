import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";

import { getCourseBuilderAdapter, getEggheadDatabase } from "../db/adapter";
import { entitlements, merchantSubscription, products, subscription, users } from "../db/schema";
import {
  CURRENT_SUBSCRIPTION_STATUSES,
  STRIPE_SUBSCRIPTION_SOURCE,
  subscriptionGrantId,
} from "./access";
import { isTeamSubscription, teamSubscriptionFieldsSchema } from "./team-contracts";
import { subscriptionStateSchema, subscriptionNeedsCapacityReview } from "./lifecycle";
import { getSubscriptionStore } from "./store";

export type TeamSubscriptionMember = {
  email: string;
  entitlementId: string;
  isOwner: boolean;
  joinedAt: Date;
  name: string | null;
  userId: string;
};

export type OwnedTeamSubscription = {
  availableSeats: number;
  capacityReviewRequired: boolean;
  reductionSeats: number | null;
  id: string;
  members: TeamSubscriptionMember[];
  ownerHasSeat: boolean;
  ownerId: string;
  productName: string;
  stripeSubscriptionId: string;
  totalSeats: number;
  usedSeats: number;
};

export type TeamMembershipAccess = {
  ownerEmail: string | null;
  ownerId: string;
  ownerName: string | null;
  productName: string;
  subscriptionId: string;
};

export type TeamInviteDetails = TeamMembershipAccess & {
  availableSeats: number;
  totalSeats: number;
};

export async function getTeamMembershipForUser(
  userId: string,
): Promise<TeamMembershipAccess | null> {
  const adapter = getCourseBuilderAdapter();
  const db = getEggheadDatabase();
  const seatEntitlements = await db.query.entitlements.findMany({
    where: and(
      eq(entitlements.userId, userId),
      eq(entitlements.sourceType, STRIPE_SUBSCRIPTION_SOURCE),
      isNull(entitlements.deletedAt),
      gt(entitlements.expiresAt, new Date()),
    ),
  });
  const subscriptionIds = seatEntitlements
    .map((entitlement) => entitlement.sourceId)
    .filter((sourceId): sourceId is string => Boolean(sourceId));
  if (subscriptionIds.length === 0) return null;

  const subscriptions = await db.query.subscription.findMany({
    where: and(
      inArray(subscription.id, subscriptionIds),
      inArray(subscription.status, CURRENT_SUBSCRIPTION_STATUSES),
    ),
    with: { product: true },
  });
  const teamSubscription = subscriptions.find((candidate) => {
    const fields = teamSubscriptionFieldsSchema.safeParse(candidate.fields);
    return fields.success && isTeamSubscription(candidate.fields);
  });
  const fields = teamSubscriptionFieldsSchema.safeParse(teamSubscription?.fields);
  if (!teamSubscription || !fields.success) return null;

  const owner = await adapter.getUserById(fields.data.ownerId);

  return {
    ownerEmail: owner?.email ?? null,
    ownerId: fields.data.ownerId,
    ownerName: owner?.name ?? null,
    productName: teamSubscription.product?.name ?? "egghead team membership",
    subscriptionId: teamSubscription.id,
  };
}

export async function getTeamInviteDetails(
  subscriptionId: string,
): Promise<TeamInviteDetails | null> {
  const adapter = getCourseBuilderAdapter();
  const db = getEggheadDatabase();
  const teamSubscription = await db.query.subscription.findFirst({
    where: and(
      eq(subscription.id, subscriptionId),
      inArray(subscription.status, CURRENT_SUBSCRIPTION_STATUSES),
    ),
    with: { product: true },
  });
  const fields = teamSubscriptionFieldsSchema.safeParse(teamSubscription?.fields);
  if (!teamSubscription || !fields.success || !isTeamSubscription(teamSubscription.fields))
    return null;

  const [owner, assignedSeats] = await Promise.all([
    adapter.getUserById(fields.data.ownerId),
    db.query.entitlements.findMany({
      columns: { id: true },
      where: and(
        eq(entitlements.sourceId, teamSubscription.id),
        eq(entitlements.sourceType, STRIPE_SUBSCRIPTION_SOURCE),
        isNull(entitlements.deletedAt),
      ),
    }),
  ]);

  return {
    availableSeats: Math.max(
      0,
      fields.data.seats -
        (subscriptionStateSchema.safeParse(teamSubscription.fields?.["membershipState"]).data
          ?.assignments.length ?? assignedSeats.length),
    ),
    ownerEmail: owner?.email ?? null,
    ownerId: fields.data.ownerId,
    ownerName: owner?.name ?? null,
    productName: teamSubscription.product?.name ?? "egghead team membership",
    subscriptionId: teamSubscription.id,
    totalSeats: fields.data.seats,
  };
}

export async function getOwnedTeamSubscription(
  userId: string,
): Promise<OwnedTeamSubscription | null> {
  const adapter = getCourseBuilderAdapter();
  const db = getEggheadDatabase();
  const memberships = await adapter.getMembershipsForUser(userId);
  const organizationIds = memberships
    .map((membership) => membership.organizationId)
    .filter((organizationId): organizationId is string => Boolean(organizationId));

  if (organizationIds.length === 0) return null;

  const subscriptions = await db.query.subscription.findMany({
    where: and(
      inArray(subscription.organizationId, organizationIds),
      inArray(subscription.status, [
        ...CURRENT_SUBSCRIPTION_STATUSES,
        "unpaid",
        "paused",
        "incomplete",
      ]),
    ),
    orderBy: desc(subscription.createdAt),
    limit: 100,
  });
  const ownedCandidates = subscriptions.flatMap((candidate) => {
    const fields = teamSubscriptionFieldsSchema.safeParse(candidate.fields);
    if (
      !fields.success ||
      fields.data.ownerId !== userId ||
      !isTeamSubscription(candidate.fields)
    ) {
      return [];
    }

    return [{ fields: fields.data, subscription: candidate }];
  });
  if (ownedCandidates.length === 0) return null;

  const storedMerchantSubscriptions = await db.query.merchantSubscription.findMany({
    where: inArray(
      merchantSubscription.id,
      ownedCandidates.map((candidate) => candidate.subscription.merchantSubscriptionId),
    ),
  });
  const merchantSubscriptionsById = new Map(
    storedMerchantSubscriptions.map((storedSubscription) => [
      storedSubscription.id,
      storedSubscription,
    ]),
  );
  const ownedCandidate = ownedCandidates.find((candidate) =>
    Boolean(
      merchantSubscriptionsById.get(candidate.subscription.merchantSubscriptionId)?.identifier,
    ),
  );
  if (!ownedCandidate) return null;

  const ownedSubscription = ownedCandidate.subscription;
  const parsedFields = ownedCandidate.fields;
  const storedMerchantSubscription = merchantSubscriptionsById.get(
    ownedSubscription.merchantSubscriptionId,
  );
  if (!storedMerchantSubscription?.identifier) return null;
  const storedProduct = await db.query.products.findFirst({
    where: eq(products.id, ownedSubscription.productId),
  });

  const stripeSubscriptionId = storedMerchantSubscription.identifier;
  const seatEntitlements = await db.query.entitlements.findMany({
    where: and(
      eq(entitlements.sourceId, ownedSubscription.id),
      eq(entitlements.sourceType, STRIPE_SUBSCRIPTION_SOURCE),
      isNull(entitlements.deletedAt),
    ),
    with: { user: true },
  });
  const state = subscriptionStateSchema.safeParse(ownedSubscription.fields?.["membershipState"]);
  const assignedUsers = state.success
    ? state.data.assignments.length
      ? await db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(
            inArray(
              users.id,
              state.data.assignments.map((assignment) => assignment.userId),
            ),
          )
          .limit(100)
      : []
    : [];
  const usersById = new Map(assignedUsers.map((user) => [user.id, user]));
  const members = state.success
    ? state.data.assignments.flatMap<TeamSubscriptionMember>((assignment) => {
        const user = usersById.get(assignment.userId);
        return user
          ? [
              {
                email: user.email,
                entitlementId: subscriptionGrantId(stripeSubscriptionId, user.id),
                isOwner: user.id === parsedFields.ownerId,
                joinedAt: new Date(assignment.assignedAt),
                name: user.name ?? null,
                userId: user.id,
              },
            ]
          : [];
      })
    : seatEntitlements.flatMap<TeamSubscriptionMember>((entitlement) =>
        entitlement.user
          ? [
              {
                email: entitlement.user.email,
                entitlementId: entitlement.id,
                isOwner: entitlement.user.id === parsedFields.ownerId,
                joinedAt: entitlement.createdAt,
                name: entitlement.user.name,
                userId: entitlement.user.id,
              },
            ]
          : [],
      );
  const usedSeats = state.success ? state.data.assignments.length : members.length;

  return {
    availableSeats: Math.max(0, parsedFields.seats - usedSeats),
    capacityReviewRequired: state.success && subscriptionNeedsCapacityReview(state.data),
    reductionSeats: state.success ? (state.data.reduction?.seats ?? null) : null,
    id: ownedSubscription.id,
    members,
    ownerHasSeat: members.some((member) => member.isOwner),
    ownerId: parsedFields.ownerId,
    productName: storedProduct?.name ?? "egghead team membership",
    stripeSubscriptionId: storedMerchantSubscription.identifier,
    totalSeats: parsedFields.seats,
    usedSeats,
  };
}

export async function grantTeamSubscriptionSeat(input: {
  ownerId: string;
  seatUserId: string;
  subscriptionId: string;
}) {
  return getSubscriptionStore().assignSeat({ ...input, userId: input.seatUserId });
}

export async function removeTeamSubscriptionSeat(input: {
  ownerId: string;
  subscriptionId: string;
  userId: string;
}) {
  return getSubscriptionStore().removeSeat(input);
}
