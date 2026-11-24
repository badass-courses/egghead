import mysql from "mysql2/promise";
import { getEnv } from "../env";
import { getEggheadRuntime, type EggheadRuntime } from "../runtime";

export { getEggheadRuntime, type EggheadRuntime } from "../runtime";

const DEFAULT_LOCAL_DOCKER_MYSQL_URL = "mysql://root:root@127.0.0.1:3307/coursebuilder_test";
const LEADING_SLASH = /^\//;

let pool: mysql.Pool | null = null;

export type DatabaseSafety = {
  runtime: EggheadRuntime;
  url: URL;
  host: string;
  database: string;
  localDockerOnly: boolean;
  betaDatabaseApproved: boolean;
  betaDatabaseAllowed: boolean;
  productionDatabaseAllowed: boolean;
  commerceWritesAllowed: boolean;
};

export function getDatabaseUrl() {
  return getEnv("DATABASE_URL") ?? DEFAULT_LOCAL_DOCKER_MYSQL_URL;
}

export function isBetaDatabaseApproved() {
  return getEnv("EGGHEAD_BETA_DB_APPROVED")?.trim().toLowerCase() === "true";
}

function parseDatabaseUrl(rawUrl = getDatabaseUrl()) {
  const url = new URL(rawUrl);
  const host = url.hostname;
  const database = url.pathname.replace(LEADING_SLASH, "");

  return { url, host, database };
}

function isLocalDockerDatabase(input: { database: string; host: string }) {
  const { database, host } = input;
  const isLocalHost = host === "127.0.0.1" || host === "localhost" || host === "::1";
  const isLocalDatabase =
    database === "coursebuilder_test" ||
    database === "coursebuilder_local" ||
    database.endsWith("_test") ||
    database.endsWith("_local");

  return isLocalHost && isLocalDatabase;
}

function isPlanetScaleDatabase(input: { host: string }) {
  return input.host.endsWith(".connect.psdb.cloud") || input.host === "aws.connect.psdb.cloud";
}

export function assertDatabaseUrlForRuntime(rawUrl = getDatabaseUrl()): DatabaseSafety {
  const runtime = getEggheadRuntime();
  const { url, host, database } = parseDatabaseUrl(rawUrl);
  const localDockerOnly = isLocalDockerDatabase({ database, host });
  const betaDatabaseApproved = isBetaDatabaseApproved();
  const betaDatabaseAllowed =
    runtime === "beta" && betaDatabaseApproved && isPlanetScaleDatabase({ host });
  const productionDatabaseAllowed =
    runtime === "production" && Boolean(database) && isPlanetScaleDatabase({ host });
  const commerceWritesAllowed =
    (runtime === "local" && localDockerOnly) || productionDatabaseAllowed;

  if (runtime === "local" && !localDockerOnly) {
    throw new Error(
      `Refusing non-local MySQL URL in local runtime: host=${host} database=${database}`,
    );
  }

  if (runtime === "beta" && !betaDatabaseAllowed) {
    throw new Error(
      `Refusing beta MySQL URL without approved PlanetScale beta runtime: host=${host} database=${database}`,
    );
  }

  if (runtime === "production" && !productionDatabaseAllowed) {
    throw new Error(
      `Refusing production MySQL URL outside PlanetScale: host=${host} database=${database}`,
    );
  }

  return {
    runtime,
    url,
    host,
    database,
    localDockerOnly,
    betaDatabaseApproved,
    betaDatabaseAllowed,
    productionDatabaseAllowed,
    commerceWritesAllowed,
  };
}

export function commerceWritesAreAllowed(rawUrl = getDatabaseUrl()) {
  try {
    return assertDatabaseUrlForRuntime(rawUrl).commerceWritesAllowed;
  } catch {
    return false;
  }
}

export function assertCommerceWritesAllowed(rawUrl = getDatabaseUrl()) {
  const safety = assertDatabaseUrlForRuntime(rawUrl);

  if (!safety.commerceWritesAllowed) {
    throw new Error(
      `Refusing Egghead commerce writes in runtime=${safety.runtime} host=${safety.host} database=${safety.database}`,
    );
  }

  return safety;
}

export function assertLocalDockerDatabaseUrl(rawUrl = getDatabaseUrl()) {
  const safety = assertDatabaseUrlForRuntime(rawUrl);

  if (!safety.localDockerOnly) {
    throw new Error(
      `Expected local Docker MySQL URL but got runtime=${safety.runtime} host=${safety.host} database=${safety.database}`,
    );
  }

  return safety;
}

export function mysqlConnectionOptionsFromUrl(rawUrl: string) {
  const { url, host, database } = parseDatabaseUrl(rawUrl);
  const port = Number(url.port || "3306");
  const sslAccept = url.searchParams.get("sslaccept")?.toLowerCase();
  const needsSsl = sslAccept === "strict" || isPlanetScaleDatabase({ host });

  return {
    host,
    port,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ...(needsSsl ? { ssl: { rejectUnauthorized: true } } : {}),
  };
}

/**
 * Opt-in read-only mode for audit scripts (scripts/feeds-parity.ts) that run
 * app readers against a shared database. `EGGHEAD_DB_READ_ONLY=session` makes
 * every connection `SET SESSION TRANSACTION READ ONLY` and refuses anything
 * but SELECT/SHOW/WITH/EXPLAIN before it is sent; `guard` keeps only the
 * statement check (for servers that reject the SET). Unset: no change.
 */
export type DatabaseReadOnlyMode = "session" | "guard";

export function getDatabaseReadOnlyMode(): DatabaseReadOnlyMode | null {
  const raw = getEnv("EGGHEAD_DB_READ_ONLY")?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "session" || raw === "guard") return raw;
  throw new Error(`Unsupported EGGHEAD_DB_READ_ONLY: ${raw}`);
}

const READ_ONLY_STATEMENT = /^\s*(?:SELECT|SHOW|WITH|EXPLAIN)\b/i;

export function assertReadOnlyStatement(statement: unknown) {
  const text =
    typeof statement === "string"
      ? statement
      : typeof statement === "object" &&
          statement !== null &&
          "sql" in statement &&
          typeof statement.sql === "string"
        ? statement.sql
        : "";
  if (!READ_ONLY_STATEMENT.test(text)) {
    throw new Error(
      `Refusing a non-read statement in read-only mode: ${text.trim().split(/\s+/)[0] ?? ""}`,
    );
  }
}

function guardReadOnly<T extends mysql.Connection | mysql.Pool>(connection: T): T {
  return new Proxy(connection, {
    get(target, property, receiver) {
      if (property === "query") {
        return (...args: Parameters<typeof target.query>) => {
          assertReadOnlyStatement(args[0]);
          return target.query(...args);
        };
      }
      if (property === "execute") {
        return (...args: Parameters<typeof target.execute>) => {
          assertReadOnlyStatement(args[0]);
          return target.execute(...args);
        };
      }
      if (property === "getConnection" && "getConnection" in target) {
        return async () => guardReadOnly(await target.getConnection());
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

export function getEggheadMysqlPool() {
  if (pool) return pool;

  const rawUrl = getDatabaseUrl();
  const { runtime } = assertDatabaseUrlForRuntime(rawUrl);
  if (getDatabaseReadOnlyMode()) {
    throw new Error("The shared pool is not available in EGGHEAD_DB_READ_ONLY mode.");
  }
  const connection = mysql.createPool(mysqlConnectionOptionsFromUrl(rawUrl));
  pool = runtime === "beta" ? guardReadOnly(connection) : connection;

  return pool;
}

export async function createEggheadMysqlConnection() {
  const rawUrl = getDatabaseUrl();
  const { runtime } = assertDatabaseUrlForRuntime(rawUrl);
  const readOnly = getDatabaseReadOnlyMode() ?? (runtime === "beta" ? "guard" : null);
  const connection = await mysql.createConnection(mysqlConnectionOptionsFromUrl(rawUrl));
  if (!readOnly) return connection;
  if (readOnly === "session") {
    try {
      await connection.query("SET SESSION TRANSACTION READ ONLY");
    } catch (error) {
      await connection.end();
      throw error;
    }
  }
  return guardReadOnly(connection);
}

export function createLocalMysqlConnection() {
  return createEggheadMysqlConnection();
}

export async function getRuntimeDbProof() {
  let connection: mysql.Connection | null = null;

  try {
    const rawUrl = getDatabaseUrl();
    const safety = assertDatabaseUrlForRuntime(rawUrl);
    connection = await mysql.createConnection(mysqlConnectionOptionsFromUrl(rawUrl));
    const [rows] = await connection.query("SELECT 1 AS ok");

    return {
      ok: true,
      runtime: safety.runtime,
      localDockerOnly: safety.localDockerOnly,
      betaDatabaseAllowed: safety.betaDatabaseAllowed,
      productionDatabaseAllowed: safety.productionDatabaseAllowed,
      host: safety.host,
      database: safety.database,
      query: Array.isArray(rows) ? rows[0] : null,
      commerceWritesAllowed: safety.commerceWritesAllowed,
    };
  } catch (error) {
    let runtime: EggheadRuntime | "unsupported" = "unsupported";

    try {
      runtime = getEggheadRuntime();
    } catch {
      runtime = "unsupported";
    }

    return {
      ok: false,
      runtime,
      localDockerOnly: runtime === "local",
      betaDatabaseAllowed: false,
      productionDatabaseAllowed: false,
      error: error instanceof Error ? error.message : String(error),
      commerceWritesAllowed: false,
    };
  } finally {
    await connection?.end().catch(() => undefined);
  }
}

export function getLocalDockerDbProof() {
  return getRuntimeDbProof();
}
