import type { RowDataPacket } from "mysql2";

import { evaluateContentAccessForUser } from "../access/evaluate";
import { createLocalMysqlConnection } from "../db/local-docker";

type SupportEntitlementRow = RowDataPacket & {
  entitlementType: string;
  sourceType: string;
  membershipRole: string | null;
  hasOrganization: 0 | 1;
  hasMembership: 0 | 1;
};

export type SupportAccessReadback = {
  access: {
    granted: boolean;
    reason: string;
    bucket: "grant" | "legacy_pro_quarantine" | "no_granting_entitlement";
  };
  sourceFamilies: {
    entitlementTypes: string[];
    grantSourceTypes: string[];
    allSourceTypes: string[];
  };
  explanation: {
    summary: string;
    nextAction: string;
    quarantineVisible: boolean;
    teamSeatVisible: boolean;
  };
  teamSeat: {
    organizationSourceVisible: boolean;
    membershipSourceVisible: boolean;
    membershipRoles: string[];
    seatDriftBucket: "not_team_fixture" | "not_observed_in_projection_fixture";
  };
  privacy: {
    redactedOutputOnly: true;
    rawUserIdReturned: false;
    privateRowsReturned: false;
  };
};

function sortedUnique(values: Iterable<string>) {
  const result: string[] = [];

  for (const value of new Set([...values].filter(Boolean))) {
    const insertionIndex = result.findIndex((existing) => existing.localeCompare(value) > 0);

    if (insertionIndex === -1) {
      result.push(value);
    } else {
      result.splice(insertionIndex, 0, value);
    }
  }

  return result;
}

function supportSummary(input: {
  granted: boolean;
  reason: string;
  entitlementTypes: string[];
  allSourceTypes: string[];
  quarantineVisible: boolean;
}) {
  if (input.granted) {
    const type = input.entitlementTypes[0] ?? "projected entitlement";
    const source = input.allSourceTypes[0] ?? "projected source";
    return `Access granted by ${type} from ${source}.`;
  }

  if (input.quarantineVisible) {
    return "Access denied: legacy pro marker is quarantined and does not grant broad access by default.";
  }

  return `Access denied: ${input.reason}.`;
}

function nextSupportAction(input: {
  granted: boolean;
  quarantineVisible: boolean;
  teamSeatVisible: boolean;
}) {
  if (input.granted && input.teamSeatVisible) {
    return "verify projected organization membership and keep access active";
  }

  if (input.granted) {
    return "confirm projected entitlement source and keep access active";
  }

  if (input.quarantineVisible) {
    return "review legacy pro quarantine for allowlist, reactivation, or cold archive";
  }

  return "check for missing entitlement source before routing to cold archive";
}

export async function readSupportAccessForUser(input: {
  userId: string;
}): Promise<SupportAccessReadback> {
  const connection = await createLocalMysqlConnection();

  try {
    const access = await evaluateContentAccessForUser({ userId: input.userId });
    const [rows] = await connection.execute<SupportEntitlementRow[]>(
      `
        SELECT
          entitlement.entitlementType,
          entitlement.sourceType,
          membership.role AS membershipRole,
          entitlement.organizationId IS NOT NULL AS hasOrganization,
          entitlement.organizationMembershipId IS NOT NULL AS hasMembership
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

    const allSourceTypes = sortedUnique(rows.map((row) => row.sourceType));
    const membershipRoles = sortedUnique(
      rows.flatMap((row) => (row.membershipRole ? [row.membershipRole] : [])),
    );
    const teamSeatVisible = rows.some(
      (row) =>
        row.sourceType === "rails_account_subscription" &&
        (row.hasOrganization === 1 || row.hasMembership === 1 || row.membershipRole !== null),
    );
    const quarantineVisible = access.ignored.quarantineEntitlements > 0;
    const bucket = access.granted
      ? "grant"
      : quarantineVisible
        ? "legacy_pro_quarantine"
        : "no_granting_entitlement";
    const summary = supportSummary({
      granted: access.granted,
      reason: access.reason,
      entitlementTypes: access.entitlementTypes,
      allSourceTypes,
      quarantineVisible,
    });

    return {
      access: {
        granted: access.granted,
        reason: access.reason,
        bucket,
      },
      sourceFamilies: {
        entitlementTypes: access.entitlementTypes,
        grantSourceTypes: access.sourceTypes,
        allSourceTypes,
      },
      explanation: {
        summary,
        nextAction: nextSupportAction({
          granted: access.granted,
          quarantineVisible,
          teamSeatVisible,
        }),
        quarantineVisible,
        teamSeatVisible,
      },
      teamSeat: {
        organizationSourceVisible: teamSeatVisible,
        membershipSourceVisible: teamSeatVisible,
        membershipRoles,
        seatDriftBucket: teamSeatVisible
          ? "not_observed_in_projection_fixture"
          : "not_team_fixture",
      },
      privacy: {
        redactedOutputOnly: true,
        rawUserIdReturned: false,
        privateRowsReturned: false,
      },
    };
  } finally {
    await connection.end();
  }
}
