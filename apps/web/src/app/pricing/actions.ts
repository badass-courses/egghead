"use server";

import { createHash, randomUUID } from "node:crypto";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getCurrentUser } from "../../coursebuilder/current-user";
import { expireStripeSubscriptionCheckoutSession } from "../../coursebuilder/stripe-provider";
import { getEggheadDatabase } from "../../db/adapter";
import { assertCommerceWritesAllowed, getEggheadRuntime } from "../../db/local-docker";
import {
  merchantAccount as merchantAccountTable,
  merchantCustomer,
  organization as organizationTable,
} from "../../db/schema";
import { getActiveMembershipProduct, getMembershipServices } from "../../subscriptions/catalog";
import {
  CHECKOUT_RESERVATION_FIELD,
  decideCheckoutReservation,
  readCheckoutReservation,
  subscriptionCheckoutIdempotencyKey,
} from "../../subscriptions/checkout-reservation";
import { ensurePersonalOrganization } from "../../subscriptions/personal-organization";
import { getCurrentSubscriptionForUser } from "../../subscriptions/status";
import { subscriptionCheckoutQuantitySchema } from "../../subscriptions/team-contracts";

import { resolveCheckoutPrice } from "@coursebuilder/commerce/resolve-checkout-price";
import type { StripePaymentAdapter } from "@coursebuilder/commerce/stripe-provider";
import { getCheckoutCustomer } from "../../subscriptions/checkout-customer";
import { membershipCheckoutOrigin } from "../../subscriptions/configuration";

const organizationFieldsSchema = z.record(z.string(), z.unknown());

async function reserveSubscriptionCheckout(
  organizationId: string,
  productId: string,
  priceId: string,
  quantity: number,
  country: string,
  payments: StripePaymentAdapter,
) {
  const db = getEggheadDatabase();
  const decide = (confirmedExpiredSessionId?: string) =>
    db.transaction(async (transaction) => {
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
      const decision = decideCheckoutReservation({
        current: readCheckoutReservation(fields[CHECKOUT_RESERVATION_FIELD]),
        country,
        now: Math.floor(Date.now() / 1000),
        productId,
        priceId,
        quantity,
        token: randomUUID(),
        ...(confirmedExpiredSessionId ? { confirmedExpiredSessionId } : {}),
      });
      if (decision.kind !== "replace") return decision;

      await transaction
        .update(organizationTable)
        .set({
          fields: {
            ...fields,
            [CHECKOUT_RESERVATION_FIELD]: decision.reservation,
          },
        })
        .where(eq(organizationTable.id, organizationId));

      return decision;
    });

  const first = await decide();
  if (first.kind !== "expire") return first;

  try {
    const result = await expireStripeSubscriptionCheckoutSession(first.sessionId, payments);
    if (result !== "expired") return { kind: "pending" } as const;
  } catch (error) {
    console.warn("Unable to expire Stripe checkout session", {
      error,
      organizationId,
      productId,
      sessionFingerprint: createHash("sha256").update(first.sessionId).digest("hex").slice(0, 12),
    });
    return { kind: "pending" } as const;
  }

  const next = await decide(first.sessionId);
  return next.kind === "expire" ? ({ kind: "pending" } as const) : next;
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
    const reservation = readCheckoutReservation(fields[CHECKOUT_RESERVATION_FIELD]);
    if (!reservation || reservation.token !== reservationToken) {
      throw new Error("Subscription checkout reservation changed before the session was stored.");
    }

    await transaction
      .update(organizationTable)
      .set({
        fields: {
          ...fields,
          [CHECKOUT_RESERVATION_FIELD]: {
            ...reservation,
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
  assertCommerceWritesAllowed();

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
    getEggheadRuntime(),
  );
  const country =
    requestHeaders.get("x-vercel-ip-country") ?? requestHeaders.get("cf-ipcountry") ?? "US";

  const { organization } = await ensurePersonalOrganization({
    id: user.id,
    email: user.email,
  });
  const checkoutDecision = await reserveSubscriptionCheckout(
    organization.id,
    productId,
    priceId,
    quantity,
    country,
    payments,
  );
  if (checkoutDecision.kind === "pending") {
    redirect("/pricing?error=checkout-pending");
  }
  const checkoutReservation = checkoutDecision.reservation;
  let checkoutRedirect: string;

  try {
    const { stripePrice, merchantProduct } = await resolveCheckoutPrice({
      productId,
      priceId,
      adapter,
      paymentsAdapter: payments,
    });
    const merchantAccount = await db.query.merchantAccount.findFirst({
      where: and(
        eq(merchantAccountTable.id, merchantProduct.merchantAccountId),
        eq(merchantAccountTable.status, 1),
      ),
    });
    if (!merchantAccount) {
      throw new Error("Membership checkout requires an active merchant account");
    }
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
      idempotencyKey: subscriptionCheckoutIdempotencyKey(checkoutReservation.token),
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
