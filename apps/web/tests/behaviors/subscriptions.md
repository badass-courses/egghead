# Subscription lifecycle seam

The writer remains local Docker only. Every membership write (checkout, Stripe/Inngest
reconciliation and the `/team` seat actions) passes one gate, `assertMembershipWritesAllowed`:
local Docker plus a Stripe test key. The `/team` page enables its forms by the same rule, and
`scripts/subscription-boundaries.ts` fails if a `/team` action skips the gate. This change does not add production writer ownership, a data import, a new
customer access promise, a table migration, or a dependency.

## Precondition for the production block

Blocking membership writes outside local Docker strands nothing only because no CourseBuilder
subscription exists yet. Desk evidence, 2026-11-18: CourseBuilder checkout has never run live;
no recent live Stripe checkout session came from CourseBuilder; the only live
CourseBuilder Stripe endpoint is beta's (`checkout.session.completed`,
`customer.subscription.created/updated/deleted`), and beta runs with `commerceWritesAllowed=false`.
So there are no CourseBuilder subscriptions to renew and no open CourseBuilder checkout sessions.
Re-check this before any deploy that lets CourseBuilder sell, and lift the block only through the
cutover gate. Lifting the block does not make CourseBuilder the writer for every subscription:
each event and command still routes by the Stripe customer's ownership marker (see "Ownership
seam").

## Ownership

- Stripe owns billing status, quantity, and the period end. Its adapter decodes one recurring
  subscription item, supports both period-field generations, and preserves the original
  checkout kind from `subscription_data.metadata.bulk` when available. An item without a
  quantity is recorded as `seatsReported: false`: an individual subscription reads it as one
  seat, a team raises `unsupported-stripe-shape` instead of being cut to one seat.
- A one-seat purchase whose paid quantity rises above one becomes a team and the owner keeps
  their seat. Teams never turn back into individuals.
- `Subscription.fields.membershipState` owns membership kind, owner, current assignments,
  an optional owner-selected reduction, the billing observation, and its event cursor.
  The roster is bounded to 100 unique users. Billing suspension does not remove assignments.
- Entitlements are the access projection. The store locks the subscription, loads its current
  roster, and atomically updates that projection and the authoritative state. Both prior grant
  identity schemes are retired in favor of one subscription/beneficiary ID.
- Inngest owns durable delivery and retries. A missing local row for a subscription we own, or a
  broken execution, throws and retries. Blocked environments, subscriptions the other system
  owns, and data no retry can fix are acknowledged instead (see "Never retry what cannot
  succeed"). Duplicate or older observations
  leave the locked state untouched. Final cancellation cannot reactivate the same subscription.
- Billing ownership is read separately from access eligibility, so an unpaid or canceled owner
  can still open billing. Team beneficiaries do not receive another person's billing portal.

## Capacity reductions

Owners save the target capacity and retained members on `/team` before changing billing.
Saving a plan leaves current access intact. A matching billing observation applies the selection
atomically; removed members do not return after capacity increases.

- A plan must lower capacity: `seats >= current seats` is refused, except when it resolves a
  capacity review (assignments above seats at the current quantity), which applies at once.
- A plan waits only for the next renewal. It records the period it was saved in; the first
  observation of a later period either applies it (matching quantity) or drops it.
- Members assigned after the plan was saved are kept: retained = the saved list plus later
  assignments. While a plan is pending, an assignment that would push that roster past the
  planned seats is refused as `full`.

An unplanned external reduction below the assigned roster pauses team access until the owner
chooses retained members. While it is paused, `/pricing` shows the owner a paused panel linking
to `/team` instead of "Your membership is active" (native test: paused after the cut, current
once the owner chooses). Checkout still refuses them as `existing`. A team stays a team at one seat. The owner does not receive an implicit
team seat. `subscriptionAvailableSeats` is the one availability rule: the seat writer and the
invite pages (`getTeamInviteDetails`, `getOwnedTeamSubscription`) both use it, so an invite never
shows a free seat that accepting would refuse. A legacy row without lifecycle state goes through
`rowAvailableSeats`, which runs the same legacy adoption the store runs under its lock (over every
grant, removed ones included, up to the adoption read limit); a row adoption cannot decode offers
no seats. Both `getTeamInviteDetails` and the owner's `/team` page (`getOwnedTeamSubscription`)
read every grant for this; the owner page lists only live grants as members. A legacy team with
no grants has no known period, so it shows 0, as the writer decides. Native test: a legacy row
whose member grant was soft-deleted during a suspension shows 0 seats and the writer answers
`full`; reading only live grants fails it.

Invites follow `subscriptionInviteState`: `open` exactly when seats are available (checked at
every step of the generated history), `paused` for a team waiting on billing (unpaid, paused,
incomplete, a lapsed period) or on the owner's capacity review, `full` for a full active team, and
`closed` for an ended team. The invite page and `acceptTeamInvite` say "This team is paused"
instead of "claimed" for a paused or suspended team (native test through capacity review,
unpaid, recovery and cancellation). `inviteTeamMember` refuses paused and closed teams as
unavailable. Owners of several teams can invite to any team they own: the action checks the
owner of the submitted subscription, not the newest team.

One membership row per user per organization. Under the subscription lock, the store locks the
user's existing rows in the organization (`FOR UPDATE`) and reuses the oldest (personal,
checkout or legacy); only when none exists does it insert one org-keyed row
(`lifecycleMembershipId(organizationId, userId)`), shared by every subscription there. A member
who leaves the roster loses that row only if the lifecycle created it and no other live grant
still uses it (a `FOR SHARE` read, since a plain read would see the pre-lock snapshot). Rows the
lifecycle did not create, including legacy random-UUID rows, are never removed; they confer no
access without a grant (see "Read paths").

Schema facts (CourseBuilder `adapter-drizzle` 3.1.3): `OrganizationMembership`'s only unique
index is `personalOrganizationUserId`, which lifecycle rows leave null; there is no unique
`(organizationId, userId)`, and `Entitlement.organizationMembershipId` has no foreign key. The
production PlanetScale schema is not verified here. A second row per user would still have
confused `findFirst` readers such as `ensurePersonalOrganization`, which is why rows are reused.
Native MySQL tests: two teams in one organization share one row per user, a row another team
still uses survives a departure, and an individual plus a team in one personal organization stay
independent.

The former grant-backed local data is adopted lazily under the same lock. Adoption reads at most
201 historical grant rows and refuses anything above 200 instead of silently truncating. It
recognizes explicit non-granting billing statuses for previously suspended grants. This is a local
compatibility adapter, not a production backfill or a reconstruction of ambiguous Rails history.

## Checks and remaining provider evidence

`pnpm subscription:behaviors` is part of `pnpm check`. It covers lifecycle histories, 4,000 generated
assignment/billing commands against an independent model, plus 7,200 generated commands covering
plans, capacity reviews, seat changes, period rollover and final cancellation against a reference
model that also checks page/writer availability agreement at every step (planting `>=` for the
plan's period rollover, or retaining every member, fails it), signed final-cancellation dispatch, transport failures,
blocked checkout, malformed billing, and Drizzle transaction/batching receipts. Boundary checks
reject caller-selected grant identity, caller-supplied seat billing facts, and Stripe/SQL checkout
orchestration in the Next pricing action.

The Drizzle receipt suite replaces only mysql2 I/O. A populated reconciliation with missing
memberships issues 10 statements for either 1 or 100 beneficiaries: begin, lookup, locked
subscription read, merchant/owner read, membership batch read, membership batch insert,
projection revocation, grant batch upsert, state update, commit. Local adoption adds one bounded
legacy read. Replays issue no mutations. Failed projection work rolls back and can retry.

The subscription primary key anchors serialization; merchant/customer primary keys anchor owner
reads, the entitlement `source_idx` anchors projection work, and the locked membership read uses
`organizationId_idx`. The lookup through `Subscription.merchantSubscriptionId` needs native plan
verification and may require a supporting index before scaling. No index or EXPLAIN result is
claimed without evidence.

Both a billing-suspension violation and per-member membership inserts were planted: the lifecycle
and statement-budget tests failed, respectively, and passed after restoring the implementations.

## Ownership seam

`subscriptions/ownership-seam.ts` wires the lifecycle to the ownership machine from #47
(`subscriptions/ownership/marker.ts`, `routing.ts`; ADR
`docs/adr/0001-subscription-ownership-handover.md`). The marker lives on the Stripe customer
(`egghead_owner_timeline`), so the decision is a Stripe read and happens before any row lock.

- Events are routed once (ADR §3). `decideEventOwnership` reads the customer marker and runs
  `routeStripeEvent` at the event's `created` time. Deletions are routed at receipt and the
  decision travels in the Inngest payload (`data.routing`); updates and checkout route in a
  memoized `route event ownership` step, so a retry never re-decides. A customer without a marker
  routes to Rails. Events the marker gives to Rails are acknowledged (`not-owner`, 2xx) before any
  billing read or database work.
- Reconciliation takes the routed decision (`{ owner, stripeCustomerId }`). Under the row lock the
  store checks the locked row's Stripe customer against the routed one; a mismatch (re-keyed during
  the lock wait) raises `customer-mismatch` and writes nothing.
- Seat commands and `inviteTeamMember` read the row's Stripe identity outside the transaction and
  ask `createCommandOwnership`, which applies #47's checkout rule: CourseBuilder owns the customer
  now and after every scheduled flip. Then the store locks the row and verifies the identity is
  unchanged; otherwise the command reads `not-found`. No row lock is held during the Stripe read
  (native test: a `FOR UPDATE NOWAIT` probe inside the seam succeeds).
- The checkout function routes before it creates any merchant, customer or subscription rows.
- The live read is tested against the real Stripe client the provider builds, with only the
  network methods (`customers`, `events`, `subscriptions` `.retrieve`) replaced on the SDK's
  resource prototypes. A marker read failure at the deletion seam answers 503 and logs
  `alert=deletion-dispatch-failed`, so Stripe redelivers.
- CourseBuilder `commerce` 0.2.3 publishes updates as `customerSubscriptionUpdatedEvent.parse`,
  and core 3.1.2's subscription schema requires `customer`, so updates reach the router with
  their customer and need no Stripe read for it (tested). It drops `created`, which the route step
  reads from Stripe.

Checkout (ADR §11.1–11.2): `getCheckoutCustomer` creates customers with
`cbBornCustomerMetadata()` (`cb@0`) and runs every customer, created or reused, through
`checkoutCustomerDecision`. A Rails customer, one with a flip scheduled either way, or an
unrecognized marker raises `CheckoutCustomerRefusedError`; checkout returns
`refused: billing-elsewhere` and the pricing page says billing is managed elsewhere
(`scripts/checkout-customer-smoke.ts` covers each reason). The refusal releases its sessionless
checkout reservation, so a retry with another plan is refused the same way instead of reading as
another checkout still open. The session and subscription metadata
carry `cbPaymentIntentFlag()`. ADR §11.2 says `payment_intent_data.metadata`, but
subscription-mode Checkout does not accept `payment_intent_data`; subscription charges carry the
customer, so they route by the customer marker anyway.

Deleted customers (ADR §14 L2). Deleting a Stripe customer cancels its subscriptions, so their
`customer.subscription.deleted` events arrive for a customer Stripe reports as deleted. The
deletion seam intercepts verified `customer.deleted` events and keeps the payload's marker keys
(`egghead_owner`, `egghead_owner_timeline`, `egghead_owner_generation`, nothing else) on that
customer's local subscription rows (`Subscription.fields.deletedStripeCustomerMarker`; no new
table), each row locked. A failed write answers 503 so Stripe retries. Routing for a deleted
customer then reads that record:

- recorded: route by its timeline at the event's `created` (basis `deleted_customer_record`);
- no local rows: Rails, since CB has nothing it could write for that customer;
- local rows but no record yet (Stripe does not order deliveries): pending. Once the event is
  older than Stripe's 3-day retry window, route to Rails and log
  `alert=deleted-customer-unrecorded`.

Pending is handled where the event is routed:

- At the webhook (deletions, dunning, refunds, disputes), it answers 503 and Stripe redelivers
  within its own 3-day window.
- In an Inngest step (updates and checkout), the step records `pending` instead of failing, so no
  retry is spent. The run then waits with `step.waitForEvent` for
  `egghead/stripe-customer-deletion-recorded` for that customer, an hour at a time, and routes
  again in a new step. The webhook sends that event after it records a `customer.deleted` that
  marked local rows. A lost send only delays the run to its next hourly check. A waiting run
  holds no concurrency slot (Inngest releases it while a run sleeps or waits), so other events
  for the subscription keep flowing. Once the window passes, the seam's Rails fallback ends the
  wait. A cap of 80 waits rethrows as a backstop.

Where writes are blocked, `customer.deleted` is forwarded to CourseBuilder and the marker is not
kept (no customer can be CB's then). Every Stripe
endpoint CB receives on must subscribe to `customer.deleted`. Native test: a CB customer deleted in
Stripe refuses to route before its record, routes to CB after it, and its cancellation revokes
every grant.

Flip guards (ADR §14 L3, in `ownership/machine.ts`): no flip in either direction while the
customer has draft or open invoices, pending invoice items, a not-started or active subscription
schedule, an open dispute or a pending refund, or while any of those Stripe lists came back
truncated. Charges are paged with `starting_after` until `has_more` is false, up to 20 pages
(2,000 charges), so a long-tenured subscriber's old disputes and refunds are still seen; past the
cap the facts stay incomplete. `ownership/billing-in-flight.ts` gathers the facts (tested with a
fake client, including a 250-charge customer with a dispute on an old charge); the
effect runner that calls it is not built. A further handover guard, `cb_writes_blocked`, refuses
any flip to CB while CB's membership writes are blocked (the cutover rule).

Dunning, refunds and disputes (ADR §14 L4). CourseBuilder's published handler acts on some of
these: `@coursebuilder/commerce` 0.2.3 records every event as a `MerchantEvent`, marks a fully
refunded purchase `Refunded` on `charge.refunded` and a purchase `Disputed` on
`charge.dispute.created`, workshops included. So the webhook seam forwards every
`invoice.payment_failed`, `charge.refunded`, `charge.dispute.*` and `customer.deleted` event to
CourseBuilder first, in every runtime and whatever it decides. A CourseBuilder failure is returned
as is (Stripe retries, the seam does nothing); a seam failure after a good forward answers 503, so
Stripe retries and CourseBuilder's idempotent status update runs again. Where writes are blocked
the seam does nothing more. Otherwise it reads the verified event, finds the customer and subscription (`billing-signals.ts`: from the payload when
present, else through the pinned Stripe client: charge, then invoice, then subscription), and
routes at receipt like any event:

- Rails-owned: acknowledged, nothing published.
- CB-owned with a subscription: published as `egghead/stripe-billing-signal`, shaped like a
  subscription event, so the billing function re-reads that subscription's live Stripe state and
  reconciles it under the same per-subscription concurrency key. Dunning reaches access through
  the status and paid-through boundary: `past_due` keeps access while `current_period_end` is
  strictly future, then suspends at that boundary; `unpaid` suspends immediately. The Rails
  access delta uses the same rule. Refunds and disputes log `receipt=billing-signal-receipt` at info
  with Stripe ids only, for support.
- CB-owned with no subscription (a one-off charge), or a signal whose subscription has no local
  row (a charge from before CB held it, ADR §12): an unmatched receipt
  (`alert=unmatched-refund-or-dispute`, `unmatched-payment-failure` or
  `unmatched-billing-signal`), no retry.
- A Stripe read or routing failure answers 503; blocked environments acknowledge and skip.

A refund or dispute does not itself revoke access: that would be a new access promise, and this
lane does not decide it. Every CB Stripe endpoint must subscribe to these event types.

Open, with sizes (agent hours; each can run in parallel unless noted):

- L1 (guard re-check before a flip): the flip writer is not in this slice; the store's
  under-lock customer check is the lifecycle half. Belongs to the flip lane.

## Never retry what cannot succeed

- Writes blocked (beta and production today): the deletion seam answers 2xx
  `{ received: true, skipped: "writes-blocked" }` and both Inngest functions return
  `skipped: writes-blocked` before any Stripe read. Stripe never sees a 5xx for a no-op.
- Data errors (`SubscriptionDataError`): a multi-item or otherwise unsupported Stripe
  subscription, a Rails status outside the lifecycle enum, non-object grant metadata, a stored
  state that no longer decodes, a row without an organization, Stripe subscription or owner, a
  locked row that belongs to another Stripe subscription, and either roster budget overrun. The
  step completes with `skipped: <code>`; a seat command reads them as `not-found`. Only a missing
  local row for a subscription we own still retries, because checkout writes it.
- If one Stripe subscription ID matches more than one local row, the lookup reconciles the oldest
  (`ORDER BY createdAt, id`) and logs `alert=duplicate-stripe-subscription`.
- Checkout failures (including the pricing action's catch) log `safeErrorSummary`: the error's
  name and Stripe `type`, `code` and `decline_code`. The message is logged only for a
  `FixedMessageError`, the class our own code throws with fixed strings. A plain `Error` proves
  nothing: mysql2 raises server errors that way ("Duplicate entry '<email>' ..."), so Stripe,
  database and every other error logs no message.
- A local row that stays missing (`SubscriptionNotReadyError`) retries; when Inngest gives up, the
  failure handler logs `alert=not-ready-retries-exhausted` (any other exhausted failure logs
  `alert=retries-exhausted`), with the event ID and error name, never the message.
- Every skip logs one `[egghead-subscriptions] skipped reason=...` line; data errors add
  `alert=true` and log at error level.

## Webhook seam

The deletion seam in front of the CourseBuilder Stripe handler only claims verified
`customer.subscription.deleted` events. Any other event, a missing signature, missing Stripe
configuration, or a signature its secret cannot verify falls through to the CourseBuilder handler,
which verifies again. It finds Stripe verification by shape (`webhookSecret` plus
`stripe.webhooks.constructEvent`), not by `instanceof`, so a second bundled copy of
`@coursebuilder/commerce` cannot silently disable it. The writer guard reads the same
`STRIPE_SECRET_TOKEN` key, through `getEnv`, as the CourseBuilder Stripe provider. The workshop relay, the seam and the CourseBuilder provider all read the same
`STRIPE_WEBHOOK_SECRET`. The relay reads `request.clone()`, so the seam and CourseBuilder still see
an unread body. `scripts/subscription-route.test.ts` drives the real route `POST` on beta and
production (deletion → 2xx, nothing sent; checkout, update and workshop events reach CourseBuilder
with their body) and in local development (deletion still reaches the writer through the relay).

## Read paths

`getCurrentSubscriptionForUser` checks Stripe-customer ownership, then a current team the user
owns in one of their organizations, then live seat grants. Organization membership alone makes
nobody a beneficiary: main treated every member of an org holding a non-team subscription as its
beneficiary, so a teammate in a buyer's personal org read as subscribed through the buyer's
individual plan, even while their team was paused or suspended. Native tests cover the teammate
through an active, paused and suspended team, and an org member without a grant. This narrows
what `/pricing`, the thanks page and checkout's `existing` refusal see; content access comes from
grants (`access/evaluate.ts`) and is unchanged. Beta users who read as subscribed only through
main's membership rule now read as unsubscribed on those pages. Rows the lifecycle writes carry
an explicit team classification (`membershipKind`), so a one-seat team stays a team; only
unmarked legacy rows use main's seat-count rule. A NULL
`expiresAt` means no expiry only for `egghead_all_access_subscription` grants. Callers:
`app/pricing/page.tsx`, `app/thanks/subscription/page.tsx` and `subscriptions/checkout.ts`.
`getBillingSubscriptionForUser` prefers a current row (active, past_due, trialing) over a newer
non-current one. `getTeamMembershipForUser` uses the same NULL-expiry rule.

The pricing page offers Subscribe only where the membership writer can fulfil checkout
(`pricingPanel`); in beta and production it shows a plain closed state.

Grant metadata readers: `access/evaluate.ts` reads `status`, `sellableId`, `sellableType` and
`restrictedToCountry`; `persist` writes `status`, `productId` and `stripeSubscriptionId`. Nothing in
the repo reads `teamSeat`, `stripeEventCreatedAt`, `stripeEventKind` or `stripe_ent_` IDs; the
support readback's `teamSeat` is a computed field keyed on `rails_account_subscription`.

## Native MySQL receipts

`pnpm subscription:mysql-test` runs the real store against a disposable local MySQL 8 database.
It is opt-in and not part of `pnpm check`, because CI has no MySQL; the mocked store suite's
`for update` assertion is the standing guard. Run it before changing the store, the lifecycle or
the read paths:

```sh
# an existing, disposable database whose name ends in _test, on a UTC server
SUBSCRIPTION_MYSQL_URL=mysql://root:root@127.0.0.1:3307/coursebuilder_subscription_test \
  pnpm subscription:mysql-test
```

The URL must pass the local Docker guard. The plan test toggles `general_log`, which needs
`SYSTEM_VARIABLES_ADMIN` or `SUPER`; run it as the fixture's root user. It applies the schema with a non-forced `drizzle-kit push`, writes run-unique rows
next to 2,000 unrelated filler subscriptions, and deletes nothing. On MySQL 8.4.11 it proves:

- 12 concurrent claims on a five-seat team with one assigned seat: exactly 4 `assigned` and 8
  `full`, and the roster, grants and memberships match.
- A transaction holding the subscription row `FOR UPDATE` blocks both a removal and a renewal for
  400 ms. After it commits, both apply, and the renewal keeps the removal.
- A server-side failure (a trigger raising `SQLSTATE 45000` on the grant insert, after the
  membership insert and grant revocation already ran) rolls back state, grants and memberships.
  The same command then succeeds.
- Stale and duplicate observations leave the committed row byte-identical. Final cancellation
  revokes every grant and a later update cannot restore it. Planned reductions apply on the
  matching quantity and stay applied after regrowth. Unplanned reductions pause access until the
  owner selects a roster.
- A Stripe-shaped subscription object decodes through `normalizeStripeBillingSnapshot` and
  lands as the expected grant ID, status and UTC period end.
- Commands ask the ownership seam with the row's Stripe identity before taking the row lock
  (a `FOR UPDATE NOWAIT` probe inside the seam succeeds), and a refusing seam writes nothing.
- Read paths: a NULL-expiry seat counts, a live subscription wins over a newer canceled one for
  billing, and organization membership alone grants nothing (only an owned team or a live
  seat grant does).
- A Stripe customer re-keyed while the store waits for the row lock: reconciliation raises
  `customer-mismatch` and a seat removal reads `not-found`; neither writes.
- Two teams in one organization, and an individual plus a team in one personal organization,
  keep each other's memberships and grants through removals and renewals.
- Concurrent writers of different subscriptions in one organization can deadlock on the
  grant upsert (MySQL 1213, next-key locks). MySQL rolls the loser back whole, and the store
  reruns the transaction on 1213 or 1205 (lock-wait timeout), up to three attempts with
  jittered backoff, for reconcile and every seat command. Four teams racing reconciles,
  assignments, removals and renewals all apply; with one attempt the same test fails in most
  runs. Past three attempts the error surfaces (Inngest retries a reconcile).
- A one-seat team stays a team: a member removed by a planned reduction loses the membership row
  and the current subscription, and another org member is not treated as its owner.

Planted fault: removing `FOR UPDATE` from the locked read fails both concurrency tests.

Query plans (EXPLAIN of the statements captured from the general log during one reconciliation):

| Statement                                          | Access                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Lookup by Stripe subscription ID (before the lock) | `Subscription` **ALL** (full scan, 2,040 rows), `MerchantSubscription` eq_ref PRIMARY |
| Locked subscription read                           | const PRIMARY                                                                         |
| Merchant and owner read                            | const PRIMARY on both                                                                 |
| Membership batch read (locked)                     | ref `organizationId_idx`                                                              |
| Grant revocation                                   | range `source_idx`                                                                    |
| Subscription state update                          | range PRIMARY                                                                         |

The locked path is index-anchored. The published CourseBuilder schema has no index on
`Subscription.merchantSubscriptionId`, `MerchantSubscription.merchantCustomerId` or
`MerchantSubscription.identifier`, so without the lifecycle indexes the pre-lock webhook lookup
scans `Subscription` once per webhook (the checkout function reads the same columns), and two
page read paths scan on every view: `getCurrentSubscriptionForUser`'s customer branch and
`getBillingSubscriptionForUser`. With only a `Subscription.merchantSubscriptionId` index the scan
moves to `MerchantSubscription`; it needs `merchantCustomerId` too. The seat grant branch
(`userId_idx`), `getOwnedTeamSubscription` and `getTeamInviteDetails` were already
index-anchored.

Shipping: `apps/web/src/db/lifecycle-indexes.ts` wraps the table factory passed to
`getCourseBuilderSchema` (the adapter has an override hook only for users), so
`apps/web/src/db/schema.ts` declares all three indexes and `drizzle-kit push` creates them. A
renamed upstream column fails the build instead of skipping its index. The native test asserts
the three indexes exist after the suite's push and that the four read paths do no full scan of
either table; with the two read-path indexes dropped, the scans come back.

drizzle-kit 0.28.1 push against MySQL also drops and re-adds the primary key on every table that
names one, on every run, even with no schema change (seen on the disposable database: 28
`DROP PRIMARY KEY` / `ADD PRIMARY KEY` pairs on a no-op push). On a populated PlanetScale branch
that is a rebuild of most tables, so apply these indexes there as the three statements below
(or a deploy request carrying them), after checking `SHOW INDEX` for existing equivalents:

```sql
CREATE INDEX `merchantSubscriptionId_idx` ON `egghead_Subscription` (`merchantSubscriptionId`);
CREATE INDEX `merchantCustomerId_idx` ON `egghead_MerchantSubscription` (`merchantCustomerId`);
CREATE INDEX `identifier_idx` ON `egghead_MerchantSubscription` (`identifier`);
```

Time zones: Drizzle writes `timestamp` values as UTC wall-clock text. On a server whose session
time zone is not UTC, raw `mysql2` reads shift by the offset while Drizzle reads round-trip.
Docker MySQL and PlanetScale default to UTC; run local fixtures in UTC.

## Still unproven before production

- Delivery through a running Inngest server and real Stripe test-mode events or test clocks.
  The repo has no Stripe test keys, so these remain contract tests: signed deletion dispatch,
  seam fall-through, and Stripe-shaped decoding into native MySQL.
- Lock behavior on PlanetScale (Vitess) rather than single-node MySQL 8.4.
- Plans and lookup cost at production row counts, and the production schema's actual indexes.
- Adoption of real Rails-era subscription rows; adoption here is a local compatibility adapter.
