import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  UnmappedContentTally,
} from "./import";
import {
  assertDryRunReceiptMatches,
  assertRollbackCursorFits,
  manifestUserIds,
  parseImportCursor,
  importOutput,
  parseRollbackCursor,
  type ProgressImportIdentity,
  progressImportTarget,
  resolveImportStart,
  targetMatches,
} from "./import-cli";
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

/**
 * The export case also needs a throwaway local Postgres database ending in
 * `_test` and a `psql` client (`PROGRESS_EXPORT_TEST_PSQL`, default `psql`):
 *
 *   PROGRESS_EXPORT_TEST_PG_URL='postgresql://postgres@localhost/rails_export_test' \
 *
 * It drops and recreates a synthetic subset of the Rails tables there, runs
 * the real export and counts files through psql, and imports the output.
 */
const exportTestPgUrl = testDatabaseUrl ? process.env["PROGRESS_EXPORT_TEST_PG_URL"] : undefined;
const psqlBinary = process.env["PROGRESS_EXPORT_TEST_PSQL"] ?? "psql";
const EXPORT_SQL = fileURLToPath(
  new URL("../../../../scripts/sql/rails-progress-export.sql", import.meta.url),
);
const COUNTS_SQL = fileURLToPath(
  new URL("../../../../scripts/sql/rails-progress-export-counts.sql", import.meta.url),
);

function assertLocalPgTestUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  const database = url.pathname.replace(/^\//, "");
  const socket = url.searchParams.get("host");
  const local =
    ["127.0.0.1", "localhost", "::1", ""].includes(url.hostname) &&
    (socket === null || socket.startsWith("/"));
  if (!local || !database.endsWith("_test")) {
    throw new Error(
      `PROGRESS_EXPORT_TEST_PG_URL must be a local database ending in _test, got host=${url.hostname} database=${database}`,
    );
  }
  return rawUrl;
}

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * Runs one of the import CLIs as an operator would, against the test database.
 * A failing run throws with its stderr in the message.
 */
function cli(script: string, args: readonly string[]) {
  try {
    return execFileSync("pnpm", ["-s", script, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DATABASE_URL: testDatabaseUrl, EGGHEAD_RUNTIME: "local" },
    });
  } catch (error) {
    const stderr = error instanceof Error ? String(Reflect.get(error, "stderr") ?? "") : "";
    throw new Error(`${script} failed: ${stderr}`, { cause: error });
  }
}

/**
 * Runs psql as an operator would, with no psqlrc, and returns stdout. With no
 * `timeZone` the session takes the server's default zone, as an operator's
 * would; PGTZ from the caller's environment is dropped.
 */
function psql(url: string, args: readonly string[], timeZone?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  Reflect.deleteProperty(env, "PGTZ");
  return execFileSync(psqlBinary, ["-X", url, ...args], {
    encoding: "utf8",
    env: timeZone === undefined ? env : { ...env, PGTZ: timeZone },
  });
}

/**
 * A synthetic slice of the Rails tables the export reads, with the column
 * types from Rails' schema (datetimes are `timestamp without time zone`).
 * Cutoff for the test: 2024-06-01.
 */
const RAILS_EXPORT_FIXTURE_SQL = `
SET client_min_messages = warning;
DROP TABLE IF EXISTS users, lessons, lesson_views, playlists, series, series_progresses;
CREATE TABLE users (
  id serial PRIMARY KEY,
  email varchar NOT NULL DEFAULT '',
  current_sign_in_at timestamp,
  last_sign_in_at timestamp
);
CREATE TABLE lessons (id serial PRIMARY KEY, slug varchar, current_lesson_version_id integer);
CREATE TABLE lesson_views (
  id serial PRIMARY KEY,
  user_id integer,
  lesson_id integer,
  lesson_version_id integer,
  did_complete boolean DEFAULT false,
  created_at timestamp,
  updated_at timestamp
);
CREATE INDEX ON lesson_views (user_id);
CREATE TABLE playlists (id serial PRIMARY KEY, slug varchar);
CREATE TABLE series (id serial PRIMARY KEY, slug varchar);
CREATE TABLE series_progresses (
  id serial PRIMARY KEY,
  user_id integer,
  progressable_type varchar,
  progressable_id integer,
  series_id integer,
  is_complete boolean DEFAULT false,
  completed_at timestamp,
  updated_at timestamp,
  last_lesson_watched_at timestamp,
  site text DEFAULT 'egghead.io'
);

INSERT INTO lessons VALUES (1, 'lesson-a', 11), (2, 'lesson-b', 21), (3, 'lesson-c', 31);
INSERT INTO playlists VALUES (50, 'course-x');
INSERT INTO series VALUES (70, 'course-z');

INSERT INTO users (id, email, current_sign_in_at, last_sign_in_at) VALUES
  (101, ' Alpha@Example.test ', '2024-09-01 10:00:00', NULL),  -- active by sign-in
  (102, 'beta@example.test', NULL, '2023-01-01'),               -- active by a recent view
  (103, 'gamma@example.test', '2023-01-01', '2023-01-01'),      -- inactive
  (104, 'nobody@example.test', '2024-09-01', NULL),             -- active, nothing completed
  (105, 'delta@example.test', NULL, NULL),                      -- active by series progress
  (250, 'later@example.test', '2024-10-01', NULL),              -- a later chunk, no CB user
  (100, 'edge-100@example.test', '2024-09-01', NULL),           -- on chunk edges: each
  (200, 'edge-200@example.test', '2024-09-01', NULL),           -- must land in exactly
  (300, 'edge-300@example.test', '2024-09-01', NULL);           -- one chunk

INSERT INTO lesson_views (user_id, lesson_id, lesson_version_id, did_complete, created_at, updated_at) VALUES
  (101, 1, 11, true, '2024-01-01 12:00:00', '2024-01-02 12:00:00'),
  (101, 1, 11, true, '2024-01-03 12:00:00', NULL),             -- latest, by created_at
  (101, 2, 20, true, '2024-01-04', '2024-01-04'),              -- superseded version
  (101, 3, 31, false, '2024-01-05', '2024-01-05'),             -- not completed
  (102, 2, 21, true, '2024-07-01 08:30:00.123', '2024-07-01 08:30:00.123'),
  (103, 1, 11, true, '2023-01-01', '2023-01-01'),              -- inactive user
  (NULL, 1, 11, true, '2024-09-01', '2024-09-01'),             -- no user
  (250, 1, 11, true, '2024-10-01', '2024-10-01'),
  (100, 3, 31, true, '2024-05-01', '2024-05-01'),
  (200, 3, 31, true, '2024-05-01', '2024-05-01'),
  (300, 3, 31, true, '2024-05-01', '2024-05-01');

INSERT INTO series_progresses
  (user_id, progressable_type, progressable_id, series_id, is_complete, completed_at, updated_at, last_lesson_watched_at, site)
VALUES
  (105, 'Playlist', 50, NULL, true, '2024-08-01', '2024-08-02', NULL, 'egghead.io'),
  (105, 'Series', 70, NULL, true, NULL, '2024-08-03', '2024-08-03', 'egghead.io'),  -- completed_at from updated_at
  (105, 'Playlist', 51, NULL, false, NULL, '2024-08-04', NULL, 'egghead.io'),       -- not complete
  (105, 'Playlist', 52, NULL, true, '2024-08-05', '2024-08-05', NULL, 'other.site'), -- another site
  (105, 'Course', 9, NULL, true, '2024-08-06', '2024-08-06', NULL, NULL),           -- neither playlist nor series
  (105, 'Playlist', 55, NULL, true, '2024-08-07', '2024-08-07', NULL, 'egghead.io'); -- playlist row deleted
`;

const edgeUser = (railsUserId: number) => ({
  railsUserId,
  email: `edge-${railsUserId}@example.test`,
  lastActiveAt: "2024-09-01T00:00:00.000Z",
  lessons: [{ railsLessonId: 3, slug: "lesson-c", completedAt: "2024-05-01T00:00:00.000Z" }],
  series: [],
});

const EXPECTED_EXPORT = [
  edgeUser(100),
  {
    railsUserId: 101,
    email: "alpha@example.test",
    lastActiveAt: "2024-09-01T10:00:00.000Z",
    lessons: [{ railsLessonId: 1, slug: "lesson-a", completedAt: "2024-01-03T12:00:00.000Z" }],
    series: [],
  },
  {
    railsUserId: 102,
    email: "beta@example.test",
    lastActiveAt: "2024-07-01T08:30:00.123Z",
    lessons: [{ railsLessonId: 2, slug: "lesson-b", completedAt: "2024-07-01T08:30:00.123Z" }],
    series: [],
  },
  {
    railsUserId: 105,
    email: "delta@example.test",
    lastActiveAt: "2024-08-07T00:00:00.000Z",
    lessons: [],
    series: [
      {
        railsPlaylistId: 50,
        railsSeriesId: null,
        slug: "course-x",
        completedAt: "2024-08-01T00:00:00.000Z",
      },
      // Its playlist row is gone: still exported, with no slug, and counted.
      {
        railsPlaylistId: 55,
        railsSeriesId: null,
        slug: null,
        completedAt: "2024-08-07T00:00:00.000Z",
      },
      {
        railsPlaylistId: null,
        railsSeriesId: 70,
        slug: "course-z",
        completedAt: "2024-08-03T00:00:00.000Z",
      },
    ],
  },
  edgeUser(200),
  {
    railsUserId: 250,
    email: "later@example.test",
    lastActiveAt: "2024-10-01T00:00:00.000Z",
    lessons: [{ railsLessonId: 1, slug: "lesson-a", completedAt: "2024-10-01T00:00:00.000Z" }],
    series: [],
  },
  edgeUser(300),
];

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
    // A post-type course with no Rails playlist id: reachable only by slug.
    [
      "course_z",
      "post",
      { title: "Course Z", slug: "course-z", postType: "course", state: "published" },
    ],
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

// Database cases get room for a slow CI runner; the cap and CLI cases set their own.
describe.skipIf(!testDatabaseUrl)(
  "progress import against local MySQL",
  { timeout: 30_000 },
  () => {
    let db: mysql.Connection;

    beforeAll(async () => {
      const options = assertLocalTestDatabase(testDatabaseUrl ?? "");
      const { database, ...serverOptions } = options;
      const admin = await openUtcConnection(serverOptions);
      await admin.query(`CREATE DATABASE IF NOT EXISTS \`${database}\``);
      await admin.end();
      db = await openUtcConnection(options);
      await createSchema(db);
    }, 60_000);

    afterAll(async () => {
      await getEggheadMysqlPool().end();
      await db?.end();
    });

    beforeEach(async () => {
      await seedFixture(db);
    }, 30_000);

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
      // One multi-row statement: thousands of round trips would dominate the test.
      await db.query(
        "INSERT INTO egghead_ContentResource (id, type, createdById, fields) VALUES ?",
        [resources.map(({ id, fields }) => [id, "lesson", "author", fields])],
      );
      const heavy = railsUser(
        101,
        "alpha@example.test",
        Array.from({ length: lessonCount }, (_, index) =>
          lesson(10_000 + index, `bulk-${index}`, 1),
        ),
      );
      const receipt = await runProgressImport({
        db,
        source: memoryRailsProgressSource([heavy]),
        apply: true,
      });
      expect(receipt.rows.inserted).toBe(lessonCount);
      expect(receipt.transactions).toBe(2);
    }, 120_000);

    it("takes a lower per-transaction cap and records transaction timings", async () => {
      const receipt = await runProgressImport({
        db,
        source: memoryRailsProgressSource(bulkUsers),
        apply: true,
        maxRowsPerTransaction: 1,
      });
      expect(receipt).toMatchObject({ maxRowsPerTransaction: 1, transactions: 4 });
      expect(receipt.timings.slowestTransactionRows).toBe(1);
      expect(receipt.timings.writeMs).toBeGreaterThanOrEqual(receipt.timings.slowestTransactionMs);
      expect(await progressRows(db)).toEqual(expectedAfterBulkApply);
    });

    it("lists every unmapped lesson and series with its learner count", async () => {
      const unmapped = new UnmappedContentTally();
      const gaps = railsUser(
        105,
        "delta@example.test",
        [lesson(4, "lesson-gone", 1), lesson(8, "other-gone", 2)],
        [
          {
            railsPlaylistId: 51,
            railsSeriesId: null,
            slug: "course-gone",
            completedAt: RAILS_DAY(3),
          },
          { railsPlaylistId: null, railsSeriesId: 71, slug: null, completedAt: RAILS_DAY(4) },
        ],
      );
      const receipt = await runProgressImport({
        db,
        source: memoryRailsProgressSource([alpha, gaps]),
        apply: false,
        unmapped,
      });
      expect(unmapped.lessons()).toEqual([
        { railsLessonId: 4, slug: "lesson-gone", users: 2 },
        { railsLessonId: 8, slug: "other-gone", users: 1 },
      ]);
      expect(unmapped.series()).toEqual([
        { railsPlaylistId: 51, railsSeriesId: null, slug: "course-gone", users: 2 },
        { railsPlaylistId: 52, railsSeriesId: null, slug: "course-y", users: 1 },
        { railsPlaylistId: null, railsSeriesId: 71, slug: null, users: 1 },
      ]);
      expect(receipt.lessons.distinctUnmappedRailsLessonIds).toBe(2);
      expect(receipt.series.distinctUnmapped).toBe(3);
    });

    it("the CLI dry run writes a salted target and gap list that its apply and rollback honour", () => {
      const dir = mkdtempSync(join(tmpdir(), "progress-cli-"));
      exportDirs.push(dir);
      const exportPath = join(dir, "rails-progress.jsonl");
      writeFileSync(
        exportPath,
        [
          {
            railsUserId: 101,
            email: "alpha@example.test",
            lastActiveAt: "2024-01-20T12:00:00.000Z",
            lessons: [
              { railsLessonId: 1, slug: "lesson-a", completedAt: "2024-01-01T12:00:00.000Z" },
              { railsLessonId: 4, slug: "lesson-gone", completedAt: "2024-01-04T12:00:00.000Z" },
            ],
            series: [],
          },
          {
            railsUserId: 105,
            email: "delta@example.test",
            lastActiveAt: "2024-01-20T12:00:00.000Z",
            lessons: [
              { railsLessonId: 2, slug: "lesson-b", completedAt: "2024-01-02T12:00:00.000Z" },
              { railsLessonId: 4, slug: "lesson-gone", completedAt: "2024-01-05T12:00:00.000Z" },
            ],
            series: [],
          },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n"),
      );
      const path = (name: string) => join(dir, name);

      cli("progress:import", [
        "--source",
        exportPath,
        "--receipt",
        path("dry.json"),
        "--unmapped-out",
        path("unmapped.jsonl"),
      ]);
      const dryText = readFileSync(path("dry.json"), "utf8");
      const dry: unknown = JSON.parse(dryText);
      const target: unknown =
        typeof dry === "object" && dry !== null ? Reflect.get(dry, "target") : null;
      expect(target).toEqual({
        runtime: "local",
        salt: expect.stringMatching(/^[0-9a-f]{32}$/),
        identityHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      const { host, user } = assertLocalTestDatabase(testDatabaseUrl ?? "");
      expect(dryText).not.toContain(host);
      expect(dryText).not.toContain(`"${user}"`);
      expect(readFileSync(path("unmapped.jsonl"), "utf8")).toBe(
        `${JSON.stringify({ kind: "lesson", railsLessonId: 4, slug: "lesson-gone", users: 2 })}\n`,
      );

      // A receipt whose salt no longer hashes to this connection is refused before any write.
      writeFileSync(
        path("forged.json"),
        dryText.replace(/"salt": "[0-9a-f]{32}"/, `"salt": "${"0".repeat(32)}"`),
      );
      expect(() =>
        cli("progress:import", [
          "--source",
          exportPath,
          "--apply",
          "--expect-dry-run",
          path("forged.json"),
          "--cursor",
          path("forged-cursor.json"),
        ]),
      ).toThrow("another database or branch");
      expect(existsSync(path("forged-cursor.json"))).toBe(false);

      cli("progress:import", [
        "--source",
        exportPath,
        "--apply",
        "--expect-dry-run",
        path("dry.json"),
        "--cursor",
        path("cursor.json"),
        "--receipt",
        path("apply.json"),
      ]);
      const cursor = parseImportCursor(readFileSync(path("cursor.json"), "utf8"));
      expect(readFileSync(path("apply.json"), "utf8")).toContain(`"runId": "${cursor.runId}"`);

      cli("progress:import:rollback", [
        "--run",
        cursor.runId,
        "--manifest",
        path("cursor.json.manifest.jsonl"),
        "--apply",
        "--cursor",
        path("rollback.json"),
      ]);
      expect(parseRollbackCursor(readFileSync(path("rollback.json"), "utf8"))).toMatchObject({
        runId: cursor.runId,
        scope: "manifest",
      });
      expect(() =>
        cli("progress:import:rollback", [
          "--run",
          cursor.runId,
          "--apply",
          "--cursor",
          path("rollback.json"),
        ]),
      ).toThrow("user orders differ");
    }, 120_000);

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
      await runProgressImport({
        db,
        source: memoryRailsProgressSource([lessonsOnly]),
        apply: true,
      });
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
      const before = await snapshot(db);
      // A non-UTC server session, and separately a UTC server session read by a
      // client that formats Dates in another zone.
      const offsetServer = await mysql.createConnection({ ...options, timezone: "Z" });
      const offsetClient = await mysql.createConnection({ ...options, timezone: "+05:00" });
      try {
        await offsetServer.query("SET time_zone = '+05:00'");
        await offsetClient.query("SET time_zone = '+00:00'");
        await [offsetServer, offsetClient].reduce<Promise<void>>(async (previous, offset) => {
          await previous;
          await expect(
            runProgressImport({
              db: offset,
              source: memoryRailsProgressSource(bulkUsers),
              apply: true,
            }),
          ).rejects.toThrow("UTC session");
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
        }, Promise.resolve());
      } finally {
        await offsetServer.end();
        await offsetClient.end();
      }
      expect(await snapshot(db)).toEqual(before);
    });

    it("refuses a table with an extra UNIQUE index", async () => {
      const before = await snapshot(db);
      await db.query(
        "CREATE UNIQUE INDEX progress_import_extra_unique ON egghead_ResourceProgress (resourceId, userId, organizationMembershipId)",
      );
      try {
        await expect(
          runProgressImport({ db, source: memoryRailsProgressSource(bulkUsers), apply: false }),
        ).rejects.toThrow("progress_import_extra_unique");
        await expect(
          importProgressForUser("cb_delta", {
            db,
            source: memoryRailsProgressSource(allUsers),
            apply: true,
          }),
        ).rejects.toThrow("besides the primary key");
      } finally {
        await db.query("DROP INDEX progress_import_extra_unique ON egghead_ResourceProgress");
      }
      expect(await snapshot(db)).toEqual(before);
    });

    it("relies on the (userId, resourceId) primary key and refuses a table without it", async () => {
      const [keys] = await db.query<Array<RowDataPacket & { columnName: string }>>(`
      SELECT COLUMN_NAME AS columnName FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'egghead_ResourceProgress'
        AND INDEX_NAME = 'PRIMARY'
      ORDER BY SEQ_IN_INDEX
    `);
      expect(keys.map((key) => key.columnName)).toEqual(["userId", "resourceId"]);

      const before = await snapshot(db);
      await db.query("ALTER TABLE egghead_ResourceProgress DROP PRIMARY KEY");
      try {
        await expect(
          runProgressImport({ db, source: memoryRailsProgressSource(bulkUsers), apply: true }),
        ).rejects.toThrow("not (userId, resourceId)");
        await expect(
          importProgressForUser("cb_delta", {
            db,
            source: memoryRailsProgressSource(allUsers),
            apply: true,
          }),
        ).rejects.toThrow("not (userId, resourceId)");
      } finally {
        await db.query("ALTER TABLE egghead_ResourceProgress ADD PRIMARY KEY (userId, resourceId)");
      }
      expect(await snapshot(db)).toEqual(before);
    });

    it("skips and counts every planned row a learner changed before the write", async () => {
      // Planned: insert alpha/lesson_a; update alpha/course_x, alpha/lesson_c and
      // beta/lesson_b. Between planning and the write, each loses a race that
      // only one guard catches.
      let raced = false;
      const receipt = await runProgressImport({
        db,
        source: memoryRailsProgressSource(bulkUsers),
        apply: true,
        runId: "run-race",
        onBeforeWrite: async () => {
          if (raced) return;
          raced = true;
          // The row now exists: the duplicate-key no-op.
          await completeResourceForUser({
            userId: "cb_alpha",
            resourceId: "lesson_a",
            source: "lesson_player_ended",
          });
          // A newer learner un-complete: only updatedAt moves.
          await uncompleteResourceForUser({
            userId: "cb_beta",
            resourceId: "lesson_b",
            source: "lesson_progress_control",
          });
          // Completed with updatedAt untouched: only completedAt differs.
          await db.execute(
            "UPDATE egghead_ResourceProgress SET completedAt = ? WHERE userId = 'cb_alpha' AND resourceId = 'course_x'",
            [CB_NEWER],
          );
          // fields became a JSON array, updatedAt and completedAt untouched.
          await db.execute(
            "UPDATE egghead_ResourceProgress SET fields = JSON_ARRAY(1) WHERE userId = 'cb_alpha' AND resourceId = 'lesson_c'",
          );
        },
      });
      const keys: Array<[string, string]> = [
        ["cb_alpha", "lesson_a"],
        ["cb_alpha", "course_x"],
        ["cb_alpha", "lesson_c"],
        ["cb_beta", "lesson_b"],
      ];
      const learnerState = only(await snapshot(db), keys);

      expect(receipt.rows).toMatchObject({
        toInsert: 1,
        toUpdate: 3,
        inserted: 0,
        updated: 0,
        raceSkipped: 4,
      });
      expect(learnerState.map((row) => row.fields?.includes("railsImport") ?? false)).toEqual([
        false,
        false,
        false,
        false,
      ]);
      expect(
        (await progressRows(db)).filter((row) =>
          keys.some(
            ([userId, resourceId]) => row.userId === userId && row.resourceId === resourceId,
          ),
        ),
      ).toEqual([
        {
          userId: "cb_alpha",
          resourceId: "course_x",
          completedAt: CB_NEWER.toISOString(),
          source: "course_lessons_incomplete",
        },
        {
          userId: "cb_alpha",
          resourceId: "lesson_a",
          completedAt: expect.any(String),
          source: "lesson_player_ended",
        },
        { userId: "cb_alpha", resourceId: "lesson_c", completedAt: null, source: null },
        {
          userId: "cb_beta",
          resourceId: "lesson_b",
          completedAt: null,
          source: "lesson_progress_control",
        },
      ]);

      // Nothing carries the run's stamp, so its rollback has nothing to do.
      const rollback = await rollbackProgressImport({ db, runId: "run-race", apply: true });
      expect(rollback).toMatchObject({ insertedRows: 0, updatedRows: 0, deleted: 0, restored: 0 });
      expect(only(await snapshot(db), keys)).toEqual(learnerState);
    });

    it("maps a Rails series to a CB course by slug only when no course has its playlist id", async () => {
      const seriesOnly = railsUser(
        105,
        "delta@example.test",
        [],
        [
          // Playlist id unknown to CB: falls back to the slug.
          { railsPlaylistId: 53, railsSeriesId: null, slug: "course-z", completedAt: RAILS_DAY(3) },
          // A Rails Series row has no playlist id at all.
          {
            railsPlaylistId: null,
            railsSeriesId: 70,
            slug: " Course-Z ",
            completedAt: RAILS_DAY(4),
          },
          // course-x carries Rails playlist 50, so playlist 54 never claims it by slug.
          { railsPlaylistId: 54, railsSeriesId: null, slug: "course-x", completedAt: RAILS_DAY(5) },
        ],
      );
      const receipt = await runProgressImport({
        db,
        source: memoryRailsProgressSource([seriesOnly]),
        apply: true,
      });

      expect(receipt.series).toMatchObject({
        seen: 3,
        mappedByRailsPlaylistId: 0,
        mappedBySlug: 2,
        unmapped: 1,
      });
      expect(receipt.rows).toMatchObject({ collapsedDuplicates: 1, inserted: 1 });
      expect((await progressRows(db)).filter((row) => row.userId === "cb_delta")).toEqual([
        {
          userId: "cb_delta",
          resourceId: "course_z",
          completedAt: RAILS_DAY(4).toISOString(),
          source: imported,
        },
      ]);
      expect(
        await readResourceProgress({ userId: "cb_delta", resourceId: "course_z" }),
      ).toMatchObject({ exists: true, completed: true });
    });

    describe.skipIf(!exportTestPgUrl)("Rails export SQL under psql", () => {
      it("exports, chunks and counts the same rows, and imports them end to end", async () => {
        const pgUrl = assertLocalPgTestUrl(exportTestPgUrl ?? "");
        const dir = mkdtempSync(join(tmpdir(), "progress-export-"));
        exportDirs.push(dir);
        const fixturePath = join(dir, "rails-fixture.sql");
        writeFileSync(fixturePath, RAILS_EXPORT_FIXTURE_SQL);
        psql(pgUrl, ["-v", "ON_ERROR_STOP=1", "-q", "-f", fixturePath]);

        const since = ["-v", "active_since=2024-06-01"];
        const whole = psql(pgUrl, [...since, "-f", EXPORT_SQL]);
        const chunked = [0, 100, 200]
          .map((start) =>
            psql(pgUrl, [
              ...since,
              "-v",
              `after_user_id=${start}`,
              "-v",
              `through_user_id=${start + 100}`,
              "-f",
              EXPORT_SQL,
            ]),
          )
          .join("");

        // Only JSON lines: no psql chatter, BEGIN or ROLLBACK.
        const lines = whole.split("\n").filter((line) => line.length > 0);
        expect(chunked).toBe(whole);
        expect(lines.map((line) => JSON.parse(line))).toEqual(EXPECTED_EXPORT);

        // The session zone does not change a byte: Rails timestamps are zone-less
        // UTC and the cutoff is computed in UTC.
        for (const timeZone of ["Asia/Kolkata", "America/Sao_Paulo"]) {
          expect(psql(pgUrl, [...since, "-f", EXPORT_SQL], timeZone)).toBe(whole);
        }
        const windowCutoffs = [undefined, "Asia/Kolkata", "America/Sao_Paulo"].map((timeZone) => {
          const parsed: unknown = JSON.parse(
            psql(pgUrl, ["-v", "active_window=24 months", "-f", COUNTS_SQL], timeZone),
          );
          const cutoff: unknown =
            typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "cutoff") : null;
          return Date.parse(String(cutoff));
        });
        const spread = Math.max(...windowCutoffs) - Math.min(...windowCutoffs);
        expect(Number.isFinite(spread) && spread < 60_000).toBe(true);

        const counts: unknown = JSON.parse(psql(pgUrl, [...since, "-f", COUNTS_SQL]));
        expect(counts).toMatchObject({
          cutoff: "2024-06-01T00:00:00.000Z",
          active_users: 8,
          exported_users: lines.length,
          lesson_completion_rows: EXPECTED_EXPORT.flatMap((user) => user.lessons).length,
          series_completion_rows: EXPECTED_EXPORT.flatMap((user) => user.series).length,
          playlist_completion_rows: 2,
          distinct_lessons: 3,
        });

        // The rolling window's cutoff is UTC too. This user's only activity is a
        // sign-in one hour after the UTC cutoff; a cutoff taken in a zone ahead
        // of UTC would land after it and drop them.
        psql(pgUrl, [
          "-v",
          "ON_ERROR_STOP=1",
          "-q",
          "-c",
          `INSERT INTO users (id, email, current_sign_in_at) VALUES (400, 'window@example.test', (now() AT TIME ZONE 'UTC') - interval '24 months' + interval '1 hour');
           INSERT INTO lesson_views (user_id, lesson_id, lesson_version_id, did_complete, created_at, updated_at) VALUES (400, 1, 11, true, '2020-01-01', '2020-01-01');`,
        ]);
        for (const timeZone of [undefined, "Asia/Kolkata", "America/Sao_Paulo"]) {
          const windowed = psql(
            pgUrl,
            ["-v", "active_window=24 months", "-v", "after_user_id=399", "-f", EXPORT_SQL],
            timeZone,
          );
          expect(windowed.split("\n").filter((line) => line.length > 0)).toHaveLength(1);
        }

        const exportPath = join(dir, "rails-progress.jsonl");
        writeFileSync(exportPath, chunked);
        const receipt = await runProgressImport({
          db,
          source: jsonlRailsProgressSource(exportPath),
          apply: true,
        });
        expect(receipt).toMatchObject({ fullSource: true });
        expect(receipt.users).toMatchObject({
          seen: 7,
          matchedByLegacyRailsUserId: 2,
          matchedByEmail: 1,
          unmatchedNoCbUser: 4,
        });
        expect(receipt.series).toMatchObject({
          mappedByRailsPlaylistId: 1,
          mappedBySlug: 1,
          unmapped: 1,
        });
        expect(receipt.rows).toMatchObject({ inserted: 3, updated: 1, raceSkipped: 0 });
        const written = (await progressRows(db)).filter(
          (row) =>
            row.source === imported || (row.userId === "cb_beta" && row.resourceId === "lesson_b"),
        );
        expect(written).toEqual([
          {
            userId: "cb_alpha",
            resourceId: "lesson_a",
            completedAt: "2024-01-03T12:00:00.000Z",
            source: imported,
          },
          {
            userId: "cb_beta",
            resourceId: "lesson_b",
            completedAt: "2024-07-01T08:30:00.123Z",
            source: "lesson_progress_control",
          },
          {
            userId: "cb_delta",
            resourceId: "course_x",
            completedAt: "2024-08-01T00:00:00.000Z",
            source: imported,
          },
          {
            userId: "cb_delta",
            resourceId: "course_z",
            completedAt: "2024-08-03T00:00:00.000Z",
            source: imported,
          },
        ]);
      });
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
  },
);

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
  const betaIdentity: ProgressImportIdentity = {
    runtime: "beta",
    host: "beta.example.test",
    port: 3306,
    user: "branch-main-user",
    database: "egghead",
  };
  const betaTarget = progressImportTarget(betaIdentity);
  const dryRun = (overrides: Record<string, unknown>, target: unknown = betaTarget) =>
    JSON.stringify({
      sourceSha256: sha,
      target,
      receipt: {
        mode: "dry_run",
        fullSource: true,
        finishedAt: "2026-11-18T00:00:00Z",
        ...overrides,
      },
    });

  it("only accepts a finished full-file dry run of the same export for --apply", () => {
    expect(() => assertDryRunReceiptMatches(dryRun({}), sha, betaIdentity)).not.toThrow();
    expect(() => assertDryRunReceiptMatches(dryRun({}), "b".repeat(64), betaIdentity)).toThrow(
      "different export",
    );
    expect(() =>
      assertDryRunReceiptMatches(dryRun({ fullSource: false }), sha, betaIdentity),
    ).toThrow("full-file");
    expect(() => assertDryRunReceiptMatches(dryRun({ mode: "apply" }), sha, betaIdentity)).toThrow(
      "full-file",
    );
    expect(() => assertDryRunReceiptMatches("{nope", sha, betaIdentity)).toThrow("not valid JSON");
  });

  it("refuses a receipt from another branch, user, port, database or runtime", () => {
    const variants: ProgressImportIdentity[] = [
      // PlanetScale: same host and database name, branch-specific user.
      { ...betaIdentity, user: "branch-dev-user" },
      { ...betaIdentity, port: 3307 },
      { ...betaIdentity, database: "egghead_branch" },
      { ...betaIdentity, host: "other.example.test" },
      { ...betaIdentity, runtime: "local" },
    ];
    for (const identity of variants) {
      expect(() => assertDryRunReceiptMatches(dryRun({}), sha, identity)).toThrow(
        "another database or branch",
      );
    }
    // The host is matched case-insensitively, like DNS.
    expect(() =>
      assertDryRunReceiptMatches(dryRun({}), sha, { ...betaIdentity, host: "BETA.example.test" }),
    ).not.toThrow();
  });

  it("salts each target, and the receipt carries no host or user", () => {
    const again = progressImportTarget(betaIdentity);
    expect(again.salt).not.toBe(betaTarget.salt);
    expect(again.identityHash).not.toBe(betaTarget.identityHash);
    expect(targetMatches(again, betaIdentity)).toBe(true);
    expect(JSON.stringify(betaTarget)).not.toMatch(/example\.test|branch-main-user|3306/);
  });

  it("refuses receipts without a salted target, including earlier rounds' formats", () => {
    // Round 3: raw host and database.
    const round3 = { runtime: "beta", host: "beta.example.test", database: "egghead" };
    // Round 4: unsalted host hash.
    const round4 = { runtime: "beta", hostHash: "529c5f1556e6ae1b" };
    for (const target of [round3, round4, null]) {
      expect(() => assertDryRunReceiptMatches(dryRun({}, target), sha, betaIdentity)).toThrow(
        "salted target",
      );
    }
  });

  it("the dry-run producer writes a target that unlocks only its own connection", () => {
    const output = importOutput({
      identity: betaIdentity,
      sourceSha256: sha,
      receipt: { mode: "dry_run", fullSource: true, finishedAt: "2026-11-18T00:00:00Z" },
    });
    expect(output.target).toMatchObject({ runtime: "beta" });
    const text = JSON.stringify(output);
    expect(() => assertDryRunReceiptMatches(text, sha, betaIdentity)).not.toThrow();
    expect(() =>
      assertDryRunReceiptMatches(text, sha, { ...betaIdentity, user: "branch-dev-user" }),
    ).toThrow("another database or branch");
  });

  it("resumes an import only from a cursor for this export, and never with --after", () => {
    const cursor = {
      runId: "run-1",
      lastRailsUserId: 7,
      source: "jsonl:x",
      sourceSha256: sha,
      updatedAt: "2026-11-18T00:00:00Z",
    };
    expect(
      resolveImportStart({ cursorGiven: true, cursor, after: undefined, sourceSha256: sha }),
    ).toEqual({ runId: "run-1", afterRailsUserId: 7 });
    expect(
      resolveImportStart({ cursorGiven: true, cursor: null, after: undefined, sourceSha256: sha }),
    ).toEqual({ runId: null, afterRailsUserId: 0 });
    expect(
      resolveImportStart({ cursorGiven: false, cursor: null, after: 40, sourceSha256: sha }),
    ).toEqual({ runId: null, afterRailsUserId: 40 });
    expect(() =>
      resolveImportStart({ cursorGiven: true, cursor, after: undefined, sourceSha256: "b" }),
    ).toThrow("different export");
    expect(() =>
      resolveImportStart({ cursorGiven: true, cursor: null, after: 3, sourceSha256: sha }),
    ).toThrow("not both");
  });

  it("resumes a rollback only for its own run and mode", () => {
    const cursor = parseRollbackCursor(
      JSON.stringify({
        runId: "run-1",
        scope: "manifest",
        lastUserId: "u2",
        updatedAt: "2026-11-18T00:00:00Z",
      }),
    );
    expect(() =>
      assertRollbackCursorFits(cursor, { runId: "run-1", scope: "manifest" }),
    ).not.toThrow();
    expect(() => assertRollbackCursorFits(cursor, { runId: "run-2", scope: "manifest" })).toThrow(
      "belongs to run run-1",
    );
    expect(() => assertRollbackCursorFits(cursor, { runId: "run-1", scope: "table_scan" })).toThrow(
      "user orders differ",
    );
    // A cursor without its scope is refused rather than guessed.
    expect(() =>
      parseRollbackCursor(
        JSON.stringify({ runId: "run-1", lastUserId: "u2", updatedAt: "2026-11-18T00:00:00Z" }),
      ),
    ).toThrow("not a progress rollback cursor");
    expect(() => parseRollbackCursor("{")).toThrow("not valid JSON");
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
