import { mySqlDrizzleAdapter } from "@coursebuilder/adapter-drizzle/mysql";
import { StripePaymentAdapter } from "@coursebuilder/commerce/stripe-provider";
import { syncStripeProductPrices } from "@coursebuilder/commerce/sync-stripe-product-prices";
import { drizzle } from "drizzle-orm/mysql2";
import {
  assertDatabaseUrlForRuntime,
  getEggheadMysqlPool,
  getEggheadRuntime,
} from "../db/local-docker";
import { mysqlTable } from "../db/mysql-table";
import { eggheadCourseBuilderSchema } from "../db/schema";

export const LOCAL_MEMBERSHIP_ID = "local-multiple-price-membership";
export const LOCAL_MEMBERSHIP_PATH = "/local/membership";

export function isLocalMembershipEnabled() {
  return (
    process.env["EGGHEAD_LOCAL_MEMBERSHIP"] === "true" &&
    process.env["NODE_ENV"] !== "production" &&
    getEggheadRuntime() === "local"
  );
}

/** This testing surface can only use local MySQL and a Stripe test-mode key. */
export function getLocalMembershipServices() {
  if (!isLocalMembershipEnabled() || !assertDatabaseUrlForRuntime().localDockerOnly) {
    throw new Error("Local membership testing is disabled");
  }
  const stripeToken = process.env["STRIPE_SECRET_TOKEN"];
  if (!stripeToken?.startsWith("sk_test_")) throw new Error("A Stripe test secret key is required");
  const db = drizzle(getEggheadMysqlPool(), {
    schema: eggheadCourseBuilderSchema,
    mode: "default",
  });
  const adapter = mySqlDrizzleAdapter(db, mysqlTable);
  const payments = new StripePaymentAdapter({
    stripeToken,
    stripeWebhookSecret: process.env["STRIPE_WEBHOOK_SECRET"] ?? "local-unused-webhook-secret",
  });
  return { db, adapter, payments };
}

export async function getLocalMembership() {
  const { adapter } = getLocalMembershipServices();
  const product = await adapter.getProduct(LOCAL_MEMBERSHIP_ID, false);
  if (!product) throw new Error("Run pnpm membership:setup before opening this page");
  return product;
}

export async function syncLocalMembership() {
  const { adapter, payments } = getLocalMembershipServices();
  return syncStripeProductPrices({
    productId: LOCAL_MEMBERSHIP_ID,
    adapter,
    provider: payments,
    dryRun: false,
  });
}
