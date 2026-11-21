import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createShadowStripeReader, type ShadowStripeReader } from "./stripe-reader";
import type { TenantCatalogue } from "./tenant";

const ref = z.union([z.string(), z.object({ id: z.string() })]);
const subscriptionSchema = z.object({
  status: z.string(),
  items: z.object({
    data: z.array(
      z.object({
        price: z.object({ id: z.string(), product: ref }).optional(),
        plan: z.object({ id: z.string(), product: ref }).optional(),
      }),
    ),
  }),
});

/** Read-only regeneration. Only product/price IDs leave this function, never customer rows. */
export async function regenerateCatalogue(stripe: ShadowStripeReader): Promise<TenantCatalogue> {
  const products = new Set<string>();
  const prices = new Set<string>();
  const candidates = (await stripe.subscriptions()).flatMap((raw) => {
    const subscription = subscriptionSchema.parse(raw);
    if (!["active", "past_due", "trialing"].includes(subscription.status)) return [];
    return subscription.items.data.flatMap((item) => {
      const price = item.price ?? item.plan;
      return price
        ? [
            {
              id: price.id,
              productId: typeof price.product === "string" ? price.product : price.product.id,
            },
          ]
        : [];
    });
  });
  const productIds = [...new Set(candidates.map((candidate) => candidate.productId))];
  const sites = new Map(
    await Promise.all(
      productIds.map(async (productId): Promise<[string, string | undefined]> => {
        const product = z
          .object({ metadata: z.record(z.string(), z.string()) })
          .parse(await stripe.retrieve("products", productId));
        return [productId, product.metadata["site"]];
      }),
    ),
  );
  for (const candidate of candidates) {
    if (sites.get(candidate.productId) !== "egghead.io") continue;
    products.add(candidate.productId);
    prices.add(candidate.id);
  }
  return { products: [...products].toSorted(), prices: [...prices].toSorted() };
}

async function main() {
  const key = process.env["STRIPE_SHADOW_READ_KEY"];
  if (!key?.startsWith("rk_")) throw new Error("A restricted read-only Stripe key is required");
  const catalogue = await regenerateCatalogue(createShadowStripeReader(key));
  console.log(
    `import type { TenantCatalogue } from "./tenant";\n\n// Source: read-only Stripe subscription/product export, ${new Date().toISOString()}.\nexport const EGGHEAD_STRIPE_CATALOGUE: TenantCatalogue = ${JSON.stringify(catalogue, null, 2)};`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("Catalogue read failed. No Stripe response bodies logged.");
    process.exitCode = 1;
  });
}
