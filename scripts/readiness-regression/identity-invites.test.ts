import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { beforeEach, mock, test } from "node:test";

import type * as AuthModule from "../../apps/web/src/coursebuilder/auth-config";
import type * as InviteModule from "../../apps/web/src/subscriptions/team-invite-token";
import { appImport, appModule, appRequire, resetRuntimeEnvironment } from "./fixtures";

const now = Date.UTC(2030, 0, 1);
const strongSecret = "regression-only-independent-signing-secret-0123456789";
const developmentSecret = "local-dev-only-egghead-phase-0";
const invite = {
  invitationId: "invitation-regression",
  subscriptionId: "subscription-regression",
  email: "invited@example.test",
  expiresAt: now + 60_000,
};

function signedInvitation(payload: Record<string, unknown>, secret = strongSecret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

type StoredToken = {
  identifier: string;
  token: string;
  expires: Date;
  createdAt: Date;
};
let storedToken: StoredToken | null = null;

// Only persistence is substituted. Both revisions use their actual published
// adapter; authConfig decides which consumption implementation Auth.js receives.
class TokenDatabase {
  select() {
    return {
      from() {
        return {
          where() {
            const rows = Promise.resolve(storedToken ? [{ ...storedToken }] : []);
            return Object.assign(rows, { for: () => rows });
          },
        };
      },
    };
  }
  delete() {
    return {
      async where() {
        storedToken = null;
      },
    };
  }
  async transaction<T>(operation: (transaction: TokenDatabase) => Promise<T>): Promise<T> {
    const before = storedToken;
    try {
      return await operation(this);
    } catch (error) {
      storedToken = before;
      throw error;
    }
  }
}
const tokenDatabase = new TokenDatabase();

mock.module(appImport("drizzle-orm/mysql2"), {
  namedExports: { drizzle: () => tokenDatabase },
});
mock.module(appRequire.resolve("mysql2/promise"), {
  defaultExport: { createPool: () => ({}) },
});
mock.module(appModule("progress/anonymous-lesson-progress.ts"), {
  namedExports: { claimAnonymousLessonCompletions: async () => undefined },
});
mock.module(appModule("coursebuilder/email-provider.ts"), {
  namedExports: {
    createPostmarkEmailProvider: () => ({ id: "postmark", type: "email" }),
  },
});

resetRuntimeEnvironment({ AUTH_SECRET: strongSecret });
// Runtime imports are required so persistence mocks precede app initialization.
const tokens: typeof InviteModule = await import(appModule("subscriptions/team-invite-token.ts"));
const auth: typeof AuthModule = await import(appModule("coursebuilder/auth-config.ts"));

beforeEach((context) => {
  resetRuntimeEnvironment({ AUTH_SECRET: strongSecret });
  assert.ok("mock" in context);
  context.mock.timers.enable({ apis: ["Date"], now });
  storedToken = null;
});

const insecureSigningCases = [
  { name: "missing beta secret", runtime: "beta", nodeEnv: "development", secret: undefined },
  { name: "short beta secret", runtime: "beta", nodeEnv: "production", secret: "too-short" },
  {
    name: "known development secret in beta",
    runtime: "beta",
    nodeEnv: "production",
    secret: developmentSecret,
  },
  {
    name: "missing production secret",
    runtime: "production",
    nodeEnv: "production",
    secret: undefined,
  },
  {
    name: "missing secret in a production-built local runtime",
    runtime: "local",
    nodeEnv: "production",
    secret: undefined,
  },
];

for (const scenario of insecureSigningCases) {
  void test(`invitation verification refuses ${scenario.name}`, () => {
    const valid = tokens.verifyTeamInviteToken(signedInvitation(invite));
    assert.equal(valid?.email, invite.email, "a correctly signed invitation is accepted");

    resetRuntimeEnvironment({
      EGGHEAD_RUNTIME: scenario.runtime,
      NODE_ENV: scenario.nodeEnv,
      AUTH_SECRET: scenario.secret,
    });
    const weaklySigned = signedInvitation(invite, scenario.secret ?? developmentSecret);
    assert.throws(() => tokens.verifyTeamInviteToken(weaklySigned), /AUTH_SECRET/);
  });
}

for (const scenario of [
  { name: "expired invitation", payload: { ...invite, expiresAt: now - 1 } },
  { name: "invitation at its exact expiry", payload: { ...invite, expiresAt: now } },
  {
    name: "invitation without an email scope",
    payload: {
      invitationId: invite.invitationId,
      subscriptionId: invite.subscriptionId,
      expiresAt: invite.expiresAt,
    },
  },
  {
    name: "legacy timeless invitation",
    payload: { subscriptionId: invite.subscriptionId, email: invite.email },
  },
  {
    name: "invitation without a persisted invitation identity",
    payload: {
      subscriptionId: invite.subscriptionId,
      email: invite.email,
      expiresAt: invite.expiresAt,
    },
  },
]) {
  void test(`invitation verification rejects ${scenario.name}`, () => {
    const valid = tokens.verifyTeamInviteToken(signedInvitation(invite));
    assert.ok(valid);
    assert.equal(tokens.teamInviteMatchesEmail(valid, " INVITED@EXAMPLE.TEST "), true);
    assert.equal(tokens.teamInviteMatchesEmail(valid, "other@example.test"), false);
    assert.equal(tokens.verifyTeamInviteToken(signedInvitation(scenario.payload)), null);
  });
}

void test("Auth.js magic-link consumption rejects a second click inside the old replay window", async () => {
  const input = { identifier: "learner@example.test", token: "one-use-link" };
  storedToken = { ...input, createdAt: new Date(now), expires: new Date(now + 60_000) };
  const first = await auth.authConfig.adapter.useVerificationToken(input);
  assert.equal(first?.identifier, input.identifier);
  assert.equal(first?.token, input.token);
  assert.equal(await auth.authConfig.adapter.useVerificationToken(input), null);
});

void test("Auth.js magic-link consumption rejects an expired persisted token", async () => {
  const input = { identifier: "learner@example.test", token: "expired-link" };
  storedToken = { ...input, createdAt: new Date(now - 10_000), expires: new Date(now - 1) };
  assert.equal(await auth.authConfig.adapter.useVerificationToken(input), null);
});
