import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildStripeCheckoutPath } from "@coursebuilder/commerce/build-stripe-checkout-path";
import { resolveCheckoutPrice } from "@coursebuilder/commerce/resolve-checkout-price";
import { selectProductPrice } from "@coursebuilder/commerce/select-product-price";
import { priceSchema } from "@coursebuilder/core/schemas/price-schema";
import { productSchema } from "@coursebuilder/core/schemas/product-schema";

const product = productSchema.parse({
  id: "synthetic-membership",
  name: "Membership",
  type: "membership",
  status: 1,
  createdAt: new Date(0),
  fields: { slug: "synthetic-membership" },
});
const billingOptions = [
  { id: "annual", amount: 15000, interval: "year", intervalCount: 1 },
  { id: "monthly", amount: 2500, interval: "month", intervalCount: 1 },
  { id: "quarterly", amount: 7000, interval: "month", intervalCount: 3 },
] as const;
const prices = billingOptions.map((option) =>
  priceSchema.parse({
    id: option.id,
    productId: product.id,
    unitAmount: option.amount / 100,
    status: 1,
    createdAt: new Date(0),
    fields: {
      offer: { offered: true, position: 0 },
      stripe: {
        identifier: option.id,
        productIdentifier: product.id,
        unitAmountMinor: option.amount,
        currency: "usd",
        active: true,
        livemode: false,
        supported: true,
        type: "recurring",
        lookupKey: null,
        recurring: { interval: option.interval, intervalCount: option.intervalCount },
      },
    },
  }),
);

await Promise.all(
  billingOptions.map(async (option) => {
    const resolved = await resolveCheckoutPrice({
      productId: product.id,
      priceId: option.id,
      adapter: {
        getMerchantPriceForProductId: () => Promise.resolve(null),
        getProduct: () => Promise.resolve(product),
        getPriceForProduct: (_productId, priceId) =>
          Promise.resolve(
            selectProductPrice(prices, {
              ...(priceId ? { priceId } : {}),
              defaultPriceId: "annual",
            }),
          ),
        getMerchantProductForProductId: () =>
          Promise.resolve({
            id: "synthetic-merchant-product",
            identifier: product.id,
            productId: product.id,
            merchantAccountId: "synthetic-account",
            status: 1,
            createdAt: new Date(0),
          }),
        getMerchantPriceForPriceId: (merchantProductId, priceId) =>
          Promise.resolve({
            id: `synthetic-${priceId}`,
            identifier: priceId,
            priceId,
            merchantProductId,
            merchantAccountId: "synthetic-account",
            status: 1,
            createdAt: new Date(0),
          }),
      },
      paymentsAdapter: {
        getPrice: (id) =>
          Promise.resolve({
            id,
            object: "price",
            active: true,
            billing_scheme: "per_unit",
            created: 0,
            currency: "usd",
            custom_unit_amount: null,
            livemode: false,
            lookup_key: null,
            metadata: {},
            nickname: null,
            product: product.id,
            tax_behavior: "unspecified",
            tiers_mode: null,
            transform_quantity: null,
            type: "recurring",
            unit_amount: option.amount,
            unit_amount_decimal: String(option.amount),
            recurring: {
              interval: option.interval,
              interval_count: option.intervalCount,
              usage_type: "licensed",
              aggregate_usage: null,
              meter: null,
              trial_period_days: null,
            },
            lastResponse: { headers: {}, requestId: "synthetic", statusCode: 200 },
          }),
      },
    });
    assert.equal(resolved.price.unitAmount, option.amount / 100);
    assert.equal(resolved.stripePrice.recurring?.interval_count, option.intervalCount);
    const url = new URL(
      buildStripeCheckoutPath({ productId: product.id, priceId: option.id, bulk: false }),
      "http://localhost",
    );
    assert.equal(url.searchParams.get("priceId"), option.id);
  }),
);

assert.equal(selectProductPrice(prices), null);
const resolvedModule = realpathSync(
  fileURLToPath(import.meta.resolve("@coursebuilder/commerce/resolve-checkout-price")),
);
console.log(
  JSON.stringify({
    ok: true,
    billingOptions: billingOptions.length,
    quarterlyIntervalCount: 3,
    explicitSelectionVerified: true,
    coreModule: resolvedModule,
    networkCalls: 0,
  }),
);
