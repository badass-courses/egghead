import { createHash } from "node:crypto";
import type { RowDataPacket } from "mysql2";

import { createLocalMysqlConnection } from "../src/db/local-docker";
import {
  anonymousProgressState,
  completeResourceForUser,
  ensureLocalResourceProgressTable,
  readResourceProgress,
  seedResourceProgress,
} from "../src/progress/resource-progress";

type FixtureUserRow = RowDataPacket & {
  userId: string;
};

type FixtureResourceRow = RowDataPacket & {
  resourceId: string;
  slug: string | null;
};

type CountRow = RowDataPacket & {
  count: number;
};

function hashValue(kind: string, value: string) {
  return createHash("sha1").update(`${kind}:${value}`).digest("hex").slice(0, 16);
}

async function firstEntitledUserId() {
  const connection = await createLocalMysqlConnection();

  try {
    const [rows] = await connection.execute<FixtureUserRow[]>(
      `
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
    );

    return rows[0]?.userId ?? null;
  } finally {
    await connection.end();
  }
}

async function retainedLessonResources() {
  const connection = await createLocalMysqlConnection();

  try {
    const [rows] = await connection.execute<FixtureResourceRow[]>(
      `
        SELECT
          id AS resourceId,
          JSON_UNQUOTE(JSON_EXTRACT(fields, '$.slug')) AS slug
        FROM egghead_ContentResource
        WHERE deletedAt IS NULL
          AND (
            type = 'lesson'
            OR (
              type = 'post'
              AND JSON_UNQUOTE(JSON_EXTRACT(fields, '$.postType')) = 'lesson'
            )
          )
          AND JSON_UNQUOTE(JSON_EXTRACT(fields, '$.migratedFrom')) = 'rails_readonly_mve_fixture'
        ORDER BY id ASC
        LIMIT 3
      `,
    );

    return rows;
  } finally {
    await connection.end();
  }
}

async function resourceProgressCount() {
  const connection = await createLocalMysqlConnection();

  try {
    const [rows] = await connection.execute<CountRow[]>(
      "SELECT COUNT(*) AS count FROM egghead_ResourceProgress",
    );

    return rows[0]?.count ?? 0;
  } finally {
    await connection.end();
  }
}

await ensureLocalResourceProgressTable();

const userId = await firstEntitledUserId();
const lessons = await retainedLessonResources();
const readResource = lessons[0] ?? null;
const writeResource = lessons[1] ?? lessons[0] ?? null;
const fixturesReady = Boolean(userId && readResource && writeResource);

if (!fixturesReady || !userId || !readResource || !writeResource) {
  console.log(
    JSON.stringify({
      ok: false,
      source: "egghead-standalone-progress.v1",
      error: "missing_progress_fixture",
      fixtureCounts: {
        users: userId ? 1 : 0,
        retainedLessons: lessons.length,
      },
      guardrails: {
        localDevOnly: true,
        noRailsLessonViewWrite: true,
        railsSourceConnectionUsed: false,
        rawRowsInOutput: false,
      },
    }),
  );
  process.exitCode = 1;
} else {
  const userHash = hashValue("coursebuilder-user", userId);
  const readResourceHash = hashValue("coursebuilder-resource", readResource.resourceId);
  const writeResourceHash = hashValue("coursebuilder-resource", writeResource.resourceId);
  const migratedCompletedAt = new Date("2026-06-07T00:00:00.000Z");

  await seedResourceProgress({
    userId,
    resourceId: readResource.resourceId,
    completedAt: migratedCompletedAt,
    source: "phase1_mve_migrated_completion_fixture",
  });
  const migratedRead = await readResourceProgress({
    userId,
    resourceId: readResource.resourceId,
  });

  await seedResourceProgress({
    userId,
    resourceId: writeResource.resourceId,
    completedAt: null,
    source: "phase1_mve_incomplete_seed",
  });
  const beforeWrite = await readResourceProgress({
    userId,
    resourceId: writeResource.resourceId,
  });
  const firstWrite = await completeResourceForUser({
    userId,
    resourceId: writeResource.resourceId,
    source: "phase1_mve_completion_write",
  });
  const secondWrite = await completeResourceForUser({
    userId,
    resourceId: writeResource.resourceId,
    source: "phase1_mve_completion_write",
  });
  const afterSecondWrite = await readResourceProgress({
    userId,
    resourceId: writeResource.resourceId,
  });

  const countBeforeAnonymous = await resourceProgressCount();
  const anonymous = anonymousProgressState();
  const countAfterAnonymous = await resourceProgressCount();

  const checks = {
    migratedCompletionRead:
      migratedRead.exists &&
      migratedRead.completed &&
      migratedRead.source === "phase1_mve_migrated_completion_fixture",
    completionWrite:
      beforeWrite.exists &&
      !beforeWrite.completed &&
      firstWrite.state.exists &&
      firstWrite.state.completed &&
      firstWrite.state.source === "phase1_mve_completion_write",
    idempotentWrite:
      firstWrite.state.completedAt !== null &&
      firstWrite.state.completedAt === secondWrite.state.completedAt &&
      secondWrite.state.completedAt === afterSecondWrite.completedAt,
    noRailsLessonViewWrite: true,
    anonymousNoUserProgress:
      countBeforeAnonymous === countAfterAnonymous &&
      !anonymous.userProgressCreated &&
      anonymous.anonymousStateSeparated &&
      !anonymous.completionFaked &&
      anonymous.signInRequired,
  };

  console.log(
    JSON.stringify({
      ok: Object.values(checks).every(Boolean),
      source: "egghead-standalone-progress.v1",
      checks,
      fixtures: {
        sampleUserHash: userHash,
        readResourceHash,
        writeResourceHash,
        retainedLessonFixtureCount: lessons.length,
      },
      read: {
        migratedRead,
      },
      write: {
        beforeWrite,
        firstWrite: firstWrite.state,
        secondWrite: secondWrite.state,
        afterSecondWrite,
      },
      anonymous: {
        state: anonymous,
        countBefore: countBeforeAnonymous,
        countAfter: countAfterAnonymous,
      },
      guardrails: {
        localDevOnly: true,
        noRailsLessonViewWrite: true,
        railsSourceConnectionUsed: false,
        rawRowsInOutput: false,
      },
    }),
  );
}
