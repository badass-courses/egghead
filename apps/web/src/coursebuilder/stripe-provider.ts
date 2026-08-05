import StripeProvider, { StripePaymentAdapter } from "@coursebuilder/core/providers/stripe";

import { getEnv } from "../env";

const TRAILING_SLASH = /\/$/;

export function getSiteUrl() {
  return (getEnv("NEXT_PUBLIC_APP_URL") ?? "http://localhost:3008").replace(TRAILING_SLASH, "");
}

export function isStripeConfigured() {
  return Boolean(getEnv("STRIPE_SECRET_TOKEN") && getEnv("STRIPE_WEBHOOK_SECRET"));
}

export function getStripeProvider() {
  const stripeToken = getEnv("STRIPE_SECRET_TOKEN");
  const stripeWebhookSecret = getEnv("STRIPE_WEBHOOK_SECRET");

  if (!stripeToken || !stripeWebhookSecret) {
    return null;
  }

  const siteUrl = getSiteUrl();

  return StripeProvider({
    errorRedirectUrl: `${siteUrl}/subscribe?error=checkout`,
    baseSuccessUrl: siteUrl,
    cancelUrl: `${siteUrl}/subscribe`,
    paymentsAdapter: new StripePaymentAdapter({
      stripeToken,
      stripeWebhookSecret,
    }),
  });
}
