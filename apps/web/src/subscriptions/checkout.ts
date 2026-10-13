import { createHash, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { expireStripeSubscriptionCheckoutSession } from "../coursebuilder/stripe-provider";
import { getEggheadDatabase } from "../db/adapter";
import {
  organization as organizationTable,
  merchantCustomer,
  merchantAccount as merchantAccountTable,
} from "../db/schema";
import { getEggheadRuntime } from "../db/local-docker";
import type { StripePaymentAdapter } from "@coursebuilder/commerce/stripe-provider";
import {
  CHECKOUT_RESERVATION_FIELD,
  decideCheckoutReservation,
  readCheckoutReservation,
  subscriptionCheckoutIdempotencyKey,
} from "./checkout-reservation";
import { getActiveMembershipProduct, getMembershipServices } from "./catalog";
import { ensurePersonalOrganization } from "./personal-organization";
import { getCurrentSubscriptionForUser } from "./status";
import { subscriptionCheckoutQuantitySchema } from "./team-contracts";

import { resolveCheckoutPrice } from "@coursebuilder/commerce/resolve-checkout-price";
import { getCheckoutCustomer } from "./checkout-customer";
import { membershipCheckoutOrigin } from "./configuration";
import { assertMembershipWritesAllowed } from "./write-policy";

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
      error: error instanceof Error ? error.name : "UnknownError",
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
export async function createMembershipCheckout(input: {
  user: { id: string; email: string };
  productId: string;
  priceId: string;
  quantity: number;
  requestOrigin: string | null;
  country: string;
}) {
  assertMembershipWritesAllowed();
  const { user, productId, priceId, quantity, country } = input;
  if (!user.email || !z.email().safeParse(user.email).success) {
    return { status: "refused", reason: "missing-email" } as const;
  }
  const currentSubscription = await getCurrentSubscriptionForUser(user.id);
  if (currentSubscription) {
    return { status: "refused", reason: "existing" } as const;
  }

  if (!subscriptionCheckoutQuantitySchema.safeParse(quantity).success)
    return { status: "refused", reason: "invalid-seats" } as const;
  const services = getMembershipServices();
  if (!services) return { status: "refused", reason: "not-configured" } as const;
  const { adapter, payments, configuration, db } = services;
  const product = await getActiveMembershipProduct(productId);

  if (!product || !product.prices.some((price) => price.id === priceId)) {
    return { status: "refused", reason: "invalid-product" } as const;
  }

  const origin = membershipCheckoutOrigin(
    process.env["NEXT_PUBLIC_APP_URL"] ?? process.env["COURSEBUILDER_URL"],
    input.requestOrigin,
    getEggheadRuntime(),
  );

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
    return { status: "refused", reason: "checkout-pending" } as const;
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
      error: error instanceof Error ? error.name : "UnknownError",
      organizationId: organization.id,
      productId,
      priceId,
      quantity,
      reservationFingerprint: createHash("sha256")
        .update(checkoutReservation.token)
        .digest("hex")
        .slice(0, 12),
    });
    throw error;
  }

  return { status: "ready", url: checkoutRedirect } as const;
}
