"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getCurrentUser } from "../../coursebuilder/current-user";
import { createMembershipCheckout } from "../../subscriptions/checkout";
import { subscriptionCheckoutQuantitySchema } from "../../subscriptions/team-contracts";

export async function startSubscriptionCheckout(formData: FormData) {
  const user = await getCurrentUser();
  if (!user?.id) redirect("/login?callbackUrl=/pricing");
  if (!user.email) redirect("/pricing?error=missing-email");
  const selection = z
    .object({
      productId: z.string().min(1),
      priceId: z.string().min(1),
      quantity: subscriptionCheckoutQuantitySchema,
    })
    .safeParse({
      productId: formData.get("productId"),
      priceId: formData.get("priceId"),
      quantity: formData.get("quantity"),
    });
  if (!selection.success) redirect("/pricing?error=invalid-product");
  const requestHeaders = await headers();
  let result: Awaited<ReturnType<typeof createMembershipCheckout>>;
  try {
    result = await createMembershipCheckout({
      ...selection.data,
      user: { id: user.id, email: user.email },
      requestOrigin: requestHeaders.get("origin"),
      country:
        requestHeaders.get("x-vercel-ip-country") ?? requestHeaders.get("cf-ipcountry") ?? "US",
    });
  } catch {
    redirect("/pricing?error=checkout");
  }
  if (result.status === "refused") {
    if (result.reason === "existing") redirect("/thanks/subscription?existing=true");
    redirect(`/pricing?error=${result.reason}`);
  }
  redirect(result.url);
}
