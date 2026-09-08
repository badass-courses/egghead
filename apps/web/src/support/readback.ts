import {
  effectiveAccessEntitlementRows,
  entitlementGrantsAccess,
  evaluateAccessEntitlementRows,
  readAccessEntitlementsForUser,
  type AccessEntitlement,
} from "../access/evaluate";

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
  grantingSourceType: string | undefined;
  quarantineVisible: boolean;
}) {
  if (input.granted) {
    const type = input.entitlementTypes[0] ?? "projected entitlement";
    const source = input.grantingSourceType ?? "projected source";
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

export function supportAccessReadbackFromRows(
  candidates: readonly AccessEntitlement[],
  input: {
    legacyRailsPlaylistId?: number | string | null;
    requestCountry?: string | null;
    now?: number;
  } = {},
): SupportAccessReadback {
  const context = { ...input, now: input.now ?? Date.now() };
  const rows = effectiveAccessEntitlementRows(candidates, context.now);
  const access = evaluateAccessEntitlementRows(rows, context);
  const grantingRow = rows.find(
    (row) =>
      row.entitlementType === access.entitlementTypes[0] && entitlementGrantsAccess(row, context),
  );
  const allSourceTypes = sortedUnique(rows.map((row) => row.sourceType));
  const membershipRoles = sortedUnique(
    rows.flatMap((row) => (row.membershipRole ? [row.membershipRole] : [])),
  );
  const teamRows = rows.filter(
    (row) =>
      (row.sourceType === "rails_account_subscription" ||
        row.sourceType === "stripe_subscription") &&
      (row.hasOrganization === 1 || row.hasMembership === 1),
  );
  const teamSeatVisible = teamRows.length > 0;
  const quarantineVisible = access.ignored.quarantineEntitlements > 0;
  const bucket = access.granted
    ? "grant"
    : quarantineVisible
      ? "legacy_pro_quarantine"
      : "no_granting_entitlement";

  return {
    access: { granted: access.granted, reason: access.reason, bucket },
    sourceFamilies: {
      entitlementTypes: access.entitlementTypes,
      grantSourceTypes: access.sourceTypes,
      allSourceTypes,
    },
    explanation: {
      summary: supportSummary({
        granted: access.granted,
        reason: access.reason,
        entitlementTypes: access.entitlementTypes,
        grantingSourceType: grantingRow?.sourceType,
        quarantineVisible,
      }),
      nextAction: nextSupportAction({
        granted: access.granted,
        quarantineVisible,
        teamSeatVisible,
      }),
      quarantineVisible,
      teamSeatVisible,
    },
    teamSeat: {
      organizationSourceVisible: teamRows.some((row) => row.hasOrganization === 1),
      membershipSourceVisible: teamRows.some((row) => row.hasMembership === 1),
      membershipRoles,
      seatDriftBucket: teamSeatVisible ? "not_observed_in_projection_fixture" : "not_team_fixture",
    },
    privacy: { redactedOutputOnly: true, rawUserIdReturned: false, privateRowsReturned: false },
  };
}

export async function readSupportAccessForUser(input: {
  userId: string;
  legacyRailsPlaylistId?: number | string | null;
  requestCountry?: string | null;
}): Promise<SupportAccessReadback> {
  return supportAccessReadbackFromRows(await readAccessEntitlementsForUser(input.userId), input);
}
