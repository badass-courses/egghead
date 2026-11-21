import { z } from "zod";

import { EGGHEAD_STRIPE_CATALOGUE } from "./catalogue";

export interface TenantCatalogue {
  readonly products: readonly string[];
  readonly prices: readonly string[];
}

const reference = z.union([z.string(), z.object({ id: z.string() })]);
const itemSchema = z.object({
  price: z.object({ id: z.string(), product: reference.optional() }).optional(),
  plan: z.object({ id: z.string(), product: reference.optional() }).optional(),
});
const tenantSubscriptionSchema = z.object({
  items: z.object({ data: z.array(itemSchema).min(1) }),
});

/** Metadata can corroborate or veto a catalogue match, never establish one. */
export function isEggheadSubscription(
  raw: unknown,
  metadata: Record<string, string>,
  catalogue: TenantCatalogue = EGGHEAD_STRIPE_CATALOGUE,
) {
  const parsed = tenantSubscriptionSchema.safeParse(raw);
  if (!parsed.success) return false;
  if (metadata["site"] && !["egghead", "egghead.io"].includes(metadata["site"])) return false;
  return parsed.data.items.data.every((item) => {
    const price = item.price ?? item.plan;
    if (!price) return false;
    const product = typeof price.product === "string" ? price.product : price.product?.id;
    return (
      catalogue.prices.includes(price.id) ||
      (product !== undefined && catalogue.products.includes(product))
    );
  });
}
