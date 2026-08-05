import { DrizzleAdapter } from "@coursebuilder/adapter-drizzle";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";

import {
  assertDatabaseUrlForRuntime,
  getDatabaseUrl,
  mysqlConnectionOptionsFromUrl,
} from "./local-docker";
import { mysqlTable } from "./mysql-table";
import * as schema from "./schema";

type CourseBuilderAuthAdapter = ReturnType<typeof DrizzleAdapter>;
type EggheadDatabase = MySql2Database<typeof schema>;

let adapter: CourseBuilderAuthAdapter | null = null;
let database: EggheadDatabase | null = null;
let databasePool: mysql.Pool | null = null;

function getDatabasePool() {
  if (databasePool) {
    return databasePool;
  }

  const databaseUrl = getDatabaseUrl();
  assertDatabaseUrlForRuntime(databaseUrl);
  databasePool = mysql.createPool(mysqlConnectionOptionsFromUrl(databaseUrl));

  return databasePool;
}

export function getEggheadDatabase() {
  if (database) {
    return database;
  }

  database = drizzle(getDatabasePool(), { mode: "default", schema });

  return database;
}

export function getCourseBuilderAdapter() {
  if (adapter) {
    return adapter;
  }

  // The published adapter currently expects Drizzle's schema-less MySQL type.
  // App queries use the typed database instance above over the same connection pool.
  const db = drizzle(getDatabasePool());
  adapter = DrizzleAdapter(db, mysqlTable);

  return adapter;
}
