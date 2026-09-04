import type { RowDataPacket } from "mysql2";

import { createLocalMysqlConnection } from "../db/local-docker";

const BROAD_GRANTING_ENTITLEMENT_TYPES = new Set([
  "egghead_all_access_subscription",
  "egghead_lifetime_access",
  "egghead_staff_special_access",
  "egghead_membership_access",
  "egghead_basic_legacy_access",
]);

const PLAYLIST_ENTITLEMENT_TYPE = "egghead_playlist_access";
const QUARANTINE_ENTITLEMENT_TYPE = "egghead_legacy_pro_quarantine";
const AUTH_SUBSCRIPTION_SOURCE_TYPE = "rails_account_subscription";

export const ACCESS_ENTITLEMENT_ROWS_SQL = `
  SELECT
    entitlement.entitlementType,
    entitlement.sourceType,
    entitlement.deletedAt,
    entitlement.expiresAt,
    entitlement.userId = ? AS isDirectGrant,
    membership.role AS membershipRole,
    entitlement.organizationId IS NOT NULL AS hasOrganization,
    entitlement.organizationMembershipId IS NOT NULL AS hasMembership,
    JSON_UNQUOTE(JSON_EXTRACT(entitlement.metadata, '$.status')) AS status,
    JSON_UNQUOTE(JSON_EXTRACT(entitlement.metadata, '$.sellableId')) AS sellableId,
    JSON_UNQUOTE(JSON_EXTRACT(entitlement.metadata, '$.sellableType')) AS sellableType,
    JSON_UNQUOTE(JSON_EXTRACT(entitlement.metadata, '$.restrictedToCountry')) AS restrictedToCountry
  FROM egghead_Entitlement entitlement
  LEFT JOIN egghead_OrganizationMembership membership
    ON membership.organizationId = entitlement.organizationId
   AND membership.userId = ?
  WHERE entitlement.deletedAt IS NULL
    AND (
      entitlement.sourceType = ?
      OR entitlement.expiresAt IS NULL
      OR entitlement.expiresAt > CURRENT_TIMESTAMP(3)
    )
    AND (
      entitlement.userId = ?
      OR (
        membership.userId = ?
        AND entitlement.sourceType <> 'stripe_subscription'
        AND JSON_UNQUOTE(JSON_EXTRACT(membership.fields, '$.hasAccountMemberRole')) = 'true'
      )
    )
  ORDER BY entitlement.entitlementType ASC, entitlement.sourceType ASC
`;

export type AccessEntitlement = {
  entitlementType: string;
  sourceType: string;
  status: string | null;
  sellableId: string | null;
  sellableType: string | null;
  restrictedToCountry: string | null;
  deletedAt?: Date | string | null;
  expiresAt?: Date | string | null;
  isDirectGrant?: 0 | 1;
  membershipRole?: string | null;
  hasOrganization?: 0 | 1;
  hasMembership?: 0 | 1;
};

export type AccessEntitlementRow = RowDataPacket & AccessEntitlement;

export type AccessEvaluation = {
  granted: boolean;
  reason: string;
  entitlementTypes: string[];
  sourceTypes: string[];
  ignored: {
    quarantineEntitlements: number;
  };
};

export async function readAccessEntitlementsForUser(
  userId: string,
): Promise<AccessEntitlementRow[]> {
  const connection = await createLocalMysqlConnection();

  try {
    const [rows] = await connection.execute<AccessEntitlementRow[]>(ACCESS_ENTITLEMENT_ROWS_SQL, [
      userId,
      userId,
      AUTH_SUBSCRIPTION_SOURCE_TYPE,
      userId,
      userId,
    ]);

    return rows;
  } finally {
    await connection.end();
  }
}

function sortedStrings(values: Iterable<string>): string[] {
  const result: string[] = [];

  for (const value of values) {
    const insertionIndex = result.findIndex((existing) => existing.localeCompare(value) > 0);
    if (insertionIndex === -1) {
      result.push(value);
    } else {
      result.splice(insertionIndex, 0, value);
    }
  }

  return result;
}

function trimTextOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return null;

  return trimmed;
}

export function normalizeRequestCountry(value: string | null | undefined): string | null {
  return trimTextOrNull(value);
}

/** Legacy account imports own their paid-through projection. Their expiresAt
 * mirror is not authoritative, but an explicit terminal cancellation is. */
export function entitlementIsEffective(
  row: {
    sourceType?: string;
    status?: string | null;
    deletedAt?: Date | string | null;
    expiresAt?: Date | string | null;
    isDirectGrant?: 0 | 1;
  },
  now = Date.now(),
) {
  if (row.deletedAt != null) return false;
  const status = trimTextOrNull(row.status)?.toLowerCase();
  if (row.sourceType === "stripe_subscription") {
    if (row.isDirectGrant === 0 || row.expiresAt == null) return false;
    if (status !== "active" && status !== "trialing" && status !== "past_due") return false;
  }
  if (status === "canceled" || status === "cancelled") return false;
  if (row.sourceType === AUTH_SUBSCRIPTION_SOURCE_TYPE) return true;
  if (row.expiresAt == null) return true;
  const expiresAt =
    row.expiresAt instanceof Date ? row.expiresAt.getTime() : Date.parse(row.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export function effectiveAccessEntitlementRows(
  rows: readonly AccessEntitlement[],
  now = Date.now(),
) {
  return rows.filter((row) => entitlementIsEffective(row, now));
}

export function entitlementGrantsAccess(
  row: {
    entitlementType: string;
    restrictedToCountry?: string | null;
    sellableId: string | null;
    sellableType: string | null;
    sourceType?: string;
    status?: string | null;
    deletedAt?: Date | string | null;
    expiresAt?: Date | string | null;
    isDirectGrant?: 0 | 1;
  },
  input: {
    legacyRailsPlaylistId?: number | string | null;
    requestCountry?: string | null;
    now?: number;
  },
) {
  if (!entitlementIsEffective(row, input.now)) return false;
  if (BROAD_GRANTING_ENTITLEMENT_TYPES.has(row.entitlementType)) return true;

  const legacyRailsPlaylistId =
    input.legacyRailsPlaylistId == null ? null : String(input.legacyRailsPlaylistId);
  if (
    row.entitlementType !== PLAYLIST_ENTITLEMENT_TYPE ||
    row.sellableType !== "Playlist" ||
    legacyRailsPlaylistId === null ||
    row.sellableId !== legacyRailsPlaylistId
  ) {
    return false;
  }

  const restrictedToCountry = trimTextOrNull(row.restrictedToCountry);
  if (restrictedToCountry === null) return true;

  return normalizeRequestCountry(input.requestCountry) === restrictedToCountry;
}

export function evaluateAccessEntitlementRows(
  rows: readonly AccessEntitlement[],
  input: {
    legacyRailsPlaylistId?: number | string | null;
    requestCountry?: string | null;
    now?: number;
  },
): AccessEvaluation {
  const effectiveRows = effectiveAccessEntitlementRows(rows, input.now);
  const quarantineEntitlements = effectiveRows.filter(
    (row) => row.entitlementType === QUARANTINE_ENTITLEMENT_TYPE,
  ).length;
  const grantRows = effectiveRows.filter((row) => entitlementGrantsAccess(row, input));
  const entitlementTypes = sortedStrings(new Set(grantRows.map((row) => row.entitlementType)));
  const sourceTypes = sortedStrings(new Set(grantRows.map((row) => row.sourceType)));
  const granted = entitlementTypes.length > 0;

  return {
    granted,
    reason: granted ? `granted:${entitlementTypes[0]}` : "denied:no_granting_entitlement",
    entitlementTypes,
    sourceTypes,
    ignored: {
      quarantineEntitlements,
    },
  };
}

export async function evaluateContentAccessForUser(input: {
  userId: string;
  legacyRailsPlaylistId?: number | null;
  requestCountry?: string | null;
}): Promise<AccessEvaluation> {
  const rows = await readAccessEntitlementsForUser(input.userId);

  return evaluateAccessEntitlementRows(rows, input);
}
