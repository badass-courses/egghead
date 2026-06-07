import { sql } from "drizzle-orm";
import {
  index,
  json,
  type MySqlTableFn,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export function getEggheadUsersSchema(mysqlTable: MySqlTableFn) {
  return mysqlTable(
    "User",
    {
      id: varchar("id", { length: 255 }).notNull().primaryKey(),
      name: varchar("name", { length: 255 }),
      role: varchar("role", { length: 191 }).notNull().default("user"),
      email: varchar("email", { length: 255 }).notNull().unique(),
      fields: json("fields").$type<Record<string, unknown>>().default({}),
      legacyRailsUserId: varchar("legacyRailsUserId", {
        length: 255,
      }).generatedAlwaysAs(sql`(fields->>'$.legacyRailsUserId')`, {
        mode: "stored",
      }),
      legacyContactId: varchar("legacyContactId", {
        length: 255,
      }).generatedAlwaysAs(sql`(fields->>'$.legacyContactId')`, {
        mode: "stored",
      }),
      emailVerified: timestamp("emailVerified", {
        mode: "date",
        fsp: 3,
      }),
      image: varchar("image", { length: 255 }),
      createdAt: timestamp("createdAt", {
        mode: "date",
        fsp: 3,
      }).default(sql`CURRENT_TIMESTAMP(3)`),
    },
    (user) => ({
      emailIdx: index("email_idx").on(user.email),
      roleIdx: index("role_idx").on(user.role),
      createdAtIdx: index("created_at_idx").on(user.createdAt),
      legacyRailsUserIdIdx: uniqueIndex("legacyRailsUserId_idx").on(user.legacyRailsUserId),
      legacyContactIdIdx: index("legacyContactId_idx").on(user.legacyContactId),
    }),
  );
}
