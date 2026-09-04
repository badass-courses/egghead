import { mySqlDrizzleAdapter } from "@coursebuilder/adapter-drizzle/mysql";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";

import { getEggheadMysqlPool } from "./local-docker";
import { mysqlTable } from "./mysql-table";
import * as schema from "./schema";
import { withAdapterRuntimePolicy, type PublishedAdapter } from "./adapter-policy";

type EggheadDatabase = MySql2Database<typeof schema>;

let adapter: PublishedAdapter | null = null;
let database: EggheadDatabase | null = null;

export function getEggheadDatabase() {
  const pool = getEggheadMysqlPool();
  if (database) {
    return database;
  }

  database = drizzle(pool, { mode: "default", schema });

  return database;
}

export function getCourseBuilderAdapter() {
  const db = getEggheadDatabase();
  if (adapter) {
    return adapter;
  }

  adapter = withAdapterRuntimePolicy(mySqlDrizzleAdapter(db, mysqlTable));

  return adapter;
}
