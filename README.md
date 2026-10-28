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

Runtime boundaries:

- published `@coursebuilder/*` packages only
- no `workspace:*` CourseBuilder runtime reach-through
- local web development writes to local Docker MySQL
- beta web runtime reads an explicitly approved PlanetScale database but blocks commerce writes
- production web runtime requires a PlanetScale `DATABASE_URL` and owns subscription checkout, webhook fulfillment, and team-seat writes
- builder production runtime and production imports remain blocked

Run:

```bash
pnpm install
pnpm phase0:imports
pnpm --filter @egghead/web dev
```

## Stripe subscriptions

The subscription flow uses hosted Stripe Checkout. CourseBuilder verifies Stripe webhook
signatures and publishes the events to the app's Inngest endpoint; the Egghead handler then
creates the local subscription records and grants the all-access entitlement. A checkout quantity
of two or more creates a team subscription: the seat count and owner are stored on the local
subscription, and access is assigned from `/team` rather than granted to the purchaser implicitly.

Configure these values in `apps/web/.env.local`:

```bash
STRIPE_SECRET_TOKEN=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
INNGEST_EVENT_KEY=
INNGEST_SIGNING_KEY=
```

For production web checkout, set `EGGHEAD_RUNTIME=production`, a PlanetScale `DATABASE_URL`,
`AUTH_SECRET`, an HTTPS `NEXT_PUBLIC_APP_URL`, live Stripe credentials, and both Inngest keys.
Register the Stripe webhook endpoint and Inngest functions before offering checkout. The pricing
page requires the Stripe webhook secret and Inngest keys before it offers production checkout.
The builder's production database guard is separate and remains blocked.

The pricing page discovers active CourseBuilder products whose type is `membership`. Each offered
recurring price must be connected through active `MerchantProduct` and `MerchantPrice` rows. The
price owns its billing interval and currency; the database owns offer visibility, label, order,
and default selection. Legacy single-price memberships remain readable.

Run the app and the Inngest dev server in separate terminals:

```bash
pnpm --filter @egghead/web dev
pnpm dlx inngest-cli@latest dev --no-discovery -u http://localhost:3008/api/inngest
```

Forward Stripe test-mode webhooks to the CourseBuilder endpoint:

```bash
stripe listen --events checkout.session.completed,customer.subscription.updated \
  --forward-to http://localhost:3008/api/coursebuilder/webhook/stripe
```

Copy the `whsec_...` value printed by Stripe CLI into `STRIPE_WEBHOOK_SECRET`, restart the
web app, sign in, and open `/pricing`. Use the **Seats** input to select two or more seats, then
click **Subscribe for {quantity} seats** to send that quantity to Stripe Checkout. The checkout
success page waits for the durable webhook handler to create the
subscription, then links to `/team`, where the owner can claim, invite, remove, and add seats.

Team subscription renewal and cancellation events fan out to every assigned seat entitlement.
Adding seats updates Stripe first and relies on the same webhook to converge the local seat count;
the local row is also updated immediately for responsive local development.

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
With Typesense configured, discovery reads instructor facets from that same index:
`instructor_name` for `content_production`, and `instructorNames` for canonical collections.
Only an unconfigured Typesense reader uses SQL instructor discovery. Names are normalized,
encoding variants are merged, and name searches fold accents. The operation returns up to six
default suggestions, or up to eight matching suggestions for `?q=<name>`. Unknown names return
an empty list. Lookup failures propagate as errors, not successful empty results; the dropdown
shows "Unable to load instructors." rather than retaining stale suggestions.

Existing canonical collections missing `instructorNames`/`instructorKeys` need a new schema
and a full reindex. Deploying source alone does not populate these fields.

### Safe reindex and beta rollout

Follow [Typesense's alias workflow](https://typesense.org/docs/26.0/api/collection-alias.html)
(version 26 runs on the current cluster): create a versioned collection, load and verify it,
then switch the stable `egghead_content` alias. Existing collections are never deleted or
reused. `--recreate`, partial indexing, and unknown options are rejected.

Use the approved, populated content database through a leased **reader** credential. Set
`EGGHEAD_RUNTIME=beta` and `EGGHEAD_BETA_DB_APPROVED=true`; local Docker is for fixtures,
not a source for a live rebuild. Use Node 24 and the locked pnpm version.
The script reads environment variables from the invoking process; load your approved environment
before running it. Keep credentials in private files or process environment, never in arguments.

1. Read the complete source without writing to Typesense:

   ```bash
   pnpm search:typesense-index --dry-run
   ```

   Review document counts by type, instructor coverage, and `sourceSha256`. Independently
   compare them with the approved migration source. Every document ID in the existing alias
   target (or `egghead_content_migration_v1` on first rollout) must be retained or explicitly
   confirmed ineligible by the same database publication predicate used to build the index.
   Soft-deleted, unpublished, hidden, unsupported, or unsluggable rows can be excluded;
   an absent source row blocks the build as an unexplained migration gap.
   A digest alone does not establish source completeness.

2. Stage a fresh target using the reviewed digest:

   ```bash
   EGGHEAD_TYPESENSE_INDEX_APPROVED=true pnpm search:typesense-index \
     --collection=egghead_content_migration_v2 --source-sha256=<reviewed-digest>
   pnpm search:typesense-index --verify-only --collection=egghead_content_migration_v2
   ```

   The operator key needs collection create/retrieve, document import/export, and alias
   retrieve/update/delete permissions. The application uses only its search key; it must be
   able to read **both versioned targets and the stable alias**. Schema types/facets, exact
   document counts, instructor counts, and instructor-filtered results are checked before
   promotion. Import responses are checked line by line. Failed targets are kept for inspection;
   retry with a new versioned name.

3. Coordinate a content-write freeze before the final dry run and rebuild. Drain in-flight
   content/indexing work and keep one reindex operator active. Set
   `EGGHEAD_CONTENT_WRITES_PAUSED=true` **only after** the actual freeze is in effect;
   this flag is an operator assertion, not an automatic lock. It concerns content writes,
   not subscription/commerce ownership. Re-run with a **new** target and the fresh digest:

   ```bash
   EGGHEAD_TYPESENSE_INDEX_APPROVED=true EGGHEAD_CONTENT_WRITES_PAUSED=true \
     pnpm search:typesense-index --collection=egghead_content_migration_v3 \
     --source-sha256=<fresh-reviewed-digest> --promote
   ```

   The source is loaded again before switching. Any content/contributor/path drift or
   concurrent alias change aborts promotion. Typesense has no conditional alias update:
   serialize operators; the final read/update still has a race without that external lock.
   A failed or ambiguous alias PUT triggers recovery and mapping confirmation. Failed
   recovery reports that operator intervention is required; do not assume rollback succeeded.

4. Set beta's `TYPESENSE_COLLECTION_NAME` and `NEXT_PUBLIC_TYPESENSE_COLLECTION_NAME` to
   `egghead_content`, keeping `EGGHEAD_RUNTIME=beta` and beta DB approval enabled. Run
   `pnpm search:typesense-preflight` with the **deployment's reader key and environment**
   before deploying. This check needs no database or write key and exits nonzero on missing
   instructor fields, denied search access, or empty content/facets. Redeploy so public
   environment values are rebuilt. Verify `/api/instructors`, `/api/instructors?q=John`,
   `/q?q=`, and instructor-filtered results through the deployed app.

5. Preserve the old collection and the previous deployment/configuration for rollback.
   If a later verification fails, restore the previous alias mapping (or remove the alias
   if it did not exist), restore beta configuration/deployment, then verify again.
   Rollback never deletes a collection. The initial v1 collection lacks instructor fields,
   so restoring it restores the prior behavior, including that limitation.

The builder still emits the legacy Typesense shape. **Do not point that writer at the canonical
alias or enable builder production runtime.** Canonical publication currently uses complete
snapshot rebuilds; leave content writes frozen while validating the beta snapshot. Resuming
content writes requires an agreed rebuild cadence or a separately reviewed canonical writer
with replay/dual-write support. An alias switch by itself does not synchronize writers, and
this workflow does not transfer commerce or builder runtime ownership.

### Repair missing Rails instructor contributions

`pnpm content:instructor-backfill` defaults to a read-only plan. It reads only Rails lesson /
playlist authorship and existing instructor users by indexed `legacyRailsUserId`, then plans
missing `instructor` contributions. It does not select Rails/customer emails or create users.
Lessons prefer Rails IDs; resources without those IDs require a unique exact slug. Courses
require playlist owners who are known Rails instructors. Ambiguous matches, missing users,
blank names, inactive attributions, and conflicting existing instructors block application.
A resource without a legacy match is reported and left untouched.

Use an approved beta PlanetScale reader lease for the dry run and the builder's Rails URL
as `EGGHEAD_POSTGRES_DATABASE_URL`. Set `EGGHEAD_RAILS_CA_FILE` to the verified database CA
bundle (AWS RDS's [official bundle](https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem)
for the current Rails source). TLS verification stays enabled, and Rails sessions force
read-only transactions with a 15-second statement timeout.

```bash
pnpm content:instructor-backfill
# After reviewing counts and planSha256, with content writes actually paused:
EGGHEAD_CONTRIBUTION_BACKFILL_APPROVED=true EGGHEAD_CONTENT_WRITES_PAUSED=true \
  pnpm content:instructor-backfill --apply --plan-sha256=<reviewed-digest>
pnpm content:instructor-backfill
```

For apply, lease only the target branch's required write capability, then revoke that lease.
Only `egghead_ContributionType` and `egghead_ContentContribution` receive inserts. Deterministic
contribution IDs and existing semantic-match checks make reruns safe; existing rows are
preserved. The second dry run must report zero pending contributions. A partial failure can
leave already-inserted batches; rerun a dry run and resume with the same reviewed mapping.
After repair, re-run the Typesense dry run to capture its new digest and instructor counts.

The operator scans resource IDs in primary-key pages of 500 and checks/inserts contributions
in serial batches of 100. Source budgets are 20,000 lessons, 5,000 playlists, 1,000 distinct
instructor users, and 20,000 target resources; exceeding them stops the run. A metadata read,
15 resource pages, 72 contribution reads, and 3 source/identity reads took about 20 seconds
on the current 7,202-resource target. No query runs once per resource. See the investigation
record in `docs/typesense-instructor-reindex.md` for executed checks and rollout status.
