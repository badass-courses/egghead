import { inngest } from "./client";
import {
  stripeCustomerSubscriptionLifecycle,
  stripeSubscriptionCheckoutSessionComplete,
} from "./stripe-subscription";

export const inngestConfig = {
  client: inngest,
  functions: [stripeSubscriptionCheckoutSessionComplete, stripeCustomerSubscriptionLifecycle],
};
