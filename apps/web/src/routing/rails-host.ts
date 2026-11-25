export const RAILS_HOST = "app.egghead.io";
const EGGHEAD_ORIGIN = "https://egghead.io";

// Next runs its canonical-site redirects before proxy.ts. Keep those rules
// off this host: some forward query strings, including old credentials.
export const RAILS_HOST_CONDITION = { type: "host", value: "app\\.egghead\\.io" } as const;

const PAGE_REDIRECTS = new Map([
  ["/", "/"],
  ["/robots.txt", "/robots.txt"],
  ["/sitemap.xml", "/sitemap.xml"],
  ["/profile", "/profile"],
  ["/login", "/login"],
  ["/users/sign_in", "/login"],
  ["/users/sign_up", "/login"],
  ["/users/github_passthrough", "/login"],
  ["/users/password/new", "/login"],
  ["/users/password/edit", "/login"],
  ["/courses", "/courses"],
  ["/lessons", "/lessons"],
  ["/articles", "/blog"],
  ["/search", "/q"],
  ["/browse", "/q"],
  ["/podcasts", "/podcasts"],
  ["/talks", "/talks"],
]);

const PUBLIC_FEEDS = new Set(["/feed", "/feed.rss", "/lessons/feed", "/lessons/feed.rss"]);
const MEMBER_FEEDS =
  /^\/(?:lessons\/pro_feed|courses\/[^/]+\/course_feed|playlists\/[^/]+\/playlist_feed|instructors\/[^/]+\/feed)(?:\.rss)?$/;
const LEGACY_MAGIC_LINK = /^\/token\/[^/]+$/;
const RETIRED_API = /^\/(?:oauth(?:\/|$)|api\/v1(?:\/|$)|graphql(?:\/|$)|current_user(?:\.json)?$)/;
const PENDING_SAML = /^\/(?:saml-(?:login|consume|metadata)$|saml_sessions(?:\/|$))/;
const PROFILE = /^\/users\/\d+$/;
const CONTENT_PAGE = /^\/(?:courses|playlists|lessons)\/[a-z0-9][a-z0-9_~-]*$/i;
const LESSON_EMBED = /^\/lessons\/[a-z0-9][a-z0-9_~-]*\/embed$/i;
const ARTICLE_PAGE = /^\/articles\/([a-z0-9][a-z0-9_~-]*)$/i;
const BROWSE_TAG = /^\/browse\/[a-z0-9_-]+\/([a-z0-9][a-z0-9_-]*)$/i;

type RailsHostRoute =
  | { kind: "serve-feed"; path: string }
  | { kind: "redirect"; location: string }
  | { kind: "retire"; reason: "member-feed" | "magic-link" | "legacy-api" }
  | { kind: "pending-saml" }
  | { kind: "unmapped" };

export function railsHostRoute(pathname: string): RailsHostRoute {
  const path = pathname.replace(/\/$/, "") || "/";
  if (MEMBER_FEEDS.test(path)) return { kind: "retire", reason: "member-feed" };
  if (LEGACY_MAGIC_LINK.test(path)) return { kind: "retire", reason: "magic-link" };
  if (RETIRED_API.test(path)) return { kind: "retire", reason: "legacy-api" };
  // Rails still owns SAML. Do not attach this host until its flip decision.
  if (PENDING_SAML.test(path)) return { kind: "pending-saml" };
  if (PUBLIC_FEEDS.has(path)) return { kind: "serve-feed", path };

  const target = canonicalPath(path);
  // No query-string relay, wildcard origin, or fallback to an app handler.
  return target === null
    ? { kind: "unmapped" }
    : { kind: "redirect", location: `${EGGHEAD_ORIGIN}${target}` };
}

function canonicalPath(path: string): string | null {
  const exact = PAGE_REDIRECTS.get(path);
  if (exact) return exact;
  if (PROFILE.test(path)) return "/profile";
  if (CONTENT_PAGE.test(path) || LESSON_EMBED.test(path)) return path;
  const article = ARTICLE_PAGE.exec(path)?.[1];
  if (article) return `/blog/${article}`;
  const tag = BROWSE_TAG.exec(path)?.[1];
  return tag ? `/q/${tag}` : null;
}
