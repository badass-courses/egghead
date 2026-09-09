# Local CourseBuilder v3 integration

Egghead now targets published core 3.0.2, adapter-drizzle 3.0.2, Next bindings 0.0.38, commerce/server/video-processing 0.1.2, UI 2.5.1, and utils 1.1.2. Local overrides currently resolve these packages to `.local/course-builder`, a separate Git checkout on `zac/multiple-membership-prices-v3`, based on upstream main `edbd8e0d0`.

The prior v2 prototype is preserved in the upstream checkout's stash, not applied to v2 releases. Nothing has been published, deployed, or written to live Stripe. Local links are explicitly authorized for testing; app manifests retain released versions and no CourseBuilder `workspace:*` dependencies.

## Commands

Use Node 24 with Corepack. Egghead selects pnpm 11.3.0; the upstream checkout selects its own pinned pnpm 11.1.2.

```sh
pnpm coursebuilder:local build
pnpm coursebuilder:local link
pnpm coursebuilder:local status
pnpm coursebuilder:prices:smoke
pnpm coursebuilder:v3:smoke
pnpm check
```

`build` compiles the coordinated package dependency graph. `link` applies pnpm overrides and aligns shared framework/class dependencies with Egghead's instances; the original symlink targets are saved under `.local`. This avoids duplicate Next, React, Drizzle, date, and editor instances across the two repositories. Re-run `link` after either repository installs dependencies.

`pnpm coursebuilder:local unlink` removes only this integration's overrides and root link dependencies, restores upstream peer links, and reinstalls published packages. The modified upstream checkout is retained. The app's shared form boundary and the multi-price smoke commands require these local changes until new package versions are published. Unlinking now restores dependency resolution, but is not a supported runnable release state; after publication, update the pinned versions before unlinking.

## Package changes

- Core owns typed price-catalog metadata, Product.prices, a configured default price, and optional CatalogPort/MerchantPort capabilities.
- Commerce paginates Stripe prices before applying an atomic snapshot. It defaults to dry run. Explicit price selection travels through checkout URLs, quote calculations, and checkout metadata. Unknown, hidden, archived, foreign-product, or mismatched prices are rejected.
- Adapter-drizzle imports each Stripe price independently, preserves offer settings and history, serializes imports per product, and prevents legacy replacement/archival logic from affecting imported catalogs. Existing JSON fields and tables are sufficient for this local implementation; no SQL migration was applied.
- Server passes selected price IDs through pricing actions.
- UI upgrades its resolver for Zod 4 and preserves output-shaped form state while validating the full schema. Egghead uses this shared boundary and explicit Auth.js account adapters.

The existing singular Product.price remains the configured default (or sole eligible legacy price). With multiple prices and no default it is null; it never chooses an arbitrary row. Newly discovered prices are hidden until explicitly offered. USD flat, licensed recurring prices are supported; quarterly is `month` with `intervalCount: 3`. Other billing models are mirrored but unavailable for new checkout.

## Using the new APIs

```ts
import { syncStripeProductPrices } from '@coursebuilder/commerce/sync-stripe-product-prices'

// The provider must use the account and environment of the existing mapping.
const preview = await syncStripeProductPrices({ productId, adapter, provider })
// Explicit database write, only against an authorized local/test environment:
await syncStripeProductPrices({ productId, adapter, provider, dryRun: false })
await adapter.configureProductPrice?.({
  productId,
  priceId,
  offer: { offered: true, label: 'Annual', position: 0 },
  default: true,
})
```

Amounts in smoke fixtures are synthetic: $150/year, $25/month, $70/quarter. They are not a commercial price decision. The importer requires an existing product/merchant mapping and does not create Stripe products or prices.

## Verification and remaining rollout work

Verified locally: `pnpm check` passed; core 53 tests, commerce 211 tests, server 23 tests, and adapter catalog 7 tests passed (294 total). Both offline smoke scripts passed, and the coordinated v3 package build passed. No beta database probe ran because approval was not configured.

Package tests cover checkout selection, pagination and failed fetches, repeat/concurrent imports, inactive prices, legacy history, and local offer configuration. The database suite uses its own disposable MySQL database at localhost:3317, not the app databases. Offline app checks verify the resolved commerce build and auth/form boundaries.

No webhook writer ownership, production database migration, live catalog import, membership selector UI, or package publication is enabled by this change. Those remain rollout work after local review. The original investigation's typed-column/index proposal is not implemented here; this prototype uses typed JSON plus per-product transactions.

Next 16.2.5 no longer exposes the old `experimental.isolatedDevBuild` option. The app removes that unsupported flag and lets Next generate route declarations; `next-env.d.ts` is not hand-edited.

The GitNexus registry still points to the older reference checkout. Its impact results informed caller review, but its change report does not describe this local v3 clone; direct Git diff review and the tests above are the verification for this checkout.

## Re-running the isolated adapter suite

The dedicated test container has been stopped after verification. Existing application containers were left alone.

```sh
docker start egghead-catalog-package-test
cd .local/course-builder/packages/adapter-drizzle
pnpm exec vitest run --config vitest.catalog.config.ts
# When finished:
docker stop egghead-catalog-package-test
```

The unlink/relink round trip was verified and Egghead was left linked. Both offline smoke checks passed again after relinking.

## Interactive local membership test

The web app now has a guarded test surface at `http://127.0.0.1:3008/local/membership`.

```sh
pnpm membership:setup
pnpm membership:dev
```

Setup uses `apps/web/.env`, requires a Stripe test secret key and local MySQL, and creates/reuses a dedicated test product. It synchronizes annual $150, monthly $25, and quarterly $70 prices through the linked v3 importer. Rerunning setup preserves local offer configuration. No Stripe IDs or credentials are stored in fixtures or this document.

On the page, select a billing option and continue to Stripe sandbox checkout. Below it, change labels, display order, offered prices, and default selection; these persist in the local database. Refresh retrieves all prices from Stripe and preserves local offer settings. The page requires `EGGHEAD_LOCAL_MEMBERSHIP=true`, is disabled in production/beta, and mutation actions require a loopback origin. The dev command binds to 127.0.0.1.

Browser verification confirmed offer/default persistence, preservation after Stripe refresh, and checkout amounts/cadences for all three options. The repository's full `pnpm check` passed. This tests catalog and checkout selection; it does not enable entitlement fulfillment or production webhook ownership.

## Pricing and invoice integration

`/pricing` uses the existing membership card presentation with price-ID selection, persisted offer order/default, and seat totals. The regular checkout path accepts configured Stripe test or live accounts via `STRIPE_SECRET_TOKEN` and `EGGHEAD_SUBSCRIPTION_PRODUCT_ID`; `NEXT_PUBLIC_APP_URL` supplies the checkout return origin. The explicit preview flag selects the local catalog instead.

Checkout requires an authenticated account and binds its email to a persisted Stripe Customer scoped to the product's merchant account. Successful checkout returns to `/thanks/subscription`, which verifies session ownership and reads the Stripe invoice, paid total, billing address email, and hosted/PDF links. Cancellations return to pricing. Customer-facing pages use the same presentation in both Stripe modes.

Validation includes the full `pnpm check`, `node --import tsx scripts/checkout-customer-smoke.ts`, and `node --import tsx scripts/membership-configuration-smoke.ts`. Browser verification covered locked checkout email, multiple billing intervals, seat totals, the success redirect, and a completed invoice.

The app PR is an integration draft: publish the upstream changes, replace local dependency overrides with released versions, and reconcile with current main before merging. Webhook-driven membership/team fulfillment and the inherited production database migration guard remain separate rollout work. A completed checkout alone does not grant access.
