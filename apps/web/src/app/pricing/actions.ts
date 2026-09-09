"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { resolveCheckoutPrice } from "@coursebuilder/commerce/resolve-checkout-price";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { merchantCustomer } from "../../db/schema";
import { getCurrentUser } from "../../coursebuilder/current-user";
import { getCheckoutCustomer } from "../../subscriptions/checkout-customer";
import { getMembershipServices } from "../../subscriptions/catalog";
import { membershipCheckoutOrigin } from "../../subscriptions/configuration";

export async function startSubscriptionCheckout(data: FormData) {
  const user = await getCurrentUser();
  if (!user?.id) redirect("/login?callbackUrl=/pricing");
  if (!z.email().safeParse(user.email).success || !user.email)
    redirect("/pricing?error=missing-email");
  const services = getMembershipServices();
  if (!services) redirect("/pricing?error=not-configured");
  const { adapter, payments, configuration, db } = services;
  const input = z
    .object({
      productId: z.literal(configuration.productId),
      priceId: z.string().min(1),
      quantity: z.coerce.number().int().min(1).max(100),
      requestId: z.uuid(),
    })
    .parse(Object.fromEntries(data));
  const origin = membershipCheckoutOrigin(
    process.env["NEXT_PUBLIC_APP_URL"] ?? process.env["COURSEBUILDER_URL"],
    (await headers()).get("origin"),
    configuration.localPreview,
  );
  const { stripePrice, merchantProduct } = await resolveCheckoutPrice({
    productId: input.productId,
    priceId: input.priceId,
    adapter,
    paymentsAdapter: payments,
  });
  if (!stripePrice.recurring || stripePrice.livemode !== configuration.live)
    throw new Error("Membership price must match the configured Stripe mode");
  const customerId = await getCheckoutCustomer({
    user: { id: user.id, email: user.email },
    merchantAccountId: merchantProduct.merchantAccountId,
    live: configuration.live,
    adapter: {
      getMerchantCustomerForUserId: async (userId) => {
        const mapping = await db.query.merchantCustomer.findFirst({
          where: and(
            eq(merchantCustomer.userId, userId),
            eq(merchantCustomer.merchantAccountId, merchantProduct.merchantAccountId),
          ),
        });
        return mapping ? { ...mapping, status: mapping.status ?? 0 } : null;
      },
      createMerchantCustomer: adapter.createMerchantCustomer.bind(adapter),
    },
    customers: payments.stripe.customers,
  });
  const metadata = { productId: input.productId, priceId: input.priceId, userId: user.id };
  const session = await payments.stripe.checkout.sessions.create(
    {
      mode: "subscription",
      line_items: [{ price: stripePrice.id, quantity: input.quantity }],
      customer: customerId,
      client_reference_id: user.id,
      metadata,
      subscription_data: { metadata },
      success_url: `${origin}/thanks/subscription?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/pricing?cancelled=1`,
    },
    {
      idempotencyKey: `membership-thanks-${customerId}-${user.id}-${input.priceId}-${input.quantity}-${input.requestId}`,
    },
  );
  if (!session.url || session.livemode !== configuration.live)
    throw new Error("Invalid Stripe checkout session");
  redirect(session.url);
}
