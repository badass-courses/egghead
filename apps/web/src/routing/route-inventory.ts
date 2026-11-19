// egghead.io route inventory for the domain flip.
//
// One row per egghead-next route file (pages/**, app/**, including API
// routes) and per egghead-next next.config redirect, at egghead-next
// 992ec9a1 (2026-11-01). Each row says what the CourseBuilder app does with
// that URL:
//
// - served:   a CourseBuilder route answers the same path.
// - redirect: a rule in legacy-redirects.ts moves it to a CourseBuilder URL.
// - retire:   a rule in legacy-redirects.ts answers 410; the reason stays in the table.
// - build:    nothing answers yet; a follow-up lane owns it.
//
// test/routing/route-parity.test.ts walks every row against the real Next
// config and the app route tree, so a route that goes missing fails the test.

import type { LegacyRedirectId, RetiredRouteId } from "./legacy-redirects";

export const ROUTE_INVENTORY_SOURCE = {
  repo: "skillrecordings/egghead-next",
  commit: "992ec9a1",
  committedAt: "2026-11-01",
} as const;

export type RouteOrigin = "page" | "app" | "api" | "next-redirect" | "middleware" | "coursebuilder";

export type FollowUpLane =
  | "feeds"
  | "instructor-feeds"
  | "commerce-paid-paths"
  | "commerce-cutover"
  | "saml-sso"
  | "downloads"
  | "short-urls"
  | "crm-unsubscribe"
  | "static-pages"
  | "workshop-reference"
  | "integration-webhooks";

export type Disposition =
  | { readonly class: "served"; readonly cbRoute: string }
  | { readonly class: "redirect"; readonly rule: LegacyRedirectId; readonly destination: string }
  | { readonly class: "retire"; readonly rule: RetiredRouteId }
  | { readonly class: "build"; readonly lane: FollowUpLane; readonly note: string };

export type RouteInventoryRow = {
  readonly legacy: string;
  readonly origin: RouteOrigin;
  readonly sourceFile: string;
  readonly sample: string;
  readonly disposition: Disposition;
  readonly note?: string;
};

export type RouteParityClass = Disposition["class"];

const served = (cbRoute: string): Disposition => ({ class: "served", cbRoute });
const redirect = (rule: LegacyRedirectId, destination: string): Disposition => ({
  class: "redirect",
  rule,
  destination,
});
const retire = (rule: RetiredRouteId): Disposition => ({ class: "retire", rule });
const build = (lane: FollowUpLane, note: string): Disposition => ({ class: "build", lane, note });

const NEXT_CONFIG = "next.config.mjs";
const LESSON = "aws-write-and-test-your-first-aws-lambda-function";
const COURSE = "effective-runtime-type-checks-with-zod-22abf5f9";

function page(
  legacy: string,
  file: string,
  sample: string,
  disposition: Disposition,
  extra: Partial<Pick<RouteInventoryRow, "note">> = {},
): RouteInventoryRow {
  return { legacy, origin: "page", sourceFile: `src/pages/${file}`, sample, disposition, ...extra };
}

function app(
  legacy: string,
  file: string,
  sample: string,
  disposition: Disposition,
  extra: Partial<Pick<RouteInventoryRow, "note">> = {},
): RouteInventoryRow {
  return { legacy, origin: "app", sourceFile: `src/app/${file}`, sample, disposition, ...extra };
}

function api(
  legacy: string,
  file: string,
  sample: string,
  disposition: Disposition,
  extra: Partial<Pick<RouteInventoryRow, "note">> = {},
): RouteInventoryRow {
  return { legacy, origin: "api", sourceFile: `src/${file}`, sample, disposition, ...extra };
}

function nextRedirect(
  legacy: string,
  group: string,
  sample: string,
  disposition: Disposition,
  extra: Partial<Pick<RouteInventoryRow, "note">> = {},
): RouteInventoryRow {
  return {
    legacy,
    origin: "next-redirect",
    sourceFile: `${NEXT_CONFIG}#${group}`,
    sample,
    disposition,
    ...extra,
  };
}

const FEEDS = "Rails feed; the rails-off feeds lane builds it in CourseBuilder.";
const PAID_PATHS = "Paid-customer surface with no CourseBuilder equivalent yet (audit lane L5).";
const POWER_USER_REFERENCE =
  "Workshop companion reference sold with the workshop; bespoke egghead-next content.";

export const ROUTE_INVENTORY: readonly RouteInventoryRow[] = [
  // Redirects CourseBuilder already shipped before this table.
  {
    legacy: "/live-events",
    origin: "coursebuilder",
    sourceFile: "apps/web/next.config.ts (pre-parity)",
    sample: "/live-events",
    disposition: redirect("live-events", "/workshops"),
  },
  {
    legacy: "/workshop",
    origin: "coursebuilder",
    sourceFile: "apps/web/next.config.ts (pre-parity /workshop/:path*)",
    sample: "/workshop",
    disposition: redirect("workshop-index", "/workshops"),
  },
  {
    legacy: "/workshop/:id/thanks",
    origin: "coursebuilder",
    sourceFile: "apps/web/next.config.ts (pre-parity /workshop/:path*)",
    sample: "/workshop/claude-code/thanks",
    disposition: redirect("workshop-thanks", "/workshops/claude-code/thanks"),
    note: "Destination resolves to app route /workshops/[id]/thanks.",
  },
  {
    legacy: "/workshop/:id/:rest+",
    origin: "coursebuilder",
    sourceFile: "apps/web/next.config.ts (pre-parity /workshop/:path*)",
    sample: "/workshop/claude-code/old-page",
    disposition: redirect("workshop-fallback", "/workshops"),
    note: "Untabled workshop subpages. Invoice and power-user reference rows stay build rows.",
  },
  {
    legacy: "/articles",
    origin: "coursebuilder",
    sourceFile:
      "egghead-next next.config legacyRoutes (/articles/:all* also matches bare /articles)",
    sample: "/articles",
    disposition: redirect("rails-article-index", "/blog"),
  },

  // egghead-next middleware search canonicalization (src/server/search-query-canonicalization.ts).
  {
    legacy: "/q/resources-by-:instructor",
    origin: "middleware",
    sourceFile: "src/server/search-query-canonicalization.ts",
    sample: "/q/resources-by-kent-c-dodds",
    disposition: redirect("search-resources-by-instructor", "/q?instructor=kent-c-dodds"),
  },
  {
    legacy: "/q/:tags-resources-by-:instructor",
    origin: "middleware",
    sourceFile: "src/server/search-query-canonicalization.ts",
    sample: "/q/react-resources-by-kent-c-dodds",
    disposition: redirect(
      "search-topic-resources-by-instructor",
      "/q?q=react&instructor=kent-c-dodds",
    ),
    note: "Single topic and single instructor only; -and- lists are not split.",
  },

  // Public content.
  app("/", "page.tsx", "/", served("/")),
  page("/[post]", "[post].tsx", "/codemods-with-babel-plugins~ee7xa", served("/[slug]")),
  page("/courses", "courses/index.tsx", "/courses", served("/courses")),
  page(
    "/courses/[course]",
    "courses/[course]/index.tsx",
    `/courses/${COURSE}`,
    served("/courses/[course]"),
  ),
  page("/lessons/[slug]", "lessons/[slug].tsx", `/lessons/${LESSON}`, served("/lessons/[slug]")),
  app(
    "/lessons/[slug]/embed",
    "(content)/lessons/[slug]/embed/page.tsx",
    `/lessons/${LESSON}/embed`,
    served("/lessons/[slug]/embed"),
  ),
  page("/q/[[...all]]", "q/[[...all]].tsx", "/q/react", served("/q/[[...all]]"), {
    note: "CourseBuilder treats path segments as the search term; tag-and-instructor grammar beyond resources-by is not parsed.",
  }),
  page("/talks", "talks/index.tsx", "/talks", served("/talks")),
  page("/talks/[slug]", "talks/[slug].tsx", "/talks/some-talk", served("/talks/[slug]")),
  page(
    "/podcasts/[slug]",
    "podcasts/[slug].tsx",
    "/podcasts/developer-chats",
    served("/podcasts/[slug]"),
  ),
  page("/case-studies", "case-studies/index.tsx", "/case-studies", served("/case-studies")),
  page(
    "/case-studies/[slug]",
    "case-studies/[slug].tsx",
    "/case-studies/some-team",
    served("/case-studies/[slug]"),
  ),
  page(
    "/playlists/[slug]",
    "playlists/[slug].tsx",
    `/playlists/${COURSE}`,
    redirect("playlist", `/courses/${COURSE}`),
  ),
  page(
    "/collections/[slug]",
    "collections/[slug].tsx",
    `/collections/${COURSE}`,
    redirect("collection", `/courses/${COURSE}`),
    {
      note: "egghead-next loaded the Rails playlist. User-made collections that are not courses will 404 on the course route.",
    },
  ),
  page("/guides", "guides/index.tsx", "/guides", redirect("guides-index", "/q")),
  page("/guides/[slug]", "guides/[slug].tsx", "/guides/some-guide", retire("guide")),
  page("/topics", "topics.tsx", "/topics", redirect("topics", "/q")),
  page(
    "/site-directory",
    "site-directory/index.tsx",
    "/site-directory",
    redirect("site-directory", "/q"),
  ),
  page(
    "/site-directory/[tag]",
    "site-directory/[tag].tsx",
    "/site-directory/react",
    redirect("site-directory-tag", "/q/react"),
  ),
  page("/learn/[slug]", "learn/[slug].tsx", "/learn/react", redirect("learn-topic", "/q/react")),
  page(
    "/learn/developer-portfolio",
    "learn/developer-portfolio/index.tsx",
    "/learn/developer-portfolio",
    redirect("learn-topic", "/q/developer-portfolio"),
  ),
  page(
    "/learn/digital-gardening",
    "learn/digital-gardening/index.tsx",
    "/learn/digital-gardening",
    redirect("learn-topic", "/q/digital-gardening"),
  ),
  page(
    "/learn/state-management",
    "learn/state-management/index.tsx",
    "/learn/state-management",
    redirect("learn-topic", "/q/state-management"),
  ),
  page(
    "/learn/javascript",
    "learn/javascript/index.mdx",
    "/learn/javascript",
    redirect("learn-topic", "/q/javascript"),
  ),
  page(
    "/learn/javascript/es6",
    "learn/javascript/es6.mdx",
    "/learn/javascript/es6",
    redirect("learn-topic-page", "/q/javascript"),
  ),
  page(
    "/learn/javascript/interact-DOM",
    "learn/javascript/interact-DOM/index.mdx",
    "/learn/javascript/interact-DOM",
    redirect("learn-topic-page", "/q/javascript"),
  ),
  page(
    "/learn/javascript/javascript-introduction",
    "learn/javascript/javascript-introduction/index.mdx",
    "/learn/javascript/javascript-introduction",
    redirect("learn-topic-page", "/q/javascript"),
  ),
  page(
    "/learn/javascript/the-dom",
    "learn/javascript/the-dom/index.mdx",
    "/learn/javascript/the-dom",
    redirect("learn-topic-page", "/q/javascript"),
  ),
  page(
    "/learn/javascript/the-dom/DOMScroller",
    "learn/javascript/the-dom/DOMScroller.js",
    "/learn/javascript/the-dom/DOMScroller",
    redirect("learn-topic-page", "/q/javascript"),
    {
      note: "A component file that pageExtensions turned into a route.",
    },
  ),
  page(
    "/learn/javascript/the-dom/NodesScroller",
    "learn/javascript/the-dom/NodesScroller.js",
    "/learn/javascript/the-dom/NodesScroller",
    redirect("learn-topic-page", "/q/javascript"),
    {
      note: "A component file that pageExtensions turned into a route.",
    },
  ),
  page(
    "/learn/react",
    "learn/react/index.mdx",
    "/learn/react",
    redirect("learn-topic", "/q/react"),
  ),
  page(
    "/learn/react/beginners",
    "learn/react/beginners/index.mdx",
    "/learn/react/beginners",
    redirect("learn-topic-page", "/q/react"),
  ),
  page(
    "/learn/react/beginners/js-before-react",
    "learn/react/beginners/js-before-react.mdx",
    "/learn/react/beginners/js-before-react",
    redirect("learn-topic-page", "/q/react"),
  ),
  page(
    "/learn/react/beginners/wtf-is-jsx",
    "learn/react/beginners/wtf-is-jsx.mdx",
    "/learn/react/beginners/wtf-is-jsx",
    redirect("learn-topic-page", "/q/react"),
  ),
  page(
    "/learn/react/beginners/wtf-is-react",
    "learn/react/beginners/wtf-is-react.mdx",
    "/learn/react/beginners/wtf-is-react",
    redirect("learn-topic-page", "/q/react"),
  ),
  page(
    "/learn/react/toolkit-or-framework",
    "learn/react/toolkit-or-framework.mdx",
    "/learn/react/toolkit-or-framework",
    redirect("learn-topic-page", "/q/react"),
  ),
  page(
    "/learn/30x500",
    "learn/30x500/index.mdx",
    "/learn/30x500",
    redirect("learn-topic", "/q/30x500"),
  ),
  page(
    "/learn/30x500/sales-safari",
    "learn/30x500/sales-safari/index.mdx",
    "/learn/30x500/sales-safari",
    redirect("learn-topic-page", "/q/30x500"),
  ),
  page(
    "/projects/build-a-developer-blog-with-gatsby",
    "projects/build-a-developer-blog-with-gatsby/index.tsx",
    "/projects/build-a-developer-blog-with-gatsby",
    redirect("project-gatsby-blog", "/q/gatsby"),
    {
      note: "The page's course (build-a-developer-blog-with-gatsby-bd96) and its lessons 404 on egghead.io and are not in the beta sitemap, so search takes it.",
    },
  ),
  page(
    "/projects/build-modern-layouts-with-css-grid",
    "projects/build-modern-layouts-with-css-grid/index.tsx",
    "/projects/build-modern-layouts-with-css-grid",
    redirect("project-css-grid", "/build-modern-layouts-with-css-grid-d3f5"),
  ),
  page(
    "/projects/create-an-ecommerce-store-with-next-js-and-stripe-checkout",
    "projects/create-an-ecommerce-store-with-next-js-and-stripe-checkout/index.tsx",
    "/projects/create-an-ecommerce-store-with-next-js-and-stripe-checkout",
    redirect(
      "project-ecommerce-stripe",
      "/create-an-ecommerce-store-with-next-js-and-stripe-checkout-562c",
    ),
  ),
  page(
    "/projects/introduction-to-cloudflare-workers",
    "projects/introduction-to-cloudflare-workers/index.tsx",
    "/projects/introduction-to-cloudflare-workers",
    redirect("project-cloudflare-workers", "/introduction-to-cloudflare-workers-5aa3"),
  ),
  page(
    "/projects/the-beginner-s-guide-to-vue-3",
    "projects/the-beginner-s-guide-to-vue-3/index.tsx",
    "/projects/the-beginner-s-guide-to-vue-3",
    redirect("project-vue-3", "/the-beginner-s-guide-to-vue-3-1c46da8b"),
  ),
  page(
    "/newsletters/ai-dev-essentials",
    "newsletters/ai-dev-essentials.tsx",
    "/newsletters/ai-dev-essentials",
    redirect("newsletter-ai-dev-essentials", "/blog"),
    {
      note: "AI Dev Essentials issues are CourseBuilder articles.",
    },
  ),

  // Static policy pages, built by this lane from the egghead-next copy.
  page("/privacy", "privacy.mdx", "/privacy", served("/privacy"), {
    note: "Built by the route-parity lane.",
  }),
  page("/faq", "faq.mdx", "/faq", served("/faq"), {
    note: "Built by the route-parity lane. The copy links to /invoices, which is still a build row.",
  }),
  page("/code-of-conduct", "code-of-conduct.mdx", "/code-of-conduct", served("/code-of-conduct"), {
    note: "Built by the route-parity lane.",
  }),
  page(
    "/write-for-egghead",
    "write-for-egghead/index.mdx",
    "/write-for-egghead",
    build("static-pages", "Instructor pitch page with a topic list and pitch form components."),
  ),

  // Campaign, club and test pages.
  page("/20-days", "20-days.tsx", "/20-days", retire("twenty-days")),
  page("/ask", "ask.tsx", "/ask", retire("ask")),
  page(
    "/answer/online-presence",
    "answer/online-presence.tsx",
    "/answer/online-presence",
    retire("answer-online-presence"),
  ),
  page("/blank", "blank.tsx", "/blank", retire("blank")),
  page(
    "/migration-flags-proof",
    "migration-flags-proof.tsx",
    "/migration-flags-proof",
    retire("migration-flags-proof"),
  ),
  page("/level-up", "level-up/index.mdx", "/level-up", retire("level-up")),
  page(
    "/clubs/portfolio-project",
    "clubs/portfolio-project.mdx",
    "/clubs/portfolio-project",
    retire("clubs"),
  ),
  page(
    "/developer-portfolio-foundations",
    "developer-portfolio-foundations/index.mdx",
    "/developer-portfolio-foundations",
    retire("developer-portfolio-foundations"),
  ),
  page(
    "/developer-portfolio-foundations/[slug]",
    "developer-portfolio-foundations/[slug].tsx",
    "/developer-portfolio-foundations/some-step",
    retire("developer-portfolio-foundations"),
  ),
  page(
    "/own-your-online-presence",
    "own-your-online-presence/index.mdx",
    "/own-your-online-presence",
    retire("own-your-online-presence"),
  ),
  page(
    "/own-your-online-presence/[slug]",
    "own-your-online-presence/[slug].tsx",
    "/own-your-online-presence/some-step",
    retire("own-your-online-presence"),
  ),
  page("/portfolios", "portfolios/index.tsx", "/portfolios", retire("portfolios")),
  page(
    "/portfolios/[slug]",
    "portfolios/[slug].tsx",
    "/portfolios/some-portfolio",
    retire("portfolios"),
  ),
  page("/discord", "discord/index.tsx", "/discord", retire("discord")),
  page("/discord/callback", "discord/callback.tsx", "/discord/callback", retire("discord")),
  app("/blocked", "blocked/page.tsx", "/blocked", retire("blocked")),

  // Sign-in and account.
  page("/login", "login.tsx", "/login", served("/login")),
  page("/logout", "logout.tsx", "/logout", served("/logout")),
  page("/signup", "signup/index.tsx", "/signup", redirect("signup", "/login")),
  page(
    "/signup/[topic]",
    "signup/[topic].tsx",
    "/signup/react",
    redirect("signup-topic", "/login"),
  ),
  page("/redirect", "redirect.tsx", "/redirect", redirect("post-login-redirect", "/")),
  page(
    "/instructor",
    "instructor/index.tsx",
    "/instructor",
    redirect("instructor-dashboard", "/profile"),
  ),
  page("/bookmarks", "bookmarks/index.tsx", "/bookmarks", retire("bookmarks")),
  app("/user/bookmarks", "user/bookmarks/page.tsx", "/user/bookmarks", retire("user-bookmarks")),
  app(
    "/user/activity",
    "user/activity/page.tsx",
    "/user/activity",
    redirect("user-activity", "/profile/progress"),
  ),
  app(
    "/user/membership",
    "user/membership/page.tsx",
    "/user/membership",
    redirect("user-membership", "/profile"),
  ),
  app(
    "/user/profile",
    "user/profile/page.tsx",
    "/user/profile",
    redirect("user-profile", "/profile"),
  ),
  app("/user/team", "user/team/page.tsx", "/user/team", redirect("user-team", "/team")),
  page("/team", "team/index.tsx", "/team", served("/team")),
  page(
    "/team-invite/[token]",
    "team-invite/[token].tsx",
    "/team-invite/abc123",
    redirect("team-invite", "/team/invite/abc123"),
    {
      note: "Rails-issued invite tokens will not resolve in CourseBuilder; CourseBuilder-issued tokens will.",
    },
  ),
  page(
    "/egghead-for-teams",
    "egghead-for-teams.tsx",
    "/egghead-for-teams",
    redirect("egghead-for-teams", "/pricing"),
  ),
  page(
    "/email-change-request/[token]",
    "email-change-request/[token].tsx",
    "/email-change-request/abc123",
    build("commerce-paid-paths", "Account email change confirmation; no CourseBuilder flow yet."),
  ),
  page(
    "/account-ownership-transfer/[guid]",
    "account-ownership-transfer/[guid].tsx",
    "/account-ownership-transfer/abc123",
    build(
      "commerce-paid-paths",
      "Team account ownership transfer accept page. #47 added the handover machine but no accept route.",
    ),
  ),
  page(
    "/unsubscribed",
    "unsubscribed.tsx",
    "/unsubscribed",
    build(
      "crm-unsubscribe",
      "Customer.io unsubscribe landing that also identifies the subscriber; needs a Customer.io owner decision.",
    ),
  ),

  // Commerce.
  page("/pricing", "pricing/index.tsx", "/pricing", served("/pricing")),
  page(
    "/pricing/email",
    "pricing/email/index.tsx",
    "/pricing/email",
    redirect("pricing-email", "/pricing"),
  ),
  page("/confirm", "confirm.tsx", "/confirm", redirect("confirm", "/profile")),
  page("/confirmed", "confirmed.tsx", "/confirmed", redirect("confirmed", "/profile")),
  page(
    "/confirm/membership",
    "confirm/membership.tsx",
    "/confirm/membership",
    redirect("confirm-membership", "/profile"),
  ),
  page(
    "/confirm/forever",
    "confirm/forever.tsx",
    "/confirm/forever",
    build("commerce-paid-paths", "Lifetime purchase confirmation. " + PAID_PATHS),
  ),
  page(
    "/forever",
    "forever/index.tsx",
    "/forever",
    build("commerce-paid-paths", "Lifetime membership sales page. " + PAID_PATHS),
  ),
  page(
    "/forever/email",
    "forever/email/index.tsx",
    "/forever/email",
    build("commerce-paid-paths", "Lifetime membership email capture. " + PAID_PATHS),
  ),
  page(
    "/invoices",
    "invoices/index.tsx",
    "/invoices",
    build("commerce-paid-paths", "Invoice list; the FAQ links here. " + PAID_PATHS),
  ),
  page(
    "/invoices/[stripeTransactionId]",
    "invoices/[stripeTransactionId].tsx",
    "/invoices/ch_123",
    build("commerce-paid-paths", "Printable invoice. " + PAID_PATHS),
  ),
  page(
    "/gifts/claim/[guid]",
    "gifts/claim/[guid].tsx",
    "/gifts/claim/abc123",
    build(
      "commerce-paid-paths",
      "Gift claim. Gifts are not in CourseBuilder; build or drop is an owner decision.",
    ),
  ),

  // Workshops.
  page(
    "/workshop/claude-code",
    "workshop/claude-code/index.tsx",
    "/workshop/claude-code",
    redirect("workshop", "/workshops/claude-code"),
  ),
  page(
    "/workshop/claude-code/boss",
    "workshop/claude-code/boss.tsx",
    "/workshop/claude-code/boss",
    redirect("workshop-subpage", "/workshops/claude-code"),
  ),
  page(
    "/workshop/claude-code/invoice/[merchantChargeId]",
    "workshop/claude-code/invoice/[merchantChargeId].tsx",
    "/workshop/claude-code/invoice/abc123",
    build("commerce-paid-paths", "Workshop invoice. " + PAID_PATHS),
  ),
  page(
    "/workshop/codex",
    "workshop/codex/index.tsx",
    "/workshop/codex",
    redirect("workshop", "/workshops/codex"),
  ),
  page(
    "/workshop/cursor",
    "workshop/cursor/index.tsx",
    "/workshop/cursor",
    redirect("workshop", "/workshops/cursor"),
  ),
  page(
    "/workshop/cursor/invoice/[merchantChargeId]",
    "workshop/cursor/invoice/[merchantChargeId].tsx",
    "/workshop/cursor/invoice/abc123",
    build("commerce-paid-paths", "Workshop invoice. " + PAID_PATHS),
  ),
  page(
    "/workshop/cursor/team",
    "workshop/cursor/team/index.tsx",
    "/workshop/cursor/team",
    redirect("workshop-subpage", "/workshops/cursor"),
  ),
  page(
    "/workshop/email",
    "workshop/email/index.tsx",
    "/workshop/email",
    redirect("workshop-email", "/workshops"),
  ),
  page(
    "/workshop/invoice/[merchantChargeId]",
    "workshop/invoice/[merchantChargeId].tsx",
    "/workshop/invoice/abc123",
    build("commerce-paid-paths", "Workshop invoice. " + PAID_PATHS),
  ),
  page(
    "/workshop/software-factory",
    "workshop/software-factory/index.tsx",
    "/workshop/software-factory",
    redirect("workshop", "/workshops/software-factory"),
  ),
  app(
    "/workshop/codex/power-user-reference",
    "workshop/codex/power-user-reference/page.tsx",
    "/workshop/codex/power-user-reference",
    build("workshop-reference", POWER_USER_REFERENCE),
  ),
  app(
    "/workshop/codex/power-user-reference/[slug]",
    "workshop/codex/power-user-reference/[slug]/page.tsx",
    "/workshop/codex/power-user-reference/some-topic",
    build("workshop-reference", POWER_USER_REFERENCE),
  ),
  app(
    "/workshop/codex/power-user-reference/source/[slug]",
    "workshop/codex/power-user-reference/source/[slug]/page.tsx",
    "/workshop/codex/power-user-reference/source/some-source",
    build("workshop-reference", POWER_USER_REFERENCE),
  ),
  app(
    "/workshop/software-factory/power-user-reference",
    "workshop/software-factory/power-user-reference/page.tsx",
    "/workshop/software-factory/power-user-reference",
    build("workshop-reference", POWER_USER_REFERENCE),
  ),
  app(
    "/workshop/software-factory/power-user-reference/[slug]",
    "workshop/software-factory/power-user-reference/[slug]/page.tsx",
    "/workshop/software-factory/power-user-reference/some-topic",
    build("workshop-reference", POWER_USER_REFERENCE),
  ),
  app(
    "/workshop/software-factory/power-user-reference/source/[slug]",
    "workshop/software-factory/power-user-reference/source/[slug]/page.tsx",
    "/workshop/software-factory/power-user-reference/source/some-source",
    build("workshop-reference", POWER_USER_REFERENCE),
  ),

  // Instructor feeds served by egghead-next itself.
  page(
    "/i/[slug]/rss.xml",
    "i/[slug]/rss.xml.tsx",
    "/i/kent-c-dodds/rss.xml",
    build("instructor-feeds", "Instructor RSS feed from egghead-next."),
  ),
  page(
    "/i/[slug]/atom.xml",
    "i/[slug]/atom.xml.tsx",
    "/i/kent-c-dodds/atom.xml",
    build("instructor-feeds", "Instructor Atom feed from egghead-next."),
  ),
  page(
    "/i/[slug]/feed.json",
    "i/[slug]/feed.json.tsx",
    "/i/kent-c-dodds/feed.json",
    build("instructor-feeds", "Instructor JSON feed from egghead-next."),
  ),

  // egghead-next API routes.
  api(
    "/api/cio-subscriber",
    "pages/api/cio-subscriber.ts",
    "/api/cio-subscriber",
    retire("next-cio-subscriber"),
  ),
  api(
    "/api/cio/identify/[id]",
    "pages/api/cio/identify/[id].ts",
    "/api/cio/identify/abc",
    retire("next-cio-identify"),
  ),
  api("/api/topic", "pages/api/topic.tsx", "/api/topic", retire("next-topic")),
  api(
    "/api/trpc/[trpc]",
    "app/api/trpc/[trpc]/route.ts",
    "/api/trpc/user.current",
    retire("next-trpc"),
  ),
  api("/api/pricing", "app/api/pricing/route.ts", "/api/pricing", retire("next-pricing")),
  api(
    "/api/users/current",
    "pages/api/users/current.ts",
    "/api/users/current",
    retire("next-users-current"),
    {
      note: "No third-party caller found in code; L1 caller census should confirm before the flip.",
    },
  ),
  api(
    "/api/users/check-pro-status",
    "pages/api/users/check-pro-status.ts",
    "/api/users/check-pro-status",
    retire("next-users-current"),
  ),
  api(
    "/api/stripe/checkout/session",
    "pages/api/stripe/checkout/session.ts",
    "/api/stripe/checkout/session",
    retire("next-stripe-client"),
  ),
  api(
    "/api/stripe/billing/session",
    "pages/api/stripe/billing/session.ts",
    "/api/stripe/billing/session",
    retire("next-stripe-client"),
  ),
  api(
    "/api/stripe/transaction",
    "pages/api/stripe/transaction.ts",
    "/api/stripe/transaction",
    retire("next-stripe-client"),
  ),
  api(
    "/api/stripe/webhook",
    "pages/api/stripe/webhook.ts",
    "/api/stripe/webhook",
    build(
      "commerce-cutover",
      "Registered Stripe webhook endpoint. Moving it to /api/coursebuilder/webhook/stripe is the commerce cutover (L3/L4).",
    ),
  ),
  api(
    "/api/stripe/checkout/lifetime",
    "app/api/stripe/checkout/lifetime/route.ts",
    "/api/stripe/checkout/lifetime",
    build("commerce-paid-paths", "Lifetime checkout. " + PAID_PATHS),
  ),
  api(
    "/api/lessons/[slug]/download",
    "app/api/lessons/[slug]/download/route.ts",
    `/api/lessons/${LESSON}/download`,
    build("downloads", "Member video download."),
  ),
  api("/api/inngest", "app/api/inngest/route.ts", "/api/inngest", served("/api/inngest"), {
    note: "Same path, different Inngest app. The flip re-syncs Inngest Cloud to the CourseBuilder functions.",
  }),
  api(
    "/api/mux/webhook",
    "app/api/mux/webhook/route.ts",
    "/api/mux/webhook",
    build("integration-webhooks", "Mux webhook registered in the Mux dashboard."),
  ),
  api(
    "/api/deepgram/webhook",
    "app/api/deepgram/webhook/route.ts",
    "/api/deepgram/webhook",
    build("integration-webhooks", "Deepgram transcript callback."),
  ),
  api(
    "/api/webhooks/transloadit",
    "app/api/webhooks/transloadit/route.ts",
    "/api/webhooks/transloadit",
    build("integration-webhooks", "Transloadit upload callback."),
  ),
  api("/api/cron", "app/api/cron/route.ts", "/api/cron", retire("next-cron"), {
    note: "Vercel cron for egghead-next; L10 decides which jobs CourseBuilder needs.",
  }),
  api("/api/feedback", "app/api/feedback/route.ts", "/api/feedback", retire("next-feedback")),
  api(
    "/api/workshop-quote",
    "app/api/workshop-quote/route.ts",
    "/api/workshop-quote",
    retire("next-workshop-quote"),
  ),
  api(
    "/api/newsletter/subscribe",
    "pages/api/newsletter/subscribe.ts",
    "/api/newsletter/subscribe",
    retire("next-newsletter-subscribe"),
  ),
  api("/api/discord", "pages/api/discord.ts", "/api/discord", retire("next-discord")),
  api("/api/schedule", "pages/api/schedule.ts", "/api/schedule", retire("next-schedule")),
  api("/api/timeout", "pages/api/timeout.ts", "/api/timeout", retire("next-timeout")),
  api("/api/cors", "pages/api/cors.ts", "/api/cors", retire("next-cors")),
  api(
    "/api/auth-readback",
    "pages/api/auth-readback.ts",
    "/api/auth-readback",
    retire("next-auth-readback"),
  ),
  api(
    "/api/migration-flags/proof",
    "pages/api/migration-flags/proof.ts",
    "/api/migration-flags/proof",
    retire("next-migration-flags"),
  ),
  api(
    "/api/vercel/flags",
    "pages/api/vercel/flags.ts",
    "/api/vercel/flags",
    retire("next-vercel-flags"),
  ),
  api(
    "/api/og/og-default",
    "pages/api/og/og-default.tsx",
    "/api/og/og-default",
    retire("next-og-default"),
  ),
  api("/api/aws/sign-s3", "pages/api/aws/sign-s3.ts", "/api/aws/sign-s3", retire("next-sign-s3")),
  api("/api/progress", "pages/api/progress.ts", "/api/progress", retire("next-progress")),
  api(
    "/api/courses/[slug]/authed-bits",
    "pages/api/courses/[slug]/authed-bits.ts",
    `/api/courses/${COURSE}/authed-bits`,
    retire("next-authed-bits"),
  ),

  // egghead-next next.config redirects: learnRoutes.
  nextRedirect(
    "/learn/data/egghead-content-modeling-with-santity-io",
    "learnRoutes",
    "/learn/data/egghead-content-modeling-with-santity-io",
    redirect(
      "learn-sanity-content-modeling",
      "/content-modeling-and-data-design-with-sanity-io~cm479",
    ),
  ),
  nextRedirect(
    "/learn/gardening/github-issues-powered-blog",
    "learnRoutes",
    "/learn/gardening/github-issues-powered-blog",
    redirect("learn-topic-page", "/q/gardening"),
    {
      note: "egghead-next's target 404s on egghead.io and is not in CourseBuilder.",
    },
  ),
  nextRedirect(
    "/learn/rails-graphql-typescript-react-apollo",
    "learnRoutes",
    "/learn/rails-graphql-typescript-react-apollo",
    redirect("learn-topic", "/q/rails-graphql-typescript-react-apollo"),
    {
      note: "egghead-next's target 404s on egghead.io and is not in CourseBuilder.",
    },
  ),
  nextRedirect(
    "/learn/next/tailwindcss-dark-mode-nextjs-typography-prose",
    "learnRoutes",
    "/learn/next/tailwindcss-dark-mode-nextjs-typography-prose",
    redirect(
      "learn-tailwind-dark-mode",
      "/tailwind-css-dark-mode-in-next-js-with-tailwind-typography-prose-classes~0j6ia",
    ),
  ),
  nextRedirect(
    "/learn/javascript/codemods-with-babel-plugins",
    "learnRoutes",
    "/learn/javascript/codemods-with-babel-plugins",
    redirect("learn-codemods", "/codemods-with-babel-plugins~ee7xa"),
  ),
  nextRedirect(
    "/learn/javascript/use-the-intersection-observer-api-for-analytics-events",
    "learnRoutes",
    "/learn/javascript/use-the-intersection-observer-api-for-analytics-events",
    redirect(
      "learn-intersection-observer",
      "/use-the-intersection-observer-api-for-analytics-events~fnet1",
    ),
  ),
  nextRedirect(
    "/learn/javascript/handling-copy-and-paste-in-cypress",
    "learnRoutes",
    "/learn/javascript/handling-copy-and-paste-in-cypress",
    redirect("learn-cypress-copy-paste", "/handling-copy-and-paste-in-cypress~wf598"),
  ),
  nextRedirect(
    "/learn/ecommerce/build-a-content-management-system-for-an-e-commerce-store-with-nextjs-and-sanity",
    "learnRoutes",
    "/learn/ecommerce/build-a-content-management-system-for-an-e-commerce-store-with-nextjs-and-sanity",
    redirect(
      "learn-ecommerce-cms",
      "/build-a-content-management-system-for-an-e-commerce-store-with-next-js-and-sanity~nmfzn",
    ),
  ),
  nextRedirect(
    "/learn/ecommerce/product-images-that-dont-byte-with-the-nextjs-image-component",
    "learnRoutes",
    "/learn/ecommerce/product-images-that-dont-byte-with-the-nextjs-image-component",
    redirect(
      "learn-ecommerce-product-images",
      "/product-images-that-dont-byte-with-the-next-js-image-component~b4nos",
    ),
  ),
  nextRedirect(
    "/learn/javascript/improve-performance-with-the-object-pool-design-pattern-in-javascript",
    "learnRoutes",
    "/learn/javascript/improve-performance-with-the-object-pool-design-pattern-in-javascript",
    redirect(
      "learn-object-pool",
      "/improve-performance-with-the-object-pool-design-pattern-in-java-script~6l53t",
    ),
  ),
  nextRedirect(
    "/learn/tailwind/utility-css-with-tailwind-sam-selikoff",
    "learnRoutes",
    "/learn/tailwind/utility-css-with-tailwind-sam-selikoff",
    redirect("learn-tailwind-selikoff", "/utility-first-tailwind-css-with-sam-selikoff~lpj01"),
  ),
  nextRedirect(
    "/learn/understanding-by-design",
    "learnRoutes",
    "/learn/understanding-by-design",
    redirect("learn-understanding-by-design", "/understanding-by-design-in-a-nutshell~ufwcf"),
  ),
  nextRedirect(
    "/learn/understanding-by-design/performance-task-patterns",
    "learnRoutes",
    "/learn/understanding-by-design/performance-task-patterns",
    redirect("learn-performance-task-patterns", "/performance-task-patterns~vkqe6"),
  ),

  // instructorRoutes.
  nextRedirect(
    "/instructors/:instructor",
    "instructorRoutes",
    "/instructors/kent-c-dodds",
    redirect("instructor", "/q?instructor=kent-c-dodds"),
  ),
  nextRedirect(
    "/instructors/:id/feed",
    "instructorRoutes",
    "/instructors/kent-c-dodds/feed",
    build("feeds", FEEDS),
  ),
  nextRedirect(
    "/instructors/:instructor/:rest(.+)",
    "instructorRoutes",
    "/instructors/kent-c-dodds/edit",
    redirect("instructor-rails-subpage", "/q?instructor=kent-c-dodds"),
  ),
  nextRedirect("/instructors", "instructorRoutes", "/instructors", redirect("instructors", "/q")),

  // searchRoutes.
  nextRedirect("/search", "searchRoutes", "/search", redirect("search", "/q")),
  nextRedirect(
    "/s/:all*",
    "searchRoutes",
    "/s/abc12",
    build(
      "short-urls",
      "Rails short URLs; needs the Rails short-link table exported as a redirect map.",
    ),
  ),

  // legacyRoutes.
  nextRedirect(
    "/blog/manage-reactive-state-with-solid-js-signals",
    "legacyRoutes",
    "/blog/manage-reactive-state-with-solid-js-signals",
    redirect("blog-solid-signals", "/manage-reactive-state-with-solid-js-signals~7gwxg"),
  ),
  nextRedirect(
    "/user/subscription",
    "legacyRoutes",
    "/user/subscription",
    redirect("user-subscription", "/profile"),
  ),
  nextRedirect("/user", "legacyRoutes", "/user", redirect("user", "/profile")),
  nextRedirect("/membership", "legacyRoutes", "/membership", redirect("membership", "/profile")),
  nextRedirect(
    "/update_billing.html",
    "legacyRoutes",
    "/update_billing.html",
    redirect("update-billing", "/profile"),
  ),
  nextRedirect(
    "/sitemap.xml.gz",
    "legacyRoutes",
    "/sitemap.xml.gz",
    redirect("sitemap-gz", "/sitemap.xml"),
  ),
  nextRedirect("/oauth/:all*", "legacyRoutes", "/oauth/authorize", retire("rails-oauth")),
  nextRedirect(
    "/production/:all*",
    "legacyRoutes",
    "/production/anything",
    retire("rails-production"),
  ),
  nextRedirect(
    "/enhanced_transcripts/:all*",
    "legacyRoutes",
    "/enhanced_transcripts/123",
    retire("rails-enhanced-transcripts"),
  ),
  nextRedirect(
    "/articles/:all*",
    "legacyRoutes",
    "/articles/some-article",
    redirect("rails-article", "/blog/some-article"),
  ),
  nextRedirect(
    "/transaction_receipt/:all*",
    "legacyRoutes",
    "/transaction_receipt/123",
    build("commerce-paid-paths", "Rails transaction receipt. " + PAID_PATHS),
  ),
  nextRedirect(
    "/lesson_uploads/:all*",
    "legacyRoutes",
    "/lesson_uploads/new",
    retire("rails-lesson-uploads"),
  ),
  nextRedirect("/lessons/new", "legacyRoutes", "/lessons/new", retire("rails-lessons-new")),
  nextRedirect("/watch/:all*", "legacyRoutes", "/watch/123", retire("rails-watch")),
  nextRedirect("/users/:all*", "legacyRoutes", "/users/sign_in", redirect("rails-users", "/login")),
  nextRedirect("/koudoku/:all*", "legacyRoutes", "/koudoku/subscriptions", retire("rails-koudoku")),
  nextRedirect("/admin/:all*", "legacyRoutes", "/admin/users", retire("rails-admin")),

  // contentIndexRoutes: CourseBuilder serves these indexes itself.
  nextRedirect("/blog", "contentIndexRoutes", "/blog", served("/blog")),
  nextRedirect(
    "/blog/:slug",
    "contentIndexRoutes",
    "/blog/codemods-with-babel-plugins",
    served("/blog/[slug]"),
  ),
  nextRedirect("/podcasts", "contentIndexRoutes", "/podcasts", served("/podcasts")),
  nextRedirect("/lessons", "contentIndexRoutes", "/lessons", served("/lessons")),
  nextRedirect(
    "/browse/:context/:tag",
    "contentIndexRoutes",
    "/browse/frameworks/react",
    redirect("browse-tag", "/q/react"),
  ),
  nextRedirect(
    "/browse/:all*",
    "contentIndexRoutes",
    "/browse/frameworks/react/extra",
    redirect("browse", "/q"),
  ),
  nextRedirect(
    "/browse/:context",
    "contentIndexRoutes",
    "/browse/frameworks",
    redirect("browse", "/q"),
  ),

  // apiRoutes.
  nextRedirect("/api/v1/:all*", "apiRoutes", "/api/v1/lessons/123", retire("rails-api-v1"), {
    note: "Rails lessons#show still has heavy traffic from unknown callers; L1 caller census should confirm before the flip.",
  }),
  nextRedirect("/graphql", "apiRoutes", "/graphql", retire("rails-graphql")),

  // contentCrudRoutes.
  nextRedirect(
    "/downloads/:title/:rest(.+)",
    "contentCrudRoutes",
    `/downloads/${COURSE}/zip`,
    build("downloads", "Rails course download."),
  ),
  nextRedirect(
    "/playlists/new",
    "contentCrudRoutes",
    "/playlists/new",
    retire("rails-playlists-new"),
  ),
  nextRedirect(
    "/playlists/:title/:rest(.+)",
    "contentCrudRoutes",
    `/playlists/${COURSE}/edit`,
    retire("rails-playlist-subpage"),
  ),
  nextRedirect(
    "/podcasts/:title/:rest(.+)",
    "contentCrudRoutes",
    "/podcasts/developer-chats/edit",
    retire("rails-podcast-subpage"),
  ),

  // teamRoutes.
  nextRedirect("/team/:rest(.+)", "teamRoutes", "/team/members", redirect("team-rails", "/team")),
  nextRedirect("/invite/:all*", "teamRoutes", "/invite/abc123", retire("rails-invite")),
  nextRedirect(
    "/managed_subscriptions/:all*",
    "teamRoutes",
    "/managed_subscriptions/123",
    redirect("managed-subscriptions", "/team"),
  ),
  nextRedirect(
    "/saml-consume/:all*",
    "teamRoutes",
    "/saml-consume/acme",
    build("saml-sso", "SAML assertion consumer; a handful of logins."),
  ),
  nextRedirect(
    "/saml-login/:all*",
    "teamRoutes",
    "/saml-login/acme",
    build("saml-sso", "SAML login start."),
  ),
  nextRedirect(
    "/saml-metadata/:all*",
    "teamRoutes",
    "/saml-metadata/acme",
    build("saml-sso", "SAML service-provider metadata."),
  ),
  nextRedirect(
    "/saml_certificates/:all*",
    "teamRoutes",
    "/saml_certificates/acme",
    build("saml-sso", "SAML certificates."),
  ),

  // rssRoutes.
  nextRedirect(
    "/feed",
    "rssRoutes",
    "/feed",
    build("feeds", "CourseBuilder /feed is a one-item placeholder. " + FEEDS),
  ),
  nextRedirect("/lessons/pro_feed", "rssRoutes", "/lessons/pro_feed", build("feeds", FEEDS)),
  nextRedirect("/lessons/feed", "rssRoutes", "/lessons/feed", build("feeds", FEEDS)),
  nextRedirect(
    "/courses/:id/course_feed",
    "rssRoutes",
    `/courses/${COURSE}/course_feed`,
    build("feeds", FEEDS),
  ),
  nextRedirect(
    "/playlists/:id/playlist_feed",
    "rssRoutes",
    `/playlists/${COURSE}/playlist_feed`,
    build("feeds", FEEDS),
  ),
];

export function routeInventoryCounts(rows: readonly RouteInventoryRow[] = ROUTE_INVENTORY) {
  const byClass: Record<RouteParityClass, number> = { served: 0, redirect: 0, retire: 0, build: 0 };
  const byOrigin: Record<RouteOrigin, number> = {
    page: 0,
    app: 0,
    api: 0,
    "next-redirect": 0,
    middleware: 0,
    coursebuilder: 0,
  };
  for (const row of rows) {
    byClass[row.disposition.class] += 1;
    byOrigin[row.origin] += 1;
  }
  return { total: rows.length, byClass, byOrigin };
}
