import { describe, expect, it } from "vitest";

import {
  MAX_CHARGE_PAGES,
  readBillingInFlight,
  type BillingInFlightStripe,
  type StripeLister,
} from "./billing-in-flight";

type Pages = Partial<
  Record<keyof BillingInFlightStripe, (params: Record<string, unknown>) => unknown[]>
>;

function fakeStripe(pages: Pages, truncated: ReadonlySet<keyof BillingInFlightStripe> = new Set()) {
  const calls: Array<{ resource: string; params: Record<string, unknown> }> = [];
  const lister = (resource: keyof BillingInFlightStripe): StripeLister => ({
    list: async (params) => {
      calls.push({ resource, params });
      return { data: pages[resource]?.(params) ?? [], has_more: truncated.has(resource) };
    },
  });
  const stripe: BillingInFlightStripe = {
    invoices: lister("invoices"),
    invoiceItems: lister("invoiceItems"),
    subscriptionSchedules: lister("subscriptionSchedules"),
    charges: lister("charges"),
    disputes: lister("disputes"),
    refunds: lister("refunds"),
  };
  return { stripe, calls };
}

describe("readBillingInFlight (ADR-0001 §14 L3)", () => {
  it("reports a customer with nothing in flight as clear and complete", async () => {
    const { stripe, calls } = fakeStripe({});
    expect(await readBillingInFlight(stripe, "cus_1")).toEqual({
      openInvoices: 0,
      pendingInvoiceItems: 0,
      activeSubscriptionSchedules: 0,
      openDisputes: 0,
      refundsInFlight: 0,
      complete: true,
    });
    // Every customer-scoped list is filtered by the customer.
    for (const call of calls) expect(call.params["customer"]).toBe("cus_1");
  });

  it("counts open work and ignores finished work", async () => {
    const { stripe, calls } = fakeStripe({
      invoices: (params) => (params["status"] === "draft" ? [{}] : [{}, {}]),
      invoiceItems: () => [{}],
      subscriptionSchedules: () => [
        { status: "active" },
        { status: "not_started" },
        { status: "completed" },
        { status: "released" },
      ],
      charges: () => [
        { id: "ch_disputed", disputed: true, amount_refunded: 0 },
        { id: "ch_refunded", disputed: false, amount_refunded: 500 },
        { id: "ch_plain", disputed: false, amount_refunded: 0 },
      ],
      disputes: () => [{ status: "needs_response" }, { status: "won" }],
      refunds: () => [{ status: "pending" }, { status: "succeeded" }],
    });
    expect(await readBillingInFlight(stripe, "cus_1")).toEqual({
      openInvoices: 3,
      pendingInvoiceItems: 1,
      activeSubscriptionSchedules: 2,
      openDisputes: 1,
      refundsInFlight: 1,
      complete: true,
    });
    // Disputes and refunds are read only for charges that have them.
    expect(
      calls.filter((call) => call.resource === "disputes").map((call) => call.params["charge"]),
    ).toEqual(["ch_disputed"]);
    expect(
      calls.filter((call) => call.resource === "refunds").map((call) => call.params["charge"]),
    ).toEqual(["ch_refunded"]);
    expect(calls.find((call) => call.resource === "invoiceItems")?.params["pending"]).toBe(true);
  });

  it("marks the facts incomplete when any list is truncated", async () => {
    const { stripe } = fakeStripe({}, new Set(["invoices"]));
    expect((await readBillingInFlight(stripe, "cus_1")).complete).toBe(false);
    // An empty charge page that claims more has no cursor: incomplete, not a loop.
    const { stripe: endless, calls } = fakeStripe({}, new Set(["charges"]));
    expect((await readBillingInFlight(endless, "cus_1")).complete).toBe(false);
    expect(calls.filter((call) => call.resource === "charges")).toHaveLength(1);
  });

  it("pages a long-tenured customer's charges and finds a dispute on an old one", async () => {
    // 250 renewals, newest first; the dispute is on one of the oldest.
    const all = Array.from({ length: 250 }, (_, index) => ({
      id: `ch_${index}`,
      disputed: index === 240,
      amount_refunded: 0,
    }));
    const calls: Array<Record<string, unknown>> = [];
    const charges: StripeLister = {
      list: async (params) => {
        calls.push(params);
        const after = params["starting_after"];
        const start = typeof after === "string" ? all.findIndex((c) => c.id === after) + 1 : 0;
        const data = all.slice(start, start + 100);
        return { data, has_more: start + 100 < all.length };
      },
    };
    const { stripe } = fakeStripe({ disputes: () => [{ status: "needs_response" }] });
    const facts = await readBillingInFlight({ ...stripe, charges }, "cus_1");
    expect(facts).toMatchObject({ openDisputes: 1, complete: true });
    expect(calls.map((params) => params["starting_after"] ?? null)).toEqual([
      null,
      "ch_99",
      "ch_199",
    ]);
  });

  it("stops at the page cap and reports the facts incomplete", async () => {
    let next = 0;
    const charges: StripeLister = {
      list: async () => {
        next += 1;
        return { data: [{ id: `ch_${next}` }], has_more: true };
      },
    };
    const { stripe } = fakeStripe({});
    expect((await readBillingInFlight({ ...stripe, charges }, "cus_1")).complete).toBe(false);
    expect(next).toBe(MAX_CHARGE_PAGES);
  });
});
