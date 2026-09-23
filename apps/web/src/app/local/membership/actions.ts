"use server";

import { resolveCheckoutPrice } from "@coursebuilder/commerce/resolve-checkout-price";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  getLocalMembership,
  getLocalMembershipServices,
  LOCAL_MEMBERSHIP_ID,
  LOCAL_MEMBERSHIP_PATH,
  syncLocalMembership,
} from "../../../local-membership/catalog";

async function localOrigin() {
  getLocalMembershipServices();
  const requestHeaders = await headers();
  const host = requestHeaders.get("host");
  if (host !== "localhost:3008" && host !== "127.0.0.1:3008")
    throw new Error("Local requests only");
  const origin = `http://${host}`;
  if (requestHeaders.get("origin") !== origin) throw new Error("Invalid request origin");
  return origin;
}

export async function checkoutMembership(data: FormData) {
  const origin = await localOrigin();
  const priceId = z.string().min(1).parse(data.get("priceId"));
  const returnPath = z
    .enum([LOCAL_MEMBERSHIP_PATH, "/pricing"])
    .parse(data.get("returnPath") ?? LOCAL_MEMBERSHIP_PATH);
  const quantity = z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(data.get("quantity") ?? 1);
  const requestId = z.uuid().parse(data.get("requestId"));
  const { adapter, payments } = getLocalMembershipServices();
  const { stripePrice } = await resolveCheckoutPrice({
    productId: LOCAL_MEMBERSHIP_ID,
    priceId,
    adapter,
    paymentsAdapter: payments,
  });
  if (stripePrice.livemode || !stripePrice.recurring)
    throw new Error("A test recurring price is required");
  const session = await payments.stripe.checkout.sessions.create(
    {
      mode: "subscription",
      line_items: [{ price: stripePrice.id, quantity }],
      success_url: `${origin}${returnPath}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}${returnPath}?cancelled=1`,
      client_reference_id: LOCAL_MEMBERSHIP_ID,
      metadata: {
        local_test: "egghead-local-multiple-prices-v3",
        productId: LOCAL_MEMBERSHIP_ID,
        priceId,
      },
    },
    { idempotencyKey: `local-membership-${priceId}-${quantity}-${requestId}` },
  );
  if (!session.url || session.livemode) throw new Error("Could not create a test checkout");
  redirect(session.url);
}

export async function saveMembershipOffers(data: FormData) {
  await localOrigin();
  const product = await getLocalMembership();
  const defaultPriceId = z.string().min(1).parse(data.get("defaultPriceId"));
  const offers = (product.prices ?? []).map((price) => ({
    priceId: price.id,
    offer: z
      .object({
        offered: z.boolean(),
        label: z.string().trim().min(1).max(100),
        position: z.coerce.number().int().min(0).max(100),
      })
      .parse({
        offered: data.get(`offered:${price.id}`) === "on",
        label: data.get(`label:${price.id}`),
        position: data.get(`position:${price.id}`),
      }),
  }));
  if (!offers.some((item) => item.priceId === defaultPriceId && item.offer.offered))
    redirect(`${LOCAL_MEMBERSHIP_PATH}?error=default-offered`);
  const { adapter } = getLocalMembershipServices();
  if (!adapter.configureProductPrice) throw new Error("Multi-price adapter is required");
  const configure = adapter.configureProductPrice.bind(adapter);
  await Promise.all(
    offers.map((item) =>
      configure({ ...item, productId: product.id, default: item.priceId === defaultPriceId }),
    ),
  );
  revalidatePath(LOCAL_MEMBERSHIP_PATH);
  revalidatePath("/pricing");
  redirect(`${LOCAL_MEMBERSHIP_PATH}?saved=1`);
}

export async function refreshMembershipPrices() {
  await localOrigin();
  await syncLocalMembership();
  revalidatePath(LOCAL_MEMBERSHIP_PATH);
  revalidatePath("/pricing");
  redirect(`${LOCAL_MEMBERSHIP_PATH}?synced=1`);
}
