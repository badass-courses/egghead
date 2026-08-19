"use server";

import { createHash, randomUUID } from "node:crypto";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getCurrentUser } from "../../coursebuilder/current-user";
import {
  expireStripeSubscriptionCheckoutSession,
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
import { subscriptionCheckoutQuantitySchema } from "../../subscriptions/team-contracts";

const CHECKOUT_RESERVATION_FIELD = "stripeSubscriptionCheckout";
const CHECKOUT_RESERVATION_PENDING_TTL_SECONDS = 2 * 60;
const organizationFieldsSchema = z.record(z.string(), z.unknown());
const checkoutReservationSchema = z.object({
  country: z.string(),
  pendingUntil: z.number().int(),
  productId: z.string(),
  quantity: subscriptionCheckoutQuantitySchema,
  sessionExpiresAt: z.number().int().optional(),
  sessionId: z.string().optional(),
  token: z.string(),
});

async function reserveSubscriptionCheckout(
  organizationId: string,
  productId: string,
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
  const requestedQuantity = subscriptionCheckoutQuantitySchema.safeParse(formData.get("quantity"));

  if (
    typeof requestedProductId !== "string" ||
    !isConfiguredSubscriptionProductId(requestedProductId, configuredProductIds)
  ) {
    redirect("/subscribe?error=invalid-product");
  }
  if (!requestedQuantity.success) {
    redirect("/subscribe?error=invalid-seats");
  }

  const productId = requestedProductId;
  const quantity = requestedQuantity.data;
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

  const requestHeaders = await headers();
  const country =
    requestHeaders.get("x-vercel-ip-country") ?? requestHeaders.get("cf-ipcountry") ?? "US";

  const { organization } = await ensurePersonalOrganization({
    id: user.id,
    email: user.email,
  });
  const checkoutReservation = await reserveSubscriptionCheckout(
    organization.id,
    productId,
    quantity,
    country,
  );
  if (checkoutReservation.productId !== productId || checkoutReservation.quantity !== quantity) {
    redirect("/subscribe?error=checkout-pending");
  }
  const stripeProvider = getStripeProvider(checkoutReservation.token);
  if (!stripeProvider) {
    redirect("/subscribe?error=not-configured");
  }
  let checkoutRedirect: string;

  try {
    const checkout = await stripeProvider.createCheckoutSession(
      {
        productId,
        userId: user.id,
        organizationId: organization.id,
        quantity,
        bulk: quantity > 1,
        country: checkoutReservation.country,
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
  } catch (error) {
    console.error("Subscription checkout failed", {
      error,
      organizationId: organization.id,
      productId,
      quantity,
      reservationFingerprint: createHash("sha256")
        .update(checkoutReservation.token)
        .digest("hex")
        .slice(0, 12),
    });
    redirect("/subscribe?error=checkout");
  }

  redirect(checkoutRedirect);
}
