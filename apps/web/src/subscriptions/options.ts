import type { BillingInterval } from "@coursebuilder/core/schemas";

const billingIntervalOrder: Record<NonNullable<BillingInterval>, number> = {
  month: 0,
  year: 1,
};

export function subscriptionIntervalLabel(interval: NonNullable<BillingInterval>) {
  if (interval === "month") return "Monthly";
  return "Yearly";
}

export function compareSubscriptionIntervals(
  first: NonNullable<BillingInterval>,
  second: NonNullable<BillingInterval>,
) {
  return billingIntervalOrder[first] - billingIntervalOrder[second];
}
