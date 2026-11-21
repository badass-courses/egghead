# Stripe subscription shadow

This route observes Rails-owned subscription events. It never forwards to the CourseBuilder webhook, calls Inngest, imports an application database, creates a customer, or changes Stripe. CB-owned events produce a skip, not a would-do. The existing CB endpoint and its ownership/write gates remain unchanged.

## Provisioning after merge

The endpoint is **POST `/api/stripe/subscription-shadow`**. Exempt only that exact signed POST route from deployment protection. Do not exempt `/api/*`, the existing CourseBuilder webhook, GET requests, or the rest of the app. The handler verifies Stripe's v1 HMAC and a five-minute timestamp tolerance before configuring any reader or store. Invalid signatures return 400. Missing isolated configuration returns 503. No endpoint or protection settings are changed by this packet.

Provision these independent secrets through the deployment secret manager:

- `STRIPE_SHADOW_WEBHOOK_SECRET`: this endpoint's Stripe signing secret.
- `STRIPE_SHADOW_READ_KEY`: a restricted `rk_` key with GET permissions for events, customers, subscriptions, products, invoices and charges. The name and prefix do not prove read-only grants; the operator must provision those grants. The client exposes GET only.
- `STRIPE_SHADOW_REDIS_REST_URL` and `STRIPE_SHADOW_REDIS_REST_TOKEN`: a **dedicated external Redis REST database**, separate from all live customer tables and application storage. The adapter uses the Redis REST command protocol and atomic `EVAL` scripts. Its token needs only this database. It is never an app database connection.

There are **no reads of the main database**, so this path needs no `STRIPE_SHADOW_READER_DATABASE_URL` or writer connection. Do not wire `DATABASE_URL` into it. The recursive import-fence test covers the route, replay command, catalogue generator, and their transitive imports. Only pure shared Stripe-shape and ownership/access rules cross the boundary.

No production fallback to memory or local files exists. Without the dedicated store the endpoint retries rather than losing claims. `MemoryShadowStore` is for tests only. No new application table or schema deployment is required. Provisioning the separate Redis store and secrets remains an operator action.

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

The store claims the event ID **before** Stripe reads. Busy claims return an error so Stripe retries. A claim has a five-minute lease. Failures release only the caller's token; crashes recover after lease expiry. Completion atomically checks the token, writes the record with `HSETNX`, and makes the claim permanent. A duplicate yields no second record or console log. Counted skips are completed records too: a later catalogue change does not silently reclassify a previously claimed event. Review any intentional re-projection separately instead of deleting claims. An expired worker cannot complete or release its successor's claim. Completed records/claims have no TTL; retention must be an explicit operator decision that also preserves the dedupe horizon.

Redis hash `{subscription-shadow}:records` is the canonical record store, keyed by Stripe event ID. Console JSON is its queryable mirror. A crash after Redis completion but before console output can omit the mirror, but cannot duplicate the canonical record. Export the hash values as JSONL for comparison or log backfill. Provisioning must verify Redis persistence and backup; memory eviction or lost storage invalidates the idempotency guarantee. Never use an evicting cache for this store.

For Axiom/Vercel logs, parse the JSON message and filter `name` for `subscription.shadow.would-do` or `subscription.shadow.skipped`. Sum `count` by `eventType` and `reason`; alert on `tenantMetadataConflicts`, `unresolvedDeletedCustomers`, or `subscription.shadow.error`. Do not count skip rows as would-dos. The JSON object itself is valid JSONL. No Axiom credentials or dataset configuration are added here.

## Replay and catalogue refresh

From the repository root, with the isolated secrets already in the process environment:

```sh
pnpm exec tsx apps/web/src/subscriptions/shadow/replay.ts <from-epoch-seconds> <to-epoch-seconds>
```

The window is `[from, to)`. Stripe's event-list API only retains roughly 30 days. The command paginates the event log with the read key and dispatches through the same projection and external event claims. Replaying a completed event does not emit it again. Stdout is JSONL records; the completion summary goes to stderr. A failure exits nonzero; rerun the same window after fixing it. Keep records and claims intact between webhook and replay runs. Do not replay through the CB writer endpoint.

To regenerate candidate catalogue data:

```sh
pnpm exec tsx apps/web/src/subscriptions/shadow/regenerate-catalogue.ts > /tmp/egghead-shadow-catalogue.ts
```

The generator reads all subscription pages and products, selects active/past_due/trialing subscriptions with product metadata `site=egghead.io`, and prints only sorted product/price IDs. Review additions **and removals** before replacing `catalogue.ts`; do not remove historical products needed for refund/deletion replay just because no current subscription uses them. No customer data belongs in the checked-in output.

## Ordering fix and remaining comparison packet

The shared `reconcileBilling` ordering fix accepts a later `observedAt` even when the triggering event is older, retains the maximum event `createdAt`, and still rejects the current revision's duplicate event ID. Equal observation times use event creation and event-kind precedence. Terminal states stay terminal. Durable whole-history event-ID dedupe for shadow belongs to `ShadowStore`; the CB Inngest functions retain their existing idempotency.

The read-only Rails comparison command in `migrate-egghead/tools/me.ts` is a separate packet. It must group agreements/mismatches by event type, use sample subscription IDs only, and separate Rails/manual or invoiced subscriptions without a Stripe subscription from true mismatches. It must not conflate Stripe subscription IDs with Rails account-subscription IDs, nor treat unknown team/deleted-customer outcomes as grants or agreements.

Rollback: remove this endpoint's Stripe delivery configuration or unset its shadow secrets. Preserve the separate store for investigation. No ownership, live table, price, cancellation, refund, or checkout setting needs reversing.
