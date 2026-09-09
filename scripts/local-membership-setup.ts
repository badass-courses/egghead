import { eq } from "drizzle-orm";
import { getEggheadMysqlPool } from "../apps/web/src/db/local-docker";
import { merchantAccount, merchantProduct, products } from "../apps/web/src/db/schema";
import {
  getLocalMembershipServices,
  LOCAL_MEMBERSHIP_ID,
  syncLocalMembership,
} from "../apps/web/src/local-membership/catalog";

async function setup() {
  const { db, adapter, payments } = getLocalMembershipServices();
  const stripe = payments.stripe;
  const marker = "egghead-local-multiple-prices-v3";
  let stripeProduct;
  for await (const product of stripe.products.list({ limit: 100 })) {
    if (product.metadata["local_test"] === marker) {
      stripeProduct = product;
      break;
    }
  }
  stripeProduct ??= await stripe.products.create(
    {
      name: "Egghead membership · local test",
      metadata: { local_test: marker },
    },
    { idempotencyKey: marker },
  );
  if (stripeProduct.livemode || !stripeProduct.active)
    throw new Error("Expected an active test product");
  const options = [
    { label: "Annual", amount: 15000, interval: "year", count: 1 },
    { label: "Monthly", amount: 2500, interval: "month", count: 1 },
    { label: "Quarterly", amount: 7000, interval: "month", count: 3 },
  ] as const;
  const currentPrices = await stripe.prices.list({ product: stripeProduct.id, limit: 100 });
  const stripePrices = await Promise.all(
    options.map(async (option) => {
      const existing = currentPrices.data.find(
        (price) =>
          price.active &&
          price.nickname === option.label &&
          price.unit_amount === option.amount &&
          price.recurring?.interval === option.interval &&
          price.recurring.interval_count === option.count,
      );
      return (
        existing ??
        stripe.prices.create(
          {
            product: stripeProduct.id,
            nickname: option.label,
            currency: "usd",
            unit_amount: option.amount,
            recurring: { interval: option.interval, interval_count: option.count },
            metadata: { local_test: marker },
          },
          { idempotencyKey: `${marker}-${option.label}` },
        )
      );
    }),
  );
  const annual = stripePrices[0];
  if (!annual) throw new Error("Missing annual price");
  if (!stripeProduct.default_price)
    await stripe.products.update(stripeProduct.id, { default_price: annual.id });
  await db
    .insert(merchantAccount)
    .values({
      id: "local-membership-stripe",
      label: "stripe-local-membership",
      identifier: "local-stripe-test-account",
      status: 1,
    })
    .onDuplicateKeyUpdate({ set: { status: 1 } });
  await db
    .insert(products)
    .values({
      id: LOCAL_MEMBERSHIP_ID,
      name: "Egghead membership",
      type: "membership",
      status: 1,
      fields: { slug: LOCAL_MEMBERSHIP_ID },
    })
    .onDuplicateKeyUpdate({ set: { name: "Egghead membership" } });
  const [mapping] = await db
    .select()
    .from(merchantProduct)
    .where(eq(merchantProduct.productId, LOCAL_MEMBERSHIP_ID));
  if (mapping && mapping.identifier !== stripeProduct.id)
    throw new Error("Existing local mapping belongs to a different test product");
  if (!mapping)
    await db.insert(merchantProduct).values({
      id: "local-membership-merchant-product",
      productId: LOCAL_MEMBERSHIP_ID,
      merchantAccountId: "local-membership-stripe",
      identifier: stripeProduct.id,
      status: 1,
    });
  await syncLocalMembership();
  const localPrices = await adapter.getPricesForProduct?.(LOCAL_MEMBERSHIP_ID);
  if (!localPrices || !adapter.configureProductPrice)
    throw new Error("Linked multi-price adapter is required");
  const configure = adapter.configureProductPrice.bind(adapter);
  // Only initial setup enables offers. Re-running setup preserves settings.
  if (!mapping)
    await Promise.all(
      localPrices.map((price) => {
        const index = stripePrices.findIndex(
          (entry) => entry.id === price.fields.stripe?.identifier,
        );
        const option = options[index];
        if (!option) return Promise.resolve();
        return configure({
          productId: LOCAL_MEMBERSHIP_ID,
          priceId: price.id,
          offer: { offered: true, label: option.label, position: index },
          default: index === 0,
        });
      }),
    );
  console.log(
    JSON.stringify({
      ok: true,
      productCount: 1,
      priceCount: localPrices.length,
      stripeMode: "test",
      database: "local",
      url: "http://localhost:3008/local/membership",
    }),
  );
}
try {
  await setup();
} finally {
  await getEggheadMysqlPool().end();
}
