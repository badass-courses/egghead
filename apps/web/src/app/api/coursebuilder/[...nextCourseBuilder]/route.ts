import { handlers } from "../../../../coursebuilder/config";
import { NextRequest } from "next/server";
import { isWorkshopProduct } from "../../../../workshops/catalog";
import { getWorkshopPayments } from "../../../../workshops/payments";
import { getEnv } from "../../../../env";
import { checkoutSessionCompletedEvent } from "@coursebuilder/core/schemas/stripe/checkout-session-completed";
import { STRIPE_CHECKOUT_SESSION_COMPLETED_EVENT } from "@coursebuilder/core/events/stripe";
import { inngest } from "../../../../inngest/client";
import { localWorkshopPurchasesEnabled } from "../../../../workshops/checkout-contract";

async function workshopCheckoutBypass(request: NextRequest) {
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/checkout/stripe")) return false;
  const productIds = url.searchParams.getAll("productId");
  const productId = productIds[0];
  if (productIds.length !== 1 || !productId) return true;
  return isWorkshopProduct(productId);
}
export async function GET(request: NextRequest) {
  if (await workshopCheckoutBypass(request))
    return Response.json({ error: "Use the Workshop landing page to purchase" }, { status: 403 });
  return handlers.GET(request);
}
export async function POST(request: NextRequest) {
  if (await workshopCheckoutBypass(request))
    return Response.json({ error: "Use the Workshop landing page to purchase" }, { status: 403 });
  if (
    localWorkshopPurchasesEnabled() &&
    new URL(request.url).pathname.endsWith("/webhook/stripe")
  ) {
    const services = getWorkshopPayments();
    const signature = request.headers.get("stripe-signature");
    const secret = getEnv("STRIPE_WEBHOOK_SECRET");
    if (services && signature && secret) {
      const payload = await request.clone().text();
      const event = (() => {
        try {
          return services.payments.stripe.webhooks.constructEvent(payload, signature, secret);
        } catch {
          return null;
        }
      })();
      if (!event) return Response.json({ error: "Invalid Stripe signature" }, { status: 400 });
      if (
        event.type === "checkout.session.async_payment_succeeded" &&
        event.data.object.metadata?.["workshopId"] &&
        !event.livemode
      ) {
        const stripeEvent = checkoutSessionCompletedEvent.parse({
          ...event,
          type: "checkout.session.completed",
        });
        await inngest.send({
          name: STRIPE_CHECKOUT_SESSION_COMPLETED_EVENT,
          data: { stripeEvent },
        });
        return Response.json({ received: true });
      }
    }
  }
  return handlers.POST(request);
}
