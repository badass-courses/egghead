/**
 * Rails → CourseBuilder progress import.
 *
 * Dry run (default): reads the export and the target CB database, writes nothing,
 * prints a receipt with counts and samples.
 *
 *   pnpm progress:import --source /path/rails-progress.jsonl
 *
 * Apply: writes CB-native completion rows in batches and saves a resume cursor
 * after every committed batch. Re-running with the same cursor file resumes.
 * The receipt's `runId` is what `pnpm progress:import:rollback` undoes.
 *
 *   pnpm progress:import --source /path/rails-progress.jsonl --apply \
 *     --cursor /path/progress-import.cursor.json --receipt /path/receipt.json
 *
 * One user (the on-demand path):
 *
 *   pnpm progress:import --source /path/rails-progress.jsonl --user <cbUserId>
 *
 * The target database comes from DATABASE_URL and the app's runtime guard
 * (`EGGHEAD_RUNTIME`). Local runs need a local `_test` or `_local` MySQL. Beta
 * reads need EGGHEAD_BETA_DB_APPROVED=true; beta writes also need
 * EGGHEAD_PROGRESS_IMPORT_APPLY_APPROVED=true. Production is refused.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";

import {
  DEFAULT_PROGRESS_IMPORT_BATCH_SIZE,
  importProgressForUser,
  runProgressImport,
} from "../apps/web/src/progress/import";
import { openProgressImportDatabase } from "../apps/web/src/progress/import-db";
import { jsonlRailsProgressSource } from "../apps/web/src/progress/import-source";

const cursorSchema = z.object({
  lastRailsUserId: z.number().int().nonnegative(),
  source: z.string(),
  sourceSha256: z.string(),
  updatedAt: z.string(),
});

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

function readCursor(path: string) {
  if (!existsSync(path)) return null;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Cursor file ${path} is not valid JSON. Fix or move it; nothing was written.`);
  }
  const parsed = cursorSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Cursor file ${path} is not a progress import cursor. Nothing was written.`);
  }
  return parsed.data;
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      apply: { type: "boolean", default: false },
      cursor: { type: "string" },
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
  const { db, target } = await openProgressImportDatabase({ apply: values.apply });

  try {
    if (values.user) {
      const result = await importProgressForUser(values.user, {
        db,
        source,
        apply: values.apply,
      });
      const output = { target, ...result };
      if (values.receipt) writeJson(values.receipt, output);
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    const sourceSha256 = await sha256File(values.source);
    const cursor = values.cursor ? readCursor(values.cursor) : null;
    if (cursor && cursor.sourceSha256 !== sourceSha256) {
      throw new Error(
        `Cursor ${values.cursor} belongs to a different export (sha256 ${cursor.sourceSha256.slice(0, 12)}…, this file ${sourceSha256.slice(0, 12)}…). Use a new cursor file per export.`,
      );
    }
    const afterRailsUserId =
      nonNegativeIntegerOption("after", values.after) ?? cursor?.lastRailsUserId ?? 0;
    const maxUsers = nonNegativeIntegerOption("max-users", values["max-users"]);
    if (cursor) console.error(`resuming after railsUserId ${cursor.lastRailsUserId}`);

    const receipt = await runProgressImport({
      db,
      source,
      apply: values.apply,
      afterRailsUserId,
      batchSize:
        nonNegativeIntegerOption("batch-size", values["batch-size"]) ??
        DEFAULT_PROGRESS_IMPORT_BATCH_SIZE,
      ...(maxUsers === undefined ? {} : { maxUsers }),
      onBatchCommitted: ({ lastRailsUserId, receipt: progress }) => {
        if (values.cursor) {
          writeJson(values.cursor, {
            lastRailsUserId,
            source: source.description,
            sourceSha256,
            updatedAt: new Date().toISOString(),
          });
        }
        console.error(
          `batch ${progress.batches}: through railsUserId ${lastRailsUserId}, inserted ${progress.rows.inserted}, updated ${progress.rows.updated}`,
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
