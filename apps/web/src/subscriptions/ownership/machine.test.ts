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
  ownerAt,
  ownerMarkerMetadata,
  readOwnerMarker,
  RAILS_FROM_START,
  type OwnerMarker,
  type OwnerTimeline,
} from "./marker";

const CUS = "cus_synthetic_1";
const NOW = 1_800_000_000;
const DAY = 86_400;

const policy = suggestedOwnershipPolicy({ cbAccessRule: lenientStatusRule, accessReadSide: "cb" });
const LEAD = policy.flipLeadSeconds;
const TTL = policy.markerCacheTtlSeconds;
const FLIP = NOW + LEAD;
const DEADLINE = FLIP - TTL - policy.landingMarginSeconds;

const ABSENT = readOwnerMarker({});

function liveMarker(timeline: OwnerTimeline, generation: number): OwnerMarker {
  return readOwnerMarker(ownerMarkerMetadata(timeline, generation));
}

function confirmedMarker(record: OwnershipRecord): OwnerMarker {
  return record.generation === 0 &&
    record.timeline.length === 1 &&
    record.timeline[0]?.owner === "rails"
    ? ABSENT
    : liveMarker(record.timeline, record.generation);
}

const subscription: SubscriptionFacts = {
  subscriptionId: "sub_1",
  status: "active",
  paidThroughAt: NOW + 10 * DAY,
  team: null,
};

function factsWith(live: OwnerMarker, overrides: Partial<TransitionFacts> = {}): TransitionFacts {
  return {
    liveMarker: live,
    subscriptions: [subscription],
    lastStripeEventAt: NOW - 3600,
    acceptAccessChange: false,
    ...overrides,
  };
}

function factsFor(
  record: OwnershipRecord,
  overrides: Partial<TransitionFacts> = {},
): TransitionFacts {
  return factsWith(confirmedMarker(record), overrides);
}

function railsRecord(): OwnershipRecord {
  return createOwnershipRecord({ customerId: CUS, marker: ABSENT, at: NOW - DAY }).record;
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

function observe(
  marker: OwnerMarker,
  at: number,
  source: "event" | "live_read" = "live_read",
  landedAt = at,
): OwnershipEvent {
  return { type: "MARKER_OBSERVED", source, marker, at, landedAt };
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

/** rails_owned -> handover_pending (gen 1, flip at FLIP) */
function handoverPending(): OwnershipRecord {
  return step(railsRecord(), request(railsRecord())).record;
}

function withAttempts(record: OwnershipRecord, attempts: number): OwnershipRecord {
  if (record.state !== "handover_pending" && record.state !== "handback_pending") return record;
  return { ...record, pending: { ...record.pending, attempts } };
}

function pendingMarker(record: OwnershipRecord): OwnerMarker {
  const p = pendingOf(record);
  return liveMarker(p.timeline, p.generation);
}

/** Handover committed by its customer.updated event: cb from FLIP, gen 1, last seen NOW+4. */
function cbRecord(): OwnershipRecord {
  const pending = handoverPending();
  return step(pending, observe(pendingMarker(pending), NOW + 5, "event", NOW + 4)).record;
}

function failure(
  generation: number,
  kind: MarkerWriteFailure,
  at: number,
  facts: TransitionFacts | null,
): OwnershipEvent {
  return { type: "MARKER_WRITE_FAILED", generation, failure: kind, at, error: kind, facts };
}

function abort(at: number, live: OwnerMarker, reason = "operator"): OwnershipEvent {
  return { type: "ABORT_REQUESTED", at, reason, liveMarker: live };
}

function deadline(at: number, live: OwnerMarker): OwnershipEvent {
  return { type: "DEADLINE_REACHED", at, liveMarker: live };
}

describe("policy", () => {
  it("suggests a usable policy and takes the access law as an input", () => {
    expect(ownershipPolicyProblems(policy)).toEqual([]);
    expect(policy.timelineRetentionSeconds).toBe(35 * DAY);
    const strict = suggestedOwnershipPolicy({
      cbAccessRule: strictPaidThroughRule,
      accessReadSide: "rails",
    });
    expect(strict.cbAccessRule).toBe(strictPaidThroughRule);
    expect(strict.railsAccessRule).toBe(lenientStatusRule);
  });

  it("rejects a lead time shorter than the cache, and retention under 35 days", () => {
    const bad = { ...policy, flipLeadSeconds: 100 };
    expect(ownershipPolicyProblems(bad)).toHaveLength(1);
    expect(ownershipPolicyProblems({ ...policy, timelineRetentionSeconds: 30 * DAY })).toHaveLength(
      1,
    );
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
    const pending = pendingOf(result.record);
    expect(pending).toMatchObject({
      generation: 1,
      flipAt: FLIP,
      deadline: DEADLINE,
      attempts: 1,
      keyNonce: 0,
    });
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
    const notYet = step(result.record, observe(ABSENT, NOW + 1));
    expect(notYet.outcome).toBe("unchanged");
    expect(notYet.record.state).toBe("handover_pending");

    const committed = step(
      result.record,
      observe(pendingMarker(result.record), NOW + 5, "event", NOW + 4),
    );
    expect(committed.record).toMatchObject({
      state: "cb_owned",
      generation: 1,
      issuedGeneration: 1,
      fence: null,
      lastObservedAt: NOW + 4,
    });
    expect(committed.effects).toEqual([
      { type: "sync_cb_from_stripe", customerId: CUS, notBefore: FLIP },
    ]);
  });

  it("alerts when the write is first seen too late for every cache to read it before the flip", () => {
    const pending = handoverPending();
    const late = step(pending, observe(pendingMarker(pending), FLIP + 10, "event", FLIP - TTL + 1));
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

describe("stale and out-of-order sightings (7)", () => {
  it("drops a customer.updated older than the last applied sighting, in every state", () => {
    const states: OwnershipRecord[] = [
      railsRecord(),
      handoverPending(),
      cbRecord(),
      step(cbRecord(), request(cbRecord(), "HANDBACK_REQUESTED", FLIP + 100, "rb")).record,
      step(railsRecord(), observe(readOwnerMarker({ egghead_owner: "x" }), NOW)).record,
    ];
    for (const record of states) {
      const last = record.lastObservedAt ?? 0;
      for (const marker of [
        ABSENT,
        liveMarker([{ owner: "cb", since: 0 }], 7),
        readOwnerMarker({ egghead_owner: "x" }),
      ]) {
        const result = step(record, observe(marker, last + 100, "event", last - 1));
        expect(result, record.state).toEqual({ outcome: "unchanged", record, effects: [] });
      }
      // An out-of-order live read result is stale too.
      expect(step(record, observe(ABSENT, last - 1, "live_read")).record).toBe(record);
    }
  });

  it("compares Stripe time with Stripe time only, whatever CB's clock says (6)", () => {
    const pending = handoverPending();
    // CB's clock runs five minutes ahead, and the read is processed late on top of that.
    const SKEW = 300;
    const read = step(pending, observe(ABSENT, NOW + 20 + SKEW + 60, "live_read", NOW + 20));
    expect(read.record.lastObservedAt).toBe(NOW + 20);
    // The commit event was created on Stripe after the read, so it applies.
    const committed = step(
      read.record,
      observe(pendingMarker(pending), NOW + 41 + SKEW, "event", NOW + 40),
    );
    expect(committed.record).toMatchObject({ state: "cb_owned", lastObservedAt: NOW + 40 });
    // A CB clock behind Stripe's does not make old snapshots look fresh either.
    const behind = step(committed.record, observe(ABSENT, NOW - 600, "event", NOW + 39));
    expect(behind.record).toBe(committed.record);
  });

  it("treats a redelivered commit event as a no-op", () => {
    const owned = cbRecord();
    const redelivered = step(
      owned,
      observe(liveMarker(owned.timeline, 1), NOW + 500, "event", NOW + 4),
    );
    expect(redelivered.outcome).toBe("unchanged");
    expect(redelivered.record.state).toBe("cb_owned");
    expect(redelivered.effects).toEqual([]);
  });

  it("asks for a live read when a newer event carries an older generation", () => {
    const owned = cbRecord();
    const ambiguous = step(owned, observe(ABSENT, NOW + 200, "event", NOW + 100));
    expect(ambiguous.record).toBe(owned);
    expect(ambiguous.effects).toEqual([
      expect.objectContaining({ type: "read_live_marker", customerId: CUS }),
    ]);
    // The read shows the confirmed marker: nothing to do.
    const fine = step(owned, observe(liveMarker(owned.timeline, 1), NOW + 210));
    expect(fine.record.state).toBe("cb_owned");
    expect(fine.effects).toEqual([]);
  });

  it("in a pending flip, an old snapshot neither commits nor conflicts", () => {
    const pending = handoverPending();
    const old = step(pending, observe(ABSENT, NOW + 20, "event", NOW - 2 * DAY));
    expect(old.record).toBe(pending);
  });

  it("a zombie behind a landed fence is found only by the live read", () => {
    const pending = handoverPending();
    const aborted = step(pending, abort(NOW + 60, ABSENT)).record;
    const fenced = step(
      aborted,
      observe(liveMarker(RAILS_FROM_START, 2), NOW + 70, "event", NOW + 65),
    ).record;
    expect(fenced).toMatchObject({ state: "rails_owned", generation: 2, fence: null });
    const zombieEvent = step(fenced, observe(pendingMarker(pending), NOW + 90, "event", NOW + 80));
    expect(zombieEvent.record).toBe(fenced);
    expect(zombieEvent.effects).toEqual([expect.objectContaining({ type: "read_live_marker" })]);
    const zombieLive = step(fenced, observe(pendingMarker(pending), NOW + 95));
    expect(zombieLive.record).toMatchObject({
      state: "conflict",
      conflict: { reason: "fenced_write_landed" },
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

  it("refuses an unrecognized or out-of-sync live marker, but not a generation-only difference", () => {
    expect(reasonsFor({ liveMarker: readOwnerMarker({ egghead_owner: "cb" }) })).toEqual([
      "marker_unrecognized",
    ]);
    expect(reasonsFor({ liveMarker: liveMarker([{ owner: "cb", since: 0 }], 7) })).toEqual([
      "marker_out_of_sync",
    ]);
    expect(reasonsFor({ liveMarker: liveMarker(RAILS_FROM_START, 7) })).toEqual([]);
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
    const result = step(
      owned,
      request(owned, "HANDBACK_REQUESTED", at, "rb", factsWith(liveMarker(owned.timeline, 5))),
    );
    const pending = pendingOf(result.record);
    expect(pending.generation).toBe(6);
    expect(pending.timeline).toEqual([
      { owner: "rails", since: 0 },
      { owner: "cb", since: FLIP },
      { owner: "rails", since: at + LEAD },
    ]);
    const done = step(result.record, observe(liveMarker(pending.timeline, 6), at + 3));
    expect(done.record).toMatchObject({ state: "rails_owned", generation: 6 });
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
  const facts = factsWith(ABSENT);

  it("mints a new key after a 5xx, because Stripe replays a cached 5xx", () => {
    const result = step(pending, failure(1, "server_error", NOW + 10, facts));
    expect(writes(result.effects)).toEqual([
      expect.objectContaining({ idempotencyKey: `egghead-owner:${CUS}:1:1`, notAfter: DEADLINE }),
    ]);
    expect(pendingOf(result.record)).toMatchObject({ attempts: 2, keyNonce: 1 });
  });

  it("reuses the key after a timeout, a 429 or a 409 key-in-use", () => {
    for (const kind of ["timeout", "rate_limited", "key_in_use"] as const) {
      const result = step(pending, failure(1, kind, NOW + 10, facts));
      expect(writes(result.effects)).toEqual([
        expect.objectContaining({ idempotencyKey: `egghead-owner:${CUS}:1:0` }),
      ]);
    }
  });

  it("cancels on any other 4xx, fencing at max(live, issued) + 1", () => {
    const result = step(pending, failure(1, "client_error", NOW + 10, facts));
    expect(result.record).toMatchObject({
      state: "rails_owned",
      issuedGeneration: 2,
      fence: { generation: 2, required: false, notAfter: DEADLINE },
    });
    expect(alertCodes(result.effects)).toEqual(["marker_write_rejected"]);
    const higher = step(
      pending,
      failure(1, "client_error", NOW + 10, factsWith(liveMarker(RAILS_FROM_START, 9))),
    );
    expect(higher.record).toMatchObject({ issuedGeneration: 10, fence: { generation: 10 } });
  });
});

describe("retries and re-drives re-check fresh facts (2.4, 8)", () => {
  const pending = handoverPending();

  it("needs fresh facts to retry or cancel", () => {
    expect(step(pending, failure(1, "timeout", NOW + 10, null))).toMatchObject({
      outcome: "rejected",
      reasons: ["fresh_facts_required"],
    });
    expect(step(pending, failure(1, "client_error", NOW + 10, null))).toMatchObject({
      outcome: "rejected",
      reasons: ["fresh_facts_required"],
    });
  });

  it("cancels and fences when the fresh facts fail a guard", () => {
    const result = step(
      pending,
      failure(1, "timeout", NOW + 10, factsWith(ABSENT, { lastStripeEventAt: NOW + 5 })),
    );
    expect(result.record).toMatchObject({
      state: "rails_owned",
      issuedGeneration: 2,
      fence: { generation: 2 },
    });
    expect(alertCodes(result.effects)).toEqual(["flip_guard_failed"]);
  });

  it("goes to conflict, not cancel, when the live marker changed under the flip", () => {
    const external = step(
      pending,
      failure(1, "timeout", NOW + 10, factsWith(liveMarker([{ owner: "cb", since: 0 }], 9))),
    );
    expect(external.record).toMatchObject({
      state: "conflict",
      conflict: { reason: "external_write" },
    });
    expect(writes(external.effects)).toEqual([]);
    const garbled = step(
      pending,
      request(
        railsRecord(),
        "HANDOVER_REQUESTED",
        NOW + 30,
        "batch-1",
        factsWith(readOwnerMarker({ egghead_owner: "x" })),
      ),
    );
    expect(garbled.record).toMatchObject({
      state: "conflict",
      conflict: { reason: "marker_unrecognized" },
    });
    const exhaustedExternal = step(
      withAttempts(pending, policy.maxMarkerWriteAttempts),
      failure(1, "timeout", NOW + 10, factsWith(liveMarker([{ owner: "cb", since: 0 }], 9))),
    );
    expect(exhaustedExternal.record.state).toBe("conflict");
  });

  it("commits when the fresh facts show the 'failed' write landed", () => {
    expect(
      step(pending, failure(1, "timeout", NOW + 10, factsWith(pendingMarker(pending)))).record
        .state,
    ).toBe("cb_owned");
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
        factsWith(ABSENT, { lastStripeEventAt: NOW + 29 }),
      ),
    );
    expect(failing.record.state).toBe("rails_owned");
    expect(
      step(pending, request(railsRecord(), "HANDOVER_REQUESTED", NOW + 30, "batch-9")),
    ).toMatchObject({ outcome: "rejected", reasons: ["transition_in_flight"] });
    expect(step(pending, request(railsRecord(), "HANDBACK_REQUESTED", NOW + 30))).toMatchObject({
      outcome: "rejected",
      reasons: ["transition_in_flight"],
    });
  });

  it("cancels after the attempt limit", () => {
    let record = pending;
    for (let attempt = 1; attempt < policy.maxMarkerWriteAttempts; attempt++) {
      record = step(record, failure(1, "timeout", NOW + attempt, factsWith(ABSENT))).record;
    }
    expect(pendingOf(record).attempts).toBe(policy.maxMarkerWriteAttempts);
    const exhausted = step(record, failure(1, "timeout", NOW + 50, factsWith(ABSENT)));
    expect(exhausted.record.state).toBe("rails_owned");
    expect(alertCodes(exhausted.effects)).toEqual(["marker_write_retries_exhausted"]);
  });
});

describe("cancelling never rewrites routable history (9)", () => {
  const pending = handoverPending();

  it("a deadline with the write not landed settles back without any write", () => {
    expect(step(pending, deadline(DEADLINE - 1, ABSENT)).outcome).toBe("unchanged");
    const expired = step(pending, deadline(DEADLINE, ABSENT));
    expect(expired.record).toMatchObject({
      state: "rails_owned",
      fence: null,
      issuedGeneration: 1,
    });
    expect(writes(expired.effects)).toEqual([]);
    expect(alertCodes(expired.effects)).toEqual(["flip_deadline_missed"]);
    // A late landing of the cancelled write then surfaces as a conflict.
    const late = step(expired.record, observe(pendingMarker(pending), DEADLINE + 30));
    expect(late.record).toMatchObject({
      state: "conflict",
      conflict: { reason: "fenced_write_landed" },
    });
  });

  it("a deadline whose write did land commits, with no conflict and no fence (5)", () => {
    const landed = step(pending, deadline(DEADLINE, pendingMarker(pending)));
    expect(landed.record).toMatchObject({ state: "cb_owned", generation: 1, fence: null });
    expect(landed.effects).toEqual([
      { type: "sync_cb_from_stripe", customerId: CUS, notBefore: FLIP },
    ]);
  });

  it("exhaustion or a 4xx whose write did land commits too (5, 15)", () => {
    const landed = factsWith(pendingMarker(pending));
    expect(step(pending, failure(1, "client_error", NOW + 10, landed)).record.state).toBe(
      "cb_owned",
    );
    const exhausted = withAttempts(pending, policy.maxMarkerWriteAttempts);
    const result = step(exhausted, failure(1, "timeout", NOW + 10, landed));
    expect(result.record.state).toBe("cb_owned");
    expect(writes(result.effects)).toEqual([]);
  });

  it("Stripe's successful write response, fed back as a live read, commits after the deadline", () => {
    const late = step(pending, observe(pendingMarker(pending), DEADLINE + 5, "live_read"));
    expect(late.record.state).toBe("cb_owned");
  });

  it("a live read past the deadline that shows nothing landed settles back", () => {
    expect(step(pending, observe(ABSENT, DEADLINE - 1)).record.state).toBe("handover_pending");
    const settled = step(pending, observe(ABSENT, DEADLINE + 1));
    expect(settled.record).toMatchObject({ state: "rails_owned", fence: null });
    expect(writes(settled.effects)).toEqual([]);
  });

  it("an abort before the deadline fences a landed write, bounded by the deadline", () => {
    const fenced = step(pending, abort(NOW + 60, pendingMarker(pending)));
    expect(fenced.record).toMatchObject({
      state: "rails_owned",
      issuedGeneration: 2,
      fence: { generation: 2, required: true, notAfter: DEADLINE },
    });
    expect(writes(fenced.effects)).toEqual([
      expect.objectContaining({ generation: 2, timeline: RAILS_FROM_START, notAfter: DEADLINE }),
    ]);
  });

  it("an abort after the deadline but before the flip is a conflict when the write landed", () => {
    const late = step(pending, abort(DEADLINE + 10, pendingMarker(pending)));
    expect(late.record).toMatchObject({
      state: "conflict",
      conflict: { reason: "landed_before_cancel" },
    });
    expect(step(pending, abort(FLIP, ABSENT))).toMatchObject({ reasons: ["flip_time_passed"] });
    expect(step(railsRecord(), abort(NOW, ABSENT))).toMatchObject({
      reasons: ["nothing_to_abort"],
    });
  });

  it("restore_confirmed is the one deliberate rewrite, and says so", () => {
    const conflict = step(pending, abort(DEADLINE + 10, pendingMarker(pending))).record;
    expect(conflict.state).toBe("conflict");
    const restored = step(conflict, {
      type: "CONFLICT_RESOLVED",
      at: FLIP + 5,
      decision: "restore_confirmed",
      liveMarker: pendingMarker(pending),
      operator: "desk",
    });
    expect(restored.record).toMatchObject({
      state: "rails_owned",
      issuedGeneration: 2,
      fence: { generation: 2, required: true, notAfter: null },
    });
    expect(alertCodes(restored.effects)).toEqual(["history_rewritten"]);
  });
});

describe("fencing (2.2)", () => {
  const pending = handoverPending();
  const aborted = step(pending, abort(NOW + 60, ABSENT, "bad batch"));

  it("abort writes the confirmed timeline at a newer generation and stops writing the old one", () => {
    expect(aborted.record).toMatchObject({
      state: "rails_owned",
      generation: 0,
      issuedGeneration: 2,
      fence: { generation: 2, required: false },
    });
    expect(writes(aborted.effects)).toEqual([
      expect.objectContaining({ generation: 2, timeline: RAILS_FROM_START, notAfter: DEADLINE }),
    ]);
    expect(step(aborted.record, failure(1, "timeout", NOW + 70, factsWith(ABSENT)))).toEqual({
      outcome: "unchanged",
      record: aborted.record,
      effects: [],
    });
  });

  it("a late cb write after abort is a conflict, not a silent adopt", () => {
    const late = step(aborted.record, observe(pendingMarker(pending), NOW + 90));
    expect(late.record).toMatchObject({
      state: "conflict",
      conflict: { reason: "fenced_write_landed", observed: { generation: 1 } },
    });
    expect(alertCodes(late.effects)).toEqual(["fenced_write_landed"]);
    expect(step(late.record, request(railsRecord()))).toMatchObject({
      outcome: "rejected",
      reasons: ["conflict_unresolved"],
    });
    expect(step(late.record, observe(pendingMarker(pending), NOW + 99)).effects).toEqual([]);
  });

  it("an operator resolves by adopting the live marker or restoring the confirmed one", () => {
    const conflict = step(aborted.record, observe(pendingMarker(pending), NOW + 90)).record;
    const adopted = step(conflict, {
      type: "CONFLICT_RESOLVED",
      at: NOW + 120,
      decision: "adopt_live",
      liveMarker: pendingMarker(pending),
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
    expect(
      step(conflict, {
        type: "CONFLICT_RESOLVED",
        at: NOW + 120,
        decision: "adopt_live",
        liveMarker: readOwnerMarker({ egghead_owner: "x" }),
        operator: "desk",
      }),
    ).toMatchObject({
      reasons: ["marker_unrecognized"],
    });
    const restored = step(conflict, {
      type: "CONFLICT_RESOLVED",
      at: NOW + 120,
      decision: "restore_confirmed",
      liveMarker: liveMarker(pendingOf(pending).timeline, 9),
      operator: "desk",
    });
    expect(restored.record).toMatchObject({ issuedGeneration: 10, fence: { generation: 10 } });
    expect(
      step(railsRecord(), {
        type: "CONFLICT_RESOLVED",
        at: NOW,
        decision: "adopt_live",
        liveMarker: ABSENT,
        operator: "desk",
      }),
    ).toMatchObject({ reasons: ["no_conflict"] });
  });

  it("clears the fence when it lands, and blocks new flips until then", () => {
    expect(
      step(aborted.record, request(aborted.record, "HANDOVER_REQUESTED", NOW + 100)),
    ).toMatchObject({ reasons: ["fence_outstanding"] });
    const landed = step(aborted.record, observe(liveMarker(RAILS_FROM_START, 2), NOW + 100));
    expect(landed.record).toMatchObject({ state: "rails_owned", generation: 2, fence: null });
    const next = step(
      landed.record,
      request(landed.record, "HANDOVER_REQUESTED", NOW + 200, "batch-2"),
    );
    expect(pendingOf(next.record).generation).toBe(3);
  });

  it("an optional fence that keeps failing is dropped; a required one becomes a conflict", () => {
    let record = aborted.record;
    for (let attempt = 1; attempt < policy.maxMarkerWriteAttempts; attempt++) {
      const result = step(record, failure(2, "server_error", NOW + 100 + attempt, null));
      expect(writes(result.effects)).toEqual([
        expect.objectContaining({
          idempotencyKey: `egghead-owner:${CUS}:2:${attempt}`,
          notAfter: DEADLINE,
        }),
      ]);
      record = result.record;
    }
    const dropped = step(record, failure(2, "server_error", NOW + 200, null));
    expect(dropped.record).toMatchObject({ state: "rails_owned", fence: null });
    expect(alertCodes(dropped.effects)).toEqual(["fence_write_failed"]);

    const required = step(pending, abort(NOW + 60, pendingMarker(pending))).record;
    const expired = step(required, failure(2, "timeout", DEADLINE, null));
    expect(expired.record).toMatchObject({
      state: "conflict",
      conflict: { reason: "fence_write_failed" },
      fence: null,
    });
  });

  it("a write dropped at its deadline asks for a live read, which commits or settles (7)", () => {
    const dropped = step(pending, { type: "WRITE_DROPPED", generation: 1, at: DEADLINE });
    expect(dropped.record).toBe(pending);
    expect(dropped.effects).toEqual([expect.objectContaining({ type: "read_live_marker" })]);
    expect(step(pending, observe(pendingMarker(pending), DEADLINE + 2)).record.state).toBe(
      "cb_owned",
    );
    expect(step(pending, observe(ABSENT, DEADLINE + 2)).record.state).toBe("rails_owned");
  });

  it("a dropped fence clears and triggers a live read, so it can never stick (7)", () => {
    const optional = step(aborted.record, { type: "WRITE_DROPPED", generation: 2, at: DEADLINE });
    expect(optional.record).toMatchObject({ state: "rails_owned", fence: null });
    expect(optional.effects).toEqual([expect.objectContaining({ type: "read_live_marker" })]);
    expect(
      step(optional.record, request(optional.record, "HANDOVER_REQUESTED", DEADLINE + 1, "b2"))
        .outcome,
    ).toBe("transitioned");

    const required = step(pending, abort(NOW + 60, pendingMarker(pending))).record;
    const cleared = step(required, { type: "WRITE_DROPPED", generation: 2, at: DEADLINE });
    expect(cleared.record.fence).toBeNull();
    expect(alertCodes(cleared.effects)).toEqual(["fence_write_failed"]);
    // The cancelled entry is still live: the live read turns it into a conflict.
    const read = step(cleared.record, observe(pendingMarker(pending), DEADLINE + 2));
    expect(read.record).toMatchObject({
      state: "conflict",
      conflict: { reason: "fenced_write_landed" },
    });
    // A drop for a generation nobody is writing changes nothing.
    expect(step(cbRecord(), { type: "WRITE_DROPPED", generation: 9, at: NOW }).effects).toEqual([]);
  });

  it("an unknown newer generation is an external write and freezes automation", () => {
    const external = step(cbRecord(), observe(liveMarker(RAILS_FROM_START, 9), FLIP + 5));
    expect(external.record).toMatchObject({
      state: "conflict",
      conflict: { reason: "external_write" },
    });
  });
});

describe("unrecognized marker alerts are deduplicated (2.10)", () => {
  const garbled = readOwnerMarker({ egghead_owner: "cb" });

  it("alerts once per cooldown", () => {
    const first = step(railsRecord(), observe(garbled, NOW));
    expect(first.record).toMatchObject({
      state: "conflict",
      conflict: { reason: "marker_unrecognized" },
    });
    expect(alertCodes(first.effects)).toEqual(["marker_unrecognized"]);
    const soon = step(first.record, observe(garbled, NOW + 3600));
    expect(soon.effects).toEqual([]);
    const later = step(soon.record, observe(garbled, NOW + policy.alertCooldownSeconds));
    expect(alertCodes(later.effects)).toEqual(["marker_unrecognized"]);
  });

  it("first sighting of a garbled marker starts in conflict with one alert", () => {
    const created = createOwnershipRecord({ customerId: CUS, marker: garbled, at: NOW });
    expect(created.record.state).toBe("conflict");
    expect(alertCodes(created.effects)).toEqual(["marker_unrecognized"]);
    expect(step(created.record, observe(garbled, NOW + 10)).effects).toEqual([]);
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
      step(railsRecord(), observe(readOwnerMarker({ egghead_owner: "x" }), NOW)).record,
  };

  const events: Record<string, (record: OwnershipRecord) => OwnershipEvent> = {
    handover: (record) => request(record, "HANDOVER_REQUESTED", FLIP + 200, "matrix"),
    handback: (record) => request(record, "HANDBACK_REQUESTED", FLIP + 200, "matrix"),
    observe_same: (record) => observe(confirmedMarker(record), FLIP + 200),
    write_failed_stale: () => failure(99, "timeout", FLIP + 200, null),
    write_dropped_stale: () => ({ type: "WRITE_DROPPED", generation: 99, at: FLIP + 200 }),
    deadline: (record) => deadline(FLIP + 200, confirmedMarker(record)),
    abort: (record) => abort(FLIP + 200, confirmedMarker(record)),
    resolve: () => ({
      type: "CONFLICT_RESOLVED",
      at: FLIP + 200,
      decision: "adopt_live",
      liveMarker: ABSENT,
      operator: "desk",
    }),
  };

  const expected: Record<OwnershipState, Record<string, [string, OwnershipState]>> = {
    rails_owned: {
      handover: ["transitioned", "handover_pending"],
      handback: ["unchanged", "rails_owned"],
      observe_same: ["unchanged", "rails_owned"],
      write_failed_stale: ["unchanged", "rails_owned"],
      write_dropped_stale: ["unchanged", "rails_owned"],
      deadline: ["unchanged", "rails_owned"],
      abort: ["rejected", "rails_owned"],
      resolve: ["rejected", "rails_owned"],
    },
    handover_pending: {
      handover: ["rejected", "handover_pending"],
      handback: ["rejected", "handover_pending"],
      // A live read past the deadline showing nothing landed settles the flip.
      observe_same: ["transitioned", "rails_owned"],
      write_failed_stale: ["unchanged", "handover_pending"],
      write_dropped_stale: ["unchanged", "handover_pending"],
      deadline: ["transitioned", "rails_owned"],
      abort: ["rejected", "handover_pending"],
      resolve: ["rejected", "handover_pending"],
    },
    cb_owned: {
      handover: ["unchanged", "cb_owned"],
      handback: ["transitioned", "handback_pending"],
      observe_same: ["unchanged", "cb_owned"],
      write_failed_stale: ["unchanged", "cb_owned"],
      write_dropped_stale: ["unchanged", "cb_owned"],
      deadline: ["unchanged", "cb_owned"],
      abort: ["rejected", "cb_owned"],
      resolve: ["rejected", "cb_owned"],
    },
    handback_pending: {
      handover: ["rejected", "handback_pending"],
      handback: ["rejected", "handback_pending"],
      observe_same: ["unchanged", "handback_pending"],
      write_failed_stale: ["unchanged", "handback_pending"],
      write_dropped_stale: ["unchanged", "handback_pending"],
      deadline: ["unchanged", "handback_pending"],
      abort: ["transitioned", "cb_owned"],
      resolve: ["rejected", "handback_pending"],
    },
    conflict: {
      handover: ["rejected", "conflict"],
      handback: ["rejected", "conflict"],
      observe_same: ["unchanged", "conflict"],
      write_failed_stale: ["unchanged", "conflict"],
      write_dropped_stale: ["unchanged", "conflict"],
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

/** Deterministic PRNG (mulberry32) so a failing seed can be replayed. */
function prng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    int: (max: number) => Math.floor(next() * max),
    chance: (p: number) => next() < p,
  };
}

/** Owner breakpoints a timeline change could affect, up to `limit`. */
function checkpoints(a: OwnerTimeline, b: OwnerTimeline, limit: number): number[] {
  const points = new Set<number>([0, limit]);
  for (const entry of [...a, ...b]) {
    if (entry.since <= limit) {
      points.add(entry.since);
      if (entry.since > 0) points.add(entry.since - 1);
    }
  }
  return [...points];
}

describe("randomized sequences through transition", () => {
  type Write = Extract<OwnershipEffect, { type: "write_marker" }>;
  const FAILURES: readonly MarkerWriteFailure[] = [
    "server_error",
    "timeout",
    "rate_limited",
    "key_in_use",
    "client_error",
  ];
  /** The drain must settle every flip and clear every fence within this many steps. */
  const DRAIN_LIMIT = 60;

  /**
   * One customer, one Stripe account, one CB runner. `t` is Stripe's clock; CB's clock
   * is `t + skew`, with the skew fixed per seed in [-60, 60] seconds. Every `at` the
   * machine sees is CB time; every `landedAt` is Stripe time.
   */
  function run(
    seed: number,
    steps: number,
    runner: { readonly honourNotAfter: boolean } = { honourNotAfter: true },
  ) {
    const random = prng(seed);
    const skew = random.int(121) - 60;
    let t = NOW;
    const cb = () => t + skew;
    let liveMetadata: Record<string, string> = {};
    const liveHistory: { at: number; marker: OwnerMarker }[] = [{ at: NOW - DAY, marker: ABSENT }];
    let record = createOwnershipRecord({ customerId: CUS, marker: ABSENT, at: NOW - DAY }).record;
    let queue: Write[] = [];
    let reads = 0;
    const deliveries: { at: number; marker: OwnerMarker }[] = [];
    const cancelled = new Set<number>();
    const routeChanges: string[] = [];
    const coverage = new Set<string>();
    let lastEventAt = NOW - DAY;

    const live = () => readOwnerMarker(liveMetadata);
    const liveRead = (): OwnershipEvent => observe(live(), cb(), "live_read", t);
    const facts = (): TransitionFacts =>
      factsWith(live(), {
        subscriptions: [{ ...subscription, paidThroughAt: t + 40 * DAY }],
        lastStripeEventAt: random.chance(0.1) ? t - 10 : lastEventAt,
      });

    const land = (write: Write) => {
      const before = live();
      liveMetadata = write.metadata;
      const after = live();
      // Invariant 1: a landed write never changes the owner of an event that either app
      // could already have routed (created up to now plus the cache TTL).
      for (const created of checkpoints(before.timeline, after.timeline, t + TTL)) {
        if (ownerAt(before.timeline, created) !== ownerAt(after.timeline, created)) {
          routeChanges.push(
            `seed ${seed} t ${t}: gen ${write.generation} changed owner at ${created}`,
          );
        }
      }
      liveHistory.push({ at: t, marker: after });
      // Stripe usually delivers customer.updated, late and out of order.
      if (random.chance(0.7)) deliveries.push({ at: t, marker: after });
      coverage.add("landed");
      lastEventAt = t;
    };

    /** The runner sends one queued write: dropped at notAfter, failed, or landed. */
    const send = (allowFailure: boolean): OwnershipEvent | null => {
      const write = queue.shift();
      if (write === undefined) return null;
      if (runner.honourNotAfter && write.notAfter !== null && cb() >= write.notAfter) {
        coverage.add("dropped");
        return { type: "WRITE_DROPPED", generation: write.generation, at: cb() };
      }
      if (allowFailure && random.chance(0.3)) {
        const kind = FAILURES[random.int(FAILURES.length)] ?? "timeout";
        return failure(write.generation, kind, cb(), facts());
      }
      land(write);
      // Stripe's response holds the updated customer: the runner feeds it back as a
      // live read. A lost response is a timeout, retried under the same key.
      if (allowFailure && random.chance(0.2)) {
        return failure(write.generation, "timeout", cb(), facts());
      }
      return liveRead();
    };

    const apply = (event: OwnershipEvent, label: string) => {
      const previous = record;
      const result = transition(record, event, policy);
      record = result.record;
      if (record.state !== previous.state) {
        coverage.add(`${previous.state}->${record.state}`);
      }

      // Invariant 2: generations never decrease.
      expect(record.generation, label).toBeGreaterThanOrEqual(previous.generation);
      expect(record.issuedGeneration, label).toBeGreaterThanOrEqual(previous.issuedGeneration);

      // A flip that left pending without committing is cancelled for good.
      if (
        (previous.state === "handover_pending" || previous.state === "handback_pending") &&
        record.state !== previous.state &&
        record.generation !== previous.pending.generation
      ) {
        const gone = previous.pending.generation;
        cancelled.add(gone);
        coverage.add("cancelled");
        // Runner contract: a cancel or conflict purges queued writes for the
        // generation. Half the time the request is already in flight and can't be.
        if (random.chance(0.5)) queue = queue.filter((write) => write.generation !== gone);
      }

      for (const effect of result.effects) {
        if (effect.type === "read_live_marker") reads += 1;
        if (effect.type !== "write_marker") continue;
        // Invariant 3: a fenced (cancelled) generation is never written again.
        expect(
          cancelled.has(effect.generation),
          `${label} wrote cancelled ${effect.generation}`,
        ).toBe(false);
        // Every automated write is bounded by its flip's deadline.
        expect(effect.notAfter, label).not.toBeNull();
        queue.push(effect);
      }
    };

    for (let i = 0; i < steps; i++) {
      t += random.int(400);
      let event: OwnershipEvent | null = null;

      switch (random.int(10)) {
        case 0:
          event = request(
            record,
            "HANDOVER_REQUESTED",
            cb(),
            random.chance(0.5) ? "b1" : "b2",
            facts(),
          );
          break;
        case 1:
          event = request(
            record,
            "HANDBACK_REQUESTED",
            cb(),
            random.chance(0.5) ? "b1" : "b2",
            facts(),
          );
          break;
        case 2:
        case 3:
          event = send(true);
          break;
        case 4: {
          // Deliver a pending customer.updated, in any order.
          const index = random.int(deliveries.length);
          const [delivery] = deliveries.splice(index, 1);
          if (delivery !== undefined) event = observe(delivery.marker, cb(), "event", delivery.at);
          break;
        }
        case 5: {
          // Replay an old snapshot, as a dashboard resend would.
          const old = liveHistory[random.int(liveHistory.length)];
          if (old !== undefined) event = observe(old.marker, cb(), "event", old.at);
          break;
        }
        case 6:
          if (reads > 0) {
            reads -= 1;
            event = liveRead();
          }
          break;
        case 7:
          if (record.state === "handover_pending" || record.state === "handback_pending") {
            t = Math.max(t, record.pending.deadline - skew);
            event = deadline(cb(), live());
          }
          break;
        case 8:
          event = abort(cb(), live());
          break;
        default:
          if (record.state === "conflict") {
            event = {
              type: "CONFLICT_RESOLVED",
              at: cb(),
              decision: "adopt_live",
              liveMarker: live(),
              operator: "sim",
            };
          }
      }
      if (event !== null) apply(event, `seed ${seed} step ${i}`);
    }

    // Liveness: with no new requests, a runner that keeps its contract (answer reads,
    // send or drop queued writes, fire deadline timers) settles every flip and clears
    // every fence within DRAIN_LIMIT steps.
    let drained = false;
    for (let i = 0; i < DRAIN_LIMIT; i++) {
      t += 5;
      let event: OwnershipEvent | null = null;
      if (reads > 0) {
        reads -= 1;
        event = liveRead();
      } else if (queue.length > 0) {
        event = send(false);
      } else if (record.state === "handover_pending" || record.state === "handback_pending") {
        t = Math.max(t, record.pending.deadline - skew);
        event = deadline(cb(), live());
      } else {
        drained = true;
        break;
      }
      if (event !== null) apply(event, `seed ${seed} drain ${i}`);
    }
    if (runner.honourNotAfter) {
      expect(drained, `seed ${seed}: drain did not finish`).toBe(true);
      expect(record.fence, `seed ${seed}: fence stuck`).toBeNull();
      expect(record.state, `seed ${seed}: flip stuck`).not.toMatch(/_pending$/);
    }
    return { routeChanges, coverage };
  }

  it("catches history rewrites when the runner ignores notAfter (the check is not vacuous)", () => {
    let violations = 0;
    for (let seed = 1; seed <= 200; seed++) {
      violations += run(seed, 150, { honourNotAfter: false }).routeChanges.length;
    }
    expect(violations).toBeGreaterThan(0);
  });

  it("holds the invariants after every step, and settles, across 200 seeded runs", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      const { routeChanges, coverage } = run(seed, 150);
      expect(routeChanges).toEqual([]);
      for (const item of coverage) seen.add(item);
    }
    // The runs must reach the paths the invariants are about.
    for (const required of [
      "landed",
      "dropped",
      "cancelled",
      "rails_owned->handover_pending",
      "handover_pending->cb_owned",
      "cb_owned->handback_pending",
      "handback_pending->rails_owned",
      "handover_pending->rails_owned",
      "rails_owned->conflict",
      "conflict->rails_owned",
    ]) {
      expect([...seen], required).toContain(required);
    }
  });
});
