import assert from "node:assert/strict";
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  exportColdArchive,
  verifyColdArchive,
  type ArchiveKeys,
  type ArchiveManifest,
  type ColdArchiveStore,
} from "../apps/web/src/access/cold-archive";
import {
  projectClaimedSubject,
  type ClaimedUserGrantStore,
  type ClaimedUserTransaction,
  type CurrentSubjectState,
  type SubjectClaim,
} from "../apps/web/src/access/cold-projector";
import {
  buildSubjectRecords,
  candidateSchema,
  evidenceFields,
  identityHmac,
  sha256,
  verifySubject,
  type ColdCandidate,
  type SubjectEnvelope,
} from "../apps/web/src/access/cold-subject";
import {
  buildExpectedProjection,
  parseRailsAccessExport,
  projectionIds,
  type CbEntitlement,
  type IdentityOutcome,
  type RailsPurchase,
  type RailsSubscription,
  type RailsUser,
} from "../apps/web/src/access/rails-access-delta";

const EXPORTED_AT = "2026-10-01T00:00:00.000Z";
const NOW = new Date("2026-11-21T12:00:00.000Z");
// Ephemeral synthetic test keys, never credentials.
const keys = (): ArchiveKeys => ({ encryption: randomBytes(32), authentication: randomBytes(32) });
const user = (railsUserId = "synthetic-1001"): RailsUser => ({
  kind: "user",
  railsUserId,
  email: "dormant.buyer@example.test",
  firstName: null,
  lastName: null,
  avatarUrl: null,
  confirmedAt: EXPORTED_AT,
  createdAt: "2019-01-01T00:00:00Z",
  isBanned: false,
  signInCount: 0,
  hasAuthenticationToken: false,
});
const purchase = (overrides: Partial<RailsPurchase> = {}): RailsPurchase => ({
  kind: "purchase",
  railsSellablePurchaseId: "synthetic-purchase-1",
  railsUserId: "synthetic-1001",
  railsApplicationId: "111",
  sellableType: "Resource::Membership",
  sellableId: "synthetic-lifetime",
  purchaseState: "paid",
  bulk: false,
  restrictedToCountry: null,
  expiresAt: null,
  createdAt: "2019-01-01T00:00:00Z",
  ...overrides,
});
const subscription = (): RailsSubscription => ({
  kind: "subscription",
  railsAccountSubscriptionId: "synthetic-subscription-1",
  railsAccountId: "synthetic-account-1",
  accountName: null,
  accountSlug: null,
  accountGuid: null,
  status: "active",
  quantity: 2,
  currentPeriodStart: EXPORTED_AT,
  currentPeriodEnd: "2027-01-01T00:00:00Z",
  cancelAtPeriodEnd: false,
  createdAt: EXPORTED_AT,
  stripeCustomerIdPresent: false,
  stripeSubscriptionIdPresent: false,
  members: ["synthetic-1001", "synthetic-other"].map((railsUserId) => ({
    railsUserId,
    railsAccountUserId: `seat-${railsUserId}`,
    hasMemberRole: true,
    hasOwnerRole: railsUserId === "synthetic-1001",
    createdAt: EXPORTED_AT,
  })),
});
function candidate(railsUserId = "synthetic-1001"): ColdCandidate {
  return {
    railsUserId,
    disposition: "eligible",
    identity: {
      inventory: "complete",
      emailHmacs: [],
      providerUidHmacs: [],
      legacyContactId: null,
      samlRequired: false,
    },
  };
}
type FixtureLine = { kind: string; [key: string]: unknown };
function source(lines: readonly FixtureLine[]) {
  const counts: Record<string, number> = {
    user: 0,
    role_grant: 0,
    basic_grant: 0,
    subscription: 0,
    purchase: 0,
    pro_holder: 0,
    backing_grant: 0,
  };
  for (const line of lines) {
    if (!(line.kind in counts)) throw new Error("invalid fixture");
    counts[line.kind] = (counts[line.kind] ?? 0) + 1;
  }
  return (
    [
      ...lines,
      {
        kind: "manifest",
        format: "egghead-rails-access-export/v3",
        exportedAt: EXPORTED_AT,
        counts,
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n"
  );
}
function records(lines: readonly FixtureLine[] = [user(), purchase()], candidates = [candidate()]) {
  const exportText = source(lines);
  return buildSubjectRecords({
    exportText,
    expectedSourceSha256: sha256(exportText),
    exportId: "synthetic-export-v1",
    bundleKey: "synthetic-support-bundle-v1",
    candidates,
  });
}
function firstRecord(
  lines?: readonly FixtureLine[],
  candidates?: ColdCandidate[],
): SubjectEnvelope {
  const record = records(lines, candidates)[0];
  assert.ok(record);
  return record;
}
class MemoryArchive implements ColdArchiveStore {
  objects = new Map<string, Uint8Array>();
  get(key: string) {
    return Promise.resolve(this.objects.get(key) ?? null);
  }
  put(key: string, bytes: Uint8Array) {
    const existing = this.objects.get(key);
    if (existing && !Buffer.from(existing).equals(Buffer.from(bytes)))
      throw new Error("immutable object conflict");
    this.objects.set(key, bytes);
    return Promise.resolve();
  }
}
async function archive(
  lines: readonly FixtureLine[] = [user(), purchase()],
  candidates = [candidate()],
  keyVersion = "test-key-v1",
) {
  const store = new MemoryArchive();
  const secret = keys();
  const exportText = source(lines);
  const published = await exportColdArchive({
    store,
    keys: secret,
    keyVersion,
    exportText,
    expectedSourceSha256: sha256(exportText),
    exportId: "synthetic-export-v1",
    bundleKey: "synthetic-support-bundle-v1",
    candidates,
  });
  const input = {
    store,
    manifestKey: published.manifestKey,
    keyring: (version: string) => {
      assert.equal(version, keyVersion);
      return secret;
    },
    expected: {
      exportId: published.manifest.body.exportId,
      sourceSha256: sha256(exportText),
      candidateCount: candidates.length,
      candidateDigest: sha256(
        JSON.stringify(candidates.map((row) => sha256(row.railsUserId)).toSorted()),
      ),
    },
  };
  return { ...published, input, store, secret };
}
function resign(manifest: ArchiveManifest, secret: ArchiveKeys) {
  manifest.mac = createHmac("sha256", secret.authentication)
    .update(JSON.stringify(manifest.body))
    .digest("hex");
  return Buffer.from(JSON.stringify(manifest));
}

const claim: SubjectClaim = {
  claimId: "synthetic-claim-1",
  userId: "synthetic-cb-user",
  railsUserId: "synthetic-1001",
};
class MemoryGrantStore implements ClaimedUserGrantStore {
  state: CurrentSubjectState = {
    claim,
    userExists: true,
    disposition: "eligible",
    overridesComplete: true,
    deniedPurchaseIds: [],
  };
  rows = new Map<string, CbEntitlement>();
  userEmail = "proved.current@example.test";
  memberships = [
    {
      id: "synthetic-shared-seat",
      userId: "synthetic-other",
      fields: { hasAccountMemberRole: true },
    },
  ];
  readUsers: string[] = [];
  writeUsers: string[] = [];
  failReadback = false;
  withClaimedUser<T>(
    claimed: SubjectClaim,
    work: (tx: ClaimedUserTransaction) => Promise<T>,
  ): Promise<T> {
    const before = new Map(this.rows);
    let reads = 0;
    const tx: ClaimedUserTransaction = {
      readCurrentState: () => Promise.resolve(this.state),
      readEntitlements: () => {
        reads++;
        this.readUsers.push(claimed.userId);
        return Promise.resolve(
          reads > 1 && this.failReadback
            ? []
            : [...this.rows.values()].filter((row) => row.userId === claimed.userId),
        );
      },
      insertGrantIfAbsent: (row) => {
        assert.equal(row.userId, claimed.userId);
        this.writeUsers.push(claimed.userId);
        if (this.rows.has(row.id)) return Promise.resolve("conflict");
        this.rows.set(row.id, { ...row, deletedAt: null });
        return Promise.resolve("inserted");
      },
    };
    return work(tx).catch((error: unknown) => {
      this.rows = before;
      throw error;
    });
  }
}
function project(record = firstRecord(), store = new MemoryGrantStore()) {
  return projectClaimedSubject({ record, claim, store, now: NOW });
}
function unrelatedRow(overrides: Partial<CbEntitlement> = {}): CbEntitlement {
  return {
    id: "synthetic-unrelated-rails",
    entitlementType: "egghead_membership_access",
    userId: "synthetic-other",
    sourceType: "rails_sellable_purchase",
    sourceId: "synthetic-unrelated-purchase",
    organizationId: null,
    organizationMembershipId: null,
    expiresAt: null,
    deletedAt: null,
    metadata: {},
    ...overrides,
  };
}

void test("all seven kinds and explicit empty candidates survive; parent subscription is subject scoped", async () => {
  const id = "synthetic-1001";
  const lines = [
    user(),
    purchase(),
    subscription(),
    { kind: "role_grant", railsUserId: id, roleName: "lifetime_subscriber" },
    { kind: "basic_grant", railsUserId: id },
    { kind: "pro_holder", railsUserId: id, lastSignInOn: "2019-01-01" },
    {
      kind: "backing_grant",
      railsUserId: id,
      railsSourceId: "synthetic-gift",
      source: "gift",
      expiresAt: EXPORTED_AT,
      currentPeriodEnd: null,
    },
  ];
  const result = records(lines, [candidate(), candidate("synthetic-empty")]);
  const full = result.find((record) => record.subject.railsUserId === id);
  const empty = result.find((record) => record.subject.railsUserId === "synthetic-empty");
  assert.ok(full && empty);
  assert.deepEqual(
    evidenceFields.map((field) => full.counts[field]),
    [1, 1, 1, 1, 1, 1, 1],
  );
  assert.equal(full.evidence.subscriptions[0]?.members.length, 1);
  assert.equal(empty.result, "empty");
  assert.ok(Object.values(empty.counts).every((count) => count === 0));
  assert.equal(empty.source.sha256, full.source.sha256);
  assert.equal(firstRecord([user()]).result, "empty");
  const published = await archive(lines, [candidate(), candidate("synthetic-empty")]);
  const restored = await verifyColdArchive(published.input);
  assert.deepEqual(
    restored.find((record) => record.subject.railsUserId === id),
    full,
  );
  assert.deepEqual(
    restored.find((record) => record.result === "empty"),
    empty,
  );
  const store = new MemoryGrantStore();
  store.state = { ...store.state, claim: { ...claim, railsUserId: "synthetic-empty" } };
  assert.equal(
    (await projectClaimedSubject({ record: empty, claim: store.state.claim, store, now: NOW }))
      .changed,
    0,
  );
});

void test("missing provider inventory, duplicate candidates, truncated source and checksum mismatch refuse", () => {
  const malformed: unknown = { ...candidate(), identity: { emailHmacs: [] } };
  assert.throws(() => candidateSchema.parse(malformed));
  assert.throws(() => records([user()], [candidate(), candidate()]), /duplicate candidate/);
  const exportText = source([user()]);
  assert.throws(
    () =>
      buildSubjectRecords({
        exportText,
        expectedSourceSha256: "0".repeat(64),
        exportId: "test",
        bundleKey: "test",
        candidates: [],
      }),
    /checksum/,
  );
  const truncated = JSON.stringify(user());
  assert.throws(
    () =>
      buildSubjectRecords({
        exportText: truncated,
        expectedSourceSha256: sha256(truncated),
        exportId: "test",
        bundleKey: "test",
        candidates: [],
      }),
    /incomplete|truncated/,
  );
});

void test("versioned HMAC facts separate email/provider domains and provider/UID boundaries", () => {
  const key = randomBytes(32);
  const email = identityHmac(key, "v1", {
    kind: "email",
    normalizedEmail: "dormant.buyer@example.test",
  });
  const uid = identityHmac(key, "v1", {
    kind: "provider_uid",
    provider: "github",
    uid: "synthetic-uid-1",
  });
  assert.notEqual(email.digest, uid.digest);
  assert.notEqual(
    email.digest,
    identityHmac(key, "v2", { kind: "email", normalizedEmail: "dormant.buyer@example.test" })
      .digest,
  );
  const c = candidate();
  c.identity.emailHmacs.push(email);
  c.identity.providerUidHmacs.push({ ...uid, provider: "github" });
  const record = firstRecord([user()], [c]);
  assert.deepEqual(record.subject.identity, c.identity);
  assert.notEqual(
    identityHmac(key, "v1", { kind: "provider_uid", provider: "a:b", uid: "c" }).digest,
    identityHmac(key, "v1", { kind: "provider_uid", provider: "a", uid: "b:c" }).digest,
  );
});

void test("subject verifier rejects wrong schema, counts, checksum, kind coverage, cross-subject and missing application", () => {
  const record = firstRecord();
  assert.throws(() => verifySubject({ ...record, schemaVersion: "future" }));
  assert.throws(
    () => verifySubject({ ...record, counts: { ...record.counts, purchases: 2 } }),
    /count/,
  );
  assert.throws(() => verifySubject({ ...record, evidenceSha256: "0".repeat(64) }), /checksum/);
  assert.throws(
    () =>
      verifySubject({
        ...record,
        completeness: { ...record.completeness, kinds: Array(7).fill("users") },
      }),
    /incomplete/,
  );
  const other = { ...record.evidence, users: [user("synthetic-other")] };
  assert.throws(
    () =>
      verifySubject({ ...record, evidence: other, evidenceSha256: sha256(JSON.stringify(other)) }),
    /boundary/,
  );
  const badPurchase = { ...purchase() };
  const { railsApplicationId: _application, ...missingApplication } = badPurchase;
  assert.throws(() => records([user(), missingApplication]));
});

void test("encrypted compressed archive roundtrip, stable buckets and separate backup with Rails absent", async () => {
  const { input, store, manifest } = await archive(
    [user(), purchase()],
    [candidate(), candidate("synthetic-empty")],
  );
  const restored = await verifyColdArchive(input);
  assert.equal(restored.length, 2);
  assert.deepEqual(
    restored.find((record) => record.subject.railsUserId === "synthetic-1001"),
    firstRecord(),
  );
  for (const shard of manifest.body.shards) {
    assert.ok(
      shard.subjects.every((digest) => Number.parseInt(digest.slice(0, 2), 16) === shard.bucket),
    );
    assert.ok(!Buffer.from(store.objects.get(shard.key) ?? []).includes("@example.test"));
  }
  assert.ok(!Buffer.from(store.objects.get(input.manifestKey) ?? []).includes("@example.test"));
  const backup = new MemoryArchive();
  backup.objects = new Map(store.objects);
  assert.deepEqual(await verifyColdArchive({ ...input, store: backup }), restored);
});

void test("key rotation retains old decryption and rejects wrong, unknown and non-separated keys", async () => {
  const old = await archive();
  const next = await archive([user(), purchase()], [candidate()], "test-key-v2");
  const keyring = (version: string) => {
    if (version === "test-key-v1") return old.secret;
    if (version === "test-key-v2") return next.secret;
    throw new Error("unknown key version");
  };
  assert.equal((await verifyColdArchive({ ...old.input, keyring })).length, 1);
  assert.equal((await verifyColdArchive({ ...next.input, keyring })).length, 1);
  await assert.rejects(
    verifyColdArchive({ ...old.input, keyring: () => keys() }),
    /authentication/,
  );
  await assert.rejects(
    verifyColdArchive({
      ...old.input,
      keyring: () => {
        throw new Error("key unavailable");
      },
    }),
    /unavailable/,
  );
  await assert.rejects(
    verifyColdArchive({
      ...old.input,
      keyring: () => ({ encryption: old.secret.encryption, authentication: old.secret.encryption }),
    }),
    /separate/,
  );
});

void test("missing/truncated/corrupt shards and missing/tampered manifest refuse", async () => {
  const { input, manifest, store } = await archive();
  const shard = manifest.body.shards[0];
  assert.ok(shard);
  const bytes = store.objects.get(shard.key);
  assert.ok(bytes);
  store.objects.delete(shard.key);
  await assert.rejects(verifyColdArchive(input), /missing shard/);
  store.objects.set(shard.key, bytes.subarray(0, -1));
  await assert.rejects(verifyColdArchive(input), /checksum/);
  store.objects.set(shard.key, Buffer.alloc(bytes.length));
  await assert.rejects(verifyColdArchive(input), /checksum/);
  store.objects.set(shard.key, bytes);
  manifest.body.bundleKey = "tampered";
  store.objects.set(input.manifestKey, Buffer.from(JSON.stringify(manifest)));
  await assert.rejects(verifyColdArchive(input), /authentication/);
  store.objects.delete(input.manifestKey);
  await assert.rejects(verifyColdArchive(input), /missing manifest/);
});

void test("authenticated but inconsistent manifest count/checksum/schema and substituted bundle refuse", async () => {
  await Promise.all(
    (["counts", "candidateCount", "plaintextSha256", "schema"] as const).map(async (mutation) => {
      const { input, manifest, store, secret } = await archive();
      const shard = manifest.body.shards[0];
      assert.ok(shard);
      if (mutation === "counts") manifest.body.counts.purchases++;
      if (mutation === "candidateCount") manifest.body.candidateCount++;
      if (mutation === "plaintextSha256") shard.plaintextSha256 = "0".repeat(64);
      if (mutation === "schema") {
        const raw = { ...manifest.body, subjectSchema: "egghead-cold-subject/future" };
        store.objects.set(
          input.manifestKey,
          Buffer.from(JSON.stringify({ body: raw, mac: manifest.mac })),
        );
      } else store.objects.set(input.manifestKey, resign(manifest, secret));
      await assert.rejects(verifyColdArchive(input));
    }),
  );
  const { input } = await archive();
  await assert.rejects(
    verifyColdArchive({ ...input, expected: { ...input.expected, exportId: "different" } }),
    /unexpected/,
  );
});

void test("AEAD refuses tampering even when ciphertext checksum is reauthenticated", async () => {
  const { input, manifest, store, secret } = await archive();
  const shard = manifest.body.shards[0];
  assert.ok(shard);
  const bytes = store.objects.get(shard.key);
  assert.ok(bytes);
  const corrupted = Buffer.from(bytes);
  corrupted[15] = (corrupted[15] ?? 0) ^ 1;
  shard.ciphertextSha256 = sha256(corrupted);
  store.objects.set(shard.key, corrupted);
  store.objects.set(input.manifestKey, resign(manifest, secret));
  await assert.rejects(verifyColdArchive(input));
});

void test("authenticated truncated NDJSON, corrupt subject and record count fail after decryption", async () => {
  await Promise.all(
    (["newline", "subject", "count"] as const).map(async (mode) => {
      const { input, manifest, store, secret } = await archive();
      const shard = manifest.body.shards[0];
      assert.ok(shard);
      const record = firstRecord();
      const raw = mode === "subject" ? { ...record, schemaVersion: "future" } : record;
      const plaintext = Buffer.from(JSON.stringify(raw) + (mode === "newline" ? "" : "\n"));
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", secret.encryption, nonce);
      cipher.setAAD(
        Buffer.from(
          JSON.stringify([
            manifest.body.format,
            manifest.body.subjectSchema,
            manifest.body.exportId,
            manifest.body.keyVersion,
            shard.key,
          ]),
        ),
      );
      const encrypted = Buffer.concat([
        nonce,
        cipher.update(gzipSync(plaintext)),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      shard.bytes = encrypted.byteLength;
      shard.ciphertextSha256 = sha256(encrypted);
      shard.plaintextSha256 = sha256(plaintext);
      shard.plaintextBytes = plaintext.byteLength;
      if (mode === "count") shard.subjects.push(sha256("synthetic-missing"));
      store.objects.set(shard.key, encrypted);
      store.objects.set(input.manifestKey, resign(manifest, secret));
      await assert.rejects(verifyColdArchive(input));
    }),
  );
});

void test("claimed lifetime/course keys equal batch builder; second run changes zero and old email stays", async () => {
  const course = purchase({
    railsSellablePurchaseId: "synthetic-course-purchase",
    railsApplicationId: "10",
    sellableType: "Playlist",
    sellableId: "synthetic-course-1",
  });
  const lines = [user(), purchase(), course];
  const record = firstRecord(lines);
  const store = new MemoryGrantStore();
  assert.equal((await project(record, store)).changed, 2);
  const identities = new Map<string, IdentityOutcome>([
    [claim.railsUserId, { kind: "linked", userId: claim.userId }],
  ]);
  const batch = buildExpectedProjection(parseRailsAccessExport(source(lines)), identities);
  assert.deepEqual([...store.rows.keys()].toSorted(), [...batch.entitlements.keys()].toSorted());
  assert.equal((await project(record, store)).changed, 0);
  assert.equal(store.userEmail, "proved.current@example.test");
  const courses = [...store.rows.values()].filter(
    (row) => row.entitlementType === "egghead_playlist_access",
  );
  assert.equal(courses.length, 1);
  assert.equal(courses[0]?.metadata["sellableId"], "synthetic-course-1");
  assert.equal(
    courses[0]?.metadata["productId"],
    projectionIds.product("Playlist", "synthetic-course-1"),
  );
});

void test("applications 10,111,NULL grant; every other tenant denies without recoding provenance", async () => {
  await Promise.all(
    ["10", "111", null, "12", "", "unknown"].map(async (railsApplicationId) => {
      const record = firstRecord([user(), purchase({ railsApplicationId })]);
      assert.equal(record.evidence.purchases[0]?.railsApplicationId, railsApplicationId);
      const store = new MemoryGrantStore();
      const result = await project(record, store);
      assert.equal(
        result.changed,
        railsApplicationId === "10" || railsApplicationId === "111" || railsApplicationId === null
          ? 1
          : 0,
      );
    }),
  );
});

void test("unrelated Rails rows, shared seat flags, native and quarantine rows remain byte-for-byte unchanged", async () => {
  const store = new MemoryGrantStore();
  const rows = [
    unrelatedRow(),
    unrelatedRow({ id: "synthetic-org", userId: null, organizationId: "synthetic-shared-org" }),
    unrelatedRow({ id: "synthetic-native", userId: claim.userId, sourceType: "stripe" }),
    unrelatedRow({
      id: "synthetic-quarantine",
      userId: claim.userId,
      sourceType: "rails_bare_pro_quarantine",
    }),
  ];
  rows.forEach((row) => store.rows.set(row.id, row));
  const before = structuredClone(rows);
  const seats = structuredClone(store.memberships);
  assert.equal((await project(firstRecord(), store)).changed, 1);
  assert.equal((await project(firstRecord(), store)).changed, 0);
  assert.deepEqual(
    rows.map((row) => store.rows.get(row.id)),
    before,
  );
  assert.deepEqual(store.memberships, seats);
  assert.ok(store.readUsers.every((id) => id === claim.userId));
  assert.ok(store.writeUsers.every((id) => id === claim.userId));
  const implementation = await readFile(
    new URL("../apps/web/src/access/cold-projector.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(implementation, /computeDeltaPlan|applyDeltaOps|readCbSnapshot/);
});

void test("tombstones, erasure, quarantine, ban and current revocations block resurrection", async () => {
  await Promise.all(
    (["tombstoned", "erased", "quarantined", "banned"] as const).map(async (disposition) => {
      const c = { ...candidate(), disposition };
      assert.equal((await project(firstRecord([user(), purchase()], [c]))).status, "blocked");
      const store = new MemoryGrantStore();
      store.state = { ...store.state, disposition };
      assert.equal((await project(firstRecord(), store)).changed, 0);
    }),
  );
  assert.equal(
    (await project(firstRecord([{ ...user(), isBanned: true }, purchase()]))).status,
    "blocked",
  );
  const store = new MemoryGrantStore();
  store.state = { ...store.state, deniedPurchaseIds: [purchase().railsSellablePurchaseId] };
  assert.equal((await project(firstRecord(), store)).changed, 0);
  store.state = { ...store.state, overridesComplete: false };
  assert.deepEqual((await project(firstRecord(), store)).reasons, [
    "current_overrides_unavailable",
  ]);
});

void test("subscription/team/backing are pending; bare pro grants nothing and basic/special never elevate", async () => {
  const id = claim.railsUserId;
  const record = firstRecord([
    user(),
    subscription(),
    {
      kind: "backing_grant",
      railsUserId: id,
      railsSourceId: "synthetic-managed",
      source: "managed_subscription",
      expiresAt: null,
      currentPeriodEnd: null,
    },
    { kind: "basic_grant", railsUserId: id },
    { kind: "role_grant", railsUserId: id, roleName: "admin" },
  ]);
  const store = new MemoryGrantStore();
  const result = await project(record, store);
  assert.equal(result.status, "pending_reconciliation");
  assert.equal(result.changed, 0);
  assert.ok(result.reasons.includes("team_current_seat_required"));
  assert.ok(result.reasons.includes("subscription_current_law_required"));
  assert.ok(result.reasons.includes("backing_current_law_required"));
  assert.ok(result.reasons.includes("basic_role_review_required"));
  assert.ok(result.reasons.includes("special_role_review_required"));
  const pro = firstRecord([
    user(),
    { kind: "pro_holder", railsUserId: id, lastSignInOn: "2019-01-01" },
  ]);
  assert.equal((await project(pro, store)).changed, 0);
  assert.equal(pro.evidence.proHolders[0]?.lastSignInOn, "2019-01-01");
});

void test("lifetime role evidence is preserved but purchase-only release holds it for review", async () => {
  const record = firstRecord([
    user(),
    { kind: "role_grant", railsUserId: claim.railsUserId, roleName: "lifetime_subscriber" },
  ]);
  const store = new MemoryGrantStore();
  const result = await project(record, store);
  assert.equal(result.status, "pending_reconciliation");
  assert.equal(result.changed, 0);
  assert.deepEqual(result.reasons, ["special_role_review_required"]);
  assert.equal(record.evidence.roleGrants[0]?.roleName, "lifetime_subscriber");
  assert.equal((await project(record, store)).changed, 0);
  assert.equal(store.rows.size, 0);
});

void test("refunds, disputes, unknown state/type, missing sellable and restrictions are pending, not grants", async () => {
  await Promise.all(
    [
      { purchaseState: "refunded" },
      { purchaseState: "disputed" },
      { purchaseState: "revoked" },
      { purchaseState: null },
      { sellableType: "Other" },
      { sellableId: null },
      { bulk: true },
      { restrictedToCountry: "US" },
      { expiresAt: "not-a-date" },
      { expiresAt: "2099-01-01T00:00:00Z" },
    ].map(async (change) => {
      const result = await project(firstRecord([user(), purchase(change)]));
      assert.equal(result.status, "pending_reconciliation");
      assert.equal(result.changed, 0);
    }),
  );
});

void test("expiry uses real clock and Rails UTC timestamps, including equality; eligible finite grants expire", async () => {
  await Promise.all(
    ["2026-11-21T12:00:00Z", "2026-01-01T00:00:00Z", "2026-11-21 12:00:00"].map(
      async (expiresAt) => {
        assert.equal((await project(firstRecord([user(), purchase({ expiresAt })]))).changed, 0);
      },
    ),
  );
  const store = new MemoryGrantStore();
  assert.equal(
    (await project(firstRecord([user(), purchase({ expiresAt: "2026-11-22 00:00:00" })]), store))
      .changed,
    1,
  );
  assert.equal([...store.rows.values()][0]?.expiresAt, "2026-11-22T00:00:00.000Z");
});

void test("existing revoked/native/conflicting rows are never overwritten, including global id collision", async () => {
  const id = projectionIds.entitlement(
    `rails_sellable_purchase:${purchase().railsSellablePurchaseId}`,
  );
  await Promise.all(
    [{ deletedAt: EXPORTED_AT }, { sourceType: "stripe" }, { userId: "synthetic-other" }].map(
      async (change) => {
        const store = new MemoryGrantStore();
        const stored = unrelatedRow({ id, userId: claim.userId, ...change });
        store.rows.set(id, stored);
        const before = structuredClone(stored);
        const result = await project(firstRecord(), store);
        assert.equal(result.status, "pending_reconciliation");
        assert.equal(result.changed, 0);
        assert.deepEqual(store.rows.get(id), before);
      },
    ),
  );
});

void test("wrong/missing claim or user rejects; orphan evidence pending and readback failure rolls back", async () => {
  const store = new MemoryGrantStore();
  store.state = { ...store.state, userExists: false };
  await assert.rejects(project(firstRecord(), store), /missing user claim/);
  store.state = { ...store.state, userExists: true, claim: { ...claim, claimId: "wrong" } };
  await assert.rejects(project(firstRecord(), store), /claim/);
  await assert.rejects(
    projectClaimedSubject({
      record: firstRecord(),
      claim: { ...claim, railsUserId: "wrong" },
      store,
      now: NOW,
    }),
    /claim/,
  );
  assert.equal((await project(firstRecord([purchase()]))).status, "pending_reconciliation");
  const broken = new MemoryGrantStore();
  broken.failReadback = true;
  await assert.rejects(project(firstRecord(), broken), /readback/);
  assert.equal(broken.rows.size, 0);
  await assert.rejects(
    projectClaimedSubject({ record: firstRecord(), claim, store, now: new Date("invalid") }),
    /clock/,
  );
});
