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

Phase 0 is local/dev only:

- published `@coursebuilder/*` packages only
- no `workspace:*` CourseBuilder runtime reach-through
- local Docker MySQL only
- Stripe Checkout and subscription webhook writes are local-only
- subscription and team-seat management remain local-only
- no dev/prod PlanetScale writes
- no read flip

Run:

```bash
pnpm install
pnpm phase0:imports
pnpm --filter @egghead/web dev
```

## Local Stripe subscriptions

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
