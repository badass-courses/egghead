"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { getCurrentUser } from "../../coursebuilder/current-user";
import {
  getSiteUrl,
  getStripeProvider,
  isStripeConfigured,
  stripeMembershipCatalogProvider,
  stripeSubscriptionCheckoutProvider,
} from "../../coursebuilder/stripe-provider";
import { getEggheadDatabase } from "../../db/adapter";
import { merchantCustomer } from "../../db/schema";
import { assertCommerceWritesAllowed } from "../../db/local-docker";
import { getActiveMembershipProducts } from "../../subscriptions/catalog";
import { validateStripeMembershipMapping } from "../../subscriptions/catalog-contracts";
import { startReservedSubscriptionCheckout } from "../../subscriptions/checkout-state";
import { organizationCheckoutStore } from "../../subscriptions/checkout-store";
import { ensurePersonalOrganization } from "../../subscriptions/personal-organization";
import { getCurrentSubscriptionForUser } from "../../subscriptions/status";
import { subscriptionCheckoutQuantitySchema } from "../../subscriptions/team-contracts";

/** Validate the exact mapped membership, then serialize checkout against its durable intent. */
export async function startSubscriptionCheckout(formData: FormData) {
  assertCommerceWritesAllowed();
  const user = await getCurrentUser();
  if (!user?.id) redirect("/login?callbackUrl=/pricing");
  if (!user.email) redirect("/pricing?error=missing-email");
  if (await getCurrentSubscriptionForUser(user.id)) redirect("/thanks/subscription?existing=true");

  const productId = formData.get("productId");
  const parsedQuantity = subscriptionCheckoutQuantitySchema.safeParse(formData.get("quantity"));
  if (typeof productId !== "string") redirect("/pricing?error=invalid-product");
  if (!parsedQuantity.success) redirect("/pricing?error=invalid-seats");
  if (!isStripeConfigured()) redirect("/pricing?error=not-configured");
  const quantity = parsedQuantity.data;
  let checkoutRedirect: string;

  try {
    // Resolving the full catalog also rejects duplicate monthly/yearly selections.
    const product = (await getActiveMembershipProducts()).find(
      (candidate) => candidate.id === productId,
    );
    if (!product) throw new Error("Membership product is not active.");
    const provider = getStripeProvider();
    if (!provider) throw new Error("Stripe is not configured.");
    await validateStripeMembershipMapping(
      product.checkoutMapping,
      quantity,
      stripeMembershipCatalogProvider(provider),
    );

    const customers = await getEggheadDatabase()
      .select()
      .from(merchantCustomer)
      .where(eq(merchantCustomer.userId, user.id));
    if (customers.length > 1)
      throw new Error("Ambiguous Stripe customer mapping; reconciliation required.");
    const [customer] = customers;
    if (
      customer &&
      (customer.status !== 1 ||
        customer.merchantAccountId !== product.checkoutMapping.merchantAccountId ||
        !customer.identifier)
    ) {
      throw new Error("Existing Stripe customer mapping does not match the checkout account.");
    }
    if (customer) {
      const stripeCustomer = await provider.getCustomer(customer.identifier);
      if (stripeCustomer.livemode || ("deleted" in stripeCustomer && stripeCustomer.deleted)) {
        throw new Error("Existing Stripe customer is not an active test-mode customer.");
      }
    }

    const requestHeaders = await headers();
    const country =
      requestHeaders.get("x-vercel-ip-country") ?? requestHeaders.get("cf-ipcountry") ?? "US";
    const { organization } = await ensurePersonalOrganization({ id: user.id, email: user.email });
    checkoutRedirect = await startReservedSubscriptionCheckout(
      {
        mapping: product.checkoutMapping,
        productName: product.name,
        quantity,
        country,
        siteUrl: getSiteUrl(),
        userId: user.id,
        organizationId: organization.id,
        email: user.email,
        ...(customer ? { customerId: customer.identifier } : {}),
      },
      organizationCheckoutStore(organization.id),
      stripeSubscriptionCheckoutProvider(provider),
    );
    console.info("Subscription checkout ready", {
      productId,
      interval: product.checkoutMapping.interval,
      quantity,
    });
  } catch (error) {
    console.error("Subscription checkout blocked; reservation retained", {
      reason: error instanceof Error ? error.message : "Unknown checkout failure",
      productId,
      quantity,
    });
    redirect("/pricing?error=checkout");
  }
  redirect(checkoutRedirect);
}
