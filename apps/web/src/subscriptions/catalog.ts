import type { BillingInterval, Product } from "@coursebuilder/core/schemas/product-schema";
import { isPriceAvailable } from "@coursebuilder/commerce/select-product-price";
import { and, eq } from "drizzle-orm";
import { merchantAccount as merchantAccountTable, products } from "../db/schema";
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
      stripeWebhookSecret: configuration.webhookSecret,
    }),
  };
}

type MembershipProductCandidate = {
  fields: { billingInterval?: BillingInterval };
  price?: { status: number } | null | undefined;
  prices?:
    | Array<{
        status: number;
        fields: {
          stripe?: { active: boolean; supported: boolean; recurring?: unknown } | undefined;
          offer?: { offered?: boolean | undefined } | undefined;
        };
      }>
    | undefined;
  status: number;
  type?: Product["type"];
};
export type ActiveMembershipProduct = Product & { status: 1; type: "membership" };

export function isActiveMembershipProduct(
  product: MembershipProductCandidate | null,
): product is ActiveMembershipProduct {
  return Boolean(
    product &&
    product.status === 1 &&
    product.type === "membership" &&
    (product.prices?.some(
      (price) =>
        price.status === 1 &&
        price.fields.stripe?.active &&
        price.fields.stripe.supported &&
        price.fields.stripe.recurring &&
        price.fields.offer?.offered === true,
    ) ||
      (product.price?.status === 1 && product.fields.billingInterval)),
  );
}

export function membershipPrices(product: Product) {
  return (product.prices ?? (product.price ? [product.price] : [])).filter(
    (price) =>
      isPriceAvailable(price) &&
      (price.fields.stripe?.recurring || (!price.fields.stripe && product.fields.billingInterval)),
  );
}

export async function getActiveMembershipProduct(productId: string) {
  const services = getMembershipServices();
  if (
    !services ||
    (services.configuration.productId && services.configuration.productId !== productId)
  )
    return null;
  const product = await services.adapter.getProduct(productId, false);
  if (!isActiveMembershipProduct(product)) return null;
  const merchantProduct = await services.adapter.getMerchantProductForProductId(productId);
  if (merchantProduct?.status !== 1 || !merchantProduct.identifier) return null;
  const merchantAccount = await services.db.query.merchantAccount.findFirst({
    where: and(
      eq(merchantAccountTable.id, merchantProduct.merchantAccountId),
      eq(merchantAccountTable.status, 1),
    ),
  });
  if (!merchantAccount) return null;
  const mappedPrices = await Promise.all(
    membershipPrices(product).map(async (price) => {
      const mapping = await services.adapter.getMerchantPriceForPriceId?.(
        merchantProduct.id,
        price.id,
      );
      return mapping?.status === 1 &&
        mapping.identifier &&
        mapping.merchantProductId === merchantProduct.id
        ? price
        : null;
    }),
  );
  const prices = mappedPrices.filter((price) => price !== null);
  return prices.length ? { ...product, prices } : null;
}

export async function getActiveMembershipProducts() {
  const services = getMembershipServices();
  if (!services) return [];
  const productIds = services.configuration.productId
    ? [{ id: services.configuration.productId }]
    : await services.db
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.status, 1), eq(products.type, "membership")));
  const productsWithPrices = await Promise.all(
    productIds.map(({ id }) => getActiveMembershipProduct(id)),
  );
  return productsWithPrices.filter((product) => product !== null);
}
