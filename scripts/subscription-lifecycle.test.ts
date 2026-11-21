import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assignSubscriptionSeat,
  prepareSubscriptionReduction,
  reconcileBilling,
  removeSubscriptionSeat,
  subscriptionAvailableSeats,
  subscriptionBeneficiaries,
  subscriptionInviteState,
  subscriptionSnapshotSchema,
  type SubscriptionSnapshot,
  type SubscriptionState,
} from "../apps/web/src/subscriptions/lifecycle";
import {
  adoptLegacySubscriptionState,
  rowAvailableSeats,
} from "../apps/web/src/subscriptions/legacy-adoption";

const now = 2_000_000;
function state(kind: "team" | "individual" = "team"): SubscriptionState {
  return {
    ownerId: "owner",
    kind,
    seats: kind === "team" ? 3 : 1,
    status: "active",
    currentPeriodEnd: 5000,
    revision: null,
    reduction: null,
    assignments: kind === "team" ? [] : [{ userId: "owner", assignedAt: 1 }],
  };
}
function snapshot(
  status: SubscriptionSnapshot["status"],
  createdAt: number,
  seats = 3,
): SubscriptionSnapshot {
  return {
    stripeSubscriptionId: "synthetic-subscription",
    status,
    seats,
    currentPeriodEnd: 5000,
    event: {
      id: `synthetic-event-${createdAt}`,
      createdAt,
      observedAt: createdAt,
      kind: "subscription_update",
    },
  };
}

await test("individual renewal, suspension, recovery and cancellation keep one beneficiary", () => {
  let current = state("individual");
  for (const [index, status] of ["active", "past_due", "unpaid", "active", "canceled"].entries()) {
    current = reconcileBilling(
      current,
      snapshot(subscriptionSnapshotSchema.shape.status.parse(status), index + 1, 1),
    ).state;
    assert.deepEqual(subscriptionBeneficiaries(current, now), status === "active" ? ["owner"] : []);
    assert.equal(current.assignments.length, 1);
  }
});

await test("suspension preserves assignments; removing a member during suspension survives recovery", () => {
  let current = state();
  current = assignSubscriptionSeat(current, "owner", "a", now).state;
  current = assignSubscriptionSeat(current, "owner", "b", now).state;
  current = reconcileBilling(current, snapshot("unpaid", 1)).state;
  assert.deepEqual(subscriptionBeneficiaries(current, now), []);
  assert.equal(current.assignments.length, 2);
  current = removeSubscriptionSeat(current, "owner", "a").state;
  current = reconcileBilling(current, snapshot("active", 2)).state;
  assert.deepEqual(subscriptionBeneficiaries(current, now), ["b"]);
});

await test("owner-selected reductions preserve access until billing changes and retain only selected people", () => {
  let current = state();
  for (const userId of ["owner", "a", "b"])
    current = assignSubscriptionSeat(current, "owner", userId, now).state;
  current = prepareSubscriptionReduction(current, "owner", 2, ["owner", "b"], now).state;
  assert.deepEqual(subscriptionBeneficiaries(current, now), ["owner", "a", "b"]);
  current = reconcileBilling(current, snapshot("active", 1, 2)).state;
  assert.equal(current.kind, "team");
  assert.deepEqual(subscriptionBeneficiaries(current, now), ["owner", "b"]);
  current = reconcileBilling(current, snapshot("active", 2, 3)).state;
  assert.deepEqual(subscriptionBeneficiaries(current, now), ["owner", "b"]);
});

await test("a reduction must retain the owner: empty and owner-less selections are refused", () => {
  let current = state();
  for (const userId of ["owner", "a", "b"])
    current = assignSubscriptionSeat(current, "owner", userId, now).state;
  for (const retained of [[], ["a"], ["a", "b"]])
    assert.equal(
      prepareSubscriptionReduction(current, "owner", 2, retained, now).status,
      "invalid-selection",
      `retained ${JSON.stringify(retained)}`,
    );
  // The same rule in capacity review, where a valid selection applies at once.
  const reviewed = reconcileBilling(current, snapshot("active", 1, 2)).state;
  assert.equal(
    prepareSubscriptionReduction(reviewed, "owner", 2, [], now).status,
    "invalid-selection",
  );
  assert.equal(
    prepareSubscriptionReduction(reviewed, "owner", 2, ["a", "b"], now).status,
    "invalid-selection",
  );
  assert.equal(
    prepareSubscriptionReduction(reviewed, "owner", 2, ["owner", "a"], now).status,
    "prepared",
  );
});

await test("unplanned reductions pause access until the owner selects a valid roster", () => {
  let current = state();
  for (const userId of ["owner", "a", "b"])
    current = assignSubscriptionSeat(current, "owner", userId, now).state;
  current = reconcileBilling(current, snapshot("active", 1, 2)).state;
  assert.deepEqual(subscriptionBeneficiaries(current, now), []);
  assert.equal(
    prepareSubscriptionReduction(current, "intruder", 2, ["a"], now).status,
    "invalid-selection",
  );
  assert.equal(
    prepareSubscriptionReduction(current, "owner", 2, ["a", "a"], now).status,
    "invalid-selection",
  );
  current = prepareSubscriptionReduction(current, "owner", 2, ["owner", "b"], now).state;
  assert.deepEqual(subscriptionBeneficiaries(current, now), ["owner", "b"]);
});

await test("stale and repeated observations cannot undo removal or newer billing state", () => {
  let current = assignSubscriptionSeat(state(), "owner", "a", now).state;
  current = reconcileBilling(current, snapshot("active", 10)).state;
  current = removeSubscriptionSeat(current, "owner", "a").state;
  assert.equal(reconcileBilling(current, snapshot("active", 10)).status, "unchanged");
  assert.equal(reconcileBilling(current, snapshot("unpaid", 9)).status, "unchanged");
  assert.deepEqual(subscriptionBeneficiaries(current, now), []);
  current = reconcileBilling(current, snapshot("active", 11)).state;
  assert.deepEqual(subscriptionBeneficiaries(current, now), []);
});

await test("expiry and final cancellation are independent of assignment and permit missing canceled periods", () => {
  const individual = state("individual");
  assert.deepEqual(subscriptionBeneficiaries(individual, 5_000_000), []);
  const canceled = subscriptionSnapshotSchema.parse({
    ...snapshot("canceled", 1, 1),
    currentPeriodEnd: null,
  });
  assert.deepEqual(
    subscriptionBeneficiaries(reconcileBilling(individual, canceled).state, now),
    [],
  );
  assert.throws(() => subscriptionSnapshotSchema.parse({ ...canceled, status: "active" }));
});

await test("final cancellation is terminal even when a later stale checkout observation arrives", () => {
  const canceled = reconcileBilling(state("individual"), snapshot("canceled", 2, 1)).state;
  const result = reconcileBilling(canceled, {
    ...snapshot("active", 3, 1),
    event: { ...snapshot("active", 3, 1).event, kind: "checkout" },
  });
  assert.equal(result.status, "unchanged");
  assert.deepEqual(subscriptionBeneficiaries(result.state, now), []);
});

await test("generated command histories agree with an independent assignment and billing model", () => {
  for (let seed = 1; seed <= 80; seed++) {
    let current = state();
    const assigned = new Set<string>();
    let eligible = true;
    let random = seed;
    for (let step = 1; step <= 50; step++) {
      random = (random * 1664525 + 1013904223) >>> 0;
      const command = random % 4;
      const userId = `member-${random % 5}`;
      if (command === 0) {
        current = assignSubscriptionSeat(current, "owner", userId, now).state;
        if (eligible && assigned.size < 3) assigned.add(userId);
      } else if (command === 1) {
        current = removeSubscriptionSeat(current, "owner", userId).state;
        assigned.delete(userId);
      } else {
        eligible = command === 2;
        current = reconcileBilling(current, snapshot(eligible ? "active" : "unpaid", step)).state;
      }
      assert.deepEqual(
        new Set(subscriptionBeneficiaries(current, now)),
        eligible ? assigned : new Set(),
      );
      assert.deepEqual(
        new Set(current.assignments.map((assignment) => assignment.userId)),
        assigned,
      );
    }
  }
});

function teamWith(userIds: string[], seats = 3) {
  let current = { ...state(), seats };
  for (const userId of userIds)
    current = assignSubscriptionSeat(current, "owner", userId, now).state;
  return current;
}

await test("a reduction must lower capacity unless it resolves a capacity review", () => {
  const current = teamWith(["owner", "a", "b"]);
  assert.equal(
    prepareSubscriptionReduction(current, "owner", 3, ["owner", "a"], now).status,
    "invalid-selection",
  );
  // The bug this guards: a plan at the current quantity fired on the next renewal.
  assert.deepEqual(
    subscriptionBeneficiaries(reconcileBilling(current, snapshot("active", 1, 3)).state, now),
    ["owner", "a", "b"],
  );
  const reviewed = reconcileBilling(current, snapshot("active", 1, 2)).state;
  const resolved = prepareSubscriptionReduction(reviewed, "owner", 2, ["owner", "a"], now);
  assert.equal(resolved.status, "prepared");
  assert.deepEqual(subscriptionBeneficiaries(resolved.state, now), ["owner", "a"]);
});

await test("a pending reduction expires at the next renewal that does not apply it", () => {
  let current = prepareSubscriptionReduction(
    teamWith(["owner", "a", "b"]),
    "owner",
    2,
    ["owner", "a"],
    now,
  ).state;
  // Same period, other change: the plan keeps waiting.
  current = reconcileBilling(current, snapshot("past_due", 1, 3)).state;
  assert.equal(current.reduction?.seats, 2);
  // The next period arrives at the old quantity: the plan is dropped.
  current = reconcileBilling(current, {
    ...snapshot("active", 2, 3),
    currentPeriodEnd: 9000,
  }).state;
  assert.equal(current.reduction, null);
  // A later quantity match no longer removes anyone.
  current = reconcileBilling(current, {
    ...snapshot("active", 3, 2),
    currentPeriodEnd: 9000,
  }).state;
  assert.deepEqual(
    current.assignments.map((assignment) => assignment.userId),
    ["owner", "a", "b"],
  );
});

await test("members assigned after a plan is saved are kept, within the planned capacity", () => {
  let current = prepareSubscriptionReduction(
    teamWith(["owner", "a"], 4),
    "owner",
    3,
    ["owner"],
    now,
  ).state;
  const later = now + 1000;
  const added = assignSubscriptionSeat(current, "owner", "c", later);
  assert.equal(added.status, "assigned");
  current = added.state;
  current = assignSubscriptionSeat(current, "owner", "d", later).state;
  // owner + c + d fill the planned three seats, so a fourth is refused.
  assert.equal(assignSubscriptionSeat(current, "owner", "e", later).status, "full");
  current = reconcileBilling(current, snapshot("active", 1, 3)).state;
  assert.deepEqual(
    current.assignments.map((assignment) => assignment.userId),
    ["owner", "c", "d"],
  );
  assert.equal(current.reduction, null);
});

await test("invite availability and the seat writer agree in every state", () => {
  const later = now + 1000;
  const states = [
    teamWith(["owner"]),
    teamWith(["owner", "a", "b"]),
    reconcileBilling(teamWith(["owner", "a", "b"]), snapshot("active", 1, 2)).state,
    prepareSubscriptionReduction(teamWith(["owner", "a"], 4), "owner", 2, ["owner"], now).state,
    prepareSubscriptionReduction(teamWith(["owner", "a"], 4), "owner", 3, ["owner"], now).state,
    reconcileBilling(teamWith(["owner"]), snapshot("unpaid", 1)).state,
    state("individual"),
  ];
  for (const candidate of states) {
    const available = subscriptionAvailableSeats(candidate, later);
    const attempt = assignSubscriptionSeat(candidate, "owner", "newcomer", later).status;
    assert.equal(attempt === "assigned", available > 0, JSON.stringify({ available, attempt }));
  }
  // A pending plan for two seats with the owner retained leaves exactly one.
  assert.equal(subscriptionAvailableSeats(states[3] ?? state(), later), 1);
});

await test("a one-seat purchase whose paid quantity rises becomes a team, and never turns back", () => {
  const promoted = reconcileBilling(state("individual"), snapshot("active", 1, 3)).state;
  assert.equal(promoted.kind, "team");
  assert.deepEqual(
    promoted.assignments.map((assignment) => assignment.userId),
    ["owner"],
  );
  assert.equal(subscriptionAvailableSeats(promoted, now), 2);
  assert.equal(assignSubscriptionSeat(promoted, "owner", "a", now).status, "assigned");
  const lowered = reconcileBilling(promoted, snapshot("active", 2, 1)).state;
  assert.equal(lowered.kind, "team");
  // One paid seat at quantity one stays individual.
  assert.equal(
    reconcileBilling(state("individual"), snapshot("active", 1, 1)).state.kind,
    "individual",
  );
});

const legacyGrant = (userId: string, deleted = false, status = "active") => ({
  userId,
  createdAt: new Date(2000),
  deletedAt: deleted ? new Date(3000) : null,
  expiresAt: new Date(9_000_000_000),
  metadata: { status },
});

await test("legacy rows: the invite page and the seat writer agree on availability", () => {
  const created = new Date(1000);
  const grant = legacyGrant;
  const cases = [
    // A team row with no grants has no known period: the writer offers nothing,
    // so the page must not offer three seats (round-4 item 2.2).
    { fields: { ownerId: "owner", seats: 3 }, grants: [] },
    { fields: { ownerId: "owner", seats: 3 }, grants: [grant("owner")] },
    { fields: { ownerId: "owner", seats: 2 }, grants: [grant("owner"), grant("a")] },
    { fields: { ownerId: "owner", seats: 3 }, grants: [grant("owner"), grant("a", true)] },
    {
      fields: { ownerId: "owner", seats: 3 },
      grants: [grant("owner", true, "unpaid"), grant("a", true, "unpaid")],
    },
    {
      fields: { ownerId: "owner", seats: 1, membershipKind: "individual" },
      grants: [grant("owner")],
    },
    { fields: { seats: 3 }, grants: [grant("owner")] },
  ];
  for (const { fields, grants } of cases) {
    const available = rowAvailableSeats({
      fields,
      rowStatus: "active",
      rowCreatedAt: created,
      grants,
      now,
    });
    let writer = "not-found";
    try {
      const adopted = adoptLegacySubscriptionState({
        fields,
        merchantOwnerId: null,
        rowStatus: "active",
        rowCreatedAt: created,
        grants,
      });
      writer = assignSubscriptionSeat(adopted, "owner", "newcomer", now).status;
    } catch {
      writer = "not-found";
    }
    assert.equal(
      writer === "assigned",
      available > 0,
      JSON.stringify({ fields, available, writer }),
    );
  }
  assert.equal(
    rowAvailableSeats({
      fields: { ownerId: "owner", seats: 3 },
      rowStatus: "active",
      rowCreatedAt: created,
      grants: [grant("owner")],
      now,
    }),
    2,
  );
});

type ReferenceModel = {
  seats: number;
  status: SubscriptionSnapshot["status"];
  periodEnd: number;
  assigned: Map<string, number>;
  plan: { seats: number; retained: Set<string>; savedAt: number; periodEnd: number } | null;
};
const referenceGrants = (status: string) =>
  status === "active" || status === "past_due" || status === "trialing";
/** Retained by a pending plan: the saved list plus anyone assigned after it was saved. */
const referenceKeeps = (model: ReferenceModel, userId: string) => {
  const plan = model.plan;
  const at = model.assigned.get(userId) ?? 0;
  return plan === null || plan.retained.has(userId) || at > plan.savedAt;
};

await test("generated histories with plans, reviews, seat changes, renewals and cancellation match a reference model", () => {
  type Model = ReferenceModel;
  const statuses = ["active", "active", "active", "past_due", "unpaid"] as const;
  const grants = referenceGrants;
  const keeps = referenceKeeps;
  let commands = 0;
  for (let seed = 1; seed <= 120; seed++) {
    let random = seed;
    const next = (n: number) => {
      random = (random * 1664525 + 1013904223) >>> 0;
      return random % n;
    };
    let current: SubscriptionState = {
      ...state(),
      currentPeriodEnd: 10_000,
      assignments: [{ userId: "owner", assignedAt: 1 }],
    };
    const model: Model = {
      seats: 3,
      status: "active",
      periodEnd: 10_000,
      assigned: new Map([["owner", 1]]),
      plan: null,
    };
    for (let step = 1; step <= 60; step++) {
      const at = now + step * 10;
      const userId = `member-${next(6)}`;
      const command = next(20);
      commands++;
      if (command < 6) {
        // Assign.
        const result = assignSubscriptionSeat(current, "owner", userId, at);
        current = result.state;
        const live = model.status !== "canceled" && grants(model.status);
        const room = model.seats - model.assigned.size;
        const plannedRoom = model.plan
          ? model.plan.seats - [...model.assigned.keys()].filter((id) => keeps(model, id)).length
          : Number.POSITIVE_INFINITY;
        if (live && !model.assigned.has(userId) && Math.min(room, plannedRoom) > 0)
          model.assigned.set(userId, at);
      } else if (command < 9) {
        // Remove; the owner always keeps their seat.
        current = removeSubscriptionSeat(current, "owner", userId).state;
        if (userId !== "owner") model.assigned.delete(userId);
      } else if (command < 12) {
        // Plan a reduction (or resolve a capacity review) keeping the owner and maybe one member.
        const seats = 1 + next(model.seats);
        const retained = [
          "owner",
          ...[...model.assigned.keys()].filter((id) => id !== "owner" && next(2) === 0),
        ].slice(0, seats);
        const result = prepareSubscriptionReduction(current, "owner", seats, retained, at);
        current = result.state;
        const review = model.assigned.size > model.seats && seats === model.seats;
        if (review) {
          for (const id of model.assigned.keys())
            if (!retained.includes(id)) model.assigned.delete(id);
          model.plan = null;
        } else if (seats < model.seats)
          model.plan = {
            seats,
            retained: new Set(retained),
            savedAt: at,
            periodEnd: model.periodEnd,
          };
        else assert.equal(result.status, "invalid-selection");
      } else {
        // A billing observation: maybe a seat change, a renewal into the next period,
        // a status change, or (rarely) final cancellation.
        const seats = next(3) === 0 ? 1 + next(5) : model.seats;
        const renewed = next(3) === 0;
        const periodEnd = renewed ? model.periodEnd + 1000 : model.periodEnd;
        const status = next(25) === 0 ? "canceled" : (statuses[next(statuses.length)] ?? "active");
        const observed: SubscriptionSnapshot = {
          stripeSubscriptionId: "synthetic-subscription",
          status,
          seats,
          currentPeriodEnd: periodEnd,
          event: {
            id: `evt-${seed}-${step}`,
            createdAt: step,
            observedAt: step,
            kind: "subscription_update",
          },
        };
        current = reconcileBilling(current, observed).state;
        if (model.status !== "canceled" || status === "canceled") {
          const plan = model.plan;
          if (plan && seats === plan.seats && seats <= model.seats) {
            for (const id of model.assigned.keys())
              if (!keeps(model, id)) model.assigned.delete(id);
            model.plan = null;
          } else if (plan && periodEnd > plan.periodEnd) model.plan = null;
          model.seats = seats;
          model.status = status;
          model.periodEnd = periodEnd;
        }
      }
      const reviewing = model.assigned.size > model.seats;
      const expected =
        model.status === "active" && !reviewing ? new Set(model.assigned.keys()) : new Set();
      const context = JSON.stringify({ seed, step, command });
      assert.deepEqual(new Set(subscriptionBeneficiaries(current, at)), expected, context);
      assert.deepEqual(
        new Set(current.assignments.map((assignment) => assignment.userId)),
        new Set(model.assigned.keys()),
        context,
      );
      assert.equal(current.reduction === null, model.plan === null, context);
      assert.equal(current.seats, model.seats, context);
      // The page's availability and the writer always agree.
      const available = subscriptionAvailableSeats(current, at);
      const probe = assignSubscriptionSeat(current, "owner", "probe", at).status;
      assert.equal(probe === "assigned", available > 0, context);
      // An invite is "open" exactly when the writer would assign.
      assert.equal(subscriptionInviteState(current, at) === "open", available > 0, context);
    }
  }
  assert.ok(commands >= 7000);
});

await test("invites say paused for a team waiting on billing or capacity review, not claimed", () => {
  const later = now + 1000;
  const full = teamWith(["owner", "a", "b"]);
  assert.equal(subscriptionInviteState(teamWith(["owner"]), later), "open");
  assert.equal(subscriptionInviteState(full, later), "full");
  const reviewing = reconcileBilling(full, snapshot("active", 1, 2)).state;
  assert.equal(subscriptionInviteState(reviewing, later), "paused");
  for (const status of ["unpaid", "paused", "incomplete"] as const)
    assert.equal(
      subscriptionInviteState(
        reconcileBilling(teamWith(["owner"]), snapshot(status, 1)).state,
        later,
      ),
      "paused",
      status,
    );
  assert.equal(
    subscriptionInviteState(
      reconcileBilling(teamWith(["owner"]), snapshot("canceled", 1)).state,
      later,
    ),
    "closed",
  );
  assert.equal(subscriptionInviteState(state("individual"), later), "closed");
});

await test("legacy rosters of 101-200 users are a data error, never a ZodError; pages offer nothing", async () => {
  const { SubscriptionDataError } = await import("../apps/web/src/subscriptions/alerts");
  const { rowInviteState } = await import("../apps/web/src/subscriptions/legacy-adoption");
  const grants = Array.from({ length: 150 }, (_, index) => legacyGrant(`user-${index}`));
  const row = {
    fields: { ownerId: "user-0", seats: 100 },
    rowStatus: "active",
    rowCreatedAt: new Date(1000),
    grants,
  };
  assert.throws(
    () => adoptLegacySubscriptionState({ ...row, merchantOwnerId: null }),
    (error: unknown) =>
      error instanceof SubscriptionDataError && error.code === "roster-budget-exceeded",
  );
  assert.equal(rowAvailableSeats({ ...row, now }), 0);
  assert.equal(rowInviteState({ ...row, now }), "closed");
});

await test("a main-era bulk:false row raised to 3 seats keeps its members, in commands and reconcile", () => {
  // Main wrote no lifecycle fields for a one-seat purchase; the members came later.
  const grants = [legacyGrant("owner"), legacyGrant("member-a"), legacyGrant("member-b")];
  const base = {
    fields: {},
    merchantOwnerId: "owner",
    rowStatus: "active",
    rowCreatedAt: new Date(1000),
    grants,
  };
  const raised: SubscriptionSnapshot = {
    ...snapshot("active", 10, 3),
    initialKind: "individual",
  };
  const reconciled = adoptLegacySubscriptionState({ ...base, initialSnapshot: raised });
  const commanded = adoptLegacySubscriptionState(base);
  for (const adopted of [reconciled, commanded]) {
    assert.equal(adopted.kind, "team");
    assert.deepEqual(adopted.assignments.map((assignment) => assignment.userId).toSorted(), [
      "member-a",
      "member-b",
      "owner",
    ]);
  }
  // The renewal then keeps all three as beneficiaries.
  assert.deepEqual(
    subscriptionBeneficiaries(reconcileBilling(reconciled, raised).state, now).toSorted(),
    ["member-a", "member-b", "owner"],
  );
  // A true one-seat purchase with no members stays individual.
  const solo = adoptLegacySubscriptionState({
    ...base,
    grants: [legacyGrant("owner")],
    initialSnapshot: { ...snapshot("active", 10, 1), initialKind: "individual" },
  });
  assert.equal(solo.kind, "individual");
});
