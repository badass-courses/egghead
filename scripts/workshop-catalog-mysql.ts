import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/mysql2";
import { listUpcomingWorkshops } from "../apps/web/src/workshops/catalog";
import { assertDatabaseUrlForRuntime, getEggheadMysqlPool } from "../apps/web/src/db/local-docker";
import * as schema from "../apps/web/src/db/schema";

const safety = assertDatabaseUrlForRuntime();
assert.ok(
  safety.localDockerOnly && safety.runtime === "local",
  "This fixture requires an isolated local database",
);
const pool = getEggheadMysqlPool();
const connection = await pool.getConnection();
try {
  // A connection-local temporary table shadows the native table without changing its rows.
  await connection.execute(
    "CREATE TEMPORARY TABLE egghead_ContentResource (id varchar(255) PRIMARY KEY, type varchar(255) NOT NULL, fields json, deletedAt timestamp(3) NULL, INDEX type_idx(type))",
  );
  const fixtures = Array.from({ length: 25 }, (_, index) => ({
    id: `synthetic-${String(25 - index).padStart(2, "0")}`,
    startsAt: `2099-11-${String(Math.floor(index / 6) + 1).padStart(2, "0")}T17:00:00.000Z`,
  }));
  const values = [
    ...Array.from({ length: 2000 }, (_, index) => [
      `unrelated-${index}`,
      "lesson",
      JSON.stringify({ title: "Synthetic unrelated lesson" }),
      null,
    ]),
    ...fixtures.map((row) => [
      row.id,
      "workshop",
      JSON.stringify({
        ...row,
        title: "Synthetic Workshop",
        description: "",
        timezone: "UTC",
        state: "published",
      }),
      null,
    ]),
    [
      "synthetic-draft",
      "workshop",
      JSON.stringify({ startsAt: fixtures[0]?.startsAt, state: "draft" }),
      null,
    ],
    [
      "synthetic-deleted",
      "workshop",
      JSON.stringify({ startsAt: fixtures[0]?.startsAt, state: "published" }),
      new Date(),
    ],
    [
      "synthetic-past",
      "workshop",
      JSON.stringify({ startsAt: "2000-01-01T00:00:00.000Z", state: "published" }),
      null,
    ],
  ];
  await connection.query(
    "INSERT INTO egghead_ContentResource (id, type, fields, deletedAt) VALUES ?",
    [values],
  );
  let statements = 0;
  const database = drizzle(connection, {
    mode: "default",
    schema,
    logger: {
      logQuery() {
        statements++;
      },
    },
  });
  const first = await listUpcomingWorkshops(undefined, database);
  assert.equal(statements, 1);
  assert.equal(first.workshops.length, 20);
  assert.ok(first.nextCursor);
  const second = await listUpcomingWorkshops(first.nextCursor, database);
  assert.equal(statements, 2);
  assert.equal(second.workshops.length, 5);
  assert.equal(second.nextCursor, undefined);
  const expected = fixtures
    .toSorted((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id))
    .map((row) => row.id);
  assert.deepEqual(
    [...first.workshops, ...second.workshops].map((row) => row.id),
    expected,
  );
  const invalid = await listUpcomingWorkshops("invalid-cursor", database);
  assert.equal(invalid.workshops.length, 0);
  assert.equal(statements, 2, "Malformed cursors must fail closed before querying");
  const [plan] = await connection.execute(
    "EXPLAIN SELECT id FROM egghead_ContentResource WHERE type = 'workshop' AND deletedAt IS NULL AND JSON_UNQUOTE(JSON_EXTRACT(fields, '$.state')) = 'published' AND JSON_UNQUOTE(JSON_EXTRACT(fields, '$.startsAt')) > ? ORDER BY JSON_UNQUOTE(JSON_EXTRACT(fields, '$.startsAt')), id LIMIT 21",
    [new Date().toISOString()],
  );
  console.log(
    JSON.stringify({
      ok: true,
      statementsPerPage: 1,
      returnedRowBudget: 21,
      fixtures: fixtures.length,
      plan,
    }),
  );
} finally {
  await connection.execute("DROP TEMPORARY TABLE IF EXISTS egghead_ContentResource");
  connection.release();
  await pool.end();
}
