// Run the feeds MySQL integration suite against a disposable local MySQL.
//
//   FEEDS_MYSQL_URL_FILE=<file> pnpm feeds:mysql-test  (a file holding a disposable MySQL URL)
//   FEEDS_MYSQL_URL=mysql://user:pass@127.0.0.1:<port>/<any> pnpm feeds:mysql-test
//
// Steps: create and stamp `<stem>_feeds_test` (loopback only; never the
// database named in the URL), or confirm an existing one carries our stamp;
// push the app schema with `drizzle-kit push --force` into that database
// only; then run apps/web/src/feeds/mysql.integration.test.ts with
// FEEDS_MYSQL_TEST_URL set. See apps/web/src/feeds/mysql-fixture.ts.
// The URL is passed through the environment and never printed.

import { spawnSync } from "node:child_process";

import {
  ensureFeedsTestDatabase,
  feedsMysqlBaseUrl,
  feedsTestDatabaseUrl,
} from "../apps/web/src/feeds/mysql-fixture";

function run(command: string, args: string[], env: Record<string, string>) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${String(result.status)}`);
  }
}

async function main() {
  const base = feedsMysqlBaseUrl();
  if (!base) {
    throw new Error(
      "Set FEEDS_MYSQL_URL or FEEDS_MYSQL_URL_FILE (a file holding a disposable MySQL URL).",
    );
  }
  const testUrl = feedsTestDatabaseUrl(base);
  const state = await ensureFeedsTestDatabase(testUrl);
  console.log(
    `[feeds:mysql-test] database ${testUrl.pathname.slice(1)} on ${testUrl.hostname} (${state})`,
  );

  const env = {
    DATABASE_URL: testUrl.toString(),
    EGGHEAD_RUNTIME: "local",
    FEEDS_MYSQL_TEST_URL: testUrl.toString(),
  };
  run("pnpm", ["--filter", "@egghead/web", "exec", "drizzle-kit", "push", "--force"], env);
  run(
    "pnpm",
    ["--filter", "@egghead/web", "exec", "vitest", "run", "src/feeds/mysql.integration.test.ts"],
    env,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
