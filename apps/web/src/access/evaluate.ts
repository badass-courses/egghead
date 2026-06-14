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
        AND JSON_UNQUOTE(JSON_EXTRACT(membership.fields, '$.hasAccountMemberRole')) = 'true'
      )
    )
  ORDER BY entitlement.entitlementType ASC, entitlement.sourceType ASC
`;

type EntitlementRow = RowDataPacket & {
  entitlementType: string;
  sourceType: string;
  status: string | null;
  sellableId: string | null;
  sellableType: string | null;
  restrictedToCountry: string | null;
};

export type AccessEvaluation = {
  granted: boolean;
  reason: string;
  entitlementTypes: string[];
  sourceTypes: string[];
  ignored: {
    quarantineEntitlements: number;
  };
};

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

export function entitlementGrantsAccess(
  row: {
    entitlementType: string;
    restrictedToCountry?: string | null;
    sellableId: string | null;
    sellableType: string | null;
  },
  input: {
    legacyRailsPlaylistId?: number | string | null;
    requestCountry?: string | null;
  },
) {
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

export async function evaluateContentAccessForUser(input: {
  userId: string;
  legacyRailsPlaylistId?: number | null;
  requestCountry?: string | null;
}): Promise<AccessEvaluation> {
  const connection = await createLocalMysqlConnection();

  try {
    const [rows] = await connection.execute<EntitlementRow[]>(ACCESS_ENTITLEMENT_ROWS_SQL, [
      input.userId,
      AUTH_SUBSCRIPTION_SOURCE_TYPE,
      input.userId,
      input.userId,
    ]);

    const quarantineEntitlements = rows.filter(
      (row) => row.entitlementType === QUARANTINE_ENTITLEMENT_TYPE,
    ).length;
    const grantRows = rows.filter((row) => entitlementGrantsAccess(row, input));
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
  } finally {
    await connection.end();
  }
}
