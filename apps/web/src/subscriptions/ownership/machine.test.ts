import { describe, expect, it } from "vitest";

import {
  accessGranted,
  lenientStatusRule,
  strictPaidThroughRule,
  type StripeSubscriptionStatus,
} from "./access-rule";
import {
  createOwnershipRecord,
  ownershipPolicyProblems,
  suggestedOwnershipPolicy,
  transition,
  transitionRejections,
  type MarkerWriteFailure,
  type OwnershipEffect,
  type OwnershipEvent,
  type OwnershipPolicy,
  type OwnershipRecord,
  type OwnershipState,
  type SubscriptionFacts,
  type TransitionFacts,
  type TransitionResult,
} from "./machine";
import {
  ownerMarkerMetadata,
  readOwnerMarker,
  type OwnerMarker,
  type OwnerTimeline,
} from "./marker";

const CUS = "cus_synthetic_1";
const NOW = 1_800_000_000;
const DAY = 86_400;

const policy = suggestedOwnershipPolicy({ cbAccessRule: lenientStatusRule, accessReadSide: "cb" });
const LEAD = policy.flipLeadSeconds;
const FLIP = NOW + LEAD;
const DEADLINE = FLIP - policy.markerCacheTtlSeconds - policy.landingMarginSeconds;

function liveMarker(timeline: OwnerTimeline, generation: number): OwnerMarker {
  return readOwnerMarker(ownerMarkerMetadata(timeline, generation));
}

const subscription: SubscriptionFacts = {
  subscriptionId: "sub_1",
  status: "active",
  paidThroughAt: NOW + 10 * DAY,
  team: null,
};

function factsFor(
  record: OwnershipRecord,
  overrides: Partial<TransitionFacts> = {},
): TransitionFacts {
  const marker =
    record.generation === 0 && record.timeline.length === 1 && record.timeline[0]?.owner === "rails"
      ? readOwnerMarker({})
      : liveMarker(record.timeline, record.generation);
  return {
    liveMarker: marker,
    subscriptions: [subscription],
    lastStripeEventAt: NOW - 3600,
    acceptAccessChange: false,
    ...overrides,
  };
}

function railsRecord(): OwnershipRecord {
  return createOwnershipRecord({ customerId: CUS, marker: readOwnerMarker({}), at: NOW - DAY })
    .record;
}

function request(
  record: OwnershipRecord,
  type: "HANDOVER_REQUESTED" | "HANDBACK_REQUESTED" = "HANDOVER_REQUESTED",
  at = NOW,
  batchId = "batch-1",
  facts?: TransitionFacts,
): OwnershipEvent {
  return { type, batchId, at, facts: facts ?? factsFor(record) };
}

function step(
  record: OwnershipRecord,
  event: OwnershipEvent,
  p: OwnershipPolicy = policy,
): TransitionResult {
  return transition(record, event, p);
}

function pendingOf(record: OwnershipRecord) {
  if (record.state !== "handover_pending" && record.state !== "handback_pending") {
    throw new Error(`expected pending, got ${record.state}`);
  }
  return record.pending;
}

function writes(effects: readonly OwnershipEffect[]) {
  return effects.filter((effect) => effect.type === "write_marker");
}

function alertCodes(effects: readonly OwnershipEffect[]) {
  return effects.flatMap((effect) => (effect.type === "alert" ? [effect.code] : []));
}

/** rails_owned -> handover_pending (gen 1) */
function handoverPending(): OwnershipRecord {
  return step(railsRecord(), request(railsRecord())).record;
}

/** handover committed: cb from FLIP, gen 1 */
function cbRecord(): OwnershipRecord {
  const pending = handoverPending();
  const p = pendingOf(pending);
  return step(pending, {
    type: "MARKER_OBSERVED",
    marker: liveMarker(p.timeline, p.generation),
    at: NOW + 5,
    landedAt: NOW + 5,
  }).record;
}

function failure(
  generation: number,
  kind: MarkerWriteFailure,
  at: number,
  facts: TransitionFacts | null,
): OwnershipEvent {
  return { type: "MARKER_WRITE_FAILED", generation, failure: kind, at, error: kind, facts };
}

describe("policy", () => {
  it("suggests a usable policy and takes the access law as an input", () => {
    expect(ownershipPolicyProblems(policy)).toEqual([]);
    const strict = suggestedOwnershipPolicy({
      cbAccessRule: strictPaidThroughRule,
      accessReadSide: "rails",
    });
    expect(strict.cbAccessRule).toBe(strictPaidThroughRule);
    expect(strict.railsAccessRule).toBe(lenientStatusRule);
  });

  it("rejects a lead time that cannot outlast the marker cache, and refuses to flip with it", () => {
    const bad = { ...policy, flipLeadSeconds: 100 };
    expect(ownershipPolicyProblems(bad)).toHaveLength(1);
    expect(ownershipPolicyProblems({ ...policy, timelineRetentionSeconds: DAY })).toHaveLength(1);
    expect(step(railsRecord(), request(railsRecord()), bad)).toMatchObject({
      outcome: "rejected",
      reasons: ["policy_invalid"],
    });
  });
});

describe("access rules", () => {
  it("lenient grants by status (ADR-0006); strict needs an active paid period (ADR-0008)", () => {
    for (const status of ["active", "trialing", "past_due"] as const) {
      expect(
        accessGranted(lenientStatusRule.evaluate({ status, paidThroughAt: NOW - DAY, now: NOW })),
      ).toBe(true);
    }
    expect(
      lenientStatusRule.evaluate({ status: "canceled", paidThroughAt: NOW + DAY, now: NOW }),
    ).toBe("status_no_grant");
    expect(
      strictPaidThroughRule.evaluate({ status: "active", paidThroughAt: NOW + 1, now: NOW }),
    ).toBe("paid_through");
    expect(strictPaidThroughRule.evaluate({ status: "active", paidThroughAt: NOW, now: NOW })).toBe(
      "not_paid_through",
    );
    expect(
      strictPaidThroughRule.evaluate({ status: "trialing", paidThroughAt: NOW + DAY, now: NOW }),
    ).toBe("not_paid_through");
  });
});

describe("handover happy path", () => {
  it("schedules the flip ahead, writes before a deadline, and commits when the write is seen", () => {
    const start = railsRecord();
    const result = step(start, request(start));
    expect(result.outcome).toBe("transitioned");
    const pending = pendingOf(result.record);
    expect(pending).toMatchObject({
      generation: 1,
      flipAt: FLIP,
      deadline: DEADLINE,
      attempts: 1,
      keyNonce: 0,
    });
    expect(pending.timeline).toEqual([
      { owner: "rails", since: 0 },
      { owner: "cb", since: FLIP },
    ]);
    expect(result.effects).toEqual([
      {
        type: "write_marker",
        customerId: CUS,
        generation: 1,
        timeline: pending.timeline,
        metadata: {
          egghead_owner: "cb",
          egghead_owner_timeline: `rails@0;cb@${FLIP}`,
          egghead_owner_generation: "1",
        },
        idempotencyKey: `egghead-owner:${CUS}:1:0`,
        notAfter: DEADLINE,
      },
    ]);

    // Not landed yet: nothing changes.
    expect(
      step(result.record, {
        type: "MARKER_OBSERVED",
        marker: readOwnerMarker({}),
        at: NOW + 1,
        landedAt: NOW + 1,
      }),
    ).toEqual({
      outcome: "unchanged",
      record: result.record,
      effects: [],
    });

    const committed = step(result.record, {
      type: "MARKER_OBSERVED",
      marker: liveMarker(pending.timeline, 1),
      at: NOW + 5,
      landedAt: NOW + 4,
    });
    expect(committed.record).toMatchObject({
      state: "cb_owned",
      generation: 1,
      issuedGeneration: 1,
      fence: null,
    });
    expect(committed.effects).toEqual([
      { type: "sync_cb_from_stripe", customerId: CUS, notBefore: FLIP },
    ]);
  });

  it("alerts when the write lands too late for every cache to see it before the flip", () => {
    const pending = handoverPending();
    const p = pendingOf(pending);
    const late = step(pending, {
      type: "MARKER_OBSERVED",
      marker: liveMarker(p.timeline, p.generation),
      at: FLIP + 10,
      landedAt: FLIP - policy.markerCacheTtlSeconds + 1,
    });
    expect(late.record.state).toBe("cb_owned");
    expect(alertCodes(late.effects)).toEqual(["flip_landed_late"]);
  });

  it("is a no-op for a customer that already moved", () => {
    const owned = cbRecord();
    expect(step(owned, request(owned))).toEqual({
      outcome: "unchanged",
      record: owned,
      effects: [],
    });
  });
});

describe("customer as the unit (2.6)", () => {
  it("guards every subscription on the customer", () => {
    const start = railsRecord();
    const facts = factsFor(start, {
      subscriptions: [
        subscription,
        { ...subscription, subscriptionId: "sub_2", status: "past_due" },
      ],
    });
    expect(step(start, request(start, "HANDOVER_REQUESTED", NOW, "b", facts))).toMatchObject({
      outcome: "rejected",
      reasons: ["status_not_eligible"],
    });
  });

  it("moves a customer with no live subscription", () => {
    const start = railsRecord();
    const facts = factsFor(start, {
      subscriptions: [{ ...subscription, status: "canceled", paidThroughAt: NOW - DAY }],
    });
    expect(step(start, request(start, "HANDOVER_REQUESTED", NOW, "b", facts)).outcome).toBe(
      "transitioned",
    );
    expect(
      step(
        start,
        request(start, "HANDOVER_REQUESTED", NOW, "b", factsFor(start, { subscriptions: [] })),
      ).outcome,
    ).toBe("transitioned");
  });
});

describe("guards", () => {
  const reasonsFor = (
    overrides: Partial<TransitionFacts>,
    direction: "handover" | "handback" = "handover",
    p: OwnershipPolicy = policy,
  ) => {
    const record = direction === "handover" ? railsRecord() : cbRecord();
    return transitionRejections({
      direction,
      facts: factsFor(record, overrides),
      record,
      policy: p,
      at: NOW,
      flipAt: FLIP,
    });
  };

  it("passes an eligible customer", () => {
    expect(reasonsFor({})).toEqual([]);
  });

  it("refuses an unrecognized or out-of-sync live marker", () => {
    expect(reasonsFor({ liveMarker: readOwnerMarker({ egghead_owner: "cb" }) })).toEqual([
      "marker_unrecognized",
    ]);
    expect(reasonsFor({ liveMarker: liveMarker([{ owner: "rails", since: 0 }], 7) })).toEqual([
      "marker_out_of_sync",
    ]);
  });

  it("refuses while access is read from Rails", () => {
    expect(reasonsFor({}, "handover", { ...policy, accessReadSide: "rails" })).toEqual([
      "access_read_side_is_rails",
    ]);
  });

  it("refuses dunning and incomplete statuses", () => {
    for (const status of [
      "past_due",
      "unpaid",
      "incomplete",
      "paused",
    ] as StripeSubscriptionStatus[]) {
      expect(reasonsFor({ subscriptions: [{ ...subscription, status }] })).toContain(
        "status_not_eligible",
      );
    }
  });

  it("measures the renewal window from the flip time", () => {
    const window = policy.renewalQuietWindowSeconds;
    expect(
      reasonsFor({ subscriptions: [{ ...subscription, paidThroughAt: FLIP + window - 1 }] }),
    ).toEqual(["renewal_window"]);
    expect(
      reasonsFor({ subscriptions: [{ ...subscription, paidThroughAt: FLIP + window }] }),
    ).toEqual([]);
    expect(reasonsFor({ subscriptions: [{ ...subscription, paidThroughAt: null }] })).toEqual([
      "renewal_window",
    ]);
  });

  it("waits for recent Stripe activity to settle", () => {
    expect(reasonsFor({ lastStripeEventAt: NOW - 599 })).toEqual(["recent_stripe_activity"]);
    expect(reasonsFor({ lastStripeEventAt: NOW - 600 })).toEqual([]);
  });

  it("guards team seats", () => {
    const team = { quantity: 5, seatsProjectedToCb: true, pendingSeatChange: false };
    expect(reasonsFor({ subscriptions: [{ ...subscription, team }] })).toEqual([]);
    expect(
      reasonsFor({
        subscriptions: [{ ...subscription, team: { ...team, seatsProjectedToCb: false } }],
      }),
    ).toEqual(["team_seats_not_projected"]);
    expect(
      reasonsFor({
        subscriptions: [{ ...subscription, team: { ...team, pendingSeatChange: true } }],
      }),
    ).toEqual(["team_seat_change_pending"]);
  });

  it("refuses an access change under the chosen law unless acknowledged", () => {
    const strict = { ...policy, cbAccessRule: strictPaidThroughRule };
    const trialing = [{ ...subscription, status: "trialing" as const }];
    expect(reasonsFor({ subscriptions: trialing }, "handover", strict)).toEqual([
      "access_would_change",
    ]);
    expect(
      reasonsFor({ subscriptions: trialing, acceptAccessChange: true }, "handover", strict),
    ).toEqual([]);
    expect(reasonsFor({ subscriptions: trialing })).toEqual([]);
  });

  it("reports every failing guard at once", () => {
    expect(
      reasonsFor({
        lastStripeEventAt: NOW,
        subscriptions: [{ ...subscription, status: "past_due" }],
      }),
    ).toEqual(["recent_stripe_activity", "status_not_eligible"]);
  });
});

describe("handback (2.5)", () => {
  it("applies the same guards, renewal window included", () => {
    const owned = cbRecord();
    const facts = factsFor(owned, {
      subscriptions: [{ ...subscription, paidThroughAt: NOW + 3600 }],
    });
    expect(step(owned, request(owned, "HANDBACK_REQUESTED", NOW + 100, "rb", facts))).toMatchObject(
      {
        outcome: "rejected",
        reasons: ["renewal_window"],
      },
    );
  });

  it("takes generation max(live, issued) + 1 and schedules rails after the cb entry", () => {
    const owned = cbRecord();
    const at = FLIP + 100;
    const result = step(owned, request(owned, "HANDBACK_REQUESTED", at, "rb"));
    const pending = pendingOf(result.record);
    expect(result.record.state).toBe("handback_pending");
    expect(pending.generation).toBe(2);
    expect(pending.timeline).toEqual([
      { owner: "rails", since: 0 },
      { owner: "cb", since: FLIP },
      { owner: "rails", since: at + LEAD },
    ]);
    const done = step(result.record, {
      type: "MARKER_OBSERVED",
      marker: liveMarker(pending.timeline, 2),
      at: at + 3,
      landedAt: at + 3,
    });
    expect(done.record).toMatchObject({ state: "rails_owned", generation: 2 });
    expect(done.effects).toEqual([]);
  });

  it("refuses once Rails is retired", () => {
    const owned = cbRecord();
    expect(
      step(owned, request(owned, "HANDBACK_REQUESTED", FLIP + 100, "rb"), {
        ...policy,
        railsAcceptsHandback: false,
      }),
    ).toMatchObject({
      outcome: "rejected",
      reasons: ["rails_retired"],
    });
  });
});

describe("idempotency keys on retry (2.3)", () => {
  const pending = handoverPending();
  const facts = factsFor(railsRecord());

  it("mints a new key after a 5xx, because Stripe replays a cached 5xx", () => {
    const result = step(pending, failure(1, "server_error", NOW + 10, facts));
    expect(writes(result.effects)).toEqual([
      expect.objectContaining({ idempotencyKey: `egghead-owner:${CUS}:1:1`, notAfter: DEADLINE }),
    ]);
    expect(pendingOf(result.record)).toMatchObject({ attempts: 2, keyNonce: 1 });
  });

  it("reuses the key after a transport timeout or rate limit", () => {
    for (const kind of ["timeout", "rate_limited"] as const) {
      const result = step(pending, failure(1, kind, NOW + 10, facts));
      expect(writes(result.effects)).toEqual([
        expect.objectContaining({ idempotencyKey: `egghead-owner:${CUS}:1:0` }),
      ]);
    }
  });

  it("cancels on a 4xx instead of retrying", () => {
    const result = step(pending, failure(1, "client_error", NOW + 10, facts));
    expect(result.record).toMatchObject({ state: "rails_owned", issuedGeneration: 2 });
    expect(alertCodes(result.effects)).toEqual(["marker_write_rejected"]);
  });
});

describe("retries and re-drives re-check facts (2.4)", () => {
  const pending = handoverPending();

  it("needs fresh facts to retry", () => {
    expect(step(pending, failure(1, "timeout", NOW + 10, null))).toMatchObject({
      outcome: "rejected",
      reasons: ["fresh_facts_required"],
    });
  });

  it("cancels and fences when the fresh facts fail a guard", () => {
    const facts = factsFor(railsRecord(), { lastStripeEventAt: NOW + 5 });
    const result = step(pending, failure(1, "timeout", NOW + 10, facts));
    expect(result.record).toMatchObject({
      state: "rails_owned",
      issuedGeneration: 2,
      fence: { generation: 2 },
    });
    expect(alertCodes(result.effects)).toEqual(["flip_guard_failed"]);
  });

  it("commits when the fresh facts show the 'failed' write landed", () => {
    const p = pendingOf(pending);
    const facts = factsFor(railsRecord(), { liveMarker: liveMarker(p.timeline, p.generation) });
    expect(step(pending, failure(1, "timeout", NOW + 10, facts)).record.state).toBe("cb_owned");
  });

  it("re-drives the same batch with fresh guards and a new key; refuses another batch", () => {
    const again = step(pending, request(railsRecord(), "HANDOVER_REQUESTED", NOW + 30));
    expect(again.outcome).toBe("unchanged");
    expect(writes(again.effects)).toEqual([
      expect.objectContaining({ idempotencyKey: `egghead-owner:${CUS}:1:1` }),
    ]);
    const failing = step(
      pending,
      request(
        railsRecord(),
        "HANDOVER_REQUESTED",
        NOW + 30,
        "batch-1",
        factsFor(railsRecord(), { lastStripeEventAt: NOW + 29 }),
      ),
    );
    expect(failing.record.state).toBe("rails_owned");
    expect(
      step(pending, request(railsRecord(), "HANDOVER_REQUESTED", NOW + 30, "batch-9")),
    ).toMatchObject({
      outcome: "rejected",
      reasons: ["transition_in_flight"],
    });
    expect(step(pending, request(railsRecord(), "HANDBACK_REQUESTED", NOW + 30))).toMatchObject({
      outcome: "rejected",
      reasons: ["transition_in_flight"],
    });
  });

  it("expires at the deadline, whether by timer or by a late retry", () => {
    expect(step(pending, { type: "DEADLINE_REACHED", at: DEADLINE - 1 }).outcome).toBe("unchanged");
    const expired = step(pending, { type: "DEADLINE_REACHED", at: DEADLINE });
    expect(expired.record).toMatchObject({ state: "rails_owned", fence: { generation: 2 } });
    expect(alertCodes(expired.effects)).toEqual(["flip_deadline_missed"]);
    const lateRetry = step(pending, failure(1, "timeout", DEADLINE + 1, factsFor(railsRecord())));
    expect(alertCodes(lateRetry.effects)).toEqual(["flip_deadline_missed"]);
  });

  it("cancels after the attempt limit", () => {
    let record = pending;
    for (let attempt = 1; attempt < policy.maxMarkerWriteAttempts; attempt++) {
      record = step(record, failure(1, "timeout", NOW + attempt, factsFor(railsRecord()))).record;
    }
    expect(pendingOf(record).attempts).toBe(policy.maxMarkerWriteAttempts);
    const exhausted = step(record, failure(1, "timeout", NOW + 50, factsFor(railsRecord())));
    expect(exhausted.record.state).toBe("rails_owned");
    expect(alertCodes(exhausted.effects)).toEqual(["marker_write_retries_exhausted"]);
  });
});

describe("fencing (2.2)", () => {
  const pending = handoverPending();
  const p = pendingOf(pending);
  const aborted = step(pending, { type: "ABORT_REQUESTED", at: NOW + 60, reason: "bad batch" });

  it("abort writes the confirmed timeline at a newer generation and stops writing the old one", () => {
    expect(aborted.record).toMatchObject({
      state: "rails_owned",
      generation: 0,
      issuedGeneration: 2,
      fence: { generation: 2 },
    });
    expect(writes(aborted.effects)).toEqual([
      expect.objectContaining({
        generation: 2,
        timeline: [{ owner: "rails", since: 0 }],
        notAfter: null,
      }),
    ]);
    // A failure report for the fenced generation issues nothing.
    expect(step(aborted.record, failure(1, "timeout", NOW + 70, factsFor(railsRecord())))).toEqual({
      outcome: "unchanged",
      record: aborted.record,
      effects: [],
    });
  });

  it("a late cb write after abort is a conflict, not a silent adopt", () => {
    const late = step(aborted.record, {
      type: "MARKER_OBSERVED",
      marker: liveMarker(p.timeline, 1),
      at: NOW + 90,
      landedAt: NOW + 90,
    });
    expect(late.record.state).toBe("conflict");
    expect(late.record).toMatchObject({
      conflict: { reason: "fenced_write_landed", observed: { generation: 1 } },
    });
    expect(alertCodes(late.effects)).toEqual(["fenced_write_landed"]);
    // Automation is frozen.
    expect(step(late.record, request(railsRecord()))).toMatchObject({
      outcome: "rejected",
      reasons: ["conflict_unresolved"],
    });
    // Seeing it again stays quiet.
    expect(
      step(late.record, {
        type: "MARKER_OBSERVED",
        marker: liveMarker(p.timeline, 1),
        at: NOW + 99,
        landedAt: NOW + 99,
      }).effects,
    ).toEqual([]);
  });

  it("an operator resolves by adopting the live marker or restoring the confirmed one", () => {
    const conflict = step(aborted.record, {
      type: "MARKER_OBSERVED",
      marker: liveMarker(p.timeline, 1),
      at: NOW + 90,
      landedAt: NOW + 90,
    }).record;
    const adopted = step(conflict, {
      type: "CONFLICT_RESOLVED",
      at: NOW + 120,
      decision: "adopt_live",
      liveMarker: liveMarker(p.timeline, 1),
      operator: "desk",
    });
    expect(adopted.record).toMatchObject({
      state: "cb_owned",
      generation: 1,
      issuedGeneration: 2,
      fence: null,
    });
    expect(adopted.effects[0]).toEqual({
      type: "sync_cb_from_stripe",
      customerId: CUS,
      notBefore: NOW + 120,
    });

    const restored = step(conflict, {
      type: "CONFLICT_RESOLVED",
      at: NOW + 120,
      decision: "restore_confirmed",
      liveMarker: liveMarker(p.timeline, 1),
      operator: "desk",
    });
    expect(restored.record).toMatchObject({
      state: "rails_owned",
      issuedGeneration: 3,
      fence: { generation: 3 },
    });
    expect(writes(restored.effects)).toEqual([
      expect.objectContaining({ generation: 3, timeline: [{ owner: "rails", since: 0 }] }),
    ]);
    expect(
      step(railsRecord(), {
        type: "CONFLICT_RESOLVED",
        at: NOW,
        decision: "adopt_live",
        liveMarker: readOwnerMarker({}),
        operator: "desk",
      }),
    ).toMatchObject({
      reasons: ["no_conflict"],
    });
  });

  it("clears the fence when it lands, and blocks new flips until then", () => {
    expect(
      step(aborted.record, request(aborted.record, "HANDOVER_REQUESTED", NOW + 100)),
    ).toMatchObject({
      reasons: ["fence_outstanding"],
    });
    const landed = step(aborted.record, {
      type: "MARKER_OBSERVED",
      marker: liveMarker([{ owner: "rails", since: 0 }], 2),
      at: NOW + 100,
      landedAt: NOW + 100,
    });
    expect(landed.record).toMatchObject({ state: "rails_owned", generation: 2, fence: null });
    const next = step(
      landed.record,
      request(landed.record, "HANDOVER_REQUESTED", NOW + 200, "batch-2"),
    );
    expect(pendingOf(next.record).generation).toBe(3);
  });

  it("a fence write that keeps failing becomes a conflict", () => {
    let record = aborted.record;
    for (let attempt = 1; attempt < policy.maxMarkerWriteAttempts; attempt++) {
      const result = step(record, failure(2, "server_error", NOW + 100 + attempt, null));
      expect(writes(result.effects)).toEqual([
        expect.objectContaining({ idempotencyKey: `egghead-owner:${CUS}:2:${attempt}` }),
      ]);
      record = result.record;
    }
    const failed = step(record, failure(2, "server_error", NOW + 200, null));
    expect(failed.record).toMatchObject({
      state: "conflict",
      conflict: { reason: "fence_write_failed" },
    });
  });

  it("an unknown newer generation is an external write and freezes automation", () => {
    const owned = cbRecord();
    const external = step(owned, {
      type: "MARKER_OBSERVED",
      marker: liveMarker([{ owner: "rails", since: 0 }], 9),
      at: FLIP + 5,
      landedAt: FLIP + 5,
    });
    expect(external.record).toMatchObject({
      state: "conflict",
      conflict: { reason: "external_write" },
    });
  });

  it("abort is refused once the flip time has passed", () => {
    expect(step(pending, { type: "ABORT_REQUESTED", at: FLIP, reason: "x" })).toMatchObject({
      reasons: ["flip_time_passed"],
    });
    expect(step(railsRecord(), { type: "ABORT_REQUESTED", at: NOW, reason: "x" })).toMatchObject({
      reasons: ["nothing_to_abort"],
    });
  });
});

describe("unrecognized marker alerts are deduplicated (2.10)", () => {
  const garbled = readOwnerMarker({ egghead_owner: "cb" });

  it("alerts once per cooldown", () => {
    const first = step(railsRecord(), {
      type: "MARKER_OBSERVED",
      marker: garbled,
      at: NOW,
      landedAt: NOW,
    });
    expect(first.record).toMatchObject({
      state: "conflict",
      conflict: { reason: "marker_unrecognized" },
    });
    expect(alertCodes(first.effects)).toEqual(["marker_unrecognized"]);

    const soon = step(first.record, {
      type: "MARKER_OBSERVED",
      marker: garbled,
      at: NOW + 3600,
      landedAt: NOW + 3600,
    });
    expect(soon).toEqual({ outcome: "unchanged", record: first.record, effects: [] });

    const later = step(first.record, {
      type: "MARKER_OBSERVED",
      marker: garbled,
      at: NOW + policy.alertCooldownSeconds,
      landedAt: NOW,
    });
    expect(alertCodes(later.effects)).toEqual(["marker_unrecognized"]);
    expect(later.record.lastUnrecognizedAlertAt).toBe(NOW + policy.alertCooldownSeconds);
  });

  it("first sighting of a garbled marker starts in conflict with one alert", () => {
    const created = createOwnershipRecord({ customerId: CUS, marker: garbled, at: NOW });
    expect(created.record.state).toBe("conflict");
    expect(alertCodes(created.effects)).toEqual(["marker_unrecognized"]);
    expect(
      step(created.record, {
        type: "MARKER_OBSERVED",
        marker: garbled,
        at: NOW + 10,
        landedAt: NOW,
      }).effects,
    ).toEqual([]);
  });
});

describe("state x event matrix", () => {
  const states: Record<OwnershipState, () => OwnershipRecord> = {
    rails_owned: railsRecord,
    handover_pending: handoverPending,
    cb_owned: cbRecord,
    handback_pending: () => {
      const owned = cbRecord();
      return step(owned, request(owned, "HANDBACK_REQUESTED", FLIP + 100, "rb")).record;
    },
    conflict: () =>
      step(railsRecord(), {
        type: "MARKER_OBSERVED",
        marker: readOwnerMarker({ egghead_owner: "x" }),
        at: NOW,
        landedAt: NOW,
      }).record,
  };

  const events: Record<string, (record: OwnershipRecord) => OwnershipEvent> = {
    handover: (record) => request(record, "HANDOVER_REQUESTED", FLIP + 200, "matrix"),
    handback: (record) => request(record, "HANDBACK_REQUESTED", FLIP + 200, "matrix"),
    observe_same: (record) => ({
      type: "MARKER_OBSERVED",
      marker: factsFor(record).liveMarker,
      at: FLIP + 200,
      landedAt: FLIP + 200,
    }),
    write_failed_stale: () => failure(99, "timeout", FLIP + 200, null),
    deadline: () => ({ type: "DEADLINE_REACHED", at: FLIP + 200 }),
    abort: () => ({ type: "ABORT_REQUESTED", at: FLIP + 200, reason: "matrix" }),
    resolve: () => ({
      type: "CONFLICT_RESOLVED",
      at: FLIP + 200,
      decision: "adopt_live",
      liveMarker: readOwnerMarker({}),
      operator: "desk",
    }),
  };

  const expected: Record<OwnershipState, Record<string, [string, OwnershipState]>> = {
    rails_owned: {
      handover: ["transitioned", "handover_pending"],
      handback: ["unchanged", "rails_owned"],
      observe_same: ["unchanged", "rails_owned"],
      write_failed_stale: ["unchanged", "rails_owned"],
      deadline: ["unchanged", "rails_owned"],
      abort: ["rejected", "rails_owned"],
      resolve: ["rejected", "rails_owned"],
    },
    handover_pending: {
      handover: ["rejected", "handover_pending"],
      handback: ["rejected", "handover_pending"],
      observe_same: ["unchanged", "handover_pending"],
      write_failed_stale: ["unchanged", "handover_pending"],
      deadline: ["transitioned", "rails_owned"],
      abort: ["rejected", "handover_pending"],
      resolve: ["rejected", "handover_pending"],
    },
    cb_owned: {
      handover: ["unchanged", "cb_owned"],
      handback: ["transitioned", "handback_pending"],
      observe_same: ["unchanged", "cb_owned"],
      write_failed_stale: ["unchanged", "cb_owned"],
      deadline: ["unchanged", "cb_owned"],
      abort: ["rejected", "cb_owned"],
      resolve: ["rejected", "cb_owned"],
    },
    handback_pending: {
      handover: ["rejected", "handback_pending"],
      handback: ["rejected", "handback_pending"],
      observe_same: ["unchanged", "handback_pending"],
      write_failed_stale: ["unchanged", "handback_pending"],
      deadline: ["unchanged", "handback_pending"],
      abort: ["transitioned", "cb_owned"],
      resolve: ["rejected", "handback_pending"],
    },
    conflict: {
      handover: ["rejected", "conflict"],
      handback: ["rejected", "conflict"],
      observe_same: ["unchanged", "conflict"],
      write_failed_stale: ["unchanged", "conflict"],
      deadline: ["unchanged", "conflict"],
      abort: ["rejected", "conflict"],
      resolve: ["transitioned", "rails_owned"],
    },
  };

  const allStates: readonly OwnershipState[] = [
    "rails_owned",
    "handover_pending",
    "cb_owned",
    "handback_pending",
    "conflict",
  ];
  for (const state of allStates) {
    const build = states[state];
    for (const [name, make] of Object.entries(events)) {
      const want = expected[state][name];
      it(`${state} + ${name}`, () => {
        if (want === undefined) throw new Error("missing expectation");
        const record = build();
        expect(record.state).toBe(state);
        const result = step(record, make(record));
        expect([result.outcome, result.record.state]).toEqual(want);
        if (result.outcome === "rejected") expect(result.effects).toEqual([]);
      });
    }
  }
});
