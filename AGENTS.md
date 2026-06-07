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

Reference plan:

- `/Users/joel/Code/skillrecordings/migrate-egghead/.brain/resources/decisions/adr-0004-standalone-egghead-coursebuilder-app.svx`
- `/Users/joel/Code/skillrecordings/migrate-egghead/.brain/projects/egghead-migration-master-plan/standalone-extraction-implementation-shape.svx`
- `/Users/joel/Code/skillrecordings/migrate-egghead/.brain/projects/egghead-migration-master-plan/mve-content-auth-bdd-plan.svx`
