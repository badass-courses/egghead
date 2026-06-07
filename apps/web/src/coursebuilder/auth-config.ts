import type { AuthConfig } from "@auth/core";

export const authConfig = {
  providers: [],
  secret: process.env.AUTH_SECRET ?? "local-dev-only-egghead-phase-0",
  trustHost: true,
} satisfies AuthConfig;
