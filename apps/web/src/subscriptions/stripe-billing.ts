import type { PaymentsProviderConfig } from "@coursebuilder/core/types";
import { z } from "zod";
import { retrieveStripeEventCreatedAt } from "../coursebuilder/stripe-provider";
import { billingEventSchema, subscriptionSnapshotSchema } from "./lifecycle";
import { getStripeSubscriptionCurrentPeriodEnd, getStripeSubscriptionQuantity } from "./stripe";

const stripeBillingShapeSchema = z
  .object({
    id: z.string().min(1),
    status: subscriptionSnapshotSchema.shape.status,
    metadata: z
      .object({ bulk: z.enum(["true", "false"]).optional() })
      .passthrough()
      .optional(),
    items: z.object({
      data: z
        .array(
          z.object({ quantity: z.number().int().positive().nullable().optional() }).passthrough(),
        )
        .length(1),
    }),
  })
  .passthrough();

export function normalizeStripeBillingSnapshot(
  rawSubscription: unknown,
  event: z.infer<typeof billingEventSchema>,
) {
  const billing = stripeBillingShapeSchema.parse(rawSubscription);
  return subscriptionSnapshotSchema.parse({
    stripeSubscriptionId: billing.id,
    ...(billing.metadata?.bulk
      ? { initialKind: billing.metadata.bulk === "true" ? "team" : "individual" }
      : {}),
    status: billing.status,
    seats: getStripeSubscriptionQuantity(rawSubscription),
    currentPeriodEnd: getStripeSubscriptionCurrentPeriodEnd(rawSubscription),
    event,
  });
}

export async function loadStripeSubscriptionSnapshot(
  provider: PaymentsProviderConfig,
  subscriptionId: string,
  event: Pick<z.infer<typeof billingEventSchema>, "id" | "kind"> & { createdAt?: number },
) {
  // Published update events omit creation time; retrieve the original event at this boundary.
  const createdAt = event.createdAt ?? (await retrieveStripeEventCreatedAt(provider, event.id));
  const observedAt = Date.now();
  const billing = await provider.options.paymentsAdapter.getSubscription(subscriptionId);
  return normalizeStripeBillingSnapshot(billing, { ...event, createdAt, observedAt });
}
