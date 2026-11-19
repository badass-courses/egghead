// Per-event routing, decided once at receipt and stamped by Stripe event id.
//
// Both apps classify the event the same way, read the same owner fact, and apply the
// same rule. Deferred work (queued jobs, Inngest steps, retries) reads the stamp
// instead of deciding again. A redelivery reuses the stamp.

import {
  cbBornCustomerMetadata,
  finalOwner,
  OWNER_METADATA_KEY,
  ownerAt,
  type Owner,
  type OwnerMarker,
  type OwnerTimeline,
} from "./marker";

/**
 * Account-level objects belong to no customer and are not owner-routed: each app keeps
 * doing what it does today. CB's webhook handler (`@coursebuilder/commerce`) acts on
 * none of these; it only acts on `customer.subscription.updated`,
 * `checkout.session.completed` and `invoice.payment_succeeded`.
 */
export const ACCOUNT_LEVEL_EVENT_PREFIXES = [
  "product.",
  "price.",
  "plan.",
  "coupon.",
  "promotion_code.",
  "tax_rate.",
] as const;

export function isAccountLevelEvent(type: string): boolean {
  return ACCOUNT_LEVEL_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix));
}

/**
 * What an event is routed by. Both apps build it the same way:
 * - account-level types (above) → `account_level`;
 * - a customer id on the object (`customer.*` uses `object.id`; disputes use the
 *   charge's customer) → `customer`, with the live marker, or `deleted_customer` when
 *   Stripe returns the customer as deleted;
 * - no customer → `customerless`, flagged by the PaymentIntent's metadata
 *   (`payment_intent.*`: the object; `charge.*` and disputes: the charge's
 *   payment intent; `checkout.session.*`: the session's payment intent).
 *   CB checkout must copy `egghead_owner=cb` into `payment_intent_data.metadata`.
 */
export type EventSubject =
  | { readonly kind: "account_level" }
  | { readonly kind: "customer"; readonly marker: OwnerMarker }
  | {
      readonly kind: "deleted_customer";
      /**
       * Last timeline this app recorded for the customer: CB's ownership record, or the
       * timeline Rails stored from the `customer.deleted` payload. Null when none exists.
       */
      readonly knownTimeline: OwnerTimeline | null;
    }
  | { readonly kind: "customerless"; readonly paymentIntentMetadata: unknown };

export type RoutingBasis =
  | "customer_timeline"
  | "deleted_customer_record"
  | "payment_intent_flag"
  | "no_owner_marker";

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
   * The customer marker is read live, or from a cache younger than the policy TTL.
   * A read failure must throw so the webhook returns non-2xx and Stripe retries.
   * Never route without a marker read.
   */
  readonly subject: EventSubject;
  readonly receivedAt: number;
  /** Stamp already recorded for this event id, if any. */
  readonly priorStamp: EventOwnershipStamp | null;
}

export type RouteDecision =
  | { readonly scope: "account_level" }
  | {
      readonly scope: "owned";
      readonly owner: Owner;
      readonly stamp: EventOwnershipStamp;
      /** Persist the stamp when true. False on a redelivery. */
      readonly stampIsNew: boolean;
    };

function flagOwner(metadata: unknown): Owner | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  return Reflect.get(metadata, OWNER_METADATA_KEY) === "cb" ? "cb" : null;
}

export function routeStripeEvent(input: RouteStripeEventInput): RouteDecision {
  const { subject, eventId, eventCreated, receivedAt, priorStamp } = input;
  if (subject.kind === "account_level") return { scope: "account_level" };
  if (priorStamp !== null && priorStamp.eventId === eventId) {
    return { scope: "owned", owner: priorStamp.owner, stamp: priorStamp, stampIsNew: false };
  }

  const stamp = ((): EventOwnershipStamp => {
    switch (subject.kind) {
      case "customer":
        return {
          eventId,
          owner: ownerAt(subject.marker.timeline, eventCreated),
          basis: "customer_timeline",
          markerGeneration: subject.marker.generation,
          decidedAt: receivedAt,
        };
      case "deleted_customer":
        return subject.knownTimeline === null
          ? {
              eventId,
              owner: "rails",
              basis: "no_owner_marker",
              markerGeneration: null,
              decidedAt: receivedAt,
            }
          : {
              eventId,
              owner: ownerAt(subject.knownTimeline, eventCreated),
              basis: "deleted_customer_record",
              markerGeneration: null,
              decidedAt: receivedAt,
            };
      case "customerless": {
        const owner = flagOwner(subject.paymentIntentMetadata);
        return owner === null
          ? {
              eventId,
              owner: "rails",
              basis: "no_owner_marker",
              markerGeneration: null,
              decidedAt: receivedAt,
            }
          : {
              eventId,
              owner,
              basis: "payment_intent_flag",
              markerGeneration: null,
              decidedAt: receivedAt,
            };
      }
      default:
        throw new Error(`Unhandled event subject: ${JSON.stringify(subject)}`);
    }
  })();
  return { scope: "owned", owner: stamp.owner, stamp, stampIsNew: true };
}

/** Whether `self` acts on the event. The other side acknowledges it with 2xx and skips. */
export function shouldAct(decision: RouteDecision, self: Owner): boolean | "as_today" {
  if (decision.scope === "account_level") return "as_today";
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

/** Flag CB checkout copies into `payment_intent_data.metadata` (and session metadata). */
export function cbPaymentIntentFlag(): Record<string, string> {
  return { [OWNER_METADATA_KEY]: "cb" };
}

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
  if (customerMarker === null) {
    return { action: "create_cb_customer", metadata: cbBornCustomerMetadata() };
  }
  if (customerMarker.source === "unrecognized") {
    return { action: "refuse", reason: "marker_unrecognized" };
  }
  if (finalOwner(customerMarker.timeline) !== "cb") {
    return { action: "refuse", reason: "customer_owned_by_rails" };
  }
  if (ownerAt(customerMarker.timeline, now) !== "cb") {
    return { action: "refuse", reason: "customer_flip_scheduled" };
  }
  return { action: "proceed" };
}
