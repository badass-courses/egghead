import type { RowDataPacket } from "mysql2";

import type { createLocalMysqlConnection } from "../db/local-docker";

type MysqlConnection = Awaited<ReturnType<typeof createLocalMysqlConnection>>;

let hasSlugColumnPromise: Promise<boolean> | null = null;

async function hasContentResourceSlugColumn(connection: MysqlConnection) {
  hasSlugColumnPromise ??= connection
    .query<RowDataPacket[]>("SHOW COLUMNS FROM egghead_ContentResource LIKE 'slug'")
    .then(([rows]) => rows.length > 0)
    .catch((error: unknown) => {
      hasSlugColumnPromise = null;
      throw error;
    });

  return hasSlugColumnPromise;
}

export function contentResourceSlugJsonSql(alias: string) {
  return `JSON_UNQUOTE(JSON_EXTRACT(${alias}.fields, '$.slug'))`;
}

export async function contentResourceSlugSql(connection: MysqlConnection, alias: string) {
  return (await hasContentResourceSlugColumn(connection))
    ? `${alias}.slug`
    : contentResourceSlugJsonSql(alias);
}
