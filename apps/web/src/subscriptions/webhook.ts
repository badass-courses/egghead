import { z } from "zod";
import { getStripeProvider } from "../coursebuilder/stripe-provider";
import { inngest } from "../inngest/client";
import {
  BILLING_SIGNAL_EVENT,
  type BillingSignalPayload,
  DELETED_CUSTOMER_RECORDED_EVENT,
  type DeletedCustomerRecordedPayload,
  SUBSCRIPTION_DELETED_EVENT,
  customerDeletedEventSchema,
  subscriptionDeletedEventSchema,
} from "./webhook-contract";
import {
  reportSubscriptionAlert,
  reportSubscriptionReceipt,
  reportSubscriptionSkip,
  safeErrorSummary,
} from "./alerts";
import {
  isBillingSignal,
  resolveBillingSignal,
  type BillingSignalStripe,
  type ResolvedBillingSignal,
} from "./billing-signals";
import { recordDeletedCustomer } from "./deleted-customers";
import { decideEventOwnership, type RoutedEvent } from "./ownership-seam";
import { membershipWritesAllowed } from "./write-policy";

function objectField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * Find Stripe signature verification by shape, not by class identity: a Next
 * bundle can hold two copies of `@coursebuilder/commerce`, and an `instanceof`
 * check across copies fails silently and would drop the deletion seam.
 */
export function stripeWebhookVerifier(adapter: unknown) {
  const secret = objectField(adapter, "webhookSecret");
  const webhooks = objectField(objectField(adapter, "stripe"), "webhooks");
  const constructEvent = objectField(webhooks, "constructEvent");
  if (typeof secret !== "string" || !secret || typeof constructEvent !== "function") return null;
  return {
    verify(body: string, signature: string): unknown {
      const event: unknown = Reflect.apply(constructEvent, webhooks, [body, signature, secret]);
      return event;
    },
  };
}

/**
 * Route a dunning, refund or dispute event at receipt and publish it only when CB
 * owns it (ADR-0001 §14 L4). A CB-owned event for a charge or invoice with no
 * subscription gets an unmatched receipt for support (§12). Receipts carry Stripe
 * ids only. Stripe reads and routing throw, so the route answers non-2xx.
 */
export async function dispatchBillingSignal(
  verified: unknown,
  boundary: {
    resolve(verified: unknown): Promise<ResolvedBillingSignal>;
    route(signal: ResolvedBillingSignal): Promise<RoutedEvent>;
    publish(event: {
      name: typeof BILLING_SIGNAL_EVENT;
      data: BillingSignalPayload;
    }): Promise<unknown>;
  },
) {
  const signal = await boundary.resolve(verified);
  const routing = await boundary.route(signal);
  const receipt = {
    source: "stripe-webhook",
    stripeEventId: signal.eventId,
    signal: signal.type,
    stripeObjectId: signal.objectId,
    stripeCustomerId: signal.stripeCustomerId,
    stripeSubscriptionId: signal.stripeSubscriptionId,
  };
  if (routing.stamp.owner !== "cb") {
    reportSubscriptionSkip("not-owner", { ...receipt, owner: routing.stamp.owner });
    return "not-owner" as const;
  }
  if (signal.stripeSubscriptionId === null) {
    reportSubscriptionAlert(
      signal.type === "invoice.payment_failed"
        ? "unmatched-payment-failure"
        : "unmatched-refund-or-dispute",
      receipt,
    );
    return "unmatched" as const;
  }
  if (signal.type !== "invoice.payment_failed")
    reportSubscriptionReceipt("billing-signal-receipt", receipt);
  await boundary.publish({
    name: BILLING_SIGNAL_EVENT,
    data: {
      stripeEvent: {
        id: signal.eventId,
        created: signal.created,
        data: { object: { id: signal.stripeSubscriptionId, customer: signal.stripeCustomerId } },
      },
      routing,
      signal: { type: signal.type, objectId: signal.objectId },
    },
  });
  return "dispatched" as const;
}

/** The configured Stripe client's invoice and charge readers, found by shape. */
function billingSignalStripe(stripe: unknown): BillingSignalStripe {
  const reader = (resource: string) => {
    const target = objectField(stripe, resource);
    const retrieve = objectField(target, "retrieve");
    return {
      retrieve: async (id: string): Promise<unknown> => {
        if (typeof retrieve !== "function") throw new Error("Stripe is not configured");
        const retrieved: unknown = await Reflect.apply(retrieve, target, [id]);
        return retrieved;
      },
    };
  };
  return { invoices: reader("invoices"), charges: reader("charges") };
}

function isCustomerDeletion(event: unknown) {
  const parsed = z.object({ type: z.string() }).safeParse(event);
  return parsed.success && parsed.data.type === "customer.deleted";
}

/**
 * ADR-0001 §14 L2: keep the marker a `customer.deleted` payload carries, so later
 * events for the deleted customer route by it. A failed write throws, and the
 * route answers non-2xx so Stripe delivers the event again.
 */
export async function recordCustomerDeletion(
  verified: unknown,
  record: (input: { stripeCustomerId: string; metadata: unknown }) => Promise<number>,
  announce?: (event: {
    name: typeof DELETED_CUSTOMER_RECORDED_EVENT;
    data: DeletedCustomerRecordedPayload;
  }) => Promise<unknown>,
) {
  const deletion = customerDeletedEventSchema.parse(verified);
  const stripeCustomerId = deletion.data.object.id;
  const marked = await record({
    stripeCustomerId,
    metadata: deletion.data.object.metadata ?? {},
  });
  // Wake runs waiting on this customer's record. The record is already durable
  // and they re-check hourly, so a failed send only delays them.
  if (announce && marked > 0)
    try {
      await announce({ name: DELETED_CUSTOMER_RECORDED_EVENT, data: { stripeCustomerId } });
    } catch (error) {
      reportSubscriptionAlert("deleted-customer-announce-failed", {
        stripeCustomerId,
        errorName: safeErrorSummary(error).name,
      });
    }
  return marked;
}

function isSubscriptionDeletion(event: unknown) {
  const parsed = z.object({ type: z.string() }).safeParse(event);
  return parsed.success && parsed.data.type === "customer.subscription.deleted";
}

type SubscriptionDeletion = ReturnType<typeof subscriptionDeletedEventSchema.parse>;

export function deletionCustomerId(deletion: SubscriptionDeletion) {
  const customer = deletion.data.object.customer;
  return typeof customer === "string" ? customer : (customer?.id ?? null);
}

/**
 * Verify, route at receipt (ADR-0001 §3), then publish only what CB owns. The
 * routing decision travels in the payload, so the function never decides again.
 * A marker read failure throws, so the route answers non-2xx and Stripe retries.
 */
export async function dispatchSubscriptionDeletion(
  rawBody: string,
  signature: string,
  boundary: {
    verify(body: string, signature: string): unknown;
    route(deletion: SubscriptionDeletion): Promise<RoutedEvent>;
    publish(event: {
      name: typeof SUBSCRIPTION_DELETED_EVENT;
      data: { stripeEvent: SubscriptionDeletion; routing: RoutedEvent };
    }): Promise<unknown>;
  },
) {
  const verified = boundary.verify(rawBody, signature);
  if (!isSubscriptionDeletion(verified)) return "ignored" as const;
  const deletion = subscriptionDeletedEventSchema.parse(verified);
  const routing = await boundary.route(deletion);
  if (routing.stamp.owner !== "cb") {
    reportSubscriptionSkip("not-owner", {
      source: "stripe-webhook",
      stripeEventId: deletion.id,
      owner: routing.stamp.owner,
    });
    return "not-owner" as const;
  }
  await boundary.publish({
    name: SUBSCRIPTION_DELETED_EVENT,
    data: { stripeEvent: deletion, routing },
  });
  return "dispatched" as const;
}

/** CourseBuilder's own webhook handler, which verifies and processes the event again. */
export type ForwardToCourseBuilder = () => Promise<Response>;

/**
 * Forward first, then run the seam's work. CourseBuilder's handler acts on these
 * events itself (it records every event, marks a fully refunded purchase Refunded
 * and a disputed one Disputed, workshops included), so it must see every one,
 * whatever the seam decides. A CourseBuilder failure is returned as is, so Stripe
 * retries; a seam failure after a good forward answers 503, so Stripe retries and
 * CourseBuilder's idempotent status update runs again.
 */
async function forwardThen(
  forward: ForwardToCourseBuilder,
  seamWork: () => Promise<Response | null>,
) {
  const forwarded = await forward();
  if (!forwarded.ok) return forwarded;
  return (await seamWork()) ?? forwarded;
}

export async function handleSubscriptionDeletion(
  request: Request,
  forward: ForwardToCourseBuilder,
): Promise<Response | null> {
  if (new URL(request.url).pathname.replace(/\/+$/, "") !== "/api/coursebuilder/webhook/stripe")
    return null;
  // Every other Stripe event still belongs to the CourseBuilder handler, so this
  // seam must not fail them: missing config, a missing signature or one this
  // secret cannot verify all fall through, and CourseBuilder verifies again.
  const verifier = stripeWebhookVerifier(getStripeProvider()?.options.paymentsAdapter);
  if (!verifier) return null;
  const signature = request.headers.get("stripe-signature");
  if (!signature) return null;
  const rawBody = await request.clone().text();
  let verified;
  try {
    verified = verifier.verify(rawBody, signature);
  } catch {
    return null;
  }
  const stripeEventId = z.object({ id: z.string() }).safeParse(verified).data?.id;
  if (isCustomerDeletion(verified))
    return forwardThen(forward, async () => {
      // Recording the marker is a membership write. Where writes are blocked, CB
      // owns no customer yet (the cutover guard refuses flips to CB until the
      // block lifts), so there is nothing to keep.
      if (!membershipWritesAllowed()) {
        reportSubscriptionSkip("writes-blocked", { source: "stripe-webhook", stripeEventId });
        return null;
      }
      try {
        await recordCustomerDeletion(verified, recordDeletedCustomer, (event) =>
          inngest.send(event),
        );
        return null;
      } catch (error) {
        reportSubscriptionAlert("customer-deletion-record-failed", {
          stripeEventId,
          errorName: safeErrorSummary(error).name,
          errorCode: safeErrorSummary(error).code,
        });
        return Response.json({ received: false }, { status: 503 });
      }
    });
  if (isBillingSignal(verified))
    return forwardThen(forward, async () => {
      // Where writes are blocked the seam does nothing; CourseBuilder still has it.
      if (!membershipWritesAllowed()) {
        reportSubscriptionSkip("writes-blocked", { source: "stripe-webhook", stripeEventId });
        return null;
      }
      const stripe = objectField(getStripeProvider()?.options.paymentsAdapter, "stripe");
      try {
        await dispatchBillingSignal(verified, {
          resolve: (event) => resolveBillingSignal(event, billingSignalStripe(stripe)),
          route: (signal) =>
            decideEventOwnership({
              eventId: signal.eventId,
              eventCreated: signal.created,
              stripeCustomerId: signal.stripeCustomerId,
            }),
          publish: (event) => inngest.send(event),
        });
        return null;
      } catch (error) {
        reportSubscriptionAlert("billing-signal-dispatch-failed", {
          stripeEventId,
          errorName: safeErrorSummary(error).name,
          errorCode: safeErrorSummary(error).code,
        });
        return Response.json({ received: false }, { status: 503 });
      }
    });
  if (!isSubscriptionDeletion(verified)) return null;
  // Only final cancellations enter the membership writer, which stays local-only.
  // Where it is blocked (beta and production today) a deletion is acknowledged
  // and skipped: Stripe must never see a 5xx for an environment that cannot write.
  if (!membershipWritesAllowed()) {
    reportSubscriptionSkip("writes-blocked", {
      source: "stripe-webhook",
      stripeEventId: z.object({ id: z.string() }).safeParse(verified).data?.id,
    });
    return Response.json({ received: true, skipped: "writes-blocked" });
  }
  // The published CourseBuilder transport only logs deletions. Other events still
  // use its handler; only verified deletions enter this app-owned subscription seam.
  let outcome;
  try {
    outcome = await dispatchSubscriptionDeletion(rawBody, signature, {
      verify: () => verified,
      route: (deletion) =>
        decideEventOwnership({
          eventId: deletion.id,
          eventCreated: deletion.created,
          stripeCustomerId: deletionCustomerId(deletion),
        }),
      publish: (event) => inngest.send(event),
    });
  } catch (error) {
    // The marker read or the publish failed. Never act by default (ADR §3): answer
    // non-2xx so Stripe delivers the event again.
    reportSubscriptionAlert("deletion-dispatch-failed", {
      stripeEventId: z.object({ id: z.string() }).safeParse(verified).data?.id,
      errorName: safeErrorSummary(error).name,
      errorCode: safeErrorSummary(error).code,
    });
    return Response.json({ received: false }, { status: 503 });
  }
  if (outcome === "not-owner") return Response.json({ received: true, skipped: "not-owner" });
  return outcome === "dispatched" ? Response.json({ received: true }) : null;
}
