// Sync Rails feed tokens (hashed) into egghead_LegacyFeedToken.
//
// Usage:
//   pnpm feeds:import-tokens <export.csv>                 # dry run: parse, match, count revocations
//   pnpm feeds:import-tokens <export.csv> --apply         # upsert, then revoke rows absent from the export
//   ... --apply --allow-mass-revoke                       # allow revoking >10% of active rows
//
// The export comes from egghead-rails (Postgres, pgcrypto), hashed in SQL so
// raw tokens never leave it. In psql:
//   \copy (SELECT id AS rails_user_id,
//                 encode(digest(authentication_token, 'sha256'), 'hex') AS token_sha256
//          FROM users
//          WHERE authentication_token IS NOT NULL AND authentication_token <> ''
//          ORDER BY id) TO 'export.csv' WITH CSV HEADER
//
// Writes need the runtime guard: local Docker, or EGGHEAD_RUNTIME=production
// with EGGHEAD_FEED_TOKEN_IMPORT_APPROVED=true. Beta is refused for writes
// because beta is read-only for this app. The script prints counts only; it
// never prints emails, user ids or hashes.

import { runLegacyFeedTokenImport } from "../apps/web/src/feeds/token-import-run";

async function main() {
  const [file, ...flags] = process.argv.slice(2);
  if (!file) {
    throw new Error(
      "Usage: import-legacy-feed-tokens <export.csv> [--apply] [--allow-mass-revoke]",
    );
  }
  const summary = await runLegacyFeedTokenImport({
    file,
    apply: flags.includes("--apply"),
    allowMassRevoke: flags.includes("--allow-mass-revoke"),
  });
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
