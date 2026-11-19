import { createHash } from "node:crypto";
import type { MerchantPort } from "@coursebuilder/core/ports/merchant";
import { z } from "zod";
import { FixedMessageError } from "./alerts";
import { cbBornCustomerMetadata, readOwnerMarker } from "./ownership/marker";
import { checkoutCustomerDecision } from "./ownership/routing";

type RefusalReason = "customer_owned_by_rails" | "customer_flip_scheduled" | "marker_unrecognized";

/**
 * Checkout on a Stripe customer CourseBuilder does not own now and after every
 * scheduled flip (ADR-0001 §11). The buyer is told their billing lives elsewhere.
 */
export class CheckoutCustomerRefusedError extends FixedMessageError {
  readonly reason: RefusalReason;
  constructor(reason: RefusalReason) {
    super(`Checkout refused for this Stripe customer: ${reason}`);
    this.name = "CheckoutCustomerRefusedError";
    this.reason = reason;
  }
}

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
    input: { email: string; metadata: Record<string, string> },
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
  /** Epoch seconds; defaults to now. */
  now?: number;
}) {
  const { user, merchantAccountId, live, adapter, customers } = input;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const email = z.email().parse(user.email);
  const mapping = await adapter.getMerchantCustomerForUserId(user.id);
  if (
    mapping &&
    (mapping.userId !== user.id ||
      mapping.merchantAccountId !== merchantAccountId ||
      mapping.status !== 1)
  )
    throw new FixedMessageError(
      "The account's Stripe customer mapping does not match this checkout",
    );
  const key = createHash("sha256")
    .update(JSON.stringify([merchantAccountId, live, user.id, email]))
    .digest("hex");
  let customer = mapping
    ? await customers.retrieve(mapping.identifier)
    : await customers.create(
        // A customer CourseBuilder creates is CourseBuilder's from the start (cb@0).
        { email, metadata: { userId: user.id, ...cbBornCustomerMetadata() } },
        { idempotencyKey: `membership-customer-${key}-cb-born` },
      );
  if (
    customer.deleted ||
    customer.livemode !== live ||
    (customer.metadata["userId"] && customer.metadata["userId"] !== user.id)
  )
    throw new FixedMessageError("Stripe customer does not belong to this account and mode");
  // Reused or just created, the customer must be CourseBuilder's now and after
  // every scheduled flip; a Rails customer is moved by a batch, never by checkout.
  const decision = checkoutCustomerDecision({
    customerMarker: readOwnerMarker(customer.metadata),
    now,
  });
  if (decision.action === "refuse") throw new CheckoutCustomerRefusedError(decision.reason);
  if (customer.email !== email) customer = await customers.update(customer.id, { email });
  if (customer.email !== email)
    throw new FixedMessageError("Could not bind checkout to the account email");
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
        throw new FixedMessageError("Could not save the account's Stripe customer");
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
