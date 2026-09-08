import { createHash } from "node:crypto";

import StripeProvider, { StripePaymentAdapter } from "@coursebuilder/core/providers/stripe";
import type { PaymentsProviderConfig } from "@coursebuilder/core/types";

import { assertCommerceWritesAllowed } from "../db/local-docker";
import { getEnv } from "../env";
import type { MembershipCatalogProvider } from "../subscriptions/catalog-contracts";
import type {
  CheckoutProvider,
  CheckoutSession,
  SubscriptionCheckoutParams,
} from "../subscriptions/checkout-state";

const TRAILING_SLASH = /\/$/;

export function subscriptionCheckoutIdempotencyKey(attempt: string, params: object) {
  // Object property insertion order must not create a second idempotency key.
  const serialized = JSON.stringify(params, (_key, value: unknown) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value).toSorted(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      );
    }
    return value;
  });
  if (serialized === undefined) throw new Error("Unable to serialize subscription checkout.");
  return `egghead-subscription-checkout:${attempt}:${createHash("sha256").update(serialized).digest("hex")}`;
}

export function assertStripeTestSecret(token: string) {
  if (!token.startsWith("sk_test_") && !token.startsWith("rk_test_")) {
    throw new Error("Only Stripe test-mode credentials are allowed.");
  }
}

function checkoutSession(session: {
  id: string;
  status: CheckoutSession["status"] | null;
  url: string | null;
  livemode: boolean;
  customer: string | { id: string } | null;
  subscription: string | { id: string } | null;
  metadata: Record<string, string> | null;
}): CheckoutSession {
  if (!session.status) throw new Error("Stripe checkout status is missing.");
  return {
    id: session.id,
    status: session.status,
    url: session.url,
    livemode: session.livemode,
    customerId:
      typeof session.customer === "string" ? session.customer : (session.customer?.id ?? null),
    subscriptionId:
      typeof session.subscription === "string"
        ? session.subscription
        : (session.subscription?.id ?? null),
    userId: session.metadata?.["userId"] ?? null,
    organizationId: session.metadata?.["organizationId"] ?? null,
    productId: session.metadata?.["productId"] ?? null,
  };
}

class EggheadStripePaymentAdapter extends StripePaymentAdapter {
  async retrieveStripeEventCreatedAt(eventId: string) {
    return (await this.stripe.events.retrieve(eventId)).created;
  }

  async retrieveSubscriptionForLifecycle(subscriptionId: string) {
    return this.stripe.subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice"] });
  }

  async getTestAccount() {
    // Account objects have no livemode flag. Balance is mode-scoped for this credential.
    const [account, balance] = await Promise.all([
      this.stripe.accounts.retrieve(),
      this.stripe.balance.retrieve(),
    ]);
    return { id: account.id, livemode: balance.livemode };
  }

  override async createCheckoutSession(): Promise<string | null> {
    throw new Error("Membership checkout requires a durable organization reservation.");
  }

  async createReservedCheckout(params: SubscriptionCheckoutParams, token: string) {
    assertCommerceWritesAllowed();
    const line = params.line_items[0];
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 100) {
      throw new Error("Subscription quantity must be between 1 and 100.");
    }
    const { customer, customer_email, ...requiredParams } = params;
    const stripeParams = {
      ...requiredParams,
      ...(customer ? { customer } : {}),
      ...(customer_email ? { customer_email } : {}),
    };
    return checkoutSession(
      await this.stripe.checkout.sessions.create(stripeParams, {
        idempotencyKey: subscriptionCheckoutIdempotencyKey(token, stripeParams),
      }),
    );
  }

  async retrieveReservedCheckout(id: string) {
    return checkoutSession(await this.stripe.checkout.sessions.retrieve(id));
  }

  async expireReservedCheckout(id: string) {
    assertCommerceWritesAllowed();
    return checkoutSession(await this.stripe.checkout.sessions.expire(id));
  }
}

function eggheadPaymentsAdapter(provider: PaymentsProviderConfig) {
  const adapter = provider.options.paymentsAdapter;
  if (!(adapter instanceof EggheadStripePaymentAdapter))
    throw new Error("Stripe is not configured.");
  return adapter;
}

export function stripeMembershipCatalogProvider(
  provider: PaymentsProviderConfig,
): MembershipCatalogProvider {
  const adapter = eggheadPaymentsAdapter(provider);
  return {
    getAccount: () => adapter.getTestAccount(),
    getProduct: (id) => adapter.getProduct(id),
    getPrice: (id) => adapter.getPrice(id),
  };
}

export function stripeSubscriptionCheckoutProvider(
  provider: PaymentsProviderConfig,
): CheckoutProvider {
  const adapter = eggheadPaymentsAdapter(provider);
  return {
    create: (params, token) => adapter.createReservedCheckout(params, token),
    retrieve: (id) => adapter.retrieveReservedCheckout(id),
    expire: (id) => adapter.expireReservedCheckout(id),
    getSubscription: async (id) => {
      const subscription = await adapter.getSubscription(id);
      return {
        id: subscription.id,
        customerId:
          typeof subscription.customer === "string"
            ? subscription.customer
            : subscription.customer.id,
        status: subscription.status,
        livemode: subscription.livemode,
      };
    },
  };
}

export async function retrieveStripeEventCreatedAt(
  provider: PaymentsProviderConfig,
  eventId: string,
) {
  return eggheadPaymentsAdapter(provider).retrieveStripeEventCreatedAt(eventId);
}

export async function retrieveStripeSubscriptionForLifecycle(
  provider: PaymentsProviderConfig,
  subscriptionId: string,
) {
  return eggheadPaymentsAdapter(provider).retrieveSubscriptionForLifecycle(subscriptionId);
}

export function getSiteUrl() {
  return (getEnv("NEXT_PUBLIC_APP_URL") ?? "http://localhost:3008").replace(TRAILING_SLASH, "");
}

export function isStripeConfigured() {
  const token = getEnv("STRIPE_SECRET_TOKEN");
  return Boolean(
    token &&
    (token.startsWith("sk_test_") || token.startsWith("rk_test_")) &&
    getEnv("STRIPE_WEBHOOK_SECRET"),
  );
}

export function getStripeProvider() {
  const stripeToken = getEnv("STRIPE_SECRET_TOKEN");
  const stripeWebhookSecret = getEnv("STRIPE_WEBHOOK_SECRET");
  if (!stripeToken || !stripeWebhookSecret) return null;
  assertStripeTestSecret(stripeToken);
  const siteUrl = getSiteUrl();
  const provider = StripeProvider({
    errorRedirectUrl: `${siteUrl}/pricing?error=checkout`,
    baseSuccessUrl: siteUrl,
    cancelUrl: `${siteUrl}/pricing`,
    paymentsAdapter: new EggheadStripePaymentAdapter({ stripeToken, stripeWebhookSecret }),
  });
  return {
    ...provider,
    // Published generic checkout mutates customers/coupons before creating a session.
    // The membership route uses validated mapping + immutable reservation instead.
    async createCheckoutSession(): Promise<never> {
      throw new Error("Use the reserved membership checkout action.");
    },
  };
}
