import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { Connection } from "mysql2/promise";

/**
 * Undo one progress import run, identified by `fields.railsImport.runId`.
 *
 * - Rows the run inserted are deleted.
 * - Rows the run updated get their prior `fields`, `completedAt` (null) and
 *   `updatedAt` back, byte for byte.
 * - A row whose `updatedAt` no longer equals `railsImport.at` was written by CB
 *   after the import (the learner toggled it, a course recount ran). Rollback
 *   leaves it and counts it as `changedSinceImport`, so post-import progress is
 *   never erased.
 *
 * `db` must be a UTC session (`openUtcConnection`), like the import.
 */

type Db = Pick<Connection, "execute" | "beginTransaction" | "commit" | "rollback">;

type RollbackCountRow = RowDataPacket & {
  action: string | null;
  unchanged: number | string | null;
  rowCount: number | string;
};

export type ProgressImportRollbackReceipt = {
  mode: "dry_run" | "apply";
  runId: string;
  insertedRows: number;
  updatedRows: number;
  changedSinceImport: number;
  deleted: number;
  restored: number;
};

const RUN_ID_SQL = "JSON_UNQUOTE(JSON_EXTRACT(fields, '$.railsImport.runId'))";
const ACTION_SQL = "JSON_UNQUOTE(JSON_EXTRACT(fields, '$.railsImport.action'))";
const UNCHANGED_SQL =
  "updatedAt = CAST(JSON_UNQUOTE(JSON_EXTRACT(fields, '$.railsImport.at')) AS DATETIME(3))";
const PRIOR_FIELDS_SQL = "JSON_EXTRACT(fields, '$.railsImport.prior.fields')";

export async function rollbackProgressImport(input: {
  db: Db;
  runId: string;
  apply: boolean;
}): Promise<ProgressImportRollbackReceipt> {
  const { db, runId } = input;
  const [counts] = await db.execute<RollbackCountRow[]>(
    `
      SELECT ${ACTION_SQL} AS action, (${UNCHANGED_SQL}) AS unchanged, COUNT(*) AS rowCount
      FROM egghead_ResourceProgress
      WHERE ${RUN_ID_SQL} = ?
      GROUP BY action, unchanged
    `,
    [runId],
  );

  const receipt: ProgressImportRollbackReceipt = {
    mode: input.apply ? "apply" : "dry_run",
    runId,
    insertedRows: 0,
    updatedRows: 0,
    changedSinceImport: 0,
    deleted: 0,
    restored: 0,
  };
  for (const row of counts) {
    const rowCount = Number(row.rowCount);
    if (Number(row.unchanged) !== 1) receipt.changedSinceImport += rowCount;
    else if (row.action === "insert") receipt.insertedRows += rowCount;
    else if (row.action === "update") receipt.updatedRows += rowCount;
  }

  if (!input.apply) return receipt;

  await db.beginTransaction();
  try {
    const [deleted] = await db.execute<ResultSetHeader>(
      `
        DELETE FROM egghead_ResourceProgress
        WHERE ${RUN_ID_SQL} = ?
          AND ${ACTION_SQL} = 'insert'
          AND ${UNCHANGED_SQL}
      `,
      [runId],
    );
    // Single-table UPDATE assigns left to right: updatedAt and completedAt are
    // set from the still-unchanged fields before fields itself is replaced.
    const [restored] = await db.execute<ResultSetHeader>(
      `
        UPDATE egghead_ResourceProgress
        SET updatedAt = CAST(
              JSON_UNQUOTE(JSON_EXTRACT(fields, '$.railsImport.prior.updatedAt')) AS DATETIME(3)
            ),
            completedAt = NULL,
            fields = CASE
              WHEN JSON_TYPE(${PRIOR_FIELDS_SQL}) = 'NULL' THEN NULL
              ELSE ${PRIOR_FIELDS_SQL}
            END
        WHERE ${RUN_ID_SQL} = ?
          AND ${ACTION_SQL} = 'update'
          AND ${UNCHANGED_SQL}
      `,
      [runId],
    );
    await db.commit();
    receipt.deleted = deleted.affectedRows;
    receipt.restored = restored.affectedRows;
  } catch (error) {
    await db.rollback().catch(() => undefined);
    throw error;
  }

  return receipt;
}
