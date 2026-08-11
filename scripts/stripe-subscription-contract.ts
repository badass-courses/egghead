import assert from "node:assert/strict";

import {
  stripeSubscriptionEntitlementId,
  stripeSubscriptionGrantsAccess,
} from "../apps/web/src/subscriptions/access";
import { assertCommerceWritesAllowed } from "../apps/web/src/db/local-docker";
import {
  formatMembershipCost,
  membershipIntervalLabel,
} from "../apps/web/src/subscriptions/billing";

type ContractCheck = {
  name: string;
  pass: true;
};

const originalEnv = {
  databaseUrl: process.env["DATABASE_URL"],
  runtime: process.env["EGGHEAD_RUNTIME"],
};

function setEnv(name: "DATABASE_URL" | "EGGHEAD_RUNTIME", value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

let runningCheckName: string | null = null;

function check(name: string, run: () => void): ContractCheck {
  runningCheckName = name;
  run();
  runningCheckName = null;
  return { name, pass: true };
}

try {
  const checks = [
    check("access-granting Stripe statuses remain explicit", () => {
      assert.equal(stripeSubscriptionGrantsAccess("active"), true);
      assert.equal(stripeSubscriptionGrantsAccess("trialing"), true);
      assert.equal(stripeSubscriptionGrantsAccess("past_due"), true);
      assert.equal(stripeSubscriptionGrantsAccess("canceled"), false);
      assert.equal(stripeSubscriptionGrantsAccess("unpaid"), false);
    }),
    check("Stripe entitlement IDs are deterministic", () => {
      assert.equal(
        stripeSubscriptionEntitlementId("sub_contract_fixture"),
        "stripe_ent_sub_contract_fixture",
      );
    }),
    check("membership billing details are customer-readable", () => {
      assert.equal(membershipIntervalLabel("month", 1), "Monthly");
      assert.equal(membershipIntervalLabel("year", 1), "Annual");
      assert.equal(membershipIntervalLabel("month", 3), "Every 3 months");
      assert.equal(membershipIntervalLabel(null, null), "Recurring");
      assert.equal(formatMembershipCost(2_000, "usd", 1), "$20.00");
      assert.equal(formatMembershipCost(2_000, "usd", 3), "$60.00");
      assert.equal(formatMembershipCost(2_000, "jpy", 1), "¥2,000");
    }),
    check("commerce writes are allowed for local Docker only", () => {
      setEnv("DATABASE_URL", "mysql://root:root@127.0.0.1:3307/coursebuilder_test");
      setEnv("EGGHEAD_RUNTIME", "local");
      assert.equal(assertCommerceWritesAllowed().commerceWritesAllowed, true);

      setEnv("DATABASE_URL", "mysql://user:password@aws.connect.psdb.cloud/egghead");
      setEnv("EGGHEAD_RUNTIME", "beta");
      assert.throws(() => assertCommerceWritesAllowed());
    }),
  ];

  console.log(JSON.stringify({ ok: true, checks }));
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      check: runningCheckName ?? "stripe subscription contract",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
} finally {
  setEnv("DATABASE_URL", originalEnv.databaseUrl);
  setEnv("EGGHEAD_RUNTIME", originalEnv.runtime);
}
