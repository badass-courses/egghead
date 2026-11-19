import { z } from "zod";

import { stripeSubscriptionGrantsAccess } from "./access";
import { SubscriptionDataError } from "./alerts";
import {
  subscriptionAvailableSeats,
  subscriptionInviteState,
  type InviteSeatState,
  subscriptionSnapshotSchema,
  subscriptionStateSchema,
  type SubscriptionSnapshot,
  type SubscriptionState,
} from "./lifecycle";
import { MAX_TEAM_SEATS, teamSubscriptionFieldsSchema } from "./team-contracts";

/** Rows read per legacy subscription; one more than the budget, to detect overruns. */
export const LEGACY_GRANT_READ_LIMIT = MAX_TEAM_SEATS * 2 + 1;

export type LegacyGrant = {
  userId: string | null;
  createdAt: Date;
  deletedAt: Date | null;
  expiresAt: Date | null;
  metadata: unknown;
};

const recordSchema = z.record(z.string(), z.unknown());

function dataError(code: SubscriptionDataError["code"], message: string): never {
  throw new SubscriptionDataError(code, message);
}

/**
 * Lifecycle state for a row written before lifecycle state existed, rebuilt from
 * its grants. The store adopts under its row lock; the invite pages use the same
 * function, so availability shown on a page matches what the seat writer decides.
 * This is a local compatibility adapter, not a production backfill.
 */
export function adoptLegacySubscriptionState(input: {
  fields: Record<string, unknown>;
  merchantOwnerId: string | null;
  rowStatus: string;
  rowCreatedAt: Date;
  grants: LegacyGrant[];
  initialSnapshot?: SubscriptionSnapshot | undefined;
}): SubscriptionState {
  const { fields, initialSnapshot } = input;
  const legacyFields = teamSubscriptionFieldsSchema.safeParse(fields);
  const ownerId = legacyFields.success ? legacyFields.data.ownerId : input.merchantOwnerId;
  if (!ownerId) dataError("incomplete-subscription-row", "The subscription has no owner");
  const seats = legacyFields.success ? legacyFields.data.seats : (initialSnapshot?.seats ?? 1);
  if (input.grants.length > MAX_TEAM_SEATS * 2)
    dataError(
      "roster-budget-exceeded",
      "Legacy subscription roster exceeds the local adoption budget",
    );
  const assignments = new Map<string, { userId: string; assignedAt: number }>();
  let latestPeriodEnd: number | null = null;
  for (const grant of input.grants) {
    const periodEnd = grant.expiresAt ? grant.expiresAt.getTime() / 1000 : null;
    if (periodEnd !== null && (latestPeriodEnd === null || periodEnd > latestPeriodEnd))
      latestPeriodEnd = periodEnd;
    const metadata = recordSchema.safeParse(grant.metadata ?? {});
    if (!metadata.success)
      dataError("invalid-grant-metadata", "A legacy subscription grant has non-object metadata");
    const legacyStatus = subscriptionSnapshotSchema.shape.status.safeParse(metadata.data["status"]);
    const billingSuspended =
      legacyStatus.success && !stripeSubscriptionGrantsAccess(legacyStatus.data);
    if (grant.userId && (!grant.deletedAt || billingSuspended) && !assignments.has(grant.userId))
      assignments.set(grant.userId, {
        userId: grant.userId,
        assignedAt: grant.createdAt.getTime(),
      });
  }
  // Kind: an explicit classification wins. Otherwise a row that holds or pays for
  // more than one seat is a team, whatever checkout's original `bulk` said: a
  // main-era purchase at quantity 1 later raised to 3 seats must keep its members.
  // Commands (no snapshot) and reconciliation (with one) then adopt the same kind.
  const paidSeats = Math.max(seats, initialSnapshot?.seats ?? 0);
  const hasMembers = [...assignments.keys()].some((userId) => userId !== ownerId);
  const kind =
    legacyFields.success && legacyFields.data.membershipKind
      ? legacyFields.data.membershipKind
      : paidSeats > 1 || hasMembers
        ? "team"
        : (initialSnapshot?.initialKind ?? "individual");
  if (kind === "individual") {
    assignments.clear();
    assignments.set(ownerId, { userId: ownerId, assignedAt: input.rowCreatedAt.getTime() });
  }
  const status = subscriptionSnapshotSchema.shape.status.safeParse(input.rowStatus);
  if (!status.success)
    dataError("unknown-subscription-status", "The subscription row has an unsupported status");
  // More live users than a roster may hold: data no retry can fix, never a ZodError.
  if (assignments.size > MAX_TEAM_SEATS)
    dataError("roster-budget-exceeded", "Legacy subscription roster exceeds the seat limit");
  const state = subscriptionStateSchema.safeParse({
    ownerId,
    kind,
    seats,
    status: status.data,
    currentPeriodEnd: initialSnapshot?.currentPeriodEnd ?? latestPeriodEnd,
    assignments: [...assignments.values()],
    revision: null,
    reduction: null,
  });
  if (!state.success)
    dataError("invalid-subscription-state", "Adopted legacy state does not decode");
  return state.data;
}

/** Lifecycle state for any row: stored state when present, otherwise legacy adoption. */
function rowState(input: {
  fields: unknown;
  rowStatus: string;
  rowCreatedAt: Date;
  grants: LegacyGrant[];
}): SubscriptionState | null {
  const fields = recordSchema.safeParse(input.fields ?? {});
  if (!fields.success) return null;
  const stored = fields.data["membershipState"];
  if (stored !== undefined) {
    const state = subscriptionStateSchema.safeParse(stored);
    return state.success ? state.data : null;
  }
  try {
    return adoptLegacySubscriptionState({
      fields: fields.data,
      merchantOwnerId: null,
      rowStatus: input.rowStatus,
      rowCreatedAt: input.rowCreatedAt,
      grants: input.grants,
    });
  } catch (error) {
    if (error instanceof SubscriptionDataError) return null;
    throw error;
  }
}

type RowInput = {
  fields: unknown;
  rowStatus: string;
  rowCreatedAt: Date;
  grants: LegacyGrant[];
  now: number;
};

/**
 * Seats a new member can take on this row, by the seat writer's own rule: stored
 * lifecycle state when present, otherwise the same legacy adoption the store runs
 * under its lock. A row that cannot be decoded offers no seats.
 */
export function rowAvailableSeats(input: RowInput) {
  const state = rowState(input);
  return state ? subscriptionAvailableSeats(state, input.now) : 0;
}

/** The invite state for this row; a row that cannot be decoded is closed. */
export function rowInviteState(input: RowInput): InviteSeatState {
  const state = rowState(input);
  return state ? subscriptionInviteState(state, input.now) : "closed";
}
