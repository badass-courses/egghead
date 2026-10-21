import { eq } from "drizzle-orm";
import { syncStripeProductPrices } from "@coursebuilder/commerce/sync-stripe-product-prices";
import { getCourseBuilderAdapter, getEggheadDatabase } from "../apps/web/src/db/adapter";
import { assertDatabaseUrlForRuntime, getEggheadMysqlPool } from "../apps/web/src/db/local-docker";
import {
  contentResourceProduct,
  merchantAccount,
  merchantProduct,
  products,
} from "../apps/web/src/db/schema";
import { getStoredWorkshop } from "../apps/web/src/workshops/catalog";
import { getWorkshopPayments } from "../apps/web/src/workshops/payments";

async function setup() {
  if (process.env["NODE_ENV"] !== "development" || !assertDatabaseUrlForRuntime().localDockerOnly)
    throw new Error("Workshop offer setup is local development only");
  const id = process.argv[2];
  if (!id || !/^workshop~[a-f0-9-]{36}$/.test(id)) throw new Error("Pass a native Workshop ID");
  const workshop = await getStoredWorkshop(id);
  const services = getWorkshopPayments();
  if (!workshop || !services || services.live)
    throw new Error("Local Workshop and Stripe test credentials are required");
  const db = getEggheadDatabase();
  const adapter = getCourseBuilderAdapter();
  const stripe = services.payments.stripe;
  const productId = `workshop-product~${id.slice(9)}`;
  const mapping = await adapter.getMerchantProductForProductId(productId);
  const product = mapping?.identifier
    ? await stripe.products.retrieve(mapping.identifier)
    : await stripe.products.create(
        { name: workshop.fields.title, metadata: { local_workshop: id } },
        { idempotencyKey: `local-workshop-product:${id}` },
      );
  if (product.livemode || !product.active) throw new Error("Expected an active test Product");
  const catalog = await stripe.prices.list({ product: product.id, limit: 100 });
  if (catalog.has_more) throw new Error("Unexpectedly large Workshop price catalog");
  const price =
    catalog.data.find(
      (entry) =>
        entry.active &&
        entry.type === "one_time" &&
        entry.unit_amount === 37500 &&
        entry.currency === "usd",
    ) ??
    (await stripe.prices.create(
      { product: product.id, currency: "usd", unit_amount: 37500 },
      { idempotencyKey: `local-workshop-price:${id}:usd:37500` },
    ));
  if (price.livemode) throw new Error("Live price rejected");
  if (product.default_price !== price.id)
    await stripe.products.update(product.id, { default_price: price.id });
  const account = await stripe.accounts.retrieve();
  const [existingAccount] = await db
    .select()
    .from(merchantAccount)
    .where(eq(merchantAccount.label, "stripe"))
    .limit(1);
  if (existingAccount && existingAccount.identifier !== account.id)
    throw new Error("Local Stripe account mapping differs from test credentials");
  const merchantAccountId = existingAccount?.id ?? "local-workshop-stripe";
  if (!existingAccount)
    await db
      .insert(merchantAccount)
      .values({ id: merchantAccountId, label: "stripe", identifier: account.id, status: 1 });
  await db
    .insert(products)
    .values({
      id: productId,
      name: workshop.fields.title,
      type: "live",
      status: 1,
      quantityAvailable: -1,
      fields: { slug: productId, state: "published", visibility: "unlisted" },
    })
    .onDuplicateKeyUpdate({ set: { quantityAvailable: -1 } });
  if (!mapping)
    await db.insert(merchantProduct).values({
      id: `workshop-merchant~${id.slice(9)}`,
      productId,
      merchantAccountId,
      identifier: product.id,
      status: 1,
    });
  await db
    .insert(contentResourceProduct)
    .values({ productId, resourceId: id, metadata: { role: "workshop" } })
    .onDuplicateKeyUpdate({ set: { deletedAt: null } });
  await syncStripeProductPrices({ productId, adapter, provider: services.payments, dryRun: false });
  const prices = await adapter.getPricesForProduct?.(productId);
  const selected = prices?.find((entry) => entry.fields.stripe?.identifier === price.id);
  if (!selected || !adapter.configureProductPrice)
    throw new Error("Synchronized Workshop Price missing");
  await adapter.configureProductPrice({
    productId,
    priceId: selected.id,
    offer: { offered: true, label: "Workshop seat", position: 0 },
    default: true,
  });
  console.log(
    JSON.stringify({
      ok: true,
      productId,
      priceId: selected.id,
      amount: 375,
      currency: "USD",
      seatLimit: null,
      stripeMode: "test",
      workshopState: workshop.fields.state,
    }),
  );
}
try {
  await setup();
} finally {
  await getEggheadMysqlPool().end();
}
