import { z } from "zod";

import type { BillingInFlightFacts } from "./machine";

// ADR-0001 §14 L3: gather the billing work in flight on one Stripe customer, for the
// effect runner to put in `TransitionFacts` right before a flip. Structural, so
// the real Stripe client fits and tests can pass a fake. Charges are paged until
// Stripe says there are no more, up to `MAX_CHARGE_PAGES`, because a long-tenured
// subscriber has one per renewal and a dispute can land on an old one. Every other
// list is read once, up to `PAGE_LIMIT`. A list still truncated marks the facts
// incomplete, and the machine refuses to flip on incomplete facts.

const PAGE_LIMIT = 100;
/** 2,000 charges: a monthly subscriber for well over a century. */
export const MAX_CHARGE_PAGES = 20;

/** The slice of a Stripe list resource this reads. */
export interface StripeLister {
  list(params: Record<string, unknown>): PromiseLike<{ data: unknown[]; has_more: boolean }>;
}
export interface BillingInFlightStripe {
  readonly invoices: StripeLister;
  readonly invoiceItems: StripeLister;
  readonly subscriptionSchedules: StripeLister;
  readonly charges: StripeLister;
  readonly disputes: StripeLister;
  readonly refunds: StripeLister;
}

const ACTIVE_SCHEDULE_STATUSES = new Set(["not_started", "active"]);
const OPEN_DISPUTE_STATUSES = new Set([
  "warning_needs_response",
  "warning_under_review",
  "needs_response",
  "under_review",
]);
const IN_FLIGHT_REFUND_STATUSES = new Set(["pending", "requires_action"]);

const statusSchema = z.object({ status: z.string() });
const chargeSchema = z.object({
  id: z.string(),
  disputed: z.boolean().optional(),
  amount_refunded: z.number().optional(),
});

function countStatuses(data: unknown[], statuses: ReadonlySet<string>) {
  return data.filter((item) => {
    const parsed = statusSchema.safeParse(item);
    return parsed.success && statuses.has(parsed.data.status);
  }).length;
}

type ChargePage = { data: Array<z.infer<typeof chargeSchema>>; has_more: boolean };

/** Every charge on the customer, newest first, page by page via `starting_after`. */
async function listCharges(
  charges: StripeLister,
  customerId: string,
  startingAfter: string | null = null,
  pagesRead = 0,
): Promise<ChargePage> {
  const page = await charges.list({
    customer: customerId,
    limit: PAGE_LIMIT,
    ...(startingAfter === null ? {} : { starting_after: startingAfter }),
  });
  const data = z.array(chargeSchema).parse(page.data);
  const last = data.at(-1);
  // Stop when Stripe has no more, at the page cap, or on an empty page that
  // claims more (no cursor to continue from); the last two stay incomplete.
  if (!page.has_more || last === undefined || pagesRead + 1 >= MAX_CHARGE_PAGES)
    return { data, has_more: page.has_more };
  const rest = await listCharges(charges, customerId, last.id, pagesRead + 1);
  return { data: [...data, ...rest.data], has_more: rest.has_more };
}

export async function readBillingInFlight(
  stripe: BillingInFlightStripe,
  customerId: string,
): Promise<BillingInFlightFacts> {
  const page = { limit: PAGE_LIMIT };
  const [draft, open, items, schedules, charges] = await Promise.all([
    stripe.invoices.list({ customer: customerId, status: "draft", ...page }),
    stripe.invoices.list({ customer: customerId, status: "open", ...page }),
    stripe.invoiceItems.list({ customer: customerId, pending: true, ...page }),
    stripe.subscriptionSchedules.list({ customer: customerId, ...page }),
    listCharges(stripe.charges, customerId),
  ]);
  const parsedCharges = charges.data;
  // Disputes and refunds have no customer filter: read them per charge, only for
  // charges Stripe marks disputed or (partly) refunded. A pending refund counts in
  // `amount_refunded`.
  const [disputes, refunds] = await Promise.all([
    Promise.all(
      parsedCharges
        .filter((charge) => charge.disputed === true)
        .map((charge) => stripe.disputes.list({ charge: charge.id, ...page })),
    ),
    Promise.all(
      parsedCharges
        .filter((charge) => (charge.amount_refunded ?? 0) > 0)
        .map((charge) => stripe.refunds.list({ charge: charge.id, ...page })),
    ),
  ]);
  const pages = [draft, open, items, schedules, charges, ...disputes, ...refunds];
  return {
    openInvoices: draft.data.length + open.data.length,
    pendingInvoiceItems: items.data.length,
    activeSubscriptionSchedules: countStatuses(schedules.data, ACTIVE_SCHEDULE_STATUSES),
    openDisputes: disputes.reduce(
      (total, list) => total + countStatuses(list.data, OPEN_DISPUTE_STATUSES),
      0,
    ),
    refundsInFlight: refunds.reduce(
      (total, list) => total + countStatuses(list.data, IN_FLIGHT_REFUND_STATUSES),
      0,
    ),
    complete: pages.every((list) => !list.has_more),
  };
}
