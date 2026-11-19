import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { z } from "zod";
import { subscription } from "../apps/web/src/db/schema";
import {
  subscriptionStateSchema,
  type SubscriptionSnapshot,
  type SubscriptionState,
} from "../apps/web/src/subscriptions/lifecycle";

process.env["EGGHEAD_RUNTIME"] = "local";
process.env["DATABASE_URL"] = "mysql://root:root@127.0.0.1:3307/coursebuilder_test";
const now = 2_000_000;
const statements: string[] = [];
let fields: Record<string, unknown> = {};
let grantUsers: string[] = [];
let failProjection: boolean | "deadlock-once" = false;
let legacyGrants: unknown[][] = [];
let rowStatus = "active";
let localExists = true;
let duplicateLocal = false;
let rowOrganization: string | null = "organization";
let merchantIdentifier = "synthetic-subscription";
let deletedMemberships: unknown[][] = [];
// Existing membership rows in the subscription's organization: [id, userId].
let existingMemberships: string[][] = [];
// Live grants from other sources still pointing at a membership: [membershipId].
let otherGrantMemberships: string[][] = [];
let lockedCustomer = "cus_synthetic";
let transactionStart = { fields, grantUsers };
const arraySchema = z.array(z.unknown());
const stringSchema = z.string();

// Only the mysql2 transport is replaced. Real Drizzle builds SQL and decodes rows;
// this receipt fixture proves transaction shape and batching, not MySQL locking.
async function query(options: { sql: string }, input: unknown[]) {
  const sql = options.sql;
  statements.push(sql);
  if (sql === "begin")
    transactionStart = { fields: structuredClone(fields), grantUsers: [...grantUsers] };
  else if (sql === "rollback") {
    fields = transactionStart.fields;
    grantUsers = transactionStart.grantUsers;
  } else if (sql === "commit") return [[], []];
  else if (sql.startsWith("select") && sql.includes("from `egghead_Subscription` inner join")) {
    // The command identity read, outside any transaction.
    return [[[merchantIdentifier, "cus_synthetic"]], []];
  } else if (sql.startsWith("select") && sql.includes("from `egghead_Subscription`")) {
    assert.match(sql, /for update$/);
    const row: Record<string, unknown> = {
      id: "local-subscription",
      organizationId: rowOrganization,
      productId: "product",
      createdAt: "1970-01-01 00:00:01.000",
      merchantSubscriptionId: "merchant",
      status: rowStatus,
      fields,
    };
    return [[Object.values(getTableColumns(subscription)).map((column) => row[column.name])], []];
  } else if (sql.startsWith("select") && sql.includes("from `egghead_MerchantSubscription`")) {
    if (sql.includes("inner join")) {
      assert.match(sql, /order by .*limit \?$/);
      if (!localExists) return [[], []];
      return [
        duplicateLocal
          ? [["local-subscription"], ["duplicate-subscription"]]
          : [["local-subscription"]],
        [],
      ];
    }
    return [[[merchantIdentifier, "owner", lockedCustomer]], []];
  } else if (sql.startsWith("select") && sql.includes("from `egghead_OrganizationMembership`")) {
    assert.match(sql, /for update$/, "membership rows are locked before reuse or delete");
    return [existingMemberships, []];
  } else if (sql.startsWith("select") && sql.includes("`organizationMembershipId` in")) {
    assert.match(sql, /for share$/, "the still-used check is a locking read");
    return [otherGrantMemberships, []];
  } else if (sql.startsWith("select") && sql.includes("from `egghead_Entitlement`"))
    return [legacyGrants, []];
  else if (sql.startsWith("insert into `egghead_OrganizationMembership`")) return [[], []];
  else if (sql.startsWith("delete from `egghead_OrganizationMembership`"))
    deletedMemberships.push(input);
  else if (sql.startsWith("update `egghead_Entitlement`")) grantUsers = [];
  else if (sql.startsWith("insert into `egghead_Entitlement`")) {
    if (failProjection === "deadlock-once") {
      failProjection = false;
      throw Object.assign(new Error("Deadlock found when trying to get lock"), { errno: 1213 });
    }
    if (failProjection) throw new Error("synthetic projection failure");
    // Bindings contain one JSON metadata object per inserted grant. Count the
    // expected beneficiary values independently of ID-generation code.
    grantUsers = input.filter(
      (value): value is string => typeof value === "string" && /^(owner|member-\d+)$/.test(value),
    );
  } else if (sql.startsWith("update `egghead_Subscription`")) {
    fields = z.record(z.string(), z.unknown()).parse(JSON.parse(stringSchema.parse(input[1])));
  } else throw new Error(`Unexpected subscription statement template: ${sql}`);
  return [[], []];
}

const mysqlPath = await realpath(
  fileURLToPath(new URL("../apps/web/node_modules/mysql2/promise.js", import.meta.url)),
);
mock.module(mysqlPath, {
  defaultExport: {
    createPool: () => ({ query, getConnection: async () => ({ query, release: () => undefined }) }),
  },
});
const { getEggheadDatabase } = await import("../apps/web/src/db/adapter");
const { createSubscriptionStore, lifecycleMembershipId } =
  await import("../apps/web/src/subscriptions/store");
// The ownership seam's own tests are below; these tests own every subscription.
const store = createSubscriptionStore(
  getEggheadDatabase(),
  () => now,
  async () => true,
);
const cb = { owner: "cb", stripeCustomerId: "cus_synthetic" } as const;

function seed(count: number) {
  const state: SubscriptionState = {
    ownerId: "owner",
    kind: "team",
    seats: 100,
    status: "active",
    currentPeriodEnd: 5000,
    assignments: Array.from({ length: count }, (_, index) => ({
      userId: `member-${index}`,
      assignedAt: 1,
    })),
    revision: null,
    reduction: null,
  };
  fields = { ownerId: "owner", seats: 100, membershipKind: "team", membershipState: state };
  grantUsers = state.assignments.map((assignment) => assignment.userId);
  statements.length = 0;
  failProjection = false;
  legacyGrants = [];
  rowStatus = "active";
  localExists = true;
  duplicateLocal = false;
  rowOrganization = "organization";
  merchantIdentifier = "synthetic-subscription";
  deletedMemberships = [];
  existingMemberships = [];
  otherGrantMemberships = [];
  lockedCustomer = "cus_synthetic";
}
const snapshot: SubscriptionSnapshot = {
  stripeSubscriptionId: "synthetic-subscription",
  status: "active",
  seats: 100,
  currentPeriodEnd: 6000,
  event: { id: "synthetic-renewal", createdAt: 10, observedAt: 10, kind: "subscription_update" },
};

async function measureReconciliation(count: number) {
  seed(count);
  assert.equal((await store.reconcile(snapshot, cb)).status, "applied");
  assert.equal(grantUsers.length, count);
  assert.equal(
    statements.filter((sql) => sql.startsWith("insert into `egghead_Entitlement`")).length,
    1,
  );
  assert.equal(
    statements.filter((sql) => sql.startsWith("insert into `egghead_OrganizationMembership`"))
      .length,
    1,
  );
  assert.equal(statements.length, 10);
  const state = subscriptionStateSchema.parse(fields["membershipState"]);
  assert.equal(state.currentPeriodEnd, 6000);
  assert.equal(state.assignments.length, count);
  return statements.length;
}

await test("reconciliation batches 100 grants with the same statement budget as one grant", async () => {
  const oneGrantStatements = await measureReconciliation(1);
  const manyGrantStatements = await measureReconciliation(100);
  assert.equal(manyGrantStatements, oneGrantStatements);
});

await test("a failed projection rolls back state and grants and remains retryable", async () => {
  seed(2);
  failProjection = true;
  await assert.rejects(store.reconcile(snapshot, cb), /synthetic projection failure/);
  assert.deepEqual(grantUsers, ["member-0", "member-1"]);
  assert.equal(subscriptionStateSchema.parse(fields["membershipState"]).revision, null);
  assert.equal(statements.at(-1), "rollback");
  failProjection = false;
  assert.equal((await store.reconcile(snapshot, cb)).status, "applied");
});

await test("a renewal reads the locked roster after removal, not a memoized webhook roster", async () => {
  seed(2);
  assert.equal(
    (
      await store.removeSeat({
        subscriptionId: "local-subscription",
        ownerId: "owner",
        userId: "member-0",
      })
    ).status,
    "removed",
  );
  assert.equal((await store.reconcile(snapshot, cb)).status, "applied");
  assert.deepEqual(grantUsers, ["member-1"]);
  statements.length = 0;
  assert.equal((await store.reconcile(snapshot, cb)).status, "unchanged");
  assert.equal(
    statements.some((sql) => sql.startsWith("update") || sql.startsWith("insert")),
    false,
  );
});

await test("invalid inputs are rejected before opening a transaction", async () => {
  seed(1);
  await assert.rejects(
    store.assignSeat({ subscriptionId: "", ownerId: "owner", userId: "member-0" }),
  );
  assert.equal(arraySchema.parse(statements).length, 0);
});

await test("local adoption retires duplicate individual grants and keeps a single owner assignment", async () => {
  seed(1);
  fields = { ownerId: "owner", seats: 1 };
  grantUsers = ["owner", "owner"];
  legacyGrants = [
    ["owner", "1970-01-01 00:00:01.000", null, "1970-01-01 01:23:20.000", { status: "active" }],
    ["owner", "1970-01-01 00:00:02.000", null, "1970-01-01 01:23:20.000", { status: "active" }],
  ];
  assert.equal((await store.reconcile({ ...snapshot, seats: 1 }, cb)).status, "applied");
  assert.deepEqual(grantUsers, ["owner"]);
  const state = subscriptionStateSchema.parse(fields["membershipState"]);
  assert.equal(state.kind, "individual");
  assert.deepEqual(
    state.assignments.map((assignment) => assignment.userId),
    ["owner"],
  );
});

await test("rows no retry can fix raise data errors and write nothing", async () => {
  const { SubscriptionDataError } = await import("../apps/web/src/subscriptions/alerts");
  const dataError = (code: string) => (error: unknown) =>
    error instanceof SubscriptionDataError && error.code === code;

  seed(1);
  fields = { ownerId: "owner", seats: 1 };
  rowStatus = "cancelled_in_rails";
  await assert.rejects(store.reconcile(snapshot, cb), dataError("unknown-subscription-status"));

  seed(1);
  fields = { ownerId: "owner", seats: 2, membershipKind: "team" };
  legacyGrants = [["owner", "1970-01-01 00:00:01.000", null, "1970-01-01 01:23:20.000", 5]];
  await assert.rejects(store.reconcile(snapshot, cb), dataError("invalid-grant-metadata"));

  seed(1);
  fields = { membershipState: { ownerId: "owner" } };
  await assert.rejects(store.reconcile(snapshot, cb), dataError("invalid-subscription-state"));
  assert.equal(
    statements.some((sql) => sql.startsWith("update") || sql.startsWith("insert")),
    false,
  );
});

await test("the Stripe lookup runs before the transaction, ordered, and alerts on duplicates", async () => {
  seed(1);
  duplicateLocal = true;
  const alerts: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => {
    alerts.push(String(line));
  };
  try {
    assert.equal((await store.reconcile(snapshot, cb)).status, "applied");
  } finally {
    console.error = original;
  }
  assert.ok(statements[0]?.includes("inner join"), "lookup first");
  assert.equal(statements[1], "begin");
  assert.equal(alerts.length, 1);
  assert.match(alerts[0] ?? "", /alert=duplicate-stripe-subscription/);
  assert.match(alerts[0] ?? "", /local-subscription/);
});

await test("memberships: one per user per organization, reused, and removed only when unused", async () => {
  const lifecycleRow = (userId: string) => lifecycleMembershipId("organization", userId);
  const insertedMemberships = () =>
    statements.filter((sql) => sql.startsWith("insert into `egghead_OrganizationMembership`"));
  // Existing rows (the owner's personal membership, a legacy row) are reused, not duplicated.
  seed(2);
  existingMemberships = [
    ["egghead-personal-membership:owner", "owner"],
    ["legacy-uuid", "member-0"],
    [lifecycleRow("member-1"), "member-1"],
  ];
  fields = { ...fields, seats: 3 };
  assert.equal((await store.reconcile({ ...snapshot, seats: 3 }, cb)).status, "applied");
  assert.deepEqual(insertedMemberships(), []);
  // A departed member's lifecycle row goes when no other live grant uses it.
  seed(3);
  existingMemberships = [[lifecycleRow("member-1"), "member-1"]];
  const command = { subscriptionId: "local-subscription", ownerId: "owner", userId: "member-1" };
  assert.equal((await store.removeSeat(command)).status, "removed");
  assert.deepEqual(deletedMemberships, [[lifecycleRow("member-1")]]);
  // Another subscription in the organization still grants through it: kept.
  seed(3);
  existingMemberships = [[lifecycleRow("member-1"), "member-1"]];
  otherGrantMemberships = [[lifecycleRow("member-1")]];
  assert.equal((await store.removeSeat(command)).status, "removed");
  assert.deepEqual(deletedMemberships, []);
  // Rows the lifecycle did not create are never removed.
  seed(3);
  existingMemberships = [["legacy-uuid", "member-1"]];
  assert.equal((await store.removeSeat(command)).status, "removed");
  assert.deepEqual(deletedMemberships, []);
  // Renewals that keep the roster delete nothing; the owner is never removed.
  seed(3);
  assert.equal((await store.reconcile(snapshot, cb)).status, "applied");
  assert.equal((await store.removeSeat({ ...command, userId: "owner" })).status, "owner");
  assert.deepEqual(deletedMemberships, []);
});

await test("rows that cannot succeed on retry are data errors; seat commands read them as not-found", async () => {
  const { SubscriptionDataError } = await import("../apps/web/src/subscriptions/alerts");
  const dataError = (code: string) => (error: unknown) =>
    error instanceof SubscriptionDataError && error.code === code;
  const original = console.error;
  console.error = () => undefined;
  try {
    seed(1);
    rowOrganization = null;
    await assert.rejects(store.reconcile(snapshot, cb), dataError("incomplete-subscription-row"));
    assert.equal(
      (
        await store.removeSeat({
          subscriptionId: "local-subscription",
          ownerId: "owner",
          userId: "member-0",
        })
      ).status,
      "not-found",
    );

    seed(1);
    merchantIdentifier = "another-subscription";
    await assert.rejects(store.reconcile(snapshot, cb), dataError("stripe-id-mismatch"));

    seed(1);
    fields = { ownerId: "owner", seats: 2, membershipKind: "team" };
    legacyGrants = Array.from({ length: 201 }, (_, index) => [
      `member-${index}`,
      "1970-01-01 00:00:01.000",
      null,
      "1970-01-01 01:23:20.000",
      { status: "active" },
    ]);
    await assert.rejects(store.reconcile(snapshot, cb), dataError("roster-budget-exceeded"));
  } finally {
    console.error = original;
  }
  assert.equal(
    statements.some((sql) => sql.startsWith("update") || sql.startsWith("insert")),
    false,
  );
});

await test("events the other side owns are acknowledged before any database read", async () => {
  seed(2);
  assert.deepEqual(await store.reconcile(snapshot, { owner: "rails", stripeCustomerId: null }), {
    status: "not-owner",
    subscriptionId: null,
  });
  assert.deepEqual(statements, []);
});

await test("commands ask the seam with the subscription's Stripe identity before locking", async () => {
  seed(2);
  const asked: unknown[] = [];
  const foreign = createSubscriptionStore(
    getEggheadDatabase(),
    () => now,
    async (question) => {
      asked.push(question);
      return false;
    },
  );
  const command = { subscriptionId: "local-subscription", ownerId: "owner", userId: "member-1" };
  assert.equal((await foreign.removeSeat(command)).status, "not-found");
  assert.equal((await foreign.assignSeat({ ...command, userId: "member-9" })).status, "not-found");
  assert.equal(await foreign.owns({ subscriptionId: "local-subscription" }), false);
  assert.deepEqual(
    asked,
    Array.from({ length: 3 }, () => ({
      stripeSubscriptionId: "synthetic-subscription",
      stripeCustomerId: "cus_synthetic",
      now,
    })),
  );
  assert.equal(
    statements.some((sql) => sql.includes("for update")),
    false,
    "no lock taken",
  );
  assert.equal(
    statements.some((sql) => sql.startsWith("update") || sql.startsWith("insert")),
    false,
  );
});

await test("a row re-keyed to another customer after the ownership read is not written", async () => {
  seed(2);
  lockedCustomer = "cus_rekeyed";
  const command = { subscriptionId: "local-subscription", ownerId: "owner", userId: "member-1" };
  assert.equal((await store.removeSeat(command)).status, "not-found");
  const { SubscriptionDataError } = await import("../apps/web/src/subscriptions/alerts");
  await assert.rejects(
    store.reconcile(snapshot, cb),
    (error: unknown) =>
      error instanceof SubscriptionDataError && error.code === "customer-mismatch",
  );
  assert.equal(
    statements.some((sql) => sql.startsWith("update") || sql.startsWith("insert")),
    false,
  );
});

await test("a team observation without a Stripe quantity is a data error, never a cut to one seat", async () => {
  const { SubscriptionDataError } = await import("../apps/web/src/subscriptions/alerts");
  seed(3);
  await assert.rejects(
    store.reconcile({ ...snapshot, seats: 1, seatsReported: false }, cb),
    (error: unknown) =>
      error instanceof SubscriptionDataError && error.code === "unsupported-stripe-shape",
  );
  assert.equal(
    statements.some((sql) => sql.startsWith("update") || sql.startsWith("insert")),
    false,
  );
  assert.deepEqual(grantUsers, ["member-0", "member-1", "member-2"]);
  // An individual subscription without a quantity is one seat, as Stripe means it.
  seed(1);
  fields = { ownerId: "owner", seats: 1 };
  assert.equal(
    (await store.reconcile({ ...snapshot, seats: 1, seatsReported: false }, cb)).status,
    "applied",
  );
});

const timeline = (value: string) => ({ egghead_owner_timeline: value });
const markerRead = (metadata: Record<string, string> | "deleted") => async () =>
  metadata === "deleted" ? ({ deleted: true } as const) : ({ deleted: false, metadata } as const);

await test("command ownership follows #47's marker: CB now and after every scheduled flip", async () => {
  const { createCommandOwnership } = await import("../apps/web/src/subscriptions/ownership-seam");
  const nowMs = 1_800_000_000_000;
  const question = { stripeSubscriptionId: "sub_x", stripeCustomerId: "cus_x", now: nowMs };
  const owns = (metadata: Record<string, string> | "deleted") =>
    createCommandOwnership(markerRead(metadata))(question);
  assert.equal(await owns(timeline("cb@0")), true);
  assert.equal(await owns(timeline("rails@0")), false);
  assert.equal(await owns({}), false, "no marker routes to Rails");
  assert.equal(await owns(timeline("cb@0;rails@1800000600")), false, "a flip away is scheduled");
  assert.equal(await owns(timeline("rails@0;cb@1800000600")), false, "CB does not own it yet");
  assert.equal(await owns(timeline("not-a-timeline")), false);
  assert.equal(await owns("deleted"), false);
  assert.equal(
    await createCommandOwnership(markerRead(timeline("cb@0")))({
      ...question,
      stripeCustomerId: null,
    }),
    false,
  );
});

await test("event ownership is routed by the customer timeline at the event's created time", async () => {
  const { decideEventOwnership } = await import("../apps/web/src/subscriptions/ownership-seam");
  const decide = (
    metadata: Record<string, string> | "deleted",
    eventCreated: number,
    customer: string | null = "cus_x",
  ) =>
    decideEventOwnership(
      { eventId: "evt_x", eventCreated, stripeCustomerId: customer, receivedAt: 1 },
      markerRead(metadata),
      async () => ({ status: "no-local-rows" }) as const,
    );
  const handover = { egghead_owner_timeline: "rails@0;cb@1000" };
  assert.equal((await decide(handover, 999)).stamp.owner, "rails");
  assert.equal((await decide(handover, 1000)).stamp.owner, "cb");
  assert.equal((await decide({}, 5000)).stamp.owner, "rails");
  assert.equal(
    (await decide({ egghead_owner_timeline: "cb@0" }, 5)).stamp.basis,
    "customer_timeline",
  );
  // A deleted customer with no local rows has nothing CB could write: Rails (see the L2 test).
  assert.equal((await decide("deleted", 5000)).stamp.owner, "rails");
  assert.equal((await decide({ egghead_owner_timeline: "cb@0" }, 5, null)).stamp.owner, "rails");
  const routed = await decide(handover, 1000);
  assert.deepEqual(
    { eventCreated: routed.eventCreated, stripeCustomerId: routed.stripeCustomerId },
    { eventCreated: 1000, stripeCustomerId: "cus_x" },
  );
});

await test("lock conflicts rerun the whole transaction, at most three times", async () => {
  const { retryLockConflicts, isLockConflict } =
    await import("../apps/web/src/subscriptions/store");
  const deadlock = Object.assign(new Error("Deadlock found"), { errno: 1213 });
  const wrappedTimeout = new Error("query failed", {
    cause: Object.assign(new Error("Lock wait timeout"), { errno: 1205 }),
  });
  assert.equal(isLockConflict(deadlock), true);
  assert.equal(isLockConflict(wrappedTimeout), true);
  assert.equal(isLockConflict(Object.assign(new Error("dup"), { errno: 1062 })), false);
  const waits: number[] = [];
  const wait = async (attempt: number) => {
    waits.push(attempt);
  };
  let calls = 0;
  assert.equal(
    await retryLockConflicts(async () => {
      calls++;
      if (calls < 3) throw calls === 1 ? deadlock : wrappedTimeout;
      return "applied";
    }, wait),
    "applied",
  );
  assert.deepEqual([calls, waits], [3, [1, 2]]);
  calls = 0;
  await assert.rejects(
    retryLockConflicts(async () => {
      calls++;
      throw deadlock;
    }, wait),
    /Deadlock found/,
  );
  assert.equal(calls, 3, "gives up after three attempts");
  calls = 0;
  await assert.rejects(
    retryLockConflicts(async () => {
      calls++;
      throw new Error("not a lock conflict");
    }, wait),
    /not a lock conflict/,
  );
  assert.equal(calls, 1);
});

await test("a reconcile rolled back by a deadlock reruns and applies once", async () => {
  seed(2);
  failProjection = "deadlock-once";
  assert.equal((await store.reconcile(snapshot, cb)).status, "applied");
  assert.equal(statements.filter((sql) => sql === "begin").length, 2);
  assert.equal(statements.filter((sql) => sql === "rollback").length, 1);
  assert.deepEqual(grantUsers, ["member-0", "member-1"]);
});

const deletedCustomerRead = async () => ({ deleted: true }) as const;

await test("a deleted customer routes by its recorded customer.deleted marker, never by default", async () => {
  const {
    decideEventOwnership,
    DeletedCustomerPendingError,
    DELETED_CUSTOMER_RECORD_WAIT_SECONDS,
  } = await import("../apps/web/src/subscriptions/ownership-seam");
  const decide = (
    record: Awaited<
      ReturnType<
        typeof import("../apps/web/src/subscriptions/deleted-customers").readDeletedCustomerRecord
      >
    >,
    eventCreated: number,
    receivedAt: number,
  ) =>
    decideEventOwnership(
      { eventId: "evt_x", eventCreated, stripeCustomerId: "cus_x", receivedAt },
      deletedCustomerRead,
      async () => record,
    );
  const handedOver = {
    status: "recorded",
    metadata: { egghead_owner: "cb", egghead_owner_timeline: "rails@0;cb@1000" },
  } as const;
  const after = await decide(handedOver, 1500, 1600);
  assert.deepEqual([after.stamp.owner, after.stamp.basis], ["cb", "deleted_customer_record"]);
  assert.equal((await decide(handedOver, 900, 1600)).stamp.owner, "rails");
  // No local rows: CB could never write for this customer.
  assert.equal((await decide({ status: "no-local-rows" }, 1500, 1600)).stamp.owner, "rails");
  // Local rows but no customer.deleted yet: retry instead of stamping Rails for good.
  await assert.rejects(
    decide({ status: "pending" }, 1500, 1600),
    (error: unknown) => error instanceof DeletedCustomerPendingError,
  );
  // After Stripe's retry window, route to Rails with an alert.
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => {
    lines.push(String(line));
  };
  try {
    const late = await decide(
      { status: "pending" },
      1500,
      1500 + DELETED_CUSTOMER_RECORD_WAIT_SECONDS,
    );
    assert.equal(late.stamp.owner, "rails");
  } finally {
    console.error = original;
  }
  assert.match(lines.join("\n"), /alert=deleted-customer-unrecorded/);
});

await test("a marker read failure makes /team commands unavailable with an alert, not a 500", async () => {
  seed(2);
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => {
    lines.push(String(line));
  };
  const outage = createSubscriptionStore(
    getEggheadDatabase(),
    () => now,
    async () => {
      throw Object.assign(new Error("connect ECONNRESET someone@example.test"), {
        type: "StripeConnectionError",
      });
    },
  );
  const command = { subscriptionId: "local-subscription", ownerId: "owner", userId: "member-1" };
  try {
    assert.equal((await outage.removeSeat(command)).status, "not-found");
    assert.equal((await outage.assignSeat({ ...command, userId: "member-9" })).status, "not-found");
    assert.equal(await outage.owns({ subscriptionId: "local-subscription" }), false);
  } finally {
    console.error = original;
  }
  assert.equal(lines.filter((line) => line.includes("alert=ownership-read-failed")).length, 3);
  assert.equal(lines.join("").includes("example.test"), false, "no message is logged");
  assert.equal(
    statements.some((sql) => sql.includes("for update")),
    false,
    "nothing locked",
  );
});

await test("seat assignment re-checks the locked row: an ended or non-current row takes no one", async () => {
  // The row's status column says canceled while the stored state still says active.
  seed(1);
  rowStatus = "canceled";
  const command = { subscriptionId: "local-subscription", ownerId: "owner", userId: "member-9" };
  assert.equal((await store.assignSeat(command)).status, "not-found");
  // The stored period has ended.
  seed(1);
  fields = {
    ...fields,
    membershipState: {
      ...subscriptionStateSchema.parse(fields["membershipState"]),
      currentPeriodEnd: 1,
    },
  };
  assert.equal((await store.assignSeat(command)).status, "not-found");
  // Suspended billing in the stored state.
  seed(1);
  fields = {
    ...fields,
    membershipState: {
      ...subscriptionStateSchema.parse(fields["membershipState"]),
      status: "unpaid",
    },
  };
  assert.equal((await store.assignSeat(command)).status, "not-found");
  assert.equal(
    statements.some((sql) => sql.startsWith("update") || sql.startsWith("insert")),
    false,
  );
  // An active row with a current period still assigns.
  seed(1);
  assert.equal((await store.assignSeat(command)).status, "assigned");
});
