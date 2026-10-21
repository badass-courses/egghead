import { StripePaymentAdapter } from "@coursebuilder/commerce/stripe-provider";
import { getStripeProvider } from "../coursebuilder/stripe-provider";
import { getEnv } from "../env";
import { localWorkshopPurchasesEnabled } from "./checkout-contract";

export function getWorkshopPayments() {
  if (!localWorkshopPurchasesEnabled()) return null;
  const token = getEnv("STRIPE_SECRET_TOKEN") ?? "";
  if (!token.startsWith("sk_test_") && !token.startsWith("rk_test_")) return null;
  const provider = getStripeProvider();
  if (!provider || !(provider.options.paymentsAdapter instanceof StripePaymentAdapter)) return null;
  return { provider, payments: provider.options.paymentsAdapter, live: false };
}

export function workshopCheckoutOrigin(configured: string, origin: string | null, runtime: string) {
  const url = new URL(configured);
  if (runtime === "local" && origin) {
    const request = new URL(origin);
    if (
      request.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(request.hostname) &&
      request.port === url.port
    )
      return request.origin;
  }
  if (runtime !== "production" || url.protocol !== "https:" || origin !== url.origin)
    throw new Error("Invalid Workshop checkout origin");
  return url.origin;
}
