type EnvKey =
  | "AUTH_SECRET"
  | "COURSEBUILDER_APP_URL"
  | "COURSEBUILDER_URL"
  | "DATABASE_URL"
  | "NEXT_PUBLIC_APP_URL"
  | "URL";

export function getEnv(name: EnvKey) {
  return process.env[name];
}
