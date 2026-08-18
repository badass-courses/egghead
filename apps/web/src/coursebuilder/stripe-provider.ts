import StripeProvider, { StripePaymentAdapter } from "@coursebuilder/core/providers/stripe";
import type { PaymentsProviderConfig } from "@coursebuilder/core/types";

import { getEnv } from "../env";

const TRAILING_SLASH = /\/$/;

type CreatedSubscriptionCheckout = {
  expiresAt: number;
  id: string;
};

class EggheadStripePaymentAdapter extends StripePaymentAdapter {
  private createdSubscriptionCheckout: CreatedSubscriptionCheckout | null = null;

  constructor(
    options: ConstructorParameters<typeof StripePaymentAdapter>[0],
    private readonly subscriptionCheckoutAttempt: string | null,
  ) {
    super(options);
  }

  takeCreatedSubscriptionCheckout() {
    const createdCheckout = this.createdSubscriptionCheckout;
    this.createdSubscriptionCheckout = null;
    return createdCheckout;
  }

  override async createCheckoutSession(
    params: Parameters<StripePaymentAdapter["createCheckoutSession"]>[0],
  ) {
    if (params.mode !== "subscription" || !this.subscriptionCheckoutAttempt) {
      return super.createCheckoutSession(params);
    }

    const stableParams = { ...params };
    delete stableParams.expires_at;
    const session = await this.stripe.checkout.sessions.create(stableParams, {
      idempotencyKey: `egghead-subscription-checkout:${this.subscriptionCheckoutAttempt}`,
    });
    this.createdSubscriptionCheckout = {
      expiresAt: session.expires_at,
      id: session.id,
    };

    return session.url;
  }
}

export function takeCreatedStripeSubscriptionCheckout(provider: PaymentsProviderConfig) {
  const paymentsAdapter = provider.options.paymentsAdapter;
  if (!(paymentsAdapter instanceof EggheadStripePaymentAdapter)) {
    return null;
  }

  return paymentsAdapter.takeCreatedSubscriptionCheckout();
}

export function getSiteUrl() {
  return (getEnv("NEXT_PUBLIC_APP_URL") ?? "http://localhost:3008").replace(TRAILING_SLASH, "");
}

export function isStripeConfigured() {
  return Boolean(getEnv("STRIPE_SECRET_TOKEN") && getEnv("STRIPE_WEBHOOK_SECRET"));
}

export function getStripeProvider(subscriptionCheckoutAttempt: string | null = null) {
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
    paymentsAdapter: new EggheadStripePaymentAdapter(
      {
        stripeToken,
        stripeWebhookSecret,
      },
      subscriptionCheckoutAttempt,
    ),
  });
}
