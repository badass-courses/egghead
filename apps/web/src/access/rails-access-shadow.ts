// Shadow compare: "Rails says X, CourseBuilder says Y" for every user in scope.
//
// Rails side: the export under ADR-0008 strict paid-through, scoped
// account_member seats and viewable non-bulk purchases.
// CourseBuilder side: the snapshot under the runtime predicate in
// `access/evaluate.ts` (ACCESS_ENTITLEMENT_ROWS_SQL + entitlementGrantsAccess).
// Grants compare as keys: `all_access` or `sellable:<type>:<id>`.

import {
  DELTA_OWNED_SOURCE_TYPES,
  subscriptionPaidThrough,
  type CbEntitlement,
  type CbMembership,
  type CbSnapshot,
  type IdentityOutcome,
  type RailsAccessExport,
} from "./rails-access-delta";

const ALL_ACCESS = "all_access";
const BROAD_GRANTING_TYPES: ReadonlySet<string> = new Set([
  "egghead_all_access_subscription",
  "egghead_lifetime_access",
  "egghead_staff_special_access",
  "egghead_membership_access",
  "egghead_basic_legacy_access",
]);
const PLAYLIST_TYPE = "egghead_playlist_access";

type GrantMap = Map<string, string[]>;

function addGrant(map: GrantMap, key: string, why: string) {
  const list = map.get(key);
  if (list) list.push(why);
  else map.set(key, [why]);
}

/** An all-access grant the plan adds outside the export's own lines (bare-active `pro`). */
export interface ExtraRailsGrant {
  readonly railsUserId: string;
  readonly why: string;
}

/** Rails grant keys per Rails user id. */
export function railsGrantsByUser(
  railsExport: RailsAccessExport,
  extra: readonly ExtraRailsGrant[] = [],
  nowMs: number = Date.parse(railsExport.manifest.exportedAt),
): Map<string, GrantMap> {
  const result = new Map<string, GrantMap>();
  const grants = (railsUserId: string) => {
    let map = result.get(railsUserId);
    if (!map) {
      map = new Map();
      result.set(railsUserId, map);
    }
    return map;
  };

  for (const grant of railsExport.roleGrants) {
    addGrant(grants(grant.railsUserId), ALL_ACCESS, `role ${grant.roleName}`);
  }
  for (const grant of railsExport.basicGrants) {
    addGrant(grants(grant.railsUserId), ALL_ACCESS, "role basic");
  }
  for (const sub of railsExport.subscriptions) {
    if (!sub.railsAccountId || !subscriptionPaidThrough(sub, nowMs)) continue;
    for (const member of sub.members) {
      if (!member.hasMemberRole) continue;
      addGrant(
        grants(member.railsUserId),
        ALL_ACCESS,
        `account subscription ${sub.railsAccountSubscriptionId} (${sub.status})`,
      );
    }
  }
  for (const grant of railsExport.backingGrants) {
    addGrant(
      grants(grant.railsUserId),
      ALL_ACCESS,
      `backed pro: ${grant.source.replace("_", " ")} ${grant.railsSourceId}`,
    );
  }
  for (const grant of extra) addGrant(grants(grant.railsUserId), ALL_ACCESS, grant.why);
  for (const purchase of railsExport.purchases) {
    if (!purchase.sellableType || !purchase.sellableId) continue;
    if (purchase.sellableType === "Resource::Membership") {
      addGrant(
        grants(purchase.railsUserId),
        ALL_ACCESS,
        `membership purchase ${purchase.railsSellablePurchaseId}`,
      );
      continue;
    }
    if (purchase.bulk) continue;
    const country = purchase.restrictedToCountry?.trim();
    addGrant(
      grants(purchase.railsUserId),
      `sellable:${purchase.sellableType}:${purchase.sellableId}`,
      `purchase ${purchase.railsSellablePurchaseId}${country ? ` (country ${country})` : ""}`,
    );
  }

  return result;
}

interface SnapshotIndex {
  readonly byUser: Map<string, CbEntitlement[]>;
  readonly byOrganization: Map<string, CbEntitlement[]>;
  readonly grantingMemberships: Map<string, CbMembership[]>;
  readonly grantingMembersByOrganization: Map<string, string[]>;
}

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Mirrors ACCESS_ENTITLEMENT_ROWS_SQL's validity predicate. */
function rowIsLive(row: CbEntitlement, nowMs: number) {
  if (row.deletedAt !== null) return false;
  if (row.expiresAt === null) return true;
  return Date.parse(row.expiresAt) > nowMs;
}

function grantsThroughMembership(membership: CbMembership) {
  const flag = membership.fields["hasAccountMemberRole"];
  return flag === true || flag === "true";
}

function indexSnapshot(snapshot: CbSnapshot, nowMs: number): SnapshotIndex {
  const byUser = new Map<string, CbEntitlement[]>();
  const byOrganization = new Map<string, CbEntitlement[]>();
  for (const row of snapshot.entitlements) {
    if (!rowIsLive(row, nowMs)) continue;
    if (row.userId) push(byUser, row.userId, row);
    if (row.organizationId) push(byOrganization, row.organizationId, row);
  }
  const grantingMemberships = new Map<string, CbMembership[]>();
  const grantingMembersByOrganization = new Map<string, string[]>();
  for (const membership of snapshot.memberships) {
    if (!membership.organizationId || !grantsThroughMembership(membership)) continue;
    push(grantingMemberships, membership.userId, membership);
    push(grantingMembersByOrganization, membership.organizationId, membership.userId);
  }
  return { byUser, byOrganization, grantingMemberships, grantingMembersByOrganization };
}

function cbGrantKey(row: CbEntitlement): string | null {
  if (BROAD_GRANTING_TYPES.has(row.entitlementType)) return ALL_ACCESS;
  if (row.entitlementType !== PLAYLIST_TYPE) return null;
  const sellableType = row.metadata["sellableType"];
  const sellableId = row.metadata["sellableId"];
  if (typeof sellableType !== "string") return null;
  if (typeof sellableId !== "string" && typeof sellableId !== "number") return null;
  return `sellable:${sellableType}:${sellableId}`;
}

/** One owned row behind a grant key: held directly (`membershipId` null) or through a seat. */
export interface OwnedGrantPath {
  readonly key: string;
  readonly entitlementId: string;
  readonly membershipId: string | null;
}

interface CbGrant {
  readonly why: string[];
  railsOwned: boolean;
  readonly ownedPaths: OwnedGrantPath[];
}

function cbGrantsForUser(index: SnapshotIndex, userId: string): Map<string, CbGrant> {
  const reached: { row: CbEntitlement; membershipId: string | null }[] = [];
  const seen = new Set<string>();
  const reach = (row: CbEntitlement, membershipId: string | null) => {
    const id = `${row.id}|${membershipId ?? ""}`;
    if (seen.has(id)) return;
    seen.add(id);
    reached.push({ row, membershipId });
  };
  for (const row of index.byUser.get(userId) ?? []) reach(row, null);
  for (const membership of index.grantingMemberships.get(userId) ?? []) {
    if (!membership.organizationId) continue;
    for (const row of index.byOrganization.get(membership.organizationId) ?? [])
      reach(row, membership.id);
  }

  const grants = new Map<string, CbGrant>();
  const whyAdded = new Set<string>();
  for (const { row, membershipId } of reached) {
    const key = cbGrantKey(row);
    if (!key) continue;
    const owned = DELTA_OWNED_SOURCE_TYPES.has(row.sourceType);
    let grant = grants.get(key);
    if (!grant) {
      grant = { why: [], railsOwned: false, ownedPaths: [] };
      grants.set(key, grant);
    }
    if (!whyAdded.has(`${key}|${row.id}`)) {
      whyAdded.add(`${key}|${row.id}`);
      grant.why.push(`${row.entitlementType} via ${row.sourceType} ${row.sourceId}`);
    }
    grant.railsOwned ||= owned;
    if (owned) grant.ownedPaths.push({ key, entitlementId: row.id, membershipId });
  }
  return grants;
}

export interface UserShadow {
  readonly cbUserId: string | null;
  readonly railsUserIds: readonly string[];
  readonly identity: string;
  readonly railsSays: Record<string, readonly string[]>;
  readonly cbSays: Record<string, readonly string[]>;
  readonly underGrant: readonly string[];
  readonly overGrant: readonly string[];
  /** Every owned row (and the seat it came through) behind each over-grant key. */
  readonly overGrantPaths: readonly OwnedGrantPath[];
  readonly cbNativeOnly: readonly string[];
}

export interface ShadowSummary {
  readonly usersCompared: number;
  readonly railsGrantUsers: number;
  readonly underGrantUsers: number;
  readonly overGrantUsers: number;
  readonly missingIdentityUsers: number;
  readonly missingIdentityByReason: Record<string, number>;
  readonly cbNativeOnlyUsers: number;
  readonly matchedUsers: number;
}

export interface ShadowResult {
  readonly summary: ShadowSummary;
  readonly users: readonly UserShadow[];
}

function toRecord(map: Map<string, readonly string[]>) {
  const record: Record<string, readonly string[]> = {};
  for (const key of [...map.keys()].toSorted()) {
    const value = map.get(key);
    if (value) record[key] = value;
  }
  return record;
}

export function compareShadow(
  railsExport: RailsAccessExport,
  snapshot: CbSnapshot,
  identities: ReadonlyMap<string, IdentityOutcome>,
  nowMs: number,
  extra: readonly ExtraRailsGrant[] = [],
): ShadowResult {
  const railsGrants = railsGrantsByUser(railsExport, extra, nowMs);
  const index = indexSnapshot(snapshot, nowMs);
  const railsByCbUser = new Map<string, string[]>();
  const users: UserShadow[] = [];
  const missingIdentityByReason: Record<string, number> = {};

  const orphans = new Set(railsExport.orphanRailsUserIds);
  for (const [railsUserId, grants] of railsGrants) {
    if (grants.size === 0) continue;
    // No Rails user line: nobody to grant. Held and reported by the plan.
    if (orphans.has(railsUserId)) continue;
    const outcome = identities.get(railsUserId);
    if (!outcome || outcome.kind === "unresolved") {
      const reason = outcome?.kind === "unresolved" ? outcome.reason : "no_user_line";
      missingIdentityByReason[reason] = (missingIdentityByReason[reason] ?? 0) + 1;
      users.push({
        cbUserId: null,
        railsUserIds: [railsUserId],
        identity: `unresolved:${reason}`,
        railsSays: toRecord(grants),
        cbSays: {},
        underGrant: [...grants.keys()].toSorted(),
        overGrant: [],
        overGrantPaths: [],
        cbNativeOnly: [],
      });
      continue;
    }
    push(railsByCbUser, outcome.userId, railsUserId);
  }

  const cbUsersInScope = new Set(railsByCbUser.keys());
  for (const [userId, rows] of index.byUser) {
    if (rows.some((row) => DELTA_OWNED_SOURCE_TYPES.has(row.sourceType) && cbGrantKey(row))) {
      cbUsersInScope.add(userId);
    }
  }
  for (const [organizationId, rows] of index.byOrganization) {
    if (!rows.some((row) => DELTA_OWNED_SOURCE_TYPES.has(row.sourceType) && cbGrantKey(row)))
      continue;
    for (const userId of index.grantingMembersByOrganization.get(organizationId) ?? []) {
      cbUsersInScope.add(userId);
    }
  }

  const identityLabel = (railsUserIds: readonly string[]) =>
    railsUserIds.map((id) => identities.get(id)?.kind ?? "none").join(",") || "cb_only";

  for (const cbUserId of [...cbUsersInScope].toSorted()) {
    const railsUserIds = railsByCbUser.get(cbUserId) ?? [];
    const expected = new Map<string, string[]>();
    for (const railsUserId of railsUserIds) {
      for (const [key, why] of railsGrants.get(railsUserId) ?? []) {
        for (const reason of why) addGrant(expected, key, reason);
      }
    }
    const actual = cbGrantsForUser(index, cbUserId);
    const underGrant = [...expected.keys()].filter((key) => !actual.has(key)).toSorted();
    const overGrant = [...actual]
      .filter(([key, grant]) => grant.railsOwned && !expected.has(key))
      .map(([key]) => key)
      .toSorted();
    const cbNativeOnly = [...actual]
      .filter(([key, grant]) => !grant.railsOwned && !expected.has(key))
      .map(([key]) => key)
      .toSorted();
    users.push({
      cbUserId,
      railsUserIds,
      identity: identityLabel(railsUserIds),
      railsSays: toRecord(expected),
      cbSays: toRecord(new Map([...actual].map(([key, grant]) => [key, grant.why]))),
      underGrant,
      overGrant,
      overGrantPaths: overGrant.flatMap((key) => actual.get(key)?.ownedPaths ?? []),
      cbNativeOnly,
    });
  }

  const summary: ShadowSummary = {
    usersCompared: users.length,
    railsGrantUsers: [...railsGrants.values()].filter((grants) => grants.size > 0).length,
    underGrantUsers: users.filter((user) => user.underGrant.length > 0).length,
    overGrantUsers: users.filter((user) => user.overGrant.length > 0).length,
    missingIdentityUsers: users.filter((user) => user.cbUserId === null).length,
    missingIdentityByReason,
    cbNativeOnlyUsers: users.filter((user) => user.cbNativeOnly.length > 0).length,
    matchedUsers: users.filter(
      (user) => user.underGrant.length === 0 && user.overGrant.length === 0,
    ).length,
  };

  return { summary, users };
}

/** Find one user's shadow by Rails user id, CourseBuilder user id, or email. */
export function findUserShadow(
  shadow: ShadowResult,
  query: string,
  context: {
    readonly cbUserIdByEmailKey: ReadonlyMap<string, string>;
    readonly railsUserIdByEmailKey: ReadonlyMap<string, string>;
  },
  emailKey: (value: string) => string,
): UserShadow | null {
  const trimmed = query.trim();
  const byCb = (id: string) => shadow.users.find((user) => user.cbUserId === id) ?? null;
  const byRails = (id: string) =>
    shadow.users.find((user) => user.railsUserIds.includes(id)) ?? null;
  if (trimmed.includes("@")) {
    const key = emailKey(trimmed);
    const railsUserId = context.railsUserIdByEmailKey.get(key);
    const cbUserId = context.cbUserIdByEmailKey.get(key);
    return (railsUserId ? byRails(railsUserId) : null) ?? (cbUserId ? byCb(cbUserId) : null);
  }
  return byRails(trimmed) ?? byCb(trimmed);
}
