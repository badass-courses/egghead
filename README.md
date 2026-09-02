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
`MerchantPrice` rows, a `month` or `year` `billingInterval`, and the database must contain the
Stripe `MerchantAccount` row.

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

Search documents include every content contributor in `instructorNames` and a normalized
`instructorKeys` facet. Text queries search instructor display names, while the instructor filter
uses the normalized key so `q`, `type`, and `instructor` combinations share the same Typesense
query path. SQL remains an availability fallback when Typesense is not configured or errors.

Adding these fields changes the collection schema and existing documents do not contain contributor
data, so the collection must be recreated and fully reindexed before this behavior is available in
an existing environment. The guarded command is:

```bash
EGGHEAD_TYPESENSE_INDEX_APPROVED=true pnpm search:typesense-index --recreate
```

Do not run that command against a shared or production collection without explicit authorization.
