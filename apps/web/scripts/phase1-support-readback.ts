import { createHash } from "node:crypto";
import type { RowDataPacket } from "mysql2";

import { createLocalMysqlConnection } from "../src/db/local-docker";
import { readSupportAccessForUser } from "../src/support/readback";

const SYSTEM_USER_ID = "c903e890-0970-4d13-bdee-ea535aaaf69b";

type FixtureUserRow = RowDataPacket & {
  userId: string;
};

type ScenarioResult = {
  ok: boolean;
  sampleUserHash: string | null;
  readback: Awaited<ReturnType<typeof readSupportAccessForUser>> | null;
  error: string | null;
};

function hashUserId(userId: string) {
  return createHash("sha1").update(`coursebuilder-user:${userId}`).digest("hex").slice(0, 16);
}

async function firstUserId(query: string) {
  const connection = await createLocalMysqlConnection();

  try {
    const [rows] = await connection.execute<FixtureUserRow[]>(query);
    return rows[0]?.userId ?? null;
  } finally {
    await connection.end();
  }
}

async function readScenario(name: string, query: string): Promise<ScenarioResult> {
  const userId = await firstUserId(query);

  if (!userId) {
    return {
      ok: false,
      sampleUserHash: null,
      readback: null,
      error: `missing_fixture:${name}`,
    };
  }

  const readback = await readSupportAccessForUser({ userId });

  return {
    ok: true,
    sampleUserHash: hashUserId(userId),
    readback,
    error: null,
  };
}

const queries = {
  grantedAccess: `
    SELECT userId
    FROM egghead_Entitlement
    WHERE deletedAt IS NULL
      AND entitlementType IN (
        'egghead_all_access_subscription',
        'egghead_lifetime_access',
        'egghead_staff_special_access',
        'egghead_membership_access',
        'egghead_playlist_access'
      )
      AND userId IS NOT NULL
      AND (expiresAt IS NULL OR expiresAt > CURRENT_TIMESTAMP(3))
    ORDER BY entitlementType ASC, id ASC
    LIMIT 1
  `,
  deniedAccess: `
    SELECT user.id AS userId
    FROM egghead_User user
    WHERE user.id <> '${SYSTEM_USER_ID}'
      AND NOT EXISTS (
        SELECT 1
        FROM egghead_Entitlement entitlement
        WHERE entitlement.deletedAt IS NULL
          AND entitlement.userId = user.id
      )
    ORDER BY user.id ASC
    LIMIT 1
  `,
  legacyProQuarantine: `
    SELECT quarantine.userId
    FROM egghead_Entitlement quarantine
    WHERE quarantine.deletedAt IS NULL
      AND quarantine.entitlementType = 'egghead_legacy_pro_quarantine'
      AND quarantine.sourceType = 'rails_legacy_pro_role'
      AND quarantine.userId IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM egghead_Entitlement grantRow
        WHERE grantRow.deletedAt IS NULL
          AND grantRow.userId = quarantine.userId
          AND grantRow.entitlementType IN (
            'egghead_all_access_subscription',
            'egghead_lifetime_access',
            'egghead_staff_special_access',
            'egghead_membership_access',
            'egghead_playlist_access'
          )
      )
    ORDER BY quarantine.id ASC
    LIMIT 1
  `,
  teamSeat: `
    SELECT userId
    FROM egghead_Entitlement
    WHERE deletedAt IS NULL
      AND entitlementType = 'egghead_all_access_subscription'
      AND sourceType = 'rails_account_subscription'
      AND userId IS NOT NULL
      AND organizationMembershipId IS NOT NULL
      AND (expiresAt IS NULL OR expiresAt > CURRENT_TIMESTAMP(3))
      AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.status')) = 'active'
    ORDER BY id ASC
    LIMIT 1
  `,
};

const scenarios = {
  grantedAccess: await readScenario("grantedAccess", queries.grantedAccess),
  deniedAccess: await readScenario("deniedAccess", queries.deniedAccess),
  legacyProQuarantine: await readScenario("legacyProQuarantine", queries.legacyProQuarantine),
  teamSeat: await readScenario("teamSeat", queries.teamSeat),
};

const checks = {
  grantedAccess:
    scenarios.grantedAccess.ok &&
    scenarios.grantedAccess.readback?.access.granted === true &&
    scenarios.grantedAccess.readback.sourceFamilies.grantSourceTypes.length > 0 &&
    scenarios.grantedAccess.readback.explanation.summary.length > 0 &&
    scenarios.grantedAccess.readback.privacy.redactedOutputOnly,
  deniedAccess:
    scenarios.deniedAccess.ok &&
    scenarios.deniedAccess.readback?.access.granted === false &&
    scenarios.deniedAccess.readback.access.bucket === "no_granting_entitlement" &&
    scenarios.deniedAccess.readback.explanation.nextAction.length > 0,
  legacyProQuarantine:
    scenarios.legacyProQuarantine.ok &&
    scenarios.legacyProQuarantine.readback?.access.granted === false &&
    scenarios.legacyProQuarantine.readback.access.bucket === "legacy_pro_quarantine" &&
    scenarios.legacyProQuarantine.readback.explanation.quarantineVisible,
  teamSeat:
    scenarios.teamSeat.ok &&
    scenarios.teamSeat.readback?.access.granted === true &&
    scenarios.teamSeat.readback.explanation.teamSeatVisible &&
    scenarios.teamSeat.readback.teamSeat.organizationSourceVisible &&
    scenarios.teamSeat.readback.teamSeat.membershipSourceVisible &&
    scenarios.teamSeat.readback.teamSeat.seatDriftBucket.length > 0,
};

console.log(
  JSON.stringify({
    ok: Object.values(checks).every(Boolean),
    source: "egghead-standalone-support-readback.v1",
    checks,
    scenarios,
    guardrails: {
      localDevOnly: true,
      privateRowsInOutput: false,
      rawUserIdsInOutput: false,
      broadLegacyProAccess: false,
    },
  }),
);
