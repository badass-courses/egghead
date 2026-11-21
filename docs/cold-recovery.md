# Cold subject archive and grant-only recovery

This is the offline A+B slice. Nothing calls it from authentication, opens a database, provisions storage, or enables production recovery.

## Entry points

- `apps/web/src/access/cold-subject.ts`: `buildSubjectRecords`, `verifySubject`, `identityHmac`, and the versioned envelope schema.
- `apps/web/src/access/cold-archive.ts`: `exportColdArchive`, `verifyColdArchive`, and `ColdArchiveStore`.
- `apps/web/src/access/cold-projector.ts`: `projectClaimedSubject` and `ClaimedUserGrantStore`, the typed seam for a later proved-claim worker.
- `pnpm access:cold:test`: synthetic, in-memory proofs. Also runs in `pnpm check`.

The only batch-code change exports shared line validation. Recovery never calls the batch planner, snapshot reader, or apply function. Grant construction still uses the existing pure `buildExpectedProjection` and its `projectionIds`.

## Envelope and export

Pass the original full NDJSON access export, its independently captured SHA-256, an export id, a support-bundle reference, and the separately approved candidate inventory. Every candidate includes an explicit completed identity inventory, versioned email/provider-UID HMAC facts (possibly empty), contact reference or null, SAML restriction, and a disposition. Missing provider inventory is an error, not an assumed empty identity.

The envelope preserves all seven line kinds, including denied-tenant purchase evidence. Each subscription keeps its parent facts but only this subject's member entry. It does not include other dormant members' identities. The exporter indexes the full export once rather than rescanning it for every candidate.

Each record binds its source digest, export clock, bundle reference, source eligibility law, recovery law, projection version, per-kind counts, completeness, and evidence checksum. Completeness means the supplied **eligible-access export**, not all historical purchases or current commerce truth. The independent candidate inventory covers people absent from that export. `result: empty` explicitly represents no grant evidence, even when a user/pro-holder identity line exists. Banned, quarantined, erased and tombstoned subjects remain non-projectable.

`identityHmac` accepts already-normalized proof inputs. It uses HMAC-SHA256 with versioned JSON tuples separating email from provider/UID domains. Keep keys outside records, fixtures, logs and lookup objects. Slice C still owns normalization, proof validation, ambiguity, SAML enforcement and the unique subject claim.

## Storage and verification

The first digest byte selects one of 256 stable buckets. A populated shard contains newline-terminated subject NDJSON, compressed with gzip **before** AES-256-GCM encryption. A random 96-bit nonce precedes the ciphertext; the 128-bit authentication tag follows it. AAD binds archive format, subject schema, export id, key version and object key.

The private HMAC-SHA256 manifest binds the source/export identity, candidate inventory digest/count, subject-scoped evidence totals, shard membership and byte counts, plaintext checksums and ciphertext checksums. Shared subscription parents are counted once per subject, not once per original export. It contains digests, not raw emails or provider UIDs.

Inject separate 256-bit encryption and authentication keys, identified by key version. The keyring must retain old versions for restore. Production managed-key provisioning/envelope-key wrapping belongs to the storage adapter, not this offline module. The verifier requires a trusted expected export/source/candidate locator; do not derive that expectation from an unverified manifest.

`ColdArchiveStore.put` must be immutable: reject replacement with different bytes. Export writes shards first and publishes the manifest last. Use a new export id for a new publication attempt; randomized ciphertext is not a resumable overwrite format. The key version participates in the object prefix, so rotation can publish a separate bundle. Incomplete uploads have no published manifest.

The verifier authenticates the manifest and verifies **every listed shard** before returning any subjects. It rejects missing keys/objects, truncation, duplicate subjects/buckets, count/checksum mismatches, wrong schemas and provenance drift. Shard I/O runs sequentially to bound simultaneous plaintext buffers. The 64 MiB per-shard decompression limit prevents memory exhaustion; measure heavy-subject/shard sizes before publishing real exports. This implementation materializes the full verified archive in memory and is an offline verifier, not an auth request-time fetcher. A later warm adapter needs a verified-publication receipt and targeted shard fetch without weakening integrity checks.

## Claimed-user projection contract

Call `projectClaimedSubject({record, claim, store, now})` only with a verified archive record and an existing proved, persisted unique claim. Use the actual current clock, not the export clock. `now` is injected for deterministic tests, not permission to backdate recovery.

The store must open one transaction scoped to the claim. It must:

1. Lock/check the persisted claim and existing destination user; serialize with current erasure, ban and commerce overrides.
2. Read authoritative current disposition and purchase revocations. If the overlay is unavailable or incomplete, return `overridesComplete: false`; recovery stays pending and writes nothing.
3. Read entitlements only with `WHERE userId = claimedUserId`.
4. Insert missing grants with a global unique-id conflict check and **do nothing on conflict**, never an upsert. A conflicting id belonging to another user returns `conflict` without exposing that row.
5. Read back inserted grants and roll back the transaction if the callback fails.

There is deliberately no user-create/update, email, membership, organization, seat-flag, revoke, extend or restore API. The projector cannot transfer a claim or copy an archived email. Conflicting, soft-deleted, native and quarantine rows stay unchanged and return a pending reason. An exact existing grant produces no write. Replaying a completed projection changes zero rows.

Automatic grants cover paid Egghead `Playlist` and `Resource::Membership` purchases with complete sellable evidence. The first release is purchase-only: even `lifetime_subscriber` role evidence stays in the envelope and returns a review reason rather than becoming a grant. VIP, staff, basic and other special roles also remain pending review, never administrative roles. The unchanged batch builder retains its broader role/basic/lifetime mechanics; this release does not invoke them.

Purchase application ids `10`, `111`, and historical `NULL` are allowed. Missing application ids fail validation; every other application denies. Refund/dispute/revoked/unknown states, bulk/country restrictions, unknown sellables and malformed expiries remain pending. Expired purchases grant nothing. Finite expiries beyond the shared builder's MySQL range remain pending rather than becoming permanent grants.

Subscriptions, team seats, gifts, managed and legacy backing all return `pending_reconciliation` reason codes. No lenient subscription or bare-pro grant is projected. An independent valid purchase may still be granted while unsupported evidence remains pending; the job must not mark that subject fully recovered. Bare `pro` alone grants nothing, and its historical sign-in timestamp never changes.

## Proof boundary

The suite covers candidate coverage, all seven kinds, explicit empties, provider facts, encryption/decryption, key rotation, backup copies, malformed/authenticated corruption, tenant filtering, tombstones/current overrides, shared batch keys, zero-change replay, unrelated Rails-owned rows, native/quarantine rows, shared seat flags, stale email, strict purchase eligibility, claim failures and transactional readback rollback.

It does not prove a production database/storage adapter, auth callbacks, concurrent claim acquisition, a durable job/outbox, current-overlay provisioning, provider-key recovery, or runtime library access. Those remain prerequisites for wiring recovery into sign-in. This packet does not authorize an export, production access, commerce writes, or Rails shutdown.
