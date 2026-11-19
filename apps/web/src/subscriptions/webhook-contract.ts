import { z } from "zod";

import type { BillingSignalType } from "./billing-signals";
import type { RoutedEvent } from "./ownership-seam";

export const SUBSCRIPTION_DELETED_EVENT = "egghead/stripe-subscription-deleted";
export const subscriptionDeletedEventSchema = z.object({
  id: z.string().min(1),
  created: z.number().int().nonnegative(),
  type: z.literal("customer.subscription.deleted"),
  data: z.object({
    object: z.object({
      id: z.string().min(1),
      // Routing reads the customer's ownership marker (ADR-0001 §2).
      customer: z.union([z.string().min(1), z.object({ id: z.string().min(1) })]).optional(),
    }),
  }),
});
/** `customer.deleted`: its object still carries the customer's ownership marker metadata. */
export const customerDeletedEventSchema = z.object({
  id: z.string().min(1),
  created: z.number().int().nonnegative(),
  type: z.literal("customer.deleted"),
  data: z.object({
    object: z.object({
      id: z.string().min(1),
      metadata: z.record(z.string(), z.string()).optional(),
    }),
  }),
});

/**
 * A CB-owned dunning, refund or dispute event (ADR-0001 §14 L4), routed at receipt
 * and shaped like a subscription event, so the billing function re-reads that
 * subscription and reconciles it under the same per-subscription concurrency key.
 */
export const BILLING_SIGNAL_EVENT = "egghead/stripe-billing-signal";

/**
 * Sent after a `customer.deleted` marker is recorded, so runs waiting on that
 * customer's record (ADR-0001 §14 L2) route again at once instead of at their
 * next hourly check.
 */
export const DELETED_CUSTOMER_RECORDED_EVENT = "egghead/stripe-customer-deletion-recorded";
export type DeletedCustomerRecordedPayload = { stripeCustomerId: string };
export type BillingSignalPayload = {
  stripeEvent: {
    id: string;
    created: number;
    data: { object: { id: string; customer: string | null } };
  };
  routing: RoutedEvent;
  signal: { type: BillingSignalType; objectId: string };
};

export type EggheadSubscriptionEvents = {
  [BILLING_SIGNAL_EVENT]: { name: typeof BILLING_SIGNAL_EVENT; data: BillingSignalPayload };
  [DELETED_CUSTOMER_RECORDED_EVENT]: {
    name: typeof DELETED_CUSTOMER_RECORDED_EVENT;
    data: DeletedCustomerRecordedPayload;
  };
  [SUBSCRIPTION_DELETED_EVENT]: {
    name: typeof SUBSCRIPTION_DELETED_EVENT;
    data: {
      stripeEvent: z.infer<typeof subscriptionDeletedEventSchema>;
      /** Ownership decided once at receipt (ADR-0001 §3); the function never decides again. */
      routing: RoutedEvent;
    };
  };
};
