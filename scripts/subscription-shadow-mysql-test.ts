// Explicit fixture-only writes. The approved secret is fixed; no URL is accepted from argv.
// Every run creates/drops only its uniquely named shadow tables. Never use the real shadow DB.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import mysql from "mysql2/promise";
import { z } from "zod";
import { shadowDatabaseOptions } from "../apps/web/src/subscriptions/shadow/database-url";
import {
  createMysqlShadowStore,
  shadowTableNames,
} from "../apps/web/src/subscriptions/shadow/mysql-store";
import type { ShadowRecord } from "../apps/web/src/subscriptions/shadow/projection";
import { recordShadowOnce } from "../apps/web/src/subscriptions/shadow/store";

let phase = "lease-fixture";
const countSchema = z.tuple([z.array(z.object({ n: z.number() })), z.unknown()]);
const claimSchema = z.tuple([
  z.array(z.object({ claimOwner: z.string(), complete: z.number() })),
  z.unknown(),
]);
function record(id: string): ShadowRecord {
  return {
    name: "subscription.shadow.skipped",
    version: 1,
    stripeEventId: id,
    eventType: "invoice.paid",
    createdAt: 1,
    observedAt: 1000,
    count: 1,
    reason: "not-subscription",
    skippedSubscriptions: 0,
    tenantMetadataConflicts: 0,
    unresolvedDeletedCustomers: 0,
    subscriptions: [],
  };
}
async function main() {
  const leased = await promisify(execFile)(
    path.join(homedir(), ".local/bin/secrets"),
    [
      "--no-update-check",
      "lease",
      "egghead-cb::fixture_admin_url",
      "--ttl",
      "30m",
      "--client-id",
      "egghead-stripe-shadow-test",
    ],
    { encoding: "utf8" },
  );
  const raw = leased.stdout.trim();
  const options = shadowDatabaseOptions(raw, process.env["DATABASE_URL"]);
  assert.ok(options.host.endsWith(".connect.psdb.cloud"), "fixture must be PlanetScale");
  const prefix = `ss_${randomUUID().replaceAll("-", "")}`;
  const names = { claims: `${prefix}_claim`, records: `${prefix}_record` };
  const tables = shadowTableNames(names);
  const db = await mysql.createConnection(options);
  const store = createMysqlShadowStore(raw, { tables: names });
  const other = createMysqlShadowStore(raw, { tables: names });
  const passed: string[] = [];
  let failure: Error | undefined;
  try {
    phase = "create-run-owned-tables";
    const ddl = (
      await readFile(
        new URL(
          "../apps/web/src/subscriptions/shadow/migrations/0001-shadow-store.sql",
          import.meta.url,
        ),
        "utf8",
      )
    )
      .replaceAll(/\bShadowEventClaim\b/g, names.claims)
      .replaceAll(/\bShadowRecord\b/g, names.records);
    const created = await Promise.allSettled(
      ddl
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((statement) => db.query(statement)),
    );
    assert.ok(
      created.every((result) => result.status === "fulfilled"),
      "fixture DDL failed",
    );
    const count = async () =>
      countSchema.parse(await db.query(`SELECT COUNT(*) AS n FROM ${tables.records}`))[0][0]?.n;
    const state = async (id: string) =>
      claimSchema.parse(
        await db.execute(
          `SELECT claimOwner, (completedAt IS NOT NULL) AS complete FROM ${tables.claims} WHERE stripeEventId = ?`,
          [id],
        ),
      )[0][0];

    phase = "concurrent-deliveries-one-record";
    const event = record("evt_synthetic_concurrent");
    let projections = 0;
    let logs = 0;
    const project = async () => {
      projections++;
      return event;
    };
    const log = () => {
      logs++;
    };
    const deliveries = await Promise.allSettled([
      recordShadowOnce(event.stripeEventId, store, project, log),
      recordShadowOnce(event.stripeEventId, other, project, log),
    ]);
    assert.equal(
      deliveries.filter((item) => item.status === "fulfilled" && item.value.status === "recorded")
        .length,
      1,
    );
    assert.equal(await count(), 1);
    assert.equal(projections, 1);
    assert.equal(logs, 1);
    passed.push(phase);

    phase = "completed-event-never-reprocessed";
    await db.execute(
      `UPDATE ${tables.claims} SET claimedUntil = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 SECOND) WHERE stripeEventId = ?`,
      [event.stripeEventId],
    );
    assert.equal(
      (await recordShadowOnce(event.stripeEventId, other, project, log)).status,
      "duplicate",
    );
    assert.equal(await count(), 1);
    assert.equal(projections, 1);
    assert.equal(logs, 1);
    assert.equal((await state(event.stripeEventId))?.complete, 1);
    passed.push(phase);

    phase = "expired-owner-cannot-complete";
    const expired = record("evt_synthetic_expired");
    assert.equal(await store.claim(expired.stripeEventId, "crashed"), "claimed");
    await db.execute(
      `UPDATE ${tables.claims} SET claimedUntil = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 SECOND) WHERE stripeEventId = ?`,
      [expired.stripeEventId],
    );
    assert.equal(await store.complete(expired.stripeEventId, "crashed", expired), false);
    assert.equal(await count(), 1);
    passed.push(phase);

    phase = "expired-lease-single-reclaimer";
    const reclaims = await Promise.all([
      store.claim(expired.stripeEventId, "worker-a"),
      other.claim(expired.stripeEventId, "worker-b"),
    ]);
    assert.deepEqual(reclaims.toSorted(), ["busy", "claimed"]);
    const winner = reclaims[0] === "claimed" ? "worker-a" : "worker-b";
    await store.release(expired.stripeEventId, "crashed");
    assert.equal((await state(expired.stripeEventId))?.claimOwner, winner);
    assert.equal(await store.complete(expired.stripeEventId, "crashed", expired), false);
    assert.equal(await other.complete(expired.stripeEventId, winner, expired), true);
    assert.equal(await store.complete(expired.stripeEventId, winner, expired), false);
    assert.equal(await count(), 2);
    passed.push(phase);

    phase = "canonical-insert-conflict-rolls-back-claim";
    const conflict = record("evt_synthetic_conflict");
    assert.equal(await store.claim(conflict.stripeEventId, "owner"), "claimed");
    await db.execute(
      `INSERT INTO ${tables.records} (stripeEventId, observedAt, record) VALUES (?, ?, ?)`,
      [conflict.stripeEventId, conflict.observedAt, JSON.stringify(conflict)],
    );
    await assert.rejects(() =>
      store.complete(conflict.stripeEventId, "owner", { ...conflict, observedAt: 2000 }),
    );
    assert.equal((await state(conflict.stripeEventId))?.complete, 0);
    const observed = z
      .tuple([z.array(z.object({ observedAt: z.number() })), z.unknown()])
      .parse(
        await db.execute(`SELECT observedAt FROM ${tables.records} WHERE stripeEventId = ?`, [
          conflict.stripeEventId,
        ]),
      );
    assert.equal(observed[0][0]?.observedAt, 1000);
    passed.push(phase);
  } catch {
    failure = new Error("Fixture proof failed");
  }
  // Cleanup follows the captured outcome, without throwing from finally or masking it.
  // Fresh connections also permit cleanup if the test's control connection failed.
  const cleanup = await Promise.allSettled(
    [tables.records, tables.claims].map(async (table) => {
      const cleaner = await mysql.createConnection(options);
      try {
        await cleaner.query(`DROP TABLE IF EXISTS ${table}`);
      } finally {
        await cleaner.end();
      }
    }),
  );
  const closed = await Promise.allSettled([db.end()]);
  if (![...cleanup, ...closed].every((result) => result.status === "fulfilled")) {
    console.error(JSON.stringify({ ok: false, phase: "cleanup", runOwnedTables: names }));
    failure ??= new Error("Run-owned table cleanup failed");
  }
  if (failure) throw failure;
  console.log(
    JSON.stringify({
      ok: true,
      suite: "shadow-mysql-fixture",
      passed,
      cleanup: "both run-owned tables dropped",
    }),
  );
}
main().catch(() => {
  // Never print driver/lease errors: they can contain credentials or private connection data.
  console.error(JSON.stringify({ ok: false, suite: "shadow-mysql-fixture", phase }));
  process.exitCode = 1;
});
