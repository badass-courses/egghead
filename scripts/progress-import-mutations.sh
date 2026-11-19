#!/usr/bin/env bash
# Mutation checks for the progress import's safety guards.
#
# Each mutation removes or weakens one guard; at least one test in
# `pnpm progress:import:test` must then fail. The file is restored after each
# mutation, including on Ctrl-C. Needs the same databases as the tests:
#
#   PROGRESS_IMPORT_TEST_DATABASE_URL=mysql://…/progress_import_test \
#   PROGRESS_EXPORT_TEST_PG_URL=postgresql://…/rails_export_test \
#     scripts/progress-import-mutations.sh
#
# Prints one line per mutation and exits 1 if any mutation survives or no
# longer applies (the guard moved; update its pattern here).
set -u
cd "$(dirname "$0")/.."

if [ -z "${PROGRESS_IMPORT_TEST_DATABASE_URL:-}" ] || [ -z "${PROGRESS_EXPORT_TEST_PG_URL:-}" ]; then
  echo "Set PROGRESS_IMPORT_TEST_DATABASE_URL and PROGRESS_EXPORT_TEST_PG_URL; without them the guarded cases skip and every mutation would survive." >&2
  exit 2
fi

backup="$(mktemp)"
current=""
restore() { if [ -n "$current" ]; then cp "$backup" "$current"; current=""; fi; }
trap 'restore; rm -f "$backup"' EXIT
trap 'exit 130' INT TERM

failures=0
mutate() { # file perl-substitution label
  current="$1"
  cp "$1" "$backup"
  perl -0pi -e "$2" "$1"
  if cmp -s "$1" "$backup"; then
    echo "NOT APPLIED  $3"
    failures=$((failures + 1))
  elif pnpm -s progress:import:test >/dev/null 2>&1; then
    echo "SURVIVED     $3"
    failures=$((failures + 1))
  else
    echo "caught       $3"
  fi
  restore
}

P=apps/web/src/progress
# Write-time race guards and counts.
mutate $P/import.ts 's/\n\s*AND progress\.updatedAt <=> CAST\(incoming\.priorUpdatedAt AS DATETIME\(3\)\)//' "update guard: updatedAt"
mutate $P/import.ts 's/WHERE progress\.completedAt IS NULL\n/WHERE 1 = 1\n/' "update guard: completedAt"
mutate $P/import.ts "s/\n\s*AND JSON_TYPE\(COALESCE\(progress\.fields, JSON_OBJECT\(\)\)\) = 'OBJECT'//" "update guard: fields is an object"
mutate $P/import.ts 's/\n\s*ON DUPLICATE KEY UPDATE userId = userId//' "insert: duplicate-key no-op"
mutate $P/import.ts 's/receipt\.rows\.inserted \+= written\.inserted;/receipt.rows.inserted += group.filter((write) => write.action === "insert").length;/' "insert count taken from the plan"
# Session and table guards.
mutate $P/import.ts 's/(Promise<ProgressImportReceipt> \{\n  )await assertUtcSession\(input\.db\);/$1/' "bulk import: UTC session"
mutate $P/import.ts 's/  await assertProgressUniqueKeys\(input\.db\);\n//' "bulk import: unique-key check"
mutate $P/import.ts 's/if \(others\.length > 0\)/if (others.length < 0)/' "extra UNIQUE index allowed"
mutate $P/import.ts 's/EXPLICIT_UNCOMPLETE_SOURCES: readonly string\[\] = LESSON_PROGRESS_SOURCES;/EXPLICIT_UNCOMPLETE_SOURCES: readonly string[] = ["lesson_progress_control", "lesson_player_ended"];/' "un-complete sources as literals"
# Receipts and targets.
mutate $P/import-cli.ts 's/\n\s*identity\.user,//' "target hash ignores the user (branch)"
mutate $P/import-cli.ts 's/\n\s*String\(identity\.port\),//' "target hash ignores the port"
mutate $P/import-cli.ts 's/salt = randomBytes\(16\)\.toString\("hex"\)/salt = "0".repeat(32)/' "fixed salt"
mutate $P/import-cli.ts 's/  salt: z\.string\(\)\.regex\(\/\^\[0-9a-f\]\{32\}\$\/\),\n//' "unsalted receipts accepted"
mutate scripts/progress-import.ts 's/assertDryRunReceiptMatches\(readFileSync\(expectDryRun, "utf8"\), sourceSha256, identity\);/void 0;/' "CLI skips the receipt check"
# Mapping and reporting.
mutate $P/import-catalog.ts "s/OR \(course\.type = 'post' AND \\$\{jsonString\(\"course\", \"postType\"\)\} = 'course'\)/OR FALSE/" "post-type courses dropped"
mutate $P/import.ts 's/      input\.unmapped\.addSeries\(series\.railsPlaylistId, series\.railsSeriesId, series\.slug\);\n//' "unmapped series not listed"
# Export and counts SQL.
mutate scripts/sql/rails-progress-export.sql 's/\n   AND lv\.lesson_version_id = l\.current_lesson_version_id//' "export: current-version filter"
mutate scripts/sql/rails-progress-export.sql 's/\\set QUIET on\n//' "export: QUIET"
mutate scripts/sql/rails-progress-export.sql "s/\(now\(\) AT TIME ZONE 'UTC'\)/now()::timestamp/" "export: cutoff in the session zone"
mutate scripts/sql/rails-progress-export.sql 's/  WHERE u\.id > :after_user_id/  WHERE u.id >= :after_user_id/' "export: inclusive chunk lower edge"
mutate scripts/sql/rails-progress-export.sql 's/  LEFT JOIN playlists p ON/  JOIN playlists p ON/' "export: drops deleted playlists"
mutate scripts/sql/rails-progress-export-counts.sql 's/  WHERE playlist_id IS NOT NULL OR series_id IS NOT NULL\n//' "counts: series filter"
mutate scripts/sql/rails-progress-export-counts.sql "s/COALESCE\(sp\.site, 'egghead\.io'\) = 'egghead\.io'/TRUE/" "counts: site filter"
mutate scripts/sql/rails-progress-export-counts.sql "s/\(now\(\) AT TIME ZONE 'UTC'\)/now()::timestamp/" "counts: cutoff in the session zone"

if [ "$failures" -gt 0 ]; then
  echo "$failures mutation(s) survived or no longer apply" >&2
  exit 1
fi
echo "all mutations caught"
