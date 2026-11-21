/**
 * Rails → CourseBuilder progress import.
 *
 * 1. Dry run over the whole file (writes nothing, prints a receipt):
 *
 *      pnpm progress:import --source rails-progress.jsonl --receipt dry-run.json
 *
 * 2. Apply. Needs that full-file dry-run receipt for the same file and the
 *    same connection (host, port, user and database: on PlanetScale the user
 *    picks the branch), and a cursor file. The runId is printed to stderr at
 *    start and saved in the cursor; a resume with the same cursor reuses it, so one import has one runId. Before
 *    each write the CB user ids go to the manifest (`<cursor>.manifest.jsonl`),
 *    which `pnpm progress:import:rollback` uses to undo the run.
 *
 *      pnpm progress:import --source rails-progress.jsonl --apply \
 *        --expect-dry-run dry-run.json --cursor import.cursor.json --receipt apply.json
 *
 * 3. One user (the on-demand path): add `--user <cbUserId>`.
 *
 * `--unmapped-out <file>` writes every distinct Rails lesson and series with
 * no CB row, as JSON lines with ids, slugs and how many matched learners
 * completed it. No learner data.
 *
 * `--max-rows-per-transaction` lowers the per-transaction write cap (default
 * 5,000) if a target's transactions run long; the receipt's `timings` shows
 * the slowest one.
 *
 * The target database comes from DATABASE_URL and the app's runtime guard
 * (`EGGHEAD_RUNTIME`). Local runs need a local `_test` or `_local` MySQL. Beta
 * reads need EGGHEAD_BETA_DB_APPROVED=true; beta writes also need
 * EGGHEAD_PROGRESS_IMPORT_APPLY_APPROVED=true. Production writes require
 * EGGHEAD_PROGRESS_IMPORT_PRODUCTION_APPROVED=true and --confirm-database
 * matching SELECT DATABASE(), plus a conflict-free inserts-only dry-run receipt.
 * --pause-ms sleeps between write transactions (default 0).
 */
import { createHash } from "node:crypto";
import { appendFileSync, createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  DEFAULT_PROGRESS_IMPORT_BATCH_SIZE,
  importProgressForUser,
  UnmappedContentTally,
  newProgressImportRunId,
  runProgressImport,
} from "../apps/web/src/progress/import";
import {
  assertDryRunReceiptMatches,
  type ImportCursor,
  importOutput,
  parseImportCursor,
  resolveImportStart,
} from "../apps/web/src/progress/import-cli";
import { openProgressImportDatabase } from "../apps/web/src/progress/import-db";
import { jsonlRailsProgressSource } from "../apps/web/src/progress/import-source";

function nonNegativeIntegerOption(name: string, value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
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
      "confirm-database": { type: "string" },
      "pause-ms": { type: "string" },
      "expect-dry-run": { type: "string" },
      cursor: { type: "string" },
      manifest: { type: "string" },
      after: { type: "string" },
      "batch-size": { type: "string" },
      "max-rows-per-transaction": { type: "string" },
      "unmapped-out": { type: "string" },
      "max-users": { type: "string" },
      receipt: { type: "string" },
      user: { type: "string" },
    },
    strict: true,
  });

  if (!values.source) throw new Error("--source <rails-progress.jsonl> is required");
  if (!existsSync(values.source)) throw new Error(`--source file not found: ${values.source}`);
  const after = nonNegativeIntegerOption("after", values.after);

  const source = jsonlRailsProgressSource(values.source);
  const sourceSha256 = await sha256File(values.source);
  const expectDryRun = values["expect-dry-run"];

  if (values.apply) {
    if (!expectDryRun) {
      throw new Error(
        "--apply needs --expect-dry-run <receipt> from a finished dry run over this whole file.",
      );
    }
    if (!values.user && !values.cursor) {
      throw new Error(
        "--apply needs --cursor <file> so the runId and resume point survive a crash.",
      );
    }
  }

  const pauseMs = nonNegativeIntegerOption("pause-ms", values["pause-ms"]) ?? 0;
  const { db, identity } = await openProgressImportDatabase({
    apply: values.apply,
    confirmDatabase: values["confirm-database"],
  });

  try {
    // Checked before any write: the receipt must be for this file and this database.
    if (values.apply && expectDryRun) {
      assertDryRunReceiptMatches(readFileSync(expectDryRun, "utf8"), sourceSha256, identity);
    }

    if (values.user && values["unmapped-out"]) {
      throw new Error("--unmapped-out lists the bulk run's gaps; it does not apply to --user.");
    }
    if (values.user) {
      const runId = newProgressImportRunId();
      console.error(`progress import runId ${runId}`);
      const result = await importProgressForUser(values.user, {
        db,
        source,
        apply: values.apply,
        insertsOnly: identity.runtime === "production",
        pauseMs,
        runId,
      });
      const output = {
        ...importOutput({ identity, sourceSha256, receipt: result.receipt }),
        status: result.status,
      };
      if (values.receipt) writeJson(values.receipt, output);
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    const cursor =
      values.cursor && existsSync(values.cursor)
        ? parseImportCursor(readFileSync(values.cursor, "utf8"), `Cursor file ${values.cursor}`)
        : null;
    const start = resolveImportStart({
      cursorGiven: values.cursor !== undefined,
      cursor,
      after,
      sourceSha256,
    });
    const runId = start.runId ?? newProgressImportRunId();
    const unmapped = new UnmappedContentTally();
    const { afterRailsUserId } = start;
    const maxUsers = nonNegativeIntegerOption("max-users", values["max-users"]);
    const maxRowsPerTransaction = nonNegativeIntegerOption(
      "max-rows-per-transaction",
      values["max-rows-per-transaction"],
    );
    if (maxRowsPerTransaction === 0) {
      throw new Error("--max-rows-per-transaction must be at least 1");
    }
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
      insertsOnly: identity.runtime === "production",
      pauseMs,
      runId,
      afterRailsUserId,
      batchSize:
        nonNegativeIntegerOption("batch-size", values["batch-size"]) ??
        DEFAULT_PROGRESS_IMPORT_BATCH_SIZE,
      ...(maxUsers === undefined ? {} : { maxUsers }),
      ...(maxRowsPerTransaction === undefined ? {} : { maxRowsPerTransaction }),
      unmapped,
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

    const unmappedOut = values["unmapped-out"];
    if (unmappedOut) {
      const lines = [
        ...unmapped.lessons().map((lesson) =>
          JSON.stringify({
            kind: "lesson",
            railsLessonId: lesson.railsLessonId,
            slug: lesson.slug,
            users: lesson.users,
          }),
        ),
        ...unmapped.series().map((series) =>
          JSON.stringify({
            kind: "series",
            railsPlaylistId: series.railsPlaylistId,
            railsSeriesId: series.railsSeriesId,
            slug: series.slug,
            users: series.users,
          }),
        ),
      ];
      writeFileSync(unmappedOut, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
      console.error(
        `unmapped: ${receipt.lessons.distinctUnmappedRailsLessonIds} lessons, ${receipt.series.distinctUnmapped} series → ${unmappedOut}`,
      );
    }

    const output = importOutput({ identity, sourceSha256, receipt });
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
