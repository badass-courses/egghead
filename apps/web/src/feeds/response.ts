// Route-level helpers shared by the feed route handlers.

import { proFeedTechTags } from "./feeds";
import {
  authenticateFeedRequest,
  type FeedAuthRefusal,
  type FeedMembershipCheck,
  type FeedTokenStore,
} from "./token";

const RSS_CONTENT_TYPE = "application/rss+xml; charset=utf-8";

export function publicRssResponse(xml: string) {
  return new Response(xml, {
    headers: {
      "content-type": RSS_CONTENT_TYPE,
      "cache-control": "public, max-age=900, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}

/** Member feed URLs carry a credential in the query string: never share-cache them. */
export function memberRssResponse(xml: string) {
  return new Response(xml, {
    headers: {
      "content-type": RSS_CONTENT_TYPE,
      "cache-control": "private, max-age=900",
      "referrer-policy": "no-referrer",
    },
  });
}

const REFUSAL_MESSAGES: Record<FeedAuthRefusal, string> = {
  missing_credentials: "This feed needs the user_email and user_token from your egghead feed URL.",
  unknown_token: "This feed URL is not valid. Copy a fresh feed URL from egghead.io.",
  email_mismatch: "This feed URL is not valid. Copy a fresh feed URL from egghead.io.",
  revoked_token: "This feed URL was revoked. Copy a fresh feed URL from egghead.io.",
  not_a_member: "Not authorized to view this feed. An egghead membership is required.",
};

export function feedRefusalResponse(reason: FeedAuthRefusal) {
  return new Response(`${REFUSAL_MESSAGES[reason]}\n`, {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export function feedNotFoundResponse() {
  return new Response("Feed not found.\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * A database outage must not look like a revoked feed: 503 tells readers to
 * retry instead of dropping the subscription.
 */
export function feedUnavailableResponse() {
  return new Response("Feed temporarily unavailable.\n", {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": "300",
    },
  });
}

export type MemberFeedDeps = { store: FeedTokenStore; isMember: FeedMembershipCheck };

/**
 * Authenticate, then render. `render` returns null for an unknown feed.
 * Auth runs before the lookup so unauthenticated callers cannot probe slugs.
 */
export async function serveMemberFeed(
  request: Request,
  deps: MemberFeedDeps,
  render: () => Promise<string | null>,
): Promise<Response> {
  try {
    const auth = await authenticateFeedRequest(new URL(request.url).searchParams, deps);
    if (!auth.ok) return feedRefusalResponse(auth.reason);

    const xml = await render();
    return xml === null ? feedNotFoundResponse() : memberRssResponse(xml);
  } catch (error) {
    console.error("[feeds] member feed failed", error);
    return feedUnavailableResponse();
  }
}

/**
 * Decode one route segment. A malformed escape ("%E0%A4%A") is an unknown
 * feed, so it returns null and the route answers 404, not a URIError 503.
 */
export function decodeFeedParam(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded ? decoded : null;
  } catch {
    return null;
  }
}

/** render() for a feed keyed by one route segment: bad segments are 404s. */
export function renderByParam(
  raw: string,
  render: (param: string) => Promise<string | null>,
): () => Promise<string | null> {
  return async () => {
    const param = decodeFeedParam(raw);
    return param === null ? null : render(param);
  };
}

export function proFeedTechKey(request: Request) {
  return proFeedTechTags(new URL(request.url).searchParams.get("tech")).toSorted().join(",");
}
