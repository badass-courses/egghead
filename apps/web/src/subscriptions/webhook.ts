import { z } from "zod";
import { StripePaymentAdapter } from "@coursebuilder/commerce/stripe-provider";
import { getStripeProvider } from "../coursebuilder/stripe-provider";
import { inngest } from "../inngest/client";
import { SUBSCRIPTION_DELETED_EVENT, subscriptionDeletedEventSchema } from "./webhook-contract";
import { assertMembershipWritesAllowed } from "./write-policy";

export async function dispatchSubscriptionDeletion(
  rawBody: string,
  signature: string,
  boundary: {
    verify(body: string, signature: string): unknown;
    publish(event: {
      name: typeof SUBSCRIPTION_DELETED_EVENT;
      data: { stripeEvent: ReturnType<typeof subscriptionDeletedEventSchema.parse> };
    }): Promise<unknown>;
  },
) {
  const verified = boundary.verify(rawBody, signature);
  if (z.object({ type: z.string() }).parse(verified).type !== "customer.subscription.deleted")
    return false;
  const deletion = subscriptionDeletedEventSchema.parse(verified);
  await boundary.publish({ name: SUBSCRIPTION_DELETED_EVENT, data: { stripeEvent: deletion } });
  return true;
}

export async function handleSubscriptionDeletion(request: Request): Promise<Response | null> {
  if (new URL(request.url).pathname.replace(/\/+$/, "") !== "/api/coursebuilder/webhook/stripe")
    return null;
  assertMembershipWritesAllowed();
  const adapter = getStripeProvider()?.options.paymentsAdapter;
  if (!(adapter instanceof StripePaymentAdapter))
    return new Response("Stripe is not configured", { status: 503 });
  const signature = request.headers.get("stripe-signature");
  if (!signature) return new Response("Missing Stripe signature", { status: 400 });
  const rawBody = await request.clone().text();
  let verified;
  try {
    verified = adapter.stripe.webhooks.constructEvent(rawBody, signature, adapter.webhookSecret);
  } catch {
    return new Response("Invalid Stripe signature", { status: 400 });
  }
  // The published CourseBuilder transport only logs deletions. Other events still
  // use its handler; only verified deletions enter this app-owned subscription seam.
  const dispatched = await dispatchSubscriptionDeletion(rawBody, signature, {
    verify: () => verified,
    publish: (event) => inngest.send(event),
  });
  return dispatched ? Response.json({ received: true }) : null;
}
