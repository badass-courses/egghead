// Per-event routing, decided once at receipt and stamped by Stripe event id.
//
// Both apps run the same rule on the same inputs: the customer's live timeline and the
// event's Stripe `created` time. Deferred work (queued jobs, Inngest steps, retries)
// reads the stamp instead of deciding again. A redelivery reuses the stamp.

import {
  cbBornCustomerMetadata,
  finalOwner,
  oneTimePaymentOwner,
  ownerAt,
  type Owner,
  type OwnerMarker,
} from "./marker";

export type RoutingBasis = "customer_timeline" | "checkout_session" | "no_owner_marker";

export interface EventOwnershipStamp {
  readonly eventId: string;
  readonly owner: Owner;
  readonly basis: RoutingBasis;
  /** Marker generation read at receipt, for audit. Null when no customer marker applied. */
  readonly markerGeneration: number | null;
  readonly decidedAt: number;
}

export interface RouteStripeEventInput {
  readonly eventId: string;
  /** Stripe `event.created`, epoch seconds. */
  readonly eventCreated: number;
  /**
   * Marker of the event's Stripe customer, read live (or from a cache younger than the
   * policy TTL). Null when the event has no customer. A read failure must throw so the
   * webhook returns non-2xx and Stripe retries. Never route without a marker read.
   */
  readonly customerMarker: OwnerMarker | null;
  /** Checkout session metadata, for customerless one-time payment events. */
  readonly checkoutSessionMetadata: unknown;
  readonly receivedAt: number;
  /** Stamp already recorded for this event id, if any. */
  readonly priorStamp: EventOwnershipStamp | null;
}

export interface RouteDecision {
  readonly owner: Owner;
  readonly stamp: EventOwnershipStamp;
  /** Persist the stamp when true. False on a redelivery. */
  readonly stampIsNew: boolean;
}

export function routeStripeEvent(input: RouteStripeEventInput): RouteDecision {
  if (input.priorStamp !== null && input.priorStamp.eventId === input.eventId) {
    return { owner: input.priorStamp.owner, stamp: input.priorStamp, stampIsNew: false };
  }

  const stamp: EventOwnershipStamp =
    input.customerMarker !== null
      ? {
          eventId: input.eventId,
          owner: ownerAt(input.customerMarker.timeline, input.eventCreated),
          basis: "customer_timeline",
          markerGeneration: input.customerMarker.generation,
          decidedAt: input.receivedAt,
        }
      : {
          eventId: input.eventId,
          owner: oneTimePaymentOwner(input.checkoutSessionMetadata),
          basis:
            oneTimePaymentOwner(input.checkoutSessionMetadata) === "cb"
              ? "checkout_session"
              : "no_owner_marker",
          markerGeneration: null,
          decidedAt: input.receivedAt,
        };
  return { owner: stamp.owner, stamp, stampIsNew: true };
}

/** Whether `self` acts on the event. The other side acknowledges it with 2xx and skips. */
export function shouldAct(decision: RouteDecision, self: Owner): boolean {
  return decision.owner === self;
}

export type CheckoutCustomerDecision =
  | { readonly action: "create_cb_customer"; readonly metadata: Record<string, string> }
  | { readonly action: "proceed" }
  | {
      readonly action: "refuse";
      readonly reason:
        | "customer_owned_by_rails"
        | "customer_flip_scheduled"
        | "marker_unrecognized";
    };

/**
 * CB checkout on an existing Stripe customer. Desk pick: refuse unless CB already owns
 * the customer now and after every scheduled flip. A Rails-owned customer is moved by
 * a batch (customers with no live subscription can all move before CB checkout opens),
 * never implicitly by checkout, because a checkout cannot wait out the flip lead time.
 */
export function checkoutCustomerDecision(input: {
  /** Null when the user has no Stripe customer yet. */
  readonly customerMarker: OwnerMarker | null;
  readonly now: number;
}): CheckoutCustomerDecision {
  const { customerMarker, now } = input;
  if (customerMarker === null)
    return { action: "create_cb_customer", metadata: cbBornCustomerMetadata() };
  if (customerMarker.source === "unrecognized")
    return { action: "refuse", reason: "marker_unrecognized" };
  const owner = finalOwner(customerMarker.timeline);
  if (owner !== "cb") return { action: "refuse", reason: "customer_owned_by_rails" };
  if (ownerAt(customerMarker.timeline, now) !== "cb") {
    return { action: "refuse", reason: "customer_flip_scheduled" };
  }
  return { action: "proceed" };
}
