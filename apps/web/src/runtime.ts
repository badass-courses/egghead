import { getEnv } from "./env";

export type EggheadRuntime = "beta" | "local" | "production";

export function getEggheadRuntime(): EggheadRuntime {
  const rawRuntime = getEnv("EGGHEAD_RUNTIME")?.trim().toLowerCase();
  // Use platform-owned project metadata, not a second mutable runtime flag.
  const isBetaProject =
    process.env["VERCEL_PROJECT_NAME"] === "beta-egghead" ||
    process.env["VERCEL_PROJECT_PRODUCTION_URL"] === "beta.egghead.io";
  const onVercel =
    process.env["VERCEL"] === "1" || process.env["VERCEL_ENV"] !== undefined || isBetaProject;

  if (!rawRuntime) {
    if (onVercel) throw new Error("EGGHEAD_RUNTIME is required on Vercel");
    return "local";
  }
  if (rawRuntime !== "local" && rawRuntime !== "beta" && rawRuntime !== "production") {
    throw new Error("Unsupported EGGHEAD_RUNTIME");
  }
  if (isBetaProject && rawRuntime !== "beta") {
    throw new Error("The beta Vercel project requires EGGHEAD_RUNTIME=beta");
  }
  return rawRuntime;
}

/** Beta is a reader. The signed Stripe shadow route uses its own isolated store. */
export function isReadOnlyBeta() {
  return getEggheadRuntime() === "beta";
}
