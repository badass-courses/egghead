import type { RetiredRoute } from "./legacy-redirects";

const RETIRED_CACHE_CONTROL = "public, max-age=3600, s-maxage=86400";

// Customers see this page; the internal reason stays in the route table and
// the x-egghead-retired-route header.
const RETIRED_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>This page is gone | egghead</title>
</head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem;">
<h1>This page is gone</h1>
<p>We retired this page when egghead moved to its new home. Your courses, lessons and progress are still here.</p>
<p><a href="/">egghead home</a> &middot; <a href="/q">Search</a> &middot; <a href="/profile">Your profile</a></p>
</body>
</html>
`;

// 410 tells browsers and crawlers the URL was retired on purpose. An unknown
// rule id is a plain 404: only ids from the retired table may answer 410.
export function retiredRouteResponse(route: RetiredRoute | undefined) {
  if (!route) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const headers = { "cache-control": RETIRED_CACHE_CONTROL, "x-egghead-retired-route": route.id };

  if (route.kind === "api") {
    return Response.json({ error: "gone", reason: route.reason }, { status: 410, headers });
  }

  return new Response(RETIRED_PAGE_HTML, {
    status: 410,
    headers: { ...headers, "content-type": "text/html; charset=utf-8" },
  });
}
