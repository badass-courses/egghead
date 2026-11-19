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
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  simulateApply,
  type CbEntitlement,
  type CbSnapshot,
  type CbUser,
  type DeltaOp,
} from "../apps/web/src/access/rails-access-delta";
import {
  gateInputsDiff,
  hostSha256,
  newCursor,
  parsePlan,
  planSha256,
  serializePlan,
  type ApplyCursor,
  type GateInputs,
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
  backingGrant,
  proHolder,
  QUARANTINE_ENTITLEMENT,
  railsUser,
  STRIPE_NATIVE_ENTITLEMENT,
} from "./access-delta.fixtures";
import {
  analysisClockMs,
  analyze,
  applyRefusals,
  buildReceipt,
  defaultGateInputs,
  emailMoveCollisions,
  parseDurationMs,
  railsIdListSha256,
  spreadSample,
  type DeltaAnalysis,
} from "./access-delta-run";

const NOW_MS = Date.parse(NOW_ISO);

/** The fixture's held stale legacy subscription (7704, user 123). */
const FIXTURE_STALE_LEGACY_SHA = railsIdListSha256(["7704"]);
/** What a reviewer of the fixture export accepts on a first run. */
const FIXTURE_FIRST_BACKING = {
  rails_gift: 1,
  rails_legacy_subscription: 1,
  rails_managed_subscription: 1,
};
/** The same acceptances as CLI flags. */
const FIXTURE_ACCEPT_ARGS = [
  "--accept-first-backing",
  "rails_gift=1",
  "--accept-first-backing",
  "rails_managed_subscription=1",
  "--accept-first-backing",
  "rails_legacy_subscription=1",
  "--accept-stale-legacy",
  FIXTURE_STALE_LEGACY_SHA,
];

/** Receipt context for pure tests: a reviewed first dry run of the fixture. */
const CTX = {
  mode: "dry-run" as const,
  generatedAt: NOW_ISO,
  target: { runtime: "local", hostSha256: hostSha256("127.0.0.1"), database: "fixture_test" },
  gateInputs: defaultGateInputs({
    acceptFirstBacking: FIXTURE_FIRST_BACKING,
    acceptStaleLegacy: FIXTURE_STALE_LEGACY_SHA,
  }),
  previousBackingCounts: null,
};

/** CTX with some gate inputs changed. */
function ctx(
  overrides: Partial<GateInputs>,
  previousBackingCounts: Record<string, number> | null = null,
) {
  return {
    ...CTX,
    gateInputs: Object.assign({}, CTX.gateInputs, overrides),
    previousBackingCounts,
  };
}

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
  user_create: 9, // 103, 109, 113, 114, 115, backed 120, 121, 122, and held 123
  user_link: 1, // 111 -> beta signup
  organization_create: 2, // accounts 7003, 7014
  membership_create: 3, // 8003 (103), 8006 (106), role-only 115 on 7014
  // 9003 org+seat, 9004 seat 106, lifetime 108, purchases 6001 and 6002,
  // basic 114, 9011 org+seat (second sub on 7001), 9014 org+seat (trialing),
  // backed pro: gift 120, managed 121, legacy subscription 122
  entitlement_grant: 14,
  entitlement_extend: 2, // 9001 org+seat
  entitlement_update: 2, // 9010 org+seat: active -> past_due
  membership_revoke: 2, // 8002 (cancelled), 8007 (removed seat)
  entitlement_revoke: 3, // 9002 org+seat, 9004 seat 107
  entitlement_expire: 1, // purchase 6009 ran out in September
};
const EXPECTED_TOTAL = 39;

/** Export text for these data lines, with a manifest counted from them. */
function exportText(lines: readonly string[], exportedAt = "2026-11-19T11:00:00.000Z") {
  const counts: Record<string, number> = {
    user: 0,
    role_grant: 0,
    basic_grant: 0,
    subscription: 0,
    purchase: 0,
    pro_holder: 0,
    backing_grant: 0,
  };
  for (const value of lines) {
    const kind = /"kind":"([a-z_]+)"/.exec(value)?.[1];
    if (kind) counts[kind] = (counts[kind] ?? 0) + 1;
  }
  const manifest = JSON.stringify({
    kind: "manifest",
    format: "egghead-rails-access-export/v3",
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

/** Write an export whose exportedAt is `ageMs` before now. */
async function writeExportIn(dir: string, name: string, lines: readonly string[], ageMs: number) {
  const file = path.join(dir, name);
  await writeFile(file, exportText(lines, new Date(Date.now() - ageMs).toISOString()));
  return file;
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
    assert.equal(parsed.users.length, 16);
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
      /manifest says 4 backing_grant lines but the file has 3/,
    );
  });

  void test("refuses data after the manifest; a dangling user reference is a held orphan", () => {
    const lines = novemberExportLines();
    assert.throws(
      () => parseRailsAccessExport([...lines, lines[0]].join("\n")),
      /after the manifest/,
    );
    const noUser109 = lines.filter((value) => !value.includes('"railsUserId":"109","email"'));
    const manifest = (noUser109.at(-1) ?? "").replace('"user":16', '"user":15');
    const orphaned = parseRailsAccessExport([...noUser109.slice(0, -1), manifest].join("\n"));
    assert.deepEqual(orphaned.orphanRailsUserIds, ["109"]);
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
    assert.equal(analysis.before.summary.underGrantUsers, 10); // 103, 106, 108, 109, 111, 114, 115, 120, 121, 122
    assert.equal(analysis.before.summary.overGrantUsers, 2); // 102, 107
    assert.equal(analysis.after.summary.underGrantUsers, 0);
    assert.equal(analysis.after.summary.overGrantUsers, 0);
    assert.equal(analysis.remainingAfterSimulation, 0);
  });

  void test("receipt: counts per class, at most 20 samples without emails, and a passing gate", () => {
    const receipt = buildReceipt(railsExport, analysis, CTX);
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
    const receipt = buildReceipt(railsExport, conflictAnalysis, CTX);
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
    const receipt = buildReceipt(railsExport, held, CTX);
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
    const receipt = buildReceipt(twins, result, CTX);
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
    const receipt = buildReceipt(renamed, result, CTX);
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
    const receipt = buildReceipt(renamed, result, CTX);
    assert.equal(receipt.identityConflicts.emailUpdateHeld, 1);
    assert.equal(receipt.identity["matched:email_update_held"], 1);
    assert.equal(receipt.gate.pass, false);
    assert.equal(result.after.summary.underGrantUsers, 0, "101 keeps access by legacy id");
  });

  void test("#8: backed pro holders are granted on their backing", () => {
    const gift = opFor(
      ops,
      "entitlement_grant",
      ids.backingEntitlement("rails_gift", "7701", "120"),
    );
    assert.ok(gift && gift.kind === "entitlement_grant");
    assert.equal(gift.entitlement.entitlementType, "egghead_all_access_subscription");
    assert.equal(
      gift.entitlement.expiresAt,
      "2027-03-01T00:00:00.000Z",
      "a gift ends on its own clock",
    );
    assert.equal(gift.entitlement.metadata["accessLaw"], "gift_expires_at_v1");
    const managed = opFor(
      ops,
      "entitlement_grant",
      ids.backingEntitlement("rails_managed_subscription", "7702", "121"),
    );
    assert.ok(managed && managed.kind === "entitlement_grant");
    assert.equal(managed.entitlement.expiresAt, null);
    const legacy = opFor(
      ops,
      "entitlement_grant",
      ids.backingEntitlement("rails_legacy_subscription", "7703", "122"),
    );
    assert.ok(legacy && legacy.kind === "entitlement_grant");
    assert.equal(
      legacy.entitlement.expiresAt,
      null,
      "lenient: the stale period end is metadata only",
    );
    assert.equal(legacy.entitlement.metadata["currentPeriodEnd"], "2026-11-01T00:00:00.000Z");

    const receipt = buildReceipt(railsExport, analysis, CTX);
    assert.deepEqual(receipt.backingGrants.bySourceType, {
      rails_gift: 1,
      rails_managed_subscription: 1,
      rails_legacy_subscription: 1,
      rails_bare_pro_active: 0,
    });
    assert.equal(receipt.backingGrants.legacySubscriptionsPastPeriodEnd, 1);
    assert.deepEqual(receipt.backingGrants.backedWithoutPro, {
      rails_gift: 0,
      rails_managed_subscription: 2,
      rails_legacy_subscription: 1,
    });
    assert.equal(receipt.proCrossCheck.bareProHolders.count, 0);
    assert.equal(receipt.proCrossCheck.railsProHolders, 11);
    assert.deepEqual(receipt.proCrossCheck.exportHasRailsLacksSample, []);
    assert.equal(receipt.gate.pass, true);
    assert.equal(analysis.after.summary.underGrantUsers, 0);
  });

  void test("#8: an expired gift grants nothing and is not held: its July row expires", () => {
    const snapshot = julySnapshot();
    const expired: CbSnapshot = {
      ...snapshot,
      entitlements: [
        ...snapshot.entitlements,
        {
          id: ids.backingEntitlement("rails_gift", "7799", "101"),
          entitlementType: "egghead_all_access_subscription",
          userId: ids.user("101"),
          organizationId: null,
          organizationMembershipId: null,
          sourceType: "rails_gift",
          sourceId: "7799:101",
          metadata: { railsUserId: "101" },
          expiresAt: "2026-10-01T00:00:00.000Z",
          deletedAt: null,
        },
      ],
    };
    const result = analyze(railsExport, expired, NOW_MS);
    assert.ok(
      opFor(
        result.plan.ops,
        "entitlement_expire",
        ids.backingEntitlement("rails_gift", "7799", "101"),
      ),
    );
    assert.equal(buildReceipt(railsExport, result, CTX).proCrossCheck.bareProHolders.count, 0);
  });

  void test("#8: bare pro is a held list of ids; accepting it binds the exact set", () => {
    const bare = exportWith([JSON.stringify(proHolder("130")), JSON.stringify(proHolder("131"))]);
    const bareAnalysis = analyze(bare, julySnapshot(), NOW_MS);
    const failing = buildReceipt(bare, bareAnalysis, CTX);
    assert.deepEqual(failing.proCrossCheck.bareProHolders.railsUserIds, ["130", "131"]);
    assert.equal(failing.proCrossCheck.bareProHolders.sha256, railsIdListSha256(["131", "130"]));
    assert.equal(failing.gate.pass, false);
    assert.match(failing.gate.failures.join(), /2 bare pro holders/);
    const sha = failing.proCrossCheck.bareProHolders.sha256;
    assert.equal(buildReceipt(bare, bareAnalysis, ctx({ acceptBarePro: sha })).gate.pass, true);
    // A same-size swap of who is bare does not pass on the old acceptance.
    const swapped = exportWith([
      JSON.stringify(proHolder("130")),
      JSON.stringify(proHolder("132")),
    ]);
    assert.equal(
      buildReceipt(swapped, analyze(swapped, julySnapshot(), NOW_MS), ctx({ acceptBarePro: sha }))
        .gate.pass,
      false,
    );
    // A pro holder with a special role, seat or backing is never on the list.
    assert.deepEqual(
      buildReceipt(railsExport, analysis, CTX).proCrossCheck.bareProHolders.railsUserIds,
      [],
    );
  });

  void test("#8: a backed source type that more than doubles since the previous run alarms", () => {
    const counts = { rails_gift: 1, rails_managed_subscription: 1, rails_legacy_subscription: 1 };
    assert.equal(buildReceipt(railsExport, analysis, ctx({}, counts)).gate.pass, true);
    const grown = buildReceipt(railsExport, analysis, ctx({}, { ...counts, rails_gift: 0 }));
    assert.equal(grown.gate.pass, false);
    assert.match(grown.gate.failures.join(), /rails_gift grew from 0 to 1/);
    assert.equal(
      buildReceipt(
        railsExport,
        analysis,
        ctx({ allowBackingGrowth: true }, { ...counts, rails_gift: 0 }),
      ).gate.pass,
      true,
    );
  });

  void test("#11: an X->Y move then a new signup on X clears through an identity pass", () => {
    const lines = novemberData().map((value) =>
      value.includes('"railsUserId":"101","email"')
        ? value.replace('"u101@example.test"', '"moved101@example.test"')
        : value,
    );
    const chain = parseRailsAccessExport(
      exportText([...lines, ...learnerLines("140", "u101@example.test", "700")]),
    );
    // As the store reads it: 101's CourseBuilder email pairs with the export's
    // u101 line (now Rails user 140's address).
    const july = julySnapshot();
    const snapshot: CbSnapshot = {
      ...july,
      users: [
        ...july.users.filter((user) => user.id !== ids.user("101")),
        ...july.users
          .filter((user) => user.id === ids.user("101"))
          .map(
            (user): CbUser =>
              Object.assign({}, user, { matchedExportEmails: ["u101@example.test"] }),
          ),
      ],
    };
    const full = analyze(chain, snapshot, NOW_MS);
    assert.deepEqual(full.plan.identities.get("140"), {
      kind: "unresolved",
      reason: "email_owned_by_other_rails_user",
    });
    assert.equal(buildReceipt(chain, full, CTX).gate.pass, false);

    const identity = analyze(chain, snapshot, NOW_MS, { pass: "identity" });
    assert.deepEqual(
      identity.plan.ops.map((op) => op.kind),
      ["user_email_update", "user_link"],
    );
    const identityReceipt = buildReceipt(chain, identity, CTX);
    assert.equal(identityReceipt.pass, "identity");
    assert.equal(identityReceipt.gate.pass, true, identityReceipt.gate.failures.join());
    assert.deepEqual(identity.afterIdentityPass, {
      underGrantUsers: 0,
      overGrantUsers: 0,
      identityConflicts: 0,
      fullPlanOps: EXPECTED_TOTAL + 1, // 140's create and grant, minus the link
    });

    const moved = simulateApply(snapshot, identity.plan.ops, NOW_ISO);
    const replanned = analyze(chain, moved, NOW_MS);
    assert.ok(opFor(replanned.plan.ops, "user_create", ids.user("140")));
    assert.equal(buildReceipt(chain, replanned, CTX).gate.pass, true);
  });

  void test("#12: a held seat flag takes a named ruling: clear revokes it, keep accepts the over-grant", () => {
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
    const heldReceipt = buildReceipt(railsExport, held, CTX);
    assert.deepEqual(
      heldReceipt.heldSeatFlags.map((flag) => [flag.membershipId, flag.ruling]),
      [[ids.membership("8007"), null]],
    );
    assert.equal(heldReceipt.gate.pass, false);

    const seat = ids.membership("8007");
    const cleared = analyze(railsExport, native, NOW_MS, {
      seatFlagRulings: new Map([[seat, "clear"]]),
    });
    assert.ok(opFor(cleared.plan.ops, "membership_revoke", seat));
    assert.equal(buildReceipt(railsExport, cleared, CTX).gate.pass, true);

    const kept = analyze(railsExport, native, NOW_MS, {
      seatFlagRulings: new Map([[seat, "keep"]]),
    });
    assert.equal(opFor(kept.plan.ops, "membership_revoke", seat), undefined);
    const keptReceipt = buildReceipt(railsExport, kept, CTX);
    assert.equal(keptReceipt.overGrantAcceptedBySeatFlagKeep, 1);
    assert.equal(keptReceipt.gate.pass, true, keptReceipt.gate.failures.join());

    const stale = analyze(railsExport, native, NOW_MS, {
      seatFlagRulings: new Map([["eh_orgmem_not_held", "clear"]]),
    });
    assert.match(
      buildReceipt(railsExport, stale, CTX).gate.failures.join(),
      /not held: eh_orgmem_not_held/,
    );
  });

  void test("#14: the alarm counts access moves, seat clears by update and subscription expiries", () => {
    const snapshot = julySnapshot();
    const seat101 = ids.seatEntitlement("9001", "8001");
    const subscriptionRow = ids.subOrgEntitlement("9002", "7002");
    const moved: CbSnapshot = {
      ...snapshot,
      entitlements: [
        ...snapshot.entitlements.filter((row) => row.id !== seat101 && row.id !== subscriptionRow),
        ...snapshot.entitlements
          .filter((row) => row.id === seat101)
          .map((row): CbEntitlement => Object.assign({}, row, { userId: ids.user("104") })),
        ...snapshot.entitlements
          .filter((row) => row.id === subscriptionRow)
          .map(
            (row): CbEntitlement =>
              Object.assign({}, row, { expiresAt: "2026-08-01T00:00:00.000Z" }),
          ),
      ],
    };
    const lines = novemberExportLines().map((value) =>
      value.includes('"railsAccountSubscriptionId":"9004"')
        ? value.replace(
            '"railsAccountUserId":"8005","railsUserId":"105","hasMemberRole":true',
            '"railsAccountUserId":"8005","railsUserId":"105","hasMemberRole":false',
          )
        : value,
    );
    const result = analyze(parseRailsAccessExport(lines.join("\n")), moved, NOW_MS);
    assert.equal(
      result.largeRevoke.entitlementMoves,
      1,
      "101's seat row now points at another user",
    );
    assert.equal(result.largeRevoke.seatClearsByUpdate, 1, "8005 lost account_member");
    assert.equal(result.largeRevoke.subscriptionExpires, 1, "9002's org row with a past expiresAt");
    assert.equal(
      result.largeRevoke.revokes,
      result.largeRevoke.entitlementRevokes +
        result.largeRevoke.membershipRevokes +
        result.largeRevoke.entitlementMoves +
        result.largeRevoke.seatClearsByUpdate +
        result.largeRevoke.subscriptionExpires,
    );
  });

  void test("#17: the receipt stores a hash of the host, never the host", () => {
    const receipt = buildReceipt(railsExport, analysis, CTX);
    assert.equal(receipt.target.hostSha256, hostSha256("127.0.0.1"));
    assert.doesNotMatch(JSON.stringify(receipt), /127\.0\.0\.1/);
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
    assert.equal(buildReceipt(railsExport, stale, CTX).gate.pass, false);
    assert.equal(buildReceipt(railsExport, stale, ctx({ allowLargeRevoke: true })).gate.pass, true);
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
      pass: "full",
      gateInputs: CTX.gateInputs,
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

/** A bare `pro` holder line with a latest sign-in date. */
function proLine(railsUserId: string, lastSignInOn: string | null) {
  return JSON.stringify({ kind: "pro_holder", railsUserId, lastSignInOn });
}

function emailUpdateOp(userId: string, email: string): DeltaOp {
  return {
    kind: "user_email_update",
    key: `user_email_update:${userId}:${email}`,
    userId,
    railsUserId: userId,
    email,
    previousEmail: `${userId}@example.test`,
  };
}

function linkOp(userId: string, railsUserId: string): DeltaOp {
  return { kind: "user_link", key: `user_link:${userId}:${railsUserId}`, userId, railsUserId };
}

/** No op of any kind names this row or membership id. */
function noOpNames(ops: readonly DeltaOp[], id: string) {
  return !ops.some((op) => op.key.endsWith(`:${id}`));
}

function liveRow(
  row: Omit<CbEntitlement, "deletedAt" | "organizationId" | "organizationMembershipId">,
): CbEntitlement {
  return Object.assign(
    { organizationId: null, organizationMembershipId: null, deletedAt: null },
    row,
  );
}

void describe("round 5: pro-gated backing, holds and bound gate inputs (pure)", () => {
  const railsExport = parseRailsAccessExport(novemberExportText());
  const analysis: DeltaAnalysis = analyze(railsExport, julySnapshot(), NOW_MS);
  const staleRow = ids.backingEntitlement("rails_legacy_subscription", "7704", "123");

  void test("#2.1: a first run must accept every granted source type by its exact count", () => {
    const none = buildReceipt(railsExport, analysis, ctx({ acceptFirstBacking: {} }));
    assert.equal(none.gate.pass, false);
    for (const type of ["rails_gift", "rails_managed_subscription", "rails_legacy_subscription"]) {
      assert.match(none.gate.failures.join("\n"), new RegExp(`first run: 1 ${type} grants`));
    }
    const wrong = buildReceipt(
      railsExport,
      analysis,
      ctx({ acceptFirstBacking: { ...FIXTURE_FIRST_BACKING, rails_gift: 2 } }),
    );
    assert.match(
      wrong.gate.failures.join(),
      /--accept-first-backing rails_gift=2 but the plan grants 1/,
    );
    assert.equal(buildReceipt(railsExport, analysis, CTX).gate.pass, true);
    // With a previous receipt the growth alarm takes over; no acceptance needed.
    const previous = { rails_gift: 1, rails_managed_subscription: 1, rails_legacy_subscription: 1 };
    assert.equal(
      buildReceipt(railsExport, analysis, ctx({ acceptFirstBacking: {} }, previous)).gate.pass,
      true,
    );
  });

  void test("#2.1: a pro holder's legacy subscription 45+ days past its period end is held, by sha", () => {
    assert.equal(opFor(analysis.plan.ops, "entitlement_grant", staleRow), undefined);
    assert.deepEqual(analysis.plan.heldLegacySubscriptions, [
      {
        railsSourceId: "7704",
        railsUserId: "123",
        currentPeriodEnd: "2026-09-01T00:00:00.000Z",
        reason: "period_end_stale",
      },
    ]);
    const unaccepted = buildReceipt(railsExport, analysis, ctx({ acceptStaleLegacy: null }));
    assert.equal(unaccepted.heldLegacySubscriptions.sha256, FIXTURE_STALE_LEGACY_SHA);
    assert.match(unaccepted.gate.failures.join(), /1 legacy subscriptions held as stale/);
    // 123 is not bare: the stale subscription has its own list.
    assert.deepEqual(unaccepted.proCrossCheck.bareProHolders.railsUserIds, []);
    // A wider window grants it; no period end at all is held too.
    const wide = analyze(railsExport, julySnapshot(), NOW_MS, { legacyStaleDays: 90 });
    assert.ok(opFor(wide.plan.ops, "entitlement_grant", staleRow));
    const undated = exportWith([
      JSON.stringify(backingGrant("legacy_subscription", "7705", "101")),
    ]);
    assert.deepEqual(
      analyze(undated, julySnapshot(), NOW_MS).plan.heldLegacySubscriptions.map((held) => [
        held.railsSourceId,
        held.reason,
      ]),
      [
        ["7704", "period_end_stale"],
        ["7705", "no_period_end"],
      ],
    );
  });

  void test("#2.1: a held legacy row from an earlier run is kept, not revoked, and its over-grant is the hold's", () => {
    const snapshot = julySnapshot();
    const earlier: CbSnapshot = {
      ...snapshot,
      entitlements: [
        ...snapshot.entitlements,
        liveRow({
          id: staleRow,
          entitlementType: "egghead_all_access_subscription",
          userId: ids.user("123"),
          sourceType: "rails_legacy_subscription",
          sourceId: "7704:123",
          metadata: { railsUserId: "123" },
          expiresAt: null,
        }),
      ],
    };
    const result = analyze(railsExport, earlier, NOW_MS);
    assert.ok(noOpNames(result.plan.ops, staleRow));
    assert.equal(result.plan.revokeHeldForStaleLegacy, 1);
    const receipt = buildReceipt(railsExport, result, CTX);
    assert.equal(receipt.overGrantAcceptedByHold, 1);
    assert.equal(receipt.gate.pass, true, receipt.gate.failures.join());
  });

  void test("backing grants only users Rails grants as pro today; the rest is counted", () => {
    // 109 has a playlist purchase but no `pro`: a gift alone does not grant.
    const gifted = exportWith([JSON.stringify(backingGrant("gift", "7790", "109"))]);
    const result = analyze(gifted, julySnapshot(), NOW_MS);
    assert.equal(
      opFor(
        result.plan.ops,
        "entitlement_grant",
        ids.backingEntitlement("rails_gift", "7790", "109"),
      ),
      undefined,
    );
    const receipt = buildReceipt(gifted, result, CTX);
    assert.equal(receipt.backingGrants.backedWithoutPro.rails_gift, 1);
    assert.equal(receipt.backingGrants.bySourceType.rails_gift, 1, "only 120's gift");
    assert.equal(receipt.gate.pass, true, receipt.gate.failures.join());
    // `basic` counts as pro for Rails' Ability: 114's gift grants.
    const basic = exportWith([JSON.stringify(backingGrant("gift", "7791", "114"))]);
    assert.ok(
      opFor(
        analyze(basic, julySnapshot(), NOW_MS).plan.ops,
        "entitlement_grant",
        ids.backingEntitlement("rails_gift", "7791", "114"),
      ),
    );
  });

  void test("bare pro: signed in within 365 days is granted lenient; dormant holders are held and never touched", () => {
    const bare = exportWith([
      JSON.stringify(railsUser("130")),
      proLine("130", "2026-06-01"),
      JSON.stringify(railsUser("131")),
      proLine("131", "2020-01-01"),
      JSON.stringify(railsUser("132")),
      proLine("132", null),
    ]);
    const result = analyze(bare, julySnapshot(), NOW_MS);
    const row = projectionIds.entitlement("rails_bare_pro_active:130");
    const grant = opFor(result.plan.ops, "entitlement_grant", row);
    assert.ok(grant && grant.kind === "entitlement_grant");
    assert.equal(grant.entitlement.sourceType, "rails_bare_pro_active");
    assert.equal(grant.entitlement.expiresAt, null);
    assert.equal(grant.entitlement.metadata["accessLaw"], "lenient_status_v1");
    assert.ok(opFor(result.plan.ops, "user_create", ids.user("130")));
    for (const dormant of ["131", "132"]) {
      assert.ok(noOpNames(result.plan.ops, ids.user(dormant)), `${dormant} is out of scope`);
    }
    const receipt = buildReceipt(bare, result, CTX);
    assert.deepEqual(receipt.proCrossCheck.bareProHolders.railsUserIds, ["131", "132"]);
    assert.deepEqual(receipt.proCrossCheck.bareProActive.railsUserIds, ["130"]);
    assert.deepEqual(receipt.proCrossCheck.bareProSignIn, {
      within90Days: 0,
      within1Year: 1,
      within3Years: 0,
      older: 1,
      never: 1,
    });
    assert.match(receipt.gate.failures.join("\n"), /first run: 1 rails_bare_pro_active grants/);
    assert.match(receipt.gate.failures.join("\n"), /2 bare pro holders/);
    const accepted = buildReceipt(
      bare,
      result,
      ctx({
        acceptFirstBacking: { ...FIXTURE_FIRST_BACKING, rails_bare_pro_active: 1 },
        acceptBarePro: railsIdListSha256(["131", "132"]),
      }),
    );
    assert.equal(accepted.gate.pass, true, accepted.gate.failures.join());
    assert.equal(analysis.after.summary.underGrantUsers, 0);
    // A zero-day window holds 130 as well.
    const closed = analyze(bare, julySnapshot(), NOW_MS, { bareProActiveDays: 0 });
    assert.equal(opFor(closed.plan.ops, "entitlement_grant", row), undefined);
  });

  void test("bare pro: an earlier run's row stays while Rails keeps pro, and goes when pro goes", () => {
    const row = projectionIds.entitlement("rails_bare_pro_active:131");
    const snapshot = julySnapshot();
    const earlier: CbSnapshot = {
      ...snapshot,
      users: [
        ...snapshot.users,
        {
          id: ids.user("131"),
          email: "u131@example.test",
          legacyRailsUserId: "131",
          matchedExportEmails: [],
        },
      ],
      entitlements: [
        ...snapshot.entitlements,
        liveRow({
          id: row,
          entitlementType: "egghead_all_access_subscription",
          userId: ids.user("131"),
          sourceType: "rails_bare_pro_active",
          sourceId: "131",
          metadata: { railsUserId: "131" },
          expiresAt: null,
        }),
      ],
    };
    const dormant = exportWith([JSON.stringify(railsUser("131")), proLine("131", "2020-01-01")]);
    const kept = analyze(dormant, earlier, NOW_MS);
    assert.equal(opFor(kept.plan.ops, "entitlement_revoke", row), undefined);
    assert.deepEqual(
      kept.plan.barePro.kept.map((holder) => holder.railsUserId),
      ["131"],
    );
    const receipt = buildReceipt(dormant, kept, CTX);
    assert.equal(receipt.proCrossCheck.bareProActive.keptFromEarlierRun, 1);
    assert.deepEqual(receipt.proCrossCheck.bareProHolders.railsUserIds, []);
    // Rails removed the role: the row goes.
    const stripped = exportWith([JSON.stringify(railsUser("131"))]);
    assert.ok(opFor(analyze(stripped, earlier, NOW_MS).plan.ops, "entitlement_revoke", row));
  });

  void test("#2.11: basic holders and membership purchasers are never bare", () => {
    const lines = [
      proLine("114", null),
      proLine("113", null),
      JSON.stringify({
        kind: "purchase",
        railsSellablePurchaseId: "6113",
        railsUserId: "113",
        sellableType: "Resource::Membership",
        sellableId: "1",
        purchaseState: "paid",
        bulk: false,
        restrictedToCountry: null,
        expiresAt: null,
        createdAt: "2026-10-01 00:00:00",
      }),
    ];
    const result = analyze(exportWith(lines), julySnapshot(), NOW_MS);
    const receipt = buildReceipt(exportWith(lines), result, CTX);
    assert.equal(receipt.proCrossCheck.bareProHolders.count, 0);
    assert.equal(receipt.proCrossCheck.exportHasRailsLacks, 0);
    assert.deepEqual(spreadSample(["1", "2", "3"], 20), ["1", "2", "3"]);
    const many = Array.from({ length: 100 }, (_, index) => String(index));
    const sample = spreadSample(many);
    assert.equal(sample.length, 20);
    assert.equal(sample[0], "0");
    assert.equal(sample[19], "99");
  });

  void test("rails_legacy_pro_role quarantine rows survive every hold: bare, backed and stale", () => {
    const variants = {
      bare: [proLine("104", null)],
      backed: [
        proLine("104", null),
        JSON.stringify(backingGrant("gift", "7792", "104", { expiresAt: "2027-01-01 00:00:00" })),
      ],
      stale: [
        proLine("104", null),
        JSON.stringify(
          backingGrant("legacy_subscription", "7793", "104", { currentPeriodEnd: "2026-01-01" }),
        ),
      ],
    };
    for (const [name, lines] of Object.entries(variants)) {
      const result = analyze(exportWith(lines), julySnapshot(), NOW_MS);
      assert.ok(noOpNames(result.plan.ops, QUARANTINE_ENTITLEMENT), name);
      const simulated = simulateApply(julySnapshot(), result.plan.ops, NOW_ISO);
      const row = simulated.entitlements.find((entry) => entry.id === QUARANTINE_ENTITLEMENT);
      assert.equal(row?.deletedAt, null, name);
    }
  });

  void test("#1.1: an orphan Rails user is held: granted nothing, and their rows and seat are kept", () => {
    const lines = novemberData().filter((value) => !value.includes('"railsUserId":"101","email"'));
    const orphaned = parseRailsAccessExport(exportText(lines));
    assert.deepEqual(orphaned.orphanRailsUserIds, ["101"]);
    const result = analyze(orphaned, julySnapshot(), NOW_MS);
    for (const id of [
      ids.seatEntitlement("9001", "8001"),
      ids.purchaseEntitlement("6009"),
      ids.membership("8001"),
    ]) {
      assert.ok(
        !result.plan.ops.some(
          (op) =>
            op.key.endsWith(`:${id}`) &&
            (op.kind === "entitlement_revoke" ||
              op.kind === "entitlement_expire" ||
              op.kind === "membership_revoke"),
        ),
        id,
      );
    }
    const receipt = buildReceipt(orphaned, result, CTX);
    assert.deepEqual(receipt.orphanGrants.railsUserIds, ["101"]);
    assert.match(receipt.gate.failures.join(), /1 Rails users have grant lines but no user line/);
    const accepted = buildReceipt(
      orphaned,
      result,
      ctx({ acceptOrphanGrants: railsIdListSha256(["101"]) }),
    );
    assert.equal(accepted.gate.pass, true, accepted.gate.failures.join());
  });

  void test("#2.3: keep accepts only the kept seat's over-grant, not the same user's other held seat", () => {
    const snapshot = julySnapshot();
    const seat = snapshot.memberships.find((row) => row.id === ids.membership("8007"));
    assert.ok(seat);
    const nativeRow = (id: string) =>
      liveRow({
        id,
        entitlementType: "egghead_all_access_subscription",
        userId: null,
        sourceType: "stripe_subscription",
        sourceId: id,
        metadata: {},
        expiresAt: "2026-12-31T00:00:00.000Z",
      });
    const twoSeats: CbSnapshot = {
      ...snapshot,
      memberships: [
        ...snapshot.memberships,
        Object.assign({}, seat, { id: "eh_orgmem_107_on_7010", organizationId: ids.org("7010") }),
      ],
      entitlements: [
        ...snapshot.entitlements,
        Object.assign(nativeRow("stripe_ent_team_7004"), {
          organizationId: ids.org("7004"),
        }),
        Object.assign(nativeRow("stripe_ent_team_7010"), {
          organizationId: ids.org("7010"),
        }),
      ],
    };
    const keepOne = analyze(railsExport, twoSeats, NOW_MS, {
      seatFlagRulings: new Map([[ids.membership("8007"), "keep"]]),
    });
    const one = buildReceipt(railsExport, keepOne, CTX);
    assert.equal(one.overGrantAcceptedBySeatFlagKeep, 0);
    assert.match(one.gate.failures.join(), /1 users would still be over-granted/);
    const keepBoth = analyze(railsExport, twoSeats, NOW_MS, {
      seatFlagRulings: new Map([
        [ids.membership("8007"), "keep"],
        ["eh_orgmem_107_on_7010", "keep"],
      ]),
    });
    const both = buildReceipt(railsExport, keepBoth, CTX);
    assert.equal(both.overGrantAcceptedBySeatFlagKeep, 1);
    assert.equal(both.gate.pass, true, both.gate.failures.join());
  });

  void test("#2.4: ShadowResult.users is the full list; the gate refuses a summary that disagrees", () => {
    for (const shadow of [analysis.before, analysis.after]) {
      assert.equal(
        shadow.users.filter((user) => user.overGrant.length > 0).length,
        shadow.summary.overGrantUsers,
      );
      assert.equal(
        shadow.users.filter((user) => user.underGrant.length > 0).length,
        shadow.summary.underGrantUsers,
      );
    }
    assert.equal(analysis.before.summary.overGrantUsers, 2);
    // 30 new learners: more under-granted users than any sample holds, all listed.
    const crowd = exportWith(
      Array.from({ length: 30 }, (_, index) =>
        learnerLines(String(150 + index), `crowd${index}@example.test`, String(800 + index)),
      ).flat(),
    );
    const crowded = analyze(crowd, julySnapshot(), NOW_MS);
    assert.ok(crowded.before.summary.underGrantUsers >= 30);
    assert.equal(
      crowded.before.users.filter((user) => user.underGrant.length > 0).length,
      crowded.before.summary.underGrantUsers,
    );
    const doctored: DeltaAnalysis = {
      ...analysis,
      after: {
        ...analysis.after,
        summary: {
          ...analysis.after.summary,
          overGrantUsers: analysis.after.summary.overGrantUsers + 1,
        },
      },
    };
    assert.match(
      buildReceipt(railsExport, doctored, CTX).gate.failures.join(),
      /shadow summary disagrees with its user list/,
    );
  });

  void test("#2.5: gate inputs are compared field by field, record key order ignored", () => {
    const base = CTX.gateInputs;
    assert.deepEqual(gateInputsDiff(base, base), []);
    assert.deepEqual(
      gateInputsDiff(base, Object.assign({}, base, { allowLargeRevoke: true, acceptBarePro: "x" })),
      ["allowLargeRevoke", "acceptBarePro"],
    );
    const reordered = Object.assign({}, base, {
      acceptFirstBacking: {
        rails_managed_subscription: 1,
        rails_legacy_subscription: 1,
        rails_gift: 1,
      },
    });
    assert.deepEqual(gateInputsDiff(base, reordered), []);
    const text = serializePlan({
      exportSha256: railsExport.sha256,
      database: "fixture_test",
      hostSha256: hostSha256("127.0.0.1"),
      pass: "full",
      gateInputs: base,
      generatedAt: NOW_ISO,
      ops: analysis.plan.ops,
    });
    assert.deepEqual(parsePlan(text).gateInputs, base);
  });

  void test("#2.6: identity ops over --max-identity-ops, or any colliding identity write, fail either pass", () => {
    const lines = novemberData().map((value) =>
      value.includes('"railsUserId":"101","email"')
        ? value.replace('"u101@example.test"', '"moved101@example.test"')
        : value,
    );
    const moved = parseRailsAccessExport(exportText(lines));
    const identity = analyze(moved, julySnapshot(), NOW_MS, { pass: "identity" });
    assert.equal(identity.identityOps.count, 2, "101's email update and 111's link");
    assert.equal(buildReceipt(moved, identity, CTX).gate.pass, true);
    const capped = buildReceipt(moved, identity, ctx({ maxIdentityOps: 0 }));
    assert.match(capped.gate.failures.join(), /2 identity ops .* exceed --max-identity-ops 0/);
    const collided: DeltaAnalysis = {
      ...identity,
      identityOps: {
        ...identity.identityOps,
        collisions: { sameTarget: 1, targetHeld: 0, linkConflicts: 0, total: 1 },
      },
    };
    assert.match(
      buildReceipt(moved, collided, CTX).gate.failures.join(),
      /identity writes collide/,
    );

    const users = [
      { id: "a", email: "a@example.test", legacyRailsUserId: "1", matchedExportEmails: [] },
      { id: "b", email: "b@example.test", legacyRailsUserId: null, matchedExportEmails: [] },
    ];
    assert.deepEqual(
      emailMoveCollisions(
        [
          emailUpdateOp("a", "B@example.test"),
          emailUpdateOp("c", "new@example.test"),
          emailUpdateOp("d", "new@example.test"),
          linkOp("b", "2"),
          linkOp("b", "3"),
          linkOp("a", "4"),
        ],
        { users, exportEmailKeys: {} },
      ),
      { sameTarget: 1, targetHeld: 1, linkConflicts: 2, total: 4 },
    );
    assert.equal(emailMoveCollisions(analysis.plan.ops, julySnapshot()).total, 0);
  });

  void test("#2.7: type and organization changes count as access moves", () => {
    const snapshot = julySnapshot();
    const seat = ids.seatEntitlement("9001", "8001");
    const org = ids.subOrgEntitlement("9001", "7001");
    const changed: CbSnapshot = {
      ...snapshot,
      entitlements: [
        ...snapshot.entitlements.filter((row) => row.id !== seat && row.id !== org),
        ...snapshot.entitlements
          .filter((row) => row.id === seat)
          .map(
            (row): CbEntitlement =>
              Object.assign({}, row, { entitlementType: "egghead_lifetime_access" }),
          ),
        ...snapshot.entitlements
          .filter((row) => row.id === org)
          .map((row): CbEntitlement => Object.assign({}, row, { organizationId: ids.org("7003") })),
      ],
    };
    const result = analyze(railsExport, changed, NOW_MS);
    const reasons = (id: string) => {
      const op = opFor(result.plan.ops, "entitlement_update", id);
      return op && op.kind === "entitlement_update" ? op.reasons : [];
    };
    assert.ok(reasons(seat).includes("entitlementType_changed"));
    assert.ok(reasons(org).includes("organizationId_changed"));
    assert.equal(result.largeRevoke.entitlementMoves, 2);
  });

  void test("#3.5: a gift past MySQL's 2038 limit never expires, as purchases do", () => {
    const longGift = exportWith([
      JSON.stringify(backingGrant("gift", "7794", "101", { expiresAt: "2050-01-01 00:00:00" })),
    ]);
    const op = opFor(
      analyze(longGift, julySnapshot(), NOW_MS).plan.ops,
      "entitlement_grant",
      ids.backingEntitlement("rails_gift", "7794", "101"),
    );
    assert.ok(op && op.kind === "entitlement_grant");
    assert.equal(op.entitlement.expiresAt, null);
  });
});

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

    const database = new URL(mysqlUrl ?? "mysql://x/none").pathname.slice(1);

    /** The CLI with the fixture's first-run acceptances (dry run and apply must match). */
    function cli(args: readonly string[]) {
      return cliRaw([...args, ...FIXTURE_ACCEPT_ARGS]);
    }

    /** The CLI as a child process against the fixture database, flags as given. */
    function cliRaw(args: readonly string[], env: Record<string, string> = {}) {
      return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
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
              ...env,
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
    }

    function apply(file: string, out: string, extra: readonly string[]) {
      return cli([
        "--export",
        file,
        "--out",
        out,
        "--apply",
        "--confirm-database",
        database,
        ...extra,
      ]);
    }

    function resume(file: string, out: string, extra: readonly string[]) {
      return cli([
        "--export",
        file,
        "--out",
        out,
        "--resume",
        "--confirm-database",
        database,
        ...extra,
      ]);
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
      assert.equal(analysis.before.summary.underGrantUsers, 10);
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
      // 120 gift, 121 managed subscription, 122 legacy subscription (backed pro).
      const granted = [
        "101",
        "103",
        "105",
        "106",
        "108",
        "110",
        "114",
        "115",
        "120",
        "121",
        "122",
      ].map(ids.user);
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
      assert.equal(users[0]?.["n"], 19, "no duplicate users");
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
        (error: unknown) =>
          error instanceof store.UserCreateCollisionError &&
          /Dry-run into a NEW --out folder/.test(error.message),
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
      const writeExport = (name: string, lines: readonly string[], ageMs: number) =>
        writeExportIn(dir, name, lines, ageMs);
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
        // #2.5: the allowance must be in the reviewed dry run, not added at apply.
        const added = await apply(fresh, freshOut, ["--expect-plan", sha, "--allow-large-revoke"]);
        assert.equal(added.code, 1);
        assert.match(
          added.stderr,
          /gate inputs differ from the reviewed dry run \(allowLargeRevoke\)/,
        );
        const reviewed = await cli(["--export", fresh, "--out", freshOut, "--allow-large-revoke"]);
        assert.match(reviewed.stderr, /gate pass/);
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

    void test("#11: an identity pass then a full pass clears an X->Y move plus a new signup on X", async () => {
      await resetToJuly();
      const lines = novemberData().map((value) =>
        value.includes('"railsUserId":"101","email"')
          ? value.replace('"u101@example.test"', '"moved101@example.test"')
          : value,
      );
      const chain = parseRailsAccessExport(
        exportText([...lines, ...learnerLines("140", "u101@example.test", "700")]),
      );
      const identity = await run.analyzeDatabase(db, chain, NOW_MS, SMALL, { pass: "identity" });
      assert.deepEqual(
        identity.plan.ops.map((op) => op.kind),
        ["user_email_update", "user_link"],
      );
      await applyAll(identity.plan.ops, cursorFor(identity.plan.ops), { batchSize: 10 }, chain);
      const full = await run.analyzeDatabase(db, chain, NOW_MS, SMALL);
      const receipt = run.buildReceipt(chain, full, CTX);
      assert.equal(receipt.gate.pass, true, receipt.gate.failures.join());
      const result = await applyAll(
        full.plan.ops,
        cursorFor(full.plan.ops),
        { batchSize: 10 },
        chain,
      );
      assert.equal(result.verify.remainingOps, 0);
      assert.equal(result.timing.batches, Math.ceil(full.plan.ops.length / 10));
      const emails = await query(
        "SELECT id, email FROM egghead_User WHERE id IN (?, ?) ORDER BY id",
        [ids.user("101"), ids.user("140")],
      );
      assert.deepEqual(
        emails.map((row) => String(row["email"])).toSorted((a, b) => a.localeCompare(b)),
        ["moved101@example.test", "u101@example.test"],
      );
      assert.equal((await runtimeAccess(ids.user("101"))).granted, true);
    });

    void test("#13/#16/#11: CLI resume checks, the collision way out, the out folder guard and the identity pass", async () => {
      await resetToJuly();
      const dir = await mkdtemp(path.join(tmpdir(), "access-delta-cli2-"));
      try {
        // #16: a folder inside the repo is refused; an existing loose folder becomes 0700.
        const fresh = await writeExportIn(dir, "fresh.jsonl", novemberData(), 60_000);
        const inside = await cli([
          "--export",
          fresh,
          "--out",
          path.join(process.cwd(), "out-here"),
        ]);
        assert.equal(inside.code, 64);
        assert.match(inside.stderr, /inside the git work tree/);
        const loose = path.join(dir, "loose");
        await mkdir(loose, { mode: 0o755 });
        await chmod(loose, 0o755);

        // #13: stop after one batch; --resume needs the sha and gets the same checks.
        const first = await cli(["--export", fresh, "--out", loose]);
        assert.equal(first.code, 0, first.stderr);
        assert.equal((await stat(loose)).mode & 0o777, 0o700);
        const sha = await planShaIn(loose);
        const stopped = await apply(fresh, loose, [
          "--expect-plan",
          sha,
          "--batch-size",
          "10",
          "--max-batches",
          "1",
        ]);
        assert.equal(stopped.code, 3, stopped.stderr);
        const resumeNoSha = await resume(fresh, loose, []);
        assert.equal(resumeNoSha.code, 1);
        assert.match(resumeNoSha.stderr, /refusing --resume:[\s\S]*needs --expect-plan/);
        const resumed = await resume(fresh, loose, ["--expect-plan", sha]);
        assert.equal(resumed.code, 0, resumed.stderr);

        // #13: an old export may start with a wider --max-export-age, but resume checks age again.
        await resetToJuly();
        const old = await writeExportIn(dir, "old.jsonl", novemberData(), 3 * 3_600_000);
        const oldOut = path.join(dir, "old");
        assert.equal((await cli(["--export", old, "--out", oldOut])).code, 0);
        const oldSha = await planShaIn(oldOut);
        const oldStart = await apply(old, oldOut, [
          "--expect-plan",
          oldSha,
          "--max-export-age",
          "4h",
          "--batch-size",
          "10",
          "--max-batches",
          "1",
        ]);
        assert.equal(oldStart.code, 3, oldStart.stderr);
        const oldResume = await resume(old, oldOut, ["--expect-plan", oldSha]);
        assert.equal(oldResume.code, 1);
        assert.match(oldResume.stderr, /minutes old, over --max-export-age 120 minutes/);
        // A drifted database also blocks resume: a new owned row the saved plan does not revoke.
        await query(
          `INSERT INTO egghead_Entitlement (id, entitlementType, userId, sourceType, sourceId, metadata)
           VALUES ('eh_entitlement_cli_drift', 'egghead_playlist_access', ?, 'rails_sellable_purchase', 'cli-drift', '{}')`,
          [ids.user("101")],
        );
        const drifted = await resume(old, oldOut, [
          "--expect-plan",
          oldSha,
          "--max-export-age",
          "4h",
        ]);
        assert.equal(drifted.code, 1);
        assert.match(drifted.stderr, /ops the saved plan does not have.*NEW --out folder/s);

        // The collision way out: a NEW --out dry run, then apply that plan.
        await resetToJuly();
        const collisionExport = await writeExportIn(dir, "collide.jsonl", novemberData(), 60_000);
        const plannedOut = path.join(dir, "planned");
        assert.equal((await cli(["--export", collisionExport, "--out", plannedOut])).code, 0);
        await query(
          "INSERT INTO egghead_User (id, email, name, role, fields) VALUES (?, ?, ?, 'user', '{}')",
          ["cb-cli-signup-103", "u103@example.test", "Signup"],
        );
        const collided = await apply(collisionExport, plannedOut, [
          "--expect-plan",
          await planShaIn(plannedOut),
        ]);
        assert.equal(collided.code, 1);
        assert.match(collided.stderr, /changed since the reviewed dry run.*NEW --out folder/s);
        const retryOut = path.join(dir, "planned-2");
        const retryDry = await cli(["--export", collisionExport, "--out", retryOut]);
        assert.match(retryDry.stderr, /gate pass/);
        const retried = await apply(collisionExport, retryOut, [
          "--expect-plan",
          await planShaIn(retryOut),
        ]);
        assert.equal(retried.code, 0, retried.stderr);
        const receipt: unknown = JSON.parse(
          await readFile(path.join(retryOut, "apply-receipt.json"), "utf8"),
        );
        const applied =
          typeof receipt === "object" && receipt !== null ? Reflect.get(receipt, "apply") : null;
        assert.equal(
          typeof applied === "object" && applied !== null
            ? Reflect.get(applied, "batchSize")
            : null,
          100,
        );
        const timing =
          typeof applied === "object" && applied !== null ? Reflect.get(applied, "timing") : null;
        assert.ok(
          typeof timing === "object" && timing !== null && Reflect.get(timing, "batches") === 1,
        );

        // #11: an X->Y move plus a new signup on X fails the full gate; the identity pass clears it.
        await resetToJuly();
        const moved = novemberData().map((value) =>
          value.includes('"railsUserId":"101","email"')
            ? value.replace('"u101@example.test"', '"moved101@example.test"')
            : value,
        );
        const chain = await writeExportIn(
          dir,
          "chain.jsonl",
          [...moved, ...learnerLines("140", "u101@example.test", "700")],
          60_000,
        );
        assert.match(
          (await cli(["--export", chain, "--out", path.join(dir, "chain-full")])).stderr,
          /gate FAIL/,
        );
        const identityOut = path.join(dir, "chain-identity");
        const identityDry = await cli(["--export", chain, "--out", identityOut, "--identity-pass"]);
        assert.match(identityDry.stderr, /dry-run \(identity pass\): 2 changes.*gate pass/);
        const identitySha = await planShaIn(identityOut);
        const wrongPass = await apply(chain, identityOut, ["--expect-plan", identitySha]);
        assert.match(wrongPass.stderr, /identity pass; add --identity-pass/);
        const identityApply = await apply(chain, identityOut, [
          "--expect-plan",
          identitySha,
          "--identity-pass",
        ]);
        assert.equal(identityApply.code, 0, identityApply.stderr);
        const fullOut = path.join(dir, "chain-full-2");
        assert.match((await cli(["--export", chain, "--out", fullOut])).stderr, /gate pass/);
        const fullApply = await apply(chain, fullOut, ["--expect-plan", await planShaIn(fullOut)]);
        assert.equal(fullApply.code, 0, fullApply.stderr);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    void test("#2.2: the runtime denies an expired rails_gift row and grants a live one (by source type)", async () => {
      await resetToJuly();
      const user = ids.user("104");
      assert.equal((await runtimeAccess(user)).granted, false, "104 starts with no access");
      const insert = (id: string, sourceType: string, expiresAt: string) =>
        query(
          `INSERT INTO egghead_Entitlement (id, entitlementType, userId, sourceType, sourceId, metadata, expiresAt)
           VALUES (?, 'egghead_all_access_subscription', ?, ?, ?, ?, ?)`,
          [
            id,
            user,
            sourceType,
            id,
            JSON.stringify({ accessLaw: "lenient_status_v1" }),
            new Date(expiresAt),
          ],
        );
      await insert("eh_entitlement_gift_expired", "rails_gift", "2026-01-01T00:00:00.000Z");
      assert.equal((await runtimeAccess(user)).granted, false, "an expired gift grants nothing");
      await insert("eh_entitlement_gift_live", "rails_gift", "2037-01-01T00:00:00.000Z");
      assert.equal((await runtimeAccess(user)).granted, true, "a live gift grants");
    });

    void test("held pro holders keep their rails_legacy_pro_role row byte for byte through a real apply", async () => {
      await resetToJuly();
      const quarantine = () =>
        query("SELECT * FROM egghead_Entitlement WHERE id = ?", [QUARANTINE_ENTITLEMENT]);
      const quarantineBefore = JSON.stringify(await quarantine());
      // 104 holds `pro` with a gift (backed) on one run, bare on the next.
      const backed = exportWith([
        JSON.stringify({ kind: "pro_holder", railsUserId: "104", lastSignInOn: null }),
        JSON.stringify(backingGrant("gift", "7795", "104", { expiresAt: "2027-01-01 00:00:00" })),
      ]);
      const first = await run.analyzeDatabase(db, backed, NOW_MS, SMALL);
      assert.ok(!first.plan.ops.some((op) => op.key.endsWith(`:${QUARANTINE_ENTITLEMENT}`)));
      await applyAll(first.plan.ops, cursorFor(first.plan.ops), { batchSize: 10 }, backed);
      assert.equal((await runtimeAccess(ids.user("104"))).granted, true);
      const bare = exportWith([
        JSON.stringify({ kind: "pro_holder", railsUserId: "104", lastSignInOn: null }),
      ]);
      const second = await run.analyzeDatabase(db, bare, NOW_MS, SMALL);
      assert.ok(!second.plan.ops.some((op) => op.key.endsWith(`:${QUARANTINE_ENTITLEMENT}`)));
      await applyAll(second.plan.ops, cursorFor(second.plan.ops), { batchSize: 10 }, bare);
      assert.equal(JSON.stringify(await quarantine()), quarantineBefore);
    });

    void test("#2.5 and CLI paths: gate inputs bind the plan; --previous-receipt, default --out and flag errors", async () => {
      await resetToJuly();
      const dir = await mkdtemp(path.join(tmpdir(), "access-delta-cli3-"));
      try {
        const file = await writeExportIn(dir, "fresh.jsonl", novemberData(), 60_000);
        const first = path.join(dir, "first");
        const dry = await cli(["--export", file, "--out", first]);
        assert.equal(dry.code, 0, dry.stderr);
        assert.match(dry.stderr, /gate pass/);
        const plan = parsePlan(await readFile(path.join(first, "plan.json"), "utf8"));
        assert.deepEqual(plan.gateInputs.acceptFirstBacking, FIXTURE_FIRST_BACKING);
        assert.equal(plan.gateInputs.acceptStaleLegacy, FIXTURE_STALE_LEGACY_SHA);
        const sha = plan.planSha256;
        // A flag the dry run did not have refuses the apply.
        const extra = await apply(file, first, ["--expect-plan", sha, "--allow-large-revoke"]);
        assert.equal(extra.code, 1);
        assert.match(
          extra.stderr,
          /gate inputs differ from the reviewed dry run \(allowLargeRevoke\)/,
        );
        // Leaving off an acceptance refuses too (the gate inputs differ before the gate runs).
        const missing = await cliRaw([
          "--export",
          file,
          "--out",
          first,
          "--apply",
          "--confirm-database",
          database,
          "--expect-plan",
          sha,
        ]);
        assert.equal(missing.code, 1);
        assert.match(missing.stderr, /acceptStaleLegacy, acceptFirstBacking/);

        // --previous-receipt replaces the first-run acceptance and is bound by its sha.
        const second = path.join(dir, "second");
        const receiptFile = path.join(first, "receipt.json");
        const withPrevious = await cliRaw([
          "--export",
          file,
          "--out",
          second,
          "--previous-receipt",
          receiptFile,
          "--accept-stale-legacy",
          FIXTURE_STALE_LEGACY_SHA,
        ]);
        assert.equal(withPrevious.code, 0, withPrevious.stderr);
        assert.match(withPrevious.stderr, /gate pass/);
        const secondPlan = parsePlan(await readFile(path.join(second, "plan.json"), "utf8"));
        assert.equal(
          secondPlan.gateInputs.previousReceiptSha256,
          createHash("sha256")
            .update(await readFile(receiptFile, "utf8"))
            .digest("hex"),
        );

        // No --out: a new 0700 folder under $XDG_STATE_HOME.
        const state = path.join(dir, "state");
        const defaulted = await cliRaw(["--export", file, ...FIXTURE_ACCEPT_ARGS], {
          XDG_STATE_HOME: state,
        });
        assert.equal(defaulted.code, 0, defaulted.stderr);
        const receiptPath = /receipt (\S+receipt\.json)/.exec(defaulted.stderr)?.[1] ?? "";
        assert.ok(
          receiptPath.startsWith(path.join(state, "egghead-access-delta", "run-")),
          receiptPath,
        );
        assert.equal((await stat(path.dirname(receiptPath))).mode & 0o777, 0o700);

        // Writes need an explicit --out; malformed flags are usage errors.
        const noOut = await cliRaw(["--export", file, "--apply", "--confirm-database", database]);
        assert.equal(noOut.code, 64);
        assert.match(noOut.stderr, /--apply and --resume need --out/);
        const badRuling = await cli([
          "--export",
          file,
          "--out",
          first,
          "--held-seat-flag",
          "x=maybe",
        ]);
        assert.equal(badRuling.code, 64);
        assert.match(badRuling.stderr, /expected <membershipId>=clear/);
        const badBacking = await cliRaw([
          "--export",
          file,
          "--out",
          first,
          "--accept-first-backing",
          "rails_gold=1",
        ]);
        assert.equal(badBacking.code, 64);
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
