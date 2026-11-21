// Full-row undo images stay beside the private plan/cursor, never in receipts.
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { DeltaOp } from "./rails-access-delta";
import type { EggheadDatabase } from "./rails-access-delta-store";

type Connection = Pick<EggheadDatabase, "execute">;
export const undoRowSchema = z.object({
  table: z.enum([
    "egghead_User",
    "egghead_Organization",
    "egghead_OrganizationMembership",
    "egghead_Entitlement",
  ]),
  id: z.string(),
  before: z.record(z.string(), z.unknown()).nullable(),
  afterSha256: z.string().optional(),
});
export type UndoRow = z.infer<typeof undoRowSchema>;
const ORDER = [
  "egghead_Entitlement",
  "egghead_OrganizationMembership",
  "egghead_Organization",
  "egghead_User",
];
/** A transaction has one connection. Preserve dependency order, not parallel promises. */
function serial<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
  return items.reduce((previous, item) => previous.then(() => run(item)), Promise.resolve());
}
function normalized(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString().replace("T", " ").replace(/Z$/, "");
  if (Array.isArray(value)) return value.map(normalized);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, normalized(item)]),
    );
  return value;
}
export function rowHash(row: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(normalized(row)))
    .digest("hex");
}
function target(op: DeltaOp): Pick<UndoRow, "table" | "id"> {
  switch (op.kind) {
    case "user_create":
      return { table: "egghead_User", id: op.user.id };
    case "user_link":
    case "user_email_update":
      return { table: "egghead_User", id: op.userId };
    case "organization_create":
      return { table: "egghead_Organization", id: op.organization.id };
    case "membership_create":
    case "membership_update":
      return { table: "egghead_OrganizationMembership", id: op.membership.id };
    case "membership_revoke":
      return { table: "egghead_OrganizationMembership", id: op.membershipId };
    case "entitlement_grant":
    case "entitlement_extend":
    case "entitlement_update":
      return { table: "egghead_Entitlement", id: op.entitlement.id };
    case "entitlement_revoke":
    case "entitlement_expire":
      return { table: "egghead_Entitlement", id: op.entitlementId };
    default:
      throw new Error("Unknown delta operation");
  }
}
async function readRows(
  db: Connection,
  rows: readonly Pick<UndoRow, "table" | "id">[],
  lock = false,
) {
  const found = new Map<string, Record<string, unknown>>();
  const chunks = ORDER.flatMap((table) => {
    const group = rows.filter((row) => row.table === table);
    return Array.from({ length: Math.ceil(group.length / 500) }, (_, index) => ({
      table,
      ids: group.slice(index * 500, (index + 1) * 500),
    }));
  });
  await serial(chunks, async ({ table, ids }) => {
    const [result] = await db.execute(
      sql`SELECT * FROM ${sql.identifier(table)} WHERE id IN (${sql.join(
        ids.map((row) => sql`${row.id}`),
        sql`, `,
      )}) ${lock ? sql`FOR UPDATE` : sql``}`,
    );
    for (const row of z.array(z.record(z.string(), z.unknown())).parse(normalized(result)))
      found.set(`${table}:${String(row["id"])}`, row);
  });
  return found;
}
export async function captureUndo(db: Connection, ops: readonly DeltaOp[]): Promise<UndoRow[]> {
  const targets = new Map(
    ops.map((op) => {
      const row = target(op);
      return [`${row.table}:${row.id}`, row];
    }),
  );
  const found = await readRows(db, [...targets.values()]);
  return [...targets.values()].map((row) =>
    Object.assign({}, row, { before: found.get(`${row.table}:${row.id}`) ?? null }),
  );
}
/** Lock and compare against the reviewed full row, not merely a projection. */
export async function checkUndoBaseline(db: Connection, rows: readonly UndoRow[]) {
  const found = await readRows(db, rows, true);
  for (const row of rows) {
    if (
      rowHash(found.get(`${row.table}:${row.id}`) ?? null) !==
      (row.afterSha256 ?? rowHash(row.before))
    )
      throw new Error(`row changed since review: ${row.table}/${row.id}; replan`);
  }
}
export async function stampUndo(db: Connection, rows: readonly UndoRow[]): Promise<UndoRow[]> {
  const found = await readRows(db, rows);
  return rows.map((row) =>
    Object.assign({}, row, { afterSha256: rowHash(found.get(`${row.table}:${row.id}`) ?? null) }),
  );
}
export function undoForOps(rows: readonly UndoRow[], ops: readonly DeltaOp[]) {
  const keys = new Set(
    ops.map((op) => {
      const row = target(op);
      return `${row.table}:${row.id}`;
    }),
  );
  const selected = rows.filter((row) => keys.has(`${row.table}:${row.id}`));
  if (
    selected.length !== keys.size ||
    new Set(selected.map((row) => `${row.table}:${row.id}`)).size !== keys.size
  )
    throw new Error("undo images do not cover the selected operations exactly; replan");
  return selected;
}
/** One transaction, bulk reads/deletes: validate every row before changing any. */
export async function rollbackRows(db: EggheadDatabase, rows: readonly UndoRow[], apply = false) {
  return db.transaction(async (tx) => {
    const found = await readRows(tx, rows, apply);
    for (const row of rows) {
      if (
        !row.afterSha256 ||
        rowHash(found.get(`${row.table}:${row.id}`) ?? null) !== row.afterSha256
      )
        throw new Error(
          `rollback refused: ${row.table}/${row.id} changed since apply or has no apply proof`,
        );
    }
    if (!apply) return { rows: rows.length, applied: false };
    // Restore existing rows before deleting anything they may now reference.
    await serial(ORDER, async (table) => {
      const updates = rows.filter((row) => row.table === table && row.before !== null);
      if (updates.length === 0) return;
      const [columns] = await tx.execute(sql`SHOW COLUMNS FROM ${sql.identifier(table)}`);
      const writable = new Set(
        z
          .array(z.object({ Field: z.string(), Extra: z.string() }))
          .parse(columns)
          .filter((column) => !/(?:VIRTUAL|STORED) GENERATED/.test(column.Extra))
          .map((column) => column.Field),
      );
      await serial(updates, async (row) => {
        const assignments = Object.entries(row.before ?? {})
          .filter(([key]) => key !== "id" && writable.has(key))
          .map(
            ([key, value]) =>
              sql`${sql.identifier(key)} = ${value !== null && typeof value === "object" ? JSON.stringify(value) : value}`,
          );
        await tx.execute(
          sql`UPDATE ${sql.identifier(table)} SET ${sql.join(assignments, sql`, `)} WHERE id = ${row.id}`,
        );
      });
    });
    await serial(ORDER, async (table) => {
      const creates = rows.filter((row) => row.table === table && row.before === null);
      if (creates.length === 0) return;
      const ids = sql.join(
        creates.map((row) => sql`${row.id}`),
        sql`, `,
      );
      const referenceColumns =
        table === "egghead_User"
          ? ["userId", "invitedById"]
          : table === "egghead_Organization"
            ? ["organizationId"]
            : table === "egghead_OrganizationMembership"
              ? ["organizationMembershipId"]
              : [];
      if (referenceColumns.length > 0) {
        const [columns] = await tx.execute(
          sql`SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.columns WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME IN (${sql.join(
            referenceColumns.map((column) => sql`${column}`),
            sql`, `,
          )})`,
        );
        await serial(
          z.array(z.object({ TABLE_NAME: z.string(), COLUMN_NAME: z.string() })).parse(columns),
          async (column) => {
            const [references] = await tx.execute(
              sql`SELECT 1 AS found FROM ${sql.identifier(column.TABLE_NAME)} WHERE ${sql.identifier(column.COLUMN_NAME)} IN (${ids}) LIMIT 1 FOR UPDATE`,
            );
            if (z.array(z.unknown()).parse(references).length > 0)
              throw new Error(`rollback refused: new references to ${table}; nothing rolled back`);
          },
        );
      }
      await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE id IN (${ids})`);
    });
    return { rows: rows.length, applied: true };
  });
}
