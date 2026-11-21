/**
 * Undo one progress import run, in small per-user-batch transactions.
 *
 *   pnpm progress:import:rollback --run <runId> --manifest import.cursor.json.manifest.jsonl
 *   pnpm progress:import:rollback --run <runId> --manifest … --apply --cursor rollback.cursor.json
 *
 * The runId is printed at import start and saved in the import cursor. With
 * `--manifest` only the CB users the run wrote are touched; without it the
 * rollback walks the table by `userId`. `--cursor` makes an apply resumable;
 * a cursor resumes only the same run and the same mode (manifest or walk).
 * Rows CB changed after the import are left alone (`changedSinceImport`).
 * Same database guards as the import: beta writes need
 * EGGHEAD_PROGRESS_IMPORT_APPLY_APPROVED=true.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  assertRollbackCursorFits,
  manifestUserIds,
  parseRollbackCursor,
  progressImportTarget,
  type RollbackCursor,
} from "../apps/web/src/progress/import-cli";
import { openProgressImportDatabase } from "../apps/web/src/progress/import-db";
import { rollbackProgressImport } from "../apps/web/src/progress/import-rollback";

async function main() {
  const { values } = parseArgs({
    options: {
      run: { type: "string" },
      apply: { type: "boolean", default: false },
      "confirm-database": { type: "string" },
      manifest: { type: "string" },
      cursor: { type: "string" },
      "batch-users": { type: "string" },
    },
    strict: true,
  });

  if (!values.run) throw new Error("--run <runId> is required (printed at import start)");
  const runId = values.run;
  const userIds = values.manifest
    ? manifestUserIds(readFileSync(values.manifest, "utf8"), runId)
    : undefined;
  const cursor =
    values.cursor && existsSync(values.cursor)
      ? parseRollbackCursor(readFileSync(values.cursor, "utf8"), `Rollback cursor ${values.cursor}`)
      : null;
  const scope = userIds ? "manifest" : "table_scan";
  if (cursor) assertRollbackCursorFits(cursor, { runId, scope });
  const batchUsers =
    values["batch-users"] === undefined ? undefined : Number(values["batch-users"]);

  const { db, identity } = await openProgressImportDatabase({
    apply: values.apply,
    confirmDatabase: values["confirm-database"],
  });
  try {
    const receipt = await rollbackProgressImport({
      db,
      runId,
      apply: values.apply,
      ...(userIds ? { userIds } : {}),
      ...(cursor ? { afterUserId: cursor.lastUserId } : {}),
      ...(batchUsers === undefined ? {} : { batchUsers }),
      onBatch: ({ lastUserId, receipt: progress }) => {
        if (values.apply && values.cursor) {
          const next: RollbackCursor = {
            runId,
            scope,
            lastUserId,
            updatedAt: new Date().toISOString(),
          };
          writeFileSync(values.cursor, `${JSON.stringify(next)}\n`, "utf8");
        }
        console.error(
          `rollback ${runId} batch ${progress.batches}: deleted ${progress.deleted}, restored ${progress.restored}, changed ${progress.changedSinceImport}`,
        );
      },
    });
    console.log(JSON.stringify({ target: progressImportTarget(identity), receipt }, null, 2));
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
