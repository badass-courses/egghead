import { sql } from "drizzle-orm";
import { char, index, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

import { mysqlTable } from "./mysql-table";

/**
 * Rails feed tokens (users.authentication_token), carried over so existing
 * podcast and RSS subscriptions keep authenticating after the domain flip.
 *
 * Rails feed URLs carry `?user_email=…&user_token=<uuid>`. We store only the
 * SHA-256 of the token, never the token itself: the Rails export hashes it
 * in SQL, so the raw value never leaves the Rails database. Token UUIDs carry
 * 122 random bits, so an unsalted fast hash is safe here.
 *
 * Revocation sets `revokedAt`; rows are never reused for a new token. The
 * import is a full sync: rows whose Rails user is absent from the latest
 * export are revoked (`revokedReason = 'absent_from_rails_export'`), and
 * `lastSeenImportId` records which import last saw each row.
 *
 * `railsEmailSha256` is the SHA-256 of the user's Rails email (Devise stored it
 * lowercased and trimmed). Feed URLs carry that email, so auth accepts it even
 * when the CB email differs.
 */
export const legacyFeedTokens = mysqlTable(
  "LegacyFeedToken",
  {
    id: varchar("id", { length: 255 }).notNull().primaryKey(),
    userId: varchar("userId", { length: 255 }).notNull(),
    legacyRailsUserId: varchar("legacyRailsUserId", { length: 255 }).notNull(),
    tokenSha256: char("tokenSha256", { length: 64 }).notNull(),
    source: varchar("source", { length: 64 }).notNull().default("rails_authentication_token"),
    importedAt: timestamp("importedAt", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    revokedAt: timestamp("revokedAt", { mode: "date", fsp: 3 }),
    revokedReason: varchar("revokedReason", { length: 191 }),
    lastSeenImportId: varchar("lastSeenImportId", { length: 64 }),
    /** SHA-256 of the Rails email at export time; the feed URL carries that email. */
    railsEmailSha256: char("railsEmailSha256", { length: 64 }),
  },
  (token) => ({
    tokenSha256Idx: uniqueIndex("legacyFeedToken_tokenSha256_idx").on(token.tokenSha256),
    legacyRailsUserIdIdx: uniqueIndex("legacyFeedToken_legacyRailsUserId_idx").on(
      token.legacyRailsUserId,
    ),
    userIdIdx: index("legacyFeedToken_userId_idx").on(token.userId),
  }),
);
