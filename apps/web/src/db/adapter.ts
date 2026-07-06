import { DrizzleAdapter } from "@coursebuilder/adapter-drizzle";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";

import {
  assertDatabaseUrlForRuntime,
  getDatabaseUrl,
  mysqlConnectionOptionsFromUrl,
} from "./local-docker";
import { mysqlTable } from "./mysql-table";

type CourseBuilderAuthAdapter = ReturnType<typeof DrizzleAdapter>;

let adapter: CourseBuilderAuthAdapter | null = null;

export function getCourseBuilderAdapter() {
  if (adapter) {
    return adapter;
  }

  const databaseUrl = getDatabaseUrl();
  assertDatabaseUrlForRuntime(databaseUrl);

  const pool = mysql.createPool(mysqlConnectionOptionsFromUrl(databaseUrl));
  const db = drizzle(pool);
  adapter = DrizzleAdapter(db, mysqlTable);

  return adapter;
}
