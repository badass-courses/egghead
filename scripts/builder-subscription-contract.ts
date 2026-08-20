import assert from "node:assert/strict";

import { assertBuilderCommerceWritesAllowed } from "../apps/builder-egghead/src/db/runtime-guard";
import {
  assertStripeTestMode,
  parseSubscriptionProductForm,
  stripeAccountMode,
  stripeUnitAmount,
  subscriptionProductFormSchema,
} from "../apps/builder-egghead/src/lib/subscription-products-contracts";

type ContractCheck = {
  name: string;
  pass: true;
};

type RuntimeEnvSnapshot = {
  runtime: string | undefined;
};

function setEnv(name: "EGGHEAD_RUNTIME", value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function check(name: string, run: () => void): ContractCheck {
  run();
  return { name, pass: true };
}

const snapshot: RuntimeEnvSnapshot = {
  runtime: process.env["EGGHEAD_RUNTIME"],
};

try {
  const checks = [
    check("yearly subscription form values remain explicit", () => {
      const formData = new FormData();
      formData.set("name", "egghead Annual Membership");
      formData.set("description", "Annual access");
      formData.set("billingInterval", "year");
      formData.set("price", "149.99");
      formData.set("active", "on");

      assert.deepEqual(parseSubscriptionProductForm(formData), {
        name: "egghead Annual Membership",
        description: "Annual access",
        billingInterval: "year",
        price: 149.99,
        active: true,
      });
    }),
    check("subscription prices map from major units to Stripe cents", () => {
      assert.equal(stripeUnitAmount(150), 15_000);
      assert.equal(stripeUnitAmount(149.99), 14_999);
      assert.equal(
        subscriptionProductFormSchema.safeParse({
          name: "Annual membership",
          description: "",
          billingInterval: "year",
          price: 149.999,
          active: true,
        }).success,
        false,
      );
    }),
    check("subscription product writes require Stripe test mode", () => {
      assert.equal(stripeAccountMode("sk_test_contract"), "test");
      assert.equal(stripeAccountMode("rk_test_contract"), "test");
      assert.equal(stripeAccountMode("sk_live_contract"), "live");
      assert.doesNotThrow(() => assertStripeTestMode("sk_test_contract"));
      assert.throws(() => assertStripeTestMode("sk_live_contract"));
    }),
    check("subscription product writes require local Docker", () => {
      setEnv("EGGHEAD_RUNTIME", "local");
      assert.doesNotThrow(() =>
        assertBuilderCommerceWritesAllowed("mysql://root:root@127.0.0.1:3307/coursebuilder_test"),
      );

      setEnv("EGGHEAD_RUNTIME", "beta");
      assert.throws(() =>
        assertBuilderCommerceWritesAllowed(
          "mysql://user:password@aws.connect.psdb.cloud/egghead?sslaccept=strict",
        ),
      );
    }),
  ];

  console.log(JSON.stringify({ ok: true, checks }));
} finally {
  setEnv("EGGHEAD_RUNTIME", snapshot.runtime);
}
