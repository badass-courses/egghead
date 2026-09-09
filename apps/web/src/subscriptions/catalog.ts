import { mySqlDrizzleAdapter } from "@coursebuilder/adapter-drizzle/mysql";
import { StripePaymentAdapter } from "@coursebuilder/commerce/stripe-provider";
import { drizzle } from "drizzle-orm/mysql2";
import { getEggheadMysqlPool } from "../db/local-docker";
import { mysqlTable } from "../db/mysql-table";
import { eggheadCourseBuilderSchema } from "../db/schema";
import { getLocalMembershipServices } from "../local-membership/catalog";
import { membershipConfiguration } from "./configuration";

export function getMembershipServices() {
  const configuration = membershipConfiguration(process.env);
  if (!configuration) return null;
  if (configuration.localPreview) return { ...getLocalMembershipServices(), configuration };
  const db = drizzle(getEggheadMysqlPool(), {
    schema: eggheadCourseBuilderSchema,
    mode: "default",
  });
  return {
    db,
    configuration,
    adapter: mySqlDrizzleAdapter(db, mysqlTable),
    payments: new StripePaymentAdapter({
      stripeToken: configuration.token,
      stripeWebhookSecret: process.env["STRIPE_WEBHOOK_SECRET"] ?? "",
    }),
  };
}

export async function getMembershipCatalog() {
  const services = getMembershipServices();
  if (!services) return { product: null, testMode: false };
  const product = await services.adapter.getProduct(services.configuration.productId, false);
  return {
    product: product?.type === "membership" && product.status === 1 ? product : null,
    testMode: !services.configuration.live,
  };
}
