// Paid-access delta: re-project Rails access into CourseBuilder (ADR-0006 lenient).
//
//   pnpm access:delta --export rails-access-export.jsonl [--out dir] [--user <id|email>]...
//   pnpm access:delta --export f.jsonl --out dir --apply --expect-plan <sha> --confirm-database <db>
//   pnpm access:delta --export f.jsonl --out dir --resume --confirm-database <db>
//
// Dry run is the default: it reads CourseBuilder, writes `<out>/receipt.json` and
// `<out>/plan.json`, and changes nothing. `--apply` writes exactly the reviewed
// `<out>/plan.json`: it refuses unless `--expect-plan` names that plan's sha256,
// a fresh read still produces the same plan, and the gate passes. It applies in
// batches with a cursor and verifies. `--resume` continues the saved plan from
// `<out>/cursor.json`.
//
// The analysis clock defaults to the export's `exportedAt`, the moment Rails
// decided what had expired. `--now` overrides it (and the write timestamps).
//
// Database guards come from `apps/web/src/db/local-docker.ts`: dry runs need a
// URL the runtime accepts (local, approved beta, production); writes need
// `commerceWritesAllowed` plus `--confirm-database` naming the target database.
// The export comes from `scripts/sql/rails-access-export.sql`.
//
// Runs in UTC only (the package script sets TZ=UTC): mysql2 writes Date values as
// local wall-clock strings, and CourseBuilder runs in UTC.

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  emailUniquenessKey,
  normalizeEmail,
  parseRailsAccessExport,
  type RailsAccessExport,
} from "../apps/web/src/access/rails-access-delta";
import {
  newCursor,
  parseCursor,
  parsePlan,
  planSha256,
  serializePlan,
  type ApplyCursor,
} from "../apps/web/src/access/rails-access-delta-plan";
import {
  findUserShadow,
  type ShadowResult,
  type UserShadow,
} from "../apps/web/src/access/rails-access-shadow";
import {
  DEFAULT_READ_OPTIONS,
  findCbUsersByEmail,
} from "../apps/web/src/access/rails-access-delta-store";
import { getEggheadDatabase } from "../apps/web/src/db/adapter";
import {
  assertCommerceWritesAllowed,
  assertDatabaseUrlForRuntime,
  getEggheadMysqlPool,
} from "../apps/web/src/db/local-docker";
import {
  analysisClockMs,
  analyzeDatabase,
  applyAndVerify,
  applyRefusals,
  buildReceipt,
  type DeltaAnalysis,
} from "./access-delta-run";

function usage(message?: string): never {
  if (message) console.error(`access-delta: ${message}`);
  console.error(
    "usage: access-delta --export <file.jsonl> [--out <dir>] [--user <railsUserId|cbUserId|email>]... " +
      "[--apply --expect-plan <sha256>|--resume] [--confirm-database <db>] [--batch-size N] [--max-batches N] " +
      "[--allow-large-revoke] [--now <iso>] [--no-snapshot-transaction] [--json]",
  );
  process.exit(64);
}

function positiveInt(value: string | undefined, name: string, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) usage(`${name} must be a positive integer`);
  return parsed;
}

async function writePrivate(file: string, content: string) {
  const temp = `${file}.tmp`;
  await writeFile(temp, content, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, file);
}

function describeUser(
  label: string,
  shadow: ShadowResult,
  query: string,
  context: Parameters<typeof findUserShadow>[2],
) {
  const found: UserShadow | null = findUserShadow(shadow, query, context, emailUniquenessKey);
  if (!found)
    return { label, verdict: "neither Rails nor CourseBuilder grants this user anything" };
  const verdict =
    found.underGrant.length > 0
      ? `UNDER-GRANT: Rails grants ${found.underGrant.join(", ")} but CourseBuilder does not`
      : found.overGrant.length > 0
        ? `OVER-GRANT: CourseBuilder grants ${found.overGrant.join(", ")} from Rails rows Rails no longer backs`
        : "match";
  return {
    label,
    cbUserId: found.cbUserId,
    railsUserIds: found.railsUserIds,
    identity: found.identity,
    railsSays: found.railsSays,
    cbSays: found.cbSays,
    cbNativeOnly: found.cbNativeOnly,
    verdict,
  };
}

function lookupContext(
  railsExport: RailsAccessExport,
  analysis: DeltaAnalysis,
  extraCbUsers: readonly { id: string; email: string }[],
) {
  return {
    railsUserIdByEmailKey: new Map(
      railsExport.users
        .filter((user) => normalizeEmail(user.email))
        .map((user) => [emailUniquenessKey(user.email), user.railsUserId]),
    ),
    cbUserIdByEmailKey: new Map(
      [...extraCbUsers, ...analysis.snapshot.users].map((user) => [
        emailUniquenessKey(user.email),
        user.id,
      ]),
    ),
  };
}

async function main() {
  if (new Date().getTimezoneOffset() !== 0) usage("refusing to run outside UTC (set TZ=UTC)");

  const { values } = parseArgs({
    options: {
      export: { type: "string" },
      out: { type: "string" },
      user: { type: "string", multiple: true },
      apply: { type: "boolean", default: false },
      resume: { type: "boolean", default: false },
      "confirm-database": { type: "string" },
      "batch-size": { type: "string" },
      "max-batches": { type: "string" },
      "allow-large-revoke": { type: "boolean", default: false },
      "expect-plan": { type: "string" },
      "no-snapshot-transaction": { type: "boolean", default: false },
      now: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });

  const exportPath = values.export;
  if (!exportPath) usage("--export is required");
  if (values.apply && values.resume) usage("--apply and --resume are exclusive");
  const writing = values.apply || values.resume;
  const outDir = path.resolve(values.out ?? "access-delta-out");
  const batchSize = positiveInt(values["batch-size"], "--batch-size", 500);
  const maxBatches =
    values["max-batches"] === undefined
      ? undefined
      : positiveInt(values["max-batches"], "--max-batches", 1);
  const nowOverride = values.now === undefined ? null : Date.parse(values.now);
  if (nowOverride !== null && Number.isNaN(nowOverride)) usage("--now must be an ISO timestamp");
  const now = () => (nowOverride === null ? new Date() : new Date(nowOverride));
  const readOptions = {
    ...DEFAULT_READ_OPTIONS,
    consistent: !values["no-snapshot-transaction"],
  };

  const safety = writing ? assertCommerceWritesAllowed() : assertDatabaseUrlForRuntime();
  if (writing && values["confirm-database"] !== safety.database) {
    usage(`writes need --confirm-database ${safety.database} (the target database name)`);
  }
  const target = { runtime: safety.runtime, host: safety.host, database: safety.database };

  const railsExport = parseRailsAccessExport(await readFile(exportPath, "utf8"));
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const mode = values.resume ? "resume" : values.apply ? "apply" : "dry-run";
  const receiptPath = path.join(
    outDir,
    mode === "dry-run" ? "receipt.json" : `${mode}-receipt.json`,
  );
  const planPath = path.join(outDir, "plan.json");
  const cursorPath = path.join(outDir, "cursor.json");
  const existingCursor = await readFile(cursorPath, "utf8").then(parseCursor, () => null);
  if (mode === "dry-run" && existingCursor && !existingCursor.complete) {
    usage(`${outDir} holds an unfinished apply (cursor.json); dry-run into another --out`);
  }
  if (mode === "apply" && existingCursor && !existingCursor.complete) {
    usage(`${outDir} holds an unfinished apply; continue it with --resume`);
  }
  const analysisNowMs = analysisClockMs(railsExport, nowOverride);
  const db = getEggheadDatabase();

  try {
    const generatedAt = now().toISOString();
    const analysis = await analyzeDatabase(db, railsExport, analysisNowMs, readOptions);
    const built = buildReceipt(railsExport, analysis, {
      mode,
      generatedAt,
      target,
      allowLargeRevoke: values["allow-large-revoke"],
    });
    const receipt: Record<string, unknown> = {
      ...built,
      analysisClock: new Date(analysisNowMs).toISOString(),
    };

    const userQueries = values.user ?? [];
    if (userQueries.length > 0) {
      const extra = await findCbUsersByEmail(
        db,
        userQueries.filter((query) => query.includes("@")),
      );
      const context = lookupContext(railsExport, analysis, extra);
      for (const query of userQueries) {
        console.log(
          JSON.stringify({
            query,
            before: describeUser("Rails vs CourseBuilder now", analysis.before, query, context),
            afterSimulatedApply: describeUser(
              "Rails vs CourseBuilder after apply",
              analysis.after,
              query,
              context,
            ),
          }),
        );
      }
    }

    let exitCode = 0;
    if (!writing) {
      await writePrivate(
        planPath,
        serializePlan({
          exportSha256: railsExport.sha256,
          database: safety.database,
          generatedAt,
          ops: analysis.plan.ops,
        }),
      );
      receipt["planFile"] = planPath;
    } else {
      const plan = parsePlan(await readFile(planPath, "utf8"));
      let cursor: ApplyCursor;
      if (values.resume) {
        if (!existingCursor) throw new Error(`--resume: no cursor.json in ${outDir}`);
        cursor = existingCursor;
        for (const [name, expected, actual] of [
          ["export sha256", railsExport.sha256, plan.exportSha256],
          ["database", safety.database, plan.database],
          ["cursor plan", plan.planSha256, cursor.planSha256],
          ["--expect-plan", values["expect-plan"] ?? plan.planSha256, plan.planSha256],
        ] as const) {
          if (expected !== actual)
            throw new Error(`--resume: ${name} mismatch (${actual} != ${expected})`);
        }
      } else {
        const refusals = applyRefusals({
          expectPlan: values["expect-plan"],
          reviewedPlan: plan,
          exportSha256: railsExport.sha256,
          database: safety.database,
          freshPlanSha256: planSha256(analysis.plan.ops),
          gate: built.gate,
        });
        if (refusals.length > 0) {
          throw new Error(`refusing --apply:\n  - ${refusals.join("\n  - ")}`);
        }
        cursor = newCursor(plan, generatedAt);
        await writePrivate(cursorPath, `${JSON.stringify(cursor)}\n`);
      }
      const ops = plan.ops;
      const result = await applyAndVerify(db, railsExport, ops, cursor, {
        batchSize,
        ...(maxBatches === undefined ? {} : { maxBatches }),
        now,
        analysisNowMs,
        readOptions,
        saveCursor: (next) => writePrivate(cursorPath, `${JSON.stringify(next)}\n`),
      });
      receipt["apply"] = {
        cursor: result.cursor,
        cursorFile: cursorPath,
        planFile: planPath,
        verify: result.verify,
      };
      if (!result.cursor.complete) {
        console.error(
          `access-delta: stopped at ${result.cursor.appliedOps}/${result.cursor.totalOps}; continue with --resume`,
        );
        exitCode = 3;
      } else if (result.verify.remainingOps > 0) {
        console.error(
          `access-delta: ${result.verify.remainingOps} ops remain after apply; rerun --apply (idempotent)`,
        );
        exitCode = 2;
      }
    }

    await writePrivate(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    const gate = analysis.after.summary;
    if (values.json) console.log(JSON.stringify(receipt, null, 2));
    console.error(
      `access-delta ${mode}: ${analysis.plan.ops.length} changes; ` +
        `before under=${analysis.before.summary.underGrantUsers} over=${analysis.before.summary.overGrantUsers}; ` +
        `after under=${gate.underGrantUsers} over=${gate.overGrantUsers}; gate ${built.gate.pass ? "pass" : "FAIL"}; ` +
        `plan ${built.changes.planSha256}; receipt ${receiptPath}`,
    );
    process.exitCode = exitCode;
  } finally {
    await getEggheadMysqlPool().end();
  }
}

main().catch((error: unknown) => {
  console.error(`access-delta: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
