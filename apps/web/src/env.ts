type EnvKey =
  | "AUTH_SECRET"
  | "COURSEBUILDER_APP_URL"
  | "COURSEBUILDER_URL"
  | "DATABASE_URL"
  | "EGGHEAD_BETA_DB_APPROVED"
  | "EGGHEAD_RUNTIME"
  | "NEXT_PUBLIC_APP_URL"
  | "URL";

export function getEnv(name: EnvKey) {
  return process.env[name];
}
