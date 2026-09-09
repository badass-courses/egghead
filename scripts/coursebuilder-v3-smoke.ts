import assert from "node:assert/strict";
import { createAuthJsAdapter } from "../apps/web/src/server/auth-js-adapter";
import { formResolver } from "../apps/builder-egghead/src/utils/form-resolver";
import { z } from "zod";

const operations: string[] = [];
const adapter = createAuthJsAdapter({
  getAccount: () => ({
    userId: "synthetic-user",
    type: "oauth",
    provider: "synthetic",
    providerAccountId: "synthetic-account",
    token_type: "Bearer",
    expires_at: null,
  }),
  linkAccount: () => {
    operations.push("link");
  },
  unlinkAccount: () => {
    operations.push("unlink");
  },
  deleteSession: () => {
    operations.push("delete-session");
  },
});
assert.equal(typeof adapter.getAccount, "function");
assert.equal(typeof adapter.linkAccount, "function");
assert.equal(typeof adapter.unlinkAccount, "function");
assert.equal(typeof adapter.deleteSession, "function");
const account = await adapter.getAccount?.("synthetic-account", "synthetic");
assert.ok(account);
assert.equal(account.token_type, "bearer");
assert.equal(Object.hasOwn(account, "expires_at"), false);
await adapter.linkAccount?.(account);
await adapter.unlinkAccount?.(account);
await adapter.deleteSession?.("synthetic-session");
assert.deepEqual(operations, ["link", "unlink", "delete-session"]);
const resolver = formResolver(
  z.object({
    title: z.string().min(2),
    amount: z.coerce.number().positive(),
    enabled: z.boolean().default(true),
  }),
);
const resolverOptions = { fields: {}, shouldUseNativeValidation: false };
const valid = await resolver(
  { title: "Membership", amount: 25, enabled: true },
  undefined,
  resolverOptions,
);
assert.deepEqual(valid.errors, {});
const invalid = await resolver(
  { title: "", amount: -1, enabled: true },
  undefined,
  resolverOptions,
);
assert.ok(invalid.errors.title && invalid.errors.amount);
console.log("CourseBuilder v3 auth and form boundaries passed (offline)");
