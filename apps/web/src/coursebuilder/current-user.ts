import { createHash } from "node:crypto";
import type { RowDataPacket } from "mysql2";

import { evaluateContentAccessForUser } from "../access/evaluate";
import { createLocalMysqlConnection } from "../db/local-docker";

type FixtureUserRow = RowDataPacket & {
  userId: string;
};

type CurrentUserPayload = {
  id: string;
  role: "user";
  identitySource: "coursebuilder-local-docker-fixture";
  access: Awaited<ReturnType<typeof evaluateContentAccessForUser>>;
  support: {
    accessSummary: string;
  };
};

export type CurrentUserReadModel = {
  user: CurrentUserPayload | null;
  compatibility: {
    anonymousReturnsNullUser: true;
    invalidCredentialRejected?: true;
    fixtureSignedInUser?: true;
  };
};

function hashUserId(userId: string) {
  return createHash("sha1").update(`coursebuilder-user:${userId}`).digest("hex").slice(0, 16);
}

async function findActiveAllAccessFixtureUserId() {
  const connection = await createLocalMysqlConnection();

  try {
    const [rows] = await connection.execute<FixtureUserRow[]>(
      `
        SELECT userId
        FROM egghead_Entitlement
        WHERE deletedAt IS NULL
          AND entitlementType = 'egghead_all_access_subscription'
          AND sourceType = 'rails_account_subscription'
          AND userId IS NOT NULL
          AND (expiresAt IS NULL OR expiresAt > CURRENT_TIMESTAMP(3))
          AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.status')) = 'active'
        ORDER BY id ASC
        LIMIT 1
      `,
    );

    return rows[0]?.userId ?? null;
  } finally {
    await connection.end();
  }
}

export function getCurrentUser() {
  return Promise.resolve(null);
}

export async function getCurrentUserFromRequest(request: Request): Promise<CurrentUserReadModel> {
  const fixture = request.headers.get("x-egghead-mve-fixture");
  const authorization = request.headers.get("authorization");

  if (!fixture && authorization) {
    return {
      user: null,
      compatibility: {
        anonymousReturnsNullUser: true,
        invalidCredentialRejected: true,
      },
    };
  }

  if (fixture !== "active-all-access-user") {
    return {
      user: null,
      compatibility: {
        anonymousReturnsNullUser: true,
      },
    };
  }

  const userId = await findActiveAllAccessFixtureUserId();

  if (!userId) {
    return {
      user: null,
      compatibility: {
        anonymousReturnsNullUser: true,
        invalidCredentialRejected: true,
      },
    };
  }

  const access = await evaluateContentAccessForUser({ userId });

  return {
    user: {
      id: hashUserId(userId),
      role: "user",
      identitySource: "coursebuilder-local-docker-fixture",
      access,
      support: {
        accessSummary: access.granted ? access.reason : "denied:no_granting_entitlement",
      },
    },
    compatibility: {
      anonymousReturnsNullUser: true,
      fixtureSignedInUser: true,
    },
  };
}
