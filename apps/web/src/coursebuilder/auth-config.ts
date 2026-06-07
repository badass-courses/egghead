import type { AuthConfig } from "@auth/core";
import { getEnv } from "../env";

export const authConfig = {
  providers: [],
  secret: getEnv("AUTH_SECRET") ?? "local-dev-only-egghead-phase-0",
  trustHost: true,
} satisfies AuthConfig;
