import { createHash } from "node:crypto";

export const EGGHEAD_SUBSCRIPTION_ENTITLEMENT = "egghead_all_access_subscription";
export const STRIPE_SUBSCRIPTION_SOURCE = "stripe_subscription";
export const CURRENT_SUBSCRIPTION_STATUSES = ["active", "past_due", "trialing"];

export function stripeSubscriptionGrantsAccess(status: string) {
  return CURRENT_SUBSCRIPTION_STATUSES.includes(status);
}

// One identity per subscription beneficiary, regardless of checkout or membership kind.
export function subscriptionGrantId(subscriptionId: string, userId: string) {
  return `stripe_seat_${createHash("sha256").update(`${subscriptionId}:${userId}`).digest("hex")}`;
}
