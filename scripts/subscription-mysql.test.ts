// Native MySQL evidence for the subscription store: row locks, concurrent
// claims, real rollback, and the query plans of the statements the store sends.
//
// Opt-in, never part of `pnpm check`: it needs a disposable local MySQL 8.
//   SUBSCRIPTION_MYSQL_URL=mysql://root@127.0.0.1:3307/coursebuilder_subscription_test \
//     pnpm subscription:mysql-test
// The URL must pass the local Docker guard and name an existing database ending
// in `_test`. The suite adds the Drizzle schema with a non-forced `drizzle-kit push`
// (it refuses anything that would lose data), inserts rows under a run-unique
// prefix, and briefly enables the server's general log to capture query plans.
// It deletes nothing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const rawUrl = process.env["SUBSCRIPTION_MYSQL_URL"];
if (!rawUrl)
  throw new Error("Set SUBSCRIPTION_MYSQL_URL to a disposable local MySQL *_test database");
const runtime = process.env["EGGHEAD_RUNTIME"];
if (runtime && runtime !== "local")
  throw new Error("The native subscription suite only runs with EGGHEAD_RUNTIME=local");
process.env["EGGHEAD_RUNTIME"] = "local";
process.env["DATABASE_URL"] = rawUrl;
process.env["STRIPE_SECRET_TOKEN"] = "sk_test_synthetic";

const localDocker = await import("../apps/web/src/db/local-docker");
const safety = localDocker.assertLocalDockerDatabaseUrl(rawUrl);
if (!safety.database.endsWith("_test") || !/^[a-z0-9_]+$/.test(safety.database))
  throw new Error("The native subscription suite needs a database named *_test");

const { getEggheadDatabase } = await import("../apps/web/src/db/adapter");
const { createSubscriptionStore } = await import("../apps/web/src/subscriptions/store");
const { subscriptionGrantId } = await import("../apps/web/src/subscriptions/access");
const { normalizeStripeBillingSnapshot } =
  await import("../apps/web/src/subscriptions/stripe-billing");
const lifecycle = await import("../apps/web/src/subscriptions/lifecycle");
type SubscriptionState = z.infer<typeof lifecycle.subscriptionStateSchema>;
type SubscriptionSnapshot = z.infer<typeof lifecycle.subscriptionSnapshotSchema>;

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const PERIOD_END = NOW / 1000 + 30 * 24 * 3600;
const rowsSchema = z.array(z.record(z.string(), z.unknown()));
// Every row this run writes carries RUN, so reruns never collide or clean up.
const RUN = `it${Date.now().toString(36)}`;

function prepareDatabase() {
  const webDir = fileURLToPath(new URL("../apps/web", import.meta.url));
  const push = spawnSync("pnpm", ["exec", "drizzle-kit", "push"], {
    cwd: webDir,
    env: { ...process.env, DATABASE_URL: rawUrl },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  if (push.status !== 0) throw new Error(`drizzle-kit push failed:\n${push.stdout}${push.stderr}`);
}

prepareDatabase();
const pool = localDocker.getEggheadMysqlPool();
const database = getEggheadDatabase();
// The marker seam reads Stripe; these tests own every seeded subscription and
// prove the seam's call shape separately below.
const store = createSubscriptionStore(
  database,
  () => NOW,
  async () => true,
);
const customerFor = (stripeSubscriptionId: string) => stripeSubscriptionId.replace(/^sub_/, "cus_");
/** Reconcile an event the marker routed to CourseBuilder for the seeded customer. */
const reconcileAs = (snapshot: SubscriptionSnapshot) =>
  store.reconcile(snapshot, {
    owner: "cb",
    stripeCustomerId: customerFor(snapshot.stripeSubscriptionId),
  });

async function rows(sql: string, values: unknown[] = []) {
  const [result] = await pool.query(sql, values);
  return rowsSchema.parse(result);
}

let sequence = 0;
type Seeded = { subscriptionId: string; stripeSubscriptionId: string; organizationId: string };

async function seed(input: {
  seats: number;
  assigned: string[];
  kind?: "individual" | "team";
  status?: SubscriptionState["status"];
  organizationId?: string;
}): Promise<Seeded> {
  const n = `${RUN}-${++sequence}`;
  const ids = {
    subscriptionId: `subscription-${n}`,
    stripeSubscriptionId: `sub_${n}`,
    organizationId: input.organizationId ?? `organization-${n}`,
  };
  const ownerId = input.assigned[0] ?? "owner";
  await pool.query(`INSERT IGNORE INTO egghead_Organization (id, name) VALUES (?, ?)`, [
    ids.organizationId,
    `Integration team ${n}`,
  ]);
  await pool.query(
    `INSERT INTO egghead_MerchantCustomer (id, userId, merchantAccountId, identifier) VALUES (?, ?, 'it-account', ?)`,
    [`customer-${n}`, ownerId, `cus_${n}`],
  );
  await pool.query(
    `INSERT INTO egghead_MerchantSubscription (id, merchantAccountId, identifier, merchantCustomerId, merchantProductId) VALUES (?, 'it-account', ?, ?, 'it-product')`,
    [`merchant-subscription-${n}`, ids.stripeSubscriptionId, `customer-${n}`],
  );
  const state: SubscriptionState = {
    ownerId,
    kind: input.kind ?? "team",
    seats: input.seats,
    status: input.status ?? "active",
    currentPeriodEnd: PERIOD_END,
    assignments: input.assigned.map((userId) => ({ userId, assignedAt: NOW - 1000 })),
    revision: null,
    reduction: null,
  };
  await pool.query(
    `INSERT INTO egghead_Subscription (id, organizationId, productId, merchantSubscriptionId, status, fields) VALUES (?, ?, 'it-product', ?, ?, ?)`,
    [
      ids.subscriptionId,
      ids.organizationId,
      `merchant-subscription-${n}`,
      state.status,
      JSON.stringify({
        ownerId,
        seats: state.seats,
        membershipKind: state.kind,
        membershipState: state,
      }),
    ],
  );
  return ids;
}

function billing(
  seeded: Seeded,
  overrides: Partial<Omit<SubscriptionSnapshot, "event">> & {
    event: Partial<SubscriptionSnapshot["event"]> & { id: string; createdAt: number };
  },
): SubscriptionSnapshot {
  const { event, ...rest } = overrides;
  return {
    stripeSubscriptionId: seeded.stripeSubscriptionId,
    status: "active",
    seats: 1,
    currentPeriodEnd: PERIOD_END,
    ...rest,
    event: { observedAt: NOW, kind: "subscription_update", ...event },
  };
}

async function activeGrantUsers(seeded: Seeded) {
  const result = await rows(
    `SELECT userId FROM egghead_Entitlement WHERE sourceType = 'stripe_subscription' AND sourceId = ? AND deletedAt IS NULL ORDER BY userId`,
    [seeded.subscriptionId],
  );
  return result.map((row) => z.string().parse(row["userId"]));
}

async function storedState(seeded: Seeded) {
  const [row] = await rows(`SELECT status, fields FROM egghead_Subscription WHERE id = ?`, [
    seeded.subscriptionId,
  ]);
  const fields = z.object({ membershipState: z.unknown() }).parse(row?.["fields"]);
  return lifecycle.subscriptionStateSchema.parse(fields.membershipState);
}

async function membershipUsers(seeded: Seeded) {
  const result = await rows(
    `SELECT userId FROM egghead_OrganizationMembership WHERE organizationId = ? ORDER BY userId`,
    [seeded.organizationId],
  );
  return result.map((row) => z.string().parse(row["userId"]));
}

async function seedFiller() {
  // Realistic plans need more than a handful of rows; fill the hot tables with
  // unrelated subscriptions so the optimizer has a reason to prefer indexes.
  const filler = 2000;
  const values = (build: (index: number) => unknown[]) =>
    Array.from({ length: filler }, (_, index) => build(index));
  await pool.query(
    `INSERT IGNORE INTO egghead_MerchantSubscription (id, merchantAccountId, identifier, merchantCustomerId, merchantProductId) VALUES ?`,
    [
      values((i) => [
        `filler-ms-${i}`,
        "it-account",
        `sub_filler_${i}`,
        `filler-mc-${i}`,
        "it-product",
      ]),
    ],
  );
  await pool.query(
    `INSERT IGNORE INTO egghead_Subscription (id, organizationId, productId, merchantSubscriptionId) VALUES ?`,
    [values((i) => [`filler-s-${i}`, `filler-org-${i}`, "it-product", `filler-ms-${i}`])],
  );
  await pool.query(
    `INSERT IGNORE INTO egghead_Entitlement (id, entitlementType, userId, organizationId, sourceType, sourceId) VALUES ?`,
    [
      values((i) => [
        `filler-e-${i}`,
        "egghead_all_access_subscription",
        `filler-u-${i}`,
        `filler-org-${i}`,
        "stripe_subscription",
        `filler-s-${i}`,
      ]),
    ],
  );
  await pool.query(
    `INSERT IGNORE INTO egghead_OrganizationMembership (id, organizationId, invitedById, userId) VALUES ?`,
    [values((i) => [`filler-om-${i}`, `filler-org-${i}`, `filler-u-${i}`, `filler-u-${i}`])],
  );
  await pool.query(
    `ANALYZE TABLE egghead_MerchantSubscription, egghead_Subscription, egghead_Entitlement, egghead_OrganizationMembership, egghead_MerchantCustomer`,
  );
}

await seedFiller();

await test("concurrent seat claims on one team never exceed purchased capacity", async () => {
  const seeded = await seed({ seats: 5, assigned: ["owner"] });
  const claimants = Array.from({ length: 12 }, (_, index) => `claimant-${index}`);
  const results = await Promise.all(
    claimants.map((userId) =>
      store.assignSeat({ subscriptionId: seeded.subscriptionId, ownerId: "owner", userId }),
    ),
  );
  const statuses = results.map((result) => result.status);
  assert.equal(statuses.filter((status) => status === "assigned").length, 4);
  assert.equal(statuses.filter((status) => status === "full").length, 8);
  const state = await storedState(seeded);
  assert.equal(state.assignments.length, 5);
  const grants = await activeGrantUsers(seeded);
  assert.deepEqual(grants, state.assignments.map((assignment) => assignment.userId).toSorted());
  assert.deepEqual(await membershipUsers(seeded), grants);
});

await test("a held row lock serializes a removal and a renewal, and the renewal keeps the removal", async () => {
  const seeded = await seed({ seats: 3, assigned: ["owner", "member-a", "member-b"] });
  assert.equal(
    (await reconcileAs(billing(seeded, { seats: 3, event: { id: "evt_seed", createdAt: 100 } })))
      .status,
    "applied",
  );
  assert.deepEqual(await activeGrantUsers(seeded), ["member-a", "member-b", "owner"]);

  const holder = await localDocker.createEggheadMysqlConnection();
  try {
    await holder.query("START TRANSACTION");
    await holder.query("SELECT id FROM egghead_Subscription WHERE id = ? FOR UPDATE", [
      seeded.subscriptionId,
    ]);
    let settled = 0;
    const removal = store
      .removeSeat({ subscriptionId: seeded.subscriptionId, ownerId: "owner", userId: "member-a" })
      .finally(() => settled++);
    const renewal = reconcileAs(
      billing(seeded, {
        seats: 3,
        currentPeriodEnd: PERIOD_END + 3600,
        event: { id: "evt_renewal", createdAt: 200 },
      }),
    ).finally(() => settled++);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(settled, 0, "both writers wait on the subscription row lock");
    await holder.query("COMMIT");
    assert.equal((await removal).status, "removed");
    assert.equal((await renewal).status, "applied");
  } finally {
    await holder.end();
  }
  const state = await storedState(seeded);
  assert.equal(state.currentPeriodEnd, PERIOD_END + 3600);
  assert.deepEqual(await activeGrantUsers(seeded), ["member-b", "owner"]);
});

await test("stale and duplicate Stripe observations leave the committed row untouched", async () => {
  const seeded = await seed({ seats: 5, assigned: ["owner", "member-a"] });
  const newer = billing(seeded, { seats: 5, event: { id: "evt_newer", createdAt: 200 } });
  assert.equal((await reconcileAs(newer)).status, "applied");
  const [committed] = await rows(`SELECT fields FROM egghead_Subscription WHERE id = ?`, [
    seeded.subscriptionId,
  ]);
  const older = billing(seeded, {
    seats: 1,
    status: "unpaid",
    event: { id: "evt_older", createdAt: 100 },
  });
  assert.equal((await reconcileAs(older)).status, "unchanged");
  assert.equal((await reconcileAs(newer)).status, "unchanged");
  const [afterwards] = await rows(`SELECT fields FROM egghead_Subscription WHERE id = ?`, [
    seeded.subscriptionId,
  ]);
  assert.deepEqual(afterwards, committed);
  assert.deepEqual(await activeGrantUsers(seeded), ["member-a", "owner"]);
});

await test("a failure inside the projection rolls back every statement in MySQL and can retry", async () => {
  const seeded = await seed({ seats: 3, assigned: ["owner", "member-a"] });
  assert.equal(
    (await reconcileAs(billing(seeded, { seats: 3, event: { id: "evt_seed", createdAt: 100 } })))
      .status,
    "applied",
  );
  const stateBefore = await storedState(seeded);
  // A real server-side failure on the last projection statement: the membership
  // insert and the grant revocation have already run inside the transaction.
  const trigger = `${RUN}_poison_grant`;
  await pool.query(
    `CREATE TRIGGER ${trigger} BEFORE INSERT ON egghead_Entitlement FOR EACH ROW BEGIN IF NEW.userId = 'poison' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic grant failure'; END IF; END`,
  );
  try {
    await assert.rejects(
      store.assignSeat({
        subscriptionId: seeded.subscriptionId,
        ownerId: "owner",
        userId: "poison",
      }),
      /synthetic grant failure/,
    );
  } finally {
    // Removes only the trigger this run created above.
    await pool.query(`DROP TRIGGER ${trigger}`);
  }
  assert.deepEqual(await storedState(seeded), stateBefore);
  assert.deepEqual(await activeGrantUsers(seeded), ["member-a", "owner"]);
  assert.deepEqual(await membershipUsers(seeded), ["member-a", "owner"]);
  assert.equal(
    (
      await store.assignSeat({
        subscriptionId: seeded.subscriptionId,
        ownerId: "owner",
        userId: "poison",
      })
    ).status,
    "assigned",
  );
  assert.deepEqual(await activeGrantUsers(seeded), ["member-a", "owner", "poison"]);
});

await test("final cancellation is terminal in MySQL even when a later update arrives", async () => {
  const seeded = await seed({ seats: 2, assigned: ["owner", "member-a"] });
  await reconcileAs(billing(seeded, { seats: 2, event: { id: "evt_seed", createdAt: 100 } }));
  const deletion = billing(seeded, {
    seats: 2,
    status: "canceled",
    currentPeriodEnd: null,
    event: { id: "evt_deleted", createdAt: 300, kind: "subscription_deleted" },
  });
  assert.equal((await reconcileAs(deletion)).status, "applied");
  assert.deepEqual(await activeGrantUsers(seeded), []);
  const late = billing(seeded, { seats: 2, event: { id: "evt_late_update", createdAt: 400 } });
  assert.equal((await reconcileAs(late)).status, "unchanged");
  assert.deepEqual(await activeGrantUsers(seeded), []);
  assert.equal((await storedState(seeded)).status, "canceled");
  const [row] = await rows(`SELECT status FROM egghead_Subscription WHERE id = ?`, [
    seeded.subscriptionId,
  ]);
  assert.equal(row?.["status"], "canceled");
});

await test("an owner-planned seat reduction applies on the matching Stripe update and stays applied", async () => {
  const seeded = await seed({ seats: 3, assigned: ["owner", "member-a", "member-b"] });
  await reconcileAs(billing(seeded, { seats: 3, event: { id: "evt_seed", createdAt: 100 } }));
  assert.equal(
    (
      await store.prepareReduction({
        subscriptionId: seeded.subscriptionId,
        ownerId: "owner",
        seats: 2,
        retainedUserIds: ["owner", "member-b"],
      })
    ).status,
    "prepared",
  );
  assert.deepEqual(await activeGrantUsers(seeded), ["member-a", "member-b", "owner"]);
  await reconcileAs(billing(seeded, { seats: 2, event: { id: "evt_reduced", createdAt: 200 } }));
  assert.deepEqual(await activeGrantUsers(seeded), ["member-b", "owner"]);
  await reconcileAs(billing(seeded, { seats: 3, event: { id: "evt_regrown", createdAt: 300 } }));
  assert.deepEqual(await activeGrantUsers(seeded), ["member-b", "owner"]);
});

await test("an unplanned reduction pauses team access until the owner picks who stays", async () => {
  const seeded = await seed({ seats: 3, assigned: ["owner", "member-a", "member-b"] });
  await reconcileAs(billing(seeded, { seats: 3, event: { id: "evt_seed", createdAt: 100 } }));
  await reconcileAs(billing(seeded, { seats: 2, event: { id: "evt_cut", createdAt: 200 } }));
  assert.deepEqual(await activeGrantUsers(seeded), []);
  assert.equal(
    (
      await store.prepareReduction({
        subscriptionId: seeded.subscriptionId,
        ownerId: "owner",
        seats: 2,
        retainedUserIds: ["owner", "member-a"],
      })
    ).status,
    "prepared",
  );
  assert.deepEqual(await activeGrantUsers(seeded), ["member-a", "owner"]);
});

await test("a paused team's owner gets the paused pricing panel, and it clears once they choose", async () => {
  const { getCurrentSubscriptionForUser } = await import("../apps/web/src/subscriptions/status");
  const { getOwnedTeamSubscription } = await import("../apps/web/src/subscriptions/team");
  const { pricingPanel } = await import("../apps/web/src/subscriptions/pricing-state");
  const owner = `paused-owner-${RUN}`;
  await pool.query(`INSERT INTO egghead_User (id, email) VALUES (?, ?)`, [
    owner,
    `${owner}@example.test`,
  ]);
  const seeded = await seed({ seats: 3, assigned: [owner, "paused-a", "paused-b"] });
  await reconcileAs(billing(seeded, { seats: 3, event: { id: "evt_p_seed", createdAt: 100 } }));
  await reconcileAs(billing(seeded, { seats: 2, event: { id: "evt_p_cut", createdAt: 200 } }));
  // The same inputs the /pricing page computes.
  const panelFor = async () => {
    const [current, team] = await Promise.all([
      getCurrentSubscriptionForUser(owner),
      getOwnedTeamSubscription(owner),
    ]);
    return pricingPanel({
      hasCurrentSubscription: Boolean(current),
      optionCount: 1,
      checkoutOpen: true,
      ownedTeamPaused: team !== null && team.id === current?.id && team.capacityReviewRequired,
    });
  };
  assert.equal(await panelFor(), "paused");
  await store.prepareReduction({
    subscriptionId: seeded.subscriptionId,
    ownerId: owner,
    seats: 2,
    retainedUserIds: [owner, "paused-a"],
  });
  assert.equal(await panelFor(), "current");
});

await test("invites to a paused or suspended team say paused, and to an ended one closed", async () => {
  const { getTeamInviteDetails } = await import("../apps/web/src/subscriptions/team");
  const owner = `invite-owner-${RUN}`;
  await pool.query(`INSERT INTO egghead_User (id, email) VALUES (?, ?)`, [
    owner,
    `${owner}@example.test`,
  ]);
  const seeded = await seed({ seats: 3, assigned: [owner, "invite-a", "invite-b"] });
  const inviteState = async () =>
    (await getTeamInviteDetails(seeded.subscriptionId))?.inviteState ?? null;
  await reconcileAs(billing(seeded, { seats: 3, event: { id: "evt_i_seed", createdAt: 100 } }));
  assert.equal(await inviteState(), "full");
  await reconcileAs(billing(seeded, { seats: 2, event: { id: "evt_i_cut", createdAt: 200 } }));
  assert.equal(await inviteState(), "paused", "capacity review");
  await reconcileAs(
    billing(seeded, { seats: 4, status: "unpaid", event: { id: "evt_i_unpaid", createdAt: 300 } }),
  );
  assert.equal(await inviteState(), "paused", "suspended");
  await reconcileAs(billing(seeded, { seats: 4, event: { id: "evt_i_back", createdAt: 400 } }));
  assert.equal(await inviteState(), "open");
  await reconcileAs(
    billing(seeded, {
      seats: 4,
      status: "canceled",
      event: { id: "evt_i_end", createdAt: 500, kind: "subscription_deleted" },
    }),
  );
  assert.equal(await inviteState(), "closed");
});

await test("a legacy row's owner page reads every grant, so it agrees with the seat writer", async () => {
  const { getOwnedTeamSubscription } = await import("../apps/web/src/subscriptions/team");
  const owner = `legacy-owner-${RUN}`;
  await pool.query(`INSERT INTO egghead_User (id, email) VALUES (?, ?)`, [
    owner,
    `${owner}@example.test`,
  ]);
  const seeded = await seed({ seats: 2, assigned: [owner] });
  // A row written before lifecycle state existed: fields only, grants as history.
  await pool.query(
    `UPDATE egghead_Subscription SET fields = JSON_OBJECT('ownerId', ?, 'seats', 2) WHERE id = ?`,
    [owner, seeded.subscriptionId],
  );
  await pool.query(
    `INSERT INTO egghead_OrganizationMembership (id, organizationId, invitedById, userId) VALUES (?, ?, ?, ?)`,
    [`legacy-membership-${RUN}`, seeded.organizationId, owner, owner],
  );
  const expires = "2027-01-01 00:00:00.000";
  const grant = (id: string, userId: string, deletedAt: string | null, status: string) => [
    `${id}-${RUN}`,
    "egghead_all_access_subscription",
    userId,
    seeded.organizationId,
    "stripe_subscription",
    seeded.subscriptionId,
    JSON.stringify({ status }),
    expires,
    deletedAt,
  ];
  // The owner holds a live grant; a member's grant was soft-deleted while billing
  // was suspended, which adoption still counts as assigned. Two seats: full.
  await pool.query(
    `INSERT INTO egghead_Entitlement (id, entitlementType, userId, organizationId, sourceType, sourceId, metadata, expiresAt, deletedAt) VALUES ?`,
    [
      [
        grant("legacy-owner-grant", owner, null, "active"),
        grant(
          "legacy-suspended-grant",
          `legacy-member-${RUN}`,
          "2026-10-01 00:00:00.000",
          "unpaid",
        ),
      ],
    ],
  );
  const page = await getOwnedTeamSubscription(owner);
  assert.equal(page?.id, seeded.subscriptionId);
  assert.equal(page?.availableSeats, 0);
  // Only live grants are listed as members.
  assert.deepEqual(
    page?.members.map((member) => member.userId),
    [owner],
  );
  const attempt = await store.assignSeat({
    subscriptionId: seeded.subscriptionId,
    ownerId: owner,
    userId: `legacy-newcomer-${RUN}`,
  });
  assert.equal(attempt.status, "full");
});

await test("a deleted CB customer's cancellation routes by its recorded marker and revokes grants", async () => {
  const { recordDeletedCustomer, readDeletedCustomerRecord } =
    await import("../apps/web/src/subscriptions/deleted-customers");
  const { decideEventOwnership } = await import("../apps/web/src/subscriptions/ownership-seam");
  const seeded = await seed({
    seats: 2,
    assigned: [`deleted-owner-${RUN}`, `deleted-member-${RUN}`],
  });
  const customer = customerFor(seeded.stripeSubscriptionId);
  await reconcileAs(billing(seeded, { seats: 2, event: { id: "evt_d_seed", createdAt: 100 } }));
  assert.deepEqual(await readDeletedCustomerRecord(customer), { status: "pending" });
  assert.deepEqual(await readDeletedCustomerRecord(`cus_unknown_${RUN}`), {
    status: "no-local-rows",
  });
  const route = (eventCreated: number) =>
    decideEventOwnership(
      {
        eventId: "evt_d_cancel",
        eventCreated,
        stripeCustomerId: customer,
        receivedAt: eventCreated + 5,
      },
      async () => ({ deleted: true }) as const,
    );
  // Before customer.deleted is recorded, routing refuses to guess.
  await assert.rejects(route(300), /not recorded yet/);
  assert.equal(
    await recordDeletedCustomer({
      stripeCustomerId: customer,
      metadata: {
        egghead_owner: "cb",
        egghead_owner_timeline: "cb@0",
        email: "someone@example.test",
      },
    }),
    1,
  );
  // Only the marker keys are kept.
  assert.deepEqual(await readDeletedCustomerRecord(customer), {
    status: "recorded",
    metadata: { egghead_owner: "cb", egghead_owner_timeline: "cb@0" },
  });
  const routed = await route(300);
  assert.equal(routed.stamp.owner, "cb");
  // The final cancellation reconciles and revokes every grant; a later lifecycle
  // write keeps the recorded marker.
  assert.equal(
    (
      await store.reconcile(
        billing(seeded, {
          seats: 2,
          status: "canceled",
          event: { id: "evt_d_cancel", createdAt: 300, kind: "subscription_deleted" },
        }),
        { owner: routed.stamp.owner, stripeCustomerId: routed.stripeCustomerId },
      )
    ).status,
    "applied",
  );
  assert.deepEqual(await activeGrantUsers(seeded), []);
  assert.equal((await readDeletedCustomerRecord(customer)).status, "recorded");
});

await test("a Stripe-shaped subscription decodes and reconciles into MySQL grants", async () => {
  const seeded = await seed({ seats: 1, assigned: ["solo"], kind: "individual" });
  const stripeSubscription = {
    id: seeded.stripeSubscriptionId,
    object: "subscription",
    status: "past_due",
    metadata: { bulk: "false" },
    items: {
      object: "list",
      data: [{ id: "si_it", quantity: 1, current_period_end: PERIOD_END + 60 }],
    },
  };
  const snapshot = normalizeStripeBillingSnapshot(stripeSubscription, {
    id: "evt_stripe_shape",
    createdAt: 500,
    observedAt: NOW,
    kind: "subscription_update",
  });
  assert.equal((await reconcileAs(snapshot)).status, "applied");
  const [grant] = await rows(
    `SELECT id, CAST(expiresAt AS CHAR) AS expiresAt, JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.status')) AS status FROM egghead_Entitlement WHERE sourceId = ? AND deletedAt IS NULL`,
    [seeded.subscriptionId],
  );
  assert.equal(grant?.["id"], subscriptionGrantId(seeded.stripeSubscriptionId, "solo"));
  assert.equal(grant?.["status"], "past_due");
  // Drizzle writes UTC wall-clock text; compare that text so the result does not
  // depend on the server or session time zone.
  assert.equal(
    grant?.["expiresAt"],
    new Date((PERIOD_END + 60) * 1000).toISOString().replace("T", " ").replace("Z", ""),
  );
});

const planSchema = z.object({
  table: z.string().nullable(),
  type: z.string().nullable(),
  key: z.string().nullable(),
  rows: z.union([z.number(), z.string()]).nullable(),
});

await test("commands ask the seam with the row's Stripe identity before taking the row lock", async () => {
  const seeded = await seed({ seats: 3, assigned: ["owner", "member-a"] });
  const asked: unknown[] = [];
  const markerStore = createSubscriptionStore(
    database,
    () => NOW,
    async (query) => {
      asked.push(query);
      // The seam reads Stripe over the network; no row lock may be held meanwhile.
      // NOWAIT fails at once if the store already locked the row.
      const probe = await localDocker.createEggheadMysqlConnection();
      try {
        await probe.query("START TRANSACTION");
        await probe.query("SELECT id FROM egghead_Subscription WHERE id = ? FOR UPDATE NOWAIT", [
          seeded.subscriptionId,
        ]);
        await probe.query("ROLLBACK");
      } finally {
        await probe.end();
      }
      return true;
    },
  );
  const command = { subscriptionId: seeded.subscriptionId, ownerId: "owner", userId: "member-a" };
  assert.equal((await markerStore.removeSeat(command)).status, "removed");
  assert.deepEqual(asked, [
    {
      stripeSubscriptionId: seeded.stripeSubscriptionId,
      stripeCustomerId: customerFor(seeded.stripeSubscriptionId),
      now: NOW,
    },
  ]);
  const refusing = createSubscriptionStore(
    database,
    () => NOW,
    async () => false,
  );
  assert.equal((await refusing.assignSeat({ ...command, userId: "member-b" })).status, "not-found");
  assert.deepEqual(await activeGrantUsers(seeded), ["owner"]);
});

await test("read paths: NULL-expiry seats count, live billing wins, membership alone grants nothing", async () => {
  const { getBillingSubscriptionForUser, getCurrentSubscriptionForUser } =
    await import("../apps/web/src/subscriptions/status");
  // A seat grant without an expiry, for a user who is neither the Stripe customer
  // nor an organization member.
  const seat = await seed({ seats: 3, assigned: ["seat-owner"] });
  await pool.query(
    `INSERT INTO egghead_Entitlement (id, entitlementType, userId, organizationId, sourceType, sourceId, expiresAt) VALUES (?, 'egghead_all_access_subscription', ?, ?, 'stripe_subscription', ?, NULL)`,
    [`grant-${RUN}`, `seat-holder-${RUN}`, seat.organizationId, seat.subscriptionId],
  );
  assert.equal(
    (await getCurrentSubscriptionForUser(`seat-holder-${RUN}`))?.id,
    seat.subscriptionId,
  );

  // An older active subscription and a newer canceled one for the same customer user.
  const billingOwner = `billing-owner-${RUN}`;
  const live = await seed({ seats: 1, assigned: [billingOwner], kind: "individual" });
  const lapsed = await seed({
    seats: 1,
    assigned: [billingOwner],
    kind: "individual",
    status: "canceled",
  });
  await pool.query(`UPDATE egghead_Subscription SET createdAt = ? WHERE id = ?`, [
    "2026-01-01 00:00:00.000",
    live.subscriptionId,
  ]);
  await pool.query(`UPDATE egghead_Subscription SET createdAt = ? WHERE id = ?`, [
    "2026-06-01 00:00:00.000",
    lapsed.subscriptionId,
  ]);
  assert.equal((await getBillingSubscriptionForUser(billingOwner))?.id, live.subscriptionId);

  // Organization membership alone is not a subscription: a member of an org whose
  // individual subscription they hold no grant on reads as having none.
  const orgOnly = await seed({ seats: 1, assigned: [`org-payer-${RUN}`], kind: "individual" });
  await pool.query(`INSERT INTO egghead_User (id, email) VALUES (?, ?)`, [
    `org-member-${RUN}`,
    `org-member-${RUN}@example.test`,
  ]);
  await pool.query(
    `INSERT INTO egghead_OrganizationMembership (id, organizationId, invitedById, userId) VALUES (?, ?, ?, ?)`,
    [`membership-${RUN}`, orgOnly.organizationId, `org-payer-${RUN}`, `org-member-${RUN}`],
  );
  assert.equal(await getCurrentSubscriptionForUser(`org-member-${RUN}`), null);
});

await test("a teammate in the buyer's personal org benefits from the team only, and not while it is paused", async () => {
  const { getCurrentSubscriptionForUser } = await import("../apps/web/src/subscriptions/status");
  const organizationId = `personal-leak-${RUN}`;
  const payer = `leak-payer-${RUN}`;
  const teammate = `leak-teammate-${RUN}`;
  await pool.query(`INSERT INTO egghead_User (id, email) VALUES (?, ?), (?, ?)`, [
    payer,
    `${payer}@example.test`,
    teammate,
    `${teammate}@example.test`,
  ]);
  const individual = await seed({
    seats: 1,
    assigned: [payer],
    kind: "individual",
    organizationId,
  });
  const team = await seed({ seats: 2, assigned: [payer, teammate], organizationId });
  await reconcileAs(billing(individual, { seats: 1, event: { id: "evt_leak_i", createdAt: 100 } }));
  await reconcileAs(billing(team, { seats: 2, event: { id: "evt_leak_t", createdAt: 100 } }));
  assert.equal((await getCurrentSubscriptionForUser(teammate))?.id, team.subscriptionId);
  // An unplanned cut to one seat pauses the team; the teammate has no grant and
  // must not fall back to the payer's individual subscription.
  await reconcileAs(billing(team, { seats: 1, event: { id: "evt_leak_cut", createdAt: 200 } }));
  assert.deepEqual(await activeGrantUsers(team), []);
  assert.equal(await getCurrentSubscriptionForUser(teammate), null);
  // The same holds while the team is suspended.
  await reconcileAs(billing(team, { seats: 2, event: { id: "evt_leak_back", createdAt: 300 } }));
  assert.equal((await getCurrentSubscriptionForUser(teammate))?.id, team.subscriptionId);
  await reconcileAs(
    billing(team, { seats: 2, status: "unpaid", event: { id: "evt_leak_unpaid", createdAt: 400 } }),
  );
  assert.equal(await getCurrentSubscriptionForUser(teammate), null);
  // The payer still has a current subscription through their Stripe customer.
  assert.notEqual(await getCurrentSubscriptionForUser(payer), null);
});

await test("a customer re-keyed while the store waits for the row lock is never written", async () => {
  const seeded = await seed({ seats: 3, assigned: ["owner", "member-a"] });
  const customerRow = `customer-${seeded.subscriptionId.replace("subscription-", "")}`;
  const rekeyDuringLockWait = async (work: () => Promise<unknown>) => {
    const holder = await localDocker.createEggheadMysqlConnection();
    try {
      await holder.query("START TRANSACTION");
      await holder.query("SELECT id FROM egghead_Subscription WHERE id = ? FOR UPDATE", [
        seeded.subscriptionId,
      ]);
      const pending = work();
      // Keep the rejection observed while the holder commits.
      pending.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await holder.query("UPDATE egghead_MerchantCustomer SET identifier = ? WHERE id = ?", [
        `cus_rekeyed_${RUN}_${sequence}`,
        customerRow,
      ]);
      await holder.query("COMMIT");
      return pending;
    } finally {
      await holder.end();
    }
  };
  // The event was routed for the old customer; under the lock the row names another.
  const { SubscriptionDataError } = await import("../apps/web/src/subscriptions/alerts");
  await assert.rejects(
    rekeyDuringLockWait(() =>
      reconcileAs(billing(seeded, { seats: 3, event: { id: "evt_concurrent", createdAt: 100 } })),
    ),
    (error: unknown) =>
      error instanceof SubscriptionDataError && error.code === "customer-mismatch",
  );
  await pool.query("UPDATE egghead_MerchantCustomer SET identifier = ? WHERE id = ?", [
    customerFor(seeded.stripeSubscriptionId),
    customerRow,
  ]);
  // A command whose ownership was asked for the old customer reads as not-found.
  const result = await rekeyDuringLockWait(() =>
    store.removeSeat({
      subscriptionId: seeded.subscriptionId,
      ownerId: "owner",
      userId: "member-a",
    }),
  );
  assert.deepEqual(result, { status: "not-found" });
  // Seeding writes no grants; neither refused write added any.
  assert.deepEqual(await activeGrantUsers(seeded), []);
  const state = await storedState(seeded);
  assert.equal(state.revision, null);
  assert.deepEqual(
    state.assignments.map((assignment) => assignment.userId),
    ["owner", "member-a"],
  );
});

await test("two team subscriptions in one organization share one membership per user", async () => {
  const organizationId = `shared-org-${RUN}`;
  const first = await seed({ seats: 3, assigned: ["owner", "both", "only-first"], organizationId });
  const second = await seed({ seats: 3, assigned: ["owner", "both"], organizationId });
  // The owner already has a membership (as ensurePersonalOrganization writes): reused.
  await pool.query(
    `INSERT INTO egghead_OrganizationMembership (id, organizationId, invitedById, userId) VALUES (?, ?, 'owner', 'owner')`,
    [`existing-owner-${RUN}`, organizationId],
  );
  const initial = (seeded: Seeded) =>
    reconcileAs(
      billing(seeded, { seats: 3, event: { id: `evt_${seeded.subscriptionId}`, createdAt: 100 } }),
    );
  assert.equal((await initial(first)).status, "applied");
  assert.equal((await initial(second)).status, "applied");
  assert.deepEqual(await membershipUsers(first), ["both", "only-first", "owner"]);
  // Both subscriptions' grants point at the same rows; the owner's is the existing one.
  const pointers = await rows(
    `SELECT userId, organizationMembershipId AS membershipId FROM egghead_Entitlement WHERE organizationId = ? AND deletedAt IS NULL ORDER BY userId, sourceId`,
    [organizationId],
  );
  const pointerOf = (userId: string) =>
    new Set(pointers.filter((row) => row["userId"] === userId).map((row) => row["membershipId"]));
  assert.deepEqual(pointerOf("owner"), new Set([`existing-owner-${RUN}`]));
  assert.equal(pointerOf("both").size, 1);
  const remove = (seeded: Seeded, userId: string) =>
    store.removeSeat({ subscriptionId: seeded.subscriptionId, ownerId: "owner", userId });
  // "both" leaves the first team: the second team's live grant still uses the row.
  assert.equal((await remove(first, "both")).status, "removed");
  assert.deepEqual(await membershipUsers(first), ["both", "only-first", "owner"]);
  assert.deepEqual(await activeGrantUsers(second), ["both", "owner"]);
  // "only-first" leaves: no other grant uses that row, so it goes.
  assert.equal((await remove(first, "only-first")).status, "removed");
  assert.deepEqual(await membershipUsers(first), ["both", "owner"]);
  // A renewal of the first team deletes nothing the second uses.
  assert.equal(
    (
      await reconcileAs(
        billing(first, { seats: 3, event: { id: "evt_shared_renewal", createdAt: 200 } }),
      )
    ).status,
    "applied",
  );
  assert.deepEqual(await membershipUsers(second), ["both", "owner"]);
  // "both" leaves the second team too: now unused, the row goes. The owner's never does.
  assert.equal((await remove(second, "both")).status, "removed");
  assert.deepEqual(await membershipUsers(second), ["owner"]);
});

await test("an individual and a team subscription in one personal organization stay independent", async () => {
  const organizationId = `personal-org-${RUN}`;
  const individual = await seed({
    seats: 1,
    assigned: ["payer"],
    kind: "individual",
    organizationId,
  });
  const team = await seed({ seats: 3, assigned: ["payer", "teammate"], organizationId });
  const initial = (seeded: Seeded, seats: number) =>
    reconcileAs(
      billing(seeded, { seats, event: { id: `evt_${seeded.subscriptionId}`, createdAt: 100 } }),
    );
  assert.equal((await initial(individual, 1)).status, "applied");
  assert.equal((await initial(team, 3)).status, "applied");
  assert.equal(
    (
      await store.removeSeat({
        subscriptionId: team.subscriptionId,
        ownerId: "payer",
        userId: "teammate",
      })
    ).status,
    "removed",
  );
  // The individual renewal and the team removal leave each other's rows alone.
  assert.equal(
    (
      await reconcileAs(
        billing(individual, { seats: 1, event: { id: "evt_personal_renewal", createdAt: 200 } }),
      )
    ).status,
    "applied",
  );
  assert.deepEqual(await activeGrantUsers(individual), ["payer"]);
  assert.deepEqual(await activeGrantUsers(team), ["payer"]);
  assert.equal((await membershipUsers(team)).includes("teammate"), false);
  assert.ok((await membershipUsers(team)).includes("payer"));
});

await test("a one-seat team stays a team and a removed member keeps no current subscription", async () => {
  const { getCurrentSubscriptionForUser } = await import("../apps/web/src/subscriptions/status");
  const member = `team-member-${RUN}`;
  const bystander = `bystander-${RUN}`;
  const seeded = await seed({ seats: 2, assigned: [`team-owner-${RUN}`, member] });
  const owner = `team-owner-${RUN}`;
  await pool.query(`INSERT INTO egghead_User (id, email) VALUES (?, ?), (?, ?)`, [
    member,
    `${member}@example.test`,
    bystander,
    `${bystander}@example.test`,
  ]);
  await reconcileAs(billing(seeded, { seats: 2, event: { id: "evt_seed", createdAt: 100 } }));
  assert.deepEqual(await membershipUsers(seeded), [member, owner].toSorted());
  assert.equal((await getCurrentSubscriptionForUser(member))?.id, seeded.subscriptionId);

  // The owner plans one seat for themselves; Stripe confirms one seat.
  assert.equal(
    (
      await store.prepareReduction({
        subscriptionId: seeded.subscriptionId,
        ownerId: owner,
        seats: 1,
        retainedUserIds: [owner],
      })
    ).status,
    "prepared",
  );
  await reconcileAs(billing(seeded, { seats: 1, event: { id: "evt_one", createdAt: 200 } }));
  assert.deepEqual(await membershipUsers(seeded), [owner]);
  assert.equal(await getCurrentSubscriptionForUser(member), null);

  // Any other org member of a one-seat team is not treated as its owner.
  await pool.query(
    `INSERT INTO egghead_OrganizationMembership (id, organizationId, invitedById, userId) VALUES (?, ?, ?, ?)`,
    [`bystander-membership-${RUN}`, seeded.organizationId, owner, bystander],
  );
  assert.equal(await getCurrentSubscriptionForUser(bystander), null);
  assert.equal((await storedState(seeded)).kind, "team");
});

await test("query plans for the statements a reconciliation sends", async () => {
  const seeded = await seed({ seats: 3, assigned: ["owner", "member-a", "member-b"] });
  const [settings] = await rows(
    `SELECT @@GLOBAL.general_log AS enabled, @@GLOBAL.log_output AS output`,
  );
  const [started] = await rows(`SELECT NOW(6) AS at`);
  await pool.query(`SET GLOBAL log_output = 'TABLE'`);
  await pool.query(`SET GLOBAL general_log = 1`);
  try {
    assert.equal(
      (await reconcileAs(billing(seeded, { seats: 3, event: { id: "evt_plan", createdAt: 100 } })))
        .status,
      "applied",
    );
  } finally {
    await pool.query(`SET GLOBAL general_log = ?`, [settings?.["enabled"] ?? 0]);
    await pool.query(`SET GLOBAL log_output = ?`, [settings?.["output"] ?? "FILE"]);
  }
  const logged = await rows(
    `SELECT CONVERT(argument USING utf8mb4) AS statement FROM mysql.general_log WHERE command_type = 'Query' AND event_time >= ? AND (CONVERT(argument USING utf8mb4) LIKE ? OR CONVERT(argument USING utf8mb4) LIKE '%subscription-member:%') ORDER BY event_time`,
    [started?.["at"], `%${seeded.subscriptionId.replace("subscription-", "")}%`],
  );
  const statements = logged
    .map((row) => z.string().parse(row["statement"]))
    .filter((sql) => sql.includes("egghead_") && /^(select|update|insert)/i.test(sql));
  const plans: Array<{
    statement: string;
    summary: string;
    plan: Array<z.infer<typeof planSchema>>;
  }> = [];
  const explainedPlans = await Promise.all(
    statements.map((statement) => rows(`EXPLAIN ${statement}`)),
  );
  statements.forEach((statement, index) => {
    plans.push({
      statement,
      summary: statement.replace(/\s+/g, " ").slice(0, 110),
      plan: (explainedPlans[index] ?? []).map((row) =>
        planSchema.parse({
          table: row["table"] ?? null,
          type: row["type"] ?? null,
          key: row["key"] ?? null,
          rows: row["rows"] ?? null,
        }),
      ),
    });
  });
  for (const { summary, plan } of plans) {
    console.log(`# ${summary}`);
    for (const step of plan)
      console.log(`#   ${step.table} type=${step.type} key=${step.key} rows=${step.rows}`);
  }
  const find = (pattern: RegExp) => {
    const match = plans.find((entry) => pattern.test(entry.statement));
    assert.ok(match, `expected a statement matching ${pattern}`);
    return match.plan;
  };
  // The serialized path: every statement after the lookup is index-anchored.
  assert.deepEqual(
    find(/from `egghead_Subscription` where [\s\S]* for update$/).map((step) => step.key),
    ["PRIMARY"],
  );
  assert.ok(
    find(/^update `egghead_Entitlement`/).every((step) => step.key === "source_idx"),
    "grant revocation uses source_idx",
  );
  assert.ok(
    find(/from `egghead_OrganizationMembership`/).every(
      (step) => step.key === "organizationId_idx",
    ),
    "the locked membership read uses organizationId_idx",
  );
  assert.ok(
    find(/^update `egghead_Subscription`/).every((step) => step.key === "PRIMARY"),
    "state update uses the primary key",
  );
  // Recorded, not asserted: the pre-lock lookup by Stripe subscription ID has no
  // supporting index in the published schema (see tests/behaviors/subscriptions.md).
  const lookup = find(/inner join `egghead_Subscription`/);
  console.log(
    `# pre-lock lookup access types: ${lookup.map((step) => `${step.table}:${step.type}`).join(", ")}`,
  );
});

await test("concurrent writers in one organization all apply: lock conflicts retry", async () => {
  // InnoDB next-key locks on the grant source index deadlock concurrent writers of
  // different subscriptions (MySQL 1213). The store reruns the whole transaction,
  // so neither Inngest nor the owner sees the conflict.
  const organizationId = `deadlock-org-${RUN}`;
  const teams = await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      seed({ seats: 5, assigned: [`dl-owner-${index}`, `dl-member-${index}`], organizationId }),
    ),
  );
  const reconciled = await Promise.all(
    teams.map((seeded) =>
      reconcileAs(
        billing(seeded, {
          seats: 5,
          event: { id: `evt_dl_${seeded.subscriptionId}`, createdAt: 100 },
        }),
      ),
    ),
  );
  assert.deepEqual(
    reconciled.map((result) => result.status),
    ["applied", "applied", "applied", "applied"],
  );
  // Seat commands race each other and a renewal on every team.
  const commands = await Promise.all(
    teams.flatMap((seeded, index) => [
      store.assignSeat({
        subscriptionId: seeded.subscriptionId,
        ownerId: `dl-owner-${index}`,
        userId: `dl-new-${index}`,
      }),
      store.removeSeat({
        subscriptionId: seeded.subscriptionId,
        ownerId: `dl-owner-${index}`,
        userId: `dl-member-${index}`,
      }),
      reconcileAs(
        billing(seeded, {
          seats: 5,
          event: { id: `evt_dl_renew_${seeded.subscriptionId}`, createdAt: 200 },
        }),
      ),
    ]),
  );
  assert.deepEqual(
    commands.map((result) => result.status),
    teams.flatMap(() => ["assigned", "removed", "applied"]),
  );
  const grants = await Promise.all(teams.map((seeded) => activeGrantUsers(seeded)));
  assert.deepEqual(
    grants,
    teams.map((_, index) => [`dl-new-${index}`, `dl-owner-${index}`]),
  );
});

type ExplainedPlans = Array<{ summary: string; plan: Array<z.infer<typeof planSchema>> }>;

function printPlans(label: string, plans: ExplainedPlans) {
  for (const { summary, plan } of plans) {
    console.log(`# read-plan ${label}: ${summary}`);
    for (const step of plan)
      console.log(`#   ${step.table} type=${step.type} key=${step.key} rows=${step.rows}`);
  }
}

/** Full scans of Subscription or MerchantSubscription in a set of plans. */
function subscriptionScans(plans: ExplainedPlans) {
  return plans.flatMap(({ plan }) =>
    plan.filter(
      (step) =>
        (step.table === "egghead_Subscription" || step.table === "egghead_MerchantSubscription") &&
        step.type === "ALL",
    ),
  ).length;
}

await test("query plans for the four read paths: the shipped join indexes remove every scan", async () => {
  const { getBillingSubscriptionForUser, getCurrentSubscriptionForUser } =
    await import("../apps/web/src/subscriptions/status");
  const { getOwnedTeamSubscription, getTeamInviteDetails } =
    await import("../apps/web/src/subscriptions/team");
  const owner = `plan-owner-${RUN}`;
  const member = `plan-member-${RUN}`;
  await pool.query(`INSERT INTO egghead_User (id, email) VALUES (?, ?), (?, ?)`, [
    owner,
    `${owner}@example.test`,
    member,
    `${member}@example.test`,
  ]);
  const seeded = await seed({ seats: 3, assigned: [owner, member] });
  await reconcileAs(billing(seeded, { seats: 3, event: { id: "evt_read_plan", createdAt: 100 } }));
  const [settings] = await rows(
    `SELECT @@GLOBAL.general_log AS enabled, @@GLOBAL.log_output AS output`,
  );
  const [started] = await rows(`SELECT NOW(6) AS at`);
  await pool.query(`SET GLOBAL log_output = 'TABLE'`);
  await pool.query(`SET GLOBAL general_log = 1`);
  try {
    // The page reads, as /pricing, /profile, /team and an invite page run them.
    assert.equal((await getCurrentSubscriptionForUser(member))?.id, seeded.subscriptionId);
    assert.equal((await getBillingSubscriptionForUser(owner))?.id, seeded.subscriptionId);
    assert.equal((await getOwnedTeamSubscription(owner))?.id, seeded.subscriptionId);
    assert.equal((await getTeamInviteDetails(seeded.subscriptionId))?.inviteState, "open");
  } finally {
    await pool.query(`SET GLOBAL general_log = ?`, [settings?.["enabled"] ?? 0]);
    await pool.query(`SET GLOBAL log_output = ?`, [settings?.["output"] ?? "FILE"]);
  }
  const logged = await rows(
    `SELECT CONVERT(argument USING utf8mb4) AS statement FROM mysql.general_log WHERE command_type = 'Query' AND event_time >= ? ORDER BY event_time`,
    [started?.["at"]],
  );
  const statements = logged
    .map((row) => z.string().parse(row["statement"]))
    .filter((sql) => /^select/i.test(sql) && sql.includes("egghead_Subscription"));
  assert.ok(statements.length >= 4, "captured the read paths' subscription queries");
  const explain = async () =>
    Promise.all(
      statements.map(async (statement) => ({
        summary: statement.replace(/\s+/g, " ").slice(0, 90),
        plan: (await rows(`EXPLAIN ${statement}`)).map((row) =>
          planSchema.parse({
            table: row["table"] ?? null,
            type: row["type"] ?? null,
            key: row["key"] ?? null,
            rows: row["rows"] ?? null,
          }),
        ),
      })),
    );
  // `drizzle-kit push` created the lifecycle indexes (`db/lifecycle-indexes.ts`).
  const shipped = await rows(
    `SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName, COLUMN_NAME AS columnName FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME IN ('merchantSubscriptionId_idx', 'merchantCustomerId_idx', 'identifier_idx') AND TABLE_NAME IN ('egghead_Subscription', 'egghead_MerchantSubscription') ORDER BY TABLE_NAME, INDEX_NAME`,
  );
  assert.deepEqual(
    shipped.map((row) => `${String(row["tableName"])}.${String(row["columnName"])}`),
    [
      "egghead_MerchantSubscription.identifier",
      "egghead_MerchantSubscription.merchantCustomerId",
      "egghead_Subscription.merchantSubscriptionId",
    ],
  );
  await pool.query(`ANALYZE TABLE egghead_Subscription, egghead_MerchantSubscription`);
  const after = await explain();
  printPlans("with the lifecycle indexes", after);
  assert.equal(subscriptionScans(after), 0, "no read path scans either table");
  // Without the two read-path indexes (the published schema), the customer branch scans.
  await pool.query(`DROP INDEX merchantSubscriptionId_idx ON egghead_Subscription`);
  await pool.query(`DROP INDEX merchantCustomerId_idx ON egghead_MerchantSubscription`);
  try {
    const before = await explain();
    printPlans("published schema", before);
    console.log(
      `# read-plan Subscription/MerchantSubscription full scans: ${subscriptionScans(before)} without, ${subscriptionScans(after)} with the lifecycle indexes`,
    );
    assert.ok(subscriptionScans(before) > 0, "the published schema scans on the customer branch");
  } finally {
    await pool.query(
      `CREATE INDEX merchantSubscriptionId_idx ON egghead_Subscription (merchantSubscriptionId)`,
    );
    await pool.query(
      `CREATE INDEX merchantCustomerId_idx ON egghead_MerchantSubscription (merchantCustomerId)`,
    );
  }
});

await pool.end();
