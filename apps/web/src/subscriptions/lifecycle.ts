import { z } from "zod";

import { stripeSubscriptionGrantsAccess } from "./access";
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
    initialKind: z.enum(["individual", "team"]).optional(),
    currentPeriodEnd: z.number().int().positive().nullable(),
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
      previous.createdAt > incoming.createdAt ||
      (previous.createdAt === incoming.createdAt &&
        (eventPriority[previous.kind] > eventPriority[incoming.kind] ||
          (eventPriority[previous.kind] === eventPriority[incoming.kind] &&
            previous.observedAt > incoming.observedAt))))
  )
    return { status: "unchanged", state } as const;

  const reduction = state.reduction;
  const applyReduction =
    reduction && snapshot.seats === reduction.seats && snapshot.seats <= state.seats;
  const assignments = applyReduction
    ? state.assignments.filter((assignment) =>
        reduction.retainedUserIds.includes(assignment.userId),
      )
    : state.assignments;
  return {
    status: "applied",
    state: {
      ...state,
      seats: snapshot.seats,
      status: snapshot.status,
      currentPeriodEnd: snapshot.currentPeriodEnd,
      revision: incoming,
      assignments,
      reduction: applyReduction ? null : reduction,
    },
  } as const;
}

export function subscriptionNeedsCapacityReview(state: SubscriptionState) {
  return state.assignments.length > state.seats;
}

export function subscriptionBeneficiaries(state: SubscriptionState, now: number) {
  if (
    !stripeSubscriptionGrantsAccess(state.status) ||
    !state.currentPeriodEnd ||
    state.currentPeriodEnd * 1000 <= now ||
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
  if (state.assignments.length >= state.seats) return { status: "full", state } as const;
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
) {
  const retained = new Set(retainedUserIds);
  if (
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
  if (subscriptionNeedsCapacityReview(state) && seats === state.seats)
    return {
      status: "prepared",
      state: {
        ...state,
        assignments: state.assignments.filter((assignment) => retained.has(assignment.userId)),
        reduction: null,
      },
    } as const;
  return {
    status: "prepared",
    state: { ...state, reduction: { seats, retainedUserIds } },
  } as const;
}
