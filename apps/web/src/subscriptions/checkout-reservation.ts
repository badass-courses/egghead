import { z } from "zod";

import { subscriptionCheckoutQuantitySchema } from "./team-contracts";

export const CHECKOUT_RESERVATION_FIELD = "stripeSubscriptionCheckout";
const PENDING_TTL_SECONDS = 2 * 60;

export function subscriptionCheckoutIdempotencyKey(attemptToken: string) {
  return `egghead-subscription-checkout:${attemptToken}`;
}

const reservationSchema = z.object({
  country: z.string(),
  pendingUntil: z.number().int(),
  productId: z.string(),
  priceId: z.string().optional(),
  quantity: subscriptionCheckoutQuantitySchema.default(1),
  sessionExpiresAt: z.number().int().optional(),
  sessionId: z.string().optional(),
  token: z.string(),
  version: z.literal(2).optional(),
});

export type CheckoutReservation = z.infer<typeof reservationSchema>;

export function readCheckoutReservation(value: unknown): CheckoutReservation | null {
  const parsed = reservationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

type ReservationDecision =
  | { kind: "reuse"; reservation: CheckoutReservation }
  | { kind: "pending" }
  | { kind: "expire"; sessionId: string }
  | { kind: "replace"; reservation: CheckoutReservation };

/** A checkout attempt owns one selection and one Stripe session. */
export function decideCheckoutReservation(input: {
  current: CheckoutReservation | null;
  country: string;
  now: number;
  productId: string;
  priceId: string;
  quantity: number;
  token: string;
  confirmedExpiredSessionId?: string;
}): ReservationDecision {
  const { current, now, productId, priceId, quantity } = input;
  const expiresAt = current?.sessionExpiresAt ?? current?.pendingUntil ?? 0;
  const isActive =
    expiresAt > now &&
    !(input.confirmedExpiredSessionId && current?.sessionId === input.confirmedExpiredSessionId);

  if (current && isActive) {
    if (
      current.version === 2 &&
      current.productId === productId &&
      current.priceId === priceId &&
      current.quantity === quantity
    ) {
      return { kind: "reuse", reservation: current };
    }
    return current.sessionId
      ? { kind: "expire", sessionId: current.sessionId }
      : { kind: "pending" };
  }

  return {
    kind: "replace",
    reservation: {
      country: input.country,
      pendingUntil: now + PENDING_TTL_SECONDS,
      productId,
      priceId,
      quantity,
      token: input.token,
      version: 2,
    },
  };
}

/**
 * Organization fields without this attempt's reservation, or null when there is
 * nothing to release: the reservation belongs to another attempt, or it already
 * holds a Stripe session (that one expires through Stripe).
 */
export function releaseCheckoutReservation(
  fields: Record<string, unknown>,
  token: string,
): Record<string, unknown> | null {
  const current = readCheckoutReservation(fields[CHECKOUT_RESERVATION_FIELD]);
  if (!current || current.token !== token || current.sessionId) return null;
  const { [CHECKOUT_RESERVATION_FIELD]: _released, ...rest } = fields;
  return rest;
}
