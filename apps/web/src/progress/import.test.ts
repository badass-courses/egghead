import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RowDataPacket } from "mysql2";
import type mysql from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  classifyProgressCandidate,
  importProgressForUser,
  PROGRESS_IMPORT_SOURCE,
  runProgressImport,
} from "./import";
import { assertProgressImportAccess, openUtcConnection } from "./import-db";
import { rollbackProgressImport } from "./import-rollback";
import {
  jsonlRailsProgressSource,
  memoryRailsProgressSource,
  type RailsProgressSource,
  type RailsUserProgress,
} from "./import-source";

/**
 * Integration tests against a real local MySQL database whose name ends in
 * `_test`, for example:
 *
 *   PROGRESS_IMPORT_TEST_DATABASE_URL=mysql://user:pass@127.0.0.1:3306/progress_import_test \
 *     pnpm progress:import:test
 *
 * The user needs CREATE on that database name; the test creates it if missing.
 *
 * Without the variable the database cases are skipped; the pure cases always
 * run. All fixture data is synthetic.
 */
const testDatabaseUrl = process.env["PROGRESS_IMPORT_TEST_DATABASE_URL"];

const RAILS_DAY = (day: number) => new Date(Date.UTC(2024, 0, day, 12, 0, 0));
const CB_NEWER = new Date(Date.UTC(2026, 5, 1, 12, 0, 0));
const CB_OLDER = new Date(Date.UTC(2020, 0, 1, 12, 0, 0));

function railsUser(
  railsUserId: number,
  email: string,
  lessons: RailsUserProgress["lessons"],
  series: RailsUserProgress["series"] = [],
): RailsUserProgress {
  return { railsUserId, email, lastActiveAt: RAILS_DAY(20), lessons, series };
}

const lesson = (railsLessonId: number, slug: string, day: number | null) => ({
  railsLessonId,
  slug,
  completedAt: day === null ? null : RAILS_DAY(day),
});

/** Matched by stored Rails id: id, duplicate row, slug, collapsed slug, unmapped, CB newer. */
const alpha = railsUser(
  101,
  "alpha@example.test",
  [
    lesson(1, "lesson-a", 1),
    lesson(2, "lesson-b", 2),
    lesson(3, "lesson-c", 3),
    lesson(4, "lesson-gone", 4),
    // A second Rails lesson landing on lesson_c by slug: collapsed, latest wins.
    lesson(7, "lesson-c", 11),
  ],
  [
    { railsPlaylistId: 50, railsSeriesId: null, slug: "course-x", completedAt: RAILS_DAY(5) },
    { railsPlaylistId: 51, railsSeriesId: null, slug: "course-gone", completedAt: RAILS_DAY(6) },
    // course-y's slug belongs to a course with a different playlist id: never a fallback.
    { railsPlaylistId: 52, railsSeriesId: null, slug: "course-y", completedAt: RAILS_DAY(6) },
  ],
);
/** Matched by email. lesson-a: explicit CB un-complete after Rails. lesson-b: before Rails. */
const beta = railsUser(102, " Beta@Example.test ", [
  lesson(1, "lesson-a", 7),
  lesson(2, "lesson-b", 8),
]);
/** The CB user with this email belongs to another Rails user. */
const gamma = railsUser(103, "gamma@example.test", [lesson(1, "lesson-a", 9)]);
/** No CB user at all. */
const nobody = railsUser(104, "nobody@example.test", [lesson(1, "lesson-a", 10)]);
/** On-demand path. */
const delta = railsUser(105, "delta@example.test", [
  lesson(2, "lesson-b", null),
  lesson(4, "lesson-gone", 12),
]);
/** Two Rails users whose emails normalize to one CB user. */
const epsilonLower = railsUser(106, "epsilon@example.test", [lesson(1, "lesson-a", 13)]);
const epsilonUpper = railsUser(107, "EPSILON@example.test ", [
  lesson(1, "lesson-a", 14),
  lesson(2, "lesson-b", 15),
]);
/** Found by cb_eta's email, but its Rails id belongs to cb_theta. */
const eta = railsUser(109, "eta@example.test", [lesson(1, "lesson-a", 16)]);

const bulkUsers = [alpha, beta, gamma, nobody];
const allUsers = [alpha, beta, gamma, nobody, delta, epsilonLower, epsilonUpper, eta];

type ProgressRow = RowDataPacket & {
  userId: string;
  resourceId: string;
  completedAt: Date | null;
  source: string | null;
};

type SnapshotRow = RowDataPacket & {
  userId: string;
  resourceId: string;
  completedAt: string | null;
  fields: string | null;
  createdAt: string;
  updatedAt: string;
};

type CountRow = RowDataPacket & { count: number | string };

function assertLocalTestDatabase(rawUrl: string) {
  const url = new URL(rawUrl);
  const database = url.pathname.replace(/^\//, "");
  const localHost = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (!localHost || !database.endsWith("_test")) {
    throw new Error(
      `PROGRESS_IMPORT_TEST_DATABASE_URL must be a local database ending in _test, got host=${url.hostname} database=${database}`,
    );
  }
  return {
    host: url.hostname,
    port: Number(url.port || "3306"),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

async function createSchema(db: mysql.Connection) {
  await db.query(
    "DROP TABLE IF EXISTS egghead_ResourceProgress, egghead_ContentResourceResource, egghead_ContentResource, egghead_User",
  );
  await db.query(`
    CREATE TABLE egghead_User (
      id varchar(255) NOT NULL PRIMARY KEY,
      name varchar(255),
      email varchar(255) NOT NULL,
      fields json DEFAULT NULL,
      legacyRailsUserId varchar(255) GENERATED ALWAYS AS (fields->>'$.legacyRailsUserId') STORED,
      UNIQUE KEY email_unique (email),
      UNIQUE KEY legacyRailsUserId_idx (legacyRailsUserId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await db.query(`
    CREATE TABLE egghead_ContentResource (
      id varchar(255) NOT NULL PRIMARY KEY,
      type varchar(255) NOT NULL,
      fields json DEFAULT NULL,
      createdAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updatedAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      deletedAt timestamp(3) NULL DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await db.query(`
    CREATE TABLE egghead_ContentResourceResource (
      resourceOfId varchar(255) NOT NULL,
      resourceId varchar(255) NOT NULL,
      position double NOT NULL DEFAULT 0,
      PRIMARY KEY (resourceOfId, resourceId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // Same DDL as ensureLocalResourceProgressTable().
  await db.query(`
    CREATE TABLE egghead_ResourceProgress (
      userId varchar(255) NOT NULL,
      resourceId varchar(255) NOT NULL,
      completedAt timestamp(3) NULL DEFAULT NULL,
      fields json DEFAULT NULL,
      createdAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updatedAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (userId, resourceId),
      KEY userId_idx (userId),
      KEY resourceId_idx (resourceId),
      KEY completedAt_idx (completedAt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function seedFixture(db: mysql.Connection) {
  await db.query("DELETE FROM egghead_ResourceProgress");
  await db.query("DELETE FROM egghead_ContentResourceResource");
  await db.query("DELETE FROM egghead_ContentResource");
  await db.query("DELETE FROM egghead_User");

  const users: Array<[string, string, Record<string, unknown>]> = [
    ["cb_alpha", "alpha@example.test", { legacyRailsUserId: "101" }],
    ["cb_beta", "beta@example.test", {}],
    ["cb_gamma", "gamma@example.test", { legacyRailsUserId: "999" }],
    ["cb_delta", "delta@example.test", { legacyRailsUserId: "105" }],
    ["cb_epsilon", "epsilon@example.test", {}],
    ["cb_eta", "eta@example.test", {}],
    ["cb_theta", "theta@example.test", { legacyRailsUserId: "109" }],
    ["cb_no_rails", "fresh@example.test", {}],
  ];
  await Promise.all(
    users.map(([id, email, fields]) =>
      db.execute("INSERT INTO egghead_User (id, email, fields) VALUES (?, ?, CAST(? AS JSON))", [
        id,
        email,
        JSON.stringify(fields),
      ]),
    ),
  );

  const resources: Array<[string, string, Record<string, unknown>]> = [
    ["course_x", "course", { slug: "course-x", legacyRailsPlaylistId: 50, state: "published" }],
    ["course_y", "course", { slug: "course-y", legacyRailsPlaylistId: 60, state: "published" }],
    ["lesson_a", "lesson", { slug: "lesson-a", eggheadLessonId: 1, state: "published" }],
    // Duplicate CB row for Rails lesson 1. Not course-linked, so not canonical.
    [
      "lesson_a_dup",
      "post",
      { slug: "lesson-a", postType: "lesson", legacySourceId: 1, state: "published" },
    ],
    ["lesson_b", "lesson", { slug: "lesson-b", legacyRailsLessonId: "2", state: "published" }],
    // No Rails id: reachable only by slug.
    ["lesson_c", "lesson", { slug: "lesson-c", state: "published" }],
  ];
  await Promise.all(
    resources.map(([id, type, fields]) =>
      db.execute(
        "INSERT INTO egghead_ContentResource (id, type, fields) VALUES (?, ?, CAST(? AS JSON))",
        [id, type, JSON.stringify(fields)],
      ),
    ),
  );
  await db.execute(
    "INSERT INTO egghead_ContentResourceResource (resourceOfId, resourceId, position) VALUES ('course_x', 'lesson_a', 0)",
  );

  const progress: Array<[string, string, Date | null, Date, Record<string, unknown>]> = [
    // Newer CB completion than Rails: must stay as is.
    [
      "cb_alpha",
      "lesson_b",
      CB_NEWER,
      CB_NEWER,
      { source: "lesson_player_ended", localOnly: true },
    ],
    // Course recount nulled it after Rails: not a learner decision, Rails wins.
    [
      "cb_alpha",
      "course_x",
      null,
      CB_NEWER,
      { source: "course_lessons_incomplete", localOnly: true },
    ],
    // Explicit un-complete after the Rails completion: CB wins.
    ["cb_beta", "lesson_a", null, CB_NEWER, { source: "lesson_progress_control", localOnly: true }],
    // Explicit un-complete before the Rails completion: Rails wins.
    ["cb_beta", "lesson_b", null, CB_OLDER, { source: "lesson_progress_control", localOnly: true }],
  ];
  await Promise.all(
    progress.map(([userId, resourceId, completedAt, updatedAt, fields]) =>
      db.execute(
        `INSERT INTO egghead_ResourceProgress (userId, resourceId, completedAt, fields, createdAt, updatedAt)
         VALUES (?, ?, ?, CAST(? AS JSON), ?, ?)`,
        [userId, resourceId, completedAt, JSON.stringify(fields), CB_OLDER, updatedAt],
      ),
    ),
  );
}

async function progressRows(db: mysql.Connection) {
  const [rows] = await db.query<ProgressRow[]>(`
    SELECT userId, resourceId, completedAt,
      JSON_UNQUOTE(JSON_EXTRACT(fields, '$.source')) AS source
    FROM egghead_ResourceProgress
    ORDER BY userId, resourceId
  `);
  return rows.map((row) => ({
    userId: row.userId,
    resourceId: row.resourceId,
    completedAt: row.completedAt?.toISOString() ?? null,
    source: row.source,
  }));
}

/** Every column, as the server renders it, for byte-for-byte comparison. */
async function snapshot(db: mysql.Connection) {
  const [rows] = await db.query<SnapshotRow[]>(`
    SELECT userId, resourceId,
      DATE_FORMAT(completedAt, '%Y-%m-%d %H:%i:%s.%f') AS completedAt,
      CAST(fields AS CHAR) AS fields,
      DATE_FORMAT(createdAt, '%Y-%m-%d %H:%i:%s.%f') AS createdAt,
      DATE_FORMAT(updatedAt, '%Y-%m-%d %H:%i:%s.%f') AS updatedAt
    FROM egghead_ResourceProgress
    ORDER BY userId, resourceId
  `);
  return rows.map((row) => ({
    userId: row.userId,
    resourceId: row.resourceId,
    completedAt: row.completedAt,
    fields: row.fields,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

async function progressCount(db: mysql.Connection) {
  const [rows] = await db.query<CountRow[]>(
    "SELECT COUNT(*) AS count FROM egghead_ResourceProgress",
  );
  return Number(rows[0]?.count ?? 0);
}

const imported = PROGRESS_IMPORT_SOURCE;
const expectedAfterBulkApply = [
  // Updated, keeps its own source.
  {
    userId: "cb_alpha",
    resourceId: "course_x",
    completedAt: RAILS_DAY(5).toISOString(),
    source: "course_lessons_incomplete",
  },
  {
    userId: "cb_alpha",
    resourceId: "lesson_a",
    completedAt: RAILS_DAY(1).toISOString(),
    source: imported,
  },
  {
    userId: "cb_alpha",
    resourceId: "lesson_b",
    completedAt: CB_NEWER.toISOString(),
    source: "lesson_player_ended",
  },
  // Two Rails lessons collapsed; the later completion wins.
  {
    userId: "cb_alpha",
    resourceId: "lesson_c",
    completedAt: RAILS_DAY(11).toISOString(),
    source: imported,
  },
  {
    userId: "cb_beta",
    resourceId: "lesson_a",
    completedAt: null,
    source: "lesson_progress_control",
  },
  {
    userId: "cb_beta",
    resourceId: "lesson_b",
    completedAt: RAILS_DAY(8).toISOString(),
    source: "lesson_progress_control",
  },
];

describe.skipIf(!testDatabaseUrl)("progress import against local MySQL", () => {
  let db: mysql.Connection;

  beforeAll(async () => {
    const options = assertLocalTestDatabase(testDatabaseUrl ?? "");
    const { database, ...serverOptions } = options;
    const admin = await openUtcConnection(serverOptions);
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${database}\``);
    await admin.end();
    db = await openUtcConnection(options);
    await createSchema(db);
  });

  afterAll(async () => {
    await db?.end();
  });

  beforeEach(async () => {
    await seedFixture(db);
  });

  it("dry run reports matches, gaps and planned rows without writing", async () => {
    const before = await snapshot(db);
    const receipt = await runProgressImport({
      db,
      source: memoryRailsProgressSource(bulkUsers),
      apply: false,
    });

    expect(await snapshot(db)).toEqual(before);
    expect(receipt.mode).toBe("dry_run");
    expect(receipt.runId).toMatch(/^rails-import-/);
    expect(receipt.users).toEqual({
      seen: 4,
      matchedByLegacyRailsUserId: 1,
      matchedByEmail: 1,
      unmatchedNoCbUser: 1,
      unmatchedEmailConflict: 1,
      matchedOtherCbUser: 0,
    });
    expect(receipt.lessons).toMatchObject({
      seen: 7,
      mappedByRailsId: 4,
      mappedBySlug: 2,
      unmapped: 1,
      distinctUnmappedRailsLessonIds: 1,
      skippedForUnmatchedUser: 2,
    });
    expect(receipt.series).toMatchObject({
      seen: 3,
      mappedByRailsPlaylistId: 1,
      mappedBySlug: 0,
      unmapped: 2,
    });
    expect(receipt.rows).toMatchObject({
      toInsert: 2,
      toUpdate: 2,
      keptCbCompleted: 1,
      keptCbNewer: 1,
      collapsedDuplicates: 1,
      inserted: 0,
      updated: 0,
    });
    expect(receipt.samples.unmatchedRailsUserIds).toEqual([104]);
    expect(receipt.samples.emailConflictRailsUserIds).toEqual([103]);
    expect(receipt.samples.unmappedLessons).toEqual([
      { railsLessonId: 4, slug: "lesson-gone", users: 1 },
    ]);
    expect(receipt.samples.unmappedSeries.map((series) => series.railsPlaylistId)).toEqual([
      51, 52,
    ]);
    expect(receipt.catalog).toMatchObject({ duplicateLessonRowsForRailsId: 1 });
    expect(JSON.stringify(receipt)).not.toContain("@example.test");
  });

  it("apply writes CB-native rows with provenance and lets explicit CB state win", async () => {
    const receipt = await runProgressImport({
      db,
      source: memoryRailsProgressSource(bulkUsers),
      apply: true,
      runId: "run-apply",
    });

    expect(receipt.rows).toMatchObject({ inserted: 2, updated: 2, raceSkipped: 0 });
    expect(await progressRows(db)).toEqual(expectedAfterBulkApply);

    const [stamps] = await db.query<
      Array<RowDataPacket & { resourceId: string; railsImport: unknown; utc: string }>
    >(`
      SELECT resourceId,
        JSON_EXTRACT(fields, '$.railsImport') AS railsImport,
        CAST(UNIX_TIMESTAMP(completedAt) AS CHAR) AS utc
      FROM egghead_ResourceProgress
      WHERE userId = 'cb_beta' AND resourceId = 'lesson_b'
    `);
    // The updated row keeps its source and records what it was before.
    expect(stamps[0]?.railsImport).toMatchObject({
      runId: "run-apply",
      action: "update",
      railsUserId: 102,
      rails: { railsLessonId: 2 },
      prior: {
        fields: { source: "lesson_progress_control", localOnly: true },
        updatedAt: "2020-01-01 12:00:00.000",
      },
    });
    // Stored in UTC whatever the client's zone.
    expect(Number(stamps[0]?.utc) * 1000).toBe(RAILS_DAY(8).getTime());
  });

  it("a second run writes nothing and duplicates nothing", async () => {
    await runProgressImport({ db, source: memoryRailsProgressSource(bulkUsers), apply: true });
    const afterFirst = await snapshot(db);

    const second = await runProgressImport({
      db,
      source: memoryRailsProgressSource(bulkUsers),
      apply: true,
    });

    expect(second.rows).toMatchObject({
      toInsert: 0,
      toUpdate: 0,
      inserted: 0,
      updated: 0,
      keptCbCompleted: 5,
      keptCbNewer: 1,
    });
    expect(await snapshot(db)).toEqual(afterFirst);
  });

  it("rollback deletes inserted rows and restores updated rows byte for byte", async () => {
    const before = await snapshot(db);
    await runProgressImport({
      db,
      source: memoryRailsProgressSource(bulkUsers),
      apply: true,
      runId: "run-rollback",
    });
    expect(await snapshot(db)).not.toEqual(before);

    const dryRun = await rollbackProgressImport({ db, runId: "run-rollback", apply: false });
    expect(dryRun).toMatchObject({
      insertedRows: 2,
      updatedRows: 2,
      changedSinceImport: 0,
      deleted: 0,
      restored: 0,
    });

    const applied = await rollbackProgressImport({ db, runId: "run-rollback", apply: true });
    expect(applied).toMatchObject({ deleted: 2, restored: 2 });
    expect(await snapshot(db)).toEqual(before);
  });

  it("rollback leaves rows CB changed after the import", async () => {
    await runProgressImport({
      db,
      source: memoryRailsProgressSource(bulkUsers),
      apply: true,
      runId: "run-touched",
    });
    // The learner un-completes an inserted row and re-completes an updated one,
    // the way uncompleteResourceForUser / completeResourceForUser write.
    await db.execute(`
      UPDATE egghead_ResourceProgress
      SET completedAt = NULL,
          fields = JSON_MERGE_PATCH(fields, JSON_OBJECT('source', 'lesson_progress_control')),
          updatedAt = DATE_ADD(updatedAt, INTERVAL 1 SECOND)
      WHERE userId = 'cb_alpha' AND resourceId = 'lesson_a'
    `);
    await db.execute(`
      UPDATE egghead_ResourceProgress
      SET fields = JSON_MERGE_PATCH(fields, JSON_OBJECT('source', 'lesson_player_ended')),
          updatedAt = DATE_ADD(updatedAt, INTERVAL 1 SECOND)
      WHERE userId = 'cb_beta' AND resourceId = 'lesson_b'
    `);
    const touched = (await snapshot(db)).filter(
      (row) =>
        (row.userId === "cb_alpha" && row.resourceId === "lesson_a") ||
        (row.userId === "cb_beta" && row.resourceId === "lesson_b"),
    );

    const applied = await rollbackProgressImport({ db, runId: "run-touched", apply: true });
    expect(applied).toMatchObject({ changedSinceImport: 2, deleted: 1, restored: 1 });

    const after = await snapshot(db);
    expect(
      after.filter(
        (row) =>
          (row.userId === "cb_alpha" && row.resourceId === "lesson_a") ||
          (row.userId === "cb_beta" && row.resourceId === "lesson_b"),
      ),
    ).toEqual(touched);
    expect(after.some((row) => row.resourceId === "lesson_c")).toBe(false);
  });

  it("resumes from the cursor after a crash between batches", async () => {
    const cursors: number[] = [];
    await expect(
      runProgressImport({
        db,
        source: memoryRailsProgressSource(bulkUsers),
        apply: true,
        batchSize: 1,
        onBatchCommitted: ({ lastRailsUserId }) => {
          cursors.push(lastRailsUserId);
          if (cursors.length === 1) throw new Error("simulated crash after first batch");
        },
      }),
    ).rejects.toThrow("simulated crash");

    expect(cursors).toEqual([101]);
    // Only the first user's batch committed.
    expect((await progressRows(db)).filter((row) => row.userId === "cb_beta")).toEqual([
      {
        userId: "cb_beta",
        resourceId: "lesson_a",
        completedAt: null,
        source: "lesson_progress_control",
      },
      {
        userId: "cb_beta",
        resourceId: "lesson_b",
        completedAt: null,
        source: "lesson_progress_control",
      },
    ]);

    const resumed = await runProgressImport({
      db,
      source: memoryRailsProgressSource(bulkUsers),
      apply: true,
      batchSize: 1,
      afterRailsUserId: 101,
      onBatchCommitted: ({ lastRailsUserId }) => {
        cursors.push(lastRailsUserId);
      },
    });

    expect(resumed.users.seen).toBe(3);
    expect(cursors).toEqual([101, 102, 103, 104]);
    expect(await progressRows(db)).toEqual(expectedAfterBulkApply);
    expect(await progressCount(db)).toBe(expectedAfterBulkApply.length);
  });

  it("collapses two Rails users that share a normalized email onto one CB row each", async () => {
    const receipt = await runProgressImport({
      db,
      source: memoryRailsProgressSource([epsilonLower, epsilonUpper]),
      apply: true,
    });

    expect(receipt.users).toMatchObject({ seen: 2, matchedByEmail: 2 });
    expect(receipt.rows).toMatchObject({ collapsedDuplicates: 1, inserted: 2, raceSkipped: 0 });
    expect((await progressRows(db)).filter((row) => row.userId === "cb_epsilon")).toEqual([
      {
        userId: "cb_epsilon",
        resourceId: "lesson_a",
        completedAt: RAILS_DAY(14).toISOString(),
        source: imported,
      },
      {
        userId: "cb_epsilon",
        resourceId: "lesson_b",
        completedAt: RAILS_DAY(15).toISOString(),
        source: imported,
      },
    ]);
  });

  it("imports one user on demand and touches no one else", async () => {
    const source = memoryRailsProgressSource(allUsers);
    const before = await progressRows(db);

    const result = await importProgressForUser("cb_delta", {
      db,
      source,
      apply: true,
      now: new Date(Date.UTC(2026, 10, 18)),
    });

    expect(result.status).toBe("imported");
    expect(result.receipt?.rows).toMatchObject({ inserted: 1 });
    expect(result.receipt?.lessons).toMatchObject({ unmapped: 1 });
    const after = await progressRows(db);
    expect(after.filter((row) => row.userId !== "cb_delta")).toEqual(before);
    // A null Rails completion time falls back to the user's last activity.
    expect(after.filter((row) => row.userId === "cb_delta")).toEqual([
      {
        userId: "cb_delta",
        resourceId: "lesson_b",
        completedAt: RAILS_DAY(20).toISOString(),
        source: imported,
      },
    ]);

    const again = await importProgressForUser("cb_delta", { db, source, apply: true });
    expect(again.receipt?.rows).toMatchObject({ inserted: 0, keptCbCompleted: 1 });

    expect((await importProgressForUser("cb_missing", { db, source, apply: true })).status).toBe(
      "no_cb_user",
    );
    expect((await importProgressForUser("cb_no_rails", { db, source, apply: true })).status).toBe(
      "no_rails_progress",
    );
    // The Rails row found by email belongs to a different Rails user id.
    const conflict = await importProgressForUser("cb_gamma", { db, source, apply: true });
    expect(conflict.status).toBe("not_matched");
    expect(conflict.receipt?.users).toMatchObject({ unmatchedEmailConflict: 1 });
    // Found by email, but that Rails id belongs to a different CB user.
    const other = await importProgressForUser("cb_eta", { db, source, apply: true });
    expect(other.status).toBe("not_matched");
    expect(other.receipt?.users).toMatchObject({ matchedOtherCbUser: 1, unmatchedNoCbUser: 0 });
    expect(await progressRows(db)).toEqual(after);
  });

  it("dry-run on-demand import plans without writing", async () => {
    const before = await snapshot(db);
    const result = await importProgressForUser("cb_alpha", {
      db,
      source: memoryRailsProgressSource(allUsers),
      apply: false,
    });
    expect(result.status).toBe("imported");
    expect(result.receipt?.rows).toMatchObject({ toInsert: 2, toUpdate: 1, inserted: 0 });
    expect(await snapshot(db)).toEqual(before);
  });
});

function nullRow(source: string, updatedAt: Date) {
  return { completedAt: null, updatedAt, fields: { source } };
}

describe("write rules and guards", () => {
  const row = nullRow;
  const rails = { completedAt: RAILS_DAY(10) };

  it("treats only explicit learner un-completes as newer CB state", () => {
    expect(classifyProgressCandidate(rails, undefined)).toBe("insert");
    expect(
      classifyProgressCandidate(rails, {
        completedAt: CB_OLDER,
        updatedAt: CB_OLDER,
        fields: null,
      }),
    ).toBe("kept_cb_completed");
    expect(classifyProgressCandidate(rails, row("lesson_progress_control", CB_NEWER))).toBe(
      "kept_cb_newer",
    );
    expect(classifyProgressCandidate(rails, row("lesson_player_ended", CB_NEWER))).toBe(
      "kept_cb_newer",
    );
    expect(classifyProgressCandidate(rails, row("lesson_progress_control", CB_OLDER))).toBe(
      "update",
    );
    expect(classifyProgressCandidate(rails, row("course_lessons_incomplete", CB_NEWER))).toBe(
      "update",
    );
    expect(
      classifyProgressCandidate(rails, { completedAt: null, updatedAt: CB_NEWER, fields: null }),
    ).toBe("update");
  });

  it("needs a separate approval to write beta", () => {
    expect(() =>
      assertProgressImportAccess({ runtime: "beta", apply: false, applyApproved: false }),
    ).not.toThrow();
    expect(() =>
      assertProgressImportAccess({ runtime: "beta", apply: true, applyApproved: false }),
    ).toThrow("EGGHEAD_PROGRESS_IMPORT_APPLY_APPROVED");
    expect(() =>
      assertProgressImportAccess({ runtime: "beta", apply: true, applyApproved: true }),
    ).not.toThrow();
    expect(() =>
      assertProgressImportAccess({ runtime: "local", apply: true, applyApproved: false }),
    ).not.toThrow();
    expect(() =>
      assertProgressImportAccess({ runtime: "production", apply: false, applyApproved: true }),
    ).toThrow("production");
  });
});

const exportDirs: string[] = [];

function writeExport(lines: readonly unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "progress-import-"));
  exportDirs.push(dir);
  const path = join(dir, "rails-progress.jsonl");
  writeFileSync(
    path,
    `${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`,
  );
  return path;
}

function exportLine(railsUserId: number, email: string) {
  return {
    railsUserId,
    email,
    lastActiveAt: "2025-01-01T00:00:00.000Z",
    lessons: [{ railsLessonId: 7, slug: "x", completedAt: "2024-05-01T10:00:00.000Z" }],
    series: [],
  };
}

async function userIdsAfter(source: RailsProgressSource, afterRailsUserId: number) {
  const ids: number[] = [];
  for await (const user of source.users({ afterRailsUserId })) ids.push(user.railsUserId);
  return ids;
}

describe("Rails progress sources", () => {
  const line = exportLine;

  afterAll(() => {
    for (const dir of exportDirs) rmSync(dir, { recursive: true, force: true });
  });

  it("streams users after the cursor and finds one user by id or email", async () => {
    const source = jsonlRailsProgressSource(
      writeExport([line(1, "a@example.test"), "", line(5, "b@example.test")]),
    );

    expect(await userIdsAfter(source, 1)).toEqual([5]);
    expect((await source.findUser({ railsUserId: 1, email: null }))?.railsUserId).toBe(1);
    expect(
      (await source.findUser({ railsUserId: null, email: " B@example.TEST" }))?.railsUserId,
    ).toBe(5);
    expect(await source.findUser({ railsUserId: 9, email: null })).toBeNull();
    const first = await source.findUser({ railsUserId: 1, email: null });
    expect(first?.lessons[0]?.completedAt?.toISOString()).toBe("2024-05-01T10:00:00.000Z");
  });

  it("prefers an id match over an earlier email match", async () => {
    const lines = [line(201, "shared@example.test"), line(202, "other@example.test")];
    const sources = [
      jsonlRailsProgressSource(writeExport(lines)),
      memoryRailsProgressSource([
        railsUser(201, "shared@example.test", []),
        railsUser(202, "other@example.test", []),
      ]),
    ];
    const results = await Promise.all(
      sources.map(async (source) => [
        (await source.findUser({ railsUserId: 202, email: "shared@example.test" }))?.railsUserId,
        (await source.findUser({ railsUserId: 999, email: "shared@example.test" }))?.railsUserId,
      ]),
    );
    expect(results).toEqual([
      [202, 201],
      [202, 201],
    ]);
  });

  it("refuses an export that is not sorted by Rails user id", async () => {
    const source = jsonlRailsProgressSource(
      writeExport([line(5, "b@example.test"), line(1, "a@example.test")]),
    );
    await expect(userIdsAfter(source, 0)).rejects.toThrow("not sorted");
  });

  it("refuses malformed lines with the line number", async () => {
    const source = jsonlRailsProgressSource(
      writeExport([line(1, "a@example.test"), '{"railsUserId":"x"}']),
    );
    await expect(source.findUser({ railsUserId: 2, email: null })).rejects.toThrow("line 2");
  });
});
