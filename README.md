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
- no Stripe/Inngest writer ownership
- no dev/prod PlanetScale writes
- no read flip

Run:

```bash
pnpm install
pnpm phase0:imports
pnpm --filter @egghead/web dev
```

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
