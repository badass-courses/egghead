import { z } from "zod";

const stripeSubscriptionItemSchema = z
  .object({
    current_period_end: z.number().optional(),
    quantity: z.number().int().positive().nullable().optional(),
  })
  .passthrough();

const stripeSubscriptionShapeSchema = z
  .object({
    current_period_end: z.number().optional(),
    items: z
      .object({
        data: z.array(stripeSubscriptionItemSchema),
      })
      .optional(),
  })
  .passthrough();

export function getStripeSubscriptionCurrentPeriodEnd(stripeSubscription: unknown) {
  // CourseBuilder currently publishes pre-item-period Stripe types. Parse the runtime
  // response so both the legacy subscription field and current item fields are supported.
  const parsedSubscription = stripeSubscriptionShapeSchema.safeParse(stripeSubscription);
  if (!parsedSubscription.success) return null;
  if (parsedSubscription.data.current_period_end !== undefined) {
    return parsedSubscription.data.current_period_end;
  }

  let latestPeriodEnd: number | null = null;
  for (const item of parsedSubscription.data.items?.data ?? []) {
    const periodEnd = item.current_period_end;
    if (periodEnd !== undefined && (latestPeriodEnd === null || periodEnd > latestPeriodEnd)) {
      latestPeriodEnd = periodEnd;
    }
  }

  return latestPeriodEnd;
}

export function getStripeSubscriptionQuantity(stripeSubscription: unknown) {
  const parsedSubscription = stripeSubscriptionShapeSchema.safeParse(stripeSubscription);
  if (!parsedSubscription.success) return null;

  return parsedSubscription.data.items?.data.at(0)?.quantity ?? 1;
}
