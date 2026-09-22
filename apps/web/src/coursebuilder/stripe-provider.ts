import StripeProvider, { StripePaymentAdapter } from "@coursebuilder/commerce/stripe-provider";
import type { PaymentsProviderConfig } from "@coursebuilder/core/types";

import { getEggheadRuntime } from "../db/local-docker";
import { getEnv } from "../env";

const TRAILING_SLASH = /\/$/;

class EggheadStripePaymentAdapter extends StripePaymentAdapter {
  async retrieveStripeEventCreatedAt(eventId: string) {
    const event = await this.stripe.events.retrieve(eventId);
    return event.created;
  }

  async expireSubscriptionCheckout(sessionId: string) {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId);
    if (session.status === "complete") return "complete" as const;
    if (session.status === "expired") return "expired" as const;

    try {
      await this.stripe.checkout.sessions.expire(sessionId);
      return "expired" as const;
    } catch (error) {
      const current = await this.stripe.checkout.sessions.retrieve(sessionId);
      if (current.status === "complete") return "complete" as const;
      if (current.status === "expired") return "expired" as const;
      throw error;
    }
  }
}
export async function expireStripeSubscriptionCheckoutSession(sessionId: string) {
  const paymentsAdapter = getStripeProvider()?.options.paymentsAdapter;
  if (!(paymentsAdapter instanceof EggheadStripePaymentAdapter)) {
    throw new Error("Stripe is not configured.");
  }

  return paymentsAdapter.expireSubscriptionCheckout(sessionId);
}
export async function retrieveStripeEventCreatedAt(
  provider: PaymentsProviderConfig,
  eventId: string,
) {
  const paymentsAdapter = provider.options.paymentsAdapter;
  if (!(paymentsAdapter instanceof EggheadStripePaymentAdapter)) {
    throw new Error("Stripe is not configured.");
  }

  return paymentsAdapter.retrieveStripeEventCreatedAt(eventId);
}

export function getSiteUrl() {
  const configuredUrl = getEnv("NEXT_PUBLIC_APP_URL");
  if (getEggheadRuntime() === "production") {
    if (
      !configuredUrl ||
      !URL.canParse(configuredUrl) ||
      new URL(configuredUrl).protocol !== "https:"
    ) {
      throw new Error("Production Stripe checkout requires an HTTPS NEXT_PUBLIC_APP_URL.");
    }
  }
  return (configuredUrl ?? "http://localhost:3008").replace(TRAILING_SLASH, "");
}

export function getStripeProvider() {
  const stripeToken = getEnv("STRIPE_SECRET_TOKEN");
  const stripeWebhookSecret = getEnv("STRIPE_WEBHOOK_SECRET");

  if (!stripeToken || !stripeWebhookSecret) {
    return null;
  }

  const siteUrl = getSiteUrl();

  return StripeProvider({
    errorRedirectUrl: `${siteUrl}/pricing?error=checkout`,
    baseSuccessUrl: siteUrl,
    cancelUrl: `${siteUrl}/pricing`,
    paymentsAdapter: new EggheadStripePaymentAdapter({
      stripeToken,
      stripeWebhookSecret,
    }),
  });
}
