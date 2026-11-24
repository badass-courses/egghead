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
  data: z.array(z.unknown()),
  has_more: z.boolean(),
});
const cursorSchema = z.object({ id: z.string().min(1) });

/** Deliberately exposes GET only. Provision a restricted Stripe key with read permissions only. */
export function createShadowStripeReader(
  key: string,
  request: typeof fetch = fetch,
): ShadowStripeReader {
  const get = async (path: string, params = new URLSearchParams()): Promise<unknown> => {
    const response = await request(`https://api.stripe.com/v1/${path}?${params}`, {
      method: "GET",
      redirect: "error",
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
  ): AsyncGenerator<unknown, void, unknown> {
    const params = new URLSearchParams({
      ...query,
      limit: "100",
      ...(after ? { starting_after: after } : {}),
    });
    const page = pageSchema.parse(await get(path, params));
    yield* page.data;
    if (!page.has_more) return;
    const cursor = cursorSchema.safeParse(page.data.at(-1));
    if (!cursor.success || cursor.data.id === after)
      throw new Error("Shadow Stripe pagination made no progress");
    // The next request depends on this page's cursor; delegate lazily, not in parallel.
    yield* pages(path, query, cursor.data.id);
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
