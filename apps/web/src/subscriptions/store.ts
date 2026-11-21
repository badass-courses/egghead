import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
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
  reportSubscriptionAlert,
  reportSubscriptionSkip,
  safeErrorSummary,
  SubscriptionDataError,
} from "./alerts";
import { adoptLegacySubscriptionState, LEGACY_GRANT_READ_LIMIT } from "./legacy-adoption";
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
import type { Owner } from "./ownership/marker";
import { courseBuilderOwnsSubscription, type CommandOwnership } from "./ownership-seam";
import { MAX_TEAM_SEATS, subscriptionCheckoutQuantitySchema } from "./team-contracts";

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

/** The routed ownership of the Stripe event being reconciled (see ownership-seam.ts). */
export type ReconcileOwnership = { owner: Owner; stripeCustomerId: string | null };

/**
 * The membership row the lifecycle creates when a beneficiary has none in the
 * subscription's organization. One per user per organization, shared by every
 * subscription there; an existing row (personal, checkout, legacy) is reused.
 */
export function lifecycleMembershipId(organizationId: string, userId: string) {
  const digest = createHash("sha256").update(`${organizationId}:${userId}`).digest("hex");
  return `subscription-member:${digest}`;
}

/** MySQL errors after which InnoDB has rolled the statement or transaction back. */
const LOCK_CONFLICT_ERRNOS = new Set([1205, 1213]);
export const LOCK_CONFLICT_ATTEMPTS = 3;

function errno(error: unknown): number | null {
  for (let current = error, depth = 0; depth < 4; depth++) {
    if (typeof current !== "object" || current === null) return null;
    const value = Reflect.get(current, "errno");
    if (typeof value === "number") return value;
    current = Reflect.get(current, "cause");
  }
  return null;
}

/** A lock-wait timeout (1205) or deadlock (1213): the whole transaction can run again. */
export function isLockConflict(error: unknown) {
  const code = errno(error);
  return code !== null && LOCK_CONFLICT_ERRNOS.has(code);
}

const jitteredBackoff = (attempt: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, Math.round((20 + Math.random() * 40) * 2 ** (attempt - 1)));
  });

/**
 * Run a whole transaction again when MySQL rolls it back for a lock conflict, up to
 * three attempts with jittered backoff. Each attempt starts from a fresh lock, so a
 * retry re-reads every row; nothing from the failed attempt survives.
 */
export async function retryLockConflicts<T>(
  work: () => Promise<T>,
  wait: (attempt: number) => Promise<void> = jitteredBackoff,
  attempt = 1,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (attempt >= LOCK_CONFLICT_ATTEMPTS || !isLockConflict(error)) throw error;
    await wait(attempt);
    return retryLockConflicts(work, wait, attempt + 1);
  }
}

function dataError(code: SubscriptionDataError["code"], message: string): never {
  throw new SubscriptionDataError(code, message);
}

/** The subscription's Stripe identity, read without a transaction or lock. */
async function readIdentity(database: Database, subscriptionId: string) {
  const [identity] = await database
    .select({
      stripeSubscriptionId: merchantSubscription.identifier,
      stripeCustomerId: merchantCustomer.identifier,
    })
    .from(subscription)
    .innerJoin(
      merchantSubscription,
      eq(merchantSubscription.id, subscription.merchantSubscriptionId),
    )
    .leftJoin(merchantCustomer, eq(merchantCustomer.id, merchantSubscription.merchantCustomerId))
    .where(eq(subscription.id, subscriptionId))
    .limit(1);
  return identity?.stripeSubscriptionId
    ? {
        stripeSubscriptionId: identity.stripeSubscriptionId,
        stripeCustomerId: identity.stripeCustomerId ?? null,
      }
    : null;
}

/** Lock the subscription row and read its Stripe identity. No decoding yet. */
async function lockRow(transaction: Transaction, subscriptionId: string) {
  const [row] = await transaction
    .select()
    .from(subscription)
    .where(eq(subscription.id, subscriptionId))
    .for("update");
  if (!row) return null;
  const [merchant] = await transaction
    .select({
      identifier: merchantSubscription.identifier,
      ownerId: merchantCustomer.userId,
      customerIdentifier: merchantCustomer.identifier,
    })
    .from(merchantSubscription)
    .leftJoin(merchantCustomer, eq(merchantCustomer.id, merchantSubscription.merchantCustomerId))
    .where(eq(merchantSubscription.id, row.merchantSubscriptionId))
    .limit(1);
  return { row, merchant: merchant ?? null };
}

type LockedRow = NonNullable<Awaited<ReturnType<typeof lockRow>>>;

/** Decode the locked row. Data no retry can fix throws SubscriptionDataError. */
async function decodeLocked(
  transaction: Transaction,
  locked: LockedRow,
  initialSnapshot?: SubscriptionSnapshot,
) {
  const { row, merchant } = locked;
  if (!row.organizationId || !merchant?.identifier)
    dataError(
      "incomplete-subscription-row",
      "The subscription row has no organization or Stripe subscription",
    );
  const parsedFields = fieldsSchema.safeParse(row.fields ?? {});
  if (!parsedFields.success)
    dataError("invalid-subscription-state", "Subscription fields are not an object");
  const fields = parsedFields.data;
  const base = {
    row: { ...row, organizationId: row.organizationId },
    fields,
    stripeSubscriptionId: merchant.identifier,
  };
  if (fields["membershipState"] !== undefined) {
    const state = subscriptionStateSchema.safeParse(fields["membershipState"]);
    if (!state.success)
      dataError("invalid-subscription-state", "Stored membership state does not decode");
    return { ...base, state: state.data };
  }
  const grants = await transaction
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
    .limit(LEGACY_GRANT_READ_LIMIT);
  const state = adoptLegacySubscriptionState({
    fields,
    merchantOwnerId: merchant.ownerId ?? null,
    rowStatus: row.status,
    rowCreatedAt: row.createdAt,
    grants,
    initialSnapshot,
  });
  return { ...base, state };
}

type StoredSubscription = Awaited<ReturnType<typeof decodeLocked>>;

async function persist(
  transaction: Transaction,
  stored: StoredSubscription,
  state: SubscriptionState,
  now: number,
) {
  const date = new Date(now);
  // One boundary field for Rails projection and Stripe lifecycle, including
  // suspended/canceled rows. deletedAt denies access when there are no beneficiaries.
  const expiresAt =
    state.currentPeriodEnd === null ? null : new Date(state.currentPeriodEnd * 1000);
  const subscriptionId = stored.row.id;
  const organizationId = stored.row.organizationId;
  const beneficiaryIds = subscriptionBeneficiaries(state, now);
  const retainedUserIds = new Set(state.assignments.map((assignment) => assignment.userId));
  const departedUserIds = stored.state.assignments
    .map((assignment) => assignment.userId)
    .filter((userId) => !retainedUserIds.has(userId) && userId !== state.ownerId);

  // One membership per user per organization. Lock the rows for everyone this
  // write touches, so a concurrent writer for another subscription in the same
  // organization waits instead of deleting a row this one is about to reuse.
  const touched = [...beneficiaryIds, ...departedUserIds];
  const memberships = touched.length
    ? await transaction
        .select({ id: organizationMemberships.id, userId: organizationMemberships.userId })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.organizationId, organizationId),
            inArray(organizationMemberships.userId, touched),
          ),
        )
        .orderBy(asc(organizationMemberships.createdAt), asc(organizationMemberships.id))
        .limit(MAX_TEAM_SEATS * 4)
        .for("update")
    : [];
  const membershipFor = new Map<string, string>();
  for (const membership of memberships)
    if (!membershipFor.has(membership.userId)) membershipFor.set(membership.userId, membership.id);
  const beneficiaries = beneficiaryIds.map((userId) => ({
    userId,
    membershipId: membershipFor.get(userId) ?? lifecycleMembershipId(organizationId, userId),
  }));
  const missingMemberships = beneficiaries
    .filter((beneficiary) => !membershipFor.has(beneficiary.userId))
    .map((beneficiary) => ({
      id: beneficiary.membershipId,
      userId: beneficiary.userId,
      invitedById: state.ownerId,
      organizationId,
    }));
  if (missingMemberships.length)
    await transaction
      .insert(organizationMemberships)
      .values(missingMemberships)
      .onDuplicateKeyUpdate({ set: { userId: sql`VALUES(${organizationMemberships.userId})` } });

  // A member who leaves the roster loses the membership row the lifecycle created
  // for them, unless another live grant in this organization still uses it. Rows
  // the lifecycle did not create (personal, checkout, legacy) are never removed;
  // they confer no access without a grant (see getCurrentSubscriptionForUser).
  const departedMembershipIds = departedUserIds
    .map((userId) => lifecycleMembershipId(organizationId, userId))
    .filter((id) => memberships.some((membership) => membership.id === id));
  if (departedMembershipIds.length) {
    // A locking read: a plain read would see the snapshot taken before the lock wait.
    const stillUsed = await transaction
      .select({ membershipId: entitlements.organizationMembershipId })
      .from(entitlements)
      .where(
        and(
          inArray(entitlements.userId, departedUserIds),
          eq(entitlements.organizationId, organizationId),
          inArray(entitlements.organizationMembershipId, departedMembershipIds),
          isNull(entitlements.deletedAt),
          or(
            ne(entitlements.sourceId, subscriptionId),
            ne(entitlements.sourceType, STRIPE_SUBSCRIPTION_SOURCE),
          ),
        ),
      )
      .limit(MAX_TEAM_SEATS * 4)
      .for("share");
    const used = new Set(stillUsed.map((grant) => grant.membershipId));
    const removable = departedMembershipIds.filter((id) => !used.has(id));
    if (removable.length)
      await transaction
        .delete(organizationMemberships)
        .where(inArray(organizationMemberships.id, removable));
  }

  // Grants are a rebuildable projection. Both former ID schemes are retired atomically.
  await transaction
    .update(entitlements)
    .set({ deletedAt: date, expiresAt, updatedAt: date })
    .where(
      and(
        eq(entitlements.sourceId, subscriptionId),
        eq(entitlements.sourceType, STRIPE_SUBSCRIPTION_SOURCE),
        isNull(entitlements.deletedAt),
      ),
    );
  const grantRows = beneficiaries.map(({ userId, membershipId }) => ({
    id: subscriptionGrantId(stored.stripeSubscriptionId, userId),
    entitlementType: EGGHEAD_SUBSCRIPTION_ENTITLEMENT,
    userId,
    organizationId: stored.row.organizationId,
    organizationMembershipId: membershipId,
    sourceType: STRIPE_SUBSCRIPTION_SOURCE,
    sourceId: subscriptionId,
    metadata: {
      productId: stored.row.productId,
      status: state.status,
      stripeSubscriptionId: stored.stripeSubscriptionId,
    },
    expiresAt,
    deletedAt: null,
    updatedAt: date,
  }));
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
          sourceId: subscriptionId,
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
    .where(eq(subscription.id, subscriptionId));
}

export function createSubscriptionStore(
  database: Database,
  clock: () => number = Date.now,
  commandOwnership: CommandOwnership = courseBuilderOwnsSubscription,
) {
  /**
   * Commands without a Stripe event read the subscription's Stripe identity, ask
   * the ownership seam (a live Stripe marker read, outside any lock), then lock the
   * row and confirm the identity did not change in between. A non-owned
   * subscription reads as not-found, which every /team action treats as unavailable.
   */
  async function owned(subscriptionId: string) {
    const identity = await readIdentity(database, subscriptionId);
    if (!identity) return null;
    try {
      return (await commandOwnership({ ...identity, now: clock() })) ? identity : null;
    } catch (error) {
      // A Stripe outage must not turn /team into a 500: the subscription reads as
      // unavailable, and the failure is an alert. Never act without the marker.
      reportSubscriptionAlert("ownership-read-failed", {
        subscriptionId,
        errorName: safeErrorSummary(error).name,
        errorCode: safeErrorSummary(error).code,
      });
      return null;
    }
  }

  async function command<T>(
    subscriptionId: string,
    run: (transaction: Transaction, stored: StoredSubscription) => Promise<T>,
  ) {
    const identity = await owned(subscriptionId);
    if (!identity) return { status: "not-found" } as const;
    try {
      return await retryLockConflicts(() =>
        database.transaction(async (transaction) => {
          const locked = await lockRow(transaction, subscriptionId);
          if (
            !locked ||
            locked.merchant?.identifier !== identity.stripeSubscriptionId ||
            (locked.merchant.customerIdentifier ?? null) !== identity.stripeCustomerId
          )
            return { status: "not-found" } as const;
          return run(transaction, await decodeLocked(transaction, locked));
        }),
      );
    } catch (error) {
      if (!(error instanceof SubscriptionDataError)) throw error;
      reportSubscriptionSkip(error.code, { subscriptionId });
      return { status: "not-found" } as const;
    }
  }

  return {
    /**
     * Apply a Stripe billing observation. `ownership` is the event's routed owner,
     * decided once by the caller: anything but CB is acknowledged before any read.
     */
    async reconcile(input: SubscriptionSnapshot, ownership: ReconcileOwnership) {
      assertLocalDockerDatabaseUrl();
      const snapshot = subscriptionSnapshotSchema.parse(input);
      if (ownership.owner !== "cb") return { status: "not-owner", subscriptionId: null } as const;
      // Outside the transaction on purpose: a plain read inside it would fix the
      // REPEATABLE READ snapshot before the row lock, so later plain reads would
      // miss changes committed while this transaction waited for the lock.
      const matches = await database
        .select({ id: subscription.id })
        .from(merchantSubscription)
        .innerJoin(subscription, eq(subscription.merchantSubscriptionId, merchantSubscription.id))
        .where(eq(merchantSubscription.identifier, snapshot.stripeSubscriptionId))
        .orderBy(asc(subscription.createdAt), asc(subscription.id))
        .limit(2);
      if (matches.length > 1)
        reportSubscriptionAlert("duplicate-stripe-subscription", {
          stripeSubscriptionId: snapshot.stripeSubscriptionId,
          reconciledSubscriptionId: matches[0]?.id,
        });
      const local = matches[0];
      return retryLockConflicts(() =>
        database.transaction(async (transaction) => {
          const locked = local ? await lockRow(transaction, local.id) : null;
          // Only a missing local row can still appear on retry (checkout writes it).
          if (!local || !locked) return { status: "not-ready" } as const;
          // The decision was made for one Stripe customer; the locked row must still
          // belong to it. A row re-keyed to another customer is data, not a race.
          const lockedCustomer = locked.merchant?.customerIdentifier ?? null;
          if (
            ownership.stripeCustomerId !== null &&
            lockedCustomer !== null &&
            lockedCustomer !== ownership.stripeCustomerId
          )
            dataError(
              "customer-mismatch",
              "The locked row belongs to another Stripe customer than the routed event",
            );
          const stored = await decodeLocked(transaction, locked, snapshot);
          if (stored.stripeSubscriptionId !== snapshot.stripeSubscriptionId)
            dataError(
              "stripe-id-mismatch",
              "The locked row belongs to another Stripe subscription",
            );
          // A team's seat count must come from Stripe; never read a missing quantity as 1.
          if (snapshot.seatsReported === false && stored.state.kind === "team")
            dataError(
              "unsupported-stripe-shape",
              "A team subscription's Stripe item has no quantity",
            );
          const result = reconcileBilling(stored.state, snapshot);
          if (result.status === "applied")
            await persist(transaction, stored, result.state, clock());
          return {
            status: result.status,
            subscriptionId: local.id,
            assignedSeats: result.state.assignments.length,
          };
        }),
      );
    },
    /** Whether CourseBuilder may act on this subscription now (for actions without writes). */
    async owns(input: { subscriptionId: string }) {
      assertLocalDockerDatabaseUrl();
      return (await owned(idSchema.parse(input.subscriptionId))) !== null;
    },
    async assignSeat(input: z.infer<typeof commandSchema>) {
      assertLocalDockerDatabaseUrl();
      const parsed = commandSchema.parse(input);
      return command(parsed.subscriptionId, async (transaction, stored) => {
        const now = clock();
        // Under the lock, the row's own status must grant access too: lifecycle
        // state and the status column can disagree when another writer moved one.
        if (!stripeSubscriptionGrantsAccess(stored.row.status))
          return { status: "not-found" } as const;
        const result = assignSubscriptionSeat(stored.state, parsed.ownerId, parsed.userId, now);
        if (result.status === "assigned") await persist(transaction, stored, result.state, now);
        return { status: result.status };
      });
    },
    async removeSeat(input: z.infer<typeof commandSchema>) {
      assertLocalDockerDatabaseUrl();
      const parsed = commandSchema.parse(input);
      return command(parsed.subscriptionId, async (transaction, stored) => {
        const result = removeSubscriptionSeat(stored.state, parsed.ownerId, parsed.userId);
        if (result.status === "removed") await persist(transaction, stored, result.state, clock());
        return { status: result.status };
      });
    },
    async prepareReduction(input: z.infer<typeof reductionSchema>) {
      assertLocalDockerDatabaseUrl();
      const parsed = reductionSchema.parse(input);
      return command(parsed.subscriptionId, async (transaction, stored) => {
        const now = clock();
        const result = prepareSubscriptionReduction(
          stored.state,
          parsed.ownerId,
          parsed.seats,
          parsed.retainedUserIds,
          now,
        );
        if (result.status === "prepared") await persist(transaction, stored, result.state, now);
        return { status: result.status };
      });
    },
  };
}

export function getSubscriptionStore() {
  return createSubscriptionStore(getEggheadDatabase());
}
