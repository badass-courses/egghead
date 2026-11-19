// Backfill Rails publish dates and slugs into CB fields for the feeds.
// Dry run by default; prints counts only.
//
//   1. Export from egghead-rails (see RAILS_FEED_FIELDS_EXPORT_SQL in
//      apps/web/src/feeds/rails-backfill.ts):
//        \copy (<sql>) TO 'rails-feed-fields.csv' WITH CSV HEADER
//   2. Dry run:  pnpm feeds:backfill-rails rails-feed-fields.csv
//   3. Apply:    EGGHEAD_FEED_BACKFILL_APPROVED=true pnpm feeds:backfill-rails rails-feed-fields.csv \
//                  --apply --rollback-file <new path>
//      (beta needs EGGHEAD_RUNTIME=beta EGGHEAD_BETA_DB_APPROVED=true; production
//      needs EGGHEAD_RUNTIME=production. Local Docker needs no approval.)
//   4. Undo:     pnpm feeds:backfill-rails --rollback <rollback file> [--apply]
//   Add --show-conflicts to list every disagreement (kind, rails id, CB id,
//   CB value, Rails value; public content only).
//   Add --fix-pacific-shift to overwrite a CB publishedAt that is exactly the
//   Rails instant plus the Los Angeles UTC offset (the migration read Rails
//   UTC as Pacific wall time). The old CB value goes into the rollback file,
//   and --rollback restores it. Every other conflict is counted, never changed.
//
// It only adds missing `publishedAt` and `legacyRailsSlug` keys, never
// overwrites, and reports conflicts. Re-running is a no-op.

import { rollbackRailsBackfill, runRailsBackfill } from "../apps/web/src/feeds/rails-backfill-run";

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const apply = args.includes("--apply");
  const valueOf = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? (args[index + 1] ?? null) : null;
  };

  const rollback = valueOf("--rollback");
  if (rollback) {
    console.log(JSON.stringify(await rollbackRailsBackfill({ rollbackFile: rollback, apply })));
    return;
  }

  const file = args.find(
    (arg, index) => !arg.startsWith("--") && args[index - 1] !== "--rollback-file",
  );
  if (!file) throw new Error("Pass the Rails export CSV path.");
  const rollbackFile = valueOf("--rollback-file");
  if (apply && !rollbackFile) throw new Error("--apply needs --rollback-file <new path>.");

  const summary = await runRailsBackfill({
    file,
    apply,
    rollbackFile: rollbackFile ?? "",
    showConflicts: args.includes("--show-conflicts"),
    fixPacificShift: args.includes("--fix-pacific-shift"),
  });
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
