// Commerce handover state machine: one owner per Stripe customer, moved by scheduled
// flips of the customer's owner timeline. See docs/adr/0001-subscription-ownership-handover.md.
//
// Pure: no Stripe, DB, clock or logger. The caller persists the returned record before
// it runs the returned effects, and serializes calls per Stripe customer.
//
// Routing never reads this record. `routeStripeEvent` routes from the live timeline,
// so the record cannot make the two apps disagree. The record plans flips, drives and
// fences marker writes, detects writes it did not expect, and freezes automation in
// `conflict` until an operator decides.
//
// Every write this machine issues carries `notAfter`, the flip's deadline, so a landed
// write can only change the owner of events created after it was readable by both
// apps. The one exception is the operator's `restore_confirmed`, a deliberate rewrite.
//
// The shape maps onto XState `setup({ guards, actions })`: states are `OwnershipState`,
// events are `OwnershipEvent`, guards are `transitionRejections`, actions are effects.
// The repo has no XState dependency, so this is a typed transition function.

import {
  accessGranted,
  lenientStatusRule,
  type AccessRule,
  type StripeSubscriptionStatus,
} from "./access-rule";
import {
  appendFlip,
  finalOwner,
  ownerMarkerIdempotencyKey,
  ownerMarkerMetadata,
  RAILS_FROM_START,
  sameTimeline,
  serializeTimeline,
  type Owner,
  type OwnerMarker,
  type OwnerTimeline,
} from "./marker";

export type OwnershipState =
  | "rails_owned"
  | "handover_pending"
  | "cb_owned"
  | "handback_pending"
  | "conflict";

export type Direction = "handover" | "handback";

export interface PendingFlip {
  readonly generation: number;
  /** Confirmed timeline plus the new entry. */
  readonly timeline: OwnerTimeline;
  /** When the new owner takes over, on Stripe's event clock. */
  readonly flipAt: number;
  /** No write for this flip may be sent at or after this time. */
  readonly deadline: number;
  readonly batchId: string;
  readonly attempts: number;
  readonly keyNonce: number;
  readonly requestedAt: number;
}

/** A write of the confirmed timeline at a newer generation, after a cancelled flip. */
export interface FenceWrite {
  readonly generation: number;
  readonly timeline: OwnerTimeline;
  readonly attempts: number;
  readonly keyNonce: number;
  /** Null only for an operator rewrite (`restore_confirmed`). */
  readonly notAfter: number | null;
  /**
   * True when the live marker holds something other than the confirmed timeline, so
   * the fence must land for the record to be true. False when it only bumps the
   * generation over a live marker that already matches.
   */
  readonly required: boolean;
}

export type ConflictReason =
  | "fenced_write_landed"
  | "external_write"
  | "marker_unrecognized"
  | "fence_write_failed"
  | "landed_before_cancel";

export interface ConflictDetail {
  readonly reason: ConflictReason;
  /** The live marker that caused the conflict; null when a fence write failed. */
  readonly observed: { readonly generation: number; readonly timeline: OwnerTimeline } | null;
  readonly detectedAt: number;
}

interface RecordBase {
  readonly customerId: string;
  /** Generation and timeline CB last confirmed on the live customer. */
  readonly generation: number;
  readonly timeline: OwnerTimeline;
  /** Highest generation CB has ever issued, landed or not. Never reused. */
  readonly issuedGeneration: number;
  readonly fence: FenceWrite | null;
  /** Time of the newest marker sighting applied (event `created` or live read time). */
  readonly lastObservedAt: number | null;
  readonly lastUnrecognizedAlertAt: number | null;
  readonly updatedAt: number;
}

export type OwnershipRecord =
  | (RecordBase & { readonly state: "rails_owned" })
  | (RecordBase & { readonly state: "cb_owned" })
  | (RecordBase & { readonly state: "handover_pending"; readonly pending: PendingFlip })
  | (RecordBase & { readonly state: "handback_pending"; readonly pending: PendingFlip })
  | (RecordBase & { readonly state: "conflict"; readonly conflict: ConflictDetail });

type PendingRecord = Extract<OwnershipRecord, { state: "handover_pending" | "handback_pending" }>;

export interface TeamSeatFacts {
  readonly quantity: number;
  /** CB holds the seat roster (members and invites) for this subscription. */
  readonly seatsProjectedToCb: boolean;
  /** A quantity change or seat release is scheduled or mid-flight on either side. */
  readonly pendingSeatChange: boolean;
}

export interface SubscriptionFacts {
  readonly subscriptionId: string;
  readonly status: StripeSubscriptionStatus;
  /** Stripe current_period_end, epoch seconds. */
  readonly paidThroughAt: number | null;
  readonly team: TeamSeatFacts | null;
}

/** Facts gathered fresh from Stripe and CB right before every write attempt. */
export interface TransitionFacts {
  /** Marker read from the live Stripe customer (not from an event payload). */
  readonly liveMarker: OwnerMarker;
  /** Every subscription on the customer, ended ones included. */
  readonly subscriptions: readonly SubscriptionFacts[];
  /** Created time of the newest Stripe event for this customer, epoch seconds. */
  readonly lastStripeEventAt: number | null;
  /** Operator acknowledgement that a subscriber's access changes when it moves. */
  readonly acceptAccessChange: boolean;
}

export interface OwnershipPolicy {
  readonly cbAccessRule: AccessRule;
  readonly railsAccessRule: AccessRule;
  /** Which app answers access checks for egghead.io traffic. */
  readonly accessReadSide: Owner;
  readonly eligibleStatuses: ReadonlySet<StripeSubscriptionStatus>;
  /** Refuse a flip this close to any subscription's renewal, measured from `flipAt`. */
  readonly renewalQuietWindowSeconds: number;
  /** Refuse a flip until this long after the customer's last Stripe event. */
  readonly eventSettleSeconds: number;
  /** A flip is written this long before it takes effect. */
  readonly flipLeadSeconds: number;
  /** Longest either app may cache a customer marker. */
  readonly markerCacheTtlSeconds: number;
  /** Extra time between the write deadline and the moment caches must have expired. */
  readonly landingMarginSeconds: number;
  /** Nothing younger than this is ever compacted. At least MIN_TIMELINE_RETENTION_SECONDS. */
  readonly timelineRetentionSeconds: number;
  readonly maxMarkerWriteAttempts: number;
  readonly alertCooldownSeconds: number;
  /** False once Rails is off: there is nobody left to hand back to. */
  readonly railsAcceptsHandback: boolean;
}

/**
 * How a marker write failed, as the effect runner classifies it:
 * - `server_error`: a 5xx. Stripe caches it under the key, so the next attempt needs a new key.
 * - `timeout`: no response. Reuse the key; Stripe returns the first result if it ran.
 * - `rate_limited`: a 429. Not executed; reuse the key.
 * - `key_in_use`: a 409 because the same key is still running. Reuse the key later.
 * - `client_error`: any other 4xx. Retrying will not help.
 */
export type MarkerWriteFailure =
  | "server_error"
  | "timeout"
  | "rate_limited"
  | "key_in_use"
  | "client_error";

export type OwnershipEvent =
  | {
      readonly type: "HANDOVER_REQUESTED" | "HANDBACK_REQUESTED";
      readonly batchId: string;
      readonly at: number;
      readonly facts: TransitionFacts;
    }
  | {
      readonly type: "MARKER_OBSERVED";
      /**
       * `event`: the marker in a `customer.updated` payload, a snapshot that may be stale
       * or out of order. `live_read`: CB just retrieved the customer; authoritative.
       */
      readonly source: "event" | "live_read";
      readonly marker: OwnerMarker;
      readonly at: number;
      /** Stripe `created` of the carrying event; for a live read, the read time. */
      readonly landedAt: number;
    }
  | {
      readonly type: "MARKER_WRITE_FAILED";
      readonly generation: number;
      readonly failure: MarkerWriteFailure;
      readonly at: number;
      readonly error: string;
      /** Fresh facts. Required for a pending flip; optional for a fence write. */
      readonly facts: TransitionFacts | null;
    }
  | {
      readonly type: "DEADLINE_REACHED";
      readonly at: number;
      /** Read just now. A cancel never fences without knowing what is live. */
      readonly liveMarker: OwnerMarker;
    }
  | {
      readonly type: "ABORT_REQUESTED";
      readonly at: number;
      readonly reason: string;
      readonly liveMarker: OwnerMarker;
    }
  | {
      readonly type: "CONFLICT_RESOLVED";
      readonly at: number;
      /** `adopt_live` accepts the live marker; `restore_confirmed` rewrites CB's last confirmed one. */
      readonly decision: "adopt_live" | "restore_confirmed";
      readonly liveMarker: OwnerMarker;
      readonly operator: string;
    };

export type TransitionRejection =
  | "marker_unrecognized"
  | "marker_out_of_sync"
  | "status_not_eligible"
  | "renewal_window"
  | "recent_stripe_activity"
  | "team_seats_not_projected"
  | "team_seat_change_pending"
  | "access_would_change"
  | "access_read_side_is_rails"
  | "timeline_full"
  | "flip_not_after_last";

export type RejectionReason =
  | TransitionRejection
  | "transition_in_flight"
  | "fence_outstanding"
  | "conflict_unresolved"
  | "rails_retired"
  | "policy_invalid"
  | "fresh_facts_required"
  | "nothing_to_abort"
  | "flip_time_passed"
  | "no_conflict";

export type AlertCode =
  | "marker_unrecognized"
  | "flip_landed_late"
  | "flip_deadline_missed"
  | "flip_guard_failed"
  | "marker_write_rejected"
  | "marker_write_retries_exhausted"
  | "fenced_write_landed"
  | "external_write"
  | "fence_write_failed"
  | "landed_before_cancel"
  | "transition_aborted"
  | "conflict_resolved"
  | "history_rewritten";

export type OwnershipEffect =
  | {
      readonly type: "write_marker";
      readonly customerId: string;
      readonly generation: number;
      readonly timeline: OwnerTimeline;
      readonly metadata: Record<string, string>;
      readonly idempotencyKey: string;
      /** The runner must not send this request at or after this time. Null: no limit. */
      readonly notAfter: number | null;
    }
  | {
      /** CB takes over at `notBefore`: re-read the customer's subscriptions and seats then. */
      readonly type: "sync_cb_from_stripe";
      readonly customerId: string;
      readonly notBefore: number;
    }
  | {
      /** An event snapshot was ambiguous: retrieve the customer and send a live_read. */
      readonly type: "read_live_marker";
      readonly customerId: string;
      readonly reason: string;
    }
  | {
      readonly type: "alert";
      readonly code: AlertCode;
      readonly customerId: string;
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

const DAY = 24 * 60 * 60;

/**
 * Nothing younger than this may be compacted. It exceeds Stripe's 3-day automatic
 * retries, manual dashboard resends of events up to about 30 days old, and the Rails
 * reconciler's 24-hour look-back (`stripe_reconciler.rb:38`).
 */
export const MIN_TIMELINE_RETENTION_SECONDS = 35 * DAY;

/**
 * Starting policy. The CB access law and the read side are required inputs: neither is
 * decided here.
 */
export function suggestedOwnershipPolicy(input: {
  readonly cbAccessRule: AccessRule;
  readonly accessReadSide: Owner;
}): OwnershipPolicy {
  return {
    cbAccessRule: input.cbAccessRule,
    railsAccessRule: lenientStatusRule,
    accessReadSide: input.accessReadSide,
    eligibleStatuses: new Set<StripeSubscriptionStatus>([
      "active",
      "trialing",
      "canceled",
      "incomplete_expired",
    ]),
    // Stripe drafts renewal invoices about an hour before period end.
    renewalQuietWindowSeconds: DAY,
    // Rails defers work by 5 seconds to 1 minute after an event.
    eventSettleSeconds: 10 * 60,
    flipLeadSeconds: 15 * 60,
    markerCacheTtlSeconds: 60,
    landingMarginSeconds: 2 * 60,
    timelineRetentionSeconds: MIN_TIMELINE_RETENTION_SECONDS,
    maxMarkerWriteAttempts: 5,
    alertCooldownSeconds: DAY,
    railsAcceptsHandback: true,
  };
}

/** Why a policy cannot work. Empty means it is usable. */
export function ownershipPolicyProblems(policy: OwnershipPolicy): string[] {
  const problems: string[] = [];
  if (policy.flipLeadSeconds <= policy.markerCacheTtlSeconds + policy.landingMarginSeconds) {
    problems.push("flipLeadSeconds must exceed markerCacheTtlSeconds + landingMarginSeconds");
  }
  if (policy.timelineRetentionSeconds < MIN_TIMELINE_RETENTION_SECONDS) {
    problems.push("timelineRetentionSeconds must be at least 35 days");
  }
  if (policy.maxMarkerWriteAttempts < 1) problems.push("maxMarkerWriteAttempts must be at least 1");
  return problems;
}

function unreachable(value: never): never {
  throw new Error(`Unhandled ownership case: ${JSON.stringify(value)}`);
}

function targetOf(state: "handover_pending" | "handback_pending"): Owner {
  return state === "handover_pending" ? "cb" : "rails";
}

function directionOf(state: "handover_pending" | "handback_pending"): Direction {
  return state === "handover_pending" ? "handover" : "handback";
}

function baseOf(record: OwnershipRecord): RecordBase {
  return {
    customerId: record.customerId,
    generation: record.generation,
    timeline: record.timeline,
    issuedGeneration: record.issuedGeneration,
    fence: record.fence,
    lastObservedAt: record.lastObservedAt,
    lastUnrecognizedAlertAt: record.lastUnrecognizedAlertAt,
    updatedAt: record.updatedAt,
  };
}

function settle(base: RecordBase, at: number): OwnershipRecord {
  return {
    ...base,
    state: finalOwner(base.timeline) === "cb" ? "cb_owned" : "rails_owned",
    updatedAt: at,
  };
}

function writeMarker(
  customerId: string,
  generation: number,
  timeline: OwnerTimeline,
  nonce: number,
  notAfter: number | null,
): OwnershipEffect {
  return {
    type: "write_marker",
    customerId,
    generation,
    timeline,
    metadata: ownerMarkerMetadata(timeline, generation),
    idempotencyKey: ownerMarkerIdempotencyKey(customerId, generation, nonce),
    notAfter,
  };
}

function alert(customerId: string, code: AlertCode, detail: string): OwnershipEffect {
  return { type: "alert", code, customerId, detail };
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

function markerMatches(marker: OwnerMarker, generation: number, timeline: OwnerTimeline): boolean {
  return (
    marker.source === "explicit" &&
    marker.generation === generation &&
    sameTimeline(marker.timeline, timeline)
  );
}

/**
 * The live marker routes exactly like the one CB last confirmed. Only the timeline
 * routes, so the generation is not compared: an older-generation marker with the same
 * timeline (a fence that has not landed yet, an old snapshot) changes nothing. A
 * missing marker equals rails from the start.
 */
function markerInSync(marker: OwnerMarker, record: RecordBase): boolean {
  if (marker.source === "unrecognized") return false;
  return sameTimeline(marker.timeline, record.timeline);
}

/** Next key nonce: a new key after a 5xx (Stripe caches it), the same key otherwise. */
function nextNonce(nonce: number, failure: MarkerWriteFailure): number {
  return failure === "server_error" ? nonce + 1 : nonce;
}

function nextGeneration(record: RecordBase, live: OwnerMarker): number {
  return Math.max(record.issuedGeneration, live.generation) + 1;
}

/** First sighting of a customer, from a live read at `at`. */
export function createOwnershipRecord(input: {
  readonly customerId: string;
  readonly marker: OwnerMarker;
  readonly at: number;
}): { readonly record: OwnershipRecord; readonly effects: readonly OwnershipEffect[] } {
  const { customerId, marker, at } = input;
  const base: RecordBase = {
    customerId,
    generation: marker.generation,
    timeline: marker.source === "unrecognized" ? RAILS_FROM_START : marker.timeline,
    issuedGeneration: marker.generation,
    fence: null,
    lastObservedAt: at,
    lastUnrecognizedAlertAt: null,
    updatedAt: at,
  };
  if (marker.source === "unrecognized") {
    return {
      record: {
        ...base,
        lastUnrecognizedAlertAt: at,
        state: "conflict",
        conflict: {
          reason: "marker_unrecognized",
          observed: { generation: marker.generation, timeline: marker.timeline },
          detectedAt: at,
        },
      },
      effects: [
        alert(
          customerId,
          "marker_unrecognized",
          "owner metadata does not parse; every event routes to rails",
        ),
      ],
    };
  }
  return { record: settle(base, at), effects: [] };
}

/** Every guard that blocks a flip. Empty means the customer may move at `flipAt`. */
export function transitionRejections(input: {
  readonly direction: Direction;
  readonly facts: TransitionFacts;
  readonly record: OwnershipRecord;
  readonly policy: OwnershipPolicy;
  readonly at: number;
  readonly flipAt: number;
}): TransitionRejection[] {
  const { direction, facts, record, policy, at, flipAt } = input;
  const reasons = new Set<TransitionRejection>();

  if (facts.liveMarker.source === "unrecognized") reasons.add("marker_unrecognized");
  else if (!markerInSync(facts.liveMarker, record)) reasons.add("marker_out_of_sync");

  if (direction === "handover" && policy.accessReadSide !== "cb") {
    reasons.add("access_read_side_is_rails");
  }
  if (
    facts.lastStripeEventAt !== null &&
    at - facts.lastStripeEventAt < policy.eventSettleSeconds
  ) {
    reasons.add("recent_stripe_activity");
  }

  for (const subscription of facts.subscriptions) {
    if (!policy.eligibleStatuses.has(subscription.status)) reasons.add("status_not_eligible");
    const billsAgain = subscription.status === "active" || subscription.status === "trialing";
    if (
      billsAgain &&
      (subscription.paidThroughAt === null ||
        subscription.paidThroughAt - flipAt < policy.renewalQuietWindowSeconds)
    ) {
      reasons.add("renewal_window");
    }
    if (subscription.team !== null) {
      if (direction === "handover" && !subscription.team.seatsProjectedToCb) {
        reasons.add("team_seats_not_projected");
      }
      if (subscription.team.pendingSeatChange) reasons.add("team_seat_change_pending");
    }
    const accessFacts = {
      status: subscription.status,
      paidThroughAt: subscription.paidThroughAt,
      now: flipAt,
    };
    const railsGrants = accessGranted(policy.railsAccessRule.evaluate(accessFacts));
    const cbGrants = accessGranted(policy.cbAccessRule.evaluate(accessFacts));
    if (railsGrants !== cbGrants && !facts.acceptAccessChange) {
      reasons.add("access_would_change");
    }
  }

  return [...reasons];
}

function enterConflict(
  record: OwnershipRecord,
  reason: ConflictReason,
  observed: ConflictDetail["observed"],
  at: number,
  effects: readonly OwnershipEffect[],
): TransitionResult {
  return {
    outcome: "transitioned",
    record: {
      ...baseOf(record),
      updatedAt: at,
      state: "conflict",
      conflict: { reason, observed, detectedAt: at },
    },
    effects,
  };
}

/** A live marker CB did not write and does not expect: unrecognized, cancelled or foreign. */
function conflictFromLive(
  record: OwnershipRecord,
  live: OwnerMarker,
  at: number,
  context: string,
): TransitionResult {
  const observed = { generation: live.generation, timeline: live.timeline };
  if (live.source === "unrecognized") {
    return enterConflict(record, "marker_unrecognized", observed, at, [
      alert(record.customerId, "marker_unrecognized", `${context}: owner metadata does not parse`),
    ]);
  }
  const reason: ConflictReason =
    live.generation <= record.issuedGeneration ? "fenced_write_landed" : "external_write";
  return enterConflict(record, reason, observed, at, [
    alert(
      record.customerId,
      reason,
      `${context}: live generation ${live.generation} (${serializeTimeline(live.timeline)}) ` +
        "is not one CB expects; routing follows it; automation is frozen until an operator resolves",
    ),
  ]);
}

/**
 * Cancel a pending flip. `live` was read just now. Three outcomes:
 * - the flip's write has landed: fence it before the deadline, or past the deadline
 *   hand it to an operator, because removing it then would rewrite routable history;
 * - the live marker is still the confirmed one: settle back, and bump the generation
 *   with a harmless fence write only while it can still land before the deadline;
 * - anything else: conflict.
 */
function cancelPending(
  record: PendingRecord,
  live: OwnerMarker,
  at: number,
  code: AlertCode,
  detail: string,
): TransitionResult {
  const { pending } = record;
  const beforeDeadline = at < pending.deadline;

  if (markerMatches(live, pending.generation, pending.timeline)) {
    if (!beforeDeadline) {
      return enterConflict(
        record,
        "landed_before_cancel",
        { generation: live.generation, timeline: live.timeline },
        at,
        [
          alert(
            record.customerId,
            "landed_before_cancel",
            `${detail}; generation ${pending.generation} is live and the deadline has passed, ` +
              "so removing it could change the owner of events already routable by it",
          ),
        ],
      );
    }
    const generation = nextGeneration(record, live);
    const fence: FenceWrite = {
      generation,
      timeline: record.timeline,
      attempts: 1,
      keyNonce: 0,
      notAfter: pending.deadline,
      required: true,
    };
    return {
      outcome: "transitioned",
      record: settle({ ...baseOf(record), issuedGeneration: generation, fence }, at),
      effects: [
        writeMarker(record.customerId, generation, record.timeline, 0, pending.deadline),
        alert(
          record.customerId,
          code,
          `${detail}; landed generation ${pending.generation} fenced by ${generation}`,
        ),
      ],
    };
  }

  if (!markerInSync(live, record)) return conflictFromLive(record, live, at, detail);

  if (!beforeDeadline) {
    return {
      outcome: "transitioned",
      record: settle(baseOf(record), at),
      effects: [
        alert(
          record.customerId,
          code,
          `${detail}; generation ${pending.generation} never landed; a late landing will raise a conflict`,
        ),
      ],
    };
  }
  const generation = nextGeneration(record, live);
  const fence: FenceWrite = {
    generation,
    timeline: record.timeline,
    attempts: 1,
    keyNonce: 0,
    notAfter: pending.deadline,
    required: false,
  };
  return {
    outcome: "transitioned",
    record: settle({ ...baseOf(record), issuedGeneration: generation, fence }, at),
    effects: [
      writeMarker(record.customerId, generation, record.timeline, 0, pending.deadline),
      alert(
        record.customerId,
        code,
        `${detail}; generation ${pending.generation} fenced by ${generation}`,
      ),
    ],
  };
}

function commitPending(
  record: PendingRecord,
  at: number,
  landedAt: number,
  policy: OwnershipPolicy,
): TransitionResult {
  const { pending } = record;
  const target = targetOf(record.state);
  const effects: OwnershipEffect[] = [];
  if (target === "cb") {
    effects.push({
      type: "sync_cb_from_stripe",
      customerId: record.customerId,
      notBefore: pending.flipAt,
    });
  }
  if (landedAt > pending.flipAt - policy.markerCacheTtlSeconds) {
    effects.push(
      alert(
        record.customerId,
        "flip_landed_late",
        `generation ${pending.generation} seen at ${landedAt} for a flip at ${pending.flipAt}; ` +
          `events created in [${pending.flipAt}, ${landedAt + policy.markerCacheTtlSeconds}) may have been handled by both apps or neither`,
      ),
    );
  }
  return {
    outcome: "transitioned",
    record: settle(
      { ...baseOf(record), generation: pending.generation, timeline: pending.timeline },
      at,
    ),
    effects,
  };
}

/** Retry or re-drive a pending flip with fresh facts. Every attempt re-runs the guards. */
function retryPending(
  record: PendingRecord,
  facts: TransitionFacts,
  at: number,
  policy: OwnershipPolicy,
  next: { readonly attempts: number; readonly keyNonce: number },
): TransitionResult {
  const { pending } = record;
  const live = facts.liveMarker;
  if (markerMatches(live, pending.generation, pending.timeline)) {
    // The "failed" write landed after all (an ambiguous timeout). `at` bounds the landing.
    return commitPending(record, at, at, policy);
  }
  if (!markerInSync(live, record)) return conflictFromLive(record, live, at, "retry");
  if (at >= pending.deadline) {
    return cancelPending(
      record,
      live,
      at,
      "flip_deadline_missed",
      `write not confirmed by ${pending.deadline}`,
    );
  }
  const reasons = transitionRejections({
    direction: directionOf(record.state),
    facts,
    record,
    policy,
    at,
    flipAt: pending.flipAt,
  });
  if (reasons.length > 0) {
    return cancelPending(
      record,
      live,
      at,
      "flip_guard_failed",
      `guards failed on retry: ${reasons.join(", ")}`,
    );
  }
  const updated: PendingFlip = { ...pending, ...next };
  return unchanged({ ...record, pending: updated, updatedAt: at }, [
    writeMarker(
      record.customerId,
      pending.generation,
      pending.timeline,
      updated.keyNonce,
      pending.deadline,
    ),
  ]);
}

function requestTransition(
  record: OwnershipRecord,
  event: Extract<OwnershipEvent, { type: "HANDOVER_REQUESTED" | "HANDBACK_REQUESTED" }>,
  policy: OwnershipPolicy,
): TransitionResult {
  const direction: Direction = event.type === "HANDOVER_REQUESTED" ? "handover" : "handback";
  const target: Owner = direction === "handover" ? "cb" : "rails";

  switch (record.state) {
    case "conflict":
      return rejected(record, ["conflict_unresolved"]);
    case "handover_pending":
    case "handback_pending": {
      if (directionOf(record.state) !== direction || record.pending.batchId !== event.batchId) {
        return rejected(record, ["transition_in_flight"]);
      }
      // Re-drive: fresh facts, guards again, new key (the earlier result is unknown;
      // the write is content-identical, so a duplicate is harmless).
      return retryPending(record, event.facts, event.at, policy, {
        attempts: 1,
        keyNonce: record.pending.keyNonce + 1,
      });
    }
    case "rails_owned":
    case "cb_owned": {
      if (finalOwner(record.timeline) === target) return unchanged(record);
      if (direction === "handback" && !policy.railsAcceptsHandback) {
        return rejected(record, ["rails_retired"]);
      }
      if (record.fence !== null) return rejected(record, ["fence_outstanding"]);
      if (ownershipPolicyProblems(policy).length > 0) return rejected(record, ["policy_invalid"]);

      const flipAt = event.at + policy.flipLeadSeconds;
      const deadline = flipAt - policy.markerCacheTtlSeconds - policy.landingMarginSeconds;
      const reasons: RejectionReason[] = transitionRejections({
        direction,
        facts: event.facts,
        record,
        policy,
        at: event.at,
        flipAt,
      });
      const appended = appendFlip(
        record.timeline,
        target,
        flipAt,
        event.at,
        policy.timelineRetentionSeconds,
      );
      if (!appended.ok) {
        reasons.push(appended.reason === "timeline_full" ? "timeline_full" : "flip_not_after_last");
      }
      if (reasons.length > 0 || !appended.ok) return rejected(record, reasons);

      const generation = nextGeneration(record, event.facts.liveMarker);
      const pending: PendingFlip = {
        generation,
        timeline: appended.timeline,
        flipAt,
        deadline,
        batchId: event.batchId,
        attempts: 1,
        keyNonce: 0,
        requestedAt: event.at,
      };
      return {
        outcome: "transitioned",
        record: {
          ...baseOf(record),
          issuedGeneration: generation,
          updatedAt: event.at,
          state: direction === "handover" ? "handover_pending" : "handback_pending",
          pending,
        },
        effects: [writeMarker(record.customerId, generation, appended.timeline, 0, deadline)],
      };
    }
    default:
      return unreachable(record);
  }
}

function observeMarker(
  record: OwnershipRecord,
  event: Extract<OwnershipEvent, { type: "MARKER_OBSERVED" }>,
  policy: OwnershipPolicy,
): TransitionResult {
  const { marker, at } = event;
  const seenAt = event.source === "live_read" ? at : event.landedAt;

  // Stale or out-of-order sightings are dropped before any conflict detection.
  if (record.lastObservedAt !== null && seenAt < record.lastObservedAt) return unchanged(record);
  if (event.source === "event" && marker.generation < record.generation) {
    // A newer event carrying an older generation: a zombie write, or a snapshot that
    // predates a write CB already saw. Only a live read can tell which.
    return unchanged(record, [
      {
        type: "read_live_marker",
        customerId: record.customerId,
        reason: `event at ${seenAt} carries generation ${marker.generation} below confirmed ${record.generation}`,
      },
    ]);
  }

  const result = observeFresh(record, event, policy);
  const lastObservedAt = Math.max(record.lastObservedAt ?? seenAt, seenAt);
  if (result.record.lastObservedAt === lastObservedAt) return result;
  return {
    ...result,
    record: { ...result.record, lastObservedAt },
  };
}

function observeFresh(
  record: OwnershipRecord,
  event: Extract<OwnershipEvent, { type: "MARKER_OBSERVED" }>,
  policy: OwnershipPolicy,
): TransitionResult {
  const { marker, at } = event;
  const observed = { generation: marker.generation, timeline: marker.timeline };

  if (marker.source === "unrecognized") {
    const due =
      record.lastUnrecognizedAlertAt === null ||
      at - record.lastUnrecognizedAlertAt >= policy.alertCooldownSeconds;
    const effects = due
      ? [
          alert(
            record.customerId,
            "marker_unrecognized",
            "owner metadata does not parse; every event routes to rails",
          ),
        ]
      : [];
    const lastUnrecognizedAlertAt = due ? at : record.lastUnrecognizedAlertAt;
    if (record.state === "conflict") {
      if (!due) return unchanged(record);
      return unchanged({ ...record, lastUnrecognizedAlertAt }, effects);
    }
    return enterConflict(
      { ...record, lastUnrecognizedAlertAt },
      "marker_unrecognized",
      observed,
      at,
      effects,
    );
  }

  if (
    (record.state === "handover_pending" || record.state === "handback_pending") &&
    markerMatches(marker, record.pending.generation, record.pending.timeline)
  ) {
    return commitPending(record, at, event.landedAt, policy);
  }

  if (
    record.fence !== null &&
    markerMatches(marker, record.fence.generation, record.fence.timeline)
  ) {
    const base: RecordBase = {
      ...baseOf(record),
      generation: Math.max(record.generation, marker.generation),
      timeline: record.fence.timeline,
      fence: null,
    };
    if (record.state === "conflict") return unchanged({ ...record, ...base, updatedAt: at });
    return unchanged(settle(base, at));
  }

  if (markerInSync(marker, record)) {
    if (marker.generation <= record.generation) return unchanged(record);
    return unchanged({ ...record, generation: marker.generation, updatedAt: at });
  }

  if (record.state === "conflict") {
    const known = record.conflict.observed;
    if (
      known !== null &&
      known.generation === marker.generation &&
      sameTimeline(known.timeline, marker.timeline)
    ) {
      return unchanged(record);
    }
    return unchanged({ ...record, conflict: { ...record.conflict, observed }, updatedAt: at }, [
      alert(
        record.customerId,
        "external_write",
        `marker changed again to generation ${marker.generation}`,
      ),
    ]);
  }

  return conflictFromLive(record, marker, at, `observed via ${event.source}`);
}

function markerWriteFailed(
  record: OwnershipRecord,
  event: Extract<OwnershipEvent, { type: "MARKER_WRITE_FAILED" }>,
  policy: OwnershipPolicy,
): TransitionResult {
  if (
    (record.state === "handover_pending" || record.state === "handback_pending") &&
    event.generation === record.pending.generation
  ) {
    const { pending } = record;
    if (event.facts === null) return rejected(record, ["fresh_facts_required"]);
    const live = event.facts.liveMarker;
    if (event.failure === "client_error") {
      return cancelPending(record, live, event.at, "marker_write_rejected", event.error);
    }
    if (pending.attempts >= policy.maxMarkerWriteAttempts) {
      return cancelPending(
        record,
        live,
        event.at,
        "marker_write_retries_exhausted",
        `${pending.attempts} attempts: ${event.error}`,
      );
    }
    return retryPending(record, event.facts, event.at, policy, {
      attempts: pending.attempts + 1,
      keyNonce: nextNonce(pending.keyNonce, event.failure),
    });
  }

  const { fence } = record;
  if (fence !== null && event.generation === fence.generation) {
    const expired = fence.notAfter !== null && event.at >= fence.notAfter;
    if (
      event.failure === "client_error" ||
      fence.attempts >= policy.maxMarkerWriteAttempts ||
      expired
    ) {
      const detail = `fence generation ${fence.generation}: ${event.error}`;
      if (fence.required) {
        return enterConflict(record, "fence_write_failed", null, event.at, [
          alert(
            record.customerId,
            "fence_write_failed",
            `${detail}; the cancelled entry may still be live`,
          ),
        ]);
      }
      // The live marker already matched the confirmed timeline; the fence only bumped
      // the generation. Drop it. A late landing of the cancelled write still conflicts.
      return unchanged({ ...record, fence: null, updatedAt: event.at }, [
        alert(record.customerId, "fence_write_failed", `${detail}; dropped, not required`),
      ]);
    }
    const next: FenceWrite = {
      ...fence,
      attempts: fence.attempts + 1,
      keyNonce: nextNonce(fence.keyNonce, event.failure),
    };
    return unchanged({ ...record, fence: next, updatedAt: event.at }, [
      writeMarker(
        record.customerId,
        fence.generation,
        fence.timeline,
        next.keyNonce,
        fence.notAfter,
      ),
    ]);
  }

  // A failure for a generation that is no longer being written changes nothing.
  return unchanged(record);
}

function resolveConflict(
  record: OwnershipRecord,
  event: Extract<OwnershipEvent, { type: "CONFLICT_RESOLVED" }>,
): TransitionResult {
  if (record.state !== "conflict") return rejected(record, ["no_conflict"]);
  const { liveMarker, at } = event;

  if (event.decision === "adopt_live") {
    if (liveMarker.source === "unrecognized") return rejected(record, ["marker_unrecognized"]);
    const base: RecordBase = {
      ...baseOf(record),
      generation: Math.max(record.generation, liveMarker.generation),
      timeline: liveMarker.timeline,
      issuedGeneration: Math.max(record.issuedGeneration, liveMarker.generation),
      fence: null,
    };
    const effects: OwnershipEffect[] = [
      alert(
        record.customerId,
        "conflict_resolved",
        `${event.operator} adopted live generation ${liveMarker.generation}`,
      ),
    ];
    if (finalOwner(liveMarker.timeline) === "cb") {
      effects.unshift({
        type: "sync_cb_from_stripe",
        customerId: record.customerId,
        notBefore: at,
      });
    }
    return { outcome: "transitioned", record: settle(base, at), effects };
  }

  // restore_confirmed rewrites history: any live entry that is not in the confirmed
  // timeline disappears, so events created inside it route differently from now on.
  const generation = nextGeneration(record, liveMarker);
  const fence: FenceWrite = {
    generation,
    timeline: record.timeline,
    attempts: 1,
    keyNonce: 0,
    notAfter: null,
    required: true,
  };
  return {
    outcome: "transitioned",
    record: settle({ ...baseOf(record), issuedGeneration: generation, fence }, at),
    effects: [
      writeMarker(record.customerId, generation, record.timeline, 0, null),
      alert(
        record.customerId,
        "history_rewritten",
        `${event.operator} restored confirmed generation ${record.generation} as ${generation}, ` +
          `replacing live ${serializeTimeline(liveMarker.timeline)}; events created inside removed entries ` +
          "and not yet stamped now route by the confirmed timeline",
      ),
    ],
  };
}

export function transition(
  record: OwnershipRecord,
  event: OwnershipEvent,
  policy: OwnershipPolicy,
): TransitionResult {
  switch (event.type) {
    case "HANDOVER_REQUESTED":
    case "HANDBACK_REQUESTED":
      return requestTransition(record, event, policy);
    case "MARKER_OBSERVED":
      return observeMarker(record, event, policy);
    case "MARKER_WRITE_FAILED":
      return markerWriteFailed(record, event, policy);
    case "DEADLINE_REACHED":
      if (
        (record.state === "handover_pending" || record.state === "handback_pending") &&
        event.at >= record.pending.deadline
      ) {
        return cancelPending(
          record,
          event.liveMarker,
          event.at,
          "flip_deadline_missed",
          `write not confirmed by ${record.pending.deadline}`,
        );
      }
      return unchanged(record);
    case "ABORT_REQUESTED":
      if (record.state !== "handover_pending" && record.state !== "handback_pending") {
        return rejected(record, ["nothing_to_abort"]);
      }
      if (event.at >= record.pending.flipAt) return rejected(record, ["flip_time_passed"]);
      return cancelPending(record, event.liveMarker, event.at, "transition_aborted", event.reason);
    case "CONFLICT_RESOLVED":
      return resolveConflict(record, event);
    default:
      return unreachable(event);
  }
}
