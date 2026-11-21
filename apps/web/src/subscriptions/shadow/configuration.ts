import { createRedisShadowStore } from "./store";
import { createShadowStripeReader } from "./stripe-reader";
import type { ShadowDependencies } from "./handler";

/** No app DB, writer credentials, payment adapter, Inngest client or mailer. */
export function shadowDependencies(
  env: Readonly<Record<string, string | undefined>>,
): ShadowDependencies {
  const key = env["STRIPE_SHADOW_READ_KEY"];
  const url = env["STRIPE_SHADOW_REDIS_REST_URL"];
  const token = env["STRIPE_SHADOW_REDIS_REST_TOKEN"];
  if (!key?.startsWith("rk_") || !url || !token)
    throw new Error("Shadow is not configured with isolated credentials");
  return {
    stripe: createShadowStripeReader(key),
    store: createRedisShadowStore(url, token),
    log: (record) => console.info(JSON.stringify(record)),
  };
}
