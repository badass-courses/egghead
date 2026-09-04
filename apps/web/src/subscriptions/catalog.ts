import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { getCourseBuilderAdapter, getEggheadDatabase } from "../db/adapter";
import { merchantAccount, merchantPrice, merchantProduct, prices, products } from "../db/schema";
import {
  assertMembershipCheckoutMapping,
  assertUniqueMembershipMappings,
  validateStripeMembershipMapping,
  type MembershipCheckoutIdentity,
  type MembershipCatalogProvider,
  resolveMembershipMapping,
  type MembershipMapping,
  type MembershipBillingInterval,
} from "./catalog-contracts";

type MembershipProductCandidate = {
  fields: {
    billingInterval?: MembershipBillingInterval | null;
  };
  price?: {
    status: number;
  } | null;
  status: number;
  type?: string;
};

// Published core's Zod-derived Product/BillingInterval declarations are not usable
// across its Zod version boundary. Parse only the catalog's actual public contract.
const activeMembershipSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  fields: z.object({
    billingInterval: z.enum(["month", "year"]),
    description: z.string().nullable().optional(),
  }),
  price: z.object({
    id: z.string().min(1),
    status: z.literal(1),
    unitAmount: z.number().positive(),
  }),
  status: z.literal(1),
  type: z.literal("membership"),
});
export type ActiveMembershipProduct = z.infer<typeof activeMembershipSchema>;

/** Checks the local product and price fields required for a recurring membership. */
export function isActiveMembershipProduct(product: MembershipProductCandidate | null) {
  return Boolean(
    product &&
    product.status === 1 &&
    product.type === "membership" &&
    product.price?.status === 1 &&
    (product.fields.billingInterval === "month" || product.fields.billingInterval === "year"),
  );
}

export type MappedMembershipProduct = ActiveMembershipProduct & {
  checkoutMapping: MembershipMapping;
};

/** Resolve all mapping rows: the published adapter's findFirst cannot detect ambiguity. */
async function loadActiveMembershipProduct(
  productId: string,
): Promise<MappedMembershipProduct | null> {
  const db = getEggheadDatabase();
  const parsedProduct = activeMembershipSchema.safeParse(
    await getCourseBuilderAdapter().getProduct(productId, false),
  );
  if (!parsedProduct.success || parsedProduct.data.id !== productId) return null;
  const product = parsedProduct.data;
  const [productPrices, productMappings, accounts] = await Promise.all([
    db.select().from(prices).where(eq(prices.productId, productId)),
    db.select().from(merchantProduct).where(eq(merchantProduct.productId, productId)),
    db.select().from(merchantAccount).where(eq(merchantAccount.label, "stripe")),
  ]);
  const mappingIds = productMappings
    .filter((mapping) => mapping.status === 1)
    .map((mapping) => mapping.id);
  const priceMappings = mappingIds.length
    ? await db
        .select()
        .from(merchantPrice)
        .where(inArray(merchantPrice.merchantProductId, mappingIds))
    : [];
  const checkoutMapping = resolveMembershipMapping({
    productId,
    interval: product.fields.billingInterval,
    prices: productPrices,
    merchantProducts: productMappings,
    merchantPrices: priceMappings,
    merchantAccounts: accounts,
  });
  if (!checkoutMapping) return null;
  if (product.price.id !== checkoutMapping.priceId) {
    throw new Error(`Adapter selected a different membership price for ${productId}.`);
  }
  return { ...product, checkoutMapping };
}

/** Discovers every active CourseBuilder membership that is ready to be displayed and purchased. */
export async function getActiveMembershipProducts(): Promise<MappedMembershipProduct[]> {
  const db = getEggheadDatabase();
  const productIds = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.status, 1), eq(products.type, "membership")));
  const membershipProducts = await Promise.all(
    productIds.map(({ id }) => loadActiveMembershipProduct(id)),
  );

  const active = membershipProducts.filter(
    (product): product is MappedMembershipProduct => product !== null,
  );
  assertUniqueMembershipMappings(active.map((product) => product.checkoutMapping));
  return active;
}

/** Direct selection must not bypass the catalog-wide uniqueness checks. */
export async function getActiveMembershipProduct(productId: string) {
  return (await getActiveMembershipProducts()).find((product) => product.id === productId) ?? null;
}

export async function getValidatedMembershipCheckoutMapping(
  identity: MembershipCheckoutIdentity & { quantity: number },
  provider: MembershipCatalogProvider,
) {
  const product = await getActiveMembershipProduct(identity.productId);
  const mapping = assertMembershipCheckoutMapping(product?.checkoutMapping, identity);
  return validateStripeMembershipMapping(mapping, identity.quantity, provider);
}
