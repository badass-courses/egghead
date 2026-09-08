#!/usr/bin/env bun
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";

import { resolveAuthSecret } from "../apps/web/src/coursebuilder/auth-secret";
import {
  createTeamInviteToken,
  teamInviteMatchesEmail,
  verifyTeamInviteToken,
  type TeamInvitePayload,
} from "../apps/web/src/subscriptions/team-invite-token";
import {
  consumeTeamInvitation,
  findPendingTeamInvitation,
  issueTeamInvitation,
  listTeamInvitations,
  revokeTeamInvitation,
  TEAM_INVITATION_LIFETIME_MS,
} from "../apps/web/src/subscriptions/team-invitation-state";
import { planOwnerGithubDisconnect } from "../apps/web/src/profile/github-disconnect";

const originalSecret = process.env["AUTH_SECRET"];
const originalNow = Date.now;
const now = 1_900_000_000_000;
const secret = randomBytes(32).toString("hex");
const payload: TeamInvitePayload = {
  invitationId: "ca529056-c78b-4e5d-87a1-7f7a62cd784e",
  subscriptionId: "identity-contract-subscription",
  email: "invitee@example.test",
  expiresAt: now + TEAM_INVITATION_LIFETIME_MS,
};
const ownerId = "identity-contract-owner";
const actor = { userId: "identity-contract-member", email: "INVITEE@example.test" };
const baseFields = { ownerId, seats: 2, subscriptionKind: "team", billingMarker: "preserve" };
const checks: { name: string; pass: true }[] = [];
let runningCheck = "identity contract";

function check(name: string, run: () => void) {
  runningCheck = name;
  run();
  checks.push({ name, pass: true });
}

async function checkDatabaseContracts() {
  runningCheck = "local persisted identity boundaries";
  const { getEggheadDatabase } = await import("../apps/web/src/db/adapter");
  const {
    assertCommerceWritesAllowed,
    assertLocalDockerDatabaseUrl,
    createLocalMysqlConnection,
    getEggheadMysqlPool,
  } = await import("../apps/web/src/db/local-docker");
  const { getEggheadTableName } = await import("../apps/web/src/db/mysql-table");
  const { consumeAuthVerificationToken } =
    await import("../apps/web/src/coursebuilder/auth-verification-token");
  const { issueOwnedTeamInvitation, listOwnedTeamInvitations, revokeOwnedTeamInvitation } =
    await import("../apps/web/src/subscriptions/team-invitations");
  assertLocalDockerDatabaseUrl();
  assertCommerceWritesAllowed();
  const db = getEggheadDatabase();
  const fixtureId = `identity-contract-${randomUUID()}`;
  const identifier = `${randomUUID()}@example.test`;
  const token = randomBytes(32).toString("hex");
  const expiredToken = randomBytes(32).toString("hex");
  const connection = await createLocalMysqlConnection();
  const tokenTable = getEggheadTableName("VerificationToken");
  const subscriptionTable = getEggheadTableName("Subscription");
  try {
    await connection.execute(
      `INSERT INTO ${tokenTable} (identifier, token, expires) VALUES (?, ?, ?), (?, ?, ?)`,
      [
        identifier,
        token,
        new Date(originalNow() + 60_000),
        identifier,
        expiredToken,
        new Date(originalNow() - 60_000),
      ],
    );
    assert.equal(
      await consumeAuthVerificationToken({ identifier: "wrong@example.test", token }),
      null,
    );
    const results = await Promise.all([
      consumeAuthVerificationToken({ identifier, token }),
      consumeAuthVerificationToken({ identifier, token }),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await consumeAuthVerificationToken({ identifier, token }), null);
    assert.equal(await consumeAuthVerificationToken({ identifier, token: expiredToken }), null);
    checks.push({
      name: "persisted magic links reject expiry, wrong identifier, and concurrent replay",
      pass: true,
    });

    await connection.execute(
      `INSERT INTO ${subscriptionTable} (id, productId, merchantSubscriptionId, status, fields) VALUES (?, ?, ?, ?, ?)`,
      [
        fixtureId,
        `${fixtureId}-product`,
        `${fixtureId}-merchant`,
        "active",
        JSON.stringify(baseFields),
      ],
    );
    const issueInput = { subscriptionId: fixtureId, ownerId, email: payload.email };
    assert.equal(await issueOwnedTeamInvitation({ ...issueInput, ownerId: "wrong-owner" }), null);
    const issued = await Promise.all([
      issueOwnedTeamInvitation(issueInput),
      issueOwnedTeamInvitation(issueInput),
    ]);
    const [first] = issued;
    assert.ok(first);
    assert.equal(
      (await listOwnedTeamInvitations({ subscriptionId: fixtureId, ownerId })).length,
      2,
    );
    assert.deepEqual(
      await listOwnedTeamInvitations({ subscriptionId: fixtureId, ownerId: "wrong-owner" }),
      [],
    );
    assert.equal(
      await revokeOwnedTeamInvitation({
        ...issueInput,
        invitationId: first.payload.invitationId,
        ownerId: "wrong-owner",
      }),
      false,
    );
    assert.equal(
      await revokeOwnedTeamInvitation({ ...issueInput, invitationId: first.payload.invitationId }),
      true,
    );
    const stored = await db.query.subscription.findFirst({
      where: (table, { eq }) => eq(table.id, fixtureId),
    });
    assert.ok(stored);
    assert.equal(findPendingTeamInvitation(stored.fields, first.payload), null);
    assert.equal(stored.fields?.["billingMarker"], "preserve");
    checks.push({
      name: "persisted issue/revoke is owner-scoped and concurrent issues preserve both records",
      pass: true,
    });
  } finally {
    try {
      await connection.execute(
        `DELETE FROM ${tokenTable} WHERE identifier = ? AND token IN (?, ?)`,
        [identifier, token, expiredToken],
      );
      await connection.execute(`DELETE FROM ${subscriptionTable} WHERE id = ?`, [fixtureId]);
    } finally {
      await Promise.all([connection.end(), getEggheadMysqlPool().end()]);
    }
  }
}

try {
  process.env["AUTH_SECRET"] = secret;
  Date.now = () => now;

  check("signing secret fallback exists only in local development", () => {
    assert.equal(
      typeof resolveAuthSecret({ secret: undefined, runtime: "local", nodeEnv: "development" }),
      "string",
    );
    assert.equal(
      typeof resolveAuthSecret({ secret: undefined, runtime: "local", nodeEnv: undefined }),
      "string",
    );
    for (const runtime of ["beta", "production"] as const) {
      assert.throws(() =>
        resolveAuthSecret({ secret: undefined, runtime, nodeEnv: "development" }),
      );
      assert.throws(() =>
        resolveAuthSecret({
          secret: "local-dev-only-egghead-phase-0",
          runtime,
          nodeEnv: "production",
        }),
      );
      assert.equal(resolveAuthSecret({ secret, runtime, nodeEnv: "production" }), secret);
    }
    for (const nodeEnv of ["production", "test"]) {
      assert.throws(() => resolveAuthSecret({ secret: undefined, runtime: "local", nodeEnv }));
    }
    assert.throws(() =>
      resolveAuthSecret({ secret: "short", runtime: "beta", nodeEnv: "production" }),
    );
    assert.throws(() =>
      resolveAuthSecret({ secret: " ".repeat(40), runtime: "beta", nodeEnv: "production" }),
    );
  });

  check("signed invitations require email, expiry and invitation identity", () => {
    const token = createTeamInviteToken({ ...payload, email: " INVITEE@example.test " });
    assert.deepEqual(verifyTeamInviteToken(token), payload);
    assert.equal(teamInviteMatchesEmail(payload, actor.email), true);
    assert.equal(teamInviteMatchesEmail(payload, "someone-else@example.test"), false);
    assert.equal(verifyTeamInviteToken(`${token}tampered`), null);
    assert.equal(verifyTeamInviteToken(`${token}.extra`), null);
    const legacy = Buffer.from(JSON.stringify({ subscriptionId: payload.subscriptionId })).toString(
      "base64url",
    );
    const legacySignature = createHmac("sha256", secret).update(legacy).digest("base64url");
    assert.equal(verifyTeamInviteToken(`${legacy}.${legacySignature}`), null);
    assert.equal(
      verifyTeamInviteToken(createTeamInviteToken({ ...payload, expiresAt: now })),
      null,
    );
    assert.equal(
      verifyTeamInviteToken(createTeamInviteToken({ ...payload, expiresAt: now - 1 })),
      null,
    );
  });

  check("issue and list preserve fields and require the subscription owner", () => {
    const issued = issueTeamInvitation(baseFields, payload, ownerId, now);
    assert.ok(issued);
    assert.equal(issued["billingMarker"], "preserve");
    assert.equal(issueTeamInvitation(baseFields, payload, "wrong-owner", now), null);
    assert.equal(
      issueTeamInvitation(
        baseFields,
        { ...payload, expiresAt: payload.expiresAt + 1 },
        ownerId,
        now,
      ),
      null,
    );
    assert.equal(issueTeamInvitation(issued, payload, ownerId, now), null);
    assert.equal(listTeamInvitations(issued, payload.subscriptionId, ownerId).length, 1);
    assert.deepEqual(listTeamInvitations(issued, payload.subscriptionId, "wrong-owner"), []);
    assert.deepEqual(listTeamInvitations(issued, "other-subscription", ownerId), []);
  });

  check(
    "consume rejects mismatched, missing and expired persisted invitations without mutation",
    () => {
      const issued = issueTeamInvitation(baseFields, payload, ownerId, now);
      assert.ok(issued);
      const before = JSON.stringify(issued);
      assert.equal(consumeTeamInvitation(baseFields, payload, actor, now), null);
      assert.equal(
        consumeTeamInvitation(issued, payload, { ...actor, email: "other@example.test" }, now),
        null,
      );
      assert.equal(
        consumeTeamInvitation(
          issued,
          { ...payload, subscriptionId: "other-subscription" },
          actor,
          now,
        ),
        null,
      );
      assert.equal(
        consumeTeamInvitation(issued, { ...payload, email: "other@example.test" }, actor, now),
        null,
      );
      assert.equal(
        consumeTeamInvitation(issued, { ...payload, expiresAt: payload.expiresAt + 1 }, actor, now),
        null,
      );
      assert.equal(
        consumeTeamInvitation(issued, { ...payload, invitationId: randomUUID() }, actor, now),
        null,
      );
      assert.equal(consumeTeamInvitation(issued, payload, actor, payload.expiresAt), null);
      assert.equal(JSON.stringify(issued), before);
    },
  );

  check("consumed invitations cannot replay or reclaim a deliberately removed seat", () => {
    const issued = issueTeamInvitation(baseFields, payload, ownerId, now);
    assert.ok(issued);
    const consumed = consumeTeamInvitation(issued, payload, actor, now + 1);
    assert.ok(consumed);
    assert.equal(consumed["billingMarker"], "preserve");
    const [accepted] = listTeamInvitations(consumed, payload.subscriptionId, ownerId);
    assert.equal(accepted?.acceptedByUserId, actor.userId);
    assert.equal(accepted?.acceptedAt, now + 1);
    assert.equal(consumeTeamInvitation(consumed, payload, actor, now + 2), null);
    assert.equal(
      consumeTeamInvitation(
        { ...consumed, removedSeatUserId: actor.userId },
        payload,
        actor,
        now + 3,
      ),
      null,
    );
    assert.ok(findPendingTeamInvitation(issued, payload, now + 1));
  });

  check("revoked invites are rejected and revoke cannot cross ownership or subscription", () => {
    const issued = issueTeamInvitation(baseFields, payload, ownerId, now);
    assert.ok(issued);
    const revokeInput = {
      invitationId: payload.invitationId,
      subscriptionId: payload.subscriptionId,
      ownerId,
    };
    assert.equal(
      revokeTeamInvitation(issued, { ...revokeInput, ownerId: "wrong-owner" }, now),
      null,
    );
    assert.equal(
      revokeTeamInvitation(issued, { ...revokeInput, subscriptionId: "other-subscription" }, now),
      null,
    );
    const revoked = revokeTeamInvitation(issued, revokeInput, now + 1);
    assert.ok(revoked);
    assert.equal(revoked["billingMarker"], "preserve");
    assert.equal(consumeTeamInvitation(revoked, payload, actor, now + 2), null);
    assert.equal(revokeTeamInvitation(revoked, revokeInput, now + 2), null);
  });

  check("disconnect retains last sign-in method and profile ownership protections", () => {
    const input = {
      actorUserId: ownerId,
      profileUserId: ownerId,
      accounts: [
        { provider: "github", providerAccountId: "identity-contract-github", userId: ownerId },
      ],
      emailSignInAvailable: false,
    };
    assert.equal(planOwnerGithubDisconnect(input).status, "last-sign-in-method");
    assert.equal(
      planOwnerGithubDisconnect({ ...input, emailSignInAvailable: true }).status,
      "ready",
    );
    assert.throws(() => planOwnerGithubDisconnect({ ...input, actorUserId: "wrong-owner" }));
  });

  Date.now = originalNow;
  if (process.argv.includes("--database")) await checkDatabaseContracts();
  console.log(
    JSON.stringify({
      ok: true,
      checks,
      databaseChecksRun: process.argv.includes("--database"),
      externalCallbacksRun: false,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      check: runningCheck,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
} finally {
  Date.now = originalNow;
  if (originalSecret === undefined) delete process.env["AUTH_SECRET"];
  else process.env["AUTH_SECRET"] = originalSecret;
}
