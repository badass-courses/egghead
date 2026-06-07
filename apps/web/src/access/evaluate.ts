import type { RowDataPacket } from "mysql2";

import { createLocalMysqlConnection } from "../db/local-docker";

const GRANTING_ENTITLEMENT_TYPES = new Set([
  "egghead_all_access_subscription",
  "egghead_lifetime_access",
  "egghead_staff_special_access",
  "egghead_membership_access",
  "egghead_playlist_access",
]);

const QUARANTINE_ENTITLEMENT_TYPE = "egghead_legacy_pro_quarantine";

type EntitlementRow = RowDataPacket & {
  entitlementType: string;
  sourceType: string;
  status: string | null;
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

export async function evaluateContentAccessForUser(input: {
  userId: string;
}): Promise<AccessEvaluation> {
  const connection = await createLocalMysqlConnection();

  try {
    const [rows] = await connection.execute<EntitlementRow[]>(
      `
        SELECT
          entitlement.entitlementType,
          entitlement.sourceType,
          JSON_UNQUOTE(JSON_EXTRACT(entitlement.metadata, '$.status')) AS status
        FROM egghead_Entitlement entitlement
        LEFT JOIN egghead_OrganizationMembership membership
          ON membership.organizationId = entitlement.organizationId
         AND membership.userId = ?
        WHERE entitlement.deletedAt IS NULL
          AND (entitlement.expiresAt IS NULL OR entitlement.expiresAt > CURRENT_TIMESTAMP(3))
          AND (
            entitlement.userId = ?
            OR membership.userId = ?
          )
        ORDER BY entitlement.entitlementType ASC, entitlement.sourceType ASC
      `,
      [input.userId, input.userId, input.userId],
    );

    const quarantineEntitlements = rows.filter(
      (row) => row.entitlementType === QUARANTINE_ENTITLEMENT_TYPE,
    ).length;
    const grantRows = rows.filter((row) => GRANTING_ENTITLEMENT_TYPES.has(row.entitlementType));
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
