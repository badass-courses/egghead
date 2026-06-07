import { createHash } from "node:crypto";
import type { RowDataPacket } from "mysql2";

import { evaluateContentAccessForUser } from "../src/access/evaluate";
import { createLocalMysqlConnection } from "../src/db/local-docker";

type FixtureUserRow = RowDataPacket & {
  userId: string;
};

type ScenarioResult = {
  ok: boolean;
  sampleUserHash: string | null;
  accessGranted: boolean;
  reason: string | null;
  entitlementTypes: string[];
  sourceTypes: string[];
  ignored: {
    quarantineEntitlements: number;
  } | null;
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

async function evaluateScenario(name: string, query: string): Promise<ScenarioResult> {
  const userId = await firstUserId(query);

  if (!userId) {
    return {
      ok: false,
      sampleUserHash: null,
      accessGranted: false,
      reason: `missing_fixture:${name}`,
      entitlementTypes: [],
      sourceTypes: [],
      ignored: null,
    };
  }

  const evaluation = await evaluateContentAccessForUser({ userId });

  return {
    ok: true,
    sampleUserHash: hashUserId(userId),
    accessGranted: evaluation.granted,
    reason: evaluation.reason,
    entitlementTypes: evaluation.entitlementTypes,
    sourceTypes: evaluation.sourceTypes,
    ignored: evaluation.ignored,
  };
}

const queries = {
  activeTeamMember: `
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
  purchaseOwner: `
    SELECT purchase.userId
    FROM egghead_Entitlement purchase
    WHERE purchase.deletedAt IS NULL
      AND purchase.entitlementType = 'egghead_playlist_access'
      AND purchase.sourceType = 'rails_sellable_purchase'
      AND purchase.userId IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM egghead_Entitlement otherGrant
        WHERE otherGrant.deletedAt IS NULL
          AND otherGrant.userId = purchase.userId
          AND otherGrant.entitlementType IN (
            'egghead_all_access_subscription',
            'egghead_lifetime_access',
            'egghead_staff_special_access',
            'egghead_membership_access'
          )
      )
    ORDER BY purchase.id ASC
    LIMIT 1
  `,
  specialOrLifetime: `
    SELECT userId
    FROM egghead_Entitlement
    WHERE deletedAt IS NULL
      AND entitlementType IN ('egghead_lifetime_access', 'egghead_staff_special_access')
      AND sourceType = 'rails_user_role'
      AND userId IS NOT NULL
    ORDER BY entitlementType ASC, id ASC
    LIMIT 1
  `,
  quarantineOnly: `
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
  multipleSources: `
    SELECT userId
    FROM egghead_Entitlement
    WHERE deletedAt IS NULL
      AND userId IS NOT NULL
      AND entitlementType IN (
        'egghead_all_access_subscription',
        'egghead_lifetime_access',
        'egghead_staff_special_access',
        'egghead_membership_access',
        'egghead_playlist_access'
      )
      AND (expiresAt IS NULL OR expiresAt > CURRENT_TIMESTAMP(3))
    GROUP BY userId
    HAVING COUNT(DISTINCT entitlementType) >= 2
    ORDER BY userId ASC
    LIMIT 1
  `,
};

const scenarios = {
  activeTeamMember: await evaluateScenario("activeTeamMember", queries.activeTeamMember),
  purchaseOwner: await evaluateScenario("purchaseOwner", queries.purchaseOwner),
  specialOrLifetime: await evaluateScenario("specialOrLifetime", queries.specialOrLifetime),
  quarantineOnly: await evaluateScenario("quarantineOnly", queries.quarantineOnly),
  multipleSources: await evaluateScenario("multipleSources", queries.multipleSources),
};

console.log(
  JSON.stringify({
    ok:
      scenarios.activeTeamMember.ok &&
      scenarios.purchaseOwner.ok &&
      scenarios.specialOrLifetime.ok &&
      scenarios.quarantineOnly.ok &&
      scenarios.multipleSources.ok,
    source: "egghead-standalone-access-matrix.v1",
    scenarios,
    guardrails: {
      localDevOnly: true,
      rawCustomerRowsInOutput: false,
      bareLegacyProBroadAccess: false,
    },
  }),
);
