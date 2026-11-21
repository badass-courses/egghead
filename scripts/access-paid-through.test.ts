import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { ACCESS_ENTITLEMENT_ROWS_SQL } from "../apps/web/src/access/evaluate";
import {
  computeDeltaPlan,
  parseRailsAccessExport,
  simulateApply,
  type CbSnapshot,
  type RailsAccessExport,
} from "../apps/web/src/access/rails-access-delta";
import { compareShadow } from "../apps/web/src/access/rails-access-shadow";
import { subscriptionBoundaryLoss } from "../apps/web/src/access/subscription-boundary-loss";
import { novemberExportText, NOW_ISO } from "./access-delta.fixtures";

const NOW = Date.parse(NOW_ISO);
const EMPTY: CbSnapshot = {
  users: [],
  exportEmailKeys: {},
  entitlements: [],
  memberships: [],
  organizationIds: [],
};
const base = parseRailsAccessExport(novemberExportText());
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing synthetic fixture row");
  return value;
}
const first = required(base.subscriptions[0]);
const member = required(first.members[0]);
const user = required(base.users.find((row) => row.railsUserId === member.railsUserId));

function exported(
  status = "active",
  boundary: string | null = new Date(NOW + 86_400_000).toISOString(),
  seat = true,
  cancel = false,
): RailsAccessExport {
  return {
    ...base,
    users: [user],
    roleGrants: [],
    basicGrants: [],
    purchases: [],
    backingGrants: [],
    proHolders: [],
    subscriptions: [
      {
        ...first,
        status,
        currentPeriodEnd: boundary,
        cancelAtPeriodEnd: cancel,
        members: [{ ...member, hasMemberRole: seat }],
      },
    ],
  };
}
function project(source: RailsAccessExport, snapshot = EMPTY, now = NOW) {
  const plan = computeDeltaPlan(source, snapshot, now);
  return { plan, snapshot: simulateApply(snapshot, plan.ops, new Date(now).toISOString()) };
}
function strictGrant(source: RailsAccessExport, now = NOW) {
  const result = project(source, EMPTY, now);
  return compareShadow(source, result.snapshot, result.plan.identities, now).users.some(
    (row) => row.cbSays["all_access"],
  );
}

for (const [name, status, boundary, seat, cancel, grants] of [
  ["active paid period", "active", NOW + 1, true, false, true],
  ["equality", "active", NOW, true, false, false],
  ["lapsed", "active", NOW - 86_400_000, true, false, false],
  ["cancel at period end", "active", NOW + 1, true, true, true],
  ["cancellation boundary", "active", NOW, true, true, false],
  ["past_due even before boundary", "past_due", NOW + 86_400_000, true, false, false],
  ["trialing", "trialing", NOW + 86_400_000, true, false, false],
  ["unpaid", "unpaid", NOW + 86_400_000, true, false, false],
  ["team without seat", "active", NOW + 86_400_000, false, false, false],
  ["team with seat", "active", NOW + 86_400_000, true, false, true],
] as const) {
  void test(`strict paid-through: ${name}`, () => {
    const source = exported(status, new Date(boundary).toISOString(), seat, cancel);
    assert.equal(strictGrant(source), grants);
    const projected = project(source);
    for (const row of projected.snapshot.entitlements)
      assert.equal(row.expiresAt, source.subscriptions[0]?.currentPeriodEnd);
  });
}

void test("fresh exports retain unpaid facts for loss reporting, not bare-pro fallback grants", () => {
  const sql = readFileSync(new URL("./sql/rails-access-export.sql", import.meta.url), "utf8");
  assert.match(
    sql,
    /reportable_status\(status\) AS\s*\(\s*VALUES \('trialing'\), \('active'\), \('past_due'\), \('unpaid'\)/,
  );
  const source = exported("unpaid");
  const withPro = {
    ...source,
    proHolders: [
      {
        kind: "pro_holder" as const,
        railsUserId: member.railsUserId,
        lastSignInOn: NOW_ISO.slice(0, 10),
      },
    ],
  };
  const result = project(withPro);
  assert.equal(result.plan.barePro.active.length, 0);
  assert.equal(result.snapshot.entitlements.length, 0);
});

void test("missing and malformed paid boundaries never become indefinite grants", () => {
  for (const boundary of [null, "not-a-date"])
    assert.equal(strictGrant(exported("active", boundary)), false);
  assert.throws(() => project(exported("active", "2040-01-01T00:00:00Z")), /TIMESTAMP range/);
});

void test("period ends without Rails refreshing; renewal extends the same rows and replay converges", () => {
  const source = exported();
  const initial = project(source);
  const dayAfterEnd = NOW + 2 * 86_400_000;
  const lapsed = compareShadow(source, initial.snapshot, initial.plan.identities, dayAfterEnd);
  assert.equal(
    lapsed.users.some((row) => row.cbSays["all_access"]),
    false,
  );
  const renewed = exported("active", new Date(NOW + 30 * 86_400_000).toISOString());
  const renewal = project(renewed, initial.snapshot, dayAfterEnd);
  const extensions = renewal.plan.ops.filter((op) => op.kind === "entitlement_extend");
  assert.equal(extensions.length, 2, "organization and personal seat update the same field");
  assert.deepEqual(
    renewal.snapshot.entitlements.map((row) => row.id).toSorted(),
    initial.snapshot.entitlements.map((row) => row.id).toSorted(),
  );
  assert.equal(
    compareShadow(renewed, renewal.snapshot, renewal.plan.identities, dayAfterEnd).users.some(
      (row) => row.cbSays["all_access"],
    ),
    true,
  );
  assert.deepEqual(computeDeltaPlan(renewed, renewal.snapshot, dayAfterEnd).ops, []);
  assert.deepEqual(simulateApply(renewal.snapshot, renewal.plan.ops, NOW_ISO), renewal.snapshot);
});

void test("SQL filters every source by a strictly future expiry, with no source bypass or extra parameter", () => {
  assert.doesNotMatch(ACCESS_ENTITLEMENT_ROWS_SQL, /sourceType\s*=/);
  assert.match(
    ACCESS_ENTITLEMENT_ROWS_SQL,
    /AND\s*\(\s*entitlement\.expiresAt IS NULL\s*OR entitlement\.expiresAt > CURRENT_TIMESTAMP\(3\)\s*\)/,
  );
  assert.equal(ACCESS_ENTITLEMENT_ROWS_SQL.match(/\?/g)?.length, 3);
});

void test("loss report deduplicates org and seat, classifies denials, and excludes holders with another broad grant", () => {
  const initial = project(exported()).snapshot;
  const old: CbSnapshot = {
    ...initial,
    entitlements: initial.entitlements.map((row) => Object.assign({}, row, { expiresAt: null })),
  };
  const cases = [
    ["active", new Date(NOW - 1).toISOString(), true, "boundary_passed"],
    ["past_due", null, true, "status_past_due"],
    ["trialing", null, true, "status_trialing"],
    ["unpaid", null, true, "status_unpaid"],
    ["active", null, true, "missing_boundary"],
    ["active", new Date(NOW + 1000).toISOString(), false, "no_seat"],
  ] as const;
  for (const [status, boundary, seat, reason] of cases) {
    const source = exported(status, boundary, seat);
    const after = project(source, old).snapshot;
    const report = subscriptionBoundaryLoss(source, old, after, NOW);
    assert.equal(report.currentSubscriptionHolders, 1);
    assert.equal(report.losingHolders, 1);
    assert.equal(report.byReason[reason].holders, 1);
    assert.deepEqual(report.byReason[reason].sampleRailsSubscriptionIds, [
      first.railsAccountSubscriptionId,
    ]);
    assert.equal(JSON.stringify(report).includes("@"), false);
    const template = old.entitlements.find((row) => row.userId !== null);
    assert.ok(template);
    for (const entitlementType of [
      "egghead_lifetime_access",
      "egghead_basic_legacy_access",
      "egghead_membership_access",
      "egghead_all_access_subscription",
    ]) {
      const withOther: CbSnapshot = {
        ...after,
        entitlements: [
          ...after.entitlements,
          {
            ...template,
            id: "other",
            sourceType: "rails_gift",
            expiresAt: null,
            deletedAt: null,
            entitlementType,
          },
        ],
      };
      assert.equal(
        subscriptionBoundaryLoss(source, old, withOther, NOW).losingHolders,
        0,
        entitlementType,
      );
    }
    const withCourse = {
      ...after,
      entitlements: [
        ...after.entitlements,
        {
          ...template,
          id: "course",
          sourceType: "rails_sellable_purchase",
          expiresAt: null,
          deletedAt: null,
          entitlementType: "egghead_playlist_access",
        },
      ],
    };
    assert.equal(
      subscriptionBoundaryLoss(source, old, withCourse, NOW).losingHolders,
      1,
      "course access is not a replacement for all access",
    );
  }
});
