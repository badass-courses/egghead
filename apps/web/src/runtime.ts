import { getEnv } from "./env";

export type EggheadRuntime = "beta" | "local" | "production";

function isBetaVercelProject() {
  // Use platform-owned project metadata, not a second mutable runtime flag.
  return (
    process.env["VERCEL_PROJECT_NAME"] === "beta-egghead" ||
    process.env["VERCEL_PROJECT_PRODUCTION_URL"] === "beta.egghead.io"
  );
}

function isVercel() {
  return (
    process.env["VERCEL"] === "1" ||
    process.env["VERCEL_ENV"] !== undefined ||
    isBetaVercelProject()
  );
}

export function getEggheadRuntime(): EggheadRuntime {
  const rawRuntime = getEnv("EGGHEAD_RUNTIME")?.trim().toLowerCase();
  if (!rawRuntime) return isVercel() ? "beta" : "local";
  if (rawRuntime !== "local" && rawRuntime !== "beta" && rawRuntime !== "production") {
    throw new Error("Unsupported EGGHEAD_RUNTIME");
  }
  if (rawRuntime === "production" && isBetaVercelProject()) {
    throw new Error("The beta Vercel project cannot use production runtime");
  }
  return rawRuntime;
}

/** Vercel local may use local fixture settings, but cannot enable side effects. */
export function isReadOnlyBeta() {
  const runtime = getEggheadRuntime();
  return runtime === "beta" || (runtime === "local" && isVercel());
}
