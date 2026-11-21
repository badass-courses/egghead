import mysql from "mysql2/promise";
import { z } from "zod";
import { shadowDatabaseOptions } from "./database-url";
import type { ShadowStore } from "./store";

/** Small schema-checked driver boundary; no application adapter or pool is reachable. */
export interface ShadowMysqlConnection {
  execute(sql: string, values: (string | number)[]): Promise<unknown>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  end(): Promise<void>;
}
export interface ShadowTables {
  claims: string;
  records: string;
}
export const SHADOW_TABLES: ShadowTables = {
  claims: "ShadowEventClaim",
  records: "ShadowRecord",
};
const writeResult = z.tuple([
  z.object({ affectedRows: z.number().int().nonnegative() }),
  z.unknown(),
]);
const claimResult = z.tuple([
  z.array(z.object({ complete: z.union([z.literal(0), z.literal(1)]) })),
  z.unknown(),
]);
const duplicate = z.object({ code: z.literal("ER_DUP_ENTRY") });

export function shadowTableNames(tables: ShadowTables = SHADOW_TABLES) {
  for (const name of Object.values(tables)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error("Invalid shadow table name");
  }
  return { claims: `\`${tables.claims}\``, records: `\`${tables.records}\`` };
}

/**
 * Durable state machine: absent -> leased -> complete. Only an expired lease can
 * transition leased -> leased under a new owner. Complete is terminal.
 * Each operation owns/closes its connection; no global app pool or import-time IO.
 * Complete updates the claim and inserts the canonical record in one transaction.
 */
export function createMysqlShadowStore(
  url: string,
  options: {
    appDatabaseUrl?: string | undefined;
    tables?: ShadowTables;
    connect?: () => Promise<ShadowMysqlConnection>;
  } = {},
): ShadowStore {
  const connectionOptions = shadowDatabaseOptions(url, options.appDatabaseUrl);
  const tables = shadowTableNames(options.tables);
  const connect = options.connect ?? (() => mysql.createConnection(connectionOptions));
  async function usingConnection<T>(work: (db: ShadowMysqlConnection) => Promise<T>): Promise<T> {
    try {
      const db = await connect();
      try {
        return await work(db);
      } finally {
        await db.end();
      }
    } catch {
      // Driver errors can contain connection credentials or record contents.
      throw new Error("Shadow MySQL store unavailable");
    }
  }
  const isComplete = async (db: ShadowMysqlConnection, id: string) => {
    const result = claimResult.parse(
      await db.execute(
        `SELECT (completedAt IS NOT NULL) AS complete FROM ${tables.claims} WHERE stripeEventId = ?`,
        [id],
      ),
    );
    return result[0][0]?.complete === 1;
  };
  return {
    claim: (id, owner) =>
      usingConnection(async (db) => {
        try {
          await db.execute(
            `INSERT INTO ${tables.claims} (stripeEventId, claimOwner, claimedUntil) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 5 MINUTE))`,
            [id, owner],
          );
          return "claimed";
        } catch (error) {
          if (!duplicate.safeParse(error).success) throw error;
        }
        if (await isComplete(db, id)) return "complete";
        const reclaimed = writeResult.parse(
          await db.execute(
            `UPDATE ${tables.claims} SET claimOwner = ?, claimedUntil = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 5 MINUTE) WHERE stripeEventId = ? AND claimedUntil < UTC_TIMESTAMP(6) AND completedAt IS NULL`,
            [owner, id],
          ),
        );
        if (reclaimed[0].affectedRows === 1) return "claimed";
        return (await isComplete(db, id)) ? "complete" : "busy";
      }),
    complete: (id, owner, record) =>
      usingConnection(async (db) => {
        if (record.stripeEventId !== id) throw new Error("Shadow record event mismatch");
        await db.beginTransaction();
        try {
          const completed = writeResult.parse(
            await db.execute(
              `UPDATE ${tables.claims} SET completedAt = UTC_TIMESTAMP(6) WHERE stripeEventId = ? AND claimOwner = ? AND completedAt IS NULL AND claimedUntil > UTC_TIMESTAMP(6)`,
              [id, owner],
            ),
          );
          if (completed[0].affectedRows !== 1) {
            await db.rollback();
            return false;
          }
          await db.execute(
            `INSERT INTO ${tables.records} (stripeEventId, observedAt, record) VALUES (?, ?, ?)`,
            [id, record.observedAt, JSON.stringify(record)],
          );
          await db.commit();
          return true;
        } catch (error) {
          await db.rollback();
          throw error;
        }
      }),
    release: (id, owner) =>
      usingConnection(async (db) => {
        await db.execute(
          `DELETE FROM ${tables.claims} WHERE stripeEventId = ? AND claimOwner = ? AND completedAt IS NULL`,
          [id, owner],
        );
      }),
  };
}
