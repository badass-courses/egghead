import mysql from "mysql2/promise";
import { getEnv } from "../env";

const DEFAULT_LOCAL_DOCKER_MYSQL_URL = "mysql://root:root@127.0.0.1:3307/coursebuilder_test";
const LEADING_SLASH = /^\//;

export type EggheadRuntime = "beta" | "local" | "production";

export type DatabaseSafety = {
  runtime: EggheadRuntime;
  url: URL;
  host: string;
  database: string;
  localDockerOnly: boolean;
  betaDatabaseApproved: boolean;
  betaDatabaseAllowed: boolean;
  productionRuntimeBlocked: boolean;
  readFlipBlocked: true;
  stripeWriterBlocked: true;
  inngestWriterBlocked: true;
  planetScaleWritesApproved: false;
};

export function getDatabaseUrl() {
  return getEnv("DATABASE_URL") ?? DEFAULT_LOCAL_DOCKER_MYSQL_URL;
}

export function getEggheadRuntime(): EggheadRuntime {
  const rawRuntime = getEnv("EGGHEAD_RUNTIME")?.trim().toLowerCase();

  if (!rawRuntime) return "local";
  if (rawRuntime === "local" || rawRuntime === "beta" || rawRuntime === "production") {
    return rawRuntime;
  }

  throw new Error(`Unsupported EGGHEAD_RUNTIME: ${rawRuntime}`);
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
  const productionRuntimeBlocked = runtime === "production";

  if (productionRuntimeBlocked) {
    throw new Error("Refusing production Egghead runtime before explicit read-flip approval.");
  }

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

  return {
    runtime,
    url,
    host,
    database,
    localDockerOnly,
    betaDatabaseApproved,
    betaDatabaseAllowed,
    productionRuntimeBlocked,
    readFlipBlocked: true,
    stripeWriterBlocked: true,
    inngestWriterBlocked: true,
    planetScaleWritesApproved: false,
  };
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

function mysqlConnectionOptionsFromUrl(rawUrl: string) {
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

export function createEggheadMysqlConnection() {
  const rawUrl = getDatabaseUrl();
  assertDatabaseUrlForRuntime(rawUrl);
  return mysql.createConnection(mysqlConnectionOptionsFromUrl(rawUrl));
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
      host: safety.host,
      database: safety.database,
      query: Array.isArray(rows) ? rows[0] : null,
      readFlipBlocked: safety.readFlipBlocked,
      stripeWriterBlocked: safety.stripeWriterBlocked,
      inngestWriterBlocked: safety.inngestWriterBlocked,
      planetScaleWritesApproved: false,
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
      error: error instanceof Error ? error.message : String(error),
      readFlipBlocked: true,
      stripeWriterBlocked: true,
      inngestWriterBlocked: true,
      planetScaleWritesApproved: false,
    };
  } finally {
    await connection?.end().catch(() => undefined);
  }
}

export function getLocalDockerDbProof() {
  return getRuntimeDbProof();
}
