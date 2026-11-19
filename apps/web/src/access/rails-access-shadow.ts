// Shadow compare: "Rails says X, CourseBuilder says Y" for every user in scope.
//
// Rails side: the export under Rails law (ADR-0006 lenient status, scoped
// account_member seats, viewable non-bulk purchases).
// CourseBuilder side: the snapshot under the runtime predicate in
// `access/evaluate.ts` (ACCESS_ENTITLEMENT_ROWS_SQL + entitlementGrantsAccess).
// Grants compare as keys: `all_access` or `sellable:<type>:<id>`.

import {
  DELTA_OWNED_SOURCE_TYPES,
  type CbEntitlement,
  type CbMembership,
  type CbSnapshot,
  type IdentityOutcome,
  type RailsAccessExport,
} from "./rails-access-delta";

const ALL_ACCESS = "all_access";
const RAILS_SUBSCRIPTION_SOURCE = "rails_account_subscription";
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

/** Rails grant keys per Rails user id. */
export function railsGrantsByUser(railsExport: RailsAccessExport): Map<string, GrantMap> {
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
    if (!sub.railsAccountId) continue;
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
  if (row.sourceType === RAILS_SUBSCRIPTION_SOURCE || row.expiresAt === null) return true;
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

interface CbGrant {
  readonly why: string[];
  railsOwned: boolean;
}

function cbGrantsForUser(index: SnapshotIndex, userId: string): Map<string, CbGrant> {
  const rows = new Map<string, CbEntitlement>();
  for (const row of index.byUser.get(userId) ?? []) rows.set(row.id, row);
  for (const membership of index.grantingMemberships.get(userId) ?? []) {
    if (!membership.organizationId) continue;
    for (const row of index.byOrganization.get(membership.organizationId) ?? [])
      rows.set(row.id, row);
  }

  const grants = new Map<string, CbGrant>();
  for (const row of rows.values()) {
    const key = cbGrantKey(row);
    if (!key) continue;
    const owned = DELTA_OWNED_SOURCE_TYPES.has(row.sourceType);
    const why = `${row.entitlementType} via ${row.sourceType} ${row.sourceId}`;
    const grant = grants.get(key);
    if (grant) {
      grant.why.push(why);
      grant.railsOwned ||= owned;
    } else {
      grants.set(key, { why: [why], railsOwned: owned });
    }
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
): ShadowResult {
  const railsGrants = railsGrantsByUser(railsExport);
  const index = indexSnapshot(snapshot, nowMs);
  const railsByCbUser = new Map<string, string[]>();
  const users: UserShadow[] = [];
  const missingIdentityByReason: Record<string, number> = {};

  for (const [railsUserId, grants] of railsGrants) {
    if (grants.size === 0) continue;
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
