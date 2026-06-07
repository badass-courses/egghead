export function getBaseUrl(request: Request) {
  const configured =
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.COURSEBUILDER_APP_URL ??
    process.env.URL;

  if (configured) return configured.replace(/\/$/, "");

  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}
