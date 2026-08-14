import { mySqlDrizzleAdapter } from "@coursebuilder/adapter-drizzle/mysql";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";

import { getEggheadMysqlPool } from "./local-docker";
import { mysqlTable } from "./mysql-table";
import * as schema from "./schema";

type CourseBuilderAuthAdapter = ReturnType<typeof mySqlDrizzleAdapter>;
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

  adapter = mySqlDrizzleAdapter(getEggheadDatabase(), mysqlTable);

  return adapter;
}
