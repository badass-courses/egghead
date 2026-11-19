/**
 * Undo one progress import run.
 *
 *   pnpm progress:import:rollback --run <runId>           # dry run: counts only
 *   pnpm progress:import:rollback --run <runId> --apply   # delete inserts, restore updates
 *
 * The runId is in the import receipt. Rows CB changed after the import are left
 * alone and reported as changedSinceImport. Same database guards as the import:
 * beta writes need EGGHEAD_PROGRESS_IMPORT_APPLY_APPROVED=true.
 */
import { parseArgs } from "node:util";

import { openProgressImportDatabase } from "../apps/web/src/progress/import-db";
import { rollbackProgressImport } from "../apps/web/src/progress/import-rollback";

async function main() {
  const { values } = parseArgs({
    options: {
      run: { type: "string" },
      apply: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (!values.run) throw new Error("--run <runId> is required (from the import receipt)");

  const { db, target } = await openProgressImportDatabase({ apply: values.apply });
  try {
    const receipt = await rollbackProgressImport({ db, runId: values.run, apply: values.apply });
    console.log(JSON.stringify({ target, receipt }, null, 2));
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
