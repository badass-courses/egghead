// Pure parts of the Rails feed-token import. The script lives in
// scripts/import-legacy-feed-tokens.ts.
//
// egghead-rails runs on Postgres with pgcrypto enabled. The export hashes
// tokens in SQL so raw tokens never leave Rails (see RAILS_TOKEN_EXPORT_SQL).
// Tokens are case-sensitive UUIDs (Devise.secure_compare), so they are hashed
// exactly as stored, with no case folding.

import { createHash } from "node:crypto";

export const LEGACY_FEED_TOKEN_EXPORT_HEADER = "rails_user_id,token_sha256,email_sha256";
/** Round-1 exports had no email column; they still parse (no email hash stored). */
const LEGACY_FEED_TOKEN_EXPORT_HEADER_V1 = "rails_user_id,token_sha256";

/**
 * Run in psql against egghead-rails: \copy (<this>) TO 'export.csv' WITH CSV HEADER
 * Both the token and the email leave Rails only as SHA-256 hex.
 */
export const RAILS_TOKEN_EXPORT_SQL =
  "SELECT id AS rails_user_id, encode(digest(authentication_token, 'sha256'), 'hex') AS token_sha256, " +
  "encode(digest(lower(btrim(email)), 'sha256'), 'hex') AS email_sha256 " +
  "FROM users WHERE authentication_token IS NOT NULL AND authentication_token <> '' ORDER BY id";

export const ABSENT_FROM_EXPORT_REASON = "absent_from_rails_export";

/** Rails ids arrive as CSV strings, MySQL numbers or JSON strings; compare one form. */
export function railsUserIdKey(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "bigint" && value > 0n) return value.toString();
  if (typeof value === "string" && RAILS_ID.test(value.trim())) return value.trim();
  return null;
}

/**
 * Full-sync revocation guard. Revoking every feed URL at once is reversible
 * (re-import) but cuts off subscribers, so a sync that would revoke more than
 * this share of active rows needs an explicit --allow-mass-revoke.
 */
export const MASS_REVOKE_FRACTION = 0.1;
/** Small syncs (a handful of closed accounts) never need the override. */
export const MASS_REVOKE_MINIMUM = 25;

export function revocationAllowed(input: {
  toRevoke: number;
  active: number;
  allowMassRevoke: boolean;
  minimum?: number;
}) {
  if (input.toRevoke === 0) return true;
  if (input.allowMassRevoke) return true;
  const limit = Math.max(
    input.minimum ?? MASS_REVOKE_MINIMUM,
    Math.floor(input.active * MASS_REVOKE_FRACTION),
  );
  return input.toRevoke <= limit;
}

export type LegacyFeedTokenExportRow = {
  railsUserId: string;
  tokenSha256: string;
  emailSha256: string | null;
};

export type LegacyFeedTokenParseResult = {
  rows: LegacyFeedTokenExportRow[];
  rejected: Array<{ line: number; reason: string }>;
};

const SHA256_HEX = /^[0-9a-f]{64}$/;
const RAILS_ID = /^[1-9]\d*$/;

function rejectionReason(input: {
  railsUserId: string;
  tokenSha256: string;
  emailSha256: string;
  extra: readonly string[];
  seenUsers: ReadonlySet<string>;
  seenHashes: ReadonlySet<string>;
}): string | null {
  if (input.extra.length > 0) return "extra_columns";
  if (!RAILS_ID.test(input.railsUserId)) return "bad_rails_user_id";
  // A raw UUID here means the export skipped SHA2(); refuse rather than store it.
  if (!SHA256_HEX.test(input.tokenSha256)) return "not_sha256_hex";
  if (input.emailSha256 && !SHA256_HEX.test(input.emailSha256)) return "email_not_sha256_hex";
  if (input.seenUsers.has(input.railsUserId)) return "duplicate_user";
  if (input.seenHashes.has(input.tokenSha256)) return "duplicate_token";
  return null;
}

export function parseLegacyFeedTokenExport(csv: string): LegacyFeedTokenParseResult {
  const rows: LegacyFeedTokenExportRow[] = [];
  const rejected: LegacyFeedTokenParseResult["rejected"] = [];
  const seenUsers = new Set<string>();
  const seenHashes = new Set<string>();
  const lines = csv.split(/\r?\n/);

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const header = line.toLowerCase();
    if (
      index === 0 &&
      (header === LEGACY_FEED_TOKEN_EXPORT_HEADER || header === LEGACY_FEED_TOKEN_EXPORT_HEADER_V1)
    ) {
      continue;
    }

    const [railsUserId = "", rawHash = "", rawEmailHash = "", ...extra] = line
      .split(",")
      .map((cell) => cell.trim());
    const tokenSha256 = rawHash.toLowerCase();
    const emailSha256 = rawEmailHash.toLowerCase();
    const reason = rejectionReason({
      railsUserId,
      tokenSha256,
      emailSha256,
      extra,
      seenUsers,
      seenHashes,
    });

    if (reason) {
      rejected.push({ line: index + 1, reason });
      continue;
    }

    seenUsers.add(railsUserId);
    seenHashes.add(tokenSha256);
    rows.push({ railsUserId, tokenSha256, emailSha256: emailSha256 || null });
  }

  return { rows, rejected };
}

/** Deterministic row id so re-running the import upserts instead of duplicating. */
export function legacyFeedTokenId(railsUserId: string) {
  return `lft_${createHash("sha256").update(`rails-user:${railsUserId}`).digest("hex").slice(0, 32)}`;
}
