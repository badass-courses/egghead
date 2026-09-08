import { randomUUID } from "node:crypto";

import { z } from "zod";

import { membershipMappingSchema, type MembershipMapping } from "./catalog-contracts";
import { subscriptionCheckoutQuantitySchema } from "./team-contracts";

const checkoutParamsSchema = z.object({
  mode: z.literal("subscription"),
  line_items: z.tuple([
    z.object({ price: z.string().min(1), quantity: subscriptionCheckoutQuantitySchema }),
  ]),
  expires_at: z.number().int(),
  success_url: z.string().url(),
  cancel_url: z.string().url(),
  customer: z.string().min(1).optional(),
  customer_email: z.string().email().optional(),
  metadata: z.record(z.string(), z.string()),
});
export type SubscriptionCheckoutParams = z.infer<typeof checkoutParamsSchema>;

export const checkoutReservationSchema = z.object({
  version: z.literal(2),
  token: z.string().min(1),
  createdAt: z.number().int(),
  mapping: membershipMappingSchema,
  params: checkoutParamsSchema,
  sessionId: z.string().min(1).optional(),
});
export type CheckoutReservation = z.infer<typeof checkoutReservationSchema>;
export type CheckoutSession = {
  id: string;
  status: "open" | "complete" | "expired";
  url: string | null;
  livemode: boolean;
  customerId: string | null;
  subscriptionId: string | null;
  userId: string | null;
  organizationId: string | null;
  productId: string | null;
};
export type CheckoutSubscription = {
  id: string;
  customerId: string;
  status: string;
  livemode: boolean;
};
export type CheckoutProvider = {
  create(params: SubscriptionCheckoutParams, token: string): Promise<CheckoutSession>;
  retrieve(id: string): Promise<CheckoutSession>;
  expire(id: string): Promise<CheckoutSession>;
  getSubscription(id: string): Promise<CheckoutSubscription>;
};
export type CheckoutReservationStore = {
  locked<T>(
    operation: (
      current: unknown,
      save: (reservation: CheckoutReservation) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T>;
};
export type CheckoutRequest = {
  mapping: MembershipMapping;
  productName: string;
  quantity: number;
  country: string;
  siteUrl: string;
  userId: string;
  organizationId: string;
  customerId?: string;
  email: string;
};

function newReservation(request: CheckoutRequest, now: number): CheckoutReservation {
  const quantity = subscriptionCheckoutQuantitySchema.parse(request.quantity);
  return checkoutReservationSchema.parse({
    version: 2,
    token: randomUUID(),
    createdAt: now,
    mapping: request.mapping,
    params: {
      mode: "subscription",
      line_items: [{ price: request.mapping.stripePriceId, quantity }],
      // Fixed at reservation creation; never recomputed on retry.
      expires_at: now + 12 * 60 * 60,
      success_url: `${request.siteUrl}/thanks/subscription?session_id={CHECKOUT_SESSION_ID}&provider=stripe`,
      cancel_url: `${request.siteUrl}/pricing`,
      ...(request.customerId
        ? { customer: request.customerId }
        : { customer_email: request.email }),
      metadata: {
        bulk: quantity > 1 ? "true" : "false",
        country: request.country,
        ip_address: "",
        productId: request.mapping.productId,
        product: request.productName,
        userId: request.userId,
        organizationId: request.organizationId,
      },
    },
  });
}

function readReservation(value: unknown) {
  // Old two-minute reservations cannot prove that an unrecorded session is absent.
  const parsed = checkoutReservationSchema.safeParse(value);
  if (!parsed.success) throw new Error("Checkout reservation requires reconciliation.");
  return parsed.data;
}

async function assertCompletedCheckoutReconciled(
  session: CheckoutSession,
  reservation: CheckoutReservation,
  request: CheckoutRequest,
  provider: CheckoutProvider,
) {
  if (
    !session.subscriptionId ||
    !session.customerId ||
    session.customerId !== request.customerId ||
    (reservation.params.customer && reservation.params.customer !== session.customerId) ||
    session.userId !== request.userId ||
    session.organizationId !== request.organizationId ||
    session.productId !== reservation.mapping.productId
  ) {
    throw new Error("Completed checkout association is unresolved; repurchase is blocked.");
  }
  const subscription = await provider.getSubscription(session.subscriptionId);
  if (
    subscription.livemode ||
    subscription.id !== session.subscriptionId ||
    subscription.customerId !== session.customerId ||
    (subscription.status !== "canceled" && subscription.status !== "incomplete_expired")
  ) {
    throw new Error("Completed checkout subscription is not terminal; repurchase is blocked.");
  }
}

/** Persist intent BEFORE Stripe. Unknown outcomes never release the organization reservation. */
export async function startReservedSubscriptionCheckout(
  request: CheckoutRequest,
  store: CheckoutReservationStore,
  provider: CheckoutProvider,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<string> {
  subscriptionCheckoutQuantitySchema.parse(request.quantity);
  await store.locked(async (current, save) => {
    if (current === undefined || current === null) await save(newReservation(request, now()));
    else readReservation(current);
  });

  // A replacement needs a second committed intent before its first provider call.
  const reconcile = () =>
    store.locked(async (current, save) => {
      const reservation = readReservation(current);
      if (
        reservation.params.metadata["userId"] !== request.userId ||
        reservation.params.metadata["organizationId"] !== request.organizationId ||
        reservation.mapping.stripeAccountId !== request.mapping.stripeAccountId
      ) {
        throw new Error("Checkout reservation belongs to a different account.");
      }
      let session: CheckoutSession;
      if (reservation.sessionId) {
        session = await provider.retrieve(reservation.sessionId);
      } else {
        // Stripe may prune idempotency keys after 24h. Never replay an uncertain create
        // beyond that documented window; provider reconciliation is required.
        if (now() >= reservation.createdAt + 24 * 60 * 60) {
          throw new Error(
            "Checkout outcome is unknown; reconciliation is required before retrying.",
          );
        }
        const created = await provider.create(reservation.params, reservation.token);
        // Idempotent create replays the ORIGINAL response, not current session state.
        session = await provider.retrieve(created.id);
      }
      if (session.livemode) throw new Error("Live Stripe checkout is blocked.");
      if (session.status === "complete") {
        await assertCompletedCheckoutReconciled(session, reservation, request, provider);
        await save(newReservation(request, now()));
        return null;
      }
      const sameSelection =
        reservation.mapping.productId === request.mapping.productId &&
        reservation.mapping.stripePriceId === request.mapping.stripePriceId &&
        reservation.params.line_items[0].quantity === request.quantity;
      if (session.status === "open" && sameSelection) {
        if (!session.url) throw new Error("Open checkout session has no redirect URL.");
        await save({ ...reservation, sessionId: session.id });
        return session.url;
      }
      if (session.status === "open") {
        // An exception or non-expired response leaves the OLD reservation blocking.
        const expired = await provider.expire(session.id);
        if (expired.livemode) throw new Error("Live Stripe checkout is blocked.");
        if (expired.id !== session.id || expired.status !== "expired") {
          throw new Error("Checkout expiration is unconfirmed; replacement is blocked.");
        }
      }
      await save(newReservation(request, now()));
      return null;
    });
  const first = await reconcile();
  if (first) return first;
  const replacement = await reconcile();
  if (replacement) return replacement;
  throw new Error("Checkout selection changed concurrently; retry the current reservation.");
}
