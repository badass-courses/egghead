# PR 36 sitemap build timeout

Source: `c11a997cd0864563a1500fec8ff5465c1e2d08d3`, Next 16.2.5.

## Deployment evidence

The web deployment `dpl_ELzTPmHAxeA39bzk22YV5Nr3WvEP` compiled and passed
TypeScript, then failed exporting `/sitemap.xml` with `USE_CACHE_TIMEOUT`.
The stack points to `getEggheadSitemapEntries`, which fills an hours-long cache
by opening MySQL and enumerating content. The metadata route invoked it directly,
allowing Next to attempt that full enumeration during prerendering.

The log does not identify which database operation stalled. It does not establish
that request-specific APIs were called inside the cache. PR 19's later successful
build also rules out a universally broken sitemap query.

## Hypothesis and experiment

Hypothesis: the metadata route unnecessarily makes build success depend on a
live sitemap cache fill. An incoming-request boundary should prevent that work
during prerendering while retaining the existing tagged data cache at runtime.

A temporary minimal Next 16.2.5 fixture copies the real `app/sitemap.ts` and
supplies a cached sitemap reader that never settles during build. It returns
one synthetic URL only when `SITEMAP_PROBE_MODE=request` at runtime. No customer
data or database credentials are needed. Build with the installed Next binary:

```sh
pnpm --dir /tmp/egghead-pr36-sitemap-repro exec next build --webpack
```

Webpack is used for this small rendering-lifecycle probe; the actual deployment
uses Turbopack. Both exercise Next's Cache Components prerendering.

Results: baseline failed 1/1 with `USE_CACHE_TIMEOUT` on `/sitemap.xml`.
Copying the fixed metadata route into the same fixture passed 1/1 and reported
`ƒ /sitemap.xml`; static generation completed in 306ms. The stalled reader was
unchanged. Next's `server/use-cache/use-cache-wrapper.js` confirms its prerender
cache-fill timer is 50,000ms. No timeout setting was changed.

The unit regression also fails when `await connection()` is removed and passes
when restored. It proves cached data loading waits until the request is accepted.

## Change

Await `connection()` in the metadata route before calling the cached sitemap
reader. Keep that boundary outside `use cache`. This moves cache population to
the first request; the existing hours-long lifetime and invalidation tags remain.
No database query, timeout, runtime permission, or subscription ownership changes.
The first cold sitemap request still bears the cost of database enumeration;
this change does not claim to optimize the queries or explain the original stall.

## Verification

The deterministic before/after build and mutation-tested unit regression pass.
Starting the fixed fixture with `SITEMAP_PROBE_MODE=request` and requesting
`/sitemap.xml` returned HTTP 200, `application/xml`, and the synthetic URL.
`pnpm check` passed. The replacement Vercel deployment is the final verification.
