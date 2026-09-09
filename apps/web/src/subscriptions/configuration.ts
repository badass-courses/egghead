type MembershipEnvironment = Record<string, string | undefined>;

/** The explicit local preview is separate from normal test/live Stripe configuration. */
export function membershipConfiguration(env: MembershipEnvironment) {
  const localPreview =
    env["EGGHEAD_LOCAL_MEMBERSHIP"] === "true" &&
    env["NODE_ENV"] !== "production" &&
    (env["EGGHEAD_RUNTIME"] ?? "local") === "local";
  const token = env["STRIPE_SECRET_TOKEN"];
  const productId = localPreview
    ? "local-multiple-price-membership"
    : env["EGGHEAD_SUBSCRIPTION_PRODUCT_ID"]?.trim();
  if (!token || !productId) return null;
  const live = token.startsWith("sk_live_") || token.startsWith("rk_live_");
  const test = token.startsWith("sk_test_") || token.startsWith("rk_test_");
  if (!live && !test) throw new Error("A Stripe secret or restricted key is required");
  if (localPreview && !test) throw new Error("Local membership preview requires a Stripe test key");
  return { productId, token, live, localPreview };
}

export function membershipCheckoutOrigin(
  configuredUrl: string | undefined,
  requestOrigin: string | null,
  localPreview: boolean,
) {
  if (localPreview) {
    if (requestOrigin === "http://localhost:3008" || requestOrigin === "http://127.0.0.1:3008")
      return requestOrigin;
    throw new Error("Invalid local checkout origin");
  }
  if (!configuredUrl) throw new Error("NEXT_PUBLIC_APP_URL is required for membership checkout");
  const url = new URL(configuredUrl);
  if (url.protocol !== "https:" || url.origin !== requestOrigin)
    throw new Error("Invalid checkout origin");
  return url.origin;
}
