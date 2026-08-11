import { DrizzleAdapter } from "@coursebuilder/adapter-drizzle";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";

import { getEggheadMysqlPool } from "./local-docker";
import { mysqlTable } from "./mysql-table";
import * as schema from "./schema";

type CourseBuilderAuthAdapter = ReturnType<typeof DrizzleAdapter>;
type EggheadDatabase = MySql2Database<typeof schema>;

let adapter: CourseBuilderAuthAdapter | null = null;
let database: EggheadDatabase | null = null;

export function getEggheadDatabase() {
  if (database) {
    return database;
  }

  database = drizzle(getEggheadMysqlPool(), { mode: "default", schema });

  return database;
}

export function getCourseBuilderAdapter() {
  if (adapter) {
    return adapter;
  }

  // The published adapter currently expects Drizzle's schema-less MySQL type.
  // App queries use the typed database instance above over the same connection pool.
  const db = drizzle(getEggheadMysqlPool());
  adapter = DrizzleAdapter(db, mysqlTable);

  return adapter;
}
