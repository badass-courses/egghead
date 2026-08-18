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
- subscription management is intentionally deferred to the profile work
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
creates the local subscription records and grants the all-access entitlement.

Configure these values in `apps/web/.env.local`:

```bash
EGGHEAD_SUBSCRIPTION_PRODUCT_IDS=monthly_coursebuilder_product_id,yearly_coursebuilder_product_id
STRIPE_SECRET_TOKEN=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
INNGEST_EVENT_KEY=
INNGEST_SIGNING_KEY=
```

`EGGHEAD_SUBSCRIPTION_PRODUCT_IDS` is a comma-separated list of local CourseBuilder `Product.id`
values, not Stripe product IDs. The app still accepts `EGGHEAD_SUBSCRIPTION_PRODUCT_ID` as a
single-product fallback. Each product must have a recurring Stripe price connected through
CourseBuilder's `MerchantProduct` and `MerchantPrice` rows, a supported `billingInterval` field
(`day`, `week`, `month`, or `year`), and the database must contain the Stripe `MerchantAccount`
row.

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
web app, sign in, and open `/subscribe`. The checkout success page waits for the durable
webhook handler to create the subscription before showing course access.

Then from `migrate-egghead`:

```bash
bun tools/me.ts egghead standalone check --url http://localhost:3008 --json | jq .
```
