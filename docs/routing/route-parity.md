# egghead.io route parity for the domain flip

Every URL that egghead.io answers today must work on the CourseBuilder app, redirect on purpose, or be retired on purpose. The flip should cause no accidental 404s.

## Where it lives

- `apps/web/src/routing/route-inventory.ts` has one row per egghead-next route file (`pages/**`, `app/**`, API routes), per egghead-next `next.config` redirect (61), and per middleware search rule, at egghead-next `992ec9a1`. Each row has a sample path and a class.
- `apps/web/src/routing/legacy-redirects.ts` is the single rule table. Redirects are 308s. Retired paths go through a `beforeFiles` rewrite to `/api/retired/<id>`, which answers 410.
- `apps/web/test/routing/route-parity.test.ts` (`pnpm routing:parity-contract`, part of `pnpm check`) loads the real Next config in a plain Node child and walks every row:
  - `served`: the named app route answers, with no rule in front of it;
  - `redirect`: the named rule matches first and lands on an app route;
  - `retire`: the named rule matches and the handler returns 410;
  - `build`: no rule from this table touches the URL, so its owner gets a clean path.

  It also fails on rules that no row explains, and on any rule that shadows a CourseBuilder route.

## Classes

| Class    | Rows | Meaning                                                                                                                                    |
| -------- | ---: | ------------------------------------------------------------------------------------------------------------------------------------------ |
| served   |   24 | A CourseBuilder route answers the same path. `/privacy`, `/faq` and `/code-of-conduct` were built in this lane from the egghead-next copy. |
| redirect |   84 | Moved to a CourseBuilder URL.                                                                                                              |
| retire   |   58 | 410 on purpose: VISION drops (bookmarks, Customer.io side effects), Rails tooling and APIs, egghead-next internals, campaigns.             |
| build    |   41 | No owner in CourseBuilder yet; see follow-ups.                                                                                             |

Rows by origin: 98 pages, 14 app routes, 32 API routes, 61 next.config redirects, 2 middleware search rules. Together they cover all 144 egghead-next route files.

## Limits of the contract

The test proves a URL reaches a route. It does not prove the route has content. Root slugs such as `/some-course~abc12` always match `/[slug]`, so a redirect to a slug that is not in the database passes the test and fails live. Destination slugs for the `learn-*` and `project-*` rules were checked against the beta sitemap on 2026-11-19.

## Found on beta (2026-11-19)

- An unknown single-segment path returns **500**, not 404 (`/faq` before this lane, `/definitely-not-a-real-slug-xyz`). Every legacy root URL that CourseBuilder lacks would 500 after the flip.
- An unknown `/:collection/:entry` pair returns 200 with a not-found body (a soft 404), because `[slug]/[entry]/loading.tsx` starts streaming first.
- `/blog/:slug` redirects to the bare `/:slug`. For content stored under a `~suffix` slug, that bare slug 500s. egghead.io 404s on the same bare slugs, so this matches today's behavior, but it is still a dead end.

## Follow-up lanes (build rows)

| Lane                 | Rows | Size (agent-hours) | Notes                                                                                                                                                                                |
| -------------------- | ---: | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| feeds                |    6 | in flight          | Rails course, lesson and pro feeds. CourseBuilder `/feed` is a one-item placeholder. `/lessons/feed` returns 500 on beta today because `/lessons/[slug]` catches it.                 |
| instructor-feeds     |    3 | 2–4                | `/i/:slug/rss.xml` is live podcast-app traffic. Fold into the feeds lane.                                                                                                            |
| commerce-paid-paths  |   13 | 15–25              | Invoices and receipts (the FAQ links `/invoices`), lifetime pages and checkout, workshop invoices, gift claims, email change, and the ownership-transfer accept route on top of #47. |
| commerce-cutover     |    1 | in L3/L4           | `/api/stripe/webhook` is a registered Stripe endpoint.                                                                                                                               |
| saml-sso             |    4 | 10–16, or drop     | Few logins. Needs a build-or-drop decision.                                                                                                                                          |
| downloads            |    2 | 4–6                | Member video and course downloads.                                                                                                                                                   |
| workshop-reference   |    6 | 4–6                | Codex and Software Factory power-user reference pages sold with workshops.                                                                                                           |
| integration-webhooks |    3 | 1–2 plus decisions | Re-point or drop Mux, Deepgram and Transloadit callbacks (L10).                                                                                                                      |
| short-urls           |    1 | 2–3                | `/s/:id`; needs a Rails short-link export.                                                                                                                                           |
| crm-unsubscribe      |    1 | 1–2                | `/unsubscribed` after a Customer.io decision.                                                                                                                                        |
| static-pages         |    1 | 1–2                | `/write-for-egghead` uses form components.                                                                                                                                           |
