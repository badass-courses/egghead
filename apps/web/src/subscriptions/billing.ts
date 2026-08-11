import { and, eq } from "drizzle-orm";

import { getStripeProvider, getSiteUrl } from "../coursebuilder/stripe-provider";
import { getEggheadDatabase } from "../db/adapter";
import { merchantCustomer, merchantSubscription, products } from "../db/schema";
import { getCurrentSubscriptionForUser } from "./status";

export type MembershipBillingSummary = {
  productName: string;
  billingInterval: string;
  cost: string | null;
  renewsAt: Date;
  cancelAtPeriodEnd: boolean;
};

export function formatMembershipCost(
  unitAmount: number | null,
  currency: string | null,
  quantity: number | null,
) {
  if (unitAmount === null || !Number.isFinite(unitAmount) || !currency) return null;

  try {
    const formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    });
    const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    const itemQuantity = quantity && quantity > 0 ? quantity : 1;

    return formatter.format((unitAmount * itemQuantity) / 10 ** fractionDigits);
  } catch {
    return null;
  }
}

export function membershipIntervalLabel(interval: string | null, intervalCount: number | null) {
  const count = intervalCount && intervalCount > 0 ? intervalCount : 1;

  if (count === 1) {
    if (interval === "day") return "Daily";
    if (interval === "week") return "Weekly";
    if (interval === "month") return "Monthly";
    if (interval === "year") return "Annual";
    return "Recurring";
  }

  const unit = interval ? `${interval}${count === 1 ? "" : "s"}` : "billing periods";
  return `Every ${count} ${unit}`;
}

async function getStripeMembershipForUser(userId: string) {
  const currentSubscription = await getCurrentSubscriptionForUser(userId);
  if (!currentSubscription) return null;

  const db = getEggheadDatabase();
  const [storedMerchantSubscription, product] = await Promise.all([
    db.query.merchantSubscription.findFirst({
      where: eq(merchantSubscription.id, currentSubscription.merchantSubscriptionId),
    }),
    db.query.products.findFirst({
      where: eq(products.id, currentSubscription.productId),
    }),
  ]);
  const stripeProvider = getStripeProvider();

  if (!storedMerchantSubscription?.identifier || !stripeProvider) return null;

  const ownedMerchantCustomer = await db.query.merchantCustomer.findFirst({
    where: and(
      eq(merchantCustomer.id, storedMerchantSubscription.merchantCustomerId),
      eq(merchantCustomer.userId, userId),
    ),
  });
  if (!ownedMerchantCustomer) return null;

  const stripeSubscription = await stripeProvider.getSubscription(
    storedMerchantSubscription.identifier,
  );

  return { product, stripeProvider, stripeSubscription };
}

export async function getMembershipBillingSummary(
  userId: string,
): Promise<MembershipBillingSummary | null> {
  try {
    const membership = await getStripeMembershipForUser(userId);
    if (!membership) return null;

    const subscriptionItem = membership.stripeSubscription.items.data[0];
    const price = subscriptionItem?.price;
    const periodEnd = membership.stripeSubscription.current_period_end;
    if (!periodEnd || !Number.isFinite(periodEnd)) return null;

    return {
      productName: membership.product?.name.trim() || "egghead membership",
      billingInterval: membershipIntervalLabel(
        price?.recurring?.interval ?? null,
        price?.recurring?.interval_count ?? null,
      ),
      cost: formatMembershipCost(
        price?.unit_amount ?? null,
        price?.currency ?? null,
        subscriptionItem?.quantity ?? null,
      ),
      renewsAt: new Date(periodEnd * 1000),
      cancelAtPeriodEnd: membership.stripeSubscription.cancel_at_period_end,
    };
  } catch {
    return null;
  }
}

export async function getMembershipBillingPortalUrl(userId: string) {
  try {
    const membership = await getStripeMembershipForUser(userId);
    if (!membership) return null;

    const customer = membership.stripeSubscription.customer;
    const customerId = typeof customer === "string" ? customer : customer.id;

    return membership.stripeProvider.getBillingPortalUrl(customerId, `${getSiteUrl()}/profile`);
  } catch {
    return null;
  }
}
