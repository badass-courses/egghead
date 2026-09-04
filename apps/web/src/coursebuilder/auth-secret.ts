import { getEggheadRuntime, type EggheadRuntime } from "../db/local-docker";
import { getEnv } from "../env";

const LOCAL_AUTH_SECRET = "local-dev-only-egghead-phase-0";

export function resolveAuthSecret(input: {
  secret: string | undefined;
  runtime: EggheadRuntime;
  nodeEnv: string | undefined;
}) {
  const localDevelopment =
    input.runtime === "local" && (input.nodeEnv === undefined || input.nodeEnv === "development");

  if (!input.secret && localDevelopment) return LOCAL_AUTH_SECRET;
  if (
    !input.secret ||
    input.secret === LOCAL_AUTH_SECRET ||
    Buffer.byteLength(input.secret.trim(), "utf8") < 32
  ) {
    throw new Error("AUTH_SECRET must be an independently generated secret of at least 32 bytes.");
  }

  return input.secret;
}

export function getAuthSecret() {
  return resolveAuthSecret({
    secret: getEnv("AUTH_SECRET"),
    runtime: getEggheadRuntime(),
    nodeEnv: process.env["NODE_ENV"],
  });
}
