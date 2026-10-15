import { inngest } from "./client";
import { stripeWorkshopLocalPurchase } from "./stripe-workshop-local";
import { localWorkshopPurchasesEnabled } from "../workshops/checkout-contract";
import {
  stripeCustomerSubscriptionUpdated,
  stripeSubscriptionCheckoutSessionComplete,
} from "./stripe-subscription";

export const inngestConfig = {
  client: inngest,
  functions: [
    stripeSubscriptionCheckoutSessionComplete,
    stripeCustomerSubscriptionUpdated,
    ...(localWorkshopPurchasesEnabled() ? [stripeWorkshopLocalPurchase] : []),
  ],
};
