import type { EggheadRuntime } from "../db/local-docker";

type EmailAuthConfiguration = {
  deliveryEnabled: boolean;
  postmarkApiKey: string | undefined;
  postmarkFromEmail: string | undefined;
  runtime: EggheadRuntime;
};

export function isEmailAuthEnabled({
  deliveryEnabled,
  postmarkApiKey,
  postmarkFromEmail,
  runtime,
}: EmailAuthConfiguration) {
  const postmarkConfigured = Boolean(postmarkApiKey && postmarkFromEmail);

  if (runtime === "local") return !deliveryEnabled || postmarkConfigured;

  return runtime === "beta" && deliveryEnabled && postmarkConfigured;
}
