import { createHash } from "node:crypto";
import type { RowDataPacket } from "mysql2";

import { evaluateContentAccessForUser } from "../src/access/evaluate";
import { createLocalMysqlConnection } from "../src/db/local-docker";

type FixtureUserRow = RowDataPacket & {
  userId: string;
};

function hashUserId(userId: string) {
  return createHash("sha1").update(`coursebuilder-user:${userId}`).digest("hex").slice(0, 16);
}

async function main() {
  const connection = await createLocalMysqlConnection();

  try {
    const [rows] = await connection.execute<FixtureUserRow[]>(
      `
        SELECT userId
        FROM egghead_Entitlement
        WHERE deletedAt IS NULL
          AND entitlementType = 'egghead_all_access_subscription'
          AND sourceType = 'rails_account_subscription'
          AND userId IS NOT NULL
          AND (expiresAt IS NULL OR expiresAt > CURRENT_TIMESTAMP(3))
          AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.status')) = 'active'
        ORDER BY id ASC
        LIMIT 1
      `,
    );
    const fixture = rows[0];

    if (!fixture) {
      console.log(
        JSON.stringify({
          ok: false,
          source: "egghead-standalone-access-fixture.v1",
          granted: false,
          error: "no_active_all_access_subscription_fixture",
        }),
      );
      process.exitCode = 1;
      return;
    }

    const evaluation = await evaluateContentAccessForUser({ userId: fixture.userId });

    console.log(
      JSON.stringify({
        ok: evaluation.granted,
        source: "egghead-standalone-access-fixture.v1",
        fixture: {
          entitlementType: "egghead_all_access_subscription",
          sourceType: "rails_account_subscription",
          sampleUserHash: hashUserId(fixture.userId),
        },
        evaluator: evaluation,
        guardrails: {
          localDevOnly: true,
          rawCustomerRowsInOutput: false,
          bareLegacyProBroadAccess: false,
        },
      }),
    );
  } finally {
    await connection.end();
  }
}

await main();
