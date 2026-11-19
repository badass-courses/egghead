# egghead.io route parity for the domain flip

Every URL that egghead.io answers today must work on the CourseBuilder app, redirect on purpose, or be retired on purpose. The flip should cause no accidental 404s.

## Where it lives

- `apps/web/src/routing/route-inventory.ts` has one row per egghead-next route file (`pages/**`, `app/**`, API routes), per egghead-next `next.config` redirect (61), per middleware search rule, and per redirect CourseBuilder already shipped, at egghead-next `992ec9a1`. Each row has a sample path and a class.
- `apps/web/src/routing/legacy-redirects.ts` is the single rule table. Redirects are 308s. Retired paths go through a `beforeFiles` rewrite to `/api/retired/<id>`, which answers 410 for every method. The reason for each retirement stays in the table; responses name only the rule id.
- `apps/web/test/routing/route-parity.test.ts` (`pnpm routing:parity-contract`, part of `pnpm check`) loads the real Next config in a plain Node child and walks every row:
  - `served`: the named app route answers, with no rule in front of it;
  - `redirect`: the named rule matches first and lands on an app route;
  - `retire`: the named rule matches and the handler returns 410;
  - `build`: no rule from this table touches the URL, so its owner gets a clean path.

  It also fails on rules that no row explains, and on any rule that shadows a CourseBuilder route.

- `apps/web/test/routing/traffic-replay.test.ts` walks a list of real egghead.io paths (`fixtures/egghead-top-paths.txt`, paths only, highest traffic first) through the same table and route tree. Every path must be redirected, retired, owned by a build row, or answered by an app route.
- `pnpm routing:not-found:smoke --base <url>` checks HTTP statuses on a running server: unknown content URLs must 404, known ones must 200.

## Limits of the contract

The tests prove a URL reaches a route. They do not prove the route has content: root slugs such as `/some-course~abc12` always match `/[slug]`, so a redirect to a slug that is not in the database passes and 404s live. Literal redirect destinations were checked against the beta sitemap on 2026-11-19; the report lists any misses.

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
