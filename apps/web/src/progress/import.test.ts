import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RowDataPacket } from "mysql2";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getEggheadMysqlPool } from "../db/local-docker";
import {
  contentResource,
  contentResourceResource,
  resourceProgress,
  users as usersTable,
} from "../db/schema";
import { getPrivateLearningProgress } from "../profile/data";
import { syncCourseProgressForUser } from "./course-progress";
import {
  classifyProgressCandidate,
  importProgressForUser,
  MAX_ROWS_PER_TRANSACTION,
  PROGRESS_IMPORT_SOURCE,
  runProgressImport,
} from "./import";
import { assertDryRunReceiptMatches, manifestUserIds, parseImportCursor } from "./import-cli";
import { assertProgressImportAccess, openUtcConnection } from "./import-db";
import { rollbackProgressImport } from "./import-rollback";
import {
  jsonlRailsProgressSource,
  memoryRailsProgressSource,
  type RailsProgressSource,
  type RailsUserProgress,
} from "./import-source";
import {
  completeResourceForUser,
  readCompletedResourceIdsForUser,
  readResourceProgress,
  uncompleteResourceForUser,
} from "./resource-progress";

/**
 * Integration tests against a real local MySQL database whose name ends in
 * `_test`, for example:
 *
 *   PROGRESS_IMPORT_TEST_DATABASE_URL=mysql://user:pass@127.0.0.1:3306/progress_import_test \
 *     pnpm progress:import:test
 *
 * The user needs CREATE on that database name; the test creates it if missing.
 * The tables come from the app's own drizzle schema through drizzle-kit, so
 * they match what beta was pushed from. CB's real progress writers and readers
 * run against the same database (DATABASE_URL is pointed at it).
 *
 * Without the variable the database cases are skipped; the pure cases always
 * run. All fixture data is synthetic.
 */
const testDatabaseUrl = process.env["PROGRESS_IMPORT_TEST_DATABASE_URL"];
if (testDatabaseUrl) process.env["DATABASE_URL"] = testDatabaseUrl;

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

function lesson(railsLessonId: number, slug: string, day: number | null) {
  return { railsLessonId, slug, completedAt: day === null ? null : RAILS_DAY(day) };
}

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
/** Two Rails users whose emails normalize to one CB user: the lower id owns it. */
const epsilonLower = railsUser(106, "epsilon@example.test", [lesson(1, "lesson-a", 13)]);
const epsilonUpper = railsUser(1007, "EPSILON@example.test ", [
  lesson(1, "lesson-a", 14),
  lesson(2, "lesson-b", 15),
]);
/** Found by cb_eta's email, but its Rails id belongs to cb_theta. */
const eta = railsUser(109, "eta@example.test", [lesson(1, "lesson-a", 16)]);
/** Owns a row whose `fields` is a JSON array. */
const iota = railsUser(110, "iota@example.test", [lesson(1, "lesson-a", 17)]);

const bulkUsers = [alpha, beta, gamma, nobody];
const allUsers = [alpha, beta, gamma, nobody, delta, epsilonLower, eta, iota, epsilonUpper];

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
  updatedAt: string | null;
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

const drizzleKitApiSchema = {
  parse(value: unknown) {
    if (typeof value !== "object" || value === null) throw new Error("drizzle-kit/api missing");
    const generateJson: unknown = Reflect.get(value, "generateMySQLDrizzleJson");
    const generateMigration: unknown = Reflect.get(value, "generateMySQLMigration");
    if (typeof generateJson !== "function" || typeof generateMigration !== "function") {
      throw new Error("drizzle-kit/api has no MySQL generators");
    }
    return {
      generateJson: (imports: Record<string, unknown>): Promise<unknown> =>
        Promise.resolve(Reflect.apply(generateJson, value, [imports])),
      generateMigration: async (previous: unknown, current: unknown): Promise<string[]> => {
        const statements: unknown = await Reflect.apply(generateMigration, value, [
          previous,
          current,
        ]);
        if (!Array.isArray(statements)) throw new Error("drizzle-kit returned no statements");
        return statements.map(String);
      },
    };
  },
};

/** CREATE TABLE / INDEX statements for the four tables, generated from the app's drizzle schema. */
async function drizzleDdl() {
  // drizzle-kit's ESM build cannot load under vitest; its CommonJS build can.
  const api = drizzleKitApiSchema.parse(createRequire(import.meta.url)("drizzle-kit/api"));
  const previous = await api.generateJson({});
  const current = await api.generateJson({
    users: usersTable,
    resourceProgress,
    contentResource,
    contentResourceResource,
  });
  return api.generateMigration(previous, current);
}

async function createSchema(db: mysql.Connection) {
  await db.query(
    "DROP TABLE IF EXISTS egghead_ResourceProgress, egghead_ContentResourceResource, egghead_ContentResource, egghead_User",
  );
  const statements = await drizzleDdl();
  await statements.reduce<Promise<unknown>>(
    (previous, statement) => previous.then(() => db.query(statement)),
    Promise.resolve(),
  );
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
    ["cb_iota", "iota@example.test", { legacyRailsUserId: "110" }],
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
    [
      "course_x",
      "course",
      { title: "Course X", slug: "course-x", legacyRailsPlaylistId: 50, state: "published" },
    ],
    [
      "course_y",
      "course",
      { title: "Course Y", slug: "course-y", legacyRailsPlaylistId: 60, state: "published" },
    ],
    [
      "lesson_a",
      "lesson",
      { title: "A", slug: "lesson-a", eggheadLessonId: 1, state: "published" },
    ],
    // Duplicate CB row for Rails lesson 1. Not course-linked, so not canonical.
    [
      "lesson_a_dup",
      "post",
      { title: "A", slug: "lesson-a", postType: "lesson", legacySourceId: 1, state: "published" },
    ],
    [
      "lesson_b",
      "lesson",
      { title: "B", slug: "lesson-b", legacyRailsLessonId: "2", state: "published" },
    ],
    // No Rails id: reachable only by slug.
    ["lesson_c", "lesson", { title: "C", slug: "lesson-c", state: "published" }],
  ];
  await Promise.all(
    resources.map(([id, type, fields]) =>
      db.execute(
        "INSERT INTO egghead_ContentResource (id, type, createdById, fields) VALUES (?, ?, 'author', CAST(? AS JSON))",
        [id, type, JSON.stringify(fields)],
      ),
    ),
  );
  await db.execute(
    "INSERT INTO egghead_ContentResourceResource (resourceOfId, resourceId, position) VALUES ('course_x', 'lesson_a', 0)",
  );

  const progress: Array<[string, string, Date | null, Date | null, string | null]> = [
    // Newer CB completion than Rails: must stay as is.
    [
      "cb_alpha",
      "lesson_b",
      CB_NEWER,
      CB_NEWER,
      '{"source":"lesson_player_ended","localOnly":true}',
    ],
    // SQL NULL fields and updatedAt (both columns allow it): not a learner decision.
    ["cb_alpha", "lesson_c", null, null, null],
    // Course recount nulled it after Rails: not a learner decision, Rails wins.
    [
      "cb_alpha",
      "course_x",
      null,
      CB_NEWER,
      '{"source":"course_lessons_incomplete","localOnly":true}',
    ],
    // Explicit un-complete after the Rails completion: CB wins.
    [
      "cb_beta",
      "lesson_a",
      null,
      CB_NEWER,
      '{"source":"lesson_progress_control","localOnly":true}',
    ],
    // Explicit un-complete before the Rails completion: Rails wins.
    [
      "cb_beta",
      "lesson_b",
      null,
      CB_OLDER,
      '{"source":"lesson_progress_control","localOnly":true}',
    ],
    // fields is a JSON array, not an object: left alone.
    ["cb_iota", "lesson_a", null, CB_OLDER, "[1,2]"],
  ];
  await Promise.all(
    progress.map(([userId, resourceId, completedAt, updatedAt, fields]) =>
      db.execute(
        `INSERT INTO egghead_ResourceProgress (userId, resourceId, completedAt, fields, createdAt, updatedAt)
         VALUES (?, ?, ?, CAST(? AS JSON), ?, ?)`,
        [userId, resourceId, completedAt, fields, CB_OLDER, updatedAt],
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

function only(rows: Awaited<ReturnType<typeof snapshot>>, keys: ReadonlyArray<[string, string]>) {
  return rows.filter((row) =>
    keys.some(([userId, resourceId]) => row.userId === userId && row.resourceId === resourceId),
  );
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
  // Updated from SQL NULL fields; two Rails lessons collapsed, the later wins.
  {
    userId: "cb_alpha",
    resourceId: "lesson_c",
    completedAt: RAILS_DAY(11).toISOString(),
    source: null,
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
  { userId: "cb_iota", resourceId: "lesson_a", completedAt: null, source: null },
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
    await getEggheadMysqlPool().end();
    await db?.end();
  });

  beforeEach(async () => {
    await seedFixture(db);
  });

  it("builds its tables from the app's drizzle schema", async () => {
    const [columns] = await db.query<
      Array<RowDataPacket & { COLUMN_NAME: string; COLUMN_TYPE: string; EXTRA: string }>
    >(
      `SELECT COLUMN_NAME, COLUMN_TYPE, EXTRA FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'egghead_ResourceProgress'
       ORDER BY ORDINAL_POSITION`,
    );
    const byName = new Map(columns.map((column) => [column.COLUMN_NAME, column]));
    expect(byName.get("updatedAt")).toMatchObject({ COLUMN_TYPE: "datetime(3)", EXTRA: "" });
    expect(byName.get("completedAt")).toMatchObject({ COLUMN_TYPE: "datetime(3)" });
    expect(byName.has("organizationMembershipId")).toBe(true);
  });

  it("dry run reports matches, gaps and planned rows without writing", async () => {
    const before = await snapshot(db);
    const receipt = await runProgressImport({
      db,
      source: memoryRailsProgressSource(bulkUsers),
      apply: false,
    });

    expect(await snapshot(db)).toEqual(before);
    expect(receipt).toMatchObject({ mode: "dry_run", fullSource: true, maxUsers: null });
    expect(receipt.runId).toMatch(/^rails-import-/);
    expect(receipt.users).toEqual({
      seen: 4,
      matchedByLegacyRailsUserId: 1,
      matchedByEmail: 1,
      unmatchedNoCbUser: 1,
      unmatchedEmailConflict: 1,
      unmatchedSharedEmail: 0,
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
      toInsert: 1,
      toUpdate: 3,
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

    const partial = await runProgressImport({
      db,
      source: memoryRailsProgressSource(bulkUsers),
      apply: false,
      maxUsers: 2,
    });
    expect(partial).toMatchObject({ fullSource: false, maxUsers: 2 });
  });

  it("apply writes CB-native rows with provenance and lets explicit CB state win", async () => {
    const receipt = await runProgressImport({
      db,
      source: memoryRailsProgressSource(bulkUsers),
      apply: true,
      runId: "run-apply",
    });

    expect(receipt.rows).toMatchObject({ inserted: 1, updated: 3, raceSkipped: 0 });
    expect(receipt.transactions).toBe(1);
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
      completedAt: "2024-01-08 12:00:00.000",
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

  it("leaves a row whose fields is not a JSON object, under its own receipt class", async () => {
    const before = only(await snapshot(db), [["cb_iota", "lesson_a"]]);
    const receipt = await runProgressImport({
      db,
      source: memoryRailsProgressSource([iota]),
      apply: true,
    });
    expect(receipt.rows).toMatchObject({ keptFieldsNotObject: 1, toUpdate: 0, raceSkipped: 0 });
    expect(only(await snapshot(db), [["cb_iota", "lesson_a"]])).toEqual(before);
  });

  it("rollback deletes inserted rows and restores updated rows byte for byte, in batches", async () => {
    const before = await snapshot(db);
    const userIds: string[] = [];
    await runProgressImport({
      db,
      source: memoryRailsProgressSource(bulkUsers),
      apply: true,
      runId: "run-rollback",
      onBeforeWrite: ({ cbUserIds }) => {
        userIds.push(...cbUserIds);
      },
    });
    expect(await snapshot(db)).not.toEqual(before);
    expect(userIds.toSorted()).toEqual(["cb_alpha", "cb_beta"]);

    const dryRun = await rollbackProgressImport({ db, runId: "run-rollback", apply: false });
    expect(dryRun).toMatchObject({
      scope: "table_scan",
      insertedRows: 1,
      updatedRows: 3,
      changedSinceImport: 0,
      deleted: 0,
      restored: 0,
    });

    const batches: string[] = [];
    const applied = await rollbackProgressImport({
      db,
      runId: "run-rollback",
      apply: true,
      userIds,
      batchUsers: 1,
      onBatch: ({ lastUserId }) => {
        batches.push(lastUserId);
      },
    });
    expect(applied).toMatchObject({ scope: "manifest", batches: 2, deleted: 1, restored: 3 });
    expect(batches).toEqual(["cb_alpha", "cb_beta"]);
    // Includes the row whose prior fields and updatedAt were SQL NULL.
    expect(await snapshot(db)).toEqual(before);
  });

  it("rollback resumes from its cursor and walks the table when there is no manifest", async () => {
    const before = await snapshot(db);
    await runProgressImport({
      db,
      source: memoryRailsProgressSource(bulkUsers),
      apply: true,
      runId: "run-resume-rollback",
    });

    await expect(
      rollbackProgressImport({
        db,
        runId: "run-resume-rollback",
        apply: true,
        batchUsers: 1,
        onBatch: ({ lastUserId }) => {
          if (lastUserId === "cb_alpha") throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow("simulated crash");

    const resumed = await rollbackProgressImport({
      db,
      runId: "run-resume-rollback",
      apply: true,
      batchUsers: 1,
      afterUserId: "cb_alpha",
    });
    expect(resumed).toMatchObject({ scope: "table_scan", restored: 1 });
    expect(await snapshot(db)).toEqual(before);
  });

  it("rollback leaves rows CB's real writers changed after the import", async () => {
    await runProgressImport({
      db,
      source: memoryRailsProgressSource(bulkUsers),
      apply: true,
      runId: "run-touched",
    });

    // The learner un-completes an inserted lesson and re-completes an updated
    // one; a lesson toggle recounts course_x, which still has an incomplete
    // lesson, and nulls the imported course completion.
    await uncompleteResourceForUser({
      userId: "cb_alpha",
      resourceId: "lesson_a",
      source: "lesson_progress_control",
    });
    await completeResourceForUser({
      userId: "cb_beta",
      resourceId: "lesson_b",
      source: "lesson_player_ended",
    });
    await syncCourseProgressForUser({
      userId: "cb_alpha",
      courseId: "course_x",
      lessonIds: ["lesson_a"],
    });
    const keys: Array<[string, string]> = [
      ["cb_alpha", "lesson_a"],
      ["cb_beta", "lesson_b"],
      ["cb_alpha", "course_x"],
    ];
    const touched = only(await snapshot(db), keys);

    const applied = await rollbackProgressImport({ db, runId: "run-touched", apply: true });
    expect(applied).toMatchObject({ changedSinceImport: 3, deleted: 0, restored: 1 });

    const after = await snapshot(db);
    expect(only(after, keys)).toEqual(touched);
    // lesson_c (updated, untouched) is restored to its NULL prior state.
    expect(only(after, [["cb_alpha", "lesson_c"]])).toEqual([
      expect.objectContaining({ completedAt: null, fields: null, updatedAt: null }),
    ]);
  });

  it("rollback of a later run leaves the earlier run's stamp for the earlier rollback", async () => {
    // Run A completes course_x for alpha by update; a recount nulls it again;
    // run B completes it again over A's stamp.
    await runProgressImport({
      db,
      source: memoryRailsProgressSource([alpha]),
      apply: true,
      runId: "run-a",
    });
    const afterA = only(await snapshot(db), [["cb_alpha", "course_x"]]);
    await syncCourseProgressForUser({
      userId: "cb_alpha",
      courseId: "course_x",
      lessonIds: ["lesson_a", "lesson_b", "lesson_c", "lesson_missing"],
    });
    const afterRecount = only(await snapshot(db), [["cb_alpha", "course_x"]]);
    expect(afterRecount[0]?.completedAt).toBeNull();

    const runB = await runProgressImport({
      db,
      source: memoryRailsProgressSource([alpha]),
      apply: true,
      runId: "run-b",
    });
    expect(runB.rows).toMatchObject({ updated: 1 });

    const rollbackB = await rollbackProgressImport({ db, runId: "run-b", apply: true });
    expect(rollbackB).toMatchObject({ restored: 1, changedSinceImport: 0 });
    expect(only(await snapshot(db), [["cb_alpha", "course_x"]])).toEqual(afterRecount);

    // A's rollback sees the recount's write and leaves course_x alone.
    const rollbackA = await rollbackProgressImport({ db, runId: "run-a", apply: true });
    expect(rollbackA.changedSinceImport).toBe(1);
    expect(only(await snapshot(db), [["cb_alpha", "course_x"]])).toEqual(afterRecount);
    expect(afterA[0]?.completedAt).not.toBeNull();
  });

  it("keeps one runId across a crash and resume, and rolls the whole import back by it", async () => {
    const before = await snapshot(db);
    const cursors: number[] = [];
    const runId = "run-crash-resume";
    await expect(
      runProgressImport({
        db,
        source: memoryRailsProgressSource(bulkUsers),
        apply: true,
        batchSize: 1,
        runId,
        onBatchCommitted: ({ lastRailsUserId }) => {
          cursors.push(lastRailsUserId);
          if (cursors.length === 1) throw new Error("simulated crash after first batch");
        },
      }),
    ).rejects.toThrow("simulated crash");

    expect(cursors).toEqual([101]);
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
      runId,
      afterRailsUserId: 101,
      onBatchCommitted: ({ lastRailsUserId }) => {
        cursors.push(lastRailsUserId);
      },
    });

    expect(resumed.users.seen).toBe(3);
    expect(cursors).toEqual([101, 102, 103, 104]);
    expect(await progressRows(db)).toEqual(expectedAfterBulkApply);
    expect(await progressCount(db)).toBe(expectedAfterBulkApply.length);

    const rollback = await rollbackProgressImport({ db, runId, apply: true });
    expect(rollback).toMatchObject({ deleted: 1, restored: 3, changedSinceImport: 0 });
    expect(await snapshot(db)).toEqual(before);
  });

  it("gives a shared email to the lowest Rails id, whatever the batch size", async () => {
    const outcomes = await [1, 500].reduce<Promise<Array<Record<string, unknown>>>>(
      async (previous, batchSize) => {
        const results = await previous;
        await seedFixture(db);
        const receipt = await runProgressImport({
          db,
          source: memoryRailsProgressSource([epsilonLower, epsilonUpper]),
          apply: true,
          batchSize,
        });
        return [
          ...results,
          {
            users: receipt.users,
            shared: receipt.samples.sharedEmailRailsUserIds,
            rows: (await progressRows(db)).filter((row) => row.userId === "cb_epsilon"),
          },
        ];
      },
      Promise.resolve([]),
    );

    const expected = {
      users: expect.objectContaining({ matchedByEmail: 1, unmatchedSharedEmail: 1 }),
      shared: [1007],
      rows: [
        {
          userId: "cb_epsilon",
          resourceId: "lesson_a",
          completedAt: RAILS_DAY(13).toISOString(),
          source: imported,
        },
      ],
    };
    expect(outcomes).toEqual([expected, expected]);
  });

  it("caps rows per transaction", async () => {
    // One user with more completions than one transaction holds.
    const lessonCount = MAX_ROWS_PER_TRANSACTION + 3;
    const resources = Array.from({ length: lessonCount }, (_, index) => ({
      id: `bulk_${index}`,
      fields: JSON.stringify({
        slug: `bulk-${index}`,
        eggheadLessonId: 10_000 + index,
        state: "published",
      }),
    }));
    await Promise.all(
      resources.map(({ id, fields }) =>
        db.execute(
          "INSERT INTO egghead_ContentResource (id, type, createdById, fields) VALUES (?, 'lesson', 'author', CAST(? AS JSON))",
          [id, fields],
        ),
      ),
    );
    const heavy = railsUser(
      101,
      "alpha@example.test",
      Array.from({ length: lessonCount }, (_, index) => lesson(10_000 + index, `bulk-${index}`, 1)),
    );
    const receipt = await runProgressImport({
      db,
      source: memoryRailsProgressSource([heavy]),
      apply: true,
    });
    expect(receipt.rows.inserted).toBe(lessonCount);
    expect(receipt.transactions).toBe(2);
  });

  it("imported rows read as complete through CB's own progress readers", async () => {
    await runProgressImport({ db, source: memoryRailsProgressSource(bulkUsers), apply: true });

    expect(
      await readCompletedResourceIdsForUser({
        userId: "cb_alpha",
        resourceIds: ["lesson_a", "lesson_b", "lesson_c", "course_x", "lesson_a_dup"],
      }),
    ).toEqual(["course_x", "lesson_a", "lesson_b", "lesson_c"]);
    expect(
      await readResourceProgress({ userId: "cb_alpha", resourceId: "lesson_a" }),
    ).toMatchObject({ exists: true, completed: true, source: imported });

    const profile = await getPrivateLearningProgress({
      actorUserId: "cb_alpha",
      profileUserId: "cb_alpha",
      query: { order: "newest", page: 1 },
    });
    expect(profile).toMatchObject({ lessonCount: 3, courseCount: 1 });
  });

  it("does not recount courses at import; CB's recount completes a fully imported course", async () => {
    // Rails had every lesson of course_x complete but no series row.
    const lessonsOnly = railsUser(105, "delta@example.test", [lesson(1, "lesson-a", 3)]);
    await runProgressImport({ db, source: memoryRailsProgressSource([lessonsOnly]), apply: true });
    expect(
      await readResourceProgress({ userId: "cb_delta", resourceId: "course_x" }),
    ).toMatchObject({ exists: false });

    const recount = await syncCourseProgressForUser({
      userId: "cb_delta",
      courseId: "course_x",
      lessonIds: ["lesson_a"],
    });
    expect(recount.completed).toBe(true);
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

  it("refuses a session that is not UTC", async () => {
    const options = assertLocalTestDatabase(testDatabaseUrl ?? "");
    const offset = await mysql.createConnection(options);
    try {
      await offset.query("SET time_zone = '+05:00'");
      await expect(
        importProgressForUser("cb_delta", {
          db: offset,
          source: memoryRailsProgressSource(allUsers),
          apply: true,
        }),
      ).rejects.toThrow("UTC session");
      await expect(
        rollbackProgressImport({ db: offset, runId: "any", apply: true }),
      ).rejects.toThrow("UTC session");
    } finally {
      await offset.end();
    }
  });

  it("dry-run on-demand import plans without writing", async () => {
    const before = await snapshot(db);
    const result = await importProgressForUser("cb_alpha", {
      db,
      source: memoryRailsProgressSource(allUsers),
      apply: false,
    });
    expect(result.status).toBe("imported");
    expect(result.receipt?.rows).toMatchObject({ toInsert: 1, toUpdate: 2, inserted: 0 });
    expect(await snapshot(db)).toEqual(before);
  });
});

function nullRow(source: string, updatedAt: Date | null) {
  return { completedAt: null, updatedAt, fields: { source } };
}

describe("write rules and guards", () => {
  const rails = { completedAt: RAILS_DAY(10) };
  const row = nullRow;

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
    expect(classifyProgressCandidate(rails, row("lesson_progress_control", null))).toBe("update");
    expect(classifyProgressCandidate(rails, row("course_lessons_incomplete", CB_NEWER))).toBe(
      "update",
    );
    expect(
      classifyProgressCandidate(rails, { completedAt: null, updatedAt: CB_NEWER, fields: null }),
    ).toBe("update");
    expect(
      classifyProgressCandidate(rails, { completedAt: null, updatedAt: CB_NEWER, fields: [1] }),
    ).toBe("kept_fields_not_object");
    expect(
      classifyProgressCandidate(rails, { completedAt: null, updatedAt: CB_NEWER, fields: "x" }),
    ).toBe("kept_fields_not_object");
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

describe("CLI files", () => {
  const sha = "a".repeat(64);
  const dryRun = (overrides: Record<string, unknown>) =>
    JSON.stringify({
      sourceSha256: sha,
      receipt: {
        mode: "dry_run",
        fullSource: true,
        finishedAt: "2026-11-18T00:00:00Z",
        ...overrides,
      },
    });

  it("only accepts a finished full-file dry run of the same export for --apply", () => {
    expect(() => assertDryRunReceiptMatches(dryRun({}), sha)).not.toThrow();
    expect(() => assertDryRunReceiptMatches(dryRun({}), "b".repeat(64))).toThrow(
      "different export",
    );
    expect(() => assertDryRunReceiptMatches(dryRun({ fullSource: false }), sha)).toThrow(
      "full-file",
    );
    expect(() => assertDryRunReceiptMatches(dryRun({ mode: "apply" }), sha)).toThrow("full-file");
    expect(() => assertDryRunReceiptMatches("{nope", sha)).toThrow("not valid JSON");
  });

  it("keeps the runId in the cursor and reads a run's manifest", () => {
    const cursor = parseImportCursor(
      JSON.stringify({
        runId: "run-1",
        lastRailsUserId: 7,
        source: "jsonl:x",
        sourceSha256: sha,
        updatedAt: "2026-11-18T00:00:00Z",
      }),
    );
    expect(cursor.runId).toBe("run-1");
    expect(() => parseImportCursor(JSON.stringify({ lastRailsUserId: 7 }))).toThrow(
      "not a progress import cursor",
    );
    const manifest = [
      JSON.stringify({ runId: "run-1", cbUserIds: ["u2", "u1"] }),
      JSON.stringify({ runId: "run-2", cbUserIds: ["u9"] }),
      JSON.stringify({ runId: "run-1", cbUserIds: ["u1", "u3"] }),
      "",
    ].join("\n");
    expect(manifestUserIds(manifest, "run-1").toSorted()).toEqual(["u1", "u2", "u3"]);
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

  it("prefers an id match over an earlier email match, and owns shared emails by lowest id", async () => {
    const lines = [
      line(201, "shared@example.test"),
      line(202, "other@example.test"),
      line(305, " SHARED@example.test"),
    ];
    const sources = [
      jsonlRailsProgressSource(writeExport(lines)),
      memoryRailsProgressSource([
        railsUser(305, " SHARED@example.test", []),
        railsUser(201, "shared@example.test", []),
        railsUser(202, "other@example.test", []),
      ]),
    ];
    const results = await Promise.all(
      sources.map(async (source) => [
        (await source.findUser({ railsUserId: 202, email: "shared@example.test" }))?.railsUserId,
        (await source.findUser({ railsUserId: 999, email: "shared@example.test" }))?.railsUserId,
        (await source.emailOwners()).get("shared@example.test"),
      ]),
    );
    expect(results).toEqual([
      [202, 201, 201],
      [202, 201, 201],
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
