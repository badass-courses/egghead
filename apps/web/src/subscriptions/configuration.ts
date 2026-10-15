import type { EggheadRuntime } from "../db/local-docker";

type MembershipEnvironment = Record<string, string | undefined>;

/** The explicit local preview is separate from normal test/live Stripe configuration. */
export function membershipConfiguration(env: MembershipEnvironment) {
  const runtime = (env["EGGHEAD_RUNTIME"] ?? "local").trim().toLowerCase();
  const localPreview =
    env["EGGHEAD_LOCAL_MEMBERSHIP"] === "true" &&
    env["NODE_ENV"] !== "production" &&
    runtime === "local";
  const token = env["STRIPE_SECRET_TOKEN"];
  const webhookSecret = env["STRIPE_WEBHOOK_SECRET"];
  const productId = localPreview
    ? "local-multiple-price-membership"
    : env["EGGHEAD_SUBSCRIPTION_PRODUCT_ID"]?.trim();
  if (!token || (!localPreview && !webhookSecret)) return null;
  if (
    runtime === "production" &&
    (!env["INNGEST_EVENT_KEY"] ||
      !env["INNGEST_SIGNING_KEY"] ||
      !env["NEXT_PUBLIC_APP_URL"] ||
      !URL.canParse(env["NEXT_PUBLIC_APP_URL"]) ||
      new URL(env["NEXT_PUBLIC_APP_URL"]).protocol !== "https:")
  ) {
    return null;
  }
  const live = token.startsWith("sk_live_") || token.startsWith("rk_live_");
  const test = token.startsWith("sk_test_") || token.startsWith("rk_test_");
  if (!live && !test) throw new Error("A Stripe secret or restricted key is required");
  if (localPreview && !token.startsWith("sk_test_"))
    throw new Error("Local membership preview requires a Stripe test secret key");
  return {
    productId,
    token,
    webhookSecret: webhookSecret ?? "local-unused-webhook-secret",
    live,
    localPreview,
  };
}

export function membershipCheckoutOrigin(
  configuredUrl: string | undefined,
  requestOrigin: string | null,
  runtime: EggheadRuntime,
) {
  if (
    runtime === "local" &&
    (requestOrigin === "http://localhost:3008" || requestOrigin === "http://127.0.0.1:3008")
  )
    return requestOrigin;
  if (!configuredUrl) throw new Error("NEXT_PUBLIC_APP_URL is required for membership checkout");
  const url = new URL(configuredUrl);
  if (url.protocol !== "https:" || url.origin !== requestOrigin)
    throw new Error("Invalid checkout origin");
  return url.origin;
}
