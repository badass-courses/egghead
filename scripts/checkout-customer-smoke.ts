import assert from "node:assert/strict";
import {
  CheckoutCustomerRefusedError,
  getCheckoutCustomer,
} from "../apps/web/src/subscriptions/checkout-customer";

type Input = Parameters<typeof getCheckoutCustomer>[0];
type Mapping = Awaited<ReturnType<Input["adapter"]["getMerchantCustomerForUserId"]>>;
const user = { id: "synthetic-user", email: "account@example.invalid" };
let mapping: Mapping = null;
let created = 0;
let updates = 0;
const createdMetadata: Array<Record<string, string>> = [];
let customer: {
  id: string;
  email: string;
  livemode: boolean;
  metadata: Record<string, string>;
} = {
  id: "synthetic-customer",
  email: user.email,
  livemode: false,
  metadata: { userId: user.id },
};
const input: Input = {
  user,
  merchantAccountId: "synthetic-merchant",
  live: false,
  adapter: {
    getMerchantCustomerForUserId: async () => mapping,
    createMerchantCustomer: async (data) => {
      mapping = { ...data, id: "synthetic-mapping", status: 1, createdAt: null };
      return mapping;
    },
  },
  customers: {
    create: async (data) => {
      created++;
      assert.equal(data.email, user.email);
      createdMetadata.push(data.metadata);
      // Stripe returns the metadata it was created with.
      customer = { ...customer, metadata: data.metadata };
      return customer;
    },
    retrieve: async () => customer,
    update: async (_id, data) => {
      updates++;
      customer = { ...customer, email: data.email };
      return customer;
    },
  },
};
assert.equal(await getCheckoutCustomer(input), customer.id);
assert.equal(created, 1);
// A customer checkout creates is CourseBuilder-born (ADR-0001 §11.1).
assert.deepEqual(createdMetadata, [
  {
    userId: user.id,
    egghead_owner: "cb",
    egghead_owner_timeline: "cb@0",
    egghead_owner_generation: "1",
  },
]);
assert.equal(await getCheckoutCustomer(input), customer.id);
assert.equal(created, 1);
customer.email = "old@example.invalid";
await getCheckoutCustomer(input);
assert.equal(updates, 1);
assert.equal(customer.email, user.email);
await assert.rejects(getCheckoutCustomer({ ...input, user: { ...user, email: "" } }));
await assert.rejects(getCheckoutCustomer({ ...input, merchantAccountId: "another-merchant" }));
await assert.rejects(getCheckoutCustomer({ ...input, live: true }));
// A reused customer must be CourseBuilder's now and after every scheduled flip.
const bornMetadata = { ...customer.metadata };
const refusedFor = async (metadata: Record<string, string>) => {
  customer = { ...customer, metadata: { userId: user.id, ...metadata } };
  const error = await getCheckoutCustomer({ ...input, now: 2_000 }).then(
    () => null,
    (caught: unknown) => caught,
  );
  return error instanceof CheckoutCustomerRefusedError ? error.reason : "accepted";
};
assert.equal(await refusedFor({}), "customer_owned_by_rails", "no marker is a Rails customer");
assert.equal(
  await refusedFor({ egghead_owner: "rails", egghead_owner_timeline: "rails@0" }),
  "customer_owned_by_rails",
);
assert.equal(
  await refusedFor({ egghead_owner: "rails", egghead_owner_timeline: "cb@0;rails@3000" }),
  "customer_owned_by_rails",
  "a flip away from CB is scheduled",
);
assert.equal(
  await refusedFor({ egghead_owner: "cb", egghead_owner_timeline: "rails@0;cb@3000" }),
  "customer_flip_scheduled",
  "CB does not own it yet",
);
assert.equal(await refusedFor({ egghead_owner: "cb" }), "marker_unrecognized");
assert.equal(
  await refusedFor({ egghead_owner: "cb", egghead_owner_timeline: "rails@0;cb@1000" }),
  "accepted",
  "handed over before now",
);
customer = { ...customer, metadata: bornMetadata };
customer.metadata = { ...customer.metadata, userId: "another-user" };
await assert.rejects(getCheckoutCustomer(input));
assert.equal(updates, 1);
console.log(
  "Checkout customer checks passed: CB-born create, reuse only of CB-owned customers, account email synchronization, missing email and ownership/mode rejection. No network calls.",
);
