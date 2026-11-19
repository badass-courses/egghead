import assert from "node:assert/strict";
import { test } from "node:test";

import { decideEggheadEmailLink } from "../apps/builder-egghead/src/server/egghead-auth-link-guard";

void test("builder egghead sign-in with an existing account row is allowed", () => {
  assert.deepEqual(
    decideEggheadEmailLink({
      linkedUserId: "cb-user-1",
      emailUser: { id: "cb-user-2", legacyRailsUserId: "999" },
      providerAccountId: "123",
    }),
    { allow: true, reason: "linked-account" },
  );
});

void test("builder egghead sign-in with no matching email creates a user", () => {
  assert.deepEqual(
    decideEggheadEmailLink({ linkedUserId: null, emailUser: null, providerAccountId: "123" }),
    { allow: true, reason: "new-user" },
  );
});

void test("builder egghead sign-in links a projected user only on its own Rails id", () => {
  assert.deepEqual(
    decideEggheadEmailLink({
      linkedUserId: null,
      emailUser: { id: "cb-user-1", legacyRailsUserId: "123" },
      providerAccountId: "123",
    }),
    { allow: true, reason: "legacy-rails-id-match" },
  );
});

void test("builder egghead sign-in refuses an email match on a different Rails user", () => {
  assert.deepEqual(
    decideEggheadEmailLink({
      linkedUserId: null,
      emailUser: { id: "cb-user-1", legacyRailsUserId: "456" },
      providerAccountId: "123",
    }),
    { allow: false, reason: "legacy-rails-id-mismatch" },
  );
});

void test("builder egghead sign-in refuses an email match on a user with no Rails id", () => {
  for (const legacyRailsUserId of [null, "", "  "]) {
    assert.deepEqual(
      decideEggheadEmailLink({
        linkedUserId: null,
        emailUser: { id: "cb-user-1", legacyRailsUserId },
        providerAccountId: "123",
      }),
      { allow: false, reason: "no-legacy-rails-id" },
    );
  }
});
