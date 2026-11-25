// Edge adapter: bind `lookupPublicTarget` to the privately reviewed corpus.
// Route validation narrows what that corpus can redirect to; it cannot decide
// whether a particular content record or an external page is public.
export type LegacyShortLinkStore = {
  lookupPublicTarget(code: string): Promise<unknown>;
  allowedOffsiteTargets?: ReadonlySet<string>;
};

const SHORT_LINK_PATH = /^\/s\/([^/]+)\/?$/;
const SHORT_CODE = /^[a-z0-9]{1,32}$/;
const PUBLIC_EGGHEAD_PATH =
  /^\/(?:|courses|lessons|blog|podcasts|talks|(?:courses|playlists|lessons|blog|podcasts|talks)\/[a-z0-9][a-z0-9_~-]*)$/;
const HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

export function legacyShortLinkGone() {
  return new Response(null, { status: 410, headers: HEADERS });
}

export function isLegacyShortLinkPath(path: string): boolean {
  return SHORT_LINK_PATH.test(path);
}

function safeTarget(value: unknown, allowedOffsiteTargets?: ReadonlySet<string>): string | null {
  if (typeof value !== "string" || !/^https?:\/\//.test(value) || /[?#\s\\]/.test(value)) {
    return null;
  }
  const url = URL.parse(value);
  if (!url || url.username || url.password || url.port) return null;
  if (url.hostname === "egghead.io" || url.hostname === "app.egghead.io") {
    const path = url.pathname.replace(/\/$/, "") || "/";
    return PUBLIC_EGGHEAD_PATH.test(path) ? `https://egghead.io${path}` : null;
  }
  return url.protocol === "https:" && allowedOffsiteTargets?.has(url.href) ? url.href : null;
}

/** An edge route for app.egghead.io. Return undefined to pass unrelated requests on. */
export async function serveLegacyShortLink(
  request: Request,
  store: LegacyShortLinkStore,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.hostname !== "app.egghead.io") return undefined;
  const code = SHORT_LINK_PATH.exec(url.pathname)?.[1];
  if (!code) return undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { ...HEADERS, allow: "GET, HEAD" } });
  }
  if (!SHORT_CODE.test(code)) return legacyShortLinkGone();
  try {
    const target = safeTarget(await store.lookupPublicTarget(code), store.allowedOffsiteTargets);
    return target
      ? new Response(null, { status: 301, headers: { ...HEADERS, location: target } })
      : legacyShortLinkGone();
  } catch {
    // A store outage isn't a permanent miss. Don't log the input or target.
    return new Response(null, { status: 503, headers: { ...HEADERS, "retry-after": "300" } });
  }
}
