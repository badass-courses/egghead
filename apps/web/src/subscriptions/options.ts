import type { BillingInterval } from "@coursebuilder/core/schemas";

const billingIntervalOrder: Record<NonNullable<BillingInterval>, number> = {
  month: 0,
  year: 1,
};

export function subscriptionProductIds(
  configuredProductIds: string | undefined,
  fallbackProductId: string | undefined,
) {
  const productIds = configuredProductIds
    ?.split(",")
    .map((productId) => productId.trim())
    .filter(Boolean);

  return [
    ...new Set(productIds?.length ? productIds : fallbackProductId ? [fallbackProductId] : []),
  ];
}

export function isConfiguredSubscriptionProductId(productId: string, configuredIds: string[]) {
  return configuredIds.includes(productId);
}

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
