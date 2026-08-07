import { DrizzleAdapter } from "@coursebuilder/adapter-drizzle";
import { drizzle } from "drizzle-orm/mysql2";

import { getEggheadMysqlPool } from "./local-docker";
import { mysqlTable } from "./mysql-table";

type CourseBuilderAuthAdapter = ReturnType<typeof DrizzleAdapter>;

let adapter: CourseBuilderAuthAdapter | null = null;

export function getCourseBuilderAdapter() {
  if (adapter) {
    return adapter;
  }

  const db = drizzle(getEggheadMysqlPool());
  adapter = DrizzleAdapter(db, mysqlTable);

  return adapter;
}
