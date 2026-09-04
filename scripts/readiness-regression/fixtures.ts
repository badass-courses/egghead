import { createRequire } from "node:module";
import { Socket } from "node:net";
import { realpathSync } from "node:fs";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";

export const applicationRoot = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
export const appRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));

export function appModule(relative: string) {
  return fileURLToPath(new URL(`../../apps/web/src/${relative}`, import.meta.url));
}

// The runner enables Node's parent-URL resolution so conditional exports use the app's dependencies.
export function appImport(specifier: string) {
  return import.meta.resolve(
    specifier,
    new URL("../../apps/web/package.json", import.meta.url).href,
  );
}

const environmentDefaults: Record<string, string | undefined> = {
  NODE_ENV: "test",
  AUTH_SECRET: "regression-fixture-signing-secret-not-for-real-accounts",
  EGGHEAD_RUNTIME: "local",
  DATABASE_URL: "mysql://root:root@127.0.0.1:3307/coursebuilder_test",
  EGGHEAD_BETA_DB_APPROVED: "false",
  EGGHEAD_BETA_ACCOUNT_WRITES_APPROVED: "false",
  EGGHEAD_BETA_PROGRESS_WRITES_APPROVED: "false",
  NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3008",
  COURSEBUILDER_APP_URL: "http://127.0.0.1:3008",
  COURSEBUILDER_URL: "http://127.0.0.1:3008",
  URL: undefined,
  GITHUB_CLIENT_ID: undefined,
  GITHUB_CLIENT_SECRET: undefined,
  STRIPE_SECRET_TOKEN: "sk_test_regression_fixture",
  STRIPE_WEBHOOK_SECRET: "whsec_regression_fixture",
  INNGEST_EVENT_KEY: undefined,
  INNGEST_SIGNING_KEY: undefined,
  SEND_EMAILS: "false",
  POSTMARK_API_KEY: undefined,
  POSTMARK_FROM_EMAIL: undefined,
};

export function resetRuntimeEnvironment(overrides: Record<string, string | undefined> = {}) {
  for (const [key, value] of Object.entries({ ...environmentDefaults, ...overrides })) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

resetRuntimeEnvironment();

mock.method(Socket.prototype, "connect", () => {
  throw new Error("REGRESSION_FIXTURE_NETWORK: unexpected real socket connection");
});
mock.method(globalThis, "fetch", () => {
  throw new Error("REGRESSION_FIXTURE_NETWORK: unexpected real fetch request");
});
