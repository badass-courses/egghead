import { defineConfig } from "drizzle-kit";

import { assertLocalDockerDatabaseUrl } from "./src/db/local-docker";
import { getEggheadRuntime, isReadOnlyBeta } from "./src/runtime";

// Drizzle Kit loads this before any `push` or `migrate` can connect.
if (getEggheadRuntime() !== "local" || isReadOnlyBeta()) {
  throw new Error(
    "Web schema tools require local Docker; use a reviewed deploy request for remote DDL.",
  );
}

const url = process.env["DATABASE_URL"];

if (!url) {
  throw new Error("DATABASE_URL is required to run drizzle-kit (see apps/web/.env.local).");
}

assertLocalDockerDatabaseUrl(url);

export default defineConfig({
  schema: "./src/db/schema.ts",
  dialect: "mysql",
  dbCredentials: { url },
  tablesFilter: ["egghead_*"],
});
