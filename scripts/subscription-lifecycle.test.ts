import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assignSubscriptionSeat,
  prepareSubscriptionReduction,
  reconcileBilling,
  removeSubscriptionSeat,
  subscriptionBeneficiaries,
  subscriptionSnapshotSchema,
  type SubscriptionSnapshot,
  type SubscriptionState,
} from "../apps/web/src/subscriptions/lifecycle";

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
    assert.deepEqual(
      subscriptionBeneficiaries(current, now),
      ["unpaid", "canceled"].includes(status) ? [] : ["owner"],
    );
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
  current = prepareSubscriptionReduction(current, "owner", 1, ["b"]).state;
  assert.deepEqual(subscriptionBeneficiaries(current, now), ["owner", "a", "b"]);
  current = reconcileBilling(current, snapshot("active", 1, 1)).state;
  assert.equal(current.kind, "team");
  assert.deepEqual(subscriptionBeneficiaries(current, now), ["b"]);
  current = reconcileBilling(current, snapshot("active", 2, 3)).state;
  assert.deepEqual(subscriptionBeneficiaries(current, now), ["b"]);
});

await test("unplanned reductions pause access until the owner selects a valid roster", () => {
  let current = state();
  for (const userId of ["owner", "a", "b"])
    current = assignSubscriptionSeat(current, "owner", userId, now).state;
  current = reconcileBilling(current, snapshot("active", 1, 2)).state;
  assert.deepEqual(subscriptionBeneficiaries(current, now), []);
  assert.equal(
    prepareSubscriptionReduction(current, "intruder", 2, ["a"]).status,
    "invalid-selection",
  );
  assert.equal(
    prepareSubscriptionReduction(current, "owner", 2, ["a", "a"]).status,
    "invalid-selection",
  );
  current = prepareSubscriptionReduction(current, "owner", 2, ["owner", "b"]).state;
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
