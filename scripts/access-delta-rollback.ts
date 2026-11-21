// Dry-run by default. Uses the same target/write guards as access:delta.
import { readFile, writeFile, rename, chmod } from "node:fs/promises";
import { parseArgs } from "node:util";
import { parseOnlyUsers } from "../apps/web/src/access/rails-access-delta-canary";
import {
  databaseUserSha256,
  hostSha256,
  parseCursor,
  parsePlan,
} from "../apps/web/src/access/rails-access-delta-plan";
import {
  rollbackRows,
  undoForOps,
  rowHash,
} from "../apps/web/src/access/rails-access-delta-rollback";
import { getEggheadDatabase } from "../apps/web/src/db/adapter";
import {
  assertCommerceWritesAllowed,
  assertDatabaseUrlForRuntime,
  getEggheadMysqlPool,
} from "../apps/web/src/db/local-docker";

async function main() {
  if (new Date().getTimezoneOffset() !== 0) throw new Error("set TZ=UTC");
  const { values } = parseArgs({
    options: {
      plan: { type: "string" },
      applied: { type: "string" },
      apply: { type: "boolean", default: false },
      "only-users": { type: "string" },
      "expect-plan": { type: "string" },
      "confirm-database": { type: "string" },
    },
    strict: true,
  });
  if (!values.plan || !values.applied)
    throw new Error(
      "usage: access:delta:rollback --plan <plan.json> --applied <cursor.json> [--apply --expect-plan <sha> --confirm-database <db>] [--only-users <file>]",
    );
  const plan = parsePlan(await readFile(values.plan, "utf8"));
  const cursor = parseCursor(await readFile(values.applied, "utf8"));
  const safety = values.apply ? assertCommerceWritesAllowed() : assertDatabaseUrlForRuntime();
  if (
    plan.database !== safety.database ||
    plan.runtime !== safety.runtime ||
    plan.hostSha256 !== hostSha256(safety.host) ||
    plan.databaseUserSha256 !== databaseUserSha256(decodeURIComponent(safety.url.username))
  )
    throw new Error("rollback target identity differs from reviewed plan");
  if (
    values.apply &&
    (values["expect-plan"] !== plan.planSha256 || values["confirm-database"] !== safety.database)
  )
    throw new Error("rollback writes need --expect-plan and --confirm-database matching the plan");
  if (
    cursor.planSha256 !== plan.planSha256 ||
    cursor.exportSha256 !== plan.exportSha256 ||
    cursor.database !== plan.database ||
    cursor.totalOps !== plan.ops.length
  )
    throw new Error("applied cursor belongs to another plan");
  const onlyUsers = values["only-users"]
    ? parseOnlyUsers(await readFile(values["only-users"], "utf8"))
    : undefined;
  if (JSON.stringify(onlyUsers) !== JSON.stringify(plan.onlyUsers))
    throw new Error("--only-users must match the reviewed canary plan");
  if (!plan.undoRows || !cursor.undoRows)
    throw new Error("no rollback images/proof; refusing to guess");
  const allowed = undoForOps(plan.undoRows, plan.ops);
  for (const row of cursor.undoRows) {
    const baseline = allowed.find((entry) => entry.table === row.table && entry.id === row.id);
    if (!baseline || rowHash(baseline.before) !== rowHash(row.before))
      throw new Error("cursor undo image differs from reviewed plan");
  }
  const db = getEggheadDatabase();
  try {
    const result = await rollbackRows(db, cursor.undoRows, values.apply);
    if (values.apply) {
      const file = `${values.applied}.rollback.json`;
      await writeFile(
        `${file}.tmp`,
        JSON.stringify({ planSha256: plan.planSha256, ...result, at: new Date().toISOString() }) +
          "\n",
        { mode: 0o600 },
      );
      await chmod(`${file}.tmp`, 0o600);
      await rename(`${file}.tmp`, file);
    }
    console.log(
      JSON.stringify({
        mode: values.apply ? "rollback" : "dry-run",
        planSha256: plan.planSha256,
        ...result,
      }),
    );
  } finally {
    await getEggheadMysqlPool().end();
  }
}
main().catch((error: unknown) => {
  console.error(`access-delta-rollback: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
