import type { RowDataPacket } from "mysql2";
import type { Connection } from "mysql2/promise";

import { assertProgressWritesAllowed, createLocalMysqlConnection } from "../db/local-docker";

export type ProgressConnection = Connection;

// Every persisted progress mutation for an account uses the same lock. This keeps
// simultaneous lesson completion, course reconciliation, and review writes ordered.
export async function withProgressTransaction<T>(
  userId: string,
  write: (connection: ProgressConnection) => Promise<T>,
): Promise<T> {
  assertProgressWritesAllowed();
  const connection = await createLocalMysqlConnection();

  try {
    await connection.beginTransaction();
    const [users] = await connection.execute<(RowDataPacket & { id: string })[]>(
      "SELECT id FROM egghead_User WHERE id = ? LIMIT 1 FOR UPDATE",
      [userId],
    );
    if (users.length !== 1) throw new Error("Progress account is unavailable");
    const result = await write(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
}
