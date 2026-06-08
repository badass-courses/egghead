import { DrizzleAdapter } from "@coursebuilder/adapter-drizzle";
import type { CourseBuilderAdapter } from "@coursebuilder/core/adapters";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";

import { assertDatabaseUrlForRuntime, getDatabaseUrl } from "./local-docker";
import { mysqlTable } from "./mysql-table";

let adapter: CourseBuilderAdapter | null = null;

export function getCourseBuilderAdapter() {
  if (adapter) {
    return adapter;
  }

  const databaseUrl = getDatabaseUrl();
  assertDatabaseUrlForRuntime(databaseUrl);

  const pool = mysql.createPool(databaseUrl);
  const db = drizzle(pool);
  adapter = DrizzleAdapter(db, mysqlTable);

  return adapter;
}
