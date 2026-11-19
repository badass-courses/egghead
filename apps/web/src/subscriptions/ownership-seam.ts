import { z } from "zod";

import { getStripeProvider } from "../coursebuilder/stripe-provider";
import { reportSubscriptionAlert } from "./alerts";
import { readDeletedCustomerRecord, type DeletedCustomerRecord } from "./deleted-customers";
import { readOwnerMarker } from "./ownership/marker";
import { checkoutCustomerDecision, routeStripeEvent, type EventSubject } from "./ownership/routing";

// The lifecycle's one ownership question, answered by #47's marker
// (`ownership/marker.ts`) and routing rule (`ownership/routing.ts`); see
// docs/adr/0001-subscription-ownership-handover.md. The marker lives on the
// Stripe customer, so it is read from Stripe *before* any database transaction:
// a network call under the subscription row lock would hold the lock for the
// call's latency. The store then re-checks, under the lock, that the row still
// belongs to the customer the decision was made for.

/** What a live read of a Stripe customer says about its marker. */
export type CustomerMarkerRead =
  | { readonly deleted: true }
  | { readonly deleted: false; readonly metadata: unknown };
export type ReadCustomerMarker = (stripeCustomerId: string) => Promise<CustomerMarkerRead>;

function objectField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

const retrievedCustomerSchema = z.union([
  z.object({ deleted: z.literal(true) }),
  z.object({ metadata: z.unknown() }),
]);

/**
 * Live marker read through the configured Stripe client, found by shape. A failed
 * read throws: per ADR §3 the caller returns non-2xx or lets Inngest retry, and
 * never acts by default.
 */
export const readStripeCustomerMarker: ReadCustomerMarker = async (stripeCustomerId) => {
  const customers = objectField(
    objectField(getStripeProvider()?.options.paymentsAdapter, "stripe"),
    "customers",
  );
  const retrieve = objectField(customers, "retrieve");
  if (typeof retrieve !== "function")
    throw new Error("Stripe is not configured to read the ownership marker");
  const retrieved: unknown = await Reflect.apply(retrieve, customers, [stripeCustomerId]);
  const parsed = retrievedCustomerSchema.parse(retrieved);
  return "deleted" in parsed ? { deleted: true } : { deleted: false, metadata: parsed.metadata };
};

export const eventOwnershipStampSchema = z.object({
  eventId: z.string().min(1),
  owner: z.enum(["rails", "cb"]),
  basis: z.enum([
    "customer_timeline",
    "deleted_customer_record",
    "payment_intent_flag",
    "no_owner_marker",
  ]),
  markerGeneration: z.number().int().nullable(),
  decidedAt: z.number(),
});

/** An event's ownership, decided once at receipt (ADR §3) and carried with the event. */
export const routedEventSchema = z.object({
  stamp: eventOwnershipStampSchema,
  /** Stripe `event.created`, epoch seconds. */
  eventCreated: z.number().int().nonnegative(),
  stripeCustomerId: z.string().min(1).nullable(),
});
export type RoutedEvent = z.infer<typeof routedEventSchema>;

export type ReadDeletedCustomerRecord = (
  stripeCustomerId: string,
) => Promise<DeletedCustomerRecord>;

/** Stripe retries a webhook for up to three days; after that nothing will record the customer. */
export const DELETED_CUSTOMER_RECORD_WAIT_SECONDS = 3 * 24 * 60 * 60;

/** A deleted customer's `customer.deleted` has not been recorded yet: retry, never guess. */
export class DeletedCustomerPendingError extends Error {
  constructor() {
    super("The deleted Stripe customer's marker is not recorded yet");
    this.name = "DeletedCustomerPendingError";
  }
}

async function customerSubject(
  input: {
    eventId: string;
    eventCreated: number;
    stripeCustomerId: string | null;
    receivedAt: number;
  },
  read: ReadCustomerMarker,
  readDeleted: ReadDeletedCustomerRecord,
): Promise<EventSubject> {
  const { stripeCustomerId } = input;
  // Subscription events always carry a customer; without one, the PaymentIntent
  // flag rule applies, and no flag routes to Rails.
  if (stripeCustomerId === null) return { kind: "customerless", paymentIntentMetadata: null };
  const marker = await read(stripeCustomerId);
  if (!marker.deleted) return { kind: "customer", marker: readOwnerMarker(marker.metadata) };
  // ADR §14 L2: a deleted customer routes by the timeline its `customer.deleted`
  // payload carried, which CB records on the customer's local rows.
  const record = await readDeleted(stripeCustomerId);
  if (record.status === "recorded")
    return { kind: "deleted_customer", knownTimeline: readOwnerMarker(record.metadata).timeline };
  // CB has no rows for this customer, so it could never write for it.
  if (record.status === "no-local-rows") return { kind: "deleted_customer", knownTimeline: null };
  // CB has rows but the `customer.deleted` has not arrived: Stripe does not order
  // deliveries. Retry until it does; after Stripe's retry window, route to Rails
  // and alert.
  if (input.receivedAt - input.eventCreated < DELETED_CUSTOMER_RECORD_WAIT_SECONDS)
    throw new DeletedCustomerPendingError();
  reportSubscriptionAlert("deleted-customer-unrecorded", {
    stripeEventId: input.eventId,
    stripeCustomerId,
  });
  return { kind: "deleted_customer", knownTimeline: null };
}

/**
 * Decide which side owns one Stripe event. Callers decide once and keep the
 * result: the deletion seam puts it in the Inngest payload, and the Inngest
 * functions decide in a memoized step, so retries never decide again.
 */
export async function decideEventOwnership(
  input: {
    eventId: string;
    eventCreated: number;
    stripeCustomerId: string | null;
    receivedAt?: number;
  },
  read: ReadCustomerMarker = readStripeCustomerMarker,
  readDeleted: ReadDeletedCustomerRecord = readDeletedCustomerRecord,
): Promise<RoutedEvent> {
  const receivedAt = input.receivedAt ?? Math.floor(Date.now() / 1000);
  const decision = routeStripeEvent({
    eventId: input.eventId,
    eventCreated: input.eventCreated,
    subject: await customerSubject({ ...input, receivedAt }, read, readDeleted),
    receivedAt,
    priorStamp: null,
  });
  // Subscription events are never account-level; refuse to act if one claims to be.
  if (decision.scope === "account_level")
    throw new Error("A subscription event cannot be account-level");
  return {
    stamp: decision.stamp,
    eventCreated: input.eventCreated,
    stripeCustomerId: input.stripeCustomerId,
  };
}

export type CommandOwnershipQuery = {
  stripeSubscriptionId: string;
  stripeCustomerId: string | null;
  /** Milliseconds. */
  now: number;
};
export type CommandOwnership = (query: CommandOwnershipQuery) => Promise<boolean>;

/**
 * Commands without a Stripe event (seat changes, reductions, invites) may write
 * only while CB owns the customer now and after every scheduled flip: the same
 * rule `checkoutCustomerDecision` applies to checkout. A deleted or unknown
 * customer, or an unrecognized marker, is not CB's.
 */
export function createCommandOwnership(
  read: ReadCustomerMarker = readStripeCustomerMarker,
): CommandOwnership {
  return async ({ stripeCustomerId, now }) => {
    if (stripeCustomerId === null) return false;
    const marker = await read(stripeCustomerId);
    if (marker.deleted) return false;
    return (
      checkoutCustomerDecision({
        customerMarker: readOwnerMarker(marker.metadata),
        now: Math.floor(now / 1000),
      }).action === "proceed"
    );
  };
}

export const courseBuilderOwnsSubscription: CommandOwnership = createCommandOwnership();
