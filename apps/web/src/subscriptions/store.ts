import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { getEggheadDatabase } from "../db/adapter";
import { assertLocalDockerDatabaseUrl } from "../db/local-docker";
import {
  entitlements,
  merchantCustomer,
  merchantSubscription,
  organizationMemberships,
  subscription,
} from "../db/schema";
import {
  EGGHEAD_SUBSCRIPTION_ENTITLEMENT,
  STRIPE_SUBSCRIPTION_SOURCE,
  stripeSubscriptionGrantsAccess,
  subscriptionGrantId,
} from "./access";
import {
  assignSubscriptionSeat,
  prepareSubscriptionReduction,
  reconcileBilling,
  removeSubscriptionSeat,
  subscriptionBeneficiaries,
  subscriptionSnapshotSchema,
  subscriptionStateSchema,
  type SubscriptionSnapshot,
  type SubscriptionState,
} from "./lifecycle";
import {
  MAX_TEAM_SEATS,
  subscriptionCheckoutQuantitySchema,
  teamSubscriptionFieldsSchema,
} from "./team-contracts";

type Database = ReturnType<typeof getEggheadDatabase>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const fieldsSchema = z.record(z.string(), z.unknown());
const idSchema = z.string().min(1).max(191);
const commandSchema = z.object({ subscriptionId: idSchema, ownerId: idSchema, userId: idSchema });
const reductionSchema = z.object({
  subscriptionId: idSchema,
  ownerId: idSchema,
  seats: subscriptionCheckoutQuantitySchema,
  retainedUserIds: z.array(idSchema).max(MAX_TEAM_SEATS),
});

async function loadLocked(
  transaction: Transaction,
  subscriptionId: string,
  initialSnapshot?: SubscriptionSnapshot,
) {
  const [row] = await transaction
    .select()
    .from(subscription)
    .where(eq(subscription.id, subscriptionId))
    .for("update");
  if (!row?.organizationId) return null;
  const [merchant] = await transaction
    .select({ identifier: merchantSubscription.identifier, ownerId: merchantCustomer.userId })
    .from(merchantSubscription)
    .leftJoin(merchantCustomer, eq(merchantCustomer.id, merchantSubscription.merchantCustomerId))
    .where(eq(merchantSubscription.id, row.merchantSubscriptionId))
    .limit(1);
  if (!merchant?.identifier) return null;
  const fields = fieldsSchema.parse(row.fields ?? {});
  if (fields["membershipState"] !== undefined) {
    return {
      row: { ...row, organizationId: row.organizationId },
      fields,
      stripeSubscriptionId: merchant.identifier,
      state: subscriptionStateSchema.parse(fields["membershipState"]),
    };
  }

  // Local-only adoption of the former grant-backed roster. No production backfill.
  const legacyFields = teamSubscriptionFieldsSchema.safeParse(fields);
  const ownerId = legacyFields.success ? legacyFields.data.ownerId : merchant.ownerId;
  if (!ownerId) return null;
  const seats = legacyFields.success ? legacyFields.data.seats : (initialSnapshot?.seats ?? 1);
  const kind =
    legacyFields.success && legacyFields.data.membershipKind
      ? legacyFields.data.membershipKind
      : (initialSnapshot?.initialKind ?? (seats > 1 ? "team" : "individual"));
  const legacyGrants = await transaction
    .select({
      userId: entitlements.userId,
      createdAt: entitlements.createdAt,
      deletedAt: entitlements.deletedAt,
      expiresAt: entitlements.expiresAt,
      metadata: entitlements.metadata,
    })
    .from(entitlements)
    .where(
      and(
        eq(entitlements.sourceId, row.id),
        eq(entitlements.sourceType, STRIPE_SUBSCRIPTION_SOURCE),
      ),
    )
    .limit(MAX_TEAM_SEATS * 2 + 1);
  if (legacyGrants.length > MAX_TEAM_SEATS * 2)
    throw new Error("Legacy subscription roster exceeds the local adoption budget");
  const assignments = new Map<string, { userId: string; assignedAt: number }>();
  let latestPeriodEnd: number | null = null;
  for (const grant of legacyGrants) {
    const periodEnd = grant.expiresAt ? grant.expiresAt.getTime() / 1000 : null;
    if (periodEnd !== null && (latestPeriodEnd === null || periodEnd > latestPeriodEnd))
      latestPeriodEnd = periodEnd;
    const metadata = fieldsSchema.parse(grant.metadata ?? {});
    const status = metadata["status"];
    const legacyStatus = subscriptionSnapshotSchema.shape.status.safeParse(status);
    const billingSuspended =
      legacyStatus.success && !stripeSubscriptionGrantsAccess(legacyStatus.data);
    if (grant.userId && (!grant.deletedAt || billingSuspended) && !assignments.has(grant.userId)) {
      assignments.set(grant.userId, {
        userId: grant.userId,
        assignedAt: grant.createdAt.getTime(),
      });
    }
  }
  if (kind === "individual") {
    assignments.clear();
    assignments.set(ownerId, { userId: ownerId, assignedAt: row.createdAt.getTime() });
  }
  const state = subscriptionStateSchema.parse({
    ownerId,
    kind,
    seats,
    status: row.status,
    currentPeriodEnd: initialSnapshot?.currentPeriodEnd ?? latestPeriodEnd,
    assignments: [...assignments.values()],
    revision: null,
    reduction: null,
  });
  return {
    row: { ...row, organizationId: row.organizationId },
    fields,
    stripeSubscriptionId: merchant.identifier,
    state,
  };
}

type StoredSubscription = NonNullable<Awaited<ReturnType<typeof loadLocked>>>;

async function persist(
  transaction: Transaction,
  stored: StoredSubscription,
  state: SubscriptionState,
  now: number,
) {
  const date = new Date(now);
  const beneficiaries = subscriptionBeneficiaries(state, now);
  const memberships = beneficiaries.length
    ? await transaction
        .select({ id: organizationMemberships.id, userId: organizationMemberships.userId })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.organizationId, stored.row.organizationId),
            inArray(organizationMemberships.userId, beneficiaries),
          ),
        )
        .limit(MAX_TEAM_SEATS * 2 + 1)
    : [];
  if (memberships.length > MAX_TEAM_SEATS * 2)
    throw new Error("Subscription memberships exceed the local row budget");
  const membershipIds = new Map(
    memberships.map((membership) => [membership.userId, membership.id]),
  );
  const missingMemberships = beneficiaries
    .filter((userId) => !membershipIds.has(userId))
    .map((userId) => {
      const id = `subscription-member:${createHash("sha256").update(`${stored.row.organizationId}:${userId}`).digest("hex")}`;
      membershipIds.set(userId, id);
      return { id, userId, invitedById: state.ownerId, organizationId: stored.row.organizationId };
    });
  if (missingMemberships.length)
    await transaction
      .insert(organizationMemberships)
      .values(missingMemberships)
      .onDuplicateKeyUpdate({ set: { userId: sql`VALUES(${organizationMemberships.userId})` } });

  // Grants are a rebuildable projection. Both former ID schemes are retired atomically.
  await transaction
    .update(entitlements)
    .set({ deletedAt: date, updatedAt: date })
    .where(
      and(
        eq(entitlements.sourceId, stored.row.id),
        eq(entitlements.sourceType, STRIPE_SUBSCRIPTION_SOURCE),
        isNull(entitlements.deletedAt),
      ),
    );
  const grantRows = beneficiaries.map((userId) => {
    const membershipId = membershipIds.get(userId);
    if (!membershipId) throw new Error("A subscription beneficiary is missing its membership");
    return {
      id: subscriptionGrantId(stored.stripeSubscriptionId, userId),
      entitlementType: EGGHEAD_SUBSCRIPTION_ENTITLEMENT,
      userId,
      organizationId: stored.row.organizationId,
      organizationMembershipId: membershipId,
      sourceType: STRIPE_SUBSCRIPTION_SOURCE,
      sourceId: stored.row.id,
      metadata: {
        productId: stored.row.productId,
        status: state.status,
        stripeSubscriptionId: stored.stripeSubscriptionId,
      },
      expiresAt: state.currentPeriodEnd ? new Date(state.currentPeriodEnd * 1000) : null,
      deletedAt: null,
      updatedAt: date,
    };
  });
  if (grantRows.length)
    await transaction
      .insert(entitlements)
      .values(grantRows)
      .onDuplicateKeyUpdate({
        set: {
          userId: sql`VALUES(${entitlements.userId})`,
          organizationId: sql`VALUES(${entitlements.organizationId})`,
          entitlementType: EGGHEAD_SUBSCRIPTION_ENTITLEMENT,
          sourceType: STRIPE_SUBSCRIPTION_SOURCE,
          sourceId: stored.row.id,
          organizationMembershipId: sql`VALUES(${entitlements.organizationMembershipId})`,
          metadata: sql`VALUES(${entitlements.metadata})`,
          expiresAt: sql`VALUES(${entitlements.expiresAt})`,
          deletedAt: null,
          updatedAt: date,
        },
      });
  await transaction
    .update(subscription)
    .set({
      status: state.status,
      fields: {
        ...stored.fields,
        ownerId: state.ownerId,
        seats: state.seats,
        membershipKind: state.kind,
        membershipState: state,
      },
    })
    .where(eq(subscription.id, stored.row.id));
}

export function createSubscriptionStore(database: Database, clock: () => number = Date.now) {
  return {
    async reconcile(input: SubscriptionSnapshot) {
      assertLocalDockerDatabaseUrl();
      const snapshot = subscriptionSnapshotSchema.parse(input);
      const [local] = await database
        .select({ id: subscription.id })
        .from(merchantSubscription)
        .innerJoin(subscription, eq(subscription.merchantSubscriptionId, merchantSubscription.id))
        .where(eq(merchantSubscription.identifier, snapshot.stripeSubscriptionId))
        .limit(1);
      if (!local) return { status: "not-ready" } as const;
      const subscriptionId = local.id;
      return database.transaction(async (transaction) => {
        const stored = await loadLocked(transaction, subscriptionId, snapshot);
        if (!stored || stored.stripeSubscriptionId !== snapshot.stripeSubscriptionId)
          return { status: "not-ready" } as const;
        const result = reconcileBilling(stored.state, snapshot);
        if (result.status === "applied") await persist(transaction, stored, result.state, clock());
        return {
          status: result.status,
          subscriptionId,
          assignedSeats: result.state.assignments.length,
        };
      });
    },
    async assignSeat(input: z.infer<typeof commandSchema>) {
      assertLocalDockerDatabaseUrl();
      const command = commandSchema.parse(input);
      return database.transaction(async (transaction) => {
        const stored = await loadLocked(transaction, command.subscriptionId);
        if (!stored) return { status: "not-found" } as const;
        const now = clock();
        const result = assignSubscriptionSeat(stored.state, command.ownerId, command.userId, now);
        if (result.status === "assigned") await persist(transaction, stored, result.state, now);
        return { status: result.status };
      });
    },
    async removeSeat(input: z.infer<typeof commandSchema>) {
      assertLocalDockerDatabaseUrl();
      const command = commandSchema.parse(input);
      return database.transaction(async (transaction) => {
        const stored = await loadLocked(transaction, command.subscriptionId);
        if (!stored) return { status: "not-found" } as const;
        const result = removeSubscriptionSeat(stored.state, command.ownerId, command.userId);
        if (result.status === "removed") await persist(transaction, stored, result.state, clock());
        return { status: result.status };
      });
    },
    async prepareReduction(input: z.infer<typeof reductionSchema>) {
      assertLocalDockerDatabaseUrl();
      const command = reductionSchema.parse(input);
      return database.transaction(async (transaction) => {
        const stored = await loadLocked(transaction, command.subscriptionId);
        if (!stored) return { status: "not-found" } as const;
        const result = prepareSubscriptionReduction(
          stored.state,
          command.ownerId,
          command.seats,
          command.retainedUserIds,
        );
        if (result.status === "prepared") await persist(transaction, stored, result.state, clock());
        return { status: result.status };
      });
    },
  };
}

export function getSubscriptionStore() {
  return createSubscriptionStore(getEggheadDatabase());
}
