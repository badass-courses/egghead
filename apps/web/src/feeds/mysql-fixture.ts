// Test-only helper for the feeds MySQL suite.
//
// Point FEEDS_MYSQL_URL_FILE at a file holding a disposable MySQL URL:
//   FEEDS_MYSQL_URL_FILE=<file> pnpm feeds:mysql-test
//
// Safety rules (judge #16):
// - The suite always runs in its own database, `<stem>_feeds_test`, on a
//   loopback host. It never reuses the database named in the URL, so pointing
//   it at a dev database such as `coursebuilder_test` uses
//   `coursebuilder_feeds_test` instead.
// - The runner creates that database itself and stamps it with an owner
//   table. It refuses to run `drizzle-kit push --force` into a database that
//   exists without the stamp, i.e. one it did not create.
// - The suite deletes only the ids it seeds.
// The URL is read from the file and never printed.

import { readFileSync } from "node:fs";

import mysql, { type RowDataPacket } from "mysql2/promise";

/** Marker table. drizzle-kit's tablesFilter (`egghead_*`) never touches it. */
export const FEEDS_TEST_OWNER_TABLE = "feeds_test_owner";
const OWNER = "feeds-mysql-test";

export function feedsMysqlBaseUrl(): string | null {
  const direct = process.env["FEEDS_MYSQL_URL"]?.trim();
  if (direct) return direct;
  const file = process.env["FEEDS_MYSQL_URL_FILE"]?.trim();
  if (file) return readFileSync(file, "utf8").trim();
  return null;
}

/** `x_app`, `x_test` and `x` all become `x_feeds_test`; `x_feeds_test` stays. */
export function feedsTestDatabaseName(database: string) {
  const stem = database.replace(/_feeds_test$/, "").replace(/_(test|app|local)$/, "");
  return `${stem || "coursebuilder"}_feeds_test`;
}

export function feedsTestDatabaseUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const database = feedsTestDatabaseName(url.pathname.replace(/^\//, ""));
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (!loopback || !/^[A-Za-z0-9_]+$/.test(database)) {
    throw new Error(`Refusing a non-disposable feeds test database: ${url.hostname}/${database}`);
  }
  url.pathname = `/${database}`;
  return url;
}

type Admin = Awaited<ReturnType<typeof mysql.createConnection>>;

async function databaseExists(admin: Admin, database: string) {
  const [rows] = await admin.query<RowDataPacket[]>(
    "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
    [database],
  );
  return rows.length > 0;
}

async function ownedByRunner(admin: Admin, database: string) {
  const [tables] = await admin.query<RowDataPacket[]>(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    [database, FEEDS_TEST_OWNER_TABLE],
  );
  if (tables.length === 0) return false;
  const [rows] = await admin.query<RowDataPacket[]>(
    `SELECT owner FROM \`${database}\`.\`${FEEDS_TEST_OWNER_TABLE}\` WHERE owner = ?`,
    [OWNER],
  );
  return rows.length > 0;
}

/**
 * Create the feeds test database (stamped as ours) or confirm an existing one
 * carries our stamp. Throws, before any schema push, for anything else.
 */
export async function ensureFeedsTestDatabase(testUrl: URL): Promise<"created" | "owned"> {
  const database = testUrl.pathname.replace(/^\//, "");
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = "/";
  const admin = await mysql.createConnection(adminUrl.toString());
  try {
    if (await databaseExists(admin, database)) {
      if (await ownedByRunner(admin, database)) return "owned";
      throw new Error(
        `Database ${database} exists but was not created by feeds:mysql-test; ` +
          "refusing to push --force into it. Use another fixture or remove it yourself.",
      );
    }
    await admin.query(
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    await admin.query(
      `CREATE TABLE \`${database}\`.\`${FEEDS_TEST_OWNER_TABLE}\` (owner VARCHAR(64) PRIMARY KEY, createdAt TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))`,
    );
    await admin.query(
      `INSERT INTO \`${database}\`.\`${FEEDS_TEST_OWNER_TABLE}\` (owner) VALUES (?)`,
      [OWNER],
    );
    return "created";
  } finally {
    await admin.end();
  }
}
