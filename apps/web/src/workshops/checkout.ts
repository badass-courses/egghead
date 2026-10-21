"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { resolveCheckoutPrice } from "@coursebuilder/commerce/resolve-checkout-price";
import { getCourseBuilderAdapter } from "../db/adapter";
import { assertCommerceWritesAllowed, getEggheadRuntime } from "../db/local-docker";
import { getCurrentUser } from "../coursebuilder/current-user";
import { getSiteUrl } from "../coursebuilder/stripe-provider";
import { getPublishedWorkshop, getWorkshopOffer } from "./catalog";
import { getWorkshopPayments, workshopCheckoutOrigin } from "./payments";
import { canPurchaseWorkshop, workshopCheckoutIdempotencyKey } from "./checkout-contract";

export async function startWorkshopCheckout(data: FormData) {
  assertCommerceWritesAllowed();
  const input = z
    .object({ workshopId: z.string().min(1).max(200), requestId: z.uuid() })
    .parse(Object.fromEntries(data));
  const workshop = await getPublishedWorkshop(input.workshopId);
  if (!workshop) throw new Error("Workshop is not published");
  const offer = await getWorkshopOffer(workshop);
  const services = getWorkshopPayments();
  if (
    !offer ||
    !services ||
    !canPurchaseWorkshop({
      state: workshop.fields.state,
      hasOffer: true,
      startsAt: workshop.fields.startsAt,
    })
  )
    throw new Error("Workshop is not available for purchase");
  const origin = workshopCheckoutOrigin(
    getSiteUrl(),
    (await headers()).get("origin"),
    getEggheadRuntime(),
  );
  const { stripePrice } = await resolveCheckoutPrice({
    productId: offer.productId,
    priceId: offer.priceId,
    adapter: getCourseBuilderAdapter(),
    paymentsAdapter: services.payments,
  });
  if (stripePrice.recurring || stripePrice.livemode !== services.live)
    throw new Error("Expected a one-time Workshop price in the configured Stripe mode");
  const user = await getCurrentUser();
  const metadata = {
    workshopId: workshop.id,
    productId: offer.productId,
    priceId: offer.priceId,
    product: workshop.fields.title,
    bulk: "false",
    country: "US",
    cbPricingContract: "v1",
    expectedTotalCents: String(stripePrice.unit_amount),
    subtotalCents: String(stripePrice.unit_amount),
    ...(user?.id ? { userId: user.id } : {}),
  };
  const path = `/workshop/${encodeURIComponent(workshop.id)}`;
  const session = await services.payments.stripe.checkout.sessions.create(
    {
      mode: "payment",
      line_items: [{ price: stripePrice.id, quantity: 1 }],
      customer_creation: "always",
      ...(user?.email ? { customer_email: user.email } : {}),
      metadata,
      success_url: `${origin}${path}/thanks?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}${path}?cancelled=1`,
    },
    { idempotencyKey: workshopCheckoutIdempotencyKey(workshop.id, input.requestId) },
  );
  if (!session.url || session.livemode !== services.live)
    throw new Error("Invalid Workshop checkout session");
  redirect(session.url);
}
