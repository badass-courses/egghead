import type { BillingInterval, Product } from "@coursebuilder/core/schemas";
import { and, eq } from "drizzle-orm";

import { getCourseBuilderAdapter, getEggheadDatabase } from "../db/adapter";
import { products } from "../db/schema";

type MembershipProductCandidate = {
  fields: {
    billingInterval?: BillingInterval;
  };
  price?: {
    status: number;
  } | null;
  status: number;
  type?: Product["type"];
};

export type ActiveMembershipProduct = Product & {
  fields: Product["fields"] & {
    billingInterval: NonNullable<BillingInterval>;
  };
  price: NonNullable<Product["price"]>;
  status: 1;
  type: "membership";
};

export function isActiveMembershipProduct(
  product: MembershipProductCandidate | Product | null,
): product is ActiveMembershipProduct {
  return Boolean(
    product &&
    product.status === 1 &&
    product.type === "membership" &&
    product.price?.status === 1 &&
    product.fields.billingInterval,
  );
}

async function hasActiveMerchantProductAndPrice(productId: string) {
  const adapter = getCourseBuilderAdapter();
  const merchantProduct = await adapter.getMerchantProductForProductId(productId);

  if (merchantProduct?.status !== 1 || !merchantProduct.identifier) {
    return false;
  }

  const merchantPrice = await adapter.getMerchantPriceForProductId(merchantProduct.id);

  return merchantPrice?.status === 1 && Boolean(merchantPrice.identifier);
}

export async function getActiveMembershipProduct(productId: string) {
  const product = await getCourseBuilderAdapter().getProduct(productId, false);

  if (
    !product ||
    product.id !== productId ||
    !isActiveMembershipProduct(product) ||
    !(await hasActiveMerchantProductAndPrice(product.id))
  ) {
    return null;
  }

  return product;
}

export async function getActiveMembershipProducts() {
  const db = getEggheadDatabase();
  const productIds = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.status, 1), eq(products.type, "membership")));
  const membershipProducts = await Promise.all(
    productIds.map(({ id }) => getActiveMembershipProduct(id)),
  );

  return membershipProducts.filter(
    (product): product is ActiveMembershipProduct => product !== null,
  );
}
