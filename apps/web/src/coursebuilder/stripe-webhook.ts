import type { CourseBuilderCoreEvents } from "@coursebuilder/core/inngest";
import { checkoutSessionCompletedEvent } from "@coursebuilder/core/schemas/stripe/checkout-session-completed";
import { customerSubscriptionUpdatedEvent } from "@coursebuilder/core/schemas/stripe/customer-subscription-updated";
import { z } from "zod";

import { assertCommerceWritesAllowed } from "../db/local-docker";
import { inngest } from "../inngest/client";
import { getStripeProvider } from "./stripe-provider";

const eventSchema = z
  .object({
    id: z.string().min(1),
    created: z.number().int(),
    livemode: z.boolean(),
    type: z.string(),
    data: z.object({ object: z.object({ id: z.string().min(1) }).passthrough() }).passthrough(),
  })
  .passthrough();

const invoiceSubscriptionSchema = z.union([
  z.string().min(1),
  z.object({ id: z.string().min(1) }).transform((value) => value.id),
]);

export type ForwardedStripeEvent =
  | ({
      id: string;
      name: "stripe/checkout-session-completed";
    } & CourseBuilderCoreEvents["stripe/checkout-session-completed"])
  | ({
      id: string;
      name: "stripe/customer-subscription-updated";
    } & CourseBuilderCoreEvents["stripe/customer-subscription-updated"])
  | {
      id: string;
      name: "stripe/invoice-paid";
      data: {
        stripeEvent: {
          id: string;
          created: number;
          type: "invoice.paid";
          data: { object: { id: string; subscription: string } };
        };
      };
    }
  | {
      id: string;
      name: "stripe/customer-subscription-deleted";
      data: {
        stripeEvent: {
          id: string;
          created: number;
          type: "customer.subscription.deleted";
          data: { object: { id: string } };
        };
      };
    };

type WebhookPublish = (event: ForwardedStripeEvent) => Promise<unknown>;

/** Verify the untouched payload before parsing or dispatch. Only publication is injectable. */
export async function handleStripeWebhook(
  request: Request,
  publish: WebhookPublish = (event) => inngest.send(event),
): Promise<Response> {
  try {
    assertCommerceWritesAllowed();
  } catch {
    return Response.json({ error: "Stripe webhook writes are blocked." }, { status: 403 });
  }
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const signature = request.headers.get("stripe-signature");
  if (!signature) return Response.json({ error: "Stripe signature required." }, { status: 400 });

  const body = await request.text();
  let event: z.infer<typeof eventSchema>;
  try {
    const provider = getStripeProvider();
    if (!provider) return Response.json({ error: "Stripe is not configured." }, { status: 503 });
    // Published core 2.0.2 omits await here and accepts an absent signature.
    // The genuine provider verifier constructs the Stripe event and verifies its timestamp/HMAC.
    if (!(await provider.options.paymentsAdapter.verifyWebhookSignature(body, signature))) {
      return Response.json({ error: "Invalid Stripe signature." }, { status: 400 });
    }
    event = eventSchema.parse(JSON.parse(body));
  } catch {
    return Response.json({ error: "Invalid Stripe webhook." }, { status: 400 });
  }
  if (event.livemode)
    return Response.json({ error: "Live Stripe events are blocked." }, { status: 403 });

  let forwarded: ForwardedStripeEvent;
  try {
    switch (event.type) {
      case "checkout.session.completed":
        forwarded = {
          id: event.id,
          name: "stripe/checkout-session-completed",
          data: { txnId: event.id, stripeEvent: checkoutSessionCompletedEvent.parse(event) },
        };
        break;
      case "customer.subscription.updated":
        forwarded = {
          id: event.id,
          name: "stripe/customer-subscription-updated",
          data: { stripeEvent: customerSubscriptionUpdatedEvent.parse(event) },
        };
        break;
      case "customer.subscription.deleted":
        forwarded = {
          id: event.id,
          name: "stripe/customer-subscription-deleted",
          data: {
            stripeEvent: {
              id: event.id,
              created: event.created,
              type: "customer.subscription.deleted",
              data: { object: { id: event.data.object.id } },
            },
          },
        };
        break;
      case "invoice.paid": {
        const reference = event.data.object["subscription"];
        if (reference === null || reference === undefined) {
          return Response.json({ received: true, ignored: true });
        }
        const subscription = invoiceSubscriptionSchema.parse(reference);
        forwarded = {
          id: event.id,
          name: "stripe/invoice-paid",
          data: {
            stripeEvent: {
              id: event.id,
              created: event.created,
              type: "invoice.paid",
              data: { object: { id: event.data.object.id, subscription } },
            },
          },
        };
        break;
      }
      default:
        return Response.json({ received: true, ignored: true });
    }
  } catch {
    return Response.json({ error: "Invalid Stripe event payload." }, { status: 400 });
  }
  try {
    await publish(forwarded);
    console.info("Verified Stripe webhook dispatched", { eventType: event.type });
    return Response.json({ received: true });
  } catch {
    console.error("Verified Stripe webhook dispatch failed", { eventType: event.type });
    return Response.json({ error: "Stripe event dispatch failed." }, { status: 503 });
  }
}
