import { z } from "zod";

export const membershipMappingSchema = z.object({
  productId: z.string().min(1),
  priceId: z.string().min(1),
  merchantProductId: z.string().min(1),
  merchantPriceId: z.string().min(1),
  merchantAccountId: z.string().min(1),
  stripeAccountId: z.string().min(1),
  stripeProductId: z.string().min(1),
  stripePriceId: z.string().min(1),
  interval: z.enum(["month", "year"]),
  currency: z.literal("usd"),
  unitAmount: z.number().int().positive(),
});
export type MembershipMapping = z.infer<typeof membershipMappingSchema>;
export type MembershipBillingInterval = MembershipMapping["interval"];

export type MembershipCheckoutIdentity = {
  productId: string;
  stripeProductId: string;
  stripePriceId: string;
  merchantAccountId: string;
};

/** D1 requires distinct monthly/yearly native products, not two prices on one product. */
export function assertUniqueMembershipMappings(mappings: readonly MembershipMapping[]) {
  const intervals = new Set<MembershipBillingInterval>();
  const nativeProducts = new Set<string>();
  const nativePrices = new Set<string>();
  for (const mapping of mappings) {
    const productKey = JSON.stringify([mapping.stripeAccountId, mapping.stripeProductId]);
    const priceKey = JSON.stringify([mapping.stripeAccountId, mapping.stripePriceId]);
    if (
      intervals.has(mapping.interval) ||
      nativeProducts.has(productKey) ||
      nativePrices.has(priceKey)
    ) {
      throw new Error(`Ambiguous membership catalog mapping for ${mapping.productId}.`);
    }
    intervals.add(mapping.interval);
    nativeProducts.add(productKey);
    nativePrices.add(priceKey);
  }
}

/** Bind signed checkout metadata to the selected local product and exact native mapping. */
export function assertMembershipCheckoutMapping(
  mapping: MembershipMapping | undefined,
  identity: MembershipCheckoutIdentity,
) {
  if (
    !mapping ||
    mapping.productId !== identity.productId ||
    mapping.stripeProductId !== identity.stripeProductId ||
    mapping.stripePriceId !== identity.stripePriceId ||
    mapping.merchantAccountId !== identity.merchantAccountId
  ) {
    throw new Error("Checkout metadata does not match its exact membership mapping.");
  }
  return mapping;
}

type MerchantProductRow = {
  id: string;
  productId: string;
  merchantAccountId: string;
  identifier: string | null;
  status: number;
};
type MerchantPriceRow = {
  id: string;
  merchantProductId: string;
  merchantAccountId: string;
  priceId: string | null;
  identifier: string | null;
  status: number | null;
};
type MerchantAccountRow = {
  id: string;
  identifier: string | null;
  label: string | null;
  status: number;
};

/** Published adapter 2.1.1 uses findFirst; inspect every candidate instead. */
export function resolveMembershipMapping(input: {
  productId: string;
  interval: "month" | "year";
  prices: { id: string; status: number; unitAmount: number | string }[];
  merchantProducts: MerchantProductRow[];
  merchantPrices: MerchantPriceRow[];
  merchantAccounts: MerchantAccountRow[];
}): MembershipMapping | null {
  const activePrices = input.prices.filter((price) => price.status === 1);
  const activeProducts = input.merchantProducts.filter((product) => product.status === 1);
  const activeMerchantPrices = input.merchantPrices.filter((price) => price.status === 1);
  const activeAccounts = input.merchantAccounts.filter(
    (account) => account.status === 1 && account.label === "stripe",
  );
  if (
    [activePrices, activeProducts, activeMerchantPrices, activeAccounts].some(
      (rows) => rows.length > 1,
    )
  ) {
    throw new Error(`Ambiguous membership mapping for ${input.productId}.`);
  }
  const [price] = activePrices;
  const [product] = activeProducts;
  const [merchantPrice] = activeMerchantPrices;
  const [account] = activeAccounts;
  if (!price || !product || !merchantPrice || !account) return null;
  if (
    product.productId !== input.productId ||
    product.merchantAccountId !== account.id ||
    merchantPrice.merchantProductId !== product.id ||
    merchantPrice.merchantAccountId !== account.id ||
    merchantPrice.priceId !== price.id
  ) {
    throw new Error(`Mismatched membership mapping for ${input.productId}.`);
  }
  const amount = Number(price.unitAmount) * 100;
  // The existing pricing UI and published checkout use USD major units.
  const unitAmount = Math.round(amount);
  if (!Number.isFinite(amount) || Math.abs(amount - unitAmount) > 0.000001) {
    throw new Error(`Invalid membership amount for ${input.productId}.`);
  }
  return membershipMappingSchema.parse({
    productId: input.productId,
    priceId: price.id,
    merchantProductId: product.id,
    merchantPriceId: merchantPrice.id,
    merchantAccountId: account.id,
    stripeAccountId: account.identifier,
    stripeProductId: product.identifier,
    stripePriceId: merchantPrice.identifier,
    interval: input.interval,
    currency: "usd",
    unitAmount,
  });
}

export type MembershipCatalogProvider = {
  getAccount(): Promise<{ id: string; livemode: boolean }>;
  getProduct(id: string): Promise<{ id: string; active: boolean; livemode: boolean }>;
  getPrice(id: string): Promise<{
    id: string;
    active: boolean;
    livemode: boolean;
    product: string | { id: string };
    currency: string;
    unit_amount: number | null;
    type: string;
    billing_scheme: string;
    recurring: { interval: string; interval_count: number; usage_type: string } | null;
    transform_quantity?: unknown;
  }>;
};

export async function validateStripeMembershipMapping(
  mapping: MembershipMapping,
  quantity: number,
  provider: MembershipCatalogProvider,
) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    throw new Error("Subscription quantity must be between 1 and 100.");
  }
  const [account, product, price] = await Promise.all([
    provider.getAccount(),
    provider.getProduct(mapping.stripeProductId),
    provider.getPrice(mapping.stripePriceId),
  ]);
  const priceProductId = typeof price.product === "string" ? price.product : price.product.id;
  if (account.livemode || product.livemode || price.livemode) {
    throw new Error("Live Stripe membership checkout is blocked.");
  }
  if (
    account.id !== mapping.stripeAccountId ||
    product.id !== mapping.stripeProductId ||
    !product.active ||
    price.id !== mapping.stripePriceId ||
    !price.active ||
    priceProductId !== product.id ||
    price.currency !== mapping.currency ||
    price.unit_amount !== mapping.unitAmount ||
    price.type !== "recurring" ||
    price.billing_scheme !== "per_unit" ||
    price.recurring?.interval !== mapping.interval ||
    price.recurring.interval_count !== 1 ||
    price.recurring.usage_type !== "licensed" ||
    price.transform_quantity
  ) {
    throw new Error(`Stripe membership mapping does not match ${mapping.productId}.`);
  }
  return mapping;
}
