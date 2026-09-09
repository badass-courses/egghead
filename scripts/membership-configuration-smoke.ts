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
  EGGHEAD_SUBSCRIPTION_PRODUCT_ID: "configured-membership",
});
assert.equal(live?.live, true);
assert.equal(live?.localPreview, false);
assert.equal(live?.productId, "configured-membership");
assert.equal(
  membershipConfiguration({
    STRIPE_SECRET_TOKEN: "sk_test_synthetic",
    EGGHEAD_SUBSCRIPTION_PRODUCT_ID: "configured-membership",
  })?.live,
  false,
);
assert.equal(membershipConfiguration({}), null);
assert.throws(() =>
  membershipConfiguration({
    EGGHEAD_LOCAL_MEMBERSHIP: "true",
    STRIPE_SECRET_TOKEN: "sk_live_synthetic",
  }),
);
assert.equal(
  membershipCheckoutOrigin("https://egghead.io", "https://egghead.io", false),
  "https://egghead.io",
);
assert.throws(() =>
  membershipCheckoutOrigin("https://egghead.io", "https://untrusted.example", false),
);
assert.equal(
  membershipCheckoutOrigin(undefined, "http://127.0.0.1:3008", true),
  "http://127.0.0.1:3008",
);
assert.throws(() => membershipCheckoutOrigin(undefined, "https://egghead.io", true));
console.log(
  "Membership configuration: live and test accounts accepted; local preview and checkout origins validated. No network calls or writes.",
);
