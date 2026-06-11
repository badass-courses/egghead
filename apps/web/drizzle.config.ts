import { defineConfig } from "drizzle-kit";

const url = process.env["DATABASE_URL"];

if (!url) {
  throw new Error("DATABASE_URL is required to run drizzle-kit (see apps/web/.env.local).");
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  dialect: "mysql",
  dbCredentials: { url },
  tablesFilter: ["egghead_*"],
});
