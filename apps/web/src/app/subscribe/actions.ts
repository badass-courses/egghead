"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getCurrentUser } from "../../coursebuilder/current-user";
import { getSiteUrl, getStripeProvider } from "../../coursebuilder/stripe-provider";
import { getCourseBuilderAdapter } from "../../db/adapter";
import { assertCommerceWritesAllowed } from "../../db/local-docker";
import { getEnv } from "../../env";
import { ensurePersonalOrganization } from "../../subscriptions/personal-organization";
import { getCurrentSubscriptionForUser } from "../../subscriptions/status";

export async function startSubscriptionCheckout() {
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

  const productId = getEnv("EGGHEAD_SUBSCRIPTION_PRODUCT_ID");
  const stripeProvider = getStripeProvider();

  if (!productId || !stripeProvider) {
    redirect("/subscribe?error=not-configured");
  }

  const adapter = getCourseBuilderAdapter();
  const { organization } = await ensurePersonalOrganization(
    { id: user.id, email: user.email },
    adapter,
  );
  const requestHeaders = await headers();
  const country =
    requestHeaders.get("x-vercel-ip-country") ?? requestHeaders.get("cf-ipcountry") ?? "US";
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

  redirect(checkout.redirect);
}
