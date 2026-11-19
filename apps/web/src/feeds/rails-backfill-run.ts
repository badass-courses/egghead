// DB half of scripts/backfill-feed-rails-fields.ts. Dry run by default.
//
// Apply writes a rollback file first (one JSON line per row: the keys this
// run adds and their values), then sets each missing key with JSON_SET under a
// "still missing" guard (a JSON null counts as missing), so re-running is a
// no-op. Rollback removes a key only while it still holds the exact value this
// backfill wrote, and restores overwritten values the same way. Each apply
// writes its own rollback file; after a partial apply and a re-run, undo both
// files, newest first. Draft CB rows are never touched.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { ResultSetHeader, RowDataPacket } from "mysql2";

import { assertDatabaseUrlForRuntime, createEggheadMysqlConnection } from "../db/local-docker";
import { getEnv } from "../env";
import {
  parseRailsFeedFieldsExport,
  planRailsBackfill,
  type BackfillConflict,
  type BackfillUpdate,
  type CbBackfillRow,
  type RailsKind,
} from "./rails-backfill";
import { jsonString } from "./content";

type CbRow = RowDataPacket & {
  id: string;
  lessonId: string | null;
  playlistId: string | null;
  slug: string | null;
  publishedAt: string | null;
  railsSlug: string | null;
  isLesson: number | string;
};

type MysqlConnection = Awaited<ReturnType<typeof createEggheadMysqlConnection>>;

/** A string field, or SQL NULL for a missing key or a JSON null (judge-3 #7). */
function json(key: string) {
  return jsonString("resource", key);
}

/** True when a key is missing or holds JSON null. */
function missingSql(key: string) {
  const extract = `JSON_EXTRACT(fields, '$.${key}')`;
  return `(${extract} IS NULL OR JSON_TYPE(${extract}) = 'NULL')`;
}

const LESSON_ROW = `(resource.type = 'lesson' OR (resource.type = 'post' AND ${json("postType")} IN ('lesson', 'podcast')))`;
const PLAYLIST_ROW = `(resource.type IN ('course', 'playlist') OR (resource.type = 'post' AND ${json("postType")} IN ('course', 'playlist')))`;

function assertBackfillWritesAllowed() {
  const safety = assertDatabaseUrlForRuntime();
  if (safety.runtime === "local" && safety.localDockerOnly) return safety;
  const approved = getEnv("EGGHEAD_FEED_BACKFILL_APPROVED")?.trim().toLowerCase() === "true";
  if (approved && (safety.betaDatabaseAllowed || safety.productionDatabaseAllowed)) return safety;
  throw new Error(
    `Refusing backfill writes for runtime=${safety.runtime} database=${safety.database}. ` +
      "Use local Docker, or approved beta/production with EGGHEAD_FEED_BACKFILL_APPROVED=true.",
  );
}

async function readCbRows(connection: MysqlConnection): Promise<CbBackfillRow[]> {
  const [rows] = await connection.query<CbRow[]>(`
    SELECT resource.id,
           COALESCE(${json("eggheadLessonId")}, ${json("legacyRailsLessonId")}) AS lessonId,
           COALESCE(${json("eggheadPlaylistId")}, ${json("legacyRailsPlaylistId")}) AS playlistId,
           ${json("slug")} AS slug,
           ${json("publishedAt")} AS publishedAt,
           COALESCE(${json("legacyRailsSlug")}, ${json("legacyRailsLessonSlug")}, ${json("legacyRailsPlaylistSlug")}) AS railsSlug,
           ${LESSON_ROW} AS isLesson
    FROM egghead_ContentResource resource
    WHERE resource.deletedAt IS NULL
      AND (${LESSON_ROW} OR ${PLAYLIST_ROW})
      -- Drafts are not feed content; leave them for the builder (judge-3 #4).
      AND LOWER(COALESCE(${json("state")}, 'published')) <> 'draft'
  `);
  return rows.flatMap((row): CbBackfillRow[] => {
    const isLesson = Number(row.isLesson) === 1;
    const kind: RailsKind = isLesson ? "lesson" : "playlist";
    const railsId = isLesson ? row.lessonId : row.playlistId;
    if (!railsId || railsId === "0" || railsId === "null") return [];
    return [
      {
        id: row.id,
        kind,
        railsId,
        slug: row.slug,
        publishedAt: row.publishedAt,
        railsSlug: row.railsSlug,
      },
    ];
  });
}

function updateEntries(updates: readonly BackfillUpdate[]) {
  return updates.flatMap((update) =>
    Object.entries(update.set).flatMap(([key, value]) => {
      if (!value) return [];
      const previous = key === "publishedAt" ? update.previous?.publishedAt : undefined;
      return [{ id: update.id, key, value, previous: previous ?? null }];
    }),
  );
}

/**
 * One key per statement. A missing key is set only while still missing; an
 * overwrite (fixPacificShift) only while the old CB value is still there.
 * Either way, re-running is a no-op.
 */
async function applyUpdates(connection: MysqlConnection, updates: readonly BackfillUpdate[]) {
  // mysql2 runs one connection's commands in order; Promise.all only queues them.
  const results = await Promise.all(
    updateEntries(updates).map(({ id, key, value, previous }) =>
      previous === null
        ? connection.query<ResultSetHeader>(
            `UPDATE egghead_ContentResource
             SET fields = JSON_SET(fields, '$.${key}', ?)
             WHERE id = ? AND ${missingSql(key)}`,
            [value, id],
          )
        : connection.query<ResultSetHeader>(
            `UPDATE egghead_ContentResource
             SET fields = JSON_SET(fields, '$.${key}', ?)
             WHERE id = ? AND JSON_UNQUOTE(JSON_EXTRACT(fields, '$.${key}')) = ?`,
            [value, id, previous],
          ),
    ),
  );
  return results.reduce((total, [result]) => total + result.affectedRows, 0);
}

export type RailsBackfillSummary = {
  mode: "apply" | "dry-run";
  runtime: string;
  database: string;
  parsed: number;
  rejected: Record<string, number>;
  cbRows: number;
  matched: number;
  unmatched: number;
  rowsToUpdate: number;
  setPublishedAt: number;
  setLegacyRailsSlug: number;
  publishedAtConflicts: number;
  slugConflicts: number;
  railsDateNewer: number;
  cbDateNewer: number;
  publishedAtEqual: number;
  pacificShifted: number;
  otherDateConflicts: number;
  fixedPacificShift: number;
  keysWritten: number;
  /** Only with showConflicts: every disagreement (ids, slugs, dates; no user data). */
  conflicts?: BackfillConflict[];
};

export async function runRailsBackfill(input: {
  file: string;
  apply: boolean;
  rollbackFile: string;
  showConflicts?: boolean;
  /** Overwrite publishedAt values shifted by the Los Angeles offset (migration bug). */
  fixPacificShift?: boolean;
}): Promise<RailsBackfillSummary> {
  const safety = input.apply ? assertBackfillWritesAllowed() : assertDatabaseUrlForRuntime();
  const { rows, rejected } = parseRailsFeedFieldsExport(readFileSync(input.file, "utf8"));
  if (rows.length === 0) throw new Error("The Rails export has no valid rows; nothing to do.");
  const rejectedByReason: Record<string, number> = {};
  for (const entry of rejected) {
    rejectedByReason[entry.reason] = (rejectedByReason[entry.reason] ?? 0) + 1;
  }

  const connection = await createEggheadMysqlConnection();
  try {
    const plan = planRailsBackfill(await readCbRows(connection), rows, {
      fixPacificShift: input.fixPacificShift ?? false,
    });
    let keysWritten = 0;
    if (input.apply && plan.updates.length > 0) {
      if (existsSync(input.rollbackFile)) {
        throw new Error(`Rollback file ${input.rollbackFile} already exists; pass a new path.`);
      }
      writeFileSync(
        input.rollbackFile,
        plan.updates.map((update) => JSON.stringify(update)).join("\n") + "\n",
        { flag: "wx" },
      );
      keysWritten = await applyUpdates(connection, plan.updates);
    }
    return {
      mode: input.apply ? "apply" : "dry-run",
      runtime: safety.runtime,
      database: safety.database,
      parsed: rows.length,
      rejected: rejectedByReason,
      cbRows: plan.cbRows,
      matched: plan.matched,
      unmatched: plan.unmatched,
      rowsToUpdate: plan.updates.length,
      setPublishedAt: plan.setPublishedAt,
      setLegacyRailsSlug: plan.setLegacyRailsSlug,
      publishedAtConflicts: plan.publishedAtConflicts,
      slugConflicts: plan.slugConflicts,
      railsDateNewer: plan.railsDateNewer,
      cbDateNewer: plan.cbDateNewer,
      publishedAtEqual: plan.publishedAtEqual,
      pacificShifted: plan.pacificShifted,
      otherDateConflicts: plan.otherDateConflicts,
      fixedPacificShift: plan.fixedPacificShift,
      keysWritten,
      ...(input.showConflicts ? { conflicts: plan.conflicts } : {}),
    };
  } finally {
    await connection.end();
  }
}

/**
 * Undo an applied run from its rollback file. Only values this backfill wrote
 * are touched: added keys are removed, overwritten keys get their old value.
 */
export async function rollbackRailsBackfill(input: { rollbackFile: string; apply: boolean }) {
  const safety = input.apply ? assertBackfillWritesAllowed() : assertDatabaseUrlForRuntime();
  const updates = readFileSync(input.rollbackFile, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line): BackfillUpdate => {
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("id" in parsed) ||
        typeof parsed.id !== "string" ||
        !("set" in parsed) ||
        typeof parsed.set !== "object" ||
        parsed.set === null
      ) {
        throw new Error("Malformed rollback line.");
      }
      const set: BackfillUpdate["set"] = {};
      if ("publishedAt" in parsed.set && typeof parsed.set.publishedAt === "string") {
        set.publishedAt = parsed.set.publishedAt;
      }
      if ("legacyRailsSlug" in parsed.set && typeof parsed.set.legacyRailsSlug === "string") {
        set.legacyRailsSlug = parsed.set.legacyRailsSlug;
      }
      if (
        "previous" in parsed &&
        typeof parsed.previous === "object" &&
        parsed.previous !== null &&
        "publishedAt" in parsed.previous &&
        typeof parsed.previous.publishedAt === "string"
      ) {
        return { id: parsed.id, set, previous: { publishedAt: parsed.previous.publishedAt } };
      }
      return { id: parsed.id, set };
    });

  const connection = await createEggheadMysqlConnection();
  let keysRemoved = 0;
  try {
    if (input.apply) {
      const results = await Promise.all(
        updateEntries(updates).map(({ id, key, value, previous }) =>
          previous === null
            ? connection.query<ResultSetHeader>(
                `UPDATE egghead_ContentResource
                 SET fields = JSON_REMOVE(fields, '$.${key}')
                 WHERE id = ? AND JSON_UNQUOTE(JSON_EXTRACT(fields, '$.${key}')) = ?`,
                [id, value],
              )
            : connection.query<ResultSetHeader>(
                `UPDATE egghead_ContentResource
                 SET fields = JSON_SET(fields, '$.${key}', ?)
                 WHERE id = ? AND JSON_UNQUOTE(JSON_EXTRACT(fields, '$.${key}')) = ?`,
                [previous, id, value],
              ),
        ),
      );
      keysRemoved = results.reduce((total, [result]) => total + result.affectedRows, 0);
    }
    return {
      mode: input.apply ? "apply" : "dry-run",
      runtime: safety.runtime,
      database: safety.database,
      rows: updates.length,
      keysRemoved,
    };
  } finally {
    await connection.end();
  }
}
