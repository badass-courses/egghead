import { commerceFunctions } from "@coursebuilder/commerce/functions";
import { STRIPE_CHECKOUT_SESSION_COMPLETED_EVENT } from "@coursebuilder/core/events/stripe";
import { checkoutSessionCompletedEvent } from "@coursebuilder/core/schemas/stripe/checkout-session-completed";
import { getCourseBuilderAdapter } from "../db/adapter";
import { assertDatabaseUrlForRuntime } from "../db/local-docker";
import { getWorkshopPayments } from "../workshops/payments";
import { inngest } from "./client";

import {
  localWorkshopPurchasesEnabled,
  isVerifiedWorkshopPayment,
} from "../workshops/checkout-contract";

/** Sandbox verification only. This function cannot run against production or beta. */
export const stripeWorkshopLocalPurchase = inngest.createFunction(
  {
    id: "local-workshop-purchase",
    name: "Local Workshop Test Purchase",
    idempotency: "event.data.stripeEvent.data.object.id",
  },
  {
    event: STRIPE_CHECKOUT_SESSION_COMPLETED_EVENT,
    if: "event.data.stripeEvent.data.object.mode == 'payment' && event.data.stripeEvent.data.object.payment_status == 'paid' && event.data.stripeEvent.data.object.metadata.workshopId != null",
  },
  async (context) => {
    if (!localWorkshopPurchasesEnabled() || !assertDatabaseUrlForRuntime().localDockerOnly)
      throw new Error("Local Workshop test purchases only");
    const event = checkoutSessionCompletedEvent.parse(context.event.data.stripeEvent);
    const services = getWorkshopPayments();
    if (!services || services.live) throw new Error("Stripe test mode required");
    const session = await services.payments.getCheckoutSession(event.data.object.id);
    if (!isVerifiedWorkshopPayment(session))
      throw new Error("Workshop test payment is not verified");
    const workflow = commerceFunctions.find(
      (entry) => entry.config.id === "stripe-checkout-session-completed",
    );
    if (!workflow) throw new Error("Published CourseBuilder purchase workflow is unavailable");
    await workflow.handler({
      ...context,
      db: getCourseBuilderAdapter(),
      paymentProvider: services.provider,
    });
    return { fulfilled: true, mode: "local-test" };
  },
);
