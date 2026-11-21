import { z } from "zod";

export interface ShadowStripeReader {
  retrieve(
    resource: "subscriptions" | "customers" | "invoices" | "charges" | "products",
    id: string,
  ): Promise<unknown>;
  subscriptions(customer?: string): Promise<unknown[]>;
  events(from: number, to: number): AsyncIterable<unknown>;
}

const pageSchema = z.object({
  data: z.array(z.object({ id: z.string() }).passthrough()),
  has_more: z.boolean(),
});

/** Deliberately exposes GET only. Provision a restricted Stripe key with read permissions only. */
export function createShadowStripeReader(
  key: string,
  request: typeof fetch = fetch,
): ShadowStripeReader {
  const get = async (path: string, params = new URLSearchParams()): Promise<unknown> => {
    const response = await request(`https://api.stripe.com/v1/${path}?${params}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, "Stripe-Version": "2024-06-20" },
      cache: "no-store",
    });
    // Never surface Stripe's response body: it can contain customer data.
    if (!response.ok) throw new Error("Shadow Stripe read failed");
    return response.json();
  };
  async function* pages(
    path: string,
    query: Record<string, string>,
    after?: string,
  ): AsyncGenerator<z.infer<typeof pageSchema>["data"][number], void, unknown> {
    const params = new URLSearchParams({
      ...query,
      limit: "100",
      ...(after ? { starting_after: after } : {}),
    });
    const page = pageSchema.parse(await get(path, params));
    yield* page.data;
    if (!page.has_more) return;
    const next = page.data.at(-1)?.id;
    if (!next || next === after) throw new Error("Shadow Stripe pagination made no progress");
    // The next request depends on this page's cursor; delegate lazily, not in parallel.
    yield* pages(path, query, next);
  }
  return {
    retrieve: (resource, id) => get(`${resource}/${encodeURIComponent(id)}`),
    subscriptions: async (customer) => {
      const result: unknown[] = [];
      for await (const subscription of pages("subscriptions", {
        ...(customer ? { customer } : {}),
        status: "all",
      }))
        result.push(subscription);
      return result;
    },
    events: (from, to) =>
      pages("events", { "created[gte]": String(from), "created[lt]": String(to) }),
  };
}
