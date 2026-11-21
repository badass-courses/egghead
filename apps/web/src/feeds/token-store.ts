import type { RowDataPacket } from "mysql2";

import { evaluateContentAccessForUser } from "../access/evaluate";
import { createLocalMysqlConnection } from "../db/local-docker";
import { feedRoleGrantsAccess, type FeedMembershipCheck, type FeedTokenStore } from "./token";

type TokenRow = RowDataPacket & {
  userId: string;
  email: string | null;
  railsEmailSha256: string | null;
  revokedAt: Date | null;
};

type RoleRow = RowDataPacket & { role: string | null };

/** Read-only lookup against egghead_LegacyFeedToken joined to the CB user. */
export const mysqlFeedTokenStore: FeedTokenStore = {
  async findByTokenSha256(tokenSha256) {
    const connection = await createLocalMysqlConnection();
    try {
      const [rows] = await connection.execute<TokenRow[]>(
        `
          SELECT token.userId, user.email, token.railsEmailSha256, token.revokedAt
          FROM egghead_LegacyFeedToken token
          JOIN egghead_User user ON user.id = token.userId
          WHERE token.tokenSha256 = ?
          LIMIT 1
        `,
        [tokenSha256],
      );
      const row = rows[0];
      return row
        ? {
            userId: row.userId,
            email: row.email,
            railsEmailSha256: row.railsEmailSha256,
            revokedAt: row.revokedAt,
          }
        : null;
    } finally {
      await connection.end();
    }
  },
};

/**
 * Rails pro_user_permissions: pro (not trialing) or instructor. CB answers the
 * pro half with the broad-entitlement evaluator (bare legacy `pro` does not
 * grant; subscriptions require active paid-through grants), and the instructor
 * half with the admin/contributor roles.
 */
export const mysqlFeedMembership: FeedMembershipCheck = async (userId) => {
  const connection = await createLocalMysqlConnection();
  try {
    const [rows] = await connection.execute<RoleRow[]>(
      "SELECT user.role FROM egghead_User user WHERE user.id = ? LIMIT 1",
      [userId],
    );
    if (feedRoleGrantsAccess(rows[0]?.role)) return true;
  } finally {
    await connection.end();
  }

  return (await evaluateContentAccessForUser({ userId })).granted;
};
