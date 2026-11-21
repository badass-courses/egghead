// Paid-access delta between a Rails access export and CourseBuilder's projection.
//
// Pure: no database, no clock, no filesystem. `rails-access-delta-store.ts` reads
// and writes CourseBuilder; `scripts/access-delta.ts` is the CLI.
//
// Law (ADR-0006, lenient at the flip): anyone Rails grants today keeps access.
// A subscription in trialing/active/past_due grants regardless of its period end.
// The expected rows reproduce the July 2026 projection (migrate-egghead
// tools/me.ts `collectAuthProjectionSource`) byte for byte in ids and keys, so
// rows written in July compare as unchanged and nothing is duplicated.

import { createHash } from "node:crypto";

import { z } from "zod";

export const RAILS_ACCESS_EXPORT_FORMAT = "egghead-rails-access-export/v3";
export const ACCESS_DELTA_LAW = "adr-0006-lenient-status";

const SUBSCRIPTION_SOURCE_TYPE = "rails_account_subscription";
const SUBSCRIPTION_ACCESS_LAW = "lenient_status_v1";
const GIFT_ACCESS_LAW = "gift_expires_at_v1";
const ROLE_SOURCE_TYPE = "rails_user_role";
const PURCHASE_SOURCE_TYPE = "rails_sellable_purchase";
const BASIC_SOURCE_TYPE = "rails_legacy_basic_role";
/**
 * Backed legacy `pro`: live backing Rails' ProStatusChecker ignores but
 * Subscription#hard_cancel! honours. Grants follow Rails `is_pro?` today: the
 * backing grants only users Rails grants as pro, and sets the row's expiry.
 */
export const BACKING_SOURCE_TYPES = {
  gift: "rails_gift",
  managed_subscription: "rails_managed_subscription",
  legacy_subscription: "rails_legacy_subscription",
} as const;
export type BackingSourceType = (typeof BACKING_SOURCE_TYPES)[keyof typeof BACKING_SOURCE_TYPES];
/** Bare `pro` holders who signed in recently: granted on the role alone. */
export const BARE_PRO_ACTIVE_SOURCE_TYPE = "rails_bare_pro_active";
/** Granted source types a first run must accept by count, and that alarm on growth. */
export type GatedSourceType = BackingSourceType | typeof BARE_PRO_ACTIVE_SOURCE_TYPE;
export const DEFAULT_BARE_PRO_ACTIVE_DAYS = 365;
const BASIC_ENTITLEMENT_TYPE = "egghead_basic_legacy_access";
const BASIC_ACCESS_LAW = "adr_0007_legacy_basic_role_access_projection";
const ALL_ACCESS_TYPE = "egghead_all_access_subscription";
const LIFETIME_TYPE = "egghead_lifetime_access";
const STAFF_TYPE = "egghead_staff_special_access";
const MEMBERSHIP_ACCESS_TYPE = "egghead_membership_access";
const PLAYLIST_ACCESS_TYPE = "egghead_playlist_access";

/**
 * Source types this delta owns. Rows with any other source type (CourseBuilder
 * Stripe writes, legacy-pro quarantine rows) are never touched or revoked.
 */
export const DELTA_OWNED_SOURCE_TYPES: ReadonlySet<string> = new Set([
  ROLE_SOURCE_TYPE,
  SUBSCRIPTION_SOURCE_TYPE,
  PURCHASE_SOURCE_TYPE,
  BASIC_SOURCE_TYPE,
  ...Object.values(BACKING_SOURCE_TYPES),
  BARE_PRO_ACTIVE_SOURCE_TYPE,
]);

const RAILS_MEMBERSHIP_SOURCES: ReadonlySet<string> = new Set([
  "rails_account_user",
  "rails_scoped_account_role",
]);

// ---------------------------------------------------------------------------
// Export format

const nullableText = z.string().nullable();
const count = z.number().int().nonnegative();

const userLine = z.object({
  kind: z.literal("user"),
  railsUserId: z.string().min(1),
  email: nullableText,
  firstName: nullableText,
  lastName: nullableText,
  avatarUrl: nullableText,
  confirmedAt: nullableText,
  createdAt: nullableText,
  isBanned: z.boolean(),
  signInCount: z.number().int(),
  hasAuthenticationToken: z.boolean(),
});

const roleGrantLine = z.object({
  kind: z.literal("role_grant"),
  railsUserId: z.string().min(1),
  roleName: z.string().min(1),
});

const basicGrantLine = z.object({
  kind: z.literal("basic_grant"),
  railsUserId: z.string().min(1),
});

const subscriptionMember = z.object({
  railsAccountUserId: nullableText,
  railsUserId: z.string().min(1),
  hasMemberRole: z.boolean(),
  hasOwnerRole: z.boolean(),
  createdAt: nullableText,
});

const subscriptionLine = z.object({
  kind: z.literal("subscription"),
  railsAccountSubscriptionId: z.string().min(1),
  railsAccountId: nullableText,
  accountName: nullableText,
  accountSlug: nullableText,
  accountGuid: nullableText,
  status: z.string(),
  quantity: z.number().int(),
  currentPeriodStart: nullableText,
  currentPeriodEnd: nullableText,
  cancelAtPeriodEnd: z.boolean(),
  createdAt: nullableText,
  stripeCustomerIdPresent: z.boolean(),
  stripeSubscriptionIdPresent: z.boolean(),
  members: z.array(subscriptionMember),
});

/**
 * Rails applications whose purchases grant egghead access: 10 is egghead.io
 * (course purchases), 111 is egghead (lifetime memberships). Rails is
 * multi-tenant, so Just JavaScript, Epic React, Testing JavaScript, Technical
 * Interviews and Pure React purchases share `sellable_purchases`; they grant
 * nothing here. A null application id is the pre-application egghead era.
 */
export const EGGHEAD_RAILS_APPLICATION_IDS: ReadonlySet<string> = new Set(["10", "111"]);

export function isEggheadRailsApplication(applicationId: string | null) {
  return applicationId === null || EGGHEAD_RAILS_APPLICATION_IDS.has(applicationId);
}

const purchaseLine = z.object({
  kind: z.literal("purchase"),
  railsSellablePurchaseId: z.string().min(1),
  railsUserId: z.string().min(1),
  railsApplicationId: nullableText,
  sellableType: nullableText,
  sellableId: nullableText,
  purchaseState: nullableText,
  bulk: z.boolean(),
  restrictedToCountry: nullableText,
  expiresAt: nullableText,
  createdAt: nullableText,
});

/**
 * A Rails user holding the global `pro` role: Rails' own access decision
 * (`Ability#lesson_permissions` checks `is_pro?`). Cross-check only; grants nothing.
 */
const proHolderLine = z.object({
  kind: z.literal("pro_holder"),
  railsUserId: z.string().min(1),
  /** `GREATEST(current_sign_in_at, last_sign_in_at)` as a UTC date; null if never. */
  lastSignInOn: nullableText.default(null),
});

/**
 * Live legacy backing for `pro`: an active gift (`Gift.active`), membership of
 * an active managed subscription, or an active legacy subscription
 * (`Subscription.active`). Each grants all access while it is live.
 */
const backingGrantLine = z.object({
  kind: z.literal("backing_grant"),
  source: z.enum(["gift", "managed_subscription", "legacy_subscription"]),
  railsSourceId: z.string().min(1),
  railsUserId: z.string().min(1),
  /** Gifts only: claimed_at + COALESCE(duration_months, 12) months, UTC. */
  expiresAt: nullableText,
  /** Legacy subscriptions only: Stripe's renewing period end, metadata only. */
  currentPeriodEnd: nullableText,
});

const manifestCounts = z.object({
  user: count,
  role_grant: count,
  basic_grant: count,
  subscription: count,
  purchase: count,
  pro_holder: count,
  backing_grant: count,
});

const manifestLine = z.object({
  kind: z.literal("manifest"),
  format: z.literal(RAILS_ACCESS_EXPORT_FORMAT),
  exportedAt: z.string(),
  counts: manifestCounts,
  /** Live backing for users Rails does not grant as pro: counted in SQL, never exported. */
  backedWithoutPro: z
    .object({ gift: count, managed_subscription: count, legacy_subscription: count })
    .optional(),
});

/** Shared validation only; recovery does not use the batch planner or store. */
export const railsAccessEvidenceSchema = z.strictObject({
  users: z.array(userLine),
  roleGrants: z.array(roleGrantLine),
  basicGrants: z.array(basicGrantLine),
  subscriptions: z.array(subscriptionLine),
  purchases: z.array(purchaseLine),
  proHolders: z.array(proHolderLine),
  backingGrants: z.array(backingGrantLine),
});

const exportLine = z.discriminatedUnion("kind", [
  userLine,
  roleGrantLine,
  basicGrantLine,
  subscriptionLine,
  purchaseLine,
  proHolderLine,
  backingGrantLine,
  manifestLine,
]);

export type RailsUser = z.infer<typeof userLine>;
export type RailsRoleGrant = z.infer<typeof roleGrantLine>;
export type RailsBasicGrant = z.infer<typeof basicGrantLine>;
export type RailsSubscription = z.infer<typeof subscriptionLine>;
export type RailsSubscriptionMember = z.infer<typeof subscriptionMember>;
export type RailsPurchase = z.infer<typeof purchaseLine>;
export type RailsProHolder = z.infer<typeof proHolderLine>;
export type RailsBackingGrant = z.infer<typeof backingGrantLine>;
export type RailsExportManifest = z.infer<typeof manifestLine>;

export interface RailsAccessExport {
  readonly sha256: string;
  readonly manifest: RailsExportManifest;
  readonly users: readonly RailsUser[];
  readonly roleGrants: readonly RailsRoleGrant[];
  readonly basicGrants: readonly RailsBasicGrant[];
  readonly subscriptions: readonly RailsSubscription[];
  readonly purchases: readonly RailsPurchase[];
  readonly proHolders: readonly RailsProHolder[];
  readonly backingGrants: readonly RailsBackingGrant[];
  /**
   * Rails user ids that grant lines reference but no user line carries (for
   * example a user row deleted under its gift). Held: granted nothing, and
   * their existing CourseBuilder rows are kept.
   */
  readonly orphanRailsUserIds: readonly string[];
}

export class RailsExportError extends Error {
  override readonly name = "RailsExportError";
}

/**
 * Parse and verify a Rails access export. Throws unless the manifest is the last
 * line and its counts match the lines read, so a truncated or partial export can
 * never turn into mass revocation.
 */
export function parseRailsAccessExport(text: string): RailsAccessExport {
  const sha256 = createHash("sha256").update(text).digest("hex");
  const users: RailsUser[] = [];
  const roleGrants: RailsRoleGrant[] = [];
  const basicGrants: RailsBasicGrant[] = [];
  const subscriptions: RailsSubscription[] = [];
  const purchases: RailsPurchase[] = [];
  const proHolders: RailsProHolder[] = [];
  const backingGrants: RailsBackingGrant[] = [];
  let manifest: RailsExportManifest | null = null;
  const lines = text.split("\n");

  for (const [index, raw] of lines.entries()) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (manifest) {
      throw new RailsExportError(`line ${index + 1}: data after the manifest line`);
    }

    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      throw new RailsExportError(`line ${index + 1}: not valid JSON`);
    }
    const parsed = exportLine.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "invalid";
      throw new RailsExportError(`line ${index + 1}: ${where}`);
    }

    const line = parsed.data;
    switch (line.kind) {
      case "user":
        users.push(line);
        break;
      case "role_grant":
        roleGrants.push(line);
        break;
      case "basic_grant":
        basicGrants.push(line);
        break;
      case "subscription":
        subscriptions.push(line);
        break;
      case "purchase":
        purchases.push(line);
        break;
      case "pro_holder":
        proHolders.push(line);
        break;
      case "backing_grant":
        backingGrants.push(line);
        break;
      case "manifest":
        manifest = line;
        break;
    }
  }

  if (!manifest) {
    throw new RailsExportError("no manifest line: the export is incomplete or truncated");
  }

  const read = {
    user: users.length,
    role_grant: roleGrants.length,
    basic_grant: basicGrants.length,
    subscription: subscriptions.length,
    purchase: purchases.length,
    pro_holder: proHolders.length,
    backing_grant: backingGrants.length,
  };
  const kinds = [
    "user",
    "role_grant",
    "basic_grant",
    "subscription",
    "purchase",
    "pro_holder",
    "backing_grant",
  ] as const;
  for (const kind of kinds) {
    if (read[kind] !== manifest.counts[kind]) {
      throw new RailsExportError(
        `manifest says ${manifest.counts[kind]} ${kind} lines but the file has ${read[kind]}`,
      );
    }
  }

  const userIds = new Set<string>();
  for (const user of users) {
    if (userIds.has(user.railsUserId)) {
      throw new RailsExportError(`duplicate user line for Rails user ${user.railsUserId}`);
    }
    userIds.add(user.railsUserId);
  }
  const referenced = [
    ...roleGrants.map((grant) => grant.railsUserId),
    ...basicGrants.map((grant) => grant.railsUserId),
    ...purchases.map((purchase) => purchase.railsUserId),
    ...backingGrants.map((grant) => grant.railsUserId),
    ...subscriptions.flatMap((sub) => sub.members.map((member) => member.railsUserId)),
  ];
  const orphanRailsUserIds = [...new Set(referenced.filter((id) => !userIds.has(id)))].toSorted(
    (a, b) => Number(a) - Number(b) || a.localeCompare(b),
  );

  return {
    sha256,
    manifest,
    users,
    roleGrants,
    basicGrants,
    subscriptions,
    purchases,
    proHolders,
    backingGrants,
    orphanRailsUserIds,
  };
}

// ---------------------------------------------------------------------------
// Deterministic ids (identical to the July projection)

function authId(prefix: string, ...parts: Array<string | number>) {
  const input = parts.map((part) => String(part)).join(":");
  return `${prefix}_${createHash("sha1").update(input).digest("hex").slice(0, 32)}`;
}

export const projectionIds = {
  user: (railsUserId: string) => authId("eh_user", railsUserId),
  organization: (railsAccountId: string) => authId("eh_org", railsAccountId),
  membership: (railsAccountUserId: string) => authId("eh_orgmem", railsAccountUserId),
  roleMembership: (railsAccountId: string, railsUserId: string) =>
    authId("eh_orgmem", `role:${railsAccountId}:${railsUserId}`),
  product: (sellableType: string, sellableId: string) =>
    authId("eh_product", sellableType, sellableId),
  entitlement: (idempotencyKey: string) => authId("eh_entitlement", idempotencyKey),
};

export function normalizeEmail(value: string | null | undefined) {
  return (value ?? "").trim();
}

/** Mirrors the July projection's uniqueness key (MySQL `utf8mb4_0900_ai_ci`-like). */
export function emailUniquenessKey(value: string | null | undefined) {
  return normalizeEmail(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Rails `timestamp without time zone` columns hold UTC; json_build_object omits the offset. */
export function railsTimestampToIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const hasZone = /(?:z|[+-]\d{2}(?::?\d{2})?)$/i.test(value);
  const parsed = Date.parse(hasZone ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

// MySQL TIMESTAMP ends in January 2038. Rails has far-future "effectively
// unexpired" purchases; the July projection stored those as no expiry.
const MAX_MYSQL_TIMESTAMP_MS = Date.UTC(2038, 0, 18, 23, 59, 59);

export function mysqlExpiryOrNull(iso: string | null): string | null {
  if (iso === null) return null;
  return Date.parse(iso) > MAX_MYSQL_TIMESTAMP_MS ? null : iso;
}

// ---------------------------------------------------------------------------
// CourseBuilder snapshot

export type JsonRecord = Record<string, unknown>;

export interface CbUser {
  readonly id: string;
  readonly email: string;
  readonly legacyRailsUserId: string | null;
  /**
   * Export emails MySQL's column collation says equal this user's email (the
   * store pairs them in SQL). Covers cases the JS key misses, such as `ß`/`ss`.
   */
  readonly matchedExportEmails: readonly string[];
}

export interface CbEntitlement {
  readonly id: string;
  readonly entitlementType: string;
  readonly userId: string | null;
  readonly organizationId: string | null;
  readonly organizationMembershipId: string | null;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly metadata: JsonRecord;
  /** ISO string or null. */
  readonly expiresAt: string | null;
  /** ISO string or null. */
  readonly deletedAt: string | null;
}

export interface CbMembership {
  readonly id: string;
  readonly organizationId: string | null;
  readonly userId: string;
  readonly role: string;
  readonly fields: JsonRecord;
}

/**
 * What the store read from CourseBuilder. `users` holds only users the export can
 * reference (by legacy Rails id or email). `entitlements` holds every live row
 * plus every soft-deleted row this delta owns.
 */
export interface CbSnapshot {
  readonly users: readonly CbUser[];
  /**
   * Export email -> its weight under the `egghead_User.email` column collation
   * (MySQL `WEIGHT_STRING`). Two emails with the same weight collide on the
   * unique key. Emails missing here fall back to `emailUniquenessKey`.
   */
  readonly exportEmailKeys: Readonly<Record<string, string>>;
  readonly entitlements: readonly CbEntitlement[];
  readonly memberships: readonly CbMembership[];
  readonly organizationIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Plan operations (JSON-serializable; dates are ISO strings)

export interface NewUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: string;
  readonly fields: JsonRecord;
  readonly emailVerified: string | null;
  readonly image: string | null;
  readonly createdAt: string | null;
}

export interface NewOrganization {
  readonly id: string;
  readonly name: string;
  readonly fields: JsonRecord;
  readonly createdAt: string | null;
}

export interface ExpectedMembership {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly invitedById: string;
  readonly role: string;
  readonly fields: JsonRecord;
  readonly createdAt: string | null;
}

export interface ExpectedEntitlement {
  readonly id: string;
  readonly entitlementType: string;
  readonly userId: string | null;
  readonly organizationId: string | null;
  readonly organizationMembershipId: string | null;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly metadata: JsonRecord;
  readonly expiresAt: string | null;
  readonly createdAt: string | null;
}

export type DeltaOp =
  | {
      readonly kind: "user_create";
      readonly key: string;
      readonly railsUserId: string;
      readonly user: NewUser;
    }
  | {
      readonly kind: "user_link";
      readonly key: string;
      readonly userId: string;
      readonly railsUserId: string;
    }
  | {
      /** Rails is the source of truth for email until the flip. */
      readonly kind: "user_email_update";
      readonly key: string;
      readonly userId: string;
      readonly railsUserId: string;
      readonly email: string;
      readonly previousEmail: string;
    }
  | {
      readonly kind: "organization_create";
      readonly key: string;
      readonly organization: NewOrganization;
    }
  | {
      readonly kind: "membership_create" | "membership_update";
      readonly key: string;
      readonly membership: ExpectedMembership;
      readonly reasons: readonly string[];
    }
  | { readonly kind: "membership_revoke"; readonly key: string; readonly membershipId: string }
  | {
      readonly kind: "entitlement_grant" | "entitlement_extend" | "entitlement_update";
      readonly key: string;
      readonly entitlement: ExpectedEntitlement;
      readonly reasons: readonly string[];
    }
  | {
      readonly kind: "entitlement_revoke" | "entitlement_expire";
      readonly key: string;
      readonly entitlementId: string;
    };

export type DeltaOpKind = DeltaOp["kind"];

export const DELTA_OP_KINDS: readonly DeltaOpKind[] = [
  "user_create",
  "user_email_update",
  "user_link",
  "organization_create",
  "membership_create",
  "membership_update",
  "entitlement_grant",
  "entitlement_extend",
  "entitlement_update",
  "membership_revoke",
  "entitlement_revoke",
  "entitlement_expire",
];

// Grants land before revokes so a crash mid-apply never removes access first.
const PHASE: Record<DeltaOpKind, number> = {
  user_create: 1,
  user_email_update: 1,
  user_link: 1,
  organization_create: 2,
  membership_create: 3,
  membership_update: 3,
  entitlement_grant: 4,
  entitlement_extend: 4,
  entitlement_update: 4,
  membership_revoke: 5,
  entitlement_revoke: 6,
  entitlement_expire: 6,
};

function opKey(kind: DeltaOpKind, id: string) {
  return `${PHASE[kind]}:${kind}:${id}`;
}

// ---------------------------------------------------------------------------
// Identity

export type IdentityOutcome =
  | {
      readonly kind: "matched";
      readonly userId: string;
      /** Rails email to write when CourseBuilder's differs under the collation. */
      readonly emailUpdate: { readonly from: string; readonly to: string } | null;
      /** The Rails email belongs to another user; the stale email is kept. */
      readonly emailHeld: boolean;
    }
  | { readonly kind: "linked"; readonly userId: string }
  | { readonly kind: "created"; readonly userId: string; readonly user: NewUser }
  | {
      readonly kind: "unresolved";
      readonly reason: "empty_email" | "duplicate_rails_email" | "email_owned_by_other_rails_user";
    };

function displayName(user: RailsUser) {
  return [user.firstName, user.lastName]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

function compact(record: Record<string, unknown>): JsonRecord {
  const result: JsonRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function newUserRow(user: RailsUser): NewUser {
  return {
    id: projectionIds.user(user.railsUserId),
    email: normalizeEmail(user.email),
    name: displayName(user),
    role: user.isBanned ? "banned" : "user",
    fields: {
      source: "rails_access_delta",
      legacyRailsUserId: user.railsUserId,
      isBanned: user.isBanned,
      signInCount: user.signInCount,
      hasAuthenticationToken: user.hasAuthenticationToken,
    },
    emailVerified: railsTimestampToIso(user.confirmedAt),
    image: user.avatarUrl,
    createdAt: railsTimestampToIso(user.createdAt),
  };
}

/** The unique-key identity of an email: the column collation's weight when known. */
export function emailKeyFor(snapshot: Pick<CbSnapshot, "exportEmailKeys">) {
  return (email: string | null | undefined) => {
    const normalized = normalizeEmail(email);
    const weight = snapshot.exportEmailKeys[normalized];
    return weight === undefined ? emailUniquenessKey(normalized) : `weight:${weight}`;
  };
}

/**
 * Match by legacy Rails id, then by email; Rails id order decides email
 * collisions. Emails compare under the column collation (`exportEmailKeys`), so
 * two Rails users MySQL would treat as one email never both become creates.
 */
export function resolveIdentities(
  railsExport: Pick<RailsAccessExport, "users">,
  snapshot: Pick<CbSnapshot, "users" | "exportEmailKeys">,
): Map<string, IdentityOutcome> {
  const keyFor = emailKeyFor(snapshot);
  const byRailsId = new Map<string, CbUser>();
  const byEmail = new Map<string, CbUser>();
  const keysOf = (user: CbUser) => [
    keyFor(user.email),
    ...user.matchedExportEmails.map((email) => keyFor(email)),
  ];
  for (const user of snapshot.users) {
    if (user.legacyRailsUserId) byRailsId.set(user.legacyRailsUserId, user);
    for (const key of keysOf(user)) byEmail.set(key, user);
  }

  const ordered = railsExport.users.toSorted(
    (a, b) =>
      Number(a.railsUserId) - Number(b.railsUserId) || a.railsUserId.localeCompare(b.railsUserId),
  );
  const claimedEmail = new Set<string>();
  const outcomes = new Map<string, IdentityOutcome>();

  // Pass 1: legacy-id matches claim their CourseBuilder emails first.
  const drifted: { user: RailsUser; matched: CbUser }[] = [];
  for (const user of ordered) {
    const matched = byRailsId.get(user.railsUserId);
    if (!matched) continue;
    const ownKeys = keysOf(matched);
    for (const key of ownKeys) claimedEmail.add(key);
    const railsEmail = normalizeEmail(user.email);
    if (railsEmail && !ownKeys.includes(keyFor(railsEmail))) drifted.push({ user, matched });
    outcomes.set(user.railsUserId, {
      kind: "matched",
      userId: matched.id,
      emailUpdate: null,
      emailHeld: false,
    });
  }

  // Pass 1b: a matched user whose Rails email changed takes the Rails email,
  // unless another user (CourseBuilder or Rails) already holds it.
  for (const { user, matched } of drifted) {
    const railsEmail = normalizeEmail(user.email);
    const key = keyFor(railsEmail);
    const holder = byEmail.get(key);
    const held = claimedEmail.has(key) || (holder !== undefined && holder.id !== matched.id);
    if (!held) claimedEmail.add(key);
    outcomes.set(user.railsUserId, {
      kind: "matched",
      userId: matched.id,
      emailUpdate: held ? null : { from: matched.email, to: railsEmail },
      emailHeld: held,
    });
  }

  for (const user of ordered) {
    if (outcomes.has(user.railsUserId)) continue;
    const email = normalizeEmail(user.email);
    if (!email) {
      outcomes.set(user.railsUserId, { kind: "unresolved", reason: "empty_email" });
      continue;
    }
    const key = keyFor(email);
    if (claimedEmail.has(key)) {
      const holder = byEmail.get(key);
      outcomes.set(user.railsUserId, {
        kind: "unresolved",
        reason: holder?.legacyRailsUserId
          ? "email_owned_by_other_rails_user"
          : "duplicate_rails_email",
      });
      continue;
    }
    claimedEmail.add(key);
    const existing = byEmail.get(key);
    if (existing) {
      outcomes.set(
        user.railsUserId,
        existing.legacyRailsUserId
          ? { kind: "unresolved", reason: "email_owned_by_other_rails_user" }
          : { kind: "linked", userId: existing.id },
      );
      continue;
    }
    const row = newUserRow(user);
    outcomes.set(user.railsUserId, { kind: "created", userId: row.id, user: row });
  }

  return outcomes;
}

/** Identity outcomes a person must resolve: they fail the gate. */
export function identityConflicts(identities: ReadonlyMap<string, IdentityOutcome>) {
  let duplicateEmail = 0;
  let emailOwnedByOtherRailsUser = 0;
  let emailUpdateHeld = 0;
  for (const outcome of identities.values()) {
    if (outcome.kind === "matched" && outcome.emailHeld) emailUpdateHeld++;
    if (outcome.kind !== "unresolved") continue;
    if (outcome.reason === "duplicate_rails_email") duplicateEmail++;
    if (outcome.reason === "email_owned_by_other_rails_user") emailOwnedByOtherRailsUser++;
  }
  return {
    duplicateEmail,
    emailOwnedByOtherRailsUser,
    emailUpdateHeld,
    total: duplicateEmail + emailOwnedByOtherRailsUser + emailUpdateHeld,
  };
}

function resolvedUserId(identities: ReadonlyMap<string, IdentityOutcome>, railsUserId: string) {
  const outcome = identities.get(railsUserId);
  return outcome && outcome.kind !== "unresolved" ? outcome.userId : null;
}

// ---------------------------------------------------------------------------
// Expected projection

export interface PolicyCounts {
  bulkPlaylistPurchases: number;
  countryRestrictedPlaylistPurchases: number;
  membersWithoutMemberRole: number;
  subscriptionsWithoutAccount: number;
  purchasesWithoutSellable: number;
  /** Purchases from another Skill Recordings site sharing Rails; never granted. */
  otherTenantPurchases: number;
  unresolvedGrantRows: number;
  /** Projected backed-`pro` and bare-active rows per source type (each alarms on growth). */
  backingGrants: Record<GatedSourceType, number>;
}

export interface ExpectedProjection {
  readonly entitlements: Map<string, ExpectedEntitlement>;
  readonly memberships: Map<string, ExpectedMembership>;
  readonly organizations: Map<string, NewOrganization>;
  readonly policy: PolicyCounts;
}

function roleEntitlement(grant: RailsRoleGrant, userId: string): ExpectedEntitlement {
  const key = `rails_user_role:${grant.roleName}:${grant.railsUserId}`;
  const lifetime = grant.roleName === "lifetime_subscriber" || grant.roleName === "VIP";
  return {
    id: projectionIds.entitlement(key),
    entitlementType: lifetime ? LIFETIME_TYPE : STAFF_TYPE,
    userId,
    organizationId: null,
    organizationMembershipId: null,
    sourceType: ROLE_SOURCE_TYPE,
    sourceId: `${grant.roleName}:${grant.railsUserId}`,
    metadata: {
      idempotencyKey: key,
      source: "special_role",
      roleName: grant.roleName,
      railsUserId: grant.railsUserId,
      accessReason:
        grant.roleName === "lifetime_subscriber" ? "lifetime_subscriber_role" : "special_role",
    },
    expiresAt: null,
    createdAt: null,
  };
}

function basicEntitlement(grant: RailsBasicGrant, userId: string): ExpectedEntitlement {
  const key = `${BASIC_SOURCE_TYPE}:${grant.railsUserId}`;
  return {
    id: projectionIds.entitlement(key),
    entitlementType: BASIC_ENTITLEMENT_TYPE,
    userId,
    organizationId: null,
    organizationMembershipId: null,
    sourceType: BASIC_SOURCE_TYPE,
    sourceId: grant.railsUserId,
    metadata: {
      idempotencyKey: key,
      source: "legacy_basic_role",
      roleName: "basic",
      railsUserId: grant.railsUserId,
      accessReason: "legacy_basic_role",
      accessLaw: BASIC_ACCESS_LAW,
      identityRolePreserved: false,
      defaultGrant: true,
    },
    expiresAt: null,
    createdAt: null,
  };
}

function backingKey(grant: RailsBackingGrant) {
  return `${BACKING_SOURCE_TYPES[grant.source]}:${grant.railsSourceId}:${grant.railsUserId}`;
}

/** Days past its period end after which a legacy subscription is held, not granted. */
export const DEFAULT_LEGACY_STALE_DAYS = 45;

/** A legacy subscription held because Stripe stopped renewing it (or never dated it). */
export interface HeldLegacySubscription {
  readonly railsSourceId: string;
  readonly railsUserId: string;
  readonly currentPeriodEnd: string | null;
  readonly reason: "period_end_stale" | "no_period_end";
}

/**
 * Rails users whose lessons Rails unlocks as pro today: the global `pro` role,
 * or a role `Ability#lesson_permissions` treats the same (`is_basic?`,
 * `is_instructor?` and the other special roles the export carries).
 */
export function railsProEligible(
  railsExport: Pick<RailsAccessExport, "proHolders" | "roleGrants" | "basicGrants">,
): ReadonlySet<string> {
  return new Set([
    ...railsExport.proHolders.map((holder) => holder.railsUserId),
    ...railsExport.roleGrants.map((grant) => grant.railsUserId),
    ...railsExport.basicGrants.map((grant) => grant.railsUserId),
  ]);
}

/**
 * Split backing into what grants, what is held and what only counts. Backing
 * grants only users Rails grants as pro today (`railsProEligible`): it explains
 * the grant and sets its expiry, it never widens it. Backing for anyone else
 * is `withoutPro` (counted, not granted). A pro-eligible legacy subscription
 * whose `currentPeriodEnd` is more than `staleDays` before `nowMs` (or
 * missing) is held: Rails' active scope only checks `cancelled_on` and
 * `willCancelAfterPeriod`, so a subscription Stripe stopped renewing without a
 * cancel still looks active.
 */
export function partitionBackingGrants(
  grants: readonly RailsBackingGrant[],
  proEligible: ReadonlySet<string>,
  nowMs: number,
  staleDays: number = DEFAULT_LEGACY_STALE_DAYS,
) {
  const cutoffMs = nowMs - staleDays * 86_400_000;
  const live: RailsBackingGrant[] = [];
  const held: HeldLegacySubscription[] = [];
  const withoutPro: RailsBackingGrant[] = [];
  for (const grant of grants) {
    if (!proEligible.has(grant.railsUserId)) {
      withoutPro.push(grant);
      continue;
    }
    if (grant.source !== "legacy_subscription") {
      live.push(grant);
      continue;
    }
    const iso = railsTimestampToIso(grant.currentPeriodEnd);
    const endMs = iso === null ? Number.NaN : Date.parse(iso);
    if (Number.isNaN(endMs) || endMs < cutoffMs) {
      held.push({
        railsSourceId: grant.railsSourceId,
        railsUserId: grant.railsUserId,
        currentPeriodEnd: iso,
        reason: Number.isNaN(endMs) ? "no_period_end" : "period_end_stale",
      });
    } else {
      live.push(grant);
    }
  }
  return { live, held, withoutPro };
}

/**
 * Users the export grants all access without needing `pro`: special roles,
 * `basic`, `account_member` seats, membership purchases and live backing.
 */
export function exportProEquivalent(
  railsExport: Pick<
    RailsAccessExport,
    "roleGrants" | "basicGrants" | "subscriptions" | "purchases"
  >,
  liveBacking: readonly RailsBackingGrant[],
): ReadonlySet<string> {
  return new Set([
    ...railsExport.roleGrants.map((grant) => grant.railsUserId),
    ...railsExport.basicGrants.map((grant) => grant.railsUserId),
    ...railsExport.subscriptions.flatMap((sub) =>
      sub.members.filter((member) => member.hasMemberRole).map((member) => member.railsUserId),
    ),
    ...railsExport.purchases
      .filter((purchase) => purchase.sellableType === "Resource::Membership")
      .map((purchase) => purchase.railsUserId),
    ...liveBacking.map((grant) => grant.railsUserId),
  ]);
}

const byRailsUserId = (a: { railsUserId: string }, b: { railsUserId: string }) =>
  Number(a.railsUserId) - Number(b.railsUserId) || a.railsUserId.localeCompare(b.railsUserId);

/**
 * Bare `pro`: Rails holds `pro`, and nothing else in the export grants the
 * user (held stale legacy subscriptions and orphans have their own lists).
 * Split by sign-in: holders who signed in within `activeDays` of `nowMs` are
 * granted (`rails_bare_pro_active`); the rest are held for a person.
 */
export function splitBarePro(
  railsExport: Pick<
    RailsAccessExport,
    "proHolders" | "roleGrants" | "basicGrants" | "subscriptions" | "purchases"
  >,
  liveBacking: readonly RailsBackingGrant[],
  heldRailsUserIds: ReadonlySet<string>,
  nowMs: number,
  activeDays: number = DEFAULT_BARE_PRO_ACTIVE_DAYS,
) {
  const granted = exportProEquivalent(railsExport, liveBacking);
  const seen = new Set<string>();
  const bare = railsExport.proHolders
    .filter((holder) => {
      if (seen.has(holder.railsUserId)) return false;
      seen.add(holder.railsUserId);
      return !granted.has(holder.railsUserId) && !heldRailsUserIds.has(holder.railsUserId);
    })
    .toSorted(byRailsUserId);
  const cutoffMs = nowMs - activeDays * 86_400_000;
  const signedInMs = (holder: RailsProHolder) => {
    const iso = railsTimestampToIso(holder.lastSignInOn);
    return iso === null ? Number.NaN : Date.parse(iso);
  };
  return {
    all: bare,
    active: bare.filter((holder) => signedInMs(holder) >= cutoffMs),
    held: bare.filter((holder) => !(signedInMs(holder) >= cutoffMs)),
  };
}

function backingEntitlement(grant: RailsBackingGrant, userId: string): ExpectedEntitlement {
  const sourceType = BACKING_SOURCE_TYPES[grant.source];
  const key = backingKey(grant);
  return {
    id: projectionIds.entitlement(key),
    entitlementType: ALL_ACCESS_TYPE,
    userId,
    organizationId: null,
    organizationMembershipId: null,
    sourceType,
    sourceId: `${grant.railsSourceId}:${grant.railsUserId}`,
    metadata: compact({
      idempotencyKey: key,
      source: `backed_pro_${grant.source}`,
      railsSourceId: grant.railsSourceId,
      railsUserId: grant.railsUserId,
      accessReason: "backed_legacy_pro",
      // A gift ends on expiresAt (the runtime exempts only rails_account_subscription
      // rows from it); managed and legacy subscriptions follow the lenient law.
      accessLaw: grant.source === "gift" ? GIFT_ACCESS_LAW : SUBSCRIPTION_ACCESS_LAW,
      // Legacy subscriptions: the period end is metadata.
      currentPeriodEnd: railsTimestampToIso(grant.currentPeriodEnd) ?? undefined,
    }),
    // Gifts end on their own clock; managed and legacy subscriptions while live.
    expiresAt:
      grant.source === "gift" ? mysqlExpiryOrNull(railsTimestampToIso(grant.expiresAt)) : null,
    createdAt: null,
  };
}

function membershipRole(member: RailsSubscriptionMember) {
  if (member.hasOwnerRole) return "owner";
  if (member.hasMemberRole) return "member";
  return "user";
}

export function buildExpectedProjection(
  railsExport: RailsAccessExport,
  identities: ReadonlyMap<string, IdentityOutcome>,
  bareProActive: readonly RailsProHolder[] = [],
  /** Stale legacy subscription ids behind a bare-active grant, by Rails user id. */
  staleLegacyByUser: ReadonlyMap<string, readonly string[]> = new Map(),
): ExpectedProjection {
  const entitlements = new Map<string, ExpectedEntitlement>();
  const memberships = new Map<string, ExpectedMembership>();
  const organizations = new Map<string, NewOrganization>();
  const policy: PolicyCounts = {
    bulkPlaylistPurchases: 0,
    countryRestrictedPlaylistPurchases: 0,
    membersWithoutMemberRole: 0,
    subscriptionsWithoutAccount: 0,
    purchasesWithoutSellable: 0,
    otherTenantPurchases: 0,
    unresolvedGrantRows: 0,
    backingGrants: {
      rails_gift: 0,
      rails_managed_subscription: 0,
      rails_legacy_subscription: 0,
      rails_bare_pro_active: 0,
    },
  };
  const put = (row: ExpectedEntitlement) => entitlements.set(row.id, row);

  for (const grant of railsExport.roleGrants) {
    const userId = resolvedUserId(identities, grant.railsUserId);
    if (userId) put(roleEntitlement(grant, userId));
    else policy.unresolvedGrantRows++;
  }

  for (const grant of railsExport.basicGrants) {
    const userId = resolvedUserId(identities, grant.railsUserId);
    if (userId) put(basicEntitlement(grant, userId));
    else policy.unresolvedGrantRows++;
  }

  for (const sub of railsExport.subscriptions) {
    if (!sub.railsAccountId) {
      policy.subscriptionsWithoutAccount++;
      continue;
    }
    const railsAccountId = sub.railsAccountId;
    const orgId = projectionIds.organization(railsAccountId);
    const createdAt = railsTimestampToIso(sub.createdAt);
    const currentPeriodEnd = railsTimestampToIso(sub.currentPeriodEnd);
    if (!organizations.has(orgId)) {
      organizations.set(orgId, {
        id: orgId,
        name: sub.accountName || `Rails account ${railsAccountId}`,
        fields: compact({
          source: SUBSCRIPTION_SOURCE_TYPE,
          legacyRailsAccountId: railsAccountId,
          legacyRailsAccountGuid: sub.accountGuid ?? undefined,
          legacyRailsAccountSlug: sub.accountSlug ?? undefined,
          stripeCustomerIdPresent: sub.stripeCustomerIdPresent,
        }),
        createdAt,
      });
    }

    const orgKey = `rails_account_subscription:${sub.railsAccountSubscriptionId}:organization:${orgId}:${ALL_ACCESS_TYPE}`;
    put({
      id: projectionIds.entitlement(orgKey),
      entitlementType: ALL_ACCESS_TYPE,
      userId: null,
      organizationId: orgId,
      organizationMembershipId: null,
      sourceType: SUBSCRIPTION_SOURCE_TYPE,
      sourceId: sub.railsAccountSubscriptionId,
      metadata: {
        idempotencyKey: orgKey,
        source: "enabled_account_subscription",
        railsAccountSubscriptionId: sub.railsAccountSubscriptionId,
        railsAccountId,
        status: sub.status,
        quantity: sub.quantity,
        accessReason: "enabled_account_subscription",
        accessLaw: SUBSCRIPTION_ACCESS_LAW,
        currentPeriodEnd,
        ownerType: "organization",
      },
      expiresAt: null,
      createdAt,
    });

    for (const member of sub.members) {
      const userId = resolvedUserId(identities, member.railsUserId);
      if (!userId) {
        if (member.hasMemberRole) policy.unresolvedGrantRows++;
        continue;
      }
      const membershipId = member.railsAccountUserId
        ? projectionIds.membership(member.railsAccountUserId)
        : projectionIds.roleMembership(railsAccountId, member.railsUserId);
      memberships.set(membershipId, {
        id: membershipId,
        organizationId: orgId,
        userId,
        invitedById: userId,
        role: membershipRole(member),
        fields: compact({
          source: member.railsAccountUserId ? "rails_account_user" : "rails_scoped_account_role",
          legacyRailsAccountUserId: member.railsAccountUserId ?? undefined,
          legacyRailsAccountId: railsAccountId,
          legacyRailsUserId: member.railsUserId,
          hasAccountMemberRole: member.hasMemberRole,
          hasAccountOwnerRole: member.hasOwnerRole,
        }),
        createdAt: railsTimestampToIso(member.createdAt),
      });
      if (!member.hasMemberRole) {
        policy.membersWithoutMemberRole++;
        continue;
      }
      const seatKey = `rails_account_subscription:${sub.railsAccountSubscriptionId}:membership:${membershipId}:${ALL_ACCESS_TYPE}`;
      put({
        id: projectionIds.entitlement(seatKey),
        entitlementType: ALL_ACCESS_TYPE,
        userId,
        organizationId: orgId,
        organizationMembershipId: membershipId,
        sourceType: SUBSCRIPTION_SOURCE_TYPE,
        sourceId: sub.railsAccountSubscriptionId,
        metadata: compact({
          idempotencyKey: seatKey,
          source: "enabled_account_subscription",
          railsAccountSubscriptionId: sub.railsAccountSubscriptionId,
          railsAccountId,
          railsAccountUserId: member.railsAccountUserId ?? undefined,
          railsUserId: member.railsUserId,
          status: sub.status,
          quantity: sub.quantity,
          accessReason: "enabled_account_subscription_membership",
          accessLaw: SUBSCRIPTION_ACCESS_LAW,
          currentPeriodEnd,
          scopedAccountMemberRole: true,
          ownerType: "user",
        }),
        expiresAt: null,
        createdAt,
      });
    }
  }

  for (const purchase of railsExport.purchases) {
    if (!isEggheadRailsApplication(purchase.railsApplicationId)) {
      policy.otherTenantPurchases++;
      continue;
    }
    const userId = resolvedUserId(identities, purchase.railsUserId);
    if (!userId) {
      policy.unresolvedGrantRows++;
      continue;
    }
    const sellableType = purchase.sellableType ?? "";
    const sellableId = purchase.sellableId ?? "";
    if (!sellableType || !sellableId) {
      policy.purchasesWithoutSellable++;
      continue;
    }
    const entitlementType =
      sellableType === "Resource::Membership" ? MEMBERSHIP_ACCESS_TYPE : PLAYLIST_ACCESS_TYPE;
    // Rails Lesson.purchased: bulk playlist rows are seat pools, not content grants.
    if (entitlementType === PLAYLIST_ACCESS_TYPE && purchase.bulk) {
      policy.bulkPlaylistPurchases++;
      continue;
    }
    const restrictedToCountry = purchase.restrictedToCountry?.trim() || null;
    if (entitlementType === PLAYLIST_ACCESS_TYPE && restrictedToCountry) {
      policy.countryRestrictedPlaylistPurchases++;
    }
    const key = `rails_sellable_purchase:${purchase.railsSellablePurchaseId}`;
    put({
      id: projectionIds.entitlement(key),
      entitlementType,
      userId,
      organizationId: null,
      organizationMembershipId: null,
      sourceType: PURCHASE_SOURCE_TYPE,
      sourceId: purchase.railsSellablePurchaseId,
      metadata: compact({
        idempotencyKey: key,
        source: "viewable_sellable_purchase",
        railsSellablePurchaseId: purchase.railsSellablePurchaseId,
        railsUserId: purchase.railsUserId,
        productId: projectionIds.product(sellableType, sellableId),
        sellableType,
        sellableId,
        accessReason: "viewable_sellable_purchase",
        bulk: purchase.bulk ? true : undefined,
        restrictedToCountry: restrictedToCountry ?? undefined,
      }),
      expiresAt: mysqlExpiryOrNull(railsTimestampToIso(purchase.expiresAt)),
      createdAt: railsTimestampToIso(purchase.createdAt),
    });
  }

  for (const grant of railsExport.backingGrants) {
    const userId = resolvedUserId(identities, grant.railsUserId);
    if (!userId) {
      policy.unresolvedGrantRows++;
      continue;
    }
    const row = backingEntitlement(grant, userId);
    if (!entitlements.has(row.id)) policy.backingGrants[BACKING_SOURCE_TYPES[grant.source]]++;
    put(row);
  }

  for (const holder of bareProActive) {
    const userId = resolvedUserId(identities, holder.railsUserId);
    if (!userId) {
      policy.unresolvedGrantRows++;
      continue;
    }
    const key = `${BARE_PRO_ACTIVE_SOURCE_TYPE}:${holder.railsUserId}`;
    const row: ExpectedEntitlement = {
      id: projectionIds.entitlement(key),
      entitlementType: ALL_ACCESS_TYPE,
      userId,
      organizationId: null,
      organizationMembershipId: null,
      sourceType: BARE_PRO_ACTIVE_SOURCE_TYPE,
      sourceId: holder.railsUserId,
      metadata: compact({
        idempotencyKey: key,
        source: "bare_pro_recently_active",
        railsUserId: holder.railsUserId,
        staleLegacySubscriptionIds: staleLegacyByUser.get(holder.railsUserId),
        accessReason: "bare_pro_recently_active",
        accessLaw: SUBSCRIPTION_ACCESS_LAW,
      }),
      expiresAt: null,
      createdAt: null,
    };
    if (!entitlements.has(row.id)) policy.backingGrants[BARE_PRO_ACTIVE_SOURCE_TYPE]++;
    put(row);
  }

  return { entitlements, memberships, organizations, policy };
}

// ---------------------------------------------------------------------------
// Diff

function timeOf(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function sameValue(expected: unknown, stored: unknown): boolean {
  if ((expected === null || expected === undefined) && (stored === null || stored === undefined)) {
    return true;
  }
  const expectedTime = timeOf(expected);
  const storedTime = timeOf(stored);
  if (expectedTime !== null && storedTime !== null) return expectedTime === storedTime;
  if (typeof expected === "boolean" && typeof stored === "string") {
    return String(expected) === stored;
  }
  if (typeof expected === "number" && typeof stored === "string") {
    return String(expected) === stored;
  }
  return JSON.stringify(expected) === JSON.stringify(stored);
}

/** Keys present in `expected` that differ in `stored`. Extra stored keys are kept and ignored. */
function changedKeys(expected: JsonRecord, stored: JsonRecord) {
  return Object.keys(expected).filter((key) => !sameValue(expected[key], stored[key]));
}

function laterThan(next: unknown, previous: unknown) {
  const nextTime = timeOf(next);
  const previousTime = timeOf(previous);
  return nextTime !== null && (previousTime === null || nextTime > previousTime);
}

function classifyEntitlement(
  expected: ExpectedEntitlement,
  existing: CbEntitlement | undefined,
): {
  kind: "entitlement_grant" | "entitlement_extend" | "entitlement_update";
  reasons: string[];
} | null {
  if (!existing) return { kind: "entitlement_grant", reasons: ["new"] };
  if (existing.deletedAt !== null) return { kind: "entitlement_grant", reasons: ["restored"] };

  const reasons: string[] = [];
  const columns = [
    "entitlementType",
    "userId",
    "organizationId",
    "organizationMembershipId",
    "sourceType",
    "sourceId",
  ] as const;
  for (const column of columns) {
    if (!sameValue(expected[column], existing[column])) reasons.push(`${column}_changed`);
  }

  let extended = false;
  if (!sameValue(expected.expiresAt, existing.expiresAt)) {
    const longer =
      (expected.expiresAt === null && existing.expiresAt !== null) ||
      laterThan(expected.expiresAt, existing.expiresAt);
    reasons.push(longer ? "expires_at_later" : "expires_at_earlier");
    extended ||= longer;
  }
  for (const key of changedKeys(expected.metadata, existing.metadata)) {
    if (key === "currentPeriodEnd" && laterThan(expected.metadata[key], existing.metadata[key])) {
      reasons.push("current_period_end_later");
      extended = true;
    } else {
      reasons.push(`metadata_${key}_changed`);
    }
  }

  if (reasons.length === 0) return null;
  const onlyExtension = reasons.every(
    (reason) => reason === "expires_at_later" || reason === "current_period_end_later",
  );
  return { kind: extended && onlyExtension ? "entitlement_extend" : "entitlement_update", reasons };
}

/**
 * G2: a held user keeps everything and an orphan loses everything, so one id
 * must never be both. Holding excludes orphans by construction; this refuses
 * to plan if that ever breaks.
 */
export function assertHeldNotOrphaned(
  held: ReadonlySet<string>,
  orphans: ReadonlySet<string>,
): void {
  const both = [...held].filter((id) => orphans.has(id)).toSorted();
  if (both.length > 0) {
    throw new Error(`Rails ids both held and orphaned: ${both.join(", ")}; refusing to plan`);
  }
}

/** The seat flag that grants through organization-level entitlements. */
export function membershipGrants(membership: Pick<CbMembership, "fields">) {
  const flag = membership.fields["hasAccountMemberRole"];
  return flag === true || flag === "true";
}

/**
 * A held seat flag: keep the flag and the role it implies as they are, and
 * still apply every other change Rails made to the membership.
 */
function keepSeatFlag(expected: ExpectedMembership, existing: CbMembership): ExpectedMembership {
  return Object.assign({}, expected, {
    role: existing.role,
    fields: Object.assign({}, expected.fields, {
      hasAccountMemberRole: existing.fields["hasAccountMemberRole"],
    }),
  });
}

function membershipReasons(expected: ExpectedMembership, existing: CbMembership) {
  const reasons: string[] = [];
  if (!sameValue(expected.organizationId, existing.organizationId))
    reasons.push("organization_changed");
  if (!sameValue(expected.userId, existing.userId)) reasons.push("user_changed");
  if (!sameValue(expected.role, existing.role)) reasons.push("role_changed");
  for (const key of changedKeys(expected.fields, existing.fields))
    reasons.push(`fields_${key}_changed`);
  return reasons;
}

export interface DeltaPlan {
  readonly ops: readonly DeltaOp[];
  readonly identities: ReadonlyMap<string, IdentityOutcome>;
  readonly expected: ExpectedProjection;
  readonly revokeHeldForIdentity: number;
  /** Seat flags kept because the member's Rails identity is unresolved. */
  readonly membershipRevokeHeldForIdentity: number;
  /** Seat flags kept because the organization also holds CourseBuilder-native grants. */
  readonly membershipFlagHeldForNativeOrganization: number;
  /** Membership ids behind that count, for `--held-seat-flag <id>=clear|keep`. */
  readonly heldSeatFlags: readonly HeldSeatFlag[];
  /** Overrides that matched no held seat flag (stale): they fail the gate. */
  readonly unusedSeatFlagOverrides: readonly string[];
  readonly activeOwnedEntitlements: number;
  /** Rails-sourced memberships whose seat flag currently grants (alarm base). */
  readonly activeRailsSeatFlags: number;
  /** Backing that grants: pro-eligible users, stale legacy subscriptions removed. */
  readonly liveBackingGrants: readonly RailsBackingGrant[];
  /** Backing for users Rails does not grant as pro today: counted, never granted. */
  readonly backingWithoutPro: readonly RailsBackingGrant[];
  /** Bare `pro` (sorted by Rails id): all, granted as recently active, and held. */
  readonly barePro: {
    readonly all: readonly RailsProHolder[];
    readonly staleOnly: readonly RailsProHolder[];
    readonly active: readonly RailsProHolder[];
    readonly kept: readonly RailsProHolder[];
    readonly held: readonly RailsProHolder[];
  };
  /**
   * The export as this plan reads it: live backing only, and users referenced
   * only by a `pro_holder` line kept only when bare-active. The shadow and
   * identity checks use this, so dormant bare holders are never touched.
   */
  readonly projectedExport: RailsAccessExport;
  /** Legacy subscriptions held as stale: granted nothing, existing rows kept. */
  readonly heldLegacySubscriptions: readonly HeldLegacySubscription[];
  /** Every pro-eligible stale legacy subscription, before the one-list rule (for reconciliation). */
  readonly staleLegacyAll: readonly HeldLegacySubscription[];
  /** Existing rows kept for a held stale legacy subscription. */
  readonly revokeHeldForStaleLegacy: number;
  /**
   * Rows and seat flags kept because their user is held (bare `pro` or
   * stale-only, outside the window): held means nothing revoked. Organization
   * rows count when a held user holds a granting seat in that organization.
   */
  readonly revokeHeldForHeldUser: number;
  readonly membershipRevokeHeldForHeldUser: number;
  /** Revokes and expiries of rows and seats for orphan Rails users (deleted in Rails). */
  readonly orphanRowsRevoked: number;
  /** Organization rows kept only because a held member's seat holds them (a subset of `heldEntitlementIds`). */
  readonly heldForMemberEntitlementIds: ReadonlySet<string>;
  /** Entitlement and membership ids kept by a hold; their over-grants are the hold's. */
  readonly heldEntitlementIds: ReadonlySet<string>;
  readonly heldMembershipIds: ReadonlySet<string>;
}

/**
 * Compute every change that makes CourseBuilder match the Rails export.
 * `nowMs` is the export's clock (manifest `exportedAt`): owned rows Rails dropped
 * only because they expired by then become `entitlement_expire`, not revokes.
 */
export interface HeldSeatFlag {
  readonly membershipId: string;
  readonly userId: string;
  readonly organizationId: string;
  /** null: held (fails the gate through the over-grant); otherwise the person's ruling. */
  readonly ruling: SeatFlagRuling | null;
}

/**
 * A person's ruling on one held seat flag (an org with CourseBuilder-native
 * grants): `clear` removes the seat (the member loses the native grant too);
 * `keep` leaves it and accepts that member's over-grant.
 */
export type SeatFlagRuling = "clear" | "keep";

/**
 * What the delta acts on: backing split into live, held and pro-less; bare
 * `pro` split by sign-in; and the export with users referenced only by
 * `pro_holder` lines dropped unless they are bare-active.
 */
export function deltaScope(
  railsExport: RailsAccessExport,
  nowMs: number,
  options: Pick<DeltaPlanOptions, "legacyStaleDays" | "bareProActiveDays"> = {},
  /**
   * Rails ids with a live `rails_bare_pro_active` row. The sign-in window
   * decides only the first grant: while Rails keeps their `pro` role, the row
   * stays (dormancy after the flip is the new app's business).
   */
  existingBareProActive: ReadonlySet<string> = new Set(),
) {
  const backing = partitionBackingGrants(
    railsExport.backingGrants,
    railsProEligible(railsExport),
    nowMs,
    options.legacyStaleDays ?? DEFAULT_LEGACY_STALE_DAYS,
  );
  // A pro holder whose only backing is a stale legacy subscription is bare `pro`
  // with dead billing: the same sign-in window decides.
  const split = splitBarePro(
    railsExport,
    backing.live,
    new Set(railsExport.orphanRailsUserIds),
    nowMs,
    options.bareProActiveDays ?? DEFAULT_BARE_PRO_ACTIVE_DAYS,
  );
  const staleUsers = new Set(backing.held.map((held) => held.railsUserId));
  const isStaleOnly = (holder: RailsProHolder) => staleUsers.has(holder.railsUserId);
  const activeIds = new Set(split.active.map((holder) => holder.railsUserId));
  const seenKept = new Set<string>();
  const kept = railsExport.proHolders
    .filter((holder) => {
      const id = holder.railsUserId;
      if (!existingBareProActive.has(id) || activeIds.has(id) || seenKept.has(id)) return false;
      seenKept.add(id);
      return true;
    })
    .toSorted(byRailsUserId);
  const keptIds = new Set(kept.map((holder) => holder.railsUserId));
  const active = [...split.active, ...kept].toSorted(byRailsUserId);
  const grantedIds = new Set(active.map((holder) => holder.railsUserId));
  const barePro = {
    /** Bare holders without a stale legacy subscription. */
    all: split.all.filter((holder) => !isStaleOnly(holder)),
    /** Holders whose only backing is a stale legacy subscription (granted or held). */
    staleOnly: split.all.filter(isStaleOnly),
    /** Granted: inside the window now, or keeping a row from an earlier run. */
    active,
    /** Outside the window but kept because their row exists and `pro` remains. */
    kept,
    /** Held bare `pro`; stale-only holders are on the stale legacy list instead. */
    held: split.held.filter((holder) => !keptIds.has(holder.railsUserId) && !isStaleOnly(holder)),
  };
  // One list per person: a stale subscription is held only when its holder has
  // nothing else that grants and is outside the window.
  const staleOnlyIds = new Set(barePro.staleOnly.map((holder) => holder.railsUserId));
  const heldLegacy = backing.held.filter(
    (held) => staleOnlyIds.has(held.railsUserId) && !grantedIds.has(held.railsUserId),
  );
  const staleByGrantedUser = new Map<string, string[]>();
  for (const held of backing.held) {
    if (!staleOnlyIds.has(held.railsUserId) || !grantedIds.has(held.railsUserId)) continue;
    const list = staleByGrantedUser.get(held.railsUserId) ?? [];
    list.push(held.railsSourceId);
    staleByGrantedUser.set(held.railsUserId, list);
  }
  const grantReferenced = new Set([
    ...railsExport.roleGrants.map((grant) => grant.railsUserId),
    ...railsExport.basicGrants.map((grant) => grant.railsUserId),
    ...railsExport.purchases.map((purchase) => purchase.railsUserId),
    ...backing.live.map((grant) => grant.railsUserId),
    ...railsExport.subscriptions.flatMap((sub) => sub.members.map((member) => member.railsUserId)),
    ...barePro.active.map((holder) => holder.railsUserId),
  ]);
  const proOnly = new Set(
    railsExport.proHolders
      .map((holder) => holder.railsUserId)
      .filter((railsUserId) => !grantReferenced.has(railsUserId)),
  );
  const projectedExport: RailsAccessExport = {
    ...railsExport,
    users: railsExport.users.filter((user) => !proOnly.has(user.railsUserId)),
    backingGrants: backing.live,
  };
  return { backing, barePro, heldLegacy, staleByGrantedUser, projectedExport };
}

export interface DeltaPlanOptions {
  readonly seatFlagRulings?: ReadonlyMap<string, SeatFlagRuling>;
  /** Default 45 (`DEFAULT_LEGACY_STALE_DAYS`). */
  readonly legacyStaleDays?: number;
  /** Default 365 (`DEFAULT_BARE_PRO_ACTIVE_DAYS`). */
  readonly bareProActiveDays?: number;
}

export function computeDeltaPlan(
  railsExport: RailsAccessExport,
  snapshot: CbSnapshot,
  nowMs: number,
  options: DeltaPlanOptions = {},
): DeltaPlan {
  const existingBareProActive = new Set(
    snapshot.entitlements.flatMap((row) => {
      const railsUserId = row.metadata["railsUserId"];
      return row.sourceType === BARE_PRO_ACTIVE_SOURCE_TYPE &&
        row.deletedAt === null &&
        typeof railsUserId === "string"
        ? [railsUserId]
        : [];
    }),
  );
  const scope = deltaScope(railsExport, nowMs, options, existingBareProActive);
  const { backing, barePro, heldLegacy, staleByGrantedUser, projectedExport } = scope;
  const identities = resolveIdentities(projectedExport, snapshot);
  const expected = buildExpectedProjection(
    projectedExport,
    identities,
    barePro.active,
    staleByGrantedUser,
  );
  const ops: DeltaOp[] = [];
  const unresolvedRailsUserIds = new Set(
    [...identities].filter(([, outcome]) => outcome.kind === "unresolved").map(([id]) => id),
  );
  const orphanRailsUserIds = new Set(railsExport.orphanRailsUserIds);
  const heldLegacyRowIds = new Set(
    heldLegacy.map((held) =>
      projectionIds.entitlement(
        `${BACKING_SOURCE_TYPES.legacy_subscription}:${held.railsSourceId}:${held.railsUserId}`,
      ),
    ),
  );
  const heldEntitlementIds = new Set<string>();
  const heldMembershipIds = new Set<string>();
  let revokeHeldForStaleLegacy = 0;
  let orphanRowsRevoked = 0;
  // Held means nothing revoked: a held bare or stale-only holder keeps every
  // row and seat flag they have until a person rules on them.
  const heldRailsUserIds = new Set([
    ...barePro.held.map((holder) => holder.railsUserId),
    ...heldLegacy.map((held) => held.railsUserId),
  ]);
  const heldCbUserIds = new Set(
    snapshot.users
      .filter(
        (user) => user.legacyRailsUserId !== null && heldRailsUserIds.has(user.legacyRailsUserId),
      )
      .map((user) => user.id),
  );
  const isHeldUser = (cbUserId: string | null, railsUserId: unknown) =>
    (typeof railsUserId === "string" && heldRailsUserIds.has(railsUserId)) ||
    (cbUserId !== null && heldCbUserIds.has(cbUserId));
  // An organization row grants a held member through their seat: keep it too.
  const heldOrganizations = new Set(
    snapshot.memberships
      .filter(
        (membership) =>
          membership.organizationId !== null &&
          membershipGrants(membership) &&
          isHeldUser(membership.userId, membership.fields["legacyRailsUserId"]),
      )
      .map((membership) => membership.organizationId),
  );
  let revokeHeldForHeldUser = 0;
  let membershipRevokeHeldForHeldUser = 0;
  const heldForMemberEntitlementIds = new Set<string>();
  assertHeldNotOrphaned(heldRailsUserIds, orphanRailsUserIds);
  // Organizations that also carry live grants this delta does not own (for
  // example a CourseBuilder Stripe team subscription). Their seat flags gate
  // those grants too, so the delta never clears them.
  const nativeOrganizations = new Set(
    snapshot.entitlements
      .filter(
        (row) =>
          row.deletedAt === null &&
          row.organizationId !== null &&
          !DELTA_OWNED_SOURCE_TYPES.has(row.sourceType),
      )
      .map((row) => row.organizationId),
  );
  let membershipRevokeHeldForIdentity = 0;
  let membershipFlagHeldForNativeOrganization = 0;
  const rulings = options.seatFlagRulings ?? new Map<string, SeatFlagRuling>();
  const heldSeatFlags: HeldSeatFlag[] = [];
  /** Hold a seat flag unless a person ruled `clear`; true means push the op. */
  const holdSeatFlag = (membership: Pick<CbMembership, "id" | "userId" | "organizationId">) => {
    const ruling = rulings.get(membership.id) ?? null;
    heldSeatFlags.push({
      membershipId: membership.id,
      userId: membership.userId,
      organizationId: membership.organizationId ?? "",
      ruling,
    });
    if (ruling === "clear") return true;
    membershipFlagHeldForNativeOrganization++;
    return false;
  };

  for (const [railsUserId, outcome] of identities) {
    if (outcome.kind === "created") {
      ops.push({
        kind: "user_create",
        key: opKey("user_create", outcome.userId),
        railsUserId,
        user: outcome.user,
      });
    } else if (outcome.kind === "linked") {
      ops.push({
        kind: "user_link",
        key: opKey("user_link", outcome.userId),
        userId: outcome.userId,
        railsUserId,
      });
    } else if (outcome.kind === "matched" && outcome.emailUpdate) {
      ops.push({
        kind: "user_email_update",
        key: opKey("user_email_update", outcome.userId),
        userId: outcome.userId,
        railsUserId,
        email: outcome.emailUpdate.to,
        previousEmail: outcome.emailUpdate.from,
      });
    }
  }

  const organizationIds = new Set(snapshot.organizationIds);
  for (const organization of expected.organizations.values()) {
    if (!organizationIds.has(organization.id)) {
      ops.push({
        kind: "organization_create",
        key: opKey("organization_create", organization.id),
        organization,
      });
    }
  }

  const membershipsById = new Map(snapshot.memberships.map((row) => [row.id, row]));
  for (const membership of expected.memberships.values()) {
    const existing = membershipsById.get(membership.id);
    if (!existing) {
      ops.push({
        kind: "membership_create",
        key: opKey("membership_create", membership.id),
        membership,
        reasons: ["new"],
      });
      continue;
    }
    const clearsFlag = membershipGrants(existing) && !membershipGrants(membership);
    let target = membership;
    if (clearsFlag && isHeldUser(existing.userId, existing.fields["legacyRailsUserId"])) {
      membershipRevokeHeldForHeldUser++;
      heldMembershipIds.add(existing.id);
      target = keepSeatFlag(membership, existing);
    } else if (
      clearsFlag &&
      existing.organizationId &&
      nativeOrganizations.has(existing.organizationId) &&
      !holdSeatFlag(existing)
    ) {
      target = keepSeatFlag(membership, existing);
    }
    const reasons = membershipReasons(target, existing);
    if (reasons.length > 0) {
      ops.push({
        kind: "membership_update",
        key: opKey("membership_update", membership.id),
        membership: target,
        reasons,
      });
    }
  }

  // A Rails-sourced seat flag that Rails no longer backs would keep granting
  // through organization-level entitlements; clear it.
  let activeRailsSeatFlags = 0;
  for (const membership of snapshot.memberships) {
    const source = membership.fields["source"];
    if (typeof source !== "string" || !RAILS_MEMBERSHIP_SOURCES.has(source)) continue;
    if (!membershipGrants(membership)) continue;
    activeRailsSeatFlags++;
    // An expected row is handled above as create/update (no double count).
    if (expected.memberships.has(membership.id)) continue;
    const railsUserId = membership.fields["legacyRailsUserId"];
    if (isHeldUser(membership.userId, railsUserId)) {
      membershipRevokeHeldForHeldUser++;
      heldMembershipIds.add(membership.id);
      continue;
    }
    if (typeof railsUserId === "string" && unresolvedRailsUserIds.has(railsUserId)) {
      membershipRevokeHeldForIdentity++;
      continue;
    }
    if (
      membership.organizationId &&
      nativeOrganizations.has(membership.organizationId) &&
      !holdSeatFlag(membership)
    ) {
      continue;
    }
    // Orphans (a grant line, no user line: deleted in Rails) are revoked:
    // Rails grants a deleted user nothing.
    if (typeof railsUserId === "string" && orphanRailsUserIds.has(railsUserId)) {
      orphanRowsRevoked++;
    }
    ops.push({
      kind: "membership_revoke",
      key: opKey("membership_revoke", membership.id),
      membershipId: membership.id,
    });
  }

  const entitlementsById = new Map(snapshot.entitlements.map((row) => [row.id, row]));
  for (const entitlement of expected.entitlements.values()) {
    const change = classifyEntitlement(entitlement, entitlementsById.get(entitlement.id));
    if (change) {
      ops.push({
        kind: change.kind,
        key: opKey(change.kind, entitlement.id),
        entitlement,
        reasons: change.reasons,
      });
    }
  }

  let revokeHeldForIdentity = 0;
  let activeOwnedEntitlements = 0;
  for (const row of snapshot.entitlements) {
    if (row.deletedAt !== null || !DELTA_OWNED_SOURCE_TYPES.has(row.sourceType)) continue;
    activeOwnedEntitlements++;
    if (expected.entitlements.has(row.id)) continue;
    if (heldLegacyRowIds.has(row.id)) {
      // Held, not revoked: a person rules on stale legacy subscriptions.
      revokeHeldForStaleLegacy++;
      heldEntitlementIds.add(row.id);
      continue;
    }
    const railsUserId = row.metadata["railsUserId"];
    if (isHeldUser(row.userId, railsUserId)) {
      revokeHeldForHeldUser++;
      heldEntitlementIds.add(row.id);
      continue;
    }
    if (row.organizationId !== null && heldOrganizations.has(row.organizationId)) {
      // Kept for a held member's seat; every other member keeps it too.
      revokeHeldForHeldUser++;
      heldEntitlementIds.add(row.id);
      heldForMemberEntitlementIds.add(row.id);
      continue;
    }
    if (typeof railsUserId === "string" && unresolvedRailsUserIds.has(railsUserId)) {
      // Rails still grants this user; we just could not resolve them. Keep the row.
      revokeHeldForIdentity++;
      continue;
    }
    // Expired by the export's clock: Rails dropped it for time, not for a cancel.
    const kind =
      row.expiresAt !== null && Date.parse(row.expiresAt) <= nowMs
        ? "entitlement_expire"
        : "entitlement_revoke";
    if (typeof railsUserId === "string" && orphanRailsUserIds.has(railsUserId)) {
      orphanRowsRevoked++;
    }
    ops.push({ kind, key: opKey(kind, row.id), entitlementId: row.id });
  }

  const sorted = ops.toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    ops: sorted,
    identities,
    expected,
    revokeHeldForIdentity,
    membershipRevokeHeldForIdentity,
    membershipFlagHeldForNativeOrganization,
    heldSeatFlags,
    unusedSeatFlagOverrides: [...rulings.keys()].filter(
      (id) => !heldSeatFlags.some((held) => held.membershipId === id),
    ),
    activeOwnedEntitlements,
    activeRailsSeatFlags,
    liveBackingGrants: backing.live,
    backingWithoutPro: backing.withoutPro,
    barePro,
    projectedExport,
    heldLegacySubscriptions: heldLegacy,
    staleLegacyAll: backing.held,
    revokeHeldForStaleLegacy,
    revokeHeldForHeldUser,
    membershipRevokeHeldForHeldUser,
    orphanRowsRevoked,
    heldEntitlementIds,
    heldMembershipIds,
    heldForMemberEntitlementIds,
  };
}

/** Identity ops: the identity pass applies only these, then the full plan re-runs. */
export const IDENTITY_OP_KINDS: ReadonlySet<DeltaOpKind> = new Set([
  "user_email_update",
  "user_link",
]);

// ---------------------------------------------------------------------------
// Simulated apply (same semantics as the store's SQL)

/** Upserts clear the delta's own revoke markers (the store uses JSON_REMOVE). */
function withoutKeys(record: JsonRecord, keys: readonly string[]): JsonRecord {
  const result: JsonRecord = { ...record };
  for (const key of keys) delete result[key];
  return result;
}

function mergePatch(stored: JsonRecord, patch: JsonRecord): JsonRecord {
  const result: JsonRecord = { ...stored };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = value;
  }
  return result;
}

export function simulateApply(
  snapshot: CbSnapshot,
  ops: readonly DeltaOp[],
  nowIso: string,
): CbSnapshot {
  const users = new Map(snapshot.users.map((row) => [row.id, row]));
  const organizationIds = new Set(snapshot.organizationIds);
  const memberships = new Map(snapshot.memberships.map((row) => [row.id, row]));
  const entitlements = new Map(snapshot.entitlements.map((row) => [row.id, row]));

  for (const op of ops) {
    switch (op.kind) {
      case "user_create":
        if (!users.has(op.user.id)) {
          users.set(op.user.id, {
            id: op.user.id,
            email: op.user.email,
            legacyRailsUserId: op.railsUserId,
            matchedExportEmails: [],
          });
        }
        break;
      case "user_link": {
        const user = users.get(op.userId);
        if (user && user.legacyRailsUserId === null) {
          users.set(op.userId, { ...user, legacyRailsUserId: op.railsUserId });
        }
        break;
      }
      case "user_email_update": {
        const user = users.get(op.userId);
        if (user) {
          // A fresh read pairs the new email with its export email, and the
          // old email (now free) with nobody.
          users.set(op.userId, { ...user, email: op.email, matchedExportEmails: [op.email] });
        }
        break;
      }
      case "organization_create":
        organizationIds.add(op.organization.id);
        break;
      case "membership_create":
      case "membership_update": {
        const existing = memberships.get(op.membership.id);
        memberships.set(op.membership.id, {
          id: op.membership.id,
          organizationId: op.membership.organizationId,
          userId: op.membership.userId,
          role: op.membership.role,
          fields: withoutKeys(mergePatch(existing?.fields ?? {}, op.membership.fields), [
            "memberRoleClearedBy",
          ]),
        });
        break;
      }
      case "membership_revoke": {
        const existing = memberships.get(op.membershipId);
        if (existing) {
          memberships.set(op.membershipId, {
            ...existing,
            fields: { ...existing.fields, hasAccountMemberRole: false },
          });
        }
        break;
      }
      case "entitlement_grant":
      case "entitlement_extend":
      case "entitlement_update": {
        const existing = entitlements.get(op.entitlement.id);
        const row = op.entitlement;
        entitlements.set(row.id, {
          id: row.id,
          entitlementType: row.entitlementType,
          userId: row.userId,
          organizationId: row.organizationId,
          organizationMembershipId: row.organizationMembershipId,
          sourceType: row.sourceType,
          sourceId: row.sourceId,
          metadata: withoutKeys(mergePatch(existing?.metadata ?? {}, row.metadata), [
            "revokedBy",
            "revokedReason",
          ]),
          expiresAt: row.expiresAt,
          deletedAt: null,
        });
        break;
      }
      case "entitlement_revoke":
      case "entitlement_expire": {
        const existing = entitlements.get(op.entitlementId);
        if (
          existing &&
          existing.deletedAt === null &&
          DELTA_OWNED_SOURCE_TYPES.has(existing.sourceType)
        ) {
          entitlements.set(op.entitlementId, { ...existing, deletedAt: nowIso });
        }
        break;
      }
    }
  }

  return {
    users: [...users.values()],
    exportEmailKeys: snapshot.exportEmailKeys,
    organizationIds: [...organizationIds],
    memberships: [...memberships.values()],
    entitlements: [...entitlements.values()],
  };
}
