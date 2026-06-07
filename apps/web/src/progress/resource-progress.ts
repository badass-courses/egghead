import type { ResultSetHeader, RowDataPacket } from "mysql2";

import { createLocalMysqlConnection } from "../db/local-docker";

type ResourceProgressRow = RowDataPacket & {
  userId: string;
  resourceId: string;
  completedAt: Date | null;
  fields: unknown;
};

export type ResourceProgressState = {
  exists: boolean;
  completed: boolean;
  completedAt: string | null;
  source: string | null;
};

export type AnonymousProgressState = {
  userProgressCreated: false;
  anonymousStateSeparated: true;
  completionFaked: false;
  signInRequired: true;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldsFromJson(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (isRecord(value)) return value;

  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  return {};
}

function progressState(row: ResourceProgressRow | null): ResourceProgressState {
  if (!row) {
    return {
      exists: false,
      completed: false,
      completedAt: null,
      source: null,
    };
  }

  const fields = fieldsFromJson(row.fields);
  const sourceValue = fields["source"];
  const source = typeof sourceValue === "string" ? sourceValue : null;

  return {
    exists: true,
    completed: row.completedAt !== null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    source,
  };
}

export async function ensureLocalResourceProgressTable() {
  const connection = await createLocalMysqlConnection();

  try {
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS egghead_ResourceProgress (
        userId varchar(255) NOT NULL,
        resourceId varchar(255) NOT NULL,
        completedAt timestamp(3) NULL DEFAULT NULL,
        fields json DEFAULT NULL,
        createdAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updatedAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (userId, resourceId),
        KEY userId_idx (userId),
        KEY resourceId_idx (resourceId),
        KEY completedAt_idx (completedAt)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    return {
      ok: true,
      table: "egghead_ResourceProgress",
      localDockerOnly: true,
    };
  } finally {
    await connection.end();
  }
}

export async function readResourceProgress(input: {
  userId: string;
  resourceId: string;
}): Promise<ResourceProgressState> {
  const connection = await createLocalMysqlConnection();

  try {
    const [rows] = await connection.execute<ResourceProgressRow[]>(
      `
        SELECT userId, resourceId, completedAt, fields
        FROM egghead_ResourceProgress
        WHERE userId = ?
          AND resourceId = ?
        LIMIT 1
      `,
      [input.userId, input.resourceId],
    );

    return progressState(rows[0] ?? null);
  } finally {
    await connection.end();
  }
}

export async function seedResourceProgress(input: {
  userId: string;
  resourceId: string;
  completedAt: Date | null;
  source: string;
}) {
  const connection = await createLocalMysqlConnection();

  try {
    const [result] = await connection.execute<ResultSetHeader>(
      `
        INSERT INTO egghead_ResourceProgress
          (userId, resourceId, completedAt, fields, createdAt, updatedAt)
        VALUES (?, ?, ?, CAST(? AS JSON), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
        ON DUPLICATE KEY UPDATE
          completedAt = VALUES(completedAt),
          fields = VALUES(fields),
          updatedAt = CURRENT_TIMESTAMP(3)
      `,
      [
        input.userId,
        input.resourceId,
        input.completedAt,
        JSON.stringify({
          source: input.source,
          localOnly: true,
        }),
      ],
    );

    return {
      affectedRows: result.affectedRows,
      state: await readResourceProgress(input),
    };
  } finally {
    await connection.end();
  }
}

export async function completeResourceForUser(input: {
  userId: string;
  resourceId: string;
  source: string;
}) {
  const connection = await createLocalMysqlConnection();
  const completedAt = new Date();

  try {
    const [result] = await connection.execute<ResultSetHeader>(
      `
        INSERT INTO egghead_ResourceProgress
          (userId, resourceId, completedAt, fields, createdAt, updatedAt)
        VALUES (?, ?, ?, CAST(? AS JSON), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
        ON DUPLICATE KEY UPDATE
          completedAt = COALESCE(completedAt, VALUES(completedAt)),
          fields = VALUES(fields),
          updatedAt = CURRENT_TIMESTAMP(3)
      `,
      [
        input.userId,
        input.resourceId,
        completedAt,
        JSON.stringify({
          source: input.source,
          localOnly: true,
        }),
      ],
    );

    return {
      affectedRows: result.affectedRows,
      state: await readResourceProgress(input),
    };
  } finally {
    await connection.end();
  }
}

export function anonymousProgressState(): AnonymousProgressState {
  return {
    userProgressCreated: false,
    anonymousStateSeparated: true,
    completionFaked: false,
    signInRequired: true,
  };
}
