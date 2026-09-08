import { randomUUID } from "node:crypto";

import { and, eq, gt, inArray, isNull } from "drizzle-orm";

import { getCourseBuilderAdapter, getEggheadDatabase } from "../db/adapter";
import { assertAccountWritesAllowed } from "../db/local-docker";
import {
  entitlements,
  merchantSubscription,
  organizationMemberships,
  products,
  subscription,
  users,
} from "../db/schema";
import {
  EGGHEAD_SUBSCRIPTION_ENTITLEMENT,
  STRIPE_SUBSCRIPTION_SOURCE,
  stripeSubscriptionSeatEntitlementId,
  subscriptionGrantOccupiesSeat,
  subscriptionPaidThrough,
  subscriptionRecord,
  type SubscriptionGrantState,
} from "./access";
import { isTeamSubscription, teamSubscriptionFieldsSchema } from "./team-contracts";
import { consumeTeamInvitation } from "./team-invitation-state";
import type { TeamInvitePayload } from "./team-invite-token";

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
  const teamSubscription = subscriptions.find((candidate) => isTeamSubscription(candidate.fields));
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
      where: and(
        eq(entitlements.sourceId, teamSubscription.id),
        eq(entitlements.sourceType, STRIPE_SUBSCRIPTION_SOURCE),
      ),
    }),
  ]);

  return {
    availableSeats: Math.max(
      0,
      fields.data.seats - assignedSeats.filter(subscriptionGrantOccupiesSeat).length,
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
      inArray(subscription.status, CURRENT_SUBSCRIPTION_STATUSES),
    ),
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

  const seatEntitlements = await db.query.entitlements.findMany({
    where: and(
      eq(entitlements.sourceId, ownedSubscription.id),
      eq(entitlements.sourceType, STRIPE_SUBSCRIPTION_SOURCE),
    ),
    with: { user: true },
  });
  const members = seatEntitlements.flatMap<TeamSubscriptionMember>((entitlement) => {
    if (!entitlement.user || !subscriptionGrantOccupiesSeat(entitlement)) return [];

    return [
      {
        email: entitlement.user.email,
        entitlementId: entitlement.id,
        isOwner: entitlement.user.id === parsedFields.ownerId,
        joinedAt: entitlement.createdAt,
        name: entitlement.user.name,
        userId: entitlement.user.id,
      },
    ];
  });
  const usedSeats = members.length;

  return {
    availableSeats: Math.max(0, parsedFields.seats - usedSeats),
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
    !isTeamSubscription(row.fields) ||
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

type GrantTeamSeatResult = {
  status: "already-assigned" | "assigned" | "full" | "not-found" | "invalid-invite";
};

export function planTeamSeatGrant(input: {
  fields: unknown;
  status: string;
  subscriptionId: string;
  ownerId: string;
  actor: { userId: string; email: string };
  grants: (SubscriptionGrantState & { userId: string | null })[];
  invitation?: TeamInvitePayload;
  now: Date;
}):
  | { status: Exclude<GrantTeamSeatResult["status"], "assigned"> }
  | {
      status: "ready";
      fields: Record<string, unknown>;
      expiresAt: Date;
    } {
  const fields = teamSubscriptionFieldsSchema.safeParse(input.fields);
  const paidThrough = subscriptionPaidThrough(input.fields);
  if (
    !fields.success ||
    fields.data.ownerId !== input.ownerId ||
    !isTeamSubscription(input.fields) ||
    !CURRENT_SUBSCRIPTION_STATUSES.includes(input.status) ||
    !paidThrough ||
    paidThrough <= input.now
  ) {
    return { status: "not-found" };
  }

  let consumedFields = subscriptionRecord(input.fields);
  if (input.actor.userId !== fields.data.ownerId || input.invitation) {
    if (!input.invitation || input.invitation.subscriptionId !== input.subscriptionId)
      return { status: "invalid-invite" };
    const consumed = consumeTeamInvitation(
      input.fields,
      input.invitation,
      input.actor,
      input.now.getTime(),
    );
    if (!consumed) return { status: "invalid-invite" };
    consumedFields = consumed;
  }
  const assigned = input.grants.filter(subscriptionGrantOccupiesSeat);
  if (assigned.some((grant) => grant.userId === input.actor.userId))
    return { status: "already-assigned" };
  const lifecycle = subscriptionRecord(subscriptionRecord(input.fields)["stripeLifecycle"]);
  if (lifecycle["quantityReconciliation"] || assigned.length >= fields.data.seats)
    return { status: "full" };

  return { status: "ready", fields: consumedFields, expiresAt: paidThrough };
}

export async function grantTeamSubscriptionSeat(input: {
  ownerId: string;
  seatUserId: string;
  stripeSubscriptionId: string;
  subscriptionId: string;
  invitation?: TeamInvitePayload;
}): Promise<GrantTeamSeatResult> {
  assertAccountWritesAllowed();
  const db = getEggheadDatabase();
  return db.transaction(async (transaction) => {
    const [storedSubscription] = await transaction
      .select()
      .from(subscription)
      .where(eq(subscription.id, input.subscriptionId))
      .for("update");
    if (!storedSubscription?.organizationId) return { status: "not-found" };
    const storedMerchant = await transaction.query.merchantSubscription.findFirst({
      where: eq(merchantSubscription.id, storedSubscription.merchantSubscriptionId),
    });
    if (storedMerchant?.identifier !== input.stripeSubscriptionId) return { status: "not-found" };
    const actor = await transaction.query.users.findFirst({
      where: eq(users.id, input.seatUserId),
    });
    if (!actor?.email) return { status: "invalid-invite" };
    const grants = await transaction
      .select()
      .from(entitlements)
      .where(
        and(
          eq(entitlements.sourceId, input.subscriptionId),
          eq(entitlements.sourceType, STRIPE_SUBSCRIPTION_SOURCE),
        ),
      );
    const now = new Date();
    const plan = planTeamSeatGrant({
      fields: storedSubscription.fields,
      status: storedSubscription.status,
      subscriptionId: input.subscriptionId,
      ownerId: input.ownerId,
      actor: { userId: actor.id, email: actor.email },
      grants,
      ...(input.invitation ? { invitation: input.invitation } : {}),
      now,
    });
    if (plan.status !== "ready") return plan;

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
    if (!membership) throw new Error("Unable to create team membership.");

    const entitlementId = stripeSubscriptionSeatEntitlementId(
      input.stripeSubscriptionId,
      input.seatUserId,
    );
    const previousGrant = grants.find((grant) => grant.id === entitlementId);
    const metadata = {
      ...subscriptionRecord(previousGrant?.metadata),
      productId: storedSubscription.productId,
      status: storedSubscription.status,
      stripeSubscriptionId: input.stripeSubscriptionId,
      teamSeat: true,
      revocationReason: null,
      paidThrough: plan.expiresAt.getTime(),
    };
    const seatValues = {
      userId: input.seatUserId,
      organizationId: storedSubscription.organizationId,
      organizationMembershipId: membership.id,
      sourceId: input.subscriptionId,
      metadata,
      expiresAt: plan.expiresAt,
      deletedAt: null,
      updatedAt: now,
    };
    await transaction
      .insert(entitlements)
      .values({
        id: entitlementId,
        entitlementType: EGGHEAD_SUBSCRIPTION_ENTITLEMENT,
        sourceType: STRIPE_SUBSCRIPTION_SOURCE,
        ...seatValues,
      })
      .onDuplicateKeyUpdate({ set: seatValues });
    // Consumed invitation and grant commit or roll back together under this same lock.
    await transaction
      .update(subscription)
      .set({ fields: plan.fields })
      .where(eq(subscription.id, input.subscriptionId));
    console.info("subscription.team.seat_assigned", { subscriptionId: input.subscriptionId });
    return { status: "assigned" };
  });
}

type RemoveTeamSeatResult = { status: "not-found" | "owner" | "removed" };

export async function removeTeamSubscriptionSeat(input: {
  ownerId: string;
  subscriptionId: string;
  userId: string;
}): Promise<RemoveTeamSeatResult> {
  assertAccountWritesAllowed();
  if (input.ownerId === input.userId) return { status: "owner" };
  return getEggheadDatabase().transaction(async (transaction) => {
    const [stored] = await transaction
      .select()
      .from(subscription)
      .where(eq(subscription.id, input.subscriptionId))
      .for("update");
    const fields = teamSubscriptionFieldsSchema.safeParse(stored?.fields);
    if (
      !stored ||
      !fields.success ||
      fields.data.ownerId !== input.ownerId ||
      !isTeamSubscription(stored.fields)
    ) {
      return { status: "not-found" };
    }
    const grants = await transaction
      .select()
      .from(entitlements)
      .where(
        and(
          eq(entitlements.sourceId, input.subscriptionId),
          eq(entitlements.sourceType, STRIPE_SUBSCRIPTION_SOURCE),
          eq(entitlements.userId, input.userId),
        ),
      );
    const now = new Date();
    await grants.reduce<Promise<void>>(async (previous, grant) => {
      await previous;
      await transaction
        .update(entitlements)
        .set({
          deletedAt: grant.deletedAt ?? now,
          updatedAt: now,
          metadata: {
            ...subscriptionRecord(grant.metadata),
            revocationReason: "seat_removed",
            seatRemovedAt: now.toISOString(),
          },
        })
        .where(eq(entitlements.id, grant.id));
    }, Promise.resolve());
    console.info("subscription.team.seat_removed", {
      subscriptionId: input.subscriptionId,
      grants: grants.length,
    });
    return { status: "removed" };
  });
}
