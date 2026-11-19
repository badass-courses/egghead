// Commerce handover state machine: one owner per Stripe subscription at any moment.
//
// Pure: no Stripe, DB, clock or logger. The caller persists the returned record before
// running the returned effects, and serializes calls per subscription (the Inngest
// concurrency key on the subscription id already does this for webhook handlers).
//
// Rule that keeps exactly one side acting: the live Stripe marker decides who acts on
// an event. Rails acts when the marker is not `cb`; CourseBuilder acts when it is. The
// CB row records intent, drives the marker write, and keeps history. It never
// overrides the marker. See docs/adr/0001-subscription-ownership-handover.md.
//
// The shape maps 1:1 onto an XState `setup({ guards, actions })` machine: states are
// `OwnershipState`, events are `OwnershipEvent`, guards are `handoverRejections` and
// friends, actions are the returned `OwnershipEffect`s. The repo does not depend on
// XState today, so this is a typed transition function instead.

import {
  accessGranted,
  lenientStatusRule,
  type AccessRule,
  type StripeSubscriptionStatus,
} from "./access-rule";
import {
  ownerMarkerIdempotencyKey,
  ownerMarkerMetadata,
  type Owner,
  type OwnerMarker,
} from "./marker";

export type OwnershipState = "rails_owned" | "handover_pending" | "cb_owned" | "handback_pending";

export interface PendingMarkerWrite {
  /** Generation of the marker being written. Always above every generation seen so far. */
  readonly generation: number;
  readonly batchId: string;
  /** Write attempts made for this generation, including the first. */
  readonly attempts: number;
  readonly requestedAt: number;
}

interface RecordBase {
  readonly subscriptionId: string;
  /** Highest marker generation CB has written or observed. */
  readonly generation: number;
  /** Epoch seconds of the last change. */
  readonly updatedAt: number;
}

export type OwnershipRecord =
  | (RecordBase & { readonly state: "rails_owned" })
  | (RecordBase & { readonly state: "cb_owned" })
  | (RecordBase & { readonly state: "handover_pending"; readonly pending: PendingMarkerWrite })
  | (RecordBase & { readonly state: "handback_pending"; readonly pending: PendingMarkerWrite });

export interface TeamSeatFacts {
  readonly quantity: number;
  /** CB holds the seat roster (members and invites) for this subscription. */
  readonly seatsProjectedToCb: boolean;
  /** A quantity change or seat release is scheduled or mid-flight on either side. */
  readonly pendingSeatChange: boolean;
}

/** Facts gathered by the batch runner right before it asks for a handover. */
export interface HandoverFacts {
  /** Marker read from the live Stripe subscription, not from an event payload. */
  readonly liveMarker: OwnerMarker;
  readonly status: StripeSubscriptionStatus;
  /** Stripe current_period_end, epoch seconds. */
  readonly paidThroughAt: number | null;
  /** Created time of the newest Stripe event for this subscription, epoch seconds. */
  readonly lastStripeEventAt: number | null;
  /** Live subscriptions on the same Stripe customer that are not moving in this batch. */
  readonly otherRailsOwnedSubscriptionsOnCustomer: number;
  /** Null for individual subscriptions. */
  readonly team: TeamSeatFacts | null;
  /** Operator acknowledgement that this subscriber's access changes when it moves. */
  readonly acceptAccessChange: boolean;
}

export interface OwnershipPolicy {
  /** The access law CB enforces once it owns the subscription. */
  readonly cbAccessRule: AccessRule;
  /** The access law Rails enforces today. */
  readonly railsAccessRule: AccessRule;
  /** Which app answers "does this user have access" for egghead.io traffic. */
  readonly accessReadSide: Owner;
  readonly handoverStatuses: ReadonlySet<StripeSubscriptionStatus>;
  /** Refuse handover this close to a renewal, so invoice creation stays on one side. */
  readonly renewalQuietWindowSeconds: number;
  /** Refuse handover until this long after the last Stripe event, so Rails jobs drain. */
  readonly eventSettleSeconds: number;
  readonly maxMarkerWriteAttempts: number;
  /** False once Rails is off: there is nobody left to hand back to. */
  readonly railsAcceptsHandback: boolean;
}

/**
 * Starting policy for the first batches. The CB access law and the read side are
 * required inputs: neither is decided here.
 */
export function suggestedOwnershipPolicy(input: {
  readonly cbAccessRule: AccessRule;
  readonly accessReadSide: Owner;
}): OwnershipPolicy {
  return {
    cbAccessRule: input.cbAccessRule,
    railsAccessRule: lenientStatusRule,
    accessReadSide: input.accessReadSide,
    handoverStatuses: new Set<StripeSubscriptionStatus>(["active", "trialing", "canceled"]),
    // Stripe drafts renewal invoices about an hour before period end.
    renewalQuietWindowSeconds: 24 * 60 * 60,
    // Rails defers work by 5 seconds to 1 minute after an event.
    eventSettleSeconds: 10 * 60,
    maxMarkerWriteAttempts: 5,
    railsAcceptsHandback: true,
  };
}

export type OwnershipEvent =
  | {
      readonly type: "HANDOVER_REQUESTED";
      readonly batchId: string;
      readonly at: number;
      readonly facts: HandoverFacts;
    }
  | {
      readonly type: "HANDBACK_REQUESTED";
      readonly batchId: string;
      readonly at: number;
      readonly reason: string;
    }
  | { readonly type: "MARKER_OBSERVED"; readonly marker: OwnerMarker; readonly at: number }
  | {
      readonly type: "MARKER_WRITE_FAILED";
      readonly generation: number;
      readonly at: number;
      readonly error: string;
    }
  | { readonly type: "ABORT_REQUESTED"; readonly at: number; readonly reason: string };

export type HandoverRejection =
  | "marker_already_cb"
  | "status_not_eligible"
  | "renewal_window"
  | "recent_stripe_activity"
  | "customer_split"
  | "team_seats_not_projected"
  | "team_seat_change_pending"
  | "access_would_change"
  | "access_read_side_is_rails";

export type RejectionReason =
  | HandoverRejection
  | "transition_in_flight"
  | "rails_retired"
  | "nothing_to_abort";

export type AlertCode =
  | "marker_changed_externally"
  | "marker_unrecognized"
  | "marker_write_retries_exhausted"
  | "transition_aborted";

export type OwnershipEffect =
  | {
      readonly type: "write_marker";
      readonly subscriptionId: string;
      readonly owner: Owner;
      readonly generation: number;
      readonly idempotencyKey: string;
      readonly metadata: Record<string, string>;
    }
  | {
      /** CB just became owner: re-read the live subscription and seats, then project. */
      readonly type: "sync_cb_from_stripe";
      readonly subscriptionId: string;
    }
  | {
      readonly type: "alert";
      readonly code: AlertCode;
      readonly subscriptionId: string;
      readonly detail: string;
    };

export type TransitionResult =
  | {
      readonly outcome: "transitioned" | "unchanged";
      readonly record: OwnershipRecord;
      readonly effects: readonly OwnershipEffect[];
    }
  | {
      readonly outcome: "rejected";
      readonly record: OwnershipRecord;
      readonly reasons: readonly RejectionReason[];
      readonly effects: readonly [];
    };

function unreachable(value: never): never {
  throw new Error(`Unhandled ownership case: ${JSON.stringify(value)}`);
}

/** The side that acts on Stripe events while a record sits in this state. */
export function settledOwner(state: OwnershipState): Owner {
  switch (state) {
    case "rails_owned":
    case "handover_pending":
      return "rails";
    case "cb_owned":
    case "handback_pending":
      return "cb";
    default:
      return unreachable(state);
  }
}

function settledState(owner: Owner): "rails_owned" | "cb_owned" {
  return owner === "cb" ? "cb_owned" : "rails_owned";
}

function settledRecord(
  subscriptionId: string,
  owner: Owner,
  generation: number,
  at: number,
): OwnershipRecord {
  return { subscriptionId, state: settledState(owner), generation, updatedAt: at };
}

function writeMarker(subscriptionId: string, owner: Owner, generation: number): OwnershipEffect {
  return {
    type: "write_marker",
    subscriptionId,
    owner,
    generation,
    idempotencyKey: ownerMarkerIdempotencyKey(subscriptionId, owner, generation),
    metadata: ownerMarkerMetadata(owner, generation),
  };
}

function syncCb(subscriptionId: string): OwnershipEffect {
  return { type: "sync_cb_from_stripe", subscriptionId };
}

function alert(subscriptionId: string, code: AlertCode, detail: string): OwnershipEffect {
  return { type: "alert", code, subscriptionId, detail };
}

function unrecognizedMarkerAlerts(subscriptionId: string, marker: OwnerMarker): OwnershipEffect[] {
  return marker.source === "unrecognized"
    ? [
        alert(
          subscriptionId,
          "marker_unrecognized",
          "egghead_owner holds an unknown value; read as rails",
        ),
      ]
    : [];
}

function unchanged(
  record: OwnershipRecord,
  effects: readonly OwnershipEffect[] = [],
): TransitionResult {
  return { outcome: "unchanged", record, effects };
}

function rejected(record: OwnershipRecord, reasons: readonly RejectionReason[]): TransitionResult {
  return { outcome: "rejected", record, reasons, effects: [] };
}

/** First sighting of a subscription (a CB checkout, or a webhook before any batch). */
export function createOwnershipRecord(input: {
  readonly subscriptionId: string;
  readonly marker: OwnerMarker;
  readonly at: number;
}): { readonly record: OwnershipRecord; readonly effects: readonly OwnershipEffect[] } {
  return {
    record: settledRecord(
      input.subscriptionId,
      input.marker.owner,
      input.marker.generation,
      input.at,
    ),
    effects: unrecognizedMarkerAlerts(input.subscriptionId, input.marker),
  };
}

/** Every guard that blocks a handover. Empty means the subscription may move. */
export function handoverRejections(
  facts: HandoverFacts,
  policy: OwnershipPolicy,
  at: number,
): HandoverRejection[] {
  const reasons: HandoverRejection[] = [];

  if (facts.liveMarker.owner === "cb") reasons.push("marker_already_cb");
  if (policy.accessReadSide !== "cb") reasons.push("access_read_side_is_rails");
  if (!policy.handoverStatuses.has(facts.status)) reasons.push("status_not_eligible");

  const billsAgain = facts.status === "active" || facts.status === "trialing";
  if (
    billsAgain &&
    (facts.paidThroughAt === null || facts.paidThroughAt - at < policy.renewalQuietWindowSeconds)
  ) {
    reasons.push("renewal_window");
  }

  if (
    facts.lastStripeEventAt !== null &&
    at - facts.lastStripeEventAt < policy.eventSettleSeconds
  ) {
    reasons.push("recent_stripe_activity");
  }

  if (facts.otherRailsOwnedSubscriptionsOnCustomer > 0) reasons.push("customer_split");

  if (facts.team !== null) {
    if (!facts.team.seatsProjectedToCb) reasons.push("team_seats_not_projected");
    if (facts.team.pendingSeatChange) reasons.push("team_seat_change_pending");
  }

  const accessFacts = { status: facts.status, paidThroughAt: facts.paidThroughAt, now: at };
  const railsGrants = accessGranted(policy.railsAccessRule.evaluate(accessFacts));
  const cbGrants = accessGranted(policy.cbAccessRule.evaluate(accessFacts));
  if (railsGrants !== cbGrants && !facts.acceptAccessChange) reasons.push("access_would_change");

  return reasons;
}

function observeMarker(record: OwnershipRecord, marker: OwnerMarker, at: number): TransitionResult {
  const { subscriptionId } = record;
  const generation = Math.max(record.generation, marker.generation);
  const markerAlerts = unrecognizedMarkerAlerts(subscriptionId, marker);

  switch (record.state) {
    case "rails_owned":
    case "cb_owned": {
      const owner = settledOwner(record.state);
      if (marker.owner === owner) {
        if (generation === record.generation) return unchanged(record, markerAlerts);
        return {
          outcome: "unchanged",
          record: { ...record, generation, updatedAt: at },
          effects: markerAlerts,
        };
      }
      // Someone flipped the marker outside this machine (Stripe dashboard rollback,
      // a Rails console, a lost CB row). The marker wins; adopt it and say so.
      return {
        outcome: "transitioned",
        record: settledRecord(subscriptionId, marker.owner, generation, at),
        effects: [
          ...markerAlerts,
          alert(
            subscriptionId,
            "marker_changed_externally",
            `marker moved from ${owner} to ${marker.owner} without a pending write`,
          ),
          ...(marker.owner === "cb" ? [syncCb(subscriptionId)] : []),
        ],
      };
    }
    case "handover_pending":
    case "handback_pending": {
      const target: Owner = record.state === "handover_pending" ? "cb" : "rails";
      if (marker.owner !== target) return unchanged(record, markerAlerts);

      const external =
        marker.generation === record.pending.generation
          ? []
          : [
              alert(
                subscriptionId,
                "marker_changed_externally",
                `marker reached ${target} at generation ${marker.generation}, expected ${record.pending.generation}`,
              ),
            ];
      return {
        outcome: "transitioned",
        record: settledRecord(
          subscriptionId,
          target,
          Math.max(generation, record.pending.generation),
          at,
        ),
        effects: [
          ...markerAlerts,
          ...external,
          ...(target === "cb" ? [syncCb(subscriptionId)] : []),
        ],
      };
    }
    default:
      return unreachable(record);
  }
}

function requestHandover(
  record: OwnershipRecord,
  event: Extract<OwnershipEvent, { type: "HANDOVER_REQUESTED" }>,
  policy: OwnershipPolicy,
): TransitionResult {
  switch (record.state) {
    case "cb_owned":
      return unchanged(record);
    case "handback_pending":
      return rejected(record, ["transition_in_flight"]);
    case "handover_pending": {
      if (record.pending.batchId !== event.batchId)
        return rejected(record, ["transition_in_flight"]);
      // Same batch asking again: re-drive the same write with the same idempotency key.
      const pending = { ...record.pending, attempts: 1, requestedAt: event.at };
      return unchanged({ ...record, pending, updatedAt: event.at }, [
        writeMarker(record.subscriptionId, "cb", pending.generation),
      ]);
    }
    case "rails_owned": {
      const reasons = handoverRejections(event.facts, policy, event.at);
      if (reasons.length > 0) return rejected(record, reasons);

      const generation = Math.max(record.generation, event.facts.liveMarker.generation) + 1;
      return {
        outcome: "transitioned",
        record: {
          subscriptionId: record.subscriptionId,
          state: "handover_pending",
          generation: record.generation,
          updatedAt: event.at,
          pending: { generation, batchId: event.batchId, attempts: 1, requestedAt: event.at },
        },
        effects: [writeMarker(record.subscriptionId, "cb", generation)],
      };
    }
    default:
      return unreachable(record);
  }
}

function requestHandback(
  record: OwnershipRecord,
  event: Extract<OwnershipEvent, { type: "HANDBACK_REQUESTED" }>,
  policy: OwnershipPolicy,
): TransitionResult {
  switch (record.state) {
    case "rails_owned":
      return unchanged(record);
    case "handover_pending":
      return rejected(record, ["transition_in_flight"]);
    case "handback_pending": {
      if (record.pending.batchId !== event.batchId)
        return rejected(record, ["transition_in_flight"]);
      const pending = { ...record.pending, attempts: 1, requestedAt: event.at };
      return unchanged({ ...record, pending, updatedAt: event.at }, [
        writeMarker(record.subscriptionId, "rails", pending.generation),
      ]);
    }
    case "cb_owned": {
      if (!policy.railsAcceptsHandback) return rejected(record, ["rails_retired"]);
      const generation = record.generation + 1;
      return {
        outcome: "transitioned",
        record: {
          subscriptionId: record.subscriptionId,
          state: "handback_pending",
          generation: record.generation,
          updatedAt: event.at,
          pending: { generation, batchId: event.batchId, attempts: 1, requestedAt: event.at },
        },
        effects: [writeMarker(record.subscriptionId, "rails", generation)],
      };
    }
    default:
      return unreachable(record);
  }
}

function markerWriteFailed(
  record: OwnershipRecord,
  event: Extract<OwnershipEvent, { type: "MARKER_WRITE_FAILED" }>,
  policy: OwnershipPolicy,
): TransitionResult {
  if (record.state !== "handover_pending" && record.state !== "handback_pending") {
    return unchanged(record);
  }
  // A failure report for an older write (already superseded or aborted) changes nothing.
  if (event.generation !== record.pending.generation) return unchanged(record);

  const target: Owner = record.state === "handover_pending" ? "cb" : "rails";
  if (record.pending.attempts >= policy.maxMarkerWriteAttempts) {
    // Limits alarm; they don't block. The write may even have landed (a timeout is
    // ambiguous), so stay pending: the next MARKER_OBSERVED commits it, or an operator
    // re-drives with the same batch or aborts.
    return unchanged(record, [
      alert(
        record.subscriptionId,
        "marker_write_retries_exhausted",
        `${record.pending.attempts} attempts to mark ${target}: ${event.error}`,
      ),
    ]);
  }

  const pending = { ...record.pending, attempts: record.pending.attempts + 1 };
  return unchanged({ ...record, pending, updatedAt: event.at }, [
    writeMarker(record.subscriptionId, target, pending.generation),
  ]);
}

function abort(
  record: OwnershipRecord,
  event: Extract<OwnershipEvent, { type: "ABORT_REQUESTED" }>,
): TransitionResult {
  switch (record.state) {
    case "rails_owned":
    case "cb_owned":
      return rejected(record, ["nothing_to_abort"]);
    case "handover_pending":
    case "handback_pending": {
      // The settled owner never stopped acting, so aborting only has to make sure the
      // in-flight write cannot win. A later generation for the settled owner does that
      // even if the earlier write lands first.
      const owner = settledOwner(record.state);
      const generation = record.pending.generation + 1;
      return {
        outcome: "transitioned",
        record: settledRecord(record.subscriptionId, owner, generation, event.at),
        effects: [
          writeMarker(record.subscriptionId, owner, generation),
          alert(record.subscriptionId, "transition_aborted", event.reason),
        ],
      };
    }
    default:
      return unreachable(record);
  }
}

export function transition(
  record: OwnershipRecord,
  event: OwnershipEvent,
  policy: OwnershipPolicy,
): TransitionResult {
  switch (event.type) {
    case "HANDOVER_REQUESTED":
      return requestHandover(record, event, policy);
    case "HANDBACK_REQUESTED":
      return requestHandback(record, event, policy);
    case "MARKER_OBSERVED":
      return observeMarker(record, event.marker, event.at);
    case "MARKER_WRITE_FAILED":
      return markerWriteFailed(record, event, policy);
    case "ABORT_REQUESTED":
      return abort(record, event);
    default:
      return unreachable(event);
  }
}

export interface StripeEventDecision {
  /** `process` means CB acts on the event; `ignore` means Rails owns it. Ack 2xx either way. */
  readonly action: "process" | "ignore";
  readonly owner: Owner;
  /** Record after reconciling with the live marker. Persist it when `recordChanged`. */
  readonly record: OwnershipRecord;
  readonly recordChanged: boolean;
  readonly effects: readonly OwnershipEffect[];
}

/**
 * Decide whether CB acts on a subscription-scoped Stripe event. Call it after loading
 * the live subscription, with the marker read from that live object. Never pass the
 * marker from the event payload: it is a snapshot from when the event was created.
 */
export function decideStripeEvent(
  record: OwnershipRecord | null,
  input: { readonly subscriptionId: string; readonly liveMarker: OwnerMarker; readonly at: number },
): StripeEventDecision {
  if (record === null) {
    const created = createOwnershipRecord({
      subscriptionId: input.subscriptionId,
      marker: input.liveMarker,
      at: input.at,
    });
    const owner = settledOwner(created.record.state);
    return {
      action: owner === "cb" ? "process" : "ignore",
      owner,
      record: created.record,
      recordChanged: true,
      effects: created.effects,
    };
  }

  const observed = observeMarker(record, input.liveMarker, input.at);
  const owner = settledOwner(observed.record.state);
  return {
    action: owner === "cb" ? "process" : "ignore",
    owner,
    record: observed.record,
    recordChanged: observed.record !== record,
    effects: observed.effects,
  };
}
