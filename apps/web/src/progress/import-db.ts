import type { RowDataPacket } from "mysql2";
import mysql from "mysql2/promise";

import {
  assertDatabaseUrlForRuntime,
  type EggheadRuntime,
  getDatabaseUrl,
  mysqlConnectionOptionsFromUrl,
} from "../db/local-docker";
import type { ProgressImportIdentity } from "./import-cli";

export const PROGRESS_IMPORT_APPLY_APPROVAL_ENV = "EGGHEAD_PROGRESS_IMPORT_APPLY_APPROVED";
export const PROGRESS_IMPORT_PRODUCTION_APPROVAL_ENV =
  "EGGHEAD_PROGRESS_IMPORT_PRODUCTION_APPROVED";

/**
 * Pins both sides of the connection to UTC. mysql2 formats and parses Dates in
 * the client's local zone by default, so an import run from a machine outside
 * UTC against a UTC session would shift every Rails timestamp by hours.
 */
export async function openUtcConnection(options: mysql.ConnectionOptions) {
  const db = await mysql.createConnection({ ...options, timezone: "Z" });
  await db.query("SET time_zone = '+00:00'");
  return db;
}

/**
 * Who may write. Reading beta needs only the app's own beta approval
 * (`EGGHEAD_BETA_DB_APPROVED`). Writing beta (import apply or rollback apply)
 * also needs `EGGHEAD_PROGRESS_IMPORT_APPLY_APPROVED=true`, so a dry-run
 * environment cannot write by adding `--apply`. Production writes additionally
 * require their own approval and confirmation of the server-reported database.
 */
export function assertProgressImportAccess(input: {
  runtime: EggheadRuntime;
  apply: boolean;
  applyApproved: boolean;
  productionApproved?: boolean;
  confirmDatabase?: string | undefined;
  connectedDatabase?: string | null;
}) {
  if (
    input.runtime === "production" &&
    input.apply &&
    (!input.productionApproved ||
      !input.connectedDatabase ||
      input.confirmDatabase !== input.connectedDatabase)
  ) {
    throw new Error(
      `Refusing to write progress into runtime=production: set ${PROGRESS_IMPORT_PRODUCTION_APPROVAL_ENV}=true and pass --confirm-database matching SELECT DATABASE().`,
    );
  }
  if (input.apply && input.runtime === "beta" && !input.applyApproved) {
    throw new Error(
      `Refusing to write beta: set ${PROGRESS_IMPORT_APPLY_APPROVAL_ENV}=true once this beta write is approved. Dry runs need only EGGHEAD_BETA_DB_APPROVED.`,
    );
  }
}

/**
 * Opens the progress import's target connection behind the app's runtime guard
 * (local needs a local `_test`/`_local` MySQL, beta needs
 * EGGHEAD_BETA_DB_APPROVED=true on PlanetScale), then the write guard above.
 */
export async function openProgressImportDatabase(input: {
  apply: boolean;
  rawUrl?: string;
  confirmDatabase?: string | undefined;
}) {
  const rawUrl = input.rawUrl ?? getDatabaseUrl();
  const safety = assertDatabaseUrlForRuntime(rawUrl);
  const access = {
    runtime: safety.runtime,
    apply: input.apply,
    applyApproved: process.env[PROGRESS_IMPORT_APPLY_APPROVAL_ENV]?.trim() === "true",
    productionApproved: process.env[PROGRESS_IMPORT_PRODUCTION_APPROVAL_ENV] === "true",
    confirmDatabase: input.confirmDatabase,
  };
  // Preserve early refusal without opening a connection for unapproved writes.
  // An approved production write still needs the server's database name below.
  if (
    safety.runtime !== "production" ||
    !input.apply ||
    !access.productionApproved ||
    !input.confirmDatabase
  ) {
    assertProgressImportAccess(access);
  }
  const options = mysqlConnectionOptionsFromUrl(rawUrl);
  const db = await openUtcConnection(options);
  let connectedDatabase: string;
  try {
    const [rows] = await db.query<Array<RowDataPacket & { databaseName: string | null }>>(
      "SELECT DATABASE() AS databaseName",
    );
    const name = rows[0]?.databaseName;
    assertProgressImportAccess({
      ...access,
      connectedDatabase: name ?? null,
    });
    if (!name) throw new Error("Progress import needs a selected database; nothing was written.");
    connectedDatabase = name;
  } catch (error) {
    await db.end();
    throw error;
  }
  const identity: ProgressImportIdentity = {
    runtime: safety.runtime,
    host: options.host,
    port: options.port,
    user: options.user,
    database: connectedDatabase,
  };
  return { db, identity };
}
