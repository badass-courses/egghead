# Multiple recurring prices for one membership product

Investigation date: 2026-09-08. Status: initial investigation below; the v3 implementation is now under local integration test. See [local testing instructions](local-coursebuilder-testing.md).

## Recommendation

Keep one Egghead membership Product mapped to one Stripe Product, with separate Price and MerchantPrice records for each billing option. Stripe owns billing amounts, currency, recurrence, and active state. The database mirrors those facts and owns storefront availability, display order, labels, and the default selection.

| Option | Amount | Stripe interval | Interval count |
| --- | --- | --- | --- |
| Annual | $150 USD, provisional | year | 1 |
| Monthly | $25 USD | month | 1 |
| Quarterly | To be decided | month | 3 |

The annual example follows the existing local setup guide; confirm the commercial amount before configuring Stripe. Billing cadence belongs to the price. Membership access belongs to the product and the subscription's entitlement state.

## Baseline before the v3 upgrade

Reviewed repository code and the installed published packages: `@coursebuilder/core` 2.0.2, `@coursebuilder/adapter-drizzle` 2.1.1, and `@coursebuilder/next` 0.0.35. No live Stripe catalog, deployed database schema, or production webhook configuration was inspected. GitNexus tools were unavailable; this review used direct source tracing.

Source paths below are relative to `apps/builder-egghead`, including installed package source.

| Finding | Evidence |
| --- | --- |
| SQL table definitions permit several prices for a product: neither Price.productId nor MerchantPrice.merchantProductId is unique. | `node_modules/@coursebuilder/adapter-drizzle/src/lib/mysql/schemas/commerce/price.ts` and `merchant-price.ts` |
| The ORM still declares Product.price as a one-to-one relationship. Product reads load a singular price. | `node_modules/@coursebuilder/adapter-drizzle/src/lib/mysql/schemas/commerce/product.ts:49`; `src/lib/mysql/index.ts:2131` in that package |
| Core Product exposes singular price and product-level billingInterval limited to month/year. The local product schemas are also singular and omit billing interval configuration. | `node_modules/@coursebuilder/core/src/schemas/product-schema.ts:40`; `src/lib/products.ts:11` |
| getPriceForProduct returns the first price with no active filter or ordering. getMerchantPriceForProductId returns the first active MerchantPrice with no ordering. Despite its name, the latter takes a local MerchantProduct ID at checkout. | `node_modules/@coursebuilder/adapter-drizzle/src/lib/mysql/index.ts:1785` and `:776` |
| Checkout resolves by product only. Pricing and discount calculations separately resolve a product's first local price, so extra rows can make the displayed/calculated amount disagree with the selected Stripe price. | `node_modules/@coursebuilder/core/src/lib/pricing/stripe-checkout.ts:291`; `format-prices-for-product.ts:169` in the same directory |
| Product updates replace the active price: create a Stripe price, change default_price, reuse the local Price row, deactivate the old MerchantPrice, and archive the old Stripe price. This models replacement/history, not simultaneous offers. | `node_modules/@coursebuilder/adapter-drizzle/src/lib/mysql/index.ts:1857` |
| No catalog price-listing or product/price event synchronization was found in the reviewed integration. The provider exposes individual get/create/update operations. | `node_modules/@coursebuilder/core/src/providers/stripe.ts`; `src/lib/pricing/process-stripe-webhook.ts` in that package |
| Subscription parsing retains the actual Stripe price identifier, but the installed subscription-update handler leaves status and plan changes as TODOs. | `node_modules/@coursebuilder/core/src/lib/pricing/stripe-subscription-utils.ts:68`; `src/inngest/stripe/event-customer-subscription-updated.ts` in that package |

The builder registers Stripe; `apps/web/src/coursebuilder/config.ts` registers no payment providers. Package capability must not be mistaken for complete, deployed commerce. The untracked `stripe-membership-production-setup.html` describes only the annual setup and is not proof of live records.

## Implementation sequence

### 1. Extend the published CourseBuilder contracts

- Add Product.prices and explicit price lookup/selection APIs. Keep Product.price only as a documented default-price compatibility view during migration.
- Move recurrence to each price: currency, exact unit amount, price type, recurring interval and intervalCount, Stripe active state, optional lookup key, and last synchronization time.
- Use dedicated typed columns for billing/query fields. Keep app presentation settings separate from synchronized Stripe fields; a typed Price.fields schema can hold labels, ordering, and offered-for-sale settings.
- Preserve the existing major-unit decimal amount contract while explicitly converting Stripe minor units through a typed boundary. Never silently reinterpret existing amounts as cents. Initially support USD flat-rate licensed recurring prices; retain but do not offer unsupported pricing models.
- Add indexes for product price lists and merchant-product/status lookup. Make external identity unique within merchant account and environment, with explicit test/live isolation. Do not make interval unique: grandfathered and promotional prices can share an interval.
- Define one explicit local default price per product, validated as belonging to that product and eligible for sale. Mirror Stripe default_price separately; it does not enumerate the available prices.
- Publish changes upstream and consume released versions here. Do not edit node_modules, add private-source imports, or introduce workspace CourseBuilder dependencies.

### 2. Build an idempotent Stripe-to-database catalog importer

- Start with an explicitly mapped membership product and a dry-run report. Retrieve the product and paginate all its prices, including inactive prices, rather than importing only default_price.
- Upsert each Stripe Price into its own local Price/MerchantPrice mapping. Never create another Product for a different interval or overwrite another option's amount.
- Apply a complete fetched product snapshot transactionally. Keep archived records for historical references. A failed or incomplete fetch must not retire existing options.
- Newly discovered prices appear in administration with sale disabled until selected for offering. Stripe controls billing facts; database configuration controls which active supported prices customers see.
- Add a repeatable reconciliation command. When commerce ownership is authorized, use product/price lifecycle events to trigger the same reconciliation, with signature verification, deduplication, and serialized refreshes per product so retries and out-of-order events converge to current Stripe state.

### 3. Make all purchase paths select the same price

- Accept productId plus local priceId. Resolve and validate product ownership, merchant account/environment, active state, sale eligibility, supported currency, and recurrence server-side.
- Pass the resolved Stripe Price as the Checkout subscription line item. Use that same local price for display, discounts, credits, and purchase metadata.
- Remove arbitrary first-row selection. Old callers without a price ID may use only the explicit eligible default; fail clearly when none exists.
- Render billing choices from the database. A configured quarterly price must appear without adding a quarterly code branch. Preserve intervalCount through formatting and checkout.
- Separate editing product content from billing changes. Disable the old replace-price behavior for imported products. Archiving a product must consistently handle all its price mappings.

### 4. Preserve subscriptions and access

- Backfill the existing selected price as the default before enabling multiple options. Audit actual schema/data before choosing migration constraints.
- Account for the current history pattern: several historical MerchantPrice rows may refer to one mutable Price row. Recover each price's immutable billing facts from Stripe; do not copy the current amount into historical records.
- Keep existing subscriptions on their original Stripe prices, including prices belonging to older duplicated products. Map those explicitly to the same intended membership entitlement where appropriate; consolidation must not silently migrate billing.
- All offered intervals grant the same intended membership access while the subscription qualifies. Bare legacy pro remains insufficient for broad access.
- Treat monthly/yearly switching and proration as a separate feature. Complete and verify lifecycle ownership for renewals, payment failures, cancellation, and reactivation before live launch; the installed TODO handler is not sufficient.

### 5. Verify and roll out

Acceptance checks:

1. One product imports annual and monthly prices; rerunning import creates no duplicates.
2. Adding a quarterly price and enabling its offer makes it selectable without code changes.
3. Each selection charges the expected amount and interval, with matching displayed and discounted pricing.
4. Archived, foreign-product, wrong-environment, unsupported, and non-offered prices cannot start checkout.
5. Archiving one price leaves sibling offers and existing subscriber access intact.
6. Duplicate/out-of-order events, pagination, partial failures, price replacements, and legacy default callers behave deterministically.
7. Existing one-time purchase behavior remains correct, and subscription lifecycle tests prove access follows the subscription rather than the catalog's sale state.

Per AGENTS.md, Phase 0 remains local/dev only. Implement schema/query work and offline contracts there first. Production catalog imports, Stripe/Inngest writer ownership, and checkout activation belong to a separately authorized commerce phase. Run pnpm check before any implementation commit, plus the relevant package tests upstream.

## Stripe references

- [Products can have multiple prices; billing amount changes create new prices](https://docs.stripe.com/products-prices/manage-prices).
- [List prices by product with pagination and active-state filtering](https://docs.stripe.com/api/prices/list).
- [Price recurrence and interval_count](https://docs.stripe.com/api/prices/object).
- [Webhook verification, duplicate events, and event ordering](https://docs.stripe.com/webhooks).

This investigation changes only this plan document. No application code, dependency versions, database records, or Stripe configuration were changed.
