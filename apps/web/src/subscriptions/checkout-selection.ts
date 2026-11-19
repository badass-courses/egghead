import { z } from "zod";
import { subscriptionCheckoutQuantitySchema } from "./team-contracts";

const productSelectionSchema = z.object({
  productId: z.string().min(1),
  priceId: z.string().min(1),
});

/**
 * Decode the pricing form. A bad product or price is `invalid-product`; a bad
 * quantity keeps main's `invalid-seats` so the page shows the seat message.
 */
export function parseCheckoutSelection(form: { get(name: string): unknown }) {
  const product = productSelectionSchema.safeParse({
    productId: form.get("productId"),
    priceId: form.get("priceId"),
  });
  if (!product.success) return { status: "invalid", error: "invalid-product" } as const;
  const quantity = subscriptionCheckoutQuantitySchema.safeParse(form.get("quantity"));
  if (!quantity.success) return { status: "invalid", error: "invalid-seats" } as const;
  return { status: "valid", selection: { ...product.data, quantity: quantity.data } } as const;
}
