import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getEggheadDatabase } from "../db/adapter";
import { assertCommerceWritesAllowed } from "../db/local-docker";
import { entitlements, organizationMemberships, subscription } from "../db/schema";
import { getStripeSubscriptionCurrentPeriodEnd, getStripeSubscriptionQuantity } from "./stripe";
import {
  isTeamSubscription,
  mergeTeamSubscriptionFields,
  subscriptionCheckoutQuantitySchema,
  teamSubscriptionFieldsSchema,
} from "./team-contracts";

export const EGGHEAD_SUBSCRIPTION_ENTITLEMENT = "egghead_all_access_subscription";
export const STRIPE_SUBSCRIPTION_SOURCE = "stripe_subscription";

const ACCESS_GRANTING_STATUSES: Record<string, true | undefined> = {
  active: true,
  past_due: true,
  trialing: true,
};
const TERMINAL_STATUSES: Record<string, true | undefined> = {
  canceled: true,
  incomplete_expired: true,
};

// This status predicate never proves payment. Access also requires an unexpired grant.
export function stripeSubscriptionGrantsAccess(status: string) {
  return ACCESS_GRANTING_STATUSES[status] === true;
}

export function stripeSubscriptionEntitlementId(stripeSubscriptionId: string) {
  return `stripe_ent_${stripeSubscriptionId}`;
}

export function stripeSubscriptionSeatEntitlementId(stripeSubscriptionId: string, userId: string) {
  const seatFingerprint = createHash("sha256")
    .update(`${stripeSubscriptionId}:${userId}`)
    .digest("hex");
  return `stripe_seat_${seatFingerprint}`;
}

export function subscriptionRecord(value: unknown): Record<string, unknown> {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  return parsed.success ? parsed.data : {};
}

const lifecycleSchema = z.object({
  eventCreatedAt: z.number().int().nonnegative(),
  eventId: z.string(),
  paidThrough: z.number().nullable(),
});

export function subscriptionPaidThrough(fields: unknown): Date | null {
  const lifecycle = lifecycleSchema.safeParse(subscriptionRecord(fields)["stripeLifecycle"]);
  return lifecycle.success && lifecycle.data.paidThrough !== null
    ? new Date(lifecycle.data.paidThrough)
    : null;
}

export type SubscriptionGrantState = {
  id: string;
  metadata: unknown;
  expiresAt: Date | null;
  deletedAt: Date | null;
};

// Billing revocation retains seat intent; only deliberate removal releases capacity.
export function subscriptionGrantOccupiesSeat(grant: SubscriptionGrantState) {
  const metadata = subscriptionRecord(grant.metadata);
  return (
    metadata["revocationReason"] !== "seat_removed" &&
    (grant.deletedAt === null || metadata["revocationReason"] === "billing")
  );
}

const invoiceSchema = z.object({
  id: z.string(),
  status: z.string().nullable(),
  subscription: z
    .union([z.string(), z.object({ id: z.string() })])
    .nullable()
    .optional(),
  lines: z.object({
    data: z.array(
      z.object({
        type: z.string(),
        subscription: z
          .union([z.string(), z.object({ id: z.string() })])
          .nullable()
          .optional(),
        period: z.object({ end: z.number() }),
      }),
    ),
    has_more: z.boolean().optional(),
  }),
});
const stripeLifecycleSnapshotSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    trial_end: z.number().nullable().optional(),
    cancel_at_period_end: z.boolean().optional(),
    latest_invoice: z.unknown().optional(),
  })
  .passthrough();

export type StripeSubscriptionSnapshot = {
  status: string;
  seats: number | null;
  currentPeriodEnd: Date | null;
  paidThrough: Date | null;
  invoiceId: string | null;
  cancelAtPeriodEnd: boolean;
};

export function parseStripeSubscriptionSnapshot(
  value: unknown,
  stripeSubscriptionId: string,
): StripeSubscriptionSnapshot {
  const snapshot = stripeLifecycleSnapshotSchema.parse(value);
  if (snapshot.id !== stripeSubscriptionId)
    throw new Error("Stripe subscription identity mismatch.");
  const periodEnd = getStripeSubscriptionCurrentPeriodEnd(snapshot);
  const quantity = subscriptionCheckoutQuantitySchema.safeParse(
    snapshot["items"] ? getStripeSubscriptionQuantity(snapshot) : null,
  );
  const invoice = invoiceSchema.safeParse(snapshot.latest_invoice);
  let paidThrough: number | null = null;
  let invoiceId: string | null = null;

  if (snapshot.status === "trialing" && snapshot.trial_end) {
    paidThrough = snapshot.trial_end;
  } else if (
    snapshot.status === "active" &&
    invoice.success &&
    invoice.data.status === "paid" &&
    !invoice.data.lines.has_more
  ) {
    const invoiceSubscription =
      typeof invoice.data.subscription === "string"
        ? invoice.data.subscription
        : invoice.data.subscription?.id;
    const periods = invoice.data.lines.data.flatMap((line) => {
      const lineSubscription =
        typeof line.subscription === "string" ? line.subscription : line.subscription?.id;
      return line.type === "subscription" &&
        (lineSubscription ?? invoiceSubscription) === stripeSubscriptionId
        ? [line.period.end]
        : [];
    });
    if (periods.length > 0) {
      // Never advance beyond the shortest paid subscription line/current provider period.
      paidThrough = Math.min(...periods);
      invoiceId = invoice.data.id;
    }
  }

  if (paidThrough !== null && periodEnd !== null) paidThrough = Math.min(paidThrough, periodEnd);
  if (!TERMINAL_STATUSES[snapshot.status] && (periodEnd === null || !quantity.success)) {
    throw new Error("Stripe subscription period or quantity is missing or invalid.");
  }

  return {
    status: snapshot.status,
    seats: quantity.success ? quantity.data : null,
    currentPeriodEnd: periodEnd === null ? null : new Date(periodEnd * 1000),
    paidThrough: paidThrough === null ? null : new Date(paidThrough * 1000),
    invoiceId,
    cancelAtPeriodEnd: snapshot.cancel_at_period_end ?? false,
  };
}

export type StripeSubscriptionEvent = {
  id: string;
  createdAt: number;
  kind: "checkout" | "subscription_update" | "subscription_deleted" | "invoice_paid";
};

export function subscriptionEventIsObsolete(fields: unknown, event: StripeSubscriptionEvent) {
  const lifecycle = lifecycleSchema.safeParse(subscriptionRecord(fields)["stripeLifecycle"]);
  return (
    lifecycle.success &&
    (event.createdAt < lifecycle.data.eventCreatedAt || event.id === lifecycle.data.eventId)
  );
}

export function planStripeSubscriptionTransition(input: {
  fields: unknown;
  previousStatus: string;
  grants: SubscriptionGrantState[];
  ownerId: string;
  event: StripeSubscriptionEvent;
  snapshot: StripeSubscriptionSnapshot;
  now: Date;
}) {
  if (
    subscriptionEventIsObsolete(input.fields, input.event) ||
    (TERMINAL_STATUSES[input.previousStatus] && !TERMINAL_STATUSES[input.snapshot.status])
  ) {
    return null;
  }

  const oldFields = teamSubscriptionFieldsSchema.safeParse(input.fields);
  const prior = subscriptionRecord(input.fields);
  const storedLifecycle = subscriptionRecord(prior["stripeLifecycle"]);
  const priorBoundary = subscriptionPaidThrough(input.fields)?.getTime() ?? null;
  const freshBoundary = input.snapshot.paidThrough?.getTime() ?? null;
  // Failed events may carry a new invoice period. It is not proof and cannot add grace.
  const canAdvance = input.snapshot.status === "active" || input.snapshot.status === "trialing";
  const paidThrough =
    canAdvance && freshBoundary !== null
      ? Math.max(priorBoundary ?? 0, freshBoundary)
      : priorBoundary;
  const occupiedSeats = input.grants.filter(subscriptionGrantOccupiesSeat).length;
  const seats = input.snapshot.seats ?? (oldFields.success ? oldFields.data.seats : 1);
  const subscriptionKind =
    oldFields.success && oldFields.data.subscriptionKind
      ? oldFields.data.subscriptionKind
      : input.grants.some((grant) => grant.id.startsWith("stripe_ent_"))
        ? "personal"
        : input.grants.some((grant) => grant.id.startsWith("stripe_seat_")) ||
            isTeamSubscription(input.fields)
          ? "team"
          : oldFields.success
            ? "personal"
            : seats >= 2
              ? "team"
              : "personal";
  const quantityReconciliation =
    seats < occupiedSeats
      ? {
          reason: "below_occupied_seats",
          requestedSeats: seats,
          occupiedSeats,
          detectedAt: input.now.toISOString(),
        }
      : null;
  const fields = {
    ...mergeTeamSubscriptionFields(input.fields, {
      ownerId: oldFields.success ? oldFields.data.ownerId : input.ownerId,
      seats,
      subscriptionKind,
    }),
    stripeLifecycle: {
      ...storedLifecycle,
      eventCreatedAt: input.event.createdAt,
      eventId: input.event.id,
      eventKind: input.event.kind,
      paidThrough,
      currentPeriodEnd: input.snapshot.currentPeriodEnd?.getTime() ?? null,
      cancelAtPeriodEnd: input.snapshot.cancelAtPeriodEnd,
      invoiceId: input.snapshot.invoiceId ?? storedLifecycle["invoiceId"] ?? null,
      quantityReconciliation,
    },
  };
  const grants = input.grants.map((grant) => {
    const oldMetadata = subscriptionRecord(grant.metadata);
    const metadata = {
      ...oldMetadata,
      status: input.snapshot.status,
      stripeEventCreatedAt: input.event.createdAt,
      stripeEventId: input.event.id,
      stripeEventKind: input.event.kind,
      paidThrough,
    };
    // Unknown historical revocations also fail closed; only our billing marker recovers.
    if (!subscriptionGrantOccupiesSeat(grant)) return { ...grant, metadata };
    const grantsAccess =
      stripeSubscriptionGrantsAccess(input.snapshot.status) &&
      paidThrough !== null &&
      paidThrough > input.now.getTime();
    return {
      ...grant,
      metadata: { ...metadata, revocationReason: grantsAccess ? null : "billing" },
      expiresAt: new Date(paidThrough ?? 0),
      deletedAt: grantsAccess ? null : (grant.deletedAt ?? input.now),
    };
  });

  return {
    fields,
    grants,
    status: input.snapshot.status,
    quantityReconciliation,
    subscriptionKind,
  };
}

export async function syncStripeSubscription(input: {
  localSubscriptionId: string;
  stripeSubscriptionId: string;
  ownerId: string;
  event: StripeSubscriptionEvent;
  retrieveCurrentSubscription: () => Promise<unknown>;
}) {
  assertCommerceWritesAllowed();
  const db = getEggheadDatabase();
  return db.transaction(async (transaction) => {
    const [stored] = await transaction
      .select()
      .from(subscription)
      .where(eq(subscription.id, input.localSubscriptionId))
      .for("update");
    if (!stored) throw new Error("Local subscription is not ready for reconciliation.");
    if (subscriptionEventIsObsolete(stored.fields, input.event)) return { ignored: true };

    // Fetch under the shared grant/removal/invitation lock. Same-second Stripe events
    // have no lexical ordering; current provider state is authoritative, not event IDs.
    const snapshot = parseStripeSubscriptionSnapshot(
      await input.retrieveCurrentSubscription(),
      input.stripeSubscriptionId,
    );
    if (input.event.kind === "subscription_deleted" && snapshot.status !== "canceled") {
      throw new Error("Deleted Stripe subscription has not reached terminal provider state.");
    }
    const existingGrants = await transaction
      .select()
      .from(entitlements)
      .where(
        and(
          eq(entitlements.sourceId, stored.id),
          eq(entitlements.sourceType, STRIPE_SUBSCRIPTION_SOURCE),
        ),
      );
    const now = new Date();
    const transition = planStripeSubscriptionTransition({
      fields: stored.fields,
      previousStatus: stored.status,
      grants: existingGrants,
      ownerId: input.ownerId,
      event: input.event,
      snapshot,
      now,
    });
    if (!transition) return { ignored: true };

    if (
      transition.subscriptionKind === "personal" &&
      existingGrants.length === 0 &&
      !TERMINAL_STATUSES[snapshot.status]
    ) {
      if (!stored.organizationId) throw new Error("Personal subscriber organization is missing.");
      const ownerMembership = await transaction.query.organizationMemberships.findFirst({
        where: and(
          eq(organizationMemberships.organizationId, stored.organizationId),
          eq(organizationMemberships.userId, transition.fields.ownerId),
        ),
      });
      if (!ownerMembership)
        throw new Error("Personal subscriber organization membership is missing.");
      const expiresAt = new Date(transition.fields.stripeLifecycle.paidThrough ?? 0);
      const grantsAccess = stripeSubscriptionGrantsAccess(snapshot.status) && expiresAt > now;
      await transaction.insert(entitlements).values({
        id: stripeSubscriptionEntitlementId(input.stripeSubscriptionId),
        entitlementType: EGGHEAD_SUBSCRIPTION_ENTITLEMENT,
        userId: transition.fields.ownerId,
        organizationId: stored.organizationId,
        organizationMembershipId: ownerMembership.id,
        sourceType: STRIPE_SUBSCRIPTION_SOURCE,
        sourceId: stored.id,
        expiresAt,
        deletedAt: grantsAccess ? null : now,
        metadata: {
          productId: stored.productId,
          status: snapshot.status,
          stripeSubscriptionId: input.stripeSubscriptionId,
          stripeEventCreatedAt: input.event.createdAt,
          stripeEventId: input.event.id,
          stripeEventKind: input.event.kind,
          paidThrough: transition.fields.stripeLifecycle.paidThrough,
          revocationReason: grantsAccess ? null : "billing",
        },
      });
    }
    await transition.grants.reduce<Promise<void>>(async (previous, grant) => {
      await previous;
      await transaction
        .update(entitlements)
        .set({
          metadata: grant.metadata,
          expiresAt: grant.expiresAt,
          deletedAt: grant.deletedAt,
          updatedAt: now,
        })
        .where(eq(entitlements.id, grant.id));
    }, Promise.resolve());
    await transaction
      .update(subscription)
      .set({ fields: transition.fields, status: transition.status })
      .where(eq(subscription.id, stored.id));
    if (transition.quantityReconciliation) {
      console.warn("subscription.lifecycle.quantity_quarantined", {
        subscriptionId: stored.id,
        ...transition.quantityReconciliation,
      });
    }
    console.info("subscription.lifecycle.applied", {
      subscriptionId: stored.id,
      status: transition.status,
      subscriptionKind: transition.subscriptionKind,
      grants: transition.grants.length,
      eventKind: input.event.kind,
    });
    return { ignored: false, status: transition.status, seats: transition.fields.seats };
  });
}
