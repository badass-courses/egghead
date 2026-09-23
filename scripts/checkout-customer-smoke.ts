import assert from "node:assert/strict";
import { getCheckoutCustomer } from "../apps/web/src/subscriptions/checkout-customer";

type Input = Parameters<typeof getCheckoutCustomer>[0];
type Mapping = Awaited<ReturnType<Input["adapter"]["getMerchantCustomerForUserId"]>>;
const user = { id: "synthetic-user", email: "account@example.invalid" };
let mapping: Mapping = null;
let created = 0;
let updates = 0;
let customer = {
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
assert.equal(await getCheckoutCustomer(input), customer.id);
assert.equal(created, 1);
customer.email = "old@example.invalid";
await getCheckoutCustomer(input);
assert.equal(updates, 1);
assert.equal(customer.email, user.email);
await assert.rejects(getCheckoutCustomer({ ...input, user: { ...user, email: "" } }));
await assert.rejects(getCheckoutCustomer({ ...input, merchantAccountId: "another-merchant" }));
await assert.rejects(getCheckoutCustomer({ ...input, live: true }));
customer.metadata.userId = "another-user";
await assert.rejects(getCheckoutCustomer(input));
assert.equal(updates, 1);
console.log(
  "Checkout customer checks passed: create/reuse, account email synchronization, missing email and ownership/mode rejection. No network calls.",
);
