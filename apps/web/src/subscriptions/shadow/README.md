# Stripe subscription shadow

This route observes Rails-owned subscription events. It never forwards to the CourseBuilder webhook, calls Inngest, imports an application database, creates a customer, or changes Stripe. CB-owned events produce a skip, not a would-do. The existing CB endpoint and its ownership/write gates remain unchanged.

## Provisioning after merge

The endpoint is **POST `/api/stripe/subscription-shadow`**. Exempt only that exact signed POST route from deployment protection. Do not exempt `/api/*`, the existing CourseBuilder webhook, GET requests, or the rest of the app. The handler verifies Stripe's v1 HMAC and a five-minute timestamp tolerance before configuring any reader or store. Invalid signatures return 400. Missing isolated configuration returns 503. No endpoint or protection settings are changed by this packet.

Provision these independent secrets through the deployment secret manager:

- `STRIPE_SHADOW_WEBHOOK_SECRET`: this endpoint's Stripe signing secret.
- `STRIPE_SHADOW_READ_KEY`: bind the existing restricted Stripe read key; do not create a separate shadow key. It needs GET permissions for events, customers, subscriptions, products, invoices and charges. The name and prefix do not prove read-only grants; the operator must verify them. The client exposes GET only.
- `STRIPE_SHADOW_DATABASE_URL`: a **separate PlanetScale MySQL database or branch**, with its own branch credential, never the main app's customer database. Connections enforce certificate-verified TLS. Redis/Upstash configuration is not supported.

The URL guard compares the normalized hostname and decoded, case-sensitive branch username against `DATABASE_URL` before connecting. A changed password, port, database path, URL encoding or query string cannot disguise the main branch credential. The guard also rejects the app's local fallback database. It imports no app database client and reads no app rows. A separate branch may contain empty copies of app tables; the adapter never references them.

The route must import and boot with every shadow variable absent: it returns 503 without configuring clients or recording anything. The cold-import regression test exercises the real route, not only its handler. Keep Next's default Node runtime: this app enables Cache Components, which rejects an explicit route-segment `runtime` export during production build. Run the production build as well as `pnpm check` after route changes. The full app's course prerendering still needs its ordinary content database; that is not a shadow dependency.

There are **no reads of the main database**, so this path needs no `STRIPE_SHADOW_READER_DATABASE_URL` or writer connection. Do not wire `DATABASE_URL` into it. The recursive import-fence test covers the route, replay command, catalogue generator, and their transitive imports. Only pure shared Stripe-shape and ownership/access rules cross the boundary.

No production fallback to memory or local files exists. Without the dedicated store the endpoint retries rather than losing claims. `MemoryShadowStore` is for tests only. Apply `migrations/0001-shadow-store.sql` **only to the separate shadow database/branch**, through the operator's schema deployment flow, not the main app migration pipeline. It creates only `ShadowEventClaim` and `ShadowRecord`; the route never performs DDL. The runtime credential needs SELECT/INSERT/UPDATE/DELETE on claims and INSERT on records. Comparison needs a separate SELECT-only credential. Records never expire. Keep backups and monitor database storage, connection count and transaction latency; place the database near the beta function's verified runtime region.

Protocol references: [Stripe's manual signature verification](https://docs.stripe.com/webhooks#verify-manually) and [event-list API](https://docs.stripe.com/api/events/list). The reader pins GET responses to API `2024-06-20`; Stripe event payloads retain their creation-time API version, so the resolver accepts both legacy and newer invoice references.

## Events

Subscribe this endpoint to exactly:

```text
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.paid
invoice.payment_succeeded
invoice.payment_failed
charge.refunded
charge.dispute.created
charge.dispute.updated
charge.dispute.closed
charge.dispute.funds_withdrawn
charge.dispute.funds_reinstated
customer.deleted
checkout.session.completed
```

## Tenant and ownership

`catalogue.ts` contains the reviewed egghead product/price allowlist from the read-only Stripe export dated 2026-11-21. Every subscription item must match a product or price. Unknown or mixed-tenant subscriptions produce a counted skip, never a would-do. Metadata alone cannot establish a match. Conflicting customer `site` or product `site` metadata vetoes an otherwise allowlisted match; `tenantMetadataConflicts > 0` is an alert. Non-subscription charges and checkouts are counted skips. Refund/dispute events follow charge → invoice → subscription, including newer invoice parent references.

Ownership uses the existing event-created-time customer timeline rule. It does not flip or update markers. A deleted customer's signed deletion payload retains the marker for that event. Other events whose customer read returns a tombstone are skipped with `unresolvedDeletedCustomers > 0`, because this isolated path cannot read the app's deletion archive. Do not interpret those skips as agreement.

## Record and access boundary

One completed event yields one JSON object with `name`, `stripeEventId`, `eventType`, `createdAt` (seconds), `observedAt` (milliseconds), counters, and a `subscriptions` array. Customer deletion can affect several subscriptions but still produces one event record. No raw payload, email, customer metadata, customer row, or secret is stored or logged.

Each would-do includes subscription id, status, period end, quantity, a seat-change observation, cancellation flag, strict paid-through verdict, and the target **`Entitlement.expiresAt` on `sourceType = rails_account_subscription`**. `expiresAt` is the ISO rendering of Stripe's paid-through seconds. It is the field the paid-through importer writes, not a second boundary. A denied verdict does not imply a new grant: an eventual writer must apply both status eligibility and expiry. This packet makes no entitlement writes. Wiring real writes to imported Rails grants remains behind the existing ownership flip and its cutover review.

The verdict reuses `strictPaidThroughRule` (ADR-0008). Past due, trialing, unpaid and boundary equality deny. Cancel-at-period-end retains access only while active and before the boundary. Refunds and disputes cause a fresh subscription read; they do not independently revoke access or initiate refunds. Team billing eligibility is recorded separately from `accessVerdict = unknown-team-roster`. No main DB read means no roster verdict. Quantity deltas use Stripe's `previous_attributes` only when present; otherwise the prior quantity/delta is unknown, not invented. Seat assignment/removal changes are not inferred.

This is an **observation-time projection**, not a reconstruction of historical state. Most events re-read current Stripe subscription state, like the existing CB lifecycle. Final subscription deletion uses its signed terminal payload. A replay records the current read at a new `observedAt`, not the period/status that existed at the event's original creation time. Comparison must respect those times.

## Claims, crash recovery and logs

The store claims the event ID **before** Stripe reads. `ShadowEventClaim.stripeEventId` is the unique primary key: INSERT chooses the initial winner. Busy claims return an error so Stripe retries. Each lease lasts five minutes on the database's UTC clock. Reclaim is a conditional UPDATE where the lease has expired and `completedAt IS NULL`; exactly one affected row means success. Failures release only the caller's still-incomplete claim. Completion conditionally updates by event ID, owner, unexpired lease and incomplete state, then INSERTs `ShadowRecord` in the same transaction. Insert failure rolls back the claim update. There is no upsert or overwrite. A duplicate yields no second record or console log. Counted skips are completed records too: a later catalogue change does not silently reclassify a completed event. Review intentional re-projection separately instead of deleting claims. A stale worker cannot complete or release its successor's claim. Completed records/claims never expire; retention must preserve the dedupe horizon.

`ShadowRecord` is canonical, keyed by Stripe event ID, with the JSON object in `record` and an indexed observation timestamp in `observedAt` (epoch milliseconds). Console JSON is its queryable mirror. A crash after MySQL commits but before console output can omit the mirror, but cannot duplicate the canonical record. Export the JSON values for comparison or log backfill. The schema adds no foreign keys, triggers or customer tables. Each store operation opens and closes its own isolated connection; Stripe reads hold no SQL transaction or connection open.

For Axiom/Vercel logs, parse the JSON message and filter `name` for `subscription.shadow.would-do` or `subscription.shadow.skipped`. Sum `count` by `eventType` and `reason`; alert on `tenantMetadataConflicts`, `unresolvedDeletedCustomers`, or `subscription.shadow.error`. Do not count skip rows as would-dos. The JSON object itself is valid JSONL. No Axiom credentials or dataset configuration are added here.

## Replay and catalogue refresh

From the repository root, with a verified read-only Stripe key injected as `STRIPE_SHADOW_READ_KEY`:

```sh
pnpm exec tsx apps/web/src/subscriptions/shadow/replay.ts --dry-run <from-epoch-seconds> <to-epoch-seconds>
```

The window is `[from, to)`. Stripe retains roughly 30 days. Replay lists every page through GET requests, sorts supported events oldest first by `created` (event ID breaks ties), and calls the same dispatcher as the signed webhook. Dry run claims and deduplicates events in memory for that invocation. It never reads DB configuration, and its observations are lost on exit. The Stripe account is shared: `listed` is an account-wide event count, not an egghead customer count. Supported events can produce would-dos or counted skips; unsupported types are counted separately. Stdout contains one per-type JSON summary, never records or IDs. Event and projection parse failures are counted separately; dry mode also counts other per-event processing failures. Any failure exits nonzero. A failed list request aborts replay rather than presenting partial coverage as complete.

For a census without projection, use `--events-only`. It permits only `GET /v1/events` on Stripe; projection and processing failure counters are `null` because the dispatcher is never called. The projection modes additionally permit only the exact customer, subscription, product, invoice and charge GET paths needed by shadow. Off-scope requests abort and redirects are rejected. Use a verified read-only key by default; narrower operator exceptions do not broaden the client's allowlist.

Only for a separately authorized backfill, use `--write-shadow` instead of `--dry-run` and bind `STRIPE_SHADOW_DATABASE_URL` to the isolated shadow store. This mode persists to `ShadowRecord`, uses the same durable event claims as the webhook, and also prints only counts. Keep claims intact between webhook and backfill so overlap does not create duplicate records. Do not replay through the CB writer endpoint. Neither mode reconstructs historical subscription state: the projection generally looks up Stripe state at observation time.

To regenerate candidate catalogue data:

```sh
pnpm exec tsx apps/web/src/subscriptions/shadow/regenerate-catalogue.ts > /tmp/egghead-shadow-catalogue.ts
```

The generator reads all subscription pages and products, selects active/past_due/trialing subscriptions with product metadata `site=egghead.io`, and prints only sorted product/price IDs. Review additions **and removals** before replacing `catalogue.ts`; do not remove historical products needed for refund/deletion replay just because no current subscription uses them. No customer data belongs in the checked-in output.

## Real MySQL concurrency proof

Run `pnpm subscription:shadow:mysql-test` only with access to the explicitly approved disposable fixture credential. The runner leases that fixed fixture secret in-process, never prints its URL, creates unique per-run versions of the two shadow tables, and drops both even on test failure. It never alters existing access-suite tables and does not accept an arbitrary database URL. The real shadow branch is for final schema readback, not tests. The proof covers concurrent deliveries, permanent completed claims, expired-owner rejection, exactly one lease reclaimer, and transaction rollback without canonical overwrite.

## Ordering fix and remaining comparison packet

The shared `reconcileBilling` ordering fix accepts a later `observedAt` even when the triggering event is older, retains the maximum event `createdAt`, and still rejects the current revision's duplicate event ID. Equal observation times use event creation and event-kind precedence. Terminal states stay terminal. Durable whole-history event-ID dedupe for shadow belongs to `ShadowStore`; the CB Inngest functions retain their existing idempotency.

The read-only Rails comparison command in `migrate-egghead/tools/me.ts` is a separate packet. It must group agreements/mismatches by event type, use sample subscription IDs only, and separate Rails/manual or invoiced subscriptions without a Stripe subscription from true mismatches. It must not conflate Stripe subscription IDs with Rails account-subscription IDs, nor treat unknown team/deleted-customer outcomes as grants or agreements.

Rollback: remove this endpoint's Stripe delivery configuration or unset its shadow secrets. Preserve the separate store for investigation. No ownership, live table, price, cancellation, refund, or checkout setting needs reversing.
