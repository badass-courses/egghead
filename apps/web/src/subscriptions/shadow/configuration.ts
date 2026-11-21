import { createMysqlShadowStore } from "./mysql-store";
import { createShadowStripeReader } from "./stripe-reader";
import type { ShadowDependencies } from "./handler";

/** No app DB, writer credentials, payment adapter, Inngest client or mailer. */
export function shadowDependencies(
  env: Readonly<Record<string, string | undefined>>,
): ShadowDependencies {
  const key = env["STRIPE_SHADOW_READ_KEY"];
  const url = env["STRIPE_SHADOW_DATABASE_URL"];
  if (!key?.startsWith("rk_") || !url)
    throw new Error("Shadow is not configured with isolated credentials");
  return {
    stripe: createShadowStripeReader(key),
    store: createMysqlShadowStore(url, { appDatabaseUrl: env["DATABASE_URL"] }),
    log: (record) => console.info(JSON.stringify(record)),
  };
}
