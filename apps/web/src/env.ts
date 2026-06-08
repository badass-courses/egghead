type EnvKey =
  | "AUTH_SECRET"
  | "COURSEBUILDER_APP_URL"
  | "COURSEBUILDER_URL"
  | "DATABASE_URL"
  | "EGGHEAD_BETA_DB_APPROVED"
  | "EGGHEAD_RUNTIME"
  | "GITHUB_CLIENT_ID"
  | "GITHUB_CLIENT_SECRET"
  | "NEXT_PUBLIC_APP_URL"
  | "URL";

export function getEnv(name: EnvKey) {
  return process.env[name];
}
