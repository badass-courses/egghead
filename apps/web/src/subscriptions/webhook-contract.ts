import { z } from "zod";

export const SUBSCRIPTION_DELETED_EVENT = "egghead/stripe-subscription-deleted";
export const subscriptionDeletedEventSchema = z.object({
  id: z.string().min(1),
  created: z.number().int().nonnegative(),
  type: z.literal("customer.subscription.deleted"),
  data: z.object({ object: z.object({ id: z.string().min(1) }) }),
});
export type EggheadSubscriptionEvents = {
  [SUBSCRIPTION_DELETED_EVENT]: {
    name: typeof SUBSCRIPTION_DELETED_EVENT;
    data: { stripeEvent: z.infer<typeof subscriptionDeletedEventSchema> };
  };
};
