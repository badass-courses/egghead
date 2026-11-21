// Explicit destructive rehearsal ONLY on the fixture credential leased below.
// No URL is accepted from argv or printed. Never use live/beta credentials here.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { parseRailsAccessExport } from "../apps/web/src/access/rails-access-delta";
import {
  newCursor,
  planSha256,
  databaseUserSha256,
} from "../apps/web/src/access/rails-access-delta-plan";
import {
  captureUndo,
  rollbackRows,
  rowHash,
} from "../apps/web/src/access/rails-access-delta-rollback";
import { applyDeltaOps } from "../apps/web/src/access/rails-access-delta-store";
import { analyzeDatabase } from "./access-delta-run";
import {
  FIXTURE_TABLES,
  julyCourseBuilder,
  novemberExportText,
  NOW_ISO,
} from "./access-delta.fixtures";

async function main() {
  const leased = await promisify(execFile)(
    path.join(homedir(), ".local/bin/secrets"),
    ["--no-update-check", "lease", "egghead-cb::fixture_admin_url", "--ttl", "2h"],
    { encoding: "utf8" },
  );
  const url = new URL(leased.stdout.trim());
  url.searchParams.delete("sslaccept");
  assert.ok(url.hostname.endsWith(".connect.psdb.cloud"), "fixture must be PlanetScale");
  const options = {
    host: url.hostname,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    ssl: { rejectUnauthorized: true },
  };
  if (!process.argv.includes("--suite-only")) {
    process.env["DATABASE_URL"] = url.toString();
    process.env["EGGHEAD_RUNTIME"] = "production";
    const { getEggheadMysqlPool } = await import("../apps/web/src/db/local-docker");
    const pool = getEggheadMysqlPool();
    const db = (await import("../apps/web/src/db/adapter")).getEggheadDatabase();
    const out = path.join(
      homedir(),
      ".local/state/egghead-access-delta",
      `fixture-proof-${Date.now()}`,
    );
    await mkdir(out, { recursive: true, mode: 0o700 });
    try {
      const [triggers] = await pool.query(
        "SELECT TRIGGER_NAME, EVENT_MANIPULATION, EVENT_OBJECT_TABLE, ACTION_STATEMENT FROM information_schema.triggers WHERE TRIGGER_SCHEMA = DATABASE()",
      );
      assert.ok(Array.isArray(triggers));
      assert.equal(triggers.length, 0, "fixture has DB triggers; stop before seeding");
      console.log("DB triggers: 0 (information_schema.triggers, current fixture database)");
      await Promise.all(
        FIXTURE_TABLES.map(async (table) => {
          const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
          const counts = z.array(z.object({ n: z.number() })).parse(rows);
          assert.equal(counts[0]?.n, 0, "fixture must start empty; never clear unknown rows");
        }),
      );
      const seed = julyCourseBuilder();
      await Promise.all(
        seed.users.map((user) =>
          pool.query("INSERT INTO egghead_User (id,email,name,role,fields) VALUES (?,?,?,?,?)", [
            user.id,
            user.email,
            user.name,
            user.role,
            JSON.stringify(user.fields),
          ]),
        ),
      );
      await Promise.all(
        seed.organizations.map((org) =>
          pool.query("INSERT INTO egghead_Organization (id,name,fields) VALUES (?,?,?)", [
            org.id,
            org.name,
            JSON.stringify(org.fields),
          ]),
        ),
      );
      await Promise.all(
        seed.memberships.map((member) =>
          pool.query(
            "INSERT INTO egghead_OrganizationMembership (id,organizationId,userId,invitedById,role,fields) VALUES (?,?,?,?,?,?)",
            [
              member.id,
              member.organizationId,
              member.userId,
              member.invitedById,
              member.role,
              JSON.stringify(member.fields),
            ],
          ),
        ),
      );
      await Promise.all(
        seed.entitlements.map((row) =>
          pool.query(
            "INSERT INTO egghead_Entitlement (id,entitlementType,userId,organizationId,organizationMembershipId,sourceType,sourceId,metadata,expiresAt,deletedAt) VALUES (?,?,?,?,?,?,?,?,?,?)",
            [
              row.id,
              row.entitlementType,
              row.userId,
              row.organizationId,
              row.organizationMembershipId,
              row.sourceType,
              row.sourceId,
              JSON.stringify(row.metadata),
              row.expiresAt ? new Date(row.expiresAt) : null,
              row.deletedAt ? new Date(row.deletedAt) : null,
            ],
          ),
        ),
      );
      const snapshot = async () => {
        const result: Record<string, unknown> = {};
        await Promise.all(
          FIXTURE_TABLES.map(async (table) => {
            const [rows] = await pool.query(`SELECT * FROM \`${table}\` ORDER BY id`);
            result[table] = rows;
          }),
        );
        return result;
      };
      const before = await snapshot();
      const rails = parseRailsAccessExport(novemberExportText());
      const analysis = await analyzeDatabase(db, rails, Date.parse(NOW_ISO), {
        pageSize: 3,
        chunkSize: 2,
        concurrency: 1,
        consistent: false,
      });
      const undoRows = await captureUndo(db, analysis.plan.ops);
      const plan = {
        exportSha256: rails.sha256,
        database: options.database,
        planSha256: planSha256(analysis.plan.ops),
        ops: analysis.plan.ops,
      };
      const apply = () =>
        applyDeltaOps(db, plan.ops, newCursor(plan, NOW_ISO), {
          batchSize: 5,
          undoRows,
          now: () => new Date(NOW_ISO),
          saveCursor: async (cursor) => {
            await writeFile(path.join(out, "cursor.json"), JSON.stringify(cursor), { mode: 0o600 });
          },
        });
      const cursor = await apply();
      assert.ok(cursor.complete);
      assert.ok(cursor.undoRows);
      console.log(`Seed/apply: ${cursor.appliedOps} ops, ${cursor.undoRows.length} touched rows`);
      const afterApplyRows = await snapshot();
      const afterApply = rowHash(afterApplyRows);
      assert.equal((await rollbackRows(db, cursor.undoRows)).applied, false);
      assert.equal(rowHash(await snapshot()), afterApply, "dry run stable");
      // Race proof: an edit to any post-apply row refuses the whole rollback.
      const first = cursor.undoRows.find(
        (row) => row.table === "egghead_User" && row.before === null,
      );
      assert.ok(first);
      await pool.query("UPDATE egghead_User SET name = 'raced fixture' WHERE id = ?", [first.id]);
      await assert.rejects(rollbackRows(db, cursor.undoRows, true), /changed since apply/);
      // Restore our own deliberate edit exactly, then run the undo.
      const post = await captureUndo(db, plan.ops);
      const changed = post.find((row) => row.table === first.table && row.id === first.id);
      assert.ok(changed?.before);
      const originalName = plan.ops.find(
        (op) => op.kind === "user_create" && op.user.id === first.id,
      );
      assert.ok(originalName?.kind === "user_create");
      const savedUsers = z
        .array(z.record(z.string(), z.unknown()))
        .parse(afterApplyRows["egghead_User"]);
      const savedUser = savedUsers.find((row) => row["id"] === first.id);
      assert.ok(savedUser);
      await pool.query("UPDATE egghead_User SET name = ?, updatedAt = ? WHERE id = ?", [
        originalName.user.name,
        savedUser["updatedAt"],
        first.id,
      ]);
      await pool.query(
        "INSERT INTO egghead_OrganizationMembership (id,organizationId,userId,invitedById,role,fields) VALUES ('topup-new-reference',?,?,?,?, '{}')",
        [seed.organizations[0]?.id, first.id, first.id, "member"],
      );
      const withReference = rowHash(await snapshot());
      await assert.rejects(rollbackRows(db, cursor.undoRows, true), /new references/);
      assert.equal(rowHash(await snapshot()), withReference, "refused rollback is atomic");
      await pool.query(
        "DELETE FROM egghead_OrganizationMembership WHERE id = 'topup-new-reference'",
      );
      await rollbackRows(db, cursor.undoRows, true);
      assert.equal(rowHash(await snapshot()), rowHash(before), "all four tables match row for row");
      console.log("Rollback: all four touched tables match seed row for row; raced edit refused");
      const second = await apply();
      assert.ok(second.complete);
      console.log(`Apply again: ${second.appliedOps} ops; PASS`);
      console.log(`Private fixture artifacts: ${out}`);
    } finally {
      await pool.end();
    }
  }
  // Existing suite is destructive only on this exact, in-process leased user.
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--test",
        "scripts/access-delta.test.ts",
        "scripts/access-delta-topup.test.ts",
      ],
      {
        env: {
          ...process.env,
          ACCESS_DELTA_MYSQL_URL: url.toString(),
          ACCESS_DELTA_MYSQL_FIXTURE_USER_SHA256: databaseUserSha256(options.user),
          TSX_TSCONFIG_PATH: "apps/web/tsconfig.json",
          TZ: "UTC",
        },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(code, 0, "existing MySQL suite must pass");
}
main().catch((error: unknown) => {
  console.error(
    "Fixture proof failed (credentials redacted)",
    error instanceof assert.AssertionError
      ? error.message
      : error instanceof Error
        ? error.name
        : "unknown error",
  );
  process.exitCode = 1;
});
