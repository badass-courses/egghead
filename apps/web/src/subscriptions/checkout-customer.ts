import { createHash } from "node:crypto";
import type { MerchantPort } from "@coursebuilder/core/ports/merchant";
import { z } from "zod";

type Customer = {
  id: string;
  email: string | null;
  livemode: boolean;
  metadata: Record<string, string>;
  deleted?: void;
};
type Customers = {
  retrieve(id: string): Promise<Customer | { id: string; deleted: true }>;
  create(
    input: { email: string; metadata: { userId: string } },
    options: { idempotencyKey: string },
  ): Promise<Customer>;
  update(id: string, input: { email: string }): Promise<Customer>;
};

/** Stripe locks the email only when Checkout receives an existing Customer with an email. */
export async function getCheckoutCustomer(input: {
  user: { id: string; email: string };
  merchantAccountId: string;
  live: boolean;
  adapter: Pick<MerchantPort, "getMerchantCustomerForUserId" | "createMerchantCustomer">;
  customers: Customers;
}) {
  const { user, merchantAccountId, live, adapter, customers } = input;
  const email = z.email().parse(user.email);
  const mapping = await adapter.getMerchantCustomerForUserId(user.id);
  if (
    mapping &&
    (mapping.userId !== user.id ||
      mapping.merchantAccountId !== merchantAccountId ||
      mapping.status !== 1)
  )
    throw new Error("The account's Stripe customer mapping does not match this checkout");
  const key = createHash("sha256")
    .update(JSON.stringify([merchantAccountId, live, user.id, email]))
    .digest("hex");
  let customer = mapping
    ? await customers.retrieve(mapping.identifier)
    : await customers.create(
        { email, metadata: { userId: user.id } },
        { idempotencyKey: `membership-customer-${key}` },
      );
  if (
    customer.deleted ||
    customer.livemode !== live ||
    (customer.metadata["userId"] && customer.metadata["userId"] !== user.id)
  )
    throw new Error("Stripe customer does not belong to this account and mode");
  if (customer.email !== email) customer = await customers.update(customer.id, { email });
  if (customer.email !== email) throw new Error("Could not bind checkout to the account email");
  if (!mapping) {
    try {
      const saved = await adapter.createMerchantCustomer({
        userId: user.id,
        merchantAccountId,
        identifier: customer.id,
      });
      if (
        !saved ||
        saved.userId !== user.id ||
        saved.identifier !== customer.id ||
        saved.merchantAccountId !== merchantAccountId
      )
        throw new Error("Could not save the account's Stripe customer");
    } catch (error) {
      // Concurrent checkout requests can create the same idempotent Stripe customer.
      const saved = await adapter.getMerchantCustomerForUserId(user.id);
      if (
        !saved ||
        saved.status !== 1 ||
        saved.identifier !== customer.id ||
        saved.merchantAccountId !== merchantAccountId
      )
        throw error;
    }
  }
  return customer.id;
}
