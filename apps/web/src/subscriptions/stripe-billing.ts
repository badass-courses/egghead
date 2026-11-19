import type { PaymentsProviderConfig } from "@coursebuilder/core/types";
import { z } from "zod";
import { retrieveStripeEventCreatedAt } from "../coursebuilder/stripe-provider";
import { SubscriptionDataError } from "./alerts";
import { billingEventSchema, subscriptionSnapshotSchema } from "./lifecycle";
import { getStripeSubscriptionCurrentPeriodEnd, getStripeSubscriptionQuantity } from "./stripe";

const stripeBillingShapeSchema = z
  .object({
    id: z.string().min(1),
    status: subscriptionSnapshotSchema.shape.status,
    customer: z
      .union([z.string().min(1), z.object({ id: z.string().min(1) }).passthrough()])
      .optional(),
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
  // Shapes the lifecycle cannot represent (several items, an unknown status) will
  // never decode on retry, so they surface as data errors to acknowledge and alert.
  const parsed = stripeBillingShapeSchema.safeParse(rawSubscription);
  if (!parsed.success)
    throw new SubscriptionDataError(
      "unsupported-stripe-shape",
      "The Stripe subscription is not a single-item subscription with a known status",
    );
  const billing = parsed.data;
  const quantity = billing.items.data[0]?.quantity;
  const snapshot = subscriptionSnapshotSchema.safeParse({
    stripeSubscriptionId: billing.id,
    stripeCustomerId:
      typeof billing.customer === "string" ? billing.customer : (billing.customer?.id ?? null),
    ...(billing.metadata?.bulk
      ? { initialKind: billing.metadata.bulk === "true" ? "team" : "individual" }
      : {}),
    status: billing.status,
    seats: getStripeSubscriptionQuantity(rawSubscription),
    seatsReported: typeof quantity === "number",
    currentPeriodEnd: getStripeSubscriptionCurrentPeriodEnd(rawSubscription),
    event,
  });
  if (!snapshot.success)
    throw new SubscriptionDataError(
      "unsupported-stripe-shape",
      "The Stripe subscription has no usable quantity or billing period",
    );
  return snapshot.data;
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
