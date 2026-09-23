import assert from "node:assert/strict";
import {
  membershipConfiguration,
  membershipCheckoutOrigin,
} from "../apps/web/src/subscriptions/configuration";

const live = membershipConfiguration({
  NODE_ENV: "production",
  EGGHEAD_RUNTIME: "production",
  EGGHEAD_LOCAL_MEMBERSHIP: "true",
  STRIPE_SECRET_TOKEN: "sk_live_synthetic",
  STRIPE_WEBHOOK_SECRET: "whsec_synthetic",
  INNGEST_EVENT_KEY: "synthetic-event-key",
  INNGEST_SIGNING_KEY: "synthetic-signing-key",
  NEXT_PUBLIC_APP_URL: "https://egghead.example",
  EGGHEAD_SUBSCRIPTION_PRODUCT_ID: "configured-membership",
});
assert.equal(live?.live, true);
assert.equal(live?.localPreview, false);
assert.equal(live?.productId, "configured-membership");
assert.equal(
  membershipConfiguration({
    STRIPE_SECRET_TOKEN: "sk_test_synthetic",
    STRIPE_WEBHOOK_SECRET: "whsec_synthetic",
    EGGHEAD_SUBSCRIPTION_PRODUCT_ID: "configured-membership",
  })?.live,
  false,
);
assert.equal(membershipConfiguration({}), null);
assert.equal(membershipConfiguration({ STRIPE_SECRET_TOKEN: "sk_test_synthetic" }), null);
assert.equal(
  membershipConfiguration({
    EGGHEAD_RUNTIME: "production",
    STRIPE_SECRET_TOKEN: "sk_live_synthetic",
    STRIPE_WEBHOOK_SECRET: "whsec_synthetic",
  }),
  null,
);
assert.equal(
  membershipConfiguration({
    EGGHEAD_RUNTIME: "Production",
    STRIPE_SECRET_TOKEN: "sk_live_synthetic",
    STRIPE_WEBHOOK_SECRET: "whsec_synthetic",
  }),
  null,
);
assert.equal(
  membershipConfiguration({
    EGGHEAD_RUNTIME: "production",
    STRIPE_SECRET_TOKEN: "sk_live_synthetic",
    STRIPE_WEBHOOK_SECRET: "whsec_synthetic",
    INNGEST_EVENT_KEY: "synthetic-event-key",
    INNGEST_SIGNING_KEY: "synthetic-signing-key",
    NEXT_PUBLIC_APP_URL: "http://egghead.example",
  }),
  null,
);
assert.throws(() =>
  membershipConfiguration({
    EGGHEAD_LOCAL_MEMBERSHIP: "true",
    STRIPE_SECRET_TOKEN: "sk_live_synthetic",
  }),
);
assert.throws(() =>
  membershipConfiguration({
    EGGHEAD_LOCAL_MEMBERSHIP: "true",
    STRIPE_SECRET_TOKEN: "rk_test_synthetic",
  }),
);
assert.equal(
  membershipCheckoutOrigin("https://egghead.io", "https://egghead.io", "production"),
  "https://egghead.io",
);
assert.throws(() =>
  membershipCheckoutOrigin("https://egghead.io", "https://untrusted.example", "production"),
);
assert.equal(
  membershipCheckoutOrigin(undefined, "http://127.0.0.1:3008", "local"),
  "http://127.0.0.1:3008",
);
assert.throws(() => membershipCheckoutOrigin(undefined, "https://egghead.io", "local"));
assert.throws(() => membershipCheckoutOrigin(undefined, "http://127.0.0.1:3008", "production"));
console.log(
  "Membership configuration: live and test accounts accepted; local preview and checkout origins validated. No network calls or writes.",
);
