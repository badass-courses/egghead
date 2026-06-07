# Standalone Egghead Agent Notes

This app is the final Rails-exit Egghead CourseBuilder integration app.

Guardrails:

- Keep Phase 0 local/dev only.
- Consume published `@coursebuilder/*` packages.
- Do not use `workspace:*` CourseBuilder dependencies.
- Treat `/Users/joel/Code/skillrecordings/migrate-egghead/course-builder/apps/egghead` as extraction/reference source only.
- Do not add commerce, Stripe/Inngest writer ownership, production imports, or read flips in Phase 0.
- Do not put raw customer rows, emails, tokens, Stripe IDs, or secrets into Brain or fixtures.
- Bare legacy `pro` must not grant broad access.

Type/lint discipline:

- Use pnpm for all package operations and scripts.
- Run `pnpm check` before commit unless the user explicitly narrows the verification scope.
- Do not weaken `tsconfig.base.json`, `.oxlintrc.json`, `.oxfmtrc.json`, or `lefthook.yml` to get a change through.
- Do not add `any`, `as any`, non-null assertions, `@ts-ignore`, `@ts-expect-error`, Oxlint suppressions, skipped hooks, or disabled rules for convenience.
- If a dependency type is wrong, isolate the boundary with a small typed adapter or schema parse and document why.
- If a check fails, fix the code or make an explicit, reviewable config change with the reason in the commit message.

Package boundaries:

- Strongly prefer package `exports` with explicit subpaths.
- Do not add barrel files such as `src/index.ts` to aggregate unrelated exports.
- Do not import from package roots when an explicit subpath exists.
- Add or revise package export maps instead of reaching into private source paths from another package.

Design system:

- Keep `packages/ui` as an extremely sparse, shadcn-compatible registry-style design system.
- Start black/white only, with light/dark tokens, strong typography, and structural layout primitives.
- Prefer minimal CourseBuilder-compatible primitives over a broad component library.

Reference plan:

- `/Users/joel/Code/skillrecordings/migrate-egghead/.brain/resources/decisions/adr-0004-standalone-egghead-coursebuilder-app.svx`
- `/Users/joel/Code/skillrecordings/migrate-egghead/.brain/projects/egghead-migration-master-plan/standalone-extraction-implementation-shape.svx`
- `/Users/joel/Code/skillrecordings/migrate-egghead/.brain/projects/egghead-migration-master-plan/mve-content-auth-bdd-plan.svx`
