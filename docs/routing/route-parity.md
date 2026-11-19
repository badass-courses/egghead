# egghead.io route parity for the domain flip

Every URL that egghead.io answers today must work on the CourseBuilder app, redirect on purpose, or be retired on purpose. The flip should cause no accidental 404s.

## Where it lives

- `apps/web/src/routing/route-inventory.ts` has one row per egghead-next route file (`pages/**`, `app/**`, API routes), per egghead-next `next.config` redirect (61), per middleware search rule, and per redirect CourseBuilder already shipped, at egghead-next `992ec9a1`. Each row has a sample path and a class.
- `apps/web/src/routing/legacy-redirects.ts` is the single rule table. Redirects are 308s. Retired paths go through a `beforeFiles` rewrite to `/api/retired/<id>`, which answers 410 for every method. The reason for each retirement stays in the table; responses name only the rule id.
- `pnpm routing:parity-contract` (part of `pnpm check`) runs three test files under `apps/web/test/routing/`:
  - `route-parity.test.ts` loads the real Next config in a plain Node child and walks every inventory row. Served rows resolve to the named app route with no rule in front; redirect rows hit the named rule first and land on an app route; retire rows hit the named rule and return 410; build rows stay untouched. It also fails on unexplained rules and on rules that shadow a CourseBuilder route.
  - `traffic-replay.test.ts` walks a list of real egghead.io paths (`fixtures/egghead-top-paths.txt`, paths only, highest traffic first) through the same table and route tree. Every path must be redirected, retired, owned by a build row, or answered by an app route.
  - `not-found-guards.test.ts` keeps unknown content URLs on real 404s: no layout's module tree may read the session, no `loading.tsx` or `<Suspense>` may sit above a `notFound()` (except the listed known soft-404 pages), and no middleware may run outside the route model.
- `pnpm routing:not-found:smoke --base <url>` checks a running server over HTTP: unknown content URLs 404, known URLs 200, every redirect row 308s to its Location, trailing slashes take one hop, an incoming query merges into the destination query, every retire row 410s (HTML for pages, JSON for APIs, also on POST, HEAD and OPTIONS), and `/api/nav-account` answers signed out and, with `--session-cookie`, signed in. It also reports, without failing, what every build row answers today; on the local fixture 40 of 41 build rows 404 and `/feed` answers its one-item placeholder.

  Against beta, include an unknown entry under a known collection:

  ```sh
  pnpm routing:not-found:smoke --base https://beta.egghead.io \
    --known /effective-runtime-type-checks-with-zod-22abf5f9 \
    --known /cloud-infrastructure-fundamentals-with-aws-ee4bb845/aws-write-and-test-your-first-aws-lambda-function \
    --unknown /effective-runtime-type-checks-with-zod-22abf5f9/zz-missing-lesson \
    --redirect /blog/<an-unsuffixed-article-slug>=/<that-article-slug~suffix>
  ```

  Add `--session-cookie 'authjs.session-token=<a test session>'` to check the signed-in nav. Never paste a real customer's session.

## Classes

These counts are asserted against `routeInventoryCounts()` by `route-parity.test.ts`.

| Class    | Rows | Meaning                                                                                                                   |
| -------- | ---: | ------------------------------------------------------------------------------------------------------------------------- |
| served   |   24 | A CourseBuilder route answers the same path. `/privacy`, `/faq` and `/code-of-conduct` were built from egghead-next copy. |
| redirect |   89 | Moved to a CourseBuilder URL.                                                                                             |
| retire   |   58 | 410 on purpose.                                                                                                           |
| build    |   41 | No owner in CourseBuilder yet; see follow-ups.                                                                            |

## Behavior to know before the flip

- Trailing slashes: `next.config.ts` sets `skipTrailingSlashRedirect`, and `legacyRedirectsForNextConfig()` puts the trailing-slash redirect back after a trailing-slash copy of each legacy rule, so `/topics/` reaches `/q` in one hop. Check this on a Vercel preview before the flip; local `next start` is the only proof so far.
- `/articles`, `/articles/<slug>` and `/articles/<slug>/<anything>` go to `/blog` or `/blog/<slug>`. `/blog/<slug>` redirects to the article, including a unique `~suffix` match; an ambiguous or missing slug is a 404.
- Unknown `/workshop/<id>/<anything>` paths go to `/workshops`; workshop invoices and power-user reference pages stay build rows.
- Retired APIs answer `OPTIONS` with a 410 and no CORS headers. A browser preflight fails either way; a 204 would only tell non-browser clients the endpoint is alive.
- Malformed percent-encoding (`/%E0%A4%A`) gets a plain 500 from Next 16.2.5's router before any app code runs. Next means to answer 400 but cannot render `/400` in this app-router-only build. The smoke reports it.
- The first, uncached render of a page-level `permanentRedirect()` (the `/blog/<slug>` alias) sends the same `Location` header twice. Cached hits send it once. Browsers accept identical duplicates; the smoke reports them.
- Unknown content URLs answer a real 404. A server-side session read in the root layout used to turn every `notFound()` on a `generateStaticParams` route into a 500; the nav now reads account state from `/api/nav-account` in the browser.
- These pages still answer a soft 200 for unknown ids, because they call `notFound()` inside their own `<Suspense>`: `workshops/[id]`, `workshops/[id]/thanks`, `profile/[publicId]`, `profile`, `team/invite/[token]` and the `local/workshops` pages.
- Browsers cache 308s indefinitely. Reverting a wrong redirect does not reach visitors who already followed it. Retired 410s are cached for one hour.
- The tests prove a URL reaches a route, not that the route has content. Root slugs such as `/some-course~abc12` always match `/[slug]`, so a redirect to a slug that is not in the database passes and 404s live.

## Follow-up lanes (build rows)

| Lane                 | Rows | Size (agent-hours) | Notes                                                                                                                                                                  |
| -------------------- | ---: | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| feeds                |    6 | in flight          | Rails course, lesson and pro feeds. CourseBuilder `/feed` is a one-item placeholder.                                                                                   |
| instructor-feeds     |    3 | 2–4                | `/i/:slug/rss.xml` is live podcast-app traffic. Fold into the feeds lane.                                                                                              |
| commerce-paid-paths  |   13 | 15–25              | Invoices and receipts (the FAQ links `/invoices`), lifetime pages and checkout, workshop invoices, gift claims, email change, and the ownership-transfer accept route. |
| commerce-cutover     |    1 | in L3/L4           | `/api/stripe/webhook` is a registered Stripe endpoint.                                                                                                                 |
| saml-sso             |    4 | 10–16, or drop     | Few logins. Needs a build-or-drop decision.                                                                                                                            |
| downloads            |    2 | 4–6                | Member video and course downloads.                                                                                                                                     |
| workshop-reference   |    6 | 4–6                | Codex and Software Factory power-user reference pages sold with workshops.                                                                                             |
| integration-webhooks |    3 | 1–2 plus decisions | Re-point or drop Mux, Deepgram and Transloadit callbacks (L10).                                                                                                        |
| short-urls           |    1 | 2–3                | `/s/:id`; needs a Rails short-link export.                                                                                                                             |
| crm-unsubscribe      |    1 | 1–2                | `/unsubscribed` after a Customer.io decision.                                                                                                                          |
| static-pages         |    1 | 1–2                | `/write-for-egghead` uses form components.                                                                                                                             |
