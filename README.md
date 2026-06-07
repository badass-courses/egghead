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
