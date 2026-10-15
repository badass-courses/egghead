import assert from "node:assert/strict";
import { StripePaymentAdapter } from "@coursebuilder/commerce/stripe-provider";
import { CourseBuilder } from "@coursebuilder/server/http";

// Dummy offline values. The provider and database adapter are read from env
// when config.ts loads, so set these before the dynamic import below. The
// local URL keeps an inherited beta or production DATABASE_URL out of the
// contract; the recording adapter below never queries it.
const webhookSecret = "whsec_offline_contract_dummy";
const stripeToken = "sk_test_offline_contract_dummy";
process.env["STRIPE_SECRET_TOKEN"] = stripeToken;
process.env["STRIPE_WEBHOOK_SECRET"] = webhookSecret;
process.env["NEXT_PUBLIC_APP_URL"] = "http://localhost:3008";
delete process.env["EGGHEAD_RUNTIME"];
process.env["DATABASE_URL"] = "mysql://root:root@127.0.0.1:3307/coursebuilder_test";

const { courseBuilderConfig } = await import("../apps/web/src/coursebuilder/config");

const stripeProvider = courseBuilderConfig.providers.find((provider) => provider.id === "stripe");
assert.ok(stripeProvider, "apps/web must mount the Stripe provider when Stripe env is set");

// Signs test payloads only. The app's own provider does the verification.
const signer = new StripePaymentAdapter({ stripeToken, stripeWebhookSecret: webhookSecret });

type MerchantEventInput = Parameters<typeof courseBuilderConfig.adapter.createMerchantEvent>[0];

const dispatched: string[] = [];
const rejections: string[] = [];
const config = {
  ...courseBuilderConfig,
  logger: {
    error: (error: Error) => {
      rejections.push(error.message);
    },
    warn: () => undefined,
    debug: () => undefined,
    info: () => undefined,
  },
  adapter: {
    ...courseBuilderConfig.adapter,
    getMerchantAccount: async () => ({
      id: "synthetic-merchant",
      label: "stripe",
      identifier: "synthetic-merchant",
      status: 1,
      createdAt: null,
    }),
    createMerchantEvent: async (event: MerchantEventInput) => {
      dispatched.push(event.identifier);
      return { ...event, id: "synthetic-merchant-event", createdAt: null };
    },
  },
};

const webhookUrl = `http://localhost:3008${courseBuilderConfig.basePath}/webhook/stripe`;
const payload = JSON.stringify({
  id: "evt_offline_contract",
  object: "event",
  type: "customer.updated",
  data: { object: { id: "cus_offline_contract", object: "customer" } },
});

function signed(body: string, secret: string) {
  return signer.stripe.webhooks.generateTestHeaderString({ payload: body, secret });
}

async function postWebhook(body: string, signature?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature) headers.set("stripe-signature", signature);
  const response = await CourseBuilder(
    new Request(webhookUrl, { method: "POST", headers, body }),
    config,
  );
  return response.status;
}

const validStatus = await postWebhook(payload, signed(payload, webhookSecret));
assert.notEqual(validStatus, 400);
assert.equal(validStatus, 200);
assert.deepEqual(dispatched, ["evt_offline_contract"]);

const forgedStatus = await postWebhook(payload, signed(payload, "whsec_forged_offline_dummy"));
assert.equal(forgedStatus, 400);

const tamperedPayload = payload.replace("cus_offline_contract", "cus_tampered_offline");
const tamperedStatus = await postWebhook(tamperedPayload, signed(payload, webhookSecret));
assert.equal(tamperedStatus, 400);

const missingStatus = await postWebhook(payload);
assert.equal(missingStatus, 400);

assert.deepEqual(dispatched, ["evt_offline_contract"]);
assert.equal(rejections.length, 3);
assert.match(rejections[0] ?? "", /No signatures found matching the expected signature/);
assert.match(rejections[1] ?? "", /No signatures found matching the expected signature/);
assert.match(rejections[2] ?? "", /Missing stripe-signature header/);
console.log(
  `Stripe webhook signature checks passed: valid=${validStatus} (dispatched), forged=${forgedStatus}, tampered=${tamperedStatus}, missing=${missingStatus}. No network calls.`,
);
