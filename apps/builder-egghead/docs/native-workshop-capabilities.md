# Native Workshop capabilities

This sibling to [PR 29](https://github.com/badass-courses/egghead/pull/29) introduces native CourseBuilder draft Workshops in local development. It provides create, inspect, list, and revise operations without requiring feature flags, coupons, Products, or Stripe objects. Preview operations return the same candidate Workshop as their corresponding mutation, without writing it.

## One contract and one handler

`packages/core/src/contracts.ts` defines input, output, failure, approval requirements, and annotations. `packages/core/src/workshops.ts` binds the handlers and exports one ordered capabilities tuple. The MCP projection discovers its schemas and metadata from that tuple and executes those handlers. Server-side consumers can call the same capabilities with Actor, Approval, and WorkshopStore Layers. Contract imports require no server services.

The add-a-capability skill refers to `@rat-stack/capability`, which is not published in npm. The small local helper in `packages/core/src/capability.ts` implements the required definition, binding, decoding, output validation, and approval gate. It uses Effect 3.11.5, already present in this repository's published dependency graph, and its `Context.Tag` API. It does not pretend that Effect 4's `Context.Service` is available. Tests use compatible `@effect/vitest` 0.14.0. No framework copy or additional unused transport surfaces are introduced.

## Connect locally

Use the builder device-token authentication flow, then connect an MCP client to `http://localhost:3000/api/workshop-mcp` with a Bearer token. The authenticated account must have an active admin or contributor role. Do not commit client authentication headers. The endpoint checks the local runtime and local test-database URL before authentication or tool execution. Beta and production are refused, including when beta database access is approved elsewhere.

The local adapter uses mysql2 for authentication and Workshop storage, rather than the existing builder's PlanetScale transport. Revoked and expired tokens and inactive/deleted role assignments are rejected. Legacy tokens with no expiry retain the existing local-development behavior; production use is not supported.

| Capability                | Required values                                 | Approval |
| ------------------------- | ----------------------------------------------- | -------- |
| `list_workshops`          | `limit` between 1 and 50, optional `cursor`     | None     |
| `get_workshop`            | Workshop `id`                                   | None     |
| `preview_create_workshop` | Creation values below                           | None     |
| `create_workshop`         | Same creation values, transport `confirm: true` | Required |
| `preview_update_workshop` | `id`, `expectedRevision`, `changes`             | None     |
| `update_workshop`         | Same update values, transport `confirm: true`   | Required |

Creation values are `requestId` (UUID), `title`, `description`, `startsAt`, `endsAt`, `timezone`, and `attendeeInstructions`. Optional copy can be supplied as an empty string. Dates are ISO timestamps with an explicit offset; storage normalizes them to UTC. The Workshop timezone must be recognized by Intl. Slug initially equals the stable native ID `workshop~<requestId>`, so changing a title cannot change identity or an existing URL.

Preview first, show the candidate to the operator, then confirm using the same request ID or expected revision. A duplicate creation ID returns Conflict; write annotations deliberately make no retry-idempotency promise. Inspect that ID after an uncertain creation result rather than retrying with a new UUID. Updates increment `fields.workshopRevision`; stale edits must be reloaded and previewed again. Neither write tool can publish content or open registration.

Unknown input fields are rejected, including `flagKey`, `eggheadSale`, provider identifiers, and client-supplied actor IDs. Schedule validation merges patch fields with the current Workshop, preventing an update to only startsAt from invalidating the unchanged end. Invalid calendar dates, invalid zones, and empty patches fail before writes. Unauthorized inspect operations return NotFound to avoid exposing another contributor's draft.

## Native persistence and query budget

The system of record is the published CourseBuilder `ContentResource` table, with `type = 'workshop'`, `state = 'draft'`, `visibility = 'unlisted'`, and a revision in fields. This PR adds no SQL table, migration, provider resource, or commerce writer. Existing native Workshops without this draft contract are not automatically adopted, and no event is retyped.

The application writes through WorkshopStore. Create uses an existence read, one atomic INSERT, and a re-read. Revision uses a current-row read, one atomic UPDATE conditioned on ID, creator, type, draft/unlisted state, and expected revision, then a re-read. The update merges JSON fields so unrelated native metadata is preserved. Provider work and Inngest delivery are absent from these transactions.

The list operation performs one statement, independent of page size, fetching at most 51 rows with keyset pagination ordered by ID. Contributors are filtered to their owner ID; admins can list all drafts. Published schema indexes available to the list are `type_idx`, `createdById_idx`, and the primary key; point reads and updates use PRIMARY. The local integration suite verifies a point read's EXPLAIN result is `const` on PRIMARY. Production-scale list examined-row budgets remain unmeasured and are a release gate, not a guarantee supplied by LIMIT. Each capability invocation uses one scoped storage connection; concurrent client requests are not globally throttled in this local-only slice.

Returned fields are explicitly decoded; malformed native rows produce InvalidWorkshop instead of silently disappearing. Storage errors are sanitized to StoreUnavailable and are not treated as successful writes. Runtime safety failures are RuntimeBlocked. Mutations do not retire Products, unlink purchases, or rewrite resource relationships.

## Verification

`pnpm workshops:test` runs core handler/property tests and MCP discovery, invocation, confirmation, and runtime-guard tests. These run offline and are included in `pnpm check`. `pnpm --filter @egghead/builder typecheck:workshops` also checks the adapter and projection tests, which the existing builder tsconfig otherwise excludes.

For real MySQL verification, set `WORKSHOP_TEST_DATABASE_URL` to an isolated local database whose name ends in `_test` or `_local`, then run `pnpm --filter @egghead/builder test:workshops:mysql`. The suite creates a uniquely prefixed native resource fixture table and drops it afterward. It proves native persistence/re-read, duplicate identity protection, owner pagination, extra-field preservation, and concurrent compare-and-set updates across independent connections. It does not prove PlanetScale behavior, which is outside this endpoint's allowed runtime.

The native suite also seeds synthetic, disposable device/user/role tables and verifies a confirmed HTTP MCP call through authentication, the shared handler, and persistence. It tests expired/revoked tokens and inactive role assignments. Tokens and synthetic identifiers are generated at runtime and are never saved as fixtures or printed. Token expiry compares against the database clock, avoiding client/server timezone differences. The suite was exercised with temporary MySQL 9.2; target-provider compatibility remains a later release check.

## Follow-on adoption

PR 29 can project this same contract/handler registry through its MCP transport after merging or rebasing. Its legacy sale tools remain separate until the native Product/pricing, checkout, fulfillment, event conversion, and reader cutover work is approved for the appropriate phase. The detailed migration plan remains the guide for that work. This PR makes the native draft-management boundary reviewable without transferring production or commerce ownership.


## Create in chat, view in Egghead

A chat with access to the local MCP endpoint can preview and create a Workshop, then link to the Egghead web app at `/local/workshops/<workshop-id>`. The index at `/local/workshops` lists the same actor's drafts with bounded cursor pagination. Refresh either page after changes in chat.

Run the builder MCP server and the web dev server. Configure these server-only values in the web app's ignored `.env.local`:

```dotenv
EGGHEAD_RUNTIME=local
WORKSHOP_MCP_URL=http://127.0.0.1:3010/api/workshop-mcp
WORKSHOP_MCP_TOKEN=<local-device-token>
```

The preview is available only with `NODE_ENV=development`, `EGGHEAD_RUNTIME=local`, a loopback Workshop endpoint, and a configured device token. Beta and production return 404. The token stays on the server; the browser receives rendered Workshop content. Reads use the existing authenticated MCP capabilities and shared contracts. This adds no browser write endpoint or production content reader. `pnpm workshops:preview:contract` checks the runtime and endpoint restrictions.

This local preview does not make a localhost MCP endpoint reachable from the hosted ChatGPT connector service. Use a chat with local tool access, such as the Codex session running the dev servers.
