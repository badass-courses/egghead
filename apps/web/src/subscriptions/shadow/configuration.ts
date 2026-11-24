import { createMysqlShadowStore } from "./mysql-store";
import { createShadowStripeReader } from "./stripe-reader";
import type { ShadowDependencies } from "./handler";

/** No app DB, writer credentials, payment adapter, Inngest client or mailer. */
export function shadowDependencies(
  env: Readonly<Record<string, string | undefined>>,
): ShadowDependencies {
  const key = env["STRIPE_SHADOW_READ_KEY"];
  const url = env["STRIPE_SHADOW_DATABASE_URL"];
  const appDatabaseUrl = env["DATABASE_URL"];
  const contentReader = env["STRIPE_SHADOW_CONTENT_READER_USERNAME"];
  const shadowWriter = env["STRIPE_SHADOW_WRITER_USERNAME"];
  if (!key?.startsWith("rk_") || !url || !appDatabaseUrl || !contentReader || !shadowWriter)
    throw new Error("Shadow is not configured with isolated credentials");
  const store = createMysqlShadowStore(url, {
    appDatabaseUrl,
    branchPins: { contentReader, shadowWriter },
  });
  return {
    stripe: createShadowStripeReader(key),
    store,
    log: (record) => console.info(JSON.stringify(record)),
  };
}
