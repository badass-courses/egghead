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
let failProjection = false;
let legacyGrants: unknown[][] = [];
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
  else if (sql.startsWith("select") && sql.includes("from `egghead_Subscription`")) {
    assert.match(sql, /for update$/);
    const row: Record<string, unknown> = {
      id: "local-subscription",
      organizationId: "organization",
      productId: "product",
      createdAt: "1970-01-01 00:00:01.000",
      merchantSubscriptionId: "merchant",
      status: "active",
      fields,
    };
    return [[Object.values(getTableColumns(subscription)).map((column) => row[column.name])], []];
  } else if (sql.startsWith("select") && sql.includes("from `egghead_MerchantSubscription`")) {
    return sql.includes("inner join")
      ? [[["local-subscription"]], []]
      : [[["synthetic-subscription", "owner"]], []];
  } else if (sql.startsWith("select") && sql.includes("from `egghead_OrganizationMembership`"))
    return [[], []];
  else if (sql.startsWith("select") && sql.includes("from `egghead_Entitlement`"))
    return [legacyGrants, []];
  else if (sql.startsWith("insert into `egghead_OrganizationMembership`")) return [[], []];
  else if (sql.startsWith("update `egghead_Entitlement`")) grantUsers = [];
  else if (sql.startsWith("insert into `egghead_Entitlement`")) {
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
const { createSubscriptionStore } = await import("../apps/web/src/subscriptions/store");
const store = createSubscriptionStore(getEggheadDatabase(), () => now);

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
  assert.equal((await store.reconcile(snapshot)).status, "applied");
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
  await assert.rejects(store.reconcile(snapshot), /synthetic projection failure/);
  assert.deepEqual(grantUsers, ["member-0", "member-1"]);
  assert.equal(subscriptionStateSchema.parse(fields["membershipState"]).revision, null);
  assert.equal(statements.at(-1), "rollback");
  failProjection = false;
  assert.equal((await store.reconcile(snapshot)).status, "applied");
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
  assert.equal((await store.reconcile(snapshot)).status, "applied");
  assert.deepEqual(grantUsers, ["member-1"]);
  statements.length = 0;
  assert.equal((await store.reconcile(snapshot)).status, "unchanged");
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
  assert.equal((await store.reconcile({ ...snapshot, seats: 1 })).status, "applied");
  assert.deepEqual(grantUsers, ["owner"]);
  const state = subscriptionStateSchema.parse(fields["membershipState"]);
  assert.equal(state.kind, "individual");
  assert.deepEqual(
    state.assignments.map((assignment) => assignment.userId),
    ["owner"],
  );
});
