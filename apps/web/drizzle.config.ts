import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  dialect: "mysql",
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "mysql://root:root@127.0.0.1:3307/coursebuilder_test",
  },
  tablesFilter: ["egghead_*"],
});
