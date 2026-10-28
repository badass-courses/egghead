# Workshop reader

This slice keeps Builder as the event editor and registration destination. It reads published CourseBuilder events and offers; it does not create purchases, evaluate a person's access, grant entitlements, or take ownership of Stripe/Inngest writes. The workshop connection factory blocks production reads even when the web database runtime permits production subscription traffic.

## Trace an action

`getWorkshopContract` in `src/contracts.ts` defines the input, output, failures, read-only annotations, and approval setting. `getWorkshop` in `src/capabilities.ts` decodes its input, requests a source snapshot through `WorkshopCatalog`, samples the Effect clock, applies `evaluateWorkshop`, and validates the output. `listUpcomingWorkshops` follows the same path with a bounded page and cursor. The registry keeps the contracts beside their handlers.

`WorkshopCatalog` owns the reader interface, not SQL. `@egghead/workshop-catalog/mysql` provides the CourseBuilder MySQL Layer. The application chooses its connection factory in `apps/web/src/workshops/event-catalog.ts`, preserving the existing local/beta database safety checks. `memoryWorkshopCatalog` supplies the same interface for tests or a disposable composition.

The Next read adapter and JSON CLI call the same handlers. Formatting is separate from server execution. HTTP, MCP, code mode, and RPC projections are not implemented in this slice; their future entry points should consume these contracts and handlers. There is no owned reservation lifecycle or new infrastructure to justify XState or Alchemy here.

## Public behavior

- The index and sitemap discover public published events. Published unlisted events remain available by their direct links, with noindex metadata. Private, draft, and deleted events are excluded by the catalog.
- Status and coupon eligibility are recomputed on each request. Workshop reads and their rendered offer/registration views are not cached. This intentionally gives inventory and editor changes the same request freshness as status and price.
- A missing active price is pending, while an explicit zero price is free.
- Coupon eligibility must decode as CourseBuilder's `hasValidProductPurchase` condition to become a conditional offer. Its qualifying product is retained. An arbitrary condition cannot become a public discount or claim membership. The UI says “Eligible buyers”; registration remains authoritative for eligibility.
- Expired, exhausted, or inactive-merchant coupons do not advertise discounts. Fixed discounts are converted from cents; CourseBuilder prices are expressed in dollars. Database timestamps are read as UTC strings so host timezone does not shift expiration.
- Registration is an exhaustive `open`, `sold-out`, `closed`, or `pending` value. The view renders it and never independently decides whether registration is allowed.
- Missing records return `null`. Read failures and malformed event data remain typed failures. Defects are not converted to absence.

## Checks and local tools

```sh
pnpm check
pnpm workshops get '{"slug":"example-workshop"}'
pnpm workshops list '{"limit":20}'
pnpm workshop:test
pnpm workshop:mysql-test
pnpm turbo run check test build
```

The CLI uses the app's database safety guards and prints public workshop data. It has no writer command. The native suite expects a disposable MySQL database named `egghead_workshop_test` on loopback port 13319, with synthetic root/root credentials. It recreates only that fixture's tables; do not point it at a customer database.

The dependency check rejects provider/Next imports in the domain, cross-package private imports in the provider, database imports in workshop views, and `use cache` in workshop routes/read adapters/views. Domain properties, controlled clock histories, and native adapter examples cover the behavior. Expiry, forbidden-import, and N+1 mutations must fail their respective checks before being restored.

## Query plan

Each detail or upcoming-page read acquires one connection, probes the slug-column schema, reads events, batches product/price/purchase aggregates, and batches coupons. The maximum is four read statements, independent of the number of events in the page; empty results use fewer. Connection release is outside that read budget and is asserted separately. Sitemap references use two statements per page and fetch no bodies or offers. All operations are serial within one request.

Upcoming pages return at most 100 events plus one continuation probe, ordered by start instant and unique event ID. References use event-ID keyset pagination. Offer and coupon fan-out each return at most 1,001 rows; exceeding 1,000 produces `InvalidWorkshopData`, rather than silently truncating an offer. A validated integer is interpolated for LIMIT because the pinned mysql2 numeric prepared parameter is rejected by native MySQL 8.4.

These bounds cover returned rows and round trips, not scanned work. The CourseBuilder JSON slug/schedule predicates have no proven indexed access path on a representative Egghead dataset. Native MySQL 8.4 EXPLAIN on eight synthetic events showed `ALL`, no key, eight estimated rows, and filesort for JSON-slug/detail and upcoming reads. References used `PRIMARY` in index order. The fixture product joins used `resourceId`/`productId` with `ref` and `PRIMARY` with `eq_ref`; coupons used `restrictedToProductId` with `ref` and merchant `PRIMARY` with `eq_ref`. Native fixture results are development evidence only. A production read flip needs representative EXPLAIN/row-budget evidence and an approved indexed reader or read model; this slice adds no database migrations or production deployment.

## Replace the adapter

Swap the application composition to `memoryWorkshopCatalog`, remove the MySQL adapter package and its dependency/transpile entries, and leave capabilities, views, and CLI unchanged. The boundary check permits an intentionally absent adapter package, while type checking still rejects any remaining imports. This demonstrates reader replacement; it does not claim that this adapter owns or can delete CourseBuilder's database infrastructure.

The isolated adapter-removal checkout passed `pnpm check` with the memory composition. The web app build passed with synthetic static-route content. Native tests passed on real MySQL, and warm Next pages reflected coupon expiry and sold-out inventory changes. The full monorepo build is separately constrained by Builder's required environment configuration. The provider tsconfig explicitly loads Node types so both compilers resolve mysql2's EventEmitter mixins; no base compiler or lint rule was relaxed.
