import { getEnv } from "./env";

export type EggheadRuntime = "beta" | "local" | "production";

export function getEggheadRuntime(): EggheadRuntime {
  const rawRuntime = getEnv("EGGHEAD_RUNTIME")?.trim().toLowerCase();
  if (!rawRuntime) return "local";
  if (rawRuntime === "local" || rawRuntime === "beta" || rawRuntime === "production") {
    return rawRuntime;
  }
  throw new Error("Unsupported EGGHEAD_RUNTIME");
}

/** Beta is a reader. The signed Stripe shadow route uses its own isolated store. */
export function isReadOnlyBeta() {
  return getEggheadRuntime() === "beta";
}
