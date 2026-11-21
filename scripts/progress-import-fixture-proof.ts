// Opt-in rehearsal. Leases ONLY the disposable fixture credential in-process.
// No supplied URL, no production/beta credential, no secret output.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { runProgressImport } from "../apps/web/src/progress/import";
import {
  assertDryRunReceiptMatches,
  importOutput,
  manifestUserIds,
} from "../apps/web/src/progress/import-cli";
import {
  openProgressImportDatabase,
  PROGRESS_IMPORT_PRODUCTION_APPROVAL_ENV,
} from "../apps/web/src/progress/import-db";
import { rollbackProgressImport } from "../apps/web/src/progress/import-rollback";
import { memoryRailsProgressSource } from "../apps/web/src/progress/import-source";

async function main() {
  const leased = await promisify(execFile)(
    join(homedir(), ".local/bin/secrets"),
    ["--no-update-check", "lease", "egghead-cb::fixture_admin_url", "--ttl", "2h"],
    { encoding: "utf8" },
  );
  const url = new URL(leased.stdout.trim());
  url.searchParams.delete("sslaccept");
  assert.ok(url.hostname.endsWith(".connect.psdb.cloud"), "fixture must be PlanetScale");
  process.env["EGGHEAD_RUNTIME"] = "production";
  delete process.env[PROGRESS_IMPORT_PRODUCTION_APPROVAL_ENV];
  await assert.rejects(
    openProgressImportDatabase({
      apply: true,
      rawUrl: url.toString(),
      confirmDatabase: url.pathname.slice(1),
    }),
    /PRODUCTION_APPROVED/,
  );
  process.env[PROGRESS_IMPORT_PRODUCTION_APPROVAL_ENV] = "true";
  await assert.rejects(
    openProgressImportDatabase({
      apply: true,
      rawUrl: url.toString(),
      confirmDatabase: "not-the-connected-database",
    }),
    /confirm-database/,
  );
  const { db, identity } = await openProgressImportDatabase({
    apply: true,
    rawUrl: url.toString(),
    confirmDatabase: url.pathname.slice(1),
  });
  const prefix = `progress-proof-${randomUUID()}`;
  const lessonId = `${prefix}-lesson`;
  const cbIds = Array.from({ length: 51 }, (_, index) => `${prefix}-${index + 1}`);
  const source = memoryRailsProgressSource(
    cbIds.map((_, index) => ({
      railsUserId: 900000001 + index,
      lastActiveAt: null,
      email: `${prefix}-${index + 1}@example.test`,
      lessons: [{ railsLessonId: 1, slug: null, completedAt: new Date("2024-01-01T00:00:00Z") }],
      series: [],
    })),
  );
  const catalog = {
    lessonByRailsId: new Map([[1, lessonId]]),
    lessonBySlug: new Map<string, string>(),
    courseByRailsPlaylistId: new Map<number, string>(),
    courseBySlug: new Map<string, string>(),
    stats: {
      lessonRows: 1,
      lessonRowsWithRailsId: 1,
      duplicateLessonRowsForRailsId: 0,
      courseRows: 0,
      courseRowsWithRailsPlaylistId: 0,
    },
  };
  const marks = cbIds.map(() => "?").join(",");
  const count = async () => {
    const [rows] = await db.query(
      `SELECT COUNT(*) AS n FROM egghead_ResourceProgress WHERE userId IN (${marks})`,
      cbIds,
    );
    return z.array(z.object({ n: z.coerce.number() })).parse(rows)[0]?.n ?? 0;
  };
  let seeded = false;
  try {
    const [triggers] = await db.query(
      "SELECT TRIGGER_NAME FROM information_schema.triggers WHERE TRIGGER_SCHEMA = DATABASE()",
    );
    assert.equal(z.array(z.unknown()).parse(triggers).length, 0, "fixture triggers must be absent");
    // Refuse collisions rather than cleaning up work this run does not own.
    const [existingUsers] = await db.query(
      `SELECT id FROM egghead_User WHERE id IN (${marks})`,
      cbIds,
    );
    const [existingContent] = await db.query(
      "SELECT id FROM egghead_ContentResource WHERE id = ?",
      [lessonId],
    );
    assert.equal(z.array(z.unknown()).parse(existingUsers).length, 0);
    assert.equal(z.array(z.unknown()).parse(existingContent).length, 0);
    assert.equal(await count(), 0);
    // Do not claim legacy ids in this shared fixture. Email matching suffices.
    seeded = true;
    console.log("Seeding synthetic users");
    await Array.from(cbIds.entries()).reduce<Promise<unknown>>(
      (previous, [index, id]) =>
        previous.then(() =>
          db.execute(
            "INSERT INTO egghead_User (id,email,name,role,fields) VALUES (?,?,?,'user','{}')",
            [id, `${prefix}-${index + 1}@example.test`, "Synthetic progress fixture"],
          ),
        ),
      Promise.resolve(),
    );
    console.log("Seeding synthetic content");
    await db.execute(
      "INSERT INTO egghead_ContentResource (id,type,createdById,fields) VALUES (?,'lesson',?,'{}')",
      [lessonId, cbIds[0] ?? "missing-synthetic-author"],
    );
    console.log("Fixture seeded; starting dry run");
    const dry = await runProgressImport({ db, source, catalog, apply: false });
    assert.equal(dry.users.seen, 51);
    assert.equal(dry.rows.toInsert, 51);
    assertDryRunReceiptMatches(
      JSON.stringify(importOutput({ identity, sourceSha256: "fixture", receipt: dry })),
      "fixture",
      identity,
    );
    let manifest = "";
    const runId = `${prefix}-apply`;
    const pauses: number[] = [];
    const apply = () =>
      runProgressImport({
        db,
        source,
        catalog,
        apply: true,
        insertsOnly: true,
        runId,
        maxUsers: 50,
        batchSize: 19,
        maxRowsPerTransaction: 7,
        pauseMs: 5,
        sleep: async (ms) => {
          pauses.push(ms);
        },
        onBeforeWrite: (entry) => {
          assert.ok(
            entry.cbUserIds.every((id) => cbIds.includes(id)),
            "fixture must never write another run's users",
          );
          manifest += `${JSON.stringify(entry)}\n`;
        },
      });
    console.log("Dry run bound; starting canary");
    const first = await apply();
    assert.equal(first.users.seen, 50);
    assert.equal(first.rows.inserted, 50);
    assert.equal(first.rows.updated, 0);
    assert.equal(first.lastRailsUserId, 900000050);
    assert.equal(await count(), 50);
    assert.equal(pauses.length, first.transactions - 1);
    assert.ok(pauses.every((ms) => ms === 5));
    const manifested = manifestUserIds(manifest, runId).toSorted();
    assert.deepEqual(manifested, cbIds.slice(0, 50).toSorted());
    console.log("Canary and manifest verified; starting rollback");
    const undo = await rollbackProgressImport({ db, runId, apply: true, userIds: manifested });
    assert.equal(undo.deleted, 50);
    assert.equal(undo.restored, 0);
    assert.equal(await count(), 0);
    manifest = "";
    console.log("Rollback verified; starting re-apply");
    const second = await apply();
    assert.equal(second.rows.inserted, 50, "re-apply receipt inserts");
    assert.equal(await count(), 50);
    // A new run must stop on existing rows without writing or updating them.
    await assert.rejects(
      runProgressImport({
        db,
        source,
        catalog,
        apply: true,
        insertsOnly: true,
        runId: `${prefix}-conflict`,
      }),
      /unpredicted existing/,
    );
    assert.equal(await count(), 50);
    // The original run may resume an unchanged partially committed batch.
    const resumed = await apply();
    assert.equal(resumed.rows.inserted, 0);
    assert.equal(await count(), 50);
    const raceUser = cbIds[50];
    assert.ok(raceUser);
    await assert.rejects(
      runProgressImport({
        db,
        source,
        catalog,
        apply: true,
        insertsOnly: true,
        runId: `${prefix}-race`,
        afterRailsUserId: 900000050,
        onBeforeWrite: async (entry) => {
          assert.deepEqual(entry.cbUserIds, [raceUser]);
          await db.execute(
            "INSERT INTO egghead_ResourceProgress (userId,resourceId,fields) VALUES (?, ?, JSON_OBJECT('source','fixture_race'))",
            [raceUser, lessonId],
          );
        },
      }),
      /transaction failed.*rolled back/,
    );
    const [raced] = await db.query(
      "SELECT completedAt, JSON_UNQUOTE(JSON_EXTRACT(fields, '$.source')) AS source FROM egghead_ResourceProgress WHERE userId = ? AND resourceId = ?",
      [raceUser, lessonId],
    );
    assert.deepEqual(
      z.array(z.object({ completedAt: z.null(), source: z.string() })).parse(raced),
      [{ completedAt: null, source: "fixture_race" }],
    );
    assert.equal(await count(), 51);
    await db.execute("DELETE FROM egghead_ResourceProgress WHERE userId = ? AND resourceId = ?", [
      raceUser,
      lessonId,
    ]);
    assert.equal(await count(), 50);
    console.log(
      "PASS fixture: production gate; 51 source users, 50-user canary; exact manifest; rollback 50; re-apply 50; conflict stops; duplicate race rolls back without updating CB state; same-run resume; pacing",
    );
  } catch (error) {
    const message: unknown =
      error && typeof error === "object" ? Reflect.get(error, "sqlMessage") : null;
    if (typeof message === "string") {
      // Diagnostic stays local and strips every part of the leased identity.
      let redacted = message;
      for (const secret of [
        url.toString(),
        url.hostname,
        decodeURIComponent(url.username),
        decodeURIComponent(url.password),
        url.pathname.slice(1),
      ]) {
        if (secret) redacted = redacted.replaceAll(secret, "[redacted]");
      }
      console.error(redacted);
    }
    throw error;
  } finally {
    if (seeded) {
      await db.execute(`DELETE FROM egghead_ResourceProgress WHERE userId IN (${marks})`, cbIds);
      await db.execute("DELETE FROM egghead_ContentResource WHERE id = ?", [lessonId]);
      await db.execute(`DELETE FROM egghead_User WHERE id IN (${marks})`, cbIds);
      assert.equal(await count(), 0);
      console.log("PASS fixture cleanup: only this run's synthetic rows removed");
    }
    await db.end();
  }
}

main().catch((error: unknown) => {
  // mysql errors can carry connection details; print only a server error code,
  // never SQL, connection options or the leased URL.
  const code: unknown = error && typeof error === "object" ? Reflect.get(error, "code") : null;
  console.error(
    "Progress fixture proof failed",
    typeof code === "string" && /^[A-Z_]+$/.test(code) ? code : "(details withheld)",
  );
  if (error instanceof assert.AssertionError) console.error(error.message);
  process.exitCode = 1;
});
