# Standalone Egghead CourseBuilder App

This is the standalone Egghead CourseBuilder integration app for the Rails-exit migration.

Canonical repo:

```txt
/Users/joel/Code/badass-courses/egghead
```

During migration work it is mirrored into:

```txt
/Users/joel/Code/skillrecordings/migrate-egghead/egghead
```

## Runtime and write authority

Production runtime and the primary-domain read flip remain blocked. Local development uses
local Docker MySQL. Beta connections require the approved PlanetScale target and
`EGGHEAD_BETA_DB_APPROVED=true`; that flag alone does **not** authorize application writes.

| Operation                                                 | Local Docker                 | Approved beta                                                      | Production |
| --------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------ | ---------- |
| Database connection / reads                               | Allowed                      | Approved PlanetScale target only                                   | Blocked    |
| Auth, account and profile mutations                       | Allowed                      | Additionally requires `EGGHEAD_BETA_ACCOUNT_WRITES_APPROVED=true`  | Blocked    |
| Persisted learner progress                                | Allowed                      | Additionally requires `EGGHEAD_BETA_PROGRESS_WRITES_APPROVED=true` | Blocked    |
| DDL / local table creation                                | Allowed                      | Blocked                                                            | Blocked    |
| Checkout, Billing Portal, subscription and team mutations | Allowed, Stripe sandbox only | Blocked                                                            | Blocked    |
| Stripe webhook / Inngest commerce boundary                | Local only                   | Blocked                                                            | Blocked    |

Database credentials still determine actual SQL privileges. A successful `/api/health/db`
`SELECT 1` proves connectivity, **not** read-only credentials or authorization to mutate.
`/api` and `/.well-known/coursebuilder-app` describe the application policy; their flags are
not deployment approval receipts. Search indexing requires its own explicit approval below.
Use published `@coursebuilder/*` packages, never CourseBuilder `workspace:*` reach-through.

Run:

```bash
pnpm install
pnpm phase0:imports
pnpm --filter @egghead/web dev
```

## Local Stripe subscriptions

The subscription flow uses hosted Stripe Checkout. The app's guarded CourseBuilder endpoint
awaits Stripe signature verification before publishing supported events to Inngest. The Egghead
handler creates local subscription records and grants access only with paid/trial-through proof. A checkout quantity
of two or more creates a team subscription: the seat count and owner are stored on the local
subscription, and access is assigned from `/team` rather than granted to the purchaser implicitly.

Configure these values in `apps/web/.env.local`:

```bash
STRIPE_SECRET_TOKEN=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
INNGEST_EVENT_KEY=
INNGEST_SIGNING_KEY=
```

The pricing page discovers active CourseBuilder products whose type is `membership`. Each product
must have a recurring Stripe price connected through CourseBuilder's `MerchantProduct` and
`MerchantPrice` rows. Both mapping rows must be active with `status = 1`. The product also needs a
`month` or `year` `billingInterval`, and the database must contain the Stripe `MerchantAccount` row.

Run the app and the Inngest dev server in separate terminals:

```bash
pnpm --filter @egghead/web dev
pnpm dlx inngest-cli@latest dev --no-discovery -u http://localhost:3008/api/inngest
```

Forward Stripe test-mode webhooks to the CourseBuilder endpoint:

```bash
stripe listen --events checkout.session.completed,customer.subscription.updated,customer.subscription.deleted,invoice.paid \
  --forward-to http://localhost:3008/api/coursebuilder/webhook/stripe
```

`invoice.paid` is required for renewal: a subscription update may arrive while the renewal
invoice is still unpaid, and successful payment need not change an already-active status.
The payment event reconciles the current subscription through the same locked lifecycle path.

Copy the `whsec_...` value printed by Stripe CLI into `STRIPE_WEBHOOK_SECRET`, restart the
web app, sign in, and open `/pricing`. Use the **Seats** input to select two or more seats, then
click **Subscribe for {quantity} seats** to send that quantity to Stripe Checkout. The checkout
success page waits for the durable webhook handler to create the subscription, then links to
`/team`, where the owner explicitly claims a seat, sends email-scoped invitations, revokes
invitations, or removes members. Invitations expire after seven days and acceptance allocates
a seat; sending an invitation does not reserve one.

There is no app-owned add-seat UI. Stripe Portal quantity editing is external configuration,
not an assumed capability. Keep self-service shrink disabled; support must reconcile assigned
members before reducing capacity. A web deployment rollback does not reverse a Stripe change.

Then from `migrate-egghead`:

```bash
bun tools/me.ts egghead standalone check --url http://localhost:3008 --json | jq .
```

## Typesense search index

The configured collection selects the read contract explicitly: `TYPESENSE_COLLECTION_NAME`
takes precedence over `NEXT_PUBLIC_TYPESENSE_COLLECTION_NAME`, with
`egghead_content_migration_v1` as the default. There is no schema guessing or field-name retry.

- **`content_production` uses the existing legacy index without rewriting it.** Queries search
  `title`, `description`, `summary`, and `instructor_name`; exact instructor filters use indexed
  `instructor_name` values. App course filters select `type=playlist`, and playlist hits render as
  courses. IDs are preserved, recognized legacy paths such as `/playlists/<slug>` become app
  paths, and already-modern root/nested paths are retained. Results and instructor facets share
  the app-supported content-type scope. Publication eligibility relies on publisher-controlled
  index inclusion, not timestamp filtering: some published courses have zero publication
  timestamps. Legacy read errors propagate rather than silently switching to SQL
  or returning an unrelated catalog. No legacy reindex is required.
- **All other collection names use the canonical migration contract.** Search documents include
  `body`, every content contributor in `instructorNames`, and a normalized `instructorKeys`
  facet. Text queries search instructor display names, while instructor filters use normalized
  keys. SQL remains a search availability fallback when Typesense is not configured or a
  canonical Typesense read errors; it is not a fallback for configured legacy read errors.

Both default and typed dropdown suggestions use `GET /api/instructors`, which returns
`{ "instructors": [{ "name": "John Lindquist", "resourceCount": 33 }] }` (illustrative count).
With configured `content_production`, discovery reads instructor facets from that same index;
canonical and no-Typesense configurations retain SQL instructor discovery. Names are normalized,
encoding variants are merged, and name searches fold accents. The operation returns up to six
default suggestions, or up to eight matching suggestions for `?q=<name>`. Unknown names return
an empty list. Lookup failures propagate as errors, not successful empty results; the dropdown
shows "Unable to load instructors." rather than retaining stale suggestions.

Existing canonical collections missing `instructorNames`/`instructorKeys` need schema provisioning
and a full reindex before indexed instructor search is available. Deploying source alone does
not create those fields or contributor data. For the guarded migration collection, recreation
and reindexing use:

```bash
EGGHEAD_TYPESENSE_INDEX_APPROVED=true pnpm search:typesense-index --recreate
```

Do not run that command against a shared or production collection without explicit authorization.

## Release-readiness scope

This work follows the [EH readiness brief](https://lusty-ginger-pm3d.here.now/), not a production
launch approval. The conservative policies proposed for review are:

- **D1 — Catalog:** retain separately mapped monthly/yearly memberships. Consolidating Stripe
  products is not a data-only cleanup: checkout and webhook resolution must remain unambiguous.
- **D2 — Access:** honor paid-through access for scheduled period-end cancellation; revoke at
  effective terminal cancellation. A failed payment must not advance the last proven paid or
  trial-through boundary. No additional unpaid grace is approved by this PR. Recovery restores
  billing-revoked grants, never deliberately removed team members.
  This fail-closed default can interrupt access between paid-through expiry and invoice
  settlement; any additional grace window needs a separately reviewed policy.
- **D3 — Teams:** explicit owner claiming, allocation on acceptance, seven-day email-scoped
  single-use/revocable invitations, and no self-service shrink. Older timeless invitation links
  are intentionally invalid; owners must issue new invitations.
- **D4 — Privacy:** defer public learner profiles/activity, including data reads, metadata and
  OpenGraph. Private account and progress functions remain supported.
- **D5 — Continuity:** preserve existing database user, Stripe customer and subscription
  identities. Do not import dormant users/history or create replacement subscriptions. The
  migration owner must supply active/paid-customer reconciliation before cutover.
- **D6 — Authority:** approve connection, account writes, progress writes, commerce writers,
  indexing and traffic independently. This PR does not grant any deployment permission.

### Required receipts and owner roles

| Package | Owner role                             | Required acceptance evidence                                                                                                                                                 |
| ------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EH-R1   | Runtime/DB + Release                   | Operation-by-runtime denial/allow matrix, including adapter, Portal, webhook and DDL boundaries                                                                              |
| EH-C1   | Commerce/CourseBuilder                 | Product → MerchantProduct → MerchantPrice → Stripe mapping and account mode; monthly/yearly price/amount/quantity; inactive and mixed-mode rejection                         |
| EH-C2   | Subscriptions/Teams                    | Personal/team renewal, cancellation, recovery, ordering, seat races, removal and quantity transitions; no double-payable checkout sessions                                   |
| EH-A1   | Access/Migration                       | Personal subscriber, unseated owner, valid/removed seat, organization-only member, canceled legacy, lifetime, playlist/country and quarantine cohorts; denied media readback |
| EH-I1   | Auth/Security                          | Real email/OAuth identity continuity, magic-link expiry/replay, scoped/expired/revoked invite rejection and usable remaining sign-in method                                  |
| EH-L1   | Learning/Product                       | Cross-session complete/uncomplete, course synchronization and empty/partial failure cases; owner-only reads and closed public page/metadata/OG                               |
| EH-R2   | Release/Operations + Migration/Support | Local contracts/build, separately approved beta receipts, cohort reconciliation, writer handoff and rollback rehearsal                                                       |

These roles identify required reviewers, not approval or commitments from named people.
The release lead must name the operational approvers before enabling any new authority.

Local function/fixture contracts are not deployed end-to-end receipts. Record their command,
source SHA and result separately from a real sandbox Checkout → webhook → Inngest → database
rows → browser-access trace. Real callback, customer-continuity and service-configuration
receipts require authorized test identities and the external migration owner.

For beta, record the exact deployment URL/SHA, runtime, database target and permitted write
families. Select the Vercel project root explicitly: repository-root configuration builds
`apps/web/.next`; the `apps/web` configuration builds `.next`. Two files do not prove which
configuration an existing project uses. Do not replay beta commerce while it remains blocked.
`builder:smoke` can skip the beta probe; only claim a beta receipt from a required, successful
probe with the separately leased/approved environment.

### Verification recorded for this PR

The implementation is reviewable, but release acceptance remains blocked. The PR description
records the exact implementation commit; no real customer data or credentials are fixtures.

- `pnpm check`: both TypeScript compilers, strict lint, formatting, existing contracts and
  the new runtime, checkout, lifecycle, identity and progress contracts pass locally.
- `pnpm readiness:regression`: 97 regressions through real application entry points, included
  in `pnpm check`. Test-only commit `4c67b8e` was cherry-picked onto pre-implementation
  `fab0259` as `d3f3026`: all 97 fail with assertion errors there, then the identical 97 pass
  on implementation `88aa2be` plus the test commit. No cases skip or cancel. The committed
  test trees are identical; no implementation files were cherry-picked. Persistence and
  provider boundaries remain synthetic: this does not prove live database locking,
  Stripe charges, or Inngest delivery/deduplication.
- Checkout contracts cover slow concurrent creation, changed selection, lost responses,
  failed expiration, current-state retrieval after idempotency replay, expired key retention,
  exact canceled-subscription association, and ambiguous catalog rejection. These demonstrate
  the no-double-payable invariant against a synthetic provider, not a Stripe charge receipt.
- Lifecycle and progress contracts demonstrate ordering, paid-through proof, deliberate seat
  removal preservation and rollback behavior with synthetic state/transaction responses.
  The optional real-database lifecycle mode and cross-session persistence were not run.
- A real local Next.js server returned session `200`, anonymous purchases `401`, unsupported
  checkout/SRT/unknown operations `403`, and unsigned Stripe webhook `400`. This smoke found
  and fixed request reconstruction failing on Next.js's instrumented `NextRequest`.
- The same server, restarted with unapproved beta policy and synthetic configuration,
  advertised all operations denied and returned `403` for session, checkout and webhook.
  This is a local policy exercise, not a deployed beta or database-privilege receipt.
- Browser inspection confirmed public profiles return `404` with `noindex, nofollow`, public
  OpenGraph returns `404`, and private profile/progress routes resolve to sign-in without
  learner activity. Authenticated learning/team screens still require database-backed proof.
- `pnpm build` compiles the production bundle, then fails collecting page data because local
  MySQL at `127.0.0.1:3307` is unavailable. A full production-build receipt is still required.
  Turbo now forwards the declared application environment and tracks dotenv files rather
  than stripping `AUTH_SECRET` or silently reusing stale environment-dependent output.

Before release, obtain the local Docker database/build/race receipts, actual test-mode catalog
and Stripe/Inngest flow, real email/OAuth continuity, migration reconciliation, named approval
owners, deployment root/SHA, separately authorized beta checks, and writer/rollback rehearsal.
Native-price checkout does not inherit unverified package default-coupon or PPP configuration;
the catalog owner must reconcile intended discounted totals before enabling commerce.

### Cutover and rollback boundaries

Before a traffic change, the migration owner must provide identity/entitlement reconciliation
and the existing standalone-check receipt. Compare the approved cohorts with legacy promises
and record intentional differences. Importing access must not create a new Stripe subscription.
Choose one authoritative checkout/billing writer per cohort and reconcile open checkout
sessions and queued events before handing off traffic.

A rollback rehearsal must demonstrate restoring the prior traffic target and web deployment,
stopping unintended writers, and reconciling events already accepted. **Vercel rollback does
not undo charges, entitlement mutations, or learner writes.** Do not delete those records to
simulate a clean rollback. Use the existing HTTP diagnostics, Stripe webhook failures and
Inngest run history; preserve evidence and reconcile through the owning service.

No live beta write, sandbox transaction, customer import, traffic handoff or infrastructure
rollback is implied by passing local contracts. Missing approvals and receipts remain release
blockers, not successful skips.

[PR #20](https://github.com/badass-courses/egghead/pull/20) is explicitly deferred: its
`/team-preview` contains fictional activity, not production analytics, and is not required
for purchasing or seat management.
