import { z } from "zod";

// ADR-0001 §14 L4: after a handover, dunning, refunds and disputes for a customer
// route to CB. These are "billing signals". CourseBuilder's published handler
// still receives every one first: @coursebuilder/commerce 0.2.3 records each
// event, marks a fully refunded purchase Refunded on `charge.refunded` and a
// purchase Disputed on `charge.dispute.created` (workshops included). In
// addition, CB routes each signal at receipt like any event, re-reads the
// subscription's live Stripe state and reconciles it, and logs a support receipt
// with Stripe ids only. Revoking access because of a refund or dispute is a policy
// decision this lane does not make; access follows the subscription's status.

export const BILLING_SIGNAL_TYPES = [
  "invoice.payment_failed",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
] as const;
export type BillingSignalType = (typeof BILLING_SIGNAL_TYPES)[number];
const signalTypeSchema = z.enum(BILLING_SIGNAL_TYPES);

export function isBillingSignal(event: unknown) {
  return z.object({ type: signalTypeSchema }).safeParse(event).success;
}

const idOf = z
  .union([z.string().min(1), z.object({ id: z.string().min(1) })])
  .nullable()
  .optional()
  .transform((value) => (value == null ? null : typeof value === "string" ? value : value.id));

const signalEventSchema = z.object({
  id: z.string().min(1),
  created: z.number().int().nonnegative(),
  type: signalTypeSchema,
  data: z.object({ object: z.object({ id: z.string().min(1) }).passthrough() }),
});

const invoiceSchema = z.object({
  id: z.string().min(1),
  customer: idOf,
  // API 2024-06-20 (the pinned client) and older payloads.
  subscription: idOf,
  // Newer webhook payloads moved it here.
  parent: z
    .object({ subscription_details: z.object({ subscription: idOf }).nullable().optional() })
    .nullable()
    .optional(),
});
const chargeSchema = z.object({
  id: z.string().min(1),
  customer: idOf,
  invoice: idOf,
});
const disputeSchema = z.object({ id: z.string().min(1), charge: idOf });

/** The slice of the Stripe client a signal needs to find its subscription. */
export interface BillingSignalStripe {
  readonly invoices: { retrieve(id: string): PromiseLike<unknown> };
  readonly charges: { retrieve(id: string): PromiseLike<unknown> };
}

export type ResolvedBillingSignal = {
  readonly eventId: string;
  readonly created: number;
  readonly type: BillingSignalType;
  /** The invoice, charge or dispute the event is about. */
  readonly objectId: string;
  readonly stripeCustomerId: string | null;
  /** Null for a charge or invoice that belongs to no subscription. */
  readonly stripeSubscriptionId: string | null;
};

function invoiceSubscription(invoice: z.infer<typeof invoiceSchema>) {
  return invoice.subscription ?? invoice.parent?.subscription_details?.subscription ?? null;
}

async function subscriptionOfInvoice(invoiceId: string | null, stripe: BillingSignalStripe) {
  if (invoiceId === null) return null;
  return invoiceSubscription(invoiceSchema.parse(await stripe.invoices.retrieve(invoiceId)));
}

/** Find the customer and subscription a billing signal is about. Stripe reads throw. */
export async function resolveBillingSignal(
  verified: unknown,
  stripe: BillingSignalStripe,
): Promise<ResolvedBillingSignal> {
  const event = signalEventSchema.parse(verified);
  const base = {
    eventId: event.id,
    created: event.created,
    type: event.type,
    objectId: event.data.object.id,
  };
  if (event.type === "invoice.payment_failed") {
    const invoice = invoiceSchema.parse(event.data.object);
    const fromPayload = invoiceSubscription(invoice);
    return {
      ...base,
      stripeCustomerId: invoice.customer,
      stripeSubscriptionId: fromPayload ?? (await subscriptionOfInvoice(invoice.id, stripe)),
    };
  }
  // A dispute names its charge; a refund event is the charge itself.
  const chargeId =
    event.type === "charge.refunded"
      ? event.data.object.id
      : disputeSchema.parse(event.data.object).charge;
  if (chargeId === null) return { ...base, stripeCustomerId: null, stripeSubscriptionId: null };
  const payloadCharge =
    event.type === "charge.refunded" ? chargeSchema.safeParse(event.data.object) : null;
  // The payload's charge may come from a newer API without `invoice`; the pinned
  // client's read has it.
  const charge =
    payloadCharge?.success && payloadCharge.data.invoice !== null
      ? payloadCharge.data
      : chargeSchema.parse(await stripe.charges.retrieve(chargeId));
  return {
    ...base,
    stripeCustomerId: charge.customer,
    stripeSubscriptionId: await subscriptionOfInvoice(charge.invoice, stripe),
  };
}
