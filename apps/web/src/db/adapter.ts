import { DrizzleAdapter } from "@coursebuilder/adapter-drizzle";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";

import { assertLocalDockerDatabaseUrl, getDatabaseUrl } from "@/db/local-docker";
import { mysqlTable } from "@/db/mysql-table";

let adapter: ReturnType<typeof DrizzleAdapter> | null = null;

export function getCourseBuilderAdapter() {
  if (adapter) return adapter;

  const databaseUrl = getDatabaseUrl();
  assertLocalDockerDatabaseUrl(databaseUrl);

  const pool = mysql.createPool(databaseUrl);
  const db = drizzle(pool);
  adapter = DrizzleAdapter(db, mysqlTable);

  return adapter;
}
