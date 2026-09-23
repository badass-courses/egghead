import type { EggheadRuntime } from "../db/local-docker";
import { getEggheadRuntime } from "../db/local-docker";
import { getEnv } from "../env";

const LOCAL_AUTH_SECRET = "local-dev-only-egghead-phase-0";

export function resolveAuthSecret(secret: string | undefined, runtime: EggheadRuntime) {
  if (secret) return secret;
  return runtime === "local" ? LOCAL_AUTH_SECRET : undefined;
}

export function getAuthSecret() {
  return resolveAuthSecret(getEnv("AUTH_SECRET"), getEggheadRuntime());
}

export function requireAuthSecret() {
  const secret = getAuthSecret();
  if (!secret) {
    throw new Error("AUTH_SECRET is required outside the local runtime.");
  }
  return secret;
}
