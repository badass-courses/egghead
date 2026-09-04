#!/usr/bin/env bun
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { getEggheadDatabase } from "../apps/web/src/db/adapter";
import {
  assertCommerceWritesAllowed,
  assertLocalDockerDatabaseUrl,
  createLocalMysqlConnection,
  getEggheadMysqlPool,
} from "../apps/web/src/db/local-docker";
import { getEggheadTableName } from "../apps/web/src/db/mysql-table";
import { merchantSubscription, subscription, users } from "../apps/web/src/db/schema";
import {
  parseStripeSubscriptionSnapshot,
  planStripeSubscriptionTransition,
  stripeSubscriptionEntitlementId,
  stripeSubscriptionSeatEntitlementId,
  subscriptionGrantOccupiesSeat,
  subscriptionPaidThrough,
  subscriptionRecord,
  syncStripeSubscription,
  type StripeSubscriptionSnapshot,
  type SubscriptionGrantState,
} from "../apps/web/src/subscriptions/access";
import {
  grantTeamSubscriptionSeat,
  planTeamSeatGrant,
  removeTeamSubscriptionSeat,
} from "../apps/web/src/subscriptions/team";
import {
  isTeamSubscription,
  mergeTeamSubscriptionFields,
} from "../apps/web/src/subscriptions/team-contracts";
import {
  issueTeamInvitation,
  TEAM_INVITATION_LIFETIME_MS,
} from "../apps/web/src/subscriptions/team-invitation-state";
import type { TeamInvitePayload } from "../apps/web/src/subscriptions/team-invite-token";

const checks: string[] = [];
function check(name: string, run: () => void) {
  run();
  checks.push(name);
}

const stripeId = "sub_lifecycle_synthetic";
const ownerId = "lifecycle-owner";
const subscriptionId = "lifecycle-subscription";
const now = new Date("2030-01-01T00:00:00.000Z");
const firstEnd = new Date("2030-02-01T00:00:00.000Z");
const renewalEnd = new Date("2030-03-01T00:00:00.000Z");
const personalGrant: SubscriptionGrantState = {
  id: stripeSubscriptionEntitlementId(stripeId),
  metadata: { productId: "synthetic-product", invoiceMarker: "preserve" },
  expiresAt: firstEnd,
  deletedAt: null,
};
const snapshot: StripeSubscriptionSnapshot = {
  status: "active",
  seats: 1,
  currentPeriodEnd: firstEnd,
  paidThrough: firstEnd,
  cancelAtPeriodEnd: false,
  invoiceId: "invoice-synthetic",
};
function transition(input: Partial<Parameters<typeof planStripeSubscriptionTransition>[0]> = {}) {
  const result = planStripeSubscriptionTransition({
    fields: { ownerId, seats: 1, subscriptionKind: "personal", preserved: "yes" },
    previousStatus: "active",
    grants: [personalGrant],
    ownerId,
    event: { id: "event-first", createdAt: 100, kind: "subscription_update" },
    snapshot,
    now,
    ...input,
  });
  assert.ok(result);
  return result;
}

check("paid invoice lines and trials are the only new access proof", () => {
  const provider = {
    id: stripeId,
    status: "active",
    current_period_end: firstEnd.getTime() / 1000,
    items: { data: [{ quantity: 1 }] },
    latest_invoice: {
      id: "invoice-synthetic",
      status: "paid",
      subscription: stripeId,
      lines: { data: [{ type: "subscription", period: { end: firstEnd.getTime() / 1000 } }] },
    },
  };
  assert.deepEqual(parseStripeSubscriptionSnapshot(provider, stripeId).paidThrough, firstEnd);
  assert.equal(
    parseStripeSubscriptionSnapshot({ ...provider, latest_invoice: "unexpanded" }, stripeId)
      .paidThrough,
    null,
  );
  assert.equal(
    parseStripeSubscriptionSnapshot({ ...provider, status: "past_due" }, stripeId).paidThrough,
    null,
  );
  assert.equal(
    parseStripeSubscriptionSnapshot(
      { ...provider, latest_invoice: { ...provider.latest_invoice, status: "open" } },
      stripeId,
    ).paidThrough,
    null,
  );
  assert.deepEqual(
    parseStripeSubscriptionSnapshot(
      { ...provider, status: "trialing", trial_end: now.getTime() / 1000 + 3600 },
      stripeId,
    ).paidThrough,
    new Date(now.getTime() + 3600000),
  );
  assert.throws(() => parseStripeSubscriptionSnapshot(provider, "different-subscription"));
});

check("personal renewals keep the stripe_ent identity and unrelated metadata", () => {
  const initial = transition();
  const renewed = transition({
    fields: initial.fields,
    grants: initial.grants,
    snapshot: { ...snapshot, currentPeriodEnd: renewalEnd, paidThrough: renewalEnd },
    event: { id: "event-renewed", createdAt: 101, kind: "subscription_update" },
  });
  assert.equal(renewed.grants[0]?.id, personalGrant.id);
  assert.deepEqual(renewed.grants[0]?.expiresAt, renewalEnd);
  assert.equal(subscriptionRecord(renewed.grants[0]?.metadata)["invoiceMarker"], "preserve");
  assert.equal(subscriptionRecord(renewed.fields)["preserved"], "yes");
});

check("invoice.paid renews personal and team access after draft/open subscription updates", () => {
  for (const subscriptionKind of ["personal", "team"] as const) {
    const seats = subscriptionKind === "team" ? 2 : 1;
    const grant = {
      ...personalGrant,
      id:
        subscriptionKind === "team"
          ? stripeSubscriptionSeatEntitlementId(stripeId, ownerId)
          : personalGrant.id,
    };
    const initial = transition({
      fields: { ownerId, seats, subscriptionKind },
      grants: [grant],
      snapshot: { ...snapshot, seats },
    });
    const renewalProvider = {
      id: stripeId,
      status: "active",
      current_period_end: renewalEnd.getTime() / 1000,
      items: { data: [{ quantity: seats }] },
      latest_invoice: {
        id: "synthetic-renewal-invoice",
        status: "draft",
        subscription: stripeId,
        lines: { data: [{ type: "subscription", period: { end: renewalEnd.getTime() / 1000 } }] },
      },
    };
    const renewalNow = new Date("2030-02-02T00:00:00.000Z");
    for (const invoiceStatus of ["draft", "open"]) {
      const pending = transition({
        fields: initial.fields,
        grants: initial.grants,
        snapshot: parseStripeSubscriptionSnapshot(
          {
            ...renewalProvider,
            latest_invoice: { ...renewalProvider.latest_invoice, status: invoiceStatus },
          },
          stripeId,
        ),
        now: renewalNow,
        event: {
          id: `event-${invoiceStatus}-renewal`,
          createdAt: 200,
          kind: "subscription_update",
        },
      });
      assert.deepEqual(pending.grants[0]?.expiresAt, firstEnd);
      assert.ok(pending.grants[0]?.deletedAt);
      const paidProvider = {
        ...renewalProvider,
        latest_invoice: { ...renewalProvider.latest_invoice, status: "paid" },
      };
      const recovered = transition({
        fields: pending.fields,
        grants: pending.grants,
        snapshot: parseStripeSubscriptionSnapshot(paidProvider, stripeId),
        now: renewalNow,
        event: { id: "event-invoice-paid", createdAt: 200, kind: "invoice_paid" },
      });
      assert.equal(recovered.grants[0]?.id, grant.id);
      assert.equal(recovered.grants[0]?.deletedAt, null);
      assert.deepEqual(recovered.grants[0]?.expiresAt, renewalEnd);
      assert.equal(
        parseStripeSubscriptionSnapshot(
          {
            ...paidProvider,
            latest_invoice: {
              ...paidProvider.latest_invoice,
              subscription: "unassociated-subscription",
            },
          },
          stripeId,
        ).paidThrough,
        null,
      );
    }
  }
});

check("scheduled cancellation retains paid access; effective deletion revokes", () => {
  const scheduled = transition({ snapshot: { ...snapshot, cancelAtPeriodEnd: true } });
  assert.equal(scheduled.grants[0]?.deletedAt, null);
  assert.deepEqual(scheduled.grants[0]?.expiresAt, firstEnd);
  const terminal = transition({
    fields: scheduled.fields,
    grants: scheduled.grants,
    snapshot: {
      ...snapshot,
      status: "canceled",
      currentPeriodEnd: null,
      seats: null,
      paidThrough: null,
    },
    event: { id: "event-deleted", createdAt: 102, kind: "subscription_deleted" },
  });
  assert.equal(terminal.status, "canceled");
  assert.ok(terminal.grants[0]?.deletedAt);
  assert.equal(subscriptionRecord(terminal.grants[0]?.metadata)["revocationReason"], "billing");
  assert.equal(
    planStripeSubscriptionTransition({
      fields: terminal.fields,
      grants: terminal.grants,
      previousStatus: "canceled",
      snapshot,
      ownerId,
      now,
      event: { id: "event-stale-active", createdAt: 103, kind: "subscription_update" },
    }),
    null,
  );
});

check("failed payment cannot extend proof and recovery restores billing revocations only", () => {
  const initial = transition();
  const removed: SubscriptionGrantState = {
    id: stripeSubscriptionSeatEntitlementId(stripeId, "removed-member"),
    deletedAt: now,
    expiresAt: firstEnd,
    metadata: { revocationReason: "seat_removed", invoiceMarker: "preserve" },
  };
  const failed = transition({
    fields: initial.fields,
    grants: [...initial.grants, removed],
    now: new Date("2030-02-02"),
    snapshot: {
      ...snapshot,
      status: "past_due",
      currentPeriodEnd: renewalEnd,
      paidThrough: renewalEnd,
    },
    event: { id: "event-failed", createdAt: 104, kind: "subscription_update" },
  });
  assert.deepEqual(failed.grants[0]?.expiresAt, firstEnd);
  assert.ok(failed.grants[0]?.deletedAt);
  const recovered = transition({
    fields: failed.fields,
    grants: failed.grants,
    snapshot: { ...snapshot, currentPeriodEnd: renewalEnd, paidThrough: renewalEnd },
    event: { id: "event-recovered", createdAt: 105, kind: "subscription_update" },
  });
  assert.equal(recovered.grants[0]?.deletedAt, null);
  assert.deepEqual(recovered.grants[0]?.expiresAt, renewalEnd);
  assert.deepEqual(recovered.grants[1]?.deletedAt, now);
  assert.equal(
    subscriptionRecord(recovered.grants[1]?.metadata)["revocationReason"],
    "seat_removed",
  );
  const noProof = transition({
    snapshot: { ...snapshot, status: "past_due", paidThrough: null, currentPeriodEnd: renewalEnd },
  });
  assert.equal(noProof.grants[0]?.expiresAt?.getTime(), 0);
  assert.ok(noProof.grants[0]?.deletedAt);
});

check("duplicate and older events cannot change fields, grants or empty teams", () => {
  const initial = transition({
    fields: { ownerId, seats: 3, subscriptionKind: "team" },
    grants: [],
    snapshot: { ...snapshot, seats: 3 },
  });
  for (const event of [
    { id: "event-first", createdAt: 100, kind: "subscription_update" as const },
    { id: "older-event", createdAt: 99, kind: "checkout" as const },
  ]) {
    assert.equal(
      planStripeSubscriptionTransition({
        fields: initial.fields,
        previousStatus: "active",
        grants: [],
        ownerId,
        event,
        snapshot: { ...snapshot, status: "past_due", seats: 1 },
        now,
      }),
      null,
    );
  }
  const sameSecond = transition({
    fields: initial.fields,
    grants: [],
    event: { id: "aaa-current-provider-state", createdAt: 100, kind: "subscription_update" },
    snapshot: { ...snapshot, seats: 1 },
  });
  assert.equal(sameSecond.fields.seats, 1);
  assert.equal(sameSecond.fields.subscriptionKind, "team");
  assert.equal(sameSecond.grants.length, 0);
});

check("team renewals preserve stripe_seat identities and shrink quarantines capacity", () => {
  const grants = ["owner", "member"].map((userId) => ({
    metadata: personalGrant.metadata,
    expiresAt: personalGrant.expiresAt,
    deletedAt: personalGrant.deletedAt,
    id: stripeSubscriptionSeatEntitlementId(stripeId, userId),
  }));
  const initial = transition({
    fields: { ownerId, seats: 3, subscriptionKind: "team" },
    grants,
    snapshot: { ...snapshot, seats: 3 },
  });
  const shrunk = transition({
    fields: initial.fields,
    grants: initial.grants,
    snapshot: { ...snapshot, seats: 1, currentPeriodEnd: renewalEnd, paidThrough: renewalEnd },
    event: { id: "event-shrink", createdAt: 101, kind: "subscription_update" },
  });
  assert.deepEqual(
    shrunk.grants.map((grant) => grant.id),
    grants.map((grant) => grant.id),
  );
  assert.ok(
    shrunk.grants.every(
      (grant) => grant.deletedAt === null && grant.expiresAt?.getTime() === renewalEnd.getTime(),
    ),
  );
  assert.equal(shrunk.fields.seats, 1);
  assert.equal(shrunk.quantityReconciliation?.reason, "below_occupied_seats");
  assert.equal(isTeamSubscription(shrunk.fields), true);
  assert.equal(
    isTeamSubscription(mergeTeamSubscriptionFields(shrunk.fields, { ownerId, seats: 4 })),
    true,
  );
  assert.equal(
    isTeamSubscription(
      mergeTeamSubscriptionFields(
        { ownerId, seats: 1, subscriptionKind: "personal" },
        { ownerId, seats: 3 },
      ),
    ),
    false,
  );
});

check("invitation allocation is single-use and capacity failure leaves it unconsumed", () => {
  const initial = transition({
    fields: { ownerId, seats: 2, subscriptionKind: "team" },
    grants: [],
    snapshot: { ...snapshot, seats: 2 },
  });
  const invitation: TeamInvitePayload = {
    invitationId: "invitation-member",
    subscriptionId,
    email: "member@example.invalid",
    expiresAt: now.getTime() + TEAM_INVITATION_LIFETIME_MS,
  };
  const fields = issueTeamInvitation(initial.fields, invitation, ownerId, now.getTime());
  assert.ok(fields);
  const actor = { userId: "member", email: invitation.email };
  const input = {
    fields,
    status: "active",
    subscriptionId,
    ownerId,
    actor,
    grants: [],
    now,
  };
  assert.equal(planTeamSeatGrant(input).status, "invalid-invite");
  assert.equal(
    planTeamSeatGrant({ ...input, invitation, actor: { ...actor, email: "other@example.invalid" } })
      .status,
    "invalid-invite",
  );
  const fullGrants = ["owner", "other"].map((userId) => ({
    id: userId,
    userId,
    metadata: personalGrant.metadata,
    expiresAt: personalGrant.expiresAt,
    deletedAt: personalGrant.deletedAt,
  }));
  assert.equal(planTeamSeatGrant({ ...input, invitation, grants: fullGrants }).status, "full");
  const ready = planTeamSeatGrant({ ...input, invitation });
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("Expected invitation allocation.");
  assert.equal(
    planTeamSeatGrant({ ...input, invitation, fields: ready.fields }).status,
    "invalid-invite",
  );
  assert.equal(
    planTeamSeatGrant({
      ...input,
      actor: { userId: ownerId, email: "owner@example.invalid" },
    }).status,
    "ready",
  );
  assert.equal(
    subscriptionGrantOccupiesSeat({
      ...personalGrant,
      deletedAt: now,
      metadata: { revocationReason: "billing" },
    }),
    true,
  );
  assert.equal(
    subscriptionGrantOccupiesSeat({
      ...personalGrant,
      deletedAt: now,
      metadata: { revocationReason: "seat_removed" },
    }),
    false,
  );
});

async function databaseContract() {
  assertLocalDockerDatabaseUrl();
  assertCommerceWritesAllowed();
  const db = getEggheadDatabase();
  const id = `lifecycle-${randomUUID()}`;
  const owner = `${id}-owner`;
  const candidates = [`${id}-a`, `${id}-b`];
  const fixtureUsers = [owner, ...candidates];
  const providerId = `${id}-provider`;
  const organizationId = `${id}-org`;
  const end = Math.floor(Date.now() / 1000) + 86400;
  const provider = (status = "active", quantity = 2) => ({
    id: providerId,
    status,
    current_period_end: end,
    items: { data: [{ quantity }] },
    latest_invoice: {
      id: `${id}-invoice`,
      status: "paid",
      subscription: providerId,
      lines: { data: [{ type: "subscription", period: { end } }] },
    },
  });
  const connection = await createLocalMysqlConnection();
  try {
    await db
      .insert(users)
      .values(fixtureUsers.map((userId) => ({ id: userId, email: `${userId}@example.invalid` })));
    await db.insert(merchantSubscription).values({
      id,
      identifier: providerId,
      merchantAccountId: `${id}-account`,
      merchantCustomerId: `${id}-customer`,
      merchantProductId: `${id}-product`,
    });
    await db.insert(subscription).values({
      id,
      merchantSubscriptionId: id,
      organizationId,
      productId: `${id}-product`,
      status: "active",
      fields: { ownerId: owner, seats: 2, subscriptionKind: "team" },
    });
    await syncStripeSubscription({
      localSubscriptionId: id,
      stripeSubscriptionId: providerId,
      ownerId: owner,
      event: { id: `${id}-checkout`, createdAt: 1, kind: "checkout" },
      retrieveCurrentSubscription: async () => provider(),
    });
    assert.equal(
      (
        await grantTeamSubscriptionSeat({
          ownerId: owner,
          seatUserId: owner,
          stripeSubscriptionId: providerId,
          subscriptionId: id,
        })
      ).status,
      "assigned",
    );
    const row = await db.query.subscription.findFirst({
      where: (columns, { eq }) => eq(columns.id, id),
    });
    assert.ok(row);
    let fields: Record<string, unknown> = subscriptionRecord(row.fields);
    const issuedAt = Date.now();
    const invitations = candidates.map<TeamInvitePayload>((userId) => ({
      invitationId: `${userId}-invite`,
      subscriptionId: id,
      email: `${userId}@example.invalid`,
      expiresAt: issuedAt + TEAM_INVITATION_LIFETIME_MS,
    }));
    for (const invitation of invitations) {
      const next = issueTeamInvitation(fields, invitation, owner, issuedAt);
      assert.ok(next);
      fields = next;
    }
    await connection.execute(
      `UPDATE ${getEggheadTableName("Subscription")} SET fields = ? WHERE id = ?`,
      [JSON.stringify(fields), id],
    );
    const results = await Promise.all(
      candidates.map((userId, index) => {
        const invitation = invitations[index];
        assert.ok(invitation);
        return grantTeamSubscriptionSeat({
          ownerId: owner,
          seatUserId: userId,
          stripeSubscriptionId: providerId,
          subscriptionId: id,
          invitation,
        });
      }),
    );
    assert.deepEqual(results.map((result) => result.status).toSorted(), ["assigned", "full"]);
    const winnerIndex = results.findIndex((result) => result.status === "assigned");
    const winner = candidates[winnerIndex];
    assert.ok(winner);
    const allGrants = () =>
      db.query.entitlements.findMany({
        where: (columns, { and, eq }) =>
          and(eq(columns.sourceId, id), eq(columns.sourceType, "stripe_subscription")),
      });
    assert.equal((await allGrants()).filter(subscriptionGrantOccupiesSeat).length, 2);
    await syncStripeSubscription({
      localSubscriptionId: id,
      stripeSubscriptionId: providerId,
      ownerId: owner,
      event: { id: `${id}-shrink`, createdAt: 2, kind: "subscription_update" },
      retrieveCurrentSubscription: async () => provider("active", 1),
    });
    const shrunk = await db.query.subscription.findFirst({
      where: (columns, { eq }) => eq(columns.id, id),
    });
    assert.equal(
      subscriptionRecord(subscriptionRecord(shrunk?.fields)["stripeLifecycle"])[
        "quantityReconciliation"
      ] !== null,
      true,
    );
    assert.equal((await allGrants()).filter(subscriptionGrantOccupiesSeat).length, 2);
    await removeTeamSubscriptionSeat({ ownerId: owner, userId: winner, subscriptionId: id });
    const winnerInvitation = invitations[winnerIndex];
    assert.ok(winnerInvitation);
    assert.equal(
      (
        await grantTeamSubscriptionSeat({
          ownerId: owner,
          seatUserId: winner,
          stripeSubscriptionId: providerId,
          subscriptionId: id,
          invitation: winnerInvitation,
        })
      ).status,
      "invalid-invite",
    );
    await syncStripeSubscription({
      localSubscriptionId: id,
      stripeSubscriptionId: providerId,
      ownerId: owner,
      event: { id: `${id}-failed`, createdAt: 3, kind: "subscription_update" },
      retrieveCurrentSubscription: async () => provider("unpaid", 1),
    });
    assert.ok((await allGrants()).every((grant) => grant.deletedAt !== null));
    await syncStripeSubscription({
      localSubscriptionId: id,
      stripeSubscriptionId: providerId,
      ownerId: owner,
      event: { id: `${id}-recovery`, createdAt: 4, kind: "subscription_update" },
      retrieveCurrentSubscription: async () => provider("active", 1),
    });
    const recovered = await allGrants();
    assert.equal(recovered.find((grant) => grant.userId === owner)?.deletedAt, null);
    assert.equal(
      subscriptionRecord(recovered.find((grant) => grant.userId === winner)?.metadata)[
        "revocationReason"
      ],
      "seat_removed",
    );
    await Promise.all(
      [
        { id: `${id}-recovery`, createdAt: 4, kind: "subscription_update" as const },
        { id: `${id}-old`, createdAt: 2, kind: "subscription_update" as const },
      ].map(async (event) => {
        const ignored = await syncStripeSubscription({
          localSubscriptionId: id,
          stripeSubscriptionId: providerId,
          ownerId: owner,
          event,
          retrieveCurrentSubscription: async () => {
            throw new Error("Obsolete event unexpectedly retrieved provider state.");
          },
        });
        assert.equal(ignored.ignored, true);
      }),
    );
    await syncStripeSubscription({
      localSubscriptionId: id,
      stripeSubscriptionId: providerId,
      ownerId: owner,
      event: { id: `${id}-same-second-delete`, createdAt: 4, kind: "subscription_deleted" },
      retrieveCurrentSubscription: async () => ({ id: providerId, status: "canceled" }),
    });
    assert.ok((await allGrants()).every((grant) => grant.deletedAt !== null));
    const deleted = await db.query.subscription.findFirst({
      where: (columns, { eq }) => eq(columns.id, id),
    });
    assert.equal(deleted?.status, "canceled");
    assert.equal(isTeamSubscription(deleted?.fields), true);
    assert.equal(subscriptionPaidThrough(deleted?.fields)?.getTime(), end * 1000);
    checks.push(
      "local database: shared-lock capacity race, atomic invitation replay, shrink, removal/recovery, duplicate/order and terminal convergence",
    );
  } finally {
    try {
      await connection.execute(
        `DELETE FROM ${getEggheadTableName("Entitlement")} WHERE sourceId = ?`,
        [id],
      );
      await connection.execute(
        `DELETE FROM ${getEggheadTableName("OrganizationMembership")} WHERE organizationId = ?`,
        [organizationId],
      );
      await connection.execute(`DELETE FROM ${getEggheadTableName("Subscription")} WHERE id = ?`, [
        id,
      ]);
      await connection.execute(
        `DELETE FROM ${getEggheadTableName("MerchantSubscription")} WHERE id = ?`,
        [id],
      );
      await connection.execute(
        `DELETE FROM ${getEggheadTableName("User")} WHERE id IN (?, ?, ?)`,
        fixtureUsers,
      );
    } finally {
      await Promise.all([connection.end(), getEggheadMysqlPool().end()]);
    }
  }
}

async function main() {
  if (process.argv.includes("--database")) await databaseContract();
  console.log(
    JSON.stringify(
      {
        checks,
        database: process.argv.includes("--database") ? "passed" : "not-run",
        remoteServices: "not-contacted",
      },
      null,
      2,
    ),
  );
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Subscription lifecycle contract failed.");
  process.exitCode = 1;
});
