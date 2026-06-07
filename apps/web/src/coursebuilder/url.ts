import { getEnv } from "../env";

const TRAILING_SLASH = /\/$/;

export function getBaseUrl(request: Request) {
  const configured =
    getEnv("NEXT_PUBLIC_APP_URL") ?? getEnv("COURSEBUILDER_APP_URL") ?? getEnv("URL");

  if (configured) {
    return configured.replace(TRAILING_SLASH, "");
  }

  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}
