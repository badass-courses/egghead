"use server";

import { createHash, randomUUID } from "node:crypto";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getCurrentUser } from "../../coursebuilder/current-user";
import {
  expireStripeSubscriptionCheckoutSession,
  subscriptionCheckoutIdempotencyKey,
} from "../../coursebuilder/stripe-provider";
import { getEggheadDatabase } from "../../db/adapter";
import { organization as organizationTable, merchantCustomer } from "../../db/schema";
import { getActiveMembershipProduct, getMembershipServices } from "../../subscriptions/catalog";
import { ensurePersonalOrganization } from "../../subscriptions/personal-organization";
import { getCurrentSubscriptionForUser } from "../../subscriptions/status";
import { subscriptionCheckoutQuantitySchema } from "../../subscriptions/team-contracts";

import { resolveCheckoutPrice } from "@coursebuilder/commerce/resolve-checkout-price";
import { getCheckoutCustomer } from "../../subscriptions/checkout-customer";
import { membershipCheckoutOrigin } from "../../subscriptions/configuration";

const CHECKOUT_RESERVATION_FIELD = "stripeSubscriptionCheckout";
const CHECKOUT_RESERVATION_PENDING_TTL_SECONDS = 2 * 60;
const organizationFieldsSchema = z.record(z.string(), z.unknown());
const checkoutReservationSchema = z.object({
  country: z.string(),
  pendingUntil: z.number().int(),
  productId: z.string(),
  priceId: z.string().optional(),
  quantity: subscriptionCheckoutQuantitySchema.default(1),
  sessionExpiresAt: z.number().int().optional(),
  sessionId: z.string().optional(),
  token: z.string(),
});

async function reserveSubscriptionCheckout(
  organizationId: string,
  productId: string,
  priceId: string,
  quantity: number,
  country: string,
) {
  const db = getEggheadDatabase();
  const { reservation, staleSessionId } = await db.transaction(async (transaction) => {
    const [storedOrganization] = await transaction
      .select({ fields: organizationTable.fields })
      .from(organizationTable)
      .where(eq(organizationTable.id, organizationId))
      .for("update");
    if (!storedOrganization) {
      throw new Error("Unable to reserve subscription checkout for the organization.");
    }

    const parsedFields = organizationFieldsSchema.safeParse(storedOrganization.fields ?? {});
    const fields = parsedFields.success ? parsedFields.data : {};
    const parsedReservation = checkoutReservationSchema.safeParse(
      fields[CHECKOUT_RESERVATION_FIELD],
    );
    const currentReservation = parsedReservation.success ? parsedReservation.data : null;
    const now = Math.floor(Date.now() / 1000);
    const currentReservationExpiresAt =
      currentReservation?.sessionExpiresAt ?? currentReservation?.pendingUntil ?? 0;
    const currentReservationIsActive = currentReservationExpiresAt > now;

    if (
      currentReservation &&
      currentReservationIsActive &&
      currentReservation.productId === productId &&
      currentReservation.priceId === priceId &&
      currentReservation.quantity === quantity
    ) {
      return { reservation: currentReservation, staleSessionId: null };
    }
    if (currentReservation && currentReservationIsActive && !currentReservation.sessionId) {
      return { reservation: currentReservation, staleSessionId: null };
    }

    const newReservation = {
      country,
      pendingUntil: now + CHECKOUT_RESERVATION_PENDING_TTL_SECONDS,
      productId,
      priceId,
      quantity,
      token: randomUUID(),
    };
    await transaction
      .update(organizationTable)
      .set({
        fields: {
          ...fields,
          [CHECKOUT_RESERVATION_FIELD]: newReservation,
        },
      })
      .where(eq(organizationTable.id, organizationId));

    return {
      reservation: newReservation,
      staleSessionId:
        currentReservation && currentReservationIsActive ? currentReservation.sessionId : null,
    };
  });

  if (staleSessionId) {
    try {
      await expireStripeSubscriptionCheckoutSession(staleSessionId);
    } catch (error) {
      console.warn("Unable to expire replaced Stripe checkout session", {
        error,
        organizationId,
        productId,
        sessionFingerprint: createHash("sha256").update(staleSessionId).digest("hex").slice(0, 12),
      });
    }
  }

  return reservation;
}

async function storeSubscriptionCheckoutSession(
  organizationId: string,
  reservationToken: string,
  session: { expiresAt: number; id: string },
) {
  const db = getEggheadDatabase();

  await db.transaction(async (transaction) => {
    const [storedOrganization] = await transaction
      .select({ fields: organizationTable.fields })
      .from(organizationTable)
      .where(eq(organizationTable.id, organizationId))
      .for("update");
    if (!storedOrganization) {
      throw new Error("Unable to store subscription checkout for the organization.");
    }

    const parsedFields = organizationFieldsSchema.safeParse(storedOrganization.fields ?? {});
    const fields = parsedFields.success ? parsedFields.data : {};
    const parsedReservation = checkoutReservationSchema.safeParse(
      fields[CHECKOUT_RESERVATION_FIELD],
    );
    if (!parsedReservation.success || parsedReservation.data.token !== reservationToken) {
      throw new Error("Subscription checkout reservation changed before the session was stored.");
    }

    await transaction
      .update(organizationTable)
      .set({
        fields: {
          ...fields,
          [CHECKOUT_RESERVATION_FIELD]: {
            ...parsedReservation.data,
            sessionExpiresAt: session.expiresAt,
            sessionId: session.id,
          },
        },
      })
      .where(eq(organizationTable.id, organizationId));
  });
}

/** Validates a selected active membership and starts its hosted Stripe Checkout session. */
export async function startSubscriptionCheckout(formData: FormData) {
  const user = await getCurrentUser();

  if (!user?.id) {
    redirect("/login?callbackUrl=/pricing");
  }
  if (!user.email || !z.email().safeParse(user.email).success) {
    redirect("/pricing?error=missing-email");
  }

  const currentSubscription = await getCurrentSubscriptionForUser(user.id);
  if (currentSubscription) {
    redirect("/thanks/subscription?existing=true");
  }

  const requestedPriceId = formData.get("priceId");
  if (typeof requestedPriceId !== "string" || !requestedPriceId)
    redirect("/pricing?error=invalid-product");
  const priceId = requestedPriceId;
  const requestedProductId = formData.get("productId");
  const requestedQuantity = subscriptionCheckoutQuantitySchema.safeParse(formData.get("quantity"));

  if (typeof requestedProductId !== "string") {
    redirect("/pricing?error=invalid-product");
  }
  if (!requestedQuantity.success) {
    redirect("/pricing?error=invalid-seats");
  }

  const productId = requestedProductId;
  const quantity = requestedQuantity.data;
  const services = getMembershipServices();
  if (!services) redirect("/pricing?error=not-configured");
  const { adapter, payments, configuration, db } = services;
  const product = await getActiveMembershipProduct(productId);

  if (!product || !product.prices.some((price) => price.id === priceId)) {
    redirect("/pricing?error=invalid-product");
  }

  const requestHeaders = await headers();
  const origin = membershipCheckoutOrigin(
    process.env["NEXT_PUBLIC_APP_URL"] ?? process.env["COURSEBUILDER_URL"],
    requestHeaders.get("origin"),
    configuration.localPreview,
  );
  const country =
    requestHeaders.get("x-vercel-ip-country") ?? requestHeaders.get("cf-ipcountry") ?? "US";

  const { organization } = await ensurePersonalOrganization({
    id: user.id,
    email: user.email,
  });
  const checkoutReservation = await reserveSubscriptionCheckout(
    organization.id,
    productId,
    priceId,
    quantity,
    country,
  );
  if (
    checkoutReservation.productId !== productId ||
    checkoutReservation.priceId !== priceId ||
    checkoutReservation.quantity !== quantity
  ) {
    redirect("/pricing?error=checkout-pending");
  }
  let checkoutRedirect: string;

  try {
    const { stripePrice, merchantProduct } = await resolveCheckoutPrice({
      productId,
      priceId,
      adapter,
      paymentsAdapter: payments,
    });
    if (!stripePrice.recurring || stripePrice.livemode !== configuration.live)
      throw new Error("Membership price must match the configured Stripe mode");
    const customerId = await getCheckoutCustomer({
      user: { id: user.id, email: user.email },
      merchantAccountId: merchantProduct.merchantAccountId,
      live: configuration.live,
      adapter: {
        getMerchantCustomerForUserId: async (userId) => {
          const mapping = await db.query.merchantCustomer.findFirst({
            where: and(
              eq(merchantCustomer.userId, userId),
              eq(merchantCustomer.merchantAccountId, merchantProduct.merchantAccountId),
            ),
          });
          return mapping ? { ...mapping, status: mapping.status ?? 0 } : null;
        },
        createMerchantCustomer: adapter.createMerchantCustomer.bind(adapter),
      },
      customers: payments.stripe.customers,
    });
    const metadata = {
      product: product.name,
      country: checkoutReservation.country,
      productId,
      priceId,
      userId: user.id,
      organizationId: organization.id,
      bulk: String(quantity > 1),
    };
    const params = {
      mode: "subscription" as const,
      line_items: [{ price: stripePrice.id, quantity }],
      customer: customerId,
      client_reference_id: user.id,
      metadata,
      subscription_data: { metadata },
      success_url: `${origin}/thanks/subscription?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/pricing?cancelled=1`,
    };
    const session = await payments.stripe.checkout.sessions.create(params, {
      idempotencyKey: subscriptionCheckoutIdempotencyKey(checkoutReservation.token, params),
    });
    if (!session.url || session.livemode !== configuration.live)
      throw new Error("Invalid Stripe checkout session");
    await storeSubscriptionCheckoutSession(organization.id, checkoutReservation.token, {
      id: session.id,
      expiresAt: session.expires_at,
    });
    checkoutRedirect = session.url;
  } catch (error) {
    console.error("Subscription checkout failed", {
      error,
      organizationId: organization.id,
      productId,
      priceId,
      quantity,
      reservationFingerprint: createHash("sha256")
        .update(checkoutReservation.token)
        .digest("hex")
        .slice(0, 12),
    });
    redirect("/pricing?error=checkout");
  }

  redirect(checkoutRedirect);
}
