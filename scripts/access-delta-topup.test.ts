import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  parseRailsAccessExport,
  partitionBackingGrants,
  type CbSnapshot,
} from "../apps/web/src/access/rails-access-delta";
import { parseOnlyUsers, selectUserOps } from "../apps/web/src/access/rails-access-delta-canary";
import { rowHash } from "../apps/web/src/access/rails-access-delta-rollback";
import { analyze, buildReceipt, defaultGateInputs } from "./access-delta-run";
import { novemberExportText, NOW_ISO, ids } from "./access-delta.fixtures";

const now = Date.parse(NOW_ISO);
const empty: CbSnapshot = {
  users: [],
  entitlements: [],
  memberships: [],
  organizationIds: [],
  exportEmailKeys: {},
};
const base = parseRailsAccessExport(novemberExportText());

for (const [reason, end] of [
  ["cancelled", "2027-01-01"],
  [null, "2026-10-01"],
  ["no_subscription", null],
  [null, null],
] as const) {
  void test(`managed paid-through: ${reason ?? end ?? "missing period"} holds even a recently active pro`, () => {
    const rails = {
      ...base,
      proHolders: base.proHolders.map((holder) => ({ ...holder, lastSignInOn: NOW_ISO })),
      backingGrants: base.backingGrants.map((grant) =>
        grant.source === "managed_subscription"
          ? { ...grant, currentPeriodEnd: end, heldReason: reason }
          : grant,
      ),
    };
    const analysis = analyze(rails, empty, now);
    assert.equal(analysis.plan.heldManagedSubscriptions.length, 1);
    assert.equal(
      analysis.plan.liveBackingGrants.some((grant) => grant.source === "managed_subscription"),
      false,
    );
    assert.equal(
      analysis.plan.ops.some((op) => op.kind === "user_create" && op.railsUserId === "121"),
      false,
    );
    assert.equal(
      analysis.plan.barePro.active.some((holder) => holder.railsUserId === "121"),
      false,
    );
    const context = {
      mode: "dry-run" as const,
      generatedAt: NOW_ISO,
      target: {
        runtime: "local",
        database: "fixture_test",
        hostSha256: "host",
        databaseUserSha256: "user",
      },
      gateInputs: defaultGateInputs(),
      previousBackingCounts: null,
    };
    const receipt = buildReceipt(rails, analysis, context);
    assert.ok(receipt.gate.failures.some((failure) => failure.includes("--accept-stale-managed")));
    const accepted = buildReceipt(rails, analysis, {
      ...context,
      gateInputs: defaultGateInputs({
        acceptStaleManaged: receipt.heldManagedSubscriptions.sha256,
      }),
    });
    assert.equal(
      accepted.gate.failures.some((failure) => failure.includes("--accept-stale-managed")),
      false,
    );
    const userId = ids.user("121");
    const snapshot: CbSnapshot = {
      ...empty,
      users: [
        {
          id: userId,
          email: "held@example.test",
          legacyRailsUserId: "121",
          matchedExportEmails: [],
        },
      ],
      organizationIds: ["held-org"],
      memberships: [
        {
          id: "held-seat",
          organizationId: "held-org",
          userId,
          role: "member",
          fields: {
            source: "rails_account_user",
            legacyRailsUserId: "121",
            hasAccountMemberRole: true,
          },
        },
      ],
      entitlements: [
        {
          id: "held-org-grant",
          entitlementType: "egghead_all_access_subscription",
          userId: null,
          organizationId: "held-org",
          organizationMembershipId: null,
          sourceType: "rails_account_subscription",
          sourceId: "fixture-held-org",
          metadata: {},
          expiresAt: null,
          deletedAt: null,
        },
        {
          id: "held-grant",
          entitlementType: "egghead_all_access_subscription",
          userId,
          organizationId: null,
          organizationMembershipId: null,
          sourceType: "rails_managed_subscription",
          sourceId: "7702:121",
          metadata: { railsUserId: "121" },
          expiresAt: null,
          deletedAt: null,
        },
      ],
    };
    const held = analyze(rails, snapshot, now);
    assert.equal(
      held.plan.ops.some((op) => "entitlementId" in op && op.entitlementId === "held-grant"),
      false,
    );
    assert.ok(held.plan.heldEntitlementIds.has("held-grant"));
    assert.ok(held.plan.heldEntitlementIds.has("held-org-grant"));
    assert.ok(held.plan.heldMembershipIds.has("held-seat"));
    assert.equal(
      held.plan.ops.some(
        (op) => op.kind === "membership_revoke" && op.membershipId === "held-seat",
      ),
      false,
    );
  });
}

void test("managed hold cannot create an identity through a separate playlist purchase", () => {
  const playlist = base.purchases.find(
    (purchase) => purchase.sellableType !== "Resource::Membership",
  );
  assert.ok(playlist);
  const rails = {
    ...base,
    backingGrants: base.backingGrants.map((grant) =>
      grant.source === "managed_subscription"
        ? Object.assign({}, grant, { currentPeriodEnd: null, heldReason: "no_period_end" as const })
        : grant,
    ),
    purchases: [
      ...base.purchases,
      Object.assign({}, playlist, { railsSellablePurchaseId: "99121", railsUserId: "121" }),
    ],
  };
  const analysis = analyze(rails, empty, now);
  assert.equal(analysis.plan.heldManagedSubscriptions.length, 1);
  assert.equal(
    analysis.plan.ops.some((op) => op.kind === "user_create" && op.railsUserId === "121"),
    false,
  );
  assert.equal(
    analysis.plan.ops.some(
      (op) => "entitlement" in op && op.entitlement.metadata["railsUserId"] === "121",
    ),
    false,
  );
});

void test("managed date is inclusive through UTC day, never the legacy grace window", () => {
  const grant = base.backingGrants.find((row) => row.source === "managed_subscription");
  assert.ok(grant);
  const day = NOW_ISO.slice(0, 10);
  assert.equal(
    partitionBackingGrants(
      [{ ...grant, currentPeriodEnd: day }],
      new Set(["121"]),
      Date.parse(`${day}T23:59:59Z`),
    ).live.length,
    1,
  );
  assert.equal(
    partitionBackingGrants(
      [{ ...grant, currentPeriodEnd: "2026-10-31" }],
      new Set(["121"]),
      now,
      999,
    ).heldManaged.length,
    1,
  );
  assert.ok(
    analyze(base, empty, now).plan.ops.some(
      (op) => op.kind === "user_create" && op.railsUserId === "121",
    ),
  );
});

void test("managed SQL keeps invalid backing as a reasoned hold and joins the dated subscription", () => {
  const sql = readFileSync(new URL("./sql/rails-access-export.sql", import.meta.url), "utf8");
  assert.match(sql, /LEFT JOIN subscriptions ls ON ls.id = ms.subscription_id/);
  assert.match(sql, /ls.cancelled_on IS NOT NULL THEN 'cancelled'/);
  assert.match(sql, /ls\."currentPeriodEnd" < current_date THEN 'period_end_stale'/);
  assert.match(sql, /'heldReason', b.held_reason/);
});

void test("canary file and individual op selection do not include unrelated users", () => {
  const selectedIds = parseOnlyUsers("121\n121\n122\n");
  assert.deepEqual(selectedIds, ["121", "122"]);
  assert.throws(() => parseOnlyUsers(""));
  assert.throws(() => parseOnlyUsers("121@example.test"));
  const analysis = analyze(base, empty, now);
  const ops = selectUserOps(analysis.plan.ops, empty, ["121"]);
  assert.equal(ops.length, 2);
  assert.ok(ops.every((op) => op.kind === "user_create" || op.kind === "entitlement_grant"));
});

void test("direct SQL write path has no Auth.js, Inngest, mail or marketing calls", () => {
  for (const file of [
    "../apps/web/src/access/rails-access-delta-store.ts",
    "../apps/web/src/access/rails-access-delta-rollback.ts",
    "../apps/web/src/db/adapter.ts",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /from ["'][^"']*(?:inngest|server\/auth|email-provider|customer-?io|convertkit)[^"']*["']/i,
    );
    assert.doesNotMatch(source, /\b(?:fetch|sendEmail|sendAnEmail|sendServerEmail)\s*\(/);
    assert.doesNotMatch(source, /\binngest\.send\s*\(/);
  }
});

void test("undo hashes cover all fields, normalize key order and change on edits", () => {
  assert.equal(
    rowHash({ a: 1, fields: { b: true, a: "x" } }),
    rowHash({ fields: { a: "x", b: true }, a: 1 }),
  );
  assert.notEqual(rowHash({ updatedAt: "old" }), rowHash({ updatedAt: "new" }));
});
