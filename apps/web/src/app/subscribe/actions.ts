"use server";

import { randomUUID } from "node:crypto";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getCurrentUser } from "../../coursebuilder/current-user";
import {
  getSiteUrl,
  getStripeProvider,
  isStripeConfigured,
  takeCreatedStripeSubscriptionCheckout,
} from "../../coursebuilder/stripe-provider";
import { getCourseBuilderAdapter, getEggheadDatabase } from "../../db/adapter";
import { organization as organizationTable } from "../../db/schema";
import { assertCommerceWritesAllowed } from "../../db/local-docker";
import { getEnv } from "../../env";
import {
  isConfiguredSubscriptionProductId,
  subscriptionProductIds,
} from "../../subscriptions/options";
import { ensurePersonalOrganization } from "../../subscriptions/personal-organization";
import { getCurrentSubscriptionForUser } from "../../subscriptions/status";

const CHECKOUT_RESERVATION_FIELD = "stripeSubscriptionCheckout";
const CHECKOUT_RESERVATION_TTL_SECONDS = 24 * 60 * 60;
const organizationFieldsSchema = z.record(z.string(), z.unknown());
const checkoutReservationSchema = z.object({
  pendingUntil: z.number().int(),
  productId: z.string(),
  sessionExpiresAt: z.number().int().optional(),
  sessionId: z.string().optional(),
  token: z.string(),
});

async function reserveSubscriptionCheckout(organizationId: string, productId: string) {
  const db = getEggheadDatabase();

  return db.transaction(async (transaction) => {
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

    if (currentReservation && currentReservationExpiresAt > now) {
      return currentReservation;
    }

    const reservation = {
      pendingUntil: now + CHECKOUT_RESERVATION_TTL_SECONDS,
      productId,
      token: randomUUID(),
    };
    await transaction
      .update(organizationTable)
      .set({
        fields: {
          ...fields,
          [CHECKOUT_RESERVATION_FIELD]: reservation,
        },
      })
      .where(eq(organizationTable.id, organizationId));

    return reservation;
  });
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
  const adapter = getCourseBuilderAdapter();
  const product = await adapter.getProduct(productId, false);

  if (
    !isStripeConfigured() ||
    !product ||
    product.type !== "membership" ||
    !product.price ||
    product.price.status !== 1 ||
    !product.fields.billingInterval
  ) {
    redirect("/subscribe?error=not-configured");
  }

  const { organization } = await ensurePersonalOrganization({
    id: user.id,
    email: user.email,
  });
  const checkoutReservation = await reserveSubscriptionCheckout(organization.id, productId);
  if (checkoutReservation.productId !== productId) {
    redirect("/subscribe?error=checkout-pending");
  }
  const stripeProvider = getStripeProvider(checkoutReservation.token);
  if (!stripeProvider) {
    redirect("/subscribe?error=not-configured");
  }
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
    const createdCheckout = takeCreatedStripeSubscriptionCheckout(stripeProvider);
    if (!createdCheckout) {
      throw new Error("Stripe did not create a subscription checkout session.");
    }
    await storeSubscriptionCheckoutSession(
      organization.id,
      checkoutReservation.token,
      createdCheckout,
    );
    checkoutRedirect = checkout.redirect;
  } catch {
    redirect("/subscribe?error=checkout");
  }

  redirect(checkoutRedirect);
}
