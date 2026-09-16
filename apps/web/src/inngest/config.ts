import { inngest } from "./client";
import {
  stripeCustomerSubscriptionUpdated,
  stripeSubscriptionCheckoutSessionComplete,
} from "./stripe-subscription";

export const inngestConfig = {
  client: inngest,
  functions: [stripeSubscriptionCheckoutSessionComplete, stripeCustomerSubscriptionUpdated],
};
