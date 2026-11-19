import { describe, expect, it } from "vitest";

import {
  accessGranted,
  lenientStatusRule,
  strictPaidThroughRule,
  type StripeSubscriptionStatus,
} from "./access-rule";
import {
  createOwnershipRecord,
  decideStripeEvent,
  handoverRejections,
  settledOwner,
  suggestedOwnershipPolicy,
  transition,
  type HandoverFacts,
  type OwnershipEvent,
  type OwnershipPolicy,
  type OwnershipRecord,
  type OwnershipState,
  type TransitionResult,
} from "./machine";
import {
  oneTimePaymentOwner,
  ownerMarkerIdempotencyKey,
  ownerMarkerMetadata,
  readOwnerMarker,
  type OwnerMarker,
} from "./marker";

const SUB = "sub_synthetic_1";
const NOW = 1_800_000_000;
const DAY = 86_400;

const policy: OwnershipPolicy = {
  cbAccessRule: lenientStatusRule,
  railsAccessRule: lenientStatusRule,
  accessReadSide: "cb",
  handoverStatuses: new Set<StripeSubscriptionStatus>(["active", "trialing", "canceled"]),
  renewalQuietWindowSeconds: DAY,
  eventSettleSeconds: 600,
  maxMarkerWriteAttempts: 3,
  railsAcceptsHandback: true,
};

function marker(owner: "rails" | "cb", generation: number): OwnerMarker {
  return { owner, generation, source: "explicit" };
}

const eligibleFacts: HandoverFacts = {
  liveMarker: { owner: "rails", generation: 0, source: "absent" },
  status: "active",
  paidThroughAt: NOW + 10 * DAY,
  lastStripeEventAt: NOW - 3600,
  otherRailsOwnedSubscriptionsOnCustomer: 0,
  team: null,
  acceptAccessChange: false,
};

function record(state: OwnershipState, generation = 2): OwnershipRecord {
  switch (state) {
    case "rails_owned":
    case "cb_owned":
      return { subscriptionId: SUB, state, generation, updatedAt: NOW - DAY };
    case "handover_pending":
    case "handback_pending":
      return {
        subscriptionId: SUB,
        state,
        generation,
        updatedAt: NOW - DAY,
        pending: {
          generation: generation + 1,
          batchId: "batch-1",
          attempts: 1,
          requestedAt: NOW - DAY,
        },
      };
    default:
      throw new Error(`unknown state ${String(state)}`);
  }
}

function expectTransitioned(result: TransitionResult): OwnershipRecord {
  expect(result.outcome).toBe("transitioned");
  return result.record;
}

function pendingOf(r: OwnershipRecord) {
  if (r.state !== "handover_pending" && r.state !== "handback_pending") {
    throw new Error(`expected a pending record, got ${r.state}`);
  }
  return r.pending;
}

const allStates: readonly OwnershipState[] = [
  "rails_owned",
  "handover_pending",
  "cb_owned",
  "handback_pending",
];

describe("marker", () => {
  it("reads only the exact string cb as CourseBuilder, like the Rails guard", () => {
    expect(readOwnerMarker({ egghead_owner: "cb", egghead_owner_generation: "4" })).toEqual({
      owner: "cb",
      generation: 4,
      source: "explicit",
    });
    expect(readOwnerMarker({ egghead_owner: "rails" })).toEqual({
      owner: "rails",
      generation: 0,
      source: "explicit",
    });
    expect(readOwnerMarker({ egghead_owner: "CB" })).toEqual({
      owner: "rails",
      generation: 0,
      source: "unrecognized",
    });
    expect(readOwnerMarker({})).toEqual({ owner: "rails", generation: 0, source: "absent" });
    expect(readOwnerMarker({ egghead_owner: "" }).source).toBe("absent");
    expect(readOwnerMarker(null)).toEqual({ owner: "rails", generation: 0, source: "absent" });
    expect(readOwnerMarker("cb").owner).toBe("rails");
  });

  it("ignores generations that are not non-negative integers", () => {
    for (const raw of ["-1", "1.5", "abc", "", "1e3"]) {
      expect(
        readOwnerMarker({ egghead_owner: "cb", egghead_owner_generation: raw }).generation,
      ).toBe(0);
    }
    expect(readOwnerMarker({ egghead_owner: "cb", egghead_owner_generation: 7 }).generation).toBe(
      0,
    );
  });

  it("writes string metadata and a stable idempotency key", () => {
    expect(ownerMarkerMetadata("cb", 3)).toEqual({
      egghead_owner: "cb",
      egghead_owner_generation: "3",
    });
    expect(ownerMarkerIdempotencyKey(SUB, "cb", 3)).toBe(`egghead-owner:${SUB}:cb:3`);
    expect(readOwnerMarker(ownerMarkerMetadata("cb", 3))).toEqual(marker("cb", 3));
  });

  it("gives one-time payments to whoever created the checkout session", () => {
    expect(oneTimePaymentOwner({ egghead_owner: "cb" })).toBe("cb");
    expect(oneTimePaymentOwner({ site: "egghead" })).toBe("rails");
    expect(oneTimePaymentOwner(undefined)).toBe("rails");
  });
});

describe("access rules", () => {
  it("lenient grants by status alone (ADR-0006)", () => {
    for (const status of ["active", "trialing", "past_due"] as const) {
      expect(
        accessGranted(lenientStatusRule.evaluate({ status, paidThroughAt: NOW - DAY, now: NOW })),
      ).toBe(true);
    }
    expect(
      lenientStatusRule.evaluate({ status: "canceled", paidThroughAt: NOW + DAY, now: NOW }),
    ).toBe("status_no_grant");
  });

  it("strict grants only an active subscription inside its paid period (ADR-0008)", () => {
    expect(
      strictPaidThroughRule.evaluate({ status: "active", paidThroughAt: NOW + 1, now: NOW }),
    ).toBe("paid_through");
    expect(strictPaidThroughRule.evaluate({ status: "active", paidThroughAt: NOW, now: NOW })).toBe(
      "not_paid_through",
    );
    expect(
      strictPaidThroughRule.evaluate({ status: "active", paidThroughAt: null, now: NOW }),
    ).toBe("not_paid_through");
    expect(
      strictPaidThroughRule.evaluate({ status: "trialing", paidThroughAt: NOW + DAY, now: NOW }),
    ).toBe("not_paid_through");
  });
});

describe("single owner invariant", () => {
  const markers: OwnerMarker[] = [
    marker("rails", 0),
    marker("rails", 1),
    marker("rails", 3),
    marker("rails", 9),
    marker("cb", 0),
    marker("cb", 1),
    marker("cb", 3),
    marker("cb", 9),
    { owner: "rails", generation: 0, source: "absent" },
    { owner: "rails", generation: 5, source: "unrecognized" },
  ];

  it("CB processes an event exactly when the live marker says cb, in every state", () => {
    for (const state of allStates) {
      for (const liveMarker of markers) {
        const decision = decideStripeEvent(record(state), {
          subscriptionId: SUB,
          liveMarker,
          at: NOW,
        });
        // Rails' guard skips exactly when marker == cb, so this makes one side act.
        expect(decision.action, `${state} with ${JSON.stringify(liveMarker)}`).toBe(
          liveMarker.owner === "cb" ? "process" : "ignore",
        );
        expect(decision.owner).toBe(liveMarker.owner);
        expect(settledOwner(decision.record.state)).toBe(liveMarker.owner);
        expect(decision.record.generation).toBeGreaterThanOrEqual(record(state).generation);
      }
    }
  });

  it("holds for a subscription CB has never seen", () => {
    for (const liveMarker of markers) {
      const decision = decideStripeEvent(null, { subscriptionId: SUB, liveMarker, at: NOW });
      expect(decision.action).toBe(liveMarker.owner === "cb" ? "process" : "ignore");
      expect(decision.recordChanged).toBe(true);
      expect(decision.record.state).toBe(liveMarker.owner === "cb" ? "cb_owned" : "rails_owned");
    }
  });
});

describe("state x event matrix", () => {
  const events: Record<OwnershipEvent["type"], OwnershipEvent> = {
    HANDOVER_REQUESTED: {
      type: "HANDOVER_REQUESTED",
      batchId: "batch-2",
      at: NOW,
      facts: eligibleFacts,
    },
    HANDBACK_REQUESTED: {
      type: "HANDBACK_REQUESTED",
      batchId: "batch-2",
      at: NOW,
      reason: "rollback",
    },
    MARKER_OBSERVED: { type: "MARKER_OBSERVED", marker: marker("cb", 3), at: NOW },
    MARKER_WRITE_FAILED: { type: "MARKER_WRITE_FAILED", generation: 3, at: NOW, error: "timeout" },
    ABORT_REQUESTED: { type: "ABORT_REQUESTED", at: NOW, reason: "operator" },
  };

  const expected: Record<
    OwnershipState,
    Record<OwnershipEvent["type"], [string, OwnershipState]>
  > = {
    rails_owned: {
      HANDOVER_REQUESTED: ["transitioned", "handover_pending"],
      HANDBACK_REQUESTED: ["unchanged", "rails_owned"],
      MARKER_OBSERVED: ["transitioned", "cb_owned"],
      MARKER_WRITE_FAILED: ["unchanged", "rails_owned"],
      ABORT_REQUESTED: ["rejected", "rails_owned"],
    },
    handover_pending: {
      HANDOVER_REQUESTED: ["rejected", "handover_pending"],
      HANDBACK_REQUESTED: ["rejected", "handover_pending"],
      MARKER_OBSERVED: ["transitioned", "cb_owned"],
      MARKER_WRITE_FAILED: ["unchanged", "handover_pending"],
      ABORT_REQUESTED: ["transitioned", "rails_owned"],
    },
    cb_owned: {
      HANDOVER_REQUESTED: ["unchanged", "cb_owned"],
      HANDBACK_REQUESTED: ["transitioned", "handback_pending"],
      MARKER_OBSERVED: ["unchanged", "cb_owned"],
      MARKER_WRITE_FAILED: ["unchanged", "cb_owned"],
      ABORT_REQUESTED: ["rejected", "cb_owned"],
    },
    handback_pending: {
      HANDOVER_REQUESTED: ["rejected", "handback_pending"],
      HANDBACK_REQUESTED: ["rejected", "handback_pending"],
      MARKER_OBSERVED: ["unchanged", "handback_pending"],
      MARKER_WRITE_FAILED: ["unchanged", "handback_pending"],
      ABORT_REQUESTED: ["transitioned", "cb_owned"],
    },
  };

  for (const state of allStates) {
    for (const [type, event] of Object.entries(events)) {
      const want = expected[state][event.type];
      it(`${state} + ${type} -> ${want[0]} ${want[1]}`, () => {
        const result = transition(record(state), event, policy);
        expect(result.outcome).toBe(want[0]);
        expect(result.record.state).toBe(want[1]);
        expect(result.record.subscriptionId).toBe(SUB);
        if (result.outcome === "rejected") expect(result.effects).toEqual([]);
      });
    }
  }
});

describe("handover", () => {
  const request = (facts: HandoverFacts = eligibleFacts, batchId = "batch-1"): OwnershipEvent => ({
    type: "HANDOVER_REQUESTED",
    batchId,
    at: NOW,
    facts,
  });

  it("writes cb at the next generation, then commits when the marker is observed", () => {
    const start = record("rails_owned", 0);
    const pending = expectTransitioned(transition(start, request(), policy));
    expect(pending.state).toBe("handover_pending");
    expect(pendingOf(pending)).toMatchObject({ generation: 1, batchId: "batch-1", attempts: 1 });

    const write = transition(start, request(), policy).effects;
    expect(write).toEqual([
      {
        type: "write_marker",
        subscriptionId: SUB,
        owner: "cb",
        generation: 1,
        idempotencyKey: `egghead-owner:${SUB}:cb:1`,
        metadata: { egghead_owner: "cb", egghead_owner_generation: "1" },
      },
    ]);

    // Write not landed yet: Rails still owns, nothing changes.
    const early = transition(
      pending,
      { type: "MARKER_OBSERVED", marker: marker("rails", 0), at: NOW },
      policy,
    );
    expect(early).toEqual({ outcome: "unchanged", record: pending, effects: [] });

    const committed = transition(
      pending,
      { type: "MARKER_OBSERVED", marker: marker("cb", 1), at: NOW + 5 },
      policy,
    );
    expect(committed.record).toEqual({
      subscriptionId: SUB,
      state: "cb_owned",
      generation: 1,
      updatedAt: NOW + 5,
    });
    expect(committed.effects).toEqual([{ type: "sync_cb_from_stripe", subscriptionId: SUB }]);
  });

  it("picks a generation above anything seen on the live marker", () => {
    const facts = { ...eligibleFacts, liveMarker: marker("rails", 7) };
    const pending = expectTransitioned(
      transition(record("rails_owned", 2), request(facts), policy),
    );
    expect(pendingOf(pending).generation).toBe(8);
  });

  it("is idempotent for an already moved subscription", () => {
    const owned = record("cb_owned");
    expect(transition(owned, request(), policy)).toEqual({
      outcome: "unchanged",
      record: owned,
      effects: [],
    });
  });

  it("re-drives the same write when the same batch asks again, and refuses another batch", () => {
    const pending = record("handover_pending");
    const again = transition(pending, request(eligibleFacts, "batch-1"), policy);
    expect(again.outcome).toBe("unchanged");
    expect(again.effects).toEqual([
      expect.objectContaining({ type: "write_marker", owner: "cb", generation: 3 }),
    ]);
    expect(pendingOf(again.record).attempts).toBe(1);

    const other = transition(pending, request(eligibleFacts, "batch-9"), policy);
    expect(other).toMatchObject({ outcome: "rejected", reasons: ["transition_in_flight"] });
  });
});

describe("handover guards", () => {
  const reasonsFor = (facts: Partial<HandoverFacts>, overrides: Partial<OwnershipPolicy> = {}) =>
    handoverRejections({ ...eligibleFacts, ...facts }, { ...policy, ...overrides }, NOW);

  it("passes an eligible subscription", () => {
    expect(reasonsFor({})).toEqual([]);
  });

  it("refuses when the live marker already says cb", () => {
    expect(reasonsFor({ liveMarker: marker("cb", 1) })).toEqual(["marker_already_cb"]);
  });

  it("refuses while access is still read from Rails", () => {
    expect(reasonsFor({}, { accessReadSide: "rails" })).toEqual(["access_read_side_is_rails"]);
  });

  it("refuses statuses with dunning or incomplete payment in flight", () => {
    for (const status of [
      "past_due",
      "unpaid",
      "incomplete",
      "incomplete_expired",
      "paused",
    ] as const) {
      expect(reasonsFor({ status })).toContain("status_not_eligible");
    }
    expect(reasonsFor({ status: "canceled", paidThroughAt: NOW - DAY })).toEqual([]);
  });

  it("refuses inside the renewal quiet window or without a known period end", () => {
    expect(reasonsFor({ paidThroughAt: NOW + DAY - 1 })).toEqual(["renewal_window"]);
    expect(reasonsFor({ paidThroughAt: NOW + DAY })).toEqual([]);
    expect(reasonsFor({ paidThroughAt: null })).toContain("renewal_window");
  });

  it("waits for Rails jobs from a recent event to drain", () => {
    expect(reasonsFor({ lastStripeEventAt: NOW - 599 })).toEqual(["recent_stripe_activity"]);
    expect(reasonsFor({ lastStripeEventAt: NOW - 600 })).toEqual([]);
    expect(reasonsFor({ lastStripeEventAt: null })).toEqual([]);
  });

  it("refuses to split a Stripe customer across owners", () => {
    expect(reasonsFor({ otherRailsOwnedSubscriptionsOnCustomer: 1 })).toEqual(["customer_split"]);
  });

  it("refuses team subscriptions until CB holds the seats and no seat change is in flight", () => {
    const team = { quantity: 5, seatsProjectedToCb: true, pendingSeatChange: false };
    expect(reasonsFor({ team })).toEqual([]);
    expect(reasonsFor({ team: { ...team, seatsProjectedToCb: false } })).toEqual([
      "team_seats_not_projected",
    ]);
    expect(reasonsFor({ team: { ...team, pendingSeatChange: true } })).toEqual([
      "team_seat_change_pending",
    ]);
  });

  it("refuses a move that would change access under the chosen CB law unless acknowledged", () => {
    const strict = { cbAccessRule: strictPaidThroughRule };
    // Trialing: Rails grants by status, strict CB does not.
    expect(reasonsFor({ status: "trialing" }, strict)).toEqual(["access_would_change"]);
    expect(reasonsFor({ status: "trialing", acceptAccessChange: true }, strict)).toEqual([]);
    // Under the lenient law the same subscription moves cleanly.
    expect(reasonsFor({ status: "trialing" })).toEqual([]);
    // Active and paid through: both laws grant.
    expect(reasonsFor({}, strict)).toEqual([]);
  });

  it("reports every failing guard at once for batch reports", () => {
    const result = transition(
      record("rails_owned"),
      {
        type: "HANDOVER_REQUESTED",
        batchId: "b",
        at: NOW,
        facts: {
          ...eligibleFacts,
          status: "past_due",
          otherRailsOwnedSubscriptionsOnCustomer: 2,
          lastStripeEventAt: NOW,
        },
      },
      policy,
    );
    expect(result).toMatchObject({
      outcome: "rejected",
      reasons: ["status_not_eligible", "recent_stripe_activity", "customer_split"],
      effects: [],
    });
  });
});

describe("events during handover", () => {
  it("leaves the event to Rails until the marker flips, then commits and processes", () => {
    const pending = record("handover_pending");

    const before = decideStripeEvent(pending, {
      subscriptionId: SUB,
      liveMarker: marker("rails", 2),
      at: NOW,
    });
    expect(before).toMatchObject({
      action: "ignore",
      owner: "rails",
      recordChanged: false,
      effects: [],
    });
    expect(before.record).toBe(pending);

    // The marker write itself emits customer.subscription.updated, which confirms the move.
    const after = decideStripeEvent(pending, {
      subscriptionId: SUB,
      liveMarker: marker("cb", 3),
      at: NOW,
    });
    expect(after.action).toBe("process");
    expect(after.recordChanged).toBe(true);
    expect(after.record).toMatchObject({ state: "cb_owned", generation: 3 });
    expect(after.effects).toEqual([{ type: "sync_cb_from_stripe", subscriptionId: SUB }]);
  });

  it("keeps CB acting during a handback until the rails marker lands", () => {
    const pending = record("handback_pending");
    expect(
      decideStripeEvent(pending, { subscriptionId: SUB, liveMarker: marker("cb", 2), at: NOW })
        .action,
    ).toBe("process");
    const back = decideStripeEvent(pending, {
      subscriptionId: SUB,
      liveMarker: marker("rails", 3),
      at: NOW,
    });
    expect(back).toMatchObject({ action: "ignore", recordChanged: true, effects: [] });
    expect(back.record).toMatchObject({ state: "rails_owned", generation: 3 });
  });

  it("commits on the target owner even when someone else wrote another generation, and alerts", () => {
    const result = transition(
      record("handover_pending"),
      { type: "MARKER_OBSERVED", marker: marker("cb", 9), at: NOW },
      policy,
    );
    expect(result.record).toMatchObject({ state: "cb_owned", generation: 9 });
    expect(result.effects).toEqual([
      expect.objectContaining({ type: "alert", code: "marker_changed_externally" }),
      { type: "sync_cb_from_stripe", subscriptionId: SUB },
    ]);
  });
});

describe("marker write failures", () => {
  const fail = (generation: number): OwnershipEvent => ({
    type: "MARKER_WRITE_FAILED",
    generation,
    at: NOW,
    error: "stripe 500",
  });

  it("retries with the same idempotency key until the attempt limit, then alerts and stays pending", () => {
    let current = record("handover_pending");
    const keys: string[] = [];
    for (let attempt = 1; attempt < policy.maxMarkerWriteAttempts; attempt++) {
      const result = transition(current, fail(3), policy);
      expect(result.outcome).toBe("unchanged");
      const [effect] = result.effects;
      if (effect?.type !== "write_marker") throw new Error("expected a retry write");
      keys.push(effect.idempotencyKey);
      current = result.record;
      expect(pendingOf(current).attempts).toBe(attempt + 1);
    }
    expect(new Set(keys)).toEqual(new Set([`egghead-owner:${SUB}:cb:3`]));

    const exhausted = transition(current, fail(3), policy);
    expect(exhausted.record).toBe(current);
    expect(exhausted.record.state).toBe("handover_pending");
    expect(exhausted.effects).toEqual([
      expect.objectContaining({ type: "alert", code: "marker_write_retries_exhausted" }),
    ]);

    // An ambiguous timeout may have landed after all: observing it still commits.
    const landed = transition(
      current,
      { type: "MARKER_OBSERVED", marker: marker("cb", 3), at: NOW },
      policy,
    );
    expect(landed.record.state).toBe("cb_owned");
  });

  it("retries handback writes toward rails", () => {
    const result = transition(record("handback_pending"), fail(3), policy);
    expect(result.effects).toEqual([
      expect.objectContaining({ type: "write_marker", owner: "rails", generation: 3 }),
    ]);
  });

  it("ignores failure reports for an older generation", () => {
    const pending = record("handover_pending");
    expect(transition(pending, fail(2), policy)).toEqual({
      outcome: "unchanged",
      record: pending,
      effects: [],
    });
  });
});

describe("abort", () => {
  it("returns a handover to Rails with a newer rails marker that beats a late cb write", () => {
    const result = transition(
      record("handover_pending"),
      { type: "ABORT_REQUESTED", at: NOW, reason: "bad batch" },
      policy,
    );
    expect(result.record).toEqual({
      subscriptionId: SUB,
      state: "rails_owned",
      generation: 4,
      updatedAt: NOW,
    });
    expect(result.effects).toEqual([
      expect.objectContaining({ type: "write_marker", owner: "rails", generation: 4 }),
      expect.objectContaining({ type: "alert", code: "transition_aborted", detail: "bad batch" }),
    ]);

    // A stale observation of the aborted cb write (generation 3) cannot be newer than ours,
    // but the live marker still wins if it really says cb, and we alert.
    const late = transition(
      result.record,
      { type: "MARKER_OBSERVED", marker: marker("cb", 3), at: NOW },
      policy,
    );
    expect(late.record).toMatchObject({ state: "cb_owned", generation: 4 });
    expect(late.effects).toContainEqual(
      expect.objectContaining({ code: "marker_changed_externally" }),
    );
  });

  it("keeps a handback with CB when aborted", () => {
    const result = transition(
      record("handback_pending"),
      { type: "ABORT_REQUESTED", at: NOW, reason: "x" },
      policy,
    );
    expect(result.record).toMatchObject({ state: "cb_owned", generation: 4 });
    expect(result.effects[0]).toMatchObject({ type: "write_marker", owner: "cb", generation: 4 });
  });
});

describe("handback (rollback)", () => {
  const handback: OwnershipEvent = {
    type: "HANDBACK_REQUESTED",
    batchId: "rollback-1",
    at: NOW,
    reason: "rollback",
  };

  it("writes rails at the next generation and commits without a CB sync", () => {
    const pending = expectTransitioned(transition(record("cb_owned", 4), handback, policy));
    expect(pending.state).toBe("handback_pending");
    expect(pendingOf(pending).generation).toBe(5);
    const done = transition(
      pending,
      { type: "MARKER_OBSERVED", marker: marker("rails", 5), at: NOW },
      policy,
    );
    expect(done.record).toMatchObject({ state: "rails_owned", generation: 5 });
    expect(done.effects).toEqual([]);
  });

  it("refuses once Rails is retired", () => {
    expect(
      transition(record("cb_owned"), handback, { ...policy, railsAcceptsHandback: false }),
    ).toMatchObject({
      outcome: "rejected",
      reasons: ["rails_retired"],
    });
  });

  it("re-drives the same handback batch", () => {
    const pending = {
      ...record("handback_pending"),
      pending: { ...pendingOf(record("handback_pending")), batchId: "rollback-1" },
    };
    const result = transition(pending, handback, policy);
    expect(result.effects).toEqual([
      expect.objectContaining({ type: "write_marker", owner: "rails", generation: 3 }),
    ]);
  });

  it("adopts a marker flipped back by hand in the Stripe dashboard", () => {
    // Joel's rollback lever: set egghead_owner back to rails without touching CB.
    const decision = decideStripeEvent(record("cb_owned", 4), {
      subscriptionId: SUB,
      liveMarker: { owner: "rails", generation: 4, source: "explicit" },
      at: NOW,
    });
    expect(decision).toMatchObject({ action: "ignore", recordChanged: true });
    expect(decision.record).toMatchObject({ state: "rails_owned", generation: 4 });
    expect(decision.effects).toEqual([
      expect.objectContaining({ code: "marker_changed_externally" }),
    ]);
  });
});

describe("Stripe retries and out-of-order delivery", () => {
  it("gives the same answer for a redelivered event and does not rewrite the record", () => {
    const owned = record("cb_owned", 3);
    const input = { subscriptionId: SUB, liveMarker: marker("cb", 3), at: NOW };
    const first = decideStripeEvent(owned, input);
    const second = decideStripeEvent(first.record, input);
    expect(first).toMatchObject({ action: "process", recordChanged: false, effects: [] });
    expect(second).toEqual(first);
  });

  it("decides from the live marker, so an old event delivered late follows today's owner", () => {
    // Event created while Rails owned it, delivered after the handover committed.
    const decision = decideStripeEvent(record("cb_owned", 3), {
      subscriptionId: SUB,
      liveMarker: marker("cb", 3),
      at: NOW,
    });
    expect(decision.action).toBe("process");
  });

  it("raises the stored generation when the live marker is ahead for the same owner", () => {
    const result = transition(
      record("cb_owned", 3),
      { type: "MARKER_OBSERVED", marker: marker("cb", 6), at: NOW },
      policy,
    );
    expect(result).toMatchObject({ outcome: "unchanged", effects: [] });
    expect(result.record.generation).toBe(6);
  });

  it("never lowers the stored generation", () => {
    const owned = record("cb_owned", 6);
    const result = transition(
      owned,
      { type: "MARKER_OBSERVED", marker: marker("cb", 2), at: NOW },
      policy,
    );
    expect(result.record).toBe(owned);
  });
});

describe("suggested policy", () => {
  it("takes the CB access law and read side as inputs and models Rails as lenient", () => {
    const suggested = suggestedOwnershipPolicy({
      cbAccessRule: strictPaidThroughRule,
      accessReadSide: "rails",
    });
    expect(suggested.cbAccessRule).toBe(strictPaidThroughRule);
    expect(suggested.railsAccessRule).toBe(lenientStatusRule);
    expect(handoverRejections(eligibleFacts, suggested, NOW)).toEqual([
      "access_read_side_is_rails",
    ]);
    expect(
      handoverRejections(
        eligibleFacts,
        suggestedOwnershipPolicy({ cbAccessRule: lenientStatusRule, accessReadSide: "cb" }),
        NOW,
      ),
    ).toEqual([]);
  });
});

describe("first sightings", () => {
  it("creates a CB-owned record for a subscription born in CB checkout", () => {
    expect(
      createOwnershipRecord({ subscriptionId: SUB, marker: marker("cb", 1), at: NOW }),
    ).toEqual({
      record: { subscriptionId: SUB, state: "cb_owned", generation: 1, updatedAt: NOW },
      effects: [],
    });
  });

  it("treats an unknown marker value as Rails and alerts", () => {
    const created = createOwnershipRecord({
      subscriptionId: SUB,
      marker: { owner: "rails", generation: 0, source: "unrecognized" },
      at: NOW,
    });
    expect(created.record.state).toBe("rails_owned");
    expect(created.effects).toEqual([expect.objectContaining({ code: "marker_unrecognized" })]);
  });
});
