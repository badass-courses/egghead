export type SubscriptionBillingInterval = "day" | "week" | "month" | "year";

const billingIntervalOrder: Record<SubscriptionBillingInterval, number> = {
  day: 0,
  week: 1,
  month: 2,
  year: 3,
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

export function subscriptionProductFields(fields: unknown) {
  const description =
    typeof fields === "object" &&
    fields !== null &&
    "description" in fields &&
    typeof fields.description === "string"
      ? fields.description
      : null;
  const intervalValue =
    typeof fields === "object" &&
    fields !== null &&
    "billingInterval" in fields &&
    typeof fields.billingInterval === "string"
      ? fields.billingInterval
      : null;
  let billingInterval: SubscriptionBillingInterval | null = null;

  if (
    intervalValue === "day" ||
    intervalValue === "week" ||
    intervalValue === "month" ||
    intervalValue === "year"
  ) {
    billingInterval = intervalValue;
  }

  return { billingInterval, description };
}

export function subscriptionIntervalLabel(interval: SubscriptionBillingInterval) {
  if (interval === "day") return "Daily";
  if (interval === "week") return "Weekly";
  if (interval === "month") return "Monthly";
  return "Yearly";
}

export function compareSubscriptionIntervals(
  first: SubscriptionBillingInterval,
  second: SubscriptionBillingInterval,
) {
  return billingIntervalOrder[first] - billingIntervalOrder[second];
}
