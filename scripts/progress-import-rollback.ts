/**
 * Undo one progress import run, in small per-user-batch transactions.
 *
 *   pnpm progress:import:rollback --run <runId> --manifest import.cursor.json.manifest.jsonl
 *   pnpm progress:import:rollback --run <runId> --manifest … --apply --cursor rollback.cursor.json
 *
 * The runId is printed at import start and saved in the import cursor. With
 * `--manifest` only the CB users the run wrote are touched; without it the
 * rollback walks the table by `userId`. `--cursor` makes an apply resumable.
 * Rows CB changed after the import are left alone (`changedSinceImport`).
 * Same database guards as the import: beta writes need
 * EGGHEAD_PROGRESS_IMPORT_APPLY_APPROVED=true.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { manifestUserIds, parseRollbackCursor } from "../apps/web/src/progress/import-cli";
import { openProgressImportDatabase } from "../apps/web/src/progress/import-db";
import { rollbackProgressImport } from "../apps/web/src/progress/import-rollback";

async function main() {
  const { values } = parseArgs({
    options: {
      run: { type: "string" },
      apply: { type: "boolean", default: false },
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
  if (cursor && cursor.runId !== runId) {
    throw new Error(
      `Rollback cursor ${values.cursor} belongs to run ${cursor.runId}, not ${runId}.`,
    );
  }
  const batchUsers =
    values["batch-users"] === undefined ? undefined : Number(values["batch-users"]);

  const { db, target } = await openProgressImportDatabase({ apply: values.apply });
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
          writeFileSync(
            values.cursor,
            `${JSON.stringify({ runId, lastUserId, updatedAt: new Date().toISOString() })}\n`,
            "utf8",
          );
        }
        console.error(
          `rollback ${runId} batch ${progress.batches}: deleted ${progress.deleted}, restored ${progress.restored}, changed ${progress.changedSinceImport}`,
        );
      },
    });
    console.log(JSON.stringify({ target, receipt }, null, 2));
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
