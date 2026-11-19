// DB half of the Rails feed-token import; see scripts/import-legacy-feed-tokens.ts.
//
// The import is a full sync with the Rails export:
// - rows for Rails users in the export are upserted (matched to CB users by
//   egghead_User.legacyRailsUserId) and stamped with this run's import id;
// - a changed hash replaces the old one (Rails rotated the token) and clears
//   any revocation; an unchanged hash clears only an "absent from export"
//   revocation, never a manual one;
// - active rows not stamped by this run are revoked as absent from the
//   export, unless that would revoke more than MASS_REVOKE_FRACTION of active
//   rows without --allow-mass-revoke.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { ResultSetHeader, RowDataPacket } from "mysql2";

import { assertDatabaseUrlForRuntime, createEggheadMysqlConnection } from "../db/local-docker";
import { getEnv } from "../env";
import {
  ABSENT_FROM_EXPORT_REASON,
  legacyFeedTokenId,
  parseLegacyFeedTokenExport,
  railsUserIdKey,
  revocationAllowed,
  type LegacyFeedTokenExportRow,
} from "./token-import";

type UserMatchRow = RowDataPacket & { id: string; legacyRailsUserId: unknown };
type CountRow = RowDataPacket & { count: number | string };
type MysqlConnection = Awaited<ReturnType<typeof createEggheadMysqlConnection>>;
type BatchOutcome = { matched: number; matchedRailsIds: string[]; affectedRows: number };

const BATCH = 500;
const RAILS_SOURCE = "rails_authentication_token";

function chunk<T>(values: readonly T[]): T[][] {
  return Array.from({ length: Math.ceil(values.length / BATCH) }, (_, index) =>
    values.slice(index * BATCH, (index + 1) * BATCH),
  );
}

function assertWritesAllowed() {
  const safety = assertDatabaseUrlForRuntime();
  if (safety.runtime === "local" && safety.localDockerOnly) return safety;
  if (
    safety.runtime === "production" &&
    safety.productionDatabaseAllowed &&
    getEnv("EGGHEAD_FEED_TOKEN_IMPORT_APPROVED")?.trim().toLowerCase() === "true"
  ) {
    return safety;
  }
  throw new Error(
    `Refusing feed-token writes for runtime=${safety.runtime} database=${safety.database}. ` +
      "Use local Docker, or production with EGGHEAD_FEED_TOKEN_IMPORT_APPROVED=true.",
  );
}

async function count(connection: MysqlConnection, sql: string, params: unknown[] = []) {
  const [rows] = await connection.query<CountRow[]>(sql, params);
  return Number(rows[0]?.count ?? 0);
}

async function importBatch(
  connection: MysqlConnection,
  batch: readonly LegacyFeedTokenExportRow[],
  input: { apply: boolean; importId: string },
): Promise<BatchOutcome> {
  const [users] = await connection.execute<UserMatchRow[]>(
    `SELECT id, legacyRailsUserId FROM egghead_User WHERE legacyRailsUserId IN (${batch.map(() => "?").join(", ")})`,
    batch.map((row) => row.railsUserId),
  );
  // The generated column is VARCHAR today, but key by one string form so an
  // INT column or a JSON number can never make every row look unmatched.
  const userIdByRailsId = new Map<string, string>();
  for (const user of users) {
    const key = railsUserIdKey(user.legacyRailsUserId);
    if (key) userIdByRailsId.set(key, user.id);
  }
  const matches = batch.flatMap((row) => {
    const userId = userIdByRailsId.get(row.railsUserId);
    return userId ? [{ ...row, userId }] : [];
  });
  const matchedRailsIds = matches.map((row) => row.railsUserId);
  if (!input.apply || matches.length === 0) {
    return { matched: matches.length, matchedRailsIds, affectedRows: 0 };
  }

  // MySQL applies ON DUPLICATE KEY assignments left to right, so the
  // revocation checks must run before tokenSha256 is overwritten.
  const [result] = await connection.query<ResultSetHeader>(
    `
      INSERT INTO egghead_LegacyFeedToken
        (id, userId, legacyRailsUserId, tokenSha256, source, lastSeenImportId, railsEmailSha256)
      VALUES ${matches.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ")}
      ON DUPLICATE KEY UPDATE
        revokedAt = IF(
          tokenSha256 <> VALUES(tokenSha256) OR revokedReason = ?,
          NULL,
          revokedAt
        ),
        revokedReason = IF(
          tokenSha256 <> VALUES(tokenSha256) OR revokedReason = ?,
          NULL,
          revokedReason
        ),
        userId = VALUES(userId),
        lastSeenImportId = VALUES(lastSeenImportId),
        -- An export without the email column keeps the last captured hash.
        railsEmailSha256 = COALESCE(VALUES(railsEmailSha256), railsEmailSha256),
        tokenSha256 = VALUES(tokenSha256)
    `,
    [
      ...matches.flatMap((row) => [
        legacyFeedTokenId(row.railsUserId),
        row.userId,
        row.railsUserId,
        row.tokenSha256,
        RAILS_SOURCE,
        input.importId,
        row.emailSha256,
      ]),
      ABSENT_FROM_EXPORT_REASON,
      ABSENT_FROM_EXPORT_REASON,
    ],
  );

  return { matched: matches.length, matchedRailsIds, affectedRows: result.affectedRows };
}

/** Active imported rows whose Rails user is not among `presentRailsIds` (dry run). */
async function countAbsentActive(connection: MysqlConnection, presentRailsIds: readonly string[]) {
  const active = await count(
    connection,
    "SELECT COUNT(*) AS count FROM egghead_LegacyFeedToken WHERE source = ? AND revokedAt IS NULL",
    [RAILS_SOURCE],
  );
  const presentCounts = await Promise.all(
    chunk(presentRailsIds).map((ids) =>
      count(
        connection,
        `SELECT COUNT(*) AS count FROM egghead_LegacyFeedToken WHERE source = ? AND revokedAt IS NULL AND legacyRailsUserId IN (${ids.map(() => "?").join(", ")})`,
        [RAILS_SOURCE, ...ids],
      ),
    ),
  );
  return { active, absent: active - presentCounts.reduce((total, value) => total + value, 0) };
}

export type LegacyFeedTokenImportSummary = {
  mode: "apply" | "dry-run";
  runtime: string;
  database: string;
  parsed: number;
  rejected: Record<string, number>;
  matchedCbUsers: number;
  unmatchedRailsUsers: number;
  affectedRows: number;
  activeBeforeRevocation: number;
  absentFromExport: number;
  revoked: number;
  revocationSkipped: string | null;
};

export async function runLegacyFeedTokenImport(input: {
  file: string;
  apply: boolean;
  allowMassRevoke?: boolean;
  /** Override MASS_REVOKE_MINIMUM (tests on tiny tables). */
  massRevokeMinimum?: number;
}): Promise<LegacyFeedTokenImportSummary> {
  const { file, apply } = input;
  const safety = apply ? assertWritesAllowed() : assertDatabaseUrlForRuntime();
  const { rows, rejected } = parseLegacyFeedTokenExport(readFileSync(file, "utf8"));
  const rejectedByReason: Record<string, number> = {};
  for (const entry of rejected) {
    rejectedByReason[entry.reason] = (rejectedByReason[entry.reason] ?? 0) + 1;
  }
  // An empty or unreadable export must never be treated as "revoke everyone".
  if (rows.length === 0) {
    throw new Error("The export has no valid rows; refusing to sync (nothing was written).");
  }

  const importId = randomUUID();
  const connection = await createEggheadMysqlConnection();

  try {
    // mysql2 runs commands on one connection in order, so this stays serial.
    const outcomes = await Promise.all(
      chunk(rows).map((batch) => importBatch(connection, batch, { apply, importId })),
    );
    const matched = outcomes.reduce((total, outcome) => total + outcome.matched, 0);
    const written = outcomes.reduce((total, outcome) => total + outcome.affectedRows, 0);

    let activeBeforeRevocation: number;
    let absentFromExport: number;
    if (apply) {
      activeBeforeRevocation = await count(
        connection,
        "SELECT COUNT(*) AS count FROM egghead_LegacyFeedToken WHERE source = ? AND revokedAt IS NULL",
        [RAILS_SOURCE],
      );
      absentFromExport = await count(
        connection,
        `SELECT COUNT(*) AS count FROM egghead_LegacyFeedToken
         WHERE source = ? AND revokedAt IS NULL AND (lastSeenImportId IS NULL OR lastSeenImportId <> ?)`,
        [RAILS_SOURCE, importId],
      );
    } else {
      const presentRailsIds = outcomes.flatMap((outcome) => outcome.matchedRailsIds);
      const counts = await countAbsentActive(connection, presentRailsIds);
      activeBeforeRevocation = counts.active;
      absentFromExport = counts.absent;
    }

    const allowed = revocationAllowed({
      toRevoke: absentFromExport,
      active: activeBeforeRevocation,
      allowMassRevoke: input.allowMassRevoke ?? false,
      ...(input.massRevokeMinimum === undefined ? {} : { minimum: input.massRevokeMinimum }),
    });
    let revoked = 0;
    let revocationSkipped: string | null = null;
    if (!allowed) {
      revocationSkipped = "mass_revoke_needs_--allow-mass-revoke";
    } else if (!apply) {
      revocationSkipped = "dry_run";
    } else if (absentFromExport > 0) {
      const [result] = await connection.query<ResultSetHeader>(
        `UPDATE egghead_LegacyFeedToken
         SET revokedAt = CURRENT_TIMESTAMP(3), revokedReason = ?
         WHERE source = ? AND revokedAt IS NULL AND (lastSeenImportId IS NULL OR lastSeenImportId <> ?)`,
        [ABSENT_FROM_EXPORT_REASON, RAILS_SOURCE, importId],
      );
      revoked = result.affectedRows;
    }

    return {
      mode: apply ? "apply" : "dry-run",
      runtime: safety.runtime,
      database: safety.database,
      parsed: rows.length,
      rejected: rejectedByReason,
      matchedCbUsers: matched,
      unmatchedRailsUsers: rows.length - matched,
      affectedRows: written,
      activeBeforeRevocation,
      absentFromExport,
      revoked,
      revocationSkipped,
    };
  } finally {
    await connection.end();
  }
}
