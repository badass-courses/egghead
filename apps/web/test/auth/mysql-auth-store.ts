import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2";

import type { AuthStore } from "./auth-store";

/**
 * The shipped adapter, `createAuthJsAdapter(getCourseBuilderAdapter())`, on a
 * disposable local MySQL. The app's own runtime guard refuses anything but a
 * loopback host with a `_test` or `_local` database, and so does this file.
 * `reset()` deletes every auth row, so never point it at a shared database.
 */
export async function createMysqlAuthStore(url: string): Promise<AuthStore> {
  process.env["DATABASE_URL"] = url;
  process.env["EGGHEAD_RUNTIME"] = "local";

  const { assertDatabaseUrlForRuntime, getEggheadMysqlPool } =
    await import("../../src/db/local-docker");
  const safety = assertDatabaseUrlForRuntime(url);
  if (!safety.localDockerOnly || !safety.database.endsWith("_test")) {
    throw new Error(`Refusing a non-disposable auth test database: ${safety.database}`);
  }

  const { getCourseBuilderAdapter } = await import("../../src/db/adapter");
  const { createAuthJsAdapter } = await import("../../src/server/auth-js-adapter");
  const pool = getEggheadMysqlPool();

  async function count(sql: string) {
    const [rows] = await pool.query<RowDataPacket[]>(sql);
    return Number(rows[0]?.["count"] ?? 0);
  }

  return {
    name: "mysql",
    adapter: createAuthJsAdapter(getCourseBuilderAdapter()),
    reset: async () => {
      // No foreign keys join these tables, so the deletes can run together.
      await Promise.all(
        ["egghead_Session", "egghead_Account", "egghead_VerificationToken", "egghead_User"].map(
          (table) => pool.query(`DELETE FROM \`${table}\``),
        ),
      );
    },
    seedUser: async (email) => {
      const id = randomUUID();
      await pool.query(
        "INSERT INTO egghead_User (id, email, emailVerified) VALUES (?, ?, CURRENT_TIMESTAMP(3))",
        [id, email],
      );
      return id;
    },
    seedAccount: async (userId, provider, providerAccountId) => {
      await pool.query(
        "INSERT INTO egghead_Account (userId, type, provider, providerAccountId) VALUES (?, 'oauth', ?, ?)",
        [userId, provider, providerAccountId],
      );
    },
    accountOwner: async (provider, providerAccountId) => {
      const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT userId FROM egghead_Account WHERE provider = ? AND providerAccountId = ?",
        [provider, providerAccountId],
      );
      const userId = rows[0]?.["userId"];
      return typeof userId === "string" ? userId : null;
    },
    accountCount: () => count("SELECT COUNT(*) AS count FROM egghead_Account"),
    userCount: () => count("SELECT COUNT(*) AS count FROM egghead_User"),
    userEmail: async (userId) => {
      const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT email FROM egghead_User WHERE id = ?",
        [userId],
      );
      const email = rows[0]?.["email"];
      return typeof email === "string" ? email : null;
    },
    close: () => pool.end(),
  };
}
