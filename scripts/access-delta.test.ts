// access-delta tests.
//
// Pure tests always run. The MySQL suite runs when ACCESS_DELTA_MYSQL_URL points
// at a disposable loopback database whose name ends in `_test`; it drops and
// recreates the four tables it uses, so never point it at a shared database.
//
//   ACCESS_DELTA_MYSQL_URL=mysql://user:pass@127.0.0.1:PORT/name_test pnpm access:delta:test

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import {
  emailUniquenessKey,
  mysqlExpiryOrNull,
  parseRailsAccessExport,
  projectionIds,
  railsTimestampToIso,
  RailsExportError,
  type CbSnapshot,
  type DeltaOp,
} from "../apps/web/src/access/rails-access-delta";
import {
  hostSha256,
  newCursor,
  parsePlan,
  planSha256,
  serializePlan,
  type ApplyCursor,
} from "../apps/web/src/access/rails-access-delta-plan";
import { findUserShadow } from "../apps/web/src/access/rails-access-shadow";
import {
  CB_NATIVE_LINK_USER,
  CB_NATIVE_STRIPE_USER,
  FIXTURE_DDL,
  FIXTURE_TABLES,
  ids,
  julyCourseBuilder,
  novemberExportLines,
  novemberExportText,
  NOW_ISO,
  proHolder,
  QUARANTINE_ENTITLEMENT,
  STRIPE_NATIVE_ENTITLEMENT,
} from "./access-delta.fixtures";
import {
  analysisClockMs,
  analyze,
  applyRefusals,
  buildReceipt,
  parseDurationMs,
  type DeltaAnalysis,
} from "./access-delta-run";

const NOW_MS = Date.parse(NOW_ISO);

function julySnapshot(): CbSnapshot {
  const july = julyCourseBuilder();
  const railsExport = parseRailsAccessExport(novemberExportText());
  const railsIds = new Set(railsExport.users.map((user) => user.railsUserId));
  const emails = new Set(railsExport.users.map((user) => emailUniquenessKey(user.email)));
  return {
    // What the store would find: legacy-id matches plus email matches.
    users: july.users
      .map((user) => {
        const legacy = user.fields["legacyRailsUserId"];
        return {
          id: user.id,
          email: user.email,
          legacyRailsUserId: typeof legacy === "string" ? legacy : null,
          matchedExportEmails: [],
        };
      })
      .filter(
        (user) =>
          (user.legacyRailsUserId !== null && railsIds.has(user.legacyRailsUserId)) ||
          emails.has(emailUniquenessKey(user.email)),
      ),
    exportEmailKeys: {},
    entitlements: july.entitlements,
    memberships: july.memberships,
    organizationIds: july.organizations
      .map((org) => org.id)
      .filter((id) =>
        railsExport.subscriptions.some(
          (sub) => sub.railsAccountId && projectionIds.organization(sub.railsAccountId) === id,
        ),
      ),
  };
}

function classCounts(ops: readonly DeltaOp[]) {
  const counts: Record<string, number> = {};
  for (const op of ops) counts[op.kind] = (counts[op.kind] ?? 0) + 1;
  return counts;
}

const EXPECTED_CLASSES = {
  user_create: 5, // 103, 109, 113, 114, 115
  user_link: 1, // 111 -> beta signup
  organization_create: 2, // accounts 7003, 7014
  membership_create: 3, // 8003 (103), 8006 (106), role-only 115 on 7014
  // 9003 org+seat, 9004 seat 106, lifetime 108, purchases 6001 and 6002,
  // basic 114, 9011 org+seat (second sub on 7001), 9014 org+seat (trialing)
  entitlement_grant: 11,
  entitlement_extend: 2, // 9001 org+seat
  entitlement_update: 2, // 9010 org+seat: active -> past_due
  membership_revoke: 2, // 8002 (cancelled), 8007 (removed seat)
  entitlement_revoke: 3, // 9002 org+seat, 9004 seat 107
  entitlement_expire: 1, // purchase 6009 ran out in September
};
const EXPECTED_TOTAL = 32;

/** Export text for these data lines, with a manifest counted from them. */
function exportText(lines: readonly string[], exportedAt = "2026-11-19T11:00:00.000Z") {
  const counts: Record<string, number> = {
    user: 0,
    role_grant: 0,
    basic_grant: 0,
    subscription: 0,
    purchase: 0,
    pro_holder: 0,
  };
  for (const value of lines) {
    const kind = /"kind":"([a-z_]+)"/.exec(value)?.[1];
    if (kind) counts[kind] = (counts[kind] ?? 0) + 1;
  }
  const manifest = JSON.stringify({
    kind: "manifest",
    format: "egghead-rails-access-export/v2",
    exportedAt,
    counts,
  });
  return `${[...lines, manifest].join("\n")}\n`;
}

/** November data lines without the manifest. */
function novemberData() {
  return novemberExportLines().slice(0, -1);
}

/** Append lines to the November export and rewrite its manifest counts. */
function exportWith(extra: readonly string[]) {
  return parseRailsAccessExport(exportText([...novemberData(), ...extra]));
}

/** November export with one user's email changed (Rails-side edit after July). */
function exportWithEmail(railsUserId: string, email: string) {
  const lines = novemberData().map((value) =>
    value.includes(`"railsUserId":"${railsUserId}","email"`)
      ? value.replace(`"u${railsUserId}@example.test"`, JSON.stringify(email))
      : value,
  );
  return parseRailsAccessExport(exportText(lines));
}

function straßeLines() {
  return learnerLines("130", "straße@example.test", "600");
}

/** A Rails user line plus one playlist purchase (granting, not bulk). */
function learnerLines(railsUserId: string, email: string, sellableId: string) {
  return [
    JSON.stringify({
      kind: "user",
      railsUserId,
      email,
      firstName: "Learner",
      lastName: railsUserId,
      avatarUrl: null,
      confirmedAt: null,
      createdAt: "2025-01-01 00:00:00",
      isBanned: false,
      signInCount: 1,
      hasAuthenticationToken: false,
    }),
    JSON.stringify({
      kind: "purchase",
      railsSellablePurchaseId: `60${railsUserId}`,
      railsUserId,
      sellableType: "Playlist",
      sellableId,
      purchaseState: "paid",
      bulk: false,
      restrictedToCountry: null,
      expiresAt: null,
      createdAt: "2026-10-01 00:00:00",
    }),
  ];
}

/** The plan sha a dry run saved in `out`. */
async function planShaIn(out: string) {
  return parsePlan(await readFile(path.join(out, "plan.json"), "utf8")).planSha256;
}

function opFor(ops: readonly DeltaOp[], kind: DeltaOp["kind"], id: string) {
  return ops.find((op) => op.kind === kind && op.key.endsWith(`:${id}`));
}

void describe("export parsing", () => {
  void test("accepts a complete export and reports its sha256", () => {
    const text = novemberExportText();
    const parsed = parseRailsAccessExport(text);
    assert.equal(parsed.users.length, 12);
    assert.equal(parsed.sha256, createHash("sha256").update(text).digest("hex"));
  });

  void test("refuses a truncated export (no manifest)", () => {
    const lines = novemberExportLines();
    assert.throws(() => parseRailsAccessExport(lines.slice(0, -1).join("\n")), RailsExportError);
  });

  void test("refuses an export whose counts disagree with its manifest", () => {
    const lines = novemberExportLines();
    const withoutAPurchase = [...lines.slice(0, -2), lines.at(-1) ?? ""].join("\n");
    assert.throws(
      () => parseRailsAccessExport(withoutAPurchase),
      /manifest says 7 pro_holder lines but the file has 6/,
    );
  });

  void test("refuses data after the manifest and dangling user references", () => {
    const lines = novemberExportLines();
    assert.throws(
      () => parseRailsAccessExport([...lines, lines[0]].join("\n")),
      /after the manifest/,
    );
    const noUser109 = lines.filter((value) => !value.includes('"railsUserId":"109","email"'));
    const manifest = (noUser109.at(-1) ?? "").replace('"user":12', '"user":11');
    assert.throws(
      () => parseRailsAccessExport([...noUser109.slice(0, -1), manifest].join("\n")),
      /Rails user 109 is referenced but has no user line/,
    );
  });

  void test("treats Rails timestamps without an offset as UTC", () => {
    assert.equal(railsTimestampToIso("2026-08-01 00:00:00"), "2026-08-01T00:00:00.000Z");
    assert.equal(railsTimestampToIso("2026-08-01T00:00:00.5"), "2026-08-01T00:00:00.500Z");
    assert.equal(railsTimestampToIso("2026-08-01T00:00:00+02:00"), "2026-07-31T22:00:00.000Z");
    assert.equal(railsTimestampToIso(null), null);
    assert.equal(railsTimestampToIso("2026-12-31T00:00:00Z"), "2026-12-31T00:00:00.000Z");
  });

  void test("expiries past MySQL's 2038 limit mean no expiry, as in July", () => {
    assert.equal(mysqlExpiryOrNull("2099-01-01T00:00:00.000Z"), null);
    assert.equal(mysqlExpiryOrNull("2030-01-01T00:00:00.000Z"), "2030-01-01T00:00:00.000Z");
  });

  void test("ids match the July projection's hashing", () => {
    assert.equal(projectionIds.user("101"), ids.user("101"));
    assert.equal(projectionIds.organization("7001"), ids.org("7001"));
    assert.equal(projectionIds.membership("8001"), ids.membership("8001"));
  });
});

void describe("delta rules (pure, July snapshot vs November export)", () => {
  const railsExport = parseRailsAccessExport(novemberExportText());
  const analysis: DeltaAnalysis = analyze(railsExport, julySnapshot(), NOW_MS);
  const { ops } = analysis.plan;

  void test("change classes match the matrix", () => {
    assert.deepEqual(classCounts(ops), EXPECTED_CLASSES);
  });

  void test("July-written rows for unchanged access produce no ops", () => {
    for (const id of [ids.subOrgEntitlement("9004", "7004"), ids.seatEntitlement("9004", "8005")]) {
      assert.equal(
        ops.some((op) => op.key.endsWith(`:${id}`)),
        false,
        id,
      );
    }
    assert.equal(
      ops.some((op) => op.key.endsWith(`:${ids.membership("8004")}`)),
      false,
    );
  });

  void test("renewed user: period end moved later is an extend", () => {
    const op = opFor(ops, "entitlement_extend", ids.seatEntitlement("9001", "8001"));
    assert.ok(op && op.kind === "entitlement_extend");
    assert.deepEqual(op.reasons, ["current_period_end_later"]);
    assert.equal(op.entitlement.metadata["currentPeriodEnd"], "2026-12-31T00:00:00.000Z");
  });

  void test("lapsed but not cancelled: past_due keeps access with no expiry (ADR-0006)", () => {
    const op = opFor(ops, "entitlement_update", ids.seatEntitlement("9010", "8010"));
    assert.ok(op && op.kind === "entitlement_update");
    assert.deepEqual(op.reasons, ["metadata_status_changed"]);
    assert.equal(op.entitlement.expiresAt, null);
    const shadow = analysis.after.users.find((user) => user.cbUserId === ids.user("110"));
    assert.deepEqual(shadow?.underGrant, []);
    assert.ok(shadow?.cbSays["all_access"]);
  });

  void test("cancelled user and removed seat are revoked; their seat flags are cleared", () => {
    for (const id of [
      ids.subOrgEntitlement("9002", "7002"),
      ids.seatEntitlement("9002", "8002"),
      ids.seatEntitlement("9004", "8007"),
    ]) {
      assert.ok(opFor(ops, "entitlement_revoke", id), id);
    }
    assert.ok(opFor(ops, "membership_revoke", ids.membership("8002")));
    assert.ok(opFor(ops, "membership_revoke", ids.membership("8007")));
  });

  void test("new paying user, team seat, lifetime role and lifetime purchase are granted", () => {
    assert.ok(opFor(ops, "user_create", ids.user("103")));
    assert.ok(opFor(ops, "entitlement_grant", ids.seatEntitlement("9003", "8003")));
    assert.ok(opFor(ops, "entitlement_grant", ids.seatEntitlement("9004", "8006")));
    const lifetime = opFor(
      ops,
      "entitlement_grant",
      ids.roleEntitlement("lifetime_subscriber", "108"),
    );
    assert.ok(lifetime && lifetime.kind === "entitlement_grant");
    assert.equal(lifetime.entitlement.entitlementType, "egghead_lifetime_access");
    const purchase = opFor(ops, "entitlement_grant", ids.purchaseEntitlement("6001"));
    assert.ok(purchase && purchase.kind === "entitlement_grant");
    assert.equal(purchase.entitlement.expiresAt, null);
  });

  void test("a beta signup is linked by email, case-insensitively, not duplicated", () => {
    const link = opFor(ops, "user_link", CB_NATIVE_LINK_USER);
    assert.ok(link && link.kind === "user_link");
    assert.equal(link.railsUserId, "111");
    const grant = opFor(ops, "entitlement_grant", ids.purchaseEntitlement("6002"));
    assert.ok(grant && grant.kind === "entitlement_grant");
    assert.equal(grant.entitlement.userId, CB_NATIVE_LINK_USER);
  });

  void test("CourseBuilder-native and quarantine rows are never touched", () => {
    for (const id of [STRIPE_NATIVE_ENTITLEMENT, QUARANTINE_ENTITLEMENT]) {
      assert.equal(
        ops.some((op) => op.key.endsWith(`:${id}`)),
        false,
        id,
      );
    }
    const native = analysis.after.users.find((user) => user.cbUserId === CB_NATIVE_STRIPE_USER);
    assert.equal(native, undefined, "a user with only CourseBuilder grants is out of shadow scope");
  });

  void test("bulk purchases grant nothing", () => {
    assert.equal(
      ops.some((op) => op.key.endsWith(`:${ids.purchaseEntitlement("6003")}`)),
      false,
    );
    assert.equal(analysis.plan.expected.policy.bulkPlaylistPurchases, 1);
  });

  void test("shadow: before shows the drift, after the simulated apply shows none, and the plan converges", () => {
    assert.equal(analysis.before.summary.underGrantUsers, 7); // 103, 106, 108, 109, 111, 114, 115
    assert.equal(analysis.before.summary.overGrantUsers, 2); // 102, 107
    assert.equal(analysis.after.summary.underGrantUsers, 0);
    assert.equal(analysis.after.summary.overGrantUsers, 0);
    assert.equal(analysis.remainingAfterSimulation, 0);
  });

  void test("receipt: counts per class, at most 20 samples without emails, and a passing gate", () => {
    const receipt = buildReceipt(railsExport, analysis, {
      mode: "dry-run",
      generatedAt: NOW_ISO,
      target: { runtime: "local", host: "127.0.0.1", database: "fixture_test" },
      acceptProGap: null,
      allowLargeRevoke: false,
    });
    assert.equal(receipt.changes.total, EXPECTED_TOTAL);
    assert.equal(receipt.changes.byClass["entitlement_revoke"], 3);
    assert.ok(receipt.samples.length <= 20);
    assert.equal(new Set(receipt.samples.map((sample) => sample["kind"])).size, 10);
    assert.equal(JSON.stringify(receipt).includes("@example.test"), false);
    assert.deepEqual(receipt.gate, { pass: true, failures: [] });
  });

  void test("shadow compare for one user: Rails says X, CourseBuilder says Y", () => {
    const context = {
      railsUserIdByEmailKey: new Map(
        railsExport.users.map((user) => [emailUniquenessKey(user.email), user.railsUserId]),
      ),
      cbUserIdByEmailKey: new Map<string, string>(),
    };
    const before102 = findUserShadow(analysis.before, ids.user("102"), context, emailUniquenessKey);
    assert.deepEqual(before102?.overGrant, ["all_access"]);
    assert.deepEqual(before102?.railsSays, {});
    const before109 = findUserShadow(
      analysis.before,
      "u109@example.test",
      context,
      emailUniquenessKey,
    );
    assert.deepEqual(before109?.underGrant, ["sellable:Playlist:555"]);
    const after109 = findUserShadow(analysis.after, "109", context, emailUniquenessKey);
    assert.deepEqual(after109?.underGrant, []);
  });

  void test("identity conflict: Rails email held by another Rails user's account holds access and fails the gate", () => {
    const snapshot = julySnapshot();
    const conflicted: CbSnapshot = {
      ...snapshot,
      users: [
        ...snapshot.users,
        {
          id: "cb-other",
          email: "u109@example.test",
          legacyRailsUserId: "999",
          matchedExportEmails: [],
        },
      ],
    };
    const conflictAnalysis = analyze(railsExport, conflicted, NOW_MS);
    assert.equal(opFor(conflictAnalysis.plan.ops, "user_create", ids.user("109")), undefined);
    assert.equal(conflictAnalysis.after.summary.missingIdentityUsers, 1);
    const receipt = buildReceipt(railsExport, conflictAnalysis, {
      mode: "dry-run",
      generatedAt: NOW_ISO,
      target: { runtime: "local", host: "127.0.0.1", database: "fixture_test" },
      acceptProGap: null,
      allowLargeRevoke: false,
    });
    assert.equal(receipt.gate.pass, false);
    assert.deepEqual(receipt.identity["unresolved:email_owned_by_other_rails_user"], 1);
  });

  void test("an unresolved Rails user's existing grant is held, not revoked", () => {
    const snapshot = julySnapshot();
    const lines = novemberExportLines().map((value) =>
      value.includes('"railsUserId":"105","email"')
        ? value.replace('"u105@example.test"', '""')
        : value,
    );
    // 105's CB user no longer carries the legacy id (say, edited by hand) and Rails lost the email.
    const unlinked: CbSnapshot = {
      ...snapshot,
      users: snapshot.users.filter((user) => user.id !== ids.user("105")),
    };
    const held = analyze(parseRailsAccessExport(lines.join("\n")), unlinked, NOW_MS);
    assert.equal(
      opFor(held.plan.ops, "entitlement_revoke", ids.seatEntitlement("9004", "8005")),
      undefined,
    );
    assert.equal(held.plan.revokeHeldForIdentity, 1);
    // #7: the seat flag on 8005 is held too; clearing it would cut org-level access.
    assert.equal(opFor(held.plan.ops, "membership_revoke", ids.membership("8005")), undefined);
    assert.equal(held.plan.membershipRevokeHeldForIdentity, 1);
  });

  void test("basic legacy role, trialing subscription and a role-only member are projected", () => {
    const basic = opFor(ops, "entitlement_grant", ids.basicEntitlement("114"));
    assert.ok(basic && basic.kind === "entitlement_grant");
    assert.equal(basic.entitlement.entitlementType, "egghead_basic_legacy_access");
    const roleMember = opFor(ops, "membership_create", ids.roleMembership("7014", "115"));
    assert.ok(roleMember && roleMember.kind === "membership_create");
    assert.equal(roleMember.membership.fields["source"], "rails_scoped_account_role");
    const seat = ops.find(
      (op) =>
        op.kind === "entitlement_grant" &&
        op.entitlement.organizationMembershipId === ids.roleMembership("7014", "115"),
    );
    assert.ok(seat && seat.kind === "entitlement_grant");
    assert.equal(seat.entitlement.metadata["status"], "trialing");
  });

  void test("two enabled subscriptions on one account share one membership", () => {
    assert.ok(opFor(ops, "entitlement_grant", ids.subOrgEntitlement("9011", "7001")));
    assert.ok(opFor(ops, "entitlement_grant", ids.seatEntitlement("9011", "8001")));
    assert.equal(
      ops.some((op) => op.key.endsWith(`:${ids.membership("8001")}`)),
      false,
    );
  });

  void test("a purchase without a sellable is counted, not projected", () => {
    assert.equal(analysis.plan.expected.policy.purchasesWithoutSellable, 1);
  });

  void test("#11: an owned purchase that expired by export time is an expire, not a revoke", () => {
    const op = opFor(ops, "entitlement_expire", ids.purchaseEntitlement("6009"));
    assert.ok(op);
    assert.equal(opFor(ops, "entitlement_revoke", ids.purchaseEntitlement("6009")), undefined);
    assert.equal(analysis.largeRevoke.entitlementRevokes, 3);
    assert.equal(analysis.largeRevoke.revokes, 5, "plus the two seat-flag clears");
  });

  void test("#11: many expired purchases do not trip the revoke alarm", () => {
    const snapshot = julySnapshot();
    const expired = Array.from({ length: 80 }, (_, index) => ({
      id: `eh_entitlement_expired_${index}`,
      entitlementType: "egghead_playlist_access",
      userId: ids.user("101"),
      organizationId: null,
      organizationMembershipId: null,
      sourceType: "rails_sellable_purchase",
      sourceId: `expired-${index}`,
      metadata: { sellableType: "Playlist", sellableId: `8${index}` },
      expiresAt: "2026-10-01T00:00:00.000Z",
      deletedAt: null,
    }));
    const result = analyze(
      railsExport,
      { ...snapshot, entitlements: [...snapshot.entitlements, ...expired] },
      NOW_MS,
    );
    assert.equal(classCounts(result.plan.ops)["entitlement_expire"], 81);
    assert.equal(result.largeRevoke.tripped, false);
  });

  void test("#10: a seat flag on an org that also holds CourseBuilder grants is held and fails the gate", () => {
    const snapshot = julySnapshot();
    const native: CbSnapshot = {
      ...snapshot,
      entitlements: [
        ...snapshot.entitlements,
        {
          id: "stripe_ent_team_7004",
          entitlementType: "egghead_all_access_subscription",
          userId: null,
          organizationId: ids.org("7004"),
          organizationMembershipId: null,
          sourceType: "stripe_subscription",
          sourceId: "local-team-sub",
          metadata: {},
          expiresAt: "2026-12-31T00:00:00.000Z",
          deletedAt: null,
        },
      ],
    };
    const held = analyze(railsExport, native, NOW_MS);
    assert.equal(opFor(held.plan.ops, "membership_revoke", ids.membership("8007")), undefined);
    assert.equal(held.plan.membershipFlagHeldForNativeOrganization, 1);
    const receipt = buildReceipt(railsExport, held, {
      mode: "dry-run",
      generatedAt: NOW_ISO,
      target: { runtime: "local", host: "127.0.0.1", database: "fixture_test" },
      acceptProGap: null,
      allowLargeRevoke: false,
    });
    assert.equal(receipt.policy.membershipFlagHeldForNativeOrganization, 1);
    assert.equal(receipt.gate.pass, false, "107 stays over-granted through the Rails org row");
  });

  void test("#14: losing account_member while staying in account_users is one update, not update plus revoke", () => {
    const lines = novemberExportLines().map((value) =>
      value.includes('"railsAccountSubscriptionId":"9004"')
        ? value.replace(
            '"railsAccountUserId":"8005","railsUserId":"105","hasMemberRole":true',
            '"railsAccountUserId":"8005","railsUserId":"105","hasMemberRole":false',
          )
        : value,
    );
    const result = analyze(parseRailsAccessExport(lines.join("\n")), julySnapshot(), NOW_MS);
    const update = opFor(result.plan.ops, "membership_update", ids.membership("8005"));
    assert.ok(update && update.kind === "membership_update");
    assert.equal(update.membership.fields["hasAccountMemberRole"], false);
    assert.equal(opFor(result.plan.ops, "membership_revoke", ids.membership("8005")), undefined);
    assert.ok(opFor(result.plan.ops, "entitlement_revoke", ids.seatEntitlement("9004", "8005")));
    assert.equal(result.after.summary.overGrantUsers, 0);
  });

  void test("#9: identity pairs emails MySQL's collation calls equal", () => {
    const railsWithStraße = exportWith(straßeLines());
    const snapshot = julySnapshot();
    const paired: CbSnapshot = {
      ...snapshot,
      users: [
        ...snapshot.users,
        {
          id: "cb-strasse",
          email: "strasse@example.test",
          legacyRailsUserId: null,
          matchedExportEmails: ["straße@example.test"],
        },
      ],
    };
    const result = analyze(railsWithStraße, paired, NOW_MS);
    const link = opFor(result.plan.ops, "user_link", "cb-strasse");
    assert.ok(link && link.kind === "user_link");
    assert.equal(link.railsUserId, "130");
    assert.equal(opFor(result.plan.ops, "user_create", ids.user("130")), undefined);
  });

  void test("#12: the analysis clock defaults to the export's exportedAt", () => {
    assert.equal(analysisClockMs(railsExport, null), Date.parse("2026-11-19T11:00:00.000Z"));
    assert.equal(analysisClockMs(railsExport, 5), 5);
  });

  void test("#8: --apply refuses without the reviewed plan sha, on drift, or on a failing gate", () => {
    const sha = planSha256(analysis.plan.ops);
    const exportedAtMs = Date.parse(railsExport.manifest.exportedAt);
    const base = {
      expectPlan: sha,
      reviewedPlan: {
        planSha256: sha,
        exportSha256: railsExport.sha256,
        database: "db_test",
        hostSha256: hostSha256("db.example.test"),
      },
      exportSha256: railsExport.sha256,
      database: "db_test",
      hostSha256: hostSha256("db.example.test"),
      exportedAtMs,
      nowMs: exportedAtMs + 30 * 60_000,
      maxExportAgeMs: 2 * 3_600_000,
      freshPlanSha256: sha,
      gate: { pass: true, failures: [] },
    };
    assert.deepEqual(applyRefusals(base), []);
    assert.match(applyRefusals({ ...base, expectPlan: undefined }).join(), /--expect-plan/);
    assert.match(applyRefusals({ ...base, expectPlan: "other" }).join(), /does not match/);
    assert.match(applyRefusals({ ...base, freshPlanSha256: "drift" }).join(), /changed since/);
    assert.match(
      applyRefusals({ ...base, gate: { pass: false, failures: ["1 users under-granted"] } }).join(),
      /gate: 1 users under-granted/,
    );
    assert.match(applyRefusals({ ...base, database: "other_test" }).join(), /targets db_test/);
  });

  void test("#14: --apply refuses a plan made against another host with the same database name", () => {
    const sha = planSha256(analysis.plan.ops);
    const host = hostSha256("beta.example.test");
    const refusals = applyRefusals({
      expectPlan: sha,
      reviewedPlan: {
        planSha256: sha,
        exportSha256: railsExport.sha256,
        database: "db",
        hostSha256: host,
      },
      exportSha256: railsExport.sha256,
      database: "db",
      hostSha256: hostSha256("production.example.test"),
      exportedAtMs: NOW_MS,
      nowMs: NOW_MS,
      maxExportAgeMs: 3_600_000,
      freshPlanSha256: sha,
      gate: { pass: true, failures: [] },
    });
    assert.deepEqual(refusals, ["the saved plan was computed against a different database host"]);
    assert.notEqual(host, "beta.example.test", "the plan stores a hash, not the host");
  });

  void test("#16: --apply refuses an export older than --max-export-age, or from the future", () => {
    const sha = planSha256(analysis.plan.ops);
    const base = {
      expectPlan: sha,
      reviewedPlan: {
        planSha256: sha,
        exportSha256: railsExport.sha256,
        database: "db",
        hostSha256: "h",
      },
      exportSha256: railsExport.sha256,
      database: "db",
      hostSha256: "h",
      exportedAtMs: NOW_MS,
      maxExportAgeMs: 2 * 3_600_000,
      freshPlanSha256: sha,
      gate: { pass: true, failures: [] },
    };
    assert.deepEqual(applyRefusals({ ...base, nowMs: NOW_MS + 119 * 60_000 }), []);
    assert.match(
      applyRefusals({ ...base, nowMs: NOW_MS + 121 * 60_000 }).join(),
      /121 minutes old, over --max-export-age 120 minutes/,
    );
    assert.match(applyRefusals({ ...base, nowMs: NOW_MS - 3_600_000 }).join(), /in the future/);
    assert.equal(parseDurationMs("2h"), 7_200_000);
    assert.equal(parseDurationMs("90m"), 5_400_000);
    assert.equal(parseDurationMs("soon"), null);
  });

  void test("#8: two Rails users the email collation treats as one are a conflict, not two creates", () => {
    const twins = exportWith([
      ...learnerLines("130", "straße@example.test", "600"),
      ...learnerLines("131", "strasse@example.test", "601"),
    ]);
    // Without the column's weights the JS key misses ß = ss: both would be creates,
    // and the second would collide on apply forever.
    const naive = analyze(twins, julySnapshot(), NOW_MS);
    assert.ok(opFor(naive.plan.ops, "user_create", ids.user("130")));
    assert.ok(opFor(naive.plan.ops, "user_create", ids.user("131")));

    const weighted: CbSnapshot = {
      ...julySnapshot(),
      exportEmailKeys: { "straße@example.test": "AB12", "strasse@example.test": "AB12" },
    };
    const result = analyze(twins, weighted, NOW_MS);
    assert.ok(
      opFor(result.plan.ops, "user_create", ids.user("130")),
      "lower Rails id keeps the email",
    );
    assert.equal(opFor(result.plan.ops, "user_create", ids.user("131")), undefined);
    assert.deepEqual(result.plan.identities.get("131"), {
      kind: "unresolved",
      reason: "duplicate_rails_email",
    });
    const receipt = buildReceipt(twins, result, {
      mode: "dry-run",
      generatedAt: NOW_ISO,
      target: { runtime: "local", host: "127.0.0.1", database: "fixture_test" },
      allowLargeRevoke: false,
      acceptProGap: null,
    });
    assert.equal(receipt.identityConflicts.duplicateEmail, 1);
    assert.equal(receipt.gate.pass, false);
    assert.match(receipt.gate.failures.join(), /1 identity conflicts/);
  });

  void test("#9: a Rails email change after July becomes user_email_update (Rails wins until the flip)", () => {
    const renamed = exportWithEmail("101", "renamed101@example.test");
    const result = analyze(renamed, julySnapshot(), NOW_MS);
    const op = opFor(result.plan.ops, "user_email_update", ids.user("101"));
    assert.ok(op && op.kind === "user_email_update");
    assert.equal(op.email, "renamed101@example.test");
    assert.equal(op.previousEmail, "u101@example.test");
    assert.equal(result.remainingAfterSimulation, 0);
    const receipt = buildReceipt(renamed, result, {
      mode: "dry-run",
      generatedAt: NOW_ISO,
      target: { runtime: "local", host: "127.0.0.1", database: "fixture_test" },
      allowLargeRevoke: false,
      acceptProGap: null,
    });
    assert.equal(receipt.changes.byClass["user_email_update"], 1);
    assert.equal(receipt.identity["matched:email_update"], 1);
    assert.equal(receipt.gate.pass, true);
    assert.doesNotMatch(JSON.stringify(receipt.samples), /renamed101/, "no emails in the receipt");

    // A case-only change is the same email under the collation: no update.
    const recased = analyze(exportWithEmail("101", "U101@Example.test"), julySnapshot(), NOW_MS);
    assert.equal(opFor(recased.plan.ops, "user_email_update", ids.user("101")), undefined);
  });

  void test("#9: an email update onto an address another user holds is held and fails the gate", () => {
    const renamed = exportWithEmail("101", "taken@example.test");
    const snapshot = julySnapshot();
    const taken: CbSnapshot = {
      ...snapshot,
      users: [
        ...snapshot.users,
        {
          id: "cb-taken",
          email: "taken@example.test",
          legacyRailsUserId: null,
          matchedExportEmails: ["taken@example.test"],
        },
      ],
    };
    const result = analyze(renamed, taken, NOW_MS);
    assert.equal(opFor(result.plan.ops, "user_email_update", ids.user("101")), undefined);
    assert.equal(opFor(result.plan.ops, "user_link", "cb-taken"), undefined);
    const receipt = buildReceipt(renamed, result, {
      mode: "dry-run",
      generatedAt: NOW_ISO,
      target: { runtime: "local", host: "127.0.0.1", database: "fixture_test" },
      allowLargeRevoke: false,
      acceptProGap: null,
    });
    assert.equal(receipt.identityConflicts.emailUpdateHeld, 1);
    assert.equal(receipt.identity["matched:email_update_held"], 1);
    assert.equal(receipt.gate.pass, false);
    assert.equal(result.after.summary.underGrantUsers, 0, "101 keeps access by legacy id");
  });

  void test("#2/#10: the export is cross-checked against Rails' own pro holders", () => {
    const context = {
      mode: "dry-run" as const,
      generatedAt: NOW_ISO,
      target: { runtime: "local", host: "127.0.0.1", database: "fixture_test" },
      allowLargeRevoke: false,
    };
    const clean = buildReceipt(railsExport, analysis, { ...context, acceptProGap: null });
    assert.equal(clean.proCrossCheck.railsHasExportLacks, 0);
    assert.equal(clean.proCrossCheck.exportHasRailsLacks, 0);
    assert.equal(clean.proCrossCheck.railsProHolders, 7);

    // Two pro holders the export grants nothing: one an active gift, one bare pro.
    const gap = exportWith([
      JSON.stringify(proHolder("120", { gift: true })),
      JSON.stringify(proHolder("121")),
    ]);
    const gapAnalysis = analyze(gap, julySnapshot(), NOW_MS);
    const failing = buildReceipt(gap, gapAnalysis, { ...context, acceptProGap: null });
    assert.equal(failing.proCrossCheck.railsHasExportLacks, 2);
    assert.deepEqual(failing.proCrossCheck.railsHasExportLacksBy, {
      activeGift: 1,
      activeManagedSubscription: 0,
      activeLegacySubscription: 0,
      unexplained: 1,
    });
    assert.deepEqual(failing.proCrossCheck.railsHasExportLacksSample, ["120", "121"]);
    assert.equal(failing.gate.pass, false);
    assert.match(failing.gate.failures.join(), /2 Rails pro holders/);
    assert.equal(buildReceipt(gap, gapAnalysis, { ...context, acceptProGap: 2 }).gate.pass, true);
    assert.equal(buildReceipt(gap, gapAnalysis, { ...context, acceptProGap: 1 }).gate.pass, false);

    // The export grants 101, Rails has not given 101 pro yet: reported, not fatal.
    const lag = parseRailsAccessExport(
      exportText(novemberData().filter((value) => value !== JSON.stringify(proHolder("101")))),
    );
    const lagReceipt = buildReceipt(lag, analyze(lag, julySnapshot(), NOW_MS), {
      ...context,
      acceptProGap: null,
    });
    assert.equal(lagReceipt.proCrossCheck.exportHasRailsLacks, 1);
    assert.deepEqual(lagReceipt.proCrossCheck.exportHasRailsLacksSample, ["101"]);
    assert.equal(lagReceipt.gate.pass, true);
  });

  void test("#17: seat-flag clears count toward the revoke alarm", () => {
    const snapshot = julySnapshot();
    const template = snapshot.memberships.find((row) => row.id === ids.membership("8002"));
    assert.ok(template);
    const extra = Array.from({ length: 60 }, (_, index) => ({
      ...template,
      id: `eh_orgmem_stale_${index}`,
      userId: `eh_user_stale_${index}`,
      fields: { ...template.fields, legacyRailsUserId: `9${index}` },
    }));
    const result = analyze(
      railsExport,
      { ...snapshot, memberships: [...snapshot.memberships, ...extra] },
      NOW_MS,
    );
    assert.equal(result.largeRevoke.membershipRevokes, 62);
    assert.equal(result.largeRevoke.entitlementRevokes, 3);
    assert.equal(result.largeRevoke.revokes, 65);
    assert.equal(result.largeRevoke.tripped, true);
  });

  void test("a large revoke trips the alarm and blocks the gate until allowed", () => {
    const snapshot = julySnapshot();
    const extra = Array.from({ length: 60 }, (_, index) => ({
      id: `eh_entitlement_stale_${index}`,
      entitlementType: "egghead_playlist_access",
      userId: ids.user("101"),
      organizationId: null,
      organizationMembershipId: null,
      sourceType: "rails_sellable_purchase",
      sourceId: `stale-${index}`,
      metadata: { sellableType: "Playlist", sellableId: `9${index}` },
      expiresAt: null,
      deletedAt: null,
    }));
    const stale = analyze(
      railsExport,
      { ...snapshot, entitlements: [...snapshot.entitlements, ...extra] },
      NOW_MS,
    );
    assert.equal(stale.largeRevoke.tripped, true);
    const context = {
      mode: "dry-run" as const,
      generatedAt: NOW_ISO,
      target: { runtime: "local", host: "127.0.0.1", database: "fixture_test" },
      acceptProGap: null,
    };
    assert.equal(
      buildReceipt(railsExport, stale, { ...context, allowLargeRevoke: false }).gate.pass,
      false,
    );
    assert.equal(
      buildReceipt(railsExport, stale, { ...context, allowLargeRevoke: true }).gate.pass,
      true,
    );
  });

  void test("a soft-deleted row Rails grants again is restored as a grant", () => {
    const snapshot = julySnapshot();
    const seat = ids.seatEntitlement("9004", "8005");
    const original = snapshot.entitlements.find((row) => row.id === seat);
    assert.ok(original);
    const revoked: CbSnapshot = {
      ...snapshot,
      entitlements: [
        ...snapshot.entitlements.filter((row) => row.id !== seat),
        { ...original, deletedAt: "2026-09-01T00:00:00.000Z" },
      ],
    };
    const restored = analyze(railsExport, revoked, NOW_MS);
    const op = opFor(restored.plan.ops, "entitlement_grant", seat);
    assert.ok(op && op.kind === "entitlement_grant");
    assert.deepEqual(op.reasons, ["restored"]);
    assert.equal(restored.after.summary.underGrantUsers, 0);
  });

  void test("plan files round-trip and refuse tampering", () => {
    const text = serializePlan({
      exportSha256: railsExport.sha256,
      database: "fixture_test",
      hostSha256: hostSha256("127.0.0.1"),
      generatedAt: NOW_ISO,
      ops,
    });
    assert.equal(parsePlan(text).ops.length, ops.length);
    const tampered = JSON.parse(text);
    tampered.ops.pop();
    assert.throws(() => parsePlan(JSON.stringify(tampered)), /planSha256/);
  });
});

// ---------------------------------------------------------------------------
// MySQL fixture

const mysqlUrl = process.env["ACCESS_DELTA_MYSQL_URL"];

void describe(
  "MySQL fixture: dry run, apply, idempotent re-run, resume",
  { skip: mysqlUrl ? false : "set ACCESS_DELTA_MYSQL_URL" },
  () => {
    type Store = typeof import("../apps/web/src/access/rails-access-delta-store");
    type Run = typeof import("./access-delta-run");
    type Adapter = typeof import("../apps/web/src/db/adapter");
    type Docker = typeof import("../apps/web/src/db/local-docker");
    type Evaluate = typeof import("../apps/web/src/access/evaluate");
    let store: Store;
    let run: Run;
    let db: ReturnType<Adapter["getEggheadDatabase"]>;
    let docker: Docker;
    let evaluate: Evaluate;
    const railsExport = parseRailsAccessExport(novemberExportText());
    const now = () => new Date(NOW_MS);
    // Tiny pages and chunks so keyset paging and chunked lookups really run.
    const SMALL = { pageSize: 3, chunkSize: 2, concurrency: 4, consistent: true };

    async function query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
      const [rows] = await docker.getEggheadMysqlPool().query(sql, params);
      if (!Array.isArray(rows)) return []; // INSERT/UPDATE return a result header
      const list: unknown[] = rows;
      return list.filter(
        (row): row is Record<string, unknown> =>
          typeof row === "object" && row !== null && !Array.isArray(row),
      );
    }

    async function resetToJuly() {
      const pool = docker.getEggheadMysqlPool();
      // No foreign keys join these tables, so each step can run in parallel.
      await Promise.all(
        FIXTURE_TABLES.map((table) => pool.query(`DROP TABLE IF EXISTS \`${table}\``)),
      );
      await Promise.all(FIXTURE_DDL.map((ddl) => pool.query(ddl)));
      const july = julyCourseBuilder();
      await Promise.all([
        ...july.users.map((user) =>
          pool.query(
            "INSERT INTO egghead_User (id, email, name, role, fields) VALUES (?, ?, ?, ?, ?)",
            [user.id, user.email, user.name, user.role, JSON.stringify(user.fields)],
          ),
        ),
        ...july.organizations.map((org) =>
          pool.query("INSERT INTO egghead_Organization (id, name, fields) VALUES (?, ?, ?)", [
            org.id,
            org.name,
            JSON.stringify(org.fields),
          ]),
        ),
        ...july.memberships.map((membership) =>
          pool.query(
            "INSERT INTO egghead_OrganizationMembership (id, organizationId, userId, invitedById, role, fields) VALUES (?, ?, ?, ?, ?, ?)",
            [
              membership.id,
              membership.organizationId,
              membership.userId,
              membership.invitedById,
              membership.role,
              JSON.stringify(membership.fields),
            ],
          ),
        ),
        ...july.entitlements.map((row) =>
          pool.query(
            `INSERT INTO egghead_Entitlement
               (id, entitlementType, userId, organizationId, organizationMembershipId, sourceType, sourceId, metadata, expiresAt, deletedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              row.id,
              row.entitlementType,
              row.userId,
              row.organizationId,
              row.organizationMembershipId,
              row.sourceType,
              row.sourceId,
              JSON.stringify(row.metadata),
              row.expiresAt ? new Date(row.expiresAt) : null,
              row.deletedAt ? new Date(row.deletedAt) : null,
            ],
          ),
        ),
      ]);
    }

    /** The app's own runtime access read for one user, against the fixture. */
    async function runtimeAccess(userId: string) {
      return evaluate.evaluateContentAccessForUser({ userId, legacyRailsPlaylistId: 555 });
    }

    async function applyAll(
      ops: readonly DeltaOp[],
      cursor: ApplyCursor,
      options: { batchSize: number; maxBatches?: number },
      exportFor?: typeof railsExport,
    ) {
      const saved: ApplyCursor[] = [];
      const result = await run.applyAndVerify(db, exportFor ?? railsExport, ops, cursor, {
        ...options,
        now,
        analysisNowMs: NOW_MS,
        readOptions: SMALL,
        saveCursor: async (next) => {
          saved.push(next);
        },
      });
      return { ...result, saved };
    }

    function cursorFor(ops: readonly DeltaOp[]) {
      return newCursor(
        {
          exportSha256: railsExport.sha256,
          database: "fixture_test",
          planSha256: planSha256(ops),
          ops,
        },
        NOW_ISO,
      );
    }

    before(async () => {
      process.env["DATABASE_URL"] = mysqlUrl;
      process.env["EGGHEAD_RUNTIME"] = "local";
      docker = await import("../apps/web/src/db/local-docker");
      const safety = docker.assertDatabaseUrlForRuntime(mysqlUrl);
      if (!safety.localDockerOnly || !safety.database.endsWith("_test")) {
        throw new Error(`Refusing a non-disposable access-delta test database: ${safety.database}`);
      }
      docker.assertCommerceWritesAllowed(mysqlUrl);
      store = await import("../apps/web/src/access/rails-access-delta-store");
      run = await import("./access-delta-run");
      evaluate = await import("../apps/web/src/access/evaluate");
      db = (await import("../apps/web/src/db/adapter")).getEggheadDatabase();
    });

    after(async () => {
      await docker?.getEggheadMysqlPool().end();
    });

    void test("dry run reads July state through the adapter and plans the matrix without writing", async () => {
      await resetToJuly();
      const countBefore = await query(
        "SELECT COUNT(*) AS n, MAX(updatedAt) AS u FROM egghead_Entitlement",
      );
      // #26: every table the delta writes, not just entitlements.
      const checksum = () => query(`CHECKSUM TABLE ${FIXTURE_TABLES.join(", ")}`);
      const checksumBefore = await checksum();
      assert.equal(checksumBefore.length, FIXTURE_TABLES.length);
      const analysis = await run.analyzeDatabase(db, railsExport, NOW_MS, SMALL);
      assert.deepEqual(classCounts(analysis.plan.ops), EXPECTED_CLASSES);
      assert.equal(analysis.before.summary.underGrantUsers, 7);
      assert.equal(analysis.before.summary.overGrantUsers, 2);
      const countAfter = await query(
        "SELECT COUNT(*) AS n, MAX(updatedAt) AS u FROM egghead_Entitlement",
      );
      assert.deepEqual(countAfter, countBefore);
      assert.deepEqual(await checksum(), checksumBefore);
      assert.equal((await query("SELECT COUNT(*) AS n FROM egghead_User"))[0]?.["n"], 10);
    });

    void test("apply converges, the app's runtime access read agrees, and CourseBuilder rows survive", async () => {
      await resetToJuly();
      const analysis = await run.analyzeDatabase(db, railsExport, NOW_MS, SMALL);
      const result = await applyAll(analysis.plan.ops, cursorFor(analysis.plan.ops), {
        batchSize: 5,
      });
      assert.equal(result.cursor.complete, true);
      assert.equal(result.cursor.appliedOps, EXPECTED_TOTAL);
      assert.equal(result.saved.length, Math.ceil(EXPECTED_TOTAL / 5));
      assert.deepEqual(result.verify, {
        remainingOps: 0,
        remainingByClass: {},
        underGrantUsers: 0,
        overGrantUsers: 0,
        missingIdentityUsers: 0,
      });

      // Runtime verdicts from the app's own read: evaluateContentAccessForUser.
      const granted = ["101", "103", "105", "106", "108", "110", "114", "115"].map(ids.user);
      const verdicts = await Promise.all(
        [...granted, ...["102", "104", "107"].map(ids.user)].map(async (userId) => [
          userId,
          (await runtimeAccess(userId)).granted,
        ]),
      );
      assert.deepEqual(verdicts, [
        ...granted.map((userId) => [userId, true]),
        ...["102", "104", "107"].map((rails) => [ids.user(rails), false]),
      ]);
      assert.equal(
        (await runtimeAccess(ids.user("109"))).reason,
        "granted:egghead_playlist_access",
      );
      assert.equal((await runtimeAccess(ids.user("113"))).granted, false, "bulk buyer");
      // #6: the runtime treats the basic legacy grant as full access.
      assert.equal(
        (await runtimeAccess(ids.user("114"))).reason,
        "granted:egghead_basic_legacy_access",
      );
      // The linked beta signup's playlist, checked with its own playlist id.
      const linkedAccess = await evaluate.evaluateContentAccessForUser({
        userId: CB_NATIVE_LINK_USER,
        legacyRailsPlaylistId: 556,
      });
      assert.equal(linkedAccess.reason, "granted:egghead_playlist_access");
      const expired = await query(
        "SELECT deletedAt, JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.revokedReason')) AS why FROM egghead_Entitlement WHERE id = ?",
        [ids.purchaseEntitlement("6009")],
      );
      assert.notEqual(expired[0]?.["deletedAt"], null);
      assert.equal(expired[0]?.["why"], "expired");
      assert.equal(
        (await runtimeAccess(CB_NATIVE_STRIPE_USER)).granted,
        true,
        "CourseBuilder-native subscriber",
      );
      assert.equal(
        (
          await query("SELECT deletedAt FROM egghead_Entitlement WHERE id IN (?, ?)", [
            STRIPE_NATIVE_ENTITLEMENT,
            QUARANTINE_ENTITLEMENT,
          ])
        ).every((row) => row["deletedAt"] === null),
        true,
      );

      const linked = await query("SELECT legacyRailsUserId FROM egghead_User WHERE id = ?", [
        CB_NATIVE_LINK_USER,
      ]);
      assert.equal(linked[0]?.["legacyRailsUserId"], "111");
      const seatFlag = await query(
        "SELECT JSON_UNQUOTE(JSON_EXTRACT(fields, '$.hasAccountMemberRole')) AS flag FROM egghead_OrganizationMembership WHERE id = ?",
        [ids.membership("8007")],
      );
      assert.equal(seatFlag[0]?.["flag"], "false");
      const lapsed = await query(
        "SELECT expiresAt, JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.status')) AS status FROM egghead_Entitlement WHERE id = ?",
        [ids.seatEntitlement("9010", "8010")],
      );
      assert.deepEqual({ ...lapsed[0] }, { expiresAt: null, status: "past_due" });
    });

    void test("re-running is idempotent: a fresh plan is empty and replaying the old plan changes nothing", async () => {
      await resetToJuly();
      const original = (await run.analyzeDatabase(db, railsExport, NOW_MS, SMALL)).plan.ops;
      await applyAll(original, cursorFor(original), { batchSize: 50 });
      const once = await store.readCbSnapshot(db, railsExport, SMALL);

      const fresh = await run.analyzeDatabase(db, railsExport, NOW_MS, SMALL);
      assert.equal(fresh.plan.ops.length, 0, "second dry run finds nothing to do");

      const replayed = await applyAll(original, cursorFor(original), { batchSize: 50 });
      assert.equal(replayed.verify.remainingOps, 0);
      const twice = await store.readCbSnapshot(db, railsExport, SMALL);
      assert.deepEqual(twice, once, "replaying every op leaves the same rows");
      const users = await query("SELECT COUNT(*) AS n FROM egghead_User");
      assert.equal(users[0]?.["n"], 15, "no duplicate users");
    });

    void test("resume: a stopped run continues from its cursor, and a replayed batch is harmless", async () => {
      await resetToJuly();
      const ops = (await run.analyzeDatabase(db, railsExport, NOW_MS, SMALL)).plan.ops;
      const first = await applyAll(ops, cursorFor(ops), { batchSize: 4, maxBatches: 2 });
      assert.equal(first.cursor.complete, false);
      assert.equal(first.cursor.appliedOps, 8);
      assert.equal(first.cursor.lastKey, ops[7]?.key);
      assert.ok(first.verify.remainingOps > 0);

      // Crash after commit but before the second cursor save: resume from the first save.
      const staleCursor = first.saved[0];
      assert.ok(staleCursor);
      const resumed = await applyAll(ops, staleCursor, { batchSize: 4 });
      assert.equal(resumed.cursor.complete, true);
      assert.equal(resumed.cursor.appliedOps, EXPECTED_TOTAL);
      assert.equal(resumed.saved[0]?.lastKey, ops[7]?.key, "the replayed batch re-applies ops 5-8");
      assert.equal(resumed.verify.remainingOps, 0);
      assert.equal(resumed.verify.underGrantUsers, 0);
      assert.equal(resumed.verify.overGrantUsers, 0);
    });

    void test("#3: tiny pages, chunked lookups and the consistent read return the same snapshot", async () => {
      await resetToJuly();
      const small = await store.readCbSnapshot(db, railsExport, SMALL);
      const defaults = await store.readCbSnapshot(db, railsExport, {
        ...store.DEFAULT_READ_OPTIONS,
        consistent: false,
      });
      assert.ok(small.entitlements.length > SMALL.pageSize * 3, "several pages ran");
      assert.ok(railsExport.users.length > SMALL.chunkSize * 3, "several chunks ran");
      assert.deepEqual(small, defaults);
    });

    void test("restore through SQL clears the revoke marker", async () => {
      await resetToJuly();
      const seat = ids.seatEntitlement("9004", "8005");
      await query(
        "UPDATE egghead_Entitlement SET deletedAt = CURRENT_TIMESTAMP(3), metadata = JSON_SET(metadata, '$.revokedBy', 'rails_access_delta', '$.revokedReason', 'not_granted_by_rails') WHERE id = ?",
        [seat],
      );
      const ops = (await run.analyzeDatabase(db, railsExport, NOW_MS, SMALL)).plan.ops;
      await applyAll(ops, cursorFor(ops), { batchSize: 50 });
      const rows = await query(
        "SELECT deletedAt, JSON_EXTRACT(metadata, '$.revokedBy') AS revokedBy, JSON_EXTRACT(metadata, '$.revokedReason') AS why FROM egghead_Entitlement WHERE id = ?",
        [seat],
      );
      assert.deepEqual({ ...rows[0] }, { deletedAt: null, revokedBy: null, why: null });
    });

    void test("#7: an unresolved member keeps their seat row and seat flag through a real apply", async () => {
      await resetToJuly();
      await query(
        "UPDATE egghead_User SET fields = JSON_REMOVE(fields, '$.legacyRailsUserId') WHERE id = ?",
        [ids.user("105")],
      );
      const lines = novemberExportLines().map((value) =>
        value.includes('"railsUserId":"105","email"')
          ? value.replace('"u105@example.test"', '""')
          : value,
      );
      const unresolvedExport = parseRailsAccessExport(lines.join("\n"));
      const analysis = await run.analyzeDatabase(db, unresolvedExport, NOW_MS, SMALL);
      assert.equal(analysis.plan.membershipRevokeHeldForIdentity, 1);
      await applyAll(
        analysis.plan.ops,
        cursorFor(analysis.plan.ops),
        { batchSize: 50 },
        unresolvedExport,
      );
      const flag = await query(
        "SELECT JSON_UNQUOTE(JSON_EXTRACT(fields, '$.hasAccountMemberRole')) AS flag FROM egghead_OrganizationMembership WHERE id = ?",
        [ids.membership("8005")],
      );
      assert.equal(flag[0]?.["flag"], "true");
      const seat = await query("SELECT deletedAt FROM egghead_Entitlement WHERE id = ?", [
        ids.seatEntitlement("9004", "8005"),
      ]);
      assert.equal(seat[0]?.["deletedAt"], null);
      assert.equal((await runtimeAccess(ids.user("105"))).granted, true);
    });

    void test("#9: a signup between plan and apply fails the batch loudly; the next dry run links", async () => {
      await resetToJuly();
      const ops = (await run.analyzeDatabase(db, railsExport, NOW_MS, SMALL)).plan.ops;
      await query(
        "INSERT INTO egghead_User (id, email, name, role, fields) VALUES (?, ?, ?, 'user', '{}')",
        ["cb-signup-103", "U103@example.test", "Signup"],
      );
      const entitlementsBefore = await query("SELECT COUNT(*) AS n FROM egghead_Entitlement");
      await assert.rejects(
        applyAll(ops, cursorFor(ops), { batchSize: 50 }),
        (error: unknown) => error instanceof store.UserCreateCollisionError,
      );
      assert.deepEqual(
        await query("SELECT COUNT(*) AS n FROM egghead_Entitlement"),
        entitlementsBefore,
      );
      assert.equal(
        (await query("SELECT id FROM egghead_User WHERE id = ?", [ids.user("103")])).length,
        0,
      );

      const again = await run.analyzeDatabase(db, railsExport, NOW_MS, SMALL);
      const link = opFor(again.plan.ops, "user_link", "cb-signup-103");
      assert.ok(link && link.kind === "user_link");
      assert.equal(link.railsUserId, "103");
      await applyAll(again.plan.ops, cursorFor(again.plan.ops), { batchSize: 50 });
      assert.equal((await runtimeAccess("cb-signup-103")).granted, true);
    });

    void test("#8: the store weighs Rails emails by the column collation, so ß/ss twins never collide on apply", async () => {
      await resetToJuly();
      const twins = exportWith([
        ...learnerLines("130", "straße@example.test", "600"),
        ...learnerLines("131", "strasse@example.test", "601"),
      ]);
      const analysis = await run.analyzeDatabase(db, twins, NOW_MS, SMALL);
      const keys = analysis.snapshot.exportEmailKeys;
      assert.ok(keys["straße@example.test"]);
      assert.equal(keys["straße@example.test"], keys["strasse@example.test"]);
      assert.notEqual(keys["u101@example.test"], keys["u103@example.test"]);
      assert.equal(keys["linked@example.test"], undefined, "keys are per export email as written");
      assert.ok(keys["Linked@Example.test"]);
      assert.deepEqual(analysis.plan.identities.get("131"), {
        kind: "unresolved",
        reason: "duplicate_rails_email",
      });
      // The plan applies cleanly: no second create hits the unique key.
      const result = await applyAll(
        analysis.plan.ops,
        cursorFor(analysis.plan.ops),
        { batchSize: 50 },
        twins,
      );
      assert.equal(result.cursor.complete, true);
      assert.equal(result.verify.remainingOps, 0);
    });

    void test("#9: an email drift applies through SQL, and a raced address fails the batch", async () => {
      await resetToJuly();
      const renamed = exportWithEmail("101", "renamed101@example.test");
      const analysis = await run.analyzeDatabase(db, renamed, NOW_MS, SMALL);
      const op = opFor(analysis.plan.ops, "user_email_update", ids.user("101"));
      assert.ok(op);

      await query(
        "INSERT INTO egghead_User (id, email, name, role, fields) VALUES (?, ?, ?, 'user', '{}')",
        ["cb-racer", "Renamed101@example.test", "Racer"],
      );
      const untouched = await query(`CHECKSUM TABLE ${FIXTURE_TABLES.join(", ")}`);
      await assert.rejects(
        applyAll(analysis.plan.ops, cursorFor(analysis.plan.ops), { batchSize: 100 }, renamed),
        (error: unknown) => error instanceof store.UserWriteConflictError,
      );
      assert.deepEqual(await query(`CHECKSUM TABLE ${FIXTURE_TABLES.join(", ")}`), untouched);
      await query("DELETE FROM egghead_User WHERE id = 'cb-racer'");

      const result = await applyAll(
        analysis.plan.ops,
        cursorFor(analysis.plan.ops),
        { batchSize: 100 },
        renamed,
      );
      assert.equal(result.verify.remainingOps, 0);
      const row = await query("SELECT email FROM egghead_User WHERE id = ?", [ids.user("101")]);
      assert.equal(row[0]?.["email"], "renamed101@example.test");
      assert.equal((await runtimeAccess(ids.user("101"))).granted, true);
    });

    void test("#18: a user_link raced by another link fails the batch loudly", async () => {
      await resetToJuly();
      const analysis = await run.analyzeDatabase(db, railsExport, NOW_MS, SMALL);
      assert.ok(opFor(analysis.plan.ops, "user_link", CB_NATIVE_LINK_USER));
      await query(
        "UPDATE egghead_User SET fields = JSON_SET(fields, '$.legacyRailsUserId', '999') WHERE id = ?",
        [CB_NATIVE_LINK_USER],
      );
      await assert.rejects(
        applyAll(analysis.plan.ops, cursorFor(analysis.plan.ops), { batchSize: 100 }),
        (error: unknown) =>
          error instanceof store.UserWriteConflictError &&
          /linked to Rails user 999/.test(error.message),
      );
      const grants = await query("SELECT COUNT(*) AS n FROM egghead_Entitlement WHERE userId = ?", [
        CB_NATIVE_LINK_USER,
      ]);
      assert.equal(grants[0]?.["n"], 0, "no grant landed on the wrong person");
    });

    void test("#4: the CLI refuses --apply without the plan sha, on a stale export, a failing gate or a large revoke", async () => {
      await resetToJuly();
      const dir = await mkdtemp(path.join(tmpdir(), "access-delta-cli-"));
      const database = new URL(mysqlUrl ?? "mysql://x/none").pathname.slice(1);
      const cli = (args: readonly string[]) =>
        new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["--import", "tsx", "scripts/access-delta.ts", ...args],
            {
              env: {
                ...process.env,
                TZ: "UTC",
                TSX_TSCONFIG_PATH: "apps/web/tsconfig.json",
                DATABASE_URL: mysqlUrl,
                EGGHEAD_RUNTIME: "local",
              },
              stdio: ["ignore", "ignore", "pipe"],
            },
          );
          let stderr = "";
          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stderr }));
        });
      const writeExport = async (name: string, lines: readonly string[], ageMs: number) => {
        const file = path.join(dir, name);
        await writeFile(file, exportText(lines, new Date(Date.now() - ageMs).toISOString()));
        return file;
      };
      const apply = (file: string, out: string, extra: readonly string[]) =>
        cli(["--export", file, "--out", out, "--apply", "--confirm-database", database, ...extra]);

      try {
        // Stale export: the dry run is fine, --apply refuses.
        const stale = await writeExport("stale.jsonl", novemberData(), 3 * 3_600_000);
        const staleOut = path.join(dir, "stale");
        const dry = await cli(["--export", stale, "--out", staleOut]);
        assert.equal(dry.code, 0, dry.stderr);
        assert.match(dry.stderr, /gate pass/);
        const staleSha = await planShaIn(staleOut);
        const noSha = await apply(stale, staleOut, []);
        assert.equal(noSha.code, 1);
        assert.match(noSha.stderr, /needs --expect-plan/);
        const old = await apply(stale, staleOut, ["--expect-plan", staleSha]);
        assert.equal(old.code, 1);
        assert.match(old.stderr, /minutes old, over --max-export-age 120 minutes/);

        // Failing gate: an empty Rails email leaves a learner unresolved.
        const blank = await writeExport(
          "blank.jsonl",
          novemberData().map((value) => value.replace('"email":"u103@example.test"', '"email":""')),
          60_000,
        );
        const blankOut = path.join(dir, "blank");
        assert.match((await cli(["--export", blank, "--out", blankOut])).stderr, /gate FAIL/);
        const gated = await apply(blank, blankOut, ["--expect-plan", await planShaIn(blankOut)]);
        assert.equal(gated.code, 1);
        assert.match(gated.stderr, /gate: 1 users would still be under-granted/);

        // Large revoke: 60 owned rows Rails no longer grants.
        await Promise.all(
          Array.from({ length: 60 }, (_, index) =>
            query(
              `INSERT INTO egghead_Entitlement (id, entitlementType, userId, sourceType, sourceId, metadata)
               VALUES (?, 'egghead_playlist_access', ?, 'rails_sellable_purchase', ?, '{}')`,
              [`eh_entitlement_cli_stale_${index}`, ids.user("101"), `cli-stale-${index}`],
            ),
          ),
        );
        const fresh = await writeExport("fresh.jsonl", novemberData(), 60_000);
        const freshOut = path.join(dir, "fresh");
        assert.match((await cli(["--export", fresh, "--out", freshOut])).stderr, /gate FAIL/);
        const sha = await planShaIn(freshOut);
        const alarmed = await apply(fresh, freshOut, ["--expect-plan", sha]);
        assert.equal(alarmed.code, 1);
        assert.match(alarmed.stderr, /exceed the alarm threshold/);
        const allowed = await apply(fresh, freshOut, [
          "--expect-plan",
          sha,
          "--allow-large-revoke",
        ]);
        assert.equal(allowed.code, 0, allowed.stderr);
        const again = await cli(["--export", fresh, "--out", path.join(dir, "again")]);
        assert.match(again.stderr, /dry-run: 0 changes/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    void test("#9: the store pairs ß and ss the way the email column's collation does", async () => {
      await resetToJuly();
      await query(
        "INSERT INTO egghead_User (id, email, name, role, fields) VALUES (?, ?, ?, 'user', '{}')",
        ["cb-strasse", "strasse@example.test", "Strasse"],
      );
      const withStraße = exportWith(straßeLines());
      const analysis = await run.analyzeDatabase(db, withStraße, NOW_MS, SMALL);
      const link = opFor(analysis.plan.ops, "user_link", "cb-strasse");
      assert.ok(link && link.kind === "user_link", "linked, not a create that would collide");
      assert.equal(opFor(analysis.plan.ops, "user_create", ids.user("130")), undefined);
      const result = await applyAll(
        analysis.plan.ops,
        cursorFor(analysis.plan.ops),
        { batchSize: 50 },
        withStraße,
      );
      assert.equal(result.verify.remainingOps, 0);
    });
  },
);
