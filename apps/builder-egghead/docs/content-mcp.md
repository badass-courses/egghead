# Content MCP: read and draft

`POST /api/content-mcp` is a stateless Streamable HTTP MCP endpoint. Vercel Deployment Protection stays enabled. The endpoint requires its own bearer device token even when the caller has a browser session or a protection bypass.

Headers:

- `Authorization: Bearer <device-token>`
- `X-Actor-Label: <agent-name>` (1–100 ASCII characters; letters, numbers, spaces, `.`, `_`, `/`, `-`; starts with a letter or number)
- `Content-Type: application/json`
- `Accept: application/json, text/event-stream`
- The MCP protocol header negotiated by the SDK
- `x-vercel-protection-bypass` when required by the deployment

The label is caller-supplied attribution, not an authorization claim. Device tokens remain person-bound. Active database role assignments determine CASL permissions. Missing, unknown, revoked, expired, unverified and no-role tokens are refused. Legacy tokens with a NULL expiry keep the existing Workshop policy (no expiry). Inactive or deleted assignments and roles grant nothing. Authentication does not require creation permission. Each tool checks its own CASL ability: broad `read Content` before listing, `read` on the post for a single read, `create Content` for creation, and `manage` on the post for editing. Read-only and manage-only identities can use their authorized operations without gaining creation permission.

## Owned contract

`@egghead/core` is a private workspace package (`private: true`), not a published package. The `@egghead/core/contracts/content` subpath defines Effect Schema inputs, outputs and typed failures. `@egghead/core/content` implements the four capabilities:

| Tool           | Arguments                                | Permission                                                                                                     |
| -------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `list_posts`   | `limit` (1–50), optional `cursor`        | Requires `read Content`. Admins list all native posts; other callers list their own. Every result must also pass `read` on the post. |
| `get_post`     | `id`                                     | `read Content` on that post                                                                                    |
| `create_draft` | `title`, `body`, `postType`, `fields`    | `create Content`                                                                                               |
| `update_draft` | `id`, optional `title`, `body`, `fields` | `manage Content` on that post, and its current state must be `draft`                                           |

`postType` is `lesson`, `article`, `podcast` or `course`. Allowed `fields` are `description`, `summary`, `image`, `ogImage`, `github` and `gitpod`. An empty fields object is valid. Fields patch existing values; an empty string clears a text field. State, visibility, access, ownership, tags, integration IDs and audit data cannot be supplied. Unknown properties are rejected, including nested properties.

No publish, unpublish, delete, tagging, placement, video or instructor tools exist here. Writes do not require a second confirmation; the editor's bearer token authorizes this draft-only surface. Create is not idempotent: do not blindly retry an uncertain response; inspect the author's recent drafts first.

## Persistence and audit

The store creates native `ContentResource` rows through the published CourseBuilder adapter. IDs and slugs follow the builder's post conventions. New resources are `type=post`, `state=draft`, `visibility=unlisted`, and retain the builder's `access=pro` metadata. That metadata is not an entitlement grant.

Edits target the same native rows. The adapter's current field-update method has no conditional update facility, so the store uses a small SQL boundary on the same table. It atomically compares the full stored fields snapshot, owner, draft state, resource type and deletion status before patching. A concurrent publication, deletion, transfer or edit makes the write fail with `Conflict`. Unknown stored fields are preserved. A client that races another writer must read again.

Every successful create or edit appends `{userId, actorLabel, tokenId, at}` to `fields.contentMcpAudit` in the same statement as the content write. `DeviceAccessToken` has no separate row ID: its primary key is the bearer secret. Accordingly `tokenId` is the SHA-256 digest of that key, never the credential itself. Clients cannot replace the history through this contract. The audit is not tamper-proof against other privileged database writers.

This slice writes CourseBuilder drafts only. It does not create Rails resources, call external lesson synchronization, index search, or publish. Those workflows are outside these tools. It does not create UI version rows; its per-write history is `contentMcpAudit`.

`getUserAbilityForRequest` and the local Workshop actor use the same token validity and active-role policy. The Workshop endpoint remains local-only.

## Verification

Use Node 24 and pnpm 11.3.0:

```sh
mise exec node@24 pnpm@11.3.0 -- pnpm check
cd apps/builder-egghead
mise exec node@24 pnpm@11.3.0 -- pnpm typecheck:workshops
mise exec node@24 pnpm@11.3.0 -- pnpm exec vitest run --config vitest.workshops.config.ts
```

If an inherited PATH selects another Node inside scripts, prepend the Node 24 bin directory within the mise shell before invoking pnpm. Confirm `pnpm exec node --version` prints v24.

The root fence intentionally excludes legacy builder files from lint and format. The focused TypeScript configuration and Workshop test command include the new content implementation and tests. Run formatting and syntax lint from `apps/builder-egghead` on the changed content files as well.

The existing isolated MySQL harness includes `test/workshops-mysql/content-store.test.ts`. Set `EGGHEAD_RUNTIME=local` and `WORKSHOP_TEST_DATABASE_URL` to a local test database accepted by the runtime guard, then run:

```sh
pnpm exec vitest run --config vitest.workshops-mysql.config.ts test/workshops-mysql/content-store.test.ts
```

This uses uniquely prefixed fixture tables, the published CourseBuilder adapter for creation, the production draft-update SQL, and the same capability/store layer. It exercises create, read, list, edit, audit persistence, stale-snapshot refusal and published-post refusal. It drops only its own fixture tables. Do not point it at a shared or production database.

## Desk live proof

Deployment and production writes are separate approvals. This implementation does not run them.

1. Connect an MCP SDK client to the deployed `/api/content-mcp` with the protection bypass header, a valid editor device token and `X-Actor-Label` identifying the proof agent. Keep both secrets in the process environment, not a checked-in file or command argument.
2. Call `tools/list`. Confirm exactly `list_posts`, `get_post`, `create_draft`, `update_draft`.
3. Call `create_draft` with `{title: "Content MCP proof draft", body: "Original proof body", postType: "article", fields: {description: "Draft-only proof"}}`. Retain the returned ID.
4. Call `update_draft` with that ID and `{title: "Content MCP proof draft edited", body: "Edited proof body"}`.
5. Call `get_post` with the ID. Confirm the edited title and body and `state=draft`. Call `list_posts` as the same person and follow cursors if needed to find it.
6. Inspect the native row privately: confirm two audit entries with the expected user, label and hashed token identity. Do not copy credentials or customer rows into PRs or fixtures.
7. Confirm a revoked device token cannot use the content endpoint or create through `/api/posts`. Restore or replace the dedicated proof token only through its normal token lifecycle.

Run this from `apps/builder-egghead` only after the desk has authorized the target deployment and draft write. Supply secrets through the process environment: `CONTENT_MCP_DEVICE_TOKEN`, `CONTENT_MCP_REVOKED_TOKEN` (a dedicated token already revoked through its normal lifecycle), and `VERCEL_AUTOMATION_BYPASS_SECRET`. Set `CONTENT_MCP_BASE_URL` to the exact authorized deployment origin. The script leaves one draft and prints only its new resource ID.

```sh
pnpm exec tsx --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
const required = (key) => {
  const value = process.env[key]
  assert(value, `Missing ${key}`)
  return value
}
const base = new URL(required('CONTENT_MCP_BASE_URL'))
assert.equal(base.protocol, 'https:')
const token = required('CONTENT_MCP_DEVICE_TOKEN')
const revoked = required('CONTENT_MCP_REVOKED_TOKEN')
assert.notEqual(token, revoked)
const bypass = required('VERCEL_AUTOMATION_BYPASS_SECRET')
const headers = {
  Authorization: `Bearer ${token}`,
  'X-Actor-Label': 'desk-content-proof',
  'x-vercel-protection-bypass': bypass,
}
const client = new Client({ name: 'desk-content-proof', version: '1' })
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('/api/content-mcp', base), {
    requestInit: { headers },
  }))
  assert.deepEqual((await client.listTools()).tools.map(({ name }) => name),
    ['list_posts', 'get_post', 'create_draft', 'update_draft'])
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args })
    assert.notEqual(result.isError, true, 'Content tool refused the proof operation')
    assert(result.structuredContent)
    return result.structuredContent
  }
  const created = await call('create_draft', {
    title: 'Content MCP proof draft', body: 'Original proof body', postType: 'article', fields: {},
  })
  assert.equal(typeof created.id, 'string')
  console.log(`Proof draft ID: ${created.id}`)
  await call('update_draft', { id: created.id, title: 'Content MCP proof draft edited', body: 'Edited proof body' })
  const read = await call('get_post', { id: created.id })
  assert.equal(read.fields.title, 'Content MCP proof draft edited')
  assert.equal(read.fields.body, 'Edited proof body')
  assert.equal(read.fields.state, 'draft')
  const revokedHeaders = {
    ...headers, Authorization: `Bearer ${revoked}`, 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  const deniedMcp = await fetch(new URL('/api/content-mcp', base), {
    method: 'POST', headers: revokedHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  assert.equal(deniedMcp.status, 401)
  const deniedPosts = await fetch(new URL('/api/posts', base), {
    method: 'POST', headers: revokedHeaders,
    body: JSON.stringify({ title: 'Must never be created', postType: 'article' }),
  })
  assert.equal(deniedPosts.status, 401)
} finally {
  await client.close()
}
JS
```

Using the desk's read-only database access, inspect only `fields.contentMcpAudit` on that returned resource ID. Require exactly two entries with the expected person, `actorLabel=desk-content-proof`, and `tokenId` equal to SHA-256 of the proof token; never paste the token into SQL. Retain a redacted pass/fail receipt rather than the raw row. HTTP success alone does not prove this audit check.

Leave the proof as a draft. Do not publish or delete it through this slice.
