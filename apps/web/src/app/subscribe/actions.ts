"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getCurrentUser } from "../../coursebuilder/current-user";
import { getSiteUrl, getStripeProvider } from "../../coursebuilder/stripe-provider";
import { getCourseBuilderAdapter } from "../../db/adapter";
import { assertCommerceWritesAllowed } from "../../db/local-docker";
import { getEnv } from "../../env";
import {
  isConfiguredSubscriptionProductId,
  subscriptionProductFields,
  subscriptionProductIds,
} from "../../subscriptions/options";
import { ensurePersonalOrganization } from "../../subscriptions/personal-organization";
import { getCurrentSubscriptionForUser } from "../../subscriptions/status";

export async function startSubscriptionCheckout(formData: FormData) {
  assertCommerceWritesAllowed();

  const user = await getCurrentUser();

  if (!user?.id) {
    redirect("/login?callbackUrl=/subscribe");
  }
  if (!user.email) {
    redirect("/subscribe?error=missing-email");
  }

  const currentSubscription = await getCurrentSubscriptionForUser(user.id);
  if (currentSubscription) {
    redirect("/thanks/subscription?existing=true");
  }

  const configuredProductIds = subscriptionProductIds(
    getEnv("EGGHEAD_SUBSCRIPTION_PRODUCT_IDS"),
    getEnv("EGGHEAD_SUBSCRIPTION_PRODUCT_ID"),
  );
  const requestedProductId = formData.get("productId");

  if (
    typeof requestedProductId !== "string" ||
    !isConfiguredSubscriptionProductId(requestedProductId, configuredProductIds)
  ) {
    redirect("/subscribe?error=invalid-product");
  }

  const productId = requestedProductId;
  const stripeProvider = getStripeProvider();
  const adapter = getCourseBuilderAdapter();
  const product = await adapter.getProduct(productId, false);
  const productFields = subscriptionProductFields(product?.fields);

  if (
    !stripeProvider ||
    !product ||
    product.type !== "membership" ||
    !product.price ||
    product.price.status !== 1 ||
    !productFields.billingInterval
  ) {
    redirect("/subscribe?error=not-configured");
  }

  const { organization } = await ensurePersonalOrganization(
    { id: user.id, email: user.email },
    adapter,
  );
  const requestHeaders = await headers();
  const country =
    requestHeaders.get("x-vercel-ip-country") ?? requestHeaders.get("cf-ipcountry") ?? "US";
  let checkoutRedirect: string;

  try {
    const checkout = await stripeProvider.createCheckoutSession(
      {
        productId,
        userId: user.id,
        organizationId: organization.id,
        quantity: 1,
        bulk: false,
        country,
        cancelUrl: `${getSiteUrl()}/subscribe`,
      },
      adapter,
    );
    checkoutRedirect = checkout.redirect;
  } catch {
    redirect("/subscribe?error=checkout");
  }

  redirect(checkoutRedirect);
}
