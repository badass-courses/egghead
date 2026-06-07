import { mysqlTableCreator } from "drizzle-orm/mysql-core";

export const EGGHEAD_TABLE_PREFIX = "egghead_";

export const mysqlTable = mysqlTableCreator(
  (name) => `${EGGHEAD_TABLE_PREFIX}${name}`,
);

export function getEggheadTableName(name: string) {
  return `${EGGHEAD_TABLE_PREFIX}${name}`;
}
