import { randomUUID } from "node:crypto";

import { and, eq, gt, inArray, isNull } from "drizzle-orm";

import { getCourseBuilderAdapter, getEggheadDatabase } from "../db/adapter";
import { entitlements, organizationMemberships, subscription } from "../db/schema";
import {
  EGGHEAD_SUBSCRIPTION_ENTITLEMENT,
  STRIPE_SUBSCRIPTION_SOURCE,
  stripeSubscriptionSeatEntitlementId,
} from "./access";
import { MIN_TEAM_SEATS, teamSubscriptionFieldsSchema } from "./team-contracts";

const CURRENT_SUBSCRIPTION_STATUSES = ["active", "past_due", "trialing"];

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
    return fields.success && fields.data.seats >= MIN_TEAM_SEATS;
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
  if (!teamSubscription || !fields.success || fields.data.seats < MIN_TEAM_SEATS) return null;

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
    availableSeats: Math.max(0, fields.data.seats - assignedSeats.length),
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
      inArray(subscription.status, CURRENT_SUBSCRIPTION_STATUSES),
    ),
    with: { merchantSubscription: true, product: true },
  });
  const ownedSubscription = subscriptions.find((candidate) => {
    const fields = teamSubscriptionFieldsSchema.safeParse(candidate.fields);
    return (
      fields.success &&
      fields.data.ownerId === userId &&
      fields.data.seats >= MIN_TEAM_SEATS &&
      Boolean(candidate.merchantSubscription?.identifier)
    );
  });
  if (!ownedSubscription?.merchantSubscription?.identifier) return null;

  const parsedFields = teamSubscriptionFieldsSchema.safeParse(ownedSubscription.fields);
  if (!parsedFields.success) return null;

  const seatEntitlements = await db.query.entitlements.findMany({
    where: and(
      eq(entitlements.sourceId, ownedSubscription.id),
      eq(entitlements.sourceType, STRIPE_SUBSCRIPTION_SOURCE),
      isNull(entitlements.deletedAt),
    ),
    with: { user: true },
  });
  const members = seatEntitlements.flatMap<TeamSubscriptionMember>((entitlement) => {
    if (!entitlement.user) return [];

    return [
      {
        email: entitlement.user.email,
        entitlementId: entitlement.id,
        isOwner: entitlement.user.id === parsedFields.data.ownerId,
        joinedAt: entitlement.createdAt,
        name: entitlement.user.name,
        userId: entitlement.user.id,
      },
    ];
  });
  const usedSeats = members.length;

  return {
    availableSeats: Math.max(0, parsedFields.data.seats - usedSeats),
    id: ownedSubscription.id,
    members,
    ownerHasSeat: members.some((member) => member.isOwner),
    ownerId: parsedFields.data.ownerId,
    productName: ownedSubscription.product?.name ?? "egghead team membership",
    stripeSubscriptionId: ownedSubscription.merchantSubscription.identifier,
    totalSeats: parsedFields.data.seats,
    usedSeats,
  };
}

export async function getOwnedTeamSubscriptionRow(subscriptionId: string, ownerId: string) {
  const row = await getEggheadDatabase().query.subscription.findFirst({
    where: and(
      eq(subscription.id, subscriptionId),
      inArray(subscription.status, CURRENT_SUBSCRIPTION_STATUSES),
    ),
    with: { merchantSubscription: true, product: true },
  });
  const fields = teamSubscriptionFieldsSchema.safeParse(row?.fields);

  if (
    !row ||
    !fields.success ||
    fields.data.ownerId !== ownerId ||
    fields.data.seats < MIN_TEAM_SEATS ||
    !row.organizationId ||
    !row.merchantSubscription?.identifier
  ) {
    return null;
  }

  return {
    fields: fields.data,
    row,
    stripeSubscriptionId: row.merchantSubscription.identifier,
  };
}

type GrantTeamSeatResult =
  | { status: "already-assigned" }
  | { status: "assigned" }
  | { status: "full" }
  | { status: "not-found" };

export async function grantTeamSubscriptionSeat(input: {
  currentPeriodEnd: Date;
  ownerId: string;
  seatUserId: string;
  status: string;
  stripeSubscriptionId: string;
  subscriptionId: string;
}): Promise<GrantTeamSeatResult> {
  const db = getEggheadDatabase();

  return db.transaction(async (transaction) => {
    const [storedSubscription] = await transaction
      .select({
        fields: subscription.fields,
        organizationId: subscription.organizationId,
        productId: subscription.productId,
        status: subscription.status,
      })
      .from(subscription)
      .where(eq(subscription.id, input.subscriptionId))
      .for("update");
    const fields = teamSubscriptionFieldsSchema.safeParse(storedSubscription?.fields);

    if (
      !storedSubscription?.organizationId ||
      !fields.success ||
      fields.data.ownerId !== input.ownerId ||
      fields.data.seats < MIN_TEAM_SEATS ||
      !CURRENT_SUBSCRIPTION_STATUSES.includes(storedSubscription.status)
    ) {
      return { status: "not-found" };
    }

    const assignedEntitlements = await transaction
      .select({ id: entitlements.id, userId: entitlements.userId })
      .from(entitlements)
      .where(
        and(
          eq(entitlements.sourceId, input.subscriptionId),
          eq(entitlements.sourceType, STRIPE_SUBSCRIPTION_SOURCE),
          isNull(entitlements.deletedAt),
        ),
      );

    if (assignedEntitlements.some((entitlement) => entitlement.userId === input.seatUserId)) {
      return { status: "already-assigned" };
    }
    if (assignedEntitlements.length >= fields.data.seats) {
      return { status: "full" };
    }

    let membership = await transaction.query.organizationMemberships.findFirst({
      where: and(
        eq(organizationMemberships.organizationId, storedSubscription.organizationId),
        eq(organizationMemberships.userId, input.seatUserId),
      ),
    });

    if (!membership) {
      const membershipId = randomUUID();
      await transaction.insert(organizationMemberships).values({
        id: membershipId,
        invitedById: input.ownerId,
        organizationId: storedSubscription.organizationId,
        userId: input.seatUserId,
      });
      membership = await transaction.query.organizationMemberships.findFirst({
        where: eq(organizationMemberships.id, membershipId),
      });
    }
    if (!membership) return { status: "not-found" };

    const entitlementId = stripeSubscriptionSeatEntitlementId(
      input.stripeSubscriptionId,
      input.seatUserId,
    );
    const now = new Date();
    await transaction
      .insert(entitlements)
      .values({
        id: entitlementId,
        entitlementType: EGGHEAD_SUBSCRIPTION_ENTITLEMENT,
        userId: input.seatUserId,
        organizationId: storedSubscription.organizationId,
        organizationMembershipId: membership.id,
        sourceType: STRIPE_SUBSCRIPTION_SOURCE,
        sourceId: input.subscriptionId,
        metadata: {
          productId: storedSubscription.productId,
          status: input.status,
          stripeSubscriptionId: input.stripeSubscriptionId,
          teamSeat: true,
        },
        expiresAt: input.currentPeriodEnd,
        deletedAt: null,
      })
      .onDuplicateKeyUpdate({
        set: {
          userId: input.seatUserId,
          organizationId: storedSubscription.organizationId,
          organizationMembershipId: membership.id,
          sourceId: input.subscriptionId,
          metadata: {
            productId: storedSubscription.productId,
            status: input.status,
            stripeSubscriptionId: input.stripeSubscriptionId,
            teamSeat: true,
          },
          expiresAt: input.currentPeriodEnd,
          deletedAt: null,
          updatedAt: now,
        },
      });

    return { status: "assigned" };
  });
}

type RemoveTeamSeatResult = { status: "not-found" | "owner" | "removed" };

export async function removeTeamSubscriptionSeat(input: {
  ownerId: string;
  subscriptionId: string;
  userId: string;
}): Promise<RemoveTeamSeatResult> {
  if (input.ownerId === input.userId) return { status: "owner" };

  const ownedSubscription = await getOwnedTeamSubscriptionRow(input.subscriptionId, input.ownerId);
  if (!ownedSubscription) return { status: "not-found" };

  await getEggheadDatabase()
    .update(entitlements)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(entitlements.sourceId, input.subscriptionId),
        eq(entitlements.sourceType, STRIPE_SUBSCRIPTION_SOURCE),
        eq(entitlements.userId, input.userId),
        isNull(entitlements.deletedAt),
      ),
    );

  return { status: "removed" };
}
