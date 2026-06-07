import mysql from "mysql2/promise";
import { getEnv } from "../env";

const DEFAULT_LOCAL_DOCKER_MYSQL_URL = "mysql://root:root@127.0.0.1:3307/coursebuilder_test";
const LEADING_SLASH = /^\//;

export function getDatabaseUrl() {
  return getEnv("DATABASE_URL") ?? DEFAULT_LOCAL_DOCKER_MYSQL_URL;
}

export function assertLocalDockerDatabaseUrl(rawUrl = getDatabaseUrl()) {
  const url = new URL(rawUrl);
  const host = url.hostname;
  const database = url.pathname.replace(LEADING_SLASH, "");
  const isLocalHost = host === "127.0.0.1" || host === "localhost" || host === "::1";
  const isLocalDatabase =
    database === "coursebuilder_test" ||
    database === "coursebuilder_local" ||
    database.endsWith("_test") ||
    database.endsWith("_local");

  if (!(isLocalHost && isLocalDatabase)) {
    throw new Error(
      `Refusing non-local Docker MySQL URL for Phase 0: host=${host} database=${database}`,
    );
  }

  return { url, host, database };
}

export function createLocalMysqlConnection() {
  const rawUrl = getDatabaseUrl();
  assertLocalDockerDatabaseUrl(rawUrl);
  return mysql.createConnection(rawUrl);
}

export async function getLocalDockerDbProof() {
  let connection: mysql.Connection | null = null;

  try {
    const rawUrl = getDatabaseUrl();
    const safety = assertLocalDockerDatabaseUrl(rawUrl);
    connection = await mysql.createConnection(rawUrl);
    const [rows] = await connection.query("SELECT 1 AS ok");

    return {
      ok: true,
      localDockerOnly: true,
      host: safety.host,
      database: safety.database,
      query: Array.isArray(rows) ? rows[0] : null,
      planetScaleWritesApproved: false,
    };
  } catch (error) {
    return {
      ok: false,
      localDockerOnly: true,
      error: error instanceof Error ? error.message : String(error),
      planetScaleWritesApproved: false,
    };
  } finally {
    await connection?.end().catch(() => undefined);
  }
}
