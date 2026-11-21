import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import {
  ACCESS_DELTA_LAW,
  parseRailsAccessExport,
  railsAccessEvidenceSchema,
  type RailsAccessExport,
  type RailsPurchase,
} from "./rails-access-delta";

export const SUBJECT_SCHEMA = "egghead-cold-subject/v1";
export const RECOVERY_LAW = "lifetime-course-only/v1";
export const PROJECTION_VERSION = "cold-grant-only/v1";
export const evidenceFields = [
  "users",
  "roleGrants",
  "basicGrants",
  "subscriptions",
  "purchases",
  "proHolders",
  "backingGrants",
] as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1);
const countsSchema = z.strictObject({
  users: z.number().int().nonnegative(),
  roleGrants: z.number().int().nonnegative(),
  basicGrants: z.number().int().nonnegative(),
  subscriptions: z.number().int().nonnegative(),
  purchases: z.number().int().nonnegative(),
  proHolders: z.number().int().nonnegative(),
  backingGrants: z.number().int().nonnegative(),
});
export type EvidenceCounts = z.infer<typeof countsSchema>;
export type AccessEvidence = z.infer<typeof railsAccessEvidenceSchema>;

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

const hmacFact = z.strictObject({ keyVersion: id, digest });
export const candidateSchema = z.strictObject({
  railsUserId: id,
  identity: z.strictObject({
    // Empty arrays mean a completed inventory found no facts. Missing inventory is an error.
    inventory: z.literal("complete"),
    emailHmacs: z.array(hmacFact),
    providerUidHmacs: z.array(hmacFact.extend({ provider: id })),
    legacyContactId: id.nullable(),
    samlRequired: z.boolean(),
  }),
  disposition: z.enum(["eligible", "banned", "quarantined", "erased", "tombstoned"]),
});
export type ColdCandidate = z.infer<typeof candidateSchema>;

/** Keys never enter records. JSON tuples prevent delimiter/domain collisions. */
export function identityHmac(
  key: Uint8Array,
  keyVersion: string,
  fact:
    | { kind: "email"; normalizedEmail: string }
    | { kind: "provider_uid"; provider: string; uid: string },
) {
  if (key.byteLength < 32 || !keyVersion) throw new Error("invalid identity HMAC key/version");
  const input =
    fact.kind === "email"
      ? ["egghead-cold-identity/v1", keyVersion, "email", fact.normalizedEmail]
      : ["egghead-cold-identity/v1", keyVersion, "provider_uid", fact.provider, fact.uid];
  return {
    keyVersion,
    digest: createHmac("sha256", key).update(JSON.stringify(input)).digest("hex"),
  };
}

export const subjectSchema = z.strictObject({
  schemaVersion: z.literal(SUBJECT_SCHEMA),
  exportId: id,
  exportedAt: z.iso.datetime(),
  subject: candidateSchema,
  source: z.strictObject({
    format: z.literal("egghead-rails-access-export/v3"),
    // Preserve the legacy export's eligibility law; it is NOT approval to recover subscriptions.
    eligibilityLaw: z.literal(ACCESS_DELTA_LAW),
    sha256: digest,
    bundleKey: id,
  }),
  projectionVersion: z.literal(PROJECTION_VERSION),
  lawVersion: z.literal(RECOVERY_LAW),
  completeness: z.strictObject({
    candidateInventory: z.literal("complete"),
    // Complete eligible-access snapshot, NOT a claim to contain all historical purchases.
    accessExport: z.literal("complete"),
    kinds: z.array(z.enum(evidenceFields)).length(7),
  }),
  result: z.enum(["evidence", "empty"]),
  counts: countsSchema,
  evidenceSha256: digest,
  evidence: railsAccessEvidenceSchema,
});
export type SubjectEnvelope = z.infer<typeof subjectSchema>;

export function evidenceCounts(evidence: AccessEvidence): EvidenceCounts {
  return {
    users: evidence.users.length,
    roleGrants: evidence.roleGrants.length,
    basicGrants: evidence.basicGrants.length,
    subscriptions: evidence.subscriptions.length,
    purchases: evidence.purchases.length,
    proHolders: evidence.proHolders.length,
    backingGrants: evidence.backingGrants.length,
  };
}

function emptyAccessEvidence(evidence: AccessEvidence) {
  return (
    evidence.roleGrants.length === 0 &&
    evidence.basicGrants.length === 0 &&
    evidence.subscriptions.length === 0 &&
    evidence.purchases.length === 0 &&
    evidence.backingGrants.length === 0
  );
}

function indexByUser<T extends { railsUserId: string }>(rows: readonly T[]): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const row of rows) {
    const group = index.get(row.railsUserId) ?? [];
    group.push(row);
    index.set(row.railsUserId, group);
  }
  return index;
}

/** Revalidate even typed inputs: storage and auth are trust boundaries. */
export function verifySubject(input: unknown): SubjectEnvelope {
  const record = subjectSchema.parse(input);
  const evidence = record.evidence;
  const subjectId = record.subject.railsUserId;
  if (new Set(record.completeness.kinds).size !== evidenceFields.length) {
    throw new Error("incomplete evidence kinds");
  }
  const counts = evidenceCounts(evidence);
  for (const field of evidenceFields) {
    if (record.counts[field] !== counts[field]) throw new Error("subject count mismatch");
  }
  if (sha256(JSON.stringify(evidence)) !== record.evidenceSha256) {
    throw new Error("subject evidence checksum mismatch");
  }
  const direct = [
    ...evidence.users,
    ...evidence.roleGrants,
    ...evidence.basicGrants,
    ...evidence.purchases,
    ...evidence.proHolders,
    ...evidence.backingGrants,
  ];
  if (
    direct.some((row) => row.railsUserId !== subjectId) ||
    evidence.users.length > 1 ||
    evidence.subscriptions.some(
      (sub) =>
        sub.members.length !== 1 || sub.members.some((member) => member.railsUserId !== subjectId),
    )
  ) {
    throw new Error("evidence crosses subject boundary");
  }
  const empty = emptyAccessEvidence(evidence);
  if ((record.result === "empty") !== empty) throw new Error("invalid empty result");
  return record;
}

/** Accept original bytes, not an unchecked partial RailsAccessExport object. */
export function buildSubjectRecords(input: {
  exportText: string;
  expectedSourceSha256: string;
  exportId: string;
  bundleKey: string;
  candidates: readonly ColdCandidate[];
}): SubjectEnvelope[] {
  if (sha256(input.exportText) !== input.expectedSourceSha256)
    throw new Error("source checksum mismatch");
  const source = parseRailsAccessExport(input.exportText);
  const candidates = input.candidates.map((candidate) => candidateSchema.parse(candidate));
  if (new Set(candidates.map((candidate) => candidate.railsUserId)).size !== candidates.length) {
    throw new Error("duplicate candidate");
  }
  // Index once: candidate-count × full-export scans are not viable for a dormant cohort.
  const index = {
    users: indexByUser(source.users),
    roleGrants: indexByUser(source.roleGrants),
    basicGrants: indexByUser(source.basicGrants),
    purchases: indexByUser(source.purchases),
    proHolders: indexByUser(source.proHolders),
    backingGrants: indexByUser(source.backingGrants),
  };
  const subscriptions = new Map<string, AccessEvidence["subscriptions"]>();
  for (const sub of source.subscriptions) {
    const members = indexByUser(sub.members);
    for (const [subjectId, scopedMembers] of members) {
      const group = subscriptions.get(subjectId) ?? [];
      group.push({ ...sub, members: scopedMembers });
      subscriptions.set(subjectId, group);
    }
  }
  return candidates.map((subject) => {
    const subjectId = subject.railsUserId;
    const evidence: AccessEvidence = {
      users: index.users.get(subjectId) ?? [],
      roleGrants: index.roleGrants.get(subjectId) ?? [],
      basicGrants: index.basicGrants.get(subjectId) ?? [],
      subscriptions: subscriptions.get(subjectId) ?? [],
      purchases: index.purchases.get(subjectId) ?? [],
      proHolders: index.proHolders.get(subjectId) ?? [],
      backingGrants: index.backingGrants.get(subjectId) ?? [],
    };
    return verifySubject({
      schemaVersion: SUBJECT_SCHEMA,
      exportId: input.exportId,
      exportedAt: source.manifest.exportedAt,
      subject,
      source: {
        format: source.manifest.format,
        eligibilityLaw: ACCESS_DELTA_LAW,
        sha256: source.sha256,
        bundleKey: input.bundleKey,
      },
      projectionVersion: PROJECTION_VERSION,
      lawVersion: RECOVERY_LAW,
      completeness: {
        candidateInventory: "complete",
        accessExport: "complete",
        kinds: [...evidenceFields],
      },
      result: emptyAccessEvidence(evidence) ? "empty" : "evidence",
      counts: evidenceCounts(evidence),
      evidenceSha256: sha256(JSON.stringify(evidence)),
      evidence,
    });
  });
}

/** This is an adapter for the PURE builder, never a batch apply input. */
export function subjectProjectionInput(
  record: SubjectEnvelope,
  approvedPurchases: readonly RailsPurchase[],
): RailsAccessExport {
  // First release is purchase-only. Preserve role evidence in the envelope, not live grants.
  return {
    sha256: record.source.sha256,
    manifest: {
      kind: "manifest",
      format: record.source.format,
      exportedAt: record.exportedAt,
      counts: {
        user: record.counts.users,
        role_grant: 0,
        basic_grant: 0,
        subscription: 0,
        purchase: approvedPurchases.length,
        pro_holder: 0,
        backing_grant: 0,
      },
    },
    users: record.evidence.users,
    roleGrants: [],
    basicGrants: [],
    subscriptions: [],
    purchases: approvedPurchases,
    proHolders: [],
    backingGrants: [],
    orphanRailsUserIds: [],
  };
}
