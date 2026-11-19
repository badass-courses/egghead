// Paid-access delta: re-project Rails access into CourseBuilder (ADR-0006 lenient).
//
//   pnpm access:delta --export rails-access-export.jsonl --out <dir> [--user <id|email>]...
//   pnpm access:delta --export f.jsonl --out <dir> --apply --expect-plan <sha> --confirm-database <db>
//   pnpm access:delta --export f.jsonl --out <dir> --resume --expect-plan <sha> --confirm-database <db>
//
// Dry run is the default: it reads CourseBuilder, writes `<out>/receipt.json` and
// `<out>/plan.json`, and changes nothing. `--apply` writes exactly the reviewed
// `<out>/plan.json`: it refuses unless `--expect-plan` names that plan's sha256,
// the export is younger than `--max-export-age` (default 2h), a fresh read still
// produces the same plan, and the gate passes. It applies in batches with a
// cursor and verifies. `--resume` continues the saved plan from
// `<out>/cursor.json` after the same checks (its fresh read may only lack ops
// the stopped run already applied).
//
// `--identity-pass` plans only email updates and links. Run it (dry run, then
// apply) when the full gate fails on identity conflicts the plan's own email
// moves would free, then run the full dry run again.
//
// `<out>` holds customer emails and names: it must be outside any git work
// tree, and it is set to mode 0700. Without `--out` the tool uses a new folder
// under `$XDG_STATE_HOME/egghead-access-delta` (default `~/.local/state`).
//
// The analysis clock defaults to the export's `exportedAt`, the moment Rails
// decided what had expired. `--now` overrides it (and the write timestamps).
//
// The CourseBuilder read runs in one read-only transaction only on the local
// runtime. PlanetScale caps transaction time, so beta and production read
// query by query (`--snapshot-transaction` forces the transaction).
//
// Database guards come from `apps/web/src/db/local-docker.ts`: dry runs need a
// URL the runtime accepts (local, approved beta, production); writes need
// `commerceWritesAllowed` plus `--confirm-database` naming the target database.
// The export comes from `scripts/sql/rails-access-export.sql`.
//
// Runs in UTC only (the package script sets TZ=UTC): mysql2 writes Date values as
// local wall-clock strings, and CourseBuilder runs in UTC.

import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  emailUniquenessKey,
  normalizeEmail,
  parseRailsAccessExport,
  type RailsAccessExport,
  type SeatFlagRuling,
} from "../apps/web/src/access/rails-access-delta";
import {
  hostSha256,
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
  DEFAULT_MAX_EXPORT_AGE_MS,
  parseDurationMs,
  type DeltaAnalysis,
  type DeltaPass,
} from "./access-delta-run";

function usage(message?: string): never {
  if (message) console.error(`access-delta: ${message}`);
  console.error(
    "usage: access-delta --export <file.jsonl> [--out <dir>] [--user <railsUserId|cbUserId|email>]... " +
      "[--identity-pass] [--apply|--resume] [--expect-plan <sha256>] [--confirm-database <db>] " +
      "[--batch-size N] [--max-batches N] [--allow-large-revoke] [--accept-bare-pro <sha256>] " +
      "[--previous-receipt <receipt.json>] [--allow-backing-growth] [--held-seat-flag <membershipId>=clear|keep]... " +
      "[--max-export-age 2h] [--now <iso>] [--snapshot-transaction|--no-snapshot-transaction] [--json]",
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

/** The git work tree `dir` sits in, or null. Walks up to the filesystem root. */
async function gitWorkTreeOf(dir: string): Promise<string | null> {
  const found = await stat(path.join(dir, ".git")).then(
    () => true,
    () => false,
  );
  if (found) return dir;
  const parent = path.dirname(dir);
  return parent === dir ? null : gitWorkTreeOf(parent);
}

function defaultOutDir(generatedAt: string) {
  const state = process.env["XDG_STATE_HOME"] || path.join(homedir(), ".local", "state");
  return path.join(state, "egghead-access-delta", `run-${generatedAt.replace(/[:.]/g, "-")}`);
}

/** `id=clear|keep` pairs from repeated `--held-seat-flag`. */
function seatFlagRulings(values: readonly string[]) {
  const rulings = new Map<string, SeatFlagRuling>();
  for (const value of values) {
    const match = /^([^=\s]+)=(clear|keep)$/.exec(value);
    if (!match?.[1] || (match[2] !== "clear" && match[2] !== "keep")) {
      usage(`--held-seat-flag ${value}: expected <membershipId>=clear or <membershipId>=keep`);
    }
    rulings.set(match[1], match[2]);
  }
  return rulings;
}

/** `backingGrants.bySourceType` from an earlier receipt, without trusting its shape. */
async function previousBackingCounts(file: string | undefined) {
  if (file === undefined) return null;
  const json: unknown = JSON.parse(await readFile(file, "utf8"));
  const backing =
    typeof json === "object" && json !== null ? Reflect.get(json, "backingGrants") : null;
  const bySource =
    typeof backing === "object" && backing !== null ? Reflect.get(backing, "bySourceType") : null;
  if (typeof bySource !== "object" || bySource === null) {
    usage(`--previous-receipt ${file} has no backingGrants.bySourceType`);
  }
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(bySource)) {
    if (typeof value === "number") counts[key] = value;
  }
  return counts;
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
      "identity-pass": { type: "boolean", default: false },
      "confirm-database": { type: "string" },
      "batch-size": { type: "string" },
      "max-batches": { type: "string" },
      "allow-large-revoke": { type: "boolean", default: false },
      "accept-bare-pro": { type: "string" },
      "previous-receipt": { type: "string" },
      "allow-backing-growth": { type: "boolean", default: false },
      "held-seat-flag": { type: "string", multiple: true },
      "expect-plan": { type: "string" },
      "snapshot-transaction": { type: "boolean", default: false },
      "no-snapshot-transaction": { type: "boolean", default: false },
      "max-export-age": { type: "string" },
      now: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });

  const exportPath = values.export;
  if (!exportPath) usage("--export is required");
  if (values.apply && values.resume) usage("--apply and --resume are exclusive");
  const writing = values.apply || values.resume;
  const pass: DeltaPass = values["identity-pass"] ? "identity" : "full";
  const batchSize = positiveInt(values["batch-size"], "--batch-size", 100);
  const maxBatches =
    values["max-batches"] === undefined
      ? undefined
      : positiveInt(values["max-batches"], "--max-batches", 1);
  const nowOverride = values.now === undefined ? null : Date.parse(values.now);
  if (nowOverride !== null && Number.isNaN(nowOverride)) usage("--now must be an ISO timestamp");
  const now = () => (nowOverride === null ? new Date() : new Date(nowOverride));
  if (values["snapshot-transaction"] && values["no-snapshot-transaction"]) {
    usage("--snapshot-transaction and --no-snapshot-transaction are exclusive");
  }
  const maxExportAgeMs =
    values["max-export-age"] === undefined
      ? DEFAULT_MAX_EXPORT_AGE_MS
      : parseDurationMs(values["max-export-age"]);
  if (maxExportAgeMs === null) usage("--max-export-age must look like 90m, 2h or 1d");
  const rulings = seatFlagRulings(values["held-seat-flag"] ?? []);
  const rulingsRecord = Object.fromEntries(
    [...rulings].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const previousBacking = await previousBackingCounts(values["previous-receipt"]);

  const safety = writing ? assertCommerceWritesAllowed() : assertDatabaseUrlForRuntime();
  if (writing && values["confirm-database"] !== safety.database) {
    usage(`writes need --confirm-database ${safety.database} (the target database name)`);
  }
  const readOptions = {
    ...DEFAULT_READ_OPTIONS,
    consistent: values["snapshot-transaction"]
      ? true
      : values["no-snapshot-transaction"]
        ? false
        : safety.runtime === "local",
  };
  const targetHost = hostSha256(safety.host);
  const target = { runtime: safety.runtime, hostSha256: targetHost, database: safety.database };

  const railsExport = parseRailsAccessExport(await readFile(exportPath, "utf8"));
  const generatedAt = now().toISOString();
  if (writing && values.out === undefined)
    usage("--apply and --resume need --out <dry-run folder>");
  const outDir = path.resolve(values.out ?? defaultOutDir(generatedAt));
  // The plan holds customer emails and names: never inside a work tree.
  const workTree = await gitWorkTreeOf(outDir);
  if (workTree !== null) {
    usage(
      `--out ${outDir} is inside the git work tree ${workTree}; use a private folder outside it`,
    );
  }
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  await chmod(outDir, 0o700);

  const mode = values.resume ? "resume" : values.apply ? "apply" : "dry-run";
  const receiptPath = path.join(
    outDir,
    mode === "dry-run" ? "receipt.json" : `${mode}-receipt.json`,
  );
  const planPath = path.join(outDir, "plan.json");
  const cursorPath = path.join(outDir, "cursor.json");
  const existingCursor = await readFile(cursorPath, "utf8").then(parseCursor, () => null);
  if (mode === "dry-run" && existingCursor && !existingCursor.complete) {
    usage(`${outDir} holds an unfinished apply (cursor.json); dry-run into a NEW --out folder`);
  }
  if (mode === "apply" && existingCursor && !existingCursor.complete) {
    usage(
      `${outDir} holds an unfinished apply; continue it with --resume, or dry-run into a NEW --out folder`,
    );
  }
  if (mode === "resume" && !existingCursor) usage(`--resume: no cursor.json in ${outDir}`);
  const analysisNowMs = analysisClockMs(railsExport, nowOverride);
  const analyzeOptions = { pass, seatFlagRulings: rulings };
  const db = getEggheadDatabase();

  try {
    const analysis = await analyzeDatabase(
      db,
      railsExport,
      analysisNowMs,
      readOptions,
      analyzeOptions,
    );
    const built = buildReceipt(railsExport, analysis, {
      mode,
      generatedAt,
      target,
      allowLargeRevoke: values["allow-large-revoke"],
      acceptBarePro: values["accept-bare-pro"] ?? null,
      previousBackingCounts: previousBacking,
      allowBackingGrowth: values["allow-backing-growth"],
    });
    const receipt: Record<string, unknown> = {
      ...built,
      analysisClock: new Date(analysisNowMs).toISOString(),
      snapshotTransaction: readOptions.consistent,
      seatFlagRulings: rulingsRecord,
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
          hostSha256: targetHost,
          pass,
          seatFlagRulings: rulingsRecord,
          generatedAt,
          ops: analysis.plan.ops,
        }),
      );
      receipt["planFile"] = planPath;
    } else {
      const plan = parsePlan(await readFile(planPath, "utf8"));
      const pending =
        existingCursor && existingCursor.lastKey !== null
          ? plan.ops.filter((op) => op.key > (existingCursor.lastKey ?? ""))
          : plan.ops;
      const pendingJson = new Set(pending.map((op) => JSON.stringify(op)));
      const refusals = applyRefusals({
        expectPlan: values["expect-plan"],
        reviewedPlan: plan,
        exportSha256: railsExport.sha256,
        database: safety.database,
        hostSha256: targetHost,
        exportedAtMs: analysisClockMs(railsExport, null),
        nowMs: Date.now(),
        maxExportAgeMs,
        freshPlanSha256: planSha256(analysis.plan.ops),
        ...(mode === "resume"
          ? {
              resume: {
                freshOpsOutsidePlan: analysis.plan.ops.filter(
                  (op) => !pendingJson.has(JSON.stringify(op)),
                ).length,
              },
            }
          : {}),
        gate: built.gate,
      });
      if (plan.pass !== pass) {
        refusals.push(
          `the saved plan is a ${plan.pass} pass; ${plan.pass === "identity" ? "add" : "drop"} --identity-pass`,
        );
      }
      if (JSON.stringify(plan.seatFlagRulings) !== JSON.stringify(rulingsRecord)) {
        refusals.push("pass the same --held-seat-flag rulings the reviewed dry run used");
      }
      if (existingCursor && existingCursor.planSha256 !== plan.planSha256) {
        refusals.push("cursor.json belongs to a different plan; dry-run into a NEW --out folder");
      }
      if (refusals.length > 0) {
        throw new Error(`refusing --${mode}:\n  - ${refusals.join("\n  - ")}`);
      }
      let cursor: ApplyCursor;
      if (mode === "resume" && existingCursor) {
        cursor = existingCursor;
      } else {
        cursor = newCursor(plan, generatedAt);
        await writePrivate(cursorPath, `${JSON.stringify(cursor)}\n`);
      }
      const result = await applyAndVerify(db, railsExport, plan.ops, cursor, {
        batchSize,
        ...(maxBatches === undefined ? {} : { maxBatches }),
        now,
        analysisNowMs,
        readOptions,
        analyzeOptions,
        saveCursor: (next) => writePrivate(cursorPath, `${JSON.stringify(next)}\n`),
      });
      receipt["apply"] = {
        cursor: result.cursor,
        cursorFile: cursorPath,
        planFile: planPath,
        batchSize,
        timing: result.timing,
        verify: result.verify,
      };
      if (!result.cursor.complete) {
        console.error(
          `access-delta: stopped at ${result.cursor.appliedOps}/${result.cursor.totalOps}; continue with --resume`,
        );
        exitCode = 3;
      } else if (result.verify.remainingOps > 0) {
        console.error(
          `access-delta: ${result.verify.remainingOps} ops remain after apply; dry-run into a NEW --out folder and review it`,
        );
        exitCode = 2;
      }
    }

    await writePrivate(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    const gate = analysis.after.summary;
    if (values.json) console.log(JSON.stringify(receipt, null, 2));
    console.error(
      `access-delta ${mode}${pass === "identity" ? " (identity pass)" : ""}: ${analysis.plan.ops.length} changes; ` +
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
