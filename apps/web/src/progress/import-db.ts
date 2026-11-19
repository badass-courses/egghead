import mysql from "mysql2/promise";

import {
  assertDatabaseUrlForRuntime,
  type EggheadRuntime,
  getDatabaseUrl,
  mysqlConnectionOptionsFromUrl,
} from "../db/local-docker";
import type { ProgressImportIdentity } from "./import-cli";

export const PROGRESS_IMPORT_APPLY_APPROVAL_ENV = "EGGHEAD_PROGRESS_IMPORT_APPLY_APPROVED";

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
 * environment cannot write by adding `--apply`. Production is refused for
 * both until it has its own reviewed approval.
 */
export function assertProgressImportAccess(input: {
  runtime: EggheadRuntime;
  apply: boolean;
  applyApproved: boolean;
}) {
  if (input.runtime === "production") {
    throw new Error(
      "Refusing progress import against runtime=production. Import into beta or local first; production needs its own reviewed approval.",
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
export async function openProgressImportDatabase(input: { apply: boolean; rawUrl?: string }) {
  const rawUrl = input.rawUrl ?? getDatabaseUrl();
  const safety = assertDatabaseUrlForRuntime(rawUrl);
  assertProgressImportAccess({
    runtime: safety.runtime,
    apply: input.apply,
    applyApproved: process.env[PROGRESS_IMPORT_APPLY_APPROVAL_ENV]?.trim() === "true",
  });

  const options = mysqlConnectionOptionsFromUrl(rawUrl);
  const db = await openUtcConnection(options);
  const identity: ProgressImportIdentity = {
    runtime: safety.runtime,
    host: options.host,
    port: options.port,
    user: options.user,
    database: options.database,
  };
  return { db, identity };
}
