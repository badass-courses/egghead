// Legacy egghead.io URL table for the domain flip.
//
// One table, two outcomes:
// - LEGACY_REDIRECTS: the old URL moves to a CourseBuilder URL (308).
// - RETIRED_ROUTES: the old URL is deliberately gone. A beforeFiles rewrite
//   sends it to /api/retired/<id>, which answers 410 for every method.
//   The reason lives here for reviewers and is never sent to callers.
//
// Order matters. Next checks every redirect before any rewrite, top to
// bottom, and the first match wins. Specific rules sit above the catch-alls
// they would otherwise hit, and catch-alls exclude retired paths.
// Every rule is pinned by a row in route-inventory.ts and asserted by
// apps/web/test/routing/route-parity.test.ts.

export type LegacyRedirect = {
  readonly id: string;
  readonly source: string;
  readonly destination: string;
};

export type RetiredRouteKind = "api" | "page";

export type RetiredRoute = {
  readonly id: string;
  readonly source: string;
  readonly kind: RetiredRouteKind;
  readonly reason: string;
};

export const RETIRED_ROUTE_HANDLER_PREFIX = "/api/retired";

export const LEGACY_REDIRECTS = [
  // Workshops: egghead-next served /workshop/<id>; CourseBuilder serves /workshops/<id>.
  { id: "live-events", source: "/live-events", destination: "/workshops" },
  { id: "workshop-index", source: "/workshop", destination: "/workshops" },
  { id: "workshop-email", source: "/workshop/email", destination: "/workshops" },
  {
    id: "workshop-subpage",
    source: "/workshop/:id/:page(boss|team)",
    destination: "/workshops/:id",
  },
  { id: "workshop-thanks", source: "/workshop/:id/thanks", destination: "/workshops/:id/thanks" },
  { id: "workshop", source: "/workshop/:id", destination: "/workshops/:id" },

  // Account surfaces collapse into /profile and /team.
  { id: "user", source: "/user", destination: "/profile" },
  { id: "user-membership", source: "/user/membership", destination: "/profile" },
  { id: "user-subscription", source: "/user/subscription", destination: "/profile" },
  { id: "user-profile", source: "/user/profile", destination: "/profile" },
  { id: "user-activity", source: "/user/activity", destination: "/profile/progress" },
  { id: "user-team", source: "/user/team", destination: "/team" },
  { id: "membership", source: "/membership", destination: "/profile" },
  { id: "instructor-dashboard", source: "/instructor", destination: "/profile" },
  { id: "update-billing", source: "/update_billing.html", destination: "/profile" },
  { id: "confirm", source: "/confirm", destination: "/profile" },
  { id: "confirmed", source: "/confirmed", destination: "/profile" },
  { id: "confirm-membership", source: "/confirm/membership", destination: "/profile" },
  { id: "team-invite", source: "/team-invite/:token", destination: "/team/invite/:token" },
  { id: "team-rails", source: "/team/:rest((?!invite/).+)", destination: "/team" },
  { id: "managed-subscriptions", source: "/managed_subscriptions/:all*", destination: "/team" },
  { id: "egghead-for-teams", source: "/egghead-for-teams", destination: "/pricing" },
  { id: "pricing-email", source: "/pricing/email", destination: "/pricing" },

  // Sign-in: Auth.js owns /login; Rails Devise and egghead-next signup pages go there.
  { id: "signup", source: "/signup", destination: "/login" },
  { id: "signup-topic", source: "/signup/:topic", destination: "/login" },
  { id: "rails-users", source: "/users/:all*", destination: "/login" },
  { id: "post-login-redirect", source: "/redirect", destination: "/" },

  // Discovery: topic, tag and instructor browsing becomes search.
  { id: "search", source: "/search", destination: "/q" },
  { id: "topics", source: "/topics", destination: "/q" },
  { id: "site-directory", source: "/site-directory", destination: "/q" },
  { id: "site-directory-tag", source: "/site-directory/:tag", destination: "/q/:tag" },
  { id: "browse-tag", source: "/browse/:context/:tag", destination: "/q/:tag" },
  { id: "browse", source: "/browse/:all*", destination: "/q" },
  { id: "instructors", source: "/instructors", destination: "/q" },
  {
    id: "instructor",
    source: "/instructors/:instructor",
    destination: "/q?instructor=:instructor",
  },
  {
    // /instructors/:id/feed is left for the feeds lane.
    id: "instructor-rails-subpage",
    source: "/instructors/:instructor/:rest((?!feed$).+)",
    destination: "/q?instructor=:instructor",
  },
  {
    id: "search-resources-by-instructor",
    source: "/q/resources-by-:instructor",
    destination: "/q?instructor=:instructor",
  },
  {
    id: "search-topic-resources-by-instructor",
    source: "/q/:topic([^/]+?)-resources-by-:instructor",
    destination: "/q?q=:topic&instructor=:instructor",
  },
  { id: "guides-index", source: "/guides", destination: "/q" },
  {
    id: "newsletter-ai-dev-essentials",
    source: "/newsletters/ai-dev-essentials",
    destination: "/blog",
  },

  // egghead-next learnRoutes, pointed at the slugs CourseBuilder serves.
  // egghead-next sent these to unsuffixed slugs that already 404 on egghead.io.
  {
    id: "learn-sanity-content-modeling",
    source: "/learn/data/egghead-content-modeling-with-santity-io",
    destination: "/content-modeling-and-data-design-with-sanity-io~cm479",
  },
  {
    id: "learn-tailwind-dark-mode",
    source: "/learn/next/tailwindcss-dark-mode-nextjs-typography-prose",
    destination: "/tailwind-css-dark-mode-in-next-js-with-tailwind-typography-prose-classes~0j6ia",
  },
  {
    id: "learn-codemods",
    source: "/learn/javascript/codemods-with-babel-plugins",
    destination: "/codemods-with-babel-plugins~ee7xa",
  },
  {
    id: "learn-intersection-observer",
    source: "/learn/javascript/use-the-intersection-observer-api-for-analytics-events",
    destination: "/use-the-intersection-observer-api-for-analytics-events~fnet1",
  },
  {
    id: "learn-cypress-copy-paste",
    source: "/learn/javascript/handling-copy-and-paste-in-cypress",
    destination: "/handling-copy-and-paste-in-cypress~wf598",
  },
  {
    id: "learn-ecommerce-cms",
    source:
      "/learn/ecommerce/build-a-content-management-system-for-an-e-commerce-store-with-nextjs-and-sanity",
    destination:
      "/build-a-content-management-system-for-an-e-commerce-store-with-next-js-and-sanity~nmfzn",
  },
  {
    id: "learn-ecommerce-product-images",
    source: "/learn/ecommerce/product-images-that-dont-byte-with-the-nextjs-image-component",
    destination: "/product-images-that-dont-byte-with-the-next-js-image-component~b4nos",
  },
  {
    id: "learn-object-pool",
    source:
      "/learn/javascript/improve-performance-with-the-object-pool-design-pattern-in-javascript",
    destination: "/improve-performance-with-the-object-pool-design-pattern-in-java-script~6l53t",
  },
  {
    id: "learn-tailwind-selikoff",
    source: "/learn/tailwind/utility-css-with-tailwind-sam-selikoff",
    destination: "/utility-first-tailwind-css-with-sam-selikoff~lpj01",
  },
  {
    id: "learn-understanding-by-design",
    source: "/learn/understanding-by-design",
    destination: "/understanding-by-design-in-a-nutshell~ufwcf",
  },
  {
    id: "learn-performance-task-patterns",
    source: "/learn/understanding-by-design/performance-task-patterns",
    destination: "/performance-task-patterns~vkqe6",
  },
  {
    id: "blog-solid-signals",
    source: "/blog/manage-reactive-state-with-solid-js-signals",
    destination: "/manage-reactive-state-with-solid-js-signals~7gwxg",
  },
  // The other /learn pages were tag hubs and topic primers; search covers them.
  { id: "learn-topic", source: "/learn/:topic", destination: "/q/:topic" },
  { id: "learn-topic-page", source: "/learn/:topic/:rest+", destination: "/q/:topic" },

  // Old project landing pages became courses.
  {
    id: "project-gatsby-blog",
    // Its course (build-a-developer-blog-with-gatsby-bd96) and lessons 404 on
    // egghead.io and are not in CourseBuilder.
    source: "/projects/build-a-developer-blog-with-gatsby",
    destination: "/q/gatsby",
  },
  {
    id: "project-css-grid",
    source: "/projects/build-modern-layouts-with-css-grid",
    destination: "/build-modern-layouts-with-css-grid-d3f5",
  },
  {
    id: "project-ecommerce-stripe",
    source: "/projects/create-an-ecommerce-store-with-next-js-and-stripe-checkout",
    destination: "/create-an-ecommerce-store-with-next-js-and-stripe-checkout-562c",
  },
  {
    id: "project-cloudflare-workers",
    source: "/projects/introduction-to-cloudflare-workers",
    destination: "/introduction-to-cloudflare-workers-5aa3",
  },
  {
    id: "project-vue-3",
    source: "/projects/the-beginner-s-guide-to-vue-3",
    destination: "/the-beginner-s-guide-to-vue-3-1c46da8b",
  },

  // Rails playlists and collections were course aliases in egghead-next.
  // /playlists/new is retired below, so the alias skips it.
  { id: "playlist", source: "/playlists/:slug((?!new$)[^/]+)", destination: "/courses/:slug" },
  { id: "collection", source: "/collections/:slug", destination: "/courses/:slug" },
  { id: "rails-article", source: "/articles/:slug", destination: "/blog/:slug" },

  { id: "sitemap-gz", source: "/sitemap.xml.gz", destination: "/sitemap.xml" },
] as const satisfies readonly LegacyRedirect[];

const BOOKMARKS = "VISION drops bookmarks; saved items are not migrated.";
const RAILS_TOOLING = "Rails-only staff or instructor tooling; Rails is switched off.";
const RAILS_API = "Rails API; Rails is switched off and CourseBuilder does not expose it.";
const NEXT_INTERNAL = "egghead-next internal endpoint; it leaves with egghead-next.";
const CIO_SIDE_EFFECT = "VISION drops page-load Customer.io side effects.";
const CAMPAIGN = "Legacy campaign or club landing page; VISION drops long-tail archive work.";

export const RETIRED_ROUTES = [
  { id: "bookmarks", source: "/bookmarks", kind: "page", reason: BOOKMARKS },
  { id: "user-bookmarks", source: "/user/bookmarks", kind: "page", reason: BOOKMARKS },
  {
    id: "guide",
    source: "/guides/:slug",
    kind: "page",
    reason: "CourseBuilder routing v2 retired the guide content family.",
  },
  {
    id: "twenty-days",
    source: "/20-days",
    kind: "page",
    reason: "Expired 2021 sale; egghead-next already returned 404.",
  },
  { id: "blank", source: "/blank", kind: "page", reason: "egghead-next layout test page." },
  {
    id: "migration-flags-proof",
    source: "/migration-flags-proof",
    kind: "page",
    reason: "egghead-next migration flag probe.",
  },
  { id: "blocked", source: "/blocked", kind: "page", reason: "egghead-next abuse block page." },
  { id: "ask", source: "/ask", kind: "page", reason: CAMPAIGN },
  {
    id: "answer-online-presence",
    source: "/answer/online-presence",
    kind: "page",
    reason: CAMPAIGN,
  },
  { id: "level-up", source: "/level-up", kind: "page", reason: CAMPAIGN },
  { id: "clubs", source: "/clubs/:rest*", kind: "page", reason: CAMPAIGN },
  {
    id: "developer-portfolio-foundations",
    source: "/developer-portfolio-foundations/:rest*",
    kind: "page",
    reason: CAMPAIGN,
  },
  {
    id: "own-your-online-presence",
    source: "/own-your-online-presence/:rest*",
    kind: "page",
    reason: CAMPAIGN,
  },
  { id: "portfolios", source: "/portfolios/:rest*", kind: "page", reason: CAMPAIGN },
  {
    id: "discord",
    source: "/discord/:rest*",
    kind: "page",
    reason:
      "Discord role linking ran through the Rails user and egghead-next; no CourseBuilder owner.",
  },
  {
    id: "rails-invite",
    source: "/invite/:all*",
    kind: "page",
    reason:
      "Rails team invite tokens do not exist in CourseBuilder. Team owners re-invite from /team.",
  },
  {
    id: "rails-oauth",
    source: "/oauth/:all*",
    kind: "page",
    reason: "Rails Doorkeeper OAuth provider; Auth.js replaces it.",
  },
  { id: "rails-production", source: "/production/:all*", kind: "page", reason: RAILS_TOOLING },
  {
    id: "rails-enhanced-transcripts",
    source: "/enhanced_transcripts/:all*",
    kind: "page",
    reason: "Rails transcript files; CourseBuilder lesson pages render transcripts.",
  },
  {
    id: "rails-lesson-uploads",
    source: "/lesson_uploads/:all*",
    kind: "page",
    reason: RAILS_TOOLING,
  },
  {
    id: "rails-lessons-new",
    source: "/lessons/:action(new|upload)",
    kind: "page",
    reason: RAILS_TOOLING,
  },
  { id: "rails-playlists-new", source: "/playlists/new", kind: "page", reason: RAILS_TOOLING },
  {
    // /playlists/:id/playlist_feed is left for the feeds lane.
    id: "rails-playlist-subpage",
    source: "/playlists/:title/:rest((?!playlist_feed$).+)",
    kind: "page",
    reason: RAILS_TOOLING,
  },
  {
    id: "rails-podcast-subpage",
    source: "/podcasts/:title/:rest(.+)",
    kind: "page",
    reason: RAILS_TOOLING,
  },
  {
    id: "rails-watch",
    source: "/watch/:all*",
    kind: "page",
    reason: "Rails watch-page alias with no CourseBuilder equivalent.",
  },
  {
    id: "rails-koudoku",
    source: "/koudoku/:all*",
    kind: "page",
    reason: "Rails Koudoku subscription engine; Stripe and CourseBuilder replace it.",
  },
  { id: "rails-admin", source: "/admin/:all*", kind: "page", reason: RAILS_TOOLING },
  { id: "rails-api-v1", source: "/api/v1/:all*", kind: "api", reason: RAILS_API },
  { id: "rails-graphql", source: "/graphql", kind: "api", reason: RAILS_API },
  {
    id: "next-cio-subscriber",
    source: "/api/cio-subscriber",
    kind: "api",
    reason: CIO_SIDE_EFFECT,
  },
  { id: "next-cio-identify", source: "/api/cio/:all*", kind: "api", reason: CIO_SIDE_EFFECT },
  { id: "next-topic", source: "/api/topic", kind: "api", reason: CIO_SIDE_EFFECT },
  { id: "next-trpc", source: "/api/trpc/:all*", kind: "api", reason: NEXT_INTERNAL },
  {
    id: "next-pricing",
    source: "/api/pricing",
    kind: "api",
    reason: "egghead-next client pricing API; CourseBuilder renders /pricing on the server.",
  },
  {
    id: "next-users-current",
    source: "/api/users/:action(current|check-pro-status)",
    kind: "api",
    reason: "egghead-next proxy to Rails current-user; CourseBuilder serves /api/current-user.",
  },
  {
    id: "next-stripe-client",
    source: "/api/stripe/:action(checkout/session|billing/session|transaction)",
    kind: "api",
    reason: "egghead-next checkout client API; CourseBuilder checkout replaces it.",
  },
  { id: "next-cron", source: "/api/cron", kind: "api", reason: NEXT_INTERNAL },
  { id: "next-feedback", source: "/api/feedback", kind: "api", reason: NEXT_INTERNAL },
  { id: "next-workshop-quote", source: "/api/workshop-quote", kind: "api", reason: NEXT_INTERNAL },
  {
    id: "next-newsletter-subscribe",
    source: "/api/newsletter/subscribe",
    kind: "api",
    reason: NEXT_INTERNAL,
  },
  { id: "next-discord", source: "/api/discord", kind: "api", reason: NEXT_INTERNAL },
  { id: "next-schedule", source: "/api/schedule", kind: "api", reason: NEXT_INTERNAL },
  { id: "next-timeout", source: "/api/timeout", kind: "api", reason: NEXT_INTERNAL },
  { id: "next-cors", source: "/api/cors", kind: "api", reason: NEXT_INTERNAL },
  { id: "next-auth-readback", source: "/api/auth-readback", kind: "api", reason: NEXT_INTERNAL },
  {
    id: "next-migration-flags",
    source: "/api/migration-flags/proof",
    kind: "api",
    reason: NEXT_INTERNAL,
  },
  {
    id: "next-vercel-flags",
    source: "/:prefix(api|\\.well-known)/vercel/flags",
    kind: "api",
    reason: NEXT_INTERNAL,
  },
  { id: "next-og-default", source: "/api/og/og-default", kind: "api", reason: NEXT_INTERNAL },
  { id: "next-sign-s3", source: "/api/aws/sign-s3", kind: "api", reason: NEXT_INTERNAL },
  {
    id: "next-progress",
    source: "/api/progress",
    kind: "api",
    reason: "egghead-next progress proxy to Rails; CourseBuilder records progress natively.",
  },
  {
    id: "next-authed-bits",
    source: "/api/courses/:slug/authed-bits",
    kind: "api",
    reason: NEXT_INTERNAL,
  },
] as const satisfies readonly RetiredRoute[];

export type LegacyRedirectId = (typeof LEGACY_REDIRECTS)[number]["id"];
export type RetiredRouteId = (typeof RETIRED_ROUTES)[number]["id"];

const retiredRoutesById: ReadonlyMap<string, RetiredRoute> = new Map(
  RETIRED_ROUTES.map((route) => [route.id, route]),
);

export function retiredRouteById(id: string): RetiredRoute | undefined {
  return retiredRoutesById.get(id);
}

export function retiredRouteDestination(id: string) {
  return `${RETIRED_ROUTE_HANDLER_PREFIX}/${id}`;
}

export function legacyRedirectsForNextConfig() {
  return LEGACY_REDIRECTS.map(({ source, destination }) => ({
    source,
    destination,
    permanent: true,
  }));
}

export function retiredRouteRewritesForNextConfig() {
  return RETIRED_ROUTES.map(({ id, source }) => ({
    source,
    destination: retiredRouteDestination(id),
  }));
}
