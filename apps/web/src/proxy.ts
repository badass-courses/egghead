import { NextResponse, type NextRequest } from "next/server";

import { retiredMemberFeed } from "./feeds/retired";
import { RAILS_HOST, railsHostRoute } from "./routing/rails-host";

const PRIVATE_HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

export function proxy(request: NextRequest) {
  // Use Host, not a client-supplied X-Forwarded-Host. This must match the host
  // condition in next.config.ts; platform ingress must preserve Host.
  if (request.headers.get("host")?.split(":", 1)[0]?.toLowerCase() !== RAILS_HOST) {
    return NextResponse.next();
  }

  const route = railsHostRoute(request.nextUrl.pathname);
  const isHead = request.method === "HEAD";
  if (route.kind === "retire") {
    if (route.reason === "member-feed") return retiredMemberFeed();
    const message =
      route.reason === "magic-link"
        ? "This sign-in link no longer works. Request a new link at https://egghead.io/login.\n"
        : "This legacy egghead endpoint is gone.\n";
    return new Response(isHead ? null : message, { status: 410, headers: PRIVATE_HEADERS });
  }
  if (route.kind === "unmapped") {
    return new Response(null, { status: 404, headers: PRIVATE_HEADERS });
  }
  if (request.method !== "GET" && !isHead) {
    return new Response(null, {
      status: 405,
      headers: { ...PRIVATE_HEADERS, allow: "GET, HEAD" },
    });
  }
  if (route.kind === "redirect") {
    return NextResponse.redirect(route.location, { status: 301, headers: PRIVATE_HEADERS });
  }
  return route.path === request.nextUrl.pathname
    ? NextResponse.next()
    : NextResponse.rewrite(new URL(route.path, request.url));
}

export const config = {
  matcher: [{ source: "/:path*", has: [{ type: "host", value: "app\\.egghead\\.io" }] }],
};
