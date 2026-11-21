import { z } from "zod";

import { stripeSubscriptionGrantsAccess } from "./access";
import { accessGranted, strictPaidThroughRule } from "./ownership/access-rule";
import { MAX_TEAM_SEATS, subscriptionCheckoutQuantitySchema } from "./team-contracts";

export const billingEventSchema = z.object({
  id: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  observedAt: z.number().int().nonnegative(),
  kind: z.enum(["checkout", "subscription_update", "subscription_deleted"]),
});
export const subscriptionSnapshotSchema = z
  .object({
    stripeSubscriptionId: z.string().min(1).max(191),
    status: z.enum([
      "active",
      "past_due",
      "trialing",
      "unpaid",
      "canceled",
      "paused",
      "incomplete",
      "incomplete_expired",
    ]),
    seats: subscriptionCheckoutQuantitySchema,
    // False when Stripe reported no quantity and `seats` is only a placeholder.
    // A team never reconciles such a snapshot (the store raises a data error).
    seatsReported: z.boolean().optional(),
    initialKind: z.enum(["individual", "team"]).optional(),
    currentPeriodEnd: z.number().int().positive().nullable(),
    // The Stripe customer, for the ownership seam. Absent on older observations.
    stripeCustomerId: z.string().min(1).max(191).nullable().optional(),
    event: billingEventSchema,
  })
  .refine(
    (snapshot) =>
      !stripeSubscriptionGrantsAccess(snapshot.status) || snapshot.currentPeriodEnd !== null,
    "An eligible subscription must have a billing period",
  )
  .refine(
    (snapshot) => snapshot.event.kind !== "subscription_deleted" || snapshot.status === "canceled",
    "A final cancellation must have canceled billing state",
  );
export type SubscriptionSnapshot = z.infer<typeof subscriptionSnapshotSchema>;

const assignmentSchema = z.object({
  userId: z.string().min(1).max(191),
  assignedAt: z.number().int().nonnegative(),
});
export const subscriptionStateSchema = z.object({
  ownerId: z.string().min(1).max(191),
  kind: z.enum(["individual", "team"]),
  seats: subscriptionCheckoutQuantitySchema,
  status: subscriptionSnapshotSchema.shape.status,
  currentPeriodEnd: z.number().int().positive().nullable(),
  assignments: z
    .array(assignmentSchema)
    .max(MAX_TEAM_SEATS)
    .refine(
      (assignments) =>
        new Set(assignments.map((assignment) => assignment.userId)).size === assignments.length,
      "Seat assignments must be unique",
    ),
  revision: billingEventSchema.nullable(),
  reduction: z
    .object({
      seats: subscriptionCheckoutQuantitySchema,
      retainedUserIds: z.array(z.string().min(1).max(191)).max(MAX_TEAM_SEATS),
      // When the owner saved the plan (ms). Members assigned later are kept.
      savedAt: z.number().int().nonnegative().default(0),
      // The billing period the plan was saved in. The first observation of a
      // later period either applies the plan or drops it.
      periodEnd: z.number().int().positive().nullable().default(null),
    })
    .nullable(),
});
export type SubscriptionState = z.infer<typeof subscriptionStateSchema>;

const eventPriority = { checkout: 0, subscription_update: 1, subscription_deleted: 2 };

export function reconcileBilling(state: SubscriptionState, snapshot: SubscriptionSnapshot) {
  const previous = state.revision;
  const incoming = snapshot.event;
  if (
    (state.status === "canceled" || state.status === "incomplete_expired") &&
    state.status !== snapshot.status
  )
    return { status: "unchanged", state } as const;
  if (
    previous &&
    (previous.id === incoming.id ||
      previous.observedAt > incoming.observedAt ||
      (previous.observedAt === incoming.observedAt &&
        (previous.createdAt > incoming.createdAt ||
          (previous.createdAt === incoming.createdAt &&
            eventPriority[previous.kind] > eventPriority[incoming.kind]))))
  )
    return { status: "unchanged", state } as const;

  const reduction = state.reduction;
  const applyReduction =
    reduction !== null && snapshot.seats === reduction.seats && snapshot.seats <= state.seats;
  // A plan only waits for the next renewal: once billing reports a later period
  // without the planned quantity, the plan is dropped instead of firing whenever
  // the quantity happens to match again.
  const renewedPastPlan =
    reduction !== null &&
    (reduction.periodEnd === null ||
      (snapshot.currentPeriodEnd !== null && snapshot.currentPeriodEnd > reduction.periodEnd));
  const assignments = applyReduction
    ? state.assignments.filter((assignment) => reductionRetains(reduction, assignment))
    : state.assignments;
  // A one-seat purchase whose paid quantity rises above one becomes a team; the
  // owner keeps their seat. Teams never turn back into individuals.
  const kind = state.kind === "individual" && snapshot.seats > 1 ? "team" : state.kind;
  return {
    status: "applied",
    state: {
      ...state,
      kind,
      seats: snapshot.seats,
      status: snapshot.status,
      currentPeriodEnd: snapshot.currentPeriodEnd,
      // A late-delivered event may trigger a fresher Stripe read. Keep that
      // observation, but never move the event-created watermark backwards.
      revision: { ...incoming, createdAt: Math.max(previous?.createdAt ?? 0, incoming.createdAt) },
      assignments,
      reduction: applyReduction || renewedPastPlan ? null : reduction,
    },
  } as const;
}

type Reduction = NonNullable<SubscriptionState["reduction"]>;
type Assignment = SubscriptionState["assignments"][number];

/** Retained = the owner's saved list plus anyone assigned after it was saved. */
function reductionRetains(reduction: Reduction, assignment: Assignment) {
  return (
    reduction.retainedUserIds.includes(assignment.userId) ||
    assignment.assignedAt > reduction.savedAt
  );
}

/**
 * Seats a new member can take now. The seat writer and the invite pages share
 * this rule. With a plan pending, a new member is retained when it applies, so
 * the retained roster must also fit the planned capacity.
 */
export function subscriptionAvailableSeats(state: SubscriptionState, now: number) {
  if (
    state.kind !== "team" ||
    !stripeSubscriptionGrantsAccess(state.status) ||
    !state.currentPeriodEnd ||
    state.currentPeriodEnd * 1000 <= now
  )
    return 0;
  const reduction = state.reduction;
  const plannedRoom = reduction
    ? reduction.seats -
      state.assignments.filter((assignment) => reductionRetains(reduction, assignment)).length
    : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(state.seats - state.assignments.length, plannedRoom));
}

export type InviteSeatState = "open" | "full" | "paused" | "closed";

/**
 * What an invite to this subscription can say. "open" exactly when
 * `subscriptionAvailableSeats` is positive, so an invite never offers a seat the
 * writer refuses. "paused" covers a team waiting on billing (unpaid, paused,
 * incomplete, a lapsed period) or on the owner's capacity review; "closed" a team
 * that ended or a subscription that is not a team.
 */
export function subscriptionInviteState(state: SubscriptionState, now: number): InviteSeatState {
  if (state.kind !== "team" || state.status === "canceled" || state.status === "incomplete_expired")
    return "closed";
  if (subscriptionAvailableSeats(state, now) > 0) return "open";
  if (
    !stripeSubscriptionGrantsAccess(state.status) ||
    !state.currentPeriodEnd ||
    state.currentPeriodEnd * 1000 <= now ||
    subscriptionNeedsCapacityReview(state)
  )
    return "paused";
  return "full";
}

export function subscriptionNeedsCapacityReview(state: SubscriptionState) {
  return state.assignments.length > state.seats;
}

export function subscriptionBeneficiaries(state: SubscriptionState, now: number) {
  if (
    !accessGranted(
      strictPaidThroughRule.evaluate({
        status: state.status,
        paidThroughAt: state.currentPeriodEnd,
        now: now / 1000,
      }),
    ) ||
    subscriptionNeedsCapacityReview(state)
  )
    return [];
  return state.assignments.map((assignment) => assignment.userId);
}

export function assignSubscriptionSeat(
  state: SubscriptionState,
  actorId: string,
  userId: string,
  now: number,
) {
  if (
    state.ownerId !== actorId ||
    state.kind !== "team" ||
    !stripeSubscriptionGrantsAccess(state.status) ||
    !state.currentPeriodEnd ||
    state.currentPeriodEnd * 1000 <= now
  )
    return { status: "not-found", state } as const;
  if (state.assignments.some((assignment) => assignment.userId === userId))
    return { status: "already-assigned", state } as const;
  if (subscriptionAvailableSeats(state, now) === 0) return { status: "full", state } as const;
  const updated: SubscriptionState = {
    ...state,
    assignments: [...state.assignments, { userId, assignedAt: now }],
  };
  return { status: "assigned", state: updated } as const;
}

export function removeSubscriptionSeat(state: SubscriptionState, actorId: string, userId: string) {
  if (state.ownerId !== actorId || state.kind !== "team")
    return { status: "not-found", state } as const;
  if (actorId === userId) return { status: "owner", state } as const;
  return {
    status: "removed",
    state: {
      ...state,
      assignments: state.assignments.filter((assignment) => assignment.userId !== userId),
    },
  } as const;
}

export function prepareSubscriptionReduction(
  state: SubscriptionState,
  actorId: string,
  seats: number,
  retainedUserIds: string[],
  now: number,
) {
  const retained = new Set(retainedUserIds);
  // The owner always keeps a seat: an empty or owner-less selection would remove
  // everyone, the owner included, once Stripe's quantity matched.
  if (
    retained.size === 0 ||
    !retained.has(actorId) ||
    state.ownerId !== actorId ||
    state.kind !== "team" ||
    seats > state.seats ||
    retained.size !== retainedUserIds.length ||
    retained.size > seats ||
    retainedUserIds.some(
      (userId) => !state.assignments.some((assignment) => assignment.userId === userId),
    )
  )
    return { status: "invalid-selection", state } as const;
  // An unplanned external reduction pauses grants until the owner resolves its roster.
  const capacityReview = subscriptionNeedsCapacityReview(state) && seats === state.seats;
  if (capacityReview)
    return {
      status: "prepared",
      state: {
        ...state,
        assignments: state.assignments.filter((assignment) => retained.has(assignment.userId)),
        reduction: null,
      },
    } as const;
  // Outside capacity review a plan must actually reduce capacity; otherwise the
  // next ordinary renewal at the same quantity would silently drop members.
  if (seats >= state.seats) return { status: "invalid-selection", state } as const;
  return {
    status: "prepared",
    state: {
      ...state,
      reduction: { seats, retainedUserIds, savedAt: now, periodEnd: state.currentPeriodEnd },
    },
  } as const;
}
