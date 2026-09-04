import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import type { SQL } from "../../apps/web/node_modules/drizzle-orm";
import { appImport, appModule, resetRuntimeEnvironment } from "./fixtures";

const { MySqlDialect }: typeof import("../../apps/web/node_modules/drizzle-orm/mysql-core") =
  await import(appImport("drizzle-orm/mysql-core"));
const schema: typeof import("../../apps/web/src/db/schema") = await import(
  appModule("db/schema.ts")
);
const dialect = new MySqlDialect();
type Row = Record<string, unknown>;
type Query = { where?: SQL; with?: Record<string, boolean> };
const rows = new Map<unknown, Row[]>();
const writes: { table: unknown; values: Row }[] = [];
const now = new Date("2030-01-10T00:00:00.000Z");
const paidEnd = new Date("2030-02-01T00:00:00.000Z");
const nextEnd = new Date("2030-03-01T00:00:00.000Z");
const subscriptionId = "subscription-team";
const stripeId = "sub_lifecycle";
const ownerId = "owner";

function record(value: unknown): Row {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

function tableRows(table: unknown): Row[] {
  const stored = rows.get(table);
  assert.ok(stored, "Every accessed persistence table must have an explicit fixture");
  return stored;
}

// Only the equality/null/status filters used by these handlers are needed here.
// Drizzle still builds the real predicates; this fake does not implement billing rules.
function matchingRows(table: unknown, where?: SQL): Row[] {
  if (!where) return tableRows(table);
  const query = dialect.sqlToQuery(where);
  return tableRows(table).filter((row) => {
    for (const match of query.sql.matchAll(/`([^`]+)`\s*=\s*\?/g)) {
      const column = match[1];
      assert.ok(column);
      const parameter = query.sql.slice(0, match.index).split("?").length - 1;
      if (row[column] !== query.params[parameter]) return false;
    }
    for (const match of query.sql.matchAll(/`([^`]+)`\s+is null/gi)) {
      const column = match[1];
      assert.ok(column);
      if (row[column] !== null) return false;
    }
    if (/`status`\s+in\s*\(/i.test(query.sql) && !query.params.includes(row["status"]))
      return false;
    return true;
  });
}

function relatedRow(table: unknown, row: Row, query: Query): Row {
  const result = structuredClone(row);
  if (table === schema.merchantSubscription && query.with?.["subscription"]) {
    result["subscription"] = structuredClone(
      tableRows(schema.subscription).find(
        (candidate) => candidate["merchantSubscriptionId"] === row["id"],
      ),
    );
  }
  if (table === schema.subscription && query.with?.["merchantSubscription"]) {
    result["merchantSubscription"] = structuredClone(
      tableRows(schema.merchantSubscription).find(
        (candidate) => candidate["id"] === row["merchantSubscriptionId"],
      ),
    );
  }
  if (table === schema.subscription && query.with?.["product"]) {
    result["product"] = structuredClone(
      tableRows(schema.products).find((candidate) => candidate["id"] === row["productId"]),
    );
  }
  return result;
}

function queries(table: unknown) {
  return {
    findFirst: async (query: Query) => {
      const row = matchingRows(table, query.where)[0];
      return row ? relatedRow(table, row, query) : undefined;
    },
    findMany: async (query: Query) =>
      matchingRows(table, query.where).map((row) => relatedRow(table, row, query)),
  };
}

const persistence = {
  query: {
    subscription: queries(schema.subscription),
    merchantSubscription: queries(schema.merchantSubscription),
    merchantCustomer: queries(schema.merchantCustomer),
    entitlements: queries(schema.entitlements),
    organizationMemberships: queries(schema.organizationMemberships),
    users: queries(schema.users),
    products: queries(schema.products),
  },
  select: (_selection?: unknown) => ({
    from: (table: unknown) => ({
      where: (where: SQL) => {
        const selected = Promise.resolve(structuredClone(matchingRows(table, where)));
        return Object.assign(selected, { for: (_lock: string) => selected });
      },
    }),
  }),
  update: (table: unknown) => ({
    set: (values: Row) => ({
      where: async (where: SQL) => {
        writes.push({ table, values: structuredClone(values) });
        for (const row of matchingRows(table, where)) Object.assign(row, structuredClone(values));
      },
    }),
  }),
  insert: (table: unknown) => ({
    values: (values: Row) => {
      const existing = tableRows(table).find((row) => row["id"] === values["id"]);
      if (!existing) {
        writes.push({ table, values: structuredClone(values) });
        tableRows(table).push({
          createdAt: new Date(),
          updatedAt: new Date(),
          ...structuredClone(values),
        });
      }
      return Object.assign(Promise.resolve(), {
        onDuplicateKeyUpdate: async (update: { set: Row }) => {
          if (!existing) return;
          // Seat assignment has literal conflict-update values. Lifecycle SQL expressions
          // are deliberately not approximated; no regression enters that distinct path.
          for (const value of Object.values(update.set)) {
            assert.ok(
              !(typeof value === "object" && value !== null && "queryChunks" in value),
              "Fixture must not bypass SQL conflict ordering",
            );
          }
          writes.push({ table, values: structuredClone(update.set) });
          Object.assign(existing, structuredClone(update.set));
        },
      });
    },
  }),
};
const database = {
  ...persistence,
  transaction: async <T>(operation: (transaction: typeof persistence) => Promise<T>): Promise<T> =>
    operation(persistence),
};

type HandlerInput = {
  event: {
    name: string;
    data: { stripeEvent: { id: string; data: { object: { id: string; subscription?: string } } } };
  };
  step: { run: <T>(name: string, operation: () => T | Promise<T>) => Promise<T> };
  logger: { warn: (...values: unknown[]) => void };
};
type Handler = (input: HandlerInput) => Promise<unknown>;
const handlers = new Map<string, Handler>();
let eventCreatedAt = 200;
let providerSnapshot: Row;
let providerReads = 0;
async function getProviderSnapshot() {
  providerReads += 1;
  return structuredClone(providerSnapshot);
}
const provider = { options: { paymentsAdapter: { getSubscription: getProviderSnapshot } } };

mock.module(appModule("db/adapter.ts"), {
  namedExports: {
    getEggheadDatabase: () => database,
    getCourseBuilderAdapter: () => ({
      getUserById: async (id: string) => tableRows(schema.users).find((user) => user["id"] === id),
    }),
  },
});
mock.module(appModule("coursebuilder/stripe-provider.ts"), {
  namedExports: {
    getStripeProvider: () => provider,
    retrieveStripeEventCreatedAt: async () => eventCreatedAt,
    retrieveStripeSubscriptionForLifecycle: getProviderSnapshot,
    stripeMembershipCatalogProvider: {},
  },
});
mock.module(appModule("inngest/client.ts"), {
  namedExports: {
    STRIPE_CUSTOMER_SUBSCRIPTION_DELETED_EVENT: "stripe/customer-subscription-deleted",
    STRIPE_INVOICE_PAID_EVENT: "stripe/invoice-paid",
    inngest: {
      createFunction: (options: { id: string }, _triggers: unknown, handler: Handler) => {
        handlers.set(options.id, handler);
        return { fn: handler };
      },
    },
  },
});
await import(appModule("inngest/stripe-subscription.ts"));
const access: typeof import("../../apps/web/src/subscriptions/access") = await import(
  appModule("subscriptions/access.ts")
);
const team: typeof import("../../apps/web/src/subscriptions/team") = await import(
  appModule("subscriptions/team.ts")
);

function localSubscription(): Row {
  const row = tableRows(schema.subscription)[0];
  assert.ok(row);
  return row;
}

function snapshot(status = "active", invoiceStatus = "paid", seats = 2): Row {
  return {
    id: stripeId,
    status,
    current_period_end: nextEnd.getTime() / 1000,
    cancel_at_period_end: false,
    items: { data: [{ quantity: seats, current_period_end: nextEnd.getTime() / 1000 }] },
    latest_invoice: {
      id: "in_renewal",
      status: invoiceStatus,
      subscription: stripeId,
      lines: {
        data: [
          {
            type: "subscription",
            subscription: stripeId,
            period: { end: nextEnd.getTime() / 1000 },
          },
        ],
        has_more: false,
      },
    },
  };
}

function seedSubscription(kind: "team" | "personal" = "team", seats = 2) {
  tableRows(schema.subscription).push({
    id: subscriptionId,
    merchantSubscriptionId: "merchant-subscription",
    organizationId: "organization",
    productId: "membership-product",
    status: "active",
    fields: {
      ownerId,
      seats,
      subscriptionKind: kind,
      stripeLifecycle: { eventCreatedAt: 100, eventId: "evt_paid", paidThrough: paidEnd.getTime() },
    },
  });
}

function seedGrant(
  userId: string,
  kind: "team" | "personal" = "team",
  revocation: "billing" | "seat_removed" | null = null,
): string {
  const id =
    kind === "team"
      ? access.stripeSubscriptionSeatEntitlementId(stripeId, userId)
      : access.stripeSubscriptionEntitlementId(stripeId);
  tableRows(schema.entitlements).push({
    id,
    entitlementType: "egghead_all_access_subscription",
    sourceType: "stripe_subscription",
    sourceId: subscriptionId,
    organizationId: "organization",
    organizationMembershipId: `membership-${userId}`,
    userId,
    metadata: {
      productId: "membership-product",
      status: revocation ? "unpaid" : "active",
      stripeSubscriptionId: stripeId,
      stripeEventCreatedAt: 100,
      stripeEventKind: "subscription_update",
      ...(kind === "team" ? { teamSeat: true } : {}),
      revocationReason: revocation,
    },
    expiresAt: new Date(paidEnd),
    deletedAt: revocation ? new Date("2030-01-09T00:00:00.000Z") : null,
    createdAt: new Date("2029-12-01T00:00:00.000Z"),
  });
  return id;
}

function grant(id: string): Row {
  const row = tableRows(schema.entitlements).find((candidate) => candidate["id"] === id);
  assert.ok(row, `Expected persisted grant ${id}`);
  return row;
}

async function deliver(
  id = "evt_renewal",
  createdAt = 200,
  name = "stripe/customer-subscription-updated",
) {
  eventCreatedAt = createdAt;
  const handler = handlers.get("egghead-stripe-customer-subscription-updated");
  assert.ok(handler, "The stable lifecycle Inngest function must be registered");
  return handler({
    event: {
      name,
      data: { stripeEvent: { id, data: { object: { id: stripeId, subscription: stripeId } } } },
    },
    step: { run: async (_name, operation) => operation() },
    logger: { warn: () => undefined },
  });
}

function ownerSeatInput() {
  return {
    ownerId,
    seatUserId: ownerId,
    subscriptionId,
    stripeSubscriptionId: stripeId,
    // The published older API accepts these untrusted caller values.
    currentPeriodEnd: nextEnd,
    status: "active",
  };
}

beforeEach(() => {
  resetRuntimeEnvironment();
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date"], now });
  rows.clear();
  writes.length = 0;
  providerReads = 0;
  for (const table of [
    schema.subscription,
    schema.entitlements,
    schema.organizationMemberships,
    schema.users,
    schema.products,
    schema.merchantCustomer,
    schema.merchantSubscription,
  ])
    rows.set(table, []);
  tableRows(schema.merchantSubscription).push({
    id: "merchant-subscription",
    identifier: stripeId,
    merchantCustomerId: "merchant-customer",
  });
  tableRows(schema.merchantCustomer).push({ id: "merchant-customer", userId: ownerId });
  tableRows(schema.products).push({ id: "membership-product", name: "Team membership" });
  for (const userId of [ownerId, "member-a", "member-b", "removed-member"]) {
    tableRows(schema.users).push({ id: userId, email: `${userId}@example.test`, name: userId });
    tableRows(schema.organizationMemberships).push({
      id: `membership-${userId}`,
      organizationId: "organization",
      userId,
    });
  }
  providerSnapshot = snapshot();
});
after(() => mock.timers.reset());

for (const status of ["active", "past_due"]) {
  void test(`${status} with an unpaid invoice cannot extend the subscriber's paid access`, async () => {
    seedSubscription("personal", 1);
    seedGrant(ownerId, "personal");
    providerSnapshot = snapshot(status, "open", 1);
    await deliver();
    assert.equal(providerReads, 1);
    const liveGrants = tableRows(schema.entitlements).filter((row) => row["deletedAt"] === null);
    assert.ok(
      liveGrants.length > 0,
      "Already-paid access remains available until its paid deadline",
    );
    for (const row of liveGrants)
      assert.deepEqual(
        row["expiresAt"],
        paidEnd,
        "An unpaid new period is not a purchased extension",
      );
  });
}

void test("paid personal renewal updates its direct grant instead of creating a second team-seat grant", async () => {
  seedSubscription("personal", 1);
  const id = seedGrant(ownerId, "personal");
  providerSnapshot = snapshot("active", "paid", 1);
  await deliver();
  assert.equal(localSubscription()["status"], "active");
  assert.deepEqual(
    tableRows(schema.entitlements).map((row) => row["id"]),
    [id],
    "Renewal must preserve the subscriber's direct entitlement identity",
  );
  assert.deepEqual(grant(id)["expiresAt"], nextEnd);
});

void test("paid team recovery restores direct seat IDs while deliberately removed seats stay removed", async () => {
  seedSubscription();
  const retained = seedGrant("member-a", "team", "billing");
  const removed = seedGrant("removed-member", "team", "seat_removed");
  const removedAt = grant(removed)["deletedAt"];
  await deliver();
  assert.deepEqual(
    tableRows(schema.entitlements).map((row) => row["id"]),
    [retained, removed],
  );
  assert.ok(
    !tableRows(schema.entitlements).some((row) => row["userId"] === ownerId),
    "A team renewal does not assign its owner a seat",
  );
  assert.deepEqual(
    grant(removed)["deletedAt"],
    removedAt,
    "Recovery must not resurrect a deliberately removed seat",
  );
  assert.equal(
    grant(retained)["deletedAt"],
    null,
    "A paid recovery must restore the retained team seat",
  );
  assert.deepEqual(grant(retained)["expiresAt"], nextEnd);
});

for (const delivery of [
  { label: "older", id: "evt_old", createdAt: 199 },
  { label: "repeated", id: "evt_latest", createdAt: 200 },
]) {
  void test(`${delivery.label} lifecycle delivery cannot rewrite an unclaimed team's newer billing state or capacity`, async () => {
    seedSubscription();
    localSubscription()["status"] = "past_due";
    localSubscription()["fields"] = {
      ...record(localSubscription()["fields"]),
      stripeLifecycle: {
        eventCreatedAt: 200,
        eventId: "evt_latest",
        paidThrough: paidEnd.getTime(),
      },
    };
    providerSnapshot = snapshot("active", "paid", 8);
    await deliver(delivery.id, delivery.createdAt);
    assert.equal(tableRows(schema.entitlements).length, 0, "Unclaimed teams stay unclaimed");
    assert.equal(
      localSubscription()["status"],
      "past_due",
      "Obsolete delivery must not overwrite newer subscription status",
    );
    assert.equal(
      record(localSubscription()["fields"])["seats"],
      2,
      "Obsolete delivery must not rewrite purchased capacity",
    );
    assert.equal(writes.length, 0);
  });
}

void test("terminal cancellation cannot be reopened by a later active provider snapshot", async () => {
  seedSubscription();
  localSubscription()["status"] = "canceled";
  providerSnapshot = snapshot("active", "paid", 8);
  await deliver("evt_after_cancellation", 300);
  assert.equal(providerReads, 1);
  assert.equal(tableRows(schema.entitlements).length, 0);
  assert.equal(
    localSubscription()["status"],
    "canceled",
    "A terminally canceled subscription must not reopen",
  );
  assert.equal(record(localSubscription()["fields"])["seats"], 2);
});

void test("billing-revoked team seats still reserve capacity against another assignment", async () => {
  seedSubscription();
  seedGrant("member-a", "team", "billing");
  seedGrant("member-b", "team", "billing");
  const result = await team.grantTeamSubscriptionSeat(ownerSeatInput());
  assert.equal(
    result.status,
    "full",
    "Temporary billing revocation must not free purchased seats for other users",
  );
  assert.equal(tableRows(schema.entitlements).length, 2);
  const invitation = await team.getTeamInviteDetails(subscriptionId);
  assert.equal(invitation?.availableSeats, 0);
});

void test("removing a billing-revoked seat releases only that seat's reservation", async () => {
  seedSubscription();
  seedGrant("member-a", "team", "billing");
  const removed = seedGrant("member-b", "team", "billing");
  assert.equal(
    (await team.removeTeamSubscriptionSeat({ ownerId, subscriptionId, userId: "member-b" })).status,
    "removed",
  );
  assert.equal((await team.grantTeamSubscriptionSeat(ownerSeatInput())).status, "assigned");
  assert.ok(grant(removed)["deletedAt"] instanceof Date);
  const invitation = await team.getTeamInviteDetails(subscriptionId);
  assert.equal(
    invitation?.availableSeats,
    0,
    "The other billing-revoked member still owns the remaining seat",
  );
});

void test("team assignment uses the stored paid deadline rather than a caller-supplied later period", async () => {
  seedSubscription();
  const result = await team.grantTeamSubscriptionSeat(ownerSeatInput());
  assert.equal(result.status, "assigned");
  const id = access.stripeSubscriptionSeatEntitlementId(stripeId, ownerId);
  assert.equal(grant(id)["deletedAt"], null);
  assert.deepEqual(
    grant(id)["expiresAt"],
    paidEnd,
    "A new seat cannot outlive the subscription's proven paid period",
  );
});

void test("active team status without a proven paid period cannot grant its owner access", async () => {
  seedSubscription();
  localSubscription()["fields"] = { ownerId, seats: 2, subscriptionKind: "team" };
  const result = await team.grantTeamSubscriptionSeat(ownerSeatInput());
  assert.equal(
    result.status,
    "not-found",
    "Provider status and a caller-supplied period are not payment evidence",
  );
  assert.equal(tableRows(schema.entitlements).length, 0);
});

function seedInvitation(
  state: "pending" | "revoked" | "accepted",
  email = "member-a@example.test",
) {
  const createdAt = new Date("2030-01-09T00:00:00.000Z").getTime();
  const payload = {
    invitationId: "invitation-member",
    subscriptionId,
    email,
    expiresAt: createdAt + 7 * 24 * 60 * 60 * 1000,
  };
  localSubscription()["fields"] = {
    ...record(localSubscription()["fields"]),
    teamInvitations: {
      [payload.invitationId]: {
        ...payload,
        createdAt,
        invitedByUserId: ownerId,
        ...(state === "revoked" ? { revokedAt: createdAt + 1000 } : {}),
        ...(state === "accepted"
          ? { acceptedAt: createdAt + 1000, acceptedByUserId: "member-a" }
          : {}),
      },
    },
  };
  return payload;
}

void test("a revoked persisted invitation cannot allocate an otherwise available paid team seat", async () => {
  seedSubscription();
  const invitation = seedInvitation("revoked");
  const input = { ...ownerSeatInput(), seatUserId: "member-a", invitation };
  const result = await team.grantTeamSubscriptionSeat(input);
  assert.equal(
    tableRows(schema.entitlements).length,
    0,
    "Revoking the persisted invitation must prevent allocation even before its token expires",
  );
  assert.equal(result.status, "invalid-invite");
});

void test("a consumed invitation cannot reclaim a deliberately removed team seat", async () => {
  seedSubscription();
  const removed = seedGrant("member-a", "team", "seat_removed");
  const removedAt = grant(removed)["deletedAt"];
  const invitation = seedInvitation("accepted");
  const input = { ...ownerSeatInput(), seatUserId: "member-a", invitation };
  const result = await team.grantTeamSubscriptionSeat(input);
  assert.equal(tableRows(schema.entitlements).length, 1);
  assert.deepEqual(
    grant(removed)["deletedAt"],
    removedAt,
    "Replaying a consumed invitation must not resurrect a removed grant",
  );
  assert.equal(result.status, "invalid-invite");
});

void test("a persisted invitation cannot grant a different authoritative recipient access", async () => {
  seedSubscription();
  const invitation = seedInvitation("pending", "member-a@example.test");
  const input = { ...ownerSeatInput(), seatUserId: "member-b", invitation };
  const result = await team.grantTeamSubscriptionSeat(input);
  assert.equal(
    tableRows(schema.entitlements).length,
    0,
    "Allocation must match the invited email against the persisted actor identity",
  );
  assert.equal(result.status, "invalid-invite");
});
