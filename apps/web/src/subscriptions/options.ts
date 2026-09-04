import type { MembershipBillingInterval } from "./catalog-contracts";

const billingIntervalOrder: Record<MembershipBillingInterval, number> = {
  month: 0,
  year: 1,
};

export function subscriptionIntervalLabel(interval: MembershipBillingInterval) {
  if (interval === "month") return "Monthly";
  return "Yearly";
}

export function compareSubscriptionIntervals(
  first: MembershipBillingInterval,
  second: MembershipBillingInterval,
) {
  return billingIntervalOrder[first] - billingIntervalOrder[second];
}
