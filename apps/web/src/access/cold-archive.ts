import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { z } from "zod";
import {
  buildSubjectRecords,
  evidenceFields,
  sha256,
  SUBJECT_SCHEMA,
  verifySubject,
  type ColdCandidate,
  type SubjectEnvelope,
} from "./cold-subject";

const FORMAT = "egghead-cold-archive/v1";
const MAX_SHARD_BYTES = 64 * 1024 * 1024;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const shardSchema = z.strictObject({
  key: z.string().min(1),
  bucket: z.number().int().min(0).max(255),
  bytes: z.number().int().min(28).max(MAX_SHARD_BYTES),
  ciphertextSha256: digestSchema,
  plaintextSha256: digestSchema,
  plaintextBytes: z.number().int().positive().max(MAX_SHARD_BYTES),
  subjects: z.array(digestSchema).min(1),
});
const bodySchema = z.strictObject({
  format: z.literal(FORMAT),
  subjectSchema: z.literal(SUBJECT_SCHEMA),
  exportId: z.string().min(1),
  exportedAt: z.iso.datetime(),
  bundleKey: z.string().min(1),
  sourceSha256: digestSchema,
  keyVersion: z.string().min(1),
  candidateCount: z.number().int().nonnegative(),
  candidateDigest: digestSchema,
  // Counts are subject-scoped; shared parent subscriptions may occur in multiple subjects.
  counts: z.record(z.enum(evidenceFields), z.number().int().nonnegative()),
  shards: z.array(shardSchema),
});
const signedManifestSchema = z.strictObject({ body: bodySchema, mac: digestSchema });
export type ArchiveManifest = z.infer<typeof signedManifestSchema>;

/** Private immutable object adapter. put must reject replacement with different bytes. */
export interface ColdArchiveStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}
export interface ArchiveKeys {
  encryption: Uint8Array;
  authentication: Uint8Array;
}
export type ArchiveKeyring = (keyVersion: string) => ArchiveKeys;
function validateKeys(keys: ArchiveKeys) {
  if (
    keys.encryption.byteLength !== 32 ||
    keys.authentication.byteLength < 32 ||
    Buffer.from(keys.encryption).equals(Buffer.from(keys.authentication))
  ) {
    throw new Error("archive requires separate encryption/authentication keys");
  }
}
const subjectDigest = (record: SubjectEnvelope) => sha256(record.subject.railsUserId);
const candidateDigest = (digests: readonly string[]) =>
  sha256(JSON.stringify([...digests].toSorted()));
const bucketFor = (digest: string) => Number.parseInt(digest.slice(0, 2), 16);
function aad(body: Pick<ArchiveManifest["body"], "exportId" | "keyVersion">, key: string) {
  return Buffer.from(JSON.stringify([FORMAT, SUBJECT_SCHEMA, body.exportId, body.keyVersion, key]));
}
function mac(body: ArchiveManifest["body"], key: Uint8Array) {
  return createHmac("sha256", key).update(JSON.stringify(body)).digest("hex");
}

/** Compress, then AES-256-GCM; publish the authenticated manifest LAST. No provider/key I/O. */
export async function exportColdArchive(input: {
  store: ColdArchiveStore;
  keys: ArchiveKeys;
  keyVersion: string;
  exportText: string;
  expectedSourceSha256: string;
  exportId: string;
  bundleKey: string;
  // Independent approved candidate inventory: identities absent from the eligible export survive.
  candidates: readonly ColdCandidate[];
}): Promise<{ manifestKey: string; manifest: ArchiveManifest }> {
  validateKeys(input.keys);
  const records = buildSubjectRecords(input);
  const groups = new Map<number, SubjectEnvelope[]>();
  for (const record of records) {
    const bucket = bucketFor(subjectDigest(record));
    const group = groups.get(bucket) ?? [];
    group.push(record);
    groups.set(bucket, group);
  }
  const counts = Object.fromEntries(evidenceFields.map((field) => [field, 0]));
  const shards: ArchiveManifest["body"]["shards"] = [];
  const prefix = `cold/${sha256(JSON.stringify([input.exportId, input.keyVersion]))}`;
  // Serialize shard I/O to bound peak decrypted/compressed memory.
  await [...groups]
    .toSorted(([a], [b]) => a - b)
    .reduce(async (previous, [bucket, unsorted]) => {
      await previous;
      const group = unsorted.toSorted((a, b) => subjectDigest(a).localeCompare(subjectDigest(b)));
      const plaintext = Buffer.from(
        group.map((record) => JSON.stringify(record)).join("\n") + "\n",
      );
      if (plaintext.byteLength > MAX_SHARD_BYTES)
        throw new Error("shard exceeds decompression budget");
      const key = `${prefix}/shard-${bucket.toString(16).padStart(2, "0")}.bin`;
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", input.keys.encryption, nonce);
      cipher.setAAD(aad(input, key));
      const ciphertext = Buffer.concat([
        nonce,
        cipher.update(gzipSync(plaintext)),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      const descriptor = shardSchema.parse({
        key,
        bucket,
        bytes: ciphertext.byteLength,
        ciphertextSha256: sha256(ciphertext),
        plaintextSha256: sha256(plaintext),
        plaintextBytes: plaintext.byteLength,
        subjects: group.map(subjectDigest),
      });
      await input.store.put(key, ciphertext);
      shards.push(descriptor);
      for (const record of group)
        for (const field of evidenceFields) {
          counts[field] = (counts[field] ?? 0) + record.counts[field];
        }
    }, Promise.resolve());
  // Parse source even for an empty candidate inventory via buildSubjectRecords above.
  const sourceManifest = input.exportText.trim().split("\n").at(-1);
  if (!sourceManifest) throw new Error("missing source manifest");
  const parsedSource: unknown = JSON.parse(sourceManifest);
  const { exportedAt } = z.object({ exportedAt: z.iso.datetime() }).parse(parsedSource);
  const body = bodySchema.parse({
    format: FORMAT,
    subjectSchema: SUBJECT_SCHEMA,
    exportId: input.exportId,
    exportedAt,
    bundleKey: input.bundleKey,
    sourceSha256: input.expectedSourceSha256,
    keyVersion: input.keyVersion,
    candidateCount: records.length,
    candidateDigest: candidateDigest(records.map(subjectDigest)),
    counts,
    shards,
  });
  const manifest = { body, mac: mac(body, input.keys.authentication) };
  const manifestKey = `${prefix}/manifest.json`;
  await input.store.put(manifestKey, Buffer.from(JSON.stringify(manifest)));
  return { manifestKey, manifest };
}

/** Validate all shards, not just the desired subject, before exposing any record. */
export async function verifyColdArchive(input: {
  store: ColdArchiveStore;
  manifestKey: string;
  keyring: ArchiveKeyring;
  // Trusted locator from the lookup/claim, preventing substitution of another authentic bundle.
  expected: {
    exportId: string;
    sourceSha256: string;
    candidateCount: number;
    candidateDigest: string;
  };
}): Promise<SubjectEnvelope[]> {
  const manifestBytes = await input.store.get(input.manifestKey);
  if (!manifestBytes) throw new Error("missing manifest");
  if (manifestBytes.byteLength > MAX_SHARD_BYTES) throw new Error("manifest exceeds budget");
  const json: unknown = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
  const manifest = signedManifestSchema.parse(json);
  const { body } = manifest;
  const keys = input.keyring(body.keyVersion);
  validateKeys(keys);
  if (
    !timingSafeEqual(
      Buffer.from(manifest.mac, "hex"),
      Buffer.from(mac(body, keys.authentication), "hex"),
    )
  ) {
    throw new Error("manifest authentication failed");
  }
  for (const field of ["exportId", "sourceSha256", "candidateCount", "candidateDigest"] as const) {
    if (body[field] !== input.expected[field])
      throw new Error("unexpected archive identity/coverage");
  }
  const records: SubjectEnvelope[] = [];
  const seen = new Set<string>();
  const seenBuckets = new Set<number>();
  await body.shards.reduce(async (previous, shard) => {
    await previous;
    if (seenBuckets.has(shard.bucket)) throw new Error("duplicate shard bucket");
    seenBuckets.add(shard.bucket);
    const bytes = await input.store.get(shard.key);
    if (!bytes) throw new Error("missing shard");
    if (bytes.byteLength !== shard.bytes || sha256(bytes) !== shard.ciphertextSha256) {
      throw new Error("shard ciphertext count/checksum mismatch");
    }
    const ciphertext = Buffer.from(bytes);
    const decipher = createDecipheriv("aes-256-gcm", keys.encryption, ciphertext.subarray(0, 12));
    decipher.setAAD(aad(body, shard.key));
    decipher.setAuthTag(ciphertext.subarray(-16));
    const compressed = Buffer.concat([
      decipher.update(ciphertext.subarray(12, -16)),
      decipher.final(),
    ]);
    const plaintext = gunzipSync(compressed, { maxOutputLength: MAX_SHARD_BYTES });
    if (
      plaintext.byteLength !== shard.plaintextBytes ||
      sha256(plaintext) !== shard.plaintextSha256
    ) {
      throw new Error("shard plaintext count/checksum mismatch");
    }
    const text = plaintext.toString("utf8");
    if (!text.endsWith("\n")) throw new Error("truncated shard records");
    const lines = text.slice(0, -1).split("\n");
    if (lines.length !== shard.subjects.length) throw new Error("shard record count mismatch");
    for (const [index, line] of lines.entries()) {
      const raw: unknown = JSON.parse(line);
      const record = verifySubject(raw);
      const digest = subjectDigest(record);
      if (
        seen.has(digest) ||
        digest !== shard.subjects[index] ||
        bucketFor(digest) !== shard.bucket
      ) {
        throw new Error("subject inventory mismatch");
      }
      if (
        record.exportId !== body.exportId ||
        record.exportedAt !== body.exportedAt ||
        record.source.sha256 !== body.sourceSha256 ||
        record.source.bundleKey !== body.bundleKey
      ) {
        throw new Error("subject provenance mismatch");
      }
      seen.add(digest);
      records.push(record);
    }
  }, Promise.resolve());
  if (
    records.length !== body.candidateCount ||
    candidateDigest([...seen]) !== body.candidateDigest
  ) {
    throw new Error("candidate coverage mismatch");
  }
  for (const field of evidenceFields) {
    if (records.reduce((sum, record) => sum + record.counts[field], 0) !== body.counts[field]) {
      throw new Error("manifest evidence count mismatch");
    }
  }
  return records;
}
