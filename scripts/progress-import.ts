/**
 * Rails → CourseBuilder progress import.
 *
 * 1. Dry run over the whole file (writes nothing, prints a receipt):
 *
 *      pnpm progress:import --source rails-progress.jsonl --receipt dry-run.json
 *
 * 2. Apply. Needs that full-file dry-run receipt for the same file and a cursor
 *    file. The runId is printed to stderr at start and saved in the cursor; a
 *    resume with the same cursor reuses it, so one import has one runId. Before
 *    each write the CB user ids go to the manifest (`<cursor>.manifest.jsonl`),
 *    which `pnpm progress:import:rollback` uses to undo the run.
 *
 *      pnpm progress:import --source rails-progress.jsonl --apply \
 *        --expect-dry-run dry-run.json --cursor import.cursor.json --receipt apply.json
 *
 * 3. One user (the on-demand path): add `--user <cbUserId>`.
 *
 * The target database comes from DATABASE_URL and the app's runtime guard
 * (`EGGHEAD_RUNTIME`). Local runs need a local `_test` or `_local` MySQL. Beta
 * reads need EGGHEAD_BETA_DB_APPROVED=true; beta writes also need
 * EGGHEAD_PROGRESS_IMPORT_APPLY_APPROVED=true. Production is refused.
 */
import { createHash } from "node:crypto";
import { appendFileSync, createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  DEFAULT_PROGRESS_IMPORT_BATCH_SIZE,
  importProgressForUser,
  newProgressImportRunId,
  runProgressImport,
} from "../apps/web/src/progress/import";
import {
  assertDryRunReceiptMatches,
  type ImportCursor,
  parseImportCursor,
} from "../apps/web/src/progress/import-cli";
import { openProgressImportDatabase } from "../apps/web/src/progress/import-db";
import { jsonlRailsProgressSource } from "../apps/web/src/progress/import-source";

function nonNegativeIntegerOption(name: string, value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`--${name} must be a non-negative integer, got ${value}`);
  }
  return number;
}

/** Identifies the export by content, so a new export at the same path cannot reuse a cursor. */
async function sha256File(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      apply: { type: "boolean", default: false },
      "expect-dry-run": { type: "string" },
      cursor: { type: "string" },
      manifest: { type: "string" },
      after: { type: "string" },
      "batch-size": { type: "string" },
      "max-users": { type: "string" },
      receipt: { type: "string" },
      user: { type: "string" },
    },
    strict: true,
  });

  if (!values.source) throw new Error("--source <rails-progress.jsonl> is required");
  if (!existsSync(values.source)) throw new Error(`--source file not found: ${values.source}`);
  if (values.cursor && values.after !== undefined) {
    throw new Error(
      "Use --cursor or --after, not both: the cursor already records where to resume.",
    );
  }

  const source = jsonlRailsProgressSource(values.source);
  const sourceSha256 = await sha256File(values.source);

  if (values.apply) {
    if (!values["expect-dry-run"]) {
      throw new Error(
        "--apply needs --expect-dry-run <receipt> from a finished dry run over this whole file.",
      );
    }
    assertDryRunReceiptMatches(readFileSync(values["expect-dry-run"], "utf8"), sourceSha256);
    if (!values.user && !values.cursor) {
      throw new Error(
        "--apply needs --cursor <file> so the runId and resume point survive a crash.",
      );
    }
  }

  const { db, target } = await openProgressImportDatabase({ apply: values.apply });

  try {
    if (values.user) {
      const runId = newProgressImportRunId();
      console.error(`progress import runId ${runId}`);
      const result = await importProgressForUser(values.user, {
        db,
        source,
        apply: values.apply,
        runId,
      });
      const output = { target, sourceSha256, ...result };
      if (values.receipt) writeJson(values.receipt, output);
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    const cursor =
      values.cursor && existsSync(values.cursor)
        ? parseImportCursor(readFileSync(values.cursor, "utf8"), `Cursor file ${values.cursor}`)
        : null;
    if (cursor && cursor.sourceSha256 !== sourceSha256) {
      throw new Error(
        `Cursor ${values.cursor} belongs to a different export (sha256 ${cursor.sourceSha256.slice(0, 12)}…, this file ${sourceSha256.slice(0, 12)}…). Use a new cursor file per export.`,
      );
    }

    const runId = cursor?.runId ?? newProgressImportRunId();
    const afterRailsUserId =
      nonNegativeIntegerOption("after", values.after) ?? cursor?.lastRailsUserId ?? 0;
    const maxUsers = nonNegativeIntegerOption("max-users", values["max-users"]);
    const manifestPath =
      values.manifest ?? (values.cursor ? `${values.cursor}.manifest.jsonl` : undefined);
    console.error(
      cursor
        ? `progress import runId ${runId} (resuming after railsUserId ${afterRailsUserId})`
        : `progress import runId ${runId}`,
    );

    const saveCursor = (lastRailsUserId: number) => {
      if (!values.cursor) return;
      const next: ImportCursor = {
        runId,
        lastRailsUserId,
        source: source.description,
        sourceSha256,
        updatedAt: new Date().toISOString(),
      };
      writeJson(values.cursor, next);
    };
    // Persist the runId before anything is written.
    if (values.apply) saveCursor(afterRailsUserId);

    const receipt = await runProgressImport({
      db,
      source,
      apply: values.apply,
      runId,
      afterRailsUserId,
      batchSize:
        nonNegativeIntegerOption("batch-size", values["batch-size"]) ??
        DEFAULT_PROGRESS_IMPORT_BATCH_SIZE,
      ...(maxUsers === undefined ? {} : { maxUsers }),
      onBeforeWrite: ({ cbUserIds }) => {
        if (manifestPath) {
          appendFileSync(manifestPath, `${JSON.stringify({ runId, cbUserIds })}\n`, "utf8");
        }
      },
      onBatchCommitted: ({ lastRailsUserId, receipt: progress }) => {
        saveCursor(lastRailsUserId);
        console.error(
          `runId ${runId} batch ${progress.batches}: through railsUserId ${lastRailsUserId}, inserted ${progress.rows.inserted}, updated ${progress.rows.updated}`,
        );
      },
    });

    const output = { target, sourceSha256, receipt };
    if (values.receipt) writeJson(values.receipt, output);
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
