import { z } from "zod";
import { getStripeSubscriptionCurrentPeriodEnd } from "../stripe";
import { accessGranted, strictPaidThroughRule } from "../ownership/access-rule";
import { readOwnerMarker } from "../ownership/marker";
import { routeStripeEvent } from "../ownership/routing";
import { isEggheadSubscription, type TenantCatalogue } from "./tenant";
import type { ShadowStripeReader } from "./stripe-reader";

export const SHADOW_STRIPE_EVENTS = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
  "customer.deleted",
  "checkout.session.completed",
] as const;

export const shadowEventSchema = z.object({
  id: z.string().min(1),
  type: z.enum(SHADOW_STRIPE_EVENTS),
  created: z.number().int().nonnegative(),
  data: z.object({
    object: z.object({ id: z.string() }).passthrough(),
    previous_attributes: z.unknown().optional(),
  }),
});
export type ShadowEvent = z.infer<typeof shadowEventSchema>;

const idSchema = z
  .union([z.string(), z.object({ id: z.string() })])
  .nullable()
  .optional();
function id(value: unknown) {
  const parsed = idSchema.parse(value);
  return typeof parsed === "string" ? parsed : (parsed?.id ?? null);
}
const objectSchema = z
  .object({
    id: z.string(),
    customer: idSchema,
    subscription: idSchema,
    charge: idSchema,
    invoice: idSchema,
    parent: z
      .object({ subscription_details: z.object({ subscription: idSchema }).nullable().optional() })
      .nullable()
      .optional(),
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .passthrough();
const subscriptionSchema = z
  .object({
    id: z.string(),
    customer: idSchema,
    status: z.enum([
      "active",
      "past_due",
      "trialing",
      "unpaid",
      "canceled",
      "paused",
      "incomplete",
      "incomplete_expired",
    ]),
    cancel_at_period_end: z.boolean().default(false),
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .passthrough();

export interface ShadowSubscription {
  stripeSubscriptionId: string;
  status: z.infer<typeof subscriptionSchema>["status"];
  currentPeriodEnd: number | null;
  /** ISO timestamp, the future write target is Entitlement.expiresAt, not a new boundary. */
  expiresAt: string | null;
  targetSourceType: "rails_account_subscription";
  seats: number;
  seatChange: { previous: number | null; next: number; delta: number | null };
  cancelAtPeriodEnd: boolean;
  billingAccess: boolean;
  accessVerdict: "grant" | "deny" | "unknown-team-roster";
  roster: "not-required" | "unknown";
  accessLaw: string;
}

export interface ShadowRecord {
  name: "subscription.shadow.would-do" | "subscription.shadow.skipped";
  version: 1;
  stripeEventId: string;
  eventType: ShadowEvent["type"];
  createdAt: number;
  observedAt: number;
  count: 1;
  reason: "rails-owner" | "not-egghead" | "not-rails-owner" | "not-subscription";
  skippedSubscriptions: number;
  tenantMetadataConflicts: number;
  unresolvedDeletedCustomers: number;
  subscriptions: ShadowSubscription[];
}

/** Resolve only Stripe references, never application rows or customer identity. */
async function resolveSubscriptions(
  event: ShadowEvent,
  stripe: ShadowStripeReader,
): Promise<unknown[]> {
  const payload = objectSchema.parse(event.data.object);
  if (event.type === "customer.deleted") return stripe.subscriptions(payload.id);
  if (event.type.startsWith("customer.subscription.")) {
    // A deletion is terminal and its signed payload remains available after deletion.
    return [
      event.type === "customer.subscription.deleted"
        ? event.data.object
        : await stripe.retrieve("subscriptions", payload.id),
    ];
  }
  if (event.type === "checkout.session.completed") {
    const subscription = id(payload.subscription);
    return subscription ? [await stripe.retrieve("subscriptions", subscription)] : [];
  }
  let invoice = payload;
  if (event.type.startsWith("charge.")) {
    const chargeId = event.type === "charge.refunded" ? payload.id : id(payload.charge);
    if (!chargeId) return [];
    const charge = objectSchema.parse(await stripe.retrieve("charges", chargeId));
    const invoiceId = id(charge.invoice);
    if (!invoiceId) return [];
    invoice = objectSchema.parse(await stripe.retrieve("invoices", invoiceId));
  }
  const subscription =
    id(invoice.subscription) ?? id(invoice.parent?.subscription_details?.subscription);
  return subscription ? [await stripe.retrieve("subscriptions", subscription)] : [];
}

type ProjectionResult =
  | { kind: "projected"; subscription: ShadowSubscription }
  | { kind: "not-egghead" | "metadata-conflict" | "deleted-customer" | "not-rails-owner" };

/** Pure would-do projection after GET-only resolution. No customer-visible writes exist here. */
export async function projectShadowEvent(
  event: ShadowEvent,
  stripe: ShadowStripeReader,
  observedAt: number,
  catalogue?: TenantCatalogue,
): Promise<ShadowRecord> {
  const resolved = await resolveSubscriptions(event, stripe);
  const results = await Promise.all(
    resolved.map(async (raw): Promise<ProjectionResult> => {
      const reference = objectSchema.parse(raw);
      const customerId = id(reference.customer);
      const customer =
        event.type === "customer.deleted"
          ? objectSchema.parse(event.data.object)
          : customerId
            ? objectSchema.parse(await stripe.retrieve("customers", customerId))
            : null;
      if (!isEggheadSubscription(raw, {}, catalogue)) {
        return { kind: "not-egghead" };
      }
      const items = z
        .object({
          items: z.object({
            data: z
              .array(
                z.object({
                  quantity: z.number().int().positive(),
                  price: z.object({ product: idSchema }).optional(),
                  plan: z.object({ product: idSchema }).optional(),
                }),
              )
              .length(1),
          }),
        })
        .parse(raw).items.data;
      const productSites = await Promise.all(
        items.map(async (item) => {
          const productId = id(item.price?.product) ?? id(item.plan?.product);
          if (!productId) return undefined;
          const product = objectSchema.parse(await stripe.retrieve("products", productId));
          return product.metadata["site"];
        }),
      );
      if (
        !isEggheadSubscription(raw, customer?.metadata ?? {}, catalogue) ||
        productSites.some((site) => site !== undefined && site !== "egghead.io")
      ) {
        return { kind: "metadata-conflict" };
      }
      // A Stripe tombstone has lost its marker. No main DB read is allowed, so
      // leave the ownership unresolved instead of treating it as Rails-owned.
      if (event.type !== "customer.deleted" && customer?.["deleted"] === true) {
        return { kind: "deleted-customer" };
      }
      const subscription = subscriptionSchema.parse(raw);
      // Use the same event-time timeline rule as the real writer, without its DB imports.
      const routing = routeStripeEvent({
        eventId: event.id,
        eventCreated: event.created,
        receivedAt: Math.floor(observedAt / 1000),
        priorStamp: null,
        subject: customer
          ? { kind: "customer", marker: readOwnerMarker(customer.metadata) }
          : { kind: "customerless", paymentIntentMetadata: null },
      });
      if (routing.scope !== "owned" || routing.stamp.owner !== "rails")
        return { kind: "not-rails-owner" };
      const status =
        event.type === "customer.subscription.deleted" || event.type === "customer.deleted"
          ? "canceled"
          : subscription.status;
      const period = z
        .number()
        .int()
        .positive()
        .max(253402300799)
        .safeParse(getStripeSubscriptionCurrentPeriodEnd(raw));
      const currentPeriodEnd = period.success ? period.data : null;
      const seats = items[0]?.quantity;
      if (seats === undefined) throw new Error("Shadow subscription has no seat quantity");
      const previous = z
        .object({
          items: z.object({
            data: z.array(z.object({ quantity: z.number().int().positive() })).length(1),
          }),
        })
        .safeParse(event.data.previous_attributes);
      const previousSeats = previous.success
        ? (previous.data.items.data[0]?.quantity ?? null)
        : null;
      const billingAccess = accessGranted(
        strictPaidThroughRule.evaluate({
          status,
          paidThroughAt: currentPeriodEnd,
          now: Math.floor(observedAt / 1000),
        }),
      );
      const team = subscription.metadata["bulk"] === "true" || seats > 1;
      return {
        kind: "projected",
        subscription: {
          stripeSubscriptionId: subscription.id,
          status,
          currentPeriodEnd,
          expiresAt:
            currentPeriodEnd === null ? null : new Date(currentPeriodEnd * 1000).toISOString(),
          targetSourceType: "rails_account_subscription",
          seats,
          seatChange: {
            previous: previousSeats,
            next: seats,
            delta: previousSeats === null ? null : seats - previousSeats,
          },
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          billingAccess,
          accessVerdict: !billingAccess ? "deny" : team ? "unknown-team-roster" : "grant",
          roster: team ? "unknown" : "not-required",
          accessLaw: strictPaidThroughRule.name,
        },
      };
    }),
  );
  const subscriptions = results.flatMap((result) =>
    result.kind === "projected" ? [result.subscription] : [],
  );
  const tenantMetadataConflicts = results.filter(
    (result) => result.kind === "metadata-conflict",
  ).length;
  const skippedSubscriptions = results.filter(
    (result) => result.kind === "not-egghead" || result.kind === "metadata-conflict",
  ).length;
  const unresolvedDeletedCustomers = results.filter(
    (result) => result.kind === "deleted-customer",
  ).length;
  const reason = subscriptions.length
    ? "rails-owner"
    : !resolved.length
      ? "not-subscription"
      : skippedSubscriptions
        ? "not-egghead"
        : "not-rails-owner";
  return {
    name: subscriptions.length ? "subscription.shadow.would-do" : "subscription.shadow.skipped",
    version: 1,
    stripeEventId: event.id,
    eventType: event.type,
    createdAt: event.created,
    observedAt,
    count: 1,
    reason,
    skippedSubscriptions,
    tenantMetadataConflicts,
    unresolvedDeletedCustomers,
    subscriptions,
  };
}
