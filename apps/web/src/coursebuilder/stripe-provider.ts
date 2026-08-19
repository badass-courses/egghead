import { createHash } from "node:crypto";

import StripeProvider, { StripePaymentAdapter } from "@coursebuilder/core/providers/stripe";
import type { PaymentsProviderConfig } from "@coursebuilder/core/types";

import { getEnv } from "../env";

const TRAILING_SLASH = /\/$/;
export function subscriptionCheckoutIdempotencyKey(
  subscriptionCheckoutAttempt: string,
  params: object,
) {
  const serializedParams = JSON.stringify(params);
  if (serializedParams === undefined) {
    throw new Error("Unable to serialize Stripe subscription checkout parameters.");
  }

  const parameterFingerprint = createHash("sha256").update(serializedParams).digest("hex");
  return `egghead-subscription-checkout:${subscriptionCheckoutAttempt}:${parameterFingerprint}`;
}

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
  async retrieveStripeEventCreatedAt(eventId: string) {
    const event = await this.stripe.events.retrieve(eventId);
    return event.created;
  }

  async expireSubscriptionCheckout(sessionId: string) {
    await this.stripe.checkout.sessions.expire(sessionId);
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
      idempotencyKey: subscriptionCheckoutIdempotencyKey(
        this.subscriptionCheckoutAttempt,
        stableParams,
      ),
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
export async function expireStripeSubscriptionCheckoutSession(sessionId: string) {
  const paymentsAdapter = getStripeProvider()?.options.paymentsAdapter;
  if (!(paymentsAdapter instanceof EggheadStripePaymentAdapter)) {
    throw new Error("Stripe is not configured.");
  }

  await paymentsAdapter.expireSubscriptionCheckout(sessionId);
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
