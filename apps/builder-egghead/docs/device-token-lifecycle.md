# Builder device-token lifecycle

Grant state sketch (XState-style): `pending --VERIFY [unexpired, signed-in]--> approved --EXCHANGE [unexpired, consume succeeds]--> consumed`. Pending and approved grants both enter `expired` at their deadline. Expired, unknown and consumed grants cannot issue tokens. The exchange consumes the grant and inserts the token in one database transaction. Concurrent exchanges compete on the conditional grant deletion; only its winner can insert.

Token state sketch: `active --REVOKE [authenticated owner]--> revoked`; `active --deadline--> expired`. Both terminal states refuse bearer operations. Legacy tokens with NULL expiry remain active until revoked; this PR does not silently expire existing integrations.

Legacy phase-out is owner-driven, not a bulk expiry change: reauthorize each caller to obtain a 30-day token, confirm that caller works with the replacement, then revoke its old NULL-expiry token through `/oauth/revoke`. Keep NULL meaning no expiry until every legacy caller has migrated or been explicitly retired. A later, separately reviewed change may reject NULL expiry only after that inventory is closed. This PR performs no mass update or automatic cutoff.

New tokens expire after **30 days**, from `DEVICE_ACCESS_TOKEN_TTL_SECONDS` in `src/server/device-token-policy.ts`. Device grants last ten minutes, including approved grants awaiting exchange. The token response returns the exact generated/inserted credential with `expires_in`; it never selects a token by user ID. The existing `content:read progress` scope is recorded on issuance, not treated as a new permission grant. Active database roles and CASL still authorize content operations.

`POST /oauth/revoke` requires the token itself in `Authorization: Bearer …` and revokes only that token, constrained by its authenticated user's ID. It takes no target-token input and has no browser-cookie fallback. A successful call returns 204. Reuse returns 401, as do expired, revoked, unknown and malformed tokens. No separate admin-target revocation operation is included.

Bearer lookup errors fail closed to 401. Logs contain only the event `device_authentication_denied` and a fixed reason, never the exception, SQL or credential. Requests with invalid bearer credentials cannot fall back to a browser session. Public/session routes keep their existing no-bearer behavior; device-authenticated routes require a valid device identity before reading content or parsing write bodies.

## Schema snapshot and deployment prerequisite

`test/fixtures/live-schema.sql` contains only CREATE TABLE definitions from the desk's 2026-11-21 schema dump, without row data or AUTO_INCREMENT counter values. The snapshot additionally includes `DeviceAccessToken.scope` as nullable `varchar(191)`, and `expiresAt`/`revokedAt` as nullable `timestamp(3)`. The desk confirmed additive deploy request 11 landed those three columns. The snapshot is a committed contract, not a fresh live probe; confirm deployment state before running bearer proof. Other discovered drift is not added to this snapshot until its schema request is live.

The schema-drift test checks every exported builder Drizzle table, including published adapter tables, against the snapshot. Missing tables or selected columns fail CI. Extra live columns are permitted. This checks column presence, not types, indexes, runtime reachability or a freshly queried production database. Refresh the data-free snapshot from an approved dump when the live schema changes; do not add invented columns merely to pass the test.

## Desk proof

After the schema deploy and authorized app deployment, complete a fresh device grant, exchange it, and verify that the returned token works at `/oauth/userinfo`. Call `/oauth/revoke` with that same token, then require 401 from userinfo, content MCP and post APIs. Use a short-lived synthetic fixture for expiry tests; do not alter production expiry by hand. Keep credentials in a private process environment and retain only redacted pass/fail receipts. This lane performs no live writes.
