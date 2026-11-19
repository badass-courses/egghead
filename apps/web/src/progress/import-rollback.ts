import type { ResultSetHeader, RowDataPacket } from "mysql2";

import { assertUtcSession, PROGRESS_IMPORT_SOURCE, type ProgressImportDb } from "./import";

/**
 * Undo one progress import run, identified by `fields.railsImport.runId`.
 *
 * - Rows the run inserted are deleted.
 * - Rows the run updated get their prior `fields`, `completedAt` (null) and
 *   `updatedAt` back.
 * - A row CB wrote after the import is left alone and counted as
 *   `changedSinceImport`. CB's writers (`completeResourceForUser`,
 *   `uncompleteResourceForUser`, `syncCourseProgressForUser`) all set
 *   `updatedAt` explicitly (the real column has no `ON UPDATE`) and stamp a
 *   `source`; the guard checks `updatedAt`, `completedAt` and `source` against
 *   the import stamp, so any of them changing protects the row.
 *
 * It works in batches of CB user ids, one short transaction each, so it never
 * locks or scans the whole table at once:
 * - with `userIds` (the run's manifest, written by the CLI before each import
 *   transaction), it touches only those users;
 * - without, it walks `userId` ranges through the table's `userId` index.
 * Within a batch, rows are filtered by `userId IN (...)` first, so the JSON
 * filter only reads that batch's rows. `afterUserId` resumes a rollback.
 *
 * `db` must be a UTC session (`openUtcConnection`), like the import.
 */

export const DEFAULT_ROLLBACK_BATCH_USERS = 200;

type RollbackCountRow = RowDataPacket & {
  action: string | null;
  unchanged: number | string | null;
  rowCount: number | string;
};

type UserIdRow = RowDataPacket & { userId: string };

export type ProgressImportRollbackReceipt = {
  mode: "dry_run" | "apply";
  runId: string;
  scope: "manifest" | "table_scan";
  batches: number;
  lastUserId: string | null;
  insertedRows: number;
  updatedRows: number;
  changedSinceImport: number;
  deleted: number;
  restored: number;
};

const STAMP = (path: string) => `JSON_EXTRACT(fields, '$.railsImport${path}')`;
const STAMP_TEXT = (path: string) => `JSON_UNQUOTE(${STAMP(path)})`;
const RUN_ID_SQL = STAMP_TEXT(".runId");
const ACTION_SQL = STAMP_TEXT(".action");
const PRIOR_FIELDS_SQL = STAMP(".prior.fields");
const PRIOR_UPDATED_AT_SQL = STAMP(".prior.updatedAt");

const UNCHANGED_SQL = `(
  updatedAt <=> CAST(${STAMP_TEXT(".at")} AS DATETIME(3))
  AND completedAt <=> CAST(${STAMP_TEXT(".completedAt")} AS DATETIME(3))
  AND (
    (${ACTION_SQL} = 'insert'
      AND JSON_UNQUOTE(JSON_EXTRACT(fields, '$.source')) <=> '${PROGRESS_IMPORT_SOURCE}')
    OR (${ACTION_SQL} = 'update'
      AND JSON_EXTRACT(fields, '$.source') <=> ${STAMP(".prior.fields.source")})
  )
)`;

function placeholders(count: number) {
  return Array.from({ length: count }, () => "?").join(", ");
}

async function nextUserIdsFromTable(db: ProgressImportDb, afterUserId: string, limit: number) {
  const [rows] = await db.query<UserIdRow[]>(
    `
      SELECT DISTINCT userId
      FROM egghead_ResourceProgress
      WHERE userId > ?
      ORDER BY userId
      LIMIT ${Math.max(1, Math.floor(limit))}
    `,
    [afterUserId],
  );
  return rows.map((row) => row.userId);
}

async function rollbackUserBatch(
  db: ProgressImportDb,
  input: { runId: string; userIds: readonly string[]; apply: boolean },
  receipt: ProgressImportRollbackReceipt,
) {
  const scope = `userId IN (${placeholders(input.userIds.length)}) AND ${RUN_ID_SQL} = ?`;
  const parameters = [...input.userIds, input.runId];
  const [counts] = await db.execute<RollbackCountRow[]>(
    `
      SELECT ${ACTION_SQL} AS action, ${UNCHANGED_SQL} AS unchanged, COUNT(*) AS rowCount
      FROM egghead_ResourceProgress
      WHERE ${scope}
      GROUP BY action, unchanged
    `,
    parameters,
  );
  for (const row of counts) {
    const rowCount = Number(row.rowCount);
    if (Number(row.unchanged) !== 1) receipt.changedSinceImport += rowCount;
    else if (row.action === "insert") receipt.insertedRows += rowCount;
    else if (row.action === "update") receipt.updatedRows += rowCount;
  }

  if (!input.apply || counts.length === 0) return;

  await db.beginTransaction();
  try {
    const [deleted] = await db.execute<ResultSetHeader>(
      `
        DELETE FROM egghead_ResourceProgress
        WHERE ${scope}
          AND ${ACTION_SQL} = 'insert'
          AND ${UNCHANGED_SQL}
      `,
      parameters,
    );
    // Single-table UPDATE assigns left to right: updatedAt and completedAt
    // read the still-unchanged fields before fields itself is replaced.
    const [restored] = await db.execute<ResultSetHeader>(
      `
        UPDATE egghead_ResourceProgress
        SET updatedAt = CASE
              WHEN ${PRIOR_UPDATED_AT_SQL} IS NULL OR JSON_TYPE(${PRIOR_UPDATED_AT_SQL}) = 'NULL'
              THEN NULL
              ELSE CAST(JSON_UNQUOTE(${PRIOR_UPDATED_AT_SQL}) AS DATETIME(3))
            END,
            completedAt = NULL,
            fields = CASE
              WHEN JSON_TYPE(${PRIOR_FIELDS_SQL}) = 'NULL' THEN NULL
              ELSE ${PRIOR_FIELDS_SQL}
            END
        WHERE ${scope}
          AND ${ACTION_SQL} = 'update'
          AND ${UNCHANGED_SQL}
      `,
      parameters,
    );
    await db.commit();
    receipt.deleted += deleted.affectedRows;
    receipt.restored += restored.affectedRows;
  } catch (error) {
    await db.rollback().catch(() => undefined);
    throw error;
  }
}

export async function rollbackProgressImport(input: {
  db: ProgressImportDb;
  runId: string;
  apply: boolean;
  /** The run's manifest. Without it the rollback walks the table by `userId`. */
  userIds?: readonly string[];
  afterUserId?: string;
  batchUsers?: number;
  onBatch?: (cursor: {
    lastUserId: string;
    receipt: ProgressImportRollbackReceipt;
  }) => Promise<void> | void;
}): Promise<ProgressImportRollbackReceipt> {
  await assertUtcSession(input.db);
  const batchUsers = Math.max(1, input.batchUsers ?? DEFAULT_ROLLBACK_BATCH_USERS);
  let afterUserId = input.afterUserId ?? "";
  const receipt: ProgressImportRollbackReceipt = {
    mode: input.apply ? "apply" : "dry_run",
    runId: input.runId,
    scope: input.userIds ? "manifest" : "table_scan",
    batches: 0,
    lastUserId: null,
    insertedRows: 0,
    updatedRows: 0,
    changedSinceImport: 0,
    deleted: 0,
    restored: 0,
  };

  const manifest = input.userIds
    ? [...new Set(input.userIds)].filter((userId) => userId > afterUserId).toSorted()
    : null;
  let manifestOffset = 0;

  const nextBatch = async () => {
    if (manifest) {
      const batch = manifest.slice(manifestOffset, manifestOffset + batchUsers);
      manifestOffset += batch.length;
      return batch;
    }
    return nextUserIdsFromTable(input.db, afterUserId, batchUsers);
  };

  // One batch at a time on the single connection; each step awaits the last.
  const step = async (): Promise<void> => {
    const batch = await nextBatch();
    if (batch.length === 0) return;
    await rollbackUserBatch(
      input.db,
      { runId: input.runId, userIds: batch, apply: input.apply },
      receipt,
    );
    afterUserId = batch.at(-1) ?? afterUserId;
    receipt.batches += 1;
    receipt.lastUserId = afterUserId;
    await input.onBatch?.({ lastUserId: afterUserId, receipt });
    return step();
  };
  await step();

  return receipt;
}
